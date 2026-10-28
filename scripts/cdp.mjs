/**
 * 通过 Chrome DevTools Protocol 操作页面。
 *
 * 用法：
 *   node scripts/cdp.mjs status              看浏览器和标签页
 *   node scripts/cdp.mjs check-login         查 GitHub 登录状态
 *   node scripts/cdp.mjs create-token        自动生成一个带 repo 权限的 token
 *
 * 前提：Chrome 以 --remote-debugging-port=9222 启动，且已登录 GitHub。
 */

const CDP = 'http://127.0.0.1:9222';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/** 连一个页面（新建标签页） */
async function open(url) {
  const resp = await fetch(`${CDP}/json/new?${encodeURIComponent(url)}`, { method: 'PUT' });
  if (!resp.ok) throw new Error(`开标签页失败：${resp.status}`);
  const target = await resp.json();

  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = () => reject(new Error('连不上 CDP（Chrome 开了调试端口吗）'));
  });

  let seq = 0;
  const pending = new Map();

  ws.onmessage = (event) => {
    let msg;
    try { msg = JSON.parse(event.data); } catch { return; }
    if (msg.id && pending.has(msg.id)) {
      const resolve = pending.get(msg.id);
      pending.delete(msg.id);
      resolve(msg);
    }
  };

  const send = (method, params = {}) => new Promise((resolve) => {
    const id = ++seq;
    pending.set(id, resolve);
    ws.send(JSON.stringify({ id, method, params }));
    setTimeout(() => {
      if (pending.has(id)) { pending.delete(id); resolve({ error: 'timeout' }); }
    }, 25_000);
  });

  const evaluate = async (expression) => {
    const r = await send('Runtime.evaluate', {
      expression, returnByValue: true, awaitPromise: true, userGesture: true,
    });
    if (r?.error) throw new Error(String(r.error));
    if (r?.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.text ?? '页面执行出错');
    return r?.result?.result?.value;
  };

  return { ws, send, evaluate, target, close: () => { try { ws.close(); } catch { /* */ } } };
}

/* ------------------------------------------------------------------ 命令 */

async function cmdStatus() {
  const info = await (await fetch(`${CDP}/json/version`)).json();
  console.log(`浏览器：${info.Browser}`);
  const tabs = await (await fetch(`${CDP}/json/list`)).json();
  const pages = tabs.filter(t => t.type === 'page');
  console.log(`标签页：${pages.length} 个`);
  for (const p of pages.slice(0, 10)) {
    console.log(`  ${(p.title || '(无标题)').slice(0, 45)}`);
    console.log(`    ${p.url.slice(0, 70)}`);
  }
}

async function cmdCheckLogin() {
  const page = await open('https://github.com/settings/tokens');
  await page.send('Page.bringToFront');
  await sleep(3000);
  const out = JSON.parse(await page.evaluate(`JSON.stringify({
    url: location.href,
    title: document.title,
    loggedIn: !/\\/login/.test(location.href),
    text: (document.body?.innerText ?? '').slice(0, 200).replace(/\\n+/g, ' | ')
  })`));
  console.log(JSON.stringify(out, null, 2));
  page.close();
}

/**
 * 生成 token。
 * 流程：打开发表页 → 填 Note → 勾 repo → 提交 → 读结果。
 */
async function cmdCreateToken() {
  const page = await open('https://github.com/settings/tokens/new');
  await page.send('Page.bringToFront');
  await sleep(3500);

  const state = JSON.parse(await page.evaluate(`JSON.stringify({
    url: location.href,
    hasNote: !!document.querySelector('#oauth_access_description, input[name="oauth_access[description]"]'),
    hasRepo: !!document.querySelector('#oauth_access_scopes_repo, input[name="oauth_access[scopes][]"][value="repo"]'),
    hasSubmit: !!document.querySelector('button[type="submit"]')
  })`));

  if (/\/login/.test(state.url)) throw new Error('还没登录 GitHub');
  if (!state.hasNote || !state.hasRepo || !state.hasSubmit) {
    throw new Error(`表单结构和预期不一样：${JSON.stringify(state)}`);
  }

  // 填表：用原生 setter 触发 React 的 onChange
  const filled = await page.evaluate(`(() => {
    const note = document.querySelector('#oauth_access_description, input[name="oauth_access[description]"]');
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(note, 'mini-phone 发布用（自动生成）');
    note.dispatchEvent(new Event('input', { bubbles: true }));
    note.dispatchEvent(new Event('change', { bubbles: true }));

    const repo = document.querySelector('#oauth_access_scopes_repo, input[name="oauth_access[scopes][]"][value="repo"]');
    if (!repo.checked) repo.click();
    return JSON.stringify({ note: note.value, repoChecked: repo.checked });
  })()`);

  console.log('填表结果：', filled);
  await sleep(500);

  // 提交
  await page.evaluate(`(() => {
    const form = document.querySelector('form[action*="tokens"]') || document.querySelector('form');
    const btn = form?.querySelector('button[type="submit"], input[type="submit"]');
    if (btn) btn.click(); else form?.submit();
    return true;
  })()`);

  // 等跳转
  let token = null;
  let pageText = '';
  for (let i = 0; i < 20; i++) {
    await sleep(1000);
    const probe = JSON.parse(await page.evaluate(`JSON.stringify({
      url: location.href,
      token: document.querySelector('#new-oauth-token, code.token, .token')?.textContent?.trim() ?? '',
      text: (document.body?.innerText ?? '').slice(0, 600)
    })`));
    pageText = probe.text ?? '';
    const m = pageText.match(/\b(ghp_[A-Za-z0-9]{20,})\b/);
    if (m) { token = m[1]; break; }
    if (probe.token && /^ghp_/.test(probe.token)) { token = probe.token; break; }
  }

  if (!token) {
    console.log('没读到 token。页面文字：');
    console.log(pageText);
    page.close();
    throw new Error('生成失败或页面结构变了');
  }

  // 只输出 token 本身，方便管道取值
  console.log('TOKEN=' + token);
  page.close();
  return token;
}

/* ------------------------------------------------------------------ 入口 */

const cmd = process.argv[2];
const run = {
  status: cmdStatus,
  'check-login': cmdCheckLogin,
  'create-token': cmdCreateToken,
}[cmd];

if (!run) {
  console.log('命令：status | check-login | create-token');
  process.exit(0);
}

run()
  .then(() => setTimeout(() => process.exit(0), 300))
  .catch((e) => { console.error('FAIL:', e.message); process.exit(1); });
