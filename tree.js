// 思维树（枝）的共享定义：块类型、关系类型、表达模式。
// 和 structures.js 一样，前后端共用同一份，改这里就够了。

// 一个节点不是一条笔记，它由不同角色的「块」组成。
// AI 每次挂载碎片时，必须判断这段碎片在目标节点里扮演哪个角色。
export const BLOCK_TYPES = [
  '核心观点',
  '原因',
  '案例',
  '反例',
  '数据',
  '我的思考',
  '相关观点',
  '待验证问题',
];

// 表面是树，底层是图：同一个观点可以横向关联到别的主题。
export const RELATION_TYPES = {
  related_to: '相关',
  supports: '支持',
  contradicts: '矛盾',
  example_of: '是…的例子',
  derived_from: '推导自',
};

// 表达模式 —— 这里是「枝」和表达练习产品的接缝：
// 每种表达场景直接复用结构库里的一个结构，生成的稿子可以一键拿去练习页开口练。
export const EXPRESS_MODES = [
  {
    id: 'opinion',
    name: '观点版',
    structureId: 'prep',
    scene: '跟人聊天时抛出这个观点',
    ask: '像跟朋友聊天一样，先把结论砸出来，再给理由和例子。60 秒能说完。',
  },
  {
    id: 'interview',
    name: '面试版',
    structureId: 'star',
    scene: '面试里被问到相关问题',
    ask: '落到你自己做过的具体事情上，Action 要占一半，Result 要有数字或可复用的结论。',
  },
  {
    id: 'xhs',
    name: '小红书版',
    structureId: 'story',
    scene: '发一条分享',
    ask: '从一个具体画面或一件小事切入，口语、有情绪、短句，最后收到一句可以被转发的话。',
  },
  {
    id: 'report',
    name: '汇报版',
    structureId: 'pyramid',
    scene: '向上汇报或对外讲这个判断',
    ask: '结论先行，30 秒版本先说完，论据分条，最后收口到「所以我建议…」。',
  },
];

export const EXPRESS_INDEX = Object.fromEntries(EXPRESS_MODES.map((m) => [m.id, m]));

export function blockTypesForPrompt() {
  return BLOCK_TYPES.join(' / ');
}

export function relationTypesForPrompt() {
  return Object.entries(RELATION_TYPES)
    .map(([k, v]) => `${k}(${v})`)
    .join(' / ');
}

// 把前端传来的节点列表压成给模型看的树 outline。
// 每行都带 id，模型才能准确引用已有节点，而不是靠标题猜。
export function outlineForPrompt(nodes = [], limit = 300) {
  if (!nodes.length) return '（这棵树还是空的，你需要新建顶层节点）';
  return nodes
    .slice(0, limit)
    .map((n) => {
      const bits = [`${n.id} | ${n.path}`];
      if (n.blocks) bits.push(`已有 ${n.blocks} 条碎片`);
      if (n.types?.length) bits.push(`包含：${n.types.join('、')}`);
      return `- ${bits.join(' | ')}`;
    })
    .join('\n');
}
