import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { classifySource } from '../agent/sources.js';
import { sanitizeChecks, mergeRuns, judgeSystem } from '../agent/judge.js';
import { parseResellers, listedOnPage, listDiff } from '../agent/verify.js';
import { buildCard } from '../agent/feishu.js';
import { rank, monteCarlo } from '../lib/score.js';

const fw = JSON.parse(fs.readFileSync(new URL('../data/framework.json', import.meta.url)));
const run = JSON.parse(fs.readFileSync(new URL('../data/runs/2026-10-10.json', import.meta.url)));

test('来源分级由代码按网址判断', () => {
  const co = { site_domains: ['shoplazza.cn'] };
  assert.equal(classifySource('https://metaforbusiness.cn/resellers', co), 'official');
  assert.equal(classifySource('https://www.tiktokforbusinessoutbound.com/partners/1374', co), 'official');
  assert.equal(classifySource('https://www1.hkexnews.hk/listedco/x.pdf', co), 'listed');
  assert.equal(classifySource('https://www.qcc.com/firm/abc.html', co), 'registry_mirror');
  assert.equal(classifySource('https://www.shoplazza.cn/pages/about-us', co), 'self');
  assert.equal(classifySource('https://www.sinoclick.com/news/article/1', co), 'secondhand');
  assert.equal(classifySource('https://m.ebrun.com/471366.html', co), 'media');
  assert.equal(classifySource('not a url', co), 'secondhand');
});

test('清洗模型输出：没证据的结论改成查不到，编造的证据 id 被丢弃', () => {
  const evidence = [{ id: 'e1' }];
  const raw = {
    c1: { s: true, ev: ['e1'], note: 'ok' },
    c2: { s: true, ev: ['e999'] },
    c3: { s: false },
    zz: { s: true, ev: ['e1'] },
  };
  const { checks, dropped } = sanitizeChecks(raw, evidence, fw);
  assert.equal(checks.c1.s, true);
  assert.equal(checks.c2.s, null);
  assert.equal(checks.c3.s, null);
  assert.equal(dropped, 2);
  assert.ok(!('zz' in checks));
  assert.equal(checks.c4.s, null, '没回答的检查项按查不到处理');
});

test('清洗模型输出：档位只留给分档且成立的检查项；多次运行档位不一致取低档', () => {
  const evidence = [{ id: 'e1' }];
  const { checks } = sanitizeChecks({ c1: { s: true, tier: 1, ev: ['e1'] }, c2: { s: true, tier: 1, ev: ['e1'] }, t5: { s: true, tier: 7, ev: ['e1'] } }, evidence, fw);
  assert.equal(checks.c1.tier, 1);
  assert.ok(!('tier' in checks.c2), 'c2 不分档');
  assert.ok(!('tier' in checks.t5), '越界档位去掉，评分时按最低档');
  const { checks: m } = mergeRuns([{ c1: { s: true, tier: 1, ev: ['e'] } }, { c1: { s: true, tier: 0, ev: ['e'] } }]);
  assert.equal(m.c1.tier, 0);
  assert.ok(judgeSystem(fw).includes('分档'));
});

test('多次运行：判断不一致的检查项转人工复核', () => {
  const a = { c1: { s: true, ev: ['e'] }, c2: { s: false, ev: ['e'] } };
  const b = { c1: { s: true, ev: ['e'] }, c2: { s: true, ev: ['e'] } };
  const { checks, disputed } = mergeRuns([a, b]);
  assert.equal(checks.c1.s, true);
  assert.equal(checks.c2.s, null);
  assert.deepEqual(disputed, ['c2']);
});

test('提示词列出所有检查项，并要求查不到时输出 null', () => {
  const p = judgeSystem(fw);
  for (const d of fw.dimensions) for (const c of d.checks) assert.ok(p.includes(c.id));
  assert.ok(p.includes('s=null'));
});

test('官方名单解析与变化监控', () => {
  const page = '官方代理商 YinoLink 易诺 熊猫新媒 维卓 蓝标传媒 GatherOne 飞书深诺 钛动科技 雨果跨境 省广集团 猎豹移动';
  const list = parseResellers(page);
  assert.equal(list.length, 10);
  assert.ok(!listedOnPage(page, { short: '店匠', aliases: ['Shoplazza'] }));
  assert.ok(listedOnPage(page, { short: '钛动', aliases: ['钛动科技'] }));
  assert.deepEqual(listDiff(list, [...list, 'HuntMobi']).added, ['HuntMobi']);
});

test('飞书卡片包含排名、门槛和提醒', () => {
  const ranking = rank(run.companies, fw, null, 'conservative');
  const mc = monteCarlo(run.companies, fw, null, { n: 300 });
  const card = buildCard({ runId: 'x', ranking, mc, alerts: [{ level: 'opportunity', text: '测试提醒' }], review: ['宜客.k3'] });
  const s = JSON.stringify(card);
  assert.equal(card.msg_type, 'interactive');
  assert.ok(s.includes('长虹佳华') && s.includes('测试提醒') && s.includes('待人工复核'));
});
