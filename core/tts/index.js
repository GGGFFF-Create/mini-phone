/**
 * 语音门面 —— 把引擎配置、合成、缓存、播放组装起来。
 *
 * 【对外的四个动作】
 *   speak(line)          念一句
 *   speakAll(lines)      念一串
 *   prefetch(lines)      先做好，不播
 *   test(engineId)       测一个引擎通不通
 *
 * 【引擎从哪来】
 * 设置里有一张"引擎表"，用户能加、能改、能复制。
 * 内置的只是默认值，不是白名单 —— 任何 HTTP 接口都能接进来。
 */

import {
  BUILTIN_ENGINES, createEngine, templateOf, validateEngine, applyEmotion, normalizeEmotion,
} from './engine.js';
import { buildRequest, parseResponse, speakWithBrowser, stopBrowserSpeech } from './synth.js';
import { createAudioCache } from './cache.js';
import { createPlayer } from './player.js';

export * from './engine.js';

/**
 * @param {object} deps
 *   getSettings  () => 语音相关的设置切片
 *   emit         (type, payload) => void
 *   indexedDB    可选，测试用
 */
export function createTTS({ getSettings, emit = () => {}, indexedDB } = {}) {
  const cache = createAudioCache({
    limitBytes: () => (getSettings()?.cacheLimitMB ?? 200) * 1024 * 1024,
    indexedDB,
  });

  /* --------------------------------------------------- 引擎查询 */

  /** 当前配置里的引擎表：用户改过的优先，没改过的用内置默认值 */
  function engineTable() {
    const saved = getSettings()?.engines ?? {};
    const table = {};

    /*
     * 合并用户配置时跳过"空对象"。
     *
     * 老版本有个 bug：第一次改内置引擎的任意字段时，会把 body / headers
     * 存成 {}。之后再合并 {...模板, ...用户的 {}}，请求头和请求体就整片
     * 没了，症状是"只改了接口地址，测试却报请求体里没有 {{text}}"。
     *
     * 已经写坏的数据没法让人手动重填（他们也不知道原来长什么样），
     * 所以这里把空对象当作"没存过"，用模板补回来。
     */
    const merge = (base, user) => {
      const out = { ...base };
      for (const [k, v] of Object.entries(user ?? {})) {
        if (v === undefined || v === null) continue;
        const isEmptyObj = typeof v === 'object' && !Array.isArray(v)
          && Object.keys(v).length === 0;
        const baseHasObj = base?.[k] && typeof base[k] === 'object';
        if (isEmptyObj && baseHasObj) continue;
        out[k] = v;
      }
      return out;
    };

    for (const builtin of BUILTIN_ENGINES) {
      table[builtin.id] = createEngine({ ...merge(builtin, saved[builtin.id]), id: builtin.id });
    }

    // 用户自己加的
    for (const [id, cfg] of Object.entries(saved)) {
      if (!table[id]) table[id] = createEngine({ ...cfg, id });
    }
    return table;
  }

  function engine(id) {
    const table = engineTable();
    return table[id ?? getSettings()?.activeEngine] ?? null;
  }

  /* --------------------------------------------------- 角色音色 */

  /**
   * 这个角色用哪个引擎、哪个音色。
   * 三级降级：角色单独配的 → 引擎默认 → 空
   */
  function resolveVoice(line) {
    const s = getSettings() ?? {};
    const who = String(line?.role ?? '').trim();
    const binding = s.voices?.[who] ?? null;

    const engineId = binding?.engine || s.activeEngine;
    const engine = engineTable()[engineId];
    if (!engine) return { engine: null, voice: '', language: '' };

    return {
      engine,
      voice: binding?.voice || engine.voice || '',
      language: binding?.language || s.language || '',
    };
  }

  /* --------------------------------------------------- 合成 */

  const synthesize = {
    /** 预演：拼出请求（也用于算缓存指纹） */
    async prepare(line, route) {
      return buildRequest(route.engine, { ...line, voice: route.voice, language: route.language });
    },

    /** 真正发出去，拿 Blob */
    async send(line, route, { signal } = {}) {
      if (route.engine.kind === 'browser') {
        throw Object.assign(new Error('BROWSER_TTS'), { browser: true });
      }
      const { url, init } = buildRequest(route.engine, { ...line, voice: route.voice, language: route.language });
      const res = await fetch(url, { ...init, signal });
      return await parseResponse(res, route.engine);
    },
  };

  const player = createPlayer({ cache, synthesize, resolveVoice, emit });

  /* --------------------------------------------------- 对外 */

  return {
    engine,
    engines: engineTable,
    resolveVoice,
    level: () => player.level(),
    get busy() { return player.busy; },

    /** 这个角色配好音色了吗 */
    readyFor(line) {
      const { engine } = resolveVoice(line);
      if (!engine) return { ok: false, why: '还没有选引擎' };
      if (engine.kind === 'browser') return { ok: true };
      const problems = validateEngine(engine);
      if (problems.length) return { ok: false, why: problems[0] };
      if (!resolveVoice(line).voice) return { ok: false, why: `「${line.role}」还没有选音色` };
      return { ok: true };
    },

    /** 念一句。浏览器朗读引擎走另一条路。 */
    async speak(line, opts = {}) {
      await player.unlock();
      const { engine: eng, voice, language } = resolveVoice(line);

      if (eng?.kind === 'browser') {
        emit('line', { state: 'playing', line });
        return await new Promise((resolve, reject) => {
          try {
            speakWithBrowser(line.translation || line.text, { voice, lang: language, rate: line.speed ?? eng.speed ?? 1 }, {
              onEnd: () => { emit('line', { state: 'done', line }); resolve(true); },
              onError: (e) => { emit('line', { state: 'error', line, error: e.message }); reject(e); },
            });
          } catch (e) { reject(e); }
        });
      }

      return player.speak(line, opts);
    },

    async speakAll(lines, opts = {}) {
      await player.unlock();
      const { engine: eng, voice, language } = resolveVoice(lines[0] ?? {});

      if (eng?.kind === 'browser') {
        for (const line of lines) {
          await new Promise((resolve) => {
            try {
              speakWithBrowser(line.translation || line.text, { voice, lang: language, rate: line.speed ?? eng.speed ?? 1 }, { onEnd: resolve, onError: resolve });
            } catch { resolve(); }
          });
        }
        return true;
      }
      return player.speakAll(lines, opts);
    },

    async prefetch(lines, opts = {}) {
      const { engine: eng } = resolveVoice(lines[0] ?? {});
      if (eng?.kind === 'browser') return [];       // 浏览器朗读不用预取，它没有网络延迟
      return player.prefetch(lines, opts);
    },

    stop() {
      stopBrowserSpeech();
      player.stop();
    },

    /* --------------------------------------------- 测试与诊断 */

    /**
     * 测一个引擎通不通。用一句极短的文本，成本可以忽略。
     * @returns {{ok, ms, bytes?, error?}}
     */
    async test(engineId) {
      const eng = engineTable()[engineId];
      if (!eng) return { ok: false, error: '没有这个引擎' };

      const problems = validateEngine(eng);
      if (problems.length) return { ok: false, error: problems.join('；') };

      if (eng.kind === 'browser') {
        const names = globalThis.speechSynthesis?.getVoices?.() ?? [];
        return names.length
          ? { ok: true, note: `系统里有 ${names.length} 个声音` }
          : { ok: false, error: '系统里没有可用的朗读声音' };
      }

      const started = Date.now();
      try {
        const line = { role: '测试', text: '你好', emotion: '', translation: '你好' };
        const { url, init } = buildRequest(eng, { ...line, voice: eng.voice, language: '' });
        const res = await fetch(url, { ...init, signal: AbortSignal.timeout?.(20_000) });
        const blob = await parseResponse(res, eng);
        return { ok: true, ms: Date.now() - started, bytes: blob.size };
      } catch (e) {
        return { ok: false, ms: Date.now() - started, error: e?.message ?? String(e) };
      }
    },

    /**
     * 看看实际会发出去什么请求（不发送）。
     *
     * 排查配置问题最有用的一步：不通的时候能一眼看出是地址不对、
     * key 没带、还是请求体里没塞文本。key 一律打码，别截图泄露。
     */
    previewRequest(engineId, line = {}) {
      const id = engineId || getSettings()?.activeEngine;
      const eng = engineTable()[id];
      if (!eng) return { error: '没有这个引擎' };

      if (eng.kind === 'browser') {
        return { browser: true, text: String(line.text ?? '你好') };
      }

      try {
        const voice = line.voice || eng.voice || '';
        const { url, init, vars, emotionUsed } = buildRequest(eng, {
          ...line,
          voice,
          language: line.language || '',
        });

        const mask = (v) => {
          const str = String(v ?? '');
          if (!str) return '';
          if (str.length <= 8) return '****';
          return str.slice(0, 4) + '…' + str.slice(-4) + '（已打码，共 ' + str.length + ' 字符）';
        };

        const headers = {};
        for (const [k, v] of Object.entries(init.headers ?? {})) {
          headers[k] = /authorization|api[-_]?key|x-api-key/i.test(k) ? mask(v) : String(v);
        }

        return {
          url,
          method: init.method || 'POST',
          headers,
          body: init.body ?? '',
          emotionUsed,
          voice,
          problems: validateEngine(eng),
        };
      } catch (e) {
        return { error: e?.message ?? String(e) };
      }
    },

    /** 缓存统计，给设置页显示 */
    stats: () => cache.estimate(),
    clearCache: () => cache.clear(),

    /** 一段正文里有几句、分别谁说的（给"整段播放"用） */
    plan(lines) {
      return lines
        .filter(l => l?.text)
        .map(l => ({
          ...l,
          ready: this.readyFor(l).ok,
          voice: resolveVoice(l).voice,
          engineName: resolveVoice(l).engine?.name ?? '',
        }));
    },
  };
}
