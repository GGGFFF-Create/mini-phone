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
  settings ??= { mode: 'story', budget: {}, proactive: {}, moments: {}, theme: 'dark' };

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

  /** JSON 编辑框：请求头和请求体用它，让用户能改任何字段 */
  const jsonEditor = (label, value, onChange, rows = 4) => {
    const wrap = el('div', 'field');
    wrap.append(el('span', 'field-label', label));

    const ta = el('textarea', 'field-textarea');
    ta.rows = rows;
    ta.spellcheck = false;
    ta.value = JSON.stringify(value ?? {}, null, 2);

    const hint = el('span', 'field-hint', '');
    ta.addEventListener('change', () => {
      try {
        const parsed = JSON.parse(ta.value);
        if (!parsed || typeof parsed !== 'object') throw new Error('要是对象');
        onChange(parsed);
        hint.textContent = '已保存';
        hint.style.color = '';
      } catch (e) {
        hint.textContent = `JSON 格式不对：${e.message}`;
        hint.style.color = 'var(--danger)';
      }
    });

    wrap.append(ta, hint);
    return wrap;
  };

  /* ------------------------------------------------------ 模型 */

  section('模型接口');
  view.append(el('p', 'settings-note',
    '这是手机聊天和朋友圈用的独立通道，和酒馆的正文模型分开算额度。可以存多套配置随时切。'));

  let llmData = null;
  try { llmData = await api.llmGet(); } catch { /* 忽略 */ }

  if (!llmData) {
    view.append(el('p', 'settings-note', '模型模块没加载起来，看看控制台。'));
  } else {
    /* 配置选择 */
    const profileSelect = el('select', 'field-input');
    for (const p of llmData.profiles) {
      const o = el('option', '', p.name || p.id);
      o.value = p.id;
      if (p.id === llmData.activeId) o.selected = true;
      profileSelect.append(o);
    }
    profileSelect.addEventListener('change', async () => {
      try { llmData = { ...llmData, ...(await api.llmSetActive(profileSelect.value)) }; renderLlmEditor(); }
      catch (e) { toast(e?.message ?? '失败'); }
    });

    const llmRow = el('div', 'field');
    llmRow.append(el('span', 'field-label', '当前配置'));
    llmRow.append(profileSelect);

    const newBtn = el('button', 'pill-btn', '＋ 新建配置');
    newBtn.type = 'button';
    newBtn.addEventListener('click', async () => {
      try {
        const p = await api.llmCreate('我的模型');
        llmData = await api.llmGet();
        await api.llmSetActive(p.id);
        llmData = await api.llmGet();
        renderLlmEditor();
        toast('建好了，往下填');
      } catch (e) { toast(e?.message ?? '失败'); }
    });

    const statusHint = el('span', 'field-hint', '');
    llmRow.append(newBtn, statusHint);
    view.append(llmRow);

    const llmEditor = el('div', 'engine-editor');
    view.append(llmEditor);

    function renderLlmEditor() {
      llmEditor.innerHTML = '';
      const p = llmData.profiles.find(x => x.id === llmData.activeId);
      if (!p) { llmEditor.append(el('p', 'settings-note', '没有这个配置')); return; }
      if (p.note) llmEditor.append(el('p', 'settings-note', p.note));

      const mk = (label, key, opts = {}) => {
        const f = field({
          label,
          value: key === 'key' ? '' : (p[key] ?? ''),
          type: opts.type ?? 'text',
          placeholder: opts.placeholder ?? '',
          hint: opts.hint ?? '',
        });
        if (key === 'key') f.input.placeholder = p.key ? '已保存（留空则不修改）' : 'sk-...';
        f.input.addEventListener('change', () => {
          const v = f.input.value.trim();
          if (key === 'key' && !v) return;         // 留空表示不改
          saveLlm({ [key]: key === 'temperature' || key === 'maxTokens' ? Number(v) : v });
        });
        llmEditor.append(f.wrap);
        return f;
      };

      mk('名称', 'name', { placeholder: '这套配置叫什么' });
      mk('接口根地址', 'base', { placeholder: 'https://api.deepseek.com/v1', hint: '填到 /v1。下面的 endpoint 用 {{base}} 引用它' });
      mk('API Key', 'key', { type: 'password' });
      mk('模型名', 'model', { placeholder: 'deepseek-chat / gpt-4o-mini', hint: '手机聊天建议用便宜快的' });

      const temp = slider({
        label: '温度（越高越放飞）',
        value: p.temperature ?? 0.8, min: 0, max: 1.5, step: 0.1,
        fmt: (v) => Number(v).toFixed(1),
      });
      temp.input.addEventListener('change', () => saveLlm({ temperature: Number(temp.input.value) }));
      llmEditor.append(temp.wrap);

      const maxTok = slider({
        label: '回复长度上限',
        value: p.maxTokens ?? 400, min: 60, max: 1200, step: 20,
        hint: '手机消息本来就短，不用给太多',
      });
      maxTok.input.addEventListener('change', () => saveLlm({ maxTokens: Number(maxTok.input.value) }));
      llmEditor.append(maxTok.wrap);

      /* 高级：默认能用，需要时再改 */
      const adv = el('details', 'advanced');
      adv.append(el('summary', '', '高级（地址、请求头、请求体）'));
      adv.addEventListener('toggle', () => {
        if (!adv.open || adv.dataset.filled) return;
        adv.dataset.filled = '1';

        const ep = el('div', 'field');
        ep.append(el('span', 'field-label', '请求地址（endpoint）'));
        const epInput = el('input', 'field-input');
        epInput.type = 'text';
        epInput.value = p.endpoint ?? '';
        epInput.placeholder = '{{base}}/chat/completions';
        epInput.addEventListener('change', () => saveLlm({ endpoint: epInput.value.trim() }));
        ep.append(epInput, el('span', 'field-hint', '可以用 {{base}} {{key}} {{model}}'));
        adv.append(ep);

        adv.append(jsonEditor('额外请求头（JSON）', p.headers, (v) => saveLlm({ headers: v }), 3));
        adv.append(jsonEditor('额外请求体（JSON）', p.body, (v) => saveLlm({ body: v }), 4));
        adv.append(el('p', 'settings-note',
          '额外请求体里可以放 top_p、presence_penalty、stop 这些标准字段，会被合并进请求。'));

        const st = toggle({ label: '要流式输出', checked: p.stream === true, hint: '有些中转不支持，报错就关掉' });
        st.input.addEventListener('change', () => saveLlm({ stream: st.input.checked }));
        adv.append(st.wrap);
      });
      llmEditor.append(adv);

      /* 测试 */
      const testRow = el('div', 'field field-row');
      const tBtn = el('button', 'pill-btn', '测试这套配置');
      tBtn.type = 'button';
      const tOut = el('span', 'field-hint', '');
      testRow.append(tBtn, tOut);
      tBtn.addEventListener('click', async () => {
        tBtn.disabled = true;
        tOut.textContent = '测试中…';
        try {
          const r = await api.llmTest(p.id);
          tOut.textContent = r.ok
            ? `通了（${r.ms}ms）：${r.reply}`
            : `不通：${r.error}`;
        } catch (e) {
          tOut.textContent = `出错：${e?.message ?? e}`;
        } finally { tBtn.disabled = false; }
      });
      llmEditor.append(testRow);

      /* 恢复 / 删除 */
      const actionRow = el('div', 'field field-row');
      const reset = el('button', 'pill-btn', '恢复默认值');
      reset.type = 'button';
      reset.addEventListener('click', async () => {
        try {
          const tpl = await api.llmTemplate(p.id);
          if (!tpl) { toast('这个配置没有内置模板'); return; }
          await api.llmSaveProfile(p.id, tpl);
          llmData = await api.llmGet();
          renderLlmEditor();
          toast('已恢复');
        } catch (e) { toast(e?.message ?? '失败'); }
      });
      actionRow.append(reset);

      if (p.id.startsWith('custom_')) {
        const del = el('button', 'pill-btn', '删除这套配置');
        del.type = 'button';
        del.addEventListener('click', async () => {
          try {
            await api.llmDelete(p.id);
            llmData = await api.llmGet();
            renderLlmEditor();
            toast('已删除');
          } catch (e) { toast(e?.message ?? '失败'); }
        });
        actionRow.append(del);
      }
      llmEditor.append(actionRow);

      async function saveLlm(patch) {
        try {
          await api.llmSaveProfile(p.id, patch);
          llmData = await api.llmGet();
          statusHint.textContent = '已保存';
          setTimeout(() => { statusHint.textContent = ''; }, 1200);
        } catch (e) { toast(e?.message ?? '保存失败'); }
      }
    }

    renderLlmEditor();

    if (!llmData.ready) {
      view.append(el('p', 'settings-note',
        '⚠️ 现在这套还没填完整，手机聊天会提示"还没配置模型"。'));
    }
  }

  /* ------------------------------------------------------ 模式 */

  section('聊天模式');
  view.append(el('p', 'settings-note',
    '决定手机里的聊天"知不知道"正文发生了什么。三种模式花的钱差很多。'));

  const MODES = [
    {
      id: 'story',
      name: '剧情内',
      badge: '最准 · 最贵',
      tone: 'accent',
      what: '角色知道正文最近发生了什么',
      detail: [
        '会带上「最近的剧情」：最近 2 段完整原文 + 再往前 6 段的第一句。',
        '所以角色能接上刚才的对话、记得刚发生的事。',
      ],
      good: '正常玩剧情，聊天要跟着剧情走的时候。',
      cost: '每次请求多 2000-3000 字左右。',
    },
    {
      id: 'hybrid',
      name: '半局外',
      badge: '折中',
      tone: 'mid',
      what: '只沾一点剧情的味道',
      detail: [
        '只带正文开头几句，不给完整情节。',
        '角色知道"大概最近在一起"，但说不出具体细节。',
      ],
      good: '想让角色有点背景感，但不想被剧情绑住。',
      cost: '比剧情内省一半左右。',
    },
    {
      id: 'offstory',
      name: '局外',
      badge: '最省',
      tone: 'quiet',
      what: '完全不看正文',
      detail: [
        '只用角色卡的人设（性格、描述），一个字都不带正文。',
        '角色不知道剧情里发生了什么，可以聊任何话题。',
      ],
      good: '让角色跳出剧情闲聊，或者干脆当独立聊天用。',
      cost: '最便宜。',
    },
  ];

  const cards = el('div', 'mode-cards');
  for (const m of MODES) {
    const on = (settings.mode ?? 'story') === m.id;
    const card = el('button', `mode-card ${on ? 'on' : ''}`);
    card.type = 'button';
    card.dataset.mode = m.id;

    const head = el('div', 'mode-card-head');
    head.append(el('b', '', m.name));
    head.append(el('span', `mode-badge ${m.tone}`, m.badge));
    card.append(head);

    card.append(el('p', 'mode-what', m.what));
    for (const d of m.detail) card.append(el('p', 'mode-detail', d));

    const foot = el('div', 'mode-foot');
    foot.append(el('span', 'mode-good', `适合：${m.good}`));
    foot.append(el('span', 'mode-cost', `开销：${m.cost}`));
    card.append(foot);

    card.addEventListener('click', async () => {
      cards.querySelectorAll('.mode-card').forEach(c => c.classList.remove('on'));
      card.classList.add('on');
      try {
        settings = await api.saveChat({ mode: m.id });
        toast(`已切到「${m.name}」`);
      } catch (e) { toast(e?.message ?? '失败'); }
    });

    cards.append(card);
  }
  view.append(cards);

  view.append(el('p', 'settings-note',
    '切了立刻生效，下一次手机请求就用新模式。已经在聊的记录不会变。'));

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

  /* ------------------------------------------------------ 语音 */

  section('语音');

  let voiceData = null;
  try { voiceData = await api.voiceGet(); } catch { /* 没有也不影响别的 */ }

  if (!voiceData) {
    view.append(el('p', 'settings-note', '语音模块没加载起来，看看控制台有没有报错。'));
  } else {
    view.append(el('p', 'settings-note',
      '语音走独立接口，和聊天模型分开配。点正文里的声波按钮就会念。'));

    /* 总开关 */
    const vOn = toggle({ label: '开启动语音', checked: voiceData.enabled, hint: '关掉之后正文不显示声波按钮' });
    vOn.input.addEventListener('change', async () => {
      try { voiceData = { ...voiceData, ...(await api.voiceSave({ enabled: vOn.input.checked })) }; }
      catch (e) { toast(e?.message ?? '失败'); }
    });
    view.append(vOn.wrap);

    /* 引擎选择 + 新建 */
    const engineSelect = el('select', 'field-input');
    for (const e of voiceData.engines) {
      const opt = el('option', '', e.name);
      opt.value = e.id;
      if (e.id === voiceData.activeEngine) opt.selected = true;
      engineSelect.append(opt);
    }
    engineSelect.addEventListener('change', async () => {
      try {
        voiceData = { ...voiceData, ...(await api.voiceSave({ activeEngine: engineSelect.value })) };
        renderEngineEditor();
      } catch (e) { toast(e?.message ?? '失败'); }
    });

    const engineRow = el('div', 'field');
    engineRow.append(el('span', 'field-label', '当前引擎'));
    engineRow.append(engineSelect);

    const newBtn = el('button', 'pill-btn', '＋ 新建自定义引擎');
    newBtn.type = 'button';
    newBtn.addEventListener('click', async () => {
      try {
        const created = await api.voiceEngineCreate('我的引擎');
        voiceData = await api.voiceGet();
        voiceData.activeEngine = created.id;
        await api.voiceSave({ activeEngine: created.id });
        renderEngineEditor();
        toast('建好了，往下填字段');
      } catch (e) { toast(e?.message ?? '失败'); }
    });

    const engineHint = el('span', 'field-hint', '');
    engineRow.append(newBtn, engineHint);
    view.append(engineRow);

    /* 引擎编辑区 */
    const editor = el('div', 'engine-editor');
    view.append(editor);

    function renderEngineEditor() {
      editor.innerHTML = '';
      const eng = voiceData.engines.find(e => e.id === voiceData.activeEngine);
      if (!eng) { editor.append(el('p', 'settings-note', '没有这个引擎')); return; }

      const isBrowser = eng.kind === 'browser';

      if (eng.note) editor.append(el('p', 'settings-note', eng.note));

      const mk = (label, key, opts = {}) => {
        const f = field({
          label,
          value: eng[key] ?? '',
          type: opts.type ?? 'text',
          placeholder: opts.placeholder ?? '',
          hint: opts.hint ?? '',
        });
        f.input.addEventListener('change', () => saveField(key, f.input.value));
        editor.append(f.wrap);
        return f;
      };

      if (!isBrowser) {
        mk('接口根地址', 'base', { placeholder: 'https://api.xxx.com/v1', hint: '下面的地址里可以用 {{base}} 引用它' });
        mk('API Key', 'key', { type: 'password', placeholder: '留空则不修改' });
        mk('模型名', 'model', { placeholder: 'tts-1 / s1 / speech-02-hd' });

        const ep = field({
          label: '请求地址（endpoint）',
          value: eng.endpoint ?? '',
          placeholder: '{{base}}/audio/speech',
          hint: '可以用 {{base}} {{key}} {{model}} {{voice}} {{text}} {{language}}',
        });
        ep.input.addEventListener('change', () => saveField('endpoint', ep.input.value));
        editor.append(ep.wrap);

        /* 请求头（JSON） */
        editor.append(jsonEditor('请求头（JSON）', eng.headers, (v) => saveField('headers', v)));

        /* 请求体（JSON）—— 这里是"不预制"的极致：整段可改 */
        const bodyHint = el('p', 'settings-note',
          '请求体里必须有 {{text}}，引擎才知道要念什么。voice / model 也可以用变量。');
        editor.append(bodyHint);
        editor.append(jsonEditor('请求体（JSON）', eng.body, (v) => saveField('body', v), 6));

        /* 响应类型 */
        const respSelect = el('select', 'field-input');
        for (const [value, label] of [
          ['audio', '响应体就是音频（最常见）'],
          ['json-base64', 'JSON 里带 base64'],
          ['json-url', 'JSON 里带音频链接'],
        ]) {
          const o = el('option', '', label);
          o.value = value;
          if (eng.response === value) o.selected = true;
          respSelect.append(o);
        }
        respSelect.addEventListener('change', () => saveField('response', respSelect.value));
        const respWrap = el('div', 'field');
        respWrap.append(el('span', 'field-label', '响应格式'));
        respWrap.append(respSelect);
        editor.append(respWrap);

        if (eng.response !== 'audio') {
          const p = field({
            label: '从哪个字段取音频',
            value: eng.responsePath ?? '',
            placeholder: 'data.audio',
            hint: '支持点号路径，比如 data.audio / result.0.url',
          });
          p.input.addEventListener('change', () => saveField('responsePath', p.input.value));
          editor.append(p.wrap);
        }

        /* 情绪模式 */
        const emoSelect = el('select', 'field-input');
        for (const [value, label] of [
          ['none', '不处理（引擎不支持情绪）'],
          ['bracket', '[happy] 台词'],
          ['paren', '(happy) 台词'],
        ]) {
          const o = el('option', '', label);
          o.value = value;
          if (eng.emotion === value) o.selected = true;
          emoSelect.append(o);
        }
        emoSelect.addEventListener('change', () => saveField('emotion', emoSelect.value));
        const emoWrap = el('div', 'field');
        emoWrap.append(el('span', 'field-label', '情绪怎么塞进文本'));
        emoWrap.append(emoSelect);
        emoWrap.append(el('span', 'field-hint', '中文情绪会先翻成英文（开心 → happy）'));
        editor.append(emoWrap);

        const transToggle = toggle({ label: '中文情绪翻成英文', checked: eng.emotionTranslate !== false });
        transToggle.input.addEventListener('change', () => saveField('emotionTranslate', transToggle.input.checked));
        editor.append(transToggle.wrap);
      }

      /* 默认音色 */
      const vf = field({
        label: isBrowser ? '系统声音名（留空用默认）' : '默认音色 id',
        value: eng.voice ?? '',
        placeholder: isBrowser ? '留空即可' : 'alloy / reference_id / voice_id',
        hint: '角色没单独配的时候用这个',
      });
      vf.input.addEventListener('change', () => saveField('voice', vf.input.value));
      editor.append(vf.wrap);

      /* 测试 */
      const testRow = el('div', 'field field-row');
      const tBtn = el('button', 'pill-btn', '测试这个引擎');
      tBtn.type = 'button';
      const tOut = el('span', 'field-hint', '');
      testRow.append(tBtn, tOut);
      tBtn.addEventListener('click', async () => {
        tBtn.disabled = true;
        tOut.textContent = '测试中…';
        try {
          const r = await api.voiceTest(eng.id);
          tOut.textContent = r.ok
            ? `通了（${r.ms ?? 0}ms${r.bytes ? `，${Math.round(r.bytes / 1024)}KB` : ''}${r.note ? `，${r.note}` : ''}）`
            : `不通：${r.error}`;
        } catch (e) {
          tOut.textContent = `出错：${e?.message ?? e}`;
        } finally { tBtn.disabled = false; }
      });
      editor.append(testRow);

      /* 删除 / 恢复 */
      const actionRow = el('div', 'field field-row');
      if (!isBrowser) {
        const reset = el('button', 'pill-btn', '恢复默认值');
        reset.type = 'button';
        reset.addEventListener('click', async () => {
          try {
            const tpl = await api.voiceTemplate(eng.id);
            if (!tpl) { toast('这个引擎没有内置模板'); return; }
            await api.voiceEngineSave(eng.id, tpl);
            voiceData = await api.voiceGet();
            renderEngineEditor();
            toast('已恢复');
          } catch (e) { toast(e?.message ?? '失败'); }
        });
        actionRow.append(reset);
      }
      if (eng.id.startsWith('custom_')) {
        const del = el('button', 'pill-btn', '删除这个引擎');
        del.type = 'button';
        del.addEventListener('click', async () => {
          try {
            await api.voiceEngineDelete(eng.id);
            voiceData = await api.voiceGet();
            voiceData.activeEngine = 'openai';
            await api.voiceSave({ activeEngine: 'openai' });
            renderEngineEditor();
            toast('已删除');
          } catch (e) { toast(e?.message ?? '失败'); }
        });
        actionRow.append(del);
      }
      editor.append(actionRow);

      async function saveField(key, value) {
        try {
          await api.voiceEngineSave(eng.id, { [key]: value });
          eng[key] = value;
          engineHint.textContent = '已保存';
          setTimeout(() => { engineHint.textContent = ''; }, 1200);
        } catch (e) { toast(e?.message ?? '保存失败'); }
      }
    }

    renderEngineEditor();

    /* 角色音色 */
    section('每个角色的声音');

    const SOURCE_LABEL = {
      card: '当前卡',
      story: '剧情里出现过',
      manual: '手动加的',
      voice: '已配音色',
    };

    view.append(el('p', 'settings-note', (voiceData.contacts?.length ?? 0) > 0
      ? `只列「${voiceData.spaceName || '当前卡'}」里的人 —— 换角色卡会自动换一批，不是全酒馆的角色。`
      : voiceData.hasSpace === false
        ? '现在没有打开角色卡。先去酒馆里选一张卡，这里才会出现可以配音的人。'
        : `「${voiceData.spaceName || '这张卡'}」里还没有认识的人。聊几轮，正文里说过话的人会自动出现在这里。`));

    const voiceList = el('div', 'voice-bind-list');
    for (const person of voiceData.contacts ?? []) {
      const name = person.name;
      const row = el('div', 'field');
      const head = el('div', 'field-head');
      head.append(el('span', 'field-label', name));
      if (person.source) head.append(el('span', `voice-src src-${person.source}`, SOURCE_LABEL[person.source] ?? ''));
      row.append(head);

      const input = el('input', 'field-input');
      input.type = 'text';
      input.placeholder = '音色 id（留空 = 用上面的默认音色）';
      input.value = voiceData.voices?.[name]?.voice ?? '';
      input.addEventListener('change', async () => {
        try {
          const cur = voiceData.voices?.[name] ?? {};
          await api.voiceBind(name, input.value
            ? { ...cur, engine: cur.engine || voiceData.activeEngine, voice: input.value }
            : null);
          toast(`${name} 的音色已保存`);
        } catch (e) { toast(e?.message ?? '失败'); }
      });
      row.append(input);
      voiceList.append(row);
    }
    view.append(voiceList);

    /* 缓存 */
    section('语音缓存');
    const cacheInfo = el('p', 'settings-note', '统计中…');
    view.append(cacheInfo);

    const refreshCache = async () => {
      try {
        const s = await api.voiceStats();
        const mb = (n) => (n / 1024 / 1024).toFixed(1);
        cacheInfo.textContent = `已存 ${s.count ?? 0} 条，${mb(s.bytes ?? 0)} MB / 上限 ${mb(s.limit ?? 0)} MB`;
      } catch { cacheInfo.textContent = '读不到缓存统计'; }
    };
    refreshCache();

    const cacheRow = el('div', 'field field-row');
    const clearBtn = el('button', 'pill-btn', '清空语音缓存');
    clearBtn.type = 'button';
    clearBtn.addEventListener('click', async () => {
      try { await api.voiceClearCache(); await refreshCache(); toast('已清空'); }
      catch (e) { toast(e?.message ?? '失败'); }
    });
    const refreshBtn = el('button', 'pill-btn', '刷新');
    refreshBtn.type = 'button';
    refreshBtn.addEventListener('click', refreshCache);
    cacheRow.append(clearBtn, refreshBtn);
    view.append(cacheRow);
  }

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
