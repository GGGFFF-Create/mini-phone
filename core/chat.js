/**
 * 聊天业务层。
 *
 * 【边界】
 * 这个文件不碰 DOM，不碰 SillyTavern。它需要的一切通过参数注入，
 * 所以可以用 node 直接测（见 tests/chat.test.mjs）。
 *
 * 【一次回复的完整链路】
 *   玩家发消息
 *   → 存进本地（立刻可见，不等模型）
 *   → 组装上下文（漏斗取文 + 预算）
 *   → 调模型
 *   → 清理（剥标签、去前缀、去空行）
 *   → 解析成消息项（含 [图片]/[转账] 等）
 *   → 去重后落库
 *   → 报告"收到了什么"
 */

import { parseLines as parsePhoneItems } from './phone.js';
import { normalizeItems } from './routes.js';
import { buildChatContext, storyFunnel } from './llm.js';
import { plainLines } from './protocol.js';

/** 模型爱加的装饰：名字前缀、引号、markdown 加粗 */
const PREFIX = /^\s*(?:\*\*)?[\[【]?[^[\]【】:：\n]{1,20}?[\]】]?(?:\*\*)?\s*[:：]\s*/;
const WRAP = /^[「“"『]([\s\S]*)[」”"』]$/;

/**
 * 清理一条回复。
 * 顺序有讲究：先剥标签（不然标签里的冒号会干扰前缀识别），再剥前缀。
 */
export function cleanReply(text, { tags = ['tts', 'phone', 'img'] } = {}) {
  let s = String(text ?? '');
  for (const tag of tags) {
    s = s.replace(new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?</${tag}\\s*>`, 'gi'), '');
  }
  return s
    .split(/\r?\n/)
    .map(line => line.trim())
    .map(line => line.replace(PREFIX, ''))
    .map(line => line.replace(WRAP, '$1'))
    .filter(Boolean)
    .join('\n');
}

/**
 * 把一条清理过的回复拆成消息项。
 * 一行一条。文本里如果带 [图片]/[转账] 这类方括号，交给 phone.js 统一解析。
 *
 * 为什么复用 phone.js 的解析器：聊天和 `<phone>` 块用的是同一套语法，
 * 分开写会有两套规则，迟早不一致。
 */
export function splitReply(text, { from, roster = null, max = 3 } = {}) {
  const lines = String(text ?? '').split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  const out = [];

  for (const line of lines.slice(0, max * 2)) {
    // 有前缀时用前缀当发言人；没有就用传入的 from
    const prefixed = PREFIX.test(line) && /[:：]/.test(line);
    const candidate = prefixed ? line : `${from}：${line}`;
    const items = parsePhoneItems(candidate, { only: null });
    for (const item of items) {
      out.push({ ...item, from: item.from || from });
    }
    if (out.length >= max) break;
  }

  const trimmed = out.slice(0, max).map(item => ({ ...item, from }));
  return roster ? normalizeItems(trimmed, roster) : trimmed;
}

/* ============================================================ 服务 */

/**
 * @param {object} deps
 *   store      createStore() 的返回值
 *   client     createClient() 的返回值（可以随时换 —— 用户在设置里改配置）
 *   getCard    () => { name, description, personality }
 *   getStory   () => ctx.chat（酒馆的聊天数组）
 *   getLore    (scanText) => string
 *   getRoster  () => createRoster() 的结果
 *   settings   () => { mode, budget, user, userPersona }
 *   emit       (type, payload) => void  给 UI 的通知
 */
export function createChatService(deps) {
  const {
    store, getCard, getStory = () => [],
    getLore = () => '', getRoster = () => null,
    settings = () => ({}), emit = () => {},
  } = deps;

  // client 允许传函数 —— 用户在设置里改了接口，不需要重建整个服务
  const getClient = typeof deps.client === 'function' ? deps.client : () => deps.client;

  const busy = new Set();          // 单飞：一个会话同时只跑一次请求

  const cfg = () => ({
    mode: 'story', user: '我', userPersona: '',
    budget: {}, ...(settings() ?? {}),
  });

  /** 组装这个会话的上下文（漏斗取文在这里发生） */
  function contextFor(thread) {
    const s = cfg();
    const card = getCard?.() ?? {};
    const roster = getRoster?.();
    const story = s.mode === 'offstory' ? [] : storyFunnel(getStory(), {
      full: s.budget?.storyFull ?? 2,
      brief: s.budget?.storyBrief ?? 6,
      user: s.user,
      plain: (raw) => plainLines(raw, s.protocol),
    });
    const scanText = [story.map(l => `${l.name}：${l.text}`).join('\n')].join('\n');
    const lore = s.mode === 'offstory' ? '' : (getLore?.(scanText) ?? '');

    return buildChatContext({
      card, user: s.user, userPersona: s.userPersona,
      roster, story, lore, thread, mode: s.mode, budget: s.budget,
    });
  }

  return {
    /** 上下文预览：用户能在设置里看到"这次会发多少字"，调预算时不用猜 */
    preview(threadId) {
      return store.threads.get(threadId).then(thread => {
        if (!thread) throw new Error('这个会话不存在');
        const ctx = contextFor(thread);
        return { blocks: ctx.blocks, chars: ctx.chars };
      });
    },

    /**
     * 玩家发一条消息，拿角色回复。
     * @returns {{thread, mine, incoming}}
     */
    async send(threadId, text, { onDelta } = {}) {
      const body = String(text ?? '').trim();
      if (!body) throw new Error('消息是空的');
      if (busy.has(threadId)) throw new Error('这个会话正在回复，等一下');

      const thread = await store.threads.get(threadId);
      if (!thread) throw new Error('这个会话不存在');

      busy.add(threadId);
      try {
        // ① 自己的话先落库，界面立刻能看到
        const mine = { from: 'me', kind: 'text', text: body, at: Date.now() };
        const saved = await store.threads.append(threadId, mine, { read: true });
        emit('message', { threadId, message: saved.fresh.at(-1), mine: true });

        // ② 组上下文（用落库后的最新 thread）
        const ctx = contextFor(saved.thread);
        emit('typing', { threadId, on: true });

        // ③ 调模型
        const { text: raw } = await getClient().chat(ctx.messages, { onDelta });

        // ④ 清理 → 解析 → 归一
        const cleaned = cleanReply(raw);
        const items = splitReply(cleaned, {
          from: thread.partner || thread.name,
          roster: getRoster?.(),
          max: 3,
        });

        if (!items.length) throw new Error('这次没有收到消息，可以再试一次');

        // ⑤ 落库
        const incoming = items.map(i => ({
          from: i.from, kind: i.kind, text: i.text, meta: i.meta ?? {},
          source: 'phone', at: Date.now(),
        }));
        const after = await store.threads.append(threadId, incoming, { read: false });

        emit('typing', { threadId, on: false });
        emit('message', { threadId, messages: after.fresh, mine: false });

        return { thread: after.thread, mine: saved.fresh.at(-1), incoming: after.fresh };
      } finally {
        busy.delete(threadId);
        emit('typing', { threadId, on: false });
      }
    },

    /**
     * 正文联动：把 <phone> 里投递过来的消息存进对应会话。
     *
     * @param {{private: Item[], groups: Array<{group, items}>}} extracted
     * @param {{floor?: number, ver?: string}} origin 来源楼层（用于重抽撤回）
     */
    async receive(extracted, origin = {}) {
      const roster = getRoster?.();
      const results = [];

      // 私聊：按发言人分组，各进各的窗口
      const byPerson = new Map();
      for (const item of extracted.private ?? []) {
        const owner = roster ? roster.owner(item.from) : item.from;
        if (!owner) continue;
        if (!byPerson.has(owner)) byPerson.set(owner, []);
        byPerson.get(owner).push({ ...item, from: owner });
      }

      for (const [name, items] of byPerson) {
        const thread = await this.ensureThread({ type: 'dm', name, partner: name });
        const res = await store.threads.append(thread.id, items.map(i => ({
          from: i.from, kind: i.kind, text: i.text, meta: i.meta ?? {},
          source: 'story', floor: origin.floor ?? null, ver: origin.ver ?? '',
          at: Date.now(),
        })), { read: false });
        results.push({ threadId: thread.id, name, items: res.fresh });
        emit('message', { threadId: thread.id, messages: res.fresh, mine: false, fromStory: true });
      }

      // 群聊
      for (const g of extracted.groups ?? []) {
        const thread = await this.ensureThread({ type: 'group', name: g.group, members: [...new Set(g.items.map(i => i.from))] });
        const res = await store.threads.append(thread.id, g.items.map(i => ({
          from: i.from, kind: i.kind, text: i.text, meta: i.meta ?? {},
          source: 'story', floor: origin.floor ?? null,
          at: Date.now(),
        })), { read: false });
        results.push({ threadId: thread.id, name: g.group, items: res.fresh });
        emit('message', { threadId: thread.id, messages: res.fresh, mine: false, fromStory: true });
      }

      return results;
    },

    /** 重抽撤回：删掉某一楼某一版本投递过来的消息 */
    async withdraw(floor, keepVer) {
      const all = await store.threads.list();
      let gone = 0;
      for (const t of all) {
        gone += await store.threads.withdraw(t.id, m =>
          m.floor === floor && m.source === 'story' && m.ver !== keepVer);
      }
      return gone;
    },

    /** 拿会话，没有就建一个。dm 的 partner 就是对方名字。 */
    async ensureThread({ type = 'dm', name, partner = '', members = [] }) {
      const list = await store.threads.list();
      const hit = list.find(t => t.type === type && t.name === name);
      if (hit) return hit;
      return store.threads.create({ type, name, partner: partner || name, members });
    },

    /** 主动发消息：回合到了但正文没写 <phone> 时用 */
    async nudge(threadId) {
      const thread = await store.threads.get(threadId);
      if (!thread) throw new Error('这个会话不存在');

      const ctx = contextFor(thread);
      // 把"轮到回复"换成"要不要主动说点什么"
      ctx.messages[1] = {
        role: 'user',
        content: [
          ctx.messages[1]?.content?.split('轮到')[0] ?? '',
          '现在没人说话。要不要主动发一条？',
          '想发就直接写（一到两条）；不想发就只写「不发」。',
        ].filter(Boolean).join('\n'),
      };

      const { text: raw } = await getClient().chat(ctx.messages, {});
      if (/^不(发|想)/.test(raw.trim())) return { skipped: true };

      const items = splitReply(cleanReply(raw), {
        from: thread.partner || thread.name, roster: getRoster?.(), max: 2,
      });
      if (!items.length) return { skipped: true };

      const res = await store.threads.append(threadId, items.map(i => ({
        from: i.from, kind: i.kind, text: i.text, meta: i.meta ?? {},
        source: 'nudge', at: Date.now(),
      })), { read: false });
      emit('message', { threadId, messages: res.fresh, mine: false, nudge: true });
      return { thread: res.thread, messages: res.fresh };
    },

    /** 手机里所有会话，按最后更新排序 */
    listThreads: () => store.threads.list(),

    /** 总未读 */
    async unreadCount() {
      const list = await store.threads.list();
      return list.reduce((n, t) => n + (t.unread ?? 0), 0);
    },

    /** 把这个会话带进正文（注入一次，注入后清空） */
    async packForStory(threadId, { limit = 20 } = {}) {
      const thread = await store.threads.get(threadId);
      if (!thread) return null;
      const msgs = thread.messages.slice(-limit);
      if (!msgs.length) return null;
      const text = [
        `【和${thread.name}的手机聊天】`,
        ...msgs.map(m => `${m.from === 'me' ? cfg().user : m.from}：${m.text ?? ''}`),
      ].join('\n');
      return { threadId, name: thread.name, text, count: msgs.length };
    },
  };
}
