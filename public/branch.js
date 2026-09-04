/* 「枝」思维树 —— 碎片 → 结构 → 关系 → 体系
   数据同样只在这台设备的 localStorage 里：xp.nodes / xp.rels / xp.mount */

(() => {
const { $, $$, esc, fmtDate, toast, api, load, save, withBusy, createRecorder, transcribe, startPractice } = window.XP;

const KEY = { nodes: 'xp.nodes', rels: 'xp.rels', mount: 'xp.mount' };

let nodes = [];                                  // {id,title,parentId,createdAt,updatedAt,blocks[]}
let rels = [];                                   // {id,sourceId,targetId,type,note}
let mount = { proposed: 0, accepted: 0, changed: 0 }; // 挂载采纳率就是从这里算的
let cfg = { blockTypes: [], relationTypes: {}, expressModes: [] };

let pending = null;      // 等用户确认的挂载建议
let openNodeId = null;   // 正在看的节点
let query = '';

const uid = (p) =>
  p + (crypto.randomUUID ? crypto.randomUUID().slice(0, 8) : Math.random().toString(36).slice(2, 10));

/* ---------------- 存取 ---------------- */
function loadAll() {
  nodes = load(KEY.nodes).map((n) => ({ ...n, blocks: n.blocks || [] }));
  rels = load(KEY.rels);
  try {
    mount = { ...mount, ...(JSON.parse(localStorage.getItem(KEY.mount)) || {}) };
  } catch {
    /* 用默认值 */
  }
}

function persist() {
  save(KEY.nodes, nodes);
  save(KEY.rels, rels);
  localStorage.setItem(KEY.mount, JSON.stringify(mount));
}

/* ---------------- 树的基本操作 ---------------- */
const byId = (id) => nodes.find((n) => n.id === id) || null;
const childrenOf = (id) => nodes.filter((n) => (n.parentId || null) === (id || null)).sort((a, b) => a.createdAt - b.createdAt);

function pathOf(node) {
  const parts = [];
  let cur = node, guard = 0;
  while (cur && guard++ < 20) {
    parts.unshift(cur.title);
    cur = byId(cur.parentId);
  }
  return parts.join(' › ');
}

function subtreeIds(id, acc = new Set()) {
  acc.add(id);
  childrenOf(id).forEach((c) => subtreeIds(c.id, acc));
  return acc;
}

function createNode(title, parentId = null) {
  const node = {
    id: uid('n'),
    title: String(title || '未命名').trim().slice(0, 40) || '未命名',
    parentId: parentId || null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    blocks: [],
  };
  nodes.push(node);
  return node;
}

// 同名兄弟就复用，别让 AI 每次都造一个新的「AI产品」。
function ensureChild(title, parentId) {
  const t = String(title || '').trim();
  return childrenOf(parentId).find((n) => n.title === t) || createNode(t, parentId);
}

function ensurePath(parentId, titles) {
  let pid = parentId && byId(parentId) ? parentId : null;
  let node = byId(pid);
  for (const t of titles) {
    node = ensureChild(t, pid);
    pid = node.id;
  }
  return node;
}

function addBlock(node, { type, content, raw, source }) {
  const block = {
    id: uid('b'),
    type: cfg.blockTypes.includes(type) ? type : '我的思考',
    content: String(content || '').trim(),
    raw: raw && raw !== content ? raw : '',   // AI 整理过的话，把原话也留着
    source: source || '枝',
    createdAt: Date.now(),
  };
  node.blocks.push(block);
  node.updatedAt = Date.now();
  return block;
}

function removeNode(id) {
  const ids = subtreeIds(id);
  nodes = nodes.filter((n) => !ids.has(n.id));
  rels = rels.filter((r) => !ids.has(r.sourceId) && !ids.has(r.targetId));
}

// 给模型看的树：每行带 id，它才能准确引用已有节点。
function flatList() {
  return nodes.map((n) => ({
    id: n.id,
    path: pathOf(n),
    blocks: n.blocks.length,
    types: [...new Set(n.blocks.map((b) => b.type))],
  }));
}

/* ---------------- 挂载：产品的核心交互 ---------------- */
// 模型可能引用不存在的 id、给出十层深的新路径，落库前都要洗一遍。
function normalize(result) {
  const r = result || {};
  const u = r.understanding || {};
  const m = r.mount || {};
  const title = String(u.title || '').trim().slice(0, 40);

  const clean = { ...m };
  clean.new_path = (Array.isArray(m.new_path) ? m.new_path : [])
    .map((t) => String(t || '').trim().slice(0, 40))
    .filter(Boolean)
    .slice(0, 2);
  clean.parent_node_id = byId(m.parent_node_id) ? m.parent_node_id : null;

  if (m.mode === 'existing' && byId(m.target_node_id)) {
    clean.mode = 'existing';
  } else {
    clean.mode = 'new';
    clean.target_node_id = null;
    if (!clean.new_path.length) clean.new_path = [title || '未命名想法'];
  }
  clean.confidence = Number(m.confidence) || 0;

  return {
    ...r,
    understanding: { ...u, title },
    mount: clean,
    alternatives: (Array.isArray(r.alternatives) ? r.alternatives : [])
      .map((a) => ({
        label: String(a.label || '').slice(0, 60),
        target_node_id: byId(a.target_node_id) ? a.target_node_id : null,
        parent_node_id: byId(a.parent_node_id) ? a.parent_node_id : null,
        new_path: (Array.isArray(a.new_path) ? a.new_path : []).map((t) => String(t).trim()).filter(Boolean).slice(0, 2),
        reason: String(a.reason || ''),
      }))
      .filter((a) => a.target_node_id || a.new_path.length)
      .slice(0, 3),
    relations: (Array.isArray(r.relations) ? r.relations : []).filter((x) => byId(x.target_node_id)).slice(0, 5),
  };
}

function mountLabel(m) {
  if (m.mode === 'existing') {
    const n = byId(m.target_node_id);
    return n ? pathOf(n) : '（位置已失效）';
  }
  const parent = byId(m.parent_node_id);
  return `${parent ? pathOf(parent) + ' › ' : ''}${m.new_path.join(' › ')}`;
}

async function send(text, source = '枝') {
  const value = (text ?? $('#cap-input').value).trim();
  if (!value) return toast('先写点什么，或者说一句');

  await withBusy($('#cap-send'), 'AI 找位置中…', async () => {
    const data = await api('/api/ingest', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: value, nodes: flatList() }),
    });
    pending = { text: value, source, result: normalize(data.result) };
    mount.proposed += 1;                       // 分母：AI 一共推荐了几次
    persist();
    renderProposal();
  });
}

// 用户直接接受推荐 = 这一版最重要的指标；改了位置也记下来，用来看 AI 差在哪。
function applyMount(m, accepted) {
  if (!pending) return;
  let node = m.mode === 'existing' ? byId(m.target_node_id) : null;
  if (!node) {
    const titles = m.new_path?.length ? m.new_path : [pending.result.understanding.title || '未命名想法'];
    node = ensurePath(m.parent_node_id, titles);
  }
  if (!node) return toast('这个位置不存在了，换一个');

  addBlock(node, {
    type: m.block_type,
    content: m.block_content || pending.text,
    raw: pending.text,
    source: pending.source,
  });

  (pending.result.relations || []).forEach((r) => {
    const target = byId(r.target_node_id);
    if (!target || target.id === node.id) return;
    if (rels.some((x) => x.sourceId === node.id && x.targetId === target.id)) return;
    rels.push({
      id: uid('r'),
      sourceId: node.id,
      targetId: target.id,
      type: cfg.relationTypes[r.type] ? r.type : 'related_to',
      note: String(r.note || ''),
    });
  });

  if (accepted) mount.accepted += 1;
  else mount.changed += 1;
  persist();

  const path = pathOf(node);
  pending = null;
  $('#cap-input').value = '';
  $('#cap-result').innerHTML = '';
  renderRecent();
  toast(`已长到「${path}」`);
}

/* ---------------- 枝页渲染 ---------------- */
function renderProposal() {
  const { understanding: u, mount: m, relations } = pending.result;
  const comp = u.components || {};
  const compRows = [
    ['核心主张', comp.claim],
    ['原因', comp.reason],
    ['例子', comp.example],
    ['所以呢', comp.implication],
    ['待验证', comp.question],
  ].filter(([, v]) => v && String(v).trim());

  // 用户真正要做的决定只有一个：挂不挂这里。所以它排第一屏，
  // AI 怎么拆的收进折叠区——想看再看。
  $('#cap-result').innerHTML = `
    <div class="card mount">
      <div class="fb-head"><h2>${esc(u.summary || u.title || 'AI 读到的')}</h2><span class="tag">${esc(u.type || '碎片')}</span></div>
      <p class="section-t">建议挂到</p>
      <p class="mount-path">${esc(mountLabel(m))}${m.mode === 'new' ? '<span class="new-flag">新建</span>' : ''}</p>
      <div class="row wrap">
        <span class="tag">${esc(m.block_type || '我的思考')}</span>
        <span class="conf">把握 ${Math.round((m.confidence || 0) * 100)}%</span>
      </div>
      <p class="hint">${esc(m.reason || '')}</p>
      ${
        (relations || []).length
          ? `<p class="section-t">同时关联到</p><div class="chips">${relations
              .map((r) => `<span class="chip">${esc(pathOf(byId(r.target_node_id)))} · ${esc(cfg.relationTypes[r.type] || '相关')}</span>`)
              .join('')}</div>`
          : ''
      }
      <button class="primary" id="mount-yes" type="button">就挂这里</button>
      <button class="ghost" id="mount-no" type="button">换个位置</button>
    </div>

    <div id="mount-picker" hidden></div>

    ${
      compRows.length
        ? `<details class="card">
            <summary class="fold">AI 是怎么拆的</summary>
            <div class="comp">${compRows.map(([k, v]) => `<div class="comp-row"><span>${esc(k)}</span><p>${esc(v)}</p></div>`).join('')}</div>
           </details>`
        : ''
    }`;

  $('#mount-yes').onclick = () => applyMount(pending.result.mount, true);
  $('#mount-no').onclick = renderPicker;

  $('#cap-result').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function renderPicker() {
  const { mount: m, alternatives } = pending.result;
  const options = nodes
    .slice()
    .sort((a, b) => pathOf(a).localeCompare(pathOf(b), 'zh'))
    .map((n) => `<option value="${n.id}">${esc(pathOf(n))}</option>`)
    .join('');

  const el = $('#mount-picker');
  el.hidden = false;
  el.innerHTML = `
    <div class="card">
      ${
        alternatives.length
          ? `<p class="section-t">AI 给的其他位置</p>${alternatives
              .map(
                (a, i) => `<button class="alt" data-alt="${i}" type="button">
                  <b>${esc(a.label || mountLabel({ mode: a.target_node_id ? 'existing' : 'new', ...a }))}</b>
                  <span>${esc(a.reason || '')}</span>
                </button>`
              )
              .join('')}`
          : ''
      }
      <p class="section-t">自己选</p>
      <label class="lbl">挂在哪个节点下</label>
      <select id="pick-parent" class="inp"><option value="">（作为一个新的顶层主题）</option>${options}</select>
      <label class="lbl">新建子节点<span class="lbl-tip">（留空就直接挂在上面选的节点里）</span></label>
      <input id="pick-title" class="inp" placeholder="例如：生成 → 收敛" value="${esc(m.mode === 'new' ? m.new_path.join(' / ') : '')}" />
      <label class="lbl">这段碎片的角色</label>
      <select id="pick-type" class="inp">${cfg.blockTypes
        .map((t) => `<option value="${esc(t)}"${t === m.block_type ? ' selected' : ''}>${esc(t)}</option>`)
        .join('')}</select>
      <button class="primary" id="pick-ok" type="button">挂到这里</button>
    </div>`;

  if (m.mode === 'existing') $('#pick-parent').value = m.target_node_id;
  else if (m.parent_node_id) $('#pick-parent').value = m.parent_node_id;

  $$('#mount-picker [data-alt]').forEach((b) => {
    b.onclick = () => {
      const a = alternatives[Number(b.dataset.alt)];
      applyMount(
        {
          mode: a.target_node_id ? 'existing' : 'new',
          target_node_id: a.target_node_id,
          parent_node_id: a.parent_node_id,
          new_path: a.new_path,
          block_type: m.block_type,
          block_content: m.block_content,
        },
        false
      );
    };
  });

  $('#pick-ok').onclick = () => {
    const parentId = $('#pick-parent').value || null;
    const titles = $('#pick-title').value.split('/').map((t) => t.trim()).filter(Boolean).slice(0, 2);
    if (!parentId && !titles.length) return toast('选一个节点，或者给新节点起个名');
    applyMount(
      {
        mode: titles.length ? 'new' : 'existing',
        target_node_id: titles.length ? null : parentId,
        parent_node_id: parentId,
        new_path: titles,
        block_type: $('#pick-type').value,
        block_content: pending.result.mount.block_content,
      },
      false
    );
  };
  el.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function renderRecent() {
  const items = [];
  nodes.forEach((n) => n.blocks.forEach((b) => items.push({ node: n, block: b })));
  items.sort((a, b) => b.block.createdAt - a.block.createdAt);

  // 最近 30 条碎片，按节点归堆，最新动过的排前面
  const groups = new Map();
  for (const it of items.slice(0, 30)) {
    if (!groups.has(it.node.id)) groups.set(it.node.id, { node: it.node, count: 0 });
    groups.get(it.node.id).count += 1;
  }

  const list = [...groups.values()].slice(0, 6);
  $('#recent-growth').innerHTML = list.length
    ? `<div class="card">
        <p class="section-t">最近生长</p>
        ${list
          .map(
            (g) => `<button class="grow-row" data-open="${g.node.id}" type="button">
              <span class="grow-path">${esc(pathOf(g.node))}</span>
              <span class="grow-n">+${g.count}</span>
            </button>`
          )
          .join('')}
       </div>`
    : `<div class="card empty-card">
        <p class="empty">树还是空的。随便扔一句你今天想到的东西进来，剩下的交给 AI。</p>
       </div>`;

  $$('#recent-growth [data-open]').forEach((b) => {
    b.onclick = () => {
      window.XP.goto('tree');
      openNode(b.dataset.open);
    };
  });
}

/* ---------------- 树页渲染 ---------------- */
function renderTree() {
  $('#node-detail').hidden = true;
  $('#tree-view').hidden = false;
  $('#tree-search').closest('.card').hidden = false;
  openNodeId = null;

  if (query.trim()) return renderSearch();

  const roots = childrenOf(null);
  if (!roots.length) {
    $('#tree-view').innerHTML = '<p class="empty">还没有节点。去「枝」扔第一条想法。</p>';
    return;
  }

  const row = (n, depth) => {
    const kids = childrenOf(n.id);
    return `<button class="tnode" data-open="${n.id}" style="padding-left:${10 + depth * 16}px" type="button">
        <span class="tnode-title">${depth ? '└ ' : ''}${esc(n.title)}</span>
        ${n.blocks.length ? `<span class="tnode-n">${n.blocks.length}</span>` : ''}
      </button>${kids.map((k) => row(k, depth + 1)).join('')}`;
  };

  $('#tree-view').innerHTML = `<div class="card tree">${roots.map((r) => row(r, 0)).join('')}</div>`;
  bindOpeners('#tree-view');
}

function renderSearch() {
  const q = query.trim().toLowerCase();
  const hits = [];
  nodes.forEach((n) => {
    if (n.title.toLowerCase().includes(q)) hits.push({ node: n, why: '节点名' });
    n.blocks.forEach((b) => {
      if ((b.content + b.raw).toLowerCase().includes(q)) hits.push({ node: n, why: `[${b.type}] ${b.content}` });
    });
  });

  $('#tree-view').innerHTML = hits.length
    ? hits
        .slice(0, 40)
        .map(
          (h) => `<div class="card item">
            <div class="item-meta"><span class="tag">${esc(pathOf(h.node))}</span></div>
            <div class="item-body">${esc(h.why.slice(0, 160))}</div>
            <button class="link" data-open="${h.node.id}" type="button">打开这个节点 →</button>
          </div>`
        )
        .join('')
    : '<p class="empty">没搜到。</p>';
  bindOpeners('#tree-view');
}

function bindOpeners(scope) {
  $$(`${scope} [data-open]`).forEach((b) => (b.onclick = () => openNode(b.dataset.open)));
}

/* ---------------- 节点详情 ---------------- */
function openNode(id) {
  const node = byId(id);
  if (!node) return toast('这个节点已经没了');
  openNodeId = id;
  $('#tree-view').hidden = true;
  $('#node-detail').hidden = false;
  $('#tree-search').closest('.card').hidden = true;
  renderNode();
  window.scrollTo(0, 0);
}

function renderNode() {
  const node = byId(openNodeId);
  if (!node) return renderTree();

  const kids = childrenOf(node.id);
  const linked = rels
    .filter((r) => r.sourceId === node.id || r.targetId === node.id)
    .map((r) => ({ rel: r, other: byId(r.sourceId === node.id ? r.targetId : r.sourceId) }))
    .filter((x) => x.other);

  // 按块类型分组，一个节点因此会越长越厚，而不是变成一堆并列的笔记。
  const grouped = new Map();
  node.blocks.forEach((b) => {
    if (!grouped.has(b.type)) grouped.set(b.type, []);
    grouped.get(b.type).push(b);
  });

  $('#node-detail').innerHTML = `
    <div class="card">
      <button class="link" id="back-tree" type="button">← 整棵树</button>
      <div class="fb-head"><h2>${esc(node.title)}</h2></div>
      <p class="hint">${esc(pathOf(node))}</p>
      <div class="row wrap acts">
        <button class="mini" id="act-express" type="button">帮我表达</button>
        <button class="mini" id="act-reorg" type="button">AI 重新整理</button>
        <button class="mini" id="act-move" type="button">改挂载位置</button>
        <button class="mini" id="act-rename" type="button">重命名</button>
        <button class="mini danger" id="act-del" type="button">删除</button>
      </div>
    </div>

    <div id="node-panel"></div>

    ${
      kids.length
        ? `<div class="card">
            <p class="section-t">子节点</p>
            ${kids
              .map(
                (k) => `<button class="tnode" data-open="${k.id}" type="button">
                  <span class="tnode-title">${esc(k.title)}</span>
                  ${k.blocks.length ? `<span class="tnode-n">${k.blocks.length}</span>` : ''}
                </button>`
              )
              .join('')}
           </div>`
        : ''
    }

    ${
      node.blocks.length
        ? `<div class="card">${[...grouped.entries()]
            .map(
              ([type, list]) => `<p class="section-t">${esc(type)} × ${list.length}</p>
                ${list
                  .map(
                    (b) => `<div class="blk">
                      <button class="del" data-del-block="${b.id}" type="button">删除</button>
                      <p class="blk-body">${esc(b.content)}</p>
                      ${b.raw ? `<details class="blk-raw"><summary>我当时的原话</summary><p>${esc(b.raw)}</p></details>` : ''}
                      <p class="blk-meta">${esc(b.source)} · ${fmtDate(b.createdAt)}</p>
                    </div>`
                  )
                  .join('')}`
            )
            .join('')}</div>`
        : '<div class="card"><p class="empty">这个节点还没有内容。</p></div>'
    }

    ${
      linked.length
        ? `<div class="card">
            <p class="section-t">关联节点</p>
            ${linked
              .map(
                (x) => `<button class="tnode" data-open="${x.other.id}" type="button">
                  <span class="tnode-title">${esc(pathOf(x.other))}</span>
                  <span class="tnode-n">${esc(cfg.relationTypes[x.rel.type] || '相关')}</span>
                </button>`
              )
              .join('')}
           </div>`
        : ''
    }

    <div class="card">
      <p class="section-t">直接补一块</p>
      <textarea id="blk-input" class="inp ta" rows="3" placeholder="补一个案例、一条原因、一个反例…"></textarea>
      <select id="blk-type" class="inp">${cfg.blockTypes.map((t) => `<option value="${esc(t)}">${esc(t)}</option>`).join('')}</select>
      <button class="primary" id="blk-add" type="button">存进这个节点</button>
    </div>`;

  $('#back-tree').onclick = renderTree;
  bindOpeners('#node-detail');

  $$('#node-detail [data-del-block]').forEach((b) => {
    b.onclick = () => {
      node.blocks = node.blocks.filter((x) => x.id !== b.dataset.delBlock);
      persist();
      renderNode();
    };
  });

  $('#blk-add').onclick = () => {
    const content = $('#blk-input').value.trim();
    if (!content) return toast('写点什么再存');
    addBlock(node, { type: $('#blk-type').value, content, source: '手动' });
    persist();
    renderNode();
    toast('存好了');
  };

  $('#act-express').onclick = renderExpress;
  $('#act-reorg').onclick = runReorganize;
  $('#act-move').onclick = renderMove;
  $('#act-rename').onclick = () => {
    const t = (window.prompt('新名字', node.title) || '').trim();
    if (!t) return;
    node.title = t.slice(0, 40);
    node.updatedAt = Date.now();
    persist();
    renderNode();
  };
  $('#act-del').onclick = () => {
    const count = subtreeIds(node.id).size;
    if (!window.confirm(`删除「${node.title}」${count > 1 ? `及它下面的 ${count - 1} 个子节点` : ''}？不可恢复。`)) return;
    removeNode(node.id);
    persist();
    renderTree();
    toast('删了');
  };
}

function renderMove() {
  const node = byId(openNodeId);
  const banned = subtreeIds(node.id);   // 不能把自己挂到自己的子孙下面
  const options = nodes
    .filter((n) => !banned.has(n.id))
    .map((n) => `<option value="${n.id}"${n.id === node.parentId ? ' selected' : ''}>${esc(pathOf(n))}</option>`)
    .join('');

  $('#node-panel').innerHTML = `<div class="card">
    <p class="section-t">把「${esc(node.title)}」挂到</p>
    <select id="move-to" class="inp"><option value="">（作为顶层主题）</option>${options}</select>
    <button class="primary" id="move-ok" type="button">移过去</button>
  </div>`;

  $('#move-ok').onclick = () => {
    node.parentId = $('#move-to').value || null;
    node.updatedAt = Date.now();
    persist();
    renderNode();
    toast('移好了');
  };
}

/* ---------------- 表达模式：树 → 开口 ---------------- */
function renderExpress() {
  const node = byId(openNodeId);
  $('#node-panel').innerHTML = `<div class="card">
    <p class="section-t">把这个节点讲出来</p>
    <div class="chips" id="ex-modes">${cfg.expressModes
      .map((m) => `<button class="chip" data-mode="${m.id}" type="button">${esc(m.name)}</button>`)
      .join('')}</div>
    <p class="hint">每种模式对应一个表达结构，生成完可以直接去练习页开口练。</p>
    <div id="ex-result"></div>
  </div>`;

  $$('#ex-modes .chip').forEach((chip) => {
    chip.onclick = () =>
      withBusy(chip, '生成中…', async () => {
        $$('#ex-modes .chip').forEach((c) => c.classList.toggle('on', c === chip));
        const data = await api('/api/express', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            modeId: chip.dataset.mode,
            node: { title: node.title, path: pathOf(node) },
            blocks: node.blocks.map((b) => ({ type: b.type, content: b.content })),
          }),
        });
        renderExpressResult(node, data);
      });
  });
}

function renderExpressResult(node, { result: r, mode, structure }) {
  $('#ex-result').innerHTML = `
    <p class="section-t">${esc(mode.name)}（用 ${esc(structure.name)}）</p>
    <p class="brief-open">开口第一句：<b>${esc(r.opening_line || '')}</b></p>
    <div class="rewrite">${esc(r.script || '')}</div>
    ${
      (r.slot_map || []).length
        ? `<p class="section-t">槽位</p>${r.slot_map
            .map(
              (s) => `<div class="slot">
                <div class="slot-h"><span>${esc(s.slot)}</span><span class="v ${s.source === '缺' ? 'v-缺失' : 'v-好'}">${esc(s.source || '')}</span></div>
                <p class="note">${esc(s.content || '')}</p>
              </div>`
            )
            .join('')}`
        : ''
    }
    ${
      (r.gaps || []).length
        ? `<p class="section-t">这个节点还缺</p><ul class="plain">${r.gaps.map((g) => `<li>${esc(g)}</li>`).join('')}</ul>`
        : ''
    }
    <button class="primary" id="ex-practice" type="button">去练习页开口说一遍</button>`;

  // 闭环在这里：树里生成的稿子不算数，说出来并被复盘过才算。
  $('#ex-practice').onclick = () =>
    startPractice({
      scene: `${mode.scene}：${node.title}`,
      structureId: r.structure_id || structure.id,
      brief: {
        nodeId: node.id,
        title: pathOf(node),
        openingLine: r.opening_line,
        script: r.script,
        hint: r.practice_hint,
      },
    });
}

/* ---------------- AI 重新整理 ---------------- */
function runReorganize() {
  const node = byId(openNodeId);
  const kids = childrenOf(node.id);
  withBusy($('#act-reorg'), '整理中…', async () => {
    const data = await api('/api/reorganize', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        node: { id: node.id, title: node.title, path: pathOf(node) },
        blocks: node.blocks.map((b) => ({ id: b.id, type: b.type, content: b.content })),
        children: kids.map((k) => ({ id: k.id, title: k.title, blocks: k.blocks.length })),
      }),
    });
    renderReorgProposal(node, data.result);
  });
}

function renderReorgProposal(node, r) {
  const groups = (r.groups || []).filter((g) => g.title);
  $('#node-panel').innerHTML = `<div class="card">
    <p class="section-t">AI 看到的结构</p>
    <p>${esc(r.summary || '')}</p>
    ${groups
      .map(
        (g, i) => `<div class="issue">
          <p class="prob"><b>${i + 1}. ${esc(g.title)}</b></p>
          <p class="quote">${esc(g.why || '')}</p>
          <p class="hint">会收进去：${(g.block_ids || []).length} 条碎片${(g.child_node_ids || []).length ? ` + ${g.child_node_ids.length} 个子节点` : ''}</p>
        </div>`
      )
      .join('')}
    ${
      (r.insights || []).length
        ? `<p class="section-t">顺便发现</p>${r.insights
            .map((x) => `<p class="ins"><span class="tag">${esc(x.kind || '')}</span> ${esc(x.detail || '')}</p>`)
            .join('')}`
        : ''
    }
    <p class="hint">这是建议，不是命令。整理完你随时可以再改。</p>
    <button class="primary" id="reorg-ok" type="button">按这个整理</button>
    <button class="ghost" id="reorg-no" type="button">不用了，保持原样</button>
  </div>`;

  $('#reorg-no').onclick = () => ($('#node-panel').innerHTML = '');
  $('#reorg-ok').onclick = () => {
    groups.forEach((g) => {
      const child = ensureChild(g.title, node.id);
      (g.block_ids || []).forEach((bid) => {
        const idx = node.blocks.findIndex((b) => b.id === bid);
        if (idx === -1) return;
        const [blk] = node.blocks.splice(idx, 1);
        child.blocks.push(blk);
      });
      (g.child_node_ids || []).forEach((cid) => {
        const c = byId(cid);
        if (c && c.id !== child.id && (c.parentId || null) === node.id) c.parentId = child.id;
      });
      child.updatedAt = Date.now();
    });
    node.updatedAt = Date.now();
    persist();
    renderNode();
    toast('整理好了，不满意可以直接改');
  };
}

/* ---------------- 对外 ---------------- */
window.Branch = {
  init(config) {
    cfg = {
      blockTypes: config.blockTypes || [],
      relationTypes: config.relationTypes || {},
      expressModes: config.expressModes || [],
    };
    loadAll();

    $('#cap-send').onclick = () => send();
    $('#tree-search').oninput = (e) => {
      query = e.target.value;
      if (!$('#node-detail').hidden && !query) return;
      renderTree();
    };
    createRecorder({
      btn: $('#cap-rec'),
      labelEl: $('#cap-rec-label'),
      timerEl: $('#cap-timer'),
      idleLabel: '说',
      doneLabel: '再说一段',
      onBlob: async (blob, type) => {
        try {
          const text = await transcribe(blob, type);
          const box = $('#cap-input');
          box.value = box.value ? `${box.value}\n${text}` : text;
          if (!text) toast('没听清，再说一遍？');
        } catch (err) {
          toast(err.message);
        }
      },
    });

    renderRecent();
  },

  // 笔记、复盘稿都能一键扔进树，走的是同一条挂载流程。
  capture(text, source) {
    window.XP.goto('capture');
    $('#cap-input').value = text;
    send(text, source || '枝');
  },

  renderTree,
  renderRecent,
  stats: () => ({
    nodes: nodes.length,
    blocks: nodes.reduce((a, n) => a + n.blocks.length, 0),
    proposed: mount.proposed,
    accepted: mount.accepted,
    changed: mount.changed,
  }),
  digest: () => flatList(),
  exportData: () => ({ nodes, relations: rels, mountStats: mount }),
};
})();
