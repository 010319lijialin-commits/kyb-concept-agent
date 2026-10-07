// 权重校验：用已知结果回测。
//   node agent/calibrate.js data/calibration/labeled.json
// 标注文件格式与 runs/*.json 相同，每家公司多一个 label：1 = 已是 Meta 一级代理，0 = 同期竞争但没拿到。
// 做法：在初始权重 ±10 的范围内按 5 分步长网格搜索，指标是成对排序准确率（AUC）：
// 任取一家 label=1 和一家 label=0，前者分数更高的比例。输出最优几组，最终由业务负责人拍板。
import fs from 'node:fs';
import { scoreCompany } from '../lib/score.js';

export function auc(companies, dimensions, weights, mode = 'conservative') {
  const s = companies.map((c) => ({ label: c.label, v: scoreCompany(c, dimensions, weights, mode).total }));
  const pos = s.filter((x) => x.label === 1), neg = s.filter((x) => x.label === 0);
  if (!pos.length || !neg.length) return null;
  let win = 0;
  for (const p of pos) for (const n of neg) win += p.v > n.v ? 1 : p.v === n.v ? 0.5 : 0;
  return win / (pos.length * neg.length);
}

export function* grid(dimensions, span = 10, step = 5) {
  const ids = dimensions.map((d) => d.id);
  const base = dimensions.map((d) => d.weight);
  function* walk(i, acc) {
    if (i === ids.length) {
      yield Object.fromEntries(ids.map((id, k) => [id, acc[k]]));
      return;
    }
    for (let v = Math.max(0, base[i] - span); v <= base[i] + span; v += step) yield* walk(i + 1, [...acc, v]);
  }
  yield* walk(0, []);
}

export function calibrate(companies, dimensions, top = 5) {
  const results = [];
  for (const w of grid(dimensions)) {
    const a = auc(companies, dimensions, w);
    if (a != null) results.push({ weights: w, auc: a });
  }
  results.sort((x, y) => y.auc - x.auc);
  const initial = auc(companies, dimensions, Object.fromEntries(dimensions.map((d) => [d.id, d.weight])));
  return { initial, best: results.slice(0, top) };
}

if (process.argv[1]?.endsWith('calibrate.js')) {
  const file = process.argv[2];
  if (!file) {
    console.log('用法：node agent/calibrate.js <标注文件>。v1 尚未建立标注集，见 README「权重怎么校验」。');
    process.exit(0);
  }
  const fw = JSON.parse(fs.readFileSync(new URL('../data/framework.json', import.meta.url), 'utf8'));
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  const { initial, best } = calibrate(data.companies, fw.dimensions);
  console.log(`初始权重 AUC = ${initial?.toFixed(3)}`);
  for (const b of best) console.log(b.auc.toFixed(3), JSON.stringify(b.weights));
}
