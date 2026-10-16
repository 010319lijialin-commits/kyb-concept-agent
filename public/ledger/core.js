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
    version: 2,
    settings: { ...DEFAULT_SETTINGS },
    purchases: [],   // { id, date, supplier, product, qty, price, note }
    sales: [],       // { id, date, customer, product, qty, price, cost(单位进价), note }
    receipts: [],    // { id, date, customer, account, amount(到账), allocations:[{saleId, amount(核销)}], note }
    taxRuns: [],     // { id, date, cutoff, note }  月度扣税：扣掉 cutoff 当天及之前到公司的未税回款
    withdrawals: [], // { id, date, net(想拿到手的钱), note }
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

// ---------- 公司账户：按"批次"记 ----------
// 每笔回到公司的钱是一个批次：{ remaining, taxed, rate }，rate 由它核销的销售差价决定。
// 月度扣税：把截止日前的未税批次扣税，标成已税。
// 提现：先花已税批次（不用再扣），不够再动未税批次（边提边扣税）。

function withdrawFromLots(lots, netCents) {
  let need = netCents;
  let gross = 0;
  let tax = 0;
  const parts = [];

  for (const lot of lots) {
    if (need <= 0) break;
    if (!lot.taxed || lot.remaining <= 0) continue;
    const take = Math.min(lot.remaining, need);
    lot.remaining -= take;
    need -= take;
    gross += take;
    parts.push({ receiptId: lot.receiptId, gross: take, tax: 0, net: take, taxed: true });
  }

  for (const lot of lots) {
    if (need <= 0) break;
    if (lot.taxed || lot.remaining <= 0) continue;
    const lotTax = taxOn(lot.remaining, lot.rate);
    const lotNet = lot.remaining - lotTax;
    let g, t, n;
    if (lotNet <= need) {
      g = lot.remaining; t = lotTax; n = lotNet;
    } else {
      g = Math.min(lot.remaining, Math.round(need / (1 - lot.rate)));
      t = g - need; n = need;
    }
    lot.remaining -= g;
    need -= n;
    gross += g;
    tax += t;
    parts.push({ receiptId: lot.receiptId, gross: g, tax: t, net: n, taxed: false });
  }

  return { gross, tax, net: netCents - need, shortfall: need, parts };
}

const TYPE_ORDER = { receipt: 0, taxRun: 1, withdrawal: 2 };

export function compute(state) {
  const settings = normSettings(state.settings);
  const issues = [];
  const avg = avgCosts(state);
  const rates = saleRates(state);

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

  // ---- 按时间重放公司账户 ----
  const events = [
    ...state.receipts.map((r) => ({ type: 'receipt', date: r.date, id: r.id, rec: r })),
    ...state.taxRuns.map((t) => ({ type: 'taxRun', date: t.date, id: t.id, rec: t })),
    ...state.withdrawals.map((w) => ({ type: 'withdrawal', date: w.date, id: w.id, rec: w })),
  ].sort((a, b) => cmp(a.date, b.date) || TYPE_ORDER[a.type] - TYPE_ORDER[b.type] || cmp(a.id, b.id));

  const lots = [];
  const flow = [];
  const receipts = new Map();
  const taxRuns = new Map();
  const withdrawals = new Map();
  let personalIn = 0, personalTax = 0, companyIn = 0, taxRunTotal = 0, withdrawTax = 0, withdrawNet = 0;

  const balance = () => lots.reduce((s, l) => s + l.remaining, 0);

  for (const ev of events) {
    const r = ev.rec;
    if (ev.type === 'receipt') {
      const amount = toCents(r.amount);
      const gross = toCents(receiptGross(r));
      const ruleTax = (r.allocations || []).reduce((s, a) => s + taxOn(toCents(a.amount), salesById.get(a.saleId)?.rate ?? settings.revenueRate), 0);
      if (r.account === ACCOUNT.PERSONAL) {
        const tax = Math.max(0, gross - amount);
        personalIn += amount;
        personalTax += tax;
        receipts.set(r.id, { ...r, amountC: amount, grossC: gross, taxC: tax, ruleTax, unallocated: Math.max(0, amount - gross) });
      } else {
        const unallocated = Math.max(0, amount - gross);
        const lotTax = ruleTax + taxOn(unallocated, customerRate(r.customer));
        const rate = amount ? Math.min(lotTax / amount, 0.99) : 0;
        lots.push({ receiptId: r.id, date: r.date, customer: r.customer, original: amount, remaining: amount, taxed: false, taxedBy: null, rate });
        companyIn += amount;
        receipts.set(r.id, { ...r, amountC: amount, grossC: gross, taxC: 0, ruleTax: lotTax, unallocated, rate });
        flow.push({ date: r.date, kind: '回款', text: `${r.customer} 回款（未扣税）`, delta: amount, balance: balance(), ref: r.id });
      }
    } else if (ev.type === 'taxRun') {
      let total = 0, base = 0;
      const details = [];
      for (const lot of lots) {
        if (lot.taxed || lot.remaining <= 0 || lot.date > r.cutoff) continue;
        const t = taxOn(lot.remaining, lot.rate);
        details.push({ receiptId: lot.receiptId, base: lot.remaining, tax: t, rate: lot.rate });
        base += lot.remaining;
        total += t;
        lot.remaining -= t;
        lot.taxed = true;
        lot.taxedBy = r.id;
      }
      taxRunTotal += total;
      taxRuns.set(r.id, { ...r, base, tax: total, details });
      flow.push({ date: r.date, kind: '扣税', text: `月度扣税（${r.cutoff} 前的未税回款 ¥${fmt(base)}）`, delta: -total, balance: balance(), ref: r.id });
    } else if (ev.type === 'withdrawal') {
      const want = toCents(r.net);
      const res = withdrawFromLots(lots, want);
      if (res.shortfall > 0) issues.push(`${r.date} 提现 ¥${fmt(want)}：公司账户当时不够，只能提到 ¥${fmt(res.net)}`);
      withdrawTax += res.tax;
      withdrawNet += res.net;
      withdrawals.set(r.id, { ...r, ...res, want });
      flow.push({
        date: r.date, kind: '提现',
        text: res.tax ? `提现到手 ¥${fmt(res.net)}（其中动用未税款，扣税 ¥${fmt(res.tax)}）` : `提现到手 ¥${fmt(res.net)}（已税款，不用再扣）`,
        delta: -res.gross, balance: balance(), ref: r.id,
      });
    }
  }

  const taxedBal = lots.filter((l) => l.taxed).reduce((s, l) => s + l.remaining, 0);
  const untaxedBal = lots.filter((l) => !l.taxed).reduce((s, l) => s + l.remaining, 0);
  const pendingTax = lots.filter((l) => !l.taxed).reduce((s, l) => s + taxOn(l.remaining, l.rate), 0);
  const maxWithdrawNet = lots.reduce((s, l) => s + (l.remaining <= 0 ? 0 : l.taxed ? l.remaining : l.remaining - taxOn(l.remaining, l.rate)), 0);

  // ---- 往来：每个下游欠多少 ----
  const customers = new Map();
  for (const s of sales) {
    const c = customers.get(s.customer) || { name: s.customer, total: 0, settled: 0, outstanding: 0, oldest: null };
    c.total += s.total; c.settled += s.settled; c.outstanding += s.outstanding;
    if (s.outstanding > 0 && (!c.oldest || s.date < c.oldest)) c.oldest = s.date;
    customers.set(s.customer, c);
  }

  const revenue = sales.reduce((s, x) => s + x.total, 0);
  const receivable = sales.reduce((s, x) => s + x.outstanding, 0);
  const receivableTax = sales.reduce((s, x) => s + taxOn(x.outstanding, x.rate), 0);
  const purchaseTotal = state.purchases.reduce((s, p) => s + toCents(purchaseAmount(p)), 0);
  const taxPaid = personalTax + taxRunTotal + withdrawTax;

  return {
    settings,
    sales,
    salesById,
    receipts,
    taxRuns,
    withdrawals,
    lots,
    flow,
    products: [...products.values()],
    customers: [...customers.values()].sort((a, b) => b.outstanding - a.outstanding),
    issues,
    totals: {
      purchaseTotal, revenue, cogs, grossProfit: revenue - cogs, receivable, receivableTax,
      personalIn, personalTax, companyIn, taxRunTotal, withdrawTax, withdrawNet,
      taxPaid, pendingTax,
      companyBalance: taxedBal + untaxedBal, taxedBal, untaxedBal, maxWithdrawNet,
      // 已到手 = 个人账户到账 + 已从公司提出的
      cashInHand: personalIn + withdrawNet,
      // 税后利润（估）= 毛利 − 已扣税 − 公司未税余额待扣的税 − 应收未回部分将来要扣的税
      netProfitEst: revenue - cogs - taxPaid - pendingTax - receivableTax,
    },
  };
}

// 模拟一次提现，不改状态
export function previewWithdrawal(state, netYuan, date) {
  const probe = { ...state, withdrawals: [...state.withdrawals, { id: '￿', date, net: netYuan }] };
  return compute(probe).withdrawals.get('￿');
}

// 模拟一次月度扣税
export function previewTaxRun(state, cutoff, date) {
  const probe = { ...state, taxRuns: [...state.taxRuns, { id: '￿', date, cutoff }] };
  return compute(probe).taxRuns.get('￿');
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

// 公司里有没有上个月及更早、还没扣税的回款——用来提醒"该扣税了"
export function overdueUntaxed(result, today) {
  const cutoff = monthEnd(prevMonth(today));
  const lots = result.lots.filter((l) => !l.taxed && l.remaining > 0 && l.date <= cutoff);
  return { cutoff, amount: lots.reduce((s, l) => s + l.remaining, 0), count: lots.length };
}
