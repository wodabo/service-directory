/**
 * 图标库
 *
 * 从公开图标库按名字取图标。相比抓站点 favicon，图标库的好处是：
 * 内网服务、数据库、自研项目本来就没有 favicon，而图标库里有现成的品牌图标。
 *
 * 数据来源（都是 jsDelivr CDN，国内可达）：
 *   - dashboard-icons (walkxcode)：3500+ 个，覆盖开发工具与自托管应用，彩色
 *   - selfh.st/icons：7200+ 个，长尾自托管应用更全
 *
 * 索引（图标名清单）通过 GitHub API 拉取后缓存在 data/icon-index.json。
 * jsDelivr 自己的列表接口数据严重滞后（dashboard-icons 只列出 998 个，实际 3545 个），
 * 所以索引走 GitHub API，图标文件才走 CDN。
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';

const LIBRARIES = [
  {
    id: 'dashboard-icons',
    label: 'dashboard-icons',
    // 这个仓库已从 walkxcode/ 改名到 homarr-labs/，GitHub API 会自动重定向，
    // 但 jsDelivr 的旧路径是独立快照，所以新名优先、旧名兜底。
    repo: 'homarr-labs/dashboard-icons',
    branch: 'main',
    cdns: [
      'https://cdn.jsdelivr.net/gh/homarr-labs/dashboard-icons',
      'https://cdn.jsdelivr.net/gh/walkxcode/dashboard-icons',
    ],
  },
  {
    id: 'selfhst',
    label: 'selfh.st',
    repo: 'selfhst/icons',
    branch: 'main',
    cdns: ['https://cdn.jsdelivr.net/gh/selfhst/icons'],
  },
];

const INDEX_TTL = 30 * 24 * 3600 * 1000; // 30 天
const INDEX_TIMEOUT = 90_000; // 索引是几 MB 的响应，给足时间

export const libraryList = () => LIBRARIES.map(({ id, label }) => ({ id, label }));

/* ------------------------------------------------------------ 索引管理 */

let cache = null;          // { fetched_at, libraries: { id: { names: [] } } }
let indexState = 'idle';   // idle | building | ready | failed
let indexError = null;
let building = null;

function indexPath(dataDir) {
  return join(dataDir, 'icon-index.json');
}

function loadCache(dataDir) {
  if (cache) return cache;
  try {
    cache = JSON.parse(readFileSync(indexPath(dataDir), 'utf8'));
  } catch {
    cache = null;
  }
  return cache;
}

function isFresh(entry) {
  return entry && Date.now() - (entry.fetched_at || 0) < INDEX_TTL;
}

async function fetchNames(lib) {
  const url = `https://api.github.com/repos/${lib.repo}/git/trees/${lib.branch}?recursive=1`;
  const res = await fetch(url, {
    signal: AbortSignal.timeout(INDEX_TIMEOUT),
    headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'nav-hub/1.0' },
  });
  if (!res.ok) throw new Error(`${lib.id}: GitHub API ${res.status}`);
  const json = await res.json();
  if (!Array.isArray(json.tree)) throw new Error(`${lib.id}: 返回格式异常`);
  const names = json.tree
    .filter((f) => /^svg\/.+\.svg$/.test(f.path))
    .map((f) => f.path.slice(4, -4));
  if (!names.length) throw new Error(`${lib.id}: 未解析到任何图标`);
  return names;
}

/** 建立索引（已新鲜就直接返回；并发调用共享同一次构建） */
export async function ensureIndex(dataDir, { force = false } = {}) {
  const cached = loadCache(dataDir);
  if (!force && isFresh(cached)) {
    indexState = 'ready';
    return { state: 'ready', libraries: cached.libraries, fetched_at: cached.fetched_at };
  }
  if (building) return building;

  indexState = 'building';
  indexError = null;
  building = (async () => {
    const libraries = {};
    const errors = [];
    // 并行拉两个库；单库失败不影响另一个
    await Promise.all(LIBRARIES.map(async (lib) => {
      try {
        libraries[lib.id] = { names: await fetchNames(lib) };
      } catch (err) {
        errors.push(err.message);
        if (cached?.libraries?.[lib.id]) libraries[lib.id] = cached.libraries[lib.id];
      }
    }));

    if (!Object.keys(libraries).length) {
      indexState = 'failed';
      indexError = errors.join('; ') || '未知错误';
      building = null;
      throw new Error(indexError);
    }

    cache = { fetched_at: Date.now(), libraries };
    try {
      mkdirSync(dirname(indexPath(dataDir)), { recursive: true });
      writeFileSync(indexPath(dataDir), JSON.stringify(cache));
    } catch { /* 缓存写不了也能用，只是下次要重新拉 */ }

    indexState = 'ready';
    indexError = errors.length ? `部分库失败：${errors.join('; ')}` : null;
    building = null;
    return { state: 'ready', libraries, fetched_at: cache.fetched_at, warnings: errors };
  })();

  try {
    return await building;
  } catch (err) {
    building = null;
    throw err;
  }
}

export function indexStatus(dataDir) {
  const cached = loadCache(dataDir);
  const libraries = LIBRARIES.map((l) => ({
    id: l.id,
    label: l.label,
    count: cached?.libraries?.[l.id]?.names?.length || 0,
  }));
  // 只统计自己管的库：索引文件可能被别的工具写入额外条目
  const total = libraries.reduce((n, l) => n + l.count, 0);
  return {
    state: indexState === 'idle' && cached ? 'ready' : indexState,
    error: indexError,
    total,
    fetched_at: cached?.fetched_at || null,
    stale: Boolean(cached) && !isFresh(cached),
    libraries,
  };
}

/* ------------------------------------------------------------ 搜索 */

const norm = (s) => String(s || '').toLowerCase().replace(/[\s_.]+/g, '-');

/**
 * 按关键词搜索图标。优先精确匹配，其次前缀，最后子串。
 * 结果带上 cdn 前缀，前端可以直接引 CDN 做预览，不用自己拼仓库路径。
 * @returns {Array<{lib:string, name:string, cdn:string}>}
 */
export function searchIcons(dataDir, query, limit = 60) {
  const cached = loadCache(dataDir);
  if (!cached) return [];
  const q = norm(query).replace(/^-+|-+$/g, '');
  if (!q) return [];

  const exact = [];
  const prefix = [];
  const contains = [];

  for (const lib of LIBRARIES) {
    const cdn = lib.cdns[0];
    for (const name of cached.libraries?.[lib.id]?.names || []) {
      const n = norm(name);
      if (n === q) exact.push({ lib: lib.id, name, cdn });
      else if (n.startsWith(q)) prefix.push({ lib: lib.id, name, cdn });
      else if (n.includes(q)) contains.push({ lib: lib.id, name, cdn });
    }
  }

  const rank = (arr) => arr.sort((a, b) => {
    const la = a.name.length - b.name.length;      // 名字短的通常更通用
    if (la !== 0) return la;
    return a.lib === 'dashboard-icons' ? -1 : 1;   // 同长度优先 dashboard-icons
  });
  rank(prefix);
  rank(contains);

  return [...exact, ...prefix, ...contains].slice(0, limit);
}

/** 图标名是否存在于索引中 */
export function hasIcon(dataDir, libId, name) {
  const cached = loadCache(dataDir);
  return Boolean(cached?.libraries?.[libId]?.names?.includes(name));
}

/* ------------------------------------------------------- 按名取图标 */

/** 下载图标原始字节（不做校验，交给调用方 sniff） */
export async function fetchIconBytes(libId, name, timeout = 12_000) {
  const lib = LIBRARIES.find((l) => l.id === libId);
  if (!lib) throw new Error(`未知图标库 ${libId}`);
  if (!/^[\w.\-@/]+$/.test(name)) throw new Error('图标名含非法字符');

  let lastErr = null;
  for (const base of lib.cdns) {
    const url = `${base}/svg/${name}.svg`;
    try {
      const res = await fetch(url, {
        redirect: 'follow',
        signal: AbortSignal.timeout(timeout),
        headers: { 'User-Agent': 'nav-hub/1.0' },
      });
      if (!res.ok) {
        lastErr = new Error(`${libId}/${name} 取不到（HTTP ${res.status}）`);
        continue;
      }
      const buf = Buffer.from(await res.arrayBuffer());
      if (!buf.length) {
        lastErr = new Error(`${libId}/${name} 是空文件`);
        continue;
      }
      return { buf, url, library: libId, name };
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr || new Error(`${libId}/${name} 下载失败`);
}

/** 前端预览用：某个库对应的 CDN 前缀（图标网格里直接引 CDN，不走服务端中转） */
export function cdnFor(libId) {
  return LIBRARIES.find((l) => l.id === libId)?.cdns[0] || '';
}

/* ------------------------------------------------- 自动匹配（软件名 → 图标） */

/**
 * 已知软件的关键词 → 图标名。
 *
 * 只匹配「具体软件」，不匹配通用运行时（node / python）：用户自己的项目跑在 Node 上，
 * 给它套一个 Node 官方 logo 还不如用项目名首字母的字母图。
 * 构建工具是例外——vite / next / nuxt 出现在命令行里，基本就是这个工具本身。
 */
const SOFTWARE_MAP = [
  // 数据库与中间件
  { re: /postgres|psql/i, name: 'postgres' },
  { re: /redis/i, name: 'redis' },
  { re: /mariadb/i, name: 'mariadb' },
  { re: /\bmysql\b/i, name: 'mysql' },
  { re: /mongo/i, name: 'mongodb' },
  { re: /elasticsearch|opensearch/i, name: 'elasticsearch' },
  { re: /rabbitmq/i, name: 'rabbitmq' },
  { re: /kafka/i, name: 'apache-kafka' },
  { re: /clickhouse/i, name: 'clickhouse' },
  { re: /influxdb/i, name: 'influxdb' },
  { re: /memcached/i, name: 'memcached' },
  { re: /cassandra/i, name: 'apache-cassandra' },
  { re: /neo4j/i, name: 'neo4j' },
  { re: /\bminio\b/i, name: 'minio' },
  { re: /sqlite/i, name: 'sqlite' },
  // Web 服务器与网关
  { re: /nginx/i, name: 'nginx' },
  { re: /traefik/i, name: 'traefik' },
  { re: /caddy/i, name: 'caddy' },
  { re: /apache|httpd/i, name: 'apache' },
  // 构建工具 / 框架（命令行里出现即认为是它本身）
  { re: /\bvite\b/i, name: 'vite' },
  { re: /next\.?js|next dev/i, name: 'nextjs' },
  { re: /\bnuxt\b/i, name: 'nuxt' },
  { re: /webpack/i, name: 'webpack' },
  { re: /\bparcel\b/i, name: 'parcel' },
  { re: /\bastro\b/i, name: 'astro' },
  { re: /svelte-?kit/i, name: 'svelte' },
  { re: /\bgatsby\b/i, name: 'gatsby' },
  { re: /storybook/i, name: 'storybook' },
  // 运维 / 自托管面板
  { re: /grafana/i, name: 'grafana' },
  { re: /portainer/i, name: 'portainer' },
  { re: /prometheus/i, name: 'prometheus' },
  { re: /jenkins/i, name: 'jenkins' },
  { re: /gitlab/i, name: 'gitlab' },
  { re: /gitea/i, name: 'gitea' },
  { re: /sonarqube/i, name: 'sonarqube' },
  { re: /\bolama\b/i, name: 'ollama' },
  { re: /jupyter/i, name: 'jupyter' },
  { re: /uptime[- ]?kuma/i, name: 'uptime-kuma' },
  { re: /\bn8n\b/i, name: 'n8n' },
  { re: /\bdocker\b/i, name: 'docker' },
  { re: /home ?assistant/i, name: 'home-assistant' },
  { re: /jellyfin/i, name: 'jellyfin' },
  { re: /plex/i, name: 'plex' },
  { re: /immich/i, name: 'immich' },
  { re: /vaultwarden|bitwarden/i, name: 'vaultwarden' },
  { re: /paperless/i, name: 'paperless-ngx' },
  { re: /\bflowise\b/i, name: 'flowise' },
  { re: /open ?webui/i, name: 'open-webui' },
];

/**
 * 从服务信息里推断该用哪个图标。
 * @param {{kind?:string, command?:string, title?:string, name?:string}} hints
 * @returns {{name:string, matchedBy:string}|null}
 */
export function matchSoftware(hints = {}) {
  const fields = [
    ['类型', hints.kind],
    ['命令行', hints.command],
    ['标题', hints.title],
  ];
  for (const [source, value] of fields) {
    if (!value) continue;
    for (const entry of SOFTWARE_MAP) {
      if (entry.re.test(value)) return { name: entry.name, matchedBy: source };
    }
  }
  return null;
}

/** 校验自动匹配到的图标在索引里确实存在（索引没建好时放行，让 CDN 兜底） */
export function softwareIconAvailable(dataDir, name) {
  const cached = loadCache(dataDir);
  if (!cached) return true; // 索引还没建，交给下载环节判断
  return LIBRARIES.some((l) => cached.libraries?.[l.id]?.names?.includes(name));
}
