/**
 * 路径配置
 *
 * 数据库和图标缓存的位置。三种启动方式（手动 node server.js、start.sh、LaunchAgent）
 * 都要用同一份配置，所以放在项目根目录的 nav.config.json 里，而不是散在各自的 env 里
 * —— 那样很容易出现"手动跑用这个库、开机自启用那个库"的情况。
 *
 * 优先级：环境变量 > nav.config.json > 默认值
 */
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
export const CONFIG_FILE = join(ROOT, 'nav.config.json');

function loadConfig() {
  try {
    return JSON.parse(readFileSync(CONFIG_FILE, 'utf8'));
  } catch {
    return {};
  }
}

const config = loadConfig();

/** 相对路径按项目根目录解析，绝对路径原样使用 */
function resolvePath(value, fallback) {
  if (!value) return fallback;
  return value.startsWith('/') ? value : join(ROOT, value);
}

export const DATA_DIR = resolvePath(
  process.env.NAV_DATA_DIR || config.dataDir,
  join(ROOT, 'data'),
);

/** 图标缓存与索引：跟 dataDir 走 */
export const ICONS_DIR = join(DATA_DIR, 'icons');

export const DB_FILE = resolvePath(
  process.env.NAV_DB || config.db,
  join(DATA_DIR, 'nav.db'),
);

export const PORT = parseInt(process.env.NAV_PORT || process.argv[2] || String(config.port || 7788), 10);

export const HOST = process.env.NAV_HOST || config.host || '0.0.0.0';

/** 访问密码，格式 "用户名:密码"；留空则不鉴权 */
export const AUTH = process.env.NAV_AUTH || config.auth || '';
