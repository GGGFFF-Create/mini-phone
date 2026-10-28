/**
 * 朋友圈 App。
 *
 * 一条动态的三种互动：点赞、评论、删除。
 * 另外有一个"发一条"按钮 —— 让当前角色自己发，带生成中状态。
 */

const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
};

const ago = (ts) => {
  if (!ts) return '';
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60) return '刚刚';
  if (s < 3600) return `${Math.floor(s / 60)} 分钟前`;
  if (s < 86400) return `${Math.floor(s / 3600)} 小时前`;
  if (s < 86400 * 7) return `${Math.floor(s / 86400)} 天前`;
  const d = new Date(ts);
  return `${d.getMonth() + 1} 月 ${d.getDate()} 日`;
};

export async function mount(root, ctx) {
  const { api, toast, setTitle } = ctx;

  let moments = [];
  let me = { name: '我', avatar: '' };
  let composing = false;
  let openComments = new Set();
  let refreshing = false;

  const view = el('div', 'view moments-view');
  root.append(view);

  try { me = await api.persona(); } catch { /* 用默认 */ }

  /* --------------------------------------------------------- 渲染 */

  function render() {
    view.innerHTML = '';
    view.append(hero());
    const list = el('div', 'moments-list');
    view.append(list);

    if (!moments.length) {
      const empty = el('div', 'chat-empty');
      empty.append(el('div', 'chat-empty-icon', '🖼️'));
      empty.append(el('b', '', '还没有动态'));
      empty.append(el('p', '',
        '点击右上角的 ＋ 让角色发布一条；也可在正文中写 [朋友圈]，内容会同步到这里。每次生成消耗一次接口调用。'));
      list.append(empty);
      return;
    }

    for (const m of moments) list.append(card(m));
  }

  /** 顶部渐变头图：标题 + 三个工具按钮 + 右下角自己的头像 */
  function hero() {
    const box = el('div', 'moments-hero');

    box.append(el('div', 'moments-hero-title', '好友动态'));

    const acts = el('div', 'moments-hero-acts');

    const refresh = el('button', 'moments-hero-btn', '⟳');
    refresh.type = 'button';
    refresh.title = '刷新动态';
    refresh.addEventListener('click', () => { reload().then(() => toast('已刷新')); });
    acts.append(refresh);

    const compose = el('button', 'moments-hero-btn', composing ? '…' : '＋');
    compose.type = 'button';
    compose.title = '让角色发布动态';
    compose.disabled = composing;
    compose.addEventListener('click', doCompose);
    acts.append(compose);

    const sort = el('button', 'moments-hero-btn', '⇅');
    sort.type = 'button';
    sort.title = '按时间排序';
    sort.addEventListener('click', () => {
      moments = [...moments].sort((a, b) => (b.at ?? 0) - (a.at ?? 0));
      render();
      toast('已按时间排序');
    });
    acts.append(sort);

    box.append(acts);

    const av = el('div', 'moments-hero-avatar');
    if (me?.avatar) {
      const img = document.createElement('img');
      img.src = me.avatar;
      img.alt = me.name;
      img.addEventListener('error', () => { av.textContent = (me.name ?? '我').slice(0, 1); });
      av.append(img);
    } else {
      av.textContent = (me?.name ?? '我').slice(0, 1);
    }
    box.append(av);

    return box;
  }

  function card(m) {
    const wrap = el('article', 'moment');
    wrap.dataset.id = m.id;

    /* 头部 */
    const head = el('div', 'moment-head');
    head.append(el('span', 'avatar', (m.author || '?').slice(0, 1)));
    const headText = el('div', 'moment-head-text');
    headText.append(el('b', 'moment-author', m.author));
    headText.append(el('span', 'moment-time', ago(m.at)));
    head.append(headText);

    if (m.unread) head.append(el('span', 'moment-new', '新'));
    wrap.append(head);

    /* 正文 */
    wrap.append(el('p', 'moment-text', m.text ?? ''));

    /* 配图（只有 tag，没有真实图片时给占位） */
    if (m.images?.length) {
      const grid = el('div', 'moment-images');
      for (const img of m.images.slice(0, 9)) {
        const cell = el('div', 'moment-image');
        cell.append(el('span', 'moment-image-hint', '🖼️'));
        if (img.prompt) cell.title = img.prompt;
        grid.append(cell);
      }
      wrap.append(grid);
    }

    /* 操作 */
    const actions = el('div', 'moment-actions');
    const likes = m.likes ?? [];
    const liked = likes.includes(ctx.state?.user ?? '我');

    const likeBtn = el('button', `moment-act ${liked ? 'on' : ''}`, liked ? '♥ 已赞' : '♡ 赞');
    likeBtn.type = 'button';
    likeBtn.addEventListener('click', async () => {
      try {
        await api.likeMoment(m.id);
        await reload();
      } catch (e) { toast(e?.message ?? '失败'); }
    });

    const commentBtn = el('button', 'moment-act', `💬 ${(m.comments ?? []).length || '评论'}`);
    commentBtn.type = 'button';
    commentBtn.addEventListener('click', () => {
      if (openComments.has(m.id)) openComments.delete(m.id);
      else openComments.add(m.id);
      render();
    });

    actions.append(likeBtn, commentBtn);
    wrap.append(actions);

    /* 点赞列表 */
    if (likes.length) {
      wrap.append(el('div', 'moment-likes', `♥ ${likes.join('、')}`));
    }

    /* 评论 */
    const comments = m.comments ?? [];
    if (comments.length || openComments.has(m.id)) {
      const box = el('div', 'moment-comments');
      for (const c of comments) {
        const row = el('div', 'comment-row');
        row.append(el('b', 'comment-who', c.from));
        row.append(el('span', 'comment-text', c.text));
        box.append(row);
      }

      if (openComments.has(m.id)) {
        const inputRow = el('div', 'comment-input-row');
        const input = el('input', 'comment-input');
        input.type = 'text';
        input.placeholder = '说点什么…';
        const submit = el('button', 'comment-send', '发送');
        submit.type = 'button';

        const send = async () => {
          const text = input.value.trim();
          if (!text) return;
          submit.disabled = true;
          try {
            await api.commentMoment(m.id, text);
            input.value = '';
            await reload();
          } catch (e) { toast(e?.message ?? '失败'); }
          finally { submit.disabled = false; }
        };

        submit.addEventListener('click', send);
        input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.isComposing) send(); });
        inputRow.append(input, submit);
        box.append(inputRow);
        setTimeout(() => input.focus({ preventScroll: true }), 40);
      }
      wrap.append(box);
    }

    return wrap;
  }

  /* --------------------------------------------------------- 动作 */

  async function doCompose() {
    if (composing) return;
    composing = true;
    render();
    try {
      const r = await api.composeMoment();
      if (r?.skipped) toast('TA 这次没发');
      else toast('发了一条新动态');
      await reload();
    } catch (e) {
      toast(e?.message ?? '生成失败');
    } finally {
      composing = false;
      render();
    }
  }

  async function reload() {
    try {
      moments = await api.moments();
      // 打开时把未读清掉
      if (moments.some(m => m.unread)) {
        api.momentsRead().catch(() => {});
        moments = moments.map(m => ({ ...m, unread: false }));
      }
    } catch (e) {
      toast(`读不到动态：${e?.message ?? e}`);
      moments = [];
    }
    render();
  }

  /* --------------------------------------------------------- 启动 */

  await reload();
  setTitle('朋友圈');

  return {
    title: '朋友圈',
    back: () => false,          // 朋友圈没有二级页，返回直接回桌面
    refresh: () => reload(),
    leave: () => { openComments.clear(); },
  };
}
