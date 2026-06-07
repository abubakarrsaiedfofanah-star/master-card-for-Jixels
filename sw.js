const CACHE_NAME = 'jixels-scanner-v21';
const APP_SHELL = [
  '/scanner',
  '/scanner.html',
  '/admin',
  '/admin.html',
  '/manifest.webmanifest',
  '/node_modules/html2canvas/dist/html2canvas.min.js',
  '/jixels-logo-form-ni-tenje-cropped.jpeg'
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL)).catch(() => {}));
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))))
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;
  event.respondWith(
    fetch(request).then((response) => {
      const copy = response.clone();
      caches.open(CACHE_NAME).then((cache) => cache.put(request, copy)).catch(() => {});
      return response;
    }).catch(() => caches.match(request).then((cached) => cached || caches.match('/admin.html')))
  );
});
