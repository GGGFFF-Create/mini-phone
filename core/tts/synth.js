/**
 * 把"一句台词 + 一个引擎配置"变成一段能播的音频。
 *
 * 这里只做三件事：拼请求、发出去、把结果解成 Blob。
 * 不关心缓存、不关心播放队列 —— 那是 cache.js 和 player.js 的事。
 */

import { applyEmotion, fill, fillDeep, pick } from './engine.js';

/**
 * 拼出一次合成的请求。
 * @returns {{url: string, init: RequestInit, vars: object, emotionUsed: string}}
 */
/**
 * 中转地址（反代）。
 *
 * 只替换域名部分，路径和查询原样保留：
 *   原  https://api.openai.com/v1/audio/speech
 *   中转 https://my-proxy.com
 *   结果 https://my-proxy.com/v1/audio/speech
 *
 * 中转地址带路径也行（很多反代是 https://proxy.com/openai 这种前缀），
 * 这时会拼在目标路径前面。
 */
export function applyProxy(url, proxy) {
  const p = String(proxy ?? '').trim();
  if (!p) return url;
  if (!/^https?:\/\//i.test(p)) return url;      // 不是完整地址就当没填

  try {
    const base = (typeof location !== 'undefined' && location.href) || 'http://localhost/';
    const target = new URL(url, base);
    const mid = new URL(p, base);
    const prefix = mid.pathname.replace(/\/+$/, '');
    const path = target.pathname.startsWith('/') ? target.pathname : `/${target.pathname}`;
    return `${mid.origin}${prefix}${path}${target.search}`;
  } catch {
    return url;
  }
}

export function buildRequest(engine, line = {}, { language = '' } = {}) {
  /*
   * 念哪一段？
   *
   * 优先译文。翻译卡的正文是「中文译文 + 日文原文」，玩家看的是中文，
   * 听的自然也该是中文 —— 念原文会变成"屏幕上中文、耳机里日语"。
   * 没有译文时才用原文（纯中文卡两者通常相同）。
   *
   * 注意：以前这里写的是 line.text（原文），而浏览器朗读那条路用的是
   * translation —— 两条路径不一致，同一句话换引擎就换语言。
   */
  const rawSpeak = String(line.translation ?? '').trim() || String(line.text ?? '');
  const { text, used } = applyEmotion(rawSpeak, line.emotion ?? '', engine);

  // 语速：引擎上配一个倍率，模板里能用 {{speed}}。
  // 浏览器朗读引擎直接拿它当 utterance.rate。
  const rawSpeed = line.speed ?? engine.speed ?? 1;
  const speed = Math.min(2, Math.max(0.5, Number(rawSpeed) || 1));

  const vars = {
    base: String(engine.base ?? '').replace(/\/+$/, ''),
    key: engine.key ?? '',
    model: engine.model ?? '',
    voice: line.voice || engine.voice || '',
    text,
    speakText: text,                        // 明确语义：要念的那段
    rawText: String(line.text ?? ''),       // 原文，模板里想用还能用
    translation: String(line.translation ?? ''),
    emotion: used,
    language: line.language || language || '',
    speed,
    speedPercent: Math.round(speed * 100),
  };

  let url = fill(engine.endpoint ?? '', vars);
  // 填了中转就走中转，没填就用 endpoint 拼出来的原地址
  url = applyProxy(url, engine.proxy);

  const headers = fillDeep(engine.headers ?? {}, vars);
  const body = fillDeep(engine.body ?? {}, vars);

  const init = {
    method: engine.method || 'POST',
    headers,
  };

  // GET 就不带 body 了；其余按 JSON 发
  if (init.method.toUpperCase() !== 'GET') {
    body.__mpText = vars.text;   // 留个标记，便于调试时确认文本进了哪里
    delete body.__mpText;
    init.body = JSON.stringify(body);
  }

  return { url, init, vars, emotionUsed: used, speed };
}

/**
 * 把响应解成 Blob。
 * 三种现实情况：直接给音频 / 给 base64 / 给一个下载链接。
 */
/**
 * 把 HTTP 错误翻译成"下一步该做什么"。
 *
 * 光甩一句「语音接口返回 502」用户没法行动：502 通常不是接口本身的问题，
 * 而是中转服务连不上上游；401 是 key 不对；404 是路径不对。
 */
export function describeHttpError(status, bodyText, url) {
  const body = String(bodyText ?? '').slice(0, 300);
  const host = (() => { try { return new URL(url).host; } catch { return String(url ?? ''); } })();

  let hint = '';
  if (status === 401 || status === 403) {
    hint = '鉴权没通过。Key 可能填错或过期，也可能中转服务没把 Authorization 头转发出去。';
  } else if (status === 404) {
    hint = '这个地址上没有接口。检查请求地址的路径（是不是少了 /v1），以及中转服务有没有转发这条路由。';
  } else if (status === 429) {
    hint = '请求太频繁或额度用完。等一会儿再试，或去服务商后台查余额。';
  } else if (status >= 500) {
    hint = '服务端出错，多半是对外接口或中转服务连不上上游。'
      + '502/504 常见于反向代理超时、上游域名解析失败。'
      + '可以先清空中转地址、直连接口试一次，确认是哪一段断的。';
  } else {
    hint = '检查接口地址、Key 和请求体。';
  }

  return `语音接口返回 ${status}（${host}）\n${hint}\n原始响应：${body || '(空)'}`;
}

export async function parseResponse(res, engine) {
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    const err = new Error(describeHttpError(res.status, detail, res.url));
    err.status = res.status;
    err.body = detail;
    throw err;
  }

  switch (engine.response) {
    case 'audio':
      return await res.blob();

    case 'json-base64': {
      const json = await res.json().catch(() => ({}));
      const raw = pick(json, engine.responsePath);
      if (!raw) throw new Error(`响应里找不到音频字段「${engine.responsePath}」`);
      return await bytesToBlob(decodeBase64ish(raw));
    }

    case 'json-url': {
      const json = await res.json().catch(() => ({}));
      const link = pick(json, engine.responsePath);
      if (!link) throw new Error(`响应里找不到链接字段「${engine.responsePath}」`);
      // 相对地址补成绝对
      const url = /^https?:/i.test(link) ? link : new URL(link, engine.base || location.href).href;
      const audio = await fetch(url);
      if (!audio.ok) throw new Error(`下载音频失败：${audio.status}`);
      return await audio.blob();
    }

    default:
      throw new Error(`不认识的响应类型：${engine.response}`);
  }
}

/** 有些服务返回 hex 而不是 base64（比如 MiniMax），两种都试 */
function decodeBase64ish(raw) {
  const s = String(raw).trim();
  // 纯 hex：只含 0-9a-f 且长度是偶数 —— 优先按 hex 解
  if (/^[0-9a-f]+$/i.test(s) && s.length % 2 === 0 && s.length > 64) {
    const out = new Uint8Array(s.length / 2);
    for (let i = 0; i < out.length; i++) out[i] = parseInt(s.slice(i * 2, i * 2 + 2), 16);
    return out;
  }
  // 否则按 base64
  try {
    const bin = atob(s.replace(/^data:[^;]+;base64,/, ''));
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    throw new Error('音频数据既不是 hex 也不是 base64');
  }
}

const bytesToBlob = (bytes) => new Blob([bytes], { type: guessMime(bytes) });

/** 从文件头猜格式，猜不到用 mp3 */
function guessMime(bytes) {
  if (bytes.length < 12) return 'audio/mpeg';
  const ascii = (from, to) => String.fromCharCode(...bytes.slice(from, to));
  if (ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WAVE') return 'audio/wav';
  if (ascii(0, 4) === 'OggS') return 'audio/ogg';
  if (ascii(4, 8) === 'ftyp') return 'audio/mp4';
  return 'audio/mpeg';
}

/* ------------------------------------------------------------ 浏览器朗读 */

/**
 * 用系统自带的声音念。
 * 不需要任何配置，但效果一般 —— 它的价值是"先让流程跑通"。
 */
export function speakWithBrowser(text, { voice = '', rate = 1, lang = '' } = {}, { onEnd, onError } = {}) {
  const synth = globalThis.speechSynthesis;
  if (!synth) throw new Error('这个浏览器不支持朗读');

  const raw = String(text ?? '');
  const utter = new SpeechSynthesisUtterance(raw);
  utter.rate = Math.max(0.5, Math.min(2, Number(rate) || 1));
  if (lang) utter.lang = lang;

  const voices = synth.getVoices?.() ?? [];
  const hit = voices.find(v => v.name === voice || v.voiceURI === voice)
    ?? (lang ? voices.find(v => v.lang?.startsWith(lang)) : null);
  if (hit) utter.voice = hit;

  /*
   * 超时兜底。
   *
   * onend 不是必然触发的：没有音频设备（无头浏览器、Linux 容器）、
   * 系统语音引擎缺失、浏览器把 speak 静默丢弃 —— 这几种情况下事件永远
   * 不来，调用方的 Promise 就永久挂住，界面上表现为"点了没反应，也停不下"。
   *
   * 按字数估一个上限：3 秒起步 + 每字 0.18 秒，最多 2 分钟。
   */
  let settled = false;
  const limit = Math.min(120_000, 3_000 + raw.length * 180);
  const timer = setTimeout(() => {
    if (settled) return;
    settled = true;
    try { synth.cancel(); } catch { /* 忽略 */ }
    onEnd?.();          // 当正常结束处理，别让调用方一直等
  }, limit);

  const finish = () => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
  };

  utter.onend = () => { finish(); onEnd?.(); };
  utter.onerror = (e) => {
    finish();
    onError?.(new Error(e?.error ?? '朗读失败'));
  };

  try {
    synth.cancel();       // 先停掉上一句，避免叠着念
    synth.speak(utter);
  } catch (e) {
    finish();
    onError?.(e instanceof Error ? e : new Error('朗读启动失败'));
    return utter;
  }

  return utter;
}

export const stopBrowserSpeech = () => globalThis.speechSynthesis?.cancel();
