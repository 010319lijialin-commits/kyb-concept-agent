import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createStore, toBuckets, fromBuckets } from '../public/ledger/store.js';
import { emptyState, mergeStates, touch, tomb } from '../public/ledger/core.js';

// 假的 claude.ai 运行时：多台设备共用一个内存 db，可以模拟断网
function fakeCloud() {
  const docs = new Map();
  const listeners = new Map();
  const leases = new Map();
  const cloud = { docs, offline: false, writes: 0, reads: 0 };
  const net = () => { if (cloud.offline) { const e = new Error('offline'); e.code = 'unavailable'; throw e; } };
  const snap = (path) => ({ id: path.split('/').pop(), exists: docs.has(path), data: () => JSON.parse(JSON.stringify(docs.get(path))), metadata: {} });
  const docRef = (path) => ({
    path,
    get: async () => { net(); cloud.reads++; return snap(path); },
    set: async (d) => {
      net();
      const json = JSON.stringify(d);
      if (Buffer.byteLength(json) > 256 * 1024) { const e = new Error('too big'); e.code = 'invalid_argument'; throw e; }
      cloud.writes++;
      docs.set(path, JSON.parse(json));
      for (const f of listeners.get(path) || []) setTimeout(() => f(snap(path)));
    },
    delete: async () => { net(); docs.delete(path); },
    acquire: async ({ holder, ttlMs }) => {
      net();
      const cur = leases.get(path);
      if (cur && cur.holder !== holder && cur.until > Date.now()) return { acquired: false, expiresAt: new Date(cur.until).toISOString() };
      leases.set(path, { holder, until: Date.now() + Math.min(600000, Math.max(1000, ttlMs || 30000)) });
      return { acquired: true, holder };
    },
    onSnapshot: (f) => { listeners.set(path, [...(listeners.get(path) || []), f]); return () => {}; },
    collection: (c) => ({ doc: (id) => docRef(`${path}/${c}/${id}`) }),
  });
  cloud.runtime = { use: async (n) => ({ db: { doc: docRef }, user: { id: async () => 'u1' } })[n] ?? null };
  return cloud;
}

function memStorage(init = {}) {
  const mem = new Map(Object.entries(init));
  return { mem, getItem: (k) => mem.get(k) ?? null, setItem: (k, v) => mem.set(k, String(v)) };
}

// 一台设备：自己的 localStorage + 自己的账，和页面里的用法一样
function device(cloud, storage = memStorage()) {
  const d = { storage, statuses: [] };
  d.state = { ...emptyState(), ...(JSON.parse(storage.getItem('ledger.v1') || 'null') || {}) };
  d.store = createStore({
    storage,
    runtime: cloud.runtime,
    getState: () => d.state,
    onRemote: (inc) => { d.state = mergeStates(d.state, inc); },
    onStatus: (s) => d.statuses.push(s),
  });
  d.add = (coll, rec) => { d.state[coll].push(touch({ ...rec })); d.store.save(d.state); };
  return d;
}

// 等所有设备都同步完（包括被别的设备触发的同步）
const settle = async (cloud, ...ds) => {
  let quiet = 0;
  for (let i = 0; i < 400 && quiet < 4; i++) {
    await new Promise((r) => setTimeout(r, 25));
    quiet = ds.some((d) => d.store.busy) ? 0 : quiet + 1;
  }
};
const ids = (s, c = 'sales') => s[c].map((r) => r.id).sort();

test('块：按类型 + 月份切开，再拼回来一样', () => {
  const s = { ...emptyState(), sales: [{ id: 'a', date: '2026-09-02' }, { id: 'b', date: '2026-10-01' }, { id: 'c' }], deleted: { 'sales:x': 5 } };
  const bk = toBuckets(s);
  assert.deepEqual(Object.keys(bk).sort(), ['del', 'meta', 'sales.2026-09', 'sales.2026-10', 'sales.none']);
  const back = fromBuckets(bk);
  assert.deepEqual(ids(back), ['a', 'b', 'c']);
  assert.deepEqual(back.deleted, { 'sales:x': 5 });
});

test('两台设备同时记账：互不覆盖，最后两边都是全的', async () => {
  const cloud = fakeCloud();
  const A = device(cloud), B = device(cloud);
  await Promise.all([A.store.connect(), B.store.connect()]);
  A.add('sales', { id: 'a1', date: '2026-10-01', qty: 1 });
  B.add('sales', { id: 'b1', date: '2026-10-01', qty: 2 });
  A.add('sales', { id: 'a2', date: '2026-09-01', qty: 3 });
  await settle(cloud, A, B);
  await settle(cloud, A, B);
  assert.deepEqual(ids(A.state), ['a1', 'a2', 'b1']);
  assert.deepEqual(ids(B.state), ['a1', 'a2', 'b1']);
  // 重新打开（新设备，本机空的）也能拿到全部
  const C = device(cloud);
  await C.store.connect();
  await settle(cloud, C);
  assert.deepEqual(ids(C.state), ['a1', 'a2', 'b1']);
});

test('断网时记的账：重新打开后还在，联网后传上去', async () => {
  const cloud = fakeCloud();
  const storage = memStorage();
  const A = device(cloud, storage);
  await A.store.connect();
  A.add('sales', { id: 's1', date: '2026-10-01' });
  await settle(cloud, A);
  cloud.offline = true;
  A.add('sales', { id: 's2', date: '2026-10-02' });
  await settle(cloud, A);
  assert.equal(A.statuses.at(-1), 'offline');
  // 关掉页面重新打开：还断着网
  const A2 = device(cloud, storage);
  assert.deepEqual(ids(A2.state), ['s1', 's2']);
  await A2.store.connect();
  await settle(cloud, A2);
  assert.deepEqual(ids(A2.state), ['s1', 's2'], '断网打开不能丢本机的账');
  cloud.offline = false;
  A2.store.save();
  await settle(cloud, A2);
  const B = device(cloud);
  await B.store.connect();
  await settle(cloud, B);
  assert.deepEqual(ids(B.state), ['s1', 's2']);
});

test('刚打开还没连上云端时记的账：连上后和云端合并，不被云端覆盖', async () => {
  const cloud = fakeCloud();
  const B = device(cloud);
  await B.store.connect();
  B.add('sales', { id: 'cloud1', date: '2026-10-01' });
  await settle(cloud, B);

  const A = device(cloud);
  A.add('sales', { id: 'early', date: '2026-10-03' }); // 还没 connect
  assert.equal(A.statuses.at(-1), 'connecting');
  await A.store.connect();
  await settle(cloud, A);
  assert.deepEqual(ids(A.state), ['cloud1', 'early']);
  await settle(cloud, B);
  assert.deepEqual(ids(B.state), ['cloud1', 'early']);
});

test('删掉的单据不会被另一台设备的旧数据带回来', async () => {
  const cloud = fakeCloud();
  const A = device(cloud), B = device(cloud);
  await A.store.connect();
  A.add('sales', { id: 'x', date: '2026-10-01' });
  A.add('sales', { id: 'y', date: '2026-10-01' });
  await settle(cloud, A);
  await B.store.connect();
  await settle(cloud, B);
  assert.deepEqual(ids(B.state), ['x', 'y']);
  A.state.sales = A.state.sales.filter((r) => r.id !== 'x');
  tomb(A.state, 'sales:x');
  A.store.save();
  await settle(cloud, A, B);
  await settle(cloud, A, B);
  assert.deepEqual(ids(A.state), ['y']);
  assert.deepEqual(ids(B.state), ['y']);
});

test('只写变了的块：大账本记一笔只上传一个月份', async () => {
  const cloud = fakeCloud();
  const A = device(cloud);
  for (let m = 1; m <= 12; m++) {
    for (let i = 0; i < 300; i++) A.state.sales.push(touch({ id: `s${m}-${i}`, date: `2025-${String(m).padStart(2, '0')}-10`, customer: '某某人民医院药剂科', note: '批号'.repeat(10) }));
  }
  await A.store.connect();
  await settle(cloud, A);
  for (const [k, v] of cloud.docs) assert.ok(Buffer.byteLength(JSON.stringify(v)) < 256 * 1024, k);
  const before = cloud.writes;
  A.add('sales', { id: 'new', date: '2025-06-11' });
  await settle(cloud, A);
  // 一个月份块 + 删除记录块不变 + 目录
  assert.ok(cloud.writes - before <= 2, `写了 ${cloud.writes - before} 次`);
  const partDocs = [...cloud.docs.keys()].filter((k) => k.includes('/b/sales.2025-06'));
  assert.equal(partDocs.length, 1, '旧版本的段要删掉');
});

test('第 1 版云端数据：第一次同步时自动合并进来，原数据保留', async () => {
  const cloud = fakeCloud();
  const old = { ...emptyState(), sales: [{ id: 'v1', date: '2026-01-01' }], settings: { revenueRate: 0.01, marginRate: 0.13 } };
  const json = JSON.stringify(old);
  cloud.docs.set('data/users/u1/ledger', { v: 1, gen: 'g1', parts: 1 });
  cloud.docs.set('data/users/u1/ledger/parts/g1-0', { s: json });
  const A = device(cloud);
  A.add('sales', { id: 'local', date: '2026-02-01' });
  await A.store.connect();
  await settle(cloud, A);
  assert.deepEqual(ids(A.state), ['local', 'v1']);
  assert.ok(cloud.docs.has('data/users/u1/ledger/parts/g1-0'));
  assert.equal(cloud.docs.get('data/users/u1/ledger2').v, 2);
});

test('没有 claude.ai 运行时：只存本机', async () => {
  const storage = memStorage();
  const statuses = [];
  const st = { sales: [{ id: 'a' }] };
  const store = createStore({ storage, runtime: null, getState: () => st, onStatus: (s) => statuses.push(s) });
  assert.equal(await store.connect(), false);
  store.save();
  assert.deepEqual(store.local(), st);
  assert.equal(statuses.at(-1), 'local');
});
