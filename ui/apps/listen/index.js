/**
 * 朗读 App。
 *
 * 为什么单独做一个：
 * 正文里的声波是"点哪儿念哪儿"，适合边读边听一两句。
 * 但想整段听、或者想听前面几十楼的内容时，来回滚动太麻烦。
 * 这里把所有台词抽成一张列表 —— 一眼看到谁说了什么，点一下就念。
 *
 * 粉色耳机是它的身份色，和「角色」「消息」区分开。
 */

const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
};

export async function mount(root, ctx) {
  const { api, toast, setTitle } = ctx;

  let data = { lines: [], total: 0, ready: 0, spaceName: '', voiceEnabled: false };
  let loading = true;
  let playingIndex = -1;

  const view = el('div', 'view listen-view');
  root.append(view);

  /* --------------------------------------------------------- 渲染 */

  function render() {
    view.innerHTML = '';

    /* 头部 */
    const hero = el('div', 'listen-hero');
    const titleRow = el('div', 'listen-hero-title');
    titleRow.append(el('span', 'listen-hero-icon', '🎧'));
    titleRow.append(el('b', '', '朗读'));
    hero.append(titleRow);

    hero.append(el('p', 'listen-hero-sub', loading
      ? '读取中…'
      : data.total
        ? `共 ${data.total} 句 · ${data.ready} 句已配音色`
        : '这个聊天里还没有可朗读的台词'));

    view.append(hero);

    if (loading) return;

    if (!data.total) {
      const empty = el('div', 'listen-empty');
      empty.append(el('div', 'chat-empty-icon', '🎧'));
      empty.append(el('b', '', '没有可朗读的台词'));
      empty.append(el('p', '',
        '正文里的对话会被自动识别。如果这里一直是空的，看看正文里是不是没有引号包住的台词。'));
      view.append(empty);
      return;
    }

    /* 工具条 */
    const tools = el('div', 'listen-tools');

    const playAll = el('button', 'listen-play-all', '▶ 全部播放');
    playAll.type = 'button';
    playAll.disabled = !data.ready;
    playAll.addEventListener('click', () => playAllLines(playAll));
    tools.append(playAll);

    const stop = el('button', 'pill-btn', '停止');
    stop.type = 'button';
    stop.addEventListener('click', async () => {
      try { await api.voiceStop(); } catch { /* 忽略 */ }
      playingIndex = -1;
      render();
    });
    tools.append(stop);

    if (!data.ready) {
      const goRoles = el('button', 'pill-btn', '去配音色');
      goRoles.type = 'button';
      goRoles.addEventListener('click', () => ctx.openApp?.('roles'));
      tools.append(goRoles);
    }

    view.append(tools);

    /* 列表 */
    const list = el('div', 'listen-list');
    data.lines.forEach((line, i) => list.append(row(line, i)));
    view.append(list);
  }

  function row(line, index) {
    const box = el('div', `listen-row ${line.hasVoice ? '' : 'dim'}`.trim());

    const head = el('div', 'listen-row-head');
    head.append(el('b', 'listen-who', line.role));
    if (line.emotion) head.append(el('span', 'listen-emotion', line.emotion));
    head.append(el('span', 'listen-floor', `第 ${line.floor + 1} 楼`));
    box.append(head);

    const text = el('p', 'listen-text', line.translation || line.text);
    box.append(text);

    const foot = el('div', 'listen-row-foot');

    const btn = el('button', 'listen-play', playingIndex === index ? '■ 停止' : '▶ 播放');
    btn.type = 'button';
    btn.disabled = !line.hasVoice;
    btn.title = line.hasVoice ? '朗读这一句' : '这个角色还没有配音色';
    btn.addEventListener('click', async () => {
      if (playingIndex === index) {
        try { await api.voiceStop(); } catch { /* 忽略 */ }
        playingIndex = -1;
        render();
        return;
      }
      try {
        playingIndex = index;
        render();
        await api.voiceSpeak({
          role: line.role,
          emotion: line.emotion,
          text: line.text,
          translation: line.translation,
        });
      } catch (e) {
        toast(e?.message ?? '朗读失败');
      } finally {
        if (playingIndex === index) { playingIndex = -1; render(); }
      }
    });
    foot.append(btn);

    if (!line.hasVoice) foot.append(el('span', 'listen-note', '未配音色'));

    box.append(foot);

    /* 点整行也能播 */
    box.addEventListener('click', (e) => {
      if (e.target.closest('button')) return;
      if (line.hasVoice) btn.click();
    });

    return box;
  }

  /** 从第一句开始连着播 */
  async function playAllLines(btn) {
    const playable = data.lines.filter(l => l.hasVoice);
    if (!playable.length) { toast('还没有角色配音色'); return; }

    btn.disabled = true;
    btn.textContent = '播放中…';
    try {
      for (let i = 0; i < playable.length; i++) {
        const line = playable[i];
        const index = data.lines.indexOf(line);
        playingIndex = index;
        render();
        await api.voiceSpeak({
          role: line.role,
          emotion: line.emotion,
          text: line.text,
          translation: line.translation,
        });
      }
    } catch (e) {
      toast(e?.message ?? '播放中断');
    } finally {
      playingIndex = -1;
      render();
    }
  }

  /* --------------------------------------------------------- 数据 */

  async function reload() {
    try {
      data = await api.listenLines();
    } catch (e) {
      data = { lines: [], total: 0, ready: 0, spaceName: '', voiceEnabled: false };
      toast(`读不到台词：${e?.message ?? e}`);
    }
    loading = false;
    render();
  }

  await reload();
  setTitle('朗读');

  return {
    title: '朗读',
    back: () => false,
    refresh: () => { reload(); },
    leave: () => { api.voiceStop().catch(() => {}); },
  };
}
