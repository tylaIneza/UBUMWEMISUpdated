// UBUMWE HOUSE service worker: makes the app installable and opens it quickly.
// Only the app's own built files are kept on the device. Data (/api) always comes from the server,
// so nobody ever sees stale rent or payment figures.
const CACHE = 'ubumwe-app-v1';

self.addEventListener('install', () => self.skipWaiting());

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== 'GET' || url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api/') || url.pathname === '/health') return;

  // Built files have a content hash in their name, so a stored copy never goes out of date.
  if (url.pathname.startsWith('/assets/')) {
    event.respondWith(caches.match(request).then((hit) => hit || fetch(request).then((response) => {
      if (response.ok) { const copy = response.clone(); caches.open(CACHE).then((cache) => cache.put(request, copy)); }
      return response;
    })));
    return;
  }

  // Pages: always the latest from the server; the last copy is used only when there is no connection.
  if (request.mode === 'navigate') {
    event.respondWith(fetch(request).then((response) => {
      if (response.ok) { const copy = response.clone(); caches.open(CACHE).then((cache) => cache.put('/', copy)); }
      return response;
    }).catch(() => caches.match('/').then((hit) => hit || Response.error())));
  }
});
