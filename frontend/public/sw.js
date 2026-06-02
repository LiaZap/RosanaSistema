/* FCE Studio Service Worker — apenas push notifications + invalidação de caches antigos */
const CACHE_VERSION = 'fce-v3-no-cache';

self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      // Apagar TODOS os caches antigos do SW (PWA legacy)
      const keys = await caches.keys();
      await Promise.all(keys.map((k) => caches.delete(k)));
      await self.clients.claim();
    })(),
  );
});

// IMPORTANTE: não interceptamos fetch — deixamos o navegador lidar com HTTP cache.
// Vite gera hashes nos assets, então cache-busting é automático.

// Push notifications (mantidas)
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

self.addEventListener('message', (event) => {
  if (event.data === 'SKIP_WAITING') self.skipWaiting();
});

void CACHE_VERSION;
