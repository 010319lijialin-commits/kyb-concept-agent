// 表达结构库：MVP 的核心资产。
// 每个结构都带 trigger（什么场景下该条件反射地用它）和 slots（说话时要填的空）。
// 复盘时模型必须从这里挑一个 target 结构，并按 slots 逐格给出你实际填了什么、缺了什么。

export const STRUCTURES = [
  {
    id: 'prep',
    name: 'PREP 观点先行',
    trigger: '被问"你怎么看" / 要表态 / 争论中要站队',
    slots: ['Point 结论一句话', 'Reason 为什么（1-3 条）', 'Example 具体例子', 'Point 重申并给行动'],
    cue: '第一句就把结论说完，别铺垫。',
  },
  {
    id: 'scqa',
    name: 'SCQA 讲清问题',
    trigger: '提案 / 说服别人立项 / 开场引出话题',
    slots: ['Situation 大家都认的现状', 'Complication 出现了什么变化或矛盾', 'Question 所以问题是什么', 'Answer 我的答案'],
    cue: '先建立共识，再制造张力，最后才给答案。',
  },
  {
    id: 'star',
    name: 'STAR 讲经历',
    trigger: '面试 / 自我介绍 / 举例证明自己做过',
    slots: ['Situation 背景', 'Task 我的目标', 'Action 我具体做了什么', 'Result 量化结果 + 复用价值'],
    cue: 'Action 要占一半篇幅，Result 必须有数字。',
  },
  {
    id: 'pyramid',
    name: '金字塔 结论先行',
    trigger: '向上汇报 / 时间很短 / 对方是决策者',
    slots: ['结论 / 我要什么', '支撑论据 1', '支撑论据 2', '支撑论据 3', '收口：所以请你…'],
    cue: '30 秒版本先说完，细节等对方问。',
  },
  {
    id: 'tradeoff',
    name: '方案取舍',
    trigger: '要做技术/产品选型 / 别人问"为什么不用另一个"',
    slots: ['目标和约束', '候选方案 A / B', '判断标准（成本、风险、速度…）', '结论及被放弃项的代价'],
    cue: '先亮判据，再亮结论，别直接吵方案。',
  },
  {
    id: 'progress',
    name: '进展同步',
    trigger: '站会 / 周报 / 老板问"到哪了"',
    slots: ['进度：完成度 + 是否 on track', '风险：最可能出问题的一件事', '需求：需要谁做什么，什么时候'],
    cue: '三句话：到哪了、什么会崩、要你帮什么。',
  },
  {
    id: 'retro',
    name: '复盘归因',
    trigger: '出事之后 / 项目结束 / 别人问"为什么没做成"',
    slots: ['事实：发生了什么（不带评价）', '影响：造成了什么损失', '归因：可控因素 vs 不可控', '改进：下次的具体动作'],
    cue: '事实和评价分开说，归因只谈自己可控的。',
  },
  {
    id: 'story',
    name: '故事化',
    trigger: '需要打动人 / 分享 / 破冰 / 让抽象概念落地',
    slots: ['具体场景（时间地点人物）', '转折：本来以为…结果', '一个感官细节', '所以它意味着什么'],
    cue: '从一个具体画面开始，不要从道理开始。',
  },
  {
    id: 'define',
    name: '概念解释',
    trigger: '别人问"这是什么" / 要给外行讲专业内容',
    slots: ['一句话定义（它属于什么 + 有何不同）', '类比：就像…', '正例 / 反例边界', '为什么你要关心'],
    cue: '先归类再区分，然后立刻给类比。',
  },
  {
    id: 'ask',
    name: '提要求 / 谈判',
    trigger: '要资源 / 要加薪 / 推动别人配合',
    slots: ['我要什么（具体、可执行）', '对你的价值', '我已经做了什么（诚意）', '备选方案 / 底线'],
    cue: '要求要具体到"谁在什么时候做什么"。',
  },
];

export const STRUCTURE_INDEX = Object.fromEntries(STRUCTURES.map((s) => [s.id, s]));

export function structuresForPrompt() {
  return STRUCTURES.map(
    (s) => `- ${s.id} | ${s.name} | 适用: ${s.trigger} | 槽位: ${s.slots.join(' → ')}`
  ).join('\n');
}
