// Offline cache: after the first visit the app works without any network connection.
const VERSION = 'pencil3d-v1';
const FILES = [
  './', 'index.html', 'print.html', 'manifest.webmanifest', 'css/app.css',
  'js/app.js', 'js/view.js', 'js/model.js', 'js/geom.js', 'js/worker.js',
  'js/core/markers.js', 'js/core/cvmath.js', 'js/core/tracker.js', 'js/export/exporters.js',
  'vendor/cv.js', 'vendor/aruco.js', 'vendor/aruco_mip_16h3.js',
  'vendor/three.module.js', 'vendor/three.core.js',
  'vendor/rhino3dm.module.min.js', 'vendor/rhino3dm.wasm',
  'icons/icon-180.png', 'icons/icon-192.png', 'icons/icon-512.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(FILES)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;
  e.respondWith(
    caches.match(e.request, { ignoreSearch: true }).then((hit) => hit || fetch(e.request).then((res) => {
      if (res.ok && new URL(e.request.url).origin === location.origin) {
        const copy = res.clone();
        caches.open(VERSION).then((c) => c.put(e.request, copy));
      }
      return res;
    }))
  );
});
