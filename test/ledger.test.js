import { test } from 'node:test';
import assert from 'node:assert/strict';
import { emptyState, compute, autoAllocate, personalGross, previewWithdrawal, toYuan } from '../public/ledger/core.js';

const y = (c) => toYuan(c);

// 题目里的例子：上游 200 件 × 1 元进甲，卖给两个下游各 100 件 × 1.5 元
function base() {
  const s = emptyState();
  s.purchases.push({ id: 'p1', date: '2026-09-01', supplier: '上游A', product: '甲', qty: 200, price: 1 });
  s.sales.push({ id: 's1', date: '2026-09-02', customer: '下游C1', product: '甲', qty: 100, price: 1.5 });
  s.sales.push({ id: 's2', date: '2026-09-03', customer: '下游C1', product: '甲', qty: 60, price: 1.5 });
  s.sales.push({ id: 's3', date: '2026-09-03', customer: '下游C2', product: '甲', qty: 40, price: 1.5 });
  return s;
}

test('毛利和应收', () => {
  const r = compute(base());
  assert.equal(y(r.totals.purchaseTotal), 200);
  assert.equal(y(r.totals.revenue), 300);
  assert.equal(y(r.totals.grossProfit), 100);
  assert.equal(y(r.totals.receivable), 300);
});

test('合并回款按先后核销多笔销售', () => {
  const s = base();
  const alloc = autoAllocate(s, '下游C1', 200);
  assert.deepEqual(alloc, [{ saleId: 's1', amount: 150 }, { saleId: 's2', amount: 50 }]);
  s.receipts.push({ id: 'r1', date: '2026-09-10', customer: '下游C1', account: 'company', amount: 200, allocations: alloc });
  const r = compute(s);
  assert.equal(y(r.salesById.get('s1').outstanding), 0);
  assert.equal(y(r.salesById.get('s2').outstanding), 40);
  assert.equal(y(r.totals.untaxedBal), 200);
});

test('回个人账户：到账已扣税，核销按含税额', () => {
  const s = base();
  const gross = personalGross(53.1, s.settings); // 60 × (1 − 13/113) ≈ 53.10
  assert.equal(gross, 60);
  s.receipts.push({ id: 'r1', date: '2026-09-10', customer: '下游C2', account: 'personal', amount: 53.1, allocations: [{ saleId: 's3', amount: 60 }] });
  const r = compute(s);
  assert.equal(y(r.totals.personalTax), 6.9);
  assert.equal(y(r.salesById.get('s3').outstanding), 0);
});

test('公司回款：月度扣税后全额可提；未扣税的提现要先扣', () => {
  const s = base();
  s.receipts.push({ id: 'r1', date: '2026-09-10', customer: '下游C1', account: 'company', amount: 113, allocations: [{ saleId: 's1', amount: 113 }] });
  s.receipts.push({ id: 'r2', date: '2026-10-05', customer: '下游C1', account: 'company', amount: 113, allocations: [{ saleId: 's1', amount: 37 }, { saleId: 's2', amount: 76 }] });
  s.taxRuns.push({ id: 't1', date: '2026-10-08', cutoff: '2026-09-30' });
  let r = compute(s);
  assert.equal(y(r.taxRuns.get('t1').tax), 13);       // 只扣 9 月那笔
  assert.equal(y(r.totals.taxedBal), 100);
  assert.equal(y(r.totals.untaxedBal), 113);
  assert.equal(y(r.totals.maxWithdrawNet), 200);      // 100 已税 + 113 未税扣 13

  // 提 150 到手：已税的 100 直接提，剩 50 从未税里提，要多划 50/(1−13/113)=56.50
  const w = previewWithdrawal(s, 150, '2026-10-12');
  assert.equal(y(w.net), 150);
  assert.equal(y(w.gross), 156.5);
  assert.equal(y(w.tax), 6.5);

  s.withdrawals.push({ id: 'w1', date: '2026-10-12', net: 150 });
  s.taxRuns.push({ id: 't2', date: '2026-11-08', cutoff: '2026-10-31' });
  r = compute(s);
  assert.equal(y(r.taxRuns.get('t2').tax), 6.5);      // 剩下 56.50 未税，月底扣 6.50
  assert.equal(y(r.totals.companyBalance), 50);
  assert.equal(y(r.totals.taxPaid), 26);              // 两笔 113 合计 226，税正好 26
});

test('删掉一笔回款，后面的提现自动标出余额不足', () => {
  const s = base();
  s.receipts.push({ id: 'r1', date: '2026-09-10', customer: '下游C1', account: 'company', amount: 100, allocations: [{ saleId: 's1', amount: 100 }] });
  s.withdrawals.push({ id: 'w1', date: '2026-09-20', net: 50 });
  s.receipts = [];
  const r = compute(s);
  assert.equal(r.withdrawals.get('w1').shortfall, 5000);
  assert.ok(r.issues.some((t) => t.includes('不够')));
});

test('flat 口径：直接按比例扣', () => {
  const s = base();
  s.settings = { vatRate: 0.06, vatMode: 'flat' };
  s.receipts.push({ id: 'r1', date: '2026-09-10', customer: '下游C1', account: 'company', amount: 100, allocations: [] });
  s.taxRuns.push({ id: 't1', date: '2026-10-01', cutoff: '2026-09-30' });
  assert.equal(y(compute(s).taxRuns.get('t1').tax), 6);
});
