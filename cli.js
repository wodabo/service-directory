#!/usr/bin/env node
/**
 * nav-hub 命令行工具
 *
 *   node cli.js scan          扫描并打印本机监听端口
 *   node cli.js seed [--all]  扫描并把服务导入数据库（默认只导入 HTTP 服务）
 *   node cli.js icons [--mono] 重新处理所有图标
 *   node cli.js list          列出已收录服务
 *   node cli.js check         检测所有服务连通性
 */
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

import * as db from './lib/db.js';
import * as icons from './lib/icons.js';
import { scanPorts, checkAll } from './lib/scan.js';
import { ROOT, DATA_DIR, ICONS_DIR, DB_FILE } from './lib/config.js';

const C = {
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
  blue: (s) => `\x1b[34m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`,
};

/** 按端口/进程归类到分组 */
const GROUPS = {
  web: { name: '开发服务', color: '#5b8def' },
  db: { name: '数据库与中间件', color: '#10b981' },
  container: { name: '容器', color: '#0ea5e9' },
  tools: { name: '工具与面板', color: '#f59e0b' },
  system: { name: '系统服务', color: '#64748b' },
};

const DB_PORTS = new Set([3306, 5432, 5433, 6379, 27017, 9200, 11211, 5672, 7863, 55432, 2379, 8500]);

/** 只有端口、没有网页界面的服务（数据库/中间件）—— 收录它是为了"记得住端口" */
function isPortOnly(row) {
  if (row.http) return false;
  if (DB_PORTS.has(row.port)) return true;
  return /PostgreSQL|Redis|MySQL|MongoDB|Elasticsearch|Memcached|RabbitMQ|InfluxDB/.test(row.kind || '');
}

function classify(row) {
  if (row.process === 'OrbStack') return 'container';
  if (DB_PORTS.has(row.port)) return 'db';
  if (row.system || row.noise) return 'system';
  if (row.http) return 'web';
  return 'tools';
}

function openStore() {
  mkdirSync(ICONS_DIR, { recursive: true });
  return db.openDb(DB_FILE);
}

/* ---------------------------------------------------------------- scan */

async function cmdScan(args) {
  const store = openStore();
  const services = db.listServices(store);
  const result = await scanPorts({
    existingPorts: new Set(services.map((s) => s.port).filter(Boolean)),
    existingUrls: new Set(services.map((s) => s.url).filter(Boolean)),
    ignored: db.listIgnoredPorts(store),
  });

  console.log(`\n  ${C.bold('本机监听端口')}  ${C.dim(`共 ${result.total} 个，其中 ${result.web} 个 HTTP 服务`)}\n`);
  for (const r of result.results) {
    const port = C.blue(String(r.port).padStart(6));
    const kind = (r.http ? C.green('HTTP ' + r.status) : C.dim('—')).padEnd(12);
    const added = r.alreadyAdded ? C.dim(' 已收录') : '';
    const sys = r.system ? C.yellow(' 系统') : '';
    console.log(`  ${port}  ${kind} ${r.name}${sys}${added}`);
    console.log(`          ${C.dim((r.command || r.process).slice(0, 96))}`);
  }
  console.log();
  store.close();
}

/* ---------------------------------------------------------------- seed */

async function cmdSeed(args) {
  const all = args.includes('--all');
  const store = openStore();
  const services = db.listServices(store);
  const result = await scanPorts({
    existingPorts: new Set(services.map((s) => s.port).filter(Boolean)),
    existingUrls: new Set(services.map((s) => s.url).filter(Boolean)),
    ignored: db.listIgnoredPorts(store),
  });

  const groupCache = new Map();
  const groupId = (key) => {
    if (!groupCache.has(key)) {
      const g = db.ensureGroup(store, GROUPS[key].name);
      db.updateGroup(store, g.id, { color: GROUPS[key].color });
      groupCache.set(key, g.id);
    }
    return groupCache.get(key);
  };

  let added = 0;
  const pending = [];
  for (const r of result.results) {
    if (r.alreadyAdded) continue;
    // 默认只导入"用户自己的服务"：跳过系统守护进程、IDE 内部端口与开发服务器的附属端口
    if (!all && (r.system || r.noise || r.auxiliary)) continue;

    const portOnly = isPortOnly(r);
    if (!all && !r.http && !portOnly) continue;

    const key = classify(r);
    // 没有网页界面的服务不存 URL —— 免得点开得到一个空连接
    const url = portOnly ? '' : `http://127.0.0.1:${r.port}`;
    if (url && db.findByUrl(store, url)) continue;
    if (!url && db.findByPort(store, r.port)) continue;

    const svc = db.createService(store, {
      name: r.name,
      url,
      port: r.port,
      host: '127.0.0.1',
      description: r.description || r.kind || '',
      group_id: groupId(key),
      tags: portOnly ? '端口' : r.system ? '系统' : '',
      status: r.http ? 'online' : 'unknown',
      latency_ms: r.latency ?? null,
      checked_at: r.http ? Date.now() : null,
    });
    pending.push(svc);
    added++;
    console.log(`  ${C.green('+')} ${C.blue(String(r.port).padStart(6))}  ${r.name}${portOnly ? C.dim('  (仅端口)') : ''}`);
  }

  console.log(`\n  已导入 ${C.bold(added)} 个服务，开始抓取图标…\n`);
  let ok = 0;
  const queue = [...pending];
  const workers = Array.from({ length: 4 }, async () => {
    while (queue.length) {
      const svc = queue.shift();
      const hints = { kind: svc.name, title: svc.name };
      const found = svc.url
        ? await icons.resolveIcon(svc.url, { iconsDir: ICONS_DIR, dataDir: DATA_DIR, name: svc.name, hints })
        : await icons.resolveIcon('', { iconsDir: ICONS_DIR, dataDir: DATA_DIR, name: svc.name, hints });
      const patch = {};
      if (found.file) {
        patch.icon_file = found.file;
        patch.icon_source = found.source;
        patch.icon_url = found.url;
      } else {
        patch.icon_file = icons.writeMonogram(ICONS_DIR, svc.name, svc.url);
        patch.icon_source = 'monogram';
      }
      if (found.html) {
        const title = icons.extractTitle(found.html);
        const desc = icons.extractDescription(found.html);
        if (title) patch.name = title;
        if (desc && !svc.description) patch.description = desc;
      }
      db.updateService(store, svc.id, patch);
      if (found.file) ok++;
      process.stdout.write(`\r  图标进度 ${ok}/${pending.length}  ${C.dim(svc.name.slice(0, 40))}          `);
    }
  });
  await Promise.all(workers);
  console.log(`\n\n  ${C.bold('完成')}：${added} 个服务入库，${ok} 个抓到真实图标，其余已生成字母图。\n`);
  store.close();
}

/* --------------------------------------------------------------- icons */

async function cmdIcons(args) {
  const mono = args.includes('--mono');
  const store = openStore();
  const list = db.listServices(store).filter((s) => !s.icon_file || s.icon_source !== 'custom');
  console.log(`\n  处理 ${list.length} 个服务的图标${mono ? '（字母图模式）' : ''}…\n`);
  let n = 0;
  let brand = 0;
  for (const svc of list) {
    if (mono) {
      const file = icons.writeMonogram(ICONS_DIR, svc.name, svc.url || svc.name);
      db.updateService(store, svc.id, { icon_file: file, icon_source: 'monogram', icon_url: null });
    } else {
      const hints = { kind: svc.name, title: svc.name };
      const found = await icons.resolveIcon(svc.url || '', {
        iconsDir: ICONS_DIR, dataDir: DATA_DIR, name: svc.name, hints,
      });
      if (found.file) {
        if (found.source.startsWith('图标库')) brand++;
        db.updateService(store, svc.id, { icon_file: found.file, icon_source: found.source, icon_url: found.url });
      } else {
        const file = icons.writeMonogram(ICONS_DIR, svc.name, svc.url || svc.name);
        db.updateService(store, svc.id, { icon_file: file, icon_source: 'monogram', icon_url: null });
      }
    }
    process.stdout.write(`\r  ${++n}/${list.length}  ${C.dim(svc.name.slice(0, 44))}          `);
  }
  console.log(`\n\n  完成${brand ? `，其中 ${brand} 个用了图标库的品牌图标` : ''}。\n`);
  store.close();
}

/* --------------------------------------------------------------- sync */

/**
 * 重新扫描，把启动命令等信息同步到已收录的服务上。
 * 命令会随服务重启变化，也是图标匹配的关键线索，值得单独同步一次。
 */
async function cmdSync() {
  const store = openStore();
  const services = db.listServices(store);
  if (!services.length) {
    console.log('\n  还没有收录任何服务，先跑 node cli.js seed\n');
    store.close();
    return;
  }
  const result = await scanPorts({ probe: false });
  const byPort = new Map(result.results.map((r) => [r.port, r]));

  let updated = 0;
  for (const s of services) {
    const live = byPort.get(s.port);
    if (!live) continue;
    // 只同步启动命令。名字不动 —— 它是用户可见的，导入之后可能被改过，
    // 用扫描推断的通用名去覆盖只会把好名字冲掉（页面标题比进程名有意义得多）。
    if (!live.command || live.command === s.command) continue;
    db.updateService(store, s.id, { command: live.command });
    updated++;
    console.log(`  ${C.green('↻')} ${String(s.port).padStart(6)}  ${C.dim(live.command.slice(0, 72))}`);
  }
  console.log(`\n  同步完成，更新了 ${C.bold(updated)} 个服务的启动命令。\n`);
  store.close();
}

/* -------------------------------------------------------------- titles */

/** 重新抓取各服务的页面标题，用来恢复被改乱的服务名 */
async function cmdTitles() {
  const store = openStore();
  const list = db.listServices(store).filter((s) => s.url);
  console.log(`\n  抓取 ${list.length} 个服务的页面标题…\n`);
  let n = 0;
  for (const s of list) {
    const res = await icons.resolveIcon(s.url, {
      iconsDir: ICONS_DIR, dataDir: DATA_DIR, name: s.name, hints: { command: s.command },
    });
    const title = res.html ? icons.extractTitle(res.html) : '';
    const desc = res.html ? icons.extractDescription(res.html) : '';
    const patch = {};
    if (title && title !== s.name) patch.name = title;
    if (desc && !s.description) patch.description = desc;
    if (Object.keys(patch).length) {
      db.updateService(store, s.id, patch);
      n++;
      console.log(`  ${C.green('↻')} ${String(s.port).padStart(6)}  ${s.name.slice(0, 26)} ${C.dim('→')} ${(patch.name || s.name).slice(0, 44)}`);
    }
  }
  console.log(`\n  更新了 ${C.bold(n)} 个服务的名称/描述。\n`);
  store.close();
}

/* ---------------------------------------------------------------- list */

async function cmdList() {
  const store = openStore();
  const list = db.listServices(store);
  const groups = db.listGroups(store);
  const byId = new Map(groups.map((g) => [g.id, g.name]));
  console.log(`\n  ${C.bold('已收录服务')}  ${C.dim(`${list.length} 个`)}\n`);
  for (const s of list) {
    const dot = s.status === 'online' ? C.green('●') : s.status === 'unknown' ? C.dim('○') : C.red('●');
    const icon = s.icon_source === 'monogram' ? C.dim('字母图') : s.icon_source === 'custom' ? C.blue('自定义') : C.green('已抓取');
    console.log(`  ${dot} ${C.blue(String(s.port ?? '-').padStart(6))}  ${s.name}`);
    console.log(`          ${C.dim(s.url)}  ${C.dim(`[${byId.get(s.group_id) || '未分组'}]`)} ${icon}`);
  }
  console.log();
  store.close();
}

/* --------------------------------------------------------------- check */

async function cmdCheck() {
  const store = openStore();
  const list = db.listServices(store).filter((s) => s.url || s.port);
  console.log(`\n  检测 ${list.length} 个服务…\n`);
  const results = await checkAll(
    list.map((s) => ({ id: s.id, url: s.url || '', host: s.host, port: s.port })),
    { concurrency: 12 },
  );
  let online = 0;
  for (const s of list) {
    const r = results.get(s.id);
    db.setStatus(store, s.id, r.status, r.latency);
    if (r.status === 'online' || r.status === 'port-open') online++;
    const mark = r.status === 'online' ? C.green('● 在线')
      : r.status === 'port-open' ? C.yellow('● 端口可连')
      : C.red(`● ${r.status === 'timeout' ? '超时' : '离线'}`);
    const via = r.via === 'tcp' ? C.dim(' TCP') : '';
    console.log(`  ${mark}${via}  ${String(r.latency ?? '-').padStart(5)}ms  ${C.blue(String(s.port ?? '-').padStart(6))}  ${s.name}`);
  }
  console.log(`\n  ${C.bold(`${online}/${list.length}`)} 在线\n`);
  store.close();
}

/* ---------------------------------------------------------------- main */

const [cmd, ...args] = process.argv.slice(2);
const table = {
  scan: cmdScan, seed: cmdSeed, icons: cmdIcons, list: cmdList, check: cmdCheck,
  sync: cmdSync, titles: cmdTitles,
};

if (!table[cmd]) {
  console.log(`
  ${C.bold('nav-hub CLI')}

    node cli.js scan           扫描本机监听端口
    node cli.js seed [--all]   扫描并导入服务（默认只导入 HTTP 服务，--all 含全部）
    node cli.js sync           重新扫描，同步已收录服务的启动命令
    node cli.js titles         重新抓页面标题，恢复服务名
    node cli.js icons [--mono] 重新处理图标（--mono 全部用字母图）
    node cli.js list           列出已收录服务
    node cli.js check          检测所有服务连通性

  环境变量：NAV_DB / NAV_DATA_DIR
`);
  process.exit(0);
}

await table[cmd](args);
