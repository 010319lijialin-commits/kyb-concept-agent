// 账本核心：只存原始单据，所有余额 / 税 / 应收都由 compute() 按时间顺序重放算出来。
// 好处是删改任何一笔，后面的扣税、提现会自动重算，不会出现"账对不上"。
// 内部一律用「分」做整数运算，避免浮点误差。

export const ACCOUNT = { COMPANY: 'company', PERSONAL: 'personal' };

export const DEFAULT_SETTINGS = {
  vatRate: 0.13,
  // inclusive：回款是含税价，税 = 金额 / (1+税率) × 税率（13% 时约 11.5%）
  // flat：直接按金额 × 税率扣（"扣几个点"的口径）
  vatMode: 'inclusive',
};

export function emptyState() {
  return {
    version: 1,
    settings: { ...DEFAULT_SETTINGS },
    purchases: [],   // { id, date, supplier, product, qty, price, note }
    sales: [],       // { id, date, customer, product, qty, price, note }
    receipts: [],    // { id, date, customer, account, amount(到账), allocations:[{saleId, amount(核销)}], note }
    taxRuns: [],     // { id, date, cutoff, note }  月度扣税：扣掉 cutoff 当天及之前到公司的未税回款
    withdrawals: [], // { id, date, net(想拿到手的钱), note }
  };
}

export const toCents = (yuan) => Math.round((Number(yuan) || 0) * 100);
export const toYuan = (cents) => cents / 100;

// 1 元含税回款里要扣多少税
export function effectiveRate(settings) {
  const r = Number(settings.vatRate) || 0;
  return settings.vatMode === 'flat' ? r : r / (1 + r);
}

// 对 cents 金额算税（分，四舍五入）
export function taxOn(cents, settings) {
  return Math.round(cents * effectiveRate(settings));
}

// 回给个人账户：核销 gross 元的应收，实际到账多少
export function personalNet(grossYuan, settings) {
  const g = toCents(grossYuan);
  return toYuan(g - taxOn(g, settings));
}

// 个人账户到账 net 元，反推它核销了多少应收
export function personalGross(netYuan, settings) {
  const e = effectiveRate(settings);
  return toYuan(Math.round(toCents(netYuan) / (1 - e)));
}

export const saleAmount = (s) => toYuan(Math.round(toCents(s.price) * Number(s.qty || 0)));
export const purchaseAmount = (p) => toYuan(Math.round(toCents(p.price) * Number(p.qty || 0)));

// 某个下游的未回款销售，按日期先后排
export function openSalesFor(state, customer, excludeReceiptId) {
  const settled = settledBySale(state, excludeReceiptId);
  return state.sales
    .filter((s) => s.customer === customer)
    .map((s) => {
      const total = toCents(saleAmount(s));
      const done = settled.get(s.id) || 0;
      return { sale: s, total, settled: done, outstanding: total - done };
    })
    .filter((x) => x.outstanding > 0)
    .sort((a, b) => cmp(a.sale.date, b.sale.date) || cmp(a.sale.id, b.sale.id));
}

// 把 grossYuan 按先进先出分到未回款销售上，返回 [{saleId, amount}]
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

function settledBySale(state, excludeReceiptId) {
  const m = new Map();
  for (const r of state.receipts) {
    if (r.id === excludeReceiptId) continue;
    for (const a of r.allocations || []) m.set(a.saleId, (m.get(a.saleId) || 0) + toCents(a.amount));
  }
  return m;
}

const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

// 一笔回款核销的应收（含税口径）合计
export const receiptGross = (r) =>
  toYuan((r.allocations || []).reduce((s, a) => s + toCents(a.amount), 0));

// ---------- 公司账户：按"批次"记 ----------
// 每笔回到公司的钱是一个批次：{ remaining, taxed }。
// 月度扣税：把截止日前的未税批次扣税，标成已税。
// 提现：先花已税批次（不用再扣），不够再动未税批次（边提边扣税）。

function withdrawFromLots(lots, netCents, settings) {
  const e = effectiveRate(settings);
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
    const lotTax = taxOn(lot.remaining, settings);
    const lotNet = lot.remaining - lotTax;
    let g, t, n;
    if (lotNet <= need) {
      g = lot.remaining; t = lotTax; n = lotNet;
    } else {
      g = Math.min(lot.remaining, Math.round(need / (1 - e)));
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

// 公司账户最多能提到手多少
function maxNet(lots, settings) {
  let s = 0;
  for (const l of lots) {
    if (l.remaining <= 0) continue;
    s += l.taxed ? l.remaining : l.remaining - taxOn(l.remaining, settings);
  }
  return s;
}

function cloneLots(lots) {
  return lots.map((l) => ({ ...l }));
}

const TYPE_ORDER = { receipt: 0, taxRun: 1, withdrawal: 2 };

export function compute(state) {
  const settings = { ...DEFAULT_SETTINGS, ...(state.settings || {}) };
  const issues = [];

  // ---- 销售 & 应收 ----
  const settled = settledBySale(state);
  const sales = state.sales.map((s) => {
    const total = toCents(saleAmount(s));
    const done = settled.get(s.id) || 0;
    if (done > total) issues.push(`销售「${s.customer} ${s.product}」核销金额超过了销售额`);
    return { ...s, total, settled: done, outstanding: Math.max(0, total - done) };
  });
  const saleIds = new Set(state.sales.map((s) => s.id));
  for (const r of state.receipts)
    for (const a of r.allocations || [])
      if (!saleIds.has(a.saleId)) issues.push(`回款（${r.date} ${r.customer}）指向了已删除的销售`);

  // ---- 库存 & 成本（按品种加权平均进价） ----
  const products = new Map();
  const prod = (name) => {
    if (!products.has(name)) products.set(name, { name, inQty: 0, inCost: 0, outQty: 0, outRevenue: 0 });
    return products.get(name);
  };
  for (const p of state.purchases) {
    const x = prod(p.product);
    x.inQty += Number(p.qty) || 0;
    x.inCost += toCents(purchaseAmount(p));
  }
  for (const s of state.sales) {
    const x = prod(s.product);
    x.outQty += Number(s.qty) || 0;
    x.outRevenue += toCents(saleAmount(s));
  }
  let cogs = 0;
  for (const x of products.values()) {
    x.avgCost = x.inQty ? x.inCost / x.inQty : 0;
    x.stock = x.inQty - x.outQty;
    x.cogs = Math.round(x.avgCost * x.outQty);
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
  const flow = []; // 公司账户流水
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
      if (r.account === ACCOUNT.PERSONAL) {
        const tax = Math.max(0, gross - amount);
        personalIn += amount;
        personalTax += tax;
        receipts.set(r.id, { ...r, amountC: amount, grossC: gross, taxC: tax, unallocated: Math.max(0, amount - gross) });
      } else {
        lots.push({ receiptId: r.id, date: r.date, customer: r.customer, original: amount, remaining: amount, taxed: false, taxedBy: null });
        companyIn += amount;
        receipts.set(r.id, { ...r, amountC: amount, grossC: gross, taxC: 0, unallocated: Math.max(0, amount - gross) });
        flow.push({ date: r.date, kind: '回款', text: `${r.customer} 回款（未扣税）`, delta: amount, balance: balance(), ref: r.id });
      }
    } else if (ev.type === 'taxRun') {
      let total = 0, base = 0;
      const details = [];
      for (const lot of lots) {
        if (lot.taxed || lot.remaining <= 0 || lot.date > r.cutoff) continue;
        const t = taxOn(lot.remaining, settings);
        details.push({ receiptId: lot.receiptId, base: lot.remaining, tax: t });
        base += lot.remaining;
        total += t;
        lot.remaining -= t;
        lot.taxed = true;
        lot.taxedBy = r.id;
      }
      taxRunTotal += total;
      taxRuns.set(r.id, { ...r, base, tax: total, details });
      flow.push({ date: r.date, kind: '扣税', text: `月度扣增值税（${r.cutoff} 前的未税回款 ¥${fmt(base)}）`, delta: -total, balance: balance(), ref: r.id });
    } else if (ev.type === 'withdrawal') {
      const want = toCents(r.net);
      const res = withdrawFromLots(lots, want, settings);
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
  const pendingTax = lots.filter((l) => !l.taxed).reduce((s, l) => s + taxOn(l.remaining, settings), 0);

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
  const purchaseTotal = state.purchases.reduce((s, p) => s + toCents(purchaseAmount(p)), 0);
  const taxPaid = personalTax + taxRunTotal + withdrawTax;

  return {
    settings,
    sales,
    salesById: new Map(sales.map((s) => [s.id, s])),
    receipts,
    taxRuns,
    withdrawals,
    lots,
    flow,
    products: [...products.values()],
    customers: [...customers.values()].sort((a, b) => b.outstanding - a.outstanding),
    issues,
    totals: {
      purchaseTotal, revenue, cogs, grossProfit: revenue - cogs, receivable,
      personalIn, personalTax, companyIn, taxRunTotal, withdrawTax, withdrawNet,
      taxPaid, pendingTax,
      companyBalance: taxedBal + untaxedBal, taxedBal, untaxedBal,
      maxWithdrawNet: maxNet(lots, settings),
      // 已到手 = 个人账户到账 + 已从公司提出的
      cashInHand: personalIn + withdrawNet,
      // 税后利润（估）= 毛利 − 已扣税 − 公司里未税余额待扣的税 − 应收未回部分将来要扣的税
      netProfitEst: revenue - cogs - taxPaid - pendingTax - taxOn(receivable, settings),
    },
  };
}

// 模拟一次提现，不改状态
export function previewWithdrawal(state, netYuan, date) {
  const probe = { ...state, withdrawals: [...state.withdrawals, { id: '￿', date, net: netYuan }] };
  const res = compute(probe);
  return res.withdrawals.get('￿');
}

// 模拟一次月度扣税
export function previewTaxRun(state, cutoff, date) {
  const probe = { ...state, taxRuns: [...state.taxRuns, { id: '￿', date, cutoff }] };
  return compute(probe).taxRuns.get('￿');
}

// 截至某天公司账户里能提多少（按当天之前的流水）
export function maxWithdrawAt(state, date) {
  const cut = (arr) => arr.filter((x) => x.date <= date);
  const res = compute({ ...state, receipts: cut(state.receipts), taxRuns: cut(state.taxRuns), withdrawals: cut(state.withdrawals) });
  return res.totals.maxWithdrawNet;
}

export function fmt(cents) {
  const v = cents / 100;
  return v.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

export function monthEnd(ym) {
  const [y, m] = ym.split('-').map(Number);
  const d = new Date(Date.UTC(y, m, 0));
  return d.toISOString().slice(0, 10);
}

export function prevMonth(dateStr) {
  const [y, m] = dateStr.split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 2, 1));
  return d.toISOString().slice(0, 7);
}

// 公司里有没有上个月及更早、还没扣税的回款——用来提醒"该扣税了"
export function overdueUntaxed(result, today) {
  const cutoff = monthEnd(prevMonth(today));
  const lots = result.lots.filter((l) => !l.taxed && l.remaining > 0 && l.date <= cutoff);
  return { cutoff, amount: lots.reduce((s, l) => s + l.remaining, 0), count: lots.length };
}
