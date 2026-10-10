// 来源分级：按网址判断证据类型，类型决定 A/B/C 级（见 framework.json 的 evidence_grades）。
// 规则写在代码里，不交给模型判断。

const OFFICIAL = [
  'metaforbusiness.cn',
  'facebook.com/business',
  'tiktokforbusinessoutbound.com',
  'ads.tiktok.com',
  'google.com/partners',
  'partners.google.com',
];
const REGISTRY = ['gsxt.gov.cn', 'wenshu.court.gov.cn', 'zxgk.court.gov.cn', 'creditchina.gov.cn'];
const LISTED = ['hkexnews.hk', 'cninfo.com.cn', 'sse.com.cn', 'szse.cn', 'sec.gov'];
const REGISTRY_MIRROR = ['qcc.com', 'tianyancha.com', 'aiqicha.baidu.com', 'qixin.com', 'shuidi.cn'];
// 现任代理商或服务商的营销文章：利益相关，只作线索
const SECONDHAND = ['sinoclick.com', 'pandawm.com', 'overseas.cmcm.com', 'yinolink.com', 'wabei.cn', 'cnblogs.com', 'zhihu.com'];

function hostPath(url) {
  try {
    const u = new URL(url);
    return (u.hostname.replace(/^www\./, '') + u.pathname).toLowerCase();
  } catch {
    return '';
  }
}

export function classifySource(url, company = {}) {
  const hp = hostPath(url);
  if (!hp) return 'secondhand';
  const match = (list) => list.some((d) => hp.startsWith(d) || hp.includes('.' + d) || hp.includes(d + '/'));
  if (match(REGISTRY)) return 'registry';
  if (match(LISTED)) return 'listed';
  if (match(OFFICIAL)) return 'official';
  if (match(REGISTRY_MIRROR)) return 'registry_mirror';
  if ((company.site_domains || []).some((d) => hp.startsWith(d) || hp.includes('.' + d))) return 'self';
  if (match(SECONDHAND)) return 'secondhand';
  return 'media';
}
