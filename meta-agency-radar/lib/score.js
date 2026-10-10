// 评分引擎 v2。Node 和浏览器共用（build.js 会去掉 export 内联进页面）。
// 原则：人或模型只判断检查项是否成立并挂证据；分数、红线核查、排名、概率全部由这里的代码算。

export const MODES = ['conservative', 'neutral', 'optimistic'];

export const DEFAULT_UNCERTAINTY = {
  n: 4000, // 模拟次数
  seed: 20261010,
  pB: 0.8, // 只有 B 级证据的检查项，按 80% 概率属实
  pNull: 0.5, // 查不到的检查项，按 50% 概率成立
  pAdverse: 0.25, // 查不到且有不利线索的检查项
  sigma: 0.25, // 维度权重随机浮动幅度（对数正态）
  sigmaCheck: 0.3, // 检查项分值随机浮动幅度（对数正态，维度内重新归一）
};

export const DIM_MAX = 5;
export const ROLE_BASE = { core: 3, standard: 2, weak: 1 };

// ---------- 证据 ----------

export function gradeOf(ev, fw) {
  return fw.evidence_grades.types[ev.type]?.grade ?? 'C';
}

function domainOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return null;
  }
}

// 一个检查项的有效状态：yes / no / unknown；strong = 有 A 级或双源印证。
// 只有 C 级证据支撑的「成立」不计分，按查不到处理。
export function checkState(answer, evById, fw) {
  const s = answer?.s ?? null;
  const evs = (answer?.ev || []).map((id) => evById[id]).filter(Boolean);
  const usable = evs.filter((e) => gradeOf(e, fw) !== 'C');
  const domains = new Set(usable.map((e) => domainOf(e.url)).filter(Boolean));
  const strong = usable.some((e) => gradeOf(e, fw) === 'A') || domains.size >= 2;
  if (s === true) {
    if (!usable.length) return { state: 'unknown', strong: false, adverse: !!answer.adverse, downgraded: true };
    return { state: 'yes', strong };
  }
  if (s === false) return { state: 'no', strong };
  return { state: 'unknown', strong: false, adverse: !!answer?.adverse };
}

// ---------- 检查项分值 ----------

// 维度内各检查项的分值：按份数比例分配满分 5。份数默认由角色定（核心 3 / 一般 2 / 次要 1），
// 页面里业务负责人重新分配时写在 alloc 上。
export function checkPoints(dim) {
  const base = dim.checks.map((c) => Math.max(0, Number(c.alloc ?? ROLE_BASE[c.role] ?? c.points ?? 1) || 0));
  const s = base.reduce((a, b) => a + b, 0) || 1;
  return Object.fromEntries(dim.checks.map((c, i) => [c.id, (base[i] / s) * DIM_MAX]));
}

// 分档检查项：成立时按档位系数计分；没写档位时按最低档。
export function tierOf(check, answer) {
  if (!check.tiers?.length) return null;
  const n = check.tiers.length;
  const i = Number.isInteger(answer?.tier) ? Math.max(0, Math.min(n - 1, answer.tier)) : 0;
  return { i, guessed: !Number.isInteger(answer?.tier), ...check.tiers[i] };
}

// 同组检查项（同一个事实可能同时满足）只全额计得分最高的一项，其余按 overlap 折算。
export function groupedSum(dim, earned) {
  const groups = dim.groups || [];
  const grouped = new Set(groups.flatMap((g) => g.checks));
  let total = 0;
  for (const c of dim.checks) if (!grouped.has(c.id)) total += earned[c.id] || 0;
  for (const g of groups) {
    const v = g.checks.map((id) => earned[id] || 0).sort((a, b) => b - a);
    total += (v[0] || 0) + (g.overlap ?? 0.5) * v.slice(1).reduce((a, b) => a + b, 0);
  }
  return total;
}

// 维度得分：分组折算后再按「全部成立」时的得分换算回满分 5，保证每个维度都是 0–5。
export function dimRaw(dim, earned, pts = checkPoints(dim)) {
  const full = groupedSum(dim, pts) || 1;
  return Math.min(DIM_MAX, (groupedSum(dim, earned) / full) * DIM_MAX);
}

// 维度的扣分项：风险信号成立时直接扣分（例：营运资金被占用，扣「财务与授信」）。
// 同一个事实只在一处扣：风险信号在维度里扣分，就不再影响红线核查。
export function deductionOf(company, dim, fw, evById = Object.fromEntries((company.evidence || []).map((e) => [e.id, e]))) {
  const list = (dim.deductions || []).filter((d) => checkState(company.checks?.[d.check], evById, fw).state === 'yes')
    .map((d) => ({ ...d, note: company.checks?.[d.check]?.note || '' }));
  return { points: list.reduce((a, d) => a + d.points, 0), list };
}

// ---------- 维度分 ----------

export function dimScore(company, dim, fw) {
  const evById = Object.fromEntries((company.evidence || []).map((e) => [e.id, e]));
  const cap = fw.scoring.cap_without_strong_evidence;
  const pts = checkPoints(dim);
  const lo = {}, hi = {};
  let known = 0, strongYes = false;
  const items = dim.checks.map((c) => {
    const ans = company.checks?.[c.id];
    const st = checkState(ans, evById, fw);
    const p = pts[c.id];
    const tier = st.state === 'yes' ? tierOf(c, ans) : null;
    let earned = 0;
    if (st.state === 'yes') {
      earned = p * (tier?.f ?? 1);
      lo[c.id] = hi[c.id] = earned;
      known += p;
      if (st.strong) strongYes = true;
    } else if (st.state === 'no') {
      known += p;
    } else {
      hi[c.id] = p;
    }
    return { check: c, points: p, tier, earned, answer: ans || {}, ...st };
  });
  const raw = r2(dimRaw(dim, lo, pts));
  const capped = !strongYes && raw > cap;
  const ded = deductionOf(company, dim, fw, evById);
  const low = Math.max(0, (capped ? cap : raw) - ded.points);
  const high = Math.max(low, r2(dimRaw(dim, hi, pts)) - ded.points);
  return { dim, items, raw, lo: low, hi: high, mid: (low + high) / 2, capped, strongYes, deduct: ded.points, deductions: ded.list, allUnknown: known === 0, coverage: known / DIM_MAX };
}

export function pointOf(ds, mode) {
  return mode === 'optimistic' ? ds.hi : mode === 'neutral' ? ds.mid : ds.lo;
}

export function normalizeWeights(dims, weights) {
  const raw = dims.map((d) => Math.max(0, Number(weights?.[d.id] ?? d.weight) || 0));
  const sum = raw.reduce((a, b) => a + b, 0) || 1;
  return Object.fromEntries(dims.map((d, i) => [d.id, raw[i] / sum]));
}

export function scoreCompany(company, fw, weights, mode = 'conservative', asOf) {
  const w = normalizeWeights(fw.dimensions, weights);
  const dims = {};
  let total = 0, low = 0, high = 0, cov = 0;
  for (const d of fw.dimensions) {
    const ds = dimScore(company, d, fw);
    dims[d.id] = ds;
    total += w[d.id] * pointOf(ds, mode) * 20;
    low += w[d.id] * ds.lo * 20;
    high += w[d.id] * ds.hi * 20;
    cov += w[d.id] * ds.coverage;
  }
  return { id: company.id, company, dims, total: r1(total), low: r1(low), high: r1(high), coverage: Math.round(cov * 100), gates: gatesOf(company, fw, asOf) };
}

export function contributions(scored, fw, weights, mode = 'conservative') {
  const w = normalizeWeights(fw.dimensions, weights);
  return fw.dimensions.map((d) => {
    const ds = scored.dims[d.id];
    return { dim: d, weight: w[d.id], point: pointOf(ds, mode), points: r1(w[d.id] * pointOf(ds, mode) * 20) };
  });
}

// ---------- 红线核查 ----------

// 证据日期（YYYY / YYYY-MM / YYYY-MM-DD）距 asOf 超过 months 个月算过时
export function isStale(published, asOf, months) {
  if (!published) return true;
  const m = String(published).match(/^(\d{4})(?:-(\d{1,2}))?/);
  if (!m) return true;
  const y = +m[1], mo = m[2] ? +m[2] : 6;
  const d = new Date(asOf || Date.now());
  return (d.getFullYear() - y) * 12 + (d.getMonth() + 1 - mo) > months;
}

// 红线核查：只有踩红线才一票否决，而且要有 A 级或双源证据；只有非官方来源时按「待核·有不利线索」处理。
// 资本偏弱、诉讼、对外表述不实不是红线：Meta 会附条件（保证金、保函、降额度、要求更正），在打分里体现。
export function gatesOf(company, fw, asOf) {
  const evById = Object.fromEntries((company.evidence || []).map((e) => [e.id, e]));
  const staleM = fw.scoring.stale_months ?? 36;
  const fresh = (id) => (company.checks?.[id]?.ev || []).map((x) => evById[x]).filter(Boolean).some((e) => gradeOf(e, fw) !== 'C' && !isStale(e.published, asOf, staleM));
  const st = (id) => checkState(company.checks?.[id], evById, fw);
  const isYes = (id) => st(id).state === 'yes';
  const isNo = (id) => st(id).state === 'no';
  const hard = (id, state) => { const x = st(id); return x.state === state && x.strong; };
  const adverse = (...ids) => ids.some((id) => st(id).adverse);
  const note = (id) => company.checks?.[id]?.note || '';
  const advNote = (...ids) => ids.map((id) => (st(id).adverse ? note(id) : '')).find(Boolean) || '';

  let fin;
  if (hard('gx1', 'yes')) fin = { state: 'fail', reason: note('gx1') || '失信被执行人、破产清算或被吊销（官方来源）' };
  else if (isYes('gx1')) fin = { state: 'pending_adverse', reason: `${note('gx1') || '有踩红线的报道'}；只有非官方来源，待核实` };
  else if (isYes('f1') || isYes('f2')) {
    const basis = isYes('f1') ? '上市公司，财报公开' : note('f2') || '有公开营收或大额机构融资';
    const recent = (isYes('f1') && fresh('f1')) || (isYes('f2') && fresh('f2'));
    const sig = isYes('gx2') ? '。营运资金占用信号不是红线，已在「财务与授信」里扣分' : '';
    if (!recent) fin = { state: 'pass_inferred', reason: `${basis}；但支撑证据都超过 ${staleM / 12} 年，近况未知` };
    else fin = { state: 'pass', reason: basis + sig };
  }
  else if (isNo('f4')) fin = { state: 'borderline', reason: `${note('f4') || '资本实力偏弱'}。不是红线，但 Meta 可能要求保证金、保函或降低授信额度` };
  else if (isYes('f4')) fin = { state: 'pass', reason: note('f4') || '资本实力达标' };
  else if (adverse('f4', 'gx1')) fin = { state: 'pending_adverse', reason: `${advNote('gx1', 'f4') || '有不利线索'}。线索未核实，派人核工商` };
  else fin = { state: 'pending', reason: '查不到注册资本、融资或营收信息；Meta 尽调时会要审计报表' };

  let comp;
  if (hard('k1', 'no')) comp = { state: 'fail', reason: note('k1') || '失信、经营异常或重大处罚（官方来源）' };
  else if (isNo('k1')) comp = { state: 'pending_adverse', reason: `${note('k1') || '有失信或处罚的报道'}；只有非官方来源，待核实` };
  else if (isNo('k3')) comp = { state: 'borderline', reason: `${note('k3') || '对外资质表述与官方目录不符'}。不是红线，但 Meta 会要求更正，并影响信任` };
  else if (isNo('k2')) comp = { state: 'borderline', reason: `${note('k2') || '有未结重大诉讼'}。不是红线，需要说明对经营的影响` };
  else if (isYes('k1')) comp = { state: 'pass', reason: '工商与司法核验无问题' };
  else if (isYes('f1')) comp = { state: 'pass_inferred', reason: '上市公司须持续披露重大处罚，未见相关公告；但未做工商与司法核验' };
  else if (adverse('k1')) comp = { state: 'pending_adverse', reason: `${advNote('k1') || '有不利线索'}。线索未核实` };
  else if (adverse('k2')) comp = { state: 'pending', reason: `${note('k2')}。诉讼不属于红线，未做工商与司法核验` };
  else comp = { state: 'pending', reason: '未接入工商与司法数据，暂无不利线索' };

  const p = (g) => fw.gates.states[g.state].p;
  return { gate_fin: fin, gate_comp: comp, p: p(fin) * p(comp), passedAll: fin.state === 'pass' && comp.state === 'pass', failed: fin.state === 'fail' || comp.state === 'fail' };
}

// ---------- 排名 ----------

export function rank(companies, fw, weights, mode) {
  return companies
    .map((c) => scoreCompany(c, fw, weights, mode))
    .sort((a, b) => b.total - a.total)
    .map((r, i) => ({ ...r, rank: i + 1 }));
}

// ---------- 排名概率（蒙特卡洛） ----------

function mulberry32(a) {
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function monteCarlo(companies, fw, weights, opts = {}) {
  const o = { ...DEFAULT_UNCERTAINTY, ...opts };
  const rnd = mulberry32(o.seed);
  const gauss = () => Math.sqrt(-2 * Math.log(rnd() + 1e-12)) * Math.cos(2 * Math.PI * rnd());
  const dims = fw.dimensions;
  const base = dims.map((d) => Math.max(0, Number(weights?.[d.id] ?? d.weight) || 0));
  const cap = fw.scoring.cap_without_strong_evidence;
  const gateP = (st) => o.gateP?.[st] ?? fw.gates.states[st].p;

  // 预先算好每家每个检查项的状态
  const basePts = dims.map((d) => checkPoints(d));
  const prepared = companies.map((c) => {
    const evById = Object.fromEntries((c.evidence || []).map((e) => [e.id, e]));
    const g = gatesOf(c, fw, o.asOf);
    return {
      id: c.id,
      gp: gateP(g.gate_fin.state) * gateP(g.gate_comp.state),
      dims: dims.map((d) => d.checks.map((ch) => {
        const st = checkState(c.checks?.[ch.id], evById, fw);
        return { id: ch.id, f: st.state === 'yes' ? tierOf(ch, c.checks?.[ch.id])?.f ?? 1 : 1, ...st };
      })),
      ded: dims.map((d) => deductionOf(c, d, fw, evById).points),
    };
  });

  const stats = Object.fromEntries(companies.map((c) => [c.id, { first: 0, top2: 0, out: 0, sum: 0, n: 0 }]));
  for (let it = 0; it < o.n; it++) {
    const ws = base.map((b) => b * Math.exp(o.sigma * gauss()));
    const wsum = ws.reduce((a, b) => a + b, 0) || 1;
    // 检查项分值也随机浮动：同一次抽样里所有公司用同一套分值
    const pts = basePts.map((bp) => {
      if (!o.sigmaCheck) return bp;
      const j = Object.fromEntries(Object.entries(bp).map(([id, v]) => [id, v * Math.exp(o.sigmaCheck * gauss())]));
      const s = Object.values(j).reduce((a, b) => a + b, 0) || 1;
      for (const id in j) j[id] = (j[id] / s) * DIM_MAX;
      return j;
    });
    const alive = [];
    for (const p of prepared) {
      let total = 0;
      p.dims.forEach((checks, di) => {
        const earned = {};
        let strong = false;
        for (const ch of checks) {
          let inc = false;
          if (ch.state === 'yes') inc = ch.strong ? true : rnd() < o.pB;
          else if (ch.state === 'unknown') inc = rnd() < (ch.adverse ? o.pAdverse : o.pNull);
          if (inc) {
            earned[ch.id] = pts[di][ch.id] * ch.f;
            if (ch.strong || ch.state === 'unknown') strong = true;
          }
        }
        let s = dimRaw(dims[di], earned, pts[di]);
        if (!strong && s > cap) s = cap;
        s = Math.max(0, s - p.ded[di]);
        total += (ws[di] / wsum) * s * 20;
      });
      stats[p.id].sum += total;
      stats[p.id].n += 1;
      if (rnd() < p.gp) alive.push({ id: p.id, total: total + rnd() * 1e-6 });
      else stats[p.id].out += 1;
    }
    alive.sort((a, b) => b.total - a.total);
    if (alive[0]) stats[alive[0].id].first += 1;
    alive.slice(0, 2).forEach((a) => (stats[a.id].top2 += 1));
  }
  return Object.fromEntries(
    Object.entries(stats).map(([id, s]) => [id, { pFirst: s.first / o.n, pTop2: s.top2 / o.n, pOut: s.out / o.n, mean: r1(s.sum / s.n) }]),
  );
}

// ---------- 检查项分值换种给法，排序变不变 ----------

// 只让检查项分值随机浮动（各维度内重新归一），证据和红线核查不变，看已证实分的排序有多稳。
export function checkWeightRobustness(companies, fw, weights, mode = 'conservative', opts = {}) {
  const n = opts.n ?? 2000, sigma = opts.sigma ?? 0.5;
  const rnd = mulberry32(opts.seed ?? 20261011);
  const gauss = () => Math.sqrt(-2 * Math.log(rnd() + 1e-12)) * Math.cos(2 * Math.PI * rnd());
  const dims = fw.dimensions;
  const w = normalizeWeights(dims, weights);
  const cap = fw.scoring.cap_without_strong_evidence;
  const basePts = dims.map((d) => checkPoints(d));
  // 证据和判断不变，只有分值在变：先把每家每个检查项的状态算好
  const prepared = companies.map((c) => ({ id: c.id, dims: dims.map((d) => dimScore(c, d, fw)) }));
  const scoreWith = (p, pts) => {
    let total = 0;
    p.dims.forEach((ds, di) => {
      const lo = {}, hi = {};
      for (const it of ds.items) {
        const id = it.check.id;
        if (it.state === 'yes') lo[id] = hi[id] = pts[di][id] * (it.tier?.f ?? 1);
        else if (it.state === 'unknown') hi[id] = pts[di][id];
      }
      let l = dimRaw(ds.dim, lo, pts[di]);
      if (!ds.strongYes && l > cap) l = cap;
      l = Math.max(0, l - ds.deduct);
      const h = Math.max(l, dimRaw(ds.dim, hi, pts[di]) - ds.deduct);
      total += w[ds.dim.id] * pointOf({ lo: l, hi: h, mid: (l + h) / 2 }, mode) * 20;
    });
    return r1(total);
  };
  const order = (pts) => prepared.map((p) => ({ id: p.id, t: scoreWith(p, pts) })).sort((a, b) => b.t - a.t).map((x) => x.id);
  const baseOrder = order(basePts);
  const baseKey = baseOrder.join('>');
  const orders = new Map();
  const ranks = Object.fromEntries(companies.map((c) => [c.id, Array(companies.length).fill(0)]));
  const ahead = {}; // ahead[a][b] = a 排在 b 前面的次数
  companies.forEach((a) => (ahead[a.id] = Object.fromEntries(companies.map((b) => [b.id, 0]))));
  for (let it = 0; it < n; it++) {
    const pts = basePts.map((bp) => {
      const j = Object.fromEntries(Object.entries(bp).map(([id, v]) => [id, v * Math.exp(sigma * gauss())]));
      const s = Object.values(j).reduce((x, y) => x + y, 0) || 1;
      for (const id in j) j[id] = (j[id] / s) * DIM_MAX;
      return j;
    });
    const r = order(pts);
    const key = r.join('>');
    orders.set(key, (orders.get(key) || 0) + 1);
    r.forEach((x, i) => {
      ranks[x][i] += 1;
      for (const y of r.slice(i + 1)) ahead[x][y] += 1;
    });
  }
  const p = (k) => k / n;
  const top2 = new Set(baseOrder.slice(0, 2));
  const list = [...orders].sort((x, y) => y[1] - x[1]).map(([k, v]) => ({ ids: k.split('>'), p: p(v) }));
  return {
    n, sigma, baseOrder,
    sameOrder: p(orders.get(baseKey) || 0),
    sameTop2: list.filter((o) => o.ids.slice(0, 2).every((id) => top2.has(id))).reduce((x, o) => x + o.p, 0),
    orders: list,
    rankP: Object.fromEntries(Object.entries(ranks).map(([id, arr]) => [id, arr.map(p)])),
    ahead: Object.fromEntries(Object.entries(ahead).map(([x, row]) => [x, Object.fromEntries(Object.entries(row).map(([y, v]) => [y, p(v)]))])),
  };
}

// ---------- 翻盘条件 ----------

// 我方和某个对手之间：调哪个权重、补哪些检查项会让排序互换。
export function flips(selfS, rivalS, fw, weights, mode) {
  const dims = fw.dimensions;
  const raw = Object.fromEntries(dims.map((d) => [d.id, Math.max(0, Number(weights?.[d.id] ?? d.weight) || 0)]));
  const diff = Object.fromEntries(dims.map((d) => [d.id, pointOf(selfS.dims[d.id], mode) - pointOf(rivalS.dims[d.id], mode)]));
  const D = dims.reduce((a, d) => a + raw[d.id] * diff[d.id], 0); // >0 我方领先
  const weightFlips = [];
  for (const d of dims) {
    if (!diff[d.id]) continue;
    const rest = D - raw[d.id] * diff[d.id];
    const wStar = -rest / diff[d.id]; // 该维度原始权重达到 wStar 时打平
    const helps = D < 0 ? diff[d.id] > 0 : diff[d.id] < 0;
    if (helps && wStar > raw[d.id] && wStar <= 100) weightFlips.push({ dim: d, from: raw[d.id], to: Math.ceil(wStar) });
    if (!helps && wStar >= 0 && wStar < raw[d.id]) weightFlips.push({ dim: d, from: raw[d.id], to: Math.floor(wStar) });
  }
  weightFlips.sort((a, b) => Math.abs(a.to - a.from) - Math.abs(b.to - b.from));

  // 落后的一方：查不到的检查项里，补哪几项最快追平（按已证实分口径，贪心逐项选收益最大的）
  const gap = rivalS.total - selfS.total; // >0 我方落后
  const behind = gap > 0 ? selfS : rivalS;
  const path = fastestPath(behind, Math.abs(gap), fw, weights);
  return { gap: r1(gap), weightFlips, checkPath: path.steps, closes: path.closes, pathOwner: gap > 0 ? 'self' : 'rival' };
}

// 补齐查不到的检查项（视为经核实成立）后，已证实分最多能涨多少；按收益从大到小逐项选，直到超过 need。
export function fastestPath(scored, need, fw, weights) {
  const w = normalizeWeights(fw.dimensions, weights);
  const cap = fw.scoring.cap_without_strong_evidence;
  const state = Object.fromEntries(fw.dimensions.map((d) => [d.id, {
    dim: d,
    pts: checkPoints(d),
    earned: Object.fromEntries(scored.dims[d.id].items.filter((it) => it.state === 'yes').map((it) => [it.check.id, it.earned])),
    strong: scored.dims[d.id].strongYes,
    ded: scored.dims[d.id].deduct || 0,
  }]));
  const lo = (s) => Math.max(0, Math.min(s.strong ? DIM_MAX : cap, dimRaw(s.dim, s.earned, s.pts)) - s.ded);
  const pool = [];
  // 有「可执行的抓手」清单时只在清单里选（比如我方 30 天内能补的证据），否则在所有查不到的项里选
  const levers = scored.company?.levers;
  for (const d of fw.dimensions)
    for (const it of scored.dims[d.id].items)
      // 分档的检查项按最低档估：补上证据至少能拿到的分
      if (it.state === 'unknown' && (!levers || levers[it.check.id])) pool.push({ dim: d, check: it.check, points: it.points * (tierOf(it.check, {})?.f ?? 1), how: levers?.[it.check.id] });
  const steps = [];
  let acc = 0;
  while (pool.length && acc <= need) {
    let best = null;
    for (const [i, c] of pool.entries()) {
      const s = state[c.dim.id];
      const after = Math.max(0, dimRaw(s.dim, { ...s.earned, [c.check.id]: c.points }, s.pts) - s.ded); // 核实成立后视为有强证据
      const gain = (after - lo(s)) * w[c.dim.id] * 20;
      if (!best || gain > best.gain) best = { i, c, gain };
    }
    if (!best || best.gain <= 0) break;
    pool.splice(best.i, 1);
    const s = state[best.c.dim.id];
    s.earned[best.c.check.id] = best.c.points;
    s.strong = true;
    acc += best.gain;
    steps.push({ dim: best.c.dim, check: best.c.check, how: best.c.how, gain: r1(best.gain) });
  }
  return { steps, gained: r1(acc), closes: acc > need };
}

// ---------- 结论 ----------

export const PLAYBOOK = {
  clients: {
    lead: '把客户池写成路演第一页：行业分布、产业带覆盖和可核实案例，回答 Meta 最关心的「你能带来谁」。',
    gap: '把客户池做成证据：拿出出海客户的行业分布和 2–3 个可核实案例；同时和产业带服务商签合作意向，路演时展示已锁定的增量客户。',
  },
  ops: {
    lead: '用已有的平台官方资质证明「认证跑通过」，Meta 是第二次。',
    gap: '用 Google 合作伙伴认证证明平台认证跑通过一次；补上公开的投放规模数据，必要时先以二代身份积累 Meta 消耗记录。',
  },
  tech: {
    lead: '把技术能力做成可演示的 Meta 投放提效案例，对应 Meta 峰会讲的 AI 与自动化。',
    gap: '把微软独家授权的 AI 视频广告技术和 Azure OpenAI 素材能力，做成一个可演示的 Meta 投放提效案例。',
  },
  finance: {
    lead: '把授信做成产品：给中小卖家账期和额度。返点缩水之后，这是没有资金的对手给不了、Meta 也最看重的能力。',
    gap: '准备授信与回款管理制度和坏账数据，证明垫资能力。',
  },
  compliance: {
    lead: '把上市公司内控写进提案：开户审核、素材预审、违规率月报，目标拿 Meta 政策表现类奖项。',
    gap: '组建政策审核小组，先上线开户 KYC 和素材预审，按月报违规率。',
  },
  growth: {
    lead: '把已有的出海投入（海外公司、平台合作）串成增长路线图。',
    gap: '在路演中给出 90 天启动计划、专职团队规模和首年客户目标。',
  },
};

export function conclusions(companies, fw, weights, mode, selfId) {
  const ranking = rank(companies, fw, weights, mode);
  const self = ranking.find((r) => r.id === selfId);
  if (!self) return { ranking, self: null };
  const rivals = ranking.filter((r) => r.id !== selfId);
  const w = normalizeWeights(fw.dimensions, weights);
  const perDim = fw.dimensions.map((d) => {
    const mine = pointOf(self.dims[d.id], mode);
    let best = null;
    for (const r of rivals) {
      const s = pointOf(r.dims[d.id], mode);
      if (!r.dims[d.id].allUnknown && (best == null || s > best.score)) best = { score: s, r };
    }
    const gap = best ? best.score - mine : null;
    return { dim: d, mine, best, gap, weighted: gap == null ? null : r1(gap * w[d.id] * 20) };
  });
  const strengths = perDim.filter((p) => p.best == null || p.mine >= p.best.score).sort((a, b) => w[b.dim.id] - w[a.dim.id]);
  const gaps = perDim.filter((p) => p.gap != null && p.gap > 0).sort((a, b) => b.weighted - a.weighted);
  const ahead = rivals.filter((r) => r.total > self.total);
  const nearest = ahead.length ? ahead[ahead.length - 1] : rivals[0];
  const flip = nearest ? flips(self, nearest, fw, weights, mode) : null;
  const actions = [
    ...gaps.slice(0, 2).map((g) => ({ type: 'gap', dim: g.dim, text: PLAYBOOK[g.dim.id]?.gap })),
    ...strengths.slice(0, 2).map((s) => ({ type: 'lead', dim: s.dim, text: PLAYBOOK[s.dim.id]?.lead })),
  ].filter((a) => a.text);
  return { ranking, self, rivals, perDim, strengths, gaps, ahead, nearest, flip, actions };
}

// ---------- 滚动 diff ----------

export function diffRuns(prev, curr, fw, weights, mode, opts = {}) {
  const dimDrop = opts.dimDrop ?? 0.5;
  const totalDrop = opts.totalDrop ?? 3;
  const prevById = new Map(prev.companies.map((c) => [c.id, c]));
  const alerts = [];
  const rows = [];
  for (const c of curr.companies) {
    const p = prevById.get(c.id);
    const now = scoreCompany(c, fw, weights, mode);
    if (!p) {
      alerts.push({ level: 'info', company: c.short, text: `${c.short} 新进入名单，首次评分 ${now.total}` });
      rows.push({ id: c.id, status: 'new' });
      continue;
    }
    const before = scoreCompany(p, fw, weights, mode);
    const self = c.role === 'self';
    // 新出现的红线线索：状态可能不变（比如本来就是待核），也要单独提醒
    const RED = [['gx1', 'yes', 'gate_fin'], ['k1', 'no', 'gate_comp']];
    for (const [cid, bad, gid] of RED) {
      if (self || before.gates[gid].state !== now.gates[gid].state) continue;
      const was = checkState(p.checks?.[cid], Object.fromEntries((p.evidence || []).map((e) => [e.id, e])), fw).state;
      const is = checkState(c.checks?.[cid], Object.fromEntries((c.evidence || []).map((e) => [e.id, e])), fw).state;
      if (is === bad && was !== bad) alerts.push({ level: 'opportunity', company: c.short, text: `${c.short}出现红线线索：${c.checks[cid].note || cid}。还没有官方证据，先派人核工商与司法；属实则出局。` });
    }
    for (const g of fw.gates.list) {
      const a = before.gates[g.id].state, b = now.gates[g.id].state;
      if (a === b || self) continue;
      // 按严重程度排序判断变好变坏（附条件和待定的出局概率相同，但附条件更差）
      const SEV = ['pass', 'pass_inferred', 'pending', 'borderline', 'pending_adverse', 'fail'];
      const la = fw.gates.states[a].label, lb = fw.gates.states[b].label;
      alerts.push(SEV.indexOf(b) > SEV.indexOf(a)
        ? { level: 'opportunity', company: c.short, text: `${c.short}「${g.name}」从${la}变为${lb}：${now.gates[g.id].reason}。抢客户窗口。` }
        : { level: 'threat', company: c.short, text: `${c.short}「${g.name}」从${la}变为${lb}：${now.gates[g.id].reason}。` });
    }
    for (const d of fw.dimensions) {
      const a = before.dims[d.id].lo, b = now.dims[d.id].lo;
      if (self || a === b) continue;
      if (Math.abs(a - b) < dimDrop) {
        // 变化不大但确实动了分：点名是哪个检查项
        now.dims[d.id].items.forEach((it, i) => {
          const was = before.dims[d.id].items[i];
          if (it.earned === was.earned) return;
          const gained = it.earned > was.earned;
          alerts.push({ level: gained ? 'threat' : 'opportunity', company: c.short, text: `${c.short}「${d.name}」${gained ? '新增' : '失去'}一项：${it.check.text}（已证实分 ${a} → ${b}）${it.answer.note ? `。${it.answer.note}` : ''}` });
        });
        continue;
      }
      alerts.push(b < a
        ? { level: 'opportunity', company: c.short, text: `${c.short}「${d.name}」已证实分从 ${a} 降到 ${b}。${PLAYBOOK[d.id]?.lead ?? ''}` }
        : { level: 'threat', company: c.short, text: `${c.short}「${d.name}」已证实分从 ${a} 升到 ${b}，关注它在这一项的动作。` });
    }
    const delta = r1(now.total - before.total);
    if (!self && delta <= -totalDrop) alerts.push({ level: 'opportunity', company: c.short, text: `${c.short} 总分下降 ${Math.abs(delta)}（${before.total} → ${now.total}）` });
    rows.push({ id: c.id, status: 'kept', before: before.total, after: now.total, delta });
  }
  const order = { opportunity: 0, threat: 1, info: 2 };
  alerts.sort((a, b) => order[a.level] - order[b.level]);
  return { rows, alerts };
}

// ---------- 定权：层次分析法 ----------

// matrix[i][j] = 维度 i 相对 j 的重要程度（1/9 … 9）。返回权重和一致性比率 CR（< 0.1 算前后一致）。
export function ahp(matrix) {
  const n = matrix.length;
  let v = Array(n).fill(1 / n);
  for (let k = 0; k < 100; k++) {
    const next = matrix.map((row) => row.reduce((a, x, j) => a + x * v[j], 0));
    const s = next.reduce((a, b) => a + b, 0);
    v = next.map((x) => x / s);
  }
  const Av = matrix.map((row) => row.reduce((a, x, j) => a + x * v[j], 0));
  const lambda = Av.reduce((a, x, i) => a + x / v[i], 0) / n;
  const RI = [0, 0, 0, 0.58, 0.9, 1.12, 1.24, 1.32, 1.41, 1.45][n] ?? 1.49;
  const ci = (lambda - n) / (n - 1 || 1);
  return { weights: v, lambda, cr: RI ? ci / RI : 0 };
}

// ---------- 评委校准：模型判断 vs 标准答案 ----------

// gold / pred: { [companyId]: { [checkId]: true|false|null } }
export function judgeAgreement(gold, pred, fw) {
  const dimOf = {};
  fw.dimensions.forEach((d) => d.checks.forEach((c) => (dimOf[c.id] = d.id)));
  let n = 0, agree = 0, fp = 0, fn = 0, abstain = 0;
  const byDim = {};
  for (const [co, answers] of Object.entries(gold)) {
    for (const [cid, g] of Object.entries(answers)) {
      if (g == null) continue; // 标准答案本身未知的不计
      const p = pred?.[co]?.[cid] ?? null;
      const d = dimOf[cid] || 'gate';
      byDim[d] ||= { n: 0, agree: 0 };
      n++;
      byDim[d].n++;
      if (p == null) abstain++;
      else if (p === g) {
        agree++;
        byDim[d].agree++;
      } else if (p === true) fp++;
      else fn++;
    }
  }
  return {
    n, accuracy: n ? agree / n : null,
    falseYes: fp, // 模型说成立、实际不成立：编造风险
    falseNo: fn,
    abstain,
    byDim: Object.fromEntries(Object.entries(byDim).map(([k, v]) => [k, v.n ? v.agree / v.n : null])),
  };
}

// ---------- 成本 ----------

export const DEFAULT_PRICING = {
  cheap: { name: '便宜模型（抽取）', inPerM: 1, outPerM: 4 },
  strong: { name: '强模型（判断检查项）', inPerM: 20, outPerM: 80 },
  searchPerCall: 0.06,
};

export function estimateCost(nCompanies, nDims, pricing = DEFAULT_PRICING, p = {}) {
  const queriesPerDim = p.queriesPerDim ?? 1;
  const pagesPerQuery = p.pagesPerQuery ?? 3;
  const dedupe = p.dedupe ?? 0.66;
  const tokensPerPage = p.tokensPerPage ?? 8000;
  const outPerPage = p.outPerPage ?? 600;
  const judgeIn = p.judgeIn ?? 15000;
  const judgeOut = p.judgeOut ?? 2500;
  const changedShare = p.changedShare ?? 1; // 增量重跑时，有变化网页的比例

  const searches = nCompanies * nDims * queriesPerDim;
  const pages = Math.round(searches * pagesPerQuery * dedupe * changedShare);
  const judged = Math.max(changedShare < 1 ? Math.ceil(nCompanies * changedShare) : nCompanies, 0);
  const cheapIn = pages * tokensPerPage, cheapOut = pages * outPerPage;
  const strongIn = judged * judgeIn, strongOut = judged * judgeOut;
  const search = searches * pricing.searchPerCall;
  const extract = (cheapIn * pricing.cheap.inPerM + cheapOut * pricing.cheap.outPerM) / 1e6;
  const judge = (strongIn * pricing.strong.inPerM + strongOut * pricing.strong.outPerM) / 1e6;
  const allStrong = ((cheapIn + strongIn) * pricing.strong.inPerM + (cheapOut + strongOut) * pricing.strong.outPerM) / 1e6;
  return {
    searches, pages, judged,
    tokens: { cheapIn, cheapOut, strongIn, strongOut },
    yuan: { search: r2(search), extract: r2(extract), judge: r2(judge), total: r2(search + extract + judge) },
    allStrongYuan: r2(search + allStrong),
    savedPct: allStrong ? Math.round((1 - (extract + judge) / allStrong) * 100) : 0,
  };
}

// 抽取阶段的防编造闸门：模型给的引文必须能在原网页里找到。
export function quoteInText(quote, text) {
  const norm = (s) => String(s || '').replace(/\s+/g, '').replace(/[，。、；：“”"'（）()]/g, '').toLowerCase();
  const q = norm(quote);
  return q.length >= 6 && norm(text).includes(q);
}

function r1(x) { return Math.round(x * 10) / 10; }
function r2(x) { return Math.round(x * 100) / 100; }
