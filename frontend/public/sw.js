/* FCE Studio Service Worker — cache estático + offline fallback */
const CACHE_VERSION = 'fce-v1';
const STATIC_CACHE = `${CACHE_VERSION}-static`;
const RUNTIME_CACHE = `${CACHE_VERSION}-runtime`;

const APP_SHELL = ['/', '/manifest.webmanifest'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(STATIC_CACHE).then((cache) => cache.addAll(APP_SHELL).catch(() => {})),
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((k) => !k.startsWith(CACHE_VERSION))
          .map((k) => caches.delete(k)),
      ),
    ),
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // Não interceptar API/websocket
  if (url.pathname.startsWith('/api') || url.pathname.startsWith('/ws')) return;
  if (event.request.method !== 'GET') return;

  // Assets estáticos (JS, CSS, fonts, imagens) — cache-first
  if (url.pathname.match(/\.(js|css|woff2?|ttf|png|jpg|svg|ico|webp)$/)) {
    event.respondWith(
      caches.match(event.request).then(
        (cached) =>
          cached ||
          fetch(event.request).then((res) => {
            if (res.ok) {
              const clone = res.clone();
              caches.open(RUNTIME_CACHE).then((cache) => cache.put(event.request, clone));
            }
            return res;
          }),
      ),
    );
    return;
  }

  // HTML — network-first com fallback cache
  event.respondWith(
    fetch(event.request)
      .then((res) => {
        if (res.ok) {
          const clone = res.clone();
          caches.open(RUNTIME_CACHE).then((cache) => cache.put(event.request, clone));
        }
        return res;
      })
      .catch(() => caches.match(event.request).then((c) => c || caches.match('/'))),
  );
});

// Listener pra push notifications
self.addEventListener('push', (event) => {
  if (!event.data) return;
  let data;
  try {
    data = event.data.json();
  } catch {
    data = { title: 'FCE Studio', body: event.data.text() };
  }
  event.waitUntil(
    self.registration.showNotification(data.title ?? 'FCE Studio', {
      body: data.body,
      icon: '/icon-192.png',
      badge: '/icon-192.png',
      tag: data.tag,
      data: data.url ?? '/dashboard',
    }),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = event.notification.data ?? '/dashboard';
  event.waitUntil(
    self.clients.matchAll({ type: 'window' }).then((wins) => {
      for (const w of wins) {
        if ('focus' in w) {
          w.navigate(url);
          return w.focus();
        }
      }
      return self.clients.openWindow(url);
    }),
  );
});
