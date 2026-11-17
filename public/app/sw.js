/* App-shell service worker. Data is always fetched from the network. */
'use strict';

const CACHE = 'sakui-shell-v1';
const SHELL = [
  '/app/',
  '/app/index.html',
  '/app/styles.css',
  '/app/app.js',
  '/app/manifest.webmanifest',
  '/app/icons/icon-192.png',
  '/app/icons/icon-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;

  // Never cache auth or data calls.
  if (url.pathname.startsWith('/api/')) return;

  if (url.pathname === '/' || url.pathname === '/app' || url.pathname.startsWith('/app/')) {
    event.respondWith(
      caches.match(event.request).then((cached) => {
        const fresh = fetch(event.request).then((res) => {
          if (res.ok && res.type === 'basic') {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put(event.request, copy));
          }
          return res;
        }).catch(() => cached || Response.error());
        return cached || fresh;
      }),
    );
  }
});
