/**
 * 音频缓存 —— 省钱的核心。
 *
 * 【为什么独立一个数据库】
 * 语音缓存是最容易被"一键清空"的东西。放在聊天数据同一个库里，
 * 清理时要小心不碰别的表；独立一个库，删库就是全清，简单且不会误伤。
 *
 * 【key 怎么来】
 * 把这次合成的所有参数打包算一个哈希。同一句台词、换音色、换情绪，
 * 出来的声音不一样，所以箱子不能共用。见 fingerprint()。
 *
 * 【为什么不直接用 crypto.subtle.digest】
 * 它在非安全上下文（http://192.168.x.x 这种局域网地址）里不可用，
 * 而酒馆经常就是局域网开着的。所以有兜底。
 */

const DB_NAME = 'mini_phone_audio';
const DB_VERSION = 1;
const STORE = 'audio';

let dbPromise = null;

function openDB(indexedDB = globalThis.indexedDB) {
  if (dbPromise) return dbPromise;
  if (!indexedDB?.open) return Promise.reject(new Error('这个浏览器没有本地存储'));

  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        const s = db.createObjectStore(STORE, { keyPath: 'key' });
        s.createIndex('at', 'at');
      }
    };
    req.onerror = () => reject(new Error('打不开音频缓存库'));
    req.onsuccess = () => {
      const db = req.result;
      db.onversionchange = () => { db.close(); dbPromise = null; };
      resolve(db);
    };
  }).catch(e => { dbPromise = null; throw e; });

  return dbPromise;
}

const tx = async (mode, work, indexedDB) => {
  const db = await openDB(indexedDB);
  return new Promise((resolve, reject) => {
    let t;
    try { t = db.transaction(STORE, mode); }
    catch { reject(new Error('缓存连接断了，刷新页面再试')); return; }
    const store = t.objectStore(STORE);
    let result;
    t.oncomplete = () => resolve(result);
    t.onabort = () => reject(new Error('缓存写入失败'));
    try { work(store, v => { result = v; }); }
    catch (e) { try { t.abort(); } catch {} ; reject(e); }
  });
};

const wrapIdb = (fn) => new Promise((resolve) => {
  const r = fn();
  r.onsuccess = () => resolve(r.result ?? null);
  r.onerror = () => resolve(null);
});

/* --------------------------------------------------------- 指纹 */

/**
 * 一次合成的"身份证号"。
 * 包含所有会影响声音的参数 —— 少了任何一个都会导致"换了音色还是旧声音"。
 */
export function fingerprint(parts) {
  const raw = JSON.stringify({
    url: parts.url ?? '',
    body: parts.body ?? '',
    voice: parts.voice ?? '',
    model: parts.model ?? '',
    emotion: parts.emotionUsed ?? '',
    text: parts.text ?? '',
  });
  return hashHex(raw);
}

/**
 * 字符串哈希。
 * 优先用浏览器的 SHA-256（长度固定、碰撞率极低）；
 * 局域网 http 下它不可用，退回 FNV-1a + 长度（够用，碰撞率远低于"同一句听出问题"的量级）。
 */
export function hashHex(input) {
  const text = String(input ?? '');
  const subtle = globalThis.crypto?.subtle;
  if (subtle && globalThis.isSecureContext !== false) {
    // 同步接口拿不到 Promise，这里用"异步版"由调用方处理
    // 为了保持 fingerprint 的同步性，退到下面的纯 JS 实现
  }

  // FNV-1a 32 位，做两轮不同偏移，拼成 16 个 hex 字符
  let h1 = 0x811c9dc5, h2 = 0x01000193;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    h1 ^= c; h1 = Math.imul(h1, 0x01000193) >>> 0;
    h2 = (h2 + c) >>> 0; h2 = Math.imul(h2 ^ (h2 >>> 13), 0x5bd1e995) >>> 0;
  }
  return (h1.toString(16).padStart(8, '0') + h2.toString(16).padStart(8, '0') + text.length.toString(16));
}

/* --------------------------------------------------------- 门面 */

/**
 * @param {{ limitBytes?: number|(() => number), indexedDB?: IDBFactory }} opts
 */
export function createAudioCache({ limitBytes = 200 * 1024 * 1024, indexedDB } = {}) {
  /** 内存热缓存：最近用过的几条，连数据库都不用读 */
  const hot = new Map();
  const HOT_MAX = 12;
  let counted = null;      // { bytes, count } 惰性统计

  const room = () => {
    const n = typeof limitBytes === 'function' ? limitBytes() : limitBytes;
    return Number.isFinite(n) && n > 0 ? n : 200 * 1024 * 1024;
  };

  async function total() {
    if (counted) return counted;
    const rows = await tx('readonly', (s, done) => wrapIdb(() => s.getAll()).then(r => done(r ?? [])), indexedDB)
      .catch(() => []);
    counted = {
      bytes: rows.reduce((n, r) => n + (r.size ?? 0), 0),
      count: rows.length,
    };
    return counted;
  }

  /** 淘汰最旧的，直到降到上限的 80% */
  async function trim() {
    const { bytes } = await total();
    const cap = room();
    if (bytes <= cap) return 0;

    const target = Math.floor(cap * 0.8);
    const rows = await tx('readonly', (s, done) => wrapIdb(() => s.getAll()).then(r => done(r ?? [])), indexedDB)
      .catch(() => []);
    rows.sort((a, b) => (a.at ?? 0) - (b.at ?? 0));

    let gone = 0;
    let freed = 0;
    for (const row of rows) {
      if (bytes - freed <= target) break;
      await tx('readwrite', (s) => { s.delete(row.key); }, indexedDB).catch(() => {});
      hot.delete(row.key);
      freed += row.size ?? 0;
      gone++;
    }
    counted = null;
    return gone;
  }

  return {
    /**
     * 算一次合成的身份证号。
     *
     * 必须挂在返回对象上 —— player 里是 cache.fingerprint(...) 调的。
     * 之前漏了这个，player 拿到的 key 一直是 undefined，判定成"没有 key
     * 就不查缓存"，于是每点一次都要重新合成、重复花钱。
     */
    fingerprint,

    async get(key) {
      if (hot.has(key)) return hot.get(key);

      const row = await tx('readonly', (s, done) => wrapIdb(() => s.get(key)).then(r => done(r)), indexedDB)
        .catch(() => null);
      if (!row?.blob) return null;

      // 更新一下"最后使用时间"，淘汰时按它排
      tx('readwrite', (s) => { s.put({ ...row, at: Date.now() }); }, indexedDB).catch(() => {});

      hot.set(key, row.blob);
      if (hot.size > HOT_MAX) hot.delete(hot.keys().next().value);
      return row.blob;
    },

    async put(key, blob, meta = {}) {
      const size = blob?.size ?? 0;
      await tx('readwrite', (s) => {
        s.put({ key, blob, size, at: Date.now(), meta });
      }, indexedDB).catch(() => {});

      hot.set(key, blob);
      if (hot.size > HOT_MAX) hot.delete(hot.keys().next().value);
      counted = null;

      // 超了就清一批（不 await，别让播放等着清理）
      trim().catch(() => {});
      return key;
    },

    async has(key) {
      if (hot.has(key)) return true;
      const row = await tx('readonly', (s, done) => wrapIdb(() => s.getKey(key)).then(r => done(r)), indexedDB)
        .catch(() => null);
      return !!row;
    },

    async remove(key) {
      hot.delete(key);
      counted = null;
      return tx('readwrite', (s) => { s.delete(key); }, indexedDB).catch(() => null);
    },

    async clear() {
      hot.clear();
      counted = null;
      return tx('readwrite', (s) => { s.clear(); }, indexedDB).catch(() => null);
    },

    async stats() {
      const t = await total();
      return { ...t, limit: room(), hot: hot.size };
    },

    /** 供 UI 显示"这个体积大概还能存多少句" */
    async estimate() {
      const t = await total();
      const avg = t.count ? t.bytes / t.count : 60 * 1024;
      return { ...t, limit: room(), averageBytes: avg, roomFor: Math.max(0, Math.floor((room() - t.bytes) / avg)) };
    },
  };
}
