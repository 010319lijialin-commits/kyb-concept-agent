// 和自己的服务器同步（几个人一起记一本账）：
// - 服务器是准：每一笔在服务器上有一个版本号（_s）。从服务器来的单据都带着它。
// - 本机改过、还没传上去的：带着修改时间 _u，没有 _s。删掉的留在 deleted 里，加进下拉单的留在 listU 里。
// - 同步一次 = 先把这些传上去（服务器检查权限，按到达先后，后到的算），再把别人改的拉下来。
// - 拉下来的变化碰到本机还没传上去的同一笔：先留本机的，下次传上去。
// 全是纯函数，浏览器和测试共用。

import { COLLECTIONS, LIST_KEYS, emptyState } from './core.js';

const PK = (p) => `${p.supplier}\u0001${p.product}`;
const isPending = (r) => Boolean(r) && r._u != null && r._s == null;
const strip = (r) => {
  const { _s, _by, _t, _u, ...d } = r;
  return d;
};

// 本机有哪些还没传上去：[{ kind, key, data（null = 删掉）, u, tomb? }]
export function pendingChanges(s) {
  const out = [];
  for (const c of COLLECTIONS) for (const r of s[c] || []) if (isPending(r)) out.push({ kind: c, key: r.id, data: strip(r), u: r._u });
  for (const p of s.prices || []) if (isPending(p)) out.push({ kind: 'prices', key: PK(p), data: strip(p), u: p._u });
  if (isPending(s.settings)) out.push({ kind: 'settings', key: 'settings', data: strip(s.settings), u: s.settings._u });
  for (const [k, u] of Object.entries(s.listU || {})) {
    const i = k.indexOf(':');
    if ((s.lists?.[k.slice(0, i)] || []).includes(k.slice(i + 1))) out.push({ kind: 'lists', key: k, data: {}, u, list: true });
  }
  for (const [k, u] of Object.entries(s.deleted || {})) {
    const i = k.indexOf(':');
    const t = k.slice(0, i), rest = k.slice(i + 1);
    const kind = COLLECTIONS.includes(t) ? t : t === 'price' ? 'prices' : t === 'list' ? 'lists' : null;
    if (kind) out.push({ kind, key: rest, data: null, u, tomb: k });
  }
  return out;
}

const tombKey = (kind, key) => (kind === 'prices' ? `price:${key}` : kind === 'lists' ? `list:${key}` : `${kind}:${key}`);

// 服务器发来的变化并进本机的账：[{ kind, key, data（null = 删了）, seq, by, t }]。
// force：连本机还没传上去的也盖掉（服务器拒收时，恢复成服务器上的样子）
export function applyServerChanges(s, changes, { force = false } = {}) {
  if (!changes.length) return s;
  const out = {
    ...s,
    deleted: { ...(s.deleted || {}) },
    listU: { ...(s.listU || {}) },
    lists: Object.fromEntries(LIST_KEYS.map((k) => [k, [...(s.lists?.[k] || [])]])),
  };
  const maps = {};
  const mapOf = (c, keyOf) => {
    if (!maps[c]) {
      out[c] = [...(s[c] || [])];
      maps[c] = new Map(out[c].map((r, i) => [keyOf(r), i]));
    }
    return maps[c];
  };
  for (const ch of changes) {
    const meta = { _s: ch.seq, _by: ch.by ?? null, _t: ch.t ?? null };
    const tk = tombKey(ch.kind, ch.key);
    if (COLLECTIONS.includes(ch.kind) || ch.kind === 'prices') {
      const m = mapOf(ch.kind, ch.kind === 'prices' ? PK : (r) => r.id);
      const list = out[ch.kind];
      const i = m.get(ch.key);
      if (!force && (out.deleted[tk] != null || isPending(list[i]))) continue;
      delete out.deleted[tk];
      if (ch.data == null) {
        if (i != null) { list[i] = null; m.delete(ch.key); }
      } else if (i != null) list[i] = { ...ch.data, ...meta };
      else { m.set(ch.key, list.length); list.push({ ...ch.data, ...meta }); }
    } else if (ch.kind === 'settings') {
      if (!force && isPending(out.settings)) continue;
      if (ch.data) out.settings = { ...ch.data, ...meta };
    } else if (ch.kind === 'lists') {
      const j = ch.key.indexOf(':');
      const lk = ch.key.slice(0, j), name = ch.key.slice(j + 1);
      if (!LIST_KEYS.includes(lk)) continue;
      if (!force && (out.deleted[tk] != null || out.listU[ch.key] != null)) continue;
      delete out.deleted[tk];
      delete out.listU[ch.key];
      const arr = out.lists[lk];
      const at = arr.indexOf(name);
      if (ch.data == null) { if (at >= 0) arr.splice(at, 1); } else if (at < 0) arr.push(name);
    }
  }
  for (const c of Object.keys(maps)) out[c] = out[c].filter(Boolean);
  return out;
}

// 传上去以后：服务器收下的标上版本号（传的过程中又改过的不标，下次再传）；拒收的返回出来
export function markPushed(s, sent, results) {
  const rejected = [];
  sent.forEach((ch, i) => {
    const r = results[i] || { ok: false, reason: 'lost' };
    if (!r.ok) { rejected.push({ ...ch, reason: r.reason, current: r.current || null }); return; }
    if (ch.tomb) { if (s.deleted?.[ch.tomb] === ch.u) delete s.deleted[ch.tomb]; return; }
    if (ch.list) { if (s.listU?.[ch.key] === ch.u) delete s.listU[ch.key]; return; }
    const rec = ch.kind === 'settings' ? s.settings
      : ch.kind === 'prices' ? (s.prices || []).find((p) => PK(p) === ch.key)
        : (s[ch.kind] || []).find((x) => x.id === ch.key);
    if (rec && rec._u === ch.u) Object.assign(rec, { _s: r.seq, _by: r.by ?? null, _t: r.t ?? null });
  });
  return rejected;
}

// 拒收的那些恢复成服务器上的样子（服务器上没有的就删掉）
export function revertRejected(s, rejected) {
  return applyServerChanges(s, rejected.map((x) => ({
    kind: x.kind, key: x.key, data: x.current?.data ?? null, seq: x.current?.seq ?? 0, by: x.current?.by, t: x.current?.t,
  })), { force: true });
}

// 服务器的数据被恢复到更早的备份：本机只留还没传上去的，其余重新拉
export function keepPendingOnly(s) {
  const out = { ...emptyState(), deleted: { ...(s.deleted || {}) }, listU: { ...(s.listU || {}) } };
  for (const c of COLLECTIONS) out[c] = (s[c] || []).filter(isPending);
  out.prices = (s.prices || []).filter(isPending);
  if (isPending(s.settings)) out.settings = s.settings;
  out.lists = Object.fromEntries(LIST_KEYS.map((k) => [k, (s.lists?.[k] || []).filter((n) => out.listU[`${k}:${n}`] != null)]));
  return out;
}

export const hasPending = (s) => pendingChanges(s).length > 0;
