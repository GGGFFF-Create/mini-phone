/**
 * 宿主层 —— 唯一 import SillyTavern 的文件。
 *
 * 边界：
 *   这里负责和酒馆打交道（读角色卡、注入提示词、看正文、投递消息）
 *   core/ 负责纯逻辑（协议、存储、模型调用、聊天与朋友圈）
 *   ui/ 负责画界面，不认识 SillyTavern
 *
 * 生命周期：酒馆用 <script type="module"> 加载本文件（顶层只准定义），
 * 然后按 manifest.hooks 调用 enable / disable / dispose。hook 有 5 秒预算。
 */

import { parseLines, renderLines, plainLines, diagnose, speechRule, KEEP_REPLY, protocolFromTemplate, DEFAULT_PROTOCOL, markLines, buttonsFromMarks, stripWaves, unmark, clearStage } from './core/protocol.js';
import { extractPhone, hasPhone, phoneRule } from './core/phone.js';
import { createRoster } from './core/routes.js';
import { createStore } from './core/store.js';
import { createClient, createProfile, BUILTIN_PROFILES, profileTemplate, validateProfile } from './core/llm.js';
import { createChatService } from './core/chat.js';
import { createMomentsService } from './core/moments.js';
import { createTTS, BUILTIN_ENGINES, templateOf, validateEngine, createEngine } from './core/tts/index.js';

const NS = 'miniPhone';
const BASE = new URL('.', import.meta.url);

/**
 * 版本号。必须和 manifest.json 的 version 一致 —— load-check 会校验。
 *
 * 为什么要在代码里也写一份：iframe 的地址要带 `?v=` 才能让浏览器在更新后
 * 重新拉 ui/*.js。不然用户点了"更新"、刷新页面，看到的还是旧界面，然后来问
 * 你"为什么没变"。
 */
const VERSION = '0.11.0';

/** 默认设置。改结构时同步加 version，迁移在 normalize() 里做。 */
const DEFAULTS = {
  version: 1,
  enabled: true,

  // 台词协议
  protocol: { tag: 'tts', sep: '|', fields: ['role', 'emotion', 'text'] },
  language: '',
  stripTags: true,          // 发给模型前剥掉 <tts>/<phone>
  keepExample: true,        // 保留最新一条作格式示例

  // 注入
  inject: { enabled: true, depth: 2, role: 1 },

  // 手机聊天
  chat: {
    mode: 'story',          // story | offstory | hybrid
    budget: { storyFull: 2, storyBrief: 6, cardText: 1200, personaText: 500, history: 20, loreCount: 3 },
    proactive: { on: false, every: 3, dailyMax: 3 },
  },

  // 朋友圈
  moments: {
    on: true,
    every: 5,               // 每 N 条正文，考虑发一条动态
    reactToMe: true,        // 角色会不会对我的动态点赞评论
  },

  // 独立模型（聊天用）—— 多套配置，可切换
  llm: {
    activeId: 'openai',
    profiles: {},             // 用户改过的配置（没改过的用内置默认）
  },

  // 语音
  voice: {
    enabled: false,
    activeEngine: 'openai',
    engines: {},              // 用户改过的引擎配置（没改过的用内置默认）
    voices: {},               // 角色名 → { engine, voice, language }
    language: '',
    speed: 1,                 // 全局语速倍率（引擎上也能单独配，引擎的优先）
    previewText: '',          // 试听用的句子，空 = 用默认的
    cacheLimitMB: 200,
    prefetch: true,           // 播这句时把下一句做好
    autoPrepare: false,       // 回复完把整段先做好（烧钱，默认关）
    autoNarrate: false,       // 旁白（非台词部分）也念
  },

  // 联系人 = 当前卡的成员 + 手动加的 + 剧情里说过话的
  contacts: [],
  /** 在剧情里说过话的人，按卡记录：{ name, cards: ['card:xxx'], at } */
  seenRoles: [],
  /**
   * 自定义头像。{ 名字: { dataUrl, at } }
   * 存压缩后的 data URL（160×160 JPEG 大约 8KB）——
   * 不用 IndexedDB 是为了"换个浏览器也能带着走"，
   * 因为 settings 会跟着酒馆的 settings.json 同步。
   */
  avatars: {},

  ui: { theme: 'dark', lastThread: '', closedAt: 0 },
};

/* ------------------------------------------------------------ 状态 */

let active = false;
let settings = null;
let store = null;
let roster = null;
let chatSvc = null;
let momentsSvc = null;
let tts = null;
let client = null;
let panel = null;
let iframe = null;
let bridge = null;

/** 老版酒馆（1.18 及以前）被包装前的原 messageFormatting，disable 时要还原 */
let legacyFormatting = null;

const listeners = [];     // [source, event, fn]
let floorCount = 0;       // 已经看了几楼
let quietCount = 0;       // 连续几楼没在手机上说话
let pendingPhone = null;  // 待带进正文的手机聊天

const context = () => globalThis.SillyTavern?.getContext();
const esc = (s) => String(s ?? '');

/* ------------------------------------------------------ 设置规范化 */

function normalizeSettings(raw) {
  const base = structuredClone(DEFAULTS);
  const merge = (t, s) => {
    for (const [k, v] of Object.entries(s ?? {})) {
      if (v && typeof v === 'object' && !Array.isArray(v) && t[k] && typeof t[k] === 'object') merge(t[k], v);
      else if (v !== undefined) t[k] = v;
    }
    return t;
  };
  return merge(base, raw);
}

function saveSettings() {
  const ctx = context();
  if (ctx?.extensionSettings) ctx.extensionSettings[NS] = structuredClone(settings);
  ctx?.saveSettingsDebounced?.();
}

/* -------------------------------------------------------- 名册/范围 */

/** 当前这部手机属于谁：群聊 or 角色卡 */
function currentSpace() {
  const ctx = context();
  try {
    const gid = ctx?.groupId;
    if (gid !== undefined && gid !== null && gid !== '') {
      const g = ctx?.groups?.find(x => String(x?.id) === String(gid));
      return { key: `group:${gid}`, name: g?.name || '群聊', type: 'group', members: (g?.members ?? []).map(a => ctx?.characters?.find(c => c?.avatar === a)?.name).filter(Boolean) };
    }
    const ch = ctx?.characters?.[ctx?.characterId];
    return ch?.avatar
      ? { key: `card:${ch.avatar}`, name: ch.name || '', type: 'card', members: [ch.name].filter(Boolean) }
      : { key: 'global', name: '', type: 'card', members: [] };
  } catch { return { key: 'global', name: '', type: 'card', members: [] }; }
}

/**
 * 联系人名册。
 *
 * 【为什么不能直接用 ctx.characters】
 * 那是**整个酒馆的所有角色卡**。列出来会有几十个，用户在设置里看到一堆
 * 跟当前剧情毫无关系的名字，而且换卡之后还是这一堆。
 *
 * 【三路来源，按当前卡过滤】
 *   ① 当前卡的成员：单卡 = 角色名，群聊 = 群成员。这是主体。
 *   ② 手动加的（只在加它的那张卡里算数）
 *   ③ 在剧情里说过话的：正文解析出的人名，自动登记到当前卡名下
 *      （跟 ST-iPhonie 的 routes + cards 标记一个思路）
 *
 * 主角（user persona）不算联系人，不进名册。
 */
function buildRoster() {
  const ctx = context();
  const space = currentSpace();
  const all = ctx?.characters ?? [];
  const byName = new Map(all.map(c => [c?.name, c]).filter(([n]) => n));

  const cardOf = (name) => {
    const c = byName.get(name);
    return {
      description: c?.description ?? '',
      personality: c?.personality ?? '',
      avatar: c?.avatar && c.avatar !== 'none' ? c.avatar : '',
    };
  };

  const merged = new Map();

  // ① 当前卡的成员
  for (const name of space.members) {
    const n = String(name ?? '').trim();
    if (!n || n === ctx?.name1) continue;
    merged.set(n, { name: n, aliases: [], source: 'card', ...cardOf(n) });
  }

  // ② 手动加的（带 cardKey 的只在对应卡里出现）
  for (const c of settings.contacts ?? []) {
    const n = String(c?.name ?? '').trim();
    if (!n || n === ctx?.name1) continue;
    if (c.cardKey && c.cardKey !== space.key) continue;
    merged.set(n, { ...(merged.get(n) ?? {}), ...c, name: n, source: merged.get(n)?.source ?? 'manual' });
  }

  // ③ 剧情里说过话的
  for (const r of settings.seenRoles ?? []) {
    const n = String(r?.name ?? '').trim();
    if (!n || n === ctx?.name1) continue;
    if (!Array.isArray(r.cards) || !r.cards.includes(space.key)) continue;
    if (!merged.has(n)) merged.set(n, { name: n, aliases: r.aliases ?? [], source: 'story', ...cardOf(n) });
  }

  // ④ 手动配过音色的人，即使在当前卡没出现过，也要留着 —— 不然用户会以为配置丢了
  for (const n of Object.keys(settings.voice?.voices ?? {})) {
    if (!merged.has(n) && n !== ctx?.name1) {
      merged.set(n, { name: n, aliases: [], source: 'voice', ...cardOf(n) });
    }
  }

  return createRoster([...merged.values()]);
}

/**
 * 把在正文里说过话的人登记到当前卡名下。
 * 全局一份表，每条带 cards 标记 —— 换卡不会丢，换回来还在。
 */
function tagRoles(names, key = currentSpace().key) {
  if (!active || !key) return false;
  const want = [...new Set((names ?? []).map(n => String(n ?? '').trim()).filter(Boolean))];
  if (!want.length) return false;

  const me = context()?.name1 || '';
  const list = [...(settings.seenRoles ?? [])];
  let changed = false;

  for (const name of want) {
    if (name === me) continue;
    const hit = list.find(r => r?.name === name);
    if (hit) {
      const cards = Array.isArray(hit.cards) ? hit.cards : [];
      if (!cards.includes(key)) { hit.cards = [...cards, key].slice(-30); changed = true; }
    } else {
      list.push({ name, cards: [key], at: Date.now() });
      changed = true;
    }
  }

  if (changed) {
    settings.seenRoles = list.slice(-200);   // 别无限涨
    saveSettings();
  }
  return changed;
}

/** 从某条正文里抽出说话的人，登记下来 */
function tagFromStory(id) {
  try {
    const m = context()?.chat?.[Number(id)];
    if (!m || m.is_user || typeof m.mes !== 'string') return;
    const lines = parseLines(m.mes, settings.protocol ?? DEFAULT_PROTOCOL);
    if (!lines.length) return;
    if (tagRoles(lines.map(l => l.role))) {
      refreshRoster();
      bridge?.post('space', spaceInfo());
    }
  } catch { /* 不打断正文 */ }
}

/**
 * 扫一段历史消息，把里面说过话的人全部登记到当前卡。
 *
 * 【为什么需要这个】
 * 只靠"新消息渲染时登记"是不够的：用户打开一张**已经有几十楼**的卡时，
 * 那些楼早就渲染过了，不会再触发一次。结果就是设置页空着 —— 明明在聊天，
 * 却一个人都不列。
 *
 * ST-iPhonie 的做法是换卡时 tagSpeakers(chat.slice(-200))，扫最近 200 条。
 * 这里照做。
 */
function scanSpeakers(messages) {
  const ctx = context();
  const me = ctx?.name1 || '';
  const names = new Set();
  const proto = settings.protocol ?? DEFAULT_PROTOCOL;

  for (const m of messages ?? []) {
    if (!m || m.is_user || m.is_system) continue;
    if (typeof m.mes === 'string') {
      for (const line of parseLines(m.mes, proto)) {
        if (line.role && line.role !== me) names.add(line.role);
      }
    }
    // 消息本身的说话人（群聊里每条都带；单卡就是角色名）
    const who = String(m.name ?? '').trim();
    if (who && who !== me && !/^sillytavern\s+system$/i.test(who) && !/^system$/i.test(who)) {
      names.add(who);
    }
  }

  return names.size ? tagRoles([...names]) : false;
}

/** 重算名册并同步给界面 */
function refreshRoster() {
  roster = buildRoster();
  return roster;
}

const currentCard = () => {
  const space = currentSpace();
  const c = roster?.get(space.name);
  return c ?? { name: space.name || '对方', description: '', personality: '' };
};

/* ------------------------------------------------------- 1. 拦截器 */

/**
 * 发给模型前剥掉 <tts> 和 <phone>。
 * 保留最新一条作格式示例 —— 全剥会让模型忘记怎么写，全留会烧 token 且越写越花。
 */
globalThis.miniPhoneInterceptor = function (chat) {
  if (!active || !settings?.stripTags) return;
  try {
    stripForModel(chat);
  } catch (e) {
    console.warn('[mini-phone] 拦截器跳过：', e?.message);
  }
};

function stripForModel(chat) {
  if (!Array.isArray(chat)) return;
  const proto = settings.protocol ?? DEFAULT_PROTOCOL;

  let keep = -1;
  if (settings.keepExample) {
    for (let i = chat.length - 1; i >= 0; i--) {
      const m = chat[i];
      if (m && !m.is_user && typeof m.mes === 'string' && /<tts\b/i.test(m.mes)) { keep = i; break; }
    }
  }

  for (let i = 0; i < chat.length; i++) {
    const m = chat[i];
    if (typeof m?.mes !== 'string') continue;
    if (!/<(?:tts|phone)\b/i.test(m.mes)) continue;

    let mes = m.mes;
    // 全部剥掉 <phone>（手机内容不进正文历史）
    mes = mes.replace(/<phone\b[^>]*>[\s\S]*?<\/phone\s*>/gi, '').trimEnd();
    // <tts> 只在非示例楼层剥
    if (i !== keep) mes = plainLines(mes, proto);
    if (mes !== m.mes) chat[i] = { ...m, mes };
  }
}

/* --------------------------------------------------------- 2. 注入 */

function clearInject() {
  const ctx = context();
  if (!ctx?.setExtensionPrompt) return;
  for (const key of Object.keys(ctx.extensionPrompts ?? {})) {
    if (key.startsWith('miniPhone.')) ctx.setExtensionPrompt(key, '', -1, 0);
  }
}

/**
 * 注入三类东西：
 *   1. 台词格式规则
 *   2. <phone> 规则（只在轮到手机时）
 *   3. 待带进正文的手机聊天（一次性）
 * 最后固定追加"只加不减"，否则角色卡的状态栏/选项会被吃掉。
 */
function inject() {
  const ctx = context();
  if (!ctx?.setExtensionPrompt || !settings.inject.enabled) return;
  clearInject();

  const space = currentSpace();
  const proto = settings.protocol ?? DEFAULT_PROTOCOL;
  const depth = Math.max(0, Number(settings.inject.depth) || 0);
  const role = Number(settings.inject.role ?? 1);
  const contacts = roster?.names() ?? [];

  // 1. 台词规则
  ctx.setExtensionPrompt('miniPhone.speech', speechRule(proto, { language: settings.language }), 1, depth, false, role);

  // 2. <phone> 规则（回合判断在 shouldPhoneNow()）
  const phoneText = shouldPhoneNow() ? phoneRule({
    user: ctx.name1 || '我',
    contacts,
    groups: [],
    canDraw: false,
  }) : '';
  if (phoneText) ctx.setExtensionPrompt('miniPhone.phone', phoneText, 1, depth, false, role);

  // 3. 待带进正文的手机聊天
  if (pendingPhone) {
    ctx.setExtensionPrompt('miniPhone.bring', pendingPhone.text, 1, depth, false, role);
  }

  // 4. 兜底：规则只加不减
  ctx.setExtensionPrompt('miniPhone.keep', KEEP_REPLY, 1, 0, false, 0);
}

/** 轮到手机了吗（回合制：不是每楼都发） */
function shouldPhoneNow() {
  const p = settings.chat.proactive ?? {};
  if (!p.on) return false;
  if (p.dailyMax > 0 && todayCount() >= p.dailyMax) return false;
  return !(p.every > 0) || quietCount >= p.every - 1;
}

const DAY_KEY = 'miniPhone.day';
function todayCount() {
  try {
    const raw = JSON.parse(localStorage.getItem(DAY_KEY) || 'null');
    const today = new Date().toDateString();
    return raw?.day === today ? (raw.n ?? 0) : 0;
  } catch { return 0; }
}
function bumpToday() {
  try {
    const today = new Date().toDateString();
    const n = todayCount() + 1;
    localStorage.setItem(DAY_KEY, JSON.stringify({ day: today, n }));
  } catch { /* 只影响本会话 */ }
}

/* ------------------------------------------------------- 3. 投递 */

/**
 * 一条正文回复生成完：抽出 <phone> 投递到聊天和朋友圈。
 * @returns {Promise<number>} 投递了几条
 */
async function deliverFromStory(messageId) {
  const ctx = context();
  const idx = Number.isInteger(Number(messageId)) ? Number(messageId) : (ctx?.chat?.length ?? 1) - 1;
  const m = ctx?.chat?.[idx];
  if (!m || m.is_user || m.is_system || typeof m.mes !== 'string') return 0;
  if (!settings.chat.proactive?.on && !settings.moments?.on) return 0;

  const known = roster?.names() ?? [];
  const extracted = extractPhone(m.mes, {
    known,
    resolve: (n) => roster?.resolve(n) ?? n,   // 正文里写"小柚"，要归到"柚子"
  });
  if (!extracted.private.length && !extracted.groups.length) return 0;

  const origin = { floor: idx, ver: hashOf(m.mes) };
  const chatItems = [...extracted.private];
  const momentItems = chatItems.filter(i => i.kind === 'moment');

  let sent = 0;
  const chatOnly = { private: chatItems.filter(i => i.kind !== 'moment'), groups: extracted.groups };
  if (chatOnly.private.length || chatOnly.groups.length) {
    const results = await chatSvc.receive(chatOnly, origin);
    sent += results.reduce((n, r) => n + r.items.length, 0);
    for (const r of results) notify(`${r.name} 发来 ${r.items.length} 条`);
  }
  if (settings.moments?.on && momentItems.length) {
    const added = await momentsSvc.ingest(momentItems, origin);
    sent += added.length;
    if (added.length) notify(`${added.length} 条新动态`);
  }

  if (sent) { quietCount = 0; bumpToday(); }
  return sent;
}

const hashOf = (s) => {
  let h = 0;
  for (const c of String(s)) h = (h * 31 + c.codePointAt(0)) | 0;
  return (h >>> 0).toString(36);
};

/* ------------------------------------------- 3.5 正文渲染（三阶段） */

/**
 * 正文里长出"可点按钮"的过程分三阶段，原因见 core/protocol.js 的注释。
 * 这里只负责：判断该不该处理、把 token 管好、接住点击。
 */

/** 每次渲染的令牌：消息 id + 递增序号，防止旧 DOM 点出错误的行 */
let renderTick = 0;
/** 消息 id → 这次渲染用的 token。阶段一写入，阶段二读出。 */
const renderTokens = new Map();

const tokenOf = (meta) => `m${meta?.messageId ?? '?'}-${meta?.swipeId ?? 0}-${++renderTick}`;

/** 这条消息该不该加按钮 */
function shouldDecorate(meta) {
  if (!active || !settings?.voice?.enabled) return false;
  if (!meta) return false;
  if (meta.isUser || meta.isSystem || meta.isReasoning) return false;
  if (Number(meta.messageId) < 0) return false;
  return true;
}

function bindRender() {
  const ctx = context();

  /* ── 路线一：新版酒馆的 messageFormatter（三阶段钩子）── */
  const fm = ctx?.messageFormatter;
  if (fm?.addHook) {
    bindRenderStages(fm);
    console.info('[mini-phone] 正文渲染：messageFormatter 三阶段');
    document.addEventListener('click', onClickWave, true);
    return;
  }

  /* ── 路线二：老版酒馆的 messageFormatting（包装这个函数）── */
  const original = ctx?.messageFormatting;
  if (typeof original === 'function') {
    legacyFormatting = original;
    ctx.messageFormatting = function (text, name, isSystem, isUser, messageId, ...rest) {
      // 出任何问题都退回原样，绝不让正文变空
      if (!active || !settings?.voice?.enabled) return original.call(this, text, name, isSystem, isUser, messageId, ...rest);
      if (isSystem || isUser || !(Number(messageId) >= 0)) {
        return original.call(this, text, name, isSystem, isUser, messageId, ...rest);
      }
      try {
        const token = tokenOf({ messageId });
        renderTokens.set(messageId, token);
        // 先打隐形标记再交给酒馆渲染 —— 私用区字符不会被 markdown 转义
        const marked = markLines(text, settings.protocol ?? DEFAULT_PROTOCOL, { token });
        const html = original.call(this, marked, name, isSystem, isUser, messageId, ...rest);
        return withSayAll(buttonsFromMarks(html, { token }));
      } catch (e) {
        console.warn('[mini-phone] 渲染降级：', e?.message);
        return original.call(this, text, name, isSystem, isUser, messageId, ...rest);
      }
    };
    console.info('[mini-phone] 正文渲染：messageFormatting 包装（老版本酒馆）');
    document.addEventListener('click', onClickWave, true);
    return;
  }

  /* ── 都没有：只能不用正文按钮 ── */
  console.info('[mini-phone] 这版酒馆既没有 messageFormatter 也没有 messageFormatting，正文不显示声波按钮。声音仍可在手机里念。');
  document.addEventListener('click', onClickWave, true);
}

/**
 * 在渲染结果末尾追加「念整段」按钮。
 *
 * 单句声波是"点哪儿念哪儿"，这个是一次把整楼台词念完 —— 想听一整段
 * 对话的走向时不用一句句点。
 */
function withSayAll(html) {
  if (!active || !settings?.voice?.enabled) return html;
  if (typeof html !== 'string' || !html.includes('mp-line')) return html;
  return `${html}<button type="button" class="mp-sayall" data-say-all data-state="idle">▷ 念整段</button>`;
}

/** 从 DOM 里把这一楼的台词全捞出来，按顺序念 */
async function sayAllFrom(btn) {
  const host = btn.closest('.mes_text') ?? btn.parentElement;
  if (!host) return;

  const lines = [...host.querySelectorAll('.mp-line')]
    .sort((a, b) => Number(a.dataset.i ?? 0) - Number(b.dataset.i ?? 0))
    .map((n) => ({
      role: n.dataset.role || '',
      emotion: n.dataset.emotion || '',
      text: n.dataset.text || '',
      // .mp-tr 里是带弯引号的显示文本，剥掉引号
      translation: (n.querySelector('.mp-tr')?.textContent ?? '').replace(/^[“"']+|[”"']+$/g, '').trim(),
    }))
    .filter(l => l.role && (l.text || l.translation));

  if (!lines.length) {
    btn.dataset.state = 'error';
    btn.title = '这一楼没有可念的台词';
    return;
  }

  btn.dataset.state = 'loading';
  btn.textContent = '准备中…';
  try {
    if (tts?.busy) tts.stop();
    await tts.speakAll(lines);
    btn.dataset.state = 'done';
  } catch (e) {
    btn.dataset.state = 'error';
    btn.title = String(e?.message ?? e);
    console.warn('[mini-phone] 念整段失败：', e?.message);
  } finally {
    btn.textContent = '▷ 念整段';
    setTimeout(() => { if (btn.dataset.state === 'done') btn.dataset.state = 'idle'; }, 1200);
  }
}

function bindRenderStages(fm) {
  const st = fm.stage ?? {};
  const proto = () => settings.protocol ?? DEFAULT_PROTOCOL;

  if (st.AFTER_MARKDOWN) {
    // ── 标准三阶段 ──
    fm.addHook((text, meta) => {
      if (!shouldDecorate(meta)) return text;
      try {
        const token = tokenOf(meta);
        renderTokens.set(meta.messageId, token);
        return markLines(text, proto(), { token });
      } catch { return text; }
    }, { stage: st.BEFORE_REGEX });

    fm.addHook((text, meta) => {
      if (!active || !settings?.voice?.enabled) return unmark(text);
      if (!meta || meta.isUser || meta.isSystem || meta.isReasoning) return text;
      try {
        return withSayAll(buttonsFromMarks(text, { token: renderTokens.get(meta.messageId) ?? '' }));
      } catch { return unmark(text); }
    }, { stage: st.AFTER_MARKDOWN });

    fm.addHook((text) => {
      if (!active) return text;
      try { return stripWaves(text); } catch { return text; }
    }, { stage: st.AFTER_REGEX });

    return;
  }

  // 有 addHook 但没有 stage：单阶段一次成型
  fm.addHook((text, meta) => {
    if (!shouldDecorate(meta)) return text;
    try { return renderLines(text, proto(), { token: tokenOf(meta) }); }
    catch { return text; }
  });
  console.info('[mini-phone] 正文渲染：messageFormatter 单阶段');
}

/** 点击正文里的声波 */
async function onClickWave(event) {
  /* 「念整段」：一次把这一楼所有台词念完 */
  const allBtn = event.target?.closest?.('[data-say-all]');
  if (allBtn) {
    event.preventDefault();
    event.stopPropagation();
    const anyReady = tts?.readyFor({ role: currentSpace().name, text: '', emotion: '' });
    if (!anyReady?.ok) {
      notify(anyReady?.why ?? '语音还没配好：设置 → 语音');
      openPanel();
      return;
    }
    sayAllFrom(allBtn);
    return;
  }

  const btn = event.target?.closest?.('.mp-play');
  if (!btn) return;
  if (event.detail > 1) return;          // 双击放过

  event.preventDefault();
  event.stopPropagation();

  const holder = btn.closest('.mp-line');
  if (!holder) return;

  const line = {
    role: holder.dataset.role ?? '',
    emotion: holder.dataset.emotion ?? '',
    text: holder.dataset.text ?? '',
    translation: holder.querySelector('.mp-tr')?.textContent?.replace(/^[“"]|[”"]$/g, '') ?? '',
  };

  const ready = tts?.readyFor(line);
  if (!ready?.ok) {
    notify(ready?.why ?? '语音还没配好：设置 → 语音');
    openPanel();
    return;
  }

  const setState = (state) => {
    btn.dataset.state = state;
    btn.disabled = state === 'loading';
  };

  try {
    setState('loading');
    await tts.speak(line, {
      onState: (s) => setState(s === 'done' ? 'done' : s),
    });
  } catch (e) {
    setState('error');
    notify(`没念出来：${e?.message ?? e}`);
  }
}

/* ------------------------------------------------------- 4. 事件 */
function bindEvents() {
  const ctx = context();
  const es = ctx?.eventSource;
  const t = ctx?.eventTypes;
  if (!es?.on || !t) return;

  const add = (evt, fn) => {
    if (!evt) return;
    es.on(evt, fn);
    listeners.push([es, evt, fn]);
  };

  // 生成前注入
  add(t.GENERATION_AFTER_COMMANDS, () => {
    try { inject(); } catch (e) { console.warn('[mini-phone] 注入失败：', e?.message); }
  });

  // 一条回复渲染完：投递 <phone>，顺便登记这一楼说过话的人
  add(t.CHARACTER_MESSAGE_RENDERED, (id) => {
    tagFromStory(id);
    try { deliverFromStory(id).catch(e => console.warn('[mini-phone] 投递失败：', e?.message)); }
    catch { /* 不打断正文 */ }
  });

  // 重抽：撤回这一楼之前投递的
  add(t.MESSAGE_SWIPED, (id) => {
    try {
      const m = ctx?.chat?.[id];
      if (!m) return;
      chatSvc.withdraw(Number(id), hashOf(m.mes)).catch(() => {});
    } catch { /* 忽略 */ }
  });

  // 换聊天/换卡：清注入、重建名册、扫历史登记说话的人
  add(t.CHAT_CHANGED, () => {
    try {
      clearInject();
      pendingPhone = null;
      quietCount = 0;
      floorCount = 0;

      // ① 当前卡的成员先登记（群聊成员、单卡角色名）
      tagRoles(currentSpace().members);
      // ② 再扫历史：打开一张早就在聊的卡时，那些楼不会再触发渲染事件
      scanSpeakers((context()?.chat ?? []).slice(-200));
      // ③ 重算并推给界面
      refreshRoster();
      bridge?.post('space', spaceInfo());
    } catch (e) {
      // 这里以前是空 catch —— 出错就静默，界面上看不出任何异常。
      // 换成能看见的日志，出问题时有线索。
      console.warn('[mini-phone] 换卡处理失败：', e?.message, e);
    }
  });
}

/* ------------------------------------------------------- 5. 面板 */

function mountEntry() {
  const menu = document.getElementById('extensionsMenu');
  if (menu && !document.getElementById('miniPhone-item')) {
    const item = document.createElement('div');
    item.id = 'miniPhone-item';
    item.className = 'list-group-item flex-container flexGap5 interactable';
    item.tabIndex = 0;
    // 文案加前缀：酒馆会给每个扩展自动生成一个同名开关项，
    // 不区分的话菜单里会出现两个「小手机」
    item.innerHTML = '<i class="fa-solid fa-mobile-screen-button"></i><span>打开小手机</span>';
    item.addEventListener('click', openPanel);
    menu.append(item);
  }
}

function unmountEntry() {
  document.getElementById('miniPhone-item')?.remove();
}

/**
 * 浮动窗，不是模态对话框。
 *
 * 为什么不用 <dialog> + showModal()：
 * 那会给整个页面盖一层遮罩，正文看不见也点不了 —— 而这个小手机的用途
 * 恰恰是"边看正文边用"。所以改成一个 fixed 定位的浮层：
 * 可拖、可缩放、可收成小球，位置记在 localStorage。
 */

const LAYOUT_KEY = 'miniPhone.layout';

/**
 * 三档尺寸。默认用「中」——之前固定 390×760，在笔记本上一放就占掉小半屏。
 * 数字按 iPhone 的逻辑分辨率来（SE / 8 / 14）。
 */
const SIZES = {
  s: { w: 330, h: 620 },
  m: { w: 372, h: 736 },
  l: { w: 392, h: 844 },
};
const SIZE_ORDER = ['s', 'm', 'l'];
/** 默认用「小」—— 手机是配着正文一起看的，占太多屏幕就没法边看边用了 */
const DEFAULT_SIZE = 's';

const sizeOf = (name) => SIZES[name] ?? SIZES[DEFAULT_SIZE];

function loadLayout() {
  try {
    const raw = JSON.parse(localStorage.getItem(LAYOUT_KEY) || 'null');
    if (raw && Number.isFinite(raw.w) && Number.isFinite(raw.h)) return raw;
  } catch { /* 用默认值 */ }
  return null;
}

function saveLayout() {
  if (!panel) return;
  const r = panel.getBoundingClientRect();
  try {
    localStorage.setItem(LAYOUT_KEY, JSON.stringify({
      left: Math.round(r.left), top: Math.round(r.top),
      w: Math.round(r.width), h: Math.round(r.height),
      size: currentSize,
      minimized: panel.classList.contains('mp-min'),
    }));
  } catch { /* 忽略 */ }
}

/** 当前尺寸档位 */
let currentSize = DEFAULT_SIZE;

function applySize(name) {
  const size = sizeOf(name);
  currentSize = SIZES[name] ? name : DEFAULT_SIZE;
  if (!panel) return;
  const r = panel.getBoundingClientRect();
  const pos = clampToViewport(r.left, r.top, size.w + 12, size.h + 12);
  panel.style.width = `${size.w}px`;
  panel.style.height = `${size.h}px`;
  panel.style.left = `${pos.left}px`;
  panel.style.top = `${pos.top}px`;
  const label = panel.querySelector('[data-size-label]');
  if (label) label.textContent = { s: '小', m: '中', l: '大' }[currentSize] ?? '';
  saveLayout();
}

function clampToViewport(left, top, w, h) {
  const vw = window.innerWidth, vh = window.innerHeight;
  return {
    left: Math.min(Math.max(8, left), Math.max(8, vw - w - 8)),
    top: Math.min(Math.max(8, top), Math.max(8, vh - h - 8)),
  };
}

function buildPanel() {
  // isConnected 检查很重要：酒馆重绘、别的扩展清理 DOM、用户手动删节点，
  // 都可能让 panel 变成"还在变量里但已经不在页面上"的孤儿。不重建的话，
  // 之后每次 openPanel 都往一个空气里加 class，看起来就是"点了没反应"。
  if (panel && !panel.isConnected) {
    panel = null;
    iframe = null;
    bridge = null;
  }
  if (panel) return panel;

  panel = document.createElement('div');
  panel.id = 'miniPhone-float';
  panel.className = 'mp-float';
  panel.innerHTML = `
    <div class="mp-bar" data-drag>
      <span class="mp-bar-dot"></span>
      <span class="mp-bar-title">小手机</span>
      <span class="mp-bar-acts">
        <button type="button" data-act="size" title="切换尺寸"><span data-size-label>中</span></button>
        <button type="button" data-act="min" title="收起">—</button>
        <button type="button" data-act="close" title="关闭">×</button>
      </span>
    </div>
    <div class="mp-body"></div>
    <div class="mp-grip" data-grip title="拖动调整大小"></div>
  `;

  iframe = document.createElement('iframe');
  iframe.title = '小手机';
  // ?v= 版本号：更新后浏览器会重新拉 ui 下的文件。不带它，用户刷新也看不到改动。
  iframe.src = new URL(`ui/index.html?v=${VERSION}`, BASE).href;
  iframe.setAttribute('allow', 'microphone; autoplay');
  panel.querySelector('.mp-body').append(iframe);

  // 初始位置与尺寸
  const saved = loadLayout();
  currentSize = saved?.size && SIZES[saved.size] ? saved.size : DEFAULT_SIZE;
  const size = sizeOf(currentSize);
  const w = saved?.w ?? size.w;
  const h = saved?.h ?? Math.min(size.h, window.innerHeight - 60);
  const pos = clampToViewport(
    saved?.left ?? window.innerWidth - w - 32,
    saved?.top ?? Math.max(16, (window.innerHeight - h) / 2),
    w, h,
  );
  Object.assign(panel.style, {
    left: `${pos.left}px`, top: `${pos.top}px`,
    width: `${w}px`, height: `${h}px`,
  });
  if (saved?.minimized) panel.classList.add('mp-min');

  // 按钮
  panel.querySelector('[data-act="close"]').addEventListener('click', (e) => {
    e.stopPropagation();
    closePanel();
  });
  panel.querySelector('[data-act="min"]').addEventListener('click', (e) => {
    e.stopPropagation();
    toggleMinimize();
  });
  panel.querySelector('[data-act="size"]').addEventListener('click', (e) => {
    e.stopPropagation();
    const i = SIZE_ORDER.indexOf(currentSize);
    applySize(SIZE_ORDER[(i + 1) % SIZE_ORDER.length]);
  });

  // 标题栏上的尺寸字
  const sizeLabel = panel.querySelector('[data-size-label]');
  if (sizeLabel) sizeLabel.textContent = { s: '小', m: '中', l: '大' }[currentSize] ?? '';

  // 拖动（只在标题栏上，且不点到按钮）
  const bar = panel.querySelector('[data-drag]');
  bar.addEventListener('pointerdown', (e) => {
    if (e.target.closest('button')) return;
    e.preventDefault();
    const r = panel.getBoundingClientRect();
    const start = { x: e.clientX, y: e.clientY, left: r.left, top: r.top };
    bar.setPointerCapture(e.pointerId);

    const move = (ev) => {
      const p = clampToViewport(
        start.left + ev.clientX - start.x,
        start.top + ev.clientY - start.y,
        panel.offsetWidth, panel.offsetHeight,
      );
      panel.style.left = `${p.left}px`;
      panel.style.top = `${p.top}px`;
    };
    const up = () => {
      bar.removeEventListener('pointermove', move);
      bar.removeEventListener('pointerup', up);
      saveLayout();
    };
    bar.addEventListener('pointermove', move);
    bar.addEventListener('pointerup', up);
  });

  // 缩放（右下角把手）
  const grip = panel.querySelector('[data-grip]');
  grip.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    const start = { x: e.clientX, y: e.clientY, w: panel.offsetWidth, h: panel.offsetHeight };
    grip.setPointerCapture(e.pointerId);

    const move = (ev) => {
      const w2 = Math.max(300, Math.min(720, start.w + ev.clientX - start.x));
      const h2 = Math.max(420, Math.min(window.innerHeight - 20, start.h + ev.clientY - start.y));
      panel.style.width = `${w2}px`;
      panel.style.height = `${h2}px`;
    };
    const up = () => {
      grip.removeEventListener('pointermove', move);
      grip.removeEventListener('pointerup', up);
      saveLayout();
    };
    grip.addEventListener('pointermove', move);
    grip.addEventListener('pointerup', up);
  });

  // 双击标题栏回到默认位置
  bar.addEventListener('dblclick', () => {
    const w2 = FLOAT_W, h2 = Math.min(FLOAT_H, window.innerHeight - 40);
    const p = clampToViewport(window.innerWidth - w2 - 32, Math.max(20, (window.innerHeight - h2) / 2), w2, h2);
    Object.assign(panel.style, { left: `${p.left}px`, top: `${p.top}px`, width: `${w2}px`, height: `${h2}px` });
    saveLayout();
  });

  document.body.append(panel);

  // 同源直调：iframe 里拿 parent.__miniPhone 就能用
  bridge = createBridge();
  globalThis.__miniPhone = bridge.api;
  return panel;
}

function toggleMinimize() {
  if (!panel) return;
  panel.classList.toggle('mp-min');
  saveLayout();
}

function openPanel() {
  buildPanel();
  panel.classList.remove('mp-hidden');
  if (panel.classList.contains('mp-min')) panel.classList.remove('mp-min');
  saveLayout();
  bridge?.post('visibility', { open: true });
  // 等 iframe 就绪再推数据
  const push = () => bridge?.post('init', spaceInfo());
  if (iframe?.contentWindow?.__miniPhoneReady) push();
  else setTimeout(push, 400);
}

function closePanel() {
  if (!panel) return;
  panel.classList.add('mp-hidden');
  bridge?.post('visibility', { open: false });
  saveLayout();
}

function spaceInfo() {
  const ctx = context();
  const space = currentSpace();
  refreshRoster();               // 实时：别把 enable 时的旧名册推给界面
  return {
    name: space.name,
    type: space.type,
    key: space.key,
    user: ctx?.name1 || '我',
    contacts: (roster?.list ?? []).map(c => ({ name: c.name, avatar: avatarUrl(c.name) })),
    hasModel: !!client?.config?.url,
    hasVoice: !!settings.voice?.enabled,
    settings: publicSettings(),
  };
}

/**
 * 头像 URL。
 *
 * 三级优先：
 *   ① 用户自定义的（settings.avatars[name].dataUrl）
 *   ② 主角（name1）→ 从 powerUserSettings.personas 里按名字反查文件名
 *   ③ 角色卡 → getThumbnailUrl('avatar', file)
 *
 * 注意 persona 那一步：ST 1.18 的 powerUserSettings.persona 是 undefined，
 * 真正的头像文件名是 personas 这个表里的 key，得按 name 反查。
 */
function avatarUrl(name) {
  const n = String(name ?? '').trim();
  if (!n) return '';

  const custom = settings?.avatars?.[n]?.dataUrl;
  if (custom) return custom;

  const ctx = context();

  // 主角
  if (n === ctx?.name1) {
    // ST 1.18 里 powerUserSettings.personas 是 { 文件名: 名字 } 的映射
    // （值可能是字符串，也可能是对象 —— 两种都认，别写死）
    const personas = ctx?.powerUserSettings?.personas ?? {};
    const file = Object.keys(personas).find((f) => {
      const v = personas[f];
      return typeof v === 'string' ? v === n : v?.name === n;
    });
    if (file) {
      try {
        return ctx?.getThumbnailUrl?.('persona', file)
          ?? `/thumbnail?type=persona&file=${encodeURIComponent(file)}`;
      } catch { /* 往下走 */ }
    }
    return '';
  }

  // 角色卡
  const ch = ctx?.characters?.find(c => c?.name === n);
  if (ch?.avatar && ch.avatar !== 'none') {
    try {
      return ctx?.getThumbnailUrl?.('avatar', ch.avatar)
        ?? `/thumbnail?type=avatar&file=${encodeURIComponent(ch.avatar)}`;
    } catch { return ''; }
  }
  return '';
}

/** 主角信息：名字、头像、描述 */
function personaInfo() {
  const ctx = context();
  const name = ctx?.name1 || '我';
  const pu = ctx?.powerUserSettings ?? {};
  return {
    name,
    avatar: avatarUrl(name),
    description: String(pu.persona_description ?? '').trim(),
    isCustomAvatar: !!settings?.avatars?.[name]?.dataUrl,
  };
}

/** 这个人的头像是自定义的还是酒馆默认的 */
const isCustomAvatar = (name) => !!settings?.avatars?.[String(name ?? '').trim()]?.dataUrl;

function publicSettings() {
  return {
    mode: settings.chat.mode,
    budget: settings.chat.budget,
    proactive: settings.chat.proactive,
    moments: settings.moments,
    model: publicLlm(),
    voice: publicVoice(),
    theme: settings.ui.theme,
  };
}

/** 语音设置里能公开给 iframe 的部分（不含 key） */
function publicVoice() {
  const v = settings.voice ?? {};
  return {
    enabled: !!v.enabled,
    activeEngine: v.activeEngine ?? 'openai',
    language: v.language ?? '',
    cacheLimitMB: v.cacheLimitMB ?? 200,
    prefetch: v.prefetch !== false,
    autoPrepare: !!v.autoPrepare,
    speed: Number(v.speed) || 1,
    previewText: v.previewText ?? '',
    autoNarrate: !!v.autoNarrate,
    voices: v.voices ?? {},
  };
}

/** 当前生效的模型配置表：用户改过的覆盖内置默认 */
function llmProfiles() {
  const saved = settings.llm?.profiles ?? {};
  const table = {};
  for (const b of BUILTIN_PROFILES) {
    table[b.id] = createProfile({ ...b, ...(saved[b.id] ?? {}) });
  }
  for (const [id, cfg] of Object.entries(saved)) {
    if (!table[id]) table[id] = createProfile({ ...cfg, id });
  }
  return table;
}

/** 给 iframe 看的模型状态（不含 key） */
function publicLlm() {
  const l = settings.llm ?? {};
  const active = llmProfiles()[l.activeId] ?? null;
  return {
    activeId: l.activeId ?? '',
    name: active?.name ?? '',
    base: active?.base ?? '',
    model: active?.model ?? '',
    hasKey: !!active?.key,
    ready: !!(active?.base && active?.model),
  };
}

/* ------------------------------------------------------- 6. 桥 */

/**
 * 同源直调桥。
 * 不做 postMessage —— 单人项目里那套样板代码不值当。
 * 但保留来源校验：页面上任何一个 iframe 都不该能冒充手机。
 */
function createBridge() {
  const guard = (source) => {
    if (!active) throw new Error('扩展没有启用');
    if (source && iframe?.contentWindow && source !== iframe.contentWindow) {
      throw new Error('来源不匹配');
    }
  };

  const api = {
    version: '0.1.0',

    /* --- 初始化 --- */
    init: (source) => { guard(source); return spaceInfo(); },

    /* --- 设置 --- */
    getSettings: (source) => { guard(source); return publicSettings(); },

    saveChat: (source, patch) => {
      guard(source);
      Object.assign(settings.chat, patch ?? {});
      saveSettings();
      return publicSettings();
    },
    saveMoments: (source, patch) => {
      guard(source);
      Object.assign(settings.moments, patch ?? {});
      saveSettings();
      return publicSettings();
    },
    saveUi: (source, patch) => {
      guard(source);
      Object.assign(settings.ui, patch ?? {});
      saveSettings();
      return true;
    },

    /* --- 头像 --- */
    /** 主角（user persona）的名字、头像、描述 */
    persona: (source) => { guard(source); return personaInfo(); },

    /**
     * 换头像。dataUrl 是压缩过的（前端用 canvas 缩到 160×160 再传）。
     * 不收原始大图：base64 进 settings 会让酒馆的 settings.json 膨胀。
     */
    avatarSet: (source, name, dataUrl) => {
      guard(source);
      const n = String(name ?? '').trim();
      if (!n) throw new Error('缺名字');
      if (typeof dataUrl !== 'string' || !/^data:image\//i.test(dataUrl)) throw new Error('头像数据无效');
      if (dataUrl.length > 200 * 1024) throw new Error('头像太大了（超过 200KB），换一张小一点的');

      settings.avatars = { ...(settings.avatars ?? {}), [n]: { dataUrl, at: Date.now() } };
      saveSettings();
      bridge?.post('space', spaceInfo());
      return { name: n, avatar: avatarUrl(n), isCustom: true };
    },

    /** 恢复成酒馆里的默认封面 */
    avatarClear: (source, name) => {
      guard(source);
      const n = String(name ?? '').trim();
      const next = { ...(settings.avatars ?? {}) };
      delete next[n];
      settings.avatars = next;
      saveSettings();
      bridge?.post('space', spaceInfo());
      return { name: n, avatar: avatarUrl(n), isCustom: false };
    },

    /** 哪些人用着自定义头像（设置页显示"恢复默认"用） */
    avatarCustom: (source) => {
      guard(source);
      return Object.keys(settings.avatars ?? {});
    },

    /* --- 聊天 --- */
    /** 当前这张卡里可以聊天的人（消息 App 的「联系人」页用它） */
    contacts: (source) => {
      guard(source);
      refreshRoster();
      const space = currentSpace();
      return {
        spaceName: space.name,
        hasSpace: space.key !== 'global',
        list: (roster?.list ?? []).map(c => ({
          name: c.name,
          source: c.source ?? '',
          avatar: avatarUrl(c.name),
          hasVoice: !!settings.voice?.voices?.[c.name]?.voice,
        })),
      };
    },

    /** 会话列表，每条带上对方头像 */
    threads: (source) => {
      guard(source);
      return chatSvc.listThreads().then(list => list.map(t => ({
        ...t,
        avatar: avatarUrl(t.partner || t.name),
      })));
    },
    thread: (source, id) => { guard(source); return store.threads.get(id); },
    markRead: (source, id) => { guard(source); return store.threads.markRead(id); },
    unread: (source) => { guard(source); return chatSvc.unreadCount(); },

    send: async (source, threadId, text) => {
      guard(source);
      rebuildClient();
      if (!client?.config?.url) throw new Error('还没配置模型接口（设置 → 模型）');
      return chatSvc.send(threadId, text);
    },

    ensureThread: (source, opts) => { guard(source); return chatSvc.ensureThread(opts); },

    /** 把手机聊天带进下一次正文（注入一次，之后清空） */
    bringToStory: async (source, threadId) => {
      guard(source);
      const packed = await chatSvc.packForStory(threadId);
      if (!packed) throw new Error('这个会话还是空的');
      pendingPhone = packed;
      inject();
      return { ok: true, count: packed.count };
    },

    /** 上下文预览：用户能看到这次请求会发多少字 */
    preview: (source, threadId) => { guard(source); return chatSvc.preview(threadId); },

    /* --- 朋友圈 --- */
    moments: (source) => { guard(source); return momentsSvc.list(); },
    momentsUnread: (source) => { guard(source); return momentsSvc.unreadCount(); },
    momentsRead: (source) => { guard(source); return momentsSvc.markAllRead(); },

    composeMoment: async (source, author) => {
      guard(source);
      rebuildClient();
      if (!client?.config?.url) throw new Error('还没配置模型接口');
      return momentsSvc.compose({ author });
    },
    reactMoment: async (source, id, author) => {
      guard(source);
      rebuildClient();
      if (!client?.config?.url) throw new Error('还没配置模型接口');
      return momentsSvc.react(id, { author });
    },
    likeMoment: (source, id) => { guard(source); return momentsSvc.toggleLike(id); },
    commentMoment: (source, id, text) => { guard(source); return momentsSvc.addComment(id, text); },
    removeMoment: (source, id) => { guard(source); return momentsSvc.remove(id); },

    /* --- 模型配置（聊天用）--- */
    llmGet: (source) => {
      guard(source);
      return {
        ...publicLlm(),
        profiles: Object.values(llmProfiles()),
        builtins: BUILTIN_PROFILES.map(b => ({ id: b.id, name: b.name, note: b.note ?? '' })),
      };
    },

    llmSetActive: (source, id) => {
      guard(source);
      if (!llmProfiles()[id]) throw new Error('没有这个配置');
      settings.llm = { ...(settings.llm ?? {}), activeId: id };
      saveSettings();
      rebuildClient();
      return publicLlm();
    },

    llmSaveProfile: (source, id, cfg) => {
      guard(source);
      if (!id) throw new Error('缺配置 id');
      const current = llmProfiles()[id] ?? createProfile({ id });
      const next = createProfile({ ...current, ...cfg, id });
      settings.llm = {
        ...(settings.llm ?? {}),
        profiles: { ...(settings.llm?.profiles ?? {}), [id]: next },
      };
      saveSettings();
      rebuildClient();
      return llmProfiles()[id];
    },

    llmTemplate: (source, id) => {
      guard(source);
      const t = profileTemplate(id);
      if (!t) throw new Error(`没有这个模板：${id}`);
      return t;
    },

    llmCreate: (source, name) => {
      guard(source);
      const id = `custom_${Date.now().toString(36)}`;
      settings.llm = {
        ...(settings.llm ?? {}),
        profiles: {
          ...(settings.llm?.profiles ?? {}),
          [id]: createProfile({ id, name: name || '自定义配置', base: '', model: '' }),
        },
      };
      saveSettings();
      return llmProfiles()[id];
    },

    llmDelete: (source, id) => {
      guard(source);
      if (BUILTIN_PROFILES.some(b => b.id === id)) {
        // 内置的不能删，只能恢复默认
        const next = { ...(settings.llm?.profiles ?? {}) };
        delete next[id];
        settings.llm = { ...(settings.llm ?? {}), profiles: next };
      } else {
        const next = { ...(settings.llm?.profiles ?? {}) };
        delete next[id];
        settings.llm = { ...(settings.llm ?? {}), profiles: next };
        if (settings.llm.activeId === id) settings.llm.activeId = 'openai';
      }
      saveSettings();
      rebuildClient();
      return llmProfiles()[id] ?? true;
    },

    /** 测试某个配置通不通（用极短的一句话，成本可忽略） */
    llmTest: async (source, id) => {
      guard(source);
      const profile = llmProfiles()[id ?? settings.llm?.activeId];
      if (!profile) return { ok: false, error: '没有这个配置' };

      const problems = validateProfile(profile);
      if (problems.length) return { ok: false, error: problems.join('；') };

      const started = Date.now();
      try {
        const c = createClient(profile);
        const reply = await c.ping();
        return { ok: true, ms: Date.now() - started, reply: String(reply).slice(0, 40), describe: c.describe() };
      } catch (e) {
        return { ok: false, ms: Date.now() - started, error: e?.message ?? String(e) };
      }
    },

    /** 这份配置最后会打成什么样的请求（调试用） */
    llmDescribe: (source, id) => {
      guard(source);
      const profile = llmProfiles()[id ?? settings.llm?.activeId];
      if (!profile) throw new Error('没有这个配置');
      return createClient(profile).describe();
    },

    /* --- 语音 --- */
    voiceGet: (source) => {
      guard(source);
      // 实时重算：用户可能刚打开一张卡，缓存的 roster 是 enable 时的旧数据
      refreshRoster();
      const space = currentSpace();
      return {
        ...publicVoice(),
        engines: Object.values(tts.engines()),
        builtins: BUILTIN_ENGINES.map(b => ({ id: b.id, name: b.name, note: b.note ?? '' })),
        // 只给"当前这张卡里的人"——不是酒馆所有角色卡
        contacts: (roster?.list ?? []).map(c => ({
          name: c.name,
          source: c.source ?? '',
          avatar: avatarUrl(c.name),
        })),
        spaceName: space.name,
        spaceType: space.type,
        hasSpace: space.key !== 'global',   // false = 现在没打开角色卡
      };
    },

    voiceSave: (source, patch) => {
      guard(source);
      Object.assign(settings.voice, patch ?? {});
      saveSettings();
      return publicVoice();
    },

    /** 存某个引擎的配置（用户改过的字段会覆盖内置默认） */
    voiceEngineSave: (source, id, cfg) => {
      guard(source);
      if (!id) throw new Error('缺引擎 id');
      settings.voice.engines = {
        ...(settings.voice.engines ?? {}),
        [id]: createEngine({ ...(settings.voice.engines?.[id] ?? {}), ...cfg, id }),
      };
      saveSettings();
      return tts.engines()[id];
    },

    /** 拿一份内置模板，用来"恢复默认"或者"复制一份改" */
    voiceTemplate: (source, id) => {
      guard(source);
      const t = templateOf(id);
      if (!t) throw new Error(`没有这个模板：${id}`);
      return t;
    },

    /** 新建一个自定义引擎（从空白开始） */
    voiceEngineCreate: (source, name) => {
      guard(source);
      const id = `custom_${Date.now().toString(36)}`;
      settings.voice.engines = {
        ...(settings.voice.engines ?? {}),
        [id]: createEngine({
          id, name: name || '自定义引擎',
          endpoint: '{{base}}/v1/audio/speech',
          headers: { Authorization: 'Bearer {{key}}', 'Content-Type': 'application/json' },
          body: { model: '{{model}}', input: '{{text}}', voice: '{{voice}}' },
          response: 'audio',
        }),
      };
      saveSettings();
      return tts.engines()[id];
    },

    voiceEngineDelete: (source, id) => {
      guard(source);
      if (BUILTIN_ENGINES.some(b => b.id === id)) {
        // 内置的不能删，但可以"恢复默认"
        delete settings.voice.engines?.[id];
        saveSettings();
        return tts.engines()[id];
      }
      const next = { ...(settings.voice.engines ?? {}) };
      delete next[id];
      settings.voice.engines = next;
      if (settings.voice.activeEngine === id) settings.voice.activeEngine = 'openai';
      saveSettings();
      return true;
    },

    voiceTest: (source, id) => { guard(source); return tts.test(id); },

    /** 给角色配声 */
    voiceBind: (source, role, binding) => {
      guard(source);
      const name = String(role ?? '').trim();
      if (!name) throw new Error('缺角色名');
      settings.voice.voices = { ...(settings.voice.voices ?? {}) };
      if (binding) settings.voice.voices[name] = { ...binding };
      else delete settings.voice.voices[name];
      saveSettings();
      return settings.voice.voices;
    },

    /** 念一句（聊天里的消息也走这个） */
    voiceSpeak: async (source, line) => {
      guard(source);
      if (!tts) throw new Error('语音没有启用');
      const ready = tts.readyFor(line);
      if (!ready.ok) throw new Error(ready.why);
      return tts.speak(line);
    },

    voiceSpeakAll: async (source, lines) => {
      guard(source);
      if (!tts) throw new Error('语音没有启用');
      return tts.speakAll(lines ?? []);
    },

    voicePrefetch: async (source, lines) => {
      guard(source);
      if (!tts) return [];
      return tts.prefetch(lines ?? []);
    },

    voiceStop: (source) => { guard(source); tts?.stop(); return true; },

    /**
     * 试听：用这个角色的音色念一句。
     * 引擎级的 voiceTest 只测"连得通吗"，这个是"听着像不像他"。
     */
    voicePreview: async (source, role) => {
      guard(source);
      const name = String(role ?? '').trim() || context()?.name2 || '旁白';
      const text = String(settings.voice?.previewText ?? '').trim()
        || `你好，我是${name}。能听见我说话吗？`;
      tts?.stop();
      await tts.speak({
        role: name,
        emotion: '',
        text,
        translation: text,
        speed: settings.voice?.speed ?? 1,
      });
      return true;
    },

    /** 列出这个角色能用什么音色（给试听下拉用） */
    voiceStatus: (source, role) => {
      guard(source);
      const name = String(role ?? '').trim();
      const line = { role: name, text: '', emotion: '' };
      const ready = tts.readyFor(line);
      const bound = settings.voice?.voices?.[name] ?? null;
      return {
        ready: ready.ok,
        why: ready.why ?? '',
        bound: bound ? { engine: bound.engine ?? '', voice: bound.voice ?? '' } : null,
        activeEngine: settings.voice?.activeEngine ?? '',
      };
    },
    voiceLevel: (source) => { guard(source); return tts?.level() ?? 0; },
    voiceStats: (source) => { guard(source); return tts.stats(); },
    voiceClearCache: (source) => { guard(source); return tts.clearCache(); },

    /** 这个角色配好音色没有 */
    voiceReady: (source, line) => {
      guard(source);
      return tts?.readyFor(line) ?? { ok: false, why: '语音没有启用' };
    },

    /* --- 诊断 --- */
    diagnose: (source, messageId) => {
      guard(source);
      const m = context()?.chat?.[messageId];
      if (!m) return { problems: ['找不到这条消息'] };
      return { problems: diagnose(m.mes, settings.protocol), lines: parseLines(m.mes, settings.protocol).length };
    },

    close: (source) => { guard(source); closePanel(); return true; },
  };

  /**
   * 绑定来源：iframe 里调一次 api.bind(window)，之后所有方法都不用再传 window。
   * 不这么做的话，每个调用点都要写 api.threads(window) —— 又长又容易漏。
   */
  api.bind = (source) => {
    const bound = {};
    for (const [name, fn] of Object.entries(api)) {
      if (typeof fn !== 'function' || name === 'bind') continue;
      bound[name] = (...args) => fn(source, ...args);
    }
    return bound;
  };

  return {
    api,
    /** 主页面 → iframe 的单向推送 */
    post(type, payload) {
      try {
        const target = iframe?.contentWindow;
        if (!target) { console.debug('[mini-phone] 推送跳过（没有 iframe）：', type); return; }
        if (typeof target.__miniPhoneReceive !== 'function') {
          console.debug('[mini-phone] 推送跳过（界面还没接上）：', type);
          return;
        }
        target.__miniPhoneReceive(type, payload);
      } catch (e) {
        console.warn('[mini-phone] 推送失败：', type, e?.message);
      }
    },
  };
}

/**
 * 调试口：控制台里 `__miniPhoneDebug()` 能一眼看到当前状态。
 * 排查"为什么界面没更新"这类问题时很有用。
 */
function installDebug() {
  globalThis.__miniPhoneDebug = () => {
    const space = currentSpace();
    return {
      active,
      version: VERSION,
      space: { key: space.key, name: space.name, members: space.members },
      roster: (roster?.list ?? []).map(c => `${c.name}(${c.source ?? '?'})`),
      seenRoles: (settings?.seenRoles ?? []).map(r => `${r.name}@${(r.cards ?? []).join(',')}`),
      panel: { exists: !!panel, connected: !!panel?.isConnected, hidden: panel?.classList.contains('mp-hidden') },
      bridge: !!bridge,
      iframeReady: !!iframe?.contentWindow?.__miniPhoneReady,
      hasReceiver: typeof iframe?.contentWindow?.__miniPhoneReceive === 'function',
      voiceVoices: Object.keys(settings?.voice?.voices ?? {}),
    };
  };
}

/* --------------------------------------------------- 7. 模型客户端 */

function rebuildClient() {
  const active = llmProfiles()[settings.llm?.activeId] ?? null;
  client = active ? createClient(active) : createClient({});
}

/* ------------------------------------------------------------ 工具 */

function notify(text) {
  if (globalThis.toastr?.info) globalThis.toastr.info(text, '小手机');
  else console.info('[mini-phone]', text);
}

/* ------------------------------------------------------- 8. 生命周期 */

export async function enable() {
  if (active) return;
  const ctx = context();

  if (!ctx?.extensionSettings || !ctx?.saveSettingsDebounced) {
    console.warn('[mini-phone] 酒馆上下文不完整，跳过启用');
    return;
  }
  if (!ctx.setExtensionPrompt || !ctx.eventSource) {
    notify('酒馆版本太旧，缺 setExtensionPrompt / eventSource');
    return;
  }

  settings = normalizeSettings(ctx.extensionSettings[NS]);
  ctx.extensionSettings[NS] = structuredClone(settings);

  // 迁移旧格式串
  if (typeof settings.protocol === 'string') {
    settings.protocol = protocolFromTemplate(settings.protocol);
  }

  roster = buildRoster();
  rebuildClient();

  store = createStore({ scope: () => currentSpace().key });

  const serviceDeps = {
    store,
    client: () => client,          // 传函数：设置里改了接口不用重建服务
    getCard: currentCard,
    getStory: () => context()?.chat ?? [],
    getLore: (scanText) => {
      try {
        const wi = context()?.getWorldInfoPrompt?.(scanText, settings.chat.budget.loreCount, true, false);
        return wi?.string ?? '';
      } catch { return ''; }
    },
    getRoster: () => roster,
    settings: () => ({
      user: context()?.name1 || '我',
      userPersona: String(context()?.powerUserSettings?.persona_description ?? '').slice(0, 1500),
      mode: settings.chat.mode,
      budget: settings.chat.budget,
      protocol: settings.protocol,
    }),
    emit: (type, payload) => bridge?.post(type, payload),
  };

  chatSvc = createChatService(serviceDeps);
  momentsSvc = createMomentsService(serviceDeps);

  // 语音：独立于模型客户端，自己一套引擎配置
  tts = createTTS({
    getSettings: () => settings.voice,
    emit: (type, payload) => bridge?.post(`voice:${type}`, payload),
  });

  mountEntry();
  bindEvents();
  bindRender();
  installDebug();
  inject();

  active = true;

  // 刷新页面后不换卡也要有数据：扫一遍现有历史，把说过话的人登记上
  try {
    tagRoles(currentSpace().members);
    scanSpeakers((context()?.chat ?? []).slice(-200));
    refreshRoster();
  } catch (e) { console.warn('[mini-phone] 初始扫历史失败：', e?.message); }

  console.info('[mini-phone] enabled');
}

export async function disable() {
  if (!active) return;
  active = false;

  for (const [es, evt, fn] of listeners) { try { es.removeListener(evt, fn); } catch {} }
  listeners.length = 0;

  document.removeEventListener('click', onClickWave, true);

  // 老版酒馆：把被包装的渲染函数还回去
  if (legacyFormatting) {
    try { const c = context(); if (c) c.messageFormatting = legacyFormatting; } catch { /* 忽略 */ }
    legacyFormatting = null;
  }

  tts?.stop();
  tts = null;
  renderTokens.clear();
  clearStage();

  clearInject();
  unmountEntry();
  closePanel();
  panel?.remove();
  panel = null;
  iframe = null;
  delete globalThis.__miniPhone;
  bridge = null;

  chatSvc = null;
  momentsSvc = null;
  store = null;
  roster = null;
  client = null;
  settings = null;
  pendingPhone = null;

  console.info('[mini-phone] disabled');
}

export function dispose() {
  return disable();
}
