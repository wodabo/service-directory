/**
 * 端口扫描 & 健康检查
 *
 * 扫描：lsof -F 机器可读输出 → 端口/进程 → ps 拿完整命令行 → HTTP 探测判断是不是 Web 服务
 * 健康：HEAD/GET 探测，记录在线状态与延迟
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { hostname, userInfo } from 'node:os';
import { createConnection } from 'node:net';
import { extractTitle } from './icons.js';

const exec = promisify(execFile);

/**
 * 进程归类
 *
 * 主要靠可执行文件路径判断，比维护进程名清单可靠得多（lsof -F 给的是完整进程名）：
 *   /System/ 或 /usr/libexec/  → 系统守护进程
 *   *.app/Contents/            → 桌面应用自己开的内部端口（IDE 调试、语言服务）
 * OrbStack 是例外：它转发的端口正是用户要用的数据库/中间件。
 */
const ORB_SAFE = /^\/Applications\/OrbStack\.app\//;

const SYSTEM_PATTERNS = [
  /^rapportd$/, /^ControlCenter$/, /^ARDAgent$/, /^sharingd$/, /^AirPlay/,
  /^identitys/, /^SystemUIServer$/, /^mDNSResponder$/, /^rpcbind$/, /^cupsd$/, /^bluetoothd$/,
];

const NOISE_PATTERNS = [
  /^(webstorm|zed|Code|Cursor|idea|pycharm|goland|Electron|Antigravity|WorkBuddy)$/,
  /^language_server$/, /^editor_sdk$/, /^ApifoxAppAgent$/, /^netdisk_service$/, /^embeddings-server$/,
];

function isSystemProcess(process, command) {
  if (ORB_SAFE.test(command || '')) return false;
  if (SYSTEM_PATTERNS.some((re) => re.test(process))) return true;
  return /^\/(System|usr\/libexec|usr\/sbin)\//.test(command || '');
}

function isNoiseProcess(process, command) {
  if (ORB_SAFE.test(command || '')) return false;
  if (NOISE_PATTERNS.some((re) => re.test(process))) return true;
  // 打包成 .app 的桌面应用，其监听端口基本不是给用户访问的
  return /\.app\/Contents\//.test(command || '');
}

/** 常见数据库/中间件端口 → 展示用类型 */
const WELL_KNOWN_PORTS = {
  22: 'SSH', 25: 'SMTP', 53: 'DNS', 80: 'HTTP', 443: 'HTTPS',
  3000: 'Node', 3001: 'Node', 3306: 'MySQL', 4200: 'Angular',
  5000: 'Flask/UPnP', 5173: 'Vite', 5432: 'PostgreSQL', 5433: 'PostgreSQL',
  55432: 'PostgreSQL', 5601: 'Kibana', 5672: 'RabbitMQ',
  6379: 'Redis', 7863: 'OrbStack', 8000: 'Python', 8080: 'HTTP 代理',
  8081: 'HTTP', 8086: 'InfluxDB', 8443: 'HTTPS', 8888: 'Jupyter',
  9000: 'Web UI', 9090: 'Prometheus', 9200: 'Elasticsearch',
  11211: 'Memcached', 27017: 'MongoDB', 50000: 'Dev', 63342: 'IDE 服务',
};

/** 从完整命令行里推断项目名 */
function guessProjectName(command) {
  if (!command) return '';
  const m = command.match(/\/(?:Users|home)\/[^/]+\/(?:code|projects?|workspace|dev|src)\/(?:project|agent|apps?|work)?\/?([^/\s]+)/);
  if (m) return m[1];
  const m2 = command.match(/node_modules\/\.bin\/([^/\s]+)/);
  if (m2) return m2[1];
  return '';
}

/** 推断服务角色 */
function guessRole(command) {
  if (!command) return '';
  if (/vite/.test(command)) return 'Vite 开发服务器';
  if (/next|nuxt/.test(command)) return '前端开发服务器';
  if (/uvicorn|gunicorn|flask|fastapi/.test(command)) return 'Python 服务';
  if (/dist\/main\.js|dist\/index\.js/.test(command)) return '构建产物服务';
  if (/tsx|ts-node|nodemon/.test(command)) return 'Node 开发服务器';
  if (/nginx/.test(command)) return 'Nginx';
  if (/postgres/.test(command)) return 'PostgreSQL';
  if (/redis/.test(command)) return 'Redis';
  return '';
}

function prettyName(port, proc, command) {
  // OrbStack 转发的端口用「服务类型 · OrbStack」命名，比进程名有意义
  if (/OrbStack/.test(proc)) {
    const kind = WELL_KNOWN_PORTS[port];
    return kind && kind !== 'OrbStack' ? `${kind} · OrbStack` : `OrbStack :${port}`;
  }
  const project = guessProjectName(command);
  const role = guessRole(command);
  if (project && role) return `${project} · ${role}`;
  if (project) return project;
  if (role) return `${proc} · ${role}`;
  return `${proc}:${port}`;
}

/**
 * 判断是不是同一进程的附属端口。
 * 开发服务器常额外开 HMR / inspector 端口，它们不该被当成独立服务收录。
 */
function isAuxiliaryPort(port, command) {
  const m = command?.match(/--port[=\s]+(\d+)/);
  if (m && parseInt(m[1], 10) !== port) return true;
  if (/--inspect(-brk)?[=\s]/.test(command || '')) return true;
  return false;
}

/* ------------------------------------------------------------------ 扫描 */

/**
 * 列出本机所有 TCP 监听端口
 * @returns {Promise<Array<{port:number,pid:number,process:string,bind:string,command:string}>>}
 */
export async function listListening() {
  let stdout = '';
  try {
    ({ stdout } = await exec('lsof', ['-nP', '-iTCP', '-sTCP:LISTEN', '-FpcPn'], { timeout: 15000 }));
  } catch (err) {
    // lsof 在无匹配时以非 0 退出，但 stdout 里可能有内容
    stdout = err.stdout || '';
    if (!stdout) throw new Error('lsof 执行失败：' + (err.message || err));
  }

  const rows = [];
  let cur = null;
  for (const line of stdout.split('\n')) {
    if (!line) continue;
    const tag = line[0];
    const val = line.slice(1);
    if (tag === 'p') {
      cur = { pid: parseInt(val, 10), process: '', command: '' };
    } else if (tag === 'c' && cur) {
      cur.process = val;
    } else if (tag === 'n' && cur) {
      const m = val.match(/^(.*):(\d+)$/);
      if (!m) continue;
      rows.push({
        pid: cur.pid,
        process: cur.process,
        bind: m[1],
        port: parseInt(m[2], 10),
        command: '',
      });
    }
  }

  // 去重（同一端口可能被 v4/v6 各监听一次）
  const byPort = new Map();
  for (const r of rows) {
    const prev = byPort.get(r.port);
    if (!prev) byPort.set(r.port, r);
    else if (prev.bind === '*' && r.bind !== '*') byPort.set(r.port, r); // 优先记录具体地址
  }

  // 批量取完整命令行
  const pids = [...new Set([...byPort.values()].map((r) => r.pid))].filter(Boolean);
  if (pids.length) {
    try {
      const { stdout: psOut } = await exec(
        'ps', ['-o', 'pid=,command=', '-p', pids.join(',')], { timeout: 10000, maxBuffer: 4 * 1024 * 1024 },
      );
      const map = new Map();
      for (const line of psOut.split('\n')) {
        const m = line.match(/^\s*(\d+)\s+(.*)$/);
        if (m) map.set(parseInt(m[1], 10), m[2]);
      }
      for (const r of byPort.values()) r.command = map.get(r.pid) || '';
    } catch { /* 拿不到命令行也能继续 */ }
  }

  return [...byPort.values()].sort((a, b) => a.port - b.port);
}

/** 探测一个端口是不是 HTTP 服务，并尝试拿标题 */
export async function probeHttp(port, bind = '127.0.0.1', timeout = 2000) {
  const host = bind === '*' || bind === '0.0.0.0' ? '127.0.0.1' : bind.replace(/^\[|\]$/g, '');
  const url = `http://${host.includes(':') ? `[${host}]` : host}:${port}/`;
  const started = Date.now();
  try {
    const res = await fetch(url, {
      redirect: 'manual',
      signal: AbortSignal.timeout(timeout),
      headers: { 'User-Agent': 'nav-hub/1.0 (+local dashboard probe)' },
    });
    const ms = Date.now() - started;
    let title = '';
    let server = res.headers.get('server') || '';
    const ct = res.headers.get('content-type') || '';
    if (ct.includes('html')) {
      const text = (await res.text().catch(() => '')).slice(0, 200_000);
      title = extractTitle(text);
    }
    return {
      http: true,
      status: res.status,
      url,
      title,
      server,
      contentType: ct.split(';')[0],
      latency: ms,
    };
  } catch {
    return { http: false, status: 0, url, title: '', server: '', contentType: '', latency: Date.now() - started };
  }
}

/**
 * 完整扫描：返回可直接导入的候选列表
 * @param {{existingUrls?:Set<string>, existingPorts?:Set<number>, ignored?:number[], probe?:boolean}} opts
 */
export async function scanPorts(opts = {}) {
  const { existingUrls = new Set(), existingPorts = new Set(), ignored = [], probe = true } = opts;
  const ignoredSet = new Set(ignored);
  const listeners = await listListening();
  const me = userInfo().username;
  const results = [];

  for (const l of listeners) {
    if (ignoredSet.has(l.port)) continue;
    const system = isSystemProcess(l.process, l.command);
    // OrbStack 只在转发知名服务端口（5432/6379…）时才算用户服务，其余是它自己的内部端口
    const noise = isNoiseProcess(l.process, l.command)
      || (ORB_SAFE.test(l.command || '') && !WELL_KNOWN_PORTS[l.port]);
    const auxiliary = isAuxiliaryPort(l.port, l.command);
    const guessedName = prettyName(l.port, l.process, l.command);
    const entry = {
      port: l.port,
      pid: l.pid,
      process: l.process,
      bind: l.bind,
      command: l.command,
      system,
      noise,
      auxiliary,
      kind: WELL_KNOWN_PORTS[l.port] || '',
      name: guessedName,
      url: `http://127.0.0.1:${l.port}`,
      title: '',
      description: '',
      latency: null,
      http: false,
      status: 0,
      alreadyAdded: existingPorts.has(l.port) || existingUrls.has(`http://127.0.0.1:${l.port}`),
      ownedByUser: l.command.startsWith('/Users/' + me) || /^\/(opt\/homebrew|usr\/local)/.test(l.command),
    };

    if (probe && !entry.alreadyAdded) {
      const p = await probeHttp(l.port, l.bind);
      entry.http = p.http;
      entry.status = p.status;
      entry.latency = p.latency;
      entry.title = p.title;
      if (p.title) entry.name = p.title.slice(0, 60);
      if (!entry.kind && p.server) entry.kind = p.server.slice(0, 24);
      if (p.contentType) entry.description = `${p.contentType} · HTTP ${p.status}`;
    }
    results.push(entry);
  }

  // 排序：HTTP 服务优先 → 非内部端口优先 → 端口号
  results.sort((a, b) => {
    if (a.alreadyAdded !== b.alreadyAdded) return a.alreadyAdded ? 1 : -1;
    const an = a.system || a.noise || a.auxiliary;
    const bn = b.system || b.noise || b.auxiliary;
    if (an !== bn) return an ? 1 : -1;
    if (a.http !== b.http) return a.http ? -1 : 1;
    return a.port - b.port;
  });

  return {
    host: hostname(),
    scanned_at: Date.now(),
    total: results.length,
    web: results.filter((r) => r.http).length,
    results,
  };
}

/* ------------------------------------------------------------ 健康检查 */

/** 纯 TCP 端口探测，用于数据库这类没有 HTTP 接口的服务 */
export function checkTcp(host, port, timeout = 2500) {
  return new Promise((resolvePromise) => {
    const started = Date.now();
    const socket = createConnection({ host: host || '127.0.0.1', port });
    let settled = false;
    const done = (status) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolvePromise({ status, latency: Date.now() - started });
    };
    socket.setTimeout(timeout);
    socket.once('connect', () => done('online'));
    socket.once('timeout', () => done('timeout'));
    socket.once('error', () => done('offline'));
  });
}

/**
 * 统一的连通性探测：有 URL 走 HTTP，只有端口就走 TCP。
 * 任何 HTTP 响应（含 4xx/5xx）都算"在线"——进程活着，只是返回了错误。
 */
export async function checkTarget({ url, host, port }, timeout = 3000) {
  if (url) {
    const started = Date.now();
    try {
      const res = await fetch(url, {
        redirect: 'manual',
        signal: AbortSignal.timeout(timeout),
        headers: { 'User-Agent': 'nav-hub/1.0 (+health check)' },
      });
      return { status: 'online', latency: Date.now() - started, code: res.status, via: 'http' };
    } catch (err) {
      const ms = Date.now() - started;
      const name = err?.name || '';
      if (name === 'TimeoutError' || name === 'AbortError') return { status: 'timeout', latency: ms, via: 'http' };
      return { status: 'offline', latency: ms, via: 'http' };
    }
  }
  if (port) {
    const r = await checkTcp(host, port, Math.min(timeout, 2500));
    return { ...r, via: 'tcp' };
  }
  return { status: 'unknown', latency: null, via: 'none' };
}

/**
 * 探测单个服务是否在线（HTTP）。
 * 任何 HTTP 响应（含 4xx/5xx）都算"在线"——进程活着只是返回了错误。
 */
export async function checkHealth(url, timeout = 3000) {
  if (!url) return { status: 'unknown', latency: null };
  const started = Date.now();
  try {
    const res = await fetch(url, {
      redirect: 'manual',
      signal: AbortSignal.timeout(timeout),
      headers: { 'User-Agent': 'nav-hub/1.0 (+health check)' },
    });
    return { status: 'online', latency: Date.now() - started, code: res.status };
  } catch (err) {
    const ms = Date.now() - started;
    const name = err?.name || '';
    if (name === 'TimeoutError' || name === 'AbortError') return { status: 'timeout', latency: ms };
    return { status: 'offline', latency: ms };
  }
}

export async function checkAll(targets, { concurrency = 12, timeout = 3000 } = {}) {
  const out = new Map();
  const queue = [...targets];
  const workers = Array.from({ length: Math.min(concurrency, queue.length || 1) }, async () => {
    while (queue.length) {
      const t = queue.shift();
      out.set(t.id, await checkTarget(t, timeout));
    }
  });
  await Promise.all(workers);
  return out;
}

/**
 * host 是不是「本机 / 内网」形态：回环、私有网段、.local。
 *
 * 只有这类地址才谈得上「换成外部访问地址再探一次」。公网域名（rss.bz、zcode.z.ai 这类
 * 外链服务）换过去必然不通，拿它去判「仅本机」会把正常的外链误标成红框。
 * 前端 displayUrl 用的是同一套规则，改一处要同步改另一处。
 */
export function isLocalishHost(hostname) {
  const h = String(hostname || '').toLowerCase().replace(/^\[|\]$/g, '');
  if (!h) return false;
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local')) return true;
  if (h.includes(':')) return true; // IPv6 字面量
  const m = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return false;
  const a = Number(m[1]);
  const b = Number(m[2]);
  return a === 0 || a === 127 || a === 10
    || (a === 192 && b === 168)
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 169 && b === 254);
}

/**
 * 带外部地址的探测：先试本机地址，再试外部地址（用户实际会点开的那个），
 * 用来区分「进程挂了」和「进程活着但只绑了回环，外网连不上」。
 *
 * 外链服务（URL 的 host 是公网域名）不参与外部探测：外部访问地址是给跑在本机的服务用的，
 * 外链换过去必然不通，不能据此判成「仅本机」。
 *
 * @param {{url:string, host:string, port:number}} target 本机地址
 * @param {string} externalHost 外部访问用的地址（如 ZeroTier IP），空则等同普通探测
 */
export async function checkTargetWithExternal(target, externalHost, timeout = 3000) {
  const local = await checkTarget(target, timeout);
  if (!externalHost || !target.port) return { ...local, external: null };

  // 公网域名 / 外链：直接用探测结果，不套外部地址
  if (target.url) {
    let hostname = '';
    try { hostname = new URL(target.url).hostname; } catch { /* 非法 URL 走下面的重写逻辑 */ }
    if (hostname && !isLocalishHost(hostname)) return { ...local, external: null, direct: true };
  }

  // 本机用什么方式探（HTTP / TCP），外部就用同样的方式。
  // 数据库这类没有 URL 的服务必须走 TCP，否则会被 HTTP 探测误判成"仅本机"。
  const external = await checkTarget(
    target.url
      ? { url: buildExternalUrl(target.url, externalHost, target.port), host: externalHost, port: target.port }
      : { url: '', host: externalHost, port: target.port },
    timeout,
  );

  // 外部通 → 就是在线
  if (external.status === 'online') return { ...external, via: 'external', local };

  // 外部不通但本机通 → 服务只绑了回环
  if (local.status === 'online') {
    return { status: 'local-only', latency: local.latency, via: 'local', external, local };
  }
  return { ...local, external };
}

/** 保留原 URL 的协议和路径，只把主机换成外部地址 */
function buildExternalUrl(originalUrl, externalHost, port) {
  try {
    const u = new URL(originalUrl);
    return `${u.protocol}//${externalHost}:${port}${u.pathname}${u.search}`;
  } catch {
    return `http://${externalHost}:${port}`;
  }
}

/* ------------------------------------------------------------ 网络环境 */

/** 解析 zerotier-cli listnetworks 的输出，拿到 ZeroTier 地址 */
export async function detectZeroTier() {
  try {
    const { stdout } = await exec('zerotier-cli', ['listnetworks'], { timeout: 5000 });
    const out = [];
    for (const line of stdout.split('\n')) {
      // 数据行形如：200 listnetworks <nwid> <name> <mac> <status> <type> <dev> <ips>
      // 首行是同样的表头（字段名带尖括号），靠 nwid 是 16 位十六进制把它排除掉
      const cols = line.trim().split(/\s+/);
      if (cols.length < 9 || cols[0] !== '200' || cols[1] !== 'listnetworks') continue;
      const [nwid, name, mac, status, type, dev, ips] = cols.slice(2);
      if (!/^[0-9a-f]{16}$/i.test(nwid)) continue;
      const ip = (ips || '').split('/')[0];
      if (!ip || status !== 'OK') continue;
      out.push({ nwid, name, mac, status, type, dev, ip });
    }
    return { available: true, networks: out };
  } catch (err) {
    return { available: false, error: err?.code === 'ENOENT' ? 'zerotier-cli 未安装' : (err?.message || '调用失败'), networks: [] };
  }
}
