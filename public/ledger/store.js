// 账本存在哪：
// - 在 claude.ai 上打开：存在当前登录账号自己的私有空间（db 能力的 data/users/<id>/），
//   只有本人看得到，换手机 / 电脑登录同一账号也在。
// - 自己部署的服务里打开：没有 claude.ai 运行时，只存浏览器 localStorage。
// 两种情况本地都留一份缓存，打开时先用它把页面画出来，再去云端拿最新的。
//
// 单个云端文档上限 256 KiB，整本账序列化后按块切开存：
//   data/users/<id>/ledger              { gen, parts, client, savedAt }
//   data/users/<id>/ledger/parts/<gen>-<i>   { s: 第 i 块 JSON 字符串 }
// 先写新块，再改指针，最后删旧块——中途断掉，指针仍指向一套完整的旧数据。

const LOCAL_KEY = 'ledger.v1';
const CHUNK = 60000; // 字符数；中文按 UTF-8 最多 3 字节，60000 字 ≈ 180 KB，留足余量

export function createStore({ onRemote, onStatus }) {
  const client = Math.random().toString(36).slice(2, 10);
  let base = null;
  let lastGen = null;
  let writing = false;
  let pending = null;

  const status = (s) => { try { onStatus?.(s); } catch { /* 状态展示失败不影响保存 */ } };

  function readLocal() {
    try {
      const raw = localStorage.getItem(LOCAL_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch { return null; }
  }
  function writeLocal(s) {
    try { localStorage.setItem(LOCAL_KEY, JSON.stringify(s)); return true; } catch { return false; }
  }

  const partRef = (gen, i) => base.collection('parts').doc(`${gen}-${i}`);

  async function readRemote() {
    const meta = await base.get();
    if (!meta.exists) return null;
    const m = meta.data();
    const parts = await Promise.all(Array.from({ length: m.parts }, (_, i) => partRef(m.gen, i).get()));
    if (parts.some((p) => !p.exists)) throw new Error('云端数据不完整');
    lastGen = m.gen;
    return JSON.parse(parts.map((p) => p.data().s).join(''));
  }

  async function writeRemote(s) {
    const json = JSON.stringify(s);
    const gen = Date.now().toString(36) + client.slice(0, 4);
    const n = Math.max(1, Math.ceil(json.length / CHUNK));
    for (let i = 0; i < n; i++) await partRef(gen, i).set({ s: json.slice(i * CHUNK, (i + 1) * CHUNK) });
    const cur = await base.get();
    const old = cur.exists ? { ...cur.data() } : null;
    await base.set({ gen, parts: n, client, savedAt: new Date().toISOString() });
    lastGen = gen;
    if (old && old.gen !== gen) for (let i = 0; i < old.parts; i++) await partRef(old.gen, i).delete().catch(() => {});
  }

  async function flush() {
    if (writing) return;
    writing = true;
    while (pending) {
      const s = pending;
      pending = null;
      status('saving');
      try {
        await writeRemote(s);
      } catch (e) {
        if (e?.code === 'unavailable') {
          await new Promise((r) => setTimeout(r, 800 + Math.random() * 800));
          try { await writeRemote(s); continue; } catch { /* 落到下面 */ }
        }
        status(e?.code === 'quota_exceeded' ? 'full' : 'error');
        writing = false;
        return;
      }
    }
    writing = false;
    status('saved');
  }

  return {
    local: readLocal,

    // 连上云端；返回云端那份账（没有就是 null），连不上返回 undefined
    async connect() {
      const use = typeof window !== 'undefined' && window.claude?.use;
      if (!use) { status('local'); return undefined; }
      const [db, user] = await Promise.all([window.claude.use('db'), window.claude.use('user')]);
      const uid = db && user ? await user.id() : null;
      if (!uid) { status('local'); return undefined; }
      base = db.doc(`data/users/${uid}/ledger`);
      let remote;
      try {
        remote = await readRemote();
      } catch {
        base = null;
        status('error');
        return undefined;
      }
      if (remote) writeLocal(remote);
      status('saved');
      // 另一台设备改了账，这边自动刷新（自己正在保存时不覆盖）
      base.onSnapshot((snap) => {
        if (!snap.exists) return;
        const m = snap.data();
        if (m.gen === lastGen || m.client === client || writing || pending) return;
        readRemote().then((s) => { if (s) { writeLocal(s); onRemote?.(s); } }).catch(() => {});
      }, () => {});
      return remote;
    },

    save(s) {
      const ok = writeLocal(s);
      if (!base) { status(ok ? 'local' : 'local-failed'); return; }
      pending = s;
      flush();
    },

    get cloud() { return Boolean(base); },
  };
}
