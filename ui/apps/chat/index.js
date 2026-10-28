/**
 * 消息 App。
 *
 * 结构（照常见 IM 的分层）：
 *   顶部   头像 + 名字 + 在线状态 + 加号
 *   搜索   过滤当前页签的列表
 *   页签   消息 / 联系人
 *   内容   会话列表 / 联系人列表 / 聊天窗口
 *
 * 返回键逐层退：会话 → 联系人页签 → 列表 → 外壳（回桌面）。
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

/**
 * 头像：有图用图，没图用首字。图挂了也退回首字，不让它显示裂图。
 * 传了 onEdit 就变成可点的按钮 —— 点它换头像，点别的地方走原来的逻辑。
 */
function avatarEl(name, src, { onEdit = null, size = '' } = {}) {
  const label = String(name ?? '?');
  const box = document.createElement(onEdit ? 'button' : 'span');
  box.className = `avatar ${size}`.trim() + (onEdit ? ' avatar-edit' : '');

  const content = el('span', 'avatar-content');
  content.textContent = label.slice(0, 1);

  if (src) {
    const img = document.createElement('img');
    img.src = src;
    img.alt = label;
    img.decoding = 'async';
    content.textContent = '';
    img.addEventListener('error', () => {
      img.remove();
      content.textContent = label.slice(0, 1);
    });
    content.append(img);
  }
  box.append(content);

  if (onEdit) {
    box.type = 'button';
    box.title = `换「${label}」的头像`;
    box.setAttribute('aria-label', `换「${label}」的头像`);
    box.append(el('span', 'avatar-edit-dot', '✎'));
    box.addEventListener('click', (e) => {
      e.stopPropagation();
      e.preventDefault();
      onEdit(label);
    });
  }

  return box;
}

/** 消息气泡上的声波按钮 */
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

/** 气泡内容按类型渲染 */
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
      wrap.append(el('span', 'bubble-amount', meta.amount != null ? `¥${meta.amount}` : ''));
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
  let me = { name: '我', avatar: '' };
  let active = null;
  let tab = 'threads';
  let query = '';
  let typing = false;
  let sending = false;

  /* ------------------------------------------------------- 骨架 */

  const wrap = el('div', 'view chat-app');
  wrap.append(buildHead());

  const searchRow = el('div', 'chat-search');
  searchRow.append(el('span', 'chat-search-icon', '🔍'));
  const searchInput = el('input');
  searchInput.type = 'text';
  searchInput.placeholder = '搜索聊天和联系人';
  searchRow.append(searchInput);
  wrap.append(searchRow);

  const body = el('div', 'chat-body');
  wrap.append(body);

  /* 底部导航：消息 / 联系人 / 动态 */
  const nav = el('div', 'chat-nav');
  const NAV = [
    { id: 'threads', icon: '💬', label: '消息' },
    { id: 'contacts', icon: '👤', label: '联系人' },
    { id: 'moments', icon: '🖼️', label: '动态' },
  ];
  const navBtns = new Map();

  for (const item of NAV) {
    const btn = el('button', `chat-nav-btn ${item.id === 'threads' ? 'on' : ''}`);
    btn.type = 'button';
    btn.dataset.tab = item.id;
    btn.append(el('span', 'chat-nav-icon', item.icon));
    btn.append(el('span', 'chat-nav-label', item.label));
    btn.addEventListener('click', () => switchTab(item.id));
    nav.append(btn);
    navBtns.set(item.id, btn);
  }
  wrap.append(nav);
  root.append(wrap);

  searchInput.addEventListener('input', () => {
    query = searchInput.value.trim().toLowerCase();
    if (!active && tab !== 'moments') render();
  });

  function buildHead() {
    const head = el('div', 'chat-head');

    const av = el('button', 'chat-head-avatar');
    av.type = 'button';
    av.title = '我是谁';
    av.addEventListener('click', () => ctx.openApp?.('me'));
    head.append(av);

    const info = el('div', 'chat-head-info');
    info.append(el('b', 'chat-head-name', '手机'));
    const status = el('span', 'chat-head-status');
    status.append(el('span', 'chat-head-dot'));
    status.append(el('span', '', '在线'));
    info.append(status);
    head.append(info);

    const add = el('button', 'chat-head-add', '＋');
    add.type = 'button';
    add.title = '找个人聊天';
    add.addEventListener('click', () => switchTab('contacts'));
    head.append(add);

    return head;
  }

  /** 顶部头像和名字跟着主角走 */
  function paintHead() {
    const av = wrap.querySelector('.chat-head-avatar');
    const nm = wrap.querySelector('.chat-head-name');
    if (!av || !nm) return;
    nm.textContent = me?.name || '手机';
    av.innerHTML = '';
    if (me?.avatar) {
      const img = document.createElement('img');
      img.src = me.avatar;
      img.alt = me.name;
      img.addEventListener('error', () => { av.textContent = (me.name ?? '我').slice(0, 1); });
      av.append(img);
    } else {
      av.textContent = (me?.name ?? '我').slice(0, 1);
    }
  }

  const switchTab = (name) => {
    tab = name;
    active = null;
    for (const [id, btn] of navBtns) btn.classList.toggle('on', id === name);
    // 「动态」有自己的头图，不显示顶部搜索
    const isMoments = name === 'moments';
    searchRow.classList.toggle('hidden', isMoments);
    wrap.querySelector('.chat-head')?.classList.toggle('hidden', isMoments);
    nav.classList.remove('hidden');
    render();
  };

  /* ------------------------------------------------------- 渲染 */

  let momentsHost = null;
  let momentsInst = null;

  function render() {
    body.innerHTML = '';
    if (active) { renderThread(); return; }

    nav.classList.remove('hidden');

    if (tab === 'moments') { renderMoments(); return; }

    searchRow.classList.remove('hidden');
    if (tab === 'contacts') renderContacts();
    else renderThreads();
  }

  /** 动态页：把朋友圈模块挂进来（它自己管头图和列表） */
  async function renderMoments() {
    if (!momentsHost) {
      momentsHost = el('div', 'tab-moments');
      body.append(momentsHost);
    }

    if (momentsInst) { momentsInst.refresh?.(); return; }

    try {
      const v = encodeURIComponent(window.__MP_V || '');
      const mod = await import(/* @vite-ignore */ `../moments/index.js?v=${v}`);
      momentsInst = await mod.mount(momentsHost, { ...ctx, setTitle: () => {} });
    } catch (e) {
      momentsHost.append(el('p', 'empty', `动态打不开：${e?.message ?? e}`));
    }
  }

  function renderThreads() {
    const list = threads.filter(t => !query || String(t.name ?? '').toLowerCase().includes(query));

    if (!list.length) {
      body.append(emptyState({
        icon: '💬',
        title: query ? '没有匹配的会话' : '还没有聊天',
        text: query
          ? '换个词试试，或者去联系人里找人。'
          : '点右上角的加号找人聊天。会话也可以在酒馆聊几轮后自动出现。',
        action: query ? null : { label: '去联系人', run: () => switchTab('contacts') },
      }));
      return;
    }

    if (query) body.append(el('p', 'chat-contact-head', `搜索「${query}」`));

    const box = el('div', 'list');
    for (const t of list) {
      const row = el('button', 'row');
      row.type = 'button';
      row.append(avatarEl(t.name, t.avatar, { onEdit: (n) => openAvatarMenu(n) }));

      const main = el('span', 'row-main');
      main.append(el('b', 'row-name', t.name));
      const last = t.messages?.[t.messages.length - 1];
      main.append(el('span', 'row-preview', last ? previewOf(last) : '还没有消息'));

      const meta = el('span', 'row-meta');
      if (last) meta.append(el('span', 'row-time', timeOf(last.at)));
      if (t.unread > 0) meta.append(el('span', 'row-badge', String(t.unread)));

      row.append(main, meta);
      row.addEventListener('click', () => openThread(t.id));
      box.append(row);
    }
    body.append(box);
  }

  function renderContacts() {
    const all = contacts.list ?? [];
    const list = all.filter(p => !query || String(p.name ?? '').toLowerCase().includes(query));

    if (!all.length) {
      body.append(emptyState({
        icon: '👤',
        title: contacts.hasSpace ? `「${contacts.spaceName}」里还没有人` : '没有打开角色卡',
        text: contacts.hasSpace
          ? '在酒馆里聊几轮，正文里说过话的人会自动出现在这里。'
          : '先去酒馆里选一张角色卡。',
      }));
      return;
    }

    /* 大标题（照 CONTACTS 那种） */
    const title = el('div', 'chat-section-title');
    title.append(el('small', '', 'CONTACTS'));
    title.append(el('b', '', '联系人'));
    body.append(title);

    body.append(el('p', 'chat-section-count',
      `好友 · ${list.length}${query ? `（搜索「${query}」）` : ''}`));

    if (!list.length) {
      body.append(emptyState({ icon: '🔍', title: '没有匹配的人', text: '换个词试试。' }));
      return;
    }

    const box = el('div', 'list');
    for (const person of list) {
      const row = el('button', 'row');
      row.type = 'button';
      row.append(avatarEl(person.name, person.avatar, { onEdit: (n) => openAvatarMenu(n) }));

      const main = el('span', 'row-main');
      main.append(el('b', 'row-name', person.name));
      main.append(el('span', 'row-preview', person.hasVoice ? '角色 · 能发语音消息' : '角色 · 还没有配音'));

      const meta = el('span', 'row-meta');
      meta.append(el('span', 'row-chevron', '›'));

      row.append(main, meta);
      row.addEventListener('click', () => startChat(person.name));
      box.append(row);
    }
    body.append(box);
  }

  function emptyState({ icon, title, text, action }) {
    const box = el('div', 'chat-empty');
    box.append(el('div', 'chat-empty-icon', icon));
    box.append(el('b', '', title));
    box.append(el('p', '', text));
    if (action) {
      const btn = el('button', 'pill-btn', action.label);
      btn.type = 'button';
      btn.addEventListener('click', action.run);
      box.append(btn);
    }
    return box;
  }

  /* ------------------------------------------------------- 头像 */

  function openAvatarMenu(name) {
    const sheet = el('div', 'sheet');
    const panel = el('div', 'sheet-panel');

    panel.append(el('div', 'sheet-title', `「${name}」的头像`));

    const change = el('button', 'sheet-item', '从本地选一张图');
    change.type = 'button';
    change.addEventListener('click', async () => {
      sheet.remove();
      try {
        const dataUrl = await ctx.pickImage(160);
        if (!dataUrl) return;
        await api.avatarSet(name, dataUrl);
        await reloadPeople();
        toast(`「${name}」的头像换好了`);
      } catch (e) { toast(e?.message ?? '换头像失败'); }
    });

    const reset = el('button', 'sheet-item', '恢复酒馆里的封面');
    reset.type = 'button';
    reset.addEventListener('click', async () => {
      sheet.remove();
      try {
        await api.avatarClear(name);
        await reloadPeople();
        toast(`「${name}」已恢复默认`);
      } catch (e) { toast(e?.message ?? '恢复失败'); }
    });

    const cancel = el('button', 'sheet-item sheet-cancel', '取消');
    cancel.type = 'button';
    cancel.addEventListener('click', () => sheet.remove());

    panel.append(change, reset, cancel);
    sheet.append(panel);
    sheet.addEventListener('click', (e) => { if (e.target === sheet) sheet.remove(); });
    root.append(sheet);
  }

  async function reloadPeople() {
    try {
      threads = await api.threads();
      contacts = await api.contacts();
      render();
    } catch { /* 忽略 */ }
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
      nav.classList.add('hidden');
      searchRow.classList.add('hidden');
      wrap.querySelector('.chat-head')?.classList.add('hidden');
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
    nav.classList.remove('hidden');
    searchRow.classList.remove('hidden');
    wrap.querySelector('.chat-head')?.classList.remove('hidden');
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
    bring.type = 'button';
    bring.addEventListener('click', async () => {
      try {
        const r = await api.bringToStory(active.id);
        toast(`已准备：${r.count} 条消息会写进下一段正文`);
      } catch (e) { toast(e?.message ?? '失败'); }
      sheet.remove();
    });

    const preview = el('button', 'sheet-item', '看看这次会发多少字');
    preview.type = 'button';
    preview.addEventListener('click', async () => {
      try {
        const p = await api.preview(active.id);
        const detail = p.blocks.map(b => `${b.name} ${b.chars}`).join(' · ');
        toast(`约 ${p.chars} 字：${detail}`.slice(0, 110));
      } catch (e) { toast(e?.message ?? '失败'); }
      sheet.remove();
    });

    const cancel = el('button', 'sheet-item sheet-cancel', '取消');
    cancel.type = 'button';
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

  /*
   * 三个数据分开取，别用 Promise.all。
   *
   * 教训：persona() 是同步函数（返回对象，不是 Promise），写成
   *   api.persona().catch(...)
   * 会抛 "catch is not a function"，Promise.all 整体 reject，
   * 结果 threads 和 contacts 也一起丢了 —— 界面上就是"什么都没有"。
   * 分开 try/catch，一个挂了不影响另外两个。
   */
  try { threads = await api.threads(); } catch { threads = []; }
  try { contacts = await api.contacts(); } catch { contacts = { list: [], spaceName: '', hasSpace: false }; }
  try { me = await api.persona(); } catch { me = { name: '我', avatar: '' }; }
  if (!me) me = { name: '我', avatar: '' };

  paintHead();
  render();

  return {
    title: '消息',

    back() {
      if (active) { closeThread(); return true; }
      if (tab !== 'threads') { switchTab('threads'); return true; }
      if (query) { searchInput.value = ''; query = ''; render(); return true; }
      return false;
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
