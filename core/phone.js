/**
 * 手机联动协议 —— 正文里写 <phone>，手机上真的收到。
 *
 * 【设计要点】
 * 上一代用一条 200+ 字符的正则（SPECIAL）一次匹配 20 多种括号类型。能跑，
 * 但加一种类型就要动那条正则，而且改坏了很难发现。
 *
 * 这里改成"两层解析"：
 *   第一层：一行一条消息，`名字：内容`（正则只负责这个，简单且稳定）
 *   第二层：内容开头的 `[类型]` 用字典查表，查不到就当普通文字
 *
 * 加一种新类型 = 在 KINDS 里加一行。不动任何正则。
 */

import { scan } from './markup.js';

/** 一行消息：`名字：内容`（容忍 **加粗**、[[双括号]]、全角冒号） */
const LINE_RE = /^\s*(?:\*\*)?[\[【]?([^[\]【】:：\n]{1,40}?)[\]】]?(?:\*\*)?\s*[:：]\s*([\s\S]*)$/;

/**
 * 类型字典：`[类型关键词]` → 消息种类。
 * 值是 { kind, meta 解析函数 }。查表顺序无关，因为用词精确匹配。
 */
const KINDS = new Map([
  ['图片', { kind: 'photo' }],
  ['照片', { kind: 'photo' }],
  ['自拍', { kind: 'photo', meta: () => ({ selfie: true }) }],
  ['位置', { kind: 'location' }],
  ['定位', { kind: 'location' }],
  ['红包', { kind: 'money', meta: { type: 'redpacket' } }],
  ['转账', { kind: 'money', meta: { type: 'transfer' } }],
  ['礼物', { kind: 'gift' }],
  ['分享歌曲', { kind: 'song' }],
  ['分享音乐', { kind: 'song' }],
  ['歌曲', { kind: 'song' }],
  ['打电话', { kind: 'call' }],
  ['语音通话', { kind: 'call' }],
  ['来电', { kind: 'call' }],
  ['朋友圈', { kind: 'moment' }],
  ['发朋友圈', { kind: 'moment' }],
  ['表情包', { kind: 'sticker' }],
  ['表情', { kind: 'sticker' }],
]);

/** 金额：¥8.88 / 8.88元 / 8块 */
const AMOUNT_RE = /[¥￥]?\s*(\d+(?:\.\d{1,2})?)\s*[元块]?/;

/**
 * 解析一行。
 * @returns {{from,kind,text,meta,raw}|null}
 */
export function parseLine(line) {
  const m = LINE_RE.exec(String(line ?? ''));
  if (!m) return null;

  const from = m[1].trim();
  let content = m[2].trim();
  if (!from || !content) return null;

  // 第二层：开头是不是 [类型]
  // 类型名只吃汉字（最多 6 个），剩下的（比如「¥52.00」）留给 meta 解析。
  // 不能用「取到右括号为止」——那样「[转账 ¥52.00]」的类型会变成「转账 ¥52.00」，查表失败。
  const tag = /^[\[【]\s*([\u4e00-\u9fa5]{1,6})\s*([^\]】]*)[\]】]\s*([\s\S]*)$/.exec(content);
  const entry = tag ? KINDS.get(tag[1].trim()) : null;

  if (!entry) {
    return { from, kind: 'text', text: content, meta: {}, raw: line };
  }

  const extra = (tag[2] ?? '').trim();          // 括号里除类型名以外的部分（金额等）
  const rest = tag[3].trim();                   // 括号后面的正文
  const meta = typeof entry.meta === 'function'
    ? { ...entry.meta() }
    : { ...(entry.meta ?? {}) };

  switch (entry.kind) {
    case 'photo': {
      // 彩信描述：「一句话描述｜English, tags」
      const [desc, tags] = rest.split(/[｜|]/, 2);
      meta.prompt = (desc ?? '').trim();
      meta.tags = (tags ?? '').trim();
      return { from, kind: 'photo', text: meta.prompt, meta, raw: line };
    }
    case 'location':
      meta.place = rest;
      return { from, kind: 'location', text: rest, meta, raw: line };
    case 'money': {
      // 金额可能写在括号里（[转账 ¥52]），也可能写在外面（[转账] 52元）
      const amt = AMOUNT_RE.exec(extra)?.[1] ?? AMOUNT_RE.exec(rest)?.[1];
      meta.amount = amt ? Number(amt) : null;
      meta.note = rest.replace(AMOUNT_RE, '').trim();
      return { from, kind: 'money', text: meta.note || rest || extra, meta, raw: line };
    }
    case 'gift': {
      // [礼物 围巾] 天冷了
      const item = extra || rest.split(/\s+/)[0] || '';
      meta.item = item;
      meta.note = extra ? rest : rest.slice(item.length).trim();
      return { from, kind: 'gift', text: extra ? rest : rest, meta, raw: line };
    }
    case 'song': {
      const [song, said] = rest.split(/[｜|]/, 2);
      const [title, artist] = (song ?? '').split(/\s*[-–—]\s*/, 2);
      meta.title = (title ?? '').trim();
      meta.artist = (artist ?? '').trim();
      meta.said = (said ?? '').trim();
      return { from, kind: 'song', text: meta.title, meta, raw: line };
    }
    case 'call':
      meta.reason = rest;
      return { from, kind: 'call', text: rest, meta, raw: line };
    case 'moment': {
      const [body, tags] = rest.split(/[｜|]/, 2);
      meta.body = (body ?? '').trim();
      meta.tags = (tags ?? '').trim();
      return { from, kind: 'moment', text: meta.body, meta, raw: line };
    }
    case 'sticker':
      meta.name = rest;
      return { from, kind: 'sticker', text: rest, meta, raw: line };
    default:
      return { from, kind: 'text', text: rest, meta, raw: line };
  }
}

/**
 * 解析一段文本里的所有行。空行和被过滤的行丢掉。
 *
 * @param {{ only?: string[]|null, resolve?: (n: string) => string }} opts
 *        only: 白名单（正式名）；resolve: 名字归一函数
 *
 * 为什么要 resolve：正文里可能写"小柚"，白名单里是"柚子"。
 * 不先归一就过滤，别名会当成路人丢掉。
 */
export function parseLines(lines, { only = null, resolve = null } = {}) {
  const own = typeof resolve === 'function' ? resolve : (s) => s;
  const known = only ? new Set(only) : null;
  const out = [];

  for (const line of String(lines ?? '').split(/\r?\n/)) {
    if (!line.trim()) continue;
    const item = parseLine(line);
    if (!item) continue;

    const from = own(item.from);
    if (known && !known.has(from)) continue;
    out.push(from === item.from ? item : { ...item, from, said: item.from });
  }
  return out;
}

/**
 * 从一条正文回复里抽出所有 <phone> 块。
 * @returns {{private: Item[], groups: Array<{group: string, items: Item[]}>}}
 */
export function extractPhone(text, { known = null, resolve = null } = {}) {
  const blocks = scan(String(text ?? ''), { tags: ['phone'] })
    .filter(t => t.type === 'tag');

  const priv = [];
  const groups = new Map();

  for (const b of blocks) {
    const items = parseLines(b.body, { only: known, resolve });
    if (!items.length) continue;
    const g = (b.attrs?.group ?? '').trim();
    if (!g) { priv.push(...items); continue; }
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push(...items);
  }

  return { private: priv, groups: [...groups].map(([group, items]) => ({ group, items })) };
}

/** 回复里有没有 <phone>（快速判断，不解析内容） */
export const hasPhone = (text) => /<phone\b/i.test(String(text ?? ''));

/**
 * 生成注入给模型的规则。
 * 三个要点：
 *   1. 位置明确（正文之后、状态栏之前）—— 否则会打乱卡片的输出结构
 *   2. 私聊规则讲细（彼此看不到）—— 否则模型会让 A 回应 B 刚发的话
 *   3. 知情范围重申 —— 没在场的人不知道刚才发生了什么
 */
export function phoneRule({ user = '我', contacts = [], groups = [], canDraw = false } = {}) {
  const names = contacts.join('、');
  if (!names) return '';

  return [
    '【手机上的事】',
    `剧情里有人这时用手机联系${user}（发消息、发照片、转账、打电话……），`,
    `或者正文写到了这样的事，就在正文写完之后另起一行写 <phone></phone>，`,
    `（角色卡要求在正文后面的状态栏、选项照常写在它后面，不要省略），`,
    `把这些事在${user}的手机上真的发出来，内容和正文对得上。没有就不写。`,
    '',
    '<phone></phone> 里一件事一行：',
    '- 「名字：消息」，可以连着发几条',
    `- 「名字：[图片] 一句话描述画面${canDraw ? '｜英文 danbooru tag' : ''}」`,
    '- 「名字：[位置] 地点」',
    '- 「名字：[红包 ¥金额] 祝福语」「名字：[转账 ¥金额] 备注」',
    '- 「名字：[礼物 物品名] 附言」',
    '- 「名字：[分享歌曲] 歌名 - 歌手｜想说的话」',
    `- 「名字：[打电话] 为什么打」（${user}的手机会响，每次最多一个）`,
    `- 「名字：[朋友圈] 动态内容${canDraw ? '｜配图 tag' : ''}」（给所有朋友看，不是发给${user}的）`,
    '',
    `私聊是一对一的：每个人的每一条都是单独发给${user}的。`,
    `- 每条都对${user}说（「你」就是${user}），不喊别人的名字让对方接话。`,
    '- 几个人都发消息时各发各的：彼此看不到对方发了什么，不回应、不引用、不接着别人私聊里的话。',
    `- 只能是他这时会知道的事：没在场的人不知道刚才当面发生了什么。`,
    groups.length ? `- 几个人在一起聊、互相能看到的，另起一段 <phone group="群名">，群名只能是：${groups.join('、')}。` : '',
    '',
    `名字只能是：${names}。不要替${user}发。这些只出现在手机上，不写进正文叙述。`,
  ].filter(Boolean).join('\n');
}
