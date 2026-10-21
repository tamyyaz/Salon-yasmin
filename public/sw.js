'use strict';

// Keeps the app shell available if the tablet briefly loses Wi-Fi.
// Code files are fetched network-first so a new deploy is picked up immediately;
// /api is never cached so balances are always live.
const CACHE = 'salon-shell-v1';
const SHELL = ['/', '/style.css', '/app.js', '/fx.js', '/manifest.webmanifest', '/icon-192.png',
  '/art/blossom.svg', '/art/rose.svg', '/art/daisy.svg', '/art/heart.svg', '/art/sparkle.svg',
  '/art/petal.svg', '/art/butterfly.svg', '/art/garland.svg', '/art/bouquet.svg'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => Promise.allSettled(SHELL.map((u) => c.add(u)))).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin || url.pathname.startsWith('/api') || url.pathname === '/healthz') return;
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        if (res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(e.request, copy)); }
        return res;
      })
      .catch(() => caches.match(e.request).then((hit) => hit || (e.request.mode === 'navigate' ? caches.match('/') : Response.error()))),
  );
});
