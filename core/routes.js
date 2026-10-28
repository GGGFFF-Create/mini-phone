/**
 * 角色名归一 —— "这句话是谁说的"的问题。
 *
 * 难点不是匹配，是同一个人的名字有无数种写法：
 *   夏尔 / 夏尔·凡多姆海恩 / 凡多姆海恩 / 少爷 / Charles
 *
 * 【设计】
 * 上一代用三级降级（完全匹配 → 别名 → 按分隔符拆片段）。有效，但每次查询都做线性扫描。
 * 这里改成**指纹索引**：给每个名字和别名算一个归一化指纹，建 Map。
 * 查询变成一次哈希查找，而且天然处理了标点/空格/大小写的差异。
 *
 * 指纹 = 去掉所有非字母数字汉字 + 小写 + 去重排序（可选）
 *   夏尔·凡多姆海恩 → 夏尔凡多姆海恩
 *   夏尔·凡多姆海恩 → 夏尔凡多姆海恩   （不同标点同一指纹）
 */

const SEP = /[·・•‧．.\s\-—_]+/;

/** 归一化：去分隔符、去标点、小写 */
export function fingerprint(name) {
  return String(name ?? '')
    .toLowerCase()
    .replace(/[^\p{Script=Han}\p{Letter}\p{Number}]/gu, '');
}

/** 拆成名字片段：夏尔·凡多姆海恩 → ['夏尔', '凡多姆海恩'] */
function segments(name) {
  return String(name ?? '').split(SEP).map(s => s.trim()).filter(s => s.length >= 2);
}

/**
 * 建一个名册。contacts 形状：
 *   [{ name, aliases: [], avatar, persona, appearance, voice, ... }]
 */
export function createRoster(contacts = []) {
  const list = contacts.filter(c => c?.name);

  /** 指纹 → 正式名 */
  const index = new Map();
  /** 片段指纹 → 正式名（只在这条片段唯一归属时才用） */
  const segIndex = new Map();
  const ambiguous = new Set();

  const put = (map, key, name) => {
    if (!key) return;
    const hit = map.get(key);
    if (hit && hit !== name) { map.set(key, null); ambiguous.add(key); return; }   // 冲突 → 标记为不可用
    map.set(key, name);
  };

  for (const c of list) {
    const name = String(c.name).trim();
    put(index, fingerprint(name), name);
    for (const a of c.aliases ?? []) {
      const alias = String(a ?? '').trim();
      if (alias && alias !== name) put(index, fingerprint(alias), name);
    }
    for (const seg of segments(name)) put(segIndex, fingerprint(seg), name);
  }

  const byName = new Map(list.map(c => [String(c.name).trim(), c]));

  return {
    list,

    /** 归一到正式名。认不出就原样返回 —— 绝不猜。 */
    resolve(name) {
      const raw = String(name ?? '').trim();
      if (!raw) return raw;
      if (byName.has(raw)) return raw;

      const key = fingerprint(raw);
      const exact = index.get(key);
      if (exact && !ambiguous.has(key)) return exact;

      // 全名写法（带分隔符）：看它是否包含某个已知片段
      const segs = segments(raw);
      if (segs.length > 1) {
        const hits = [...new Set(segs.map(s => segIndex.get(fingerprint(s))).filter(Boolean))];
        if (hits.length === 1) return hits[0];          // 只有唯一候选才替换
      }

      return raw;
    },

    has(name) { return byName.has(this.resolve(name)); },
    get(name) { return byName.get(this.resolve(name)) ?? null; },
    names() { return list.map(c => String(c.name).trim()); },

    /** 这条消息的 from 该归到谁；归不到已知的人就返回 null */
    owner(name) {
      const r = this.resolve(name);
      return byName.has(r) ? r : null;
    },
  };
}

/**
 * 把一组消息项的 from 归一，并丢掉认不出的人。
 * 投递端必须做这一步 —— 提示词里写了"名字只能是这些人"，模型照样会写"路人甲"。
 */
export function normalizeItems(items, roster) {
  const out = [];
  for (const item of items) {
    const owner = roster.owner(item.from);
    if (!owner) continue;
    out.push(item.from === owner ? item : { ...item, from: owner, said: item.from });
  }
  return out;
}
