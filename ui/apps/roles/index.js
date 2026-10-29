/**
 * 角色 App —— 音色管理。
 *
 * 为什么单独拎出来：
 * 音色不是"设置里的一项"，是每个角色的一份配置。做成卡片网格能一眼看出
 * 谁配了谁没配，点开就能改头像、填音色、试听。
 *
 * 角色从哪来：
 *   ① 当前角色卡的成员
 *   ② 在酒馆对话过的（正文里出现过名字，自动登记）
 *   ③ 手动添加的
 * 所以打开一张已有聊天记录的角色卡，这里的卡片会自动出现。
 *
 * 卡片布局照常见做法：编号 + 头像 + 名字 + 引擎标签 + 音色 ID。
 */

const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
};

/** 音色 ID 太长，卡片上只露前面一截 */
const shortId = (id) => {
  const s = String(id ?? '');
  if (!s) return '';
  return s.length > 18 ? `${s.slice(0, 14)}…` : s;
};

export async function mount(root, ctx) {
  const { api, toast, setTitle, pickImage } = ctx;

  let data = { list: [], spaceName: '', hasSpace: false, activeEngine: '' };
  let loading = true;

  const view = el('div', 'view roles-view');
  root.append(view);

  /* --------------------------------------------------------- 渲染 */

  function render() {
    view.innerHTML = '';

    /* 标题区 */
    const hero = el('div', 'roles-hero');
    const heroTop = el('div', 'roles-hero-top');
    heroTop.append(el('small', 'roles-hero-small', `CHARACTER · ${String(data.list.length).padStart(2, '0')}`));
    hero.append(heroTop);

    const heroTitle = el('div', 'roles-hero-title');
    heroTitle.append(el('b', '', '角色'));
    heroTitle.append(el('span', 'roles-hero-star', '✦'));
    hero.append(heroTitle);

    const acts = el('div', 'roles-hero-acts');
    const addBtn = el('button', 'roles-hero-btn', '＋');
    addBtn.type = 'button';
    addBtn.title = '添加角色';
    addBtn.addEventListener('click', openAdd);
    acts.append(addBtn);
    hero.append(acts);

    view.append(hero);

    /* 说明 */
    view.append(el('p', 'roles-note', data.hasSpace
      ? `当前角色卡「${data.spaceName}」：出现在正文里的角色会自动加入，也可以手动添加。`
      : '当前没有打开角色卡。请先在酒馆中选择一张，角色才会出现在这里。'));

    if (loading) {
      view.append(el('p', 'roles-note', '读取中…'));
      return;
    }

    if (!data.list.length) {
      const empty = el('div', 'roles-empty');
      empty.append(el('div', 'chat-empty-icon', '👥'));
      empty.append(el('b', '', '还没有角色'));
      empty.append(el('p', '', data.hasSpace
        ? '在酒馆对话几轮，正文中出现过的角色会自动加入；也可以点右上角的 ＋ 手动添加。'
        : '请先在酒馆中选择一张角色卡。'));
      view.append(empty);
      return;
    }

    /* 卡片网格 */
    const grid = el('div', 'roles-grid');
    for (const role of data.list) grid.append(card(role));

    /* 末尾的新增卡 */
    const addCard = el('button', 'role-card role-card-add');
    addCard.type = 'button';
    addCard.append(el('span', 'role-add-plus', '＋'));
    addCard.append(el('span', 'role-add-label', '新增角色'));
    addCard.addEventListener('click', openAdd);
    grid.append(addCard);

    view.append(grid);
  }

  function card(role) {
    const box = el('button', 'role-card');
    box.type = 'button';

    /* 编号条 */
    const top = el('div', `role-card-top ${role.hasVoice ? '' : 'dim'}`.trim());
    top.append(el('span', 'role-card-no', `No.${String(role.no).padStart(3, '0')}`));
    box.append(top);

    /* 头像（压在编号条下沿） */
    const av = el('div', 'role-card-avatar');
    if (role.avatar) {
      const img = document.createElement('img');
      img.src = role.avatar;
      img.alt = role.name;
      img.decoding = 'async';
      img.addEventListener('error', () => { img.remove(); av.textContent = role.name.slice(0, 1); });
      av.append(img);
    } else {
      av.textContent = role.name.slice(0, 1);
    }
    box.append(av);

    /* 名字（主控角色带标记） */
    const nameRow = el('div', 'role-card-name-row');
    nameRow.append(el('b', 'role-card-name', role.name));
    if (role.isPersona) nameRow.append(el('span', 'role-persona-tag', '主控'));
    box.append(nameRow);

    /* 音色状态 */
    if (role.hasVoice) {
      const tag = el('span', 'role-engine-tag');
      tag.textContent = role.engineKind === 'browser' ? '浏览器朗读' : (role.engineName || '未选引擎');
      box.append(tag);

      box.append(el('span', 'role-voice-id', shortId(role.voice)));

      const lang = el('span', 'role-lang', role.language ? role.language : '跟随默认语言');
      box.append(lang);
    } else {
      box.append(el('span', 'role-warn', '待选择音色'));
      box.append(el('span', 'role-hint', '出现在聊天里时会等你配音'));
    }

    box.addEventListener('click', () => openEdit(role));
    return box;
  }

  /* --------------------------------------------------------- 添加 */

  function openAdd() {
    const sheet = el('div', 'sheet');
    const panel = el('div', 'sheet-panel');

    panel.append(el('div', 'sheet-title', '添加角色'));

    const field = el('div', 'field');
    field.append(el('span', 'field-label', '角色名'));
    const input = el('input', 'field-input');
    input.type = 'text';
    input.placeholder = '和酒馆里用的名字保持一致';
    field.append(input);
    field.append(el('span', 'field-hint', '名字要和正文里出现的写法一致，否则对不上台词。'));
    panel.append(field);

    const pick = el('button', 'pill-btn', '从酒馆角色卡里选');
    pick.type = 'button';
    pick.addEventListener('click', async () => {
      const names = await api.characterNames().catch(() => []);
      if (!names.length) { toast('酒馆里没有角色卡'); return; }
      const list = el('div', 'sheet-pick-list');
      for (const n of names) {
        const b = el('button', 'sheet-item', n);
        b.type = 'button';
        b.addEventListener('click', () => { input.value = n; list.remove(); });
        list.append(b);
      }
      panel.append(list);
    });
    panel.append(pick);

    const ok = el('button', 'primary-btn', '添加');
    ok.type = 'button';
    ok.addEventListener('click', async () => {
      const name = input.value.trim();
      if (!name) { toast('请填写角色名'); return; }
      try {
        await api.roleAdd(name);
        sheet.remove();
        await reload();
        toast(`已添加「${name}」`);
      } catch (e) { toast(e?.message ?? '添加失败'); }
    });
    panel.append(ok);

    const cancel = el('button', 'sheet-item sheet-cancel', '取消');
    cancel.type = 'button';
    cancel.addEventListener('click', () => sheet.remove());
    panel.append(cancel);

    sheet.append(panel);
    sheet.addEventListener('click', (e) => { if (e.target === sheet) sheet.remove(); });
    root.append(sheet);
    setTimeout(() => input.focus({ preventScroll: true }), 80);
  }

  /* --------------------------------------------------------- 编辑 */

  function openEdit(role) {
    const sheet = el('div', 'sheet');
    const panel = el('div', 'sheet-panel');

    panel.append(el('div', 'sheet-title', role.name));

    /* 头像 */
    const head = el('div', 'role-edit-head');
    const av = el('button', 'role-edit-avatar');
    av.type = 'button';
    av.title = '更换头像';
    if (role.avatar) {
      const img = document.createElement('img');
      img.src = role.avatar;
      img.alt = role.name;
      img.addEventListener('error', () => { img.remove(); av.textContent = role.name.slice(0, 1); });
      av.append(img);
    } else {
      av.textContent = role.name.slice(0, 1);
    }
    av.append(el('span', 'me-avatar-edit', '✎'));
    av.addEventListener('click', async () => {
      try {
        const dataUrl = await pickImage(160);
        if (!dataUrl) return;
        await api.avatarSet(role.name, dataUrl);
        sheet.remove();
        await reload();
        toast('头像已更新');
      } catch (e) { toast(e?.message ?? '换头像失败'); }
    });

    const info = el('div', 'role-edit-info');
    info.append(el('b', '', role.name));
    info.append(el('span', '', role.isPersona
      ? '主控角色 · 只用于配音，不参与聊天'
      : (role.hasVoice ? '已配置语音' : '待选择音色')));
    head.append(av, info);
    panel.append(head);

    /* 音色 id */
    const vField = el('div', 'field');
    vField.append(el('span', 'field-label', '音色 ID'));
    const vInput = el('input', 'field-input');
    vInput.type = 'text';
    vInput.placeholder = '留空 = 跟随当前引擎的默认音色';
    vInput.value = role.voice ?? '';
    vField.append(vInput);
    if (role.engineKind === 'browser') {
      vField.append(el('span', 'field-hint', '浏览器朗读要填系统音色名，例如 Microsoft Huihui - Chinese (Simplified, PRC)'));
    } else {
      vField.append(el('span', 'field-hint', '引擎里那个 voice / reference_id 的取值'));
    }
    panel.append(vField);

    /* 语言 */
    const lField = el('div', 'field');
    lField.append(el('span', 'field-label', '语言'));
    const lInput = el('input', 'field-input');
    lInput.type = 'text';
    lInput.placeholder = '留空 = 跟随默认，例如 zh / en / ja';
    lInput.value = role.language ?? '';
    lField.append(lInput);
    panel.append(lField);

    /* 保存 */
    const save = el('button', 'primary-btn', '保存');
    save.type = 'button';
    save.addEventListener('click', async () => {
      try {
        const voice = vInput.value.trim();
        await api.voiceBind(role.name, voice
          ? { engine: role.engineId, voice, language: lInput.value.trim() }
          : null);
        sheet.remove();
        await reload();
        toast(voice ? `「${role.name}」的音色已保存` : `「${role.name}」已改为跟随默认`);
      } catch (e) { toast(e?.message ?? '保存失败'); }
    });
    panel.append(save);

    /* 试听 */
    if (role.hasVoice) {
      const test = el('button', 'pill-btn', '试听');
      test.type = 'button';
      test.style.margin = '0 16px 10px';
      test.addEventListener('click', async () => {
        test.disabled = true;
        test.textContent = '合成中…';
        try {
          await api.voicePreview(role.name);
          test.textContent = '试听';
        } catch (e) {
          toast(e?.message ?? '试听失败');
          test.textContent = '试听';
        } finally { test.disabled = false; }
      });
      panel.append(test);
    }

    /* 移除（主控角色不给移除，他恒在册） */
    if (!role.isPersona) {
    const del = el('button', 'sheet-item sheet-cancel', '从这张卡里移除');
    del.type = 'button';
    del.addEventListener('click', async () => {
      try {
        await api.roleRemove(role.name);
        sheet.remove();
        await reload();
        toast(`已移除「${role.name}」`);
      } catch (e) { toast(e?.message ?? '移除失败'); }
    });
    panel.append(del);
    }

    const cancel = el('button', 'sheet-item sheet-cancel', '取消');
    cancel.type = 'button';
    cancel.addEventListener('click', () => sheet.remove());
    panel.append(cancel);

    sheet.append(panel);
    sheet.addEventListener('click', (e) => { if (e.target === sheet) sheet.remove(); });
    root.append(sheet);
  }

  /* --------------------------------------------------------- 数据 */

  async function reload() {
    try {
      data = await api.roles();
    } catch (e) {
      data = { list: [], spaceName: '', hasSpace: false, activeEngine: '' };
      toast(`读不到角色：${e?.message ?? e}`);
    }
    loading = false;
    render();
  }

  await reload();
  setTitle('角色');

  return {
    title: '角色',
    back: () => false,
    refresh: () => { reload(); },
  };
}
