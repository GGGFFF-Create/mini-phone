/**
 * 诊断工具：用无头 Chrome 加载酒馆，抓控制台错误。
 *
 *   node scripts/diagnose.mjs
 *
 * 会打印：
 *   - 页面加载期间所有 console 输出
 *   - 未捕获的异常
 *   - 请求失败的资源（404 / 500）
 */

const CDP_PORT = 9333;
const CDP = `http://127.0.0.1:${CDP_PORT}`;
const TAVERN = process.argv[2] ?? 'http://127.0.0.1:8000/';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function main() {
  // 等无头浏览器就绪
  let version = null;
  for (let i = 0; i < 20; i++) {
    try { version = await (await fetch(`${CDP}/json/version`)).json(); break; }
    catch { await sleep(500); }
  }
  if (!version) throw new Error('连不上无头 Chrome，端口 9333 没开');
  console.log(`浏览器：${version.Browser}\n`);

  const created = await fetch(`${CDP}/json/new?about:blank`, { method: 'PUT' });
  const target = await created.json();
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('WS 连不上')); });

  let seq = 0;
  const pending = new Map();
  const logs = [];
  const errors = [];
  const netFails = [];

  ws.onmessage = (event) => {
    let msg;
    try { msg = JSON.parse(event.data); } catch { return; }

    // 命令回复
    if (msg.id && pending.has(msg.id)) {
      const resolve = pending.get(msg.id);
      pending.delete(msg.id);
      resolve(msg);
      return;
    }

    // 事件
    if (msg.method === 'Runtime.consoleAPICalled') {
      const p = msg.params;
      const text = (p.args ?? []).map(a => {
        if (a.value !== undefined) return String(a.value);
        if (a.description) return a.description;
        if (a.type === 'undefined') return 'undefined';
        return a.type ?? '?';
      }).join(' ');
      logs.push({ level: p.type, text });
    }

    if (msg.method === 'Runtime.exceptionThrown') {
      const d = msg.params.exceptionDetails;
      errors.push({
        text: d.text ?? '',
        detail: d.exception?.description ?? '',
        url: d.url ?? '',
        line: d.lineNumber,
      });
    }

    if (msg.method === 'Log.entryAdded') {
      const e = msg.params.entry;
      if (e.level === 'error') {
        netFails.push({ source: e.source, text: e.text, url: e.url ?? '' });
      }
    }
  };

  const send = (method, params = {}) => new Promise((resolve) => {
    const id = ++seq;
    pending.set(id, resolve);
    ws.send(JSON.stringify({ id, method, params }));
    setTimeout(() => { if (pending.has(id)) { pending.delete(id); resolve({ error: 'timeout' }); } }, 20_000);
  });

  // 开事件监听
  await send('Runtime.enable');
  await send('Log.enable');
  await send('Page.enable');
  await send('Network.enable');

  // 记录失败的请求
  ws.addEventListener('message', (event) => {
    let msg; try { msg = JSON.parse(event.data); } catch { return; }
    if (msg.method === 'Network.responseReceived') {
      const r = msg.params.response;
      if (r.status >= 400) netFails.push({ source: 'network', text: `${r.status} ${r.statusText}`, url: r.url });
    }
    if (msg.method === 'Network.loadingFailed') {
      netFails.push({ source: 'network', text: msg.params.errorText, url: msg.params.blockedReason ?? '' });
    }
  });

  console.log(`打开 ${TAVERN} …\n`);
  await send('Page.navigate', { url: TAVERN });
  await sleep(9000);   // 等酒馆初始化完（它自己有一堆异步加载）

  // 看看扩展到底有没有被加载
  const probe = await send('Runtime.evaluate', {
    expression: `JSON.stringify({
      hasMenus: !!document.getElementById('extensionsMenu'),
      hasWand: !!document.getElementById('extensionsMenuButton'),
      miniPhoneItem: !!document.getElementById('miniPhone-item'),
      miniPhonePanel: !!document.getElementById('miniPhone-panel'),
      globalInterceptor: typeof globalThis.miniPhoneInterceptor,
      globalBridge: typeof globalThis.__miniPhone,
      stCtx: typeof SillyTavern?.getContext,
      manifestLoaded: (() => {
        try { return Object.keys(window.extension_settings ?? {}).slice(0, 10); } catch { return []; }
      })()
    })`,
    returnByValue: true,
  });

  const state = probe?.result?.result?.value;

  console.log('=== 扩展加载状态 ===');
  try { console.log(JSON.stringify(JSON.parse(state), null, 2)); }
  catch { console.log(state); }

  console.log('\n=== console 输出 ===');
  const interesting = logs.filter(l =>
    /mini|phone|error|fail|cannot|undefined|import/i.test(l.text) || l.level === 'error');
  if (!logs.length) console.log('（没有任何 console 输出）');
  else if (!interesting.length) {
    console.log(`（${logs.length} 条，没有明显相关的；下面列前 15 条）`);
    for (const l of logs.slice(0, 15)) console.log(`  [${l.level}] ${l.text.slice(0, 200)}`);
  } else {
    for (const l of interesting.slice(0, 40)) console.log(`  [${l.level}] ${l.text.slice(0, 300)}`);
  }

  console.log('\n=== 未捕获异常 ===');
  if (!errors.length) console.log('（无）');
  for (const e of errors.slice(0, 15)) {
    console.log(`  ${e.text}`);
    if (e.detail) console.log(`    ${e.detail.split('\n').slice(0, 4).join('\n    ')}`);
    if (e.url) console.log(`    位置: ${e.url}:${e.line}`);
  }

  console.log('\n=== 失败的请求 ===');
  const fails = netFails.filter(f => /mini-phone|extensions/i.test(f.url) || !f.url);
  if (!fails.length) console.log('（没有和扩展相关的失败请求）');
  for (const f of fails.slice(0, 20)) console.log(`  ${f.text}  ${f.url}`);

  ws.close();
  setTimeout(() => process.exit(0), 300);
}

main().catch(e => { console.error('诊断失败:', e.message); process.exit(1); });
