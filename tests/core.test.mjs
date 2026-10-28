/**
 * 核心层测试 —— 不需要浏览器，不需要酒馆。
 *
 *   node tests/core.test.mjs
 *
 * 覆盖：扫描器、台词协议、手机联动解析、角色归一、回复清理、漏斗取文、朋友圈解析
 */

import assert from 'node:assert/strict';

import { scan, stripTags, parseAttrs, codeRanges } from '../core/markup.js';
import { parseLines, renderLines, plainLines, diagnose, protocolFromTemplate, speechRule } from '../core/protocol.js';
import { parseLine, parseLines as parsePhoneLines, extractPhone, phoneRule, hasPhone } from '../core/phone.js';
import { createRoster, normalizeItems, fingerprint } from '../core/routes.js';
import { cleanReply, splitReply } from '../core/chat.js';
import { storyFunnel, buildChatContext, knowsRule, cleanMomentReply, parseReaction } from '../core/llm.js';

let pass = 0;
const fails = [];

function test(name, fn) {
  try { fn(); pass++; console.log(`  ok   ${name}`); }
  catch (e) { fails.push({ name, message: e.message }); console.error(`  FAIL ${name}\n       ${e.message}`); }
}

const group = (title) => console.log(`\n${title}`);

/* ============================================================ 扫描器 */

group('markup 扫描器');

test('认出成对标签', () => {
  const t = scan('前面<tts>a|b|c</tts>后面', { tags: ['tts'] });
  const tag = t.find(x => x.type === 'tag');
  assert.equal(tag.body, 'a|b|c');
  assert.equal(tag.name, 'tts');
});

test('保留标签外的文字', () => {
  const t = scan('前<tts>x</tts>后', { tags: ['tts'] });
  const texts = t.filter(x => x.type === 'text').map(x => x.value);
  assert.deepEqual(texts, ['前', '后']);
});

test('代码块里的标签不算', () => {
  const t = scan('```\n<tts>a|b|c</tts>\n```\n<tts>真|的|x</tts>', { tags: ['tts'] });
  const tags = t.filter(x => x.type === 'tag');
  assert.equal(tags.length, 1);
  assert.equal(tags[0].body, '真|的|x');
});

test('未闭合的标签降级为 open', () => {
  const t = scan('开始<tts>没闭合', { tags: ['tts'] });
  assert.ok(t.some(x => x.type === 'open'));
});

test('解析属性（双引号/单引号/中文引号）', () => {
  assert.equal(parseAttrs(' group="宿舍群"').group, '宿舍群');
  assert.equal(parseAttrs(" group='宿舍群'").group, '宿舍群');
  assert.equal(parseAttrs(' group=宿舍群').group, '宿舍群');
});

test('stripTags 去标签留内容', () => {
  assert.equal(stripTags('说<tts>a|b|c</tts>了', ['tts']), '说了');
});

test('stripTags keepLast 保留最后一个标签', () => {
  const out = stripTags('一<tts>a|b|1</tts>二<tts>a|b|2</tts>', ['tts'], { keepLast: true });
  assert.ok(!out.includes('|1'));
  assert.ok(out.includes('|2'));
});

test('codeRanges 覆盖围栏和行内', () => {
  const r = codeRanges('a `b` c');
  assert.equal(r.length, 1);
});

/* ========================================================== 台词协议 */

group('protocol 台词协议');

test('解析单句', () => {
  const lines = parseLines('她抬头。“你好呀”<tts>柚子|开心|こんにちは</tts>');
  assert.equal(lines.length, 1);
  assert.equal(lines[0].role, '柚子');
  assert.equal(lines[0].emotion, '开心');
  assert.equal(lines[0].text, 'こんにちは');
  assert.equal(lines[0].translation, '你好呀');
  assert.equal(lines[0].confidence, 'exact');
});

test('解析多句并保持顺序', () => {
  const lines = parseLines('“A”<tts>甲|平静|aaa</tts>\n“B”<tts>乙|生气|bbb</tts>');
  assert.deepEqual(lines.map(l => l.role), ['甲', '乙']);
});

test('没有引号也能解析（confidence=loose）', () => {
  const lines = parseLines('他<tts>甲|平静|hello</tts>');
  assert.equal(lines.length, 1);
  assert.equal(lines[0].confidence, 'loose');
  assert.equal(lines[0].translation, 'hello');
});

test('字段不全时 confidence=partial', () => {
  const lines = parseLines('“x”<tts>甲|只有两段</tts>');
  assert.equal(lines.length, 1);
  assert.equal(lines[0].confidence, 'partial');
});

test('台词里带分隔符不切断', () => {
  const lines = parseLines('“x”<tts>甲|平静|a|b</tts>');
  assert.equal(lines[0].text, 'a|b');
});

test('占位符角色被拒绝', () => {
  assert.equal(parseLines('“x”<tts>{{角色}}|平静|x</tts>').length, 0);
  assert.equal(parseLines('“x”<tts>角色|平静|x</tts>').length, 0);
});

test('代码块里的标签不算台词', () => {
  const msg = '```\n“x”<tts>甲|平静|x</tts>\n```\n“真”<tts>乙|笑|real</tts>';
  const lines = parseLines(msg);
  assert.equal(lines.length, 1);
  assert.equal(lines[0].role, '乙');
});

test('引号和标签之间夹了字就不算译文', () => {
  const lines = parseLines('“不是这句”然后他<tts>甲|平静|x</tts>');
  assert.equal(lines[0].translation, 'x');
  assert.equal(lines[0].confidence, 'loose');
});

test('plainLines 只留译文', () => {
  assert.equal(plainLines('前缀 “你好”<tts>甲|平静|hello</tts> 后缀'), '前缀 “你好” 后缀');
});

test('renderLines 出可点按钮且转义 HTML', () => {
  const html = renderLines('“<img src=x>”<tts>甲|平静|x</tts>');
  assert.ok(html.includes('mp-line'));
  assert.ok(html.includes('data-role="甲"'));
  assert.ok(!html.includes('<img'), '正文标签必须被转义');
});

test('diagnose 说人话', () => {
  assert.ok(diagnose('<tts>甲|平静|x').some(s => s.includes('没有闭合')));
  assert.ok(diagnose('<tts>只有两段</tts>').some(s => s.includes('缺少分隔符')));
  assert.ok(diagnose('完全没有标签').some(s => s.includes('没有')));
  assert.ok(diagnose('正文<b>粗体</b>').some(s => s.includes('别的标签')));
});

test('protocolFromTemplate 兼容旧格式串', () => {
  const p = protocolFromTemplate('“{译文}”<tts>{角色}|{情绪}|{文本}</tts>');
  assert.equal(p.tag, 'tts');
  assert.equal(p.sep, '|');
  assert.deepEqual(p.fields, ['role', 'emotion', 'text']);
});

test('自主格式也能解析', () => {
  const p = { tag: 'say', sep: '¦', fields: ['role', 'text'] };
  const lines = parseLines('“你好”<say>柚子¦こんにちは</say>', p);
  assert.equal(lines[0].role, '柚子');
  assert.equal(lines[0].text, 'こんにちは');
});

test('speechRule 含格式与"只加不减"提示', () => {
  const rule = speechRule({}, { language: '中文' });
  assert.ok(rule.includes('<tts>'));
  assert.ok(rule.includes('中文'));
  assert.ok(rule.includes('不要解释'));
});

/* ====================================================== 手机联动解析 */

group('phone 手机联动');

test('解析纯文本行', () => {
  const item = parseLine('柚子：在干嘛');
  assert.equal(item.from, '柚子');
  assert.equal(item.kind, 'text');
  assert.equal(item.text, '在干嘛');
});

test('解析图片行（描述 + tags）', () => {
  const item = parseLine('柚子：[图片] 窗外的雨｜rain, window');
  assert.equal(item.kind, 'photo');
  assert.equal(item.meta.prompt, '窗外的雨');
  assert.equal(item.meta.tags, 'rain, window');
});

test('解析转账（带金额）', () => {
  const item = parseLine('柚子：[转账 ¥52.00] 请你喝奶茶');
  assert.equal(item.kind, 'money');
  assert.equal(item.meta.amount, 52);
  assert.equal(item.meta.type, 'transfer');
  assert.equal(item.meta.note, '请你喝奶茶');
});

test('解析红包', () => {
  const item = parseLine('柚子：[红包 ¥8.88] 恭喜发财');
  assert.equal(item.meta.type, 'redpacket');
  assert.equal(item.meta.amount, 8.88);
});

test('解析唱歌', () => {
  const item = parseLine('柚子：[分享歌曲] 晴天 - 周杰伦｜听这个');
  assert.equal(item.kind, 'song');
  assert.equal(item.meta.title, '晴天');
  assert.equal(item.meta.artist, '周杰伦');
  assert.equal(item.meta.said, '听这个');
});

test('解析打电话', () => {
  const item = parseLine('柚子：[打电话] 有事找你');
  assert.equal(item.kind, 'call');
  assert.equal(item.meta.reason, '有事找你');
});

test('解析朋友圈行', () => {
  const item = parseLine('柚子：[朋友圈] 今天下雨了｜rain');
  assert.equal(item.kind, 'moment');
  assert.equal(item.meta.body, '今天下雨了');
  assert.equal(item.meta.tags, 'rain');
});

test('未知方括号当普通文字', () => {
  const item = parseLine('柚子：[随便什么] 你好');
  assert.equal(item.kind, 'text');
  assert.ok(item.text.includes('[随便什么]'));
});

test('容忍 markdown 加粗和全角冒号', () => {
  const item = parseLine('**柚子**：你好');
  assert.equal(item.from, '柚子');
});

test('extractPhone 分私聊和群聊', () => {
  const text = '<phone>柚子：在吗</phone>\n<phone group="宿舍群">小A：吃饭</phone>';
  const r = extractPhone(text);
  assert.equal(r.private.length, 1);
  assert.equal(r.private[0].text, '在吗');
  assert.equal(r.groups.length, 1);
  assert.equal(r.groups[0].group, '宿舍群');
});

test('extractPhone 用白名单过滤路人', () => {
  const text = '<phone>柚子：在吗\n路人甲：路过</phone>';
  const r = extractPhone(text, { known: ['柚子'] });
  assert.equal(r.private.length, 1);
  assert.equal(r.private[0].from, '柚子');
});

test('hasPhone 快速判断', () => {
  assert.equal(hasPhone('正文<phone>x</phone>'), true);
  assert.equal(hasPhone('普通正文'), false);
});

test('phoneRule 含隐私与知情约束', () => {
  const rule = phoneRule({ user: '我', contacts: ['柚子'], canDraw: false });
  assert.ok(rule.includes('<phone>'));
  assert.ok(rule.includes('彼此看不到'));
  assert.ok(rule.includes('只能是他这时会知道的事'));
});

test('phoneRule 没联系人时返回空', () => {
  assert.equal(phoneRule({ contacts: [] }), '');
});

/* ======================================================== 角色归一 */

group('routes 角色归一');

const roster = createRoster([
  { name: '夏尔·凡多姆海恩', aliases: ['夏尔', '少爷'] },
  { name: '柚子', aliases: ['小柚'] },
  { name: '塞巴斯蒂安', aliases: [] },
]);

test('完全匹配', () => {
  assert.equal(roster.resolve('柚子'), '柚子');
});

test('别名归到正式名', () => {
  assert.equal(roster.resolve('小柚'), '柚子');
  assert.equal(roster.resolve('少爷'), '夏尔·凡多姆海恩');
});

test('全名拆片段能认', () => {
  assert.equal(roster.resolve('夏尔·凡多姆海恩'), '夏尔·凡多姆海恩');
});

test('标点差异不影响', () => {
  assert.equal(roster.resolve('夏尔.凡多姆海恩'), '夏尔·凡多姆海恩');
});

test('认不出的原样返回，不瞎猜', () => {
  assert.equal(roster.resolve('路人甲'), '路人甲');
  assert.equal(roster.owner('路人甲'), null);
});

test('重名冲突时不替换', () => {
  const r2 = createRoster([{ name: 'A·B' }, { name: 'A·C' }]);
  assert.equal(r2.resolve('A'), 'A');   // "A" 同时属于两个人 → 不猜
});

test('normalizeItems 丢掉认不出的人', () => {
  const items = [{ from: '小柚', text: 'a' }, { from: '路人', text: 'b' }];
  const out = normalizeItems(items, roster);
  assert.equal(out.length, 1);
  assert.equal(out[0].from, '柚子');
});

test('fingerprint 归一标点', () => {
  assert.equal(fingerprint('夏尔·凡多姆海恩'), fingerprint('夏尔.凡多姆海恩'));
});

/* ==================================================== 回复清理 */

group('chat 回复清理');

test('剥掉 tts 标签', () => {
  assert.equal(cleanReply('说<tts>甲|平静|x</tts>了'), '说了');
});

test('剥掉名字前缀', () => {
  assert.equal(cleanReply('柚子：在干嘛'), '在干嘛');
});

test('剥掉外层引号', () => {
  assert.equal(cleanReply('“在干嘛”'), '在干嘛');
});

test('多行保留', () => {
  const out = cleanReply('柚子：在干嘛\n柚子：想你了');
  assert.equal(out, '在干嘛\n想你了');
});

test('splitReply 拆成多条', () => {
  const items = splitReply('在干嘛\n想你了', { from: '柚子', max: 3 });
  assert.equal(items.length, 2);
  assert.ok(items.every(i => i.from === '柚子'));
});

test('splitReply 保留类型', () => {
  const items = splitReply('在干嘛\n[图片] 外面的雨｜rain', { from: '柚子', max: 3 });
  assert.equal(items.length, 2);
  assert.equal(items[1].kind, 'photo');
});

test('splitReply 限制最大条数', () => {
  const items = splitReply('一\n二\n三\n四\n五', { from: '柚子', max: 3 });
  assert.equal(items.length, 3);
});

/* ================================================ 漏斗取文与上下文 */

group('llm 上下文');

const makeChat = (n) => Array.from({ length: n }, (_, i) => ({
  name: i % 2 ? '柚子' : '我',
  is_user: i % 2 === 0,
  mes: `第${i + 1}句话。${'内容'.repeat(150)}`,
}));

test('漏斗取文：近的完整、远的短', () => {
  const out = storyFunnel(makeChat(10), { full: 2, brief: 4, user: '我' });
  assert.equal(out.length, 6);
  const last = out.at(-1);
  assert.ok(last.text.length >= 400 * 0.5, '最近一条应保留较长内容');
  const early = out[0];
  assert.ok(early.text.length <= 84, '较早的应被截成首句');
});

test('漏斗取文跳过 system', () => {
  const chat = [...makeChat(3), { is_system: true, mes: '系统提示' }];
  const out = storyFunnel(chat, { full: 2, brief: 2 });
  assert.ok(!out.some(x => x.text.includes('系统提示')));
});

test('漏斗取文空数组不炸', () => {
  assert.deepEqual(storyFunnel([]), []);
  assert.deepEqual(storyFunnel(null), []);
});

test('buildChatContext 只有两条消息', () => {
  const ctx = buildChatContext({
    card: { name: '柚子', description: '银发的女孩', personality: '温柔' },
    user: '我',
    story: [{ name: '柚子', text: '她转过身。' }],
    thread: { type: 'dm', messages: [{ from: 'me', text: '在吗' }] },
  });
  assert.equal(ctx.messages.length, 2);
  assert.equal(ctx.messages[0].role, 'system');
  assert.equal(ctx.messages[1].role, 'user');
  assert.ok(ctx.messages[1].content.includes('在吗'));
  assert.ok(ctx.messages[1].content.includes('轮到'));
});

test('buildChatContext 含优先级声明', () => {
  const ctx = buildChatContext({ card: { name: '柚子' }, story: [] });
  const sys = ctx.messages[0].content;
  assert.ok(sys.includes('以剧情为准'));
});

test('buildChatContext offstory 不喂剧情也不加知情范围', () => {
  const ctx = buildChatContext({
    card: { name: '柚子' }, story: [{ name: '柚子', text: '吵架了' }], mode: 'offstory',
  });
  const sys = ctx.messages[0].content;
  assert.ok(!sys.includes('吵架了'));
  assert.ok(!sys.includes('知道什么'));
});

test('buildChatContext 报告每块字数', () => {
  const ctx = buildChatContext({
    card: { name: '柚子', description: 'x'.repeat(3000) },
    story: [{ name: '柚子', text: '剧情' }],
    budget: { cardText: 1200 },
  });
  const cardBlock = ctx.blocks.find(b => b.name === 'card');
  assert.ok(cardBlock.chars <= 1210, '角色卡必须被截断');
  assert.ok(ctx.chars > 0);
});

test('knowsRule 四句话都在', () => {
  const r = knowsRule({ user: '我', who: '柚子' });
  assert.ok(r.includes('在场'));
  assert.ok(r.includes('碰巧'));
  assert.ok(r.includes('没说出口'));
  assert.ok(r.includes('看不出'));
});

/* ====================================================== 朋友圈解析 */

group('moments 朋友圈');

test('cleanMomentReply 去掉"不发"', () => {
  assert.equal(cleanMomentReply('不发'), '');
  assert.equal(cleanMomentReply('不想发'), '');
});

test('cleanMomentReply 去前缀和引号', () => {
  assert.equal(cleanMomentReply('朋友圈：“今天好累”'), '今天好累');
});

test('cleanMomentReply 只留第一段', () => {
  assert.equal(cleanMomentReply('今天好累\n\n（这是解释）'), '今天好累');
});

test('parseReaction 解析点赞和评论', () => {
  const r = parseReaction('点赞：是\n评论：早点睡');
  assert.equal(r.like, true);
  assert.equal(r.comment, '早点睡');
});

test('parseReaction 处理不评论', () => {
  const r = parseReaction('点赞：否\n评论：无');
  assert.equal(r.like, false);
  assert.equal(r.comment, '');
});

/* ============================================================ 结果 */

console.log(`\n${pass} passed, ${fails.length} failed`);
if (fails.length) {
  console.error('\n失败明细：');
  for (const f of fails) console.error(`  ✗ ${f.name}: ${f.message}`);
  process.exitCode = 1;
}
