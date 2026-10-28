/**
 * 模型配置层测试 —— 不需要网络，只测配置解析和校验。
 *
 *   node tests/llm.test.mjs
 */

import assert from 'node:assert/strict';

import {
  createProfile, profileTemplate, validateProfile, createClient, BUILTIN_PROFILES,
} from '../core/llm.js';

let pass = 0;
const fails = [];
const test = (name, fn) => {
  try { fn(); pass++; console.log(`  ok   ${name}`); }
  catch (e) { fails.push({ name, message: e.message }); console.error(`  FAIL ${name}\n       ${e.message}`); }
};
const group = (t) => console.log(`\n${t}`);

/* ==================================================== 配置形状 */

group('配置形状');

test('默认值合理', () => {
  const p = createProfile();
  assert.equal(p.endpoint, '{{base}}/chat/completions');
  assert.equal(p.temperature, 0.8);
  assert.equal(p.maxTokens, 400);
  assert.equal(p.stream, false);
});

test('可以覆盖任何字段', () => {
  const p = createProfile({ base: 'https://x', model: 'm', temperature: 0.3, stream: true });
  assert.equal(p.base, 'https://x');
  assert.equal(p.temperature, 0.3);
  assert.equal(p.stream, true);
});

test('内置模板覆盖实际用到的字段', () => {
  for (const b of BUILTIN_PROFILES) {
    const p = createProfile(b);
    assert.ok(p.base, `${b.id} 缺 base`);
    assert.ok(p.model, `${b.id} 缺 model`);
    assert.ok(p.name, `${b.id} 缺 name`);
  }
});

test('模板每次给新副本', () => {
  const a = profileTemplate('openai');
  a.key = 'changed';
  const b = profileTemplate('openai');
  assert.notEqual(b.key, 'changed');
});

test('未知模板返回 null', () => {
  assert.equal(profileTemplate('不存在'), null);
});

/* ==================================================== 校验 */

group('配置校验');

test('完整的配置没问题', () => {
  assert.deepEqual(validateProfile({ base: 'https://x/v1', model: 'm', endpoint: '{{base}}/chat/completions' }), []);
});

test('没有配置时报错', () => {
  assert.ok(validateProfile(null).length > 0);
});

test('缺模型名报错', () => {
  assert.ok(validateProfile({ base: 'https://x' }).some(s => s.includes('模型名')));
});

test('base 和 endpoint 都空时报错', () => {
  assert.ok(validateProfile({ model: 'm', endpoint: '' }).some(s => s.includes('地址')));
});

test('只有绝对 endpoint 时不要求 base', () => {
  const p = { model: 'm', base: '', endpoint: 'https://abs.example.com/v1/chat/completions' };
  assert.ok(!validateProfile(p).some(s => s.includes('地址是空的')));
});

/* ==================================================== 请求解析 */

group('请求解析（describe）');

const describe = (cfg) => createClient(cfg).describe();

test('base + 默认 endpoint 拼成完整地址', () => {
  const d = describe({ base: 'https://api.deepseek.com/v1', model: 'deepseek-chat' });
  assert.equal(d.endpoint, 'https://api.deepseek.com/v1/chat/completions');
});

test('base 末尾斜杠不会拼出双斜杠', () => {
  const d = describe({ base: 'https://x.com/v1/', model: 'm' });
  assert.equal(d.endpoint, 'https://x.com/v1/chat/completions');
});

test('自定义 endpoint 生效', () => {
  const d = describe({ base: 'https://x', model: 'm', endpoint: '{{base}}/v2/chat/completions' });
  assert.equal(d.endpoint, 'https://x/v2/chat/completions');
});

test('绝对 endpoint 原样使用', () => {
  const d = describe({ base: 'https://ignored', model: 'm', endpoint: 'https://abs.example.com/chat' });
  assert.equal(d.endpoint, 'https://abs.example.com/chat');
});

test('额外请求体字段被记录', () => {
  const d = describe({ base: 'https://x', model: 'm', body: { top_p: 0.9, stop: ['\n\n'] } });
  assert.deepEqual(d.extraBodyKeys.sort(), ['stop', 'top_p']);
});

test('额外请求头字段被记录', () => {
  const d = describe({ base: 'https://x', model: 'm', headers: { 'X-Title': 'phone' } });
  assert.deepEqual(d.extraHeaderKeys, ['X-Title']);
});

test('有 key 时 hasKey 为真', () => {
  assert.equal(describe({ base: 'https://x', model: 'm', key: 'sk-1' }).hasKey, true);
  assert.equal(describe({ base: 'https://x', model: 'm' }).hasKey, false);
});

test('温度上限会传下去', () => {
  const d = describe({ base: 'https://x', model: 'm', temperature: 1.3, maxTokens: 800 });
  assert.equal(d.temperature, 1.3);
  assert.equal(d.maxTokens, 800);
});

/* ==================================================== 兼容 */

group('向后兼容');

test('老写法 url 仍然能用', () => {
  const d = describe({ url: 'https://old.example.com/v1', model: 'm' });
  assert.equal(d.endpoint, 'https://old.example.com/v1/chat/completions');
});

test('client.config.url 仍然表示"配好了没有"', () => {
  assert.ok(createClient({ base: 'https://x', model: 'm' }).config.url);
  assert.equal(createClient({}).config.url, '');
});

/* ==================================================== 结果 */

console.log(`\n${pass} passed, ${fails.length} failed`);
if (fails.length) {
  console.error('\n失败明细：');
  for (const f of fails) console.error(`  ✗ ${f.name}: ${f.message}`);
  process.exitCode = 1;
}
