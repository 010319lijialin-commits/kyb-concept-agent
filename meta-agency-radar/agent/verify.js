// 官方名单核验：抓 Meta 海外营销官网的代理商页，判断每家公司是否在名单上，并监控名单本身的变化。
// 名单变化（有新一代或有人被移出）是整个竞标里最重要的事件。
import { fetchText } from './search.js';

export const META_RESELLER_URL = 'https://metaforbusiness.cn/resellers';

// 已知现任代理商名称（用于从页面文本里识别名单）
export const KNOWN_RESELLERS = ['YinoLink', '易诺', '熊猫新媒', '维卓', '蓝标传媒', 'GatherOne', '飞书深诺', '飞书逸途', '钛动科技', '雨果跨境', '省广集团', '猎豹移动', 'HuntMobi', '前海像样'];

export function parseResellers(text, known = KNOWN_RESELLERS) {
  const found = known.filter((n) => text.includes(n));
  // 同一家的中英文名合并
  const merged = new Set(found.map((n) => ({ 易诺: 'YinoLink', 飞书逸途: '飞书深诺', 前海像样: 'HuntMobi' }[n] || n)));
  return [...merged].sort();
}

export function listedOnPage(text, company) {
  const names = [company.short, company.name, ...(company.aliases || [])].filter(Boolean);
  return names.some((n) => text.includes(n));
}

export function listDiff(prev = [], curr = []) {
  return { added: curr.filter((x) => !prev.includes(x)), removed: prev.filter((x) => !curr.includes(x)) };
}

export async function verifyMetaList(companies, accessed) {
  const text = await fetchText(META_RESELLER_URL, 200000);
  if (!text) return { ok: false, resellers: [], evidence: {} };
  const resellers = parseResellers(text);
  const evidence = {};
  for (const c of companies) {
    const on = listedOnPage(text, c);
    evidence[c.id] = {
      id: `${c.id}_meta`,
      claim: on ? `Meta 官网代理商名单列出了${c.short}` : `Meta 官网代理商名单（${resellers.length} 家）未列出${c.short}`,
      url: META_RESELLER_URL,
      source: 'Meta 海外营销官网',
      type: 'official',
      published: null,
      accessed,
      read: '原文',
      listed: on,
    };
  }
  return { ok: true, resellers, evidence };
}
