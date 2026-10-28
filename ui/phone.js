/**
 * 手机外壳 —— 锁屏、桌面、路由、通知。
 *
 * 【它不认识 SillyTavern】
 * 所有数据来自 parent.__miniPhone（宿主挂的同源函数桥），
 * 所有推送来自宿主调 window.__miniPhoneReceive(type, payload)。
 *
 * 【App 的契约】
 * 每个 App 模块导出 mount(root, ctx)，返回：
 *   { title, back?(): boolean, leave?(): void, refresh?(): void }
 *   back() 返回 true 表示"我处理了这一层，别退出 App"。
 */

// 版本号：从 iframe 地址的 ?v= 取，拼给下面的动态 import 做缓存失效
const V = window.__MP_V || '';
const { APPS, HOME, findApp } = await import(/* @vite-ignore */ `./apps.js?v=${encodeURIComponent(V)}`);

/* ------------------------------------------------------------ 连接 */

let api = null;
try {
  api = parent.__miniPhone?.bind(window) ?? null;
} catch {
  api = null;                 // 单独打开 ui/index.html 调试时会走到这里
}

/** 外壳自己的状态 */
const state = {
  space: null,                // { name, type, user, contacts, hasModel }
  settings: null,
  unread: { chat: 0, moments: 0 },
  booted: false,
};

/** iframe → 宿主的单向通知（宿主会重新拉数据） */
const emit = (type, payload) => {
  try { window.parent?.postMessage({ __miniPhoneEvent: true, type, payload }, '*'); }
  catch { /* 跨域时静默 */ }
};

/* ------------------------------------------------------------ DOM */

const $ = (sel) => document.querySelector(sel);

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/* ------------------------------------------------------------ 路由 */

const stack = [];      // [{ appId, inst, root }]
let current = null;

function screen() { return $('#screen'); }
function appLayer() { return $('#app-host'); }
function homeLayer() { return $('#layer-home'); }

async function openApp(appId, params = {}) {
  const app = findApp(appId);
  if (!app) return;

  const root = el('div', 'app-root');
  appLayer().append(root);

  showLayer('app');
  setTitle(app.name);
  setBackVisible(false);

  let inst = null;
  try {
    const mod = await app.load();
    inst = await mod.mount(root, makeContext(app, params));
  } catch (e) {
    root.append(el('p', 'empty', `打不开：${e?.message ?? e}`));
    console.error('[phone] app failed:', appId, e);
  }

  current = { appId, inst, root, params };
  stack.length = 0;
  stack.push(current);

  if (inst?.title) setTitle(inst.title);
  setBackVisible(stack.length > 1 || !!inst?.back);
  // App 可能自己接管返回
  if (inst && typeof inst.back === 'function') setBackVisible(true);
}

/** App 内部再往下走一层（用壳的返回栈，但内容由 App 自己渲染） */
function pushLevel(inst) {
  if (!current) return;
  stack.push({ ...current, inst });
  setBackVisible(true);
}

/** 返回：交给 App 处理，处理不了就回桌面 */
function goBack() {
  if (current?.inst?.back?.()) return true;
  leaveApp();
  return false;
}

function leaveApp() {
  try { current?.inst?.leave?.(); } catch { /* 忽略 */ }
  current = null;
  stack.length = 0;
  appLayer().innerHTML = '';
  showLayer('home');
  setTitle('');
  setBackVisible(false);
  renderHome();
  emit('appClosed');
}

/* ------------------------------------------------------------ 图片 */

/**
 * 把用户选的图缩成正方形头像，返回 data URL。
 * 为什么在前端压：原图动辄几 MB，base64 之后更大，塞进 settings
 * 会把酒馆的 settings.json 撑爆。160×160 JPEG 只有 8KB 左右。
 */
async function compressImage(file, size = 160, quality = 0.82) {
  const bitmap = await createImageBitmap(file);
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const g = canvas.getContext('2d');

  // 居中裁成正方形再缩，避免头像变形
  const side = Math.min(bitmap.width, bitmap.height);
  const sx = (bitmap.width - side) / 2;
  const sy = (bitmap.height - side) / 2;
  g.drawImage(bitmap, sx, sy, side, side, 0, 0, size, size);
  bitmap.close?.();

  return canvas.toDataURL('image/jpeg', quality);
}

/** 弹文件选择框，返回压缩后的 data URL（用户取消返回 null） */
function pickImage(size = 160) {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';

    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };

    input.addEventListener('change', async () => {
      const file = input.files?.[0];
      if (!file) { finish(null); return; }
      try { finish(await compressImage(file, size)); }
      catch (e) { console.warn('[phone] 图片处理失败：', e?.message); finish(null); }
    });

    // 用户直接关掉选择框时，change 不会触发。用窗口焦点回来兜底。
    window.addEventListener('focus', () => setTimeout(() => finish(null), 800), { once: true });

    input.click();
  });
}

/* ------------------------------------------------------------ 上下文 */

function makeContext(app, params) {
  return {
    api,
    state,
    params,
    app,

    /** App 想换标题 */
    setTitle: (t) => setTitle(t),

    /** App 想自己画返回按钮（默认壳画） */
    setBackVisible,

    /** App 内部跳一层：返回时先交给 back() */
    push: () => pushLevel(current?.inst),

    /** 直接回桌面 */
    home: leaveApp,

    /** 让壳重新拉未读 */
    refreshBadges,

    toast,

    /** 选一张图并缩成头像，返回 data URL（取消返回 null） */
    pickImage,

    /** 通知宿主（宿主会重新取数据或做别的） */
    notify: emit,

    /** 请求宿主刷新（比如保存了设置） */
    reload: () => loadAll(),
  };
}

/* ------------------------------------------------------------ 布局 */

const LAYERS = ['lock', 'home', 'app'];

function showLayer(name) {
  for (const id of LAYERS) {
    document.getElementById(`layer-${id}`)?.classList.toggle('active', id === name);
  }
  document.body.dataset.layer = name;
}

function setTitle(text) {
  const h = $('#app-title');
  if (h) h.textContent = text || '';
}

function setBackVisible(on) {
  $('#btn-back')?.classList.toggle('hidden', !on);
}

/* ------------------------------------------------------------ 桌面 */

async function renderHome() {
  const grid = $('#home-grid');
  if (!grid) return;
  grid.innerHTML = '';

  for (const id of HOME) {
    const app = findApp(id);
    if (!app) continue;

    const tile = el('button', 'tile');
    tile.type = 'button';
    tile.dataset.app = id;
    tile.style.setProperty('--accent', app.accent ?? '#4f8cff');

    const icon = el('span', 'tile-icon', app.icon);
    tile.append(icon);

    const badgeKey = app.badge;
    const n = badgeKey ? (state.unread[badgeKey] ?? 0) : 0;
    if (n > 0) tile.append(el('span', 'tile-badge', n > 99 ? '99+' : String(n)));

    tile.append(el('span', 'tile-name', app.name));
    tile.addEventListener('click', () => openApp(id));
    grid.append(tile);
  }

  // 顶部信息：现在是哪个角色的手机
  const who = $('#home-who');
  if (who) who.textContent = state.space?.name ? `${state.space.name} 的手机` : '';
}

async function refreshBadges() {
  if (!api) return;
  try {
    state.unread.chat = await api.unread();
    state.unread.moments = await api.momentsUnread();
  } catch { /* 忽略 */ }
  renderHome();
}

/* ------------------------------------------------------------ 数据 */

async function loadAll() {
  if (!api) {
    // 调试模式：给一份假数据，让界面能看
    state.space = { name: '调试', user: '我', contacts: [], hasModel: false };
    state.settings = { mode: 'story', budget: {}, theme: 'dark' };
    state.booted = true;
    renderHome();
    return;
  }
  try {
    state.space = await api.init();
    state.settings = state.space.settings;
    document.body.dataset.theme = state.settings?.theme ?? 'dark';
    state.booted = true;
    renderHome();
    await refreshBadges();
  } catch (e) {
    toast(`连接失败：${e?.message ?? e}`);
  }
}

/* ------------------------------------------------------------ 推送 */

/**
 * 宿主推过来的事件。
 * 只做三件事：更新未读、提示、转给当前 App 刷新。
 */
window.__miniPhoneReceive = (type, payload = {}) => {
  switch (type) {
    case 'init':
    case 'space':
      state.space = payload;
      state.settings = payload?.settings ?? state.settings;
      if (payload?.settings?.theme) document.body.dataset.theme = payload.settings.theme;
      renderHome();
      // 当前开着 App 的话，让 App 自己决定要不要刷（设置页只重建音色区）
      try { current?.inst?.refresh?.(); }
      catch (e) { console.warn('[phone] refresh 失败：', e?.message); }
      break;

    case 'message': {
      const from = payload?.messages?.[0]?.from ?? payload?.message?.from;
      const n = payload?.messages?.length ?? 1;
      if (payload?.mine) break;
      if (from) toast(`${from}：${n > 1 ? `${n} 条新消息` : (payload.messages?.[0]?.text ?? '')}`);
      refreshBadges();
      if (current?.appId === 'chat') current.inst?.refresh?.();
      break;
    }

    case 'moment':
      if (payload?.fromStory) toast('有新动态');
      refreshBadges();
      if (current?.appId === 'moments') current.inst?.refresh?.();
      break;

    case 'typing':
      if (current?.appId === 'chat') current.inst?.onTyping?.(payload);
      break;

    case 'visibility':
      if (!payload?.open) current?.inst?.leave?.();
      break;

    case 'error':
      toast(payload?.message ?? '出错了');
      break;
  }
};

/* ------------------------------------------------------------ toast */

let toastTimer = 0;
function toast(text) {
  const t = $('#toast');
  if (!t) return;
  t.textContent = String(text ?? '').slice(0, 120);
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 2400);
}

/* ------------------------------------------------------------ 时钟 */

function tick() {
  const now = new Date();
  const hh = String(now.getHours()).padStart(2, '0');
  const mm = String(now.getMinutes()).padStart(2, '0');
  const set = (sel, v) => { const n = $(sel); if (n) n.textContent = v; };
  set('#status-time', `${hh}:${mm}`);
  set('#lock-time', `${hh}:${mm}`);
  set('#lock-date', `${now.getMonth() + 1} 月 ${now.getDate()} 日 · 周${'日一二三四五六'[now.getDay()]}`);
}

/* ------------------------------------------------------------ 启动 */

function bindChrome() {
  $('#btn-back')?.addEventListener('click', goBack);
  // 锁屏整块可点：id 必须是 layer-lock（之前写成 #lock，导致点了没反应）
  $('#layer-lock')?.addEventListener('click', () => showLayer('home'));

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && document.body.dataset.layer === 'app') goBack();
  });

  // 边缘右滑返回
  let x0 = 0, y0 = 0, tracking = false;
  document.addEventListener('touchstart', (e) => {
    const t = e.touches[0];
    x0 = t.clientX; y0 = t.clientY;
    tracking = x0 < 36;
  }, { passive: true });
  document.addEventListener('touchend', (e) => {
    if (!tracking) return;
    tracking = false;
    const t = e.changedTouches[0];
    if (t.clientX - x0 > 70 && Math.abs(t.clientY - y0) < 60 && document.body.dataset.layer === 'app') goBack();
  }, { passive: true });
}

async function boot() {
  tick();
  setInterval(tick, 20_000);
  bindChrome();
  showLayer('lock');

  // 调试口：控制台里能看到壳的内部状态
  window.__MP_SHELL = {
    get current() { return current ? { appId: current.appId, hasRefresh: typeof current.inst?.refresh === 'function' } : null; },
    get layer() { return document.body.dataset.layer; },
    get state() { return { space: state.space?.name, booted: state.booted }; },
  };

  await loadAll();

  // 告诉宿主"我准备好了"
  if (parent !== window) {
    try { parent.document.dispatchEvent(new CustomEvent('miniPhoneReady')); } catch { /* 跨域忽略 */ }
  }
  window.__miniPhoneReady = true;
}

boot();
