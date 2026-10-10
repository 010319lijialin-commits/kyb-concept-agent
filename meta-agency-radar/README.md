# Meta 一代竞争力雷达

长虹佳华竞标 Meta 中国大陆一级代理（reseller）的竞对分析工具：
公开信息 → 证据（来源、等级、日期）→ 检查项 → 门槛 + 加权评分 + 排名概率 → 结论和行动 → 定期重跑、对比、提醒。

- **一页简报**：[BRIEF.md](BRIEF.md)，PDF 版 `dist/brief.pdf`
- **交互页面**：`dist/radar.html`（单文件，双击打开，可直接发群）
- **方法附录**：[METHOD.md](METHOD.md)
- **改动说明**：[CHANGELOG.md](CHANGELOG.md)

## 页面结构（按 CEO 的问题）

| 层级 | 回答什么 | 放什么 |
|---|---|---|
| 第一屏 | 能不能赢、怎么赢、要拍板什么 | 一句话结论、三个关键数、行动建议、三件待拍板的事；改过设置后显示「和初始结论相比」 |
| 能不能赢 | 门槛和排名 | 门槛 + 分数区间 + 排名概率；四家对手一览 |
| 凭什么选我们 | Meta 要补的缺口谁能补 | 缺口矩阵（对照现任一代）；五个关键判断 |
| 稳不稳 | 哪些数是硬的，补什么能翻盘 | 证据强度热力图；差距来源；翻盘条件 |
| 怎么打 | 不同情景下的路演主线 | 名额数、客户结构、结盟情况三个开关 |
| 值不值得 | 一代的账 | 返点、授信、坏账、团队的损益和打平线（示例假设） |
| 调一调 | 换个条件会怎样 | 权重（含两两比较法定权）、名单、口径、不确定性假设；录入新情报 |
| 证据 / 方法 | 每个数怎么来的 | 资质核验表、口径冲突、每家每个检查项的证据；方法、成本、迭代规划、边界 |

## 目录

```
data/framework.json      维度与检查项、门槛规则、证据分级、Meta 公开信号、现任一代、缺口矩阵
data/companies.json      名单（在这里增减公司；我方的可执行抓手）
data/runs/<日期>.json     每一期：检查项判断 + 证据 + 资质核验 + 口径冲突 + 关键判断
data/runs/*.simulated.json 模拟基线，只用于演示滚动对比
data/archive/v1/         v1 的框架和数据
lib/score.js             评分引擎（Node 和页面共用）：门槛、检查项打分、证据封顶、排名概率、翻盘条件、对比、层次分析法、评委一致率、成本
agent/                   自动流程：verify（官方名单）→ search → collect（便宜模型抽取 + 引文核对 + 来源分级）→ judge（强模型判断检查项）→ run（打分、对比、提醒、飞书卡片）
agent/calibrate.js       权重回测
web/radar.html           页面模板；build.js 内联成 dist/radar.html
pdf.js                   BRIEF.md → dist/brief.pdf
test/                    25 个测试
```

## 用法

```bash
npm test                          # 评分引擎、门槛、概率、翻盘条件、对比、定权、评委校准、Agent 各环节
npm run agent:offline             # 不调模型：按名单和最新一期数据重算，和上一期对比，写 reports/
cp .env.example .env && npm run agent   # 在线全量跑（需要模型和搜索的 key）
node agent/run.js --only=lingtok  # 只重跑部分公司
JUDGE_RUNS=3 npm run agent        # 多次判断取一致，不一致转人工
npm run build && npm run pdf      # 生成 dist/radar.html 和 dist/brief.pdf
```

定时：`0 9 * * 1 cd /path/meta-agency-radar && node agent/run.js && node build.js`；配 `ALERT_WEBHOOK` 推送飞书卡片。

## v1.1 的数据说明

检查项由人工按 Agent 的同一套规则判断，每条证据标注来源类型、发布和访问日期、是否读过原文。
工商和司法数据本次无法直接访问，相关线索来自转引，只用作「待定·有不利线索」。
自动流程代码和测试已就绪，还没有用真实 API key 跑过。
