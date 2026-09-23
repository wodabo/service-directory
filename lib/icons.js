/**
 * 图标引擎
 *
 * 目标：给一个 URL，自动找到最能代表它的图标，落盘缓存，返回本地路径。
 * 找不到时按名称生成一张 SVG 字母图（永远不会出现空白图标）。
 *
 * 检索顺序：
 *   1. 抓取页面 HTML，解析 <link rel="icon|apple-touch-icon|mask-icon"> 按尺寸打分
 *   2. 常规兜底路径 /apple-touch-icon.png、/favicon.ico、/favicon.svg ...
 *   3. 第三方 favicon 服务（Google s2 / DuckDuckGo）
 *   4. 生成字母图 SVG
 */
import { createHash } from 'node:crypto';
import { mkdirSync, readdirSync, unlinkSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import * as iconlib from './iconlib.js';

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/126.0 Safari/537.36';

const MAX_ICON_BYTES = 2 * 1024 * 1024;
const HTML_TIMEOUT = 6000;
const ICON_TIMEOUT = 6000;

/* ------------------------------------------------------------ 基础工具 */

export function normalizeUrl(raw, host = '127.0.0.1') {
  let s = String(raw || '').trim();
  if (!s) return '';
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) return s;
  if (/^\d+$/.test(s)) return `http://${host}:${s}`;
  if (/^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?/i.test(s)) return `http://${s}`;
  return `http://${s}`;
}

export function portOf(url) {
  try {
    const u = new URL(normalizeUrl(url));
    if (u.port) return parseInt(u.port, 10);
    return u.protocol === 'https:' ? 443 : 80;
  } catch {
    return null;
  }
}

export function originOf(url) {
  try {
    return new URL(normalizeUrl(url)).origin;
  } catch {
    return '';
  }
}

export function hostnameOf(url) {
  try {
    return new URL(normalizeUrl(url)).hostname;
  } catch {
    return '';
  }
}

function hash(s) {
  return createHash('sha1').update(String(s)).digest('hex').slice(0, 16);
}

async function request(url, { timeout = ICON_TIMEOUT, accept } = {}) {
  try {
    const res = await fetch(url, {
      redirect: 'follow',
      signal: AbortSignal.timeout(timeout),
      headers: {
        'User-Agent': UA,
        Accept: accept || 'image/avif,image/webp,image/png,image/svg+xml,image/*,*/*;q=0.8',
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
      },
    });
    return res;
  } catch {
    return null;
  }
}

/**
 * 剥掉 XML 声明 / DOCTYPE / 注释后，判断是不是 SVG 文档。
 * 不能只看文件是否以 <svg 开头 —— 有些图标库（如 lucide）前面有一行 license 注释。
 * 反过来，HTML 404 页面剥掉 DOCTYPE 后剩下 <html，仍然会被拒掉。
 */
function looksLikeSvg(text) {
  let s = text.trim();
  for (let i = 0; i < 10; i++) {
    const before = s;
    s = s
      .replace(/^<\?xml[^>]*\?>\s*/i, '')
      .replace(/^<!DOCTYPE[^>]*>\s*/i, '')
      .replace(/^<!--[\s\S]*?-->\s*/, '');
    if (s === before) break;
  }
  return /^<svg[\s>]/i.test(s);
}

/** 按魔数判断图片真实类型，避免把 404 页面当图标存下来 */
export function sniffImage(buf) {
  if (!buf || buf.length < 4) return null;
  const b = buf;
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return { ext: 'png', mime: 'image/png' };
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return { ext: 'jpg', mime: 'image/jpeg' };
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return { ext: 'gif', mime: 'image/gif' };
  if (b[0] === 0x00 && b[1] === 0x00 && (b[2] === 0x01 || b[2] === 0x02) && b[3] === 0x00) {
    return { ext: 'ico', mime: 'image/x-icon' };
  }
  if (b[0] === 0x42 && b[1] === 0x4d) return { ext: 'bmp', mime: 'image/bmp' };
  if (b.length > 12 && b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP') {
    return { ext: 'webp', mime: 'image/webp' };
  }
  if (looksLikeSvg(buf.toString('utf8', 0, Math.min(1024, buf.length)))) {
    return { ext: 'svg', mime: 'image/svg+xml' };
  }
  return null;
}

/** SVG 里的 script / 外链一律清掉，避免把远程内容当本地资源执行 */
export function sanitizeSvg(text) {
  return text
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/\son\w+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '')
    .replace(/(href|xlink:href)\s*=\s*("|')https?:\/\/[^"']*\2/gi, '');
}

/* -------------------------------------------------------- HTML 元信息解析 */

function absolutize(href, base) {
  try {
    return new URL(href, base).href;
  } catch {
    return null;
  }
}

function attr(tag, name) {
  const m = tag.match(new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i'));
  if (!m) return null;
  return (m[2] ?? m[3] ?? m[4] ?? '').trim() || null;
}

function scoreSize(sizes) {
  if (!sizes) return 0;
  let best = 0;
  for (const part of String(sizes).split(/\s+/)) {
    const m = part.match(/^(\d+)x(\d+)$/i);
    if (m) best = Math.max(best, parseInt(m[1], 10) * parseInt(m[2], 10));
    else if (/any/i.test(part)) best = Math.max(best, 640000); // SVG 视为任意尺寸
  }
  return best;
}

/** 从 HTML 中挑出图标候选，按优先级排序 */
export function extractIconCandidates(html, pageUrl) {
  const out = [];
  let base = pageUrl;
  const baseTag = html.match(/<base\b[^>]*>/i);
  if (baseTag) {
    const href = attr(baseTag[0], 'href');
    const abs = href && absolutize(href, pageUrl);
    if (abs) base = abs;
  }

  for (const tag of html.match(/<link\b[^>]*>/gi) || []) {
    const rel = (attr(tag, 'rel') || '').toLowerCase();
    if (!/\b(icon|apple-touch-icon|apple-touch-icon-precomposed|mask-icon|fluid-icon)\b/.test(rel)) continue;
    const href = attr(tag, 'href');
    if (!href || href.startsWith('data:')) {
      if (href?.startsWith('data:image')) out.push({ url: href, score: 10, rel });
      continue;
    }
    const abs = absolutize(href, base);
    if (!abs) continue;
    const sizes = attr(tag, 'sizes');
    const type = (attr(tag, 'type') || '').toLowerCase();
    let score = 0;
    if (rel.includes('apple-touch-icon')) score += 1000;
    if (rel.includes('mask-icon')) score -= 200;
    if (/\bicon\b/.test(rel) && !rel.includes('apple')) score += 500;
    if (type.includes('svg')) score += 120; // 矢量，缩放不糊
    score += Math.min(scoreSize(sizes), 500);
    out.push({ url: abs, score, rel, sizes, type });
  }

  // 没有显式 link 时，用 og:image 兜底（很多内网面板只有它）
  if (!out.length) {
    const og = html.match(/<meta\b[^>]*property\s*=\s*["']og:image["'][^>]*>/i);
    if (og) {
      const content = attr(og[0], 'content');
      const abs = content && absolutize(content, base);
      if (abs) out.push({ url: abs, score: 1, rel: 'og:image' });
    }
  }
  return out.sort((a, b) => b.score - a.score);
}

export function extractTitle(html) {
  const og = html.match(/<meta\b[^>]*property\s*=\s*["']og:(?:site_name|title)["'][^>]*>/i);
  if (og) {
    const c = attr(og[0], 'content');
    if (c) return decodeEntities(c).slice(0, 120);
  }
  const t = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (t) return decodeEntities(t[1]).replace(/\s+/g, ' ').trim().slice(0, 120);
  return '';
}

export function extractDescription(html) {
  for (const name of ['description', 'og:description']) {
    const key = name.includes(':') ? 'property' : 'name';
    const m = html.match(new RegExp(`<meta\\b[^>]*${key}\\s*=\\s*["']${name}["'][^>]*>`, 'i'));
    if (m) {
      const c = attr(m[0], 'content');
      if (c) return decodeEntities(c).slice(0, 300);
    }
  }
  return '';
}

function decodeEntities(s) {
  return String(s)
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&amp;/g, '&');
}

/* ------------------------------------------------------------ 图标抓取 */

/** 下载并校验一张图片，返回 {buf, ext, mime} 或 null */
async function downloadIcon(url) {
  if (url.startsWith('data:')) {
    const m = url.match(/^data:([^;,]+)?(;base64)?,(.*)$/s);
    if (!m) return null;
    const mime = m[1] || 'image/png';
    const buf = m[2] ? Buffer.from(m[3], 'base64') : Buffer.from(decodeURIComponent(m[3]));
    const kind = sniffImage(buf);
    return kind ? { buf, ...kind, from: url.slice(0, 60) } : null;
  }
  const res = await request(url);
  if (!res || !res.ok) return null;
  const type = res.headers.get('content-type') || '';
  if (type.includes('text/html')) return null; // 常见于 SPA 把 404 也返回 index.html
  const ab = await res.arrayBuffer().catch(() => null);
  if (!ab) return null;
  const buf = Buffer.from(ab);
  if (!buf.length || buf.length > MAX_ICON_BYTES) return null;
  const kind = sniffImage(buf);
  if (!kind) return null;
  let payload = buf;
  if (kind.ext === 'svg') {
    payload = Buffer.from(sanitizeSvg(buf.toString('utf8')), 'utf8');
  }
  return { buf: payload, ...kind, from: url };
}

const WELL_KNOWN = [
  '/apple-touch-icon.png',
  '/apple-touch-icon-precomposed.png',
  '/favicon.ico',
  '/favicon.png',
  '/favicon.svg',
  '/icon.png',
  '/logo.svg',
  '/logo.png',
  '/static/favicon.ico',
  '/assets/favicon.ico',
];

function thirdPartyCandidates(pageUrl) {
  const host = hostnameOf(pageUrl);
  if (!host) return [];
  const isLocal = /^(localhost|127\.0\.0\.1|\[::1\]|0\.0\.0\.0|.*\.local)$/i.test(host) || /^\d+\.\d+\.\d+\.\d+$/.test(host);
  if (isLocal) return []; // 内网地址第三方服务也拿不到，省一次超时
  return [
    `https://www.google.com/s2/favicons?domain=${encodeURIComponent(host)}&sz=128`,
    `https://icons.duckduckgo.com/ip3/${encodeURIComponent(host)}.ico`,
    `https://favicon.im/${encodeURIComponent(host)}?larger=true`,
  ];
}

/**
 * 核心入口：为某个 URL 找到图标并落盘。
 *
 * @param {string} pageUrl 服务地址，可为空（纯端口服务直接走图标库/字母图）
 * @param {{iconsDir:string, dataDir?:string, name?:string, force?:boolean,
 *          hints?:{kind?:string, command?:string, title?:string}}} opts
 * @returns {Promise<{file:string|null, source:string, url:string|null}>}
 */
export async function resolveIcon(pageUrl, { iconsDir, dataDir, name = '', force = false, hints = {} } = {}) {
  const target = normalizeUrl(pageUrl);
  const origin = originOf(target);
  mkdirSync(iconsDir, { recursive: true });
  const stamp = origin ? hash(origin) : hash(name || 'unknown');

  const candidates = [];
  let pageHtml = '';

  // 1) 页面内声明的图标（站点自己的品牌，最准）
  if (origin) {
    const pageRes = await request(target, { timeout: HTML_TIMEOUT, accept: 'text/html,application/xhtml+xml' });
    if (pageRes && pageRes.ok) {
      const ct = pageRes.headers.get('content-type') || '';
      if (!ct || ct.includes('html') || ct.includes('xml') || ct.includes('json')) {
        pageHtml = (await pageRes.text().catch(() => '')).slice(0, 400_000);
      }
    }
    if (pageHtml) candidates.push(...extractIconCandidates(pageHtml, pageRes?.url || target));

    // 2) 站点常规路径
    for (const p of WELL_KNOWN) candidates.push({ url: origin + p, score: 100, rel: 'well-known' });
  }

  // 3) 图标库：内网服务、数据库、自研项目都没有 favicon，这里能拿到像样的品牌图标
  const software = iconlib.matchSoftware({
    kind: hints.kind || name,
    command: hints.command,
    title: hints.title || (pageHtml ? extractTitle(pageHtml) : ''),
  });
  if (software) {
    // 顺序即优先级：候选是按数组顺序依次尝试的
    for (const lib of ['dashboard-icons', 'selfhst']) {
      candidates.push({
        library: lib,
        slug: software.name,
        rel: `图标库(${software.matchedBy}→${software.name})`,
      });
    }
  }

  // 4) 第三方 favicon 服务
  for (const u of thirdPartyCandidates(target)) candidates.push({ url: u, score: 20, rel: 'third-party' });

  const tried = new Set();
  for (const c of candidates) {
    const key = c.library ? `${c.library}:${c.slug}` : c.url;
    if (!key || tried.has(key)) continue;
    tried.add(key);

    let got = null;
    if (c.library) {
      got = await downloadLibraryIcon(c.library, c.slug);
    } else {
      got = await downloadIcon(c.url);
    }
    if (!got) continue;

    const file = `${stamp}.${got.ext}`;
    writeFileSync(join(iconsDir, file), got.buf);
    pruneOld(iconsDir, stamp, file);
    return {
      file,
      source: c.rel || 'fetched',
      url: got.from || c.url || null,
      bytes: got.buf.length,
      html: pageHtml,
    };
  }

  return { file: null, source: 'none', url: null, html: pageHtml };
}

/** 从图标库下载并做同样的校验 */
async function downloadLibraryIcon(libId, slug) {
  try {
    const { buf, url } = await iconlib.fetchIconBytes(libId, slug);
    const kind = sniffImage(buf);
    if (!kind) return null;
    const payload = kind.ext === 'svg' ? Buffer.from(sanitizeSvg(buf.toString('utf8')), 'utf8') : buf;
    return { buf: payload, ...kind, from: url };
  } catch {
    return null;
  }
}

function pruneOld(iconsDir, stamp, keep) {
  try {
    for (const f of readdirSync(iconsDir)) {
      if (f.startsWith(stamp + '.') && f !== keep) unlinkSync(join(iconsDir, f));
    }
  } catch { /* 清理失败不影响主流程 */ }
}

/* ------------------------------------------------------- 字母图兜底生成 */

const PALETTE = [
  ['#6366f1', '#8b5cf6'], ['#0ea5e9', '#22d3ee'], ['#10b981', '#34d399'],
  ['#f59e0b', '#fbbf24'], ['#ef4444', '#f87171'], ['#ec4899', '#f472b6'],
  ['#8b5cf6', '#d946ef'], ['#14b8a6', '#2dd4bf'], ['#f97316', '#fb923c'],
  ['#3b82f6', '#60a5fa'], ['#64748b', '#94a3b8'], ['#84cc16', '#a3e635'],
];

export function pickPalette(seed) {
  let h = 0;
  for (const ch of String(seed || '?')) h = (h * 31 + ch.codePointAt(0)) >>> 0;
  return PALETTE[h % PALETTE.length];
}

function escapeXml(s) {
  return String(s).replace(/[<>&'"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' }[c]));
}

/** 取名称里最有辨识度的字符：优先首字母，中文取首字 */
export function monogramOf(name) {
  const s = String(name || '?').trim();
  if (!s) return '?';
  const cleaned = s.replace(/^(https?:\/\/)?(www\.)?/i, '');
  const m = cleaned.match(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u);
  if (m && m.index === 0) return m[0];
  const words = cleaned.split(/[\s\-_.·]+/).filter(Boolean);
  if (words.length >= 2 && /^[A-Za-z]/.test(words[0]) && /^[A-Za-z]/.test(words[1])) {
    return (words[0][0] + words[1][0]).toUpperCase();
  }
  const letters = cleaned.match(/[A-Za-z0-9]/g);
  return letters ? letters.slice(0, 2).join('').toUpperCase() : cleaned[0];
}

/** 生成一张 256x256 的渐变字母图 SVG */
export function monogramSvg(name, { seed } = {}) {
  const [c1, c2] = pickPalette(seed || name);
  const text = escapeXml(monogramOf(name));
  const size = text.length > 1 ? 96 : 128;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256" viewBox="0 0 256 256">
  <defs>
    <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="${c1}"/>
      <stop offset="100%" stop-color="${c2}"/>
    </linearGradient>
  </defs>
  <rect width="256" height="256" rx="60" fill="url(#g)"/>
  <text x="128" y="128" text-anchor="middle" dominant-baseline="central"
        font-family="-apple-system,BlinkMacSystemFont,'PingFang SC','Helvetica Neue',Arial,sans-serif"
        font-size="${size}" font-weight="700" fill="#ffffff" letter-spacing="2">${text}</text>
</svg>`;
}

/** 生成并写入字母图，返回文件名 */
export function writeMonogram(iconsDir, name, seed) {
  mkdirSync(iconsDir, { recursive: true });
  const file = `mono-${hash(seed || name)}.svg`;
  writeFileSync(join(iconsDir, file), monogramSvg(name, { seed }), 'utf8');
  return file;
}

/** 手动上传 / 粘贴的图标：data URL 或图片地址，落盘为本地文件 */
export async function saveCustomIcon(iconsDir, serviceKey, source) {
  mkdirSync(iconsDir, { recursive: true });
  const got = await downloadIcon(String(source).trim());
  if (!got) return null;
  const file = `custom-${hash(serviceKey)}.${got.ext}`;
  writeFileSync(join(iconsDir, file), got.buf);
  return file;
}

export function iconExists(iconsDir, file) {
  return Boolean(file) && existsSync(join(iconsDir, file));
}

/**
 * 清掉没有任何服务引用的图标文件（删除服务后会留下孤儿）。
 *
 * 两道保险，避免误删：
 *   1. 数据库里一个服务都没有时直接跳过 —— 这种情况多半是 NAV_DB 指向了另一个（新建/空的）
 *      数据库，而图标目录是共用的，此时"全部无引用"是假象，清下去就把别人的缓存抹了。
 *   2. 只清超过 minAgeMs 的文件 —— 图标是「先写文件、再写数据库」的，运行中清理会误删刚抓到的；
 *      留一个时间窗既躲开这个竞态，也躲开并发实例。
 *
 * @param {string} iconsDir
 * @param {Iterable<string>} referenced 数据库里引用到的图标文件名
 * @param {string[]} keepExtra 额外保留的文件名（如面板自己的 favicon）
 * @param {number} minAgeMs 只清理修改时间早于该时长的文件，默认 1 小时
 */
export function pruneOrphanIcons(iconsDir, referenced, keepExtra = [], minAgeMs = 3600_000) {
  if (!existsSync(iconsDir)) return 0;
  const refs = [...referenced];
  if (refs.length === 0) return 0; // 保险 1

  const keep = new Set([...refs, ...keepExtra]);
  const cutoff = Date.now() - minAgeMs;
  let removed = 0;
  for (const file of readdirSync(iconsDir)) {
    if (keep.has(file)) continue;
    try {
      if (statSync(join(iconsDir, file)).mtimeMs > cutoff) continue; // 保险 2
      unlinkSync(join(iconsDir, file));
      removed++;
    } catch { /* 删不掉就留着 */ }
  }
  return removed;
}
