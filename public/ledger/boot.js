// 入口：先看这次是怎么打开的，再决定先登录还是直接进账本（app.js）。
import { env } from './env.js';
import { probeServer, api, readSession, saveSession, clearSession } from './remote.js';

env.mode = window.claude?.use ? 'claude' : await probeServer();

// 装到手机桌面后没网也能打开（claude.ai 页面里不能用）
if (env.mode !== 'claude' && 'serviceWorker' in navigator && location.protocol !== 'file:') {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}

if (env.mode === 'server') {
  const invite = (new URLSearchParams(location.search).get('invite') || '').trim();
  let me = null, offline = false;
  try {
    me = await api('/me');
  } catch (e) {
    if (e.status !== 401) { me = readSession()?.me || null; offline = true; } // 没网：用上次登录时记下的
  }
  const ui = () => import('./auth-ui.js');
  if (!me) {
    clearSession();
    (await ui()).showAuth({ invite });
  } else if (invite && !offline) {
    (await ui()).showJoin({ me, invite });
  } else if (!me.ledgers.length) {
    (await ui()).showNoLedger({ me });
  } else {
    const want = readSession()?.ledgerId;
    const ledger = me.ledgers.find((l) => l.id === want) || me.ledgers[0];
    saveSession({ me, ledgerId: ledger.id });
    Object.assign(env, { me, ledger, offline });
    await import('./app.js');
  }
} else {
  await import('./app.js');
}
