/* 表达练习 + 思维树「枝」—— 全部数据存在这台设备的 localStorage 里 */

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => [...document.querySelectorAll(sel)];

const NOTE_TYPES = ['灵感', '方法原则', '知识点'];
const KEY = { sessions: 'xp.sessions', notes: 'xp.notes' };

const state = {
  structures: [],
  noteType: NOTE_TYPES[0],
  previousText: '',   // 「再练一次」时带上一版做对比
  lastAudioUrl: '',
  needsCode: false,
  brief: null,        // 从思维树跳过来练某个节点时带的题目
};

/* ---------------- 存储 ---------------- */
const load = (k) => {
  try {
    return JSON.parse(localStorage.getItem(k) || '[]');
  } catch {
    return [];
  }
};
const save = (k, v) => localStorage.setItem(k, JSON.stringify(v));

const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const fmtDate = (ts) =>
  new Date(ts).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });

let toastTimer;
function toast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), 2600);
}

/* ---------------- 带访问码的请求 ---------------- */
// 部署到公网时服务端会开 ACCESS_CODE，第一次用要输一次，之后记在本机。
function askCode(msg) {
  const code = (window.prompt(msg || '请输入访问码') || '').trim();
  if (code) localStorage.setItem('xp.code', code);
  return code;
}

async function api(path, opts = {}) {
  const headers = { ...(opts.headers || {}) };
  if (state.needsCode) {
    const code = localStorage.getItem('xp.code') || askCode();
    if (!code) throw new Error('需要访问码');
    headers['x-access-code'] = code;
  }
  const r = await fetch(path, { ...opts, headers });
  const data = await r.json().catch(() => ({}));
  if (r.status === 401) {
    localStorage.removeItem('xp.code');
    askCode('访问码不对，再输一次');
    throw new Error('访问码不对，重试一次');
  }
  if (!r.ok) throw new Error(data.error || `请求失败（${r.status}）`);
  return data;
}

// 一个按钮跑异步任务时的统一处理：禁用、换文案、结束后复原。
async function withBusy(btn, label, fn) {
  const old = btn.textContent;
  btn.disabled = true;
  btn.textContent = label;
  try {
    return await fn();
  } catch (err) {
    toast(err.message);
  } finally {
    btn.disabled = false;
    btn.textContent = old;
  }
}

/* ---------------- 导航 ---------------- */
function goto(page) {
  const btn = $(`.tab[data-page="${page}"]`);
  if (btn) btn.click();
}

$$('.tab').forEach((btn) => {
  btn.onclick = () => {
    $$('.tab').forEach((b) => b.classList.toggle('on', b === btn));
    $$('.page').forEach((p) => (p.hidden = p.id !== `page-${btn.dataset.page}`));
    if (btn.dataset.page === 'log') renderLog();
    if (btn.dataset.page === 'analyze') renderStats();
    if (btn.dataset.page === 'tree') window.Branch?.renderTree();
    if (btn.dataset.page === 'capture') window.Branch?.renderRecent();
    window.scrollTo(0, 0);
  };
});

$$('.seg-btn').forEach((btn) => {
  btn.onclick = () => {
    $$('.seg-btn').forEach((b) => b.classList.toggle('on', b === btn));
    $('#log-notes').hidden = btn.dataset.log !== 'notes';
    $('#log-sessions').hidden = btn.dataset.log !== 'sessions';
  };
});

/* ---------------- 结构库 ---------------- */
async function initStructures() {
  const cfg = await fetch('/api/config').then((r) => r.json());
  state.structures = cfg.structures || [];
  state.needsCode = Boolean(cfg.needsCode);
  if (!cfg.hasKey) toast('服务端没配 OPENAI_API_KEY');

  const sel = $('#structure');
  sel.innerHTML =
    '<option value="">让 AI 帮我判断该用哪个</option>' +
    state.structures.map((s) => `<option value="${s.id}">${esc(s.name)}</option>`).join('');
  sel.onchange = () => {
    const s = state.structures.find((x) => x.id === sel.value);
    $('#structure-hint').textContent = s ? `${s.trigger} ｜ ${s.slots.join(' → ')}` : '';
  };

  $('#card-list').innerHTML = state.structures
    .map(
      (s) => `<div class="card">
        <div class="fb-head"><h2>${esc(s.name)}</h2></div>
        <p class="sc-trigger">触发信号：${esc(s.trigger)}</p>
        <div class="slots-row">${s.slots.map((x) => `<span class="slot-pill">${esc(x)}</span>`).join('')}</div>
        <p class="sc-cue">${esc(s.cue)}</p>
      </div>`
    )
    .join('');

  return cfg;
}

/* ---------------- 录音（练习页和枝页共用） ---------------- */
function pickMime() {
  const list = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg'];
  return list.find((t) => window.MediaRecorder?.isTypeSupported?.(t)) || '';
}

// 一个按钮 + 一个计时器 + 录完拿到 blob 要干什么，就是一台录音机。
function createRecorder({ btn, labelEl, timerEl, idleLabel, doneLabel, onBlob }) {
  let recorder, chunks = [], startedAt = 0, timerId;

  const tick = () => {
    if (!timerEl) return;
    const s = Math.floor((Date.now() - startedAt) / 1000);
    timerEl.textContent = `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
  };

  btn.onclick = async () => {
    if (recorder?.state === 'recording') return recorder.stop();
    if (!navigator.mediaDevices?.getUserMedia) {
      return toast('这个浏览器不支持录音，请用 https 打开或手动输入文字');
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mimeType = pickMime();
      recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
      chunks = [];
      recorder.ondataavailable = (e) => e.data.size && chunks.push(e.data);
      recorder.onstop = async () => {
        stream.getTracks().forEach((t) => t.stop());
        clearInterval(timerId);
        const type = recorder.mimeType || mimeType || 'audio/webm';
        btn.classList.remove('recording');
        labelEl.textContent = '转写中…';
        btn.disabled = true;
        try {
          await onBlob(new Blob(chunks, { type }), type);
        } finally {
          btn.disabled = false;
          labelEl.textContent = doneLabel;
        }
      };
      recorder.start();
      startedAt = Date.now();
      tick();
      timerId = setInterval(tick, 500);
      btn.classList.add('recording');
      labelEl.textContent = '停止';
    } catch (err) {
      toast('拿不到麦克风权限：' + err.message);
    }
  };

  return { reset: () => (labelEl.textContent = idleLabel) };
}

// 音频 → 文字。两个页面都走这一条。
async function transcribe(blob, type) {
  const ext = type.includes('mp4') ? 'mp4' : type.includes('ogg') ? 'ogg' : 'webm';
  const fd = new FormData();
  fd.append('audio', blob, `speech.${ext}`);
  const data = await api('/api/transcribe', { method: 'POST', body: fd });
  return data.text || '';
}

createRecorder({
  btn: $('#rec-btn'),
  labelEl: $('#rec-label'),
  timerEl: $('#timer'),
  idleLabel: '开始录音',
  doneLabel: '重新录音',
  onBlob: async (blob, type) => {
    if (state.lastAudioUrl) URL.revokeObjectURL(state.lastAudioUrl);
    state.lastAudioUrl = URL.createObjectURL(blob);
    const player = $('#playback');
    player.src = state.lastAudioUrl;
    player.hidden = false;
    try {
      const text = await transcribe(blob, type);
      $('#transcript').value = text;
      if (!text) toast('没听清，再说一遍？');
    } catch (err) {
      toast(err.message);
    }
  },
});

/* ---------------- 从思维树跳过来练一段 ---------------- */
// 「枝」里生成的表达稿不直接算数——得开口说出来，再走一遍复盘，才闭环。
function startPractice({ scene = '', structureId = '', brief = null } = {}) {
  $('#scene').value = scene;
  $('#structure').value = structureId || '';
  $('#structure').onchange();
  $('#transcript').value = '';
  $('#feedback').innerHTML = '';
  $('#playback').hidden = true;
  state.previousText = '';
  state.brief = brief;
  renderBrief();
  goto('practice');
}

function renderBrief() {
  const b = state.brief;
  const el = $('#practice-brief');
  if (!b) return (el.innerHTML = '');
  el.innerHTML = `<div class="card brief">
    <div class="fb-head"><h2>要讲的：${esc(b.title)}</h2><button class="del" id="brief-close" type="button">收起</button></div>
    ${b.openingLine ? `<p class="brief-open">开口第一句：<b>${esc(b.openingLine)}</b></p>` : ''}
    ${b.hint ? `<p class="hint">${esc(b.hint)}</p>` : ''}
    ${b.script ? `<details class="brief-script"><summary>看一眼参考稿（先自己讲完再看）</summary><div class="rewrite">${esc(b.script)}</div></details>` : ''}
    <p class="hint">别念稿子，合上它自己说一遍再复盘。</p>
  </div>`;
  $('#brief-close').onclick = () => {
    state.brief = null;
    renderBrief();
  };
}

/* ---------------- 复盘 ---------------- */
$('#review-btn').onclick = () =>
  withBusy($('#review-btn'), '复盘中…', async () => {
    const text = $('#transcript').value.trim();
    if (!text) return toast('先说点什么，或者手动打字');

    const data = await api('/api/review', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text,
        scene: $('#scene').value,
        targetStructureId: $('#structure').value,
        previousText: state.previousText,
      }),
    });

    const session = {
      id: crypto.randomUUID(),
      createdAt: Date.now(),
      scene: $('#scene').value.trim(),
      text,
      nodeId: state.brief?.nodeId || null,
      feedback: data.feedback,
    };
    const sessions = load(KEY.sessions);
    sessions.unshift(session);
    save(KEY.sessions, sessions);

    state.previousText = '';
    renderFeedback(data.feedback, text);
  });

function renderFeedback(f, text) {
  const st = state.structures.find((s) => s.id === f.target_structure_id);
  const scores = f.scores || {};
  const block = (title, inner) => (inner ? `<p class="section-t">${title}</p>${inner}` : '');

  $('#feedback').innerHTML = `
    <div class="card">
      <div class="fb-head">
        <h2>${esc(st?.name || f.target_structure_id || '结构复盘')}</h2>
        <span class="tag">${esc(f.scene || '')}</span>
      </div>
      <p class="hint">${esc(f.target_structure_reason || '')}</p>
      <p class="section-t">评分</p>
      <div class="scores">
        ${Object.entries(scores)
          .map(([k, v]) => `<div class="score"><b>${esc(v)}</b><span>${esc(k)}</span></div>`)
          .join('')}
      </div>
      <p class="hint" style="margin-top:10px">你实际用的：${esc(f.used_structure || '—')}</p>
    </div>

    ${
      (f.slot_fill || []).length
        ? `<div class="card">
            <p class="section-t">槽位对照</p>
            ${f.slot_fill
              .map(
                (s) => `<div class="slot">
                  <div class="slot-h"><span>${esc(s.slot)}</span><span class="v v-${esc(s.verdict)}">${esc(s.verdict)}</span></div>
                  ${s.said ? `<p class="said">「${esc(s.said)}」</p>` : ''}
                  <p class="note">${esc(s.note)}</p>
                </div>`
              )
              .join('')}
           </div>`
        : ''
    }

    ${
      (f.issues || []).length || (f.keep || []).length || (f.filler_words || []).length
        ? `<div class="card">
            ${block(
              '最该改的',
              (f.issues || [])
                .map(
                  (i) => `<div class="issue">
                    ${i.quote ? `<p class="quote">${esc(i.quote)}</p>` : ''}
                    <p class="prob">${esc(i.problem)}</p>
                    <p class="fix">→ ${esc(i.fix)}</p>
                  </div>`
                )
                .join('')
            )}
            ${block('保持', (f.keep || []).length ? `<ul class="plain">${f.keep.map((k) => `<li>${esc(k)}</li>`).join('')}</ul>` : '')}
            ${block(
              '口头禅',
              (f.filler_words || []).length
                ? `<div class="fillers">${f.filler_words.map((w) => `<span class="filler">${esc(w)}</span>`).join('')}</div>`
                : ''
            )}
           </div>`
        : ''
    }

    ${
      f.rewrite
        ? `<div class="card">
            <p class="section-t">示范改写（照着念一遍）</p>
            <div class="rewrite">${esc(f.rewrite)}</div>
           </div>`
        : ''
    }

    ${
      f.drill
        ? `<div class="card drill">
            <p class="section-t">条件反射训练</p>
            <p>${esc(f.drill.trigger)}</p>
            <p><b>${esc(f.drill.opening_line)}</b></p>
            <p class="mantra">${esc(f.drill.mantra)}</p>
           </div>`
        : ''
    }

    ${f.progress ? `<div class="card">${block('跟上一次比', `<p>${esc(f.progress)}</p>`)}</div>` : ''}

    <div class="card">
      ${f.next_prompt ? `<p class="section-t">下一题</p><p>${esc(f.next_prompt)}</p>` : ''}
      <button class="primary" id="retry-btn" type="button">用这个结构再说一遍</button>
      <button class="ghost" id="to-tree-btn" type="button">把这段沉淀进思维树</button>
    </div>
  `;

  $('#retry-btn').onclick = () => {
    state.previousText = text;
    if (f.target_structure_id) $('#structure').value = f.target_structure_id;
    $('#structure').onchange();
    $('#transcript').value = '';
    $('#feedback').innerHTML = '';
    $('#playback').hidden = true;
    window.scrollTo({ top: 0, behavior: 'smooth' });
    toast('这次按结构再说一遍，会跟上一版对比');
  };

  // 说出来的东西比打字的更接近真实想法，值得进树。
  $('#to-tree-btn').onclick = () => window.Branch?.capture(text, '练习');

  $('#feedback').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

/* ---------------- 笔记 ---------------- */
$('#note-types').innerHTML = NOTE_TYPES.map(
  (t, i) => `<button class="chip${i === 0 ? ' on' : ''}" data-type="${t}" type="button">${t}</button>`
).join('');

$$('#note-types .chip').forEach((chip) => {
  chip.onclick = () => {
    state.noteType = chip.dataset.type;
    $$('#note-types .chip').forEach((c) => c.classList.toggle('on', c === chip));
  };
});

$('#note-save').onclick = () => {
  const content = $('#note-input').value.trim();
  if (!content) return toast('写点什么再存');
  const notes = load(KEY.notes);
  notes.unshift({ id: crypto.randomUUID(), createdAt: Date.now(), type: state.noteType, content });
  save(KEY.notes, notes);
  $('#note-input').value = '';
  renderLog();
  toast('记下了');
};

function renderLog() {
  const notes = load(KEY.notes);
  $('#note-list').innerHTML = notes.length
    ? notes
        .map(
          (n) => `<div class="card item">
            <button class="del" data-del-note="${n.id}" type="button">删除</button>
            <div class="item-meta"><span class="tag">${esc(n.type)}</span><span>${fmtDate(n.createdAt)}</span></div>
            <div class="item-body">${esc(n.content)}</div>
            <button class="link" data-tree-note="${n.id}" type="button">扔进思维树 →</button>
          </div>`
        )
        .join('')
    : '<p class="empty">还没有笔记</p>';

  const sessions = load(KEY.sessions);
  $('#log-sessions').innerHTML = sessions.length
    ? sessions
        .map((s) => {
          const f = s.feedback || {};
          const st = state.structures.find((x) => x.id === f.target_structure_id);
          const avg = avgScore(f);
          return `<div class="card item">
            <button class="del" data-del-session="${s.id}" type="button">删除</button>
            <div class="item-meta">
              <span class="tag">${esc(st?.name || '—')}</span>
              <span>${fmtDate(s.createdAt)}</span>
              ${avg ? `<span>均分 ${avg}</span>` : ''}
            </div>
            <div class="item-body">${esc(s.text.slice(0, 90))}${s.text.length > 90 ? '…' : ''}</div>
            ${f.drill?.mantra ? `<p class="session-sum">口诀：${esc(f.drill.mantra)}</p>` : ''}
            <button class="link" data-open-session="${s.id}" type="button">查看完整复盘</button>
          </div>`;
        })
        .join('')
    : '<p class="empty">还没有练习记录</p>';

  $$('[data-del-note]').forEach((b) => {
    b.onclick = () => {
      save(KEY.notes, load(KEY.notes).filter((n) => n.id !== b.dataset.delNote));
      renderLog();
    };
  });
  $$('[data-del-session]').forEach((b) => {
    b.onclick = () => {
      save(KEY.sessions, load(KEY.sessions).filter((s) => s.id !== b.dataset.delSession));
      renderLog();
    };
  });
  $$('[data-tree-note]').forEach((b) => {
    b.onclick = () => {
      const n = load(KEY.notes).find((x) => x.id === b.dataset.treeNote);
      if (n) window.Branch?.capture(n.content, n.type);
    };
  });
  $$('[data-open-session]').forEach((b) => {
    b.onclick = () => {
      const s = load(KEY.sessions).find((x) => x.id === b.dataset.openSession);
      if (!s) return;
      $('#transcript').value = s.text;
      $('#scene').value = s.scene || '';
      renderFeedback(s.feedback || {}, s.text);
      goto('practice');
    };
  });
}

function avgScore(f) {
  const v = Object.values(f?.scores || {}).filter((x) => typeof x === 'number');
  return v.length ? (v.reduce((a, b) => a + b, 0) / v.length).toFixed(1) : '';
}

/* ---------------- 分析 ---------------- */
function renderStats() {
  const sessions = load(KEY.sessions);
  const notes = load(KEY.notes);
  const tree = window.Branch?.stats() || { nodes: 0, blocks: 0, proposed: 0, accepted: 0 };
  const avgs = sessions.map((s) => avgScore(s.feedback)).filter(Boolean).map(Number);
  const avg = avgs.length ? (avgs.reduce((a, b) => a + b, 0) / avgs.length).toFixed(1) : '—';
  $('#stats').innerHTML = `
    <div class="stat"><b>${sessions.length}</b><span>练习</span></div>
    <div class="stat"><b>${avg}</b><span>平均分</span></div>
    <div class="stat"><b>${tree.nodes}</b><span>节点</span></div>
    <div class="stat"><b>${tree.blocks}</b><span>碎片</span></div>`;

  // 「枝」这一版最该盯的指标：AI 推荐的挂载位置，我有多少次直接接受。
  $('#mount-rate').textContent = tree.proposed
    ? `挂载采纳率 ${Math.round((tree.accepted / tree.proposed) * 100)}%（${tree.accepted}/${tree.proposed}）——它低就说明 AI 还没理解你的思维结构。`
    : '还没有挂载记录。挂载采纳率是这一版最该盯的指标。';
}

$('#analyze-btn').onclick = () =>
  withBusy($('#analyze-btn'), '分析中…', async () => {
    const data = await api('/api/analyze', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sessions: load(KEY.sessions),
        notes: load(KEY.notes),
        tree: window.Branch?.digest() || [],
      }),
    });
    renderAnalysis(data.analysis);
  });

function renderAnalysis(a) {
  const list = (arr) => `<ul class="plain">${(arr || []).map((x) => `<li>${esc(x)}</li>`).join('')}</ul>`;
  $('#analysis').innerHTML = `
    <div class="card">
      <p class="section-t">反复出现的毛病</p>
      ${(a.recurring_problems || [])
        .map(
          (p) => `<div class="issue">
            <p class="prob"><b>${esc(p.pattern)}</b></p>
            <p class="quote">${esc(p.evidence)}</p>
            <p class="fix">代价：${esc(p.cost)}</p>
          </div>`
        )
        .join('')}
    </div>
    <div class="card">
      <p class="section-t">你的盲点</p>
      <p>${esc(a.blind_spot || '—')}</p>
      <p class="section-t">最该补的结构</p>
      <p>${esc(a.weakest_structure || '—')}</p>
      <p class="section-t">稳定优势</p>
      ${list(a.strengths)}
      ${(a.note_themes || []).length ? `<p class="section-t">你反复在想的主题</p>${list(a.note_themes)}` : ''}
    </div>
    ${
      (a.thinking_gaps || []).length
        ? `<div class="card">
            <p class="section-t">想过，但还缺一块</p>
            ${a.thinking_gaps
              .map((g) => `<div class="issue"><p class="prob"><b>${esc(g.topic)}</b></p><p class="fix">${esc(g.gap)}</p></div>`)
              .join('')}
           </div>`
        : ''
    }
    <div class="card drill">
      <p class="section-t">接下来两周</p>
      ${list(a.next_two_weeks)}
    </div>`;
  $('#analysis').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

$('#export-btn').onclick = () => {
  const payload = {
    sessions: load(KEY.sessions),
    notes: load(KEY.notes),
    ...(window.Branch?.exportData() || {}),
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `枝-备份-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
};

/* ---------------- 给 branch.js 用的公共部分 ---------------- */
window.XP = {
  $, $$, esc, fmtDate, toast, api, load, save, withBusy, goto,
  state, createRecorder, transcribe, startPractice,
  boot() {
    initStructures()
      .then((cfg) => {
        window.Branch?.init(cfg);
        renderLog();
      })
      .catch((e) => toast('初始化失败：' + e.message));
  },
};
