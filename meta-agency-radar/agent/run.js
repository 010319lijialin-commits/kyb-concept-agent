// 滚动跑入口。
//   node agent/run.js --offline              不调模型：按 companies.json 名单 + 最新一期证据重新排名，和上一期 diff，出提醒
//   node agent/run.js                        在线：检索 → 便宜模型抽证据（核对引文）→ 强模型判分 → 存新一期 → diff → 提醒
//   node agent/run.js --only=lingtok,addragon  只重跑部分公司，其余沿用上一期
// 定时：crontab 每周一 9 点 `0 9 * * 1 cd /path && node agent/run.js`；提醒推送配 ALERT_WEBHOOK（飞书/企业微信机器人）。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { rank, diffRuns, estimateCost, DEFAULT_PRICING } from '../lib/score.js';
import { ledger } from './llm.js';
import { collectCompany } from './collect.js';
import { judgeCompany } from './judge.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const RUNS = path.join(ROOT, 'data', 'runs');
const REPORTS = path.join(ROOT, 'reports');

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, '').split('=');
    return [k, v ?? true];
  }),
);
const readJSON = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));
const log = (...m) => console.log(...m);

loadDotEnv();
const framework = readJSON(path.join(ROOT, 'data', 'framework.json'));
const roster = readJSON(path.join(ROOT, 'data', 'companies.json')).companies;
const dims = framework.dimensions;
const today = new Date().toISOString().slice(0, 10);

const runFiles = fs.readdirSync(RUNS).filter((f) => f.endsWith('.json')).sort();
const realRuns = runFiles.filter((f) => !f.includes('simulated'));
const latestFile = args.from || realRuns.at(-1);
const latest = latestFile ? readJSON(path.join(RUNS, latestFile)) : { companies: [] };

let curr;
if (args.offline) {
  curr = { ...latest, run_id: `${latest.run_id}-offline`, companies: applyRoster(latest.companies) };
  log(`离线模式：沿用 ${latestFile} 的证据，名单 ${curr.companies.length} 家`);
} else {
  curr = await onlineRun();
  const out = path.join(RUNS, `${today}.json`);
  fs.writeFileSync(out, JSON.stringify(curr, null, 2));
  log(`已保存 ${path.relative(ROOT, out)}`);
}

// 对比基准：--prev 指定；否则取本期之前最近的一期（真实优先，没有就用模拟基线并明确标注）
const prevFile =
  args.prev ||
  (args.offline ? realRuns.filter((f) => f < latestFile).at(-1) : realRuns.filter((f) => f < `${today}.json`).at(-1)) ||
  runFiles.find((f) => f.includes('simulated'));
const prev = prevFile ? readJSON(path.join(RUNS, prevFile)) : null;

const ranking = rank(curr.companies, dims, null, 'conservative');
const lines = [`# Meta 一代竞争力雷达 · ${curr.run_id}`, '', '| 排名 | 公司 | 总分 | 区间 | 证据覆盖 |', '|---|---|---|---|---|'];
for (const r of ranking) lines.push(`| ${r.rank} | ${r.company.short}${r.company.role === 'self' ? '（我方）' : ''} | ${r.total} | ${r.low}–${r.high} | ${r.coverage}% |`);

if (prev) {
  const { alerts } = diffRuns(prev, curr, dims, null, 'conservative');
  lines.push('', `## 与上一期（${prev.run_id}${prev.simulated ? '，模拟基线' : ''}）相比`, '');
  if (!alerts.length) lines.push('无显著变化。');
  const tag = { opportunity: '【机会】', threat: '【威胁】', info: '【复核】' };
  for (const a of alerts) lines.push(`- ${tag[a.level]}${a.text}`);
  if (prev.simulated) lines.push('', '> 上一期是模拟数据，只用来演示 diff 和提醒机制。');
  await pushWebhook(lines.join('\n'));
}

if (!args.offline) {
  const cost = actualCost();
  lines.push('', `## 本次成本`, '', `便宜模型 ${ledger.cheap.calls} 次，强模型 ${ledger.strong.calls} 次，检索 ${ledger.search} 次，约 ¥${cost}`);
}
const est = estimateCost(curr.companies.length, dims.length);
lines.push('', `预估单次全量成本 ¥${est.yuan.total}（全部用强模型约 ¥${est.allStrongYuan}）`);

fs.mkdirSync(REPORTS, { recursive: true });
const reportPath = path.join(REPORTS, `${curr.run_id}.md`);
fs.writeFileSync(reportPath, lines.join('\n') + '\n');
log('\n' + lines.join('\n'));
log(`\n报告：${path.relative(ROOT, reportPath)}`);

// ---------------------------------------------------------------

function applyRoster(companies) {
  const byId = new Map(companies.map((c) => [c.id, c]));
  return roster.map((r) => byId.get(r.id) || placeholder(r));
}

function placeholder(r) {
  const d = Object.fromEntries(dims.map((x) => [x.id, { score: null, confidence: '低', rationale: '尚未采集。', evidence: [] }]));
  return { id: r.id, name: r.name, short: r.short, role: r.role, positioning: '待采集', strategy: '', risks: ['新加入名单，尚未运行 Agent 采集'], dims: d, evidence: [] };
}

async function onlineRun() {
  const only = typeof args.only === 'string' ? new Set(args.only.split(',')) : null;
  const prevById = new Map(latest.companies.map((c) => [c.id, c]));
  const companies = [];
  for (const r of roster) {
    if (only && !only.has(r.id) && prevById.has(r.id)) {
      companies.push(prevById.get(r.id));
      continue;
    }
    log(`采集 ${r.short} …`);
    const { evidence } = await collectCompany(r, framework, { accessed: today, log });
    const judged = await judgeCompany(r, evidence, framework);
    companies.push({ id: r.id, name: r.name, short: r.short, role: r.role, entity_note: r.entity_note || '', ...judged, evidence });
  }
  return { run_id: today, date: today, simulated: false, method: 'Agent 自动运行：检索 + 便宜模型抽取（引文核对）+ 强模型判分', companies };
}

function actualCost() {
  const p = DEFAULT_PRICING;
  const y =
    (ledger.cheap.in * p.cheap.inPerM + ledger.cheap.out * p.cheap.outPerM + ledger.strong.in * p.strong.inPerM + ledger.strong.out * p.strong.outPerM) / 1e6 +
    ledger.search * p.searchPerCall;
  return Math.round(y * 100) / 100;
}

async function pushWebhook(text) {
  const url = process.env.ALERT_WEBHOOK;
  if (!url) return;
  const kind = process.env.ALERT_WEBHOOK_KIND || 'feishu';
  const body = kind === 'wecom' ? { msgtype: 'text', text: { content: text } } : { msg_type: 'text', content: { text } };
  try {
    await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    log('提醒已推送到群机器人');
  } catch (e) {
    log(`提醒推送失败：${e.message}`);
  }
}

function loadDotEnv() {
  const p = path.join(ROOT, '.env');
  if (!fs.existsSync(p)) return;
  for (const line of fs.readFileSync(p, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
}
