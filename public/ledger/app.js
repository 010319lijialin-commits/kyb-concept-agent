import {
  ACCOUNT, emptyState, compute, autoAllocate, autoAllocateNet, openSalesFor, saleRates,
  saleTaxBreakdown, avgCosts, normSettings, pct,
  previewWithdrawal, previewTaxRun, overdueUntaxed, receiptGross,
  saleAmount, purchaseAmount, toCents, toYuan, fmt, uid, monthEnd, prevMonth,
} from './core.js';
import { createStore } from './store.js';

const $ = (sel, root = document) => root.querySelector(sel);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const today = () => {
  const d = new Date();
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
};
const y = (cents) => '¥' + fmt(cents);
const yy = (yuan) => y(toCents(yuan));

// ---------- 存储 ----------
// 示例模式：第一次打开、账本还是空的时候先放一套示例数据给人点着看，示例里的操作一律不保存。
// mine 始终是用户自己的那本账；示例模式下 state 指向示例，mine 原样留着。
let syncStatus = 'local';
const store = createStore({
  onStatus: (s) => { syncStatus = s; paintSync(); },
  onRemote: (s) => { mine = hydrate(s); if (!demoMode) { state = mine; recompute(); } },
});
const hydrate = (s) => ({ ...emptyState(), ...s });
const hasData = (s) => Boolean(s && (s.purchases?.length || s.sales?.length || s.receipts?.length));

let mine = hydrate(store.local() || {});
let demoMode = !hasData(mine);
let state = demoMode ? demoState() : mine;
let R = compute(state);
let tab = 'home';
let tradeView = 'sales';

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
  tax: '<path d="M6 2.5h12v19l-3-2-3 2-3-2-3 2z"/><path d="M9 7.5h6M9 11h6M9 14.5h3"/>',
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
const datalist = (id, values) => `<datalist id="${id}">${values.map((v) => `<option value="${esc(v)}">`).join('')}</datalist>`;

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
const acctPill = (a) => (a === ACCOUNT.PERSONAL ? '<span class="pill personal">个人</span>' : '<span class="pill company">公司</span>');

// ---------- 渲染 ----------
function render() {
  for (const t of ['home', 'trade', 'receipt', 'company', 'settings']) $(`#page-${t}`).hidden = t !== tab;
  document.querySelectorAll('.tabbar button').forEach((b) => b.classList.toggle('on', b.dataset.tab === tab));
  ({ home: renderHome, trade: renderTrade, receipt: renderReceipts, company: renderCompany, settings: renderSettings })[tab]();
}

document.querySelector('.tabbar').innerHTML = [['home', '总览'], ['trade', '进销'], ['receipt', '回款'], ['company', '公司账户'], ['settings', '设置']]
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
  const od = overdueUntaxed(R, today());
  if (od.amount > 0)
    out.push(`<div class="alert warn"><span>公司账户有 ${od.count} 笔 ${od.cutoff.slice(0, 7)} 及以前的回款共 ${y(od.amount)} 还没扣税</span><button class="btn sm" data-act="taxrun">去扣税</button></div>`);
  for (const i of R.issues) out.push(`<div class="alert bad"><span>${esc(i)}</span></div>`);
  return demoBanner() + out.join('');
}

function renderHome() {
  const T = R.totals;
  const month = today().slice(0, 7);
  const mSales = R.sales.filter((s) => s.date.startsWith(month));
  const mRevenue = mSales.reduce((s, x) => s + x.total, 0);
  const owing = R.customers.filter((c) => c.outstanding > 0);

  $('#page-home').innerHTML = `
    <header class="hdr"><div><h1>进销账</h1><p class="sub">上游进货 → 卖给下游 → 回款 → 扣税提现</p></div><span data-sync>${syncPill()}</span></header>
    ${reminders()}
    <div class="card hero">
      <div class="k">公司账户里现在最多能提到手</div>
      <div class="v num">${y(T.maxWithdrawNet)}</div>
      <div class="split num">
        <span>公司余额 ${y(T.companyBalance)}</span>
        <span>其中未扣税 ${y(T.untaxedBal)}</span>
        <span>待扣税 ${y(T.pendingTax)}</span>
      </div>
    </div>
    <div class="quick">
      <button class="btn" data-act="purchase">${icon('in')}记进货</button>
      <button class="btn" data-act="sale">${icon('out')}记销售</button>
      <button class="btn" data-act="receipt">${icon('cash')}记回款</button>
      <button class="btn" data-act="withdraw">${icon('withdraw')}提现</button>
    </div>
    <div class="grid">
      <div class="stat tap" data-goto="receipt"><div class="k">下游还欠</div><div class="v num">${y(T.receivable)}</div><div class="d">${owing.length} 家没回清</div></div>
      <div class="stat"><div class="k">已到手</div><div class="v num">${y(T.cashInHand)}</div><div class="d">个人账户 ${y(T.personalIn)} + 已提 ${y(T.withdrawNet)}</div></div>
      <div class="stat"><div class="k">累计销售额</div><div class="v num">${y(T.revenue)}</div><div class="d">本月 ${y(mRevenue)}</div></div>
      <div class="stat"><div class="k">毛利（销售 − 进价）</div><div class="v num">${y(T.grossProfit)}</div><div class="d">进货共 ${y(T.purchaseTotal)}</div></div>
      <div class="stat"><div class="k">已扣税</div><div class="v num">${y(T.taxPaid)}</div><div class="d">个人 ${y(T.personalTax)} · 月扣 ${y(T.taxRunTotal)} · 提现 ${y(T.withdrawTax)}</div></div>
      <div class="stat"><div class="k">税后利润（估）</div><div class="v num">${y(T.netProfitEst)}</div><div class="d">把待扣、应收将扣的税也算上</div></div>
    </div>
    <div class="card">
      <h3>谁还欠钱 <span class="muted">按金额排</span></h3>
      ${owing.length ? `<ul class="list">${owing.slice(0, 6).map((c) => `
        <li class="item" data-act="receipt" data-customer="${esc(c.name)}">
          <div class="l"><div class="t">${esc(c.name)}</div><div class="s">最早一笔 ${esc(c.oldest)} 起没回 · 共卖 ${y(c.total)}</div></div>
          <div class="r"><div class="amt num">${y(c.outstanding)}</div><div class="s">点这里记回款</div></div>
        </li>`).join('')}</ul>` : '<div class="empty">没有欠款</div>'}
    </div>
    ${state.sales.length || state.purchases.length ? '' : `
    <div class="card explain">
      <p><b>从哪开始：</b>先记一笔进货（从上游进了什么、多少钱），再记卖给下游的销售，下游打钱来时记回款。</p>
    </div>`}
  `;
}

function renderTrade() {
  const seg = `<div class="seg">
    ${[['sales', '销售'], ['purchases', '进货'], ['stock', '库存 / 毛利']].map(([k, l]) => `<button data-seg="${k}" class="${tradeView === k ? 'on' : ''}">${l}</button>`).join('')}
  </div>`;
  let body = '';
  if (tradeView === 'sales') {
    const items = [...R.sales].sort(byDateDesc).map((s) => ({
      date: s.date, html: `
      <li class="item" data-edit="sale" data-id="${s.id}">
        <div class="l"><div class="t">${esc(s.customer)}</div><div class="s">${esc(s.product)} ${s.qty} × ${yy(s.price)} · 进价 ${+s.unitCost.toFixed(4)} · 税 ${y(s.taxFull)}${s.note ? ' · ' + esc(s.note) : ''}</div></div>
        <div class="r"><div class="amt num">${y(s.total)}</div>${salePill(s)}</div>
      </li>` }));
    body = `<div class="card"><ul class="list">${items.length ? groupByDate(items) : '<li class="empty">还没有销售记录</li>'}</ul></div>`;
  } else if (tradeView === 'purchases') {
    const items = [...state.purchases].sort(byDateDesc).map((p) => ({
      date: p.date, html: `
      <li class="item" data-edit="purchase" data-id="${p.id}">
        <div class="l"><div class="t">${esc(p.supplier)}</div><div class="s">${esc(p.product)} ${p.qty} × ${yy(p.price)}${p.note ? ' · ' + esc(p.note) : ''}</div></div>
        <div class="r"><div class="amt num">${yy(purchaseAmount(p))}</div></div>
      </li>` }));
    body = `<div class="card"><ul class="list">${items.length ? groupByDate(items) : '<li class="empty">还没有进货记录</li>'}</ul></div>`;
  } else {
    body = `<div class="card"><h3>按品种 <span class="muted">进价按加权平均</span></h3>
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
    <header class="hdr"><div><h1>进销</h1><p class="sub">从上游进、卖给下游，每笔销售就是一笔应收</p></div>
      <div class="btn-row"><button class="btn sm" data-act="purchase">+ 进货</button><button class="btn sm primary" data-act="sale">+ 销售</button></div></header>
    ${demoBanner()}${seg}${body}`;
}

function renderReceipts() {
  const owing = R.customers.filter((c) => c.outstanding > 0);
  const items = [...state.receipts].sort(byDateDesc).map((r0) => {
    const r = R.receipts.get(r0.id);
    const n = (r0.allocations || []).length;
    const sub = r0.account === ACCOUNT.PERSONAL
      ? `核销 ${y(r.grossC)} · 扣税 ${y(r.taxC)}`
      : `核销 ${y(r.grossC)}${r.unallocated ? ` · <span style="color:var(--warn)">${y(r.unallocated)} 没对上销售</span>` : ''}`;
    return { date: r0.date, html: `
      <li class="item" data-edit="receipt" data-id="${r0.id}">
        <div class="l"><div class="t">${esc(r0.customer)} ${acctPill(r0.account)}</div><div class="s">${sub} · ${n > 1 ? `合并 ${n} 笔销售` : n === 1 ? '1 笔销售' : '未核销'}${r0.note ? ' · ' + esc(r0.note) : ''}</div></div>
        <div class="r"><div class="amt num">${y(r.amountC)}</div><div class="s">到账</div></div>
      </li>` };
  });
  $('#page-receipt').innerHTML = `
    <header class="hdr"><div><h1>回款</h1><p class="sub">一笔回款可以同时核销多笔销售</p></div>
      <button class="btn sm primary" data-act="receipt">+ 回款</button></header>
    ${demoBanner()}
    <div class="card">
      <h3>应收 <span class="muted">共 ${y(R.totals.receivable)}</span></h3>
      ${owing.length ? `<ul class="list">${owing.map((c) => `
        <li class="item" data-act="receipt" data-customer="${esc(c.name)}">
          <div class="l"><div class="t">${esc(c.name)}</div><div class="s">已回 ${y(c.settled)} / 共 ${y(c.total)} · 最早 ${esc(c.oldest)}</div></div>
          <div class="r"><div class="amt num">${y(c.outstanding)}</div></div>
        </li>`).join('')}</ul>` : '<div class="empty">都回清了</div>'}
    </div>
    <div class="card"><h3>回款记录</h3><ul class="list">${items.length ? groupByDate(items) : '<li class="empty">还没有回款记录</li>'}</ul></div>`;
}

function renderCompany() {
  const T = R.totals;
  const tot = Math.max(1, T.companyBalance);
  const lots = [...R.lots].reverse();
  const flow = [...R.flow].reverse();
  $('#page-company').innerHTML = `
    <header class="hdr"><div><h1>公司账户</h1><p class="sub">回到公司的钱先不扣税，每月统一扣；提现时没扣过的要先扣</p></div></header>
    ${reminders()}
    <div class="card">
      <div class="muted small">账户余额</div>
      <div class="num" style="font-size:28px;font-weight:700">${y(T.companyBalance)}</div>
      <div class="bar"><i style="width:${(T.taxedBal / tot) * 100}%;background:var(--accent)"></i><i style="width:${(T.untaxedBal / tot) * 100}%;background:var(--warn)"></i></div>
      <div class="legend num"><span><b style="background:var(--accent)"></b>已扣税 ${y(T.taxedBal)}（可全额提）</span><span><b style="background:var(--warn)"></b>未扣税 ${y(T.untaxedBal)}（待扣 ${y(T.pendingTax)}）</span></div>
      <div class="calc" style="margin:12px 0 10px">
        <div class="ln"><span>已扣税部分，全提</span><span class="num">${y(T.taxedBal)}</span></div>
        <div class="ln"><span>未扣税部分，扣完税再提</span><span class="num">${y(T.untaxedBal - T.pendingTax)}</span></div>
        <div class="ln total"><span>最多能提到手</span><span class="num">${y(T.maxWithdrawNet)}</span></div>
      </div>
      <div class="two"><button class="btn" data-act="taxrun">${icon('tax')}月度扣税</button><button class="btn primary" data-act="withdraw">${icon('withdraw')}提现</button></div>
    </div>
    <div class="card">
      <h3>每笔回款的状态 <span class="muted">先进先出</span></h3>
      ${lots.length ? `<ul class="list">${lots.map((l) => `
        <li class="item" data-edit="receipt" data-id="${l.receiptId}">
          <div class="l"><div class="t">${esc(l.customer)} ${l.taxed ? '<span class="pill taxed">已扣税</span>' : '<span class="pill untaxed">未扣税</span>'}</div>
            <div class="s">${esc(l.date)} 到账 ${y(l.original)} · 税负 ${pct(l.rate)}</div></div>
          <div class="r"><div class="amt num">${y(l.remaining)}</div><div class="s">${l.remaining ? '还在账上' : '已用完'}</div></div>
        </li>`).join('')}</ul>` : '<div class="empty">还没有回到公司的钱</div>'}
    </div>
    <div class="card">
      <h3>流水</h3>
      ${flow.length ? `<ul class="list">${flow.map((f) => `
        <li class="item" data-edit="${f.kind === '回款' ? 'receipt' : f.kind === '扣税' ? 'taxrun' : 'withdraw'}" data-id="${f.ref}">
          <div class="l"><div class="t">${f.kind}</div><div class="s">${esc(f.date)} · ${esc(f.text)}</div></div>
          <div class="r"><div class="amt num" style="color:${f.delta >= 0 ? 'var(--good)' : 'var(--text)'}">${f.delta >= 0 ? '+' : '−'}${fmt(Math.abs(f.delta))}</div><div class="s num">余 ${fmt(f.balance)}</div></div>
        </li>`).join('')}</ul>` : '<div class="empty">暂无流水</div>'}
    </div>`;
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
      <p class="small muted" style="margin:0">改了税率，以前所有回款、扣税、提现都会按新税率重算。如果中途税率变过，先导出备份再改。</p>
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
      <p><b>扣多少税跟着差价走：</b>每笔销售记一个进价。进价 1、卖 1.5、200 件，全部回款要扣 300×1% + 100×13% = 16。合并回款时，核销到哪笔销售就按哪笔的差价算。</p>
      <p><b>回个人账户：</b>到账就是扣完税的钱。上面那笔回到个人，到账 284，系统反推核销了 300 应收、扣税 16。</p>
      <p><b>回公司账户：</b>全额进账，标「未扣税」。每月做一次「月度扣税」，把上月及以前的未税余额扣税，标「已扣税」。</p>
      <p><b>从公司提现：</b>先提已扣税的钱，一分不少；不够再动未扣税的钱，这部分边提边扣税。提走的部分月底就不会再扣一次。</p>
      <p><b>删改任何一笔都安全：</b>余额、扣税、提现都是按时间顺序重新算出来的。</p>
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
  const seg = e.target.closest('[data-seg]');
  if (seg) { tradeView = seg.dataset.seg; return render(); }
  const go = e.target.closest('[data-goto]');
  if (go) { tab = go.dataset.goto; return render(); }
  const act = e.target.closest('[data-act]');
  if (act) {
    const a = act.dataset.act;
    if (a === 'purchase') return purchaseForm();
    if (a === 'sale') return saleForm();
    if (a === 'receipt') return receiptForm(null, act.dataset.customer);
    if (a === 'taxrun') return taxRunForm();
    if (a === 'withdraw') return withdrawForm();
    if (a === 'exit-demo') return exitDemo();
  }
  const ed = e.target.closest('[data-edit]');
  if (ed) {
    const { edit, id } = ed.dataset;
    if (edit === 'sale') return saleForm(state.sales.find((x) => x.id === id));
    if (edit === 'purchase') return purchaseForm(state.purchases.find((x) => x.id === id));
    if (edit === 'receipt') return receiptForm(state.receipts.find((x) => x.id === id));
    if (edit === 'taxrun') return taxRunForm(state.taxRuns.find((x) => x.id === id));
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

// ---------- 进货 / 销售 ----------
function tradeFields(kind, rec) {
  const partyLabel = kind === 'sale' ? '下游公司' : '上游公司';
  const partyKey = kind === 'sale' ? 'customer' : 'supplier';
  const parties = kind === 'sale' ? names(state.sales, 'customer') : names(state.purchases, 'supplier');
  const products = [...new Set([...names(state.purchases, 'product'), ...names(state.sales, 'product')])];
  return `
    <div class="two">
      <div class="f"><label>日期</label><input class="inp" type="date" id="f-date" value="${esc(rec?.date || today())}"></div>
      <div class="f"><label>品种</label><input class="inp" id="f-product" list="dl-prod" value="${esc(rec?.product || '')}" placeholder="比如 甲"></div>
    </div>
    <div class="f"><label>${partyLabel}</label><input class="inp" id="f-party" list="dl-party" value="${esc(rec?.[partyKey] || '')}" placeholder="名字"></div>
    <div class="two">
      <div class="f"><label>数量</label><input class="inp" type="number" inputmode="decimal" id="f-qty" value="${rec?.qty ?? ''}"></div>
      <div class="f"><label>${kind === 'sale' ? '售价' : '进价'}（元/件）</label><input class="inp" type="number" inputmode="decimal" step="0.01" id="f-price" value="${rec?.price ?? ''}"></div>
    </div>
    ${kind === 'sale' ? `<div class="f"><label>这批货的进价（元/件） <span class="tip">默认填该品种平均进价，用来算差价税</span></label>
      <input class="inp" type="number" inputmode="decimal" step="0.0001" id="f-cost" value="${rec?.cost ?? ''}"></div>` : ''}
    <div class="calc" id="f-calc"></div>
    <div class="f"><label>备注 <span class="tip">选填</span></label><input class="inp" id="f-note" value="${esc(rec?.note || '')}" placeholder="批号、票号…"></div>
    <button class="btn primary block" id="f-save">保存</button>${delBtn(rec)}
    ${datalist('dl-party', parties)}${datalist('dl-prod', products)}`;
}

function purchaseForm(rec) {
  openSheet(rec ? '改进货' : '记进货', tradeFields('purchase', rec), (root) => {
    const calc = () => {
      const qty = num(root, '#f-qty') || 0, price = num(root, '#f-price') || 0;
      $('#f-calc', root).innerHTML = `<div class="ln total"><span>进货金额</span><span class="num">${yy(qty * price)}</span></div>`;
    };
    root.addEventListener('input', calc); calc();
    $('#f-save', root).onclick = () => {
      const r = { id: rec?.id || uid(), date: $('#f-date', root).value, supplier: $('#f-party', root).value.trim(), product: $('#f-product', root).value.trim(), qty: num(root, '#f-qty'), price: num(root, '#f-price'), note: $('#f-note', root).value.trim() };
      if (!r.date || !r.supplier || !r.product || !(r.qty > 0) || !(r.price >= 0)) return toast('日期、上游、品种、数量、单价都要填');
      upsert(state.purchases, r); save(); closeSheet(); toast('已记进货');
    };
    if (rec) $('#f-del', root).onclick = async () => { if (await ask('删除这笔进货？', '删除', true)) { remove(state.purchases, rec.id); save(); closeSheet(); } };
  });
}

function saleForm(rec) {
  openSheet(rec ? '改销售' : '记销售', tradeFields('sale', rec), (root) => {
    const avg = avgCosts(state);
    // 进价没手动改过，就跟着品种自动填平均进价
    let costTouched = rec?.cost != null && rec.cost !== '';
    $('#f-cost', root).addEventListener('input', () => { costTouched = $('#f-cost', root).value !== ''; });
    const fillCost = () => {
      if (costTouched) return;
      const a = avg.get($('#f-product', root).value.trim());
      $('#f-cost', root).value = a != null ? +a.toFixed(4) : '';
    };
    $('#f-product', root).addEventListener('input', fillCost);
    fillCost();

    const calc = () => {
      const qty = num(root, '#f-qty') || 0, price = num(root, '#f-price') || 0;
      const cost = num(root, '#f-cost');
      const p = R.products.find((x) => x.name === $('#f-product', root).value.trim());
      const amt = toCents(qty * price);
      let html = `<div class="ln total"><span>销售金额（应收）</span><span class="num">${y(amt)}</span></div>`;
      if (p && p.inQty) {
        const stock = p.stock + (rec && rec.product === p.name ? Number(rec.qty) : 0);
        html += `<div class="ln"><span>库存</span><span class="num ${stock < qty ? 'bad' : ''}">${stock}${stock < qty ? '（不够）' : ''}</span></div>`;
      }
      if (Number.isFinite(cost) && amt) {
        const b = saleTaxBreakdown({ qty, price }, cost, R.settings);
        const cogs = toCents(cost * qty);
        html += `<div class="ln"><span>差价 (${price} − ${cost}) × ${qty}</span><span class="num">${y(amt - cogs)}</span></div>
          <div class="ln"><span>回款时扣：回款额 × ${pct(R.settings.revenueRate)}</span><span class="num">${y(b.revenueTax)}</span></div>
          <div class="ln"><span>　　　　+ 差价 × ${pct(R.settings.marginRate)}</span><span class="num">${y(b.marginTax)}</span></div>
          <div class="ln total"><span>扣税 ${y(b.tax)}，税后赚</span><span class="num">${y(amt - cogs - b.tax)}</span></div>`;
      } else if (amt) {
        html += '<div class="ln warn"><span>没填进价，差价税会按全部销售额算</span></div>';
      }
      if (rec) {
        const s = R.salesById.get(rec.id);
        if (s?.settled) html += `<div class="ln warn"><span>这笔已回款</span><span class="num">${y(s.settled)}</span></div>`;
      }
      $('#f-calc', root).innerHTML = html;
    };
    root.addEventListener('input', calc); calc();
    $('#f-save', root).onclick = () => {
      const cost = num(root, '#f-cost');
      const r = { id: rec?.id || uid(), date: $('#f-date', root).value, customer: $('#f-party', root).value.trim(), product: $('#f-product', root).value.trim(), qty: num(root, '#f-qty'), price: num(root, '#f-price'), cost: Number.isFinite(cost) ? cost : null, note: $('#f-note', root).value.trim() };
      if (!r.date || !r.customer || !r.product || !(r.qty > 0) || !(r.price >= 0)) return toast('日期、下游、品种、数量、售价都要填');
      if (r.cost != null && r.cost < 0) return toast('进价不能是负数');
      const s = rec && R.salesById.get(rec.id);
      if (s && s.settled > toCents(saleAmount(r))) return toast(`这笔已回款 ${y(s.settled)}，金额不能改得比它小`);
      if (s && s.settled && r.customer !== rec.customer) return toast('这笔已有回款，不能换下游；先删回款');
      upsert(state.sales, r); save(); closeSheet(); toast('已记销售');
    };
    if (rec) $('#f-del', root).onclick = async () => {
      const used = state.receipts.filter((x) => (x.allocations || []).some((a) => a.saleId === rec.id));
      if (used.length) return toast(`有 ${used.length} 笔回款核销了这笔销售，先删或改那些回款`);
      if (await ask('删除这笔销售？', '删除', true)) { remove(state.sales, rec.id); save(); closeSheet(); }
    };
  });
}

// ---------- 回款 ----------
function receiptForm(rec, presetCustomer) {
  let account = rec?.account || ACCOUNT.COMPANY;
  let customer = rec?.customer || presetCustomer || '';
  let alloc = new Map((rec?.allocations || []).map((a) => [a.saleId, a.amount]));
  const customers = names(state.sales, 'customer');

  openSheet(rec ? '改回款' : '记回款', `
    <div class="two">
      <div class="f"><label>到账日期</label><input class="inp" type="date" id="f-date" value="${esc(rec?.date || today())}"></div>
      <div class="f"><label>哪家回的</label><input class="inp" id="f-cust" list="dl-cust" value="${esc(customer)}" placeholder="下游公司"></div>
    </div>
    <div class="f"><label>回到哪个账户</label>
      <div class="acct">
        <button type="button" data-v="company"><b>公司账户</b><small>全额到账，先不扣税<br>月底统一扣</small></button>
        <button type="button" data-v="personal"><b>个人账户</b><small>到账的已经是<br>扣完增值税的钱</small></button>
      </div></div>
    <div class="f"><label>实际到账金额（元）</label><input class="inp" type="number" inputmode="decimal" step="0.01" id="f-amt" value="${rec?.amount ?? ''}" placeholder="银行里看到的数"></div>
    <div class="lbl" style="display:flex;justify-content:space-between;align-items:center">核销哪几笔销售 <button class="btn sm" type="button" id="f-auto">按到账自动分</button></div>
    <div class="alloc" id="f-alloc"></div>
    <div class="calc" id="f-calc"></div>
    <div class="f"><label>备注 <span class="tip">选填</span></label><input class="inp" id="f-note" value="${esc(rec?.note || '')}"></div>
    <button class="btn primary block" id="f-save">保存</button>${delBtn(rec)}
    ${datalist('dl-cust', customers)}`, (root) => {

    const amount = () => num(root, '#f-amt') || 0;
    const rates = saleRates(state);

    const paintAcct = () => root.querySelectorAll('.acct button').forEach((b) => b.classList.toggle('on', b.dataset.v === account));

    const paintAlloc = () => {
      const open = customer ? openSalesFor(state, customer, rec?.id) : [];
      // 编辑时，已核销过但现在不在"未回清"列表里的销售也要显示
      const ids = new Set(open.map((o) => o.sale.id));
      const extra = [...alloc.keys()].filter((id) => !ids.has(id)).map((id) => state.sales.find((s) => s.id === id)).filter(Boolean)
        .map((s) => ({ sale: s, outstanding: toCents(saleAmount(s)) }));
      const rows = [...open, ...extra];
      $('#f-alloc', root).innerHTML = rows.length ? rows.map((o) => `
        <div class="alloc-row">
          <div><div>${esc(o.sale.date)} ${esc(o.sale.product)} ${o.sale.qty}×${o.sale.price}</div><div class="s">还欠 ${y(o.outstanding)} · 进价 ${+rates.get(o.sale.id).cost.toFixed(4)}，税负 ${pct(rates.get(o.sale.id).rate)}</div></div>
          <input class="inp sm num" type="number" inputmode="decimal" step="0.01" data-sale="${o.sale.id}" data-max="${o.outstanding}" data-rate="${rates.get(o.sale.id).rate}" value="${alloc.get(o.sale.id) ?? ''}" placeholder="0">
        </div>`).join('') : `<div class="empty">${customer ? '这家没有未回清的销售' : '先填是哪家回的'}</div>`;
      paintCalc();
    };

    const paintCalc = () => {
      let gross = 0, ruleTax = 0, over = false;
      root.querySelectorAll('[data-sale]').forEach((i) => {
        const c = toCents(i.value);
        if (c > Number(i.dataset.max)) over = true;
        gross += c;
        ruleTax += Math.round(c * Number(i.dataset.rate));
      });
      const amt = toCents(amount());
      let html = `<div class="ln"><span>核销应收合计</span><span class="num">${y(gross)}</span></div>`;
      if (account === ACCOUNT.PERSONAL) {
        const tax = gross - amt;
        html += `<div class="ln"><span>到账</span><span class="num">${y(amt)}</span></div>
          <div class="ln total"><span>其中被扣的税</span><span class="num">${y(Math.max(0, tax))}</span></div>`;
        if (gross && Math.abs(gross - ruleTax - amt) > 100) html += `<div class="ln warn"><span>按规则应扣 ${y(ruleTax)}、到账 ${y(gross - ruleTax)}，和实际差 ${y(Math.abs(gross - ruleTax - amt))}</span></div>`;
      } else {
        html += `<div class="ln total"><span>公司账户 +${fmt(amt)}</span><span class="pill untaxed">未扣税</span></div>
          <div class="ln"><span>以后要扣的税（月度扣税或提现时）</span><span class="num">${y(ruleTax)}</span></div>`;
        if (gross !== amt && amt) html += `<div class="ln warn"><span>${gross < amt ? `有 ${y(amt - gross)} 没对上销售（多付 / 预付？）` : `核销比到账多 ${y(gross - amt)}`}</span></div>`;
      }
      if (over) html += '<div class="ln bad"><span>有一笔核销超过了它的欠款</span></div>';
      $('#f-calc', root).innerHTML = html;
    };

    const auto = () => {
      const fn = account === ACCOUNT.PERSONAL ? autoAllocateNet : autoAllocate;
      alloc = new Map(fn(state, customer, amount(), rec?.id).map((a) => [a.saleId, a.amount]));
      paintAlloc();
    };

    paintAcct(); paintAlloc();

    root.querySelectorAll('.acct button').forEach((b) => (b.onclick = () => { account = b.dataset.v; paintAcct(); if (amount()) auto(); else paintCalc(); }));
    $('#f-cust', root).addEventListener('change', (e) => { customer = e.target.value.trim(); alloc = new Map(); if (amount()) auto(); else paintAlloc(); });
    $('#f-amt', root).addEventListener('input', () => auto());
    $('#f-auto', root).onclick = auto;
    $('#f-alloc', root).addEventListener('input', (e) => {
      const i = e.target.closest('[data-sale]');
      if (i) { alloc.set(i.dataset.sale, i.value === '' ? undefined : parseFloat(i.value)); paintCalc(); }
    });

    $('#f-save', root).onclick = () => {
      customer = $('#f-cust', root).value.trim();
      const allocations = [];
      let over = false;
      root.querySelectorAll('[data-sale]').forEach((i) => {
        const c = toCents(i.value);
        if (c > Number(i.dataset.max)) over = true;
        if (c > 0) allocations.push({ saleId: i.dataset.sale, amount: toYuan(c) });
      });
      const r = { id: rec?.id || uid(), date: $('#f-date', root).value, customer, account, amount: amount(), allocations, note: $('#f-note', root).value.trim() };
      if (!r.date || !r.customer || !(r.amount > 0)) return toast('日期、哪家、到账金额要填');
      if (over) return toast('有一笔核销超过了它的欠款');
      if (r.account === ACCOUNT.PERSONAL && toCents(receiptGross(r)) < toCents(r.amount)) return toast('个人账户到账比核销还多？核对一下金额');
      upsert(state.receipts, r); save(); closeSheet();
      toast(r.allocations.length > 1 ? `已记回款，合并核销 ${r.allocations.length} 笔销售` : '已记回款');
    };
    if (rec) $('#f-del', root).onclick = async () => { if (await ask('删除这笔回款？后面的扣税、提现会自动重算。', '删除', true)) { remove(state.receipts, rec.id); save(); closeSheet(); } };
  });
}

// ---------- 月度扣税 ----------
function taxRunForm(rec) {
  const last = prevMonth(today());
  const ym = rec ? rec.cutoff.slice(0, 7) : last;
  openSheet(rec ? '月度扣税记录' : '月度扣税', `
    <p class="small muted" style="margin-top:0">把公司账户里截止到这个月底、还没扣过税的余额扣掉增值税。扣完这些钱就是「已扣税」，以后可以全额提。</p>
    <div class="two">
      <div class="f"><label>扣哪个月及以前的</label><input class="inp" type="month" id="f-ym" value="${esc(ym)}"></div>
      <div class="f"><label>扣款日期</label><input class="inp" type="date" id="f-date" value="${esc(rec?.date || today())}"></div>
    </div>
    <div class="calc" id="f-calc"></div>
    <div class="f"><label>备注 <span class="tip">选填</span></label><input class="inp" id="f-note" value="${esc(rec?.note || '')}"></div>
    <button class="btn primary block" id="f-save">${rec ? '保存' : '确认扣税'}</button>${delBtn(rec)}`, (root) => {
    const others = { ...state, taxRuns: state.taxRuns.filter((t) => t.id !== rec?.id) };
    const calc = () => {
      const cutoff = monthEnd($('#f-ym', root).value || last);
      const date = $('#f-date', root).value || today();
      const p = previewTaxRun(others, cutoff, date);
      $('#f-calc', root).innerHTML = p.details.length ? `
        ${p.details.map((d) => { const rc = state.receipts.find((x) => x.id === d.receiptId); return `<div class="ln"><span>${esc(rc?.date)} ${esc(rc?.customer)} 未税余额 ${y(d.base)}</span><span class="num">−${fmt(d.tax)}</span></div>`; }).join('')}
        <div class="ln total"><span>${cutoff} 前共 ${p.details.length} 笔，扣税</span><span class="num">${y(p.tax)}</span></div>`
        : `<div class="ln"><span>${cutoff} 前没有未扣税的余额</span></div>`;
      if (date < cutoff) $('#f-calc', root).innerHTML += '<div class="ln warn"><span>扣款日期早于月底，月底前那几天到的钱不会算进来</span></div>';
    };
    root.addEventListener('input', calc); calc();
    $('#f-save', root).onclick = () => {
      const r = { id: rec?.id || uid(), date: $('#f-date', root).value, cutoff: monthEnd($('#f-ym', root).value), note: $('#f-note', root).value.trim() };
      if (!r.date || !$('#f-ym', root).value) return toast('月份和日期要填');
      if (!rec && !previewTaxRun(others, r.cutoff, r.date).details.length) return toast('没有要扣税的余额');
      upsert(state.taxRuns, r); save(); closeSheet(); toast('已扣税');
    };
    if (rec) $('#f-del', root).onclick = async () => { if (await ask('删除这次扣税？对应的钱会变回「未扣税」。', '删除', true)) { remove(state.taxRuns, rec.id); save(); closeSheet(); } };
  });
}

// ---------- 提现 ----------
function withdrawForm(rec) {
  const others = { ...state, withdrawals: state.withdrawals.filter((w) => w.id !== rec?.id) };
  openSheet(rec ? '提现记录' : '从公司提现', `
    <div class="two">
      <div class="f"><label>日期</label><input class="inp" type="date" id="f-date" value="${esc(rec?.date || today())}"></div>
      <div class="f"><label>想拿到手（元）</label><input class="inp" type="number" inputmode="decimal" step="0.01" id="f-net" value="${rec?.net ?? ''}"></div>
    </div>
    <div class="btn-row" style="margin:-4px 0 12px"><button class="btn sm" type="button" id="f-all">全部提出</button><button class="btn sm" type="button" id="f-taxed">只提已扣税的</button></div>
    <div class="calc" id="f-calc"></div>
    <div class="f"><label>备注 <span class="tip">选填</span></label><input class="inp" id="f-note" value="${esc(rec?.note || '')}"></div>
    <button class="btn primary block" id="f-save">${rec ? '保存' : '确认提现'}</button>${delBtn(rec)}`, (root) => {
    const at = () => compute({ ...others, receipts: others.receipts.filter((x) => x.date <= ($('#f-date', root).value || today())), taxRuns: others.taxRuns.filter((x) => x.date <= ($('#f-date', root).value || today())), withdrawals: others.withdrawals.filter((x) => x.date <= ($('#f-date', root).value || today())) }).totals;
    const calc = () => {
      const T = at();
      const net = num(root, '#f-net') || 0;
      let html = `<div class="ln"><span>当天可提：已扣税 ${y(T.taxedBal)} + 未扣税 ${y(T.untaxedBal)}</span></div>
        <div class="ln"><span>最多到手</span><span class="num">${y(T.maxWithdrawNet)}</span></div>`;
      if (net > 0) {
        const w = previewWithdrawal(others, net, $('#f-date', root).value || today());
        const fromTaxed = w.parts.filter((p) => p.taxed).reduce((s, p) => s + p.gross, 0);
        const fromUntaxed = w.parts.filter((p) => !p.taxed).reduce((s, p) => s + p.gross, 0);
        html += `<div class="ln total"><span>从公司划出</span><span class="num">${y(w.gross)}</span></div>
          <div class="ln"><span>· 已扣税的钱，直接提</span><span class="num">${y(fromTaxed)}</span></div>
          <div class="ln"><span>· 未扣税的钱，要先扣税</span><span class="num">${y(fromUntaxed)}</span></div>
          <div class="ln"><span>本次扣增值税</span><span class="num">${y(w.tax)}</span></div>
          <div class="ln total"><span>到手</span><span class="num">${y(w.net)}</span></div>`;
        if (w.shortfall > 0) html += `<div class="ln bad"><span>余额不够，还差 ${y(w.shortfall)}</span></div>`;
      }
      $('#f-calc', root).innerHTML = html;
    };
    root.addEventListener('input', calc); calc();
    $('#f-all', root).onclick = () => { $('#f-net', root).value = toYuan(at().maxWithdrawNet); calc(); };
    $('#f-taxed', root).onclick = () => { $('#f-net', root).value = toYuan(at().taxedBal); calc(); };
    $('#f-save', root).onclick = () => {
      const r = { id: rec?.id || uid(), date: $('#f-date', root).value, net: num(root, '#f-net'), note: $('#f-note', root).value.trim() };
      if (!r.date || !(r.net > 0)) return toast('日期和金额要填');
      const w = previewWithdrawal(others, r.net, r.date);
      if (w.shortfall > 0) return toast(`余额不够，最多能提到手 ${y(w.net)}`);
      upsert(state.withdrawals, r); save(); closeSheet();
      toast(w.tax ? `已提现，扣税 ${y(w.tax)}` : '已提现');
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
    { id: 's1', date: d(lm, 3), customer: '仁和医院', product: '甲', qty: 80, price: 1.5, cost: 1, note: '' },
    { id: 's2', date: d(lm, 4), customer: '仁和医院', product: '甲', qty: 60, price: 1.5, cost: 1, note: '' },
    { id: 's3', date: d(lm, 6), customer: '康宁大药房', product: '甲', qty: 60, price: 1.5, cost: 1, note: '' },
    { id: 's4', date: d(lm, 8), customer: '仁和医院', product: '乙', qty: 300, price: 11, cost: 8, note: '' },
    { id: 's5', date: d(lm, 12), customer: '康宁大药房', product: '乙', qty: 150, price: 11.3, cost: 8, note: '' },
  );
  s.receipts.push(
    // 仁和医院一次打 3510，合并核销三笔销售
    { id: 'r1', date: d(lm, 20), customer: '仁和医院', account: 'company', amount: 3510, allocations: [{ saleId: 's1', amount: 120 }, { saleId: 's2', amount: 90 }, { saleId: 's4', amount: 3300 }], note: '合并回款' },
    // 康宁回到个人账户，已扣税
    { id: 'r2', date: d(lm, 25), customer: '康宁大药房', account: 'personal', amount: 85.2, allocations: [{ saleId: 's3', amount: 90 }], note: '' },
    { id: 'r3', date: d(t.slice(0, 7), 3), customer: '康宁大药房', account: 'company', amount: 1000, allocations: [{ saleId: 's5', amount: 1000 }], note: '部分回款' },
  );
  return s;
}

render();
