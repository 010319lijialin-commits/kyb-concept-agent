// 评分、排名、结论、滚动 diff、成本估算。纯函数，Node 和浏览器共用（build.js 会把 export 去掉内联进页面）。

export const UNKNOWN_VALUES = { conservative: 1.5, neutral: 2.5, exclude: null };

export function normalizeWeights(dimensions, weights) {
  const raw = dimensions.map((d) => Math.max(0, Number(weights?.[d.id] ?? d.weight) || 0));
  const sum = raw.reduce((a, b) => a + b, 0) || 1;
  const out = {};
  dimensions.forEach((d, i) => (out[d.id] = raw[i] / sum));
  return out;
}

// 总分 0-100。同时给出区间：未知按 0 分和按 5 分各算一次，区间越宽说明结论越依赖补证据。
export function scoreCompany(company, dimensions, weights, unknownMode = 'conservative') {
  const w = normalizeWeights(dimensions, weights);
  const fill = UNKNOWN_VALUES[unknownMode];
  let total = 0, known = 0, lo = 0, hi = 0, knownWeight = 0;
  for (const d of dimensions) {
    const s = company.dims?.[d.id]?.score;
    if (s == null) {
      hi += w[d.id] * 5;
      if (fill != null) total += w[d.id] * fill;
    } else {
      total += w[d.id] * s;
      known += w[d.id] * s;
      lo += w[d.id] * s;
      hi += w[d.id] * s;
      knownWeight += w[d.id];
    }
  }
  if (fill == null) total = knownWeight ? known / knownWeight : 0;
  return {
    id: company.id,
    total: round1((total / 5) * 100),
    low: round1((lo / 5) * 100),
    high: round1((hi / 5) * 100),
    coverage: Math.round(knownWeight * 100),
  };
}

// 总分拆到每个维度：贡献分 = 权重占比 × 维度分 / 5 × 100（「剔除」模式下未知维度贡献为 0，总分另行归一）。
export function contributions(company, dimensions, weights, unknownMode = 'conservative') {
  const w = normalizeWeights(dimensions, weights);
  const fill = UNKNOWN_VALUES[unknownMode];
  return dimensions.map((d) => {
    const s = company.dims?.[d.id]?.score ?? null;
    const used = s ?? fill;
    return { dim: d, score: s, used, weight: w[d.id], points: used == null ? 0 : round1(w[d.id] * used * 20) };
  });
}

export function rank(companies, dimensions, weights, unknownMode) {
  return companies
    .map((c) => ({ company: c, ...scoreCompany(c, dimensions, weights, unknownMode) }))
    .sort((a, b) => b.total - a.total)
    .map((r, i) => ({ ...r, rank: i + 1 }));
}

// 每个维度对应的动作库：长虹佳华在这一维落后时该做什么、领先时怎么用。
export const PLAYBOOK = {
  finance: {
    lead: '把授信做成产品：给中小卖家 30-60 天账期和额度，这是没有资金的对手给不了的，也是 Meta 最看重的回款安全。',
    gap: '补资金证明：向 Meta 提交授信与回款管理制度、坏账率数据，用分销业务的风控体系背书。',
  },
  scale: {
    lead: '用消耗规模换 Meta 的资源倾斜（返点、绿色通道配额），再投回客户服务。',
    gap: '最大短板。收编二代：把领拓、龙商这类有客户没资金的服务商签成二级代理，长虹佳华出授信，他们出客户，快速做出消耗曲线。',
  },
  clients: {
    lead: '把现有产业带客户池做成 Meta 的「长尾客户增长」案例，冲 Meta 年度奖项。',
    gap: '选一个 Meta 覆盖薄弱的产业带打穿（川渝/西部优先，和西部跨境电商博览会资源衔接），同时和独立站 SaaS 做开户导流合作。',
  },
  tech: {
    lead: '把 Azure OpenAI 的 AIGC 素材能力绑定到 Advantage+ 投放，做成可演示的提效数据，这正对应 Meta 峰会讲的 AI 与自动化。',
    gap: '补 API/CAPI 对接和素材工具，或与 SaaS 平台合作拿到像素和转化数据。',
  },
  compliance: {
    lead: '把上市公司内控写进提案：开户审核、素材预审、违规率周报，目标拿 Meta 政策表现类奖项。',
    gap: '组建政策审核小组，先上线开户 KYC 和素材预审，按月向 Meta 报违规率。',
  },
  background: {
    lead: '国资加上市是对 Meta 最直接的持续经营保证，放在提案第一页。',
    gap: '用集团担保或引入产业投资方补背景。',
  },
};

// 结论跟着名单和权重变。selfId 是「我们自己」（长虹佳华）。
export function conclusions(companies, dimensions, weights, unknownMode, selfId) {
  const ranking = rank(companies, dimensions, weights, unknownMode);
  const self = ranking.find((r) => r.id === selfId);
  const rivals = ranking.filter((r) => r.id !== selfId);
  const w = normalizeWeights(dimensions, weights);
  if (!self) return { ranking, self: null };

  const perDim = dimensions.map((d) => {
    const mine = self.company.dims?.[d.id]?.score ?? null;
    let best = null;
    for (const r of rivals) {
      const s = r.company.dims?.[d.id]?.score;
      if (s != null && (best == null || s > best.score)) best = { score: s, company: r.company };
    }
    const gap = mine != null && best ? best.score - mine : null;
    return { dim: d, mine, best, gap, weighted: gap == null ? null : gap * w[d.id] };
  });

  const strengths = perDim
    .filter((p) => p.mine != null && (p.best == null || p.mine >= p.best.score))
    .sort((a, b) => w[b.dim.id] - w[a.dim.id]);
  const gaps = perDim
    .filter((p) => p.gap != null && p.gap > 0)
    .sort((a, b) => b.weighted - a.weighted);

  const ahead = rivals.filter((r) => r.total > self.total);
  const closest = rivals
    .filter((r) => r.total <= self.total)
    .sort((a, b) => b.total - a.total)[0];

  const actions = [
    ...gaps.slice(0, 2).map((g) => ({ type: 'gap', dim: g.dim, text: PLAYBOOK[g.dim.id]?.gap })),
    ...strengths.slice(0, 2).map((s) => ({ type: 'lead', dim: s.dim, text: PLAYBOOK[s.dim.id]?.lead })),
  ].filter((a) => a.text);

  return { ranking, self, rivals, perDim, strengths, gaps, ahead, closest, actions };
}

// 滚动跑：和上一期比，分数下降 = 抢客户窗口，分数上升 = 威胁。
export function diffRuns(prev, curr, dimensions, weights, unknownMode, opts = {}) {
  const dimDrop = opts.dimDrop ?? 0.5;
  const totalDrop = opts.totalDrop ?? 3;
  const prevMap = new Map(prev.companies.map((c) => [c.id, c]));
  const prevRank = new Map(rank(prev.companies, dimensions, weights, unknownMode).map((r) => [r.id, r]));
  const currRank = rank(curr.companies, dimensions, weights, unknownMode);
  const rows = [];
  const alerts = [];

  for (const r of currRank) {
    const c = r.company;
    const p = prevMap.get(c.id);
    if (!p) {
      rows.push({ id: c.id, short: c.short, status: 'new', total: r.total });
      alerts.push({ level: 'info', company: c.short, text: `${c.short} 新进入名单，首次评分 ${r.total}` });
      continue;
    }
    const pr = prevRank.get(c.id);
    const dims = [];
    for (const d of dimensions) {
      const a = p.dims?.[d.id]?.score ?? null;
      const b = c.dims?.[d.id]?.score ?? null;
      if (a === b) continue;
      dims.push({ dim: d, before: a, after: b });
      if (c.role === 'self') continue;
      if (a != null && b != null && a - b >= dimDrop) {
        alerts.push({
          level: 'opportunity', company: c.short, dim: d.name,
          text: `${c.short}「${d.name}」从 ${a} 降到 ${b}：抢客户窗口，${PLAYBOOK[d.id]?.lead ?? ''}`,
        });
      } else if (a != null && b != null && b - a >= dimDrop) {
        alerts.push({ level: 'threat', company: c.short, dim: d.name, text: `${c.short}「${d.name}」从 ${a} 升到 ${b}，关注其在这一维的动作。` });
      } else if (a == null && b != null) {
        // 未知补齐：按保守口径算过的分，现在有了真实值
        const fill = UNKNOWN_VALUES[unknownMode] ?? 2.5;
        alerts.push(b > fill
          ? { level: 'threat', company: c.short, dim: d.name, text: `${c.short}「${d.name}」查到了：${b} 分，比按未知估的 ${fill} 强，重新评估它的威胁。` }
          : { level: 'opportunity', company: c.short, dim: d.name, text: `${c.short}「${d.name}」查到了：只有 ${b} 分，坐实短板。${PLAYBOOK[d.id]?.lead ?? ''}` });
      } else if (a != null && b == null) {
        alerts.push({ level: 'info', company: c.short, dim: d.name, text: `${c.short}「${d.name}」证据失效，变为未知，需人工复核。` });
      }
    }
    const delta = round1(r.total - pr.total);
    if (c.role !== 'self' && delta <= -totalDrop) {
      alerts.push({ level: 'opportunity', company: c.short, text: `${c.short} 总分下降 ${Math.abs(delta)}（${pr.total} → ${r.total}），排名 ${pr.rank} → ${r.rank}` });
    }
    rows.push({ id: c.id, short: c.short, status: 'kept', before: pr.total, total: r.total, delta, rankBefore: pr.rank, rank: r.rank, dims });
  }
  for (const p of prev.companies) {
    if (!curr.companies.some((c) => c.id === p.id)) rows.push({ id: p.id, short: p.short, status: 'removed' });
  }
  const order = { opportunity: 0, threat: 1, info: 2 };
  alerts.sort((a, b) => order[a.level] - order[b.level]);
  return { rows, alerts };
}

// 单次运行成本。价格是假设值（元 / 百万 token、元 / 次搜索），换供应商改 pricing 即可。
export const DEFAULT_PRICING = {
  cheap: { name: '便宜模型（检索抽取）', inPerM: 1, outPerM: 4 },
  strong: { name: '强模型（综合判分）', inPerM: 20, outPerM: 80 },
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

  const searches = nCompanies * nDims * queriesPerDim;
  const pages = Math.round(searches * pagesPerQuery * dedupe);
  const cheapIn = pages * tokensPerPage, cheapOut = pages * outPerPage;
  const strongIn = nCompanies * judgeIn, strongOut = nCompanies * judgeOut;

  const search = searches * pricing.searchPerCall;
  const extract = (cheapIn * pricing.cheap.inPerM + cheapOut * pricing.cheap.outPerM) / 1e6;
  const judge = (strongIn * pricing.strong.inPerM + strongOut * pricing.strong.outPerM) / 1e6;
  // 对照组：全部用强模型
  const allStrong = ((cheapIn + strongIn) * pricing.strong.inPerM + (cheapOut + strongOut) * pricing.strong.outPerM) / 1e6;
  return {
    searches, pages,
    tokens: { cheapIn, cheapOut, strongIn, strongOut },
    yuan: { search: round2(search), extract: round2(extract), judge: round2(judge), total: round2(search + extract + judge) },
    allStrongYuan: round2(search + allStrong),
    savedPct: Math.round((1 - (extract + judge) / allStrong) * 100),
  };
}

// 抽取阶段的防幻觉闸门：模型给的引文必须能在原网页文本里找到。
export function quoteInText(quote, text) {
  const norm = (s) => String(s || '').replace(/\s+/g, '').replace(/[，。、；：“”"'（）()]/g, '').toLowerCase();
  const q = norm(quote);
  return q.length >= 6 && norm(text).includes(q);
}

function round1(x) { return Math.round(x * 10) / 10; }
function round2(x) { return Math.round(x * 100) / 100; }
