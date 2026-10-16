// 账本核心：只存原始单据，所有余额 / 税 / 应收都由 compute() 按时间顺序重放算出来。
// 好处是删改任何一笔，后面的扣税、提现会自动重算，不会出现"账对不上"。
// 内部一律用「分」做整数运算，避免浮点误差。
//
// 扣税规则：税 = 回款额 × 回款税点 + 差价 × 差价税率
//   例：进价 1、售价 1.5、200 件 → 200×1.5×1% + 0.5×200×13% = 3 + 13 = 16
// 所以税负跟着每笔销售的差价走：一元回款要扣多少，取决于它核销的是哪笔销售。

export const ACCOUNT = { COMPANY: 'company', PERSONAL: 'personal' };

export const DEFAULT_SETTINGS = {
  revenueRate: 0.01, // 按回款额扣
  marginRate: 0.13,  // 按差价（售价 − 进价）扣
};

export function emptyState() {
  return {
    version: 4,
    settings: { ...DEFAULT_SETTINGS },
    purchases: [],   // { id, date, supplier, product, qty, price, note }
    sales: [],       // { id, date, customer, product, qty, price, cost(单位进价), note }
    receipts: [],    // { id, date, customer, account, amount(到账), allocations:[{saleId, amount(核销)}], note }
    payments: [],    // { id, date, supplier, account, amount(打出去的钱), allocations:[{purchaseId, amount}], note }
    withdrawals: [], // { id, date, net(从公司提到个人的钱), note }
  };
}

export const toCents = (yuan) => Math.round((Number(yuan) || 0) * 100);
export const toYuan = (cents) => cents / 100;
const isNum = (v) => v !== '' && v != null && Number.isFinite(Number(v));

export function normSettings(s = {}) {
  return {
    revenueRate: isNum(s.revenueRate) ? Number(s.revenueRate) : DEFAULT_SETTINGS.revenueRate,
    marginRate: isNum(s.marginRate) ? Number(s.marginRate) : DEFAULT_SETTINGS.marginRate,
  };
}

const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

export const saleAmount = (s) => toYuan(Math.round(toCents(s.price) * Number(s.qty || 0)));
export const purchaseAmount = (p) => toYuan(Math.round(toCents(p.price) * Number(p.qty || 0)));

// 各品种加权平均进价（元/件）
export function avgCosts(state) {
  const m = new Map();
  for (const p of state.purchases) {
    const x = m.get(p.product) || { qty: 0, cost: 0 };
    x.qty += Number(p.qty) || 0;
    x.cost += toCents(purchaseAmount(p));
    m.set(p.product, x);
  }
  const out = new Map();
  for (const [k, x] of m) if (x.qty) out.set(k, x.cost / x.qty / 100);
  return out;
}

// 这笔销售的单位进价：录了就用录的，没录就用该品种平均进价
export function unitCost(sale, avg) {
  if (isNum(sale.cost)) return Number(sale.cost);
  return avg.get(sale.product) ?? 0;
}

// 每回 1 元这笔销售的款，要扣多少税
export function saleTaxRate(price, cost, settings) {
  const S = normSettings(settings);
  const p = Number(price) || 0;
  if (p <= 0) return S.revenueRate;
  const marginRatio = Math.max(0, (p - cost) / p);
  return S.revenueRate + S.marginRate * marginRatio;
}

// 一笔销售全部回款时要扣的税，拆成两部分给界面展示（分）
export function saleTaxBreakdown(sale, cost, settings) {
  const S = normSettings(settings);
  const total = toCents(saleAmount(sale));
  const margin = Math.max(0, Math.round((toCents(sale.price) - toCents(cost)) * Number(sale.qty || 0)));
  const revenueTax = Math.round(total * S.revenueRate);
  const marginTax = Math.round(margin * S.marginRate);
  return { total, margin, revenueTax, marginTax, tax: revenueTax + marginTax };
}

const taxOn = (cents, rate) => Math.round(cents * rate);

// saleId → { cost, rate }
export function saleRates(state) {
  const avg = avgCosts(state);
  const m = new Map();
  for (const s of state.sales) {
    const cost = unitCost(s, avg);
    m.set(s.id, { cost, rate: saleTaxRate(s.price, cost, state.settings) });
  }
  return m;
}

function settledBySale(state, excludeReceiptId) {
  const m = new Map();
  for (const r of state.receipts) {
    if (r.id === excludeReceiptId) continue;
    for (const a of r.allocations || []) m.set(a.saleId, (m.get(a.saleId) || 0) + toCents(a.amount));
  }
  return m;
}

// 某个下游的未回清销售，按日期先后排
export function openSalesFor(state, customer, excludeReceiptId) {
  const settled = settledBySale(state, excludeReceiptId);
  const rates = saleRates(state);
  return state.sales
    .filter((s) => s.customer === customer)
    .map((s) => {
      const total = toCents(saleAmount(s));
      const done = settled.get(s.id) || 0;
      return { sale: s, total, settled: done, outstanding: total - done, rate: rates.get(s.id).rate };
    })
    .filter((x) => x.outstanding > 0)
    .sort((a, b) => cmp(a.sale.date, b.sale.date) || cmp(a.sale.id, b.sale.id));
}

// 回到公司：到账多少就核销多少，按先进先出分到未回清销售上
export function autoAllocate(state, customer, grossYuan, excludeReceiptId) {
  let left = toCents(grossYuan);
  const out = [];
  for (const o of openSalesFor(state, customer, excludeReceiptId)) {
    if (left <= 0) break;
    const take = Math.min(left, o.outstanding);
    out.push({ saleId: o.sale.id, amount: toYuan(take) });
    left -= take;
  }
  return out;
}

// 回到个人：到账的是扣完税的钱，按先进先出反推每笔销售核销了多少
export function autoAllocateNet(state, customer, netYuan, excludeReceiptId) {
  let left = toCents(netYuan);
  const out = [];
  for (const o of openSalesFor(state, customer, excludeReceiptId)) {
    if (left <= 0) break;
    const cap = o.outstanding - taxOn(o.outstanding, o.rate);
    const gross = cap <= left ? o.outstanding : Math.min(o.outstanding, Math.round(left / (1 - o.rate)));
    out.push({ saleId: o.sale.id, amount: toYuan(gross) });
    left -= cap <= left ? cap : left;
  }
  return out;
}

// 一组核销按规则应扣多少税（分）
export function allocationTax(state, allocations) {
  const rates = saleRates(state);
  return (allocations || []).reduce((s, a) => s + taxOn(toCents(a.amount), rates.get(a.saleId)?.rate ?? normSettings(state.settings).revenueRate), 0);
}

export const receiptGross = (r) =>
  toYuan((r.allocations || []).reduce((s, a) => s + toCents(a.amount), 0));

// ---------- 应付：每笔进货 = 欠上游的钱 ----------

function paidByPurchase(state, excludePaymentId) {
  const m = new Map();
  for (const p of state.payments || []) {
    if (p.id === excludePaymentId) continue;
    for (const a of p.allocations || []) m.set(a.purchaseId, (m.get(a.purchaseId) || 0) + toCents(a.amount));
  }
  return m;
}

// 某个上游还没付清的进货，按日期先后排
export function openPurchasesFor(state, supplier, excludePaymentId) {
  const paid = paidByPurchase(state, excludePaymentId);
  return state.purchases
    .filter((p) => p.supplier === supplier)
    .map((p) => {
      const total = toCents(purchaseAmount(p));
      const done = paid.get(p.id) || 0;
      return { purchase: p, total, paid: done, outstanding: total - done };
    })
    .filter((x) => x.outstanding > 0)
    .sort((a, b) => cmp(a.purchase.date, b.purchase.date) || cmp(a.purchase.id, b.purchase.id));
}

// 打给上游的钱按先进先出分到没付清的进货上
export function autoAllocatePayment(state, supplier, yuan, excludePaymentId) {
  let left = toCents(yuan);
  const out = [];
  for (const o of openPurchasesFor(state, supplier, excludePaymentId)) {
    if (left <= 0) break;
    const take = Math.min(left, o.outstanding);
    out.push({ purchaseId: o.purchase.id, amount: toYuan(take) });
    left -= take;
  }
  return out;
}

export const paymentAllocated = (p) =>
  toYuan((p.allocations || []).reduce((s, a) => s + toCents(a.amount), 0));

// ---------- 两个账户 ----------
// 税是跟着销售定死的（回款额 × 税点 + 差价 × 税率），公司什么时候交、交没交，都不影响你的钱。
// 所以回到公司的钱，直接按「到账 − 规则税」算你的；回到个人的，到账的就已经是扣完税的。
// 公司账户里你的钱 = 回到公司的（扣完税）− 从公司付上游的 − 提出来的
// 个人账户       = 回到个人的 + 从公司提出来的 − 从个人付上游的

const TYPE_ORDER = { receipt: 0, payment: 1, withdrawal: 2 };

export function compute(state) {
  const settings = normSettings(state.settings);
  const issues = [];
  const avg = avgCosts(state);
  const rates = saleRates(state);
  const payments = state.payments || [];
  const withdrawalsIn = state.withdrawals || [];

  // ---- 销售 & 应收 ----
  const settled = settledBySale(state);
  const sales = state.sales.map((s) => {
    const total = toCents(saleAmount(s));
    const done = settled.get(s.id) || 0;
    const { cost, rate } = rates.get(s.id);
    const tb = saleTaxBreakdown(s, cost, settings);
    if (done > total) issues.push(`销售「${s.customer} ${s.product}」核销金额超过了销售额`);
    if (!isNum(s.cost) && !avg.has(s.product)) issues.push(`销售「${s.date} ${s.customer} ${s.product}」没有进价，差价税会按全额算`);
    return {
      ...s, total, settled: done, outstanding: Math.max(0, total - done),
      unitCost: cost, cogs: Math.round(toCents(cost) * Number(s.qty || 0)), rate, taxFull: tb.tax, taxBreakdown: tb,
    };
  });
  const salesById = new Map(sales.map((s) => [s.id, s]));
  for (const r of state.receipts)
    for (const a of r.allocations || [])
      if (!salesById.has(a.saleId)) issues.push(`回款（${r.date} ${r.customer}）指向了已删除的销售`);

  // ---- 进货 & 应付 ----
  const paid = paidByPurchase(state);
  const purchases = state.purchases.map((p) => {
    const total = toCents(purchaseAmount(p));
    const done = paid.get(p.id) || 0;
    if (done > total) issues.push(`进货「${p.supplier} ${p.product}」付款超过了进货额`);
    return { ...p, total, paid: done, outstanding: Math.max(0, total - done) };
  });
  const purchasesById = new Map(purchases.map((p) => [p.id, p]));
  for (const pay of payments)
    for (const a of pay.allocations || [])
      if (!purchasesById.has(a.purchaseId)) issues.push(`付款（${pay.date} ${pay.supplier}）指向了已删除的进货`);

  // 没对上销售的那部分回款，按这个下游（没有就按全部）销售的平均税负估
  const avgRate = (list) => {
    const t = list.reduce((s, x) => s + x.total, 0);
    return t ? list.reduce((s, x) => s + x.total * x.rate, 0) / t : settings.revenueRate;
  };
  const globalRate = avgRate(sales);
  const customerRate = (c) => {
    const list = sales.filter((s) => s.customer === c);
    return list.length ? avgRate(list) : globalRate;
  };

  // ---- 库存 & 毛利 ----
  const products = new Map();
  const prod = (name) => {
    if (!products.has(name)) products.set(name, { name, inQty: 0, inCost: 0, outQty: 0, outRevenue: 0, cogs: 0 });
    return products.get(name);
  };
  for (const p of state.purchases) {
    const x = prod(p.product);
    x.inQty += Number(p.qty) || 0;
    x.inCost += toCents(purchaseAmount(p));
  }
  for (const s of sales) {
    const x = prod(s.product);
    x.outQty += Number(s.qty) || 0;
    x.outRevenue += s.total;
    x.cogs += s.cogs;
  }
  let cogs = 0;
  for (const x of products.values()) {
    x.avgCost = x.inQty ? x.inCost / x.inQty : 0; // 分/件
    x.stock = x.inQty - x.outQty;
    x.profit = x.outRevenue - x.cogs;
    cogs += x.cogs;
    if (x.stock < 0) issues.push(`「${x.name}」卖出数量比进货多 ${-x.stock}，少录了进货？`);
  }

  // ---- 按时间重放两个账户 ----
  const events = [
    ...state.receipts.map((r) => ({ type: 'receipt', date: r.date, id: r.id, rec: r })),
    ...payments.map((p) => ({ type: 'payment', date: p.date, id: p.id, rec: p })),
    ...withdrawalsIn.map((w) => ({ type: 'withdrawal', date: w.date, id: w.id, rec: w })),
  ].sort((a, b) => cmp(a.date, b.date) || TYPE_ORDER[a.type] - TYPE_ORDER[b.type] || cmp(a.id, b.id));

  const flow = [];          // 公司账户流水（你的钱）
  const personalFlow = [];  // 个人账户流水
  const receipts = new Map();
  const paymentsOut = new Map();
  const withdrawals = new Map();
  let company = 0, personal = 0;
  let personalIn = 0, personalTax = 0, personalPaid = 0;
  let companyIn = 0, companyTax = 0, companyPaid = 0, withdrawn = 0;

  for (const ev of events) {
    const r = ev.rec;
    if (ev.type === 'receipt') {
      const amount = toCents(r.amount);
      const gross = toCents(receiptGross(r));
      const unallocated = Math.max(0, amount - gross);
      const ruleTax = (r.allocations || []).reduce((s, a) => s + taxOn(toCents(a.amount), salesById.get(a.saleId)?.rate ?? settings.revenueRate), 0);
      if (r.account === ACCOUNT.PERSONAL) {
        const tax = Math.max(0, gross - amount);
        personal += amount;
        personalIn += amount;
        personalTax += tax;
        receipts.set(r.id, { ...r, amountC: amount, grossC: gross, taxC: tax, ruleTax, mineC: amount, unallocated });
        personalFlow.push({ date: r.date, kind: '回款', text: `${r.customer} 回款（已扣税 ¥${fmt(tax)}）`, delta: amount, balance: personal, ref: r.id, edit: 'receipt' });
      } else {
        const tax = Math.min(amount, ruleTax + taxOn(unallocated, customerRate(r.customer)));
        const mine = amount - tax;
        company += mine;
        companyIn += amount;
        companyTax += tax;
        receipts.set(r.id, { ...r, amountC: amount, grossC: gross, taxC: tax, ruleTax: tax, mineC: mine, unallocated });
        flow.push({ date: r.date, kind: '回款', text: `${r.customer} 到账 ¥${fmt(amount)}，扣税 ¥${fmt(tax)}`, delta: mine, balance: company, ref: r.id, edit: 'receipt' });
      }
    } else if (ev.type === 'payment') {
      const amount = toCents(r.amount);
      const allocated = toCents(paymentAllocated(r));
      if (r.account === ACCOUNT.PERSONAL) {
        personal -= amount;
        personalPaid += amount;
        paymentsOut.set(r.id, { ...r, amountC: amount, allocatedC: allocated, before: personal + amount, over: 0 });
        personalFlow.push({ date: r.date, kind: '付款', text: `付 ${r.supplier} 货款`, delta: -amount, balance: personal, ref: r.id, edit: 'payment' });
      } else {
        const before = company;
        company -= amount;
        companyPaid += amount;
        const over = Math.max(0, amount - Math.max(0, before));
        paymentsOut.set(r.id, { ...r, amountC: amount, allocatedC: allocated, before, over });
        flow.push({ date: r.date, kind: '付款', text: `付 ${r.supplier} 货款`, delta: -amount, balance: company, ref: r.id, edit: 'payment' });
      }
    } else if (ev.type === 'withdrawal') {
      const want = toCents(r.net);
      const before = company;
      const shortfall = Math.max(0, want - Math.max(0, before));
      if (shortfall > 0) issues.push(`${r.date} 提现 ¥${fmt(want)}：当时你在公司的钱只有 ¥${fmt(Math.max(0, before))}`);
      company -= want;
      personal += want;
      withdrawn += want;
      withdrawals.set(r.id, { ...r, amountC: want, before, shortfall });
      flow.push({ date: r.date, kind: '提现', text: '提到个人账户', delta: -want, balance: company, ref: r.id, edit: 'withdraw' });
      personalFlow.push({ date: r.date, kind: '提现', text: '从公司账户提出', delta: want, balance: personal, ref: r.id, edit: 'withdraw' });
    }
  }
  if (company < 0) issues.push(`从公司付出去的比你在公司的钱多 ¥${fmt(-company)}，相当于先占用了公司的钱`);

  // ---- 往来：每个下游欠多少、欠每个上游多少 ----
  const customers = new Map();
  for (const s of sales) {
    const c = customers.get(s.customer) || { name: s.customer, total: 0, settled: 0, outstanding: 0, oldest: null };
    c.total += s.total; c.settled += s.settled; c.outstanding += s.outstanding;
    if (s.outstanding > 0 && (!c.oldest || s.date < c.oldest)) c.oldest = s.date;
    customers.set(s.customer, c);
  }
  const suppliers = new Map();
  for (const p of purchases) {
    const c = suppliers.get(p.supplier) || { name: p.supplier, total: 0, paid: 0, outstanding: 0, oldest: null };
    c.total += p.total; c.paid += p.paid; c.outstanding += p.outstanding;
    if (p.outstanding > 0 && (!c.oldest || p.date < c.oldest)) c.oldest = p.date;
    suppliers.set(p.supplier, c);
  }

  const revenue = sales.reduce((s, x) => s + x.total, 0);
  const receivable = sales.reduce((s, x) => s + x.outstanding, 0);
  const receivableTax = sales.reduce((s, x) => s + taxOn(x.outstanding, x.rate), 0);
  const purchaseTotal = purchases.reduce((s, p) => s + p.total, 0);
  const payable = purchases.reduce((s, p) => s + p.outstanding, 0);
  const taxPaid = personalTax + companyTax;

  return {
    settings,
    sales,
    salesById,
    purchases,
    purchasesById,
    receipts,
    payments: paymentsOut,
    withdrawals,
    flow,
    personalFlow,
    products: [...products.values()],
    customers: [...customers.values()].sort((a, b) => b.outstanding - a.outstanding),
    suppliers: [...suppliers.values()].sort((a, b) => b.outstanding - a.outstanding),
    issues,
    totals: {
      purchaseTotal, payable, paidTotal: personalPaid + companyPaid, personalPaid, companyPaid,
      revenue, cogs, grossProfit: revenue - cogs, receivable, receivableTax,
      personalIn, personalTax, companyIn, companyTax, withdrawn, taxPaid,
      companyBalance: company,
      personalBalance: personal,
      // 税后利润（估）= 毛利 − 已扣的税 − 应收未回部分将来要扣的税
      netProfitEst: revenue - cogs - taxPaid - receivableTax,
    },
  };
}

const PROBE = '￿';

// 某天你在公司的钱（含当天及之前的流水）
export function companyBalanceAt(state, date, exclude = {}) {
  const cut = (arr, ex) => (arr || []).filter((x) => x.date <= date && x.id !== ex);
  return compute({
    ...state,
    receipts: cut(state.receipts),
    payments: cut(state.payments, exclude.payment),
    withdrawals: cut(state.withdrawals, exclude.withdrawal),
  }).totals.companyBalance;
}

// 模拟一次提现 / 从公司付上游，看当时钱够不够
export function previewWithdrawal(state, yuan, date) {
  const probe = { ...state, withdrawals: [...(state.withdrawals || []), { id: PROBE, date, net: yuan }] };
  return compute(probe).withdrawals.get(PROBE);
}

export function previewPayment(state, payment) {
  const probe = { ...state, payments: [...(state.payments || []), { ...payment, id: PROBE }] };
  return compute(probe).payments.get(PROBE);
}

export function fmt(cents) {
  const v = cents / 100;
  return v.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export const pct = (rate) => `${(rate * 100).toFixed(2).replace(/\.?0+$/, '')}%`;

export function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

export function monthEnd(ym) {
  const [y, m] = ym.split('-').map(Number);
  return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
}

export function prevMonth(dateStr) {
  const [y, m] = dateStr.split('-').map(Number);
  return new Date(Date.UTC(y, m - 2, 1)).toISOString().slice(0, 7);
}
