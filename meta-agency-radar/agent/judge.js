// 第 3 步：强模型判断检查项，不打分。
// 模型只回答「这个检查项成立吗、依据哪几条证据」；分数、红线核查、排名由 lib/score.js 按规则计算。
// 可选多次运行（JUDGE_RUNS=3）：各次判断不一致的检查项改为「查不到」并标记人工复核。
import { chatJSON } from './llm.js';

function allChecks(fw) {
  return [...fw.dimensions.flatMap((d) => d.checks.map((c) => ({ ...c, dim: d.name }))), ...fw.gate_checks.map((g) => ({ ...g, dim: '红线' }))];
}

export function judgeSystem(fw) {
  const list = allChecks(fw).map((c) => `- ${c.id}（${c.dim}）：${c.text}${c.tiers ? `［分档，tier=${c.tiers.map((t, i) => `${i}：${t.label}`).join('；')}］` : ''}`).join('\n');
  return `你在帮 Meta 大中华区渠道团队核查一家候选代理商。对下列每个检查项判断是否成立。
${list}
规则：
1. 只能依据给出的证据 id，不能用常识补充。
2. 有证据支持成立 → s=true；有证据表明不成立 → s=false；没有相关证据 → s=null（这是正常结果，不要猜）。
3. 证据只证明邻近能力时不能算成立（例：拿到平台资质证明的是运营能力，不等于有自研技术）。
4. 只有不利传闻、没有可靠来源时，s=null 并设 adverse=true。
5. 每个 s=true 或 s=false 的检查项必须列出证据 id。
6. 标了「分档」的检查项成立时，再给出证据能支持的最高档 tier（0 起算）；拿不准就给低档。
输出 JSON：
{"checks":{"c1":{"s":true|false|null,"tier":0,"ev":["证据id"],"note":"一句话依据","adverse":false}, ...},
 "positioning":"一句话定位","strategy":"它竞标 Meta 一代最可能打的牌","advantage":"最大优势","weakness":"致命弱点","risks":["待核实事项"]}`;
}

// 清洗模型输出：未知检查项丢弃；引用了不存在的证据就去掉；没有有效证据的 true/false 改成 null；
// 档位只留给分档且成立的检查项，越界的去掉（评分时按最低档）。
export function sanitizeChecks(raw, evidence, fw) {
  const ids = new Set(evidence.map((e) => e.id));
  const checks = Object.fromEntries(allChecks(fw).map((c) => [c.id, c]));
  const valid = new Set(Object.keys(checks));
  const out = {};
  let dropped = 0;
  for (const id of valid) {
    const a = raw?.[id] || {};
    const ev = (Array.isArray(a.ev) ? a.ev : []).filter((x) => ids.has(x));
    let s = a.s === true || a.s === false ? a.s : null;
    if (s !== null && !ev.length) {
      s = null;
      dropped += 1;
    }
    const nt = checks[id].tiers?.length ?? 0;
    const tier = s === true && Number.isInteger(a.tier) && a.tier >= 0 && a.tier < nt ? { tier: a.tier } : {};
    out[id] = { s, ...tier, ev, note: String(a.note || '').slice(0, 200), ...(a.adverse ? { adverse: true } : {}) };
  }
  return { checks: out, dropped };
}

// 多次运行取一致：任意两次结论不同的检查项改为 null，并记下来交给人工复核。
export function mergeRuns(runs) {
  const ids = Object.keys(runs[0] || {});
  const merged = {};
  const disputed = [];
  for (const id of ids) {
    const states = runs.map((r) => r[id]?.s ?? null);
    if (states.every((s) => s === states[0])) {
      // 档位不一致时取最低档
      const tiers = runs.map((r) => r[id]?.tier).filter(Number.isInteger);
      merged[id] = tiers.length ? { ...runs[0][id], tier: Math.min(...tiers) } : runs[0][id];
    } else {
      merged[id] = { s: null, ev: [], note: `模型 ${runs.length} 次判断不一致（${states.map(String).join(' / ')}），转人工复核` };
      disputed.push(id);
    }
  }
  return { checks: merged, disputed };
}

export async function judgeCompany(company, evidence, fw, { runs = Number(process.env.JUDGE_RUNS || 1) } = {}) {
  const ev = evidence.map((e) => `[${e.id}] (${e.type}, ${e.published || '日期未知'}) ${e.claim}`).join('\n');
  const user = `公司：${company.name}\n证据：\n${ev || '（无）'}`;
  const results = [];
  let meta = {};
  let dropped = 0;
  for (let i = 0; i < Math.max(1, runs); i++) {
    const out = await chatJSON('strong', judgeSystem(fw), user);
    const clean = sanitizeChecks(out.checks, evidence, fw);
    dropped += clean.dropped;
    results.push(clean.checks);
    if (i === 0) meta = out;
  }
  const { checks, disputed } = results.length > 1 ? mergeRuns(results) : { checks: results[0], disputed: [] };
  return {
    checks,
    review: disputed,
    droppedClaims: dropped,
    positioning: meta.positioning || '',
    strategy: meta.strategy || '',
    advantage: meta.advantage || '',
    weakness: meta.weakness || '',
    risks: Array.isArray(meta.risks) ? meta.risks : [],
  };
}
