/* ============================================================================
   Service worker для установки сайта как PWA.

   Стратегия:
     • /api/…            — только сеть (данные всегда свежие, оффлайн не кэшируем);
     • навигация и статика — «сначала кэш, в фоне обновляем» (stale-while-revalidate),
       поэтому приложение открывается мгновенно и работает без сети.

   При изменении набора файлов или логики поднимите VERSION — старый кэш удалится.
   ============================================================================ */
'use strict';

const VERSION = 'v2';
const CACHE = 'loanschart-' + VERSION;

/* то, что нужно для первого экрана без сети */
const PRECACHE = [
  '/LoansChart',
  '/LoansChart/admin',
  '/assets/style.css',
  '/assets/charts.js',
  '/assets/pwa.js',
  '/assets/icon-192.png',
  '/assets/icon-512.png',
  '/assets/icon-maskable-512.png',
  '/assets/apple-touch-icon-180.png',
  '/assets/favicon-32.png',
  '/assets/favicon-16.png',
  '/favicon.ico',
  '/manifest.webmanifest'
];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE)
      .then(c => c.addAll(PRECACHE))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(
        keys.filter(k => k !== CACHE).map(k => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  // данные — всегда из сети, без кэша
  if (url.pathname.startsWith('/api/')) return;

  // остальное — сначала кэш, параллельно обновляем в фоне
  event.respondWith(
    caches.open(CACHE).then(async cache => {
      const cached = await cache.match(req, { ignoreSearch: false });
      const network = fetch(req)
        .then(res => {
          if (res && res.ok) cache.put(req, res.clone());
          return res;
        })
        .catch(() => null);

      if (cached) return cached;

      const fresh = await network;
      if (fresh) return fresh;

      // навигация без сети и без кэша конкретной страницы — отдаём лендинг
      if (req.mode === 'navigate') {
        const shell = await cache.match('/LoansChart');
        if (shell) return shell;
      }
      return Response.error();
    })
  );
});
