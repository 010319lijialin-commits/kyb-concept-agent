// 把模板、评分逻辑和最新一期数据打成一个自包含 HTML：dist/radar.html，双击即可打开，也可直接发到群里。
//   node build.js [--run=2026-09-30.json] [--prev=2026-09-01.simulated.json]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const arg = (k) => process.argv.find((a) => a.startsWith(`--${k}=`))?.split('=')[1];
const runsDir = path.join(ROOT, 'data', 'runs');
const files = fs.readdirSync(runsDir).filter((f) => f.endsWith('.json')).sort();
const real = files.filter((f) => !f.includes('simulated'));
const runFile = arg('run') || real.at(-1);
const prevFile = arg('prev') || real.filter((f) => f < runFile).at(-1) || files.find((f) => f.includes('simulated'));

const read = (p) => fs.readFileSync(p, 'utf8');
const data = {
  framework: JSON.parse(read(path.join(ROOT, 'data', 'framework.json'))),
  run: JSON.parse(read(path.join(runsDir, runFile))),
  prev: JSON.parse(read(path.join(runsDir, prevFile))),
};
const scoreJs = read(path.join(ROOT, 'lib', 'score.js')).replace(/^export /gm, '');
const html = read(path.join(ROOT, 'web', 'radar.html'))
  .replace('/*__SCORE_JS__*/', () => scoreJs)
  .replace('/*__DATA__*/', () => JSON.stringify(data).replace(/</g, '\\u003c'));

fs.mkdirSync(path.join(ROOT, 'dist'), { recursive: true });
fs.writeFileSync(path.join(ROOT, 'dist', 'radar.html'), html);
console.log(`dist/radar.html ← 本期 ${runFile}，对比 ${prevFile}`);
