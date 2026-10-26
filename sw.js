// Brainrot Dex service worker: push alerts, plus offline caching.
// - /a/* art and sounds: cache first (file names change when the content does)
// - the app page and the live feed: network first, cached copy when offline
const CACHE = 'bd-v2';

self.addEventListener('install', (e) => {
  self.skipWaiting();
  e.waitUntil(caches.open(CACHE).then((c) => c.add('/')).catch(() => {}));
});
self.addEventListener('activate', (e) => e.waitUntil((async () => {
  for (const k of await caches.keys()) if (k !== CACHE) await caches.delete(k);
  await self.clients.claim();
})()));

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/a/')) {
    e.respondWith((async () => {
      const c = await caches.open(CACHE);
      const hit = await c.match(req, { ignoreSearch: true });
      if (hit) return hit;
      const res = await fetch(req);
      if (res.ok && res.status === 200) c.put(req, res.clone());
      return res;
    })());
    return;
  }
  const page = req.mode === 'navigate' && (url.pathname === '/' || url.pathname === '/index.html');
  if (page || url.pathname === '/api/feed') {
    e.respondWith((async () => {
      const c = await caches.open(CACHE);
      const key = page ? '/' : '/api/feed';
      try {
        const res = await fetch(req);
        if (res.ok) c.put(key, res.clone());
        return res;
      } catch (err) {
        const hit = await c.match(key);
        if (hit) return hit;
        throw err;
      }
    })());
  }
});

self.addEventListener('push', (e) => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch { d = { title: 'Brainrot Dex', body: e.data && e.data.text() }; }
  e.waitUntil(self.registration.showNotification(d.title || 'Brainrot Dex', {
    body: d.body || '', tag: d.tag || undefined, renotify: !!d.tag,
    icon: '/icon-192.png', badge: '/favicon.png', data: { url: d.url || '/' },
  }));
});
self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const url = new URL((e.notification.data && e.notification.data.url) || '/', self.location.origin).href;
  e.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const c of all) { if ('focus' in c) { await c.focus(); if ('navigate' in c) c.navigate(url); return; } }
    await self.clients.openWindow(url);
  })());
});
