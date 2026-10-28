/**
 * 设置 App。
 *
 * 四组：模型接口 / 聊天模式 / 预算旋钮 / 主动与朋友圈。
 * 每个改动立刻保存 —— 没有"保存"按钮，少一次忘记点的机会。
 */

const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
};

export async function mount(root, ctx) {
  const { api, toast, setTitle } = ctx;

  let settings = null;
  try { settings = await api.getSettings(); } catch { /* 下面会给默认 */ }
  settings ??= { mode: 'story', budget: {}, proactive: {}, moments: {}, model: {}, theme: 'dark' };

  const view = el('div', 'view settings-view');
  root.append(view);

  /* ------------------------------------------------------ 小工具 */

  const section = (title) => view.append(el('h2', 'settings-title', title));

  const field = ({ label, value = '', placeholder = '', type = 'text', hint = '' }) => {
    const wrap = el('label', 'field');
    wrap.append(el('span', 'field-label', label));
    const input = el('input', 'field-input');
    input.type = type;
    input.value = value ?? '';
    if (placeholder) input.placeholder = placeholder;
    wrap.append(input);
    if (hint) wrap.append(el('span', 'field-hint', hint));
    return { wrap, input };
  };

  const toggle = ({ label, checked = false, hint = '' }) => {
    const wrap = el('label', 'field field-row');
    const input = el('input');
    input.type = 'checkbox';
    input.checked = !!checked;
    wrap.append(input, el('span', 'field-label', label));
    if (hint) wrap.append(el('span', 'field-hint', hint));
    return { wrap, input };
  };

  const slider = ({ label, value, min, max, step = 1, hint = '', fmt = (v) => v }) => {
    const wrap = el('div', 'field');
    const head = el('div', 'field-head');
    head.append(el('span', 'field-label', label));
    const out = el('span', 'field-value', fmt(value));
    head.append(out);
    wrap.append(head);

    const input = el('input', 'field-range');
    input.type = 'range';
    input.min = String(min);
    input.max = String(max);
    input.step = String(step);
    input.value = String(value);
    input.addEventListener('input', () => { out.textContent = fmt(input.value); });
    wrap.append(input);
    if (hint) wrap.append(el('span', 'field-hint', hint));
    return { wrap, input };
  };

  /* ------------------------------------------------------ 模型 */

  section('模型接口');
  view.append(el('p', 'settings-note',
    '这是手机聊天和朋友圈用的独立通道，和酒馆的正文模型分开算额度。'));

  const url = field({
    label: '接口地址',
    value: settings.model.url,
    placeholder: 'https://api.example.com/v1',
    hint: '填到 /v1 就行，会自动补 /chat/completions',
  });
  const key = field({
    label: 'API Key',
    value: '',
    type: 'password',
    placeholder: settings.model.hasKey ? '已保存（留空则不修改）' : 'sk-...',
  });
  const model = field({
    label: '模型名',
    value: settings.model.model,
    placeholder: 'gpt-4o-mini',
    hint: '手机聊天建议用便宜快的模型',
  });

  const testRow = el('div', 'field field-row');
  const testBtn = el('button', 'pill-btn', '测试连接');
  testBtn.type = 'button';
  const testOut = el('span', 'field-hint', '');
  testRow.append(testBtn, testOut);

  const saveModel = el('button', 'primary-btn', '保存接口配置');
  saveModel.type = 'button';

  saveModel.addEventListener('click', async () => {
    saveModel.disabled = true;
    try {
      const patch = { url: url.input.value.trim(), model: model.input.value.trim() };
      if (key.input.value.trim()) patch.key = key.input.value.trim();
      await api.saveModel(patch);
      key.input.value = '';
      toast('已保存');
    } catch (e) { toast(e?.message ?? '保存失败'); }
    finally { saveModel.disabled = false; }
  });

  testBtn.addEventListener('click', async () => {
    testBtn.disabled = true;
    testOut.textContent = '测试中…';
    try {
      const r = await api.testModel();
      testOut.textContent = `通了：${String(r.reply).slice(0, 30)}`;
    } catch (e) {
      testOut.textContent = `不通：${String(e?.message ?? e).slice(0, 60)}`;
    } finally { testBtn.disabled = false; }
  });

  view.append(url.wrap, key.wrap, model.wrap, saveModel, testRow, testOut);

  /* ------------------------------------------------------ 模式 */

  section('聊天模式');
  const modes = [
    ['story', '剧情内', '角色知道正文里发生的事'],
    ['hybrid', '半局外', '只给氛围，不纠缠细节'],
    ['offstory', '局外', '只用人设，聊什么都行'],
  ];

  const modeRow = el('div', 'segmented');
  for (const [value, label, hint] of modes) {
    const btn = el('button', `seg ${settings.mode === value ? 'on' : ''}`, label);
    btn.type = 'button';
    btn.title = hint;
    btn.addEventListener('click', async () => {
      modeRow.querySelectorAll('.seg').forEach(b => b.classList.remove('on'));
      btn.classList.add('on');
      try {
        settings = await api.saveChat({ mode: value });
        toast(`已切到「${label}」`);
      } catch (e) { toast(e?.message ?? '失败'); }
    });
    modeRow.append(btn);
  }
  view.append(modeRow);
  view.append(el('p', 'settings-note',
    '剧情内：角色只知道自己经历的事，不会提前知道没发生的事。'));

  /* ------------------------------------------------------ 预算 */

  section('上下文预算');
  view.append(el('p', 'settings-note',
    '数字越大越准，也越贵。改完下一次请求就生效，可以在这里直接看效果。'));

  const b = settings.budget ?? {};
  const full = slider({
    label: '完整保留几条正文',
    value: b.storyFull ?? 2, min: 0, max: 5,
    hint: '最近这几条给完整原文（单条最多 400 字）',
  });
  const brief = slider({
    label: '再往前几条只留首句',
    value: b.storyBrief ?? 6, min: 0, max: 12,
    hint: '提供脉络，不占空间',
  });
  const cardLen = slider({
    label: '角色卡截断字数',
    value: b.cardText ?? 1200, min: 400, max: 3000, step: 100,
    hint: '越小越省，也更不容易说出设定里没发生的事',
  });
  const history = slider({
    label: '手机聊天历史条数',
    value: b.history ?? 20, min: 5, max: 60, step: 5,
  });

  const saveBudget = el('button', 'primary-btn', '保存预算');
  saveBudget.type = 'button';
  saveBudget.addEventListener('click', async () => {
    try {
      settings = await api.saveChat({
        budget: {
          ...(settings.budget ?? {}),
          storyFull: Number(full.input.value),
          storyBrief: Number(brief.input.value),
          cardText: Number(cardLen.input.value),
          history: Number(history.input.value),
        },
      });
      toast('已保存');
    } catch (e) { toast(e?.message ?? '失败'); }
  });

  view.append(full.wrap, brief.wrap, cardLen.wrap, history.wrap, saveBudget);

  /* ------------------------------------------------------ 主动 */

  section('角色主动发消息');
  const p = settings.proactive ?? {};
  const pOn = toggle({ label: '开启', checked: p.on, hint: '正文里会偶尔出现一条手机消息' });
  const pEvery = slider({
    label: '每几条正文给一次机会',
    value: p.every ?? 3, min: 1, max: 20,
    hint: '不是每楼都发 —— 稀缺才有意思',
  });
  const pMax = slider({ label: '每天最多几条', value: p.dailyMax ?? 3, min: 0, max: 20 });

  const saveProactive = el('button', 'primary-btn', '保存');
  saveProactive.type = 'button';
  saveProactive.addEventListener('click', async () => {
    try {
      settings = await api.saveChat({
        proactive: {
          on: pOn.input.checked,
          every: Number(pEvery.input.value),
          dailyMax: Number(pMax.input.value),
        },
      });
      toast('已保存');
    } catch (e) { toast(e?.message ?? '失败'); }
  });

  view.append(pOn.wrap, pEvery.wrap, pMax.wrap, saveProactive);

  /* ------------------------------------------------------ 朋友圈 */

  section('朋友圈');
  const mo = settings.moments ?? {};
  const mOn = toggle({ label: '开启', checked: mo.on !== false });
  const mEvery = slider({ label: '每几条正文考虑发一条', value: mo.every ?? 5, min: 1, max: 30 });

  const saveMoments = el('button', 'primary-btn', '保存');
  saveMoments.type = 'button';
  saveMoments.addEventListener('click', async () => {
    try {
      settings = await api.saveMoments({ on: mOn.input.checked, every: Number(mEvery.input.value) });
      toast('已保存');
    } catch (e) { toast(e?.message ?? '失败'); }
  });

  view.append(mOn.wrap, mEvery.wrap, saveMoments);

  /* ------------------------------------------------------ 外观 */

  section('外观');
  const themeRow = el('div', 'segmented');
  for (const [value, label] of [['dark', '深色'], ['light', '浅色']]) {
    const btn = el('button', `seg ${(settings.theme ?? 'dark') === value ? 'on' : ''}`, label);
    btn.type = 'button';
    btn.addEventListener('click', async () => {
      themeRow.querySelectorAll('.seg').forEach(b => b.classList.remove('on'));
      btn.classList.add('on');
      document.body.dataset.theme = value;
      ctx.state.settings = { ...(ctx.state.settings ?? {}), theme: value };
      try { await api.saveUi({ theme: value }); } catch { /* 忽略 */ }
    });
    themeRow.append(btn);
  }
  view.append(themeRow);

  setTitle('设置');

  return { title: '设置', back: () => false };
}
