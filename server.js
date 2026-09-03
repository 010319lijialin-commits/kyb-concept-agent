import 'dotenv/config';
import express from 'express';
import multer from 'multer';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { STRUCTURES, STRUCTURE_INDEX, structuresForPrompt } from './structures.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PORT = process.env.PORT || 3000;
const BASE_URL = (process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1').replace(/\/$/, '');
const API_KEY = process.env.OPENAI_API_KEY;
const TRANSCRIBE_MODEL = process.env.TRANSCRIBE_MODEL || 'gpt-4o-transcribe';
const REVIEW_MODEL = process.env.REVIEW_MODEL || 'gpt-4o';

const app = express();
app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, 'public')));

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

app.get('/api/config', (_req, res) => {
  res.json({
    hasKey: Boolean(API_KEY),
    transcribeModel: TRANSCRIBE_MODEL,
    reviewModel: REVIEW_MODEL,
    structures: STRUCTURES,
  });
});

app.post('/api/transcribe', upload.single('audio'), async (req, res) => {
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

app.post('/api/review', async (req, res) => {
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
app.post('/api/analyze', async (req, res) => {
  if (!requireKey(res)) return;
  const { sessions = [], notes = [] } = req.body || {};
  if (!sessions.length && !notes.length) {
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
            content: `你在看一个人长期的表达练习记录和随手笔记，要给出教练视角的长期诊断。
不要复述数据，要找模式。只输出 JSON：
{
  "recurring_problems": [{"pattern":"反复出现的毛病","evidence":"依据","cost":"它让你在什么场景吃亏"}],
  "strengths": ["稳定的优势"],
  "blind_spot": "他自己大概率没意识到的一点",
  "weakest_structure": "最需要补的结构及原因",
  "note_themes": ["笔记里反复出现的主题，没有笔记就空数组"],
  "next_two_weeks": ["接下来两周的具体训练动作，3 条，可执行到每天"]
}`,
          },
          {
            role: 'user',
            content: `练习记录：\n${digest || '（无）'}\n\n随手笔记：\n${noteDigest || '（无）'}`,
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

app.use((err, _req, res, _next) => {
  console.error('[server]', err.message);
  res.status(err.status || 500).json({ error: err.message });
});

app.listen(PORT, () => {
  console.log(`表达练习 MVP -> http://localhost:${PORT}`);
  if (!API_KEY) console.warn('⚠️  没检测到 OPENAI_API_KEY，转写和复盘会失败');
});
