/**
 * 语音引擎的"描述" —— 不是代码，是数据。
 *
 * 【为什么要这么设计】
 * 上一代同类项目的做法是：每个语音服务商写一段 if/else，各自拼请求、各自解析响应。
 * 结果是一个 300 行的文件里躺着 5 个引擎的分支，加第 6 个要动那段代码。
 *
 * 这里反过来：**引擎是一个数据结构**。加引擎 = 加一条配置，不改任何代码。
 *
 *   {
 *     endpoint: '{{base}}/audio/speech',       ← 地址里可以插变量
 *     headers:  { Authorization: 'Bearer {{key}}' },
 *     body:     { input: '{{text}}', voice: '{{voice}}' },
 *     response: 'audio',                        ← 响应是二进制 / base64 / URL
 *   }
 *
 * 用户在前端能改这些字段，所以"预制"只是默认值，不是牢笼。
 */

/** 模板里能用的变量。文档化在这里，设置页会照它生成提示。 */
export const TEMPLATE_VARS = Object.freeze({
  base: '接口根地址（比如 https://api.openai.com/v1）',
  key: 'API Key',
  model: '模型名',
  voice: '音色 id',
  text: '要朗读的文本（已按情绪处理后）',
  rawText: '原始文本，不带情绪前缀',
  emotion: '情绪词（英文，未处理时是空）',
  language: '语言代码，如 zh / en / ja',
});

/** 响应类型 */
export const RESPONSE_TYPES = Object.freeze({
  audio: '响应体就是音频数据（最常见的流式接口）',
  'json-base64': 'JSON 里某个字段是 base64 音频',
  'json-url': 'JSON 里某个字段是音频链接，需要再下载一次',
});

/** 情绪怎么塞进文本 */
export const EMOTION_MODES = Object.freeze({
  none: '不处理（引擎不支持情绪）',
  bracket: '括号前缀：[happy] 台词',
  paren: '圆括号前缀：(happy) 台词',
});

/**
 * 中文情绪 → 引擎常用的英文词。
 *
 * 为什么需要这张表：多数引擎只认英文情绪标签。模型写"开心"，
 * 直接传给引擎会被忽略（或者报错），得先翻一道。
 *
 * 只做常见词，不追求全 —— 认不出的就丢掉情绪，让引擎用自己的默认语气，
 * 比强行塞一个错的词好。
 */
const EMOTION_MAP = {
  开心: 'happy', 高兴: 'happy', 愉快: 'happy', 兴奋: 'excited', 激动: 'excited',
  难过: 'sad', 悲伤: 'sad', 伤心: 'sad', 失落: 'sad', 沮丧: 'sad',
  生气: 'angry', 愤怒: 'angry', 恼怒: 'angry', 不满: 'annoyed',
  害怕: 'scared', 恐惧: 'scared', 紧张: 'nervous', 焦虑: 'anxious',
  温柔: 'gentle', 平静: 'calm', 冷淡: 'cold', 无奈: 'helpless',
  惊讶: 'surprised', 震惊: 'shocked', 疑惑: 'confused', 好奇: 'curious',
  害羞: 'shy', 撒娇: 'cute', 疲惫: 'tired', 困: 'sleepy',
  心声: 'whispering', 耳语: 'whispering', 低语: 'whispering',
  笑: 'laughing', 哭: 'crying', 叹气: 'sighing',
  认真: 'serious', 郑重: 'serious', 嘲讽: 'sarcastic', 调侃: 'playful',
};

/**
 * 把中文情绪翻成英文。已经是英文的原样返回（小写）。
 * 认不出返回空串 —— 空串等于"不给情绪提示"，比给错的好。
 */
export function normalizeEmotion(emotion) {
  const word = String(emotion ?? '').trim();
  if (!word) return '';
  if (/^[a-z][a-z\s'-]{0,29}$/i.test(word)) return word.toLowerCase();

  // 先找完全包含的（"有点开心" → happy）
  for (const [zh, en] of Object.entries(EMOTION_MAP)) {
    if (word.includes(zh)) return en;
  }
  return '';
}

/** 用变量填模板。只认 {{name}}，填不进去的原样留着（方便用户看出哪个变量写错了）。 */
export function fill(template, vars) {
  if (typeof template !== 'string') return template;
  return template.replace(/\{\{\s*(\w+)\s*\}\}/g, (m, name) =>
    name in vars ? String(vars[name] ?? '') : m);
}

/** 递归填一个对象（请求体要用） */
export function fillDeep(value, vars) {
  if (typeof value === 'string') return fill(value, vars);
  if (Array.isArray(value)) return value.map(v => fillDeep(v, vars));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, fillDeep(v, vars)]));
  }
  return value;
}

/** 按路径取字段：'data.audio' / 'choices.0.text' */
export function pick(obj, path) {
  if (!path) return obj;
  let cur = obj;
  for (const part of String(path).split('.')) {
    if (cur == null) return undefined;
    cur = cur[part];
  }
  return cur;
}

/**
 * 引擎配置的默认形状。设置页会照这个生成表单。
 * 所有字段用户都能改 —— 内置的只是"填好的默认值"。
 */
export function createEngine(overrides = {}) {
  return {
    id: overrides.id ?? '',
    name: overrides.name ?? '未命名引擎',
    kind: 'http',                       // http | browser

    // 账号
    base: '',                           // 接口根地址
    key: '',
    model: '',
    voice: '',                          // 默认音色（角色没单独配时用）

    // 请求
    endpoint: '',                       // 可以是完整地址，也可以带 {{base}}
    method: 'POST',
    headers: {},                        // 值里可用 {{key}} / {{base}}
    body: {},                           // 一般放 text / voice / model

    // 情绪
    emotion: 'none',                    // none | bracket | paren
    emotionTranslate: true,             // 中文情绪是否翻成英文

    // 响应
    response: 'audio',                  // audio | json-base64 | json-url
    responsePath: '',                   // json 时取哪个字段

    // 体验
    voiceHint: [],                      // 给下拉框用的候选音色（可空）
    note: '',                           // 给自己看的备注

    ...overrides,
  };
}

/**
 * 内置模板。
 *
 * 注意：这些**不是**写死的引擎，是"填好默认值的配置"。
 * 用户在设置页里能看到每个字段、能改、能复制一份改成自己的。
 * 加一个服务商支持，就是在这里多加一条。
 */
export const BUILTIN_ENGINES = Object.freeze([
  {
    id: 'openai',
    name: 'OpenAI 兼容（/audio/speech）',
    kind: 'http',
    base: 'https://api.openai.com/v1',
    model: 'tts-1',
    voice: 'alloy',
    endpoint: '{{base}}/audio/speech',
    method: 'POST',
    headers: { Authorization: 'Bearer {{key}}', 'Content-Type': 'application/json' },
    body: { model: '{{model}}', input: '{{text}}', voice: '{{voice}}', response_format: 'mp3' },
    emotion: 'none',
    response: 'audio',
    voiceHint: ['alloy', 'echo', 'fable', 'onyx', 'nova', 'shimmer'],
    note: '大部分中转站都支持这个格式，先用它试通最省事',
  },
  {
    id: 'fish',
    name: 'Fish Audio',
    kind: 'http',
    base: 'https://api.fish.audio/v1',
    model: 's1',
    voice: '',
    endpoint: '{{base}}/tts',
    method: 'POST',
    headers: { Authorization: 'Bearer {{key}}', 'Content-Type': 'application/json' },
    body: { text: '{{text}}', reference_id: '{{voice}}', format: 'mp3', model: '{{model}}' },
    emotion: 'paren',
    emotionTranslate: true,
    response: 'audio',
    voiceHint: [],
    note: 'S1 用 (happy) 括号；换成 S2 模型要改成 [happy]，在这里改情绪模式',
  },
  {
    id: 'minimax',
    name: 'MiniMax',
    kind: 'http',
    base: 'https://api.minimaxi.com/v1',
    model: 'speech-02-hd',
    voice: '',
    endpoint: '{{base}}/t2a_v2',
    method: 'POST',
    headers: { Authorization: 'Bearer {{key}}', 'Content-Type': 'application/json' },
    body: {
      model: '{{model}}',
      text: '{{text}}',
      stream: false,
      voice_setting: { voice_id: '{{voice}}', speed: 1, vol: 1, pitch: 0 },
      audio_setting: { format: 'mp3', sample_rate: 32000, bitrate: 128000 },
    },
    emotion: 'none',
    response: 'json-base64',
    responsePath: 'data.audio',
    voiceHint: [],
    note: '返回的是 JSON，音频在 data.audio 里的 hex 或 base64',
  },
  {
    id: 'browser',
    name: '浏览器朗读（免费，兜底）',
    kind: 'browser',
    model: '',
    voice: '',
    emotion: 'none',
    response: 'audio',
    voiceHint: [],
    note: '不用配任何东西，用系统自带的声音。效果一般，但没有成本，适合先验证流程',
  },
]);

/** 从内置模板造一份可编辑的配置 */
export const templateOf = (id) => {
  const hit = BUILTIN_ENGINES.find(e => e.id === id);
  return hit ? createEngine(structuredClone(hit)) : null;
};

/**
 * 把情绪塞进文本。
 * @returns {{text: string, used: string}} used: 实际生效的情绪词（可能被丢弃）
 */
export function applyEmotion(rawText, emotion, engine) {
  const text = String(rawText ?? '');
  const mode = engine?.emotion ?? 'none';
  if (mode === 'none') return { text, used: '' };

  const word = engine?.emotionTranslate === false
    ? String(emotion ?? '').trim()
    : normalizeEmotion(emotion);

  if (!word) return { text, used: '' };
  if (word.length > 40) return { text, used: '' };

  const prefix = mode === 'bracket' ? `[${word}] ` : `(${word}) `;
  // 文本自己已经带括号/方括号开头时不再加，避免套娃
  if (/^\s*[[(（]/.test(text)) return { text, used: '' };

  return { text: prefix + text, used: word };
}

/** 校验一条引擎配置，返回人话的问题列表 */
export function validateEngine(engine) {
  const problems = [];
  if (!engine) { problems.push('还没有选引擎'); return problems; }

  if (engine.kind === 'browser') return problems;   // 浏览器朗读什么都不用配

  if (!engine.base && !/\{\{base\}\}/.test(engine.endpoint ?? '') && !engine.endpoint) {
    problems.push('接口地址是空的');
  }
  if (!engine.endpoint) problems.push('缺 endpoint（完整的请求地址，可以用 {{base}} 拼）');
  if (engine.response === 'json-base64' || engine.response === 'json-url') {
    if (!engine.responsePath) problems.push('响应类型选了 JSON，但没填「取哪个字段」');
  }
  if (!String(engine.body?.input ?? engine.body?.text ?? '').includes('{{text}}')) {
    problems.push('请求体里没有 {{text}} —— 引擎不知道该念什么');
  }
  return problems;
}
