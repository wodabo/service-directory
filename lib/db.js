/**
 * 数据层：SQLite（node:sqlite 内置模块，零依赖）
 */
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

const SCHEMA_VERSION = 3;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS groups (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT    NOT NULL UNIQUE,
  color       TEXT    NOT NULL DEFAULT '#5b8def',
  sort_order  REAL    NOT NULL DEFAULT 0,
  collapsed   INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS services (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  name         TEXT    NOT NULL,
  url          TEXT    NOT NULL DEFAULT '',
  description  TEXT    NOT NULL DEFAULT '',
  group_id     INTEGER REFERENCES groups(id) ON DELETE SET NULL,
  port         INTEGER,
  host         TEXT    NOT NULL DEFAULT '127.0.0.1',
  icon_file    TEXT,
  icon_source  TEXT,
  icon_url     TEXT,
  icon_color   TEXT,
  tags         TEXT    NOT NULL DEFAULT '',
  favorite     INTEGER NOT NULL DEFAULT 0,
  sort_order   REAL    NOT NULL DEFAULT 0,
  status       TEXT    NOT NULL DEFAULT 'unknown',
  latency_ms   INTEGER,
  checked_at   INTEGER,
  notes        TEXT    NOT NULL DEFAULT '',
  created_at   INTEGER NOT NULL DEFAULT 0,
  updated_at   INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_services_group ON services(group_id, sort_order);
CREATE INDEX IF NOT EXISTS idx_services_port  ON services(port);

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS ignored_ports (
  port       INTEGER PRIMARY KEY,
  process    TEXT,
  created_at INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS scan_runs (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at INTEGER NOT NULL DEFAULT 0,
  found      INTEGER NOT NULL DEFAULT 0,
  added      INTEGER NOT NULL DEFAULT 0
);
`;

const now = () => Date.now();

export function openDb(file) {
  mkdirSync(dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA synchronous = NORMAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec(SCHEMA);
  migrate(db);
  db.prepare('UPDATE services SET status = ? WHERE status IS NULL').run('unknown');
  return db;
}

function migrate(db) {
  const current = db.prepare('PRAGMA user_version').get().user_version ?? 0;
  if (current === SCHEMA_VERSION) return;

  // v1 -> v2：补充 host / notes / icon_color 列（旧库升级用）
  if (current < 2) {
    const cols = new Set(db.prepare('PRAGMA table_info(services)').all().map((c) => c.name));
    const add = (name, ddl) => {
      if (!cols.has(name)) db.exec(`ALTER TABLE services ADD COLUMN ${ddl}`);
    };
    add('host', "host TEXT NOT NULL DEFAULT '127.0.0.1'");
    add('notes', "notes TEXT NOT NULL DEFAULT ''");
    add('icon_color', 'icon_color TEXT');
    add('latency_ms', 'latency_ms INTEGER');
    add('checked_at', 'checked_at INTEGER');
  }

  // v2 -> v3：记录进程启动命令。
  // 它既是重启服务时要用的信息，也是识别「这是什么软件」最可靠的线索
  // —— 页面标题会把服务名覆盖成站点名，命令行里的 vite / uvicorn 不会。
  if (current < 3) {
    const cols = new Set(db.prepare('PRAGMA table_info(services)').all().map((c) => c.name));
    if (!cols.has('command')) db.exec("ALTER TABLE services ADD COLUMN command TEXT NOT NULL DEFAULT ''");
  }
  db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
}

/* ------------------------------------------------------------------ 分组 */

export function listGroups(db) {
  return db.prepare(`
    SELECT g.*, (SELECT COUNT(*) FROM services s WHERE s.group_id = g.id) AS service_count
    FROM groups g
    ORDER BY g.sort_order ASC, g.id ASC
  `).all();
}

export function createGroup(db, { name, color }) {
  const t = now();
  const max = db.prepare('SELECT COALESCE(MAX(sort_order), 0) AS m FROM groups').get().m;
  const info = db.prepare(
    'INSERT INTO groups (name, color, sort_order, created_at) VALUES (?, ?, ?, ?)'
  ).run(String(name).trim(), color || '#5b8def', max + 10, t);
  return db.prepare('SELECT * FROM groups WHERE id = ?').get(info.lastInsertRowid);
}

export function updateGroup(db, id, patch) {
  const cur = db.prepare('SELECT * FROM groups WHERE id = ?').get(id);
  if (!cur) return null;
  db.prepare('UPDATE groups SET name = ?, color = ?, sort_order = ?, collapsed = ? WHERE id = ?')
    .run(
      patch.name !== undefined ? String(patch.name).trim() : cur.name,
      patch.color ?? cur.color,
      patch.sort_order ?? cur.sort_order,
      patch.collapsed !== undefined ? (patch.collapsed ? 1 : 0) : cur.collapsed,
      id,
    );
  return db.prepare('SELECT * FROM groups WHERE id = ?').get(id);
}

export function deleteGroup(db, id) {
  return db.prepare('DELETE FROM groups WHERE id = ?').run(id).changes > 0;
}

export function ensureGroup(db, name) {
  const found = db.prepare('SELECT * FROM groups WHERE name = ?').get(name);
  return found || createGroup(db, { name });
}

/* ------------------------------------------------------------------ 服务 */

export function listServices(db) {
  return db.prepare(`
    SELECT s.*, g.name AS group_name, g.color AS group_color
    FROM services s
    LEFT JOIN groups g ON g.id = s.group_id
    ORDER BY s.sort_order ASC, s.id ASC
  `).all();
}

export function getService(db, id) {
  return db.prepare('SELECT * FROM services WHERE id = ?').get(id) || null;
}

export function findByUrl(db, url) {
  return db.prepare('SELECT * FROM services WHERE url = ?').get(url) || null;
}

export function findByPort(db, port) {
  return db.prepare('SELECT * FROM services WHERE port = ?').get(port) || null;
}

const FIELDS = [
  'name', 'url', 'description', 'group_id', 'port', 'host',
  'icon_file', 'icon_source', 'icon_url', 'icon_color',
  'tags', 'sort_order', 'command',
];

function normalize(input, cur = {}) {
  const out = {};
  for (const f of FIELDS) {
    if (input[f] === undefined) continue;
    out[f] = input[f];
  }
  if (out.port !== undefined) {
    const p = parseInt(out.port, 10);
    out.port = Number.isFinite(p) && p > 0 && p < 65536 ? p : null;
  }
  if (out.sort_order !== undefined) out.sort_order = Number(out.sort_order) || 0;
  if (out.group_id !== undefined) {
    const g = parseInt(out.group_id, 10);
    out.group_id = Number.isFinite(g) && g > 0 ? g : null;
  }
  if (out.name !== undefined) out.name = String(out.name).trim().slice(0, 120);
  if (out.url !== undefined) out.url = String(out.url).trim().slice(0, 500);
  if (out.description !== undefined) out.description = String(out.description).slice(0, 500);
  if (out.tags !== undefined) {
    out.tags = String(out.tags).split(/[,，\s]+/).map((t) => t.trim()).filter(Boolean).join(',');
  }
  if (cur.id === undefined && out.sort_order === undefined) out.sort_order = 0;
  return out;
}

export function createService(db, input) {
  const data = normalize(input);
  if (!data.name) throw new Error('name is required');
  const t = now();
  const max = db.prepare('SELECT COALESCE(MAX(sort_order), 0) AS m FROM services').get().m;
  const info = db.prepare(`
    INSERT INTO services (name, url, description, group_id, port, host, icon_file, icon_source,
      icon_url, icon_color, tags, sort_order, command, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'unknown', ?, ?)
  `).run(
    data.name,
    data.url ?? '',
    data.description ?? '',
    data.group_id ?? null,
    data.port ?? null,
    data.host ?? '127.0.0.1',
    data.icon_file ?? null,
    data.icon_source ?? null,
    data.icon_url ?? null,
    data.icon_color ?? null,
    data.tags ?? '',
    data.sort_order ?? max + 10,
    data.command ?? '',
    t, t,
  );
  return getService(db, info.lastInsertRowid);
}

export function updateService(db, id, patch) {
  const cur = getService(db, id);
  if (!cur) return null;
  const data = normalize(patch, cur);
  const keys = Object.keys(data);
  if (!keys.length) return cur;
  const sets = keys.map((k) => `${k} = ?`).join(', ');
  db.prepare(`UPDATE services SET ${sets}, updated_at = ? WHERE id = ?`)
    .run(...keys.map((k) => data[k]), now(), id);
  return getService(db, id);
}

export function deleteService(db, id) {
  const cur = getService(db, id);
  if (!cur) return null;
  db.prepare('DELETE FROM services WHERE id = ?').run(id);
  return cur;
}

export function setStatus(db, id, status, latency) {
  db.prepare('UPDATE services SET status = ?, latency_ms = ?, checked_at = ? WHERE id = ?')
    .run(status, latency ?? null, now(), id);
}

export function reorderServices(db, orderedIds) {
  const stmt = db.prepare('UPDATE services SET sort_order = ?, updated_at = ? WHERE id = ?');
  const t = now();
  orderedIds.forEach((id, i) => stmt.run((i + 1) * 10, t, id));
  return orderedIds.length;
}

export function reorderGroups(db, orderedIds) {
  const stmt = db.prepare('UPDATE groups SET sort_order = ? WHERE id = ?');
  orderedIds.forEach((id, i) => stmt.run((i + 1) * 10, id));
  return orderedIds.length;
}

/* ------------------------------------------------------------------ 设置 */

export function getSettings(db) {
  const rows = db.prepare('SELECT key, value FROM settings').all();
  const out = {};
  for (const r of rows) {
    try { out[r.key] = JSON.parse(r.value); } catch { out[r.key] = r.value; }
  }
  return out;
}

export function setSetting(db, key, value) {
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(key, JSON.stringify(value));
  return value;
}

export function getSetting(db, key, fallback = null) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  if (!row) return fallback;
  try { return JSON.parse(row.value); } catch { return row.value; }
}

/* ------------------------------------------------------------ 忽略的端口 */

export function listIgnoredPorts(db) {
  return db.prepare('SELECT port FROM ignored_ports').all().map((r) => r.port);
}

export function ignorePort(db, port, process) {
  db.prepare('INSERT OR REPLACE INTO ignored_ports (port, process, created_at) VALUES (?, ?, ?)')
    .run(port, process || '', now());
}

export function unignorePort(db, port) {
  db.prepare('DELETE FROM ignored_ports WHERE port = ?').run(port);
}

/* ------------------------------------------------------------------ 导入导出 */

export function exportAll(db) {
  return {
    version: SCHEMA_VERSION,
    exported_at: new Date().toISOString(),
    groups: db.prepare('SELECT * FROM groups ORDER BY sort_order').all(),
    services: db.prepare('SELECT * FROM services ORDER BY sort_order').all(),
    settings: getSettings(db),
  };
}

export function importAll(db, payload, { replace = false } = {}) {
  const groups = Array.isArray(payload?.groups) ? payload.groups : [];
  const services = Array.isArray(payload?.services) ? payload.services : [];
  if (replace) {
    db.exec('DELETE FROM services');
    db.exec('DELETE FROM groups');
  }
  const groupMap = new Map();
  for (const g of groups) {
    const row = ensureGroup(db, g.name);
    groupMap.set(g.id, row.id);
    if (g.color) updateGroup(db, row.id, { color: g.color });
  }
  let added = 0;
  for (const s of services) {
    if (!s.name) continue;
    const url = s.url || '';
    if (url && findByUrl(db, url)) continue;
    createService(db, { ...s, group_id: groupMap.get(s.group_id) ?? null });
    added++;
  }
  return { groups: groupMap.size, services: added };
}

export function recordScan(db, found, added) {
  db.prepare('INSERT INTO scan_runs (created_at, found, added) VALUES (?, ?, ?)').run(now(), found, added);
}
