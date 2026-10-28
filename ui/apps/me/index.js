/**
 * 我 —— 主角（user persona）的页面。
 *
 * 这一页存在的理由：手机里的人有自己的身份。头像、名字、描述都该看得见，
 * 而不是隐身在设置里。
 *
 * 头像是三级来源：自定义 → 酒馆里的 persona 封面 → 空（显示首字）。
 */

const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
};

export async function mount(root, ctx) {
  const { api, toast, setTitle, pickImage } = ctx;

  let me = null;
  let stats = { threads: 0, unread: 0, moments: 0 };

  const view = el('div', 'view me-view');
  root.append(view);

  /* ------------------------------------------------------- 渲染 */

  function render() {
    view.innerHTML = '';

    const head = el('div', 'me-head');

    /* 头像 */
    const avatarBox = el('button', 'me-avatar');
    avatarBox.type = 'button';
    avatarBox.title = '点击换头像';

    if (me?.avatar) {
      const img = document.createElement('img');
      img.src = me.avatar;
      img.alt = me.name;
      img.decoding = 'async';
      img.addEventListener('error', () => { img.replaceWith(el('span', 'me-avatar-fallback', (me.name ?? '我').slice(0, 1))); });
      avatarBox.append(img);
    } else {
      avatarBox.append(el('span', 'me-avatar-fallback', (me?.name ?? '我').slice(0, 1)));
    }

    const cam = el('span', 'me-avatar-edit', '✎');
    avatarBox.append(cam);
    avatarBox.addEventListener('click', changeAvatar);
    head.append(avatarBox);

    /* 名字与描述 */
    const info = el('div', 'me-info');
    info.append(el('b', 'me-name', me?.name ?? '我'));
    if (me?.description) info.append(el('p', 'me-desc', me.description));
    else info.append(el('p', 'me-desc me-desc-empty', '还没有设置人设描述（在酒馆的 Persona 里填）'));
    head.append(info);

    view.append(head);

    /* 统计 */
    const cards = el('div', 'me-stats');
    cards.append(statCard('会话', stats.threads, '💬'));
    cards.append(statCard('未读', stats.unread, '🔔'));
    cards.append(statCard('动态', stats.moments, '🖼️'));
    view.append(cards);

    /* 操作 */
    const actions = el('div', 'me-actions');

    const change = el('button', 'primary-btn', '换头像');
    change.type = 'button';
    change.addEventListener('click', changeAvatar);
    actions.append(change);

    if (me?.isCustomAvatar) {
      const reset = el('button', 'pill-btn me-reset', '恢复酒馆里的默认封面');
      reset.type = 'button';
      reset.addEventListener('click', resetAvatar);
      actions.append(reset);
    }

    view.append(actions);

    /* 说明 */
    view.append(el('p', 'settings-note',
      '头像是本地的：只存在这台设备的酒馆设置里，不会上传。' +
      '换上去的图会缩到 160×160，占几 KB。'));
  }

  function statCard(label, value, icon) {
    const card = el('div', 'me-stat');
    card.append(el('span', 'me-stat-icon', icon));
    card.append(el('b', 'me-stat-value', String(value)));
    card.append(el('span', 'me-stat-label', label));
    return card;
  }

  /* ------------------------------------------------------- 动作 */

  async function changeAvatar() {
    try {
      const dataUrl = await pickImage(160);
      if (!dataUrl) return;              // 用户取消了
      const r = await api.avatarSet(me?.name ?? '', dataUrl);
      me = { ...me, avatar: r.avatar, isCustomAvatar: true };
      render();
      toast('头像换好了');
    } catch (e) {
      toast(e?.message ?? '换头像失败');
    }
  }

  async function resetAvatar() {
    try {
      const r = await api.avatarClear(me?.name ?? '');
      me = { ...me, avatar: r.avatar, isCustomAvatar: false };
      render();
      toast('已恢复默认');
    } catch (e) {
      toast(e?.message ?? '恢复失败');
    }
  }

  /* ------------------------------------------------------- 数据 */

  async function load() {
    try { me = await api.persona(); } catch { me = { name: '我', avatar: '', description: '' }; }
    try {
      const [threads, unread, moments] = await Promise.all([
        api.threads(), api.unread(), api.moments(),
      ]);
      stats = {
        threads: threads.length,
        unread: unread ?? 0,
        moments: (moments ?? []).length,
      };
    } catch { /* 用默认 0 */ }
    render();
  }

  await load();
  setTitle('我');

  return {
    title: '我',
    back: () => false,
    refresh: () => { load(); },
  };
}
