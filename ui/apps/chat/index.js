/**
 * 消息 App。
 *
 * 三层：
 *   ① 消息列表（已有会话）
 *   ② 联系人（当前这张卡里的人）—— 点一下就开新会话
 *   ③ 会话窗口
 *
 * 【为什么要「联系人」这一层】
 * 只有消息列表的话，新用户打开就是空的，不知道能跟谁聊。
 * 联系人页是入口：从这儿挑一个人，会话就建起来了。
 *
 * 返回键逐层退：会话 → 列表 → 外壳（回桌面）。
 */

const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
};

/** 头像：有图用图，没图用首字。图挂了也退回首字，不让它显示裂图。 */
function avatarEl(name, src, size = '') {
  const box = el('span', `avatar ${size}`.trim());
  const label = String(name ?? '?');
  if (src) {
    const img = document.createElement('img');
    img.src = src;
    img.alt = label;
    img.decoding = 'async';
    img.addEventListener('error', () => { img.remove(); box.textContent = label.slice(0, 1); });
    box.append(img);
  } else {
    box.textContent = label.slice(0, 1);
  }
  return box;
}

const timeOf = (ts) => {
  if (!ts) return '';
  const d = new Date(ts);
  const today = new Date().toDateString() === d.toDateString();
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return today ? `${hh}:${mm}` : `${d.getMonth() + 1}/${d.getDate()}`;
};

/**
 * 消息气泡上的声波按钮。
 * 只管状态和调用，真正的合成在宿主那边（它才认识引擎配置）。
 */
function sayButton(message) {
  const btn = el('button', 'bubble-say');
  btn.type = 'button';
  btn.dataset.state = 'idle';
  btn.setAttribute('aria-label', `朗读 ${message.from} 的消息`);
  btn.append(el('i'), el('i'), el('i'));

  btn.addEventListener('click', async (e) => {
    e.stopPropagation();
    const bound = window.parent === window ? null : (window.parent.__miniPhone?.bind(window) ?? null);
    if (btn.dataset.state === 'loading' || btn.dataset.state === 'playing') {
      try { await bound?.voiceStop?.(); } catch { /* 忽略 */ }
      btn.dataset.state = 'idle';
      return;
    }
    if (!bound) { btn.dataset.state = 'error'; btn.title = '没有连上酒馆'; return; }

    btn.dataset.state = 'loading';
    try {
      await bound.voiceSpeak({
        role: message.from,
        emotion: message.meta?.emotion ?? '',
        text: message.text,
        translation: message.text,
      });
      btn.dataset.state = 'done';
    } catch (err) {
      btn.dataset.state = 'error';
      btn.title = String(err?.message ?? err);
    }
  });

  return btn;
}

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
      wrap.append(el('span', 'bubble-cap', '（发了一条朋友圈）'));
      break;

    default:
      wrap.append(el('span', 'bubble-text', msg.text ?? ''));
  }
  return wrap;
}

const previewOf = (m) => {
  const map = {
    photo: '[图片]', money: '[转账]', call: '[通话]', sticker: '[表情]',
    gift: '[礼物]', song: '[歌曲]', location: '[位置]', moment: '[朋友圈]',
  };
  const tag = map[m.kind];
  if (tag) return m.text ? `${tag} ${m.text}` : tag;
  return m.text ?? '';
};

export async function mount(root, ctx) {
  const { api, toast, setTitle } = ctx;

  let threads = [];
  let contacts = { list: [], spaceName: '', hasSpace: false };
  let active = null;
  let tab = 'threads';        // threads | contacts
  let typing = false;
  let sending = false;

  /* ------------------------------------------------------- 骨架 */

  const wrap = el('div', 'view chat-app');
  const bar = el('div', 'chat-tabs');
  const tabThreads = el('button', 'chat-tab on', '消息');
  const tabContacts = el('button', 'chat-tab', '联系人');
  tabThreads.type = 'button';
  tabContacts.type = 'button';
  bar.append(tabThreads, tabContacts);

  const body = el('div', 'chat-body');
  wrap.append(bar, body);
  root.append(wrap);

  const switchTab = (name) => {
    tab = name;
    tabThreads.classList.toggle('on', name === 'threads');
    tabContacts.classList.toggle('on', name === 'contacts');
    render();
  };
  tabThreads.addEventListener('click', () => switchTab('threads'));
  tabContacts.addEventListener('click', () => switchTab('contacts'));

  /* ------------------------------------------------------- 渲染 */

  function render() {
    body.innerHTML = '';
    if (active) { renderThread(); return; }
    bar.classList.remove('hidden');
    if (tab === 'contacts') renderContacts();
    else renderThreads();
  }

  function renderThreads() {
    if (!threads.length) {
      const empty = el('div', 'chat-empty');
      empty.append(el('div', 'chat-empty-icon', '💬'));
      empty.append(el('b', '', '还没有会话'));
      empty.append(el('p', '', '去「联系人」里挑一个角色，就能开始聊。'));
      const go = el('button', 'pill-btn', '打开联系人');
      go.type = 'button';
      go.addEventListener('click', () => switchTab('contacts'));
      empty.append(go);
      body.append(empty);
      return;
    }

    const list = el('div', 'list');
    for (const t of threads) {
      const row = el('button', 'row');
      row.type = 'button';
      row.append(avatarEl(t.name, t.avatar));

      const main = el('span', 'row-main');
      main.append(el('b', 'row-name', t.name));
      const last = t.messages?.[t.messages.length - 1];
      main.append(el('span', 'row-preview', last ? previewOf(last) : '还没有消息'));

      const meta = el('span', 'row-meta');
      if (last) meta.append(el('span', 'row-time', timeOf(last.at)));
      if (t.unread > 0) meta.append(el('span', 'row-badge', String(t.unread)));

      row.append(main, meta);
      row.addEventListener('click', () => openThread(t.id));
      list.append(row);
    }
    body.append(list);
  }

  function renderContacts() {
    const list = contacts.list ?? [];

    if (!list.length) {
      const empty = el('div', 'chat-empty');
      empty.append(el('div', 'chat-empty-icon', '👤'));
      empty.append(el('b', '', contacts.hasSpace ? `「${contacts.spaceName}」里还没有人` : '没有打开角色卡'));
      empty.append(el('p', '', contacts.hasSpace
        ? '在酒馆里聊几轮，正文里说过话的人会自动出现。'
        : '先去酒馆里选一张角色卡。'));
      body.append(empty);
      return;
    }

    const head = el('p', 'chat-contact-head',
      contacts.spaceName ? `「${contacts.spaceName}」里的人` : '可以聊天的人');
    body.append(head);

    const box = el('div', 'list');
    for (const person of list) {
      const row = el('button', 'row');
      row.type = 'button';
      row.append(avatarEl(person.name, person.avatar));

      const main = el('span', 'row-main');
      main.append(el('b', 'row-name', person.name));
      main.append(el('span', 'row-preview', person.hasVoice ? '能发语音消息' : '还没有配音色'));

      const meta = el('span', 'row-meta');
      meta.append(el('span', 'row-chevron', '›'));

      row.append(main, meta);
      row.addEventListener('click', () => startChat(person.name));
      box.append(row);
    }
    body.append(box);
  }

  /* ------------------------------------------------------- 会话 */

  async function startChat(name) {
    try {
      const t = await api.ensureThread({ type: 'dm', name, partner: name });
      await openThread(t.id);
    } catch (e) {
      toast(`开不了：${e?.message ?? e}`);
    }
  }

  async function openThread(id) {
    try {
      active = await api.thread(id);
      if (!active) throw new Error('会话不存在');
      await api.markRead(id);
      bar.classList.add('hidden');
      setTitle(active.name);
      render();
      refreshInBackground();
    } catch (e) {
      toast(`打不开：${e?.message ?? e}`);
    }
  }

  function closeThread() {
    active = null;
    typing = false;
    bar.classList.remove('hidden');
    setTitle('消息');
    render();
    refreshInBackground();
  }

  function renderThread() {
    body.innerHTML = '';
    if (!active) return;

    const scroll = el('div', 'thread-scroll');
    const msgs = active.messages ?? [];

    if (!msgs.length) {
      scroll.append(el('p', 'empty', `和「${active.name}」还没有消息。说点什么吧。`));
    }

    let lastAt = 0;
    for (const m of msgs) {
      if (m.at && m.at - lastAt > 5 * 60_000) {
        scroll.append(el('div', 'thread-time', timeOf(m.at)));
        lastAt = m.at;
      }
      const mine = m.from === 'me';
      const row = el('div', `bubble-row ${mine ? 'mine' : 'theirs'}`);
      const bubble = el('div', `bubble ${mine ? 'mine' : 'theirs'}`);
      bubble.append(bubbleBody(m));
      if (!mine && m.text && m.kind !== 'moment') bubble.append(sayButton(m));
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

    body.append(scroll);

    /* 输入区 */
    const composer = el('div', 'composer');
    const input = el('input', 'composer-input');
    input.type = 'text';
    input.placeholder = '发消息…';
    input.value = draftOf(active.id);

    const send = el('button', 'composer-send', '发送');
    send.type = 'button';

    const more = el('button', 'composer-more', '⋯');
    more.type = 'button';
    more.title = '更多';

    composer.append(more, input, send);
    body.append(composer);

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
        render();
      } catch (e) {
        toast(e?.message ?? '发送失败');
        input.value = text;
      } finally {
        sending = false;
        send.disabled = false;
      }
    }
  }

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

  async function refreshInBackground() {
    try {
      threads = await api.threads();
      contacts = await api.contacts();
      if (!active) render();
    } catch { /* 忽略 */ }
  }

  try {
    threads = await api.threads();
    contacts = await api.contacts();
  } catch (e) {
    toast(`读不到数据：${e?.message ?? e}`);
  }
  render();

  return {
    title: '消息',

    back() {
      if (active) { closeThread(); return true; }
      if (tab === 'contacts') { switchTab('threads'); return true; }
      return false;              // 交回外壳 → 回桌面
    },

    refresh() {
      refreshInBackground();
      if (active) {
        api.thread(active.id).then(t => {
          if (t && active && t.id === active.id) { active = t; render(); }
        }).catch(() => {});
      }
    },

    onTyping({ on } = {}) {
      typing = !!on;
      if (active) render();
    },

    leave() {
      active = null;
    },
  };
}
