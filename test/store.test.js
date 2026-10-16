import { test } from 'node:test';
import assert from 'node:assert/strict';

// 假的 claude.ai 运行时：内存里的 db + 固定用户
function fakeRuntime() {
  const docs = new Map();
  const listeners = new Map();
  const snap = (path) => ({ id: path.split('/').pop(), exists: docs.has(path), data: () => docs.get(path), metadata: {} });
  const docRef = (path) => ({
    path,
    get: async () => snap(path),
    set: async (d) => { docs.set(path, JSON.parse(JSON.stringify(d))); (listeners.get(path) || []).forEach((f) => f(snap(path))); },
    delete: async () => { docs.delete(path); },
    onSnapshot: (f) => { listeners.set(path, [...(listeners.get(path) || []), f]); return () => {}; },
    collection: (c) => ({ doc: (id) => docRef(`${path}/${c}/${id}`) }),
  });
  const db = { doc: docRef };
  const user = { id: async () => 'u1' };
  return { docs, claude: { use: async (n) => ({ db, user })[n] ?? null } };
}

function setup() {
  const mem = new Map();
  globalThis.localStorage = { getItem: (k) => mem.get(k) ?? null, setItem: (k, v) => mem.set(k, v) };
  const rt = fakeRuntime();
  globalThis.window = { claude: rt.claude };
  return rt;
}

const wait = () => new Promise((r) => setTimeout(r, 20));

test('云端：大账本分块保存、读回一致，旧块被清理', async () => {
  const rt = setup();
  const { createStore } = await import('../public/ledger/store.js?' + Math.random());
  const statuses = [];
  const store = createStore({ onStatus: (s) => statuses.push(s) });
  assert.equal(await store.connect(), null);
  assert.ok(store.cloud);

  const big = { sales: Array.from({ length: 800 }, (_, i) => ({ id: 's' + i, customer: '某某人民医院药剂科', note: '批号'.repeat(20) + i })) };
  store.save(big);
  await wait();
  const parts = [...rt.docs.keys()].filter((k) => k.includes('/parts/'));
  assert.ok(parts.length > 1, '应该分成多块');
  for (const k of parts) assert.ok(Buffer.byteLength(JSON.stringify(rt.docs.get(k))) < 256 * 1024);

  store.save({ sales: [{ id: 'only' }] });
  await wait();
  assert.equal([...rt.docs.keys()].filter((k) => k.includes('/parts/')).length, 1, '旧块应删掉');
  assert.equal(statuses.at(-1), 'saved');

  const { createStore: again } = await import('../public/ledger/store.js?' + Math.random());
  assert.deepEqual(await again({}).connect(), { sales: [{ id: 'only' }] });
});

test('没有 claude.ai 运行时：只存本机', async () => {
  setup();
  delete globalThis.window.claude;
  const { createStore } = await import('../public/ledger/store.js?' + Math.random());
  const statuses = [];
  const store = createStore({ onStatus: (s) => statuses.push(s) });
  assert.equal(await store.connect(), undefined);
  store.save({ sales: [{ id: 'a' }] });
  assert.deepEqual(store.local(), { sales: [{ id: 'a' }] });
  assert.equal(statuses.at(-1), 'local');
});
