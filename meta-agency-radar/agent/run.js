// 滚动跑入口。
//   node agent/run.js --offline               不调模型：按名单 + 最新一期数据重算（红线核查、排名、概率、翻盘条件），和上一期对比，出提醒
//   node agent/run.js                         在线：核对 Meta 官方名单 → 检索 → 便宜模型抽证据（核对引文）→ 强模型判断检查项 → 代码打分 → 对比 → 提醒
//   node agent/run.js --only=lingtok,addragon 只重跑部分公司，其余沿用上一期
// 定时：crontab 每周一 9 点 `0 9 * * 1 cd /path && node agent/run.js && node build.js`
// 提醒：配 ALERT_WEBHOOK；ALERT_WEBHOOK_KIND = feishu_card（飞书卡片）| feishu | wecom
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { rank, diffRuns, monteCarlo, conclusions, estimateCost, checkWeightRobustness, DEFAULT_PRICING } from '../lib/score.js';
import { ledger } from './llm.js';
import { collectCompany } from './collect.js';
import { judgeCompany } from './judge.js';
import { verifyMetaList, listDiff } from './verify.js';
import { buildCard, buildText } from './feishu.js';

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
const fw = readJSON(path.join(ROOT, 'data', 'framework.json'));
const roster = readJSON(path.join(ROOT, 'data', 'companies.json')).companies;
const today = new Date().toISOString().slice(0, 10);

const runFiles = fs.readdirSync(RUNS).filter((f) => f.endsWith('.json')).sort();
const realRuns = runFiles.filter((f) => !f.includes('simulated'));
const latestFile = args.from || realRuns.at(-1);
const latest = latestFile ? readJSON(path.join(RUNS, latestFile)) : { companies: [] };

let curr;
if (args.offline) {
  curr = { ...latest, run_id: `${latest.run_id}-offline`, companies: applyRoster(latest.companies) };
  log(`离线模式：沿用 ${latestFile} 的数据，名单 ${curr.companies.length} 家`);
} else {
  curr = await onlineRun();
  fs.writeFileSync(path.join(RUNS, `${today}.json`), JSON.stringify(curr, null, 2) + '\n');
  log(`已保存 data/runs/${today}.json`);
}

// 对比基准：--prev 指定；否则取本期之前最近的真实一期；没有就用模拟基线并明确标注
const prevFile =
  args.prev ||
  realRuns.filter((f) => f < (args.offline ? latestFile : `${today}.json`)).at(-1) ||
  runFiles.filter((f) => f.includes('simulated')).at(-1);
const prev = prevFile ? readJSON(path.join(RUNS, prevFile)) : null;

const selfId = roster.find((r) => r.role === 'self')?.id;
const ranking = rank(curr.companies, fw, null, 'conservative');
const mc = monteCarlo(curr.companies, fw, null);
const k = conclusions(curr.companies, fw, null, 'conservative', selfId);
const S = fw.gates.states;

const lines = [`# Meta 一代竞争力雷达 · ${curr.run_id}`, '', '| 名次 | 公司 | 已证实分 | 可能区间 | 资金红线 | 合规红线 | 排第一 | 前 2 | 出局 |', '|---|---|---|---|---|---|---|---|---|'];
for (const r of ranking) {
  const p = mc[r.id];
  lines.push(`| ${r.rank} | ${r.company.short}${r.company.role === 'self' ? '（我方）' : ''} | ${r.total} | ${r.low}–${r.high} | ${S[r.gates.gate_fin.state].label} | ${S[r.gates.gate_comp.state].label} | ${pct(p.pFirst)} | ${pct(p.pTop2)} | ${pct(p.pOut)} |`);
}
if (k.flip && k.nearest) {
  lines.push('', `## 和${k.nearest.company.short}之间`, '');
  lines.push(k.flip.gap > 0 ? `落后 ${k.flip.gap} 分。最快追平：${k.flip.checkPath.map((s) => `${s.how || s.check.text}（+${s.gain}）`).join('；')}` : `领先 ${-k.flip.gap} 分。`);
  for (const wf of k.flip.weightFlips.slice(0, 3)) lines.push(`- 「${wf.dim.name}」权重从 ${wf.from} 调到 ${wf.to}，两家排序互换`);
  const rob = checkWeightRobustness(curr.companies, fw, null, 'conservative');
  lines.push(`- 检查项分值换种给法（随机浮动 ${rob.n} 次）：排序和现在完全相同 ${pct(rob.sameOrder)}；我方排在${k.nearest.company.short}前面 ${pct(rob.ahead[selfId][k.nearest.id])}`);
}

let alerts = [];
if (prev) {
  alerts = diffRuns(prev, curr, fw, null, 'conservative').alerts;
  const listChange = listDiff(prev.reference?.resellers, curr.reference?.resellers);
  if (listChange.added.length) alerts.unshift({ level: 'threat', company: 'Meta', text: `Meta 官网代理商名单新增：${listChange.added.join('、')}` });
  if (listChange.removed.length) alerts.unshift({ level: 'opportunity', company: 'Meta', text: `Meta 官网代理商名单移出：${listChange.removed.join('、')}` });
  lines.push('', `## 与上一期（${prev.run_id}${prev.simulated ? '，模拟基线' : ''}）相比`, '');
  if (!alerts.length) lines.push('无显著变化。');
  const tag = { opportunity: '【机会】', threat: '【威胁】', info: '【复核】' };
  for (const a of alerts) lines.push(`- ${tag[a.level]}${a.text}`);
  if (prev.simulated) lines.push('', '> 上一期是模拟数据，只用来演示对比和提醒机制。');
}
const review = curr.companies.flatMap((c) => (c.review || []).map((id) => `${c.short}.${id}`));
if (review.length) lines.push('', `## 待人工复核`, '', review.map((x) => `- ${x}`).join('\n'));

if (!args.offline) lines.push('', '## 本次成本', '', `便宜模型 ${ledger.cheap.calls} 次，强模型 ${ledger.strong.calls} 次，检索 ${ledger.search} 次，约 ¥${actualCost()}`);
const est = estimateCost(curr.companies.length, fw.dimensions.length);
lines.push('', '> 概率只在名单内比较，只反映红线核查和查得到的信息；Meta 的主观判断、路演表现、名单外候选人不在模型里。');
lines.push('', `预估单次全量成本 ¥${est.yuan.total}（全部用强模型约 ¥${est.allStrongYuan}）`);

fs.mkdirSync(REPORTS, { recursive: true });
const reportPath = path.join(REPORTS, `${curr.run_id}.md`);
fs.writeFileSync(reportPath, lines.join('\n') + '\n');
log('\n' + lines.join('\n'));
log(`\n报告：${path.relative(ROOT, reportPath)}`);
await pushWebhook({ runId: curr.run_id, ranking, mc, alerts, review, simulatedPrev: prev?.simulated }, lines.join('\n'));

// ---------------------------------------------------------------

function pct(x) {
  return `${Math.round(x * 100)}%`;
}

function applyRoster(companies) {
  const byId = new Map(companies.map((c) => [c.id, c]));
  return roster.map((r) => byId.get(r.id) || { id: r.id, name: r.name, short: r.short, role: r.role, positioning: '待采集', risks: ['新加入名单，尚未运行 Agent 采集'], checks: {}, evidence: [] });
}

async function onlineRun() {
  const only = typeof args.only === 'string' ? new Set(args.only.split(',')) : null;
  const prevById = new Map(latest.companies.map((c) => [c.id, c]));
  log('核对 Meta 官网代理商名单 …');
  const meta = await verifyMetaList(roster, today);
  const companies = [];
  for (const r of roster) {
    if (only && !only.has(r.id) && prevById.has(r.id)) {
      companies.push(prevById.get(r.id));
      continue;
    }
    log(`采集 ${r.short} …`);
    const { evidence } = await collectCompany(r, fw, { accessed: today, log });
    if (meta.ok) evidence.push(meta.evidence[r.id]);
    const judged = await judgeCompany(r, evidence, fw);
    // 官方名单是 A 级事实，直接覆盖模型对 o3 的判断
    if (meta.ok) judged.checks.o3 = meta.evidence[r.id].listed ? { s: true, ev: [`${r.id}_meta`], note: 'Meta 官网代理商名单可查' } : judged.checks.o3?.s ? judged.checks.o3 : { s: false, ev: [`${r.id}_meta`], note: '不在 Meta 官网代理商名单' };
    companies.push({ id: r.id, name: r.name, short: r.short, role: r.role, entity_note: r.entity_note || '', levers: r.levers, ...judged, evidence });
  }
  return {
    run_id: today,
    date: today,
    simulated: false,
    method: 'Agent 自动运行：核对官方名单 + 检索 + 便宜模型抽取（核对引文）+ 强模型判断检查项 + 代码打分',
    reference: { meta_reseller_list_url: 'https://metaforbusiness.cn/resellers', resellers: meta.resellers, meta_reseller_list_note: meta.ok ? `${today} 官网列出 ${meta.resellers.length} 家` : '本次未能访问 Meta 官网' },
    companies,
  };
}

function actualCost() {
  const p = DEFAULT_PRICING;
  const y =
    (ledger.cheap.in * p.cheap.inPerM + ledger.cheap.out * p.cheap.outPerM + ledger.strong.in * p.strong.inPerM + ledger.strong.out * p.strong.outPerM) / 1e6 +
    ledger.search * p.searchPerCall;
  return Math.round(y * 100) / 100;
}

async function pushWebhook(card, text) {
  const url = process.env.ALERT_WEBHOOK;
  if (!url) return;
  const kind = process.env.ALERT_WEBHOOK_KIND || 'feishu_card';
  const body = kind === 'feishu_card' ? buildCard(card) : buildText(kind, text);
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
