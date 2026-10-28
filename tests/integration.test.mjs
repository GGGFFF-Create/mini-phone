/**
 * 端到端测试 —— 用内存存储 + 假模型，跑完整的聊天和朋友圈链路。
 *
 *   node tests/integration.test.mjs
 *
 * 验证的是"业务逻辑真的能串起来"，不是"界面好不好看"。
 * 四件事：
 *   1. 玩家发消息 → 模型回 → 解析成多条 → 落库
 *   2. 正文里的 <phone> → 投递到对应会话
 *   3. 重抽 → 撤回旧版本投递
 *   4. 朋友圈生成 / 点赞 / 评论
 */

import assert from 'node:assert/strict';

import { createChatService, cleanReply, splitReply } from '../core/chat.js';
import { createMomentsService } from '../core/moments.js';
import { extractPhone } from '../core/phone.js';
import { createRoster } from '../core/routes.js';

let pass = 0;
const fails = [];
function test(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => { pass++; console.log(`  ok   ${name}`); })
    .catch(e => { fails.push({ name, message: e.message }); console.error(`  FAIL ${name}\n       ${e.message}`); });
}
const group = (t) => console.log(`\n${t}`);

/* ==================================================== 内存存储 */

const uid = () => Math.random().toString(36).slice(2, 10);

function memoryStore() {
  const threads = new Map();
  const moments = new Map();

  const strip = (row) => { if (!row) return null; const { scope, ...rest } = row; return structuredClone(rest); };
  const fp = (m) => [m.floor ?? '', m.from ?? '', m.kind ?? 'text', String(m.text ?? '').slice(0, 40)].join('|');

  return {
    threads: {
      async list() {
        return [...threads.values()].map(strip).sort((a, b) => b.updatedAt - a.updatedAt);
      },
      async get(id) { return strip(threads.get(String(id)) ?? null); },
      async save(thread) {
        const row = { ...structuredClone(thread), id: String(thread.id), updatedAt: Date.now(), _messages: thread.messages ?? [] };
        threads.set(row.id, row);
        return strip(row);
      },
      async create({ type = 'dm', name, members = [], partner = '' }) {
        const row = {
          id: uid(), type, name, members, partner,
          messages: [], unread: 0, createdAt: Date.now(), updatedAt: Date.now(),
        };
        threads.set(row.id, row);
        return strip(row);
      },
      async append(id, incoming, { read = false } = {}) {
        const t = threads.get(String(id));
        if (!t) return null;
        const seen = new Set(t.messages.map(fp));
        const fresh = [];
        for (const m of [].concat(incoming)) {
          const msg = { id: uid(), at: Date.now(), kind: 'text', meta: {}, ...m };
          const f = fp(msg);
          if (seen.has(f)) continue;
          seen.add(f);
          fresh.push(msg);
        }
        t.messages.push(...fresh);
        if (!read) t.unread = (t.unread ?? 0) + fresh.filter(m => m.from !== 'me').length;
        t.updatedAt = Date.now();
        return { thread: strip(t), fresh };
      },
      async withdraw(id, match) {
        const t = threads.get(String(id));
        if (!t) return 0;
        const keep = t.messages.filter(m => !match(m));
        const gone = t.messages.length - keep.length;
        t.messages = keep;
        return gone;
      },
      async markRead(id) {
        const t = threads.get(String(id));
        if (!t) return null;
        t.unread = 0;
        return strip(t);
      },
      async remove(id) { threads.delete(String(id)); return true; },
    },

    moments: {
      async list() { return [...moments.values()].map(strip).sort((a, b) => b.at - a.at); },
      async add(input) {
        const row = { id: uid(), at: Date.now(), author: '', text: '', images: [], likes: [], comments: [], floor: null, unread: true, ...structuredClone(input) };
        moments.set(row.id, row);
        return strip(row);
      },
      async addMany(list) { const out = []; for (const m of list) out.push(await this.add(m)); return out; },
      async update(id, patch) {
        const row = moments.get(String(id));
        if (!row) return null;
        Object.assign(row, patch);
        return strip(row);
      },
      async remove(id) { moments.delete(String(id)); return true; },
      async markAllRead() { for (const r of moments.values()) r.unread = false; return true; },
    },
  };
}

/* ==================================================== 假模型 */

function fakeClient(script) {
  const queue = [...script];
  const calls = [];
  return {
    calls,
    config: { url: 'http://fake', model: 'fake' },
    async chat(messages) {
      calls.push(messages);
      const next = queue.shift();
      if (next instanceof Error) throw next;
      return { text: next ?? '嗯。', usage: null };
    },
    async ping() { return '好'; },
  };
}

/* ==================================================== 环境 */

const roster = createRoster([
  { name: '柚子', aliases: ['小柚'], description: '银发少女', personality: '温柔' },
  { name: '夏尔', aliases: ['少爷'], description: '少年', personality: '傲娇' },
]);

const makeChat = (n) => Array.from({ length: n }, (_, i) => ({
  name: i % 2 ? '柚子' : '我',
  is_user: i % 2 === 0,
  mes: `第${i + 1}句话，她说了些什么。${'内容'.repeat(40)}`,
}));

function deps({ store, client, story = makeChat(5) }) {
  return {
    store,
    client: () => client,
    getCard: () => ({ name: '柚子', description: roster.get('柚子')?.description ?? '', personality: '温柔' }),
    getStory: () => story,
    getLore: () => '',
    getRoster: () => roster,
    settings: () => ({
      user: '我', userPersona: '玩家',
      mode: 'story',
      budget: { storyFull: 2, storyBrief: 4, cardText: 1200, history: 20, loreCount: 3 },
    }),
    emit: () => {},
  };
}

/* ==================================================== 聊天 */

await group('聊天：发消息');

{
  const store = memoryStore();
  const client = fakeClient(['在干嘛\n想你了\n[图片] 窗外的雨｜rain, window']);
  const chat = createChatService(deps({ store, client }));

  const thread = await chat.ensureThread({ type: 'dm', name: '柚子' });

  await test('会话能建出来', () => {
    assert.ok(thread.id);
    assert.equal(thread.name, '柚子');
  });

  let result;
  await test('发一条消息拿到回复', async () => {
    result = await chat.send(thread.id, '在吗');
    assert.ok(result.mine);
    assert.equal(result.mine.from, 'me');
    assert.equal(result.mine.text, '在吗');
  });

  await test('回复被拆成三条', () => {
    assert.equal(result.incoming.length, 3);
  });

  await test('第二条带图片类型', () => {
    const photo = result.incoming.find(m => m.kind === 'photo');
    assert.ok(photo, '应该有一条图片消息');
    assert.ok(photo.meta.tags.includes('rain'));
  });

  await test('调用时带了上下文（system + user）', () => {
    assert.equal(client.calls.length, 1);
    const [sys, usr] = client.calls[0];
    assert.equal(sys.role, 'system');
    assert.equal(usr.role, 'user');
    assert.ok(sys.content.includes('柚子'));
    assert.ok(usr.content.includes('在吗'));
  });

  await test('上下文里带上了剧情', () => {
    const sys = client.calls[0][0].content;
    assert.ok(sys.includes('最近的剧情'));
    assert.ok(sys.includes('知道什么'), '应该带知情范围');
  });

  await test('落库后的会话有 4 条消息（1 我 + 3 她）', async () => {
    const after = await store.threads.get(thread.id);
    assert.equal(after.messages.length, 4);
    assert.equal(after.unread, 3);
  });

  await test('重复发同样的内容不会重复入账（幂等）', async () => {
    const before = (await store.threads.get(thread.id)).messages.length;
    await store.threads.append(thread.id, { from: '柚子', kind: 'text', text: '在干嘛' });
    const after = (await store.threads.get(thread.id)).messages.length;
    assert.equal(after, before, '同一条不该进两次');
  });

  await test('模型报错时不留下脏数据', async () => {
    const c2 = fakeClient([new Error('接口挂了')]);
    const chat2 = createChatService(deps({ store, client: c2 }));
    const t2 = await chat2.ensureThread({ type: 'dm', name: '夏尔' });
    await assert.rejects(() => chat2.send(t2.id, '测试'), /接口挂了/);
    const after = await store.threads.get(t2.id);
    // 自己那条已经落库（这是有意的：用户看见自己发出去了），但没有对方的消息
    assert.equal(after.messages.filter(m => m.from !== 'me').length, 0);
  });
}

await group('聊天：正文联动投递');

{
  const store = memoryStore();
  const client = fakeClient([]);
  const chat = createChatService(deps({ store, client }));

  const story = '<phone>柚子：在吗\n柚子：刚看到你\n小柚：[图片] 猫｜cat</phone>';

  await test('从正文抽出三条（含别名归一）', () => {
    const ex = extractPhone(story, { known: roster.names(), resolve: (n) => roster.resolve(n) });
    assert.equal(ex.private.length, 3);
    assert.equal(ex.private[2].from, '柚子', '别名「小柚」应归一到正式名');
    assert.equal(ex.private[2].said, '小柚', '原文里的写法要留着，方便回溯');
  });

  let results;
  await test('投递到会话', async () => {
    const ex = extractPhone(story, { known: roster.names(), resolve: (n) => roster.resolve(n) });
    results = await chat.receive(ex, { floor: 3, ver: 'v1' });
    assert.equal(results.length, 1, '应该只进一个会话');
    assert.equal(results[0].items.length, 3);
  });

  await test('归一到正式名', () => {
    const names = results[0].items.map(m => m.from);
    assert.ok(names.every(n => n === '柚子'), `别名应归一：${names}`);
  });

  await test('标记了来源楼层', async () => {
    const t = await store.threads.get(results[0].threadId);
    assert.ok(t.messages.every(m => m.floor === 3));
    assert.ok(t.messages.every(m => m.source === 'story'));
  });

  await test('重抽撤回旧版本', async () => {
    const gone = await chat.withdraw(3, 'v2');
    assert.equal(gone, 3);
    const t = await store.threads.get(results[0].threadId);
    assert.equal(t.messages.length, 0);
  });

  await test('路人说的话不投递', async () => {
    const ex = extractPhone('<phone>路人甲：路过</phone>', { known: roster.names(), resolve: (n) => roster.resolve(n) });
    const r = await chat.receive(ex, { floor: 4, ver: 'v1' });
    assert.equal(r.length, 0);
  });

  await test('群消息进群会话', async () => {
    const ex = extractPhone('<phone group="宿舍群">柚子：一起吃饭</phone>', { known: roster.names(), resolve: (n) => roster.resolve(n) });
    const r = await chat.receive(ex, { floor: 5, ver: 'v1' });
    assert.equal(r.length, 1);
    const t = await store.threads.get(r[0].threadId);
    assert.equal(t.type, 'group');
    assert.equal(t.name, '宿舍群');
  });
}

await group('聊天：主动发消息');

{
  const store = memoryStore();
  const client = fakeClient(['在忙吗']);
  const chat = createChatService(deps({ store, client }));
  const t = await chat.ensureThread({ type: 'dm', name: '柚子' });

  await test('nudge 能发出消息', async () => {
    const r = await chat.nudge(t.id);
    assert.ok(r.messages?.length >= 1);
    assert.equal(r.messages[0].source, 'nudge');
  });

  await test('模型说「不发」时不落库', async () => {
    const c2 = fakeClient(['不发']);
    const chat2 = createChatService(deps({ store, client: c2 }));
    const r = await chat2.nudge(t.id);
    assert.equal(r.skipped, true);
  });
}

/* ==================================================== 朋友圈 */

await group('朋友圈');

{
  const store = memoryStore();
  const client = fakeClient([
    '今天下雨了，不想出门。',        // compose
    '点赞：是\n评论：记得带伞',      // react
  ]);
  const moments = createMomentsService(deps({ store, client }));

  let m;
  await test('角色能发一条动态', async () => {
    const r = await moments.compose();
    m = r.moment;
    assert.ok(m?.id);
    assert.equal(m.author, '柚子');
    assert.ok(m.text.includes('下雨'));
  });

  await test('模型说「不发」时跳过', async () => {
    const c2 = fakeClient(['不发']);
    const mo2 = createMomentsService(deps({ store, client: c2 }));
    const r = await mo2.compose();
    assert.equal(r.skipped, true);
  });

  await test('玩家点赞', async () => {
    const next = await moments.toggleLike(m.id);
    assert.deepEqual(next.likes, ['我']);
  });

  await test('再点一次取消', async () => {
    const next = await moments.toggleLike(m.id);
    assert.deepEqual(next.likes, []);
  });

  await test('玩家评论', async () => {
    const next = await moments.addComment(m.id, '注意别感冒');
    assert.equal(next.comments.length, 1);
    assert.equal(next.comments[0].text, '注意别感冒');
  });

  await test('角色对动态点赞并评论', async () => {
    const r = await moments.react(m.id, { author: '夏尔' });
    assert.equal(r.like, true);
    assert.equal(r.comment, '记得带伞');
    const list = await moments.list();
    const saved = list.find(x => x.id === m.id);
    assert.ok(saved.likes.includes('夏尔'));
    assert.equal(saved.comments.at(-1).from, '夏尔');
  });

  await test('不会给自己的动态点赞', async () => {
    const r = await moments.react(m.id, { author: '柚子' });
    assert.equal(r.skipped, true);
  });

  await test('从正文导入朋友圈', async () => {
    const items = [{
      from: '夏尔', kind: 'moment',
      text: '雨停了', meta: { body: '雨停了', tags: 'rain' },
    }];
    const added = await moments.ingest(items, { floor: 9 });
    assert.equal(added.length, 1);
    assert.equal(added[0].author, '夏尔');
    assert.equal(added[0].floor, 9);
  });

  await test('正文里没有 [朋友圈] 时不导入', async () => {
    const added = await moments.ingest([{ from: '柚子', kind: 'text', text: '普通消息' }], {});
    assert.equal(added.length, 0);
  });
}

/* ==================================================== 混合 */

await group('混合：一条正文同时投递聊天和朋友圈');

{
  const store = memoryStore();
  const client = fakeClient([]);
  const chat = createChatService(deps({ store, client }));
  const moments = createMomentsService(deps({ store, client }));

  const story = [
    '<phone>',
    '柚子：你在哪',
    '柚子：[朋友圈] 一个人在街角｜street',
    '</phone>',
  ].join('\n');

  const ex = extractPhone(story, { known: roster.names(), resolve: (n) => roster.resolve(n) });

  await test('聊天拿到 1 条（朋友圈的不进聊天）', async () => {
    const chatOnly = { private: ex.private.filter(i => i.kind !== 'moment'), groups: [] };
    const r = await chat.receive(chatOnly, { floor: 10, ver: 'a' });
    assert.equal(r[0].items.length, 1);
    assert.equal(r[0].items[0].text, '你在哪');
  });

  await test('朋友圈拿到那 1 条', async () => {
    const momentItems = ex.private.filter(i => i.kind === 'moment');
    const added = await moments.ingest(momentItems, { floor: 10 });
    assert.equal(added.length, 1);
    assert.equal(added[0].text, '一个人在街角');
  });
}

/* ==================================================== 结果 */

console.log(`\n${pass} passed, ${fails.length} failed`);
if (fails.length) {
  console.error('\n失败明细：');
  for (const f of fails) console.error(`  ✗ ${f.name}: ${f.message}`);
  process.exitCode = 1;
}
