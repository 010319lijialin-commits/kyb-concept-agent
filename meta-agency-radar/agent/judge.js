// 第 3 步：强模型按评分细则给每个维度打分。只能引用已核对过的证据，没证据的维度强制为未知。
import { chatJSON } from './llm.js';

function judgeSystem(framework) {
  const rubric = framework.dimensions
    .map((d) => `- ${d.id}（${d.name}）：${Object.entries(d.rubric).map(([k, v]) => `${k}=${v}`).join('；')}`)
    .join('\n');
  return `你站在 Meta 大中华区渠道团队的角度，评估一家公司做 Meta 一级代理（reseller）的竞争力。
${framework.perspective}
评分细则（0-5，可用 .5）：
${rubric}
规则：
1. 每个维度只能依据给出的证据 id 打分，rationale 里写清依据。
2. 某维度没有相关证据，score 必须是 null，不能凭常识猜。
3. 自述类证据互相矛盾时（如客户数与人员规模不匹配），降低置信度并在 risks 里写明。
输出 JSON：
{"dims":{"finance":{"score":数字或null,"confidence":"高|中|低","rationale":"...","evidence":["id"]},...六个维度},
 "positioning":"一句话定位","strategy":"它竞标 Meta 一代最可能打的牌","risks":["..."]}`;
}

export async function judgeCompany(company, evidence, framework) {
  const ev = evidence.map((e) => `[${e.id}] (${e.dim}, ${e.confidence}, ${e.published || '日期未知'}) ${e.claim}`).join('\n');
  const out = await chatJSON('strong', judgeSystem(framework), `公司：${company.name}\n证据：\n${ev || '（无）'}`);
  const ids = new Set(evidence.map((e) => e.id));
  const dims = {};
  for (const d of framework.dimensions) {
    const r = out.dims?.[d.id] || {};
    const cited = (r.evidence || []).filter((id) => ids.has(id));
    let score = typeof r.score === 'number' ? Math.max(0, Math.min(5, r.score)) : null;
    // 闸门：引用了不存在的证据或没有引用，一律按未知处理
    if (!cited.length) score = null;
    dims[d.id] = {
      score,
      confidence: score == null ? '低' : r.confidence || '低',
      rationale: score == null ? '没有可引用的公开证据，标为未知。' : r.rationale || '',
      evidence: cited,
    };
  }
  return { dims, positioning: out.positioning || '', strategy: out.strategy || '', risks: out.risks || [] };
}
