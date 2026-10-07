import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { scoreCompany, rank, conclusions, diffRuns, estimateCost, quoteInText } from '../lib/score.js';
import { auc, calibrate } from '../agent/calibrate.js';

const fw = JSON.parse(fs.readFileSync(new URL('../data/framework.json', import.meta.url)));
const run = JSON.parse(fs.readFileSync(new URL('../data/runs/2026-09-30.json', import.meta.url)));
const dims = fw.dimensions;

const mk = (id, scores, role = 'candidate') => ({
  id, short: id, role,
  dims: Object.fromEntries(dims.map((d, i) => [d.id, { score: scores[i] }])),
});

test('全 5 分 = 100，全 0 分 = 0', () => {
  assert.equal(scoreCompany(mk('a', [5, 5, 5, 5, 5, 5]), dims).total, 100);
  assert.equal(scoreCompany(mk('a', [0, 0, 0, 0, 0, 0]), dims).total, 0);
});

test('未知不当 0 分，三种处理方式和区间', () => {
  const c = mk('a', [null, 4, 4, 4, 4, 4]);
  const cons = scoreCompany(c, dims, null, 'conservative');
  const excl = scoreCompany(c, dims, null, 'exclude');
  assert.equal(excl.total, 80);
  assert.ok(cons.total < excl.total);
  assert.equal(cons.coverage, 75);
  assert.equal(cons.low, 60);
  assert.equal(cons.high, 85);
});

test('调权重会改变排名', () => {
  const a = mk('a', [5, 1, 1, 1, 1, 1]);
  const b = mk('b', [1, 5, 1, 1, 1, 1]);
  assert.equal(rank([a, b], dims, { finance: 90, scale: 10 })[0].id, 'a');
  assert.equal(rank([a, b], dims, { finance: 10, scale: 90 })[0].id, 'b');
});

test('名单增减后结论跟着变', () => {
  const all = conclusions(run.companies, dims, null, 'conservative', 'changhong');
  assert.equal(all.ahead.map((r) => r.id).join(), 'shoplazza');
  const noShop = conclusions(run.companies.filter((c) => c.id !== 'shoplazza'), dims, null, 'conservative', 'changhong');
  assert.equal(noShop.self.rank, 1);
  assert.equal(noShop.ahead.length, 0);
  assert.ok(all.actions.length > 0);
});

test('diff：对手分数下降产生机会提醒，我方变化不提醒', () => {
  const prev = { companies: [mk('x', [4, 4, 4, 4, 4, 4]), mk('me', [3, 3, 3, 3, 3, 3], 'self')] };
  const curr = { companies: [mk('x', [3, 4, 4, 4, 4, 4]), mk('me', [1, 3, 3, 3, 3, 3], 'self'), mk('new', [2, 2, 2, 2, 2, 2])] };
  const { alerts, rows } = diffRuns(prev, curr, dims, null, 'conservative');
  assert.ok(alerts.some((a) => a.level === 'opportunity' && a.company === 'x'));
  assert.ok(!alerts.some((a) => a.company === 'me'));
  assert.ok(rows.some((r) => r.id === 'new' && r.status === 'new'));
});

test('引文核对：原文里没有的句子被拒绝', () => {
  const page = '龙商集团于2006年在厦门成立，发展至今已拥有员工300余人。';
  assert.ok(quoteInText('龙商集团于2006年在厦门成立', page));
  assert.ok(!quoteInText('龙商集团年营收10亿元', page));
  assert.ok(!quoteInText('龙商', page));
});

test('模型编排比全用强模型便宜', () => {
  const e = estimateCost(5, 6);
  assert.ok(e.yuan.total < e.allStrongYuan);
  assert.ok(e.savedPct > 50);
});

test('校验：完美区分的标注集 AUC = 1', () => {
  const labeled = [
    { ...mk('p1', [5, 4, 4, 4, 4, 4]), label: 1 },
    { ...mk('p2', [4, 4, 5, 3, 4, 3]), label: 1 },
    { ...mk('n1', [1, 3, 3, 2, 2, 1]), label: 0 },
  ];
  assert.equal(auc(labeled, dims, null), 1);
  assert.equal(calibrate(labeled, dims, 1).best[0].auc, 1);
});

test('数据完整性：每个打分都有证据，每个证据有链接和访问日期', () => {
  for (const c of run.companies) {
    const ids = new Set(c.evidence.map((e) => e.id));
    for (const d of dims) {
      const r = c.dims[d.id];
      if (r.score != null) assert.ok(r.evidence.length > 0, `${c.short}.${d.id} 有分无证据`);
      for (const id of r.evidence) assert.ok(ids.has(id), `${c.short}.${d.id} 引用不存在的证据 ${id}`);
    }
    for (const e of c.evidence) {
      assert.match(e.url, /^https?:\/\//);
      assert.match(e.accessed, /^\d{4}-\d{2}-\d{2}$/);
    }
  }
});

test('贡献分加总等于总分（保守模式）', async () => {
  const { contributions } = await import('../lib/score.js');
  for (const c of run.companies) {
    const sum = contributions(c, dims, null, 'conservative').reduce((a, x) => a + x.points, 0);
    assert.ok(Math.abs(sum - scoreCompany(c, dims, null, 'conservative').total) < 0.5, c.short);
  }
});

test('diff：对手从未知补齐为高分是威胁，补齐为低分是机会', () => {
  const prev = { companies: [mk('x', [null, 3, 3, 3, 3, 3]), mk('y', [null, 3, 3, 3, 3, 3])] };
  const curr = { companies: [mk('x', [4, 3, 3, 3, 3, 3]), mk('y', [1, 3, 3, 3, 3, 3])] };
  const { alerts } = diffRuns(prev, curr, dims, null, 'conservative');
  assert.ok(alerts.some((a) => a.company === 'x' && a.level === 'threat'));
  assert.ok(alerts.some((a) => a.company === 'y' && a.level === 'opportunity'));
});
