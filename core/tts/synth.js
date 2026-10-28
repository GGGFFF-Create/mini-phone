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
export function buildRequest(engine, line = {}, { language = '' } = {}) {
  const { text, used } = applyEmotion(line.text ?? '', line.emotion ?? '', engine);

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
    rawText: String(line.text ?? ''),
    emotion: used,
    language: line.language || language || '',
    speed,
    speedPercent: Math.round(speed * 100),
  };

  const url = fill(engine.endpoint ?? '', vars);
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
export async function parseResponse(res, engine) {
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    const err = new Error(`语音接口返回 ${res.status}${detail ? '：' + detail.slice(0, 160) : ''}`);
    err.status = res.status;
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
