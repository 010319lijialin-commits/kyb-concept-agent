import { test } from 'node:test';
import assert from 'node:assert/strict';
import { emptyState, compute, autoAllocate, autoAllocateNet, allocationTax, autoAllocatePayment, previewWithdrawal, previewPayment, toYuan } from '../public/ledger/core.js';

const y = (c) => toYuan(c);

// 题目里的例子：上游 200 件 × 1 元进甲，卖给下游 200 件 × 1.5 元
function single() {
  const s = emptyState();
  s.purchases.push({ id: 'p1', date: '2026-09-01', supplier: '上游A', product: '甲', qty: 200, price: 1 });
  s.sales.push({ id: 's1', date: '2026-09-02', customer: '下游C', product: '甲', qty: 200, price: 1.5, cost: 1 });
  return s;
}

test('扣税 = 200×1.5×1% + 0.5×200×13% = 16', () => {
  const r = compute(single());
  assert.equal(y(r.salesById.get('s1').taxFull), 16);
  assert.equal(y(r.salesById.get('s1').taxBreakdown.revenueTax), 3);
  assert.equal(y(r.salesById.get('s1').taxBreakdown.marginTax), 13);
  assert.equal(y(r.totals.grossProfit), 100);
  assert.equal(y(r.totals.netProfitEst), 84);
});

test('回到个人账户：到账 284 反推核销 300，已扣税 16', () => {
  const s = single();
  const alloc = autoAllocateNet(s, '下游C', 284);
  assert.deepEqual(alloc, [{ saleId: 's1', amount: 300 }]);
  s.receipts.push({ id: 'r1', date: '2026-09-10', customer: '下游C', account: 'personal', amount: 284, allocations: alloc });
  const r = compute(s);
  assert.equal(y(r.totals.personalTax), 16);
  assert.equal(y(r.totals.receivable), 0);
});

test('回到公司账户：月度扣税扣 16，之后 284 可全额提', () => {
  const s = single();
  s.receipts.push({ id: 'r1', date: '2026-09-10', customer: '下游C', account: 'company', amount: 300, allocations: [{ saleId: 's1', amount: 300 }] });
  let r = compute(s);
  assert.equal(y(r.totals.pendingTax), 16);
  assert.equal(y(r.totals.maxWithdrawNet), 284);
  s.taxRuns.push({ id: 't1', date: '2026-10-08', cutoff: '2026-09-30' });
  r = compute(s);
  assert.equal(y(r.taxRuns.get('t1').tax), 16);
  assert.equal(y(r.totals.taxedBal), 284);
  const w = previewWithdrawal(s, 284, '2026-10-09');
  assert.equal(y(w.tax), 0);
  assert.equal(y(w.gross), 284);
});

test('没扣过税就提现：边提边扣，月底只扣剩下的', () => {
  const s = single();
  s.receipts.push({ id: 'r1', date: '2026-09-10', customer: '下游C', account: 'company', amount: 300, allocations: [{ saleId: 's1', amount: 300 }] });
  // 想拿 142 到手 → 划出 150、扣税 8（税负 16/300）
  const w = previewWithdrawal(s, 142, '2026-09-15');
  assert.equal(y(w.gross), 150);
  assert.equal(y(w.tax), 8);
  s.withdrawals.push({ id: 'w1', date: '2026-09-15', net: 142 });
  s.taxRuns.push({ id: 't1', date: '2026-10-08', cutoff: '2026-09-30' });
  const r = compute(s);
  assert.equal(y(r.taxRuns.get('t1').tax), 8);
  assert.equal(y(r.totals.taxPaid), 16);
  assert.equal(y(r.totals.companyBalance), 142);
});

test('合并回款核销差价不同的两笔销售：税按各自差价算', () => {
  const s = single();
  s.purchases.push({ id: 'p2', date: '2026-09-01', supplier: '上游A', product: '乙', qty: 100, price: 1 });
  s.sales.push({ id: 's2', date: '2026-09-05', customer: '下游C', product: '乙', qty: 100, price: 2, cost: 1 });
  // 一次回 400：先核销甲 300，再核销乙 100
  const alloc = autoAllocate(s, '下游C', 400);
  assert.deepEqual(alloc, [{ saleId: 's1', amount: 300 }, { saleId: 's2', amount: 100 }]);
  // 甲 16 + 乙 100×1% + 50×13% = 1 + 6.5 → 23.5
  assert.equal(y(allocationTax(s, alloc)), 23.5);
  s.receipts.push({ id: 'r1', date: '2026-09-10', customer: '下游C', account: 'company', amount: 400, allocations: alloc });
  s.taxRuns.push({ id: 't1', date: '2026-10-08', cutoff: '2026-09-30' });
  assert.equal(y(compute(s).taxRuns.get('t1').tax), 23.5);
});

test('没填进价就用该品种平均进价', () => {
  const s = single();
  delete s.sales[0].cost;
  assert.equal(y(compute(s).salesById.get('s1').taxFull), 16);
});

test('删掉一笔回款，后面的提现自动标出余额不足', () => {
  const s = single();
  s.withdrawals.push({ id: 'w1', date: '2026-09-20', net: 50 });
  const r = compute(s);
  assert.equal(r.withdrawals.get('w1').shortfall, 5000);
  assert.ok(r.issues.some((t) => t.includes('不够')));
});

test('税率可改', () => {
  const s = single();
  s.settings = { revenueRate: 0.03, marginRate: 0.06 };
  assert.equal(y(compute(s).salesById.get('s1').taxFull), 9 + 6);
});

// ---------- 付上游 ----------

test('进货 = 欠上游；合并付款按先后核销多笔进货', () => {
  const s = single();
  s.purchases.push({ id: 'p2', date: '2026-09-03', supplier: '上游A', product: '甲', qty: 100, price: 1 });
  assert.equal(y(compute(s).totals.payable), 300);
  const alloc = autoAllocatePayment(s, '上游A', 250);
  assert.deepEqual(alloc, [{ purchaseId: 'p1', amount: 200 }, { purchaseId: 'p2', amount: 50 }]);
  s.payments.push({ id: 'pay1', date: '2026-09-04', supplier: '上游A', account: 'personal', amount: 250, allocations: alloc });
  const r = compute(s);
  assert.equal(y(r.totals.payable), 50);
  assert.equal(y(r.purchasesById.get('p1').outstanding), 0);
  assert.equal(y(r.totals.personalBalance), -250); // 先从自己口袋垫钱
});

test('从公司账户付上游：税照扣 16，最后能提 84', () => {
  const s = single();
  s.receipts.push({ id: 'r1', date: '2026-09-10', customer: '下游C', account: 'company', amount: 300, allocations: [{ saleId: 's1', amount: 300 }] });
  s.payments.push({ id: 'pay1', date: '2026-09-12', supplier: '上游A', account: 'company', amount: 200, allocations: [{ purchaseId: 'p1', amount: 200 }] });
  let r = compute(s);
  assert.equal(y(r.totals.companyBalance), 100);
  assert.equal(y(r.totals.pendingTax), 16);
  assert.equal(y(r.totals.maxWithdrawNet), 84);
  assert.equal(r.payments.get('pay1').reserveUsed, 0);
  s.taxRuns.push({ id: 't1', date: '2026-10-08', cutoff: '2026-09-30' });
  r = compute(s);
  assert.equal(y(r.taxRuns.get('t1').tax), 16);
  assert.equal(y(r.totals.taxedBal), 84);
  s.withdrawals.push({ id: 'w1', date: '2026-10-09', net: 84 });
  r = compute(s);
  assert.equal(y(r.totals.companyBalance), 0);
  assert.equal(y(r.totals.personalBalance), 84);
  assert.equal(y(r.totals.taxPaid), 16);
});

test('付上游后还没扣税就提现：提完 84 正好把 16 税交掉', () => {
  const s = single();
  s.receipts.push({ id: 'r1', date: '2026-09-10', customer: '下游C', account: 'company', amount: 300, allocations: [{ saleId: 's1', amount: 300 }] });
  s.payments.push({ id: 'pay1', date: '2026-09-12', supplier: '上游A', account: 'company', amount: 200, allocations: [{ purchaseId: 'p1', amount: 200 }] });
  const w = previewWithdrawal(s, 84, '2026-09-15');
  assert.equal(y(w.tax), 16);
  assert.equal(y(w.gross), 100);
});

test('付上游用掉了留着交税的钱：提醒；余额不够时付不出去', () => {
  const s = single();
  s.receipts.push({ id: 'r1', date: '2026-09-10', customer: '下游C', account: 'company', amount: 300, allocations: [{ saleId: 's1', amount: 300 }] });
  const p = previewPayment(s, { date: '2026-09-12', supplier: '上游A', account: 'company', amount: 290, allocations: [] });
  assert.equal(y(p.reserveUsed), 6);
  assert.equal(p.shortfall, 0);
  s.payments.push({ id: 'pay1', date: '2026-09-12', supplier: '上游A', account: 'company', amount: 290, allocations: [] });
  const r = compute(s);
  assert.equal(y(r.totals.taxGap), 6);
  assert.ok(r.issues.some((t) => t.includes('不够交')));
  // 公司账户里钱不够，付不出去
  assert.equal(y(previewPayment(s, { date: '2026-09-13', supplier: '上游A', account: 'company', amount: 50 }).shortfall), 40);
});
