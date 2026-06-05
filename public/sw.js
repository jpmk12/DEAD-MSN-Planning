// Self-retiring service worker.
//
// Earlier versions cached the app shell. Because the assets aren't content-
// hashed, that caused stale app.js to be served against a newer index.html after
// a deploy (every handler then died / old code ran). The server now sends
// `Cache-Control: no-cache` on all app assets, so a caching service worker is
// unnecessary and was the source of version skew.
//
// This worker installs, clears every cache, unregisters itself, and reloads open
// windows so any device with an old (caching) worker self-heals and loads fresh
// from the origin. It has NO fetch handler, so it never intercepts requests.
self.addEventListener('install', () => self.skipWaiting());

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    try {
      const keys = await caches.keys();
      await Promise.all(keys.map((k) => caches.delete(k)));
      await self.clients.claim();
      await self.registration.unregister();
      const clients = await self.clients.matchAll({ type: 'window' });
      clients.forEach((c) => c.navigate(c.url)); // one reload → fresh, no SW
    } catch {
      /* best effort */
    }
  })());
});
