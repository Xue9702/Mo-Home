// sw.js - Service Worker for Mo-Home (PWA + Web Push)
const CACHE_NAME = 'mo-home-v5';
const urlsToCache = [
  '/',
  '/chat.html',
  '/manifest.json',
  '/icon-192.png',
  '/icon-512.png'
];

// Install: pre-cache key files
self.addEventListener('install', function(event) {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(function(cache) {
        return cache.addAll(urlsToCache);
      })
  );
  self.skipWaiting();
});

// Fetch: network first, fall back to cache (keeps the site fresh)
self.addEventListener('fetch', function(event) {
  const request = event.request;
  if (request.method !== 'GET') return;

  event.respondWith(
    fetch(request)
      .then(function(response) {
        if (response && response.ok) {
          try {
            const url = new URL(request.url);
            if (url.origin === self.location.origin) {
              const clone = response.clone();
              caches.open(CACHE_NAME).then(function(cache) {
                cache.put(request, clone);
              });
            }
          } catch (e) { /* ignore cross-origin / non-cacheable */ }
        }
        return response;
      })
      .catch(function() {
        return caches.match(request);
      })
  );
});

// Activate: clean old caches
self.addEventListener('activate', function(event) {
  event.waitUntil(
    caches.keys().then(function(cacheNames) {
      return Promise.all(
        cacheNames.map(function(cacheName) {
          if (cacheName !== CACHE_NAME) {
            return caches.delete(cacheName);
          }
        })
      );
    }).then(function() {
      return self.clients.claim();
    })
  );
});

// Push: show a notification with title + body (this is what makes Edge/手机 display content)
self.addEventListener('push', function(event) {
  let payload = {};
  try {
    payload = event.data ? event.data.json() : {};
  } catch (e) {
    payload = { title: '默', body: event.data ? event.data.text() : '' };
  }
  const title = payload.title || '默';
  const options = {
    body: payload.body || '',
    icon: '/icon-192.png',
    badge: '/icon-192.png',
    tag: payload.tag || 'mo-push',
    data: { url: payload.url || '/' }
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

// Notification click: close and focus / open the home page
self.addEventListener('notificationclick', function(event) {
  event.notification.close();
  const targetUrl = event.notification.data && event.notification.data.url
    ? event.notification.data.url
    : '/';
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true })
      .then(function(clientList) {
        for (const client of clientList) {
          if ('focus' in client) return client.navigate(targetUrl) || client.focus();
        }
        return clients.openWindow(targetUrl);
      })
  );
});
