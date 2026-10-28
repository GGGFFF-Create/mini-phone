/**
 * 台词协议 —— 从正文里认出"谁说了什么、什么情绪、原文是什么"。
 *
 * 【和上一代实现的区别】
 * ST-iPhonie 的做法是：把格式串 `“{译文}”<tts>{角色}|{情绪}|{文本}</tts>` 编译成
 * 4 段字面文字，然后用 indexOf 逐段切分。要求极严，所以才有 repaired() 那一整套
 * "等长修复"来提高命中率。
 *
 * 这里换了个思路：**不编译格式串，而是把格式降维成结构描述**。
 *
 *   { tag: 'tts', sep: '|', fields: ['role', 'emotion', 'text'] }
 *
 * 解析就三步：扫标签 → 按分隔符切 → 按顺序映射字段。译文则"往标签前面找引号"。
 *
 * 为什么这样更好：
 *   1. 不需要等长修复 —— 扫描器给出精确位置，文字可以任意变形
 *   2. 译文定位靠启发式而非格式匹配 —— 模型多写少写一个引号都能认
 *   3. 每条结果带 confidence —— 调用方能决定"要不要显示声波按钮"
 */

import { scan, codeRanges } from './markup.js';

/** 默认协议：中文译文在引号里，原文和角色在 <tts> 标签里 */
export const DEFAULT_PROTOCOL = Object.freeze({
  tag: 'tts',
  sep: '|',
  fields: ['role', 'emotion', 'text'],
});

/** 给模型看的格式示例（注入提示词时用） */
export const FORMAT_EXAMPLE = '“你好呀”<tts>柚子|开心|こんにちは</tts>';

/** 从旧式的格式串里提取结构，兼容用户已有的预设 */
export function protocolFromTemplate(template) {
  const s = String(template ?? '');
  const tag = /<([A-Za-z][\w:-]*)\b/.exec(s)?.[1]?.toLowerCase();
  if (!tag) return { ...DEFAULT_PROTOCOL };
  const body = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`, 'i').exec(s)?.[1] ?? '';
  const seps = [...body.matchAll(/[^A-Za-z\u4e00-\u9fa5{}\s]+/g)].map(m => m[0]);
  const sep = seps.find(x => x.length === 1) || '|';
  const order = [...body.matchAll(/\{(译文|角色|情绪|文本)\}/g)].map(m => m[1]);
  const map = { 角色: 'role', 情绪: 'emotion', 文本: 'text', 译文: 'translation' };
  const fields = order.map(x => map[x]).filter(x => x && x !== 'translation');
  return { tag, sep, fields: fields.length ? fields : [...DEFAULT_PROTOCOL.fields] };
}

/* --------------------------------------------------------------- 译文定位 */

const QUOTE_OPEN = /[“"「『＂]/;
const QUOTE_PAIR = /[“"「『＂][^“”"」』＂\n]{1,2000}[”"」』＂]/g;

/**
 * 标签前面紧邻的那段引号文本，就是这个角色的译文。
 * 往前找最近的引号对，且要求它和标签之间只隔着空白/标点。
 *
 * 返回 { text, start, end } —— 位置必须带回去，因为渲染时要把
 * "引号 + 标签"整段替换成"译文 + 按钮"，只拿到文字会导致译文重复输出。
 */
function translationBefore(src, tagStart) {
  const from = Math.max(0, tagStart - 600);
  const window = src.slice(from, tagStart);
  const pairs = [...window.matchAll(QUOTE_PAIR)];
  if (!pairs.length) return null;

  const last = pairs[pairs.length - 1];
  const gap = window.slice(last.index + last[0].length);
  if (gap.trim() && !/^[\s，,。.、；;：:!！?？~～…—-]*$/.test(gap)) return null;

  return {
    text: last[0].slice(1, -1).trim(),
    start: from + last.index,
    end: from + last.index + last[0].length,
  };
}

/* ----------------------------------------------------------------- 解析 */

/**
 * @returns {Array<{
 *   role: string, emotion: string, text: string, translation: string,
 *   start: number, end: number,
 *   confidence: 'exact' | 'loose' | 'partial',
 * }>}
 */
export function parseLines(message, protocol = DEFAULT_PROTOCOL) {
  const src = String(message ?? '');
  if (!src || src.length > 500_000) return [];

  const { tag, sep, fields } = { ...DEFAULT_PROTOCOL, ...protocol };
  const tags = scan(src, { tags: [tag] });
  const skip = codeRanges(src);
  const out = [];

  for (const t of tags) {
    if (t.type !== 'tag') continue;                        // 跳过 text token 和未闭合的 open
    if (skip.some(([a, b]) => t.start >= a && t.start < b)) continue;

    const parts = t.body.split(sep).map(x => x.trim());
    if (parts.length < 2) continue;                        // 至少要有"角色 + 内容"

    const values = {};
    fields.forEach((f, i) => { values[f] = parts[i] ?? ''; });

    // 段落数少于字段数：按"第一个是角色，剩下全是内容"处理。
    // 模型经常省略情绪（<tts>甲|你好</tts>），这不该算解析失败。
    if (parts.length < fields.length) {
      values[fields[0]] = parts[0];
      values[fields[fields.length - 1]] = parts.slice(1).join(sep);
    }
    // 段落数多于字段数：台词本身带分隔符，剩下的全归最后一个字段
    if (parts.length > fields.length) {
      values[fields[fields.length - 1]] = parts.slice(fields.length - 1).join(sep);
    }

    const role = (values.role ?? '').trim();
    const text = (values.text ?? '').trim();
    if (!role || !text) continue;
    if (role.length > 60 || text.length > 4000) continue;

    // 模型照抄了模板占位符：去掉花括号/方括号后如果只剩关键词，就丢掉
    const bare = role.replace(/[{}\[\]［］【】\s]/g, '');
    if (/^(角色|角色名|role|speaker|char)$/i.test(bare)) continue;

    const quoted = translationBefore(src, t.start);
    const emotion = (values.emotion ?? '').trim().slice(0, 40);

    out.push({
      role,
      emotion,
      text,
      translation: quoted?.text || text,
      // 译文的原文位置：渲染时要把"引号 + 标签"整段换掉
      trStart: quoted ? quoted.start : t.start,
      trEnd: quoted ? quoted.end : t.start,
      start: t.start,
      end: t.end,
      confidence: parts.length < fields.length ? 'partial' : (quoted ? 'exact' : 'loose'),
    });
  }

  return out;
}

/* --------------------------------------------------------------- 渲染 */

const esc = (s) => String(s).replace(/[&<>"']/g, c =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/**
 * 渲染成"译文 + 可点声波"。语音关闭时用 plainLines()。
 * data-* 属性把解析结果带进 DOM，点击时不用重新解析。
 */
export function renderLines(message, protocol, { token = '' } = {}) {
  const src = String(message ?? '');
  const lines = parseLines(src, protocol);
  if (!lines.length) return esc(src);

  let out = '';
  let at = 0;
  for (const [i, line] of lines.entries()) {
    // 从上一个标签结尾到"译文引号开头"之间的文字，原样带过去。
    // 引号和标签之间的东西（引号本身）由下面重写，不然译文会重复。
    out += esc(src.slice(at, line.trStart));
    const attrs = [
      `class="mp-line"`,
      `data-i="${i}"`,
      `data-role="${esc(line.role)}"`,
      `data-emotion="${esc(line.emotion)}"`,
      `data-text="${esc(line.text)}"`,
      `data-conf="${line.confidence}"`,
      token ? `data-token="${esc(token)}"` : '',
    ].filter(Boolean).join(' ');
    out += `<span ${attrs}><span class="mp-tr">“${esc(line.translation)}”</span>` +
      `<button type="button" class="mp-play" data-act="say" aria-label="朗读 ${esc(line.role)} 的台词">` +
      `<i></i><i></i><i></i></button></span>`;
    at = line.end;
  }
  return out + esc(src.slice(at));
}

/** 只要译文，不要按钮 */
export function plainLines(message, protocol) {
  const src = String(message ?? '');
  const lines = parseLines(src, protocol);
  if (!lines.length) return src;
  let out = '';
  let at = 0;
  for (const line of lines) {
    out += src.slice(at, line.trStart) + `“${line.translation}”`;
    at = line.end;
  }
  return out + src.slice(at);
}

/* ------------------------------------------------------------- 诊断 */

/**
 * 为什么没解析出台词？给用户看得懂的理由。
 * 比"静默失败"好得多——模型写歪了，用户能自己去调预设。
 */
export function diagnose(message, protocol = DEFAULT_PROTOCOL) {
  const src = String(message ?? '');
  const { tag, sep, fields } = { ...DEFAULT_PROTOCOL, ...protocol };
  // scan 会把普通文字也当 token 返回，这里只要标签
  const tags = scan(src, { tags: [tag] }).filter(t => t.type !== 'text');
  const problems = [];

  for (const t of tags) {
    if (t.type === 'open') { problems.push(`<${tag}> 没有闭合`); continue; }
    const parts = t.body.split(sep).map(x => x.trim());
    if (parts.length < 2) { problems.push(`<${tag}> 里缺少分隔符「${sep}」`); continue; }
    if (parts.length < fields.length) problems.push(`<${tag}> 只有 ${parts.length} 段，需要 ${fields.length} 段`);
    if (!parts[0]) problems.push(`<${tag}> 里没有写角色名`);
    const bare = parts[0].replace(/[{}\[\]［］【】\s]/g, '');
    if (/^(角色|角色名|role|speaker|char)$/i.test(bare)) problems.push('角色名还是占位符，模型照抄了模板');
    if (!translationBefore(src, t.start)) problems.push('标签前面没有中文译文（引号）');
  }

  if (!tags.length) {
    problems.push(/<[a-z]/i.test(src)
      ? `没有找到 <${tag}> 标签（正文里有别的标签，可能格式写错了）`
      : `正文里没有 <${tag}> 标签，模型没有按格式写台词`);
  }
  return [...new Set(problems)];
}

/* --------------------------------------------------- 给模型看的规则 */

/**
 * 注入正文的硬性规则。三段结构：
 *   1. 格式（给例子）
 *   2. 边界（什么不该放进标签）
 *   3. 自我保护（不要解释规则）
 */
export function speechRule(protocol = DEFAULT_PROTOCOL, { language = '' } = {}) {
  return [
    '【对白格式】',
    `每一次角色真正说出口的台词，写成：${FORMAT_EXAMPLE}`,
    '格式里依次是：引号里的中文译文、<tts> 里的「角色名|情绪|这句台词的原文」。',
    '译文要完整自然，不能只译一半；原文和译文说的是同一句话。',
    language ? `台词语言：${language}。` : '',
    '',
    '【不要放进标签】',
    '旁白、动作、环境、心理描写，都写在标签外面的正文里。',
    '没有真的说出口的话（心想的、写下来的），不要配音。',
    '',
    '【别做的两件事】',
    '不要解释这些规则，也不要输出代码块。',
    '角色名写真实的人名，不要写「角色」「{{角色}}」这种占位符。',
  ].filter(Boolean).join('\n');
}

/**
 * 追加在一切注入之后的一句"只加不减"。
 * 没有这句，你注入的规则会让模型以为"只能输出台词"，把角色卡的思考过程、
 * 状态栏、选项全砍掉 —— 用户第一反应是"装了这个插件我的卡坏了"。
 */
export const KEEP_REPLY =
  '【以上是插件补充的写法】这些规则只管台词怎么写，不改变回复的其他部分：' +
  '预设和角色卡要求的思考过程、状态栏、选项、变量更新等内容，照常按原来的要求完整输出，不要省略。';
