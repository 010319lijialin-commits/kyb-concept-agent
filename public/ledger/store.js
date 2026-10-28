// 账本存在哪：
// - 在 claude.ai 上打开：存在当前登录账号自己的私有空间（db 能力的 data/users/<id>/），
//   只有本人看得到，换手机 / 电脑登录同一账号也在。
// - 自己部署的服务里打开：没有 claude.ai 运行时，只存浏览器 localStorage。
// 两种情况都是「本机为主」：每一笔先存本机，没网也能记；联网后自动和云端同步。
//
// 云端怎么存（第 2 版）：
//   data/users/<id>/ledger2                  目录：{ v: 2, buckets: { <块名>: { h 内容指纹, n 分几段, g 版本 } } }
//   data/users/<id>/ledger2/b/<块名>~<g>~<i>  块内容的第 i 段：{ s: JSON 字符串 }
//   data/users/<id>/ledger2lock              同步时的短锁，同一时间只有一台设备在写
// 块：每类单据按月份一块（sales.2026-09）、设置 / 价目表 / 下拉单一块（meta）、删除记录一块（del）。
// 每次同步：拿锁 → 读目录 → 只下载别的设备改过的块 → 按每一笔合并 → 只上传变了的块 → 写目录。
// 所以两台设备同时记账不会互相覆盖；离线记的、刚打开还没连上云端时记的，都会在下次同步时合并上去。
//
// 第 1 版（data/users/<id>/ledger，整本账切段存）第一次同步时自动合并进来，旧数据原样保留不删。

import { mergeStates, COLLECTIONS } from './core.js';

const LOCAL_KEY = 'ledger.v1';
const KNOWN_KEY = 'ledger.sync';   // 上次同步时各块的指纹：只下载变了的块
const CHUNK = 60000;               // 一段最多这么多字符（中文按 3 字节算 ≈ 180 KB，单个文档上限 256 KiB）
const LEASE_MS = 8000;
const RETRY_MS = 15000;

// 整本账 → 块。块里的内容按固定顺序排好：两台设备合并出同样的账，指纹也一样，不会来回互相上传
const byId = (x, y) => (x.id < y.id ? -1 : x.id > y.id ? 1 : 0);
const sortedObj = (o) => Object.fromEntries(Object.entries(o || {}).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
export function toBuckets(s) {
  const out = {};
  for (const c of COLLECTIONS) {
    for (const r of s[c] || []) {
      const m = /^\d{4}-\d{2}/.test(r.date || '') ? r.date.slice(0, 7) : 'none';
      (out[`${c}.${m}`] ||= []).push(r);
    }
  }
  for (const list of Object.values(out)) list.sort(byId);
  const pk = (p) => `${p.supplier}\u0001${p.product}`;
  out.meta = {
    settings: s.settings,
    prices: [...(s.prices || [])].sort((a, b) => (pk(a) < pk(b) ? -1 : pk(a) > pk(b) ? 1 : 0)),
    lists: s.lists && Object.fromEntries(Object.keys(s.lists).sort().map((k) => [k, [...(s.lists[k] || [])].sort()])),
    listU: sortedObj(s.listU),
  };
  out.del = sortedObj(s.deleted);
  return out;
}

// 块 → （部分）账。只拿到几块时，其余部分留空，交给 mergeStates 和本机合并
export function fromBuckets(bk) {
  const s = { deleted: {} };
  for (const c of COLLECTIONS) s[c] = [];
  for (const [k, v] of Object.entries(bk)) {
    if (k === 'meta') Object.assign(s, { settings: v.settings, prices: v.prices || [], lists: v.lists, listU: v.listU || {} });
    else if (k === 'del') s.deleted = v || {};
    else {
      const c = k.split('.')[0];
      if (s[c]) s[c].push(...(v || []));
    }
  }
  if (!('prices' in s)) s.prices = [];
  return s;
}

// 内容指纹（FNV-1a）：判断一块变没变
function hash(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return (h >>> 0).toString(36) + str.length.toString(36);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// getState：拿到用户自己那本账（示例数据不算）；onRemote：别的设备带来的变化，由页面合并进自己的账。
// storage / runtime 默认用浏览器的 localStorage 和 claude.ai 运行时，测试时换成假的。
export function createStore({ onRemote, onStatus, getState, storage, runtime } = {}) {
  const ls = storage ?? globalThis.localStorage;
  const rt = runtime === undefined ? globalThis.window?.claude : runtime;
  const client = Math.random().toString(36).slice(2, 10);
  let base = null, lock = null, blocks = null, legacy = null;
  let known = {};
  let syncing = false, wanted = false, retryTimer = null, connected = false;
  let localOk = true;

  const status = (s) => { try { onStatus?.(s); } catch { /* 状态展示失败不影响保存 */ } };

  function readLocal() {
    try {
      const raw = ls.getItem(LOCAL_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch { return null; }
  }
  function writeLocal(s) {
    try { ls.setItem(LOCAL_KEY, JSON.stringify(s)); localOk = true; } catch { localOk = false; }
    return localOk;
  }
  // 本机的账没了（清过浏览器数据）就当什么都没下载过，全部重新拉
  function loadKnown() {
    try { known = ls.getItem(LOCAL_KEY) ? JSON.parse(ls.getItem(KNOWN_KEY) || '{}') : {}; } catch { known = {}; }
  }
  // 只有本机确实存下了合并后的账，才记「这些块已经有了」；存不下就下次全部重新拉
  function saveKnown() {
    try { ls.setItem(KNOWN_KEY, localOk ? JSON.stringify(known) : '{}'); } catch { /* 下次多下载几块而已 */ }
  }

  const part = (k, g, i) => blocks.doc(`${k}~${g}~${i}`);

  async function readBucket(k, info) {
    const parts = await Promise.all(Array.from({ length: info.n }, (_, i) => part(k, info.g, i).get()));
    if (parts.some((p) => !p.exists)) throw new Error('云端数据正在被另一台设备更新');
    return JSON.parse(parts.map((p) => p.data().s).join(''));
  }

  // 第 1 版：整本账切段存在 data/users/<id>/ledger
  async function readLegacy() {
    const meta = await legacy.get();
    if (!meta.exists) return null;
    const m = meta.data();
    const parts = await Promise.all(Array.from({ length: m.parts }, (_, i) => legacy.collection('parts').doc(`${m.gen}-${i}`).get()));
    if (parts.some((p) => !p.exists)) return null;
    return JSON.parse(parts.map((p) => p.data().s).join(''));
  }

  // 拿短锁：别的设备正在同步就等它的锁过期（最多等几次，实在拿不到也继续——合并是按每一笔来的，最多慢一点）
  async function takeLock() {
    for (let i = 0; i < 16; i++) {
      try {
        const r = await lock.acquire({ holder: client, ttlMs: LEASE_MS });
        if (r.acquired) return;
        // 对方同步完会把锁缩短到 1 秒，所以隔一会儿就再试，不用等满
        const left = r.expiresAt ? Date.parse(r.expiresAt) - Date.now() : 1000;
        await sleep(Math.min(Math.max(100, left), 600) + Math.random() * 200);
      } catch { return; }
    }
  }
  // 锁没有「释放」，同步完把自己的锁续成最短的 1 秒，别的设备不用干等
  const dropLock = () => lock.acquire({ holder: client, ttlMs: 1000 }).catch(() => {});

  // 一次同步：返回别的设备带来的变化（没有就是 null）
  async function syncOnce(local) {
    await takeLock();
    const metaSnap = await base.get();
    const meta = metaSnap.exists ? metaSnap.data() : null;
    const remote = meta?.v === 2 ? meta.buckets || {} : {};
    let incoming = null;

    if (!meta) {
      const old = await readLegacy().catch(() => null);
      if (old) incoming = old;
    }
    const changed = Object.keys(remote).filter((k) => known[k] !== remote[k].h);
    if (changed.length) {
      const got = {};
      await Promise.all(changed.map(async (k) => { got[k] = await readBucket(k, remote[k]); }));
      const part = fromBuckets(got);
      incoming = incoming ? mergeStates(incoming, part) : part;
    }
    const merged = incoming ? mergeStates(local, incoming) : local;

    const mine = toBuckets(merged);
    const next = {};
    const writes = [];
    const g = Date.now().toString(36) + client.slice(0, 3);
    for (const [k, v] of Object.entries(mine)) {
      const json = JSON.stringify(v);
      const h = hash(json);
      if (remote[k]?.h === h) { next[k] = remote[k]; continue; }
      const n = Math.max(1, Math.ceil(json.length / CHUNK));
      for (let i = 0; i < n; i++) writes.push(part(k, g, i).set({ s: json.slice(i * CHUNK, (i + 1) * CHUNK) }));
      next[k] = { h, n, g };
    }
    await Promise.all(writes); // 各块一起传，全部传完才写目录：别的设备看到的目录永远指向完整的块
    let wrote = writes.length > 0;
    for (const k of Object.keys(remote)) if (!mine[k]) wrote = true; // 有块整块空了
    if (wrote || !meta || meta.v !== 2) await base.set({ v: 2, buckets: next, client, savedAt: new Date().toISOString() });
    // 换下来的旧段删掉（读到一半的设备会发现缺段，下次再同步一遍就好）
    for (const [k, old] of Object.entries(remote)) {
      if (next[k]?.g === old.g) continue;
      for (let i = 0; i < old.n; i++) part(k, old.g, i).delete().catch(() => {});
    }
    known = Object.fromEntries(Object.entries(next).map(([k, v]) => [k, v.h]));
    dropLock();
    return incoming;
  }

  async function runSync() {
    if (!base) return;
    if (syncing) { wanted = true; return; }
    syncing = true;
    clearTimeout(retryTimer);
    try {
      do {
        wanted = false;
        status('saving');
        const snapshot = JSON.parse(JSON.stringify(getState()));
        const incoming = await syncOnce(snapshot);
        if (incoming) {
          onRemote?.(incoming);
          writeLocal(getState());
        }
        saveKnown();
      } while (wanted);
      status('saved');
    } catch (e) {
      status(e?.code === 'quota_exceeded' ? 'full' : e?.code === 'revoked' || e?.code === 'invalid_argument' ? 'denied' : 'offline');
      retryTimer = setTimeout(runSync, RETRY_MS); // 没网 / 被占用：过一会儿再试，本机的账一直在
      retryTimer.unref?.();
    } finally {
      syncing = false;
    }
  }

  loadKnown();
  globalThis.window?.addEventListener?.('online', () => runSync());

  return {
    local: readLocal,

    // 连上云端并做第一次同步。期间本机照常记账，连上后一起合并上去
    async connect() {
      if (!rt?.use) { status('local'); return false; }
      status('connecting');
      let db, uid;
      try {
        db = await rt.use('db');
        const user = await rt.use('user');
        uid = db && user ? await user.id() : null;
      } catch { uid = null; }
      if (!uid) { status('local'); return false; }
      base = db.doc(`data/users/${uid}/ledger2`);
      lock = db.doc(`data/users/${uid}/ledger2lock`);
      legacy = db.doc(`data/users/${uid}/ledger`);
      blocks = base.collection('b');
      connected = true;
      await runSync();
      // 别的设备同步过：这边跟着同步一次（只下载变了的块）
      base.onSnapshot((snap) => {
        if (snap.exists && snap.data().client !== client) runSync();
      }, () => {});
      return true;
    },

    // 每次记账后调用：先存本机，再排队同步
    save(s = getState()) {
      if (!writeLocal(s)) status('local-failed');
      else if (!connected) status(rt?.use ? 'connecting' : 'local');
      if (connected) runSync();
    },

    get cloud() { return connected; },
    get busy() { return syncing; },
  };
}
