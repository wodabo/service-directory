/**
 * Docker 模块：包装 docker CLI（本机走 OrbStack 的 docker）
 *
 * 为什么走 CLI 而不是 /var/run/docker.sock：
 *   零依赖项目里自己写 sock 的 HTTP + 流式解析成本高，而 docker CLI 已经在
 *   PATH 上（OrbStack 会装好），`--format '{{json .}}'` 输出稳定可解析。
 *   性能对导航面板这种刷新频率完全够用。
 *
 * 所有命令都用 execFile（不经过 shell），容器名/ID 不会拼进 shell 字符串。
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);

/** 解析 `--format json`：docker 每行一个 JSON 对象，个别版本可能是裸数组 */
function parseLines(stdout) {
  const s = String(stdout || '').trim();
  if (!s) return [];
  if (s.startsWith('[')) {
    try { return JSON.parse(s); } catch { return []; }
  }
  return s.split('\n').filter(Boolean).map((line) => {
    try { return JSON.parse(line); } catch { return null; }
  }).filter(Boolean);
}

async function docker(args, { timeout = 15000 } = {}) {
  const { stdout } = await exec('docker', args, { timeout, maxBuffer: 16 * 1024 * 1024 });
  return stdout;
}

/** docker 不可用（没装、守护进程没起）时给前端一个明确信号 */
async function assertAvailable() {
  try {
    await docker(['version', '--format', '{{.Server.Version}}'], { timeout: 5000 });
    return true;
  } catch (err) {
    const e = new Error(
      err.code === 'ENOENT' ? 'docker 命令不存在' : `Docker 不可用：${(err.stderr || err.message || '').trim().split('\n')[0]}`
    );
    e.code = 'DOCKER_UNAVAILABLE';
    throw e;
  }
}

/* ------------------------------------------------------------- 容器列表 */

/** docker ps 的 Ports 字段拆成结构化映射，前端好渲染 */
function parsePorts(portsStr) {
  // 形如：0.0.0.0:7863->7863/tcp, [::]:7863->7863/tcp, 127.0.0.1:55432->5432/tcp
  // IPv4/IPv6 是同一映射的两份，按 hostPort+containerPort+proto 去重
  const out = [];
  const seen = new Set();
  for (const part of String(portsStr || '').split(', ')) {
    const m = part.match(/^(\[?[^\]]+\]?):(\d+)->(\d+)\/(tcp|udp)$/);
    if (!m) { if (part) out.push({ raw: part }); continue; }
    const key = `${m[2]}->${m[3]}/${m[4]}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ host: m[1].replace(/^\[::\]$/, '0.0.0.0'), hostPort: Number(m[2]), containerPort: Number(m[3]), proto: m[4] });
  }
  return out;
}

function parseMounts(mountsStr) {
  return String(mountsStr || '').split(',').map((s) => s.trim()).filter(Boolean);
}

export async function listContainers({ all = true } = {}) {
  await assertAvailable();
  const args = ['ps', '--format', '{{json .}}'];
  if (all) args.push('-a');
  const rows = parseLines(await docker(args));

  // stats 一次拿全量（--no-stream 会跑几秒），失败的容器静默跳过
  let statsByName = new Map();
  try {
    const st = parseLines(await docker(['stats', '--no-stream', '--format', '{{json .}}'], { timeout: 30000 }));
    statsByName = new Map(st.map((s) => [s.Name || s.ID, s]));
  } catch { /* stats 挂了不影响列表 */ }

  return rows.map((r) => {
    const composeProject = parseLabelValue(r.Labels, 'com.docker.compose.project');
    // compose 的内部标签没展示价值，只留非 compose 的
    const labels = Object.fromEntries(
      Object.entries(parseLabels(r.Labels)).filter(([k]) => !k.startsWith('com.docker.compose.')).slice(0, 20)
    );
    const st = statsByName.get(r.Names) || statsByName.get(r.ID) || null;
    return {
      id: r.ID,
      name: r.Names,
      image: r.Image,
      state: r.State,            // running / exited / paused / created / restarting / dead
      status: r.Status,          // "Up 4 hours (healthy)" 人类可读
      command: r.Command,
      createdAt: r.CreatedAt,
      runningFor: r.RunningFor,
      portsRaw: r.Ports || '',
      ports: parsePorts(r.Ports),
      mounts: parseMounts(r.Mounts),
      networks: String(r.Networks || '').split(',').filter(Boolean),
      composeProject,
      labels: Object.fromEntries(Object.entries(labels).slice(0, 20)),
      stats: st ? {
        cpu: st.CPUPerc, mem: st.MemUsage, memPerc: st.MemPerc,
        netIO: st.NetIO, blockIO: st.BlockIO, pids: st.PIDs,
      } : null,
    };
  });
}

function parseLabels(labelStr) {
  const out = {};
  // ps --format 里 Labels 是逗号连接的 k=v（值里也可能有逗号，这里只用于展示，容忍截断）
  for (const kv of String(labelStr || '').split(',')) {
    const i = kv.indexOf('=');
    if (i > 0) out[kv.slice(0, i)] = kv.slice(i + 1);
  }
  return out;
}
function parseLabelValue(labelStr, key) {
  const m = String(labelStr || '').match(new RegExp(`(?:^|,)${key}=[^,]*`));
  return m ? m[0].split('=').slice(1).join('=') : '';
}

/* ------------------------------------------------------------- 容器详情 */

export async function inspectContainer(idOrName) {
  await assertAvailable();
  const rows = parseLines(await docker(['inspect', '--format', '{{json .}}', idOrName]));
  const d = rows[0];
  if (!d) throw new Error(`容器不存在：${idOrName}`);

  const networks = {};
  for (const [name, n] of Object.entries(d.NetworkSettings?.Networks || {})) {
    networks[name] = {
      ip: n.IPAddress || '', gateway: n.Gateway || '', prefixLen: n.IPPrefixLen || 0,
      mac: n.MacAddress || '', aliases: n.Aliases || [], dnsNames: n.DNSNames || [],
      globalIPv6: n.GlobalIPv6Address || '',
    };
  }

  return {
    id: d.Id?.slice(0, 12),
    name: (d.Name || '').replace(/^\//, ''),
    image: d.Config?.Image,
    state: d.State?.Status,
    running: d.State?.Running,
    paused: d.State?.Paused,
    restartCount: d.RestartCount || 0,
    startedAt: d.State?.StartedAt,
    finishedAt: d.State?.FinishedAt,
    exitCode: d.State?.ExitCode,
    error: d.State?.Error || '',
    health: d.State?.Health?.Status || '',
    platform: d.Platform,
    // 网络
    ports: d.NetworkSettings?.Ports || {},     // {"7863/tcp": [{HostIp, HostPort}]}
    networks,
    // 环境与命令
    cmd: d.Config?.Cmd || [],
    entrypoint: d.Config?.Entrypoint || [],
    env: (d.Config?.Env || []).slice(0, 100),
    workDir: d.Config?.WorkingDir || '',
    // 挂载
    mounts: (d.Mounts || []).map((m) => ({
      type: m.Type, source: m.Source, dest: m.Destination, mode: m.Mode, rw: m.RW,
    })),
    restartPolicy: d.HostConfig?.RestartPolicy?.Name || '',
    // 资源限制（展示用）
    memoryLimit: d.HostConfig?.Memory || 0,
    cpuShares: d.HostConfig?.CpuShares || 0,
  };
}

/** 容器最近日志（tail） */
export async function containerLogs(idOrName, { tail = 200 } = {}) {
  await assertAvailable();
  const n = Math.min(Math.max(parseInt(tail, 10) || 200, 1), 2000);
  return docker(['logs', '--tail', String(n), '--timestamps', idOrName], { timeout: 15000 });
}

/* ------------------------------------------------------------- 容器操作 */

const ACTIONS = {
  start: ['start'],
  stop: ['stop', '-t', '10'],
  restart: ['restart', '-t', '10'],
  pause: ['pause'],
  unpause: ['unpause'],
  kill: ['kill'],
};

/**
 * 容器操作。删除走 remove（需要 force 处理运行中的容器），这里没提供——
 * 面板是日常导航工具，误触 rm 的代价太高，要删去命令行。
 */
export async function containerAction(idOrName, action) {
  await assertAvailable();
  const base = ACTIONS[action];
  if (!base) throw new Error(`不支持的操作：${action}`);
  await docker([...base, idOrName], { timeout: 30000 });
  // 操作后回读状态，前端直接拿到最新数据
  const list = await listContainers({ all: true });
  return list.find((c) => c.id === idOrName || c.name === idOrName
    || c.name === String(idOrName).replace(/^\//, '')) || null;
}

/* --------------------------------------------------------------- 网络 */

export async function listNetworks() {
  await assertAvailable();
  const rows = parseLines(await docker(['network', 'ls', '--format', '{{json .}}']));
  const details = await Promise.all(rows.map(async (r) => {
    try {
      const d = parseLines(await docker(['network', 'inspect', '--format', '{{json .}}', r.Name]));
      const net = d[0] || {};
      return {
        id: r.ID, name: r.Name, driver: r.Driver, scope: r.Scope,
        internal: net.Internal || false,
        ipv6: net.EnableIPv6 || false,
        subnet: net.IPAM?.Config?.[0]?.Subnet || '',
        gateway: net.IPAM?.Config?.[0]?.Gateway || '',
        containers: Object.entries(net.Containers || {}).map(([cid, c]) => ({
          id: cid.slice(0, 12), name: c.Name, ipv4: c.IPv4Address || '', ipv6: c.IPv6Address || '',
        })),
      };
    } catch {
      return { id: r.ID, name: r.Name, driver: r.Driver, scope: r.Scope, internal: false, ipv6: false, subnet: '', gateway: '', containers: [] };
    }
  }));
  return details;
}
