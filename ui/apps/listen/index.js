/**
 * 朗读 App —— 单角色视图。
 *
 * 一页一个角色：大头像、当前句、情绪标签、播放控制。
 * 左右箭头或滑动切换角色，只看这个角色说过的话。
 *
 * 为什么不用"所有角色一页列出来"：
 * 台词多的时候一屏几十条，翻着累，也分不清是谁说的。
 * 一页一个角色，视线集中，切换成本也低。
 */

const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
};

export async function mount(root, ctx) {
  const { api, toast, setTitle } = ctx;

  let data = { roles: [], lines: [], total: 0, ready: 0, spaceName: '' };
  let loading = true;

  let roleIndex = 0;      // 当前角色
  let lineIndex = 0;      // 这个角色念到第几句
  let playing = false;

  const view = el('div', 'view listen-view');
  root.append(view);

  const currentRole = () => data.roles[roleIndex] ?? null;
  const currentLine = () => currentRole()?.lines?.[lineIndex] ?? null;

  /* --------------------------------------------------------- 渲染 */

  function render() {
    view.innerHTML = '';

    const role = currentRole();

    /* 顶栏 */
    const head = el('div', 'listen-head');
    const headText = el('div', 'listen-head-text');
    headText.append(el('small', 'listen-head-small', 'NOW PLAYING'));
    const titleRow = el('div', 'listen-head-title');
    titleRow.append(el('b', '', '听取'));
    titleRow.append(el('span', 'listen-head-star', '✦'));
    headText.append(titleRow);
    head.append(headText);

    const headActs = el('div', 'listen-head-acts');
    const refresh = el('button', 'listen-head-btn', '⟳');
    refresh.type = 'button';
    refresh.title = '重新读取';
    refresh.addEventListener('click', () => { reload(); });
    headActs.append(refresh);
    head.append(headActs);
    view.append(head);

    if (loading) {
      view.append(el('p', 'listen-hint', '读取中…'));
      return;
    }

    if (!data.roles.length) {
      const empty = el('div', 'listen-empty');
      empty.append(el('div', 'chat-empty-icon', '🎧'));
      empty.append(el('b', '', '没有可朗读的台词'));
      empty.append(el('p', '', '正文里的对话会被自动识别。如果一直是空的，看看正文里是不是没有引号包住的台词。'));
      view.append(empty);
      return;
    }

    /* 舞台：大圆头像 + 情绪 */
    const stage = el('div', 'listen-stage');

    const ring = el('div', 'listen-ring');
    stage.append(ring);

    const avatar = el('div', 'listen-avatar');
    if (role.avatar) {
      const img = document.createElement('img');
      img.src = role.avatar;
      img.alt = role.name;
      img.decoding = 'async';
      img.addEventListener('error', () => { img.remove(); avatar.textContent = role.name.slice(0, 1); });
      avatar.append(img);
    } else {
      avatar.textContent = role.name.slice(0, 1);
    }
    stage.append(avatar);

    /* 情绪气泡（跟着当前句走） */
    const line = currentLine();
    const emotion = String(line?.emotion ?? '').trim();
    if (emotion) {
      const chip = el('div', 'listen-emotion-chip', emotion);
      stage.append(chip);
    }

    view.append(stage);

    /* 切换区 */
    const nav = el('div', 'listen-nav');
    const prev = el('button', 'listen-nav-btn', '‹');
    prev.type = 'button';
    prev.disabled = roleIndex <= 0;
    prev.title = '上一个角色';
    prev.addEventListener('click', () => goRole(-1));
    nav.append(prev);

    const dots = el('div', 'listen-dots');
    data.roles.forEach((r, i) => {
      const dot = el('button', `listen-dot ${i === roleIndex ? 'on' : ''}`.trim());
      dot.type = 'button';
      dot.title = r.name;
      dot.addEventListener('click', () => { roleIndex = i; lineIndex = 0; stop(); render(); });
      dots.append(dot);
    });
    nav.append(dots);

    const next = el('button', 'listen-nav-btn', '›');
    next.type = 'button';
    next.disabled = roleIndex >= data.roles.length - 1;
    next.title = '下一个角色';
    next.addEventListener('click', () => goRole(1));
    nav.append(next);

    view.append(nav);

    /* 台词卡片 */
    const card = el('div', 'listen-card');
    const cardHead = el('div', 'listen-card-head');
    cardHead.append(el('span', 'listen-card-name', role.name));
    cardHead.append(el('span', 'listen-card-count', `${lineIndex + 1} / ${role.lines.length}`));
    card.append(cardHead);

    const body = el('p', 'listen-card-text', line?.translation || line?.text || '');
    card.append(body);

    /* 句子导航：一句一句换，或者打开目录直接跳 */
    const steps = el('div', 'listen-steps');

    const prevLine = el('button', 'listen-step-btn', '‹ 上一句');
    prevLine.type = 'button';
    prevLine.disabled = lineIndex <= 0;
    prevLine.addEventListener('click', () => goLine(-1));
    steps.append(prevLine);

    const toc = el('button', 'listen-step-btn listen-toc-btn', '目录');
    toc.type = 'button';
    toc.addEventListener('click', openToc);
    steps.append(toc);

    const nextLine = el('button', 'listen-step-btn', '下一句 ›');
    nextLine.type = 'button';
    nextLine.disabled = lineIndex >= role.lines.length - 1;
    nextLine.addEventListener('click', () => goLine(1));
    steps.append(nextLine);

    card.append(steps);

    if (!role.hasVoice) {
      card.append(el('span', 'listen-card-warn', `等待为「${role.name}」选择音色`));
    }
    view.append(card);

    /* 底部操作 */
    const foot = el('div', 'listen-foot');

    if (!role.hasVoice) {
      const pick = el('button', 'listen-primary', '🎤 去给这个角色选音色');
      pick.type = 'button';
      pick.addEventListener('click', () => ctx.openApp?.('roles'));
      foot.append(pick);
    } else {
      const play = el('button', `listen-primary ${playing ? 'playing' : ''}`.trim(),
        playing ? '■ 停止' : `▶ 播放「${role.name}」全部（${role.lines.length} 句）`);
      play.type = 'button';
      play.addEventListener('click', () => {
        if (playing) { stop(); render(); }
        else playRole();
      });
      foot.append(play);
    }

    view.append(foot);

    /* 进度条 */
    if (role.hasVoice && role.lines.length > 1) {
      const bar = el('div', 'listen-progress');
      const fill = el('i');
      fill.style.width = `${((lineIndex + 1) / role.lines.length) * 100}%`;
      bar.append(fill);
      view.append(bar);
    }
  }

  /* --------------------------------------------------------- 操作 */

  function stop() {
    playing = false;
    try { api.voiceStop(); } catch { /* 忽略 */ }
  }

  /** 换句子；播放中换句就停掉，避免串音 */
  function goLine(delta) {
    const role = currentRole();
    if (!role) return;
    const next = lineIndex + delta;
    if (next < 0 || next >= role.lines.length) return;
    if (playing) { stop(); }
    lineIndex = next;
    render();
  }

  /**
   * 目录：每页 10 句，先选页再选句。
   * 199 句的角色一页列完没法看，分页是必须的。
   */
  const TOC_PAGE = 10;
  let tocPage = 0;

  function openToc() {
    const role = currentRole();
    if (!role) return;

    const sheet = el('div', 'sheet');
    const panel = el('div', 'sheet-panel listen-toc');

    const head = el('div', 'listen-toc-head');
    head.append(el('b', '', role.name));
    head.append(el('span', '', `共 ${role.lines.length} 句`));
    panel.append(head);

    /* 页码条 */
    const pages = Math.max(1, Math.ceil(role.lines.length / TOC_PAGE));
    if (tocPage >= pages) tocPage = pages - 1;

    const pager = el('div', 'listen-toc-pager');
    for (let i = 0; i < pages; i++) {
      const from = i * TOC_PAGE + 1;
      const to = Math.min(role.lines.length, (i + 1) * TOC_PAGE);
      const btn = el('button', `listen-toc-page ${i === tocPage ? 'on' : ''}`.trim(), `${from}-${to}`);
      btn.type = 'button';
      btn.addEventListener('click', () => { tocPage = i; sheet.remove(); openToc(); });
      pager.append(btn);
    }
    panel.append(pager);

    /* 当前页的句子 */
    const list = el('div', 'listen-toc-list');
    const start = tocPage * TOC_PAGE;
    const end = Math.min(role.lines.length, start + TOC_PAGE);

    for (let i = start; i < end; i++) {
      const l = role.lines[i];
      const row = el('button', `listen-toc-row ${i === lineIndex ? 'on' : ''}`.trim());
      row.type = 'button';

      const no = el('span', 'listen-toc-no', String(i + 1));
      const txt = el('span', 'listen-toc-text', (l.translation || l.text || '').slice(0, 40));
      row.append(no, txt);

      row.addEventListener('click', () => {
        if (playing) stop();
        lineIndex = i;
        sheet.remove();
        render();
      });
      list.append(row);
    }
    panel.append(list);

    const close = el('button', 'sheet-item sheet-cancel', '关闭');
    close.type = 'button';
    close.addEventListener('click', () => sheet.remove());
    panel.append(close);

    sheet.append(panel);
    sheet.addEventListener('click', (e) => { if (e.target === sheet) sheet.remove(); });
    root.append(sheet);
  }

  function goRole(delta) {
    const nextIndex = roleIndex + delta;
    if (nextIndex < 0 || nextIndex >= data.roles.length) return;
    stop();
    roleIndex = nextIndex;
    lineIndex = 0;
    tocPage = 0;
    render();
  }

  async function playRole() {
    const role = currentRole();
    if (!role?.hasVoice) { toast('这个角色还没有配音色'); return; }

    playing = true;
    render();

    const lines = role.lines;
    try {
      for (let i = 0; i < lines.length; i++) {
        if (!playing) break;
        lineIndex = i;
        render();
        const l = lines[i];
        await api.voiceSpeak({
          role: l.role,
          emotion: l.emotion,
          text: l.text,
          translation: l.translation,
        });
      }
      if (playing) lineIndex = 0;
    } catch (e) {
      toast(e?.message ?? '播放中断');
    } finally {
      playing = false;
      render();
    }
  }

  /* --------------------------------------------------------- 数据 */

  async function reload() {
    try {
      data = await api.listenLines();
      // 上一轮选的角色还在的话，定位过去
      if (roleIndex >= data.roles.length) roleIndex = 0;
      if (lineIndex >= (data.roles[roleIndex]?.lines?.length ?? 0)) lineIndex = 0;
    } catch (e) {
      data = { roles: [], lines: [], total: 0, ready: 0, spaceName: '' };
      toast(`读不到台词：${e?.message ?? e}`);
    }
    loading = false;
    render();
  }

  /* 左右滑动切换角色 */
  let touchX = 0;
  view.addEventListener('touchstart', (e) => { touchX = e.touches[0]?.clientX ?? 0; }, { passive: true });
  view.addEventListener('touchend', (e) => {
    const dx = (e.changedTouches[0]?.clientX ?? 0) - touchX;
    if (Math.abs(dx) < 60) return;
    goRole(dx < 0 ? 1 : -1);
  }, { passive: true });

  await reload();
  setTitle('听取');

  return {
    title: '听取',
    back: () => false,
    refresh: () => { reload(); },
    leave: () => { stop(); },
  };
}
