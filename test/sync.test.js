import { test } from 'node:test';
import assert from 'node:assert/strict';
import { emptyState, touch, tomb, addToList, removeFromList, setListPrice, removeListPrice, importState } from '../public/ledger/core.js';
import { pendingChanges, applyServerChanges, markPushed, revertRejected, keepPendingOnly } from '../public/ledger/sync.js';
import { effectivePerms, canWrite, canEditRecord } from '../public/ledger/roles.js';

const srv = (kind, key, data, seq, by = 'u1') => ({ kind, key, data, seq, by, t: 1000 + seq });

test('本机新记、改、删的都算没传上去；服务器来的不算', () => {
  let s = emptyState();
  s = applyServerChanges(s, [srv('sales', 'a', { id: 'a', qty: 1 }, 1), srv('settings', 'settings', { revenueRate: 0.01, marginRate: 0.13 }, 2), srv('lists', 'products:甲', {}, 3)]);
  assert.deepEqual(pendingChanges(s), []);
  s.sales.push(touch({ id: 'b', qty: 2 }));
  const a = s.sales.find((x) => x.id === 'a');
  Object.assign(a, { qty: 5 }); touch(a);
  addToList(s, 'products', '乙');
  setListPrice(s, 'S', '甲', 2);
  s.settings = touch({ ...s.settings, revenueRate: 0.02 });
  const p = pendingChanges(s);
  assert.deepEqual(p.map((x) => `${x.kind}:${x.key}`).sort(), ['lists:products:乙', 'prices:S\u0001甲', 'sales:a', 'sales:b', 'settings:settings']);
  assert.equal(p.find((x) => x.key === 'a').data._s, undefined, '传上去的不带版本号');
  s.sales = s.sales.filter((x) => x.id !== 'b'); tomb(s, 'sales:b');
  removeFromList(s, 'products', '甲');
  removeListPrice(s, 'S', '甲');
  const p2 = pendingChanges(s).map((x) => `${x.kind}:${x.key}:${x.data === null ? 'del' : 'set'}`).sort();
  assert.deepEqual(p2, ['lists:products:乙:set', 'lists:products:甲:del', 'prices:S\u0001甲:del', 'sales:a:set', 'sales:b:del', 'settings:settings:set']);
});

test('传上去以后标上版本号；传的过程中又改了的下次还传', () => {
  const s = emptyState();
  s.sales.push(touch({ id: 'a' }), touch({ id: 'b' }));
  tomb(s, 'sales:x');
  addToList(s, 'customers', '医院');
  const sent = pendingChanges(s);
  touch(s.sales[1]); // b 在传的时候又改了
  const rejected = markPushed(s, sent, sent.map((_, i) => ({ ok: true, seq: 10 + i, by: 'u1', t: 5 })));
  assert.deepEqual(rejected, []);
  assert.equal(s.sales[0]._s, 10);
  assert.equal(s.sales[1]._s, undefined);
  assert.deepEqual(pendingChanges(s).map((x) => x.key), ['b']);
});

test('拉下来的变化：本机没传上去的同一笔先不盖；拒收的恢复成服务器上的', () => {
  let s = applyServerChanges(emptyState(), [srv('sales', 'a', { id: 'a', qty: 1 }, 1), srv('sales', 'b', { id: 'b', qty: 1 }, 2)]);
  const a = s.sales.find((x) => x.id === 'a');
  a.qty = 9; touch(a);
  s = applyServerChanges(s, [srv('sales', 'a', { id: 'a', qty: 2 }, 3, 'u2'), srv('sales', 'b', null, 4, 'u2'), srv('sales', 'c', { id: 'c', qty: 3 }, 5, 'u2')]);
  assert.deepEqual(s.sales.map((x) => `${x.id}:${x.qty}`).sort(), ['a:9', 'c:3']);
  assert.equal(s.sales.find((x) => x.id === 'c')._by, 'u2');
  const sent = pendingChanges(s);
  const rej = markPushed(s, sent, [{ ok: false, reason: 'not-yours', current: { data: { id: 'a', qty: 2 }, seq: 3, by: 'u2' } }]);
  s = revertRejected(s, rej);
  assert.deepEqual(s.sales.map((x) => `${x.id}:${x.qty}`).sort(), ['a:2', 'c:3']);
  assert.deepEqual(pendingChanges(s), []);
  // 拒收一笔服务器上没有的新单据：直接去掉
  s.sales.push(touch({ id: 'n' }));
  const sent2 = pendingChanges(s);
  s = revertRejected(s, markPushed(s, sent2, [{ ok: false, reason: 'no-permission' }]));
  assert.deepEqual(s.sales.map((x) => x.id).sort(), ['a', 'c']);
});

test('价目表、下拉单、税率的变化也能并进来', () => {
  let s = applyServerChanges(emptyState(), [
    srv('prices', 'S\u0001甲', { supplier: 'S', product: '甲', price: 1.5 }, 1),
    srv('lists', 'suppliers:S', {}, 2),
    srv('settings', 'settings', { revenueRate: 0.02, marginRate: 0.1 }, 3),
  ]);
  assert.equal(s.prices[0].price, 1.5);
  assert.deepEqual(s.lists.suppliers, ['S']);
  assert.equal(s.settings.revenueRate, 0.02);
  s = applyServerChanges(s, [srv('prices', 'S\u0001甲', null, 4), srv('lists', 'suppliers:S', null, 5)]);
  assert.deepEqual(s.prices, []);
  assert.deepEqual(s.lists.suppliers, []);
});

test('导入的备份里带着服务器版本号：一律当成新记的，要传上去', () => {
  const s = importState(emptyState(), { sales: [{ id: 'a', _s: 3, _by: 'x' }], purchases: [], receipts: [], prices: [{ supplier: 'S', product: 'P', price: 1, _s: 2 }] });
  assert.deepEqual(pendingChanges(s).filter((x) => x.data).map((x) => x.kind).sort(), ['prices', 'sales', 'settings']);
});

test('服务器恢复到旧备份：本机只留没传上去的', () => {
  let s = applyServerChanges(emptyState(), [srv('sales', 'a', { id: 'a' }, 1)]);
  s.sales.push(touch({ id: 'b' }));
  addToList(s, 'products', 'X');
  const k = keepPendingOnly(s);
  assert.deepEqual(k.sales.map((x) => x.id), ['b']);
  assert.deepEqual(k.lists.products, ['X']);
});

test('两种身份：全部权限什么都能记；只记收付款只能记回款付款、加公司名厂家名，只能改自己的', () => {
  const all = effectivePerms('admin');
  assert.ok(['purchases', 'sales', 'receipts', 'payments', 'withdrawals', 'prices', 'settings'].every((k) => canWrite(all, k)));
  assert.equal(all.view, 'all');
  assert.ok(canEditRecord(all, 'sales', 'boss', 'me'));
  const c = effectivePerms('cashier');
  assert.equal(c.view, 'own');
  assert.ok(canWrite(c, 'receipts') && canWrite(c, 'payments'));
  assert.ok(!canWrite(c, 'sales') && !canWrite(c, 'purchases') && !canWrite(c, 'prices') && !canWrite(c, 'settings') && !canWrite(c, 'withdrawals'));
  assert.ok(canWrite(c, 'lists', 'customers:医院') && canWrite(c, 'lists', 'suppliers:厂') && !canWrite(c, 'lists', 'products:药'));
  assert.ok(canEditRecord(c, 'receipts', 'me', 'me'));
  assert.ok(!canEditRecord(c, 'receipts', 'boss', 'me'));
  assert.equal(effectivePerms('clerk').view, 'own', '老版本的身份按最小权限算');
});
