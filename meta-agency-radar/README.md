# Meta 一代竞争力雷达

长虹佳华竞标 Meta 中国大陆一级代理（reseller）的竞对分析工具：
公开信息 → 证据卡（来源、日期、置信度）→ 按 Meta 视角加权评分 → 排名和结论 → 定期重跑、diff、提醒。

- 一页简报：[BRIEF.md](BRIEF.md)
- 可交互 demo：`npm run build` 后打开 `dist/radar.html`（单文件，可直接发群）

页面分四层，CEO 只看第一层也能拿到结论：
1. **结论和怎么做**：一句话结论、行动建议、排名、长短板。每一条都能点开：为什么 → 各家在这一维的对比 → 证据和来源 → 打分标准和权重理由。
2. **调一调**：「我的判断」改权重、增减名单、改未知的算法，每个权重旁边能点开看它为什么是这个数；「市场新信息」录入一条情报等同一次重跑。两种改动都会在顶部标出「和初始结论相比」变了什么、因为什么。
3. **每家公司的证据**：公司 → 维度 → 证据（链接、日期、置信度）。
4. **方法、成本与局限**：默认收起。

## 目录

```
data/framework.json      评分维度、权重和理由、Meta 公开信号、评分细则、检索模板
data/companies.json      名单（在这里增减公司）
data/runs/<日期>.json     每一期的证据卡和分数；*.simulated.json 是演示 diff 用的模拟基线
lib/score.js             评分、排名、结论、diff、成本估算（Node 和页面共用）
agent/                   Agent 流水线：search → collect（便宜模型抽取 + 引文核对）→ judge（强模型判分）→ run（diff、提醒）
agent/calibrate.js       用已知结果回测权重
web/radar.html           页面模板；build.js 把数据和评分逻辑内联成 dist/radar.html
test/                    单元测试
```

## 用法

```bash
npm test                          # 9 个测试：评分、未知处理、名单增减、diff、引文核对、成本、校验、数据完整性
npm run agent:offline             # 不调模型：按名单和已有证据重新排名，和上一期 diff，写 reports/
cp .env.example .env && npm run agent   # 在线全量跑，生成新一期 data/runs/<今天>.json
node agent/run.js --only=lingtok  # 只重跑部分公司
npm run build                     # 生成 dist/radar.html
```

定时：`0 9 * * 1 cd /path/meta-agency-radar && node agent/run.js && node build.js`，配 `ALERT_WEBHOOK` 推送到飞书/企业微信。

## 设计要点

**不编造**。三道闸：抽取时每条证据必须带原文引文，程序核对引文在网页正文里；判分时只能引用已核对证据的 id，引用不存在或没有引用的维度强制为「未知」；
「未知」不按 0 分算，页面给出三种处理方式（保守 1.5 / 中性 2.5 / 剔除重算）和「未知按 0 到按 5」的得分区间，区间宽说明结论依赖补证据。

**模型编排**。检索不用模型；逐页抽取量大、任务简单，用便宜模型；每家公司一次综合判分，用强模型；加权、排名、diff 是纯代码，可复算。

**合规**。OpenAI 兼容接口可换国产模型；`LLM_PROVIDER=azure` 走 Azure OpenAI。

## v1 的数据说明

`data/runs/2026-09-30.json` 由人工按 Agent 同样的规则整理（检索 → 读原文 → 逐条记来源），每条证据标注是否读过原文，只看过搜索摘要的置信度不超过「中」。
在线流水线已写好并有测试，但本仓库没有附带 API key，未做过一次真实在线运行。
