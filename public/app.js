/* nav-hub 前端逻辑 */

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const state = {
  groups: [],
  services: [],
  settings: {},
  ignoredPorts: [],
  filter: { group: 'all', search: '', kind: 'all', mode: 'grid' },
  editing: null,      // 正在编辑的服务 id，null = 新建
  editingIcon: null,  // { icon_file, icon_source, icon_url }
  scan: null,
  dragId: null,
  docker: { view: false, tab: 'containers', containers: [], networks: [], error: '', busy: new Set() },
};

/* ------------------------------------------------------------------ 工具 */

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

async function api(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = { error: text }; }
  if (!res.ok) throw new Error(data?.error || `请求失败 (${res.status})`);
  return data;
}

function toast(msg, kind = 'info', ms = 3000) {
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.textContent = msg;
  $('#toasts').append(el);
  setTimeout(() => {
    el.classList.add('leaving');
    setTimeout(() => el.remove(), 220);
  }, ms);
}

const PALETTE = [
  ['#6366f1', '#8b5cf6'], ['#0ea5e9', '#22d3ee'], ['#10b981', '#34d399'],
  ['#f59e0b', '#fbbf24'], ['#ef4444', '#f87171'], ['#ec4899', '#f472b6'],
  ['#8b5cf6', '#d946ef'], ['#14b8a6', '#2dd4bf'], ['#f97316', '#fb923c'],
  ['#3b82f6', '#60a5fa'], ['#64748b', '#94a3b8'], ['#84cc16', '#a3e635'],
];

/** 与服务端一致的字母图（前端即时兜底，避免图标抓取期间出现空位） */
function monogramDataUrl(name) {
  let h = 0;
  for (const ch of String(name || '?')) h = (h * 31 + ch.codePointAt(0)) >>> 0;
  const [c1, c2] = PALETTE[h % PALETTE.length];
  const cleaned = String(name || '?').trim().replace(/^(https?:\/\/)?(www\.)?/i, '');
  let text = cleaned.slice(0, 1);
  const words = cleaned.split(/[\s\-_.·]+/).filter(Boolean);
  if (words.length >= 2 && /^[A-Za-z]/.test(words[0]) && /^[A-Za-z]/.test(words[1])) {
    text = (words[0][0] + words[1][0]).toUpperCase();
  } else if (/^[A-Za-z0-9]/.test(cleaned)) {
    text = cleaned.match(/[A-Za-z0-9]/g).slice(0, 2).join('').toUpperCase();
  }
  const size = text.length > 1 ? 96 : 128;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256" viewBox="0 0 256 256">
<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
<stop offset="0%" stop-color="${c1}"/><stop offset="100%" stop-color="${c2}"/></linearGradient></defs>
<rect width="256" height="256" rx="60" fill="url(#g)"/>
<text x="128" y="128" text-anchor="middle" dominant-baseline="central"
font-family="-apple-system,BlinkMacSystemFont,'PingFang SC',Arial,sans-serif"
font-size="${size}" font-weight="700" fill="#ffffff">${esc(text)}</text></svg>`;
  return 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
}

function iconSrc(svc) {
  return svc.icon_file ? `/icons/${svc.icon_file}` : monogramDataUrl(svc.name);
}

/** 当前配置的外部访问地址（如 ZeroTier IP），空表示直接用本机地址 */
function externalHost() {
  return (state.settings.externalHost || '').trim();
}

/**
 * 卡片上显示 / 点开的地址。
 * 配了外部地址就走外部地址（手机上点得开），否则用服务自己存的地址。
 * 替换只作用于 host:port —— URL 里的路径/查询串是用户编辑的一部分，
 * 必须原样保留（比如 /admin/dashboard），否则点开就丢到了根路径。
 * 公网域名服务（https://rss.bz 这类）不重写：外部 IP 上没有它，换了反而打不开。
 */
function displayUrl(svc) {
  const host = externalHost();
  if (host && svc.port) {
    const raw = svc.url || '';
    let suffix = '';
    let isIpLike = true;
    if (raw) {
      try {
        const u = new URL(raw);
        suffix = `${u.pathname === '/' ? '' : u.pathname}${u.search}${u.hash}`;
        const h = u.hostname;
        // localhost / 纯 IP / 内网网段才需要换成本机外部地址；公网域名保持原样
        isIpLike = h === 'localhost' || h === '[::1]' || /^\d{1,3}(\.\d{1,3}){3}$/.test(h)
          || /^\[[0-9a-f:]+\]$/i.test(h) || /^(10|127)\./.test(h) || /^192\.168\./.test(h)
          || /^172\.(1[6-9]|2\d|3[01])\./.test(h) || h.endsWith('.local');
      } catch { /* 存的地址不是合法 URL，就只替换 host:port */ }
    }
    if (!isIpLike) return raw;
    const proto = raw.startsWith('https://') ? 'https' : 'http';
    return `${proto}://${host}:${svc.port}${suffix}`;
  }
  return svc.url || (svc.port ? `${svc.host || '127.0.0.1'}:${svc.port}` : '');
}

/** 只绑了回环的服务，换外部地址也连不上 */
function isLocalOnly(svc) {
  return Boolean(externalHost()) && svc.status === 'local-only';
}

/**
 * 卡片该不该标红框：凡是从当前配置的地址打不开的都算。
 * 包含两类——进程没了的（offline/timeout），和进程活着但只绑了回环、
 * 外部地址过不去的（local-only）。unknown 不算，那是还没检测过，没有依据说它有问题。
 */
function isUnavailable(svc) {
  return svc.status === 'offline' || svc.status === 'timeout' || isLocalOnly(svc);
}

function statusText(s) {
  return {
    online: '在线', offline: '离线', timeout: '超时', unknown: '未检测',
    checking: '检测中', 'local-only': '仅本机可访问',
  }[s] || s;
}

/** 复制地址到剪贴板（数据库类服务、以及在别的设备上要用这个地址时） */
async function copyAddress(svc) {
  const addr = displayUrl(svc) || `${svc.host || '127.0.0.1'}:${svc.port}`;
  // 显示用的地址带协议头，复制时去掉更通用
  const text = addr.replace(/^https?:\/\//, '');
  try {
    await navigator.clipboard.writeText(text);
    toast(`已复制 ${text}`, 'ok');
  } catch {
    toast(text, 'info', 6000);
  }
}

/* ------------------------------------------------------------------ 载入 */

async function load() {
  const data = await api('GET', '/api/bootstrap');
  state.groups = data.groups;
  state.services = data.services;
  state.settings = data.settings;
  state.ignoredPorts = data.ignoredPorts || [];
  if (state.settings.viewMode) state.filter.mode = state.settings.viewMode;
  if (state.settings.theme) document.documentElement.dataset.theme = state.settings.theme;
  applySiteBranding();
  applyStaticUi();
  render();
}

/** 站点名称 / 图标落到侧栏、标签页标题和 favicon */
function applySiteBranding() {
  const name = (state.settings.siteName || '').trim();
  const icon = (state.settings.siteIcon || '').trim();
  const mark = $('#brand-mark');
  if (name) {
    $('#brand-name').textContent = name;
    document.title = `${name} · 本机服务导航`;
  } else {
    $('#brand-name').textContent = 'nav-hub';
    document.title = 'nav-hub · 本机服务导航';
  }
  if (icon) {
    // 加时间戳避开浏览器对同名文件的缓存
    mark.innerHTML = `<img src="/icons/${encodeURIComponent(icon)}?t=${Date.now()}" alt="" class="brand-icon-img">`;
    let link = document.querySelector('link[rel="icon"]');
    if (!link) { link = document.createElement('link'); link.rel = 'icon'; document.head.append(link); }
    link.href = `/icons/${encodeURIComponent(icon)}?t=${Date.now()}`;
  } else {
    mark.innerHTML = '<svg class="ic ic-lg" aria-hidden="true"><use href="#i-compass"/></svg>';
    let link = document.querySelector('link[rel="icon"]');
    if (link) link.href = '/icons/nav-hub.svg';
  }
}

/** 主题按钮显示的是「点了会切到哪种模式」 */
function syncThemeIcon() {
  const dark = document.documentElement.dataset.theme !== 'light';
  $('#theme-toggle').innerHTML =
    `<svg class="ic" aria-hidden="true"><use href="#i-${dark ? 'sun' : 'moon'}"/></svg>`;
  $('#theme-toggle').title = dark ? '切换到浅色主题' : '切换到深色主题';
}

function applyStaticUi() {
  $('#view-mode').dataset.mode = state.filter.mode;
  $$('#view-mode button').forEach((b) => b.classList.toggle('active', b.dataset.mode === state.filter.mode));
  $('#content').dataset.mode = state.filter.mode;
  $('#brand-sub').textContent = `${state.services.length} 个服务 · 本机导航`;
  syncThemeIcon();
}

/* ------------------------------------------------------------------ 渲染 */

function visibleServices() {
  const { group, search, kind } = state.filter;
  const q = search.trim().toLowerCase();
  return state.services.filter((s) => {
    if (group === 'ungrouped' && s.group_id) return false;
    if (group !== 'all' && group !== 'ungrouped' && s.group_id !== Number(group)) return false;
    if (kind === 'online' && s.status !== 'online') return false;
    if (!q) return true;
    return [s.name, s.url, s.description, s.tags, s.port, s.command, s.group_name]
      .filter(Boolean).join(' ').toLowerCase().includes(q);
  });
}

function render() {
  renderSidebar();
  renderContent();
}

function renderSidebar() {
  const list = $('#group-list');
  const counts = { all: state.services.length, ungrouped: state.services.filter((s) => !s.group_id).length };
  const rows = [
    { id: 'all', name: '全部服务', color: 'var(--accent)', count: counts.all },
    ...state.groups.map((g) => ({ id: String(g.id), name: g.name, color: g.color, count: g.service_count })),
  ];
  if (counts.ungrouped) rows.push({ id: 'ungrouped', name: '未分组', color: 'var(--text-mute)', count: counts.ungrouped });

  list.innerHTML = rows.map((r) => `
    <li data-group="${esc(r.id)}" class="${state.filter.group === r.id ? 'active' : ''}"
        ${r.id !== 'all' && r.id !== 'ungrouped' ? 'draggable="true"' : ''}>
      <span class="group-dot" style="background:${esc(r.color)}"></span>
      <span class="group-name">${esc(r.name)}</span>
      <span class="group-count">${r.count}</span>
      ${r.id !== 'all' && r.id !== 'ungrouped'
        ? `<button class="icon-btn tiny group-edit" data-edit-group="${esc(r.id)}" title="编辑分组"><svg class="ic ic-sm" aria-hidden="true"><use href="#i-pencil"/></svg></button>` : ''}
    </li>`).join('');

  const online = state.services.filter((s) => s.status === 'online').length;
  const localOnly = state.services.filter((s) => s.status === 'local-only').length;
  const offline = state.services.filter((s) => s.status === 'offline' || s.status === 'timeout').length;
  const host = externalHost();
  // 统计口径跟卡片红框一致：打不开的都算「不可用」，不再拆开显示，
  // 否则两者都非零时会互相盖住（原来只显示 localOnly，把离线数藏了）。
  const unusable = localOnly + offline;
  const unusableHint = [
    offline ? `${offline} 个进程不通` : '',
    localOnly ? `${localOnly} 个仅本机` : '',
  ].filter(Boolean).join('，');
  $('#stats').innerHTML = `
    <div class="stat"><b>${state.services.length}</b><span>总计</span></div>
    <div class="stat online"><b>${online}</b><span>${host ? '外部可达' : '在线'}</span></div>
    <div class="stat ${unusable ? 'offline' : ''}" ${unusableHint ? `title="${esc(unusableHint)}"` : ''}>
      <b>${unusable}</b><span>不可用</span>
    </div>`;
}

function cardHtml(svc) {
  const tags = (svc.tags || '').split(',').filter(Boolean);
  const shown = displayUrl(svc);
  const localOnly = isLocalOnly(svc);
  const cls = ['card', isUnavailable(svc) ? 'unavailable' : '', localOnly ? 'local-only' : '']
    .filter(Boolean).join(' ');
  return `
    <article class="${cls}" data-id="${svc.id}" draggable="true">
      <span class="card-status ${esc(svc.status)}" data-status title="${statusText(svc.status)}${svc.latency_ms ? ` · ${svc.latency_ms}ms` : ''}"></span>
      <div class="card-side">
        <img class="card-icon" src="${iconSrc(svc)}" alt="" loading="lazy"
             onerror="this.src='${monogramDataUrl(svc.name)}'">
        ${svc.port ? `<span class="tag port card-port" title="端口 ${svc.port}">:${svc.port}</span>` : ''}
      </div>
      <div class="card-body">
        <div class="card-title">
          <strong title="${esc(svc.name)}">${esc(svc.name)}</strong>
        </div>
        <div class="card-url" title="${esc(shown)}">${esc(shown)}</div>
        ${svc.description ? `<div class="card-desc">${esc(svc.description)}</div>` : ''}
        ${(localOnly || tags.length) ? `
        <div class="card-tags">
          ${localOnly ? '<span class="tag warn" title="该服务只监听了 127.0.0.1，从外部地址连不上">仅本机</span>' : ''}
          ${tags.map((t) => `<span class="tag">${esc(t)}</span>`).join('')}
        </div>` : ''}
      </div>
      <div class="card-actions">
        ${svc.url || svc.port
          ? `<button class="icon-btn" data-act="copy" title="复制地址"><svg class="ic ic-sm" aria-hidden="true"><use href="#i-copy"/></svg></button>`
          : ''}
        ${svc.url
          ? '<button class="icon-btn" data-act="check" title="检测连通性"><svg class="ic ic-sm" aria-hidden="true"><use href="#i-plug-zap"/></svg></button>'
          : ''}
        <button class="icon-btn" data-act="edit" title="编辑"><svg class="ic ic-sm" aria-hidden="true"><use href="#i-pencil"/></svg></button>
        <button class="icon-btn" data-act="del" title="删除"><svg class="ic ic-sm" aria-hidden="true"><use href="#i-trash-2"/></svg></button>
      </div>
    </article>`;
}

function renderContent() {
  const list = visibleServices();
  const content = $('#content');
  const { group, kind } = state.filter;

  const title = group === 'all' ? '全部服务'
    : group === 'ungrouped' ? '未分组'
    : (state.groups.find((g) => g.id === Number(group))?.name || '服务');
  $('#view-title').textContent = kind === 'online' ? `${title} · 在线` : title;
  $('#view-sub').textContent = list.length ? `${list.length} 个服务` : '';

  if (!state.services.length) {
    content.innerHTML = `
      <div class="empty">
        <div class="big"><svg class="ic ic-xl" aria-hidden="true"><use href="#i-compass"/></svg></div>
        <p>还没有收录任何服务</p>
        <p class="hint">点右上角「新建服务」，或先「扫描本机端口」一键发现</p>
      </div>`;
    return;
  }
  if (!list.length) {
    content.innerHTML = `
      <div class="empty">
        <div class="big"><svg class="ic ic-xl" aria-hidden="true"><use href="#i-search"/></svg></div>
        <p>没有匹配的服务</p>
        <p class="hint">换个关键词，或切换左侧分组</p>
      </div>`;
    return;
  }

  // 分组视图：全部/搜索时按分组分块，单组视图直接平铺
  const grouped = group === 'all' && !state.filter.search;
  if (!grouped) {
    content.innerHTML = `<div class="cards">${list.map(cardHtml).join('')}</div>`;
    return;
  }

  const buckets = new Map();
  for (const s of list) {
    const key = s.group_id ?? 0;
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(s);
  }
  const order = [
    ...[...buckets.keys()].filter((k) => k !== 0).sort((a, b) => {
      const ga = state.groups.find((g) => g.id === a)?.sort_order ?? 0;
      const gb = state.groups.find((g) => g.id === b)?.sort_order ?? 0;
      return ga - gb;
    }),
    ...(buckets.has(0) ? [0] : []),
  ];
  content.innerHTML = order.map((key) => {
    const g = state.groups.find((x) => x.id === key);
    const items = buckets.get(key);
    return `
      <section class="group-block">
        <div class="group-block-head">
          <span class="group-dot" style="background:${esc(g?.color || 'var(--text-mute)')}"></span>
          <span>${esc(g?.name || '未分组')}</span>
          <span class="count">${items.length}</span>
        </div>
        <div class="cards">${items.map(cardHtml).join('')}</div>
      </section>`;
  }).join('');
}

/** 局部更新一张卡片（SSE 推送时用，避免整页重绘打断交互） */
function patchCard(svc) {
  const el = $(`.card[data-id="${svc.id}"]`);
  if (!el) { renderContent(); return; }
  const dot = $('[data-status]', el);
  if (dot) {
    dot.className = `card-status ${svc.status}`;
    dot.title = statusText(svc.status) + (svc.latency_ms ? ` · ${svc.latency_ms}ms` : '');
  }
  const img = $('.card-icon', el);
  if (img && svc.icon_file && !img.src.endsWith(svc.icon_file)) img.src = `/icons/${svc.icon_file}`;
  const nameEl = $('.card-title strong', el);
  if (nameEl && nameEl.textContent !== svc.name) {
    nameEl.textContent = svc.name;
    nameEl.title = svc.name;
  }
  // 地址或「仅本机」标记变了就整块重绘 —— 这两处还牵扯标签和卡片动作按钮
  const urlEl = $('.card-url', el);
  const shown = displayUrl(svc);
  if (urlEl && urlEl.textContent !== shown) { renderContent(); return; }
  if (el.classList.contains('local-only') !== isLocalOnly(svc)) { renderContent(); return; }
  syncUnavailable(el, svc);
}

/** 红框跟着状态走：健康检查只改这个 class，不用整页重绘 */
function syncUnavailable(el, svc) {
  if (!el) return;
  const want = isUnavailable(svc);
  if (el.classList.contains('unavailable') !== want) el.classList.toggle('unavailable', want);
}

function upsertService(svc) {
  const i = state.services.findIndex((s) => s.id === svc.id);
  if (i >= 0) state.services[i] = { ...state.services[i], ...svc };
  else state.services.push(svc);
}

/* ------------------------------------------------------------ 编辑弹窗 */

function openEdit(id = null) {
  state.editing = id;
  state.editingIcon = null;
  const svc = id ? state.services.find((s) => s.id === id) : null;

  $('#edit-title').textContent = svc ? '编辑服务' : '新建服务';
  $('#btn-delete').hidden = !svc;
  $('#f-url').value = svc?.url || '';
  $('#f-name').value = svc?.name || '';
  $('#f-desc').value = svc?.description || '';
  $('#f-tags').value = svc?.tags || '';
  $('#preview-card').hidden = true;

  const sel = $('#f-group');
  sel.innerHTML = `<option value="">未分组</option>` +
    state.groups.map((g) => `<option value="${g.id}">${esc(g.name)}</option>`).join('');
  sel.value = svc?.group_id ? String(svc.group_id) : '';

  if (svc) state.editingIcon = { icon_file: svc.icon_file, icon_source: svc.icon_source, icon_url: svc.icon_url };
  renderIconCurrent();
  show('#edit-modal');
  setTimeout(() => $(svc ? '#f-name' : '#f-url').focus(), 60);
}

function renderIconCurrent() {
  const box = $('#icon-current');
  const file = state.editingIcon?.icon_file;
  const name = $('#f-name').value || $('#f-url').value || '?';
  box.innerHTML = `<img src="${file ? `/icons/${file}` : monogramDataUrl(name)}" alt="">`;
}

async function previewUrl() {
  const url = $('#f-url').value.trim();
  if (!url) return toast('请先填写地址', 'err');
  const btn = $('#btn-preview');
  btn.disabled = true;
  btn.textContent = '抓取中…';
  try {
    const info = await api('POST', '/api/preview', { url, host: '127.0.0.1' });
    $('#preview-card').hidden = false;
    $('#preview-icon').src = info.iconDataUrl || monogramDataUrl(info.title || url);
    $('#preview-title').textContent = info.title || '（页面无标题）';
    $('#preview-desc').textContent = info.description || info.url;
    const badge = $('#preview-badge');
    badge.textContent = info.reachable
      ? `✓ 可访问 · HTTP ${info.status} · ${info.latency}ms${info.iconUrl ? ' · 图标已获取' : ''}`
      : '✗ 无法访问（仍可保存）';
    badge.className = 'preview-badge' + (info.reachable ? '' : ' bad');

    if (!$('#f-name').value) $('#f-name').value = info.title || `端口 ${info.port}`;
    if (!$('#f-desc').value && info.description) $('#f-desc').value = info.description;
    if (info.iconFile) {
      state.editingIcon = { icon_file: info.iconFile, icon_source: info.iconSource, icon_url: info.iconUrl };
      renderIconCurrent();
    }
  } catch (err) {
    toast(err.message, 'err');
  } finally {
    btn.disabled = false;
    btn.textContent = '自动抓取';
  }
}

async function saveService() {
  const name = $('#f-name').value.trim();
  const url = $('#f-url').value.trim();
  if (!name) return toast('请填写名称', 'err');
  if (!url) return toast('请填写地址', 'err');

  const payload = {
    name,
    url,
    description: $('#f-desc').value.trim(),
    tags: $('#f-tags').value.trim(),
    group_id: $('#f-group').value ? Number($('#f-group').value) : null,
  };
  if (state.editingIcon?.icon_file) {
    payload.icon_file = state.editingIcon.icon_file;
    payload.icon_source = state.editingIcon.icon_source;
    payload.icon_url = state.editingIcon.icon_url;
  }

  try {
    const saved = state.editing
      ? await api('PUT', `/api/services/${state.editing}`, payload)
      : await api('POST', '/api/services', payload);
    upsertService(saved);
    hide('#edit-modal');
    render();
    toast(state.editing ? '已保存' : `已添加「${saved.name}」，正在抓取图标…`, 'ok');
  } catch (err) {
    toast(err.message, 'err');
  }
}

async function deleteService(id) {
  const svc = state.services.find((s) => s.id === id);
  if (!svc) return;
  if (!confirm(`确定删除「${svc.name}」？`)) return;
  try {
    await api('DELETE', `/api/services/${id}`);
    state.services = state.services.filter((s) => s.id !== id);
    hide('#edit-modal');
    render();
    toast('已删除', 'ok');
  } catch (err) {
    toast(err.message, 'err');
  }
}

async function serviceIconAction(id, body) {
  try {
    const updated = await api('POST', `/api/services/${id}/icon`, body);
    if (updated?.id) {
      upsertService(updated);
      state.editingIcon = { icon_file: updated.icon_file, icon_source: updated.icon_source, icon_url: updated.icon_url };
      renderIconCurrent();
      renderContent();
      toast('图标已更新', 'ok');
    } else {
      toast('正在后台重新检索图标…', 'info');
    }
  } catch (err) {
    toast(err.message, 'err');
  }
}

async function generateMonogram(id) {
  const text = prompt('字母图显示的文字（1-2 个字符）', ($('#f-name').value || '?').slice(0, 2));
  if (text === null) return;
  try {
    const updated = await api('POST', `/api/services/${id}/icon/generate`, { text });
    upsertService(updated);
    state.editingIcon = { icon_file: updated.icon_file, icon_source: 'monogram', icon_url: null };
    renderIconCurrent();
    renderContent();
    toast('已生成字母图', 'ok');
  } catch (err) {
    toast(err.message, 'err');
  }
}

/* ------------------------------------------------------------ 图标库 */

let iconLibTimer = null;

async function openIconLib() {
  show('#iconlib-modal');
  $('#iconlib-search').value = '';
  await ensureIconLibIndex();
  runIconLibSearch();
  setTimeout(() => $('#iconlib-search').focus(), 60);
}

/** 索引没建好就等一下（首次要拉几 MB） */
async function ensureIconLibIndex() {
  const grid = $('#iconlib-grid');
  for (let i = 0; i < 60; i++) {
    let st;
    try {
      st = await api('GET', '/api/iconlib');
    } catch (err) {
      grid.innerHTML = `<div class="loading">图标库不可用：${esc(err.message)}</div>`;
      return false;
    }
    const total = st.libraries.reduce((n, l) => n + l.count, 0);
    if (st.state === 'ready' && total) {
      $('#iconlib-status').textContent =
        `共 ${total} 个图标（${st.libraries.map((l) => `${l.label} ${l.count}`).join(' / ')}）`;
      return true;
    }
    if (st.state === 'failed') {
      grid.innerHTML = `<div class="loading">图标库索引构建失败：${esc(st.error || '未知原因')}<br>可以点右上角「刷新索引」重试。</div>`;
      return false;
    }
    grid.innerHTML = `<div class="loading">正在建立图标索引（首次需要拉取几 MB，请稍候…）</div>`;
    await new Promise((r) => setTimeout(r, 1500));
  }
  grid.innerHTML = '<div class="loading">索引构建超时，可以点「刷新索引」重试。</div>';
  return false;
}

async function runIconLibSearch() {
  const q = $('#iconlib-search').value.trim();
  const grid = $('#iconlib-grid');
  if (!q) {
    grid.innerHTML = '<div class="loading">输入关键词开始搜索，例如 postgres、grafana、code、server</div>';
    return;
  }
  try {
    const r = await api('GET', `/api/iconlib/search?q=${encodeURIComponent(q)}&limit=120`);
    const lib = $('#iconlib-lib button.active')?.dataset.lib || 'all';
    const items = r.results.filter((x) => lib === 'all' || x.lib === lib);
    if (!items.length) {
      grid.innerHTML = `<div class="loading">没有匹配「${esc(q)}」的图标</div>`;
      return;
    }
    grid.innerHTML = items.map((x) => `
      <div class="iconlib-item" data-lib="${esc(x.lib)}" data-name="${esc(x.name)}" title="${esc(x.lib)}/${esc(x.name)}">
        <img src="${esc(x.cdn)}/svg/${esc(x.name)}.svg" alt=""
             onerror="this.style.opacity=.15">
        <span>${esc(x.name)}</span>
      </div>`).join('');
  } catch (err) {
    grid.innerHTML = `<div class="loading">搜索失败：${esc(err.message)}</div>`;
  }
}

/** 选好图标：已保存的服务立即生效，新建的等服务保存时一起写 */
async function applyLibIcon(lib, name) {
  const btn = $(`.iconlib-item[data-lib="${lib}"][data-name="${name}"]`);
  btn?.classList.add('picking');
  try {
    const r = await api('POST', '/api/iconlib/apply', { lib, name });
    const patch = { icon_file: r.icon_file, icon_source: 'library', icon_url: r.icon_url };
    if (state.editing) {
      const saved = await api('PUT', `/api/services/${state.editing}`, patch);
      upsertService(saved);
      state.editingIcon = { icon_file: saved.icon_file, icon_source: saved.icon_source, icon_url: saved.icon_url };
      renderIconCurrent();
      renderContent();
      toast(`已应用图标 ${name}`, 'ok');
    } else {
      state.editingIcon = patch;
      renderIconCurrent();
      toast(`已选用 ${name}，保存后生效`, 'ok');
    }
    hide('#iconlib-modal');
  } catch (err) {
    toast('应用失败：' + err.message, 'err');
  } finally {
    btn?.classList.remove('picking');
  }
}

/* ------------------------------------------------------------ 健康检查 */

async function checkHealth(ids = null) {
  const btn = $('#btn-health');
  btn.disabled = true;
  const targets = ids || state.services.map((s) => s.id);
  for (const id of targets) {
    const el = $(`.card[data-id="${id}"] .card-status`);
    if (el) el.className = 'card-status checking';
  }
  try {
    const res = await api('POST', '/api/health', { ids });
    for (const u of res.updated) {
      const svc = state.services.find((s) => s.id === u.id);
      if (svc) { svc.status = u.status; svc.latency_ms = u.latency; }
    }
    render();
    const host = externalHost();
    const online = res.updated.filter((u) => u.status === 'online').length;
    const localOnly = res.updated.filter((u) => u.status === 'local-only').length;
    if (host && localOnly) {
      toast(`${host}：${online}/${res.updated.length} 外部可达，${localOnly} 个仅本机`, 'info', 6000);
    } else if (host) {
      toast(`外部地址检测：${online}/${res.updated.length} 可达`, 'ok');
    } else {
      toast(`检测完成：${online}/${res.updated.length} 在线`, 'ok');
    }
  } catch (err) {
    toast(err.message, 'err');
    render();
  } finally {
    btn.disabled = false;
  }
}

/* ------------------------------------------------------------ 端口扫描 */

async function openScan() {
  show('#scan-modal');
  await runScan();
}

async function runScan() {
  $('#scan-list').innerHTML = '<div class="loading">正在扫描本机监听端口…</div>';
  $('#scan-hint').textContent = '';
  try {
    state.scan = await api('POST', '/api/scan', { probe: true });
    renderScan();
  } catch (err) {
    $('#scan-list').innerHTML = `<div class="loading">扫描失败：${esc(err.message)}</div>`;
  }
}

function renderScan() {
  const rows = state.scan?.results || [];
  const hideSystem = $('#scan-hide-system').checked;
  const hideAdded = $('#scan-hide-added').checked;
  const webOnly = $('#scan-web-only').checked;

  const shown = rows.filter((r) => {
    if (hideSystem && (r.system || r.noise || r.auxiliary)) return false;
    if (hideAdded && r.alreadyAdded) return false;
    if (webOnly && !r.http) return false;
    return true;
  });

  $('#scan-hint').textContent =
    `共 ${state.scan.total} 个监听端口 · ${state.scan.web} 个 HTTP 服务 · 显示 ${shown.length} 个`;

  if (!shown.length) {
    $('#scan-list').innerHTML = '<div class="loading">没有需要导入的端口</div>';
    return;
  }

  $('#scan-list').innerHTML = shown.map((r) => `
    <label class="scan-row ${r.alreadyAdded ? 'added' : ''}" data-port="${r.port}">
      <input type="checkbox" ${r.http && !r.alreadyAdded ? 'checked' : ''} ${r.alreadyAdded ? 'disabled' : ''}
             data-port="${r.port}">
      <span class="scan-port">:${r.port}</span>
      <span class="scan-main">
        <strong>${esc(r.name)}</strong>
        <span class="scan-cmd">${esc(r.command || r.process)}</span>
      </span>
      <span class="scan-badges">
        ${r.http ? `<span class="badge web">HTTP ${r.status}</span>` : ''}
        ${r.latency != null ? `<span class="badge">${r.latency}ms</span>` : ''}
        ${r.system ? '<span class="badge sys">系统</span>' : ''}
        ${r.noise ? '<span class="badge sys">应用内部</span>' : ''}
        ${r.auxiliary ? '<span class="badge sys">附属端口</span>' : ''}
        ${r.alreadyAdded ? '<span class="badge added">已收录</span>' : ''}
      </span>
      ${r.alreadyAdded ? '' : `<button class="icon-btn scan-ignore" data-ignore="${r.port}" title="忽略此端口">忽略</button>`}
    </label>`).join('');
}

async function importScan() {
  const picked = $$('#scan-list input[type="checkbox"]:checked')
    .map((cb) => state.scan.results.find((r) => r.port === Number(cb.dataset.port)))
    .filter(Boolean);
  if (!picked.length) return toast('请先勾选要导入的端口', 'err');

  const btn = $('#scan-import');
  btn.disabled = true;
  btn.textContent = '导入中…';
  try {
    const res = await api('POST', '/api/scan/import', {
      items: picked,
      group: $('#scan-group').value.trim() || '本机服务',
    });
    const data = await api('GET', '/api/bootstrap');
    state.groups = data.groups;
    state.services = data.services;
    hide('#scan-modal'); // 导入完成就该关掉，列表里的行状态已过期（不再标记已收录）
    render();
    toast(`已导入 ${res.created} 个服务，正在抓取图标…`, 'ok');
  } catch (err) {
    toast(err.message, 'err');
  } finally {
    btn.disabled = false;
    btn.textContent = '导入选中';
  }
}

/* ------------------------------------------------------------ 设置 */

async function openSettings() {
  const info = await api('GET', '/api/db').catch(() => null);
  if (info) {
    $('#s-db').innerHTML = `
      <span>数据库：${esc(info.file)}（${(info.size / 1024).toFixed(1)} KB）</span>
      <span>服务 ${info.services} 条 · 分组 ${info.groups} 个 · 图标缓存 ${info.iconCount} 个</span>
      <span>图标目录：${esc(info.iconsDir)}</span>`;
  }
  $('#s-interval').value = state.settings.healthInterval ?? 0;
  $('#s-external').value = state.settings.externalHost || '';
  $('#s-site-name').value = state.settings.siteName || '';
  renderSiteIconPreview();
  $('#s-candidates').hidden = true;
  show('#settings-modal');
  loadNetworkInfo();
}

/** 设置弹窗里的站点图标预览：有图标显示图，没有显示默认罗盘 */
function renderSiteIconPreview() {
  const icon = (state.settings.siteIcon || '').trim();
  const img = $('#s-site-icon-preview');
  const fallback = $('#s-site-icon-fallback');
  $('#s-site-icon-clear').hidden = !icon;
  if (icon) {
    img.src = `/icons/${encodeURIComponent(icon)}?t=${Date.now()}`;
    img.hidden = false;
    fallback.hidden = true;
  } else {
    img.hidden = true;
    img.removeAttribute('src');
    fallback.hidden = false;
  }
}

/** 拉取网卡与 ZeroTier 信息，列出可选的外部地址 */
async function loadNetworkInfo() {
  let net;
  try {
    net = await api('GET', '/api/network');
  } catch {
    return;
  }
  const hint = $('#s-external-hint');
  const box = $('#s-candidates');
  const cands = [];

  if (net.zerotier?.available) {
    for (const n of net.zerotier.networks) {
      cands.push({ label: `ZeroTier · ${n.name || n.nwid}`, value: n.ip, primary: true });
    }
  } else if (net.zerotier && !net.zerotier.available) {
    hint.textContent = `未检测到 ZeroTier（${net.zerotier.error || '未知原因'}）。`;
  }
  for (const i of net.interfaces || []) {
    if (cands.some((c) => c.value === i.address)) continue;
    cands.push({ label: `${i.name}${i.virtual ? '（虚拟网卡）' : ''}`, value: i.address });
  }

  if (!cands.length) {
    box.hidden = true;
    return;
  }
  box.hidden = false;
  box.innerHTML = cands.map((c) => `
    <button class="btn small ${c.primary ? 'primary' : 'ghost'}" data-host="${esc(c.value)}">
      ${esc(c.label)} · ${esc(c.value)}
    </button>`).join('');
}

/** 预检：用给定地址探一遍所有服务，告诉用户哪些连得上 */
async function probeExternalHost(host) {
  const btn = $('#s-detect');
  btn.disabled = true;
  btn.textContent = '检测中…';
  try {
    const r = await api('POST', '/api/network/probe', { host, all: true });
    const bad = r.results.filter((x) => x.status === 'local-only');
    if (bad.length) {
      toast(`${host}：${r.reachable}/${r.total} 可达，${bad.length} 个服务只绑了 127.0.0.1（${bad.map((b) => ':' + b.port).join(' ')}）`, 'info', 8000);
    } else {
      toast(`${host}：${r.reachable}/${r.total} 个服务全部可达`, 'ok');
    }
  } catch (err) {
    toast('检测失败：' + err.message, 'err');
  } finally {
    btn.disabled = false;
    btn.textContent = '检测';
  }
}

async function saveSettings() {
  try {
    state.settings = await api('PUT', '/api/settings', {
      healthInterval: Number($('#s-interval').value) || 0,
      externalHost: $('#s-external').value.trim(),
      siteName: $('#s-site-name').value.trim(),
    });
    hide('#settings-modal');
    applySiteBranding();
    render();
    toast('设置已保存', 'ok');
    // 外部地址变了就立刻重新检测一轮，让状态马上反映实际可达性
    if (externalHost()) checkHealth(null);
  } catch (err) {
    toast(err.message, 'err');
  }
}

async function refreshAllIcons(mode) {
  const list = state.services.filter((s) => s.url);
  if (!list.length) return;
  if (!confirm(`将对 ${list.length} 个服务重新处理图标，期间会持续刷新，继续？`)) return;
  toast(`开始处理 ${list.length} 个图标…`, 'info');
  let done = 0;
  const queue = [...list];
  const workers = Array.from({ length: 4 }, async () => {
    while (queue.length) {
      const svc = queue.shift();
      try {
        if (mode === 'mono') {
          const updated = await api('POST', `/api/services/${svc.id}/icon/generate`, { text: svc.name.slice(0, 2) });
          upsertService(updated);
          patchCard(updated);
        } else {
          await api('POST', `/api/services/${svc.id}/icon`, {});
        }
      } catch { /* 单个失败不中断 */ }
      done++;
      if (done % 5 === 0) toast(`进度 ${done}/${list.length}`, 'info', 1200);
    }
  });
  await Promise.all(workers);
  const data = await api('GET', '/api/bootstrap');
  state.services = data.services;
  render();
  toast(`图标处理完成（${list.length} 个）`, 'ok');
}

/* ------------------------------------------------------------ 分组编辑 */

function openGroupEdit(id = null) {
  const g = id ? state.groups.find((x) => x.id === Number(id)) : null;
  state.editingGroup = id;
  $('#group-title').textContent = g ? '编辑分组' : '新建分组';
  $('#g-name').value = g?.name || '';
  $('#g-color').value = g?.color || '#5b8def';
  $('#g-delete').hidden = !g;
  show('#group-modal');
  setTimeout(() => $('#g-name').focus(), 60);
}

async function saveGroup() {
  const name = $('#g-name').value.trim();
  if (!name) return toast('请填写分组名', 'err');
  const body = { name, color: $('#g-color').value };
  try {
    if (state.editingGroup) await api('PUT', `/api/groups/${state.editingGroup}`, body);
    else await api('POST', '/api/groups', body);
    const data = await api('GET', '/api/bootstrap');
    state.groups = data.groups;
    state.services = data.services;
    hide('#group-modal');
    render();
    toast('分组已保存', 'ok');
  } catch (err) {
    toast(err.message, 'err');
  }
}

async function deleteGroup() {
  const id = state.editingGroup;
  const g = state.groups.find((x) => x.id === Number(id));
  if (!g) return;
  if (!confirm(`删除分组「${g.name}」？组内服务会变成未分组，不会被删除。`)) return;
  try {
    await api('DELETE', `/api/groups/${id}`);
    const data = await api('GET', '/api/bootstrap');
    state.groups = data.groups;
    state.services = data.services;
    if (state.filter.group === String(id)) state.filter.group = 'all';
    hide('#group-modal');
    render();
    toast('分组已删除', 'ok');
  } catch (err) {
    toast(err.message, 'err');
  }
}

/* ------------------------------------------------------------ 拖拽排序 */

/**
 * 分组拖拽排序。列表由 renderSidebar() 整体重绘，所以走委托、绑一次就够。
 * 拖拽期间不能用 renderSidebar() 反馈（会打断 drag 事件流），只用 class 标记落点。
 */
function initGroupDrag() {
  const list = $('#group-list');
  let dragId = null;

  list.addEventListener('dragstart', (e) => {
    const li = e.target.closest('li[data-group][draggable]');
    if (!li) return;
    dragId = li.dataset.group;
    li.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', dragId);
  });
  list.addEventListener('dragend', () => {
    dragId = null;
    $$('#group-list li').forEach((li) => li.classList.remove('dragging', 'drop-target'));
  });
  list.addEventListener('dragover', (e) => {
    if (dragId == null) return;
    // 内置组不能作为落点（它们位置固定），只有可拖动的自定义组可以
    const li = e.target.closest('li[data-group][draggable]');
    if (!li || li.dataset.group === dragId) return;
    e.preventDefault();
    $$('#group-list li.drop-target').forEach((x) => x.classList.remove('drop-target'));
    li.classList.add('drop-target');
  });
  list.addEventListener('drop', async (e) => {
    const li = e.target.closest('li[data-group][draggable]');
    if (!li || dragId == null || li.dataset.group === dragId) return;
    e.preventDefault();

    // 本地重排：state.groups 的顺序 = 侧栏自定义组顺序（rows 里在 all 之后、ungrouped 之前）
    const ids = state.groups.map((g) => String(g.id));
    const from = ids.indexOf(dragId);
    const to = ids.indexOf(li.dataset.group);
    if (from < 0 || to < 0) return;
    const [moved] = ids.splice(from, 1);
    ids.splice(to, 0, moved);
    const byId = new Map(state.groups.map((g) => [String(g.id), g]));
    state.groups = ids.map((id) => byId.get(id));
    renderSidebar();

    try {
      await api('POST', '/api/groups/reorder', { ids: ids.map(Number) });
    } catch (err) {
      toast('分组排序保存失败：' + err.message, 'err');
    }
  });
}

function initDrag() {  const content = $('#content');
  content.addEventListener('dragstart', (e) => {
    const card = e.target.closest('.card');
    if (!card) return;
    state.dragId = Number(card.dataset.id);
    card.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', String(state.dragId));
  });
  content.addEventListener('dragend', () => {
    state.dragId = null;
    $$('.card').forEach((c) => c.classList.remove('dragging', 'drop-target'));
  });
  content.addEventListener('dragover', (e) => {
    const card = e.target.closest('.card');
    if (!card || state.dragId == null) return;
    if (Number(card.dataset.id) === state.dragId) return;
    e.preventDefault();
    $$('.card.drop-target').forEach((c) => c.classList.remove('drop-target'));
    card.classList.add('drop-target');
  });
  content.addEventListener('drop', async (e) => {
    const card = e.target.closest('.card');
    if (!card || state.dragId == null) return;
    e.preventDefault();
    const targetId = Number(card.dataset.id);
    if (targetId === state.dragId) return;

    // 重排本地顺序：把拖拽项移动到目标位置
    const ordered = [...state.services].sort((a, b) => a.sort_order - b.sort_order || a.id - b.id);
    const from = ordered.findIndex((s) => s.id === state.dragId);
    const to = ordered.findIndex((s) => s.id === targetId);
    if (from < 0 || to < 0) return;
    const [moved] = ordered.splice(from, 1);
    ordered.splice(to, 0, moved);
    ordered.forEach((s, i) => { s.sort_order = (i + 1) * 10; });
    state.services = ordered;
    renderContent();

    try {
      await api('POST', '/api/services/reorder', { ids: ordered.map((s) => s.id) });
    } catch (err) {
      toast('排序保存失败：' + err.message, 'err');
    }
  });
}

/* ------------------------------------------------------------ 事件绑定 */

function show(sel) { $(sel).hidden = false; }
function hide(sel) { $(sel).hidden = true; }

function initEvents() {
  // 侧边栏
  $('#group-list').addEventListener('click', (e) => {
    const editBtn = e.target.closest('[data-edit-group]');
    if (editBtn) { e.stopPropagation(); return openGroupEdit(editBtn.dataset.editGroup); }
    const li = e.target.closest('li[data-group]');
    if (!li) return;
    state.filter.group = li.dataset.group;
    render();
  });
  // 分组拖拽排序：只允许拖动自定义分组（内置「全部服务」「未分组」位置固定）
  initGroupDrag();
  $('#add-group').addEventListener('click', () => openGroupEdit(null));
  $('#search').addEventListener('input', (e) => { state.filter.search = e.target.value; renderContent(); });
  $('#btn-scan').addEventListener('click', openScan);
  $('#btn-health').addEventListener('click', () => checkHealth(null));
  $('#btn-settings').addEventListener('click', openSettings);
  $('#btn-docker').addEventListener('click', () => dockerEnter());

  // Docker 视图：页签 / 刷新 / 容器操作 / 详情、日志（事件委托，容器卡片会整体重绘）
  $('#content').addEventListener('click', (e) => {
    if (!state.docker.view) return;
    const tab = e.target.closest('#docker-tab button');
    if (tab) { state.docker.tab = tab.dataset.tab; renderDocker(); return; }
    if (e.target.closest('#docker-refresh')) { loadDocker(); return; }
    const act = e.target.closest('[data-dact]');
    if (act && !act.disabled) {
      const name = act.closest('[data-container]')?.dataset.container;
      if (name) dockerAction(name, act.dataset.dact);
      return;
    }
    const detail = e.target.closest('[data-ddetail]');
    if (detail) openDockerDetail(detail.dataset.ddetail);
  });
  $('#docker-logs-btn').addEventListener('click', (e) => {
    const name = e.currentTarget.dataset.name;
    if (name) openDockerLogs(name);
  });
  $('#logs-refresh').addEventListener('click', (e) => {
    const name = e.currentTarget.dataset.name;
    if (name) openDockerLogs(name);
  });
  $('#btn-new').addEventListener('click', () => openEdit(null));
  $('#theme-toggle').addEventListener('click', () => {
    const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
    document.documentElement.dataset.theme = next;
    syncThemeIcon();
    api('PUT', '/api/settings', { theme: next }).catch(() => {});
  });

  // 顶部筛选
  $('#kind-filter').addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-kind]');
    if (!btn) return;
    state.filter.kind = btn.dataset.kind;
    $$('#kind-filter button').forEach((b) => b.classList.toggle('active', b === btn));
    renderContent();
  });
  $('#view-mode').addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-mode]');
    if (!btn) return;
    state.filter.mode = btn.dataset.mode;
    $$('#view-mode button').forEach((b) => b.classList.toggle('active', b === btn));
    $('#content').dataset.mode = state.filter.mode;
    api('PUT', '/api/settings', { viewMode: state.filter.mode }).catch(() => {});
  });

  // 卡片交互
  $('#content').addEventListener('click', (e) => {
    const card = e.target.closest('.card');
    if (!card) return;
    const id = Number(card.dataset.id);
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (act === 'edit') return openEdit(id);
    if (act === 'del') return deleteService(id);
    if (act === 'check') return checkHealth([id]);
    if (act === 'copy') return copyAddress(state.services.find((s) => s.id === id) || {});
    const svc = state.services.find((s) => s.id === id);
    if (!svc) return;
    if (svc.url) return void window.open(displayUrl(svc), '_blank', 'noopener');
    // 数据库这类没有网页界面的服务：点一下复制地址，省得去翻配置
    if (svc.port) return void copyAddress(svc);
    toast('该服务没有可用地址', 'err');
  });

  // 编辑弹窗
  $('#btn-preview').addEventListener('click', previewUrl);
  $('#f-url').addEventListener('keydown', (e) => { if (e.key === 'Enter') previewUrl(); });
  $('#btn-save').addEventListener('click', saveService);
  $('#btn-delete').addEventListener('click', () => deleteService(state.editing));
  $('#btn-icon-auto').addEventListener('click', () => {
    if (state.editing) return serviceIconAction(state.editing, {});
    previewUrl();
  });
  $('#btn-icon-mono').addEventListener('click', () => {
    if (state.editing) return generateMonogram(state.editing);
    const name = $('#f-name').value || $('#f-url').value || '?';
    state.editingIcon = { icon_file: null, icon_source: 'monogram', icon_url: null };
    $('#icon-current').innerHTML = `<img src="${monogramDataUrl(name)}" alt="">`;
    toast('保存后将生成字母图', 'info');
  });
  $('#btn-icon-lib').addEventListener('click', openIconLib);

  // 图标库弹窗
  $('#iconlib-search').addEventListener('input', () => {
    clearTimeout(iconLibTimer);
    iconLibTimer = setTimeout(runIconLibSearch, 220);
  });
  $('#iconlib-grid').addEventListener('click', (e) => {
    const item = e.target.closest('.iconlib-item');
    if (item) applyLibIcon(item.dataset.lib, item.dataset.name);
  });
  $('#iconlib-lib').addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-lib]');
    if (!btn) return;
    $$('#iconlib-lib button').forEach((b) => b.classList.toggle('active', b === btn));
    runIconLibSearch();
  });
  $('#iconlib-refresh').addEventListener('click', async () => {
    const btn = $('#iconlib-refresh');
    btn.disabled = true;
    btn.textContent = '刷新中…';
    try {
      await api('POST', '/api/iconlib/refresh', {});
      toast('图标库索引已更新', 'ok');
      await ensureIconLibIndex();
      runIconLibSearch();
    } catch (err) {
      toast('刷新失败：' + err.message, 'err');
    } finally {
      btn.disabled = false;
      btn.innerHTML = '<svg class="ic ic-sm" aria-hidden="true"><use href="#i-refresh-cw"/></svg> 刷新索引';
    }
  });
  $('#btn-icon-custom').addEventListener('click', async () => {
    const url = prompt('粘贴图片地址，或 data:image/... 的 base64');
    if (!url) return;
    if (state.editing) return serviceIconAction(state.editing, { icon_url: url });
    try {
      const res = await fetch(url);
      const blob = await res.blob();
      const dataUrl = await new Promise((r) => {
        const fr = new FileReader();
        fr.onload = () => r(fr.result);
        fr.readAsDataURL(blob);
      });
      $('#icon-current').innerHTML = `<img src="${dataUrl}" alt="">`;
      toast('图标已预览，保存后生效', 'ok');
    } catch {
      $('#icon-current').innerHTML = `<img src="${esc(url)}" alt="">`;
    }
  });
  $('#f-name').addEventListener('input', () => { if (!state.editingIcon?.icon_file) renderIconCurrent(); });

  // 扫描弹窗
  $('#scan-rescan').addEventListener('click', runScan);
  for (const id of ['#scan-hide-system', '#scan-hide-added', '#scan-web-only']) {
    $(id).addEventListener('change', renderScan);
  }
  $('#scan-select-web').addEventListener('click', () => {
    $$('#scan-list .scan-row').forEach((row) => {
      const cb = $('input[type="checkbox"]', row);
      if (cb && !cb.disabled) cb.checked = Boolean(state.scan.results.find((r) => r.port === Number(row.dataset.port))?.http);
    });
  });
  $('#scan-import').addEventListener('click', importScan);
  $('#scan-list').addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-ignore]');
    if (!btn) return;
    e.preventDefault();
    e.stopPropagation();
    const port = Number(btn.dataset.ignore);
    await api('POST', '/api/scan/ignore', { port });
    state.scan.results = state.scan.results.filter((r) => r.port !== port);
    renderScan();
    toast(`已忽略端口 ${port}`, 'info');
  });

  // 设置弹窗
  $('#btn-save-settings').addEventListener('click', saveSettings);

  // 站点图标上传 / 恢复默认
  $('#s-site-icon-upload').addEventListener('click', () => $('#s-site-icon-file').click());
  $('#s-site-icon-file').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file) return;
    if (file.size > 3 * 1024 * 1024) return toast('图片超过 3MB，换一张小的', 'err');
    try {
      const dataUrl = await new Promise((resolve, reject) => {
        const fr = new FileReader();
        fr.onload = () => resolve(fr.result);
        fr.onerror = () => reject(new Error('读取文件失败'));
        fr.readAsDataURL(file);
      });
      const r = await api('POST', '/api/site-icon', { dataUrl });
      state.settings.siteIcon = r.siteIcon;
      renderSiteIconPreview();
      applySiteBranding();
      toast('站点图标已更新', 'ok');
    } catch (err) {
      toast(err.message, 'err');
    }
  });
  $('#s-site-icon-clear').addEventListener('click', async () => {
    try {
      await api('DELETE', '/api/site-icon');
      state.settings.siteIcon = '';
      renderSiteIconPreview();
      applySiteBranding();
      toast('已恢复默认图标', 'ok');
    } catch (err) {
      toast(err.message, 'err');
    }
  });
  $('#s-detect').addEventListener('click', () => {
    const host = $('#s-external').value.trim();
    if (!host) return toast('请先填写外部地址，或点下面的候选地址', 'err');
    probeExternalHost(host);
  });
  $('#s-candidates').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-host]');
    if (!btn) return;
    $('#s-external').value = btn.dataset.host;
    probeExternalHost(btn.dataset.host);
  });
  $('#btn-refresh-icons').addEventListener('click', () => refreshAllIcons('auto'));
  $('#btn-refresh-mono').addEventListener('click', () => refreshAllIcons('mono'));
  $('#btn-export').addEventListener('click', () => { window.location.href = '/api/export'; });
  $('#btn-import').addEventListener('click', () => $('#import-file').click());
  $('#import-file').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      const data = JSON.parse(await file.text());
      const res = await api('POST', '/api/import', { data });
      const fresh = await api('GET', '/api/bootstrap');
      state.groups = fresh.groups;
      state.services = fresh.services;
      hide('#settings-modal');
      render();
      toast(`导入完成：新增 ${res.services} 个服务`, 'ok');
    } catch (err) {
      toast('导入失败：' + err.message, 'err');
    }
    e.target.value = '';
  });

  // 分组弹窗
  $('#g-save').addEventListener('click', saveGroup);
  $('#g-delete').addEventListener('click', deleteGroup);

  // 通用关闭
  document.addEventListener('click', (e) => {
    if (e.target.closest('[data-close]')) {
      const modal = e.target.closest('.modal-backdrop');
      if (modal) modal.hidden = true;
    }
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      $$('.modal-backdrop').forEach((m) => { m.hidden = true; });
      return;
    }
    const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName);
    if ((e.key === '/' && !typing) || ((e.metaKey || e.ctrlKey) && e.key === 'k')) {
      e.preventDefault();
      $('#search').focus();
      $('#search').select();
    }
    if ((e.metaKey || e.ctrlKey) && e.key === 'n') {
      e.preventDefault();
      openEdit(null);
    }
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter' && !$('#edit-modal').hidden) {
      e.preventDefault();
      saveService();
    }
  });

  initDrag();
}

/* ------------------------------------------------------------ Docker 容器 */

const DOCKER_STATE_TEXT = {
  running: '运行中', exited: '已退出', paused: '已暂停',
  created: '已创建', restarting: '重启中', dead: '异常退出',
};

function dockerEnter() {
  state.docker.view = true;
  if (state.docker.containers.length || state.docker.error) renderDocker();
  else loadDocker();
}

function dockerLeave() {
  state.docker.view = false;
  renderContent();
}

async function loadDocker() {
  renderDockerLoading();
  try {
    const [c, n] = await Promise.all([api('GET', '/api/docker/containers'), api('GET', '/api/docker/networks')]);
    state.docker.containers = c.containers || [];
    state.docker.networks = n.networks || [];
    state.docker.error = '';
  } catch (err) {
    state.docker.error = err.message;
  }
  updateDockerCount();
  renderDocker();
}

function updateDockerCount() {
  const badge = $('#docker-count');
  if (!badge) return;
  const running = state.docker.containers.filter((c) => c.state === 'running').length;
  if (!state.docker.containers.length) { badge.hidden = true; return; }
  badge.hidden = false;
  badge.textContent = `${running}/${state.docker.containers.length}`;
}

function renderDockerLoading() {
  if (!state.docker.view) return;
  $('#view-title').textContent = 'Docker 容器';
  $('#view-sub').textContent = '';
  $('#content').innerHTML = '<div class="loading">正在读取容器…</div>';
}

function dockerStatusClass(c) {
  if (c.state === 'running') return c.health === 'unhealthy' ? 'bad' : 'ok';
  if (c.state === 'restarting') return 'warn';
  if (c.state === 'paused') return 'warn';
  return 'muted';
}

function dockerContainerRow(c) {
  const busy = state.docker.busy.has(c.name);
  const cls = dockerStatusClass(c);
  const ports = c.ports.filter((p) => p.hostPort).map((p) => `:${p.hostPort}`);
  const compose = c.composeProject ? `<span class="tag" title="Compose 项目">${esc(c.composeProject)}</span>` : '';
  return `
    <article class="card docker-card" data-container="${esc(c.name)}">
      <span class="card-status ${cls}" title="${esc(DOCKER_STATE_TEXT[c.state] || c.state)}"></span>
      <div class="card-body">
        <div class="card-title docker-title">
          <strong title="${esc(c.name)}">${esc(c.name)}</strong>
        </div>
        <div class="docker-sub">
          <span class="docker-state ${cls}">${esc(DOCKER_STATE_TEXT[c.state] || c.state)}</span>
          ${c.stats ? `<span class="docker-res" title="CPU / 内存">${esc(c.stats.cpu)} · ${esc(c.stats.mem.split('/')[0].trim())}</span>` : ''}
        </div>
        <div class="card-url" title="${esc(c.image)}">${esc(c.image)}</div>
        <div class="card-tags">
          ${c.status ? `<span class="tag">${esc(c.status)}</span>` : ''}
          ${ports.map((p) => `<span class="tag port">${esc(p)}</span>`).join('')}
          ${c.networks.map((n) => `<span class="tag" title="网络">${esc(n)}</span>`).join('')}
          ${compose}
        </div>
      </div>
      <div class="card-actions docker-actions">
        ${c.state === 'running'
          ? `<button class="icon-btn" data-dact="stop" title="停止" ${busy ? 'disabled' : ''}><svg class="ic ic-sm" aria-hidden="true"><use href="#i-square"/></svg></button>
             <button class="icon-btn" data-dact="restart" title="重启" ${busy ? 'disabled' : ''}><svg class="ic ic-sm" aria-hidden="true"><use href="#i-rotate-cw"/></svg></button>`
          : c.state === 'paused'
            ? `<button class="icon-btn" data-dact="unpause" title="恢复" ${busy ? 'disabled' : ''}><svg class="ic ic-sm" aria-hidden="true"><use href="#i-play"/></svg></button>`
            : `<button class="icon-btn" data-dact="start" title="启动" ${busy ? 'disabled' : ''}><svg class="ic ic-sm" aria-hidden="true"><use href="#i-play"/></svg></button>`}
        <button class="icon-btn" data-ddetail="${esc(c.name)}" title="详情 / 网络"><svg class="ic ic-sm" aria-hidden="true"><use href="#i-search"/></svg></button>
      </div>
    </article>`;
}

function renderDocker() {
  if (!state.docker.view) return;
  const content = $('#content');
  $('#view-title').textContent = 'Docker 容器';
  const d = state.docker;

  if (d.error) {
    content.innerHTML = `
      <div class="empty">
        <div class="big"><svg class="ic ic-xl" aria-hidden="true"><use href="#i-container"/></svg></div>
        <p>Docker 不可用</p>
        <p class="hint">${esc(d.error)}</p>
        <p class="hint"><button class="btn small" id="docker-retry" style="margin-top:10px">重试</button></p>
      </div>`;
    $('#docker-retry')?.addEventListener('click', loadDocker);
    return;
  }

  const tabs = `
    <div class="docker-toolbar">
      <div class="seg" id="docker-tab">
        <button data-tab="containers" class="${d.tab === 'containers' ? 'active' : ''}">容器 <b>${d.containers.length}</b></button>
        <button data-tab="networks" class="${d.tab === 'networks' ? 'active' : ''}">网络 <b>${d.networks.length}</b></button>
      </div>
      <div class="spacer"></div>
      <button class="btn small ghost" id="docker-refresh"><svg class="ic ic-sm" aria-hidden="true"><use href="#i-refresh-cw"/></svg> 刷新</button>
    </div>`;

  if (d.tab === 'networks') {
    const rows = d.networks.map((n) => `
      <section class="group-block">
        <div class="group-block-head">
          <span class="group-dot" style="background:var(--accent)"></span>
          <span>${esc(n.name)}</span>
          <span class="count">${n.containers.length} 个容器</span>
        </div>
        <div class="docker-net">
          <div class="docker-net-meta">
            <span class="tag">${esc(n.driver)}</span>
            ${n.internal ? '<span class="tag warn">internal</span>' : ''}
            ${n.subnet ? `<span class="tag port">${esc(n.subnet)}</span>` : ''}
            ${n.gateway ? `<span class="tag">网关 ${esc(n.gateway)}</span>` : ''}
          </div>
          ${n.containers.length ? `
            <table class="docker-net-table">
              <thead><tr><th>容器</th><th>IP</th></tr></thead>
              <tbody>${n.containers.map((c) => `
                <tr><td>${esc(c.name)}</td><td class="mono">${esc(c.ipv4 || c.ipv6 || '—')}</td></tr>`).join('')}
              </tbody>
            </table>` : '<p class="hint" style="padding:8px 2px">没有容器接入</p>'}
        </div>
      </section>`).join('');
    content.innerHTML = `${tabs}${rows || '<div class="empty"><p>没有网络</p></div>'}`;
    return;
  }

  const running = d.containers.filter((c) => c.state === 'running');
  const stopped = d.containers.filter((c) => c.state !== 'running');
  const block = (title, items) => items.length ? `
    <section class="group-block">
      <div class="group-block-head">
        <span class="group-dot" style="background:var(--ok)"></span>
        <span>${title}</span>
        <span class="count">${items.length}</span>
      </div>
      <div class="cards">${items.map(dockerContainerRow).join('')}</div>
    </section>` : '';
  content.innerHTML = `${tabs}${block('运行中', running)}${block('已停止', stopped)
    || (!d.containers.length ? '<div class="empty"><div class="big"><svg class="ic ic-xl" aria-hidden="true"><use href="#i-container"/></svg></div><p>没有容器</p></div>' : '')}`;
}

async function dockerAction(name, action) {
  state.docker.busy.add(name);
  renderDocker();
  try {
    await api('POST', `/api/docker/containers/${encodeURIComponent(name)}/${action}`);
    toast(`${name} · ${action} 成功`, 'ok');
  } catch (err) {
    toast(`${name} · ${action} 失败：${err.message}`, 'err', 5000);
  }
  state.docker.busy.delete(name);
  await loadDocker();
}

async function openDockerDetail(name) {
  show('#docker-modal');
  $('#docker-title').textContent = name;
  $('#docker-hint').textContent = '';
  $('#docker-detail').innerHTML = '<div class="loading">正在载入…</div>';
  $('#docker-logs-btn').dataset.name = name;
  let c;
  try {
    const r = await api('GET', `/api/docker/containers/${encodeURIComponent(name)}`);
    c = r.container;
  } catch (err) {
    $('#docker-detail').innerHTML = `<div class="loading">${esc(err.message)}</div>`;
    return;
  }

  const portRows = Object.entries(c.ports || {}).map(([k, binds]) => {
    if (!binds?.length) return `<tr><td class="mono">${esc(k)}</td><td class="mono muted-text">未映射</td></tr>`;
    return binds.map((b) => `<tr><td class="mono">${esc(b.HostIp === '::' ? '0.0.0.0' : b.HostIp)}:${esc(b.HostPort)}</td><td class="mono">${esc(k)}</td></tr>`).join('');
  }).join('');
  const netRows = Object.entries(c.networks || {}).map(([name, n]) => `
    <tr><td>${esc(name)}</td><td class="mono">${esc(n.ip || '—')}/${n.prefixLen}</td>
    <td class="mono">${esc(n.gateway || '—')}</td>
    <td>${(n.aliases || []).map((a) => `<span class="tag">${esc(a)}</span>`).join(' ')}</td></tr>`).join('');
  const mountRows = (c.mounts || []).map((m) => `
    <tr><td class="mono" title="${esc(m.source)}">${esc(m.source.length > 42 ? m.source.slice(0, 40) + '…' : m.source)}</td>
    <td class="mono">${esc(m.dest)}</td><td>${m.rw ? 'rw' : 'ro'}</td></tr>`).join('');
  const sec = (title, body) => body ? `
    <section class="docker-sec">
      <h3>${title}</h3>${body}
    </section>` : '';
  const table = (head, rows) => `<table class="docker-net-table"><thead><tr>${head.map((h) => `<th>${h}</th>`).join('')}</tr></thead><tbody>${rows}</tbody></table>`;

  $('#docker-detail').innerHTML = `
    <div class="docker-detail-head">
      <span class="docker-state ${dockerStatusClass({ state: c.state, health: c.health })}">${esc(DOCKER_STATE_TEXT[c.state] || c.state)}</span>
      ${c.health ? `<span class="tag">health: ${esc(c.health)}</span>` : ''}
      <span class="tag port">${esc(c.image)}</span>
      ${c.restartPolicy ? `<span class="tag">重启策略: ${esc(c.restartPolicy)}</span>` : ''}
      ${c.restartCount ? `<span class="tag warn">已重启 ${c.restartCount} 次</span>` : ''}
      ${c.exitCode ? `<span class="tag warn">exit ${c.exitCode}</span>` : ''}
    </div>
    <div class="kv">ID ${esc(c.id)} · 启动于 ${esc((c.startedAt || '').replace('T', ' ').slice(0, 19))}</div>
    ${sec('端口映射', table(['宿主机', '容器'], portRows))}
    ${sec('网络', table(['网络', 'IP', '网关', '别名'], netRows))}
    ${sec('挂载', table(['宿主机路径', '容器路径', '权限'], mountRows))}
    ${sec('环境变量', `<div class="kv">${c.env.map((e) => esc(e)).join('<br>')}</div>`)}
    ${c.cmd.length || c.entrypoint.length ? sec('启动命令', `<div class="kv">${esc([...c.entrypoint, ...c.cmd].join(' '))}</div>`) : ''}`;
}

async function openDockerLogs(name, tail = 200) {
  show('#logs-modal');
  $('#logs-title').textContent = `${name} · 日志`;
  $('#logs-hint').textContent = `最近 ${tail} 条`;
  $('#logs-view').textContent = '正在载入…';
  $('#logs-refresh').dataset.name = name;
  try {
    const r = await api('GET', `/api/docker/containers/${encodeURIComponent(name)}/logs?tail=${tail}`);
    $('#logs-view').textContent = r.logs || '（无日志）';
    $('#logs-view').scrollTop = $('#logs-view').scrollHeight;
  } catch (err) {
    $('#logs-view').textContent = `读取失败：${err.message}`;
  }
}

/* ------------------------------------------------------------ SSE 实时 */

function initSSE() {
  let es;
  const connect = () => {
    es = new EventSource('/api/events');
    es.addEventListener('service', (e) => {
      const svc = JSON.parse(e.data);
      upsertService(svc);
      patchCard(svc);
      renderSidebar();
    });
    es.addEventListener('deleted', (e) => {
      const { id } = JSON.parse(e.data);
      state.services = state.services.filter((s) => s.id !== id);
      render();
    });
    es.addEventListener('health', (e) => {
      const { updated } = JSON.parse(e.data);
      for (const u of updated) {
        const svc = state.services.find((s) => s.id === u.id);
        if (svc) { svc.status = u.status; svc.latency_ms = u.latency; }
        const card = $(`.card[data-id="${u.id}"]`);
        const dot = $('.card-status', card || document.createElement('div'));
        if (dot) {
          dot.className = `card-status ${u.status}`;
          dot.title = statusText(u.status) + (u.latency ? ` · ${u.latency}ms` : '');
        }
        if (svc) syncUnavailable(card, svc);
      }
      renderSidebar();
    });
    es.addEventListener('reload', async () => {
      const data = await api('GET', '/api/bootstrap');
      state.groups = data.groups;
      state.services = data.services;
      state.settings = data.settings;
      applySiteBranding();
      if (state.docker.view) loadDocker();
      else render();
    });
    es.addEventListener('docker', () => {
      // 任何一端操作了容器，所有打开着 Docker 视图的页面自动刷新
      if (state.docker.view) loadDocker();
      else api('GET', '/api/docker/containers').then((r) => {
        state.docker.containers = r.containers || [];
        updateDockerCount();
      }).catch(() => {});
    });
    es.onerror = () => {
      es.close();
      setTimeout(connect, 3000); // 服务重启后自动恢复
    };
  };
  connect();
}

/* ------------------------------------------------------------ 启动 */

initEvents();
load().catch((err) => {
  $('#loading').textContent = '载入失败：' + err.message;
});
initSSE();
