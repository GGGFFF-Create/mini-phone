/**
 * 语音层测试 —— 只测纯函数部分（不需要浏览器）。
 *
 *   node tests/tts.test.mjs
 *
 * 覆盖：模板变量填充、情绪翻译、请求拼装、配置校验、缓存指纹
 */

import assert from 'node:assert/strict';

import {
  fill, fillDeep, pick, normalizeEmotion, applyEmotion,
  validateEngine, createEngine, templateOf, BUILTIN_ENGINES,
} from '../core/tts/engine.js';
import { buildRequest } from '../core/tts/synth.js';
import { fingerprint } from '../core/tts/cache.js';

let pass = 0;
const fails = [];
const test = (name, fn) => {
  try { fn(); pass++; console.log(`  ok   ${name}`); }
  catch (e) { fails.push({ name, message: e.message }); console.error(`  FAIL ${name}\n       ${e.message}`); }
};
const group = (t) => console.log(`\n${t}`);

/* ==================================================== 模板 */

group('模板填充');

test('填单个变量', () => {
  assert.equal(fill('Bearer {{key}}', { key: 'abc' }), 'Bearer abc');
});

test('容忍变量旁边的空格', () => {
  assert.equal(fill('{{ key }}', { key: 'x' }), 'x');
});

test('未知变量原样保留', () => {
  assert.equal(fill('{{unknown}}', { key: 'x' }), '{{unknown}}');
});

test('空值填成空串', () => {
  assert.equal(fill('a{{key}}b', { key: '' }), 'ab');
});

test('递归填对象', () => {
  const out = fillDeep({ a: '{{x}}', b: { c: '{{x}}!' } }, { x: '9' });
  assert.deepEqual(out, { a: '9', b: { c: '9!' } });
});

test('递归填数组', () => {
  assert.deepEqual(fillDeep(['{{x}}', '{{x}}'], { x: 'a' }), ['a', 'a']);
});

test('非字符串原样返回', () => {
  assert.equal(fillDeep(42, {}), 42);
  assert.equal(fillDeep(null, {}), null);
});

test('pick 取嵌套字段', () => {
  assert.equal(pick({ data: { audio: 'aa' } }, 'data.audio'), 'aa');
  assert.equal(pick({ a: [{ b: 1 }] }, 'a.0.b'), 1);
  assert.equal(pick({}, 'x.y'), undefined);
});

/* ==================================================== 情绪 */

group('情绪翻译');

test('中文情绪转英文', () => {
  assert.equal(normalizeEmotion('开心'), 'happy');
  assert.equal(normalizeEmotion('难过'), 'sad');
  assert.equal(normalizeEmotion('害羞'), 'shy');
});

test('带修饰的中文也能认', () => {
  assert.equal(normalizeEmotion('有点开心'), 'happy');
  assert.equal(normalizeEmotion('非常生气'), 'angry');
});

test('英文原样小写', () => {
  assert.equal(normalizeEmotion('Happy'), 'happy');
});

test('认不出返回空串（不瞎猜）', () => {
  assert.equal(normalizeEmotion('某种复杂的心境'), '');
  assert.equal(normalizeEmotion(''), '');
  assert.equal(normalizeEmotion(null), '');
});

group('情绪塞进文本');

const engBracket = createEngine({ emotion: 'bracket' });
const engParen = createEngine({ emotion: 'paren' });
const engNone = createEngine({ emotion: 'none' });

test('方括号模式', () => {
  const r = applyEmotion('你好', '开心', engBracket);
  assert.equal(r.text, '[happy] 你好');
  assert.equal(r.used, 'happy');
});

test('圆括号模式', () => {
  const r = applyEmotion('你好', '开心', engParen);
  assert.equal(r.text, '(happy) 你好');
});

test('none 模式不动文本', () => {
  const r = applyEmotion('你好', '开心', engNone);
  assert.equal(r.text, '你好');
  assert.equal(r.used, '');
});

test('文本自己带括号时不套娃', () => {
  const r = applyEmotion('[叹气] 算了', '难过', engBracket);
  assert.equal(r.text, '[叹气] 算了');
  assert.equal(r.used, '');
});

test('认不出的情绪不加前缀', () => {
  const r = applyEmotion('你好', '复杂心境', engBracket);
  assert.equal(r.text, '你好');
  assert.equal(r.used, '');
});

test('关闭翻译时直接用原文', () => {
  const eng = createEngine({ emotion: 'bracket', emotionTranslate: false });
  const r = applyEmotion('你好', 'happy', eng);
  assert.equal(r.text, '[happy] 你好');
});

/* ==================================================== 请求拼装 */

group('请求拼装');

const openai = createEngine({
  id: 'openai',
  base: 'https://api.openai.com/v1',
  key: 'sk-test',
  model: 'tts-1',
  voice: 'alloy',
  endpoint: '{{base}}/audio/speech',
  method: 'POST',
  headers: { Authorization: 'Bearer {{key}}', 'Content-Type': 'application/json' },
  body: { model: '{{model}}', input: '{{text}}', voice: '{{voice}}', response_format: 'mp3' },
  emotion: 'none',
  response: 'audio',
  bodyIsJson: true,
});

test('地址里的变量被替换', () => {
  const { url } = buildRequest(openai, { role: '甲', text: '你好' });
  assert.equal(url, 'https://api.openai.com/v1/audio/speech');
});

test('base 末尾斜杠不会拼出双斜杠', () => {
  const e = createEngine({ ...openai, base: 'https://x.com/v1/' });
  const { url } = buildRequest(e, { text: 'a' });
  assert.equal(url, 'https://x.com/v1/audio/speech');
});

test('请求头里的 key 被替换', () => {
  const { init } = buildRequest(openai, { text: '你好' });
  assert.equal(init.headers.Authorization, 'Bearer sk-test');
});

test('请求体是 JSON 且含文本', () => {
  const { init } = buildRequest(openai, { text: '你好呀' });
  const body = JSON.parse(init.body);
  assert.equal(body.input, '你好呀');
  assert.equal(body.model, 'tts-1');
  assert.equal(body.voice, 'alloy');
});

test('角色音色覆盖引擎默认音色', () => {
  const { init } = buildRequest(openai, { text: 'x', voice: 'nova' });
  assert.equal(JSON.parse(init.body).voice, 'nova');
});

test('情绪模式生效时文本被改写', () => {
  const fish = createEngine({
    base: 'https://api.fish.audio/v1',
    endpoint: '{{base}}/tts',
    key: 'k',
    body: { text: '{{text}}' },
    emotion: 'paren',
  });
  const { init, emotionUsed } = buildRequest(fish, { text: '你好', emotion: '开心' });
  assert.equal(emotionUsed, 'happy');
  assert.equal(JSON.parse(init.body).text, '(happy) 你好');
});

test('GET 方法不带 body', () => {
  const e = createEngine({ ...openai, method: 'GET' });
  const { init } = buildRequest(e, { text: 'x' });
  assert.equal(init.body, undefined);
});

test('返回值里有 vars 方便调试', () => {
  const { vars } = buildRequest(openai, { text: 'hi' });
  assert.equal(vars.text, 'hi');
  assert.equal(vars.rawText, 'hi');
});

/* ==================================================== 校验 */

group('配置校验');

test('完整的配置没问题', () => {
  assert.deepEqual(validateEngine(openai), []);
});

test('缺 endpoint 报错', () => {
  const e = createEngine({ body: { text: '{{text}}' } });
  assert.ok(validateEngine(e).some(s => s.includes('endpoint')));
});

test('请求体里没有 {{text}} 报错', () => {
  const e = createEngine({ endpoint: 'https://x', body: { foo: 'bar' } });
  assert.ok(validateEngine(e).some(s => s.includes('{{text}}')));
});

test('JSON 响应没填字段路径报错', () => {
  const e = createEngine({ endpoint: 'https://x', body: { text: '{{text}}' }, response: 'json-base64' });
  assert.ok(validateEngine(e).some(s => s.includes('字段')));
});

test('浏览器朗读不用配任何东西', () => {
  const e = createEngine({ kind: 'browser' });
  assert.deepEqual(validateEngine(e), []);
});

/* ==================================================== 模板与指纹 */

group('内置模板');

test('每个内置模板都能通过校验（除了需要用户填的）', () => {
  for (const b of BUILTIN_ENGINES) {
    const e = createEngine(b);
    if (e.kind === 'browser') { assert.deepEqual(validateEngine(e), []); continue; }
    const problems = validateEngine(e);
    // 只允许"缺 key/voice"这类运行期问题，不允许结构性问题
    assert.ok(!problems.some(p => p.includes('endpoint')), `${b.id} 缺 endpoint`);
    assert.ok(!problems.some(p => p.includes('{{text}}')), `${b.id} 请求体没引 {{text}}`);
  }
});

test('templateOf 返回可编辑的副本', () => {
  const a = templateOf('openai');
  a.key = 'changed';
  const b = templateOf('openai');
  assert.notEqual(b.key, 'changed', '应该每次给新副本');
});

test('未知模板返回 null', () => {
  assert.equal(templateOf('不存在的'), null);
});

group('缓存指纹');

const fpOf = (over = {}) => ({
  url: 'https://x/tts',
  body: '{"text":"你好"}',
  voice: 'a',
  model: 'm',
  emotionUsed: '',
  text: '你好',
  ...over,
});

test('相同参数指纹相同', () => {
  assert.equal(fingerprint(fpOf()), fingerprint(fpOf()));
});

test('换音色指纹不同', () => {
  assert.notEqual(fingerprint(fpOf()), fingerprint(fpOf({ voice: 'b' })));
});

test('换情绪指纹不同', () => {
  assert.notEqual(fingerprint(fpOf()), fingerprint(fpOf({ emotionUsed: 'happy' })));
});

test('换文本指纹不同', () => {
  assert.notEqual(fingerprint(fpOf()), fingerprint(fpOf({ text: '再见' })));
});

test('换地址指纹不同', () => {
  assert.notEqual(fingerprint(fpOf()), fingerprint(fpOf({ url: 'https://y/tts' })));
});

test('指纹是固定长度的十六进制', () => {
  const f = fingerprint(fpOf());
  assert.match(f, /^[0-9a-f]+$/);
  assert.ok(f.length >= 16);
});

/* ==================================================== 结果 */

console.log(`\n${pass} passed, ${fails.length} failed`);
if (fails.length) {
  console.error('\n失败明细：');
  for (const f of fails) console.error(`  ✗ ${f.name}: ${f.message}`);
  process.exitCode = 1;
}
