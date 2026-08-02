// sw.js - 基础 Service Worker
const CACHE_NAME = 'mo-home-v3';
const urlsToCache = [
  '/',
  '/chat.html',
  '/manifest.json',
  '/icon-192.png',
  '/icon-512.png'
];

// 安装时缓存关键文件
self.addEventListener('install', function(event) {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(function(cache) {
        return cache.addAll(urlsToCache);
      })
  );
  // 立即接管页面，避免旧版本继续生效
  self.skipWaiting();
});

// 拦截请求：优先从网络获取最新版本，失败时才回退到缓存（保证线上总是最新）
self.addEventListener('fetch', function(event) {
  const request = event.request;
  if (request.method !== 'GET') return;

  event.respondWith(
    fetch(request)
      .then(function(response) {
        // 同源成功响应写入缓存，供离线时使用
        if (response && response.ok) {
          try {
            const url = new URL(request.url);
            if (url.origin === location.origin) {
              const clone = response.clone();
              caches.open(CACHE_NAME).then(function(cache) {
                cache.put(request, clone);
              });
            }
          } catch (e) { /* 忽略跨域等无法缓存的情况 */ }
        }
        return response;
      })
      .catch(function() {
        return caches.match(request);
      })
  );
});

// 激活时清理旧缓存
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

// 点击浏览器通知时回到小屋
self.addEventListener('notificationclick', function(event) {
  event.notification.close();
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true })
      .then(function(clientList) {
        for (const client of clientList) {
          if ('focus' in client) return client.focus();
        }
        return clients.openWindow('/');
      })
  );
});
