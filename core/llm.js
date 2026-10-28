/**
 * 模型调用 + 上下文组装。
 *
 * 【为什么独立 API 而不是复用酒馆连接】
 * 用 generateRaw 时，酒馆会把它的预设（常含"必须细腻描写""要有心理活动""延续写作风格"）
 * 一起拼进 prompt。手机聊天会变得像写小说。用独立通道，prompt 一个字都不多。
 *
 * 【上下文组装的原创点：按块组装 + 预算统计】
 * 上一代是一整段模板字符串，塞完就完，不知道每块占多少。
 * 这里每块独立、各自有预算，组装后返回每块的字数 —— 调 token 消耗时不用靠猜。
 */

/* ============================================================ 客户端 */

/**
 * 把各种中转/官方的差异收在一处。
 * 支持：OpenAI 兼容（chat/completions）、流式 SSE、429 退避。
 */
export function createClient(config = {}) {
  const {
    url = '',
    key = '',
    model = '',
    temperature = 0.75,
    maxTokens = 400,
    timeout = 60_000,
    retries = 1,
  } = config;

  const endpoint = normalizeEndpoint(url);

  async function once(messages, { stream = false, signal, onDelta, extra = {} } = {}) {
    if (!endpoint) throw new Error('还没有配置接口地址');
    if (!model) throw new Error('还没有配置模型名');

    const body = {
      model,
      messages,
      temperature,
      max_tokens: maxTokens,
      ...(stream ? { stream: true } : {}),
      ...extra,
    };

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(new Error('请求超时')), timeout);
    const onAbort = () => ctrl.abort(new Error('已取消'));
    signal?.addEventListener('abort', onAbort, { once: true });

    try {
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(key ? { Authorization: `Bearer ${key}` } : {}),
        },
        body: JSON.stringify(body),
        signal: ctrl.signal,
      });

      if (!res.ok) {
        const detail = await res.text().catch(() => '');
        const err = new Error(`接口返回 ${res.status}${detail ? '：' + detail.slice(0, 200) : ''}`);
        err.status = res.status;
        throw err;
      }

      if (!stream) {
        const data = await res.json();
        return {
          text: data?.choices?.[0]?.message?.content ?? '',
          usage: data?.usage ?? null,
        };
      }

      return await readStream(res, onDelta);
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    }
  }

  return {
    config,

    /**
     * 一次对话。失败会退避重试一次（只对 429 / 5xx）。
     * @returns {{text: string, usage: object|null}}
     */
    async chat(messages, opts = {}) {
      let lastError;
      for (let attempt = 0; attempt <= retries; attempt++) {
        try {
          return await once(messages, opts);
        } catch (e) {
          lastError = e;
          const retryable = e.status === 429 || (e.status >= 500 && e.status < 600);
          if (!retryable || attempt === retries || opts.signal?.aborted) break;
          await sleep(800 * (attempt + 1));
        }
      }
      throw lastError;
    },

    /** 简单的连通性测试 */
    async ping() {
      const { text } = await this.chat([{ role: 'user', content: '回一个字：好' }], {});
      return text.trim();
    },
  };
}

function normalizeEndpoint(url) {
  const u = String(url ?? '').trim().replace(/\/+$/, '');
  if (!u) return '';
  if (/\/chat\/completions$/.test(u)) return u;
  if (/\/v\d+$/.test(u)) return u + '/chat/completions';
  return u + '/v1/chat/completions';
}

async function readStream(res, onDelta) {
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let text = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('data:')) continue;
      const payload = trimmed.slice(5).trim();
      if (payload === '[DONE]') continue;
      try {
        const json = JSON.parse(payload);
        const delta = json?.choices?.[0]?.delta?.content ?? '';
        if (delta) { text += delta; onDelta?.(delta, text); }
      } catch { /* 半截 JSON，等下一块 */ }
    }
  }

  return { text, usage: null };
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/* ====================================================== 取文（漏斗） */

const clip = (s, n) => {
  const text = String(s ?? '');
  if (text.length <= n) return text;
  const cut = text.slice(0, n);
  const stop = Math.max(...['。', '！', '？', '…', '\n'].map(c => cut.lastIndexOf(c)));
  return (stop > n * 0.5 ? cut.slice(0, stop + 1) : cut) + '……';
};

const head = (s, n) => {
  const text = String(s ?? '').trim();
  if (text.length <= n) return text;
  const first = text.split(/(?<=[。！？!?…\n])/)[0] ?? '';
  return clip(first || text, n);
};

/**
 * 漏斗式取文：近的完整，远的只留首句。
 *
 * 为什么不直接上 AI 摘要：
 *   摘要会丢掉"刚才"这个概念。用户问"刚才怎么了"，摘要里没有"刚才"，
 *   模型就答不出具体的事。留最近两条完整的原文，才有指代对象。
 *
 * @param {Array} chat       酒馆的 ctx.chat
 * @param {{ full, brief, eachFull, eachBrief, user, plain }} opts
 */
export function storyFunnel(chat, {
  full = 2, brief = 6, eachFull = 400, eachBrief = 80, user = '我',
  plain = (s) => s,
} = {}) {
  const pool = (chat ?? []).filter(m => m && !m.is_system && String(m?.mes ?? '').trim());
  if (!pool.length) return [];

  const who = m => m.name || (m.is_user ? user : '旁白');
  const body = m => plain(String(m.mes));

  const recent = pool.slice(-full).map(m => ({ name: who(m), text: clip(body(m), eachFull) }));
  const older = pool.slice(-(full + brief), -full)
    .map(m => ({ name: who(m), text: head(body(m), eachBrief) }))
    .filter(x => x.text);

  return [...older, ...recent];
}

/** 把漏斗结果拼成一段文本 */
export const storyText = (lines) => lines.map(l => `${l.name}：${l.text}`).join('\n');

/* ================================================= 上下文组装 */

/**
 * 组装一次手机聊天请求。
 *
 * 【为什么只有两条消息】
 * system 说清所有背景和规则，user 给"现在轮到谁回"。
 * 中间不插东西 —— 插进去的内容容易被当成"刚刚发生的事"。
 *
 * 【块的顺序有讲究】
 * 越靠后权重越高。所以"最近的剧情"放在角色设定之后、"知情范围"之前，
 * 让模型先理解这个人是谁，再看到剧情到哪了，最后被规则约束。
 *
 * @returns {{messages, blocks, chars}}
 */
export function buildChatContext({
  card = {}, user = '我', userPersona = '', roster = null,
  story = [], lore = '', thread = null, mode = 'story',
  budget = {},
}) {
  const {
    cardText = 1200, personaText = 500, storyFull = 2, storyBrief = 6,
    history = 20, loreCount = 3,
  } = budget;

  const partner = card.name || '对方';
  const isGroup = thread?.type === 'group';
  const members = isGroup ? (thread?.members ?? []) : [partner];

  const blocks = [];
  const push = (name, text, note) => {
    const t = String(text ?? '').trim();
    if (t) blocks.push({ name, text: t, chars: t.length, note });
  };

  /* --- 身份 --- */
  push('role', `你在扮演「${partner}」，正在用手机和「${user}」聊天。`);

  /* --- 输出要求（放最前面：行为约束优先于内容） --- */
  push('format', [
    '【输出要求】',
    '- 只输出这个角色发来的聊天消息本身：口语、短句，可以有语气词和表情。',
    '- 不要旁白、不要动作描写、不要引号、不要加角色名前缀。',
    '- 一次一到三条，每条单独一行。',
    '- 不要使用正文里的 <tts> 标签。',
  ].join('\n'));

  /* --- 设定 vs 剧情（这是防偏移最有效的一句） --- */
  push('precedence', [
    '【设定与剧情的优先级】',
    '角色卡的设定只描述这个人是谁、世界观是什么，不代表现在的剧情进度。',
    '现在进展到哪一步，以「最近的剧情」为准。两者冲突时，一律以剧情为准。',
  ].join('\n'));

  /* --- 角色本身 --- */
  const persona = [card.description, card.personality && `性格：${card.personality}`]
    .filter(Boolean).join('\n');
  push('card', clip(persona, cardText), `截断至 ${cardText} 字`);

  if (isGroup) {
    push('members', members.map(n => `- ${n}：${roster?.get(n)?.persona || '（按剧情里的表现来）'}`).join('\n'));
  }
  push('userPersona', clip(userPersona, personaText));

  /* --- 剧情（三层预算） --- */
  if (mode !== 'offstory' && story.length) {
    push('story', `【最近的剧情】\n${storyText(story)}`, `${story.length} 条`);
  }
  push('lore', lore ? `【相关设定】\n${clip(lore, 1200)}` : '', `${loreCount} 条上限`);

  /* --- 知情范围（只在有剧情时加） --- */
  if (mode !== 'offstory' && story.length) {
    push('knows', knowsRule({ user, who: isGroup ? '群里每个人' : partner, isGroup }));
  }

  /* --- 能发什么 --- */
  push('tools', [
    '【你能发的】',
    '文字。也可以发 [表情包]、[图片] 附图描述、[语音条]。',
  ].join('\n'));

  /* --- 这次要回什么 --- */
  const msgs = (thread?.messages ?? []).slice(-history);
  const transcript = msgs.length
    ? `【和${partner}的聊天记录】\n` + msgs.map(m =>
        `${m.from === 'me' ? user : m.from}：${m.text ?? ''}`).join('\n')
    : '';

  const tail = [
    transcript,
    `轮到「${partner}」回复。`,
  ].filter(Boolean).join('\n\n');

  const messages = [
    { role: 'system', content: blocks.map(b => b.text).join('\n\n') },
    { role: 'user', content: tail },
  ];

  return {
    messages,
    blocks,
    chars: blocks.reduce((n, b) => n + b.chars, 0) + tail.length,
  };
}

/**
 * 知情范围规则。
 * 四句话各堵一种越界，第二条是精髓 —— 不加它，模型不会直说"我知道"，
 * 而是绕个弯问"你今天去哪儿了"，用提问把知道的事讲出来。
 */
export function knowsRule({ user = '我', who = '他', isGroup = false } = {}) {
  return [
    `【${who}知道什么】`,
    `- ${who}只知道自己在场亲眼看到、亲耳听到的事，${user}或别人告诉过${who}的事，还有在手机上和${user}聊过的事。`,
    `- 剧情里${user}不在场时发生的事，${who}不知道：不能提起这些细节，也不能「碰巧」猜中；想知道可以问${user}。`,
    `- ${user}心里想的、没说出口的话，旁白交代的秘密和真相，就算在场也不知道。`,
    `- 自己在场经历的事自然记得，可以聊起来。剧情里看不出${who}在不在场的，就当不知道。`,
    isGroup ? '- 群里的消息大家都看得到：各人知道的不一样，私事一般不在群里说。' : '',
  ].filter(Boolean).join('\n');
}

/* ============================================ 朋友圈的上下文 */

/**
 * 朋友圈生成：让角色看完剧情，决定发不发、发什么。
 *
 * 和聊天的区别：
 *   - 聊天是"回话"，朋友圈是"创作"（可以是心情、照片、牢骚）
 *   - 要给它"最近的剧情"当素材，否则发的内容和剧情无关
 *   - 明确允许"不发"（给出口，否则每条都硬凑）
 */
export function buildMomentsContext({
  card = {}, user = '我', story = [], roster = null, budget = {},
}) {
  const { cardText = 1200, storyFull = 3, storyBrief = 5 } = budget;
  const partner = card.name || '对方';

  const lines = [];
  lines.push(`你在扮演「${partner}」。现在是${partner}在朋友圈发动态的时刻。`);
  lines.push('');
  lines.push('【要做什么】');
  lines.push('看完下面的剧情，决定要不要发一条朋友圈。想发就写一条，不想发就只写「不发」。');
  lines.push('');
  lines.push('【怎么写】');
  lines.push('- 第一人称，像真人发朋友圈：可以是心情、吐槽、流水账、一张照片配一句话。');
  lines.push('- 长度 1-3 句，不要写成小作文，不要写旁白。');
  lines.push(`- 不要提到「${user}」看不见的事；不要在动态里解释剧情。`);
  lines.push('');
  lines.push('【这个人】');
  lines.push(clip([card.description, card.personality && `性格：${card.personality}`]
    .filter(Boolean).join('\n'), cardText));
  if (story.length) {
    lines.push('');
    lines.push('【最近的剧情】');
    lines.push(storyText(story));
  }

  return {
    messages: [
      { role: 'system', content: lines.filter(Boolean).join('\n') },
      { role: 'user', content: '现在发一条朋友圈。不想发就只写「不发」。' },
    ],
  };
}

/* ============================================ 朋友圈评论的上下文 */

/**
 * 给一条朋友圈写评论/点赞。
 * 参考实现里这是"二次生成"，可以批量做（一次请求给多条动态写评论），省额度。
 */
export function buildReactionContext({
  card = {}, user = '我', moment = null, roster = null,
}) {
  const partner = card.name || '对方';
  return {
    messages: [
      {
        role: 'system',
        content: [
          `你在扮演「${partner}」。你刚看到朋友发的朋友圈。`,
          '',
          '【要做什么】',
          '决定点不点赞、留不留言。',
          '输出格式（只输出这两行，不要别的）：',
          '点赞：是 / 否',
          '评论：（一句话，或者留空）',
          '',
          '【怎么写评论】',
          '- 口语、短，像真的在社交软件上留言。',
          '- 不想留就不留，不要硬夸。',
          '- 不要提到你不知道的事。',
        ].join('\n'),
      },
      {
        role: 'user',
        content: `朋友圈内容：\n作者：${moment?.author ?? '某人'}\n${moment?.text ?? ''}`,
      },
    ],
  };
}

/** 解析"点赞/评论"的回答 */
export function parseReaction(text) {
  const src = String(text ?? '');
  const like = /点赞\s*[:：]\s*(是|要|好|true|yes)/i.test(src);
  const m = /评论\s*[:：]\s*([\s\S]*)$/i.exec(src);
  const comment = (m?.[1] ?? '').trim().split('\n')[0].slice(0, 120);
  return { like, comment: /^(无|不要|不|none)$/i.test(comment) ? '' : comment };
}

/* ============================================ 朋友圈的解析 */

/**
 * 朋友圈回复的清理：
 *   - 模型可能写「不发」
 *   - 可能带引号、带前缀"朋友圈："
 *   - 可能写成多段
 */
export function cleanMomentReply(text) {
  let s = String(text ?? '').trim();
  if (!s) return '';
  if (/^不(发|想发|发了)/.test(s)) return '';
  s = s.replace(/^朋友圈\s*[:：]\s*/, '');
  s = s.replace(/^[「“"『]([\s\S]*)[」”"』]$/, '$1');
  s = s.split(/\n{2,}/)[0].trim();          // 只要第一段
  return s.slice(0, 300);
}
