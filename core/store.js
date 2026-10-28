/**
 * 存储层 —— 聊天记录和朋友圈存哪。
 *
 * 【三层分开，各有各的道理】
 *   设置    → 酒馆 settings.json（跟着账号走，换设备自动同步）
 *   聊天/朋友圈 → IndexedDB（量大，不同步）
 *   临时状态  → 内存（丢了不心疼）
 *
 * 【隔离】
 * 一个数据库装所有角色卡的数据，靠 scope 字段分家：
 *   card:<头像文件名>   /   group:<群 id>
 * 用头像文件名而不是 characterId —— 删卡之后下标会漂移，用下标会导致
 * "删了 A，B 的数据串进 A 的位置"。
 *
 * 【为什么图片不进设置】
 * 酒馆会把整个 settings 序列化进 settings.json。几十张 base64 图片 =
 * 存档几十 MB = 保存卡顿 → 极端情况存档打不开、角色卡全丢。
 * 图片只能进 IndexedDB 或服务器文件。
 */

const DB_NAME = 'mini_phone';
const DB_VERSION = 1;

const STORES = {
  threads: 'threads',     // keyPath: ['scope','id']
  moments: 'moments',     // keyPath: ['scope','id']
  media: 'media',         // keyPath: 'id'（图片 Blob，跨 scope 共用）
  kv: 'kv',              // keyPath: ['scope','key']
};

/* ------------------------------------------------------------- 底层 */

let dbPromise = null;

function openDB(indexedDB = globalThis.indexedDB) {
  if (dbPromise) return dbPromise;
  if (!indexedDB?.open) return Promise.reject(new Error('这个浏览器不支持本地存储'));

  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORES.threads)) {
        const s = db.createObjectStore(STORES.threads, { keyPath: ['scope', 'id'] });
        s.createIndex('scope', 'scope');
      }
      if (!db.objectStoreNames.contains(STORES.moments)) {
        const s = db.createObjectStore(STORES.moments, { keyPath: ['scope', 'id'] });
        s.createIndex('scope', 'scope');
        s.createIndex('scopeAt', ['scope', 'at']);
      }
      if (!db.objectStoreNames.contains(STORES.media)) {
        db.createObjectStore(STORES.media, { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains(STORES.kv)) {
        db.createObjectStore(STORES.kv, { keyPath: ['scope', 'key'] });
      }
    };
    req.onerror = () => reject(new Error('打不开本地数据库，检查浏览器的存储权限'));
    req.onblocked = () => reject(new Error('另一个页面占用了数据库，关掉旧页面再试'));
    req.onsuccess = () => {
      const db = req.result;
      // 版本变更时自动关掉，下次访问重开
      db.onversionchange = () => { db.close(); dbPromise = null; };
      resolve(db);
    };
  }).catch(e => { dbPromise = null; throw e; });

  return dbPromise;
}

/** 一次事务。任何一步失败整体回滚，不留半条数据。 */
async function tx(storeName, mode, work, indexedDB) {
  const db = await openDB(indexedDB);
  return new Promise((resolve, reject) => {
    let t;
    try { t = db.transaction(storeName, mode); }
    catch (e) { reject(new Error('数据库连接断了，刷新页面再试')); return; }

    const store = t.objectStore(storeName);
    let result;

    t.oncomplete = () => resolve(result);
    t.onabort = () => {
      const err = t.error;
      reject(new Error(err?.name === 'QuotaExceededError'
        ? '设备存储空间不足，没有保存'
        : '没有保存成功，请重试'));
    };

    try {
      work(store, v => { result = v; }, e => { try { t.abort(); } catch {} ; reject(e); });
    } catch (e) { reject(e); }
  });
}

const all = (store, idx, key) => new Promise((resolve) => {
  const req = idx ? store.index(idx).getAll(key) : store.getAll();
  req.onsuccess = () => resolve(req.result ?? []);
  req.onerror = () => resolve([]);
});

const one = (store, key) => new Promise((resolve) => {
  const req = store.get(key);
  req.onsuccess = () => resolve(req.result ?? null);
  req.onerror = () => resolve(null);
});

/* ------------------------------------------------------------- 门面 */

const uid = () => (globalThis.crypto?.randomUUID?.() ??
  String(Date.now(36)) + Math.random().toString(36).slice(2, 8));

/**
 * @param {{ scope: () => string, indexedDB?: IDBFactory }} opts
 *        scope 每次都现取 —— 换角色卡后必须立刻生效，不能缓存
 */
export function createStore({ scope, indexedDB } = {}) {
  const sc = () => String(scope?.() ?? 'default');

  return {
    /* ------------------------------------------------------- 会话 */
    threads: {
      async list() {
        const rows = await tx(STORES.threads, 'readonly',
          (s, done) => all(s, 'scope', sc()).then(done), indexedDB).catch(() => []);
        return rows.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
      },

      async get(id) {
        return tx(STORES.threads, 'readonly', (s, done) => one(s, [sc(), String(id)]).then(done), indexedDB)
          .catch(() => null);
      },

      /** 建或整体覆盖 */
      async save(thread) {
        const row = { ...thread, scope: sc(), id: String(thread.id), updatedAt: Date.now() };
        await tx(STORES.threads, 'readwrite', (s, done) => {
          s.put(row); done(row);
        }, indexedDB);
        return strip(row);
      },

      async create({ type = 'dm', name, members = [], partner = '' }) {
        const thread = {
          id: uid(), type, name, members, partner,
          messages: [], unread: 0,
          createdAt: Date.now(), updatedAt: Date.now(),
        };
        return this.save(thread);
      },

      /**
       * 追加消息。带去重：同样的 (floor, from, kind, text) 只进一条。
       * 酒馆会重抽、会重生成、会重复触发事件 —— 不去重手机上就会多三条一样的。
       */
      async append(id, incoming, { read = false } = {}) {
        return tx(STORES.threads, 'readwrite', (s, done) => {
          one(s, [sc(), String(id)]).then(thread => {
            if (!thread) { done(null); return; }
            const seen = new Set(thread.messages.map(fingerprint));
            const fresh = [];
            for (const m of [].concat(incoming)) {
              const msg = { id: uid(), at: Date.now(), kind: 'text', meta: {}, ...m };
              const f = fingerprint(msg);
              if (seen.has(f)) continue;
              seen.add(f);
              fresh.push(msg);
            }
            thread.messages.push(...fresh);
            if (!read) thread.unread = (thread.unread ?? 0) + fresh.filter(m => m.from !== 'me').length;
            thread.updatedAt = Date.now();
            s.put(thread);
            done({ thread: strip(thread), fresh });
          });
        }, indexedDB);
      },

      /** 撤回某条回复带来的消息（重抽时用） */
      async withdraw(id, match) {
        return tx(STORES.threads, 'readwrite', (s, done) => {
          one(s, [sc(), String(id)]).then(thread => {
            if (!thread) { done(0); return; }
            const keep = thread.messages.filter(m => !match(m));
            const gone = thread.messages.length - keep.length;
            thread.messages = keep;
            s.put(thread);
            done(gone);
          });
        }, indexedDB);
      },

      async markRead(id) {
        return tx(STORES.threads, 'readwrite', (s, done) => {
          one(s, [sc(), String(id)]).then(thread => {
            if (!thread) { done(null); return; }
            thread.unread = 0;
            s.put(thread);
            done(strip(thread));
          });
        }, indexedDB);
      },

      async remove(id) {
        return tx(STORES.threads, 'readwrite', (s, done) => {
          s.delete([sc(), String(id)]); done(true);
        }, indexedDB);
      },
    },

    /* ----------------------------------------------------- 朋友圈 */
    moments: {
      async list({ limit = 100 } = {}) {
        const rows = await tx(STORES.moments, 'readonly',
          (s, done) => all(s, 'scope', sc()).then(done), indexedDB).catch(() => []);
        return rows.sort((a, b) => (b.at ?? 0) - (a.at ?? 0)).slice(0, limit).map(strip);
      },

      async add(input) {
        const row = {
          id: uid(), at: Date.now(),
          author: '', text: '', images: [], likes: [], comments: [],
          floor: null, unread: true,
          ...input, scope: sc(), id: String(input.id ?? uid()),
        };
        await tx(STORES.moments, 'readwrite', (s, done) => { s.put(row); done(row); }, indexedDB);
        return strip(row);
      },

      /** 去重写入：同作者 + 同文本 + 同楼层只进一条 */
      async addMany(list) {
        const existing = await this.list({ limit: 500 });
        const seen = new Set(existing.map(fingerprintMoment));
        const added = [];
        for (const m of list) {
          const f = fingerprintMoment(m);
          if (seen.has(f)) continue;
          seen.add(f);
          added.push(await this.add(m));
        }
        return added;
      },

      async update(id, patch) {
        return tx(STORES.moments, 'readwrite', (s, done) => {
          one(s, [sc(), String(id)]).then(row => {
            if (!row) { done(null); return; }
            const next = { ...row, ...patch, id: row.id, scope: row.scope };
            s.put(next);
            done(strip(next));
          });
        }, indexedDB);
      },

      async remove(id) {
        return tx(STORES.moments, 'readwrite', (s, done) => {
          s.delete([sc(), String(id)]); done(true);
        }, indexedDB);
      },

      async markAllRead() {
        return tx(STORES.moments, 'readwrite', (s, done) => {
          all(s, 'scope', sc()).then(rows => {
            for (const r of rows) if (r.unread) s.put({ ...r, unread: false });
            done(rows.length);
          });
        }, indexedDB);
      },
    },

    /* -------------------------------------------------------- 其他 */
    media: {
      async get(id) {
        return tx(STORES.media, 'readonly', (s, done) => one(s, String(id)).then(done), indexedDB)
          .catch(() => null);
      },
      async put(id, blob, meta = {}) {
        return tx(STORES.media, 'readwrite', (s, done) => {
          s.put({ id: String(id), blob, meta, at: Date.now() }); done(true);
        }, indexedDB);
      },
      async remove(id) {
        return tx(STORES.media, 'readwrite', (s, done) => { s.delete(String(id)); done(true); }, indexedDB);
      },
    },

    kv: {
      async get(key, fallback = null) {
        const row = await tx(STORES.kv, 'readonly', (s, done) => one(s, [sc(), String(key)]).then(done), indexedDB)
          .catch(() => null);
        return row ? row.value : fallback;
      },
      async set(key, value) {
        return tx(STORES.kv, 'readwrite', (s, done) => {
          s.put({ scope: sc(), key: String(key), value }); done(true);
        }, indexedDB);
      },
    },

    /** 清掉当前角色卡的全部数据 */
    async clear() {
      for (const store of [STORES.threads, STORES.moments, STORES.kv]) {
        await tx(store, 'readwrite', (s, done) => {
          all(s, 'scope', sc()).then(rows => {
            for (const r of rows) {
              const key = store === STORES.kv ? [sc(), r.key] : [sc(), r.id];
              s.delete(key);
            }
            done(rows.length);
          });
        }, indexedDB).catch(() => 0);
      }
    },
  };
}

/* --------------------------------------------------------- 小工具 */

const strip = (row) => { if (!row) return null; const { scope, ...rest } = row; return rest; };

/** 消息去重指纹：来自哪楼 + 谁 + 类型 + 内容前 40 字 */
function fingerprint(m) {
  return [m.floor ?? '', m.from ?? '', m.kind ?? 'text', String(m.text ?? '').slice(0, 40)].join('|');
}

function fingerprintMoment(m) {
  return [m.floor ?? '', m.author ?? '', String(m.text ?? '').slice(0, 40)].join('|');
}

export { uid };
