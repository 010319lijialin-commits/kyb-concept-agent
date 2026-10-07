// 检索和抓取。检索用 Tavily（TAVILY_API_KEY），没配就只抓 companies.json 里的种子链接。
import { ledger } from './llm.js';

export async function search(query, max = 3) {
  const key = process.env.TAVILY_API_KEY;
  if (!key) return [];
  ledger.search += 1;
  const resp = await fetch('https://api.tavily.com/search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify({ query, max_results: max, search_depth: 'basic' }),
  });
  if (!resp.ok) throw new Error(`搜索失败 ${resp.status}`);
  const data = await resp.json();
  return (data.results || []).map((r) => ({ url: r.url, title: r.title, published: r.published_date || null }));
}

export async function fetchText(url, limit = 20000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15000);
  try {
    const resp = await fetch(url, { signal: ctrl.signal, headers: { 'User-Agent': 'Mozilla/5.0 meta-agency-radar' } });
    if (!resp.ok) return null;
    const html = await resp.text();
    return htmlToText(html).slice(0, limit);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export function htmlToText(html) {
  return String(html)
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
}
