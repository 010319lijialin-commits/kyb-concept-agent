// 和进销账服务器打交道：登录、成员接口，以及按每一笔同步（规则见 sync.js）。
// 本机缓存放在 IndexedDB（容量比 localStorage 大得多），每个账号的每本账一份。
import { pendingChanges, applyServerChanges, markPushed, revertRejected, keepPendingOnly } from './sync.js';

const API = '/api/ledger';
const SESSION_KEY = 'ledger.session';

export async function api(path, { method = 'GET', body } = {}) {
  let res;
  try {
    res = await fetch(API + path, {
      method,
      credentials: 'same-origin',
      cache: 'no-store',
      headers: method === 'GET' ? {} : { 'Content-Type': 'application/json' },
      body: method === 'GET' ? undefined : JSON.stringify(body ?? {}),
    });
  } catch {
    throw Object.assign(new Error('没连上服务器，检查一下网络'), { offline: true });
  }
  let data = {};
  try { data = await res.json(); } catch { /* 不是 JSON 的出错页 */ }
  if (!res.ok) throw Object.assign(new Error(data.error || `服务器出错（${res.status}）`), { status: res.status, data });
  return data;
}

// 登录过的人和上次打开的账本记在本机：没网也能打开看、接着记
export function readSession() {
  try { return JSON.parse(localStorage.getItem(SESSION_KEY) || 'null'); } catch { return null; }
}
export function saveSession(patch) {
  try { localStorage.setItem(SESSION_KEY, JSON.stringify({ ...(readSession() || {}), ...patch })); } catch { /* 存不下就下次联网再取 */ }
}
export function clearSession() {
  try { localStorage.removeItem(SESSION_KEY); } catch { /* 无所谓 */ }
}

// 这个页面是不是从进销账服务器打开的
export async function probeServer() {
  if (location.protocol === 'file:') return 'local';
  try {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 6000);
    const res = await fetch(`${API}/ping`, { signal: ctl.signal, cache: 'no-store' });
    clearTimeout(t);
    if (res.ok && (await res.json().catch(() => ({}))).app === 'jinxiaozhang') return 'server';
    return 'local';
  } catch {
    return readSession()?.me ? 'server' : 'local'; // 没网：以前在这台设备上登录过，就按服务器模式离线打开
  }
}

// ---------- 本机缓存 ----------
const kv = (() => {
  const hasIdb = typeof indexedDB !== 'undefined';
  let dbp = null;
  const open = () => (dbp ||= new Promise((resolve, reject) => {
    const r = indexedDB.open('jinxiaozhang', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('kv');
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  }));
  const run = async (mode, fn) => {
    const db = await open();
    return new Promise((resolve, reject) => {
      const t = db.transaction('kv', mode);
      const req = fn(t.objectStore('kv'));
      t.oncomplete = () => resolve(req.result);
      t.onerror = t.onabort = () => reject(t.error);
    });
  };
  const ls = {
    get: async (k) => JSON.parse(localStorage.getItem(`kv.${k}`) || 'null'),
    set: async (k, v) => localStorage.setItem(`kv.${k}`, JSON.stringify(v)),
    del: async (k) => localStorage.removeItem(`kv.${k}`),
  };
  if (!hasIdb) return ls;
  return {
    get: (k) => run('readonly', (s) => s.get(k)).catch(() => ls.get(k)),
    set: (k, v) => run('readwrite', (s) => s.put(v, k)).catch(() => ls.set(k, v)),
    del: (k) => run('readwrite', (s) => s.delete(k)).catch(() => ls.del(k)),
  };
})();
export const cache = kv;

// getState / setState：页面里自己的那本账；onGone('login' | 'removed')：登录过期 / 被移出账本；
// onRejected(list)：服务器没收下的（没权限、不是自己记的），已经恢复成服务器上的样子
export function createServerStore({ userId, ledgerId, getState, setState, onStatus, onGone, onRejected }) {
  const key = `srv:${userId}:${ledgerId}`;
  let seq = 0;
  let view = null; // 服务器按什么范围发的（'all' 整本 / 'own' 只有自己记的）
  let syncing = false, wanted = false, connected = false, retry = null, debounce = null;
  let writeQ = Promise.resolve();
  const status = (s) => { try { onStatus?.(s); } catch { /* 状态显示失败不影响保存 */ } };

  // 每次都存「当时最新的账 + 同步到哪了」
  const persist = () => (writeQ = writeQ.then(() => kv.set(key, { state: getState(), seq, view })).catch(() => status('local-failed')));

  async function syncOnce() {
    // 1) 本机记的先传上去
    for (let round = 0; round < 50; round++) {
      const pend = pendingChanges(getState()).slice(0, 400);
      if (!pend.length) break;
      const res = await api(`/l/${ledgerId}/push`, { method: 'POST', body: { changes: pend.map(({ kind, key: k, data }) => ({ kind, key: k, data })) } });
      const rejected = markPushed(getState(), pend, res.results);
      if (rejected.length) {
        setState(revertRejected(getState(), rejected));
        onRejected?.(rejected);
      }
      await persist();
    }
    // 2) 别人记的拉下来
    for (let page = 0; page < 1000; page++) {
      const r = await api(`/l/${ledgerId}/pull?since=${seq}`);
      // 身份变了（比如从全部权限改成只记收付款）：本机的账清掉，按新的范围从头拉
      const viewChanged = r.view && view && r.view !== view;
      if (r.view) view = r.view;
      if (r.reset || viewChanged) { setState(keepPendingOnly(getState())); seq = 0; await persist(); continue; }
      if (r.changes.length) setState(applyServerChanges(getState(), r.changes));
      seq = r.seq;
      if (!r.more) break;
    }
    await persist();
  }

  async function runSync() {
    if (!connected) return;
    if (syncing) { wanted = true; return; }
    syncing = true;
    clearTimeout(retry);
    try {
      do {
        wanted = false;
        status('saving');
        await syncOnce();
      } while (wanted);
      status('saved');
    } catch (e) {
      if (e.status === 401) { status('login'); onGone?.('login'); }
      else if (e.status === 403) { status('removed'); onGone?.('removed'); }
      else {
        status('offline');
        retry = setTimeout(runSync, 15000); // 没网：过一会儿再试，本机的账一直在
      }
    } finally {
      syncing = false;
    }
  }

  const onVisible = () => { if (document.visibilityState === 'visible') runSync(); };

  return {
    async load() {
      const c = await kv.get(key).catch(() => null);
      seq = c?.seq || 0;
      view = c?.view || null;
      return c?.state || null;
    },
    async connect() {
      connected = true;
      await runSync();
      setInterval(() => { if (document.visibilityState === 'visible') runSync(); }, 15000); // 别人记的，开着页面最多 15 秒就能看到
      document.addEventListener('visibilitychange', onVisible);
      window.addEventListener('online', () => runSync());
      return true;
    },
    // 每记一笔：先存本机，稍等一下再传（连着记几笔时一起传）
    save() {
      persist();
      clearTimeout(debounce);
      debounce = setTimeout(runSync, 300);
    },
    sync: runSync,
    async drop() { await kv.del(key).catch(() => {}); },
    get cloud() { return true; },
    get busy() { return syncing; },
    get seq() { return seq; },
  };
}
