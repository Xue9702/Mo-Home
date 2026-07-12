// sw.js - 基础 Service Worker
const CACHE_NAME = 'mo-home-v1';
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
});

// 拦截请求，优先从缓存返回
self.addEventListener('fetch', function(event) {
  event.respondWith(
    caches.match(event.request)
      .then(function(response) {
        // 如果缓存命中则返回缓存，否则从网络获取
        if (response) {
          return response;
        }
        return fetch(event.request);
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
    })
  );
});