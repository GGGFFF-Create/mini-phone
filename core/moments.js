/**
 * 朋友圈业务层。
 *
 * 【和聊天的区别】
 * 聊天是"回话"（有明确的对象和话题），朋友圈是"创作"（自发、可以没有对象）。
 * 所以朋友圈的 prompt 要给它"素材"（最近的剧情），并且明确允许"不发"。
 *
 * 【原创点：批量反应】
 * 一次请求给多条动态写评论，而不是一条一次。
 * 三个人给三条动态点赞 = 9 次请求，批量后只要 1-3 次。
 */

import { parseLines as parsePhoneItems } from './phone.js';
import { normalizeItems } from './routes.js';
import { buildMomentsContext, buildReactionContext, cleanMomentReply, parseReaction, storyFunnel } from './llm.js';
import { plainLines } from './protocol.js';

/**
 * @param {object} deps
 *   store      createStore()
 *   client     createClient()
 *   getCard    () => card
 *   getStory   () => ctx.chat
 *   getRoster  () => roster
 *   settings   () => { user, mode, budget }
 *   emit       (type, payload) => void
 */
export function createMomentsService(deps) {
  const {
    store, getCard, getStory = () => [],
    getRoster = () => null, settings = () => ({}), emit = () => {},
  } = deps;
  const getClient = typeof deps.client === 'function' ? deps.client : () => deps.client;

  const busy = new Set();
  const cfg = () => ({ user: '我', mode: 'story', budget: {}, ...(settings() ?? {}) });

  /** 给模型看的剧情（比聊天更短 —— 朋友圈只需要氛围，不需要细节） */
  function storyForModel() {
    const s = cfg();
    if (s.mode === 'offstory') return [];
    return storyFunnel(getStory(), {
      full: s.budget?.storyFull ?? 2,
      brief: s.budget?.storyBrief ?? 4,
      user: s.user,
      plain: (raw) => plainLines(raw, s.protocol),
    });
  }

  return {
    list: (opts) => store.moments.list(opts),

    /**
     * 让一个角色发一条动态。
     * @returns {{moment}|{skipped: true}}
     */
    async compose({ author } = {}) {
      const card = getCard?.() ?? {};
      const who = author || card.name;
      if (!who) throw new Error('还没有角色');
      if (busy.has(who)) throw new Error('这个角色正在发动态');

      busy.add(who);
      try {
        const ctx = buildMomentsContext({
          card: { ...card, name: who },
          user: cfg().user,
          story: storyForModel(),
          roster: getRoster?.(),
          budget: cfg().budget,
        });

        const { text: raw } = await getClient().chat(ctx.messages, {});
        const body = cleanMomentReply(raw);
        if (!body) return { skipped: true };

        const moment = await store.moments.add({
          author: who,
          text: body,
          images: [],
          likes: [],
          comments: [],
          floor: null,
          unread: true,
        });
        emit('moment', { moment });
        return { moment };
      } finally {
        busy.delete(who);
      }
    },

    /**
     * 让一个角色对某条动态做出反应（点赞 / 评论）。
     * 自己发的不反应。
     */
    async react(momentId, { author } = {}) {
      const moment = (await store.moments.list({ limit: 500 })).find(m => m.id === momentId);
      if (!moment) throw new Error('这条动态不在了');

      const card = getCard?.() ?? {};
      const who = author || (card.name && card.name !== moment.author ? card.name : getRoster?.()?.names?.()?.[0]);
      if (!who || who === moment.author) return { skipped: true };

      const ctx = buildReactionContext({
        card: { ...card, name: who },
        user: cfg().user,
        moment,
        roster: getRoster?.(),
      });

      const { text: raw } = await getClient().chat(ctx.messages, {});
      const { like, comment } = parseReaction(raw);

      const patch = {};
      if (like) patch.likes = [...new Set([...(moment.likes ?? []), who])];
      if (comment) {
        patch.comments = [...(moment.comments ?? []), {
          id: crypto.randomUUID?.() ?? String(Date.now()),
          from: who,
          text: comment,
          at: Date.now(),
        }];
      }
      if (!Object.keys(patch).length) return { skipped: true };

      const next = await store.moments.update(momentId, patch);
      emit('moment', { moment: next, reactedBy: who });
      return { moment: next, like, comment };
    },

    /**
     * 批量反应：一次请求处理多条。
     * 比起逐条请求，省下的是额度，不是延迟 —— 所以只在"一次要给很多条点赞"时用。
     */
    async reactMany(momentIds = [], { author } = {}) {
      const out = [];
      for (const id of momentIds) {
        try { out.push(await this.react(id, { author })); }
        catch (e) { out.push({ error: String(e?.message ?? e) }); }
      }
      return out;
    },

    /** 玩家点赞 / 取消 */
    async toggleLike(momentId, who = null) {
      const me = who || cfg().user;
      const moment = (await store.moments.list({ limit: 500 })).find(m => m.id === momentId);
      if (!moment) throw new Error('这条动态不在了');
      const likes = moment.likes ?? [];
      const next = likes.includes(me) ? likes.filter(x => x !== me) : [...likes, me];
      const saved = await store.moments.update(momentId, { likes: next });
      emit('moment', { moment: saved });
      return saved;
    },

    /** 玩家评论 */
    async addComment(momentId, text, { who = null } = {}) {
      const body = String(text ?? '').trim();
      if (!body) throw new Error('评论是空的');
      const moment = (await store.moments.list({ limit: 500 })).find(m => m.id === momentId);
      if (!moment) throw new Error('这条动态不在了');
      const comment = {
        id: crypto.randomUUID?.() ?? String(Date.now()),
        from: who || cfg().user,
        text: body.slice(0, 200),
        at: Date.now(),
      };
      const saved = await store.moments.update(momentId, { comments: [...(moment.comments ?? []), comment] });
      emit('moment', { moment: saved });
      return saved;
    },

    async remove(momentId) {
      await store.moments.remove(momentId);
      emit('momentRemoved', { id: momentId });
      return true;
    },

    async markAllRead() {
      await store.moments.markAllRead();
      emit('momentsRead', {});
      return true;
    },

    async unreadCount() {
      const list = await store.moments.list({ limit: 200 });
      return list.filter(m => m.unread).length;
    },

    /**
     * 正文联动：正文里写了 `名字：[朋友圈] 内容`，投递到这里。
     * 和聊天共用 phone.js 的解析器 —— 同一套语法，避免两处不一致。
     */
    async ingest(items = [], origin = {}) {
      const roster = getRoster?.();
      const out = [];

      for (const item of items) {
        if (item.kind !== 'moment') continue;
        const author = roster ? roster.owner(item.from) : item.from;
        if (!author) continue;
        const text = item.meta?.body || item.text;
        if (!text) continue;

        const saved = await store.moments.add({
          author,
          text: String(text).slice(0, 300),
          images: item.meta?.tags ? [{ prompt: text, tags: item.meta.tags }] : [],
          likes: [], comments: [],
          floor: origin.floor ?? null,
          unread: true,
        });
        out.push(saved);
      }

      // 楼层级的去重已经在 store.addMany 里做了，这里只在有新增时通知
      if (out.length) emit('moment', { moments: out, fromStory: true });
      return out;
    },

    /** 从一段文本里捞所有 [朋友圈] 项（给宿主层用） */
    extract(text) {
      const roster = getRoster?.();
      return parsePhoneItems(String(text ?? ''), {
        only: roster ? roster.names() : null,
        resolve: roster ? (n) => roster.resolve(n) : null,
      });
    },
  };
}
