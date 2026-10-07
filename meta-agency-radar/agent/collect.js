// 第 1-2 步：检索 + 便宜模型抽证据。抽出来的每条都要带原文引文，程序核对引文确实在网页里，对不上就丢弃。
import { chatJSON } from './llm.js';
import { search, fetchText } from './search.js';
import { quoteInText } from '../lib/score.js';

const EXTRACT_SYSTEM = `你是尽调助理，只做信息抽取，不做判断。
规则：
1. 只能使用给你的网页正文，不能用你自己的知识补充。
2. 每条证据必须附 quote：从正文里原样复制的一句话（10-80 字）。复制不出原文就不要输出这条。
3. 找不到就返回空数组，绝不编造数字、日期、资质。
4. dim 只能是：finance, scale, clients, tech, compliance, background。
输出 JSON：{"items":[{"dim":"...","claim":"一句话事实","quote":"原文","published":"YYYY-MM-DD 或 null","confidence":"高|中|低"}]}
自述类内容（公司官网、招聘页自我介绍）置信度最高给「中」。`;

export async function collectCompany(company, framework, { accessed, log = () => {} }) {
  const urls = new Map();
  for (const u of company.seed_urls || []) urls.set(u, { url: u, published: null });
  for (const d of framework.dimensions) {
    for (const tpl of d.query_templates.slice(0, 1)) {
      const q = tpl.replace('{name}', company.search_name || company.short);
      try {
        for (const r of await search(q)) if (!urls.has(r.url)) urls.set(r.url, r);
      } catch (e) {
        log(`  检索失败：${q}（${e.message}）`);
      }
    }
  }

  const evidence = [];
  let rejected = 0;
  let n = 0;
  for (const { url, published } of urls.values()) {
    const text = await fetchText(url);
    if (!text || text.length < 200) continue;
    let out;
    try {
      out = await chatJSON('cheap', EXTRACT_SYSTEM, `公司：${company.name}（${company.short}）\n网址：${url}\n正文：\n${text}`);
    } catch (e) {
      log(`  抽取失败：${url}（${e.message}）`);
      continue;
    }
    for (const it of out.items || []) {
      if (!quoteInText(it.quote, text)) {
        rejected += 1;
        continue;
      }
      evidence.push({
        id: `${company.id}-${++n}`,
        dim: it.dim,
        claim: it.claim,
        quote: it.quote,
        url,
        source: new URL(url).hostname,
        published: it.published || published || null,
        accessed,
        confidence: it.confidence || '低',
        read: '原文',
      });
    }
  }
  log(`  ${company.short}：${urls.size} 个网页，保留证据 ${evidence.length} 条，引文对不上被丢弃 ${rejected} 条`);
  return { evidence, rejected };
}
