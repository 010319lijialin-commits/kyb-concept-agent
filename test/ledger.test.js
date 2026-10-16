import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  emptyState, compute, autoAllocate, autoAllocateNet, allocationTax, autoAllocatePayment,
  previewWithdrawal, previewPayment, companyBalanceAt, toYuan,
} from '../public/ledger/core.js';

const y = (c) => toYuan(c);

// 题目里的例子：上游 200 件 × 1 元进甲，卖给下游 200 件 × 1.5 元
function single() {
  const s = emptyState();
  s.purchases.push({ id: 'p1', date: '2026-09-01', supplier: '上游A', product: '甲', qty: 200, price: 1 });
  s.sales.push({ id: 's1', date: '2026-09-02', customer: '下游C', product: '甲', qty: 200, price: 1.5 });
  return s;
}

const companyReceipt = (s, amount = 300, date = '2026-09-10') =>
  s.receipts.push({ id: 'r1', date, customer: '下游C', account: 'company', amount, allocations: [{ saleId: 's1', amount }] });

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
  assert.equal(y(r.totals.personalBalance), 284);
  assert.equal(y(r.totals.receivable), 0);
});

test('回到公司账户：到账 300，算你的 284，不用管公司什么时候交税', () => {
  const s = single();
  companyReceipt(s);
  const r = compute(s);
  assert.equal(y(r.totals.companyBalance), 284);
  assert.equal(y(r.totals.companyTax), 16);
  assert.equal(y(r.receipts.get('r1').mineC), 284);
  assert.equal(y(r.totals.netProfitEst), 84);
});

test('从公司提现：提多少到手多少，最多提你在公司的钱', () => {
  const s = single();
  companyReceipt(s);
  assert.equal(previewWithdrawal(s, 284, '2026-09-11').shortfall, 0);
  assert.equal(y(previewWithdrawal(s, 300, '2026-09-11').shortfall), 16);
  assert.equal(y(previewWithdrawal(s, 100, '2026-09-09').shortfall), 100); // 回款到账前
  s.withdrawals.push({ id: 'w1', date: '2026-09-11', net: 284 });
  const r = compute(s);
  assert.equal(y(r.totals.companyBalance), 0);
  assert.equal(y(r.totals.personalBalance), 284);
  assert.equal(y(r.totals.taxPaid), 16);
});

test('合并回款核销差价不同的两笔销售：税按各自差价算', () => {
  const s = single();
  s.purchases.push({ id: 'p2', date: '2026-09-01', supplier: '上游A', product: '乙', qty: 100, price: 1 });
  s.sales.push({ id: 's2', date: '2026-09-05', customer: '下游C', product: '乙', qty: 100, price: 2 });
  const alloc = autoAllocate(s, '下游C', 400);
  assert.deepEqual(alloc, [{ saleId: 's1', amount: 300 }, { saleId: 's2', amount: 100 }]);
  // 甲 16 + 乙 100×1% + 50×13% = 1 + 6.5 → 23.5
  assert.equal(y(allocationTax(s, alloc)), 23.5);
  s.receipts.push({ id: 'r1', date: '2026-09-10', customer: '下游C', account: 'company', amount: 400, allocations: alloc });
  assert.equal(y(compute(s).totals.companyBalance), 376.5);
});

// ---------- 进价自动算 ----------

test('进价自动按卖出那天之前进的货算，之后的进货不影响已卖的', () => {
  const s = single();
  // 卖出之后又进了一批更贵的：已卖的那批扣税不变
  s.purchases.push({ id: 'p2', date: '2026-09-20', supplier: '上游A', product: '甲', qty: 200, price: 1.2 });
  let r = compute(s);
  assert.equal(r.salesById.get('s1').unitCost, 1);
  assert.equal(y(r.salesById.get('s1').taxFull), 16);
  // 之后再卖的，按两批平均 1.1 算
  s.sales.push({ id: 's2', date: '2026-09-21', customer: '下游C', product: '甲', qty: 100, price: 1.5 });
  r = compute(s);
  assert.equal(Math.round(r.salesById.get('s2').unitCost * 100) / 100, 1.1);
  assert.equal(r.salesById.get('s2').costBasis, 'before');
});

test('改了进货价，用到它的销售跟着重算', () => {
  const s = single();
  s.purchases[0].price = 0.8; // 差价变成 0.7：3 + 140×13% = 21.2
  assert.equal(y(compute(s).salesById.get('s1').taxFull), 21.2);
});

test('卖出之前没进货记录：用全部进货的平均价；一笔进货都没有就提醒', () => {
  const s = single();
  s.purchases[0].date = '2026-09-05'; // 进货日期记在卖出之后
  let r = compute(s);
  assert.equal(r.salesById.get('s1').unitCost, 1);
  assert.equal(r.salesById.get('s1').costBasis, 'all');
  s.purchases = [];
  r = compute(s);
  assert.equal(r.salesById.get('s1').costBasis, 'none');
  assert.ok(r.issues.some((t) => t.includes('还没记过「甲」的进货')));
});

test('老数据里销售上存的进价不再使用', () => {
  const s = single();
  s.sales[0].cost = 0.5;
  assert.equal(y(compute(s).salesById.get('s1').taxFull), 16);
});

test('删掉一笔回款，后面的提现自动标出钱不够', () => {
  const s = single();
  s.withdrawals.push({ id: 'w1', date: '2026-09-20', net: 50 });
  const r = compute(s);
  assert.equal(r.withdrawals.get('w1').shortfall, 5000);
  assert.ok(r.issues.some((t) => t.includes('只有')));
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

test('从公司付上游：回款 300、付 200，你在公司还剩 84', () => {
  const s = single();
  companyReceipt(s);
  s.payments.push({ id: 'pay1', date: '2026-09-12', supplier: '上游A', account: 'company', amount: 200, allocations: [{ purchaseId: 'p1', amount: 200 }] });
  const r = compute(s);
  assert.equal(y(r.totals.companyBalance), 84);
  assert.equal(y(r.totals.payable), 0);
  assert.equal(r.payments.get('pay1').over, 0);
  assert.equal(y(companyBalanceAt(s, '2026-09-11')), 284);
});

test('从公司付得比你在公司的钱多：照记，标出超了多少', () => {
  const s = single();
  companyReceipt(s);
  assert.equal(y(previewPayment(s, { date: '2026-09-12', supplier: '上游A', account: 'company', amount: 290 }).over), 6);
  s.payments.push({ id: 'pay1', date: '2026-09-12', supplier: '上游A', account: 'company', amount: 290, allocations: [] });
  const r = compute(s);
  assert.equal(y(r.totals.companyBalance), -6);
  assert.ok(r.issues.some((t) => t.includes('占用')));
});

test('老数据里的月度扣税记录被忽略，不影响余额', () => {
  const s = single();
  companyReceipt(s);
  s.taxRuns = [{ id: 't1', date: '2026-10-08', cutoff: '2026-09-30' }];
  assert.equal(y(compute(s).totals.companyBalance), 284);
});

// ---------- 一笔回款对多批货 ----------

function threeBatches() {
  const s = emptyState();
  s.purchases.push({ id: 'p1', date: '2026-09-01', supplier: '上游A', product: '甲', qty: 1000, price: 1 });
  s.sales.push({ id: 'a', date: '2026-09-02', customer: '下游C', product: '甲', qty: 100, price: 1.5 }); // 150
  s.sales.push({ id: 'b', date: '2026-09-03', customer: '下游C', product: '甲', qty: 200, price: 1.5 }); // 300
  s.sales.push({ id: 'c', date: '2026-09-04', customer: '下游C', product: '甲', qty: 300, price: 2 });   // 600
  return s;
}

test('一次回完整两批 + 第三批的一部分（先进先出）', () => {
  const s = threeBatches();
  const alloc = autoAllocate(s, '下游C', 650);
  assert.deepEqual(alloc, [{ saleId: 'a', amount: 150 }, { saleId: 'b', amount: 300 }, { saleId: 'c', amount: 200 }]);
  s.receipts.push({ id: 'r1', date: '2026-09-10', customer: '下游C', account: 'company', amount: 650, allocations: alloc });
  const r = compute(s);
  assert.equal(y(r.salesById.get('a').outstanding), 0);
  assert.equal(y(r.salesById.get('b').outstanding), 0);
  assert.equal(y(r.salesById.get('c').outstanding), 400);
  // 税：甲 450 → 4.5 + 150×13% = 24；乙那 200 → 2 + 100×13% = 15（按回了的比例）
  assert.equal(y(r.receipts.get('r1').taxC), 24 + 15);
  // 剩下 400 下次回，税 4 + 200×13% = 30，合计正好等于三批全回的税
  s.receipts.push({ id: 'r2', date: '2026-09-20', customer: '下游C', account: 'company', amount: 400, allocations: autoAllocate(s, '下游C', 400) });
  const r2 = compute(s);
  assert.equal(y(r2.receipts.get('r2').taxC), 30);
  assert.equal(y(r2.totals.companyTax), [...r2.sales].reduce((t, x) => t + x.taxFull, 0) / 100);
});

test('跳着挑：第一批全额、第二批不回、第三批回一部分', () => {
  const s = threeBatches();
  s.receipts.push({ id: 'r1', date: '2026-09-10', customer: '下游C', account: 'company', amount: 450, allocations: [{ saleId: 'a', amount: 150 }, { saleId: 'c', amount: 300 }] });
  const r = compute(s);
  assert.equal(y(r.salesById.get('a').outstanding), 0);
  assert.equal(y(r.salesById.get('b').outstanding), 300);
  assert.equal(y(r.salesById.get('c').outstanding), 300);
  // 再来一笔自动分：先补第二批，再补第三批剩下的
  assert.deepEqual(autoAllocate(s, '下游C', 500), [{ saleId: 'b', amount: 300 }, { saleId: 'c', amount: 200 }]);
});

test('回到个人账户：多批合并、最后一批只回一部分，按各批税负反推', () => {
  const s = threeBatches();
  // a 全回到账 150−8=142，b 全回 300−16=284，c 回 200 应收：税 2+100×13%=15 → 到账 185
  const alloc = autoAllocateNet(s, '下游C', 142 + 284 + 185);
  assert.deepEqual(alloc, [{ saleId: 'a', amount: 150 }, { saleId: 'b', amount: 300 }, { saleId: 'c', amount: 200 }]);
});

// ---------- 下拉单 ----------
import { seedLists, addToList, lastUsed } from '../public/ledger/core.js';

test('老账本：已经记过的名字自动进下拉单', () => {
  const s = threeBatches();
  s.payments.push({ id: 'pay', date: '2026-09-05', supplier: '上游B', account: 'personal', amount: 1, allocations: [] });
  assert.deepEqual(seedLists(s), { products: ['甲'], suppliers: ['上游A', '上游B'], customers: ['下游C'] });
});

test('加入下拉单：去空格、不重复', () => {
  const s = emptyState();
  assert.equal(addToList(s, 'customers', '  仁和医院 '), true);
  assert.equal(addToList(s, 'customers', '仁和医院'), false);
  assert.equal(addToList(s, 'customers', ''), false);
  assert.deepEqual(s.lists.customers, ['仁和医院']);
});

test('最近用过的日期', () => {
  const m = lastUsed(threeBatches(), 'customers');
  assert.equal(m.get('下游C'), '2026-09-04');
});

// ---------- 厂家 + 价目表 ----------
import { listPrice, setListPrice, removeListPrice, supplierResolver } from '../public/ledger/core.js';

function twoMakers() {
  const s = emptyState();
  s.purchases.push({ id: 'pa', date: '2026-09-01', supplier: '厂家A', product: '甲', qty: 100, price: 1 });
  s.purchases.push({ id: 'pb', date: '2026-09-01', supplier: '厂家B', product: '甲', qty: 100, price: 1.2 });
  return s;
}

test('同一个药不同厂家：进价、库存按厂家分开算', () => {
  const s = twoMakers();
  s.sales.push({ id: 'sa', date: '2026-09-02', supplier: '厂家A', product: '甲', customer: '下游C', qty: 50, price: 1.5 });
  s.sales.push({ id: 'sb', date: '2026-09-02', supplier: '厂家B', product: '甲', customer: '下游C', qty: 50, price: 1.5 });
  const r = compute(s);
  assert.equal(r.salesById.get('sa').unitCost, 1);
  assert.equal(r.salesById.get('sb').unitCost, 1.2);
  // 厂家A：75×1% + 25×13% = 0.75 + 3.25；厂家B：0.75 + 15×13% = 0.75 + 1.95
  assert.equal(y(r.salesById.get('sa').taxFull), 4);
  assert.equal(y(r.salesById.get('sb').taxFull), 2.7);
  const stock = Object.fromEntries(r.products.map((p) => [p.name, p.stock]));
  assert.deepEqual(stock, { '甲（厂家A）': 50, '甲（厂家B）': 50 });
});

test('老销售没记厂家：这个药只从一家进过就认那家，多家就按全部厂家平均', () => {
  const s = single();
  assert.equal(supplierResolver(s)(s.sales[0]), '上游A');
  assert.equal(compute(s).products[0].name, '甲（上游A）');
  const t = twoMakers();
  t.sales.push({ id: 'old', date: '2026-09-02', product: '甲', customer: '下游C', qty: 10, price: 1.5 });
  assert.equal(Math.round(compute(t).salesById.get('old').unitCost * 100) / 100, 1.1);
});

test('价目表：每个厂家的每个药一个售价，可改可删', () => {
  const s = twoMakers();
  assert.equal(listPrice(s, '厂家A', '甲'), null);
  setListPrice(s, '厂家A', '甲', 1.5);
  setListPrice(s, '厂家B', '甲', 1.6);
  assert.equal(listPrice(s, '厂家A', '甲'), 1.5);
  assert.equal(listPrice(s, '厂家B', '甲'), 1.6);
  setListPrice(s, '厂家A', '甲', 1.55);
  assert.equal(listPrice(s, '厂家A', '甲'), 1.55);
  assert.equal(s.prices.length, 2);
  removeListPrice(s, '厂家B', '甲');
  assert.equal(listPrice(s, '厂家B', '甲'), null);
});
