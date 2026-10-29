// 装到桌面后没网也能打开：页面文件联网时取最新的（顺手存一份），没网时用存下的。
// 接口（/api/）不经过这里，账本数据由页面自己存在 IndexedDB。
const CACHE = 'jxz-shell-v1';
const SHELL = [
  './', 'index.html', 'boot.js', 'env.js', 'app.js', 'auth-ui.js', 'core.js', 'store.js', 'remote.js', 'sync.js', 'roles.js',
  'ledger.css', 'manifest.webmanifest', 'icons/icon-192.png', 'icons/icon-512.png', 'icons/apple-touch-icon.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin || url.pathname.includes('/api/')) return;
  e.respondWith((async () => {
    const cache = await caches.open(CACHE);
    try {
      // 网太慢（4 秒没回）就先用存下的
      const net = fetch(e.request);
      const res = await Promise.race([net, new Promise((_, rej) => setTimeout(() => rej(new Error('slow')), 4000))]);
      if (res.ok) cache.put(url.pathname.endsWith('/') ? 'index.html' : e.request, res.clone());
      return res;
    } catch {
      const hit = await cache.match(e.request, { ignoreSearch: true }) || (e.request.mode === 'navigate' ? await cache.match('index.html') : null);
      return hit || Response.error();
    }
  })());
});
