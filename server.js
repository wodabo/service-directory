/**
 * nav-hub 服务端：静态资源 + REST API + SSE 实时推送
 * 零依赖，仅用 Node 内置模块。
 */
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { existsSync, mkdirSync, writeFileSync, unlinkSync, readdirSync } from 'node:fs';
import { extname, join, normalize, resolve } from 'node:path';
import { timingSafeEqual } from 'node:crypto';
import { networkInterfaces } from 'node:os';

import * as db from './lib/db.js';
import * as icons from './lib/icons.js';
import * as iconlib from './lib/iconlib.js';
import * as dockerx from './lib/docker.js';
import { scanPorts, checkHealth, checkAll, checkTargetWithExternal, detectZeroTier, probeHttp } from './lib/scan.js';
import { ROOT, DATA_DIR, ICONS_DIR, DB_FILE, PORT, HOST, AUTH, CONFIG_FILE } from './lib/config.js';

const PUBLIC_DIR = join(ROOT, 'public');

mkdirSync(ICONS_DIR, { recursive: true });
const store = db.openDb(DB_FILE);

/* ------------------------------------------------------------ SSE 广播 */

const clients = new Set();

function broadcast(event, payload) {
  const frame = `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
  for (const res of clients) {
    try { res.write(frame); } catch { clients.delete(res); }
  }
}

/* --------------------------------------------------- 图标后台任务队列 */

const iconQueue = [];
let iconRunning = 0;
const ICON_CONCURRENCY = 3;

function enqueueIcon(serviceId, { force = false } = {}) {
  if (iconQueue.some((j) => j.serviceId === serviceId)) return;
  iconQueue.push({ serviceId, force });
  pumpIconQueue();
}

function pumpIconQueue() {
  while (iconRunning < ICON_CONCURRENCY && iconQueue.length) {
    const job = iconQueue.shift();
    iconRunning++;
    resolveIconFor(job.serviceId, { force: job.force })
      .catch((err) => console.error('[icon] 失败', job.serviceId, err?.message || err))
      .finally(() => { iconRunning--; pumpIconQueue(); });
  }
}

async function resolveIconFor(serviceId, { force = false } = {}) {
  const svc = db.getService(store, serviceId);
  if (!svc) return null;
  const hasIcon = svc.icon_file && icons.iconExists(ICONS_DIR, svc.icon_file);
  if (hasIcon && !force && svc.icon_source !== 'monogram') return svc;

  const pageUrl = svc.url || '';
  let result = { file: null, source: 'none', url: null };

  // 用户手工指定或从图标库挑的，默认不覆盖；
  // 但 force 表示用户明确要求重新检索（点了「↻ 自动」），这时要放行。
  if (!force && (svc.icon_source === 'custom' || svc.icon_source === 'library') && hasIcon) return svc;

  // hints 里是识别「这是什么软件」的线索：启动命令最可靠（vite / uvicorn / postgres 都在里面），
  // 名称次之（"PostgreSQL · OrbStack"），图标库据此匹配品牌图标。
  const hints = { kind: svc.name, command: svc.command, title: svc.name };
  result = await icons.resolveIcon(pageUrl, {
    iconsDir: ICONS_DIR, dataDir: DATA_DIR, name: svc.name, force, hints,
  });

  const patch = {};
  if (result.file) {
    patch.icon_file = result.file;
    patch.icon_source = result.source;
    patch.icon_url = result.url;
  } else {
    // 兜底：生成字母图，保证卡片永远有图标
    patch.icon_file = icons.writeMonogram(ICONS_DIR, svc.name, svc.url || svc.name);
    patch.icon_source = 'monogram';
    patch.icon_url = null;
  }

  // 顺带补全名称/描述
  if (result.html) {
    const title = icons.extractTitle(result.html);
    const desc = icons.extractDescription(result.html);
    if (title && (!svc.name || /^[0-9a-zA-Z_.-]+:\d+$/.test(svc.name) || svc.name === `端口 ${svc.port}`)) {
      patch.name = title;
    }
    if (desc && !svc.description) patch.description = desc;
  }

  const updated = db.updateService(store, serviceId, patch);
  broadcast('service', updated);
  return updated;
}

/* ---------------------------------------------------------------- 工具 */

function json(res, code, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function readBody(req, limit = 2 * 1024 * 1024) {
  return new Promise((resolvePromise, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new Error('请求体过大')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolvePromise({});
      try { resolvePromise(JSON.parse(raw)); } catch { reject(new Error('JSON 解析失败')); }
    });
    req.on('error', reject);
  });
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

async function serveFile(req, res, filePath, { cache = false } = {}) {
  try {
    const info = await stat(filePath);
    if (!info.isFile()) throw new Error('not a file');
    // HTML/CSS/JS：no-cache + ETag。只发 no-cache 而没有验证器时，个别浏览器
    // 仍会直接用内存缓存，改了样式刷新也不落地（实际踩过）；有了 ETag，
    // 浏览器每次都会带 If-None-Match 来验证，文件没变回 304，变了拿新内容。
    // 图标走长缓存（文件内容不变）。
    const etag = `W/"${info.size.toString(36)}-${Math.floor(info.mtimeMs).toString(36)}"`;
    if (!cache && req.headers['if-none-match'] === etag) {
      res.writeHead(304, { ETag: etag, 'Cache-Control': 'no-cache' });
      return res.end();
    }
    const body = await readFile(filePath);
    res.writeHead(200, {
      'Content-Type': MIME[extname(filePath).toLowerCase()] || 'application/octet-stream',
      'Content-Length': body.length,
      ETag: etag,
      'Cache-Control': cache ? 'public, max-age=86400' : 'no-cache',
    });
    res.end(body);
  } catch {
    json(res, 404, { error: 'not found' });
  }
}

function safeJoin(base, target) {
  const p = resolve(base, '.' + normalize('/' + target).replace(/^\/+/, '/'));
  return p.startsWith(base) ? p : null;
}

/* ------------------------------------------------------------ 访问鉴权 */

function sameSecret(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  // 长度不同直接判否；长度相同也要定长比较，避免按字符逐位比较泄漏信息
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

/** 设了 NAV_AUTH 才生效；否则一律放行 */
function authorized(req, res) {
  if (!AUTH) return true;
  const header = req.headers.authorization || '';
  const [scheme, encoded] = header.split(' ');
  if (scheme === 'Basic' && encoded) {
    const decoded = Buffer.from(encoded, 'base64').toString('utf8');
    const sep = decoded.indexOf(':');
    if (sep >= 0) {
      const user = decoded.slice(0, sep);
      const pass = decoded.slice(sep + 1);
      const cut = AUTH.indexOf(':');
      if (cut >= 0 && sameSecret(user, AUTH.slice(0, cut)) && sameSecret(pass, AUTH.slice(cut + 1))) {
        return true;
      }
    }
  }
  res.writeHead(401, {
    'WWW-Authenticate': 'Basic realm="nav-hub", charset="UTF-8"',
    'Content-Type': 'text/plain; charset=utf-8',
  });
  res.end('需要登录');
  return false;
}

/**
 * 列出可供其它设备访问的本机地址。
 * 过滤掉几类连不上的：Clash/Mihomo TUN 的假网段、主机位全 0 的网络地址。
 * ZeroTier 的 feth* 接口看着像虚拟网卡，但它正是用户要用的外部地址，单独标注。
 *
 * @param {Set<string>} ztDevices 已知的 ZeroTier 接口名
 */
const TUN_FAKE_RANGES = [/^198\.18\./, /^198\.19\./, /^172\.16\.0\.1$/, /^10\.0\.0\.1$/];
const VIRTUAL_IFACE = /^(bridge|utun|feth|vmenet|awdl|llw|ap\d)/i;

function lanAddresses(ztDevices = new Set()) {
  const out = [];
  for (const [name, addrs] of Object.entries(networkInterfaces())) {
    for (const a of addrs || []) {
      if (a.family !== 'IPv4' || a.internal) continue;
      if (TUN_FAKE_RANGES.some((re) => re.test(a.address))) continue;
      if (a.address.endsWith('.0') || a.address.endsWith('.255')) continue; // 网络/广播地址
      const zerotier = ztDevices.has(name);
      out.push({
        name,
        address: a.address,
        zerotier,
        virtual: !zerotier && VIRTUAL_IFACE.test(name),
      });
    }
  }
  // 物理网卡 → ZeroTier → 其它虚拟网卡
  const rank = (x) => (x.zerotier ? 1 : x.virtual ? 2 : 0);
  return out.sort((a, b) => rank(a) - rank(b));
}

/** 带 ZeroTier 信息的地址列表（会调用一次 zerotier-cli） */
async function lanAddressesWithZt() {
  const zt = await detectZeroTier();
  const devices = new Set((zt.networks || []).map((n) => n.dev).filter(Boolean));
  return { addresses: lanAddresses(devices), zerotier: zt };
}

/* ------------------------------------------------------------ 启动数据 */

function bootstrapPayload() {
  const groups = db.listGroups(store);
  const services = db.listServices(store);
  return {
    groups,
    services,
    settings: db.getSettings(store),
    ignoredPorts: db.listIgnoredPorts(store),
    stats: {
      total: services.length,
      online: services.filter((s) => s.status === 'online').length,
      offline: services.filter((s) => s.status === 'offline' || s.status === 'timeout').length,
    },
  };
}

/* -------------------------------------------------------------- 路由表 */

const routes = [];
const route = (method, pattern, handler) => {
  const keys = [];
  const regex = new RegExp('^' + pattern.replace(/:(\w+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '$');
  routes.push({ method, regex, keys, handler });
};

/* --- 服务 CRUD --- */

route('GET', '/api/bootstrap', async (req, res) => json(res, 200, bootstrapPayload()));

route('GET', '/api/services', async (req, res) => json(res, 200, db.listServices(store)));

route('GET', '/api/services/:id', async (req, res, params) => {
  const svc = db.getService(store, Number(params.id));
  if (!svc) return json(res, 404, { error: '服务不存在' });
  json(res, 200, svc);
});

route('POST', '/api/services', async (req, res) => {
  const body = await readBody(req);
  const url = icons.normalizeUrl(body.url || '', body.host || '127.0.0.1');
  const payload = { ...body, url };
  if (url && !payload.port) payload.port = icons.portOf(url);
  if (url && !payload.host) payload.host = icons.hostnameOf(url) || '127.0.0.1';
  if (url && db.findByUrl(store, url)) return json(res, 409, { error: '该地址已存在' });

  const svc = db.createService(store, payload);
  if (payload.icon_file) {
    // 前端已经带上了图标（从图标库挑的或手工指定），别覆盖它的来源标记
    db.updateService(store, svc.id, { icon_source: payload.icon_source || 'custom' });
  } else {
    enqueueIcon(svc.id);
  }
  const fresh = db.getService(store, svc.id);
  broadcast('service', fresh);
  json(res, 201, fresh);
});

route('PUT', '/api/services/:id', async (req, res, params) => {
  const id = Number(params.id);
  const cur = db.getService(store, id);
  if (!cur) return json(res, 404, { error: '服务不存在' });
  const body = await readBody(req);

  const patch = { ...body };
  if (patch.url !== undefined) {
    patch.url = icons.normalizeUrl(patch.url, patch.host || cur.host);
    if (patch.url && !patch.port) patch.port = icons.portOf(patch.url);
    if (patch.url && patch.url !== cur.url) {
      const clash = db.findByUrl(store, patch.url);
      if (clash && clash.id !== id) return json(res, 409, { error: '该地址已被其他服务占用' });
    }
  }
  // URL 变了或名称变了，旧图标就该重新抓；但从图标库挑的图标不受影响
  const urlChanged = patch.url !== undefined && patch.url !== cur.url;
  const pinnedIcon = (patch.icon_source === 'custom' || patch.icon_source === 'library') && patch.icon_file;

  const svc = db.updateService(store, id, patch);
  if (urlChanged && !pinnedIcon) {
    db.updateService(store, id, { icon_file: null, icon_source: null, icon_url: null });
    enqueueIcon(id, { force: true });
  }
  const fresh = db.getService(store, id);
  broadcast('service', fresh);
  json(res, 200, fresh);
});

route('DELETE', '/api/services/:id', async (req, res, params) => {
  const removed = db.deleteService(store, Number(params.id));
  if (!removed) return json(res, 404, { error: '服务不存在' });
  broadcast('deleted', { id: removed.id });
  json(res, 200, { ok: true, id: removed.id });
});

route('POST', '/api/services/reorder', async (req, res) => {
  const { ids } = await readBody(req);
  if (!Array.isArray(ids)) return json(res, 400, { error: 'ids 必须是数组' });
  db.reorderServices(store, ids.map(Number));
  json(res, 200, { ok: true, count: ids.length });
});

/* --- 图标 --- */

route('POST', '/api/services/:id/icon', async (req, res, params) => {
  const id = Number(params.id);
  const svc = db.getService(store, id);
  if (!svc) return json(res, 404, { error: '服务不存在' });
  const body = await readBody(req).catch(() => ({}));

  if (body.icon_file === null) { // 重置为自动抓取
    db.updateService(store, id, { icon_file: null, icon_source: null, icon_url: null });
    enqueueIcon(id, { force: true });
    return json(res, 200, { ok: true, queued: true });
  }
  if (body.icon_url) { // 手工指定图片地址 / data URL
    const file = await icons.saveCustomIcon(ICONS_DIR, `${svc.id}-${Date.now()}`, body.icon_url);
    if (!file) return json(res, 400, { error: '无法解析该图片，请确认是可访问的图片地址或 data URL' });
    const updated = db.updateService(store, id, { icon_file: file, icon_source: 'custom', icon_url: body.icon_url.slice(0, 300) });
    broadcast('service', updated);
    return json(res, 200, updated);
  }
  const updated = await resolveIconFor(id, { force: true });
  json(res, 200, updated);
});

route('POST', '/api/services/:id/icon/generate', async (req, res, params) => {
  const id = Number(params.id);
  const svc = db.getService(store, id);
  if (!svc) return json(res, 404, { error: '服务不存在' });
  const body = await readBody(req).catch(() => ({}));
  const seed = body.seed || svc.url || svc.name;
  const file = icons.writeMonogram(ICONS_DIR, body.text || svc.name, seed);
  const updated = db.updateService(store, id, { icon_file: file, icon_source: 'monogram', icon_url: null });
  broadcast('service', updated);
  json(res, 200, updated);
});

/* --- 预览（不落库，编辑时实时抓元信息） --- */

route('POST', '/api/preview', async (req, res) => {
  const body = await readBody(req);
  const url = icons.normalizeUrl(body.url || '', body.host || '127.0.0.1');
  if (!url) return json(res, 400, { error: '请填写地址' });

  const port = icons.portOf(url);
  const out = {
    url,
    port,
    host: icons.hostnameOf(url) || '127.0.0.1',
    title: '',
    description: '',
    iconUrl: null,
    iconDataUrl: null,
    reachable: false,
    status: 0,
    latency: null,
  };

  const health = await checkHealth(url, 3500);
  out.reachable = health.status === 'online';
  out.status = health.code || 0;
  out.latency = health.latency;

  const found = await icons.resolveIcon(url, { iconsDir: ICONS_DIR, name: body.name || url });
  out.iconUrl = found.url;
  out.iconSource = found.source;
  if (found.file) {
    const bytes = await readFile(join(ICONS_DIR, found.file)).catch(() => null);
    if (bytes) {
      const ext = extname(found.file).slice(1);
      const mime = ext === 'svg' ? 'image/svg+xml' : ext === 'ico' ? 'image/x-icon' : `image/${ext === 'jpg' ? 'jpeg' : ext}`;
      out.iconDataUrl = `data:${mime};base64,${bytes.toString('base64')}`;
      out.iconFile = found.file;
    }
  }
  if (found.html) {
    out.title = icons.extractTitle(found.html);
    out.description = icons.extractDescription(found.html);
  }
  if (!out.title) {
    const probe = await probeHttp(port, out.host);
    out.title = probe.title || '';
    out.reachable = out.reachable || probe.http;
  }
  json(res, 200, out);
});

/* --- 端口扫描 --- */

route('POST', '/api/scan', async (req, res) => {
  const body = await readBody(req).catch(() => ({}));
  const services = db.listServices(store);
  const result = await scanPorts({
    existingPorts: new Set(services.map((s) => s.port).filter(Boolean)),
    existingUrls: new Set(services.map((s) => s.url).filter(Boolean)),
    ignored: db.listIgnoredPorts(store),
    probe: body.probe !== false,
  });
  db.recordScan(store, result.total, 0);
  json(res, 200, result);
});

route('POST', '/api/scan/import', async (req, res) => {
  const body = await readBody(req);
  const items = Array.isArray(body.items) ? body.items : [];
  const groupName = body.group || '本机服务';
  const group = db.ensureGroup(store, groupName);
  const created = [];

  for (const item of items) {
    const url = icons.normalizeUrl(item.url || `http://127.0.0.1:${item.port}`);
    if (db.findByUrl(store, url)) continue;
    const svc = db.createService(store, {
      name: item.name || `端口 ${item.port}`,
      url,
      port: item.port || icons.portOf(url),
      host: icons.hostnameOf(url) || '127.0.0.1',
      description: item.description || item.kind || '',
      group_id: group.id,
      tags: item.system ? '系统' : '',
      command: item.command || '',
      status: item.http ? 'online' : 'unknown',
      latency_ms: item.latency ?? null,
      checked_at: item.http ? Date.now() : null,
    });
    enqueueIcon(svc.id);
    created.push(svc);
  }
  broadcast('reload', { reason: 'scan-import', count: created.length });
  json(res, 200, { ok: true, created: created.length, ids: created.map((s) => s.id) });
});

route('POST', '/api/scan/ignore', async (req, res) => {
  const { port, process: proc, undo } = await readBody(req);
  const p = parseInt(port, 10);
  if (!Number.isFinite(p)) return json(res, 400, { error: 'port 无效' });
  if (undo) db.unignorePort(store, p); else db.ignorePort(store, p, proc);
  json(res, 200, { ok: true, ignoredPorts: db.listIgnoredPorts(store) });
});

/* --- 健康检查 --- */

route('POST', '/api/health', async (req, res) => {
  const body = await readBody(req).catch(() => ({}));
  let list = db.listServices(store);
  if (Array.isArray(body.ids) && body.ids.length) {
    const ids = new Set(body.ids.map(Number));
    list = list.filter((s) => ids.has(s.id));
  }
  const externalHost = db.getSetting(store, 'externalHost', '') || '';
  const targets = list
    .filter((s) => s.url || s.port)
    .map((s) => ({ id: s.id, url: s.url || '', host: s.host || '127.0.0.1', port: s.port || null }));

  const results = await checkAllExternal(targets, externalHost, body);
  const updated = [];
  for (const t of targets) {
    const r = results.get(t.id);
    if (!r) continue;
    db.setStatus(store, t.id, r.status, r.latency);
    updated.push({ id: t.id, ...r });
  }
  broadcast('health', { updated, at: Date.now() });
  json(res, 200, { ok: true, checked: updated.length, externalHost: externalHost || null, updated });
});

/** 设了外部地址就做内外双探，否则退回普通探测 */
async function checkAllExternal(targets, externalHost, opts = {}) {
  if (!externalHost) {
    return checkAll(targets, { concurrency: opts.concurrency || 12, timeout: opts.timeout || 3000 });
  }
  const out = new Map();
  const queue = [...targets];
  const workers = Array.from({ length: Math.min(opts.concurrency || 8, queue.length || 1) }, async () => {
    while (queue.length) {
      const t = queue.shift();
      out.set(t.id, await checkTargetWithExternal(t, externalHost, opts.timeout || 3000));
    }
  });
  await Promise.all(workers);
  return out;
}

/* --- 网络环境（ZeroTier 等） --- */

route('GET', '/api/network', async (req, res) => {
  const { addresses, zerotier } = await lanAddressesWithZt();
  json(res, 200, {
    interfaces: addresses,
    zerotier,
    externalHost: db.getSetting(store, 'externalHost', '') || '',
  });
});

/** 探测某地址是否真能访问到服务，用于「外部地址能不能用」的预检 */
route('POST', '/api/network/probe', async (req, res) => {
  const body = await readBody(req).catch(() => ({}));
  const host = String(body.host || '').trim();
  if (!host) return json(res, 400, { error: '请提供 host' });
  const services = db.listServices(store).filter((s) => s.port);
  const sample = body.all ? services : services.slice(0, 8);

  const out = [];
  const queue = [...sample];
  const workers = Array.from({ length: Math.min(8, queue.length || 1) }, async () => {
    while (queue.length) {
      const s = queue.shift();
      const r = await checkTargetWithExternal(
        { url: s.url || '', host: s.host, port: s.port }, host, 2500,
      );
      out.push({ id: s.id, name: s.name, port: s.port, status: r.status });
    }
  });
  await Promise.all(workers);
  out.sort((a, b) => a.port - b.port);
  json(res, 200, {
    host,
    reachable: out.filter((o) => o.status === 'online').length,
    localOnly: out.filter((o) => o.status === 'local-only').length,
    total: out.length,
    results: out,
  });
});

/* --- 分组 --- */

route('GET', '/api/groups', async (req, res) => json(res, 200, db.listGroups(store)));

route('POST', '/api/groups', async (req, res) => {
  const body = await readBody(req);
  if (!body.name?.trim()) return json(res, 400, { error: '请填写分组名' });
  const exists = db.listGroups(store).find((g) => g.name === body.name.trim());
  if (exists) return json(res, 409, { error: '分组已存在' });
  const g = db.createGroup(store, body);
  broadcast('reload', { reason: 'group' });
  json(res, 201, g);
});

route('PUT', '/api/groups/:id', async (req, res, params) => {
  const g = db.updateGroup(store, Number(params.id), await readBody(req));
  if (!g) return json(res, 404, { error: '分组不存在' });
  broadcast('reload', { reason: 'group' });
  json(res, 200, g);
});

route('DELETE', '/api/groups/:id', async (req, res, params) => {
  const ok = db.deleteGroup(store, Number(params.id));
  if (!ok) return json(res, 404, { error: '分组不存在' });
  broadcast('reload', { reason: 'group' });
  json(res, 200, { ok: true });
});

route('POST', '/api/groups/reorder', async (req, res) => {
  const { ids } = await readBody(req);
  if (!Array.isArray(ids)) return json(res, 400, { error: 'ids 必须是数组' });
  db.reorderGroups(store, ids.map(Number));
  json(res, 200, { ok: true });
});

/* --- 图标库 --- */

route('GET', '/api/iconlib', async (req, res) => {
  // 首次访问时后台建索引，前端据此显示进度
  const status = iconlib.indexStatus(DATA_DIR);
  if (status.state !== 'ready' && status.state !== 'building') {
    iconlib.ensureIndex(DATA_DIR).catch((err) => console.error('[iconlib] 建索引失败:', err.message));
  }
  // indexStatus 里的 libraries 已含各库的图标数量，前端要用它算总数
  json(res, 200, iconlib.indexStatus(DATA_DIR));
});

route('POST', '/api/iconlib/refresh', async (req, res) => {
  try {
    const r = await iconlib.ensureIndex(DATA_DIR, { force: true });
    json(res, 200, { ok: true, ...iconlib.indexStatus(DATA_DIR), warnings: r.warnings });
  } catch (err) {
    json(res, 500, { error: err.message });
  }
});

route('GET', '/api/iconlib/search', async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const q = url.searchParams.get('q') || '';
  const limit = Math.min(parseInt(url.searchParams.get('limit') || '60', 10) || 60, 200);
  const status = iconlib.indexStatus(DATA_DIR);
  if (status.state !== 'ready') {
    if (status.state !== 'building') {
      iconlib.ensureIndex(DATA_DIR).catch((err) => console.error('[iconlib] 建索引失败:', err.message));
    }
    return json(res, 200, { state: 'building', query: q, results: [] });
  }
  json(res, 200, { state: 'ready', query: q, results: iconlib.searchIcons(DATA_DIR, q, limit) });
});

/**
 * 取用图标库里的某个图标：下载到本地缓存并返回文件名，不改动任何服务。
 * 前端拿到文件名后随服务一起保存（icon_source = 'library'）。
 */
route('POST', '/api/iconlib/apply', async (req, res) => {
  const body = await readBody(req);
  const lib = String(body.lib || 'dashboard-icons');
  const name = String(body.name || '').trim();
  if (!name) return json(res, 400, { error: '请提供图标名' });

  try {
    const { buf, url } = await iconlib.fetchIconBytes(lib, name);
    const kind = icons.sniffImage(buf);
    if (!kind) return json(res, 400, { error: '下载到的不是有效图片' });

    const payload = kind.ext === 'svg'
      ? Buffer.from(icons.sanitizeSvg(buf.toString('utf8')), 'utf8')
      : buf;
    const file = `lib-${lib.replace(/[^\w-]/g, '')}-${name.replace(/[^\w.@-]/g, '_')}.${kind.ext}`;
    writeFileSync(join(ICONS_DIR, file), payload);

    json(res, 200, {
      ok: true, icon_file: file, icon_source: 'library', icon_url: url,
      library: lib, name, bytes: payload.length,
    });
  } catch (err) {
    json(res, 400, { error: err.message });
  }
});

/* --- 设置 / 导入导出 --- */

route('GET', '/api/settings', async (req, res) => json(res, 200, db.getSettings(store)));

route('PUT', '/api/settings', async (req, res) => {
  const body = await readBody(req);
  for (const [k, v] of Object.entries(body)) db.setSetting(store, k, v);
  json(res, 200, db.getSettings(store));
});

/* --- 站点品牌（名称 / 图标） --- */

const SITE_ICON_BASE = 'site-icon'; // 文件名前缀，实际文件 site-icon.<ext>

// site-icon.<ext> 可能是任何扩展名，找出现在实际存在的那个
function siteIconPath() {
  if (!existsSync(ICONS_DIR)) return null;
  try {
    for (const f of readdirSync(ICONS_DIR)) {
      if (f === SITE_ICON_BASE || f.startsWith(`${SITE_ICON_BASE}.`)) return join(ICONS_DIR, f);
    }
  } catch { /* noop */ }
  return null;
}

// 上传站点图标：前端传 data URL，服务端落盘到 icons 目录
route('POST', '/api/site-icon', async (req, res) => {
  const body = await readBody(req, 5 * 1024 * 1024);
  const m = String(body.dataUrl || '').match(/^data:(image\/(?:png|jpeg|webp|svg\+xml|x-icon));base64,([\s\S]+)$/);
  if (!m) return json(res, 400, { error: '仅支持 PNG / JPG / WebP / SVG / ICO 图片' });
  const ext = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/svg+xml': 'svg', 'image/x-icon': 'ico' }[m[1]];
  const buf = Buffer.from(m[2], 'base64');
  if (!buf.length) return json(res, 400, { error: '图片内容为空' });
  if (buf.length > 3 * 1024 * 1024) return json(res, 400, { error: '图片太大（超过 3MB）' });

  // 删旧文件（扩展名可能不同，避免 site-icon.png / site-icon.svg 并存）
  const old = siteIconPath();
  if (old) { try { unlinkSync(old); } catch { /* noop */ } }
  const file = `${SITE_ICON_BASE}.${ext}`;
  writeFileSync(join(ICONS_DIR, file), buf);
  db.setSetting(store, 'siteIcon', file);
  broadcast('reload', { reason: 'site-icon' });
  json(res, 200, { ok: true, siteIcon: file });
});

route('DELETE', '/api/site-icon', async (req, res) => {
  const old = siteIconPath();
  if (old) { try { unlinkSync(old); } catch { /* noop */ } }
  db.setSetting(store, 'siteIcon', '');
  broadcast('reload', { reason: 'site-icon' });
  json(res, 200, { ok: true });
});

route('GET', '/api/export', async (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Disposition': `attachment; filename="nav-hub-${new Date().toISOString().slice(0, 10)}.json"`,
  });
  res.end(JSON.stringify(db.exportAll(store), null, 2));
});

route('POST', '/api/import', async (req, res) => {
  const body = await readBody(req, 10 * 1024 * 1024);
  const payload = body.data || body;
  const result = db.importAll(store, payload, { replace: Boolean(body.replace) });
  broadcast('reload', { reason: 'import' });
  json(res, 200, { ok: true, ...result });
});

/* --- 数据库信息 --- */

route('GET', '/api/db', async (req, res) => {
  const size = existsSync(DB_FILE) ? (await stat(DB_FILE)).size : 0;
  json(res, 200, {
    file: DB_FILE,
    iconsDir: ICONS_DIR,
    size,
    services: db.listServices(store).length,
    groups: db.listGroups(store).length,
    iconCount: existsSync(ICONS_DIR) ? (await import('node:fs')).readdirSync(ICONS_DIR).length : 0,
  });
});

/* --- Docker（容器 / 网络） --- */

// docker CLI 调用慢（stats 一次要几秒），同一路径短时间内的重复请求合并成一次
const dockerCache = new Map();
function dockerCached(key, ttlMs, fn) {
  const hit = dockerCache.get(key);
  if (hit && Date.now() - hit.at < ttlMs) return hit.promise;
  const promise = fn().finally(() => setTimeout(() => dockerCache.delete(key), ttlMs).unref?.());
  dockerCache.set(key, { at: Date.now(), promise });
  return promise;
}

route('GET', '/api/docker/containers', async (req, res) => {
  try {
    const containers = await dockerCached('containers', 5000, () => dockerx.listContainers());
    json(res, 200, { ok: true, containers });
  } catch (err) {
    json(res, 503, { ok: false, error: err.message });
  }
});

route('GET', '/api/docker/containers/:id', async (req, res, params) => {
  try {
    const c = await dockerCached(`inspect:${params.id}`, 3000, () => dockerx.inspectContainer(params.id));
    json(res, 200, { ok: true, container: c });
  } catch (err) {
    json(res, err.code === 'DOCKER_UNAVAILABLE' ? 503 : 404, { ok: false, error: err.message });
  }
});

route('GET', '/api/docker/containers/:id/logs', async (req, res, params) => {
  try {
    const tail = Number(new URL(req.url, 'http://x').searchParams.get('tail')) || 200;
    const logs = await dockerx.containerLogs(params.id, { tail });
    json(res, 200, { ok: true, logs });
  } catch (err) {
    json(res, err.code === 'DOCKER_UNAVAILABLE' ? 503 : 500, { ok: false, error: err.message });
  }
});

route('POST', '/api/docker/containers/:id/:action', async (req, res, params) => {
  const { id, action } = params;
  if (!['start', 'stop', 'restart', 'pause', 'unpause', 'kill'].includes(action)) {
    return json(res, 400, { ok: false, error: `不支持的操作：${action}` });
  }
  try {
    const container = await dockerx.containerAction(id, action);
    broadcast('docker', { reason: `container ${action}`, name: container?.name || id });
    json(res, 200, { ok: true, container });
  } catch (err) {
    json(res, err.code === 'DOCKER_UNAVAILABLE' ? 503 : 500, { ok: false, error: err.message });
  }
});

route('GET', '/api/docker/networks', async (req, res) => {
  try {
    const networks = await dockerCached('networks', 8000, () => dockerx.listNetworks());
    json(res, 200, { ok: true, networks });
  } catch (err) {
    json(res, 503, { ok: false, error: err.message });
  }
});

/* ------------------------------------------------------------ 请求分发 */

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = decodeURIComponent(url.pathname);

  res.setHeader('X-Content-Type-Options', 'nosniff');

  if (!authorized(req, res)) return;

  // SSE
  if (pathname === '/api/events') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write(`event: hello\ndata: ${JSON.stringify({ at: Date.now() })}\n\n`);
    clients.add(res);
    const ping = setInterval(() => { try { res.write(': ping\n\n'); } catch { /* noop */ } }, 25000);
    req.on('close', () => { clearInterval(ping); clients.delete(res); });
    return;
  }

  // 图标静态资源
  if (pathname.startsWith('/icons/')) {
    const file = safeJoin(ICONS_DIR, pathname.slice('/icons/'.length));
    if (!file) return json(res, 400, { error: 'bad path' });
    return serveFile(req, res, file, { cache: true });
  }

  if (pathname.startsWith('/api/')) {
    for (const r of routes) {
      if (r.method !== req.method) continue;
      const m = pathname.match(r.regex);
      if (!m) continue;
      const params = Object.fromEntries(r.keys.map((k, i) => [k, m[i + 1]]));
      try {
        return await r.handler(req, res, params);
      } catch (err) {
        console.error(`[api] ${req.method} ${pathname}`, err);
        if (!res.headersSent) json(res, 500, { error: err?.message || '服务器内部错误' });
        return;
      }
    }
    return json(res, 404, { error: `未知接口 ${req.method} ${pathname}` });
  }

  // 静态前端
  const rel = pathname === '/' ? 'index.html' : pathname.slice(1);
  const file = safeJoin(PUBLIC_DIR, rel);
  if (!file) return json(res, 400, { error: 'bad path' });
  return serveFile(req, res, file);
});

/* ------------------------------------------------- 定时健康检查（可选） */

let healthTimer = null;
function scheduleHealth() {
  if (healthTimer) clearInterval(healthTimer);
  healthTimer = null;
  const seconds = Number(db.getSetting(store, 'healthInterval', 0));
  if (!seconds || seconds < 10) return;
  healthTimer = setInterval(async () => {
    const list = db.listServices(store).filter((s) => s.url || s.port);
    if (!list.length) return;
    const externalHost = db.getSetting(store, 'externalHost', '') || '';
    const results = await checkAllExternal(
      list.map((s) => ({ id: s.id, url: s.url || '', host: s.host, port: s.port })),
      externalHost,
      { concurrency: 10 },
    );
    const updated = [];
    for (const [id, r] of results) {
      db.setStatus(store, id, r.status, r.latency);
      updated.push({ id, ...r });
    }
    broadcast('health', { updated, at: Date.now() });
  }, seconds * 1000);
  healthTimer.unref?.();
}

/* ------------------------------------------------------------ 启动 */

server.listen(PORT, HOST, async () => {
  console.log(`\n  🧭  nav-hub 已启动`);
  console.log(`     本机访问   http://127.0.0.1:${PORT}`);
  if (HOST !== '127.0.0.1' && HOST !== 'localhost') {
    const { addresses } = await lanAddressesWithZt();
    for (const a of addresses) {
      const tag = a.zerotier ? 'ZeroTier' : a.virtual ? `${a.name}（虚拟网卡）` : a.name;
      console.log(`     局域网     http://${a.address}:${PORT}   ${tag}`);
    }
    if (!addresses.length) console.log(`     局域网     （没有检测到可用的非回环网卡）`);
    if (!AUTH) console.log(`     ⚠️  未设访问密码，同网段设备可直接打开。加密码：NAV_AUTH=user:pass`);
  }
  if (AUTH) console.log(`     访问密码   已开启（用户名 ${AUTH.split(':')[0]}）`);
  console.log(`     数据库     ${DB_FILE}`);
  console.log(`     图标目录   ${ICONS_DIR}`);
  if (existsSync(CONFIG_FILE)) console.log(`     配置文件   ${CONFIG_FILE}`);
  console.log(`     服务数量   ${db.listServices(store).length}\n`);

  // 启动时清理孤儿图标，再补齐缺失的
  const all = db.listServices(store);
  const orphans = icons.pruneOrphanIcons(
    ICONS_DIR,
    all.map((s) => s.icon_file).filter(Boolean),
    ['nav-hub.svg', ...(db.getSettings(store).siteIcon ? [db.getSettings(store).siteIcon] : [])], // 面板 favicon + 自定义站点图标
  );
  if (orphans) console.log(`     清理图标   ${orphans} 个无引用的缓存文件`);

  // 补齐缺失的图标（纯端口服务也会走到，生成字母图）
  for (const s of all) {
    if (!icons.iconExists(ICONS_DIR, s.icon_file)) enqueueIcon(s.id);
  }
  scheduleHealth();

  // 图标库索引有几 MB，放后台慢慢建，不挡启动
  iconlib.ensureIndex(DATA_DIR)
    .then(() => {
      // 用 indexStatus 计数，而不是自己遍历索引文件里的 libraries
      // —— 那个文件可能被别的工具写入额外条目，遍历会算多
      const st = iconlib.indexStatus(DATA_DIR);
      const detail = st.libraries.map((l) => `${l.label} ${l.count}`).join(' / ');
      console.log(`     图标库     ${st.total} 个图标可用（${detail}）`);
    })
    .catch((err) => console.warn(`     图标库     索引构建失败（${err.message}），不影响其它功能`));
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`端口 ${PORT} 已被占用。换个端口：NAV_PORT=7789 npm start`);
  } else {
    console.error('服务启动失败：', err);
  }
  process.exit(1);
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    console.log('\n  nav-hub 已停止');
    try { store.close(); } catch { /* noop */ }
    process.exit(0);
  });
}

export { server, store, scheduleHealth };
