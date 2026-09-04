import 'dotenv/config';
import express from 'express';
import multer from 'multer';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { STRUCTURES, STRUCTURE_INDEX, structuresForPrompt } from './structures.js';
import {
  BLOCK_TYPES,
  RELATION_TYPES,
  EXPRESS_MODES,
  EXPRESS_INDEX,
  blockTypesForPrompt,
  relationTypesForPrompt,
  outlineForPrompt,
} from './tree.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PORT = process.env.PORT || 3000;
const BASE_URL = (process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1').replace(/\/$/, '');
const API_KEY = process.env.OPENAI_API_KEY;
const TRANSCRIBE_MODEL = process.env.TRANSCRIBE_MODEL || 'gpt-4o-transcribe';
const REVIEW_MODEL = process.env.REVIEW_MODEL || 'gpt-4o';
const ACCESS_CODE = (process.env.ACCESS_CODE || '').trim();

const app = express();
app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// 部署到公网后，没有这道门任何拿到链接的人都能花你的 OpenAI 额度。
// 本地不设 ACCESS_CODE 就自动放行。
function gate(req, res, next) {
  if (!ACCESS_CODE) return next();
  const given = req.get('x-access-code') || '';
  if (given !== ACCESS_CODE) return res.status(401).json({ error: '访问码不对' });
  next();
}

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 }, // OpenAI 音频上限就是 25MB
});

function requireKey(res) {
  if (!API_KEY) {
    res.status(500).json({ error: '服务端没配 OPENAI_API_KEY，复制 .env.example 成 .env 再填。' });
    return false;
  }
  return true;
}

async function openai(pathname, init) {
  const resp = await fetch(`${BASE_URL}${pathname}`, {
    ...init,
    headers: { Authorization: `Bearer ${API_KEY}`, ...(init.headers || {}) },
  });
  const raw = await resp.text();
  if (!resp.ok) {
    let detail = raw;
    try {
      detail = JSON.parse(raw)?.error?.message || raw;
    } catch {
      /* 原样返回 */
    }
    const err = new Error(`OpenAI ${resp.status}: ${detail}`);
    err.status = resp.status;
    throw err;
  }
  return JSON.parse(raw);
}

// 复盘、分析、思维树都在跑同一个「要一段结构化 JSON」的调用，抽出来。
async function chatJSON({ system, user, temperature = 0.4 }) {
  const data = await openai('/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: REVIEW_MODEL,
      temperature,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
    }),
  });
  const content = data.choices?.[0]?.message?.content || '{}';
  try {
    return JSON.parse(content);
  } catch {
    const err = new Error('模型返回的不是合法 JSON');
    err.status = 502;
    err.raw = content;
    throw err;
  }
}

app.get('/api/config', (_req, res) => {
  res.json({
    hasKey: Boolean(API_KEY),
    needsCode: Boolean(ACCESS_CODE),
    transcribeModel: TRANSCRIBE_MODEL,
    reviewModel: REVIEW_MODEL,
    structures: STRUCTURES,
    blockTypes: BLOCK_TYPES,
    relationTypes: RELATION_TYPES,
    expressModes: EXPRESS_MODES,
  });
});

app.post('/api/transcribe', gate, upload.single('audio'), async (req, res) => {
  if (!requireKey(res)) return;
  if (!req.file) return res.status(400).json({ error: '没收到音频' });

  try {
    const form = new FormData();
    form.append(
      'file',
      new Blob([req.file.buffer], { type: req.file.mimetype || 'audio/webm' }),
      req.file.originalname || 'speech.webm'
    );
    form.append('model', TRANSCRIBE_MODEL);
    form.append('language', 'zh');
    // 提示词能显著降低中英混说时的错字率
    form.append('prompt', '这是一段中文口头表达练习，可能夹杂英文技术词。请忠实转写，保留口头禅和重复。');

    const data = await openai('/audio/transcriptions', { method: 'POST', body: form });
    res.json({ text: (data.text || '').trim() });
  } catch (err) {
    console.error('[transcribe]', err.message);
    res.status(err.status || 500).json({ error: err.message });
  }
});

const SYSTEM_PROMPT = `你是一位严格但具体的中文表达教练。用户的痛点非常明确：
他在真实场景里无法条件反射地调用合适的表达结构，对结构本身也不熟练。
所以你的每一次反馈都要落到「结构」上，而不是泛泛夸奖。

可用的结构库（必须从中选一个作为 target）：
${structuresForPrompt()}

工作方式：
1. 先判断这段话属于什么场景，据此选出最该用的 target 结构。
2. 逐个槽位对照：他这段话里哪句填了这个槽、填得如何、哪个槽是空的。引用原话。
3. 挑最致命的 1-3 个问题，每个都给可直接替换的改法。
4. 给一版「示范改写」：用 target 结构重写他的内容，保留他的事实和观点，口语化、可以直接朗读、长度和原话相当。
5. 给一条「条件反射训练」：下次遇到什么触发信号、开口第一句固定说什么、一句好记的口诀。
6. 如果提供了上一次的尝试，对比出他这次进步和退步在哪。

评分标准（1-5 分，3 分是"能听懂但不出彩"，别做老好人，普遍应该给 2-4 分）：
- 结构：有没有清晰骨架，听众能不能预判下一句
- 清晰：一次听懂的程度，指代和逻辑是否明确
- 简洁：有没有废话、口头禅、绕圈、重复
- 感染力：有没有具体细节、画面、让人想听下去

只输出 JSON，不要 markdown 代码块。schema：
{
  "scene": "一句话概括这是什么场景",
  "target_structure_id": "结构库里的 id",
  "target_structure_reason": "为什么这个场景该用它",
  "used_structure": "他实际用的结构，如果没有就写「无明显结构」并说明表现",
  "slot_fill": [{"slot":"槽位名","said":"他原话里对应的片段，没有就空字符串","verdict":"好|薄弱|缺失","note":"一句点评"}],
  "scores": {"结构":1-5,"清晰":1-5,"简洁":1-5,"感染力":1-5},
  "filler_words": ["检测到的口头禅和它出现的次数，如「然后 x6」"],
  "keep": ["做得好的点，1-2 条，必须具体"],
  "issues": [{"quote":"原话","problem":"问题","fix":"改成这样说"}],
  "rewrite": "用 target 结构改写后的完整口语稿",
  "drill": {"trigger":"下次当你听到/遇到…","opening_line":"就先说这一句：…","mantra":"不超过 12 个字的口诀"},
  "progress": "有上次尝试时才填的对比，否则 null",
  "next_prompt": "针对他薄弱点的下一道练习题，一句话"
}`;

app.post('/api/review', gate, async (req, res) => {
  if (!requireKey(res)) return;
  const { text, scene, targetStructureId, previousText } = req.body || {};
  if (!text || !text.trim()) return res.status(400).json({ error: '没有可复盘的文本' });

  const forced = targetStructureId && STRUCTURE_INDEX[targetStructureId];
  const userParts = [
    scene?.trim() ? `场景（用户自述）：${scene.trim()}` : '场景：用户没说，你自己判断。',
    forced
      ? `用户指定要练的结构：${forced.id}（${forced.name}）。target_structure_id 必须用它。`
      : '用户没指定结构，你来选最合适的。',
    previousText?.trim() ? `上一次的尝试：\n"""\n${previousText.trim()}\n"""` : '',
    `这次的表达：\n"""\n${text.trim()}\n"""`,
  ].filter(Boolean);

  try {
    const data = await openai('/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: REVIEW_MODEL,
        temperature: 0.4,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: userParts.join('\n\n') },
        ],
      }),
    });

    const content = data.choices?.[0]?.message?.content || '{}';
    let feedback;
    try {
      feedback = JSON.parse(content);
    } catch {
      return res.status(502).json({ error: '模型返回的不是合法 JSON', raw: content });
    }
    res.json({ feedback });
  } catch (err) {
    console.error('[review]', err.message);
    res.status(err.status || 500).json({ error: err.message });
  }
});

// 长期分析：把历史记录喂回去，找反复出现的毛病
app.post('/api/analyze', gate, async (req, res) => {
  if (!requireKey(res)) return;
  const { sessions = [], notes = [], tree = [] } = req.body || {};
  if (!sessions.length && !notes.length && !tree.length) {
    return res.status(400).json({ error: '还没有记录可以分析' });
  }

  const digest = sessions
    .slice(-30)
    .map((s, i) => {
      const f = s.feedback || {};
      return [
        `#${i + 1} ${new Date(s.createdAt).toLocaleDateString('zh-CN')} 场景:${f.scene || s.scene || '未知'}`,
        `目标结构:${f.target_structure_id || '-'} 评分:${JSON.stringify(f.scores || {})}`,
        `问题:${(f.issues || []).map((x) => x.problem).join('；') || '-'}`,
      ].join(' | ');
    })
    .join('\n');

  const noteDigest = notes
    .slice(-50)
    .map((n) => `[${n.type}] ${n.content}`)
    .join('\n');

  // 思维树也一起喂进去：表达上的毛病和思考上的空缺，本来就是同一个人的同一个问题。
  const treeDigest = tree
    .slice(0, 120)
    .map((n) => `${n.path}（${n.blocks || 0} 条${n.types?.length ? '：' + n.types.join('、') : ''}）`)
    .join('\n');

  try {
    const data = await openai('/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: REVIEW_MODEL,
        temperature: 0.5,
        response_format: { type: 'json_object' },
        messages: [
          {
            role: 'system',
            content: `你在看一个人长期的表达练习记录、随手笔记，以及他自己长出来的思维树，
要给出教练视角的长期诊断。不要复述数据，要找模式。

特别注意「想」和「说」之间的落差：
他思维树里最厚的主题，是不是恰好是他讲不清楚的？他反复思考的问题，有没有真的练过表达？

只输出 JSON：
{
  "recurring_problems": [{"pattern":"反复出现的毛病","evidence":"依据","cost":"它让你在什么场景吃亏"}],
  "strengths": ["稳定的优势"],
  "blind_spot": "他自己大概率没意识到的一点",
  "weakest_structure": "最需要补的结构及原因",
  "note_themes": ["笔记和思维树里反复出现的主题，没有就空数组"],
  "thinking_gaps": [{"topic":"思维树里的主题","gap":"缺什么：缺案例 / 只有结论没有原因 / 两条碎片矛盾 / 想过但从没讲过"}],
  "next_two_weeks": ["接下来两周的具体训练动作，3 条，可执行到每天，尽量指名用思维树里的哪个主题去练"]
}`,
          },
          {
            role: 'user',
            content: `练习记录：\n${digest || '（无）'}\n\n随手笔记：\n${noteDigest || '（无）'}\n\n思维树：\n${treeDigest || '（无）'}`,
          },
        ],
      }),
    });
    const content = data.choices?.[0]?.message?.content || '{}';
    res.json({ analysis: JSON.parse(content) });
  } catch (err) {
    console.error('[analyze]', err.message);
    res.status(err.status || 500).json({ error: err.message });
  }
});


/* ==================== 思维树「枝」 ==================== */

// 产品的核心差异化就在这一个接口：
// 用户随手扔一句话，AI 说出「它应该长在你哪棵树的哪个节点上，以及为什么」。
const INGEST_PROMPT = `你是用户「思维树」的整理助手。用户会随手扔进来一个想法碎片：
可能是一个观点、一个案例、一个问题、一个新学的概念，或者一段经历。

你要做三件事：
1. 读懂它：判断类型，提炼核心，拆成结构化要素。
2. 决定它该长在树的哪个位置。
3. 找出它和哪些已有节点存在横向关联（表面是树，底层是图，一个观点可以属于多个主题）。

挂载原则（很重要，直接决定产品成败）：
- 优先挂到已有节点上，让已有知识变厚。只有确实没有合适位置时才新建。
- 新建路径最多 2 层；节点标题是 2-12 个字的概念名，不是一句话。
- 一条碎片不等于一个新节点。多数情况下它只是某个节点里的一个「块」。
- block_type 表示这段碎片在目标节点里扮演什么角色，从这些里选：${blockTypesForPrompt()}
- 保留用户的原话，不要改写成你的语气；summary 才是你精炼过的一句话。
- confidence 是你对挂载位置的把握。低于 0.6 时，alternatives 至少给 2 个真正不同的选择。
- 挂载理由要说人话，说清「为什么是这里，而不是别处」，一到两句。

关系类型可选：${relationTypesForPrompt()}

只输出 JSON，不要 markdown 代码块。schema：
{
  "understanding": {
    "type": "观点|案例|问题|概念|经历|事实|其他",
    "title": "适合当节点标题的短语，2-12 字",
    "summary": "一句话说清这条碎片的核心",
    "components": {
      "claim": "核心主张，没有就 null",
      "reason": "原因，没有就 null",
      "example": "例子，没有就 null",
      "implication": "推论 / 所以呢，没有就 null",
      "question": "它引出的待验证问题，没有就 null"
    }
  },
  "mount": {
    "mode": "existing 挂到已有节点 | new 新建节点",
    "target_node_id": "mode=existing 时填已有节点 id，否则 null",
    "parent_node_id": "mode=new 时填新节点挂在哪个已有节点下；挂到根就填 null",
    "new_path": ["mode=new 时从 parent 往下要新建的节点标题，1-2 个"],
    "block_type": "这段碎片在目标节点里的角色",
    "block_content": "要存进节点的内容，基于用户原话整理，保留他的说法",
    "reason": "为什么挂这里而不是别处",
    "confidence": 0.0
  },
  "alternatives": [
    {"label": "备选位置的可读路径", "target_node_id": "已有节点 id 或 null", "parent_node_id": "或 null", "new_path": [], "reason": "什么情况下应该选它"}
  ],
  "relations": [
    {"target_node_id": "已有节点 id", "type": "关系类型", "note": "一句话说清它们的关系"}
  ]
}`;

app.post('/api/ingest', gate, async (req, res) => {
  if (!requireKey(res)) return;
  const { text, nodes = [] } = req.body || {};
  if (!text || !text.trim()) return res.status(400).json({ error: '没有可整理的内容' });

  try {
    const result = await chatJSON({
      system: INGEST_PROMPT,
      temperature: 0.3,
      user: `用户现在的思维树：\n${outlineForPrompt(nodes)}\n\n他刚扔进来的碎片：\n"""\n${text.trim()}\n"""`,
    });
    res.json({ result });
  } catch (err) {
    console.error('[ingest]', err.message);
    res.status(err.status || 500).json({ error: err.message, raw: err.raw });
  }
});

// 一个主题攒了很多碎片之后，AI 主动帮你归纳成几个核心观点。
app.post('/api/reorganize', gate, async (req, res) => {
  if (!requireKey(res)) return;
  const { node, blocks = [], children = [] } = req.body || {};
  if (!node?.title) return res.status(400).json({ error: '没有指定要整理的节点' });
  if (blocks.length + children.length < 2) {
    return res.status(400).json({ error: '这个节点内容还太少，先多扔几条进来' });
  }

  const blockList = blocks
    .map((b) => `- ${b.id} | [${b.type}] ${String(b.content || '').slice(0, 300)}`)
    .join('\n');
  const childList = children.map((c) => `- ${c.id} | ${c.title}（${c.blocks || 0} 条碎片）`).join('\n');

  try {
    const result = await chatJSON({
      temperature: 0.4,
      system: `你在帮用户整理他自己思维树里的一个主题。他往这个主题下扔了很多碎片，现在需要你看出结构。

你要做的是「归纳」，不是「重写」：
- 把这些碎片归到 2-5 个核心观点/子主题下，每个组的标题是 2-12 字的概念名。
- 只有确实同属一类的才放一组，硬凑的组不如放进 leftover。
- 已有的子节点也可以被重新归组（用它们的 id）。
- 另外指出你看到的问题：哪个观点只有主张没有案例、哪两条碎片其实互相矛盾、哪里明显缺一块。
- 这是用户自己的思维，不要把它整理成一个"看起来很漂亮但不是他的"体系。宁可少归纳。

只输出 JSON：
{
  "summary": "这个主题目前的整体判断，两三句",
  "groups": [{"title":"子主题标题","why":"为什么它们是一类","block_ids":[],"child_node_ids":[]}],
  "leftover_block_ids": ["暂时归不进任何组的碎片 id"],
  "insights": [{"kind":"缺案例|有矛盾|缺推论|可深挖","detail":"具体说明，引用碎片内容"}]
}`,
      user: `主题：${node.path || node.title}\n\n它下面的碎片：\n${blockList || '（无）'}\n\n它下面的子节点：\n${childList || '（无）'}`,
    });
    res.json({ result });
  } catch (err) {
    console.error('[reorganize]', err.message);
    res.status(err.status || 500).json({ error: err.message, raw: err.raw });
  }
});

// 表达模式：把一个节点里攒的东西，变成可以直接开口说的稿子。
// 每种模式都复用表达结构库里的一个结构，生成完可以一键跳到练习页录音。
app.post('/api/express', gate, async (req, res) => {
  if (!requireKey(res)) return;
  const { node, blocks = [], modeId } = req.body || {};
  if (!node?.title) return res.status(400).json({ error: '没有指定节点' });

  const mode = EXPRESS_INDEX[modeId] || EXPRESS_MODES[0];
  const structure = STRUCTURE_INDEX[mode.structureId];
  const material = blocks
    .map((b) => `[${b.type}] ${String(b.content || '').slice(0, 500)}`)
    .join('\n');

  try {
    const result = await chatJSON({
      temperature: 0.6,
      system: `你是这个人的表达教练。他在自己的思维树里攒了一个主题的素材，现在要把它讲出来。

这次的场景：${mode.name} —— ${mode.scene}
必须使用的表达结构：${structure.name}
槽位：${structure.slots.join(' → ')}
口诀：${structure.cue}
额外要求：${mode.ask}

硬性要求：
- 只能用他自己素材里的事实、例子和观点，不许替他编经历、编数据。
- 素材填不满的槽位，就在 gaps 里说清缺什么，不要用漂亮的空话把它填上。
- script 是口语稿，是给他照着念出来的，不是书面文章。别用"首先其次最后"这种书面连接词。
- opening_line 是他一开口就说的那一句，必须能独立成立。

只输出 JSON：
{
  "structure_id": "${structure.id}",
  "opening_line": "开口第一句",
  "script": "完整口语稿",
  "slot_map": [{"slot":"槽位名","content":"这一格说什么","source":"用了哪条素材，没素材就写「缺」"}],
  "gaps": ["这个节点还缺什么素材才能讲得更实，每条都具体到该补什么"],
  "practice_hint": "开口练这段时最该注意的一点"
}`,
      user: `主题：${node.path || node.title}\n\n素材：\n${material || '（这个节点还没有内容）'}`,
    });
    res.json({ result, mode, structure });
  } catch (err) {
    console.error('[express]', err.message);
    res.status(err.status || 500).json({ error: err.message, raw: err.raw });
  }
});

app.use((err, _req, res, _next) => {
  console.error('[server]', err.message);
  res.status(err.status || 500).json({ error: err.message });
});

app.listen(PORT, () => {
  console.log(`表达练习 MVP -> http://localhost:${PORT}`);
  if (!API_KEY) console.warn('⚠️  没检测到 OPENAI_API_KEY，转写和复盘会失败');
});
