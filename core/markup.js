/**
 * 标记扫描器 —— 整个协议层的地基。
 *
 * 【为什么不用正则】
 * 上一代实现（ST-iPhonie 的 protocol.js）用了 5 组正则串起来做解析：
 * 先 repaired() 把不规范的标签"修"成规范形式，再 exactLines() 严格切，
 * 失败再 looseLines() 宽松切，最后 mendLine() 修补半句话。
 *
 * 那套能跑，但有三个问题：
 *   1. repaired() 必须"等长替换"（字符数不变），否则后面的位置信息全错 —— 这个约束让每个修复都很别扭
 *   2. 正则链的失败模式难以预测：修 A 会破坏 B，加一条规则要权衡三条
 *   3. 没法知道"为什么没解析出来"
 *
 * 这里换成一个扫描器：一次遍历，产出 token 流，容错点在扫描时解决。
 * 好处是——只有一个地方处理畸形输入，而且能报告原因。
 */

/** 标签名合法字符 */
const NAME_RE = /[A-Za-z][\w:-]*/y;

/**
 * 找出代码块 / 行内代码的范围。里面的标签是示例，不是真标签。
 * 这是唯一需要"预扫描"的东西，因为代码块可以跨行。
 */
export function codeRanges(text) {
  const out = [];
  const re = /```[\s\S]*?(?:```|$)|~~~[\s\S]*?(?:~~~|$)|`[^`\n]*`/g;
  for (const m of text.matchAll(re)) out.push([m.index, m.index + m[0].length]);
  return out;
}

const inRanges = (pos, ranges) => ranges.some(([a, b]) => pos >= a && pos < b);

/**
 * 扫描文本，产出 token 流。
 *
 * token 形状：
 *   { type: 'text', value, start, end }
 *   { type: 'tag',  name, attrs, body, start, end }     自闭合或成对
 *   { type: 'open', name, attrs, start, end }           未闭合的开标签（畸形）
 *
 * @param {string} text
 * @param {{ tags?: string[], codeAware?: boolean }} opts
 *        tags: 只认这些标签名（不传则认所有）；codeAware: 跳过代码块（默认 true）
 */
export function scan(text, { tags = null, codeAware = true } = {}) {
  const src = String(text ?? '');
  const out = [];
  const skip = codeAware ? codeRanges(src) : [];
  const wanted = tags ? new Set(tags.map(t => t.toLowerCase())) : null;

  // 栈：处理嵌套（同名标签理论上不该嵌套，但畸形输出里会出现）
  const stack = [];
  let textStart = 0;

  const flushText = (upto) => {
    if (upto > textStart) out.push({ type: 'text', value: src.slice(textStart, upto), start: textStart, end: upto });
  };

  let i = 0;
  while (i < src.length) {
    const lt = src.indexOf('<', i);
    if (lt < 0) break;
    if (inRanges(lt, skip)) { i = lt + 1; continue; }

    // 匹配 <name 或 </name
    const close = src[lt + 1] === '/';
    NAME_RE.lastIndex = lt + (close ? 2 : 1);
    const nm = NAME_RE.exec(src);
    if (!nm) { i = lt + 1; continue; }

    const name = nm[0].toLowerCase();
    if (wanted && !wanted.has(name)) { i = lt + 1; continue; }

    const gt = src.indexOf('>', nm.index + nm[0].length);
    if (gt < 0) { i = lt + 1; continue; }

    const rawAttrs = src.slice(nm.index + nm[0].length, gt);
    const selfClose = rawAttrs.trimEnd().endsWith('/');

    if (close) {
      // 找栈里最近一个同名 open
      let k = stack.length - 1;
      while (k >= 0 && stack[k].name !== name) k--;
      if (k < 0) { i = gt + 1; continue; }        // 孤立闭标签，当文本

      const open = stack[k];
      stack.length = k;                            // 丢弃中间未闭合的项（畸形）
      flushText(open.start);
      out.push({
        type: 'tag', name,
        attrs: open.attrs,
        body: src.slice(open.end, lt),
        start: open.start,
        end: gt + 1,
      });
      i = gt + 1;
      textStart = i;
      continue;
    }

    if (selfClose) {
      flushText(lt);
      out.push({ type: 'tag', name, attrs: parseAttrs(rawAttrs), body: '', start: lt, end: gt + 1 });
      i = gt + 1;
      textStart = i;
      continue;
    }

    stack.push({ name, attrs: parseAttrs(rawAttrs), start: lt, end: gt + 1 });
    i = gt + 1;
  }

  // 收尾：未闭合的开标签降级成 open token（调用方决定怎么处理）
  for (const open of stack) out.push({ type: 'open', name: open.name, attrs: open.attrs, start: open.start, end: open.end });

  flushText(src.length);
  return out.sort((a, b) => a.start - b.start);
}

/** 解析标签属性：<phone group="宿舍群" id=3> */
export function parseAttrs(raw) {
  const attrs = {};
  const re = /([A-Za-z_][\w-]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|“([^”]*)”|「([^」]*)」|([^\s>]+))/g;
  for (const m of String(raw ?? '').matchAll(re)) {
    attrs[m[1].toLowerCase()] = (m[2] ?? m[3] ?? m[4] ?? m[5] ?? m[6] ?? '').trim();
  }
  return attrs;
}

/** 去掉所有指定标签（含内容），用于"发给模型前"的清理 */
export function stripTags(text, tags, { keepLast = false } = {}) {
  const tokens = scan(text, { tags: keepLast ? tags : tags });
  const hits = tokens.filter(t => t.type === 'tag' || t.type === 'open');
  if (!hits.length) return String(text ?? '');

  const drop = keepLast ? hits.slice(0, -1) : hits;
  let out = text;
  for (const t of [...drop].sort((a, b) => b.start - a.start)) {
    out = out.slice(0, t.start) + out.slice(t.end);
  }
  return out;
}

/**
 * 把标签内容替换成渲染结果。replacer 收到 token，返回字符串。
 * 从后往前替换，避免位置偏移。
 */
export function replaceTags(text, tags, replacer) {
  const src = String(text ?? '');
  const hits = scan(src, { tags }).filter(t => t.type === 'tag' || t.type === 'open');
  let out = src;
  for (const t of [...hits].sort((a, b) => b.start - a.start)) {
    let replacement;
    try { replacement = replacer(t); }
    catch { replacement = src.slice(t.start, t.end); }
    if (replacement !== undefined) out = out.slice(0, t.start) + replacement + out.slice(t.end);
  }
  return out;
}
