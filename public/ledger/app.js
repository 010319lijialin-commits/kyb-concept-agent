import {
  ACCOUNT, emptyState, compute, autoAllocate, autoAllocateNet, openSalesFor, saleRates,
  openPurchasesFor, autoAllocatePayment, paymentAllocated, previewPayment,
  saleTaxBreakdown, costBasis, taxFromTotals, openBatchesFor, fifoLots, normSettings, pct,
  previewWithdrawal, companyBalanceAt, receiptGross,
  saleAmount, purchaseAmount, toCents, toYuan, fmt, uid, prevMonth,
  seedLists, addToList, lastUsed, listPrice, setListPrice, removeListPrice,
} from './core.js';
import { createStore } from './store.js';

const $ = (sel, root = document) => root.querySelector(sel);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const today = () => {
  const d = new Date();
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
};
const y = (cents) => (cents < 0 ? '−¥' : '¥') + fmt(Math.abs(cents));
const yy = (yuan) => y(toCents(yuan));

// ---------- 存储 ----------
// 示例模式：第一次打开、账本还是空的时候先放一套示例数据给人点着看，示例里的操作一律不保存。
// mine 始终是用户自己的那本账；示例模式下 state 指向示例，mine 原样留着。
let syncStatus = 'local';
const store = createStore({
  onStatus: (s) => { syncStatus = s; paintSync(); },
  onRemote: (s) => { mine = hydrate(s); if (!demoMode) { state = mine; recompute(); } },
});
const hydrate = (s) => {
  const h = { ...emptyState(), ...s };
  if (!s?.lists) h.lists = seedLists(h); // 老账本：记过的名字直接进下拉单
  return h;
};
const hasData = (s) => Boolean(s && (s.purchases?.length || s.sales?.length || s.receipts?.length));

let mine = hydrate(store.local() || {});
let demoMode = !hasData(mine);
let state = demoMode ? demoState() : mine;
let R = compute(state);
let tab = 'home';
// 各页里的分段切换：进销（销售/进货/库存）、收付款（回款/付款）、账户（公司/个人）
const seg = { trade: 'sales', cash: 'in', acct: 'company' };

function recompute() { R = compute(state); render(); }

function save() {
  recompute();
  if (!demoMode) store.save(state);
}

function enterDemo() { demoMode = true; state = demoState(); tab = 'home'; recompute(); }
function exitDemo() {
  demoMode = false;
  state = mine;
  tab = 'home';
  recompute();
  window.scrollTo(0, 0);
  toast(hasData(mine) ? '已回到你自己的账' : '开始记账：先记一笔进货或销售');
}

store.connect().then((remote) => {
  if (remote) {
    mine = hydrate(remote);
    if (demoMode && hasData(mine)) demoMode = false;
    if (!demoMode) { state = mine; recompute(); }
  } else if (remote === null && hasData(mine)) {
    store.save(mine); // 云端还没有，把本机已有的账传上去
  }
});

const SYNC_TEXT = {
  local: ['仅存在本机', 'muted'],
  'local-failed': ['本机保存失败，请导出备份', 'bad'],
  saving: ['保存中…', 'muted'],
  saved: ['已存到你的账号', 'ok'],
  error: ['云端保存失败，已留在本机', 'bad'],
  full: ['云端空间已满，请导出备份', 'bad'],
};
function syncPill() {
  if (demoMode) return '<span class="sync muted">示例，不保存</span>';
  const [t, c] = SYNC_TEXT[syncStatus] || SYNC_TEXT.local;
  return `<span class="sync ${c}">${t}</span>`;
}
function paintSync() { document.querySelectorAll('[data-sync]').forEach((el) => (el.innerHTML = syncPill())); }

function demoBanner() {
  if (!demoMode) return '';
  return `<div class="demo-bar"><div><b>这是示例数据</b><span>随便点、随便改，都不会保存。</span></div>
    <button class="btn sm primary" data-act="exit-demo">${hasData(mine) ? '回到我的账' : '开始记自己的账'}</button></div>`;
}

// ---------- 通用 ----------
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => (t.hidden = true), 2200);
}

// 页面内的确认框（claude.ai 里打开时浏览器自带的 confirm() 不弹）
function ask(message, okLabel = '确定', danger = false) {
  return new Promise((resolve) => {
    const box = $('#ask');
    box.innerHTML = `<div class="ask-mask"></div><div class="ask-body" role="alertdialog" aria-modal="true">
      <p>${esc(message)}</p>
      <div class="two"><button class="btn" data-ans="0">取消</button><button class="btn ${danger ? 'danger-solid' : 'primary'}" data-ans="1">${esc(okLabel)}</button></div></div>`;
    box.hidden = false;
    const done = (v) => { box.hidden = true; box.innerHTML = ''; resolve(v); };
    box.querySelector('[data-ans="1"]').focus();
    box.onclick = (e) => {
      const b = e.target.closest('[data-ans]');
      if (b) done(b.dataset.ans === '1');
      else if (e.target.classList.contains('ask-mask')) done(false);
    };
  });
}

const ICON = {
  home: '<path d="M3 20h18"/><path d="M6 16v-5M11 16V6M16 16v-8"/>',
  trade: '<path d="M3.5 7.5 12 3l8.5 4.5v9L12 21l-8.5-4.5z"/><path d="m3.5 7.5 8.5 4.5 8.5-4.5M12 12v9"/>',
  receipt: '<rect x="2.5" y="6" width="19" height="12" rx="2"/><circle cx="12" cy="12" r="2.6"/><path d="M6 9.5v5M18 9.5v5"/>',
  company: '<path d="M4 21V4.5L12 2v19M12 8h7.5v13M2 21h20"/><path d="M7 7.5h2M7 11.5h2M7 15.5h2M15 12h2M15 16h2"/>',
  settings: '<path d="M4 6h9M17 6h3M4 12h3M11 12h9M4 18h11M19 18h1"/><circle cx="15" cy="6" r="2"/><circle cx="9" cy="12" r="2"/><circle cx="17" cy="18" r="2"/>',
  in: '<path d="M12 3v11M7.5 9.5 12 14l4.5-4.5"/><path d="M4 15v4.5h16V15"/>',
  out: '<path d="M12 14V3M7.5 7.5 12 3l4.5 4.5"/><path d="M4 15v4.5h16V15"/>',
  cash: '<rect x="2.5" y="6" width="19" height="12" rx="2"/><circle cx="12" cy="12" r="2.6"/>',
  withdraw: '<rect x="3" y="3.5" width="18" height="10" rx="2"/><path d="M12 8v12.5M8 16.5l4 4 4-4"/>',
  chev: '<path d="m6 9 6 6 6-6"/>',
  pay: '<rect x="2.5" y="6" width="13" height="12" rx="2"/><circle cx="9" cy="12" r="2.4"/><path d="M15.5 12h6M18.5 9l3 3-3 3"/>',
};
const icon = (k) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICON[k]}</svg>`;

function openSheet(title, html, onMount) {
  $('#sheet-title').textContent = title;
  // 每次换一个新容器：表单都往 root 上挂 input 监听，复用旧节点会把上一个表单的监听也带过来
  const root = document.createElement('div');
  root.id = 'sheet-content';
  root.innerHTML = html;
  $('#sheet-content').replaceWith(root);
  $('#sheet').hidden = false;
  document.body.style.overflow = 'hidden';
  onMount?.(root);
}
function closeSheet() {
  $('#sheet').hidden = true;
  document.body.style.overflow = '';
}
document.addEventListener('click', (e) => { if (e.target.closest('[data-close]')) closeSheet(); });

const names = (arr, k) => [...new Set(arr.map((x) => x[k]).filter(Boolean))];

function groupByDate(items) {
  const out = [];
  let cur = null;
  for (const it of items) {
    if (it.date !== cur) { out.push(`<li class="day">${esc(it.date)}</li>`); cur = it.date; }
    out.push(it.html);
  }
  return out.join('');
}
const byDateDesc = (a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : a.id < b.id ? 1 : -1);

function salePill(s) {
  if (s.outstanding <= 0) return '<span class="pill done">已回清</span>';
  if (s.settled > 0) return `<span class="pill part">还欠 ${y(s.outstanding)}</span>`;
  return '<span class="pill open">未回款</span>';
}
// 列表里一句话说清这笔钱分到了哪几批：「9-02 甲 回清 · 9-04 甲 回一部分 ¥200」
function batchSummary(allocs, byId, key, words) {
  const parts = (allocs || []).map((a) => {
    const b = byId.get(a[key]);
    if (!b) return '已删除的一批';
    const c = toCents(a.amount);
    return `${b.date.slice(5)} ${esc(b.product)} ${c >= b.total ? words.full : `${words.part} ${y(c)}`}`;
  });
  if (!parts.length) return '没分到货上';
  return parts.length > 3 ? `${parts.slice(0, 3).join(' · ')} 等 ${parts.length} 批` : parts.join(' · ');
}

// 某一批货被哪几笔钱回过 / 付过（销售、进货的编辑页里看）
function batchHistory(list, key, id, label) {
  const hits = list.filter((x) => (x.allocations || []).some((a) => a[key] === id));
  if (!hits.length) return '';
  return `<div class="hist"><div class="lbl">${label}</div>${hits.sort((a, b) => (a.date < b.date ? -1 : 1)).map((x) => {
    const a = x.allocations.find((z) => z[key] === id);
    return `<div class="ln"><span>${esc(x.date)} ${acctPill(x.account)}${x.allocations.length > 1 ? ` <span class="muted small">（这笔一共 ${yy(x.amount)}，分了 ${x.allocations.length} 批）</span>` : ''}</span><span class="num">${yy(a.amount)}</span></div>`;
  }).join('')}</div>`;
}

function purchasePill(p) {
  if (p.outstanding <= 0) return '<span class="pill done">已付清</span>';
  if (p.paid > 0) return `<span class="pill part">还欠 ${y(p.outstanding)}</span>`;
  return '<span class="pill open">未付款</span>';
}
const acctPill = (a) => (a === ACCOUNT.PERSONAL ? '<span class="pill personal">个人</span>' : '<span class="pill company">公司</span>');

// ---------- 渲染 ----------
function render() {
  for (const t of ['home', 'trade', 'receipt', 'company', 'settings']) $(`#page-${t}`).hidden = t !== tab;
  document.querySelectorAll('.tabbar button').forEach((b) => b.classList.toggle('on', b.dataset.tab === tab));
  ({ home: renderHome, trade: renderTrade, receipt: renderCash, company: renderAccounts, settings: renderSettings })[tab]();
}

document.querySelector('.tabbar').innerHTML = [['home', '总览'], ['trade', '进销'], ['receipt', '收付款'], ['company', '账户'], ['settings', '设置']]
  .map(([k, l]) => `<button data-tab="${k}">${icon(k)}<span>${l}</span></button>`).join('');
document.querySelector('.tabbar').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-tab]');
  if (!b) return;
  tab = b.dataset.tab;
  render();
  window.scrollTo(0, 0);
});

function reminders() {
  const out = [];
  for (const i of R.issues) out.push(`<div class="alert bad"><span>${esc(i)}</span></div>`);
  return demoBanner() + out.join('');
}

const segCtl = (group, opts) => `<div class="seg">${opts.map(([k, l]) =>
  `<button data-group="${group}" data-seg="${k}" class="${seg[group] === k ? 'on' : ''}">${l}</button>`).join('')}</div>`;

function renderHome() {
  const T = R.totals;
  const owing = R.customers.filter((c) => c.outstanding > 0);
  const oweUp = R.suppliers.filter((c) => c.outstanding > 0);

  $('#page-home').innerHTML = `
    <header class="hdr"><div><h1>进销账</h1><p class="sub">上游进货 → 卖给下游 → 回款 → 扣税提现</p></div><span data-sync>${syncPill()}</span></header>
    ${reminders()}
    <div class="card hero">
      <div class="hero-top">
        <div><div class="k">你在公司账户的钱（已扣税，可以全提）</div><div class="v num">${y(T.companyBalance)}</div></div>
        <button class="btn sm hero-btn" data-act="withdraw">${icon('withdraw')}提现</button>
      </div>
      <div class="split num">
        <span>到账 ${y(T.companyIn)}</span>
        <span>扣税 ${y(T.companyTax)}</span>
        <span>付上游 ${y(T.companyPaid)}</span>
        <span>已提 ${y(T.withdrawn)}</span>
      </div>
    </div>
    <div class="quick">
      <button class="btn" data-act="purchase">${icon('in')}记进货</button>
      <button class="btn" data-act="sale">${icon('out')}记销售</button>
      <button class="btn" data-act="receipt">${icon('cash')}记回款</button>
      <button class="btn" data-act="payment">${icon('pay')}付上游</button>
    </div>
    <div class="grid">
      <div class="stat tap" data-goto="receipt" data-goseg="cash:in"><div class="k">下游还欠我</div><div class="v num">${y(T.receivable)}</div><div class="d">${owing.length} 家没回清</div></div>
      <div class="stat tap" data-goto="receipt" data-goseg="cash:out"><div class="k">我还欠上游</div><div class="v num">${y(T.payable)}</div><div class="d">已付 ${y(T.paidTotal)} / 进货 ${y(T.purchaseTotal)}</div></div>
      <div class="stat tap" data-goto="company" data-goseg="acct:personal"><div class="k">个人账户</div><div class="v num">${y(T.personalBalance)}</div><div class="d">进 ${y(T.personalIn + T.withdrawn)} · 付上游 ${y(T.personalPaid)}</div></div>
      <div class="stat"><div class="k">已扣税</div><div class="v num">${y(T.taxPaid)}</div><div class="d">回个人 ${y(T.personalTax)} · 回公司 ${y(T.companyTax)}</div></div>
      <div class="stat"><div class="k">毛利</div><div class="v num">${y(T.grossProfit)}</div><div class="d">销售 ${y(T.revenue)} − 进价 ${y(T.cogs)}</div></div>
      <div class="stat"><div class="k">税后利润（估）</div><div class="v num">${y(T.netProfitEst)}</div><div class="d">毛利减掉已扣的税和没回款部分将扣的税</div></div>
    </div>
    <div class="card">
      <h3>谁还欠我钱</h3>
      ${owing.length ? `<ul class="list">${owing.slice(0, 5).map((c) => `
        <li class="item" data-act="receipt" data-customer="${esc(c.name)}">
          <div class="l"><div class="t">${esc(c.name)}</div><div class="s">最早一笔 ${esc(c.oldest)} 起没回 · 共卖 ${y(c.total)}</div></div>
          <div class="r"><div class="amt num">${y(c.outstanding)}</div><div class="s">记回款</div></div>
        </li>`).join('')}</ul>` : '<div class="empty">没有欠款</div>'}
    </div>
    <div class="card">
      <h3>我还欠谁钱</h3>
      ${oweUp.length ? `<ul class="list">${oweUp.slice(0, 5).map((c) => `
        <li class="item" data-act="payment" data-supplier="${esc(c.name)}">
          <div class="l"><div class="t">${esc(c.name)}</div><div class="s">最早一笔 ${esc(c.oldest)} 起没付 · 共进 ${y(c.total)}</div></div>
          <div class="r"><div class="amt num">${y(c.outstanding)}</div><div class="s">记付款</div></div>
        </li>`).join('')}</ul>` : '<div class="empty">上游货款都付清了</div>'}
    </div>
    ${state.sales.length || state.purchases.length ? '' : `
    <div class="card explain">
      <p><b>从哪开始：</b>先记一笔进货（从上游进了什么、多少钱），再记卖给下游的销售。下游打钱来时记回款，你打钱给上游时记付款。</p>
    </div>`}
  `;
}

function renderTrade() {
  const segHtml = `<div class="seg">
    ${[['sales', '销售'], ['purchases', '进货'], ['prices', '价目表'], ['stock', '库存']].map(([k, l]) => `<button data-group="trade" data-seg="${k}" class="${seg.trade === k ? 'on' : ''}">${l}</button>`).join('')}
  </div>`;
  let body = '';
  if (seg.trade === 'sales') {
    const items = [...R.sales].sort(byDateDesc).map((s) => ({
      date: s.date, html: `
      <li class="item" data-edit="sale" data-id="${s.id}">
        <div class="l"><div class="t">${esc(s.customer)}</div><div class="s">${esc(s.product)}${s.supplier ? `（${esc(s.supplier)}）` : ''} ${s.qty} × ${yy(s.price)}${s.lots?.length > 1 ? ` · 从 ${s.lots.length} 批出货` : ''} · 回清要扣税 ${y(s.taxFull)}${s.note ? ' · ' + esc(s.note) : ''}</div></div>
        <div class="r"><div class="amt num">${y(s.total)}</div>${salePill(s)}</div>
      </li>` }));
    body = `<div class="card"><ul class="list">${items.length ? groupByDate(items) : '<li class="empty">还没有销售记录</li>'}</ul></div>`;
  } else if (seg.trade === 'purchases') {
    const items = [...R.purchases].sort(byDateDesc).map((p) => ({
      date: p.date, html: `
      <li class="item" data-edit="purchase" data-id="${p.id}">
        <div class="l"><div class="t">${esc(p.supplier)}</div><div class="s">${esc(p.product)} ${p.qty} × ${yy(p.price)} · ${p.remaining > 1e-9 ? (p.sold ? `已卖 ${+p.sold.toFixed(3)}，剩 ${+p.remaining.toFixed(3)} 件` : '还没卖') : '已卖完'}${p.note ? ' · ' + esc(p.note) : ''}</div></div>
        <div class="r"><div class="amt num">${y(p.total)}</div>${purchasePill(p)}</div>
      </li>` }));
    body = `<div class="card"><ul class="list">${items.length ? groupByDate(items) : '<li class="empty">还没有进货记录</li>'}</ul></div>`;
  } else if (seg.trade === 'prices') {
    body = renderPrices();
  } else {
    body = `<div class="card"><h3>按厂家和品种 <span class="muted">进价按加权平均</span></h3>
      ${R.products.length ? `<div class="tbl-wrap"><table class="tbl num">
        <tr><th>品种</th><th class="r">进</th><th class="r">出</th><th class="r">库存</th><th class="r">均价</th><th class="r">毛利</th></tr>
        ${R.products.map((p) => `<tr>
          <td>${esc(p.name)}</td><td class="r">${p.inQty}</td><td class="r">${p.outQty}</td>
          <td class="r" style="${p.stock < 0 ? 'color:var(--danger)' : ''}">${p.stock}</td>
          <td class="r">${(p.avgCost / 100).toFixed(2)}</td><td class="r">${fmt(p.profit)}</td></tr>`).join('')}
      </table></div>` : '<div class="empty">还没有数据</div>'}
    </div>`;
  }
  $('#page-trade').innerHTML = `
    <header class="hdr"><div><h1>进销</h1><p class="sub">${seg.trade === 'prices' ? '每个厂家的每个药一个售价，记销售时自动带出' : '从上游进、卖给下游，每笔销售就是一笔应收'}</p></div>
      ${seg.trade === 'prices'
        ? '<button class="btn sm primary" data-act="price">+ 定个售价</button>'
        : '<div class="btn-row"><button class="btn sm" data-act="purchase">+ 进货</button><button class="btn sm primary" data-act="sale">+ 销售</button></div>'}</header>
    ${demoBanner()}${segHtml}${body}`;
}

// 每件的差价和扣税：按元精确算，不先四舍五入到分（单价很小时取整会差出好几成）
function perUnit(price, cost) {
  const margin = Math.max(0, price - cost);
  const tax = price * R.settings.revenueRate + margin * R.settings.marginRate;
  return { margin, tax, net: margin - tax };
}
const yu = (yuan) => `¥${+yuan.toFixed(3)}`;

// 价目表：价目表里的 + 进过货但还没定售价的，按厂家分组
function priceRows() {
  const rows = new Map();
  const key = (sup, prod) => `${sup}\u0001${prod}`;
  for (const p of state.prices || []) rows.set(key(p.supplier, p.product), { supplier: p.supplier, product: p.product, price: p.price });
  for (const p of state.purchases) if (!rows.has(key(p.supplier, p.product))) rows.set(key(p.supplier, p.product), { supplier: p.supplier, product: p.product, price: null });
  return [...rows.values()].map((r) => {
    const st = R.products.find((x) => x.supplier === r.supplier && x.product === r.product);
    const next = st?.nextBatch || null; // 下一笔先进先出会出的那批
    const cost = next ? next.unit / 100 : null;
    const per = r.price != null && cost != null ? perUnit(r.price, cost) : null;
    return { ...r, cost, next, per, stock: st?.stock ?? 0 };
  }).sort((a, b) => (a.supplier < b.supplier ? -1 : a.supplier > b.supplier ? 1 : a.product < b.product ? -1 : 1));
}

function renderPrices() {
  const rows = priceRows();
  if (!rows.length) return '<div class="card"><div class="empty">还没有。点「定个售价」，或者记销售时顺手记进来。</div></div>';
  let cur = null;
  const out = [];
  for (const r of rows) {
    if (r.supplier !== cur) { out.push(`<li class="day">${esc(r.supplier)}</li>`); cur = r.supplier; }
    out.push(`<li class="item" data-edit="price" data-sup="${esc(r.supplier)}" data-prod="${esc(r.product)}">
      <div class="l"><div class="t">${esc(r.product)}</div><div class="s">${r.next ? `下一批出 ${r.next.date.slice(5)} 进的（进价 ¥${r.cost}，剩 ${+r.next.remaining.toFixed(3)} 件）` : '没有库存'}${r.per ? ` · 每件差价 ${yu(r.per.margin)} · 每件扣税 ${yu(r.per.tax)}` : ''} · 共 ${+r.stock.toFixed(3)} 件</div></div>
      <div class="r">${r.price != null ? `<div class="amt num">¥${r.price}</div><div class="s">售价</div>` : '<span class="pill part">还没定售价</span>'}</div>
    </li>`);
  }
  return `<div class="card"><ul class="list">${out.join('')}</ul></div>`;
}

function priceForm(supplier = '', product = '') {
  const cur = supplier && product ? listPrice(state, supplier, product) : null;
  const editing = cur != null;
  openSheet(editing ? '改售价' : '定个售价', `
    <p class="small muted" style="margin-top:0">同一个厂家的同一个药，卖给谁都是这个价。改了只影响以后的销售，已经记的不变。</p>
    <div class="f"><label for="f-maker">上游厂家</label>${pickerField('f-maker', 'suppliers', supplier, { placeholder: '选一个，或打个新名字' })}</div>
    <div class="f"><label for="f-product">品种</label>${pickerField('f-product', 'products', product, { placeholder: '选一个，或打个新名字' })}</div>
    <div class="f"><label>售价（元/件）</label><input class="inp" type="number" inputmode="decimal" step="0.01" id="f-price" value="${cur ?? ''}"></div>
    <div class="calc" id="f-calc"></div>
    <button class="btn primary block" id="f-save">保存</button>
    ${editing ? '<button class="btn danger block" id="f-del" type="button" style="margin-top:8px">从价目表删掉</button>' : ''}`, (root) => {
    const maker = () => $('#f-maker', root).value.trim();
    const prod = () => $('#f-product', root).value.trim();
    wirePickers(root, { maker });
    const calc = () => {
      const price = num(root, '#f-price');
      const st = R.products.find((x) => x.supplier === maker() && x.product === prod());
      let html = '';
      if (st?.nextBatch) {
        const cost = st.nextBatch.unit / 100;
        html += `<div class="ln"><span>下一批出 ${st.nextBatch.date.slice(5)} 进的，进价</span><span class="num">¥${cost}</span></div>`;
        if (price > 0) {
          const b = perUnit(price, cost);
          html += `<div class="ln"><span>每件差价</span><span class="num">${yu(b.margin)}</span></div>
            <div class="ln"><span>每件扣税</span><span class="num">${yu(b.tax)}</span></div>
            <div class="ln total"><span>每件税后赚</span><span class="num">${yu(b.net)}</span></div>`;
        }
      } else if (maker() && prod()) html = `<div class="ln"><span>${st ? '现在没有库存' : `还没进过 ${esc(maker())} 的${esc(prod())}`}</span></div>`;
      const other = maker() && prod() && !(maker() === supplier && prod() === product) ? listPrice(state, maker(), prod()) : null;
      if (other != null) html += `<div class="ln warn"><span>价目表里已经有了：¥${other}，保存会改成新的价</span></div>`;
      $('#f-calc', root).innerHTML = html;
      $('#f-calc', root).hidden = !html;
    };
    root.addEventListener('input', calc); calc();
    $('#f-save', root).onclick = () => {
      const price = num(root, '#f-price');
      if (!maker() || !prod() || !(price >= 0)) return toast('厂家、品种、售价都要填');
      const added = commitPickers(root);
      if (editing && (maker() !== supplier || prod() !== product)) removeListPrice(state, supplier, product);
      setListPrice(state, maker(), prod(), price);
      save(); closeSheet(); toast(`已记：${maker()} 的${prod()}卖 ¥${price}` + addedNote(added));
    };
    if (editing) $('#f-del', root).onclick = async () => {
      if (!(await ask(`从价目表删掉 ${supplier} 的${product}？已经记的销售不受影响。`, '删掉', true))) return;
      removeListPrice(state, supplier, product); save(); closeSheet(); toast('已从价目表删掉');
    };
  });
}

function renderCash() {
  const isIn = seg.cash === 'in';
  let body;
  if (isIn) {
    const owing = R.customers.filter((c) => c.outstanding > 0);
    const items = [...state.receipts].sort(byDateDesc).map((r0) => {
      const r = R.receipts.get(r0.id);
      const sub = r0.account === ACCOUNT.PERSONAL
        ? `核销 ${y(r.grossC)} · 扣税 ${y(r.taxC)}`
        : `扣税 ${y(r.taxC)} · 算你的 ${y(r.mineC)}${r.unallocated ? ` · <span style="color:var(--warn)">${y(r.unallocated)} 没对上销售</span>` : ''}`;
      return { date: r0.date, html: `
        <li class="item" data-edit="receipt" data-id="${r0.id}">
          <div class="l"><div class="t">${esc(r0.customer)} ${acctPill(r0.account)}</div><div class="s">${batchSummary(r0.allocations, R.salesById, 'saleId', RECEIPT_WORDS)}</div><div class="s">${sub}${r0.note ? ' · ' + esc(r0.note) : ''}</div></div>
          <div class="r"><div class="amt num in">+${fmt(r.amountC)}</div><div class="s">到账</div></div>
        </li>` };
    });
    body = `
      <div class="card">
        <h3>下游还欠我 <span class="muted">共 ${y(R.totals.receivable)}</span></h3>
        ${owing.length ? `<ul class="list">${owing.map((c) => `
          <li class="item" data-act="receipt" data-customer="${esc(c.name)}">
            <div class="l"><div class="t">${esc(c.name)}</div><div class="s">已回 ${y(c.settled)} / 共 ${y(c.total)} · 最早 ${esc(c.oldest)}</div></div>
            <div class="r"><div class="amt num">${y(c.outstanding)}</div></div>
          </li>`).join('')}</ul>` : '<div class="empty">都回清了</div>'}
      </div>
      <div class="card"><h3>回款记录</h3><ul class="list">${items.length ? groupByDate(items) : '<li class="empty">还没有回款记录</li>'}</ul></div>`;
  } else {
    const oweUp = R.suppliers.filter((c) => c.outstanding > 0);
    const items = [...(state.payments || [])].sort(byDateDesc).map((p0) => {
      const p = R.payments.get(p0.id);
      const extra = p.amountC > p.allocatedC ? `<div class="s" style="color:var(--warn)">${y(p.amountC - p.allocatedC)} 没分到货上</div>` : '';
      return { date: p0.date, html: `
        <li class="item" data-edit="payment" data-id="${p0.id}">
          <div class="l"><div class="t">${esc(p0.supplier)} ${acctPill(p0.account)}</div><div class="s">${batchSummary(p0.allocations, R.purchasesById, 'purchaseId', PAYMENT_WORDS)}${p0.note ? ' · ' + esc(p0.note) : ''}</div>${extra}</div>
          <div class="r"><div class="amt num">−${fmt(p.amountC)}</div><div class="s">打出</div></div>
        </li>` };
    });
    body = `
      <div class="card">
        <h3>我还欠上游 <span class="muted">共 ${y(R.totals.payable)}</span></h3>
        ${oweUp.length ? `<ul class="list">${oweUp.map((c) => `
          <li class="item" data-act="payment" data-supplier="${esc(c.name)}">
            <div class="l"><div class="t">${esc(c.name)}</div><div class="s">已付 ${y(c.paid)} / 共 ${y(c.total)} · 最早 ${esc(c.oldest)}</div></div>
            <div class="r"><div class="amt num">${y(c.outstanding)}</div></div>
          </li>`).join('')}</ul>` : '<div class="empty">都付清了</div>'}
      </div>
      <div class="card"><h3>付款记录</h3><ul class="list">${items.length ? groupByDate(items) : '<li class="empty">还没有付款记录</li>'}</ul></div>`;
  }
  $('#page-receipt').innerHTML = `
    <header class="hdr"><div><h1>收付款</h1><p class="sub">${isIn ? '下游打给我的钱，一笔可以核销多笔销售' : '我打给上游的钱，一笔可以付多笔进货'}</p></div>
      <button class="btn sm primary" data-act="${isIn ? 'receipt' : 'payment'}">+ ${isIn ? '回款' : '付款'}</button></header>
    ${demoBanner()}
    ${segCtl('cash', [['in', `回款 · 收 ${fmt(R.totals.personalIn + R.totals.companyIn)}`], ['out', `付款 · 付 ${fmt(R.totals.paidTotal)}`]])}
    ${body}`;
}

function flowList(flow) {
  return flow.length ? `<ul class="list">${[...flow].reverse().map((f) => `
    <li class="item" data-edit="${f.edit}" data-id="${f.ref}">
      <div class="l"><div class="t">${f.kind}</div><div class="s">${esc(f.date)} · ${esc(f.text)}</div></div>
      <div class="r"><div class="amt num ${f.delta >= 0 ? 'in' : ''}">${f.delta >= 0 ? '+' : '−'}${fmt(Math.abs(f.delta))}</div><div class="s num">余 ${fmt(f.balance)}</div></div>
    </li>`).join('')}</ul>` : '<div class="empty">暂无流水</div>';
}

function renderAccounts() {
  const T = R.totals;
  const segHtml = segCtl('acct', [['company', `公司账户 ${fmt(T.companyBalance)}`], ['personal', `个人账户 ${fmt(T.personalBalance)}`]]);
  let body;
  if (seg.acct === 'company') {
    body = `
    <div class="card">
      <div class="muted small">你在公司账户的钱（已按规则扣完税）</div>
      <div class="num" style="font-size:28px;font-weight:700">${y(T.companyBalance)}</div>
      <div class="calc" style="margin:12px 0 10px">
        <div class="ln"><span>下游回到公司</span><span class="num">+${fmt(T.companyIn)}</span></div>
        <div class="ln"><span>按规则扣税</span><span class="num">−${fmt(T.companyTax)}</span></div>
        <div class="ln"><span>从公司付给上游</span><span class="num">−${fmt(T.companyPaid)}</span></div>
        <div class="ln"><span>提到个人账户</span><span class="num">−${fmt(T.withdrawn)}</span></div>
        <div class="ln total"><span>可以提出来</span><span class="num">${y(Math.max(0, T.companyBalance))}</span></div>
      </div>
      <button class="btn primary block" data-act="withdraw">${icon('withdraw')}提现到个人账户</button>
    </div>
    <div class="card"><h3>公司账户流水</h3>${flowList(R.flow)}</div>`;
  } else {
    body = `
    <div class="card">
      <div class="muted small">个人账户（这本账里经手的钱）</div>
      <div class="num" style="font-size:28px;font-weight:700">${y(T.personalBalance)}</div>
      <div class="calc" style="margin:12px 0 0">
        <div class="ln"><span>下游直接回到个人（已扣税）</span><span class="num">+${fmt(T.personalIn)}</span></div>
        <div class="ln"><span>从公司提出来</span><span class="num">+${fmt(T.withdrawn)}</span></div>
        <div class="ln"><span>从个人付给上游</span><span class="num">−${fmt(T.personalPaid)}</span></div>
        <div class="ln total"><span>结余</span><span class="num">${y(T.personalBalance)}</span></div>
      </div>
      ${T.personalBalance < 0 ? '<p class="small muted" style="margin:8px 0 0">是负数说明付上游时先从自己口袋垫了钱，回款到了就补回来。</p>' : ''}
    </div>
    <div class="card"><h3>个人账户流水</h3>${flowList(R.personalFlow)}</div>`;
  }
  $('#page-company').innerHTML = `
    <header class="hdr"><div><h1>账户</h1><p class="sub">${seg.acct === 'company' ? '回到公司的钱按规则扣完税算你的，公司什么时候交税不用管' : '回到个人的钱已经扣过税，提现进来的也是到手的钱'}</p></div></header>
    ${reminders()}${segHtml}${body}`;
}

function renderSettings() {
  const s = R.settings;
  $('#page-settings').innerHTML = `
    <header class="hdr"><div><h1>设置</h1><p class="sub">税率、备份</p></div><span data-sync>${syncPill()}</span></header>
    ${demoBanner()}
    <div class="card">
      <h3>扣税怎么算</h3>
      <p class="small muted" style="margin-top:0">税 = 回款额 × 回款税点 + 差价（售价 − 进价）× 差价税率</p>
      <div class="two">
        <div class="f"><label>回款税点（%）</label><input class="inp" type="number" inputmode="decimal" step="0.01" id="set-rev" value="${+(s.revenueRate * 100).toFixed(4)}"></div>
        <div class="f"><label>差价税率（%）</label><input class="inp" type="number" inputmode="decimal" step="0.01" id="set-mar" value="${+(s.marginRate * 100).toFixed(4)}"></div>
      </div>
      <div class="calc" id="set-eg"></div>
      <p class="small muted" style="margin:0">改了税率，以前所有回款的扣税都会按新税率重算。如果中途税率变过，先导出备份再改。</p>
    </div>
    <div class="card">
      <h3>下拉单</h3>
      <p class="small muted" style="margin-top:0">记账时打的新名字，勾上「加入下拉单」就会出现在这里，下次直接选。也可以在这里手动加、删；删掉不影响已经记的账。</p>
      ${['products', 'customers', 'suppliers'].map((k) => {
        const list = state.lists?.[k] || [];
        return `<div class="lst">
          <div class="lbl">${LIST_LABEL[k]} <span class="muted small">${list.length} 个</span></div>
          <div class="tags">${list.length ? list.map((n) => `<span class="tag">${esc(n)}<button type="button" data-del-name="${k}" data-name="${esc(n)}" aria-label="从下拉单删掉 ${esc(n)}">×</button></span>`).join('') : '<span class="muted small">还没有</span>'}</div>
          <div class="tag-add"><input class="inp sm" id="add-${k}" placeholder="新加一个${LIST_LABEL[k]}"><button type="button" class="btn sm" data-add-name="${k}">加入</button></div>
        </div>`;
      }).join('')}
    </div>
    <div class="card">
      <h3>备份</h3>
      <p class="small muted" style="margin-top:0">${store.cloud
        ? '账存在你 claude.ai 账号下的私有空间，只有你自己看得到；换手机、换电脑登录同一个账号也在。导出一份留底更安心。'
        : '数据只存在这台手机 / 电脑的浏览器里。清缓存或换设备前一定先导出。'}</p>
      <div class="btn-row"><button class="btn" id="exp">导出 JSON</button><button class="btn" id="exp-csv">导出销售明细 CSV</button><label class="btn">导入 JSON<input type="file" accept="application/json" id="imp" hidden></label></div>
    </div>
    <div class="card">
      <h3>示例 / 清空</h3>
      <div class="btn-row">${demoMode ? '' : '<button class="btn" id="demo">看示例数据</button>'}<button class="btn danger" id="wipe">清空我的账</button></div>
      <p class="small muted" style="margin-bottom:0">看示例不会动你自己的账，看完点「回到我的账」。</p>
    </div>
    <div class="card explain">
      <h3 style="color:var(--text)">这本账是怎么记的</h3>
      <p><b>销售 = 应收。</b>每卖一笔，就多一笔下游欠你的钱。</p>
      <p><b>回款 = 核销应收。</b>下游一次打款可以核销好几笔销售（合并回款），默认按最早的先核销，也可以手动分。</p>
      <p><b>价目表：</b>每个厂家的每个药一个售价，卖给谁都一样。记销售时选好厂家和药，售价自动带出。</p>
      <p><b>扣多少税跟着差价走：</b>同样的药每批进价不同，记销售时选从哪几批出货（默认先进先出），差价 = 销售额 − 各批进价 × 各批件数。进价 1、卖 1.5、200 件，全部回款要扣 300×1% + 100×13% = 16。之后再进价格不同的货，不影响已经卖掉的。</p>
      <p><b>回个人账户：</b>到账就是扣完税的钱。上面那笔回到个人，到账 284，系统反推核销了 300 应收、扣税 16。</p>
      <p><b>回公司账户：</b>到账多少记多少，按同样的规则扣掉税，剩下的就是你在公司的钱。上面那笔回到公司，到账 300，算你的 284。公司什么时候交税不影响这个数。</p>
      <p><b>付上游 = 核销应付。</b>每笔进货就是欠上游的钱；打钱给上游时记一笔付款，可以一次付好几笔进货，从个人账户或公司账户打出都行。从公司付，就从你在公司的钱里扣。</p>
      <p><b>从公司提现：</b>你在公司的钱已经扣过税，提多少到手多少，最多提完为止。</p>
      <p><b>删改任何一笔都安全：</b>余额、扣税都是按时间顺序重新算出来的。</p>
    </div>`;

  const example = () => {
    const S = normSettings({ revenueRate: parseFloat($('#set-rev').value) / 100, marginRate: parseFloat($('#set-mar').value) / 100 });
    const b = saleTaxBreakdown({ qty: 200, price: 1.5 }, 1, S);
    $('#set-eg').innerHTML = `
      <div class="ln"><span>例：进价 1、售价 1.5、200 件，回款 ¥300</span></div>
      <div class="ln"><span>回款额 300 × ${pct(S.revenueRate)}</span><span class="num">${y(b.revenueTax)}</span></div>
      <div class="ln"><span>差价 0.5 × 200 × ${pct(S.marginRate)}</span><span class="num">${y(b.marginTax)}</span></div>
      <div class="ln total"><span>扣税合计，到手 ${y(b.total - b.tax)}</span><span class="num">${y(b.tax)}</span></div>`;
  };
  example();
  $('#set-rev').oninput = $('#set-mar').oninput = example;
  $('#set-rev').onchange = $('#set-mar').onchange = () => {
    const rev = parseFloat($('#set-rev').value), mar = parseFloat($('#set-mar').value);
    if (!(rev >= 0 && rev < 100 && mar >= 0 && mar < 100)) return toast('税率填 0–100 之间的数');
    state.settings = { ...state.settings, revenueRate: rev / 100, marginRate: mar / 100 };
    save();
    toast('税率已更新');
  };
  $('#page-settings').querySelectorAll('[data-del-name]').forEach((b) => (b.onclick = () => {
    const list = state.lists[b.dataset.delName];
    list.splice(list.indexOf(b.dataset.name), 1);
    save();
    toast(`已从下拉单删掉「${b.dataset.name}」，已记的账不受影响`);
  }));
  $('#page-settings').querySelectorAll('[data-add-name]').forEach((b) => (b.onclick = () => {
    const k = b.dataset.addName;
    const v = $(`#add-${k}`).value.trim();
    if (!v) return toast(`先填${LIST_LABEL[k]}的名字`);
    if (!addToList(state, k, v)) return toast(`「${v}」已经在下拉单里了`);
    save();
    toast(`「${v}」已加入${LIST_LABEL[k]}下拉单`);
  }));
  $('#exp').onclick = () => download(`进销账-${today()}.json`, JSON.stringify(mine, null, 2));
  $('#exp-csv').onclick = exportCsv;
  $('#imp').onchange = async (e) => {
    const f = e.target.files[0];
    if (!f) return;
    try {
      const data = JSON.parse(await f.text());
      if (!Array.isArray(data.sales) || !Array.isArray(data.receipts)) throw new Error('格式不对');
      if (hasData(mine) && !(await ask('导入会覆盖你现在的整本账，确定？', '覆盖导入', true))) return;
      mine = hydrate(data);
      demoMode = false;
      state = mine;
      save();
      toast('已导入');
    } catch (err) { toast('导入失败：' + err.message); }
    e.target.value = '';
  };
  if ($('#demo')) $('#demo').onclick = enterDemo;
  $('#wipe').onclick = async () => {
    if (!(await ask('清空你自己的整本账？清空前建议先导出备份。', '清空', true))) return;
    mine = { ...emptyState(), settings: mine.settings };
    demoMode = false;
    state = mine;
    save();
    toast('已清空');
  };
}

// claude.ai 里走平台的保存对话框；自己部署时用普通下载链接
async function download(name, text) {
  const dl = window.claude?.use ? await window.claude.use('downloads') : null;
  if (dl) {
    try { await dl.save({ filename: name, data: text }); toast('已导出'); } catch (e) { if (e?.code !== 'declined') toast('导出失败：' + (e?.message || '这里不支持导出')); }
    return;
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text]));
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

function exportCsv() {
  const rows = [['日期', '下游', '品种', '数量', '单价', '金额', '已回款', '未回款']];
  for (const s of [...R.sales].sort((a, b) => (a.date < b.date ? -1 : 1)))
    rows.push([s.date, s.customer, s.product, s.qty, s.price, toYuan(s.total), toYuan(s.settled), toYuan(s.outstanding)]);
  const csv = '﻿' + rows.map((r) => r.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(',')).join('\n');
  download(`销售明细-${today()}.csv`, csv);
}

// ---------- 点击分发 ----------
document.getElementById('app').addEventListener('click', (e) => {
  const segBtn = e.target.closest('[data-seg]');
  if (segBtn) { seg[segBtn.dataset.group] = segBtn.dataset.seg; return render(); }
  const go = e.target.closest('[data-goto]');
  if (go) {
    tab = go.dataset.goto;
    if (go.dataset.goseg) { const [g, v] = go.dataset.goseg.split(':'); seg[g] = v; }
    window.scrollTo(0, 0);
    return render();
  }
  const act = e.target.closest('[data-act]');
  if (act) {
    const a = act.dataset.act;
    if (a === 'purchase') return purchaseForm();
    if (a === 'sale') return saleForm();
    if (a === 'receipt') return receiptForm(null, act.dataset.customer);
    if (a === 'payment') return paymentForm(null, act.dataset.supplier);
    if (a === 'price') return priceForm();
    if (a === 'withdraw') return withdrawForm();
    if (a === 'exit-demo') return exitDemo();
  }
  const ed = e.target.closest('[data-edit]');
  if (ed) {
    const { edit, id } = ed.dataset;
    if (edit === 'sale') return saleForm(state.sales.find((x) => x.id === id));
    if (edit === 'purchase') return purchaseForm(state.purchases.find((x) => x.id === id));
    if (edit === 'receipt') return receiptForm(state.receipts.find((x) => x.id === id));
    if (edit === 'payment') return paymentForm((state.payments || []).find((x) => x.id === id));
    if (edit === 'price') return priceForm(ed.dataset.sup, ed.dataset.prod);
    if (edit === 'withdraw') return withdrawForm(state.withdrawals.find((x) => x.id === id));
  }
});

function upsert(list, rec) {
  const i = list.findIndex((x) => x.id === rec.id);
  if (i >= 0) list[i] = rec; else list.push(rec);
}
function remove(list, id) {
  const i = list.findIndex((x) => x.id === id);
  if (i >= 0) list.splice(i, 1);
}
const delBtn = (rec) => (rec ? '<button class="btn danger block" id="f-del" type="button" style="margin-top:8px">删除这笔</button>' : '');
const num = (root, sel) => parseFloat($(sel, root).value);

// ---------- 名称下拉单 ----------
// 品种、上游公司、下游公司各一张，存在账本里，跟着云端同步。
// 点输入框就列出单子里的名字，边打字边筛；打了个单子里没有的新名字，下面会出现
// 「加入下拉单」（默认勾上，不想加就取消），保存这笔账时才真的加进去。
const LIST_LABEL = { products: '品种', suppliers: '上游厂家', customers: '下游公司' };

function pickerField(id, key, value, { placeholder = '', add = true } = {}) {
  return `<div class="picker" data-picker="${key}" data-add="${add ? 1 : 0}">
    <div class="picker-box">
      <input class="inp" id="${id}" value="${esc(value)}" placeholder="${esc(placeholder)}" autocomplete="off" role="combobox" aria-expanded="false" aria-controls="${id}-list">
      <button type="button" class="picker-toggle" aria-label="打开${LIST_LABEL[key]}下拉单">${icon('chev')}</button>
      <ul class="picker-list" id="${id}-list" role="listbox" hidden></ul>
    </div>
    <label class="picker-add" hidden><input type="checkbox" checked><span></span></label>
  </div>`;
}

// 下拉单里的选项：最近用过的排前面，旁边带一句当前情况（库存、谁欠谁多少）
// 这个厂家有哪些药：价目表里的 + 进过货的
const makerProducts = (maker) => [...new Set([
  ...(state.prices || []).filter((p) => p.supplier === maker).map((p) => p.product),
  ...state.purchases.filter((p) => p.supplier === maker).map((p) => p.product),
])];

function pickerOptions(key, extra = [], owingFirst = false, maker = '') {
  const used = lastUsed(state, key);
  let all = [...new Set([...(state.lists?.[key] || []), ...extra])];
  // 选了厂家：品种只列这个厂家的药（它一个都没有时列全部）
  const mine = key === 'products' && maker ? makerProducts(maker) : [];
  if (mine.length) all = [...new Set([...mine, ...all.filter((n) => mine.includes(n))])];
  const info = (n) => {
    if (key === 'products') {
      const rows = R.products.filter((x) => x.product === n && (!maker || x.supplier === maker));
      const stock = rows.reduce((t, x) => t + x.stock, 0);
      const lp = maker ? listPrice(state, maker, n) : null;
      return { note: [rows.length ? `库存 ${stock}` : '', lp != null ? `售价 ¥${lp}` : ''].filter(Boolean).join(' · '), owe: 0 };
    }
    const c = (key === 'customers' ? R.customers : R.suppliers).find((x) => x.name === n);
    const owe = c?.outstanding || 0;
    return { note: owe ? `${key === 'customers' ? '还欠我' : '我还欠'} ${y(owe)}` : '', owe };
  };
  return all.map((n) => ({ name: n, ...info(n), last: used.get(n) || '' }))
    .sort((a, b) => (owingFirst && (b.owe > 0) - (a.owe > 0)) || (a.last < b.last ? 1 : a.last > b.last ? -1 : 0));
}

function wirePickers(root, { extra = {}, owingFirst = false, maker = () => '' } = {}) {
  root.querySelectorAll('.picker').forEach((pk) => {
    const key = pk.dataset.picker;
    const inp = pk.querySelector('input.inp');
    const list = pk.querySelector('.picker-list');
    const addRow = pk.querySelector('.picker-add');
    const opts = () => pickerOptions(key, extra[key] || [], owingFirst, maker());

    const paint = (showAll) => {
      const q = showAll ? '' : inp.value.trim();
      const all = opts();
      const items = all.filter((o) => !q || o.name.includes(q));
      list.innerHTML = items.length
        ? items.slice(0, 60).map((o) => `<li role="option"><button type="button" data-pick="${esc(o.name)}"><span>${esc(o.name)}</span>${o.note ? `<small>${o.note}</small>` : ''}</button></li>`).join('')
        : `<li class="picker-empty">${all.length ? '下拉单里没有这个名字' : `${LIST_LABEL[key]}下拉单还是空的：打个名字，勾上「加入下拉单」，下次就能直接选`}</li>`;
      return items.length;
    };
    // 打字时只有对得上的名字才弹出来，对不上就收起，露出下面的「加入下拉单」
    const open = (showAll) => {
      const n = paint(showAll);
      if (!n && !showAll) return close();
      list.hidden = false;
      inp.setAttribute('aria-expanded', 'true');
    };
    const close = () => { list.hidden = true; inp.setAttribute('aria-expanded', 'false'); };
    const paintAdd = () => {
      const v = inp.value.trim();
      const show = pk.dataset.add === '1' && v && !(state.lists?.[key] || []).includes(v);
      addRow.hidden = !show;
      if (show) addRow.querySelector('span').textContent = `把「${v}」加入${LIST_LABEL[key]}下拉单，下次直接选`;
    };

    let picking = false;
    inp.addEventListener('focus', () => open(false));
    inp.addEventListener('input', () => { if (!picking) open(false); paintAdd(); });
    inp.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); });
    pk.querySelector('.picker-toggle').addEventListener('click', () => (list.hidden ? open(true) : close()));
    list.addEventListener('click', (e) => {
      const b = e.target.closest('[data-pick]');
      if (!b) return;
      inp.value = b.dataset.pick;
      close();
      picking = true;
      inp.dispatchEvent(new Event('input', { bubbles: true }));
      inp.dispatchEvent(new Event('change', { bubbles: true }));
      picking = false;
    });
    root.addEventListener('pointerdown', (e) => { if (!pk.contains(e.target)) close(); });
    paintAdd();
  });
}

// 保存一笔账时，把勾了「加入下拉单」的新名字真正加进去；返回加了哪些
function commitPickers(root) {
  const added = [];
  root.querySelectorAll('.picker').forEach((pk) => {
    const row = pk.querySelector('.picker-add');
    if (row.hidden || !row.querySelector('input').checked) return;
    const v = pk.querySelector('input.inp').value.trim();
    if (addToList(state, pk.dataset.picker, v)) added.push(v);
  });
  return added;
}
const addedNote = (added) => (added.length ? `，「${added.join('」「')}」已加入下拉单` : '');

// ---------- 进货 / 销售 ----------
function tradeFields(kind, rec) {
  const ph = '选一个，或打个新名字';
  // 老销售没记厂家时，按能推断出的厂家先填上
  const maker = rec ? (kind === 'sale' ? (rec.supplier || R.salesById.get(rec.id)?.supplier || '') : rec.supplier) : '';
  return `
    <div class="f"><label>日期</label><input class="inp" type="date" id="f-date" value="${esc(rec?.date || today())}"></div>
    <div class="f"><label for="f-maker">${kind === 'sale' ? '哪个厂家的货' : '上游厂家'}</label>${pickerField('f-maker', 'suppliers', maker, { placeholder: ph })}</div>
    <div class="f"><label for="f-product">品种</label>${pickerField('f-product', 'products', rec?.product || '', { placeholder: ph })}</div>
    ${kind === 'sale' ? `<div class="f"><label for="f-party">卖给哪家</label>${pickerField('f-party', 'customers', rec?.customer || '', { placeholder: ph })}</div>` : ''}
    <div class="two">
      <div class="f"><label>数量</label><input class="inp" type="number" inputmode="decimal" id="f-qty" value="${rec?.qty ?? ''}"></div>
      <div class="f"><label>${kind === 'sale' ? '售价' : '进价'}（元/件）</label><input class="inp" type="number" inputmode="decimal" step="0.01" id="f-price" value="${rec?.price ?? ''}"></div>
    </div>
    ${kind === 'sale' ? `<div class="price-note" id="f-price-note"></div>
    <div id="f-lots-wrap" hidden>
      <div class="lbl alloc-hd">从哪几批出货 <button class="btn sm" type="button" id="f-fifo">按先进先出</button></div>
      <p class="hint" style="margin:-2px 0 8px">每批进价不同，扣税按实际出的批次算。默认先出最早进的，每批件数能改。</p>
      <div class="alloc" id="f-lots"></div>
    </div>` : ''}
    <div class="calc" id="f-calc"></div>
    ${rec ? (kind === 'sale' ? batchHistory(state.receipts, 'saleId', rec.id, '这批货的回款') : batchHistory(state.payments || [], 'purchaseId', rec.id, '这批货的付款')) : ''}
    <div class="f"><label>备注 <span class="tip">选填</span></label><input class="inp" id="f-note" value="${esc(rec?.note || '')}" placeholder="批号、票号…"></div>
    <button class="btn primary block" id="f-save">保存</button>${delBtn(rec)}`;
}

function purchaseForm(rec) {
  openSheet(rec ? '改进货' : '记进货', tradeFields('purchase', rec), (root) => {
    wirePickers(root, { maker: () => $('#f-maker', root).value.trim() });
    const calc = () => {
      const qty = num(root, '#f-qty') || 0, price = num(root, '#f-price') || 0;
      const pp = rec && R.purchasesById.get(rec.id);
      $('#f-calc', root).innerHTML = `<div class="ln total"><span>进货金额（欠上游）</span><span class="num">${yy(qty * price)}</span></div>`
        + (pp?.paid ? `<div class="ln warn"><span>这笔已付</span><span class="num">${y(pp.paid)}</span></div>` : '')
        + (pp?.sold ? `<div class="ln"><span>这批已经卖出 ${+pp.sold.toFixed(3)} 件，剩 ${+pp.remaining.toFixed(3)} 件</span></div>` : '');
    };
    root.addEventListener('input', calc); calc();
    $('#f-save', root).onclick = () => {
      const r = { id: rec?.id || uid(), date: $('#f-date', root).value, supplier: $('#f-maker', root).value.trim(), product: $('#f-product', root).value.trim(), qty: num(root, '#f-qty'), price: num(root, '#f-price'), note: $('#f-note', root).value.trim() };
      if (!r.date || !r.supplier || !r.product || !(r.qty > 0) || !(r.price >= 0)) return toast('日期、厂家、品种、数量、进价都要填');
      const pp = rec && R.purchasesById.get(rec.id);
      if (pp && pp.paid > toCents(purchaseAmount(r))) return toast(`这笔已付 ${y(pp.paid)}，金额不能改得比它小`);
      if (pp && pp.paid && r.supplier !== rec.supplier) return toast('这笔已付过款，不能换上游；先删付款');
      // 销售里明确选了从这批出货：件数不能改得比出掉的少，也不能换厂家 / 药
      const chosen = state.sales.reduce((t, x) => t + (x.lots || []).filter((l) => l.purchaseId === rec?.id).reduce((u, l) => u + Number(l.qty), 0), 0);
      if (chosen && r.qty < chosen) return toast(`有销售从这批出了 ${chosen} 件，件数不能改得比它少`);
      if (chosen && (r.supplier !== rec.supplier || r.product !== rec.product)) return toast('有销售从这批出过货，不能换厂家或药');
      const added = commitPickers(root);
      upsert(state.purchases, r); save(); closeSheet(); toast('已记进货' + addedNote(added));
    };
    if (rec) $('#f-del', root).onclick = async () => {
      const used = (state.payments || []).filter((x) => (x.allocations || []).some((a) => a.purchaseId === rec.id));
      if (used.length) return toast(`有 ${used.length} 笔付款付的是这笔进货，先删或改那些付款`);
      const fromHere = state.sales.filter((x) => (x.lots || []).some((l) => l.purchaseId === rec.id));
      if (fromHere.length) return toast(`有 ${fromHere.length} 笔销售从这批出的货，先改那些销售`);
      if (await ask('删除这笔进货？', '删除', true)) { remove(state.purchases, rec.id); save(); closeSheet(); }
    };
  });
}

// 卖出的件数从哪几批出：每批一行，件数能改，带「全部 / 补剩下的 / 不用」
function lotEditor(box, { onChange, onTouch }) {
  let rows = [];
  let need = () => 0;
  const input = (id) => box.querySelector(`[data-lot="${id}"]`);
  const value = (id) => Number(input(id)?.value) || 0;
  const status = (row) => {
    const el = box.querySelector(`[data-lst="${row.id}"]`);
    if (!el) return;
    const v = value(row.id);
    let t, c;
    if (!v) { t = `这次不用 · 剩 ${row.remaining} 件`; c = 'muted'; }
    else if (v > row.remaining + 1e-9) { t = `超出这批库存 ${+(v - row.remaining).toFixed(3)} 件`; c = 'bad'; }
    else if (Math.abs(v - row.remaining) < 1e-9) { t = `出 ${v} 件，这批出完`; c = 'ok'; }
    else { t = `出 ${v} 件，之后剩 ${+(row.remaining - v).toFixed(3)} 件`; c = 'warn'; }
    el.textContent = t;
    el.className = 'alloc-st ' + c;
  };
  box.addEventListener('input', (e) => {
    const i = e.target.closest('[data-lot]');
    if (!i) return;
    onTouch();
    status(rows.find((r) => r.id === i.dataset.lot));
    onChange();
  });
  box.addEventListener('click', (e) => {
    const b = e.target.closest('[data-fill]');
    if (!b) return;
    const row = rows.find((r) => r.id === b.closest('[data-row]').dataset.row);
    const others = rows.filter((r) => r.id !== row.id).reduce((t, r) => t + value(r.id), 0);
    const v = b.dataset.fill === 'full' ? row.remaining
      : b.dataset.fill === 'none' ? 0
      : Math.max(0, Math.min(row.remaining, need() - others));
    input(row.id).value = v ? +v.toFixed(6) : '';
    onTouch();
    status(row);
    onChange();
  });
  return {
    render(list, preset, needFn) {
      rows = list;
      need = needFn;
      box.innerHTML = rows.map((r) => `
        <div class="alloc-row" data-row="${r.id}">
          <div><div>${esc(r.title)}</div><div class="s">${r.sub}</div></div>
          <input class="inp sm num" type="number" inputmode="decimal" data-lot="${r.id}" value="${preset.get(r.id) ?? ''}" placeholder="0" aria-label="${esc(r.title)} 出多少件">
          <div class="alloc-foot">
            <span class="alloc-st" data-lst="${r.id}"></span>
            <span class="chips"><button type="button" data-fill="full">全部</button><button type="button" data-fill="rest">补剩下的</button><button type="button" data-fill="none">不用</button></span>
          </div>
        </div>`).join('');
      rows.forEach(status);
    },
    lines: () => rows.map((r) => ({ ...r, qty: value(r.id) })),
  };
}

function saleForm(rec) {
  openSheet(rec ? '改销售' : '记销售', tradeFields('sale', rec), (root) => {
    const maker = () => $('#f-maker', root).value.trim();
    const product = () => $('#f-product', root).value.trim();
    const qtyIn = () => num(root, '#f-qty') || 0;
    const dateIn = () => $('#f-date', root).value || today();
    wirePickers(root, { maker });

    // 售价按价目表自动带出：每个厂家的每个药，卖给谁都是这个价
    let autoPrice = null;
    const fillPrice = () => {
      const lp = listPrice(state, maker(), product());
      const el = $('#f-price', root);
      if (lp != null) { el.value = lp; autoPrice = String(lp); }
      else if (autoPrice != null && el.value === autoPrice) { el.value = ''; autoPrice = null; }
      paintPriceNote();
    };
    const paintPriceNote = () => {
      const box = $('#f-price-note', root);
      const m = maker(), pr = product();
      const price = num(root, '#f-price');
      if (!m || !pr) { box.innerHTML = ''; return; }
      const lp = listPrice(state, m, pr);
      if (lp == null) {
        box.innerHTML = price > 0
          ? `<label class="picker-add"><input type="checkbox" id="f-price-save" checked><span>把「${esc(m)} ${esc(pr)}」售价 ¥${price} 记进价目表，下次自动带出</span></label>`
          : `<p class="hint">价目表里还没有 ${esc(m)} 的${esc(pr)}，填一次售价就能记进去</p>`;
      } else if (price === lp || !(price > 0)) {
        box.innerHTML = `<p class="hint">按价目表：${esc(m)} 的${esc(pr)}卖 ¥${lp}</p>`;
      } else {
        box.innerHTML = `<p class="hint warn-text">价目表是 ¥${lp}，这笔按 ¥${price} 记</p>
          <label class="picker-add"><input type="checkbox" id="f-price-save"><span>同时把价目表改成 ¥${price}</span></label>`;
      }
    };

    // 从哪几批出货：默认先进先出；用户动过就不再自动改，点「按先进先出」重来
    const old = rec && R.salesById.get(rec.id);
    let lotsTouched = Boolean(rec);
    let lotPreset = new Map((old?.lots || []).map((l) => [l.purchaseId, +l.qty.toFixed(6)]));
    let lotKey = rec ? `${maker()}\u0001${product()}` : '';
    const ed = lotEditor($('#f-lots', root), { onChange: () => calc(), onTouch: () => { lotsTouched = true; } });

    const paintLots = () => {
      const wrap = $('#f-lots-wrap', root);
      const m = maker(), pr = product();
      const key = `${m}\u0001${pr}`;
      if (key !== lotKey) { lotsTouched = false; lotKey = key; } // 换了厂家或药，批次重来
      if (!m || !pr) { wrap.hidden = true; ed.render([], new Map(), () => 0); return; }
      if (!lotsTouched) lotPreset = new Map(fifoLots(state, m, pr, qtyIn(), dateIn(), rec?.id).map((l) => [l.purchaseId, l.qty]));
      else if (ed.lines().length) lotPreset = new Map(ed.lines().map((l) => [l.id, l.qty || ''])); // 用户改过的件数原样保留
      const open = openBatchesFor(state, m, pr, rec?.id, [...lotPreset.keys()]);
      wrap.hidden = !open.length;
      ed.render(open.map((b) => ({
        id: b.purchase.id,
        title: `${b.purchase.date} 进的，进价 ¥${b.purchase.price}`,
        sub: `这批进了 ${b.purchase.qty} 件，现在剩 ${+b.remaining.toFixed(3)} 件${b.purchase.note ? ` · ${esc(b.purchase.note)}` : ''}`,
        remaining: +b.remaining.toFixed(6),
        unit: b.unit,
      })), lotPreset, qtyIn);
    };
    $('#f-fifo', root).onclick = () => { lotsTouched = false; paintLots(); calc(); };

    const calc = () => {
      const qty = qtyIn(), price = num(root, '#f-price') || 0;
      const amt = toCents(qty * price);
      let html = `<div class="ln total"><span>销售金额（应收）</span><span class="num">${y(amt)}</span></div>`;
      if (product() && maker() && amt) {
        const lines = ed.lines().filter((l) => l.qty > 0);
        const lotQty = lines.reduce((t, l) => t + l.qty, 0);
        let cogs = lines.reduce((t, l) => t + Math.round(l.qty * l.unit), 0);
        const short = qty - lotQty;
        if (lines.length) html += `<div class="ln"><span>从 ${lines.length} 批出货共 ${+lotQty.toFixed(3)} 件，进货成本</span><span class="num">${y(cogs)}</span></div>`;
        if (lotQty > qty + 1e-9) html += `<div class="ln bad"><span>出货件数比卖的多 ${+(lotQty - qty).toFixed(3)} 件</span></div>`;
        if (short > 1e-9) {
          const { cost, basis } = costBasis(state, product(), dateIn(), maker());
          if (basis === 'none') html += `<div class="ln warn"><span>还没记过 ${esc(maker())} 的${esc(product())}的进货，差价税先按全额算；补记进货后会自动重算</span></div>`;
          else {
            cogs += Math.round(short * cost * 100);
            html += `<div class="ln warn"><span>还差 ${+short.toFixed(3)} 件没分到批次，${lines.length ? '保存后按先进先出补；库存不够的' : ''}先按平均进价 ¥${+cost.toFixed(4)} 算</span></div>`;
          }
        }
        const b = taxFromTotals(amt, cogs, R.settings);
        html += `<div class="ln"><span>差价（销售额 − 进货成本）</span><span class="num">${y(b.margin)}</span></div>
          <div class="ln"><span>回款时扣：回款额 × ${pct(R.settings.revenueRate)}</span><span class="num">${y(b.revenueTax)}</span></div>
          <div class="ln"><span>　　　　+ 差价 × ${pct(R.settings.marginRate)}</span><span class="num">${y(b.marginTax)}</span></div>
          <div class="ln total"><span>扣税 ${y(b.tax)}，税后赚</span><span class="num">${y(b.margin - b.tax)}</span></div>`;
      }
      if (old?.settled) html += `<div class="ln warn"><span>这笔已回款</span><span class="num">${y(old.settled)}</span></div>`;
      $('#f-calc', root).innerHTML = html;
    };

    $('#f-maker', root).addEventListener('input', () => { fillPrice(); paintLots(); });
    $('#f-product', root).addEventListener('input', () => { fillPrice(); paintLots(); });
    $('#f-qty', root).addEventListener('input', paintLots);
    $('#f-date', root).addEventListener('input', paintLots);
    $('#f-price', root).addEventListener('input', paintPriceNote);
    root.addEventListener('input', calc);
    paintPriceNote(); paintLots(); calc();

    $('#f-save', root).onclick = () => {
      const lots = ed.lines().filter((l) => l.qty > 0).map((l) => ({ purchaseId: l.id, qty: l.qty }));
      const r = { id: rec?.id || uid(), date: $('#f-date', root).value, supplier: maker(), product: product(), customer: $('#f-party', root).value.trim(), qty: qtyIn(), price: num(root, '#f-price'), lots, note: $('#f-note', root).value.trim() };
      if (!r.date || !r.supplier || !r.product || !r.customer || !(r.qty > 0) || !(r.price >= 0)) return toast('日期、厂家、品种、卖给哪家、数量、售价都要填');
      if (lots.reduce((t, l) => t + l.qty, 0) > r.qty + 1e-9) return toast('从各批出的件数加起来比卖的还多');
      if (ed.lines().some((l) => l.qty > l.remaining + 1e-9)) return toast('有一批出的件数超过了它的库存');
      if (old && old.settled > toCents(saleAmount(r))) return toast(`这笔已回款 ${y(old.settled)}，金额不能改得比它小`);
      if (old && old.settled && r.customer !== rec.customer) return toast('这笔已有回款，不能换下游；先删回款');
      const added = commitPickers(root);
      const savePrice = $('#f-price-save', root)?.checked;
      if (savePrice) setListPrice(state, r.supplier, r.product, r.price);
      upsert(state.sales, r); save(); closeSheet();
      toast('已记销售' + (lots.length > 1 ? `，从 ${lots.length} 批出货` : '') + addedNote(added) + (savePrice ? '，售价已记进价目表' : ''));
    };
    if (rec) $('#f-del', root).onclick = async () => {
      const used = state.receipts.filter((x) => (x.allocations || []).some((a) => a.saleId === rec.id));
      if (used.length) return toast(`有 ${used.length} 笔回款核销了这笔销售，先删或改那些回款`);
      if (await ask('删除这笔销售？它占用的库存会还回去。', '删除', true)) { remove(state.sales, rec.id); save(); closeSheet(); }
    };
  });
}

// ---------- 一笔钱分到多批货 ----------
// 回款分到销售、付款分到进货共用这一套。一笔钱可以：回清几批、只回某一批的一部分、
// 回清几批再加一批的一部分，也可以跳着挑。每批一行，金额能手改，也能点「全额 / 补剩下的 / 不回」。
function allocEditor(box, { words, restFor, onChange }) {
  let rows = [];
  const input = (id) => box.querySelector(`[data-aid="${id}"]`);
  const value = (id) => toCents(input(id)?.value);

  function status(row) {
    const el = box.querySelector(`[data-st="${row.id}"]`);
    if (!el) return;
    const v = value(row.id);
    const qty = row.unit > 0 && v > 0 ? `，约 ${+(v / row.unit).toFixed(2)} 件` : '';
    let t, c;
    if (!v) { t = `${words.none} · 还欠 ${y(row.outstanding)}`; c = 'muted'; }
    else if (v === row.outstanding) { t = `${words.full}${qty}`; c = 'ok'; }
    else if (v < row.outstanding) { t = `${words.part}${qty}，之后还欠 ${y(row.outstanding - v)}`; c = 'warn'; }
    else { t = `超过欠款 ${y(v - row.outstanding)}`; c = 'bad'; }
    el.textContent = t;
    el.className = 'alloc-st ' + c;
  }

  box.addEventListener('input', (e) => {
    const i = e.target.closest('[data-aid]');
    if (!i) return;
    status(rows.find((r) => r.id === i.dataset.aid));
    onChange();
  });
  box.addEventListener('click', (e) => {
    const b = e.target.closest('[data-fill]');
    if (!b) return;
    const row = rows.find((r) => r.id === b.closest('[data-row]').dataset.row);
    const v = b.dataset.fill === 'full' ? row.outstanding
      : b.dataset.fill === 'none' ? 0
      : Math.max(0, Math.min(row.outstanding, restFor(row.id)));
    input(row.id).value = v ? toYuan(v) : '';
    status(row);
    onChange();
  });

  return {
    render(list, preset, emptyText) {
      rows = list;
      box.innerHTML = rows.length ? rows.map((r) => `
        <div class="alloc-row" data-row="${r.id}">
          <div><div>${esc(r.title)}</div><div class="s">${r.sub}</div></div>
          <input class="inp sm num" type="number" inputmode="decimal" step="0.01" data-aid="${r.id}" value="${preset.get(r.id) ?? ''}" placeholder="0" aria-label="${esc(r.title)} 这次分多少">
          <div class="alloc-foot">
            <span class="alloc-st" data-st="${r.id}"></span>
            <span class="chips"><button type="button" data-fill="full">全额</button><button type="button" data-fill="rest">补剩下的</button><button type="button" data-fill="none">${words.noneBtn}</button></span>
          </div>
        </div>`).join('') : `<div class="empty">${emptyText}</div>`;
      rows.forEach(status);
    },
    rows: () => rows,
    lines: () => rows.map((r) => ({ ...r, cents: value(r.id) })),
  };
}

// 分配结果的一句话总结：分到几批、几批回清、几批回一部分
function allocHeadline(lines, words) {
  const used = lines.filter((l) => l.cents > 0);
  const full = used.filter((l) => l.cents === l.outstanding).length;
  const part = used.filter((l) => l.cents < l.outstanding).length;
  if (!used.length) return '还没分到任何一批';
  return `分到 ${used.length} 批：${full ? `${full} 批${words.full}` : ''}${full && part ? '，' : ''}${part ? `${part} 批${words.part}` : ''}`;
}

const RECEIPT_WORDS = { full: '回清', part: '回一部分', none: '这次不回', noneBtn: '不回' };
const PAYMENT_WORDS = { full: '付清', part: '付一部分', none: '这次不付', noneBtn: '不付' };

// ---------- 回款 ----------
function receiptForm(rec, presetCustomer) {
  let account = rec?.account || ACCOUNT.COMPANY;
  let customer = rec?.customer || presetCustomer || '';
  let preset = new Map((rec?.allocations || []).map((a) => [a.saleId, a.amount]));

  openSheet(rec ? '改回款' : '记回款', `
    <div class="two">
      <div class="f"><label>到账日期</label><input class="inp" type="date" id="f-date" value="${esc(rec?.date || today())}"></div>
    </div>
    <div class="f"><label for="f-cust">哪家回的</label>${pickerField('f-cust', 'customers', customer, { placeholder: '选下游公司', add: false })}</div>
    <div class="f"><label>回到哪个账户</label>
      <div class="acct">
        <button type="button" data-v="company"><b>公司账户</b><small>全额到账<br>扣完税的算你的</small></button>
        <button type="button" data-v="personal"><b>个人账户</b><small>到账的已经是<br>扣完税的钱</small></button>
      </div></div>
    <div class="f"><label>实际到账金额（元）</label><input class="inp" type="number" inputmode="decimal" step="0.01" id="f-amt" value="${rec?.amount ?? ''}" placeholder="银行里看到的数"></div>
    <div class="lbl alloc-hd">回的是哪几批货 <button class="btn sm" type="button" id="f-auto">从最早的开始分</button></div>
    <p class="hint" style="margin:-2px 0 8px">可以回清几批、某批只回一部分，也可以跳着挑。每批金额能直接改。</p>
    <div class="alloc" id="f-alloc"></div>
    <div class="calc" id="f-calc"></div>
    <div class="f"><label>备注 <span class="tip">选填</span></label><input class="inp" id="f-note" value="${esc(rec?.note || '')}"></div>
    <button class="btn primary block" id="f-save">保存</button>${delBtn(rec)}`, (root) => {
    // 回款只能回给有过销售的下游：下拉单里补上所有卖过货的，欠钱的排前面
    wirePickers(root, { extra: { customers: names(state.sales, 'customer') }, owingFirst: true });

    const amount = () => toCents(num(root, '#f-amt') || 0);
    const rates = saleRates(state);
    const keep = rec?.customer === customer ? (rec.allocations || []).map((a) => a.saleId) : [];

    const ed = allocEditor($('#f-alloc', root), {
      words: RECEIPT_WORDS,
      onChange: () => paintCalc(),
      // 「补剩下的」：到账还没分出去的部分，全给这一批（个人账户按这批的税负换算成应收）
      restFor: (id) => {
        const others = ed.lines().filter((l) => l.id !== id);
        if (account === ACCOUNT.PERSONAL) {
          const usedNet = others.reduce((s, l) => s + l.cents - Math.round(l.cents * l.rate), 0);
          return Math.round((amount() - usedNet) / (1 - ed.rows().find((r) => r.id === id).rate));
        }
        return amount() - others.reduce((s, l) => s + l.cents, 0);
      },
    });

    const paintAcct = () => root.querySelectorAll('.acct button').forEach((b) => b.classList.toggle('on', b.dataset.v === account));

    const paintAlloc = () => {
      const open = customer ? openSalesFor(state, customer, rec?.id, keep) : [];
      ed.render(open.map((o) => ({
        id: o.sale.id,
        title: `${o.sale.date} ${o.sale.product}${rates.get(o.sale.id).supplier ? `（${rates.get(o.sale.id).supplier}）` : ''} ${o.sale.qty}件 × ${o.sale.price}`,
        sub: `这批 ${y(o.total)}${o.settled ? `，别的回款已回 ${y(o.settled)}` : ''} · 税负 ${pct(o.rate)}`,
        outstanding: o.outstanding,
        rate: o.rate,
        unit: toCents(o.sale.price),
      })), preset, customer ? '这家没有没回清的货' : '先填是哪家回的');
      paintCalc();
    };

    const paintCalc = () => {
      const lines = ed.lines();
      const gross = lines.reduce((s, l) => s + l.cents, 0);
      const ruleTax = lines.reduce((s, l) => s + Math.round(l.cents * l.rate), 0);
      const over = lines.some((l) => l.cents > l.outstanding);
      const amt = amount();
      let html = `<div class="ln"><span>${allocHeadline(lines, RECEIPT_WORDS)}</span><span class="num">${y(gross)}</span></div>`;
      if (account === ACCOUNT.PERSONAL) {
        const expected = gross - ruleTax;
        html += `<div class="ln"><span>按规则扣税 ${y(ruleTax)}，应到账</span><span class="num">${y(expected)}</span></div>
          <div class="ln total"><span>实际到账</span><span class="num">${y(amt)}</span></div>`;
        if (amt && expected - amt > 100) html += `<div class="ln warn"><span>分多了：按分的这些应到账 ${y(expected)}，比实际多 ${y(expected - amt)}</span></div>`;
        else if (amt && amt - expected > 100) html += `<div class="ln warn"><span>还有约 ${y(amt - expected)} 到账没分到货上</span></div>`;
      } else {
        html += `<div class="ln"><span>到账</span><span class="num">${y(amt)}</span></div>
          <div class="ln"><span>按规则扣税</span><span class="num">−${fmt(ruleTax)}</span></div>
          <div class="ln total"><span>算你在公司的钱</span><span class="num">${y(amt - ruleTax)}</span></div>`;
        if (amt && gross < amt) html += `<div class="ln warn"><span>还有 ${y(amt - gross)} 没分到货上（多付 / 预付？没分的按这家平均税负扣税）</span></div>`;
        if (amt && gross > amt) html += `<div class="ln warn"><span>分多了 ${y(gross - amt)}，比到账还多</span></div>`;
      }
      if (over) html += '<div class="ln bad"><span>有一批分的钱超过了它的欠款</span></div>';
      $('#f-calc', root).innerHTML = html;
    };

    const auto = () => {
      const fn = account === ACCOUNT.PERSONAL ? autoAllocateNet : autoAllocate;
      preset = new Map(fn(state, customer, toYuan(amount()), rec?.id).map((a) => [a.saleId, a.amount]));
      paintAlloc();
    };

    paintAcct(); paintAlloc();

    root.querySelectorAll('.acct button').forEach((b) => (b.onclick = () => { account = b.dataset.v; paintAcct(); if (amount()) auto(); else paintCalc(); }));
    $('#f-cust', root).addEventListener('change', (e) => { customer = e.target.value.trim(); preset = new Map(); if (amount()) auto(); else paintAlloc(); });
    $('#f-amt', root).addEventListener('input', auto);
    $('#f-auto', root).onclick = auto;

    $('#f-save', root).onclick = () => {
      customer = $('#f-cust', root).value.trim();
      const lines = ed.lines();
      const allocations = lines.filter((l) => l.cents > 0).map((l) => ({ saleId: l.id, amount: toYuan(l.cents) }));
      const r = { id: rec?.id || uid(), date: $('#f-date', root).value, customer, account, amount: toYuan(amount()), allocations, note: $('#f-note', root).value.trim() };
      if (!r.date || !r.customer || !(r.amount > 0)) return toast('日期、哪家、到账金额要填');
      if (lines.some((l) => l.cents > l.outstanding)) return toast('有一批分的钱超过了它的欠款');
      if (r.account === ACCOUNT.PERSONAL && toCents(receiptGross(r)) < toCents(r.amount)) return toast('个人账户到账比分到货上的还多？核对一下');
      upsert(state.receipts, r); save(); closeSheet();
      toast(allocations.length > 1 ? `已记回款：${allocHeadline(lines, RECEIPT_WORDS)}` : '已记回款');
    };
    if (rec) $('#f-del', root).onclick = async () => { if (await ask('删除这笔回款？对应几批货会变回没回款。', '删除', true)) { remove(state.receipts, rec.id); save(); closeSheet(); } };
  });
}

// ---------- 付上游 ----------
function paymentForm(rec, presetSupplier) {
  let account = rec?.account || ACCOUNT.PERSONAL;
  let supplier = rec?.supplier || presetSupplier || '';
  let preset = new Map((rec?.allocations || []).map((a) => [a.purchaseId, a.amount]));
  if (!state.payments) state.payments = [];
  const others = { ...state, payments: state.payments.filter((x) => x.id !== rec?.id) };

  openSheet(rec ? '改付款' : '付上游货款', `
    <div class="two">
      <div class="f"><label>打款日期</label><input class="inp" type="date" id="f-date" value="${esc(rec?.date || today())}"></div>
    </div>
    <div class="f"><label for="f-sup">打给哪家</label>${pickerField('f-sup', 'suppliers', supplier, { placeholder: '选上游公司', add: false })}</div>
    <div class="f"><label>从哪个账户打出</label>
      <div class="acct">
        <button type="button" data-v="personal"><b>个人账户</b><small>从自己卡里付</small></button>
        <button type="button" data-v="company"><b>公司账户</b><small>从公司账上付<br>扣你在公司的钱</small></button>
      </div></div>
    <div class="f"><label>打出金额（元）</label><input class="inp" type="number" inputmode="decimal" step="0.01" id="f-amt" value="${rec?.amount ?? ''}"></div>
    <div class="lbl alloc-hd">付的是哪几批货 <button class="btn sm" type="button" id="f-auto">从最早的开始分</button></div>
    <p class="hint" style="margin:-2px 0 8px">可以付清几批、某批只付一部分，也可以跳着挑。</p>
    <div class="alloc" id="f-alloc"></div>
    <div class="calc" id="f-calc"></div>
    <div class="f"><label>备注 <span class="tip">选填</span></label><input class="inp" id="f-note" value="${esc(rec?.note || '')}"></div>
    <button class="btn primary block" id="f-save">保存</button>${delBtn(rec)}`, (root) => {
    wirePickers(root, { extra: { suppliers: names(state.purchases, 'supplier') }, owingFirst: true });

    const amount = () => toCents(num(root, '#f-amt') || 0);
    const keep = rec?.supplier === supplier ? (rec.allocations || []).map((a) => a.purchaseId) : [];
    const ed = allocEditor($('#f-alloc', root), {
      words: PAYMENT_WORDS,
      onChange: () => paintCalc(),
      restFor: (id) => amount() - ed.lines().filter((l) => l.id !== id).reduce((s, l) => s + l.cents, 0),
    });
    const paintAcct = () => root.querySelectorAll('.acct button').forEach((b) => b.classList.toggle('on', b.dataset.v === account));

    const paintAlloc = () => {
      const open = supplier ? openPurchasesFor(state, supplier, rec?.id, keep) : [];
      ed.render(open.map((o) => ({
        id: o.purchase.id,
        title: `${o.purchase.date} ${o.purchase.product} ${o.purchase.qty}件 × ${o.purchase.price}`,
        sub: `这批 ${y(o.total)}${o.paid ? `，别的付款已付 ${y(o.paid)}` : ''}`,
        outstanding: o.outstanding,
        unit: toCents(o.purchase.price),
      })), preset, supplier ? '欠这家的货款都付清了' : '先填打给哪家');
      paintCalc();
    };

    const paintCalc = () => {
      const lines = ed.lines();
      const sum = lines.reduce((s, l) => s + l.cents, 0);
      const amt = amount();
      let html = `<div class="ln"><span>${allocHeadline(lines, PAYMENT_WORDS)}</span><span class="num">${y(sum)}</span></div>`;
      if (amt && sum < amt) html += `<div class="ln warn"><span>还有 ${y(amt - sum)} 没分到货上（预付？）</span></div>`;
      if (amt && sum > amt) html += `<div class="ln warn"><span>分多了 ${y(sum - amt)}，比打出的钱还多</span></div>`;
      if (account === ACCOUNT.COMPANY && amt) {
        const p = previewPayment(others, { date: $('#f-date', root).value || today(), supplier, account, amount: toYuan(amt), allocations: [] });
        html += `<div class="ln"><span>付之前你在公司有</span><span class="num">${y(p.before)}</span></div>
          <div class="ln total"><span>付完还剩</span><span class="num">${y(p.before - p.amountC)}</span></div>`;
        if (p.over > 0) html += `<div class="ln warn"><span>比你在公司的钱多 ${y(p.over)}，相当于先占用了公司的钱</span></div>`;
      }
      if (lines.some((l) => l.cents > l.outstanding)) html += '<div class="ln bad"><span>有一批分的钱超过了它的欠款</span></div>';
      $('#f-calc', root).innerHTML = html;
    };

    const auto = () => {
      preset = new Map(autoAllocatePayment(state, supplier, toYuan(amount()), rec?.id).map((a) => [a.purchaseId, a.amount]));
      paintAlloc();
    };

    paintAcct(); paintAlloc();
    root.querySelectorAll('.acct button').forEach((b) => (b.onclick = () => { account = b.dataset.v; paintAcct(); paintCalc(); }));
    $('#f-sup', root).addEventListener('change', (e) => { supplier = e.target.value.trim(); preset = new Map(); if (amount()) auto(); else paintAlloc(); });
    $('#f-amt', root).addEventListener('input', auto);
    $('#f-date', root).addEventListener('input', paintCalc);
    $('#f-auto', root).onclick = auto;

    $('#f-save', root).onclick = () => {
      supplier = $('#f-sup', root).value.trim();
      const lines = ed.lines();
      const allocations = lines.filter((l) => l.cents > 0).map((l) => ({ purchaseId: l.id, amount: toYuan(l.cents) }));
      const r = { id: rec?.id || uid(), date: $('#f-date', root).value, supplier, account, amount: toYuan(amount()), allocations, note: $('#f-note', root).value.trim() };
      if (!r.date || !r.supplier || !(r.amount > 0)) return toast('日期、打给哪家、金额要填');
      if (lines.some((l) => l.cents > l.outstanding)) return toast('有一批分的钱超过了它的欠款');
      upsert(state.payments, r); save(); closeSheet();
      toast(allocations.length > 1 ? `已记付款：${allocHeadline(lines, PAYMENT_WORDS)}` : '已记付款');
    };
    if (rec) $('#f-del', root).onclick = async () => { if (await ask('删除这笔付款？', '删除', true)) { remove(state.payments, rec.id); save(); closeSheet(); } };
  });
}

// ---------- 提现 ----------
function withdrawForm(rec) {
  const others = { ...state, withdrawals: state.withdrawals.filter((w) => w.id !== rec?.id) };
  openSheet(rec ? '提现记录' : '从公司提现', `
    <p class="small muted" style="margin-top:0">你在公司的钱已经扣过税，提多少到手多少。</p>
    <div class="two">
      <div class="f"><label>日期</label><input class="inp" type="date" id="f-date" value="${esc(rec?.date || today())}"></div>
      <div class="f"><label>提多少（元）</label><input class="inp" type="number" inputmode="decimal" step="0.01" id="f-net" value="${rec?.net ?? ''}"></div>
    </div>
    <div class="btn-row" style="margin:-4px 0 12px"><button class="btn sm" type="button" id="f-all">全部提出</button></div>
    <div class="calc" id="f-calc"></div>
    <div class="f"><label>备注 <span class="tip">选填</span></label><input class="inp" id="f-note" value="${esc(rec?.note || '')}"></div>
    <button class="btn primary block" id="f-save">${rec ? '保存' : '确认提现'}</button>${delBtn(rec)}`, (root) => {
    const date = () => $('#f-date', root).value || today();
    const avail = () => Math.max(0, companyBalanceAt(state, date(), { withdrawal: rec?.id }));
    const calc = () => {
      const have = avail();
      const amt = toCents(num(root, '#f-net') || 0);
      let html = `<div class="ln"><span>${date()} 你在公司有</span><span class="num">${y(have)}</span></div>`;
      if (amt) {
        html += `<div class="ln total"><span>提完还剩</span><span class="num">${y(have - amt)}</span></div>`;
        if (amt > have) html += `<div class="ln bad"><span>超出了 ${y(amt - have)}，最多提 ${y(have)}</span></div>`;
      }
      $('#f-calc', root).innerHTML = html;
    };
    root.addEventListener('input', calc); calc();
    $('#f-all', root).onclick = () => { $('#f-net', root).value = toYuan(avail()); calc(); };
    $('#f-save', root).onclick = () => {
      const r = { id: rec?.id || uid(), date: $('#f-date', root).value, net: num(root, '#f-net'), note: $('#f-note', root).value.trim() };
      if (!r.date || !(r.net > 0)) return toast('日期和金额要填');
      const w = previewWithdrawal(others, r.net, r.date);
      if (w.shortfall > 0) return toast(`超出了，那天最多提 ${y(Math.max(0, w.before))}`);
      upsert(state.withdrawals, r); save(); closeSheet(); toast('已提现');
    };
    if (rec) $('#f-del', root).onclick = async () => { if (await ask('删除这笔提现？', '删除', true)) { remove(state.withdrawals, rec.id); save(); closeSheet(); } };
  });
}

// ---------- 示例数据 ----------
function demoState() {
  const s = emptyState();
  const t = today();
  const lm = prevMonth(t);
  const d = (ym, day) => `${ym}-${String(day).padStart(2, '0')}`;
  s.purchases.push(
    { id: 'p1', date: d(lm, 2), supplier: '华东医药供应链', product: '甲', qty: 200, price: 1, note: '' },
    { id: 'p2', date: d(lm, 5), supplier: '华东医药供应链', product: '乙', qty: 500, price: 8, note: '' },
  );
  s.sales.push(
    { id: 's1', date: d(lm, 3), customer: '仁和医院', product: '甲', qty: 80, price: 1.5, note: '' },
    { id: 's2', date: d(lm, 4), customer: '仁和医院', product: '甲', qty: 60, price: 1.5, note: '' },
    { id: 's3', date: d(lm, 6), customer: '康宁大药房', product: '甲', qty: 60, price: 1.5, note: '' },
    { id: 's4', date: d(lm, 8), customer: '仁和医院', product: '乙', qty: 300, price: 11, note: '' },
    { id: 's5', date: d(lm, 12), customer: '康宁大药房', product: '乙', qty: 150, price: 11, note: '' },
  );
  s.receipts.push(
    // 仁和医院一次打 3510，合并核销三笔销售
    { id: 'r1', date: d(lm, 20), customer: '仁和医院', account: 'company', amount: 3510, allocations: [{ saleId: 's1', amount: 120 }, { saleId: 's2', amount: 90 }, { saleId: 's4', amount: 3300 }], note: '合并回款' },
    // 康宁回到个人账户，已扣税
    { id: 'r2', date: d(lm, 25), customer: '康宁大药房', account: 'personal', amount: 85.2, allocations: [{ saleId: 's3', amount: 90 }], note: '' },
    { id: 'r3', date: d(t.slice(0, 7), 3), customer: '康宁大药房', account: 'company', amount: 1000, allocations: [{ saleId: 's5', amount: 1000 }], note: '部分回款' },
  );
  s.payments.push(
    // 甲的货款先从自己卡里垫上；乙的货款等仁和回款到公司后，从公司账上付了一部分
    { id: 'pay1', date: d(lm, 2), supplier: '华东医药供应链', account: 'personal', amount: 200, allocations: [{ purchaseId: 'p1', amount: 200 }], note: '' },
    { id: 'pay2', date: d(lm, 22), supplier: '华东医药供应链', account: 'company', amount: 3000, allocations: [{ purchaseId: 'p2', amount: 3000 }], note: '' },
  );
  for (const x of s.sales) x.supplier = '华东医药供应链';
  s.prices = [{ supplier: '华东医药供应链', product: '甲', price: 1.5 }, { supplier: '华东医药供应链', product: '乙', price: 11 }];
  s.lists = seedLists(s);
  return s;
}

render();
