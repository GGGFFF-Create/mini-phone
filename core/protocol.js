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
export function parseLines(message, protocol = DEFAULT_PROTOCOL, opts = {}) {
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

  if (out.length) return out;

  /*
   * 一句 <tts> 都没有 → 退回宽松解析。
   *
   * 模型不一定会照格式写。没有标签就没台词，没台词就没声波按钮，
   * 界面上只能干看着——这比"多认几个引号"糟糕得多。
   * opts.loose === false 时跳过（有些调用方只想要严格结果）。
   */
  if (opts.loose === false) return [];

  // 「引号 + 角色|情绪|原文」这种没标签的写法，优先于纯引号
  const inline = parseInline(src);
  if (inline.length) return inline;

  return parseLoose(src, opts.defaultRole ?? '');
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

/* --------------------------------------------- 两阶段渲染（给正文用） */

/**
 * 为什么需要两阶段：
 *
 * 酒馆的正文渲染是「原始文字 → 别的插件的正则美化 → 上屏」。
 * 你要是在第一步就插 <button>，被后面那层正则一包，按钮可能被切成两半、
 * 被转义掉、或者落进代码块里点了没反应。
 *
 * 所以：
 *   阶段一（正则之前）：只打"看不见的标记"。用 Unicode 私用区字符，
 *                        正则和 markdown 把它们当普通文字，不会破坏结构。
 *   阶段二（正则之后）：把标记换成真按钮。这时卡片已经成型，插进去安全。
 *   阶段三（兜底）：如果有按钮落进了代码块/整页 HTML，拆掉它只留文字。
 */

/**
 * 像不像一个角色名。
 *
 * 正文里难免混进模板残留（{キャラ}、{{user}}）、markdown 标记（**名字**）、
 * 纯数字、换行碎片。这些不该变成聊天对象、音色条目、朗读列表里的一行。
 *
 * 解析层自己就要过滤 —— 不能指望每个调用方都记得过一遍。
 */
export function looksLikeName(raw) {
  const n = String(raw ?? '').trim();
  if (!n || n.length > 30) return false;
  if (/[{}$<>`\\*#\[\]|]/.test(n)) return false;
  if (/[\r\n\t]/.test(n)) return false;
  if (/^[0-9]+$/.test(n)) return false;
  if (!/[\p{L}\p{N}]/u.test(n)) return false;
  return true;
}

/**
 * 宽松解析：正文没有 <tts> 标签时，直接从常见对话格式里认台词。
 *
 * 【为什么需要】
 * 严格模式靠模型写 <tts>角色|情绪|文本</tts>。但模型不一定照着写 ——
 * 开头几楼、或者换了提示词之后，正文里根本没有标签，于是一句台词都识别
 * 不出来，界面上连声波按钮都没有，只能干看着。
 *
 * 这里退回人类最常写的形式：
 *   中文引号 / 英文引号 / 直角引号 / 双直角引号 包起来的那句
 * 说话人从引号前面的「名字：」或「**名字**」推出来，推不出就用默认角色。
 *
 * 结果是宽松的（旁白里的引号也可能被当成台词），但这比"一句都识别不出来"
 * 好得多：多一个按钮至少点得动，漏掉整句话就没法用了。
 */
export function parseLoose(text, defaultRole = '') {
  const src = String(text ?? '');
  const lines = [];
  const re = /[\u201C"\u300C\u300E]([^\u201D"\u300D\u300F\n]{1,500})[\u201D"\u300D\u300F]/g;

  let m;
  while ((m = re.exec(src))) {
    const body = String(m[1] ?? '').trim();
    if (body.length < 2) continue;

    const before = src.slice(Math.max(0, m.index - 160), m.index);
    const speaker =
      /\*\*([^*\n]{1,16})\*\*[\s\uFF1A:]*$/.exec(before)?.[1]?.trim()
      || /[\n\u3002\uFF01\uFF1F!?\uFF09)]\s*([^\s\uFF1A:\n\uFF0C\u3002\uFF01\uFF1F!?\u201C\u201D"\u300C\u300D\u300E\u300F]{1,16})\s*[\uFF1A:]\s*$/.exec(before)?.[1]?.trim()
      || /^\s*([^\s\uFF1A:\n\uFF0C\u3002\uFF01\uFF1F!?\u201C\u201D"\u300C\u300D\u300E\u300F]{1,16})\s*[\uFF1A:]/.exec(before)?.[1]?.trim()
      || '';

    const cleaned = looksLikeName(speaker) ? speaker : '';
    const fallbackRole = looksLikeName(defaultRole) ? String(defaultRole).trim() : '\u65C1\u767D';
    lines.push({
      role: cleaned || fallbackRole,
      emotion: '',
      text: body,
      translation: body,
      trStart: m.index + 1,
      trEnd: re.lastIndex - 1,
      start: m.index,
      end: re.lastIndex,
      confidence: 'loose',
    });
  }

  return lines;
}

/**
 * 解析「引号 + 竖线」格式（没有 XML 标签的那种）。
 *
 * 正文长这样：
 *   “说起来也奇怪……”佩拉|疑惑|それにしても変な……
 *    ↑译文            ↑角色 ↑情绪 ↑原文
 *
 * 很多卡用的是这个写法（比 <tts> 标签更省 token，模型也更容易照着写），
 * 但它没有标签边界，之前完全识别不出来 —— 界面上一个声波都没有。
 *
 * 只认"引号后面紧跟着 角色|…"的形状，所以不会把普通旁白里的引号吃进来。
 */
export function parseInline(text) {
  const src = String(text ?? '');
  const lines = [];

  // 引号内容 + 紧跟的角色名 + 竖线 + 剩下的（情绪|原文，或只有原文）
  const re = /[\u201C"\u300C\u300E]([^\u201D"\u300D\u300F\n]{1,500})[\u201D"\u300D\u300F]\s*([^|\s\n]{1,16})\s*\|([^\n]{1,2000})/g;

  let m;
  while ((m = re.exec(src))) {
    const translation = String(m[1] ?? '').trim();
    const role = String(m[2] ?? '').trim();
    const rest = String(m[3] ?? '');

    if (translation.length < 2) continue;
    if (!looksLikeName(role)) continue;     // 模板残留、纯数字、markdown 标记都不收

    const parts = rest.split('|');
    const emotion = parts.length >= 2 ? String(parts[0] ?? '').trim().slice(0, 40) : '';
    const body = (parts.length >= 2 ? parts.slice(1).join('|') : parts[0]).trim();

    lines.push({
      role,
      emotion,
      text: body || translation,
      translation,
      trStart: m.index + 1,                            // 引号内侧
      trEnd: re.lastIndex - 1,
      start: m.index,
      end: re.lastIndex,
      confidence: 'inline',
    });
  }

  return lines;
}

const MARK_OPEN = '\uE000';   // 标记开始
const MARK_MID = '\uE001';    // 行号和译文的分界
const MARK_CLOSE = '\uE002';  // 标记结束
const MARK_RE = /\uE000([0-9a-f]{4})\uE001([\s\S]*?)\uE002/g;

/** 这条消息的解析结果，阶段二要用。key 是 token（消息 id + 渲染次数）。 */
const stage = new Map();

/**
 * 阶段一：把每句台词换成标记 + 译文。
 * 同时把解析结果存起来，阶段二按行号取。
 */
export function markLines(message, protocol, { token = '', defaultRole = '' } = {}) {
  const src = String(message ?? '');
  const lines = parseLines(src, protocol, { defaultRole });
  if (!lines.length) return src;

  stage.set(token, { lines, at: Date.now() });
  // 只保留最近 40 条，避免长时间开着页面越攒越多
  if (stage.size > 40) stage.delete(stage.keys().next().value);

  let out = '';
  let at = 0;
  lines.forEach((line, i) => {
    out += src.slice(at, line.trStart);
    const idx = i.toString(16).padStart(4, '0');
    out += MARK_OPEN + idx + MARK_MID + line.translation + MARK_CLOSE;
    at = line.end;
  });
  return out + src.slice(at);
}

/**
 * 阶段二：标记 → 可点的按钮。
 * regex 已经跑完，现在插 DOM 是安全的。
 */
export function buttonsFromMarks(text, { token = '' } = {}) {
  const src = String(text ?? '');
  if (!src.includes(MARK_OPEN)) return src;

  const record = stage.get(token);
  const lines = record?.lines ?? [];

  return src.replace(MARK_RE, (whole, hex, translation) => {
    const i = parseInt(hex, 16);
    const line = lines[i];
    const text2 = String(translation ?? '').trim();
    if (!text2) return whole;

    // 数据丢了（比如刷新后）也要能显示，只是按钮不带信息
    const attrs = [
      'class="mp-line"',
      `data-i="${i}"`,
      line ? `data-role="${esc(line.role)}"` : '',
      line ? `data-emotion="${esc(line.emotion)}"` : '',
      line ? `data-text="${esc(line.text)}"` : '',
      `data-token="${esc(token)}"`,
    ].filter(Boolean).join(' ');

    return `<span ${attrs}><span class="mp-tr">“${esc(text2)}”</span>` +
      `<button type="button" class="mp-play" data-act="say" aria-label="朗读这句台词">` +
      `<i></i><i></i><i></i></button></span>`;
  });
}

/**
 * 阶段三：兜底清理。
 * 落进代码块或整页 HTML 里的按钮，插件够不着，拆掉只留文字。
 */
export function stripWaves(text) {
  const src = String(text ?? '');
  if (!/<span class="mp-line"/.test(src)) return src;

  return src.replace(
    /```[\s\S]*?(?:```|$)|<(?:!doctype\s+html|html)\b[\s\S]*?(?:<\/html\s*>|$)/gi,
    (block) => block
      .replace(/<span class="mp-line"[^>]*><span class="mp-tr">([\s\S]*?)<\/span>\s*<button[\s\S]*?<\/button><\/span>/g, '$1')
      .replace(/\uE000[0-9a-f]{4}\uE001([\s\S]*?)\uE002/g, '$1'),
  );
}

/** 清掉所有标记（语音关掉、或者渲染失败时用） */
export function unmark(text) {
  return String(text ?? '')
    .replace(/\uE000[0-9a-f]{4}\uE001([\s\S]*?)\uE002/g, '$1')
    .replace(MARK_OPEN, '')
    .replace(MARK_MID, '')
    .replace(MARK_CLOSE, '');
}

/** 渲染记录清理（切聊天时调） */
export function clearStage() {
  stage.clear();
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
