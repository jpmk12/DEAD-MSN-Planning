// App-shell service worker.
//
// IMPORTANT: app assets (HTML/JS/CSS) use a NETWORK-FIRST strategy so a new
// deploy is always picked up immediately — caching them cache-first previously
// caused stale app.js to be served after updates. The cache is only an offline
// fallback. API calls always go to the network; cross-origin tiles are
// cache-first (they're immutable and bandwidth-heavy).
const CACHE = 'msn-planner-v3';
const SHELL = ['./', './index.html', './app.js', './theme.css', './map.js', './projection.js', './icon.svg', './manifest.webmanifest'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL).catch(() => {})).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (url.pathname.startsWith('/api/')) return; // live data: always network

  // Cross-origin (map tiles): cache-first.
  if (url.origin !== self.location.origin) {
    e.respondWith(
      caches.match(e.request).then((hit) =>
        hit || fetch(e.request).then((res) => {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(e.request, copy)).catch(() => {});
          return res;
        }).catch(() => hit),
      ),
    );
    return;
  }

  // Same-origin app assets: network-first, fall back to cache when offline.
  e.respondWith(
    fetch(e.request).then((res) => {
      const copy = res.clone();
      caches.open(CACHE).then((c) => c.put(e.request, copy)).catch(() => {});
      return res;
    }).catch(() => caches.match(e.request).then((hit) => hit || caches.match('./index.html'))),
  );
});
