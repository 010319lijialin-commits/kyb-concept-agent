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

test('之后再进货不影响已卖的；下一笔先进先出从新批次出', () => {
  const s = single();
  // 卖出之后又进了一批更贵的：已卖的那批扣税不变
  s.purchases.push({ id: 'p2', date: '2026-09-20', supplier: '上游A', product: '甲', qty: 200, price: 1.2 });
  let r = compute(s);
  assert.equal(r.salesById.get('s1').unitCost, 1);
  assert.equal(y(r.salesById.get('s1').taxFull), 16);
  // 第一批已经卖光，下一笔从 1.2 那批出
  s.sales.push({ id: 's2', date: '2026-09-21', customer: '下游C', product: '甲', qty: 100, price: 1.5 });
  r = compute(s);
  assert.equal(r.salesById.get('s2').unitCost, 1.2);
  assert.equal(r.salesById.get('s2').costBasis, 'lots');
});

test('改了进货价，用到它的销售跟着重算', () => {
  const s = single();
  s.purchases[0].price = 0.8; // 差价变成 0.7：3 + 140×13% = 21.2
  assert.equal(y(compute(s).salesById.get('s1').taxFull), 21.2);
});

test('进货日期记在卖出之后也照样出货；一笔进货都没有就提醒', () => {
  const s = single();
  s.purchases[0].date = '2026-09-05'; // 进货日期记在卖出之后
  let r = compute(s);
  assert.equal(r.salesById.get('s1').unitCost, 1);
  assert.equal(r.salesById.get('s1').costBasis, 'lots');
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

test('老销售没记厂家：这个药只从一家进过就认那家，多家就按进货先后出', () => {
  const s = single();
  assert.equal(supplierResolver(s)(s.sales[0]), '上游A');
  assert.equal(compute(s).products[0].name, '甲（上游A）');
  const t = twoMakers();
  t.sales.push({ id: 'old', date: '2026-09-02', product: '甲', customer: '下游C', qty: 10, price: 1.5 });
  assert.equal(compute(t).salesById.get('old').unitCost, 1);
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

// ---------- 按批次出货 ----------
import { fifoLots, openBatchesFor } from '../public/ledger/core.js';

function twoBatches() {
  const s = emptyState();
  s.purchases.push({ id: 'b1', date: '2026-09-01', supplier: '厂家A', product: '甲', qty: 100, price: 1 });
  s.purchases.push({ id: 'b2', date: '2026-09-05', supplier: '厂家A', product: '甲', qty: 100, price: 1.2 });
  return s;
}

test('先进先出：150 件 = 第一批 100 + 第二批 50，按两批实际进价算税', () => {
  const s = twoBatches();
  const lots = fifoLots(s, '厂家A', '甲', 150, '2026-09-10');
  assert.deepEqual(lots, [{ purchaseId: 'b1', qty: 100 }, { purchaseId: 'b2', qty: 50 }]);
  s.sales.push({ id: 's', date: '2026-09-10', supplier: '厂家A', product: '甲', customer: '下游C', qty: 150, price: 1.5, lots });
  const r = compute(s);
  // 成本 100 + 60 = 160；差价 225 − 160 = 65；税 2.25 + 8.45 = 10.70
  assert.equal(y(r.salesById.get('s').cogs), 160);
  assert.equal(y(r.salesById.get('s').taxFull), 10.7);
  assert.equal(r.purchasesById.get('b1').remaining, 0);
  assert.equal(r.purchasesById.get('b2').remaining, 50);
});

test('自己挑批次：第一批 50 + 第二批 100，税跟着变', () => {
  const s = twoBatches();
  s.sales.push({ id: 's', date: '2026-09-10', supplier: '厂家A', product: '甲', customer: '下游C', qty: 150, price: 1.5, lots: [{ purchaseId: 'b1', qty: 50 }, { purchaseId: 'b2', qty: 100 }] });
  const r = compute(s);
  // 成本 50 + 120 = 170；差价 55；税 2.25 + 7.15 = 9.40
  assert.equal(y(r.salesById.get('s').cogs), 170);
  assert.equal(y(r.salesById.get('s').taxFull), 9.4);
  // 下一笔默认先进先出：先用第一批剩的 50
  assert.deepEqual(fifoLots(s, '厂家A', '甲', 60, '2026-09-11'), [{ purchaseId: 'b1', qty: 50 }]);
  // 回款按这笔的税负扣：回 75（一半）扣 4.7
  s.receipts.push({ id: 'r', date: '2026-09-12', customer: '下游C', account: 'company', amount: 112.5, allocations: [{ saleId: 's', amount: 112.5 }] });
  assert.equal(y(compute(s).totals.companyTax), 4.7);
});

test('改旧销售时，它自己用掉的批次不算占用', () => {
  const s = twoBatches();
  s.sales.push({ id: 's', date: '2026-09-10', supplier: '厂家A', product: '甲', customer: '下游C', qty: 100, price: 1.5, lots: [{ purchaseId: 'b1', qty: 100 }] });
  assert.deepEqual(openBatchesFor(s, '厂家A', '甲').map((b) => [b.purchase.id, b.remaining]), [['b2', 100]]);
  assert.deepEqual(openBatchesFor(s, '厂家A', '甲', 's').map((b) => [b.purchase.id, b.remaining]), [['b1', 100], ['b2', 100]]);
});

test('老销售没记批次：扣掉记了批次的，再先进先出', () => {
  const s = twoBatches();
  s.sales.push({ id: 'new', date: '2026-09-10', supplier: '厂家A', product: '甲', customer: '下游C', qty: 80, price: 1.5, lots: [{ purchaseId: 'b1', qty: 80 }] });
  s.sales.push({ id: 'old', date: '2026-09-03', supplier: '厂家A', product: '甲', customer: '下游C', qty: 50, price: 1.5 });
  const r = compute(s);
  // 第一批只剩 20 → old 用 20 件 × 1 + 30 件 × 1.2 = 56
  assert.equal(y(r.salesById.get('old').cogs), 56);
});

test('卖得比库存多：多出的按平均进价算并提醒；某批出得比进得多也提醒', () => {
  const s = twoBatches();
  s.sales.push({ id: 's', date: '2026-09-10', supplier: '厂家A', product: '甲', customer: '下游C', qty: 250, price: 1.5 });
  let r = compute(s);
  assert.equal(y(r.salesById.get('s').cogs), 100 + 120 + 50 * 1.1);
  assert.ok(r.issues.some((t) => t.includes('比库存多 50 件')));
  const t = twoBatches();
  t.sales.push({ id: 's', date: '2026-09-10', supplier: '厂家A', product: '甲', customer: '下游C', qty: 120, price: 1.5, lots: [{ purchaseId: 'b1', qty: 120 }] });
  r = compute(t);
  assert.ok(r.issues.some((x) => x.includes('进了 100 件，记的卖出有 120 件')));
});

test('同一个药不分厂家列批次：按进货日期排', () => {
  const s = twoMakers();
  s.purchases.push({ id: 'pa2', date: '2026-08-20', supplier: '厂家A', product: '甲', qty: 10, price: 0.9 });
  assert.deepEqual(openBatchesFor(s, null, '甲').map((b) => b.purchase.id), ['pa2', 'pa', 'pb']);
  assert.deepEqual(openBatchesFor(s, '厂家B', '甲').map((b) => b.purchase.id), ['pb']);
});

// ---------- 修复：金额精度 ----------
import { mulCents, sanitize, mergeStates, touch, tomb, removeFromList } from '../public/ledger/core.js';

test('单价超过两位小数：金额按单价 × 件数算到分', () => {
  assert.equal(mulCents(0.125, 10000), 125000);   // 进价 0.125 × 10000 片 = 1250 元，不是 1300
  assert.equal(mulCents(0.001, 1000), 100);       // 0.001 × 1000 = 1 元，不是 0
  assert.equal(mulCents(0.035, 3), 11);           // 0.105 → 0.11
  assert.equal(mulCents(1.005, 1), 101);          // 浮点 100.4999… 不会被舍成 1.00
  const s = emptyState();
  s.purchases.push({ id: 'p', date: '2026-09-01', supplier: 'A', product: '片', qty: 10000, price: 0.125 });
  s.sales.push({ id: 's', date: '2026-09-02', supplier: 'A', product: '片', customer: 'C', qty: 10000, price: 0.2, lots: [{ purchaseId: 'p', qty: 10000 }] });
  const r = compute(s);
  assert.equal(y(r.totals.purchaseTotal), 1250);
  assert.equal(y(r.salesById.get('s').cogs), 1250);
  assert.equal(y(r.totals.revenue), 2000);
  // 750 差价 × 13% + 2000 × 1% = 97.5 + 20
  assert.equal(y(r.salesById.get('s').taxFull), 117.5);
});

// ---------- 修复：坏数据不让页面挂掉 ----------
test('读进来的数据先洗：坏字段、坏记录、重复编号都不报错', () => {
  const { state, dropped } = sanitize({
    sales: [{}, null, 'x', { id: 's1', qty: 'abc', price: null, lots: 'oops' }, { id: 's1', qty: 2, price: 1, _u: 5 }],
    receipts: [{ id: 'r', allocations: 'oops', amount: '12' }],
    purchases: [{ id: 'p' }], prices: 'bad', lists: { products: 'bad', customers: ['A', null, 3] }, settings: 'x',
  });
  assert.equal(dropped, 4);
  assert.equal(state.sales.length, 1);
  assert.equal(state.sales[0].qty, 2);           // 重复编号留最新的
  assert.deepEqual(state.receipts[0].allocations, []);
  assert.equal(state.receipts[0].amount, 12);
  assert.deepEqual(state.prices, []);
  assert.deepEqual(state.lists.customers, ['A', '3']);
  assert.doesNotThrow(() => compute({ ...emptyState(), ...state }));
  assert.equal(sanitize(null).state.sales.length, 0);
  assert.equal(sanitize({ sales: [] }).state.lists, undefined); // 没有下拉单：留给页面用记过的名字生成
});

// ---------- 修复：多设备按每一笔合并 ----------
test('两台设备各记一笔：合并后两笔都在', () => {
  const base = emptyState();
  const a = { ...base, purchases: [touch({ id: 'A1', date: '2026-09-01' })] };
  const b = { ...base, purchases: [touch({ id: 'B1', date: '2026-09-01' })] };
  assert.deepEqual(mergeStates(a, b).purchases.map((x) => x.id).sort(), ['A1', 'B1']);
});

test('同一笔两边都改过：留后改的', () => {
  const old = { id: 'x', qty: 1, _u: 100 };
  const nu = { id: 'x', qty: 2, _u: 200 };
  assert.equal(mergeStates({ ...emptyState(), sales: [old] }, { ...emptyState(), sales: [nu] }).sales[0].qty, 2);
  assert.equal(mergeStates({ ...emptyState(), sales: [nu] }, { ...emptyState(), sales: [old] }).sales[0].qty, 2);
});

test('一台删了、另一台还留着旧的：合并后是删掉的，不会复活', () => {
  const a = emptyState(); a.sales = [];
  tomb(a, 'sales:x');
  const b = { ...emptyState(), sales: [{ id: 'x', qty: 1, _u: 1 }] };
  assert.equal(mergeStates(a, b).sales.length, 0);
  assert.equal(mergeStates(b, a).sales.length, 0);
  // 删了之后另一台又改了它（改的时间更晚）：留下
  const c = { ...emptyState(), sales: [{ id: 'x', qty: 9, _u: Date.now() + 10000 }] };
  assert.equal(mergeStates(a, c).sales.length, 1);
});

test('价目表、下拉单、设置也按条合并', () => {
  const a = emptyState(); const b = emptyState();
  setListPrice(a, 'A', '甲', 1.5);
  setListPrice(b, 'A', '乙', 2);
  addToList(a, 'customers', '仁和');
  addToList(b, 'customers', '康宁');
  b.settings = { revenueRate: 0.02, marginRate: 0.13, _u: Date.now() + 1000 };
  const m = mergeStates(a, b);
  assert.deepEqual(m.prices.map((p) => p.product).sort(), ['乙', '甲']);
  assert.deepEqual(m.lists.customers.sort(), ['仁和', '康宁']);
  assert.equal(m.settings.revenueRate, 0.02);
  removeListPrice(a, 'A', '甲'); removeFromList(a, 'customers', '仁和');
  const m2 = mergeStates(a, m);
  assert.deepEqual(m2.prices.map((p) => p.product), ['乙']);
  assert.deepEqual(m2.lists.customers, ['康宁']);
});

test('清空 / 导入：别的设备同步后也跟着清空，导入的不会被清空记录删掉', async () => {
  const { wipeState, importState, mergeStates, touch, emptyState: es } = await import('../public/ledger/core.js');
  const other = { ...es(), sales: [touch({ id: 'a', date: '2026-10-01' })], prices: [touch({ supplier: 'S', product: 'P', price: 2 })], lists: { products: ['P'], suppliers: ['S'], customers: [] }, listU: {} };
  const mine = JSON.parse(JSON.stringify(other));
  const wiped = wipeState(mine);
  const after = mergeStates(other, wiped);
  assert.equal(after.sales.length, 0);
  assert.equal(after.prices.length, 0);
  assert.deepEqual(after.lists.products, []);
  const imported = importState(mine, { sales: [{ id: 'a', date: '2026-01-01' }, { id: 'b' }], purchases: [], receipts: [], settings: { revenueRate: 0.02, marginRate: 0.13 } });
  const synced = mergeStates(other, imported);
  assert.deepEqual(synced.sales.map((x) => x.id).sort(), ['a', 'b']);
  assert.equal(synced.sales.find((x) => x.id === 'a').date, '2026-01-01');
  assert.equal(synced.settings.revenueRate, 0.02);
  assert.deepEqual(synced.prices, []);
});
