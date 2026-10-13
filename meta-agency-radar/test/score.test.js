import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  checkState, dimScore, scoreCompany, gatesOf, rank, monteCarlo, flips, fastestPath,
  conclusions, diffRuns, ahp, judgeAgreement, estimateCost, quoteInText, contributions,
  checkPoints, tierOf, dimRaw, checkWeightRobustness, rivalPlays,
} from '../lib/score.js';
import { auc, calibrate } from '../agent/calibrate.js';

const read = (p) => JSON.parse(fs.readFileSync(new URL(p, import.meta.url)));
const fw = read('../data/framework.json');
const run = read('../data/runs/2026-10-10.json');
const prevSim = read('../data/runs/2026-10-03.simulated.json');
const byId = (id) => run.companies.find((c) => c.id === id);

// 造一家测试公司：checks 用 { id: [状态, 证据类型...] } 描述
function mk(id, spec, role = 'candidate') {
  const evidence = [];
  const checks = {};
  for (const [cid, [s, ...types]] of Object.entries(spec)) {
    const ev = types.map((t, i) => {
      const e = { id: `${id}-${cid}-${i}`, type: t, url: `https://${t}${i}.example.com/${cid}`, accessed: '2026-10-10' };
      evidence.push(e);
      return e.id;
    });
    checks[cid] = { s, ev };
  }
  return { id, short: id, role, checks, evidence };
}
const clients = fw.dimensions.find((d) => d.id === 'clients');

test('证据分级：C 级证据撑不起「成立」，双源 B 级视同 A 级', () => {
  const evById = {
    a: { id: 'a', type: 'secondhand', url: null },
    b1: { id: 'b1', type: 'self', url: 'https://x.com/1' },
    b2: { id: 'b2', type: 'media', url: 'https://y.com/2' },
    b3: { id: 'b3', type: 'self', url: 'https://x.com/3' },
  };
  assert.equal(checkState({ s: true, ev: ['a'] }, evById, fw).state, 'unknown');
  assert.equal(checkState({ s: true, ev: ['b1'] }, evById, fw).strong, false);
  assert.equal(checkState({ s: true, ev: ['b1', 'b3'] }, evById, fw).strong, false, '同一域名不算双源');
  assert.equal(checkState({ s: true, ev: ['b1', 'b2'] }, evById, fw).strong, true);
});

test('维度分：没有 A 级或双源证据时已证实分封顶 3.5，查不到的计入区间', () => {
  const weak = mk('w', { c2: [true, 'self'], c3: [true, 'self'], c4: [true, 'self'], c5: [true, 'self'], c1: [null] });
  weak.checks.c4.tier = 1;
  const ds = dimScore(weak, clients, fw);
  assert.ok(ds.raw > 3.5);
  assert.equal(ds.lo, 3.5);
  assert.ok(ds.capped);
  assert.equal(ds.hi, 5);
  const strong = JSON.parse(JSON.stringify(weak));
  strong.evidence[0].type = 'official';
  assert.equal(dimScore(strong, clients, fw).lo, ds.raw);
});

test('检查项分值：按角色分档后维度内归一到 5，可被重新分配覆盖', () => {
  for (const d of fw.dimensions) {
    const pts = checkPoints(d);
    assert.ok(Math.abs(Object.values(pts).reduce((a, b) => a + b, 0) - 5) < 1e-9, d.id);
    for (const a of d.checks) for (const b of d.checks)
      if (a.role === 'core' && b.role === 'weak') assert.ok(pts[a.id] > pts[b.id], `${a.id} > ${b.id}`);
    for (const c of d.checks) assert.ok(c.why, `${c.id} 要写理由`);
  }
  const eq = { ...clients, checks: clients.checks.map((c) => ({ ...c, alloc: 20 })) };
  assert.deepEqual(Object.values(checkPoints(eq)), [1, 1, 1, 1, 1]);
});

test('分档：部分满足得一半，没写档位按最低档', () => {
  const c1 = clients.checks.find((c) => c.id === 'c1');
  assert.equal(tierOf(c1, { s: true }).f, 0.5);
  assert.equal(tierOf(c1, { s: true, tier: 1 }).f, 1);
  const lo = dimScore(mk('a', { c1: [true, 'official'] }), clients, fw).lo;
  const full = mk('b', { c1: [true, 'official'] });
  full.checks.c1.tier = 1;
  assert.ok(Math.abs(dimScore(full, clients, fw).lo - 2 * lo) < 0.02);
});

test('分组：同一事实满足的两项不重复全额计分，维度满分仍是 5', () => {
  const pts = checkPoints(clients);
  const both = dimRaw(clients, { c1: pts.c1, c5: pts.c5 });
  const sep = dimRaw(clients, { c1: pts.c1 }) + dimRaw(clients, { c5: pts.c5 });
  assert.ok(both < sep);
  assert.equal(dimRaw(clients, pts), 5);
});

test('检查项分值换种给法：频率加总为 1，不浮动时排序不变', () => {
  const r = checkWeightRobustness(run.companies, fw, null, 'conservative', { n: 300 });
  assert.ok(Math.abs(r.orders.reduce((a, o) => a + o.p, 0) - 1) < 1e-9);
  assert.ok(r.sameOrder > 0 && r.sameOrder < 1);
  assert.ok(Math.abs(r.ahead.changhong.shoplazza + r.ahead.shoplazza.changhong - 1) < 1e-9);
  assert.equal(checkWeightRobustness(run.companies, fw, null, 'conservative', { n: 20, sigma: 0 }).sameOrder, 1);
});

test('全是查不到：已证实 0 分，区间到 5', () => {
  const ds = dimScore(mk('u', {}), clients, fw);
  assert.equal(ds.lo, 0);
  assert.equal(ds.hi, 5);
  assert.ok(ds.allUnknown);
});

test('红线核查：核实通过、推断通过、待定、附条件都按规则区分', () => {
  const g = (id) => gatesOf(byId(id), fw, '2026-10-10');
  assert.equal(g('changhong').gate_fin.state, 'pass', '营运资金风险信号不是红线，只在维度里扣分');
  assert.equal(g('changhong').gate_comp.state, 'pass_inferred', '只按上市披露推断，未做工商核验');
  assert.equal(g('shoplazza').gate_fin.state, 'pass_inferred', '融资证据超过 3 年');
  assert.equal(g('shoplazza').gate_comp.state, 'pending');
  assert.equal(g('lingtok').gate_fin.state, 'pending_adverse');
  assert.equal(g('addragon').gate_comp.state, 'pending', '只有诉讼线索，诉讼不是红线');
  assert.equal(g('ecoglobal').gate_fin.state, 'borderline');
  assert.equal(g('ecoglobal').gate_comp.state, 'borderline');
  assert.equal(gatesOf(mk('bad', { gx1: [true, 'registry'] }), fw).gate_fin.state, 'fail');
  assert.equal(gatesOf(mk('v', { k1: [false, 'registry'] }), fw).gate_comp.state, 'fail');
  const clean = mk('ok', { k1: [true, 'registry'] });
  assert.equal(gatesOf(clean, fw).gate_comp.state, 'pass', '工商核验无问题才是核实通过');
});

test('红线只认官方来源：非官方报道只能标待核，资本偏弱和诉讼不出局', () => {
  assert.equal(gatesOf(mk('a', { gx1: [true, 'media'] }), fw).gate_fin.state, 'pending_adverse');
  assert.equal(gatesOf(mk('b', { k1: [false, 'self'] }), fw).gate_comp.state, 'pending_adverse');
  assert.equal(gatesOf(mk('c', { f4: [false, 'registry'] }), fw).gate_fin.state, 'borderline');
  assert.equal(gatesOf(mk('d', { k2: [false, 'registry'] }), fw).gate_comp.state, 'borderline');
  for (const st of ['pending', 'pending_adverse', 'borderline']) assert.ok(fw.gates.states[st].p >= 0.8, `${st} 不应被当作大概率出局`);
  const mc = monteCarlo(run.companies, fw, null, { n: 1500 });
  for (const [id, v] of Object.entries(mc)) assert.ok(v.pOut < 0.35, `${id} 没有踩红线的官方证据，出局概率 ${v.pOut}`);
});

test('证据过时：超过 3 年的融资只能推断通过', () => {
  const fresh = { ...mk('f', {}), checks: { f2: { s: true, ev: ['e'] } }, evidence: [{ id: 'e', type: 'media', url: 'https://a.com', published: '2026-01', accessed: '2026-10-10' }] };
  const old = { ...fresh, evidence: [{ ...fresh.evidence[0], published: '2022-01' }] };
  assert.equal(gatesOf(fresh, fw, '2026-10-10').gate_fin.state, 'pass');
  assert.equal(gatesOf(old, fw, '2026-10-10').gate_fin.state, 'pass_inferred');
});

test('没有任何一家的出局概率是 0：红线核查「通过」也留余量', () => {
  const mc = monteCarlo(run.companies, fw, null, { n: 2000, asOf: '2026-10-10' });
  for (const [id, v] of Object.entries(mc)) assert.ok(v.pOut > 0, id);
  assert.ok(fw.gates.states.pass.p < 1);
});

test('查不到不等于通过：没有任何信息的公司红线核查是待定', () => {
  const g = gatesOf(mk('x', {}), fw);
  assert.equal(g.gate_fin.state, 'pending');
  assert.equal(g.gate_comp.state, 'pending');
});

test('三种口径：保守 ≤ 中性 ≤ 乐观', () => {
  for (const c of run.companies) {
    const a = scoreCompany(c, fw, null, 'conservative').total;
    const b = scoreCompany(c, fw, null, 'neutral').total;
    const o = scoreCompany(c, fw, null, 'optimistic').total;
    assert.ok(a <= b && b <= o, c.short);
  }
});

test('贡献分加总等于总分', () => {
  for (const c of run.companies) {
    const s = scoreCompany(c, fw, null, 'conservative');
    const sum = contributions(s, fw, null, 'conservative').reduce((a, x) => a + x.points, 0);
    assert.ok(Math.abs(sum - s.total) < 0.5, c.short);
  }
});

test('调权重会改变排名', () => {
  const a = mk('a', { f1: [true, 'listed'], f2: [true, 'listed'], f4: [true, 'listed'] });
  const b = mk('b', { c1: [true, 'official'], c2: [true, 'official'], c3: [true, 'official'] });
  assert.equal(rank([a, b], fw, { finance: 90, clients: 5 })[0].id, 'a');
  assert.equal(rank([a, b], fw, { finance: 5, clients: 90 })[0].id, 'b');
});

test('排名概率：可复现、概率合理', () => {
  const m1 = monteCarlo(run.companies, fw, null, { n: 1500 });
  const m2 = monteCarlo(run.companies, fw, null, { n: 1500 });
  assert.deepEqual(m1, m2, '固定种子，结果可复现');
  const sumFirst = Object.values(m1).reduce((a, x) => a + x.pFirst, 0);
  assert.ok(sumFirst <= 1 + 1e-9);
  for (const v of Object.values(m1)) assert.ok(v.pFirst <= v.pTop2);
});

test('翻盘条件：按建议补齐检查项后确实追平', () => {
  const self = scoreCompany(byId('changhong'), fw, null, 'conservative');
  const rival = scoreCompany(byId('shoplazza'), fw, null, 'conservative');
  const f = flips(self, rival, fw, null, 'conservative');
  assert.ok(f.gap > 0);
  assert.ok(f.closes);
  // 把路径里的检查项真的改成「官方证据成立」，重新算分应不低于对手
  const patched = JSON.parse(JSON.stringify(byId('changhong')));
  for (const st of f.checkPath) {
    patched.checks[st.check.id] = { s: true, ev: ['ok'] };
  }
  patched.evidence.push({ id: 'ok', type: 'official', url: 'https://official.example.com' });
  assert.ok(scoreCompany(patched, fw, null, 'conservative').total >= rival.total);
  // 权重翻盘点：调到建议值后排序互换
  for (const wf of f.weightFlips) {
    const w = Object.fromEntries(fw.dimensions.map((d) => [d.id, d.weight]));
    w[wf.dim.id] = wf.to;
    const s2 = scoreCompany(byId('changhong'), fw, w, 'conservative').total;
    const r2 = scoreCompany(byId('shoplazza'), fw, w, 'conservative').total;
    assert.ok(s2 >= r2 - 0.11, `${wf.dim.id} → ${wf.to}`);
  }
});

test('抓手清单：我方的追赶路径只在可执行项里选', () => {
  const self = scoreCompany(byId('changhong'), fw, null, 'conservative');
  const p = fastestPath(self, 100, fw, null);
  for (const st of p.steps) assert.ok(byId('changhong').levers[st.check.id], st.check.id);
});

test('名单增减后结论跟着变', () => {
  const all = conclusions(run.companies, fw, null, 'conservative', 'changhong');
  assert.equal(all.nearest.id, 'shoplazza');
  const noShop = conclusions(run.companies.filter((c) => c.id !== 'shoplazza'), fw, null, 'conservative', 'changhong');
  assert.equal(noShop.self.rank, 1);
  assert.equal(noShop.ahead.length, 0);
});

test('滚动 diff：对手红线核查变差、分数下降是机会，上升是威胁', () => {
  const { alerts } = diffRuns(prevSim, run, fw, null, 'conservative');
  assert.ok(alerts.some((a) => a.company === '宜客' && a.level === 'opportunity' && a.text.includes('合规红线')));
  assert.ok(alerts.some((a) => a.company === '店匠' && a.level === 'opportunity'));
  assert.ok(alerts.some((a) => a.company === '领拓' && a.level === 'threat' && a.text.includes('奖项')), '分数变化小也点名是哪个检查项');
  assert.ok(!alerts.some((a) => a.company === '长虹佳华'));
});

test('滚动 diff：红线状态没变时，新出现的红线线索也要提醒', () => {
  const curr = JSON.parse(JSON.stringify(run));
  const lt = curr.companies.find((c) => c.id === 'lingtok');
  lt.evidence.push({ id: 'rumor', type: 'internal', url: null, claim: '听说被列为失信被执行人' });
  lt.checks.gx1 = { s: true, ev: ['rumor'], note: '人工情报：听说被列为失信被执行人' };
  const { alerts } = diffRuns(run, curr, fw, null, 'conservative');
  assert.ok(alerts.some((a) => a.company === '领拓' && a.text.includes('红线线索')));
});

test('同一事实只扣一处：营运资金信号扣「财务与授信」1 分，附条件不额外计出局概率', () => {
  const fin = fw.dimensions.find((d) => d.id === 'finance');
  const ch = byId('changhong');
  const with_ = dimScore(ch, fin, fw);
  const without = dimScore({ ...ch, checks: { ...ch.checks, gx2: { s: false, ev: ['ch_ix'] } } }, fin, fw);
  assert.equal(with_.deduct, 1);
  assert.ok(Math.abs(without.lo - with_.lo - 1) < 1e-9);
  assert.equal(fw.gates.states.borderline.p, fw.gates.states.pending.p);
});

test('对每个对手怎么打：按数据定立场，不写死公司名', () => {
  const k = conclusions(run.companies, fw, null, 'conservative', 'changhong');
  const plays = Object.fromEntries(rivalPlays(k, fw, null, 'conservative').map((p) => [p.id, p]));
  assert.equal(Object.keys(plays).length, 4, '四家对手都有');
  assert.equal(plays.shoplazza.stance, 'differentiate', '领先我方的是主要对手');
  assert.equal(plays.addragon.stance, 'ally', '客户不弱、资金弱、合规没问题 → 结盟候选');
  assert.equal(plays.ecoglobal.stance, 'watch', '合规附条件的不建议结盟');
  assert.ok(plays.shoplazza.theyLead.length && plays.shoplazza.weLead.length);
  // 换名字不影响立场
  const renamed = run.companies.map((c) => (c.id === 'addragon' ? { ...c, id: 'x1', short: '某公司' } : c));
  const k2 = conclusions(renamed, fw, null, 'conservative', 'changhong');
  assert.equal(rivalPlays(k2, fw, null, 'conservative').find((p) => p.id === 'x1').stance, 'ally');
});

test('层次分析法：一致的判断 CR≈0，权重符合比例', () => {
  const m = [
    [1, 2, 4],
    [1 / 2, 1, 2],
    [1 / 4, 1 / 2, 1],
  ];
  const r = ahp(m);
  assert.ok(r.cr < 0.01);
  assert.ok(Math.abs(r.weights[0] - 4 / 7) < 1e-6);
  const bad = ahp([
    [1, 9, 1 / 9],
    [1 / 9, 1, 9],
    [9, 1 / 9, 1],
  ]);
  assert.ok(bad.cr > 0.1, '自相矛盾的判断会被发现');
});

test('评委校准：统计一致率和「编造」次数', () => {
  const gold = { a: { c1: true, c2: false, c3: null }, b: { c1: false } };
  const pred = { a: { c1: true, c2: true }, b: { c1: null } };
  const r = judgeAgreement(gold, pred, fw);
  assert.equal(r.n, 3);
  assert.equal(r.falseYes, 1);
  assert.equal(r.abstain, 1);
  assert.equal(r.accuracy, 1 / 3);
});

test('引文核对：原文里没有的句子被拒绝', () => {
  const page = '龙商集团于2006年在厦门成立，发展至今已拥有员工300余人。';
  assert.ok(quoteInText('龙商集团于2006年在厦门成立', page));
  assert.ok(!quoteInText('龙商集团年营收10亿元', page));
});

test('模型编排比全用强模型便宜；增量重跑更便宜', () => {
  const full = estimateCost(5, 6);
  const inc = estimateCost(5, 6, undefined, { changedShare: 0.2 });
  assert.ok(full.yuan.total < full.allStrongYuan);
  assert.ok(inc.yuan.total < full.yuan.total);
});

test('回测：完美区分的标注集 AUC = 1', () => {
  const labeled = [
    { ...mk('p1', { f1: [true, 'listed'], f2: [true, 'listed'], c1: [true, 'official'] }), label: 1 },
    { ...mk('n1', { c1: [false, 'official'] }), label: 0 },
  ];
  assert.equal(auc(labeled, fw, null), 1);
  assert.equal(calibrate(labeled, fw, 1).best[0].auc, 1);
});

test('数据完整性：成立的检查项都有证据；证据都有来源和访问日期', () => {
  const ids = new Set([...fw.dimensions.flatMap((d) => d.checks.map((c) => c.id)), ...fw.gate_checks.map((g) => g.id)]);
  for (const c of run.companies) {
    const evIds = new Set(c.evidence.map((e) => e.id));
    for (const [cid, a] of Object.entries(c.checks)) {
      assert.ok(ids.has(cid), `${c.short} 未知检查项 ${cid}`);
      if (a.s !== null) assert.ok((a.ev || []).length > 0, `${c.short}.${cid} 有结论没证据`);
      for (const id of a.ev || []) assert.ok(evIds.has(id), `${c.short}.${cid} 引用不存在的证据 ${id}`);
    }
    for (const e of c.evidence) {
      assert.ok(fw.evidence_grades.types[e.type], `${e.id} 来源类型未定义`);
      if (e.type !== 'secondhand') assert.match(e.url, /^https?:\/\//, e.id);
      assert.match(e.accessed, /^\d{4}-\d{2}-\d{2}$/, e.id);
    }
  }
});
