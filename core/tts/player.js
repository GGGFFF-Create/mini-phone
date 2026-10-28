/**
 * 播放器 —— 让"第二次点立刻响"成立的地方。
 *
 * 【三件事】
 *   1. 去重：同一句正在做的时候，第二个请求等它，不重复下单
 *   2. 预取：播这一句时，下一句已经在做了
 *   3. 代际失效：用户切走了、换了消息，旧的回调必须自己退出
 *
 * 【为什么用 AudioContext 而不是 <audio>】
 * 要拿实时音量驱动那几根跳动的竖条。<audio> 拿不到波形。
 * 代价是必须"解锁"（iOS 要求音频由用户手势启动），所以有 unlock()。
 */

/* ------------------------------------------------------- 波形分析 */

/**
 * 把音频接到分析器上，对外给一个 0..1 的音量值。
 * UI 每帧读一次就行，不用自己算。
 */
function createMeter(ctx) {
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 256;
  const data = new Uint8Array(analyser.frequencyBinCount);

  return {
    node: analyser,
    level() {
      analyser.getByteTimeDomainData(data);
      let peak = 0;
      for (let i = 0; i < data.length; i++) {
        const v = Math.abs(data[i] - 128) / 128;
        if (v > peak) peak = v;
      }
      return peak;
    },
  };
}

/* --------------------------------------------------------- 播放器 */

/**
 * @param {object} deps
 *   cache          createAudioCache()
 *   synthesize     (line, engine) => Promise<Blob>   由 index.js 提供
 *   resolveVoice   (line) => { engine, voice, language }   角色 → 音色
 *   emit           (type, payload) => void
 */
export function createPlayer({ cache, synthesize, resolveVoice, emit = () => {} }) {
  let ctx = null;              // AudioContext
  let meter = null;
  let unlocked = false;
  let current = null;          // { source, epoch }
  let epoch = 0;               // 代际：每次 stop 或新播放都 +1
  const making = new Map();    // 指纹 → { job, controller }

  const isStale = (e) => e !== epoch;

  /* ------------------------------------------------- 解锁音频 */

  async function unlock() {
    if (unlocked) return true;
    try {
      const AC = globalThis.AudioContext || globalThis.webkitAudioContext;
      if (!AC) throw new Error('这个浏览器没有网页音频功能');
      ctx = ctx ?? new AC();

      /*
       * resume() 的 Promise 不是必然 resolve 的。
       *
       * 浏览器在没有用户手势时不放行音频（Chrome 的状态是 suspended，
       * 触发播放会报 not-allowed），这时 resume() 一直挂着不回来 ——
       * 调用方 await 在这里就永久卡死，界面上显示"点了没反应"。
       * 所以给它一个上限：600ms 拿不到 running 就接着走，
       * 让下层自己去撞 not-allowed 并报错，好过无声地卡住。
       */
      if (ctx.state === 'suspended') {
        await Promise.race([
          ctx.resume().catch(() => {}),
          new Promise((r) => setTimeout(r, 600)),
        ]);
      }

      meter = meter ?? createMeter(ctx);
      unlocked = ctx.state === 'running';
      // 播一个极短的静音，让 iOS 认定"音频由用户手势启动"
      const buf = ctx.createBuffer(1, 1, 22050);
      const src = ctx.createBufferSource();
      src.buffer = buf;
      src.connect(ctx.destination);
      src.start(0);
      return unlocked;
    } catch (e) {
      emit('error', { message: `音频初始化失败：${e?.message ?? e}` });
      return false;
    }
  }

  /* ------------------------------------------------- 拿音频 */

  /**
   * 一句台词的音频：缓存 → 合成 → 存缓存。带跨请求去重。
   * @returns {Promise<Blob|null>}
   */
  async function audioFor(line, { signal } = {}) {
    const route = resolveVoice(line);
    if (!route?.engine) throw new Error(`「${line.role}」还没有配音色`);

    const { url, init, vars, emotionUsed } = await synthesize.prepare(line, route);
    const key = cache.fingerprint
      ? cache.fingerprint({ url, body: init.body, voice: vars.voice, model: vars.model, emotionUsed, text: vars.text })
      : null;

    if (!key) return await synthesize.send(line, route);

    // ① 缓存
    const hit = await cache.get(key);
    if (hit) { emit('cache-hit', { role: line.role }); return hit; }

    // ② 有人正在做同一句：等它，不重复下单
    const inflight = making.get(key);
    if (inflight && !inflight.controller.signal.aborted) {
      emit('warm', { role: line.role });
      try { return await inflight.job; }
      catch { /* 对方失败了，自己再做一次 */ }
    }

    // ③ 自己做
    const controller = new AbortController();
    const onAbort = () => controller.abort();
    signal?.addEventListener('abort', onAbort, { once: true });

    const job = (async () => {
      try {
        const blob = await synthesize.send(line, route, { signal: controller.signal });
        if (blob?.size) await cache.put(key, blob, { role: line.role, text: line.text?.slice(0, 60) });
        return blob;
      } finally {
        signal?.removeEventListener('abort', onAbort);
        if (making.get(key)?.controller === controller) making.delete(key);
      }
    })();

    making.set(key, { job, controller });
    return await job;
  }

  /* ------------------------------------------------- 播放 */

  async function playBlob(blob, myEpoch) {
    if (!ctx) throw new Error('音频还没解锁，先点一下页面');
    if (isStale(myEpoch)) return false;

    const data = await blob.arrayBuffer();
    const buffer = await ctx.decodeAudioData(data.slice(0));
    if (isStale(myEpoch)) return false;

    return await new Promise((resolve) => {
      const source = ctx.createBufferSource();
      source.buffer = buffer;

      let tail = null;
      if (meter) {
        source.connect(meter.node);
        meter.node.connect(ctx.destination);
      } else {
        source.connect(ctx.destination);
      }

      const done = () => {
        if (current?.source === source) current = null;
        emit('playing', { on: false });
        resolve(true);
      };
      source.onended = done;

      current = { source, epoch: myEpoch };
      source.start(0);
      emit('playing', { on: true, duration: buffer.duration });
    });
  }

  /* ------------------------------------------------- 对外 */

  return {
    unlock,

    /** 当前音量 0..1，UI 每帧读它来画竖条 */
    level() { return meter?.level() ?? 0; },

    /**
     * 念一句。
     * @param {{role,text,emotion,translation}} line
     */
    async speak(line, { onState } = {}) {
      const myEpoch = ++epoch;
      onState?.('loading');
      emit('line', { state: 'loading', line });

      try {
        await unlock();
        const blob = await audioFor(line, {});
        if (isStale(myEpoch)) return false;

        onState?.('playing');
        emit('line', { state: 'playing', line });
        const ok = await playBlob(blob, myEpoch);

        onState?.(ok ? 'done' : 'idle');
        emit('line', { state: ok ? 'done' : 'idle', line });
        return ok;
      } catch (e) {
        if (isStale(myEpoch)) return false;
        onState?.('error');
        emit('line', { state: 'error', line, error: e?.message ?? String(e) });
        throw e;
      }
    },

    /**
     * 把一串台词挨个念完。中途 stop() 会立刻断。
     */
    async speakAll(lines, { onEach } = {}) {
      const myEpoch = ++epoch;
      for (const [i, line] of lines.entries()) {
        if (isStale(myEpoch)) return false;
        onEach?.(i, line, 'loading');
        try {
          const blob = await audioFor(line, {});
          if (isStale(myEpoch)) return false;
          onEach?.(i, line, 'playing');
          await playBlob(blob, myEpoch);
          onEach?.(i, line, 'done');
        } catch (e) {
          onEach?.(i, line, 'error');
          emit('error', { message: `${line.role}：${e?.message ?? e}` });
          // 一句失败不中断整段，继续下一句
        }
      }
      return true;
    },

    /**
     * 预取：把这几句的音频先做好，不播。
     * 用户点的时候就是"立刻响"。
     */
    async prefetch(lines, { signal, onEach } = {}) {
      const results = [];
      for (const line of lines) {
        if (signal?.aborted) break;
        try {
          const blob = await audioFor(line, { signal });
          results.push({ line, ok: !!blob });
          onEach?.(line, true);
        } catch (e) {
          results.push({ line, ok: false, error: e?.message });
          onEach?.(line, false);
        }
      }
      return results;
    },

    /** 停止：断掉当前音频，并让所有进行中的回调失效 */
    stop() {
      epoch++;
      try { current?.source?.stop(); } catch { /* 已经结束了 */ }
      current = null;
      for (const { controller } of making.values()) {
        try { controller.abort(); } catch { /* 忽略 */ }
      }
      making.clear();
      emit('playing', { on: false });
      emit('line', { state: 'idle' });
    },

    /** 正在做的句数（UI 可以显示"准备中 2/5"） */
    get busy() { return making.size; },

    get unlocked() { return unlocked; },
  };
}
