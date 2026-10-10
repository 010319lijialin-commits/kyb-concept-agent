// 评分引擎 v2。Node 和浏览器共用（build.js 会去掉 export 内联进页面）。
// 原则：人或模型只判断检查项是否成立并挂证据；分数、门槛、排名、概率全部由这里的代码算。

export const MODES = ['conservative', 'neutral', 'optimistic'];

export const DEFAULT_UNCERTAINTY = {
  n: 4000, // 模拟次数
  seed: 20261010,
  pB: 0.8, // 只有 B 级证据的检查项，按 80% 概率属实
  pNull: 0.5, // 查不到的检查项，按 50% 概率成立
  pAdverse: 0.25, // 查不到且有不利线索的检查项
  sigma: 0.25, // 权重随机浮动幅度（对数正态）
};

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

// ---------- 维度分 ----------

export function dimScore(company, dim, fw) {
  const evById = Object.fromEntries((company.evidence || []).map((e) => [e.id, e]));
  const cap = fw.scoring.cap_without_strong_evidence;
  let raw = 0, nullPts = 0, known = 0, total = 0, strongYes = false;
  const items = dim.checks.map((c) => {
    const ans = company.checks?.[c.id];
    const st = checkState(ans, evById, fw);
    total += c.points;
    if (st.state === 'yes') {
      raw += c.points;
      known += c.points;
      if (st.strong) strongYes = true;
    } else if (st.state === 'no') {
      known += c.points;
    } else {
      nullPts += c.points;
    }
    return { check: c, answer: ans || {}, ...st };
  });
  const capped = !strongYes && raw > cap;
  const lo = capped ? cap : raw;
  const hi = Math.min(5, raw + nullPts);
  const allUnknown = known === 0;
  return { dim, items, raw, lo, hi: Math.max(hi, lo), mid: (lo + Math.max(hi, lo)) / 2, capped, strongYes, allUnknown, coverage: known / total };
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

// ---------- 门槛 ----------

// 证据日期（YYYY / YYYY-MM / YYYY-MM-DD）距 asOf 超过 months 个月算过时
export function isStale(published, asOf, months) {
  if (!published) return true;
  const m = String(published).match(/^(\d{4})(?:-(\d{1,2}))?/);
  if (!m) return true;
  const y = +m[1], mo = m[2] ? +m[2] : 6;
  const d = new Date(asOf || Date.now());
  return (d.getFullYear() - y) * 12 + (d.getMonth() + 1 - mo) > months;
}

export function gatesOf(company, fw, asOf) {
  const evById = Object.fromEntries((company.evidence || []).map((e) => [e.id, e]));
  const staleM = fw.scoring.stale_months ?? 36;
  const fresh = (id) => (company.checks?.[id]?.ev || []).map((x) => evById[x]).filter(Boolean).some((e) => gradeOf(e, fw) !== 'C' && !isStale(e.published, asOf, staleM));
  const st = (id) => checkState(company.checks?.[id], evById, fw);
  const isYes = (id) => st(id).state === 'yes';
  const isNo = (id) => st(id).state === 'no';
  const adverse = (...ids) => ids.some((id) => st(id).adverse);
  const note = (id) => company.checks?.[id]?.note || '';

  let fin;
  if (isYes('gx1')) fin = { state: 'fail', reason: note('gx1') || '注册资本低于 100 万元或连续减资' };
  else if (isYes('f1') || isYes('f2')) {
    const basis = isYes('f1') ? '上市公司，财报公开' : note('f2') || '有公开营收或大额机构融资';
    const recent = (isYes('f1') && fresh('f1')) || (isYes('f2') && fresh('f2'));
    if (isYes('gx2')) fin = { state: 'pass_inferred', reason: `${basis}；但有营运资金风险信号：${note('gx2')}` };
    else if (!recent) fin = { state: 'pass_inferred', reason: `${basis}；但支撑证据都超过 ${staleM / 12} 年，近况未知` };
    else fin = { state: 'pass', reason: basis };
  }
  else if (isNo('f4')) fin = { state: 'borderline', reason: note('f4') || '注册资本低于 1000 万或近期减资' };
  else if (isYes('f4')) fin = { state: 'pass', reason: note('f4') || '资本实力达标' };
  else if (adverse('f4', 'gx1')) fin = { state: 'pending_adverse', reason: note('gx1') || note('f4') || '查不到，且有不利线索' };
  else fin = { state: 'pending', reason: '查不到注册资本、融资或营收信息' };

  let comp;
  if (isNo('k1')) comp = { state: 'fail', reason: note('k1') || '有失信、经营异常或重大处罚' };
  else if (isNo('k2') || isNo('k3')) comp = { state: 'borderline', reason: isNo('k3') ? note('k3') || '对外资质表述与官方目录不符' : note('k2') || '有未结重大诉讼' };
  else if (isYes('k1')) comp = { state: 'pass', reason: '工商与司法核验无问题' };
  else if (isYes('f1')) comp = { state: 'pass_inferred', reason: '上市公司须持续披露重大处罚，未见相关公告；但未做工商与司法核验' };
  else if (adverse('k1', 'k2')) comp = { state: 'pending_adverse', reason: note('k2') || note('k1') || '查不到，且有不利线索' };
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
  const prepared = companies.map((c) => {
    const evById = Object.fromEntries((c.evidence || []).map((e) => [e.id, e]));
    const g = gatesOf(c, fw, o.asOf);
    return {
      id: c.id,
      gp: gateP(g.gate_fin.state) * gateP(g.gate_comp.state),
      dims: dims.map((d) => d.checks.map((ch) => ({ pts: ch.points, ...checkState(c.checks?.[ch.id], evById, fw) }))),
    };
  });

  const stats = Object.fromEntries(companies.map((c) => [c.id, { first: 0, top2: 0, out: 0, sum: 0, n: 0 }]));
  for (let it = 0; it < o.n; it++) {
    const ws = base.map((b) => b * Math.exp(o.sigma * gauss()));
    const wsum = ws.reduce((a, b) => a + b, 0) || 1;
    const alive = [];
    for (const p of prepared) {
      let total = 0;
      p.dims.forEach((checks, di) => {
        let s = 0, strong = false;
        for (const ch of checks) {
          let inc = false;
          if (ch.state === 'yes') inc = ch.strong ? true : rnd() < o.pB;
          else if (ch.state === 'unknown') inc = rnd() < (ch.adverse ? o.pAdverse : o.pNull);
          if (inc) {
            s += ch.pts;
            if (ch.strong || ch.state === 'unknown') strong = true;
          }
        }
        if (!strong && s > cap) s = cap;
        total += (ws[di] / wsum) * Math.min(5, s) * 20;
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
  const state = Object.fromEntries(fw.dimensions.map((d) => [d.id, { raw: scored.dims[d.id].raw, strong: scored.dims[d.id].strongYes }]));
  const lo = (s) => (s.strong ? Math.min(5, s.raw) : Math.min(cap, s.raw));
  const pool = [];
  // 有「可执行的抓手」清单时只在清单里选（比如我方 30 天内能补的证据），否则在所有查不到的项里选
  const levers = scored.company?.levers;
  for (const d of fw.dimensions)
    for (const it of scored.dims[d.id].items)
      if (it.state === 'unknown' && (!levers || levers[it.check.id])) pool.push({ dim: d, check: it.check, how: levers?.[it.check.id] });
  const steps = [];
  let acc = 0;
  while (pool.length && acc <= need) {
    let best = null;
    for (const [i, c] of pool.entries()) {
      const s = state[c.dim.id];
      const gain = (Math.min(5, s.raw + c.check.points) - lo(s)) * w[c.dim.id] * 20;
      if (!best || gain > best.gain) best = { i, c, gain };
    }
    if (!best || best.gain <= 0) break;
    pool.splice(best.i, 1);
    const s = state[best.c.dim.id];
    s.raw += best.c.check.points;
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
    for (const g of fw.gates.list) {
      const a = before.gates[g.id].state, b = now.gates[g.id].state;
      if (a === b || self) continue;
      const pa = fw.gates.states[a].p, pb = fw.gates.states[b].p;
      const la = fw.gates.states[a].label, lb = fw.gates.states[b].label;
      alerts.push(pb < pa
        ? { level: 'opportunity', company: c.short, text: `${c.short}「${g.name}」从${la}变为${lb}：${now.gates[g.id].reason}。抢客户窗口。` }
        : { level: 'threat', company: c.short, text: `${c.short}「${g.name}」从${la}变为${lb}：${now.gates[g.id].reason}。` });
    }
    for (const d of fw.dimensions) {
      const a = before.dims[d.id].lo, b = now.dims[d.id].lo;
      if (self || Math.abs(a - b) < dimDrop) continue;
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
