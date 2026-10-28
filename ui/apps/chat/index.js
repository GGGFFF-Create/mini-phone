/**
 * 消息 App。
 *
 * 两层：会话列表 → 会话窗口。
 * 返回键先退出窗口，再退出 App —— 由 back() 的返回值告诉外壳。
 */

const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
};

const timeOf = (ts) => {
  if (!ts) return '';
  const d = new Date(ts);
  const today = new Date().toDateString() === d.toDateString();
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return today ? `${hh}:${mm}` : `${d.getMonth() + 1}/${d.getDate()}`;
};

/** 气泡内容按类型渲染。新类型只要在这里加一个分支。 */
function bubbleBody(msg) {
  const wrap = el('span', 'bubble-body');
  const meta = msg.meta ?? {};

  switch (msg.kind) {
    case 'photo':
      wrap.append(el('span', 'bubble-photo', '🖼️'));
      if (msg.text) wrap.append(el('span', 'bubble-cap', msg.text));
      break;

    case 'money': {
      const isRed = meta.type === 'redpacket';
      wrap.append(el('span', 'bubble-money', isRed ? '🧧' : '💰'));
      const amt = meta.amount != null ? `¥${meta.amount}` : '';
      wrap.append(el('span', 'bubble-amount', amt));
      if (meta.note) wrap.append(el('span', 'bubble-cap', meta.note));
      break;
    }

    case 'call':
      wrap.append(el('span', 'bubble-call', '📞 通话'));
      if (meta.reason) wrap.append(el('span', 'bubble-cap', meta.reason));
      break;

    case 'sticker':
      wrap.append(el('span', 'bubble-sticker', `[${msg.text || '表情'}]`));
      break;

    case 'gift':
      wrap.append(el('span', 'bubble-gift', '🎁'));
      if (meta.item) wrap.append(el('span', 'bubble-amount', meta.item));
      break;

    case 'song':
      wrap.append(el('span', 'bubble-song', '🎵'));
      wrap.append(el('span', 'bubble-amount', [meta.title, meta.artist].filter(Boolean).join(' · ')));
      if (meta.said) wrap.append(el('span', 'bubble-cap', meta.said));
      break;

    case 'location':
      wrap.append(el('span', 'bubble-loc', '📍'));
      wrap.append(el('span', 'bubble-cap', meta.place || msg.text));
      break;

    case 'moment':
      // 朋友圈投递过来的，聊天里不显示内容，只留一个提示
      wrap.append(el('span', 'bubble-cap', '（发了一条朋友圈）'));
      break;

    default:
      wrap.append(el('span', 'bubble-text', msg.text ?? ''));
  }
  return wrap;
}

export async function mount(root, ctx) {
  const { api, toast, setTitle } = ctx;

  let threads = [];
  let active = null;            // 当前打开的会话
  let typing = false;
  let sending = false;

  const listView = el('div', 'view chat-list');
  const threadView = el('div', 'view chat-thread hidden');
  root.append(listView, threadView);

  /* ------------------------------------------------------- 列表 */

  function renderList() {
    listView.innerHTML = '';
    if (!threads.length) {
      listView.append(el('p', 'empty', '还没有会话。\n在酒馆里聊几轮，或在这里挑一个角色开始。'));
      return;
    }
    for (const t of threads) {
      const row = el('button', 'row');
      row.type = 'button';

      const av = el('span', 'avatar', (t.name || '?').slice(0, 1));
      const main = el('span', 'row-main');
      main.append(el('b', 'row-name', t.name));
      const last = t.messages?.[t.messages.length - 1];
      main.append(el('span', 'row-preview', last ? previewOf(last) : '还没有消息'));

      const meta = el('span', 'row-meta');
      if (last) meta.append(el('span', 'row-time', timeOf(last.at)));
      if (t.unread > 0) meta.append(el('span', 'row-badge', String(t.unread)));

      row.append(av, main, meta);
      row.addEventListener('click', () => openThread(t.id));
      listView.append(row);
    }
  }

  const previewOf = (m) => {
    const map = { photo: '[图片]', money: '[转账]', call: '[通话]', sticker: '[表情]', gift: '[礼物]', song: '[歌曲]', location: '[位置]', moment: '[朋友圈]' };
    return map[m.kind] ? (m.text ? `${map[m.kind]} ${m.text}` : map[m.kind]) : (m.text ?? '');
  };

  /* ------------------------------------------------------- 会话 */

  async function openThread(id) {
    try {
      active = await api.thread(id);
      if (!active) throw new Error('会话不存在');
      await api.markRead(id);
      listView.classList.add('hidden');
      threadView.classList.remove('hidden');
      setTitle(active.name);
      renderThread();
      refreshListInBackground();
    } catch (e) {
      toast(`打不开：${e?.message ?? e}`);
    }
  }

  function closeThread() {
    active = null;
    typing = false;
    threadView.classList.add('hidden');
    listView.classList.remove('hidden');
    setTitle('消息');
    renderList();
    refreshListInBackground();
  }

  function renderThread() {
    threadView.innerHTML = '';
    if (!active) return;

    const scroll = el('div', 'thread-scroll');
    const msgs = active.messages ?? [];

    if (!msgs.length) {
      scroll.append(el('p', 'empty', '还没有消息。说点什么吧。'));
    }

    let lastAt = 0;
    for (const m of msgs) {
      // 时间分隔：每条隔 5 分钟以上插一行
      if (m.at && m.at - lastAt > 5 * 60_000) {
        scroll.append(el('div', 'thread-time', timeOf(m.at)));
        lastAt = m.at;
      }
      const mine = m.from === 'me';
      const row = el('div', `bubble-row ${mine ? 'mine' : 'theirs'}`);
      const bubble = el('div', `bubble ${mine ? 'mine' : 'theirs'}`);
      bubble.append(bubbleBody(m));
      bubble.append(el('span', 'bubble-time', timeOf(m.at)));
      row.append(bubble);
      scroll.append(row);
    }

    if (typing) {
      const row = el('div', 'bubble-row theirs');
      const b = el('div', 'bubble theirs typing');
      b.append(el('i', 'dot'), el('i', 'dot'), el('i', 'dot'));
      row.append(b);
      scroll.append(row);
    }

    threadView.append(scroll);

    /* 输入区 */
    const bar = el('div', 'composer');
    const input = el('input', 'composer-input');
    input.type = 'text';
    input.placeholder = '发消息…';
    input.value = draftOf(active.id);

    const send = el('button', 'composer-send', '发送');
    send.type = 'button';

    const more = el('button', 'composer-more', '⋯');
    more.type = 'button';
    more.title = '更多';

    bar.append(more, input, send);
    threadView.append(bar);

    input.addEventListener('input', () => saveDraft(active.id, input.value));
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.isComposing) doSend(); });
    send.addEventListener('click', doSend);
    more.addEventListener('click', openMore);

    scroll.scrollTop = scroll.scrollHeight;
    setTimeout(() => input.focus({ preventScroll: true }), 60);

    async function doSend() {
      const text = input.value.trim();
      if (!text || sending) return;
      sending = true;
      send.disabled = true;
      input.value = '';
      saveDraft(active.id, '');

      try {
        await api.send(active.id, text);
        active = await api.thread(active.id);
        typing = false;
        renderThread();
      } catch (e) {
        toast(e?.message ?? '发送失败');
        input.value = text;
        send.disabled = false;
      } finally {
        sending = false;
        send.disabled = false;
      }
    }
  }

  /* ------------------------------------------------------- 更多 */

  function openMore() {
    const sheet = el('div', 'sheet');
    const panel = el('div', 'sheet-panel');

    const bring = el('button', 'sheet-item', '把这段聊天带进下一次正文');
    bring.addEventListener('click', async () => {
      try {
        const r = await api.bringToStory(active.id);
        toast(`已准备：${r.count} 条消息会写进下一段正文`);
      } catch (e) { toast(e?.message ?? '失败'); }
      sheet.remove();
    });

    const preview = el('button', 'sheet-item', '看看这次会发多少字');
    preview.addEventListener('click', async () => {
      try {
        const p = await api.preview(active.id);
        const detail = p.blocks.map(b => `${b.name} ${b.chars}`).join(' · ');
        toast(`约 ${p.chars} 字：${detail}`.slice(0, 110));
      } catch (e) { toast(e?.message ?? '失败'); }
      sheet.remove();
    });

    const cancel = el('button', 'sheet-item sheet-cancel', '取消');
    cancel.addEventListener('click', () => sheet.remove());

    panel.append(bring, preview, cancel);
    sheet.append(panel);
    sheet.addEventListener('click', (e) => { if (e.target === sheet) sheet.remove(); });
    root.append(sheet);
  }

  /* ------------------------------------------------------- 草稿 */

  const drafts = new Map();
  const draftOf = (id) => drafts.get(id) ?? '';
  const saveDraft = (id, v) => { if (v) drafts.set(id, v); else drafts.delete(id); };

  /* ------------------------------------------------------- 数据 */

  async function refreshListInBackground() {
    try {
      threads = await api.threads();
      if (!active) renderList();
    } catch { /* 忽略 */ }
  }

  /* ------------------------------------------------------- 初始化 */

  try {
    threads = await api.threads();
  } catch (e) {
    threads = [];
    toast(`读不到会话：${e?.message ?? e}`);
  }
  renderList();

  return {
    title: '消息',

    back() {
      if (active) { closeThread(); return true; }
      return false;              // 交回外壳 → 回桌面
    },

    refresh() {
      refreshListInBackground();
      if (active) {
        api.thread(active.id).then(t => {
          if (t && active && t.id === active.id) { active = t; renderThread(); }
        }).catch(() => {});
      }
    },

    onTyping({ on } = {}) {
      typing = !!on;
      if (active) renderThread();
    },

    leave() {
      active = null;
    },
  };
}
