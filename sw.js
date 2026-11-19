// 앱 파일을 수정해서 다시 올릴 때는 이 숫자를 올려 주세요.
const VERSION = 'atelier-v1.5.0';
const FONTS = 'atelier-fonts';
const SHELL = [
  './',
  './index.html',
  './css/style.css',
  './js/app.js',
  './js/db.js',
  './js/nai.js',
  './js/tags.js',
  './js/thumb.js',
  './js/zip.js',
  './js/backup.js',
  './js/icons.js',
  './js/tagtab.js',
  './fonts/NotoSerifKR-500.woff2',
  './manifest.webmanifest',
  './icons/icon.svg',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/apple-touch-icon.png',
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(VERSION).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== VERSION && k !== FONTS).map(k => caches.delete(k))))
      .then(() => self.clients.claim()));
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  const same = url.origin === location.origin;
  const font = /(^|\.)fonts\.(googleapis|gstatic)\.com$|(^|\.)cdn\.jsdelivr\.net$/.test(url.hostname);
  if (!same && !font) return;

  e.respondWith((async () => {
    const cache = await caches.open(font ? FONTS : VERSION);
    const cached = await cache.match(req, { ignoreSearch: same });
    const network = fetch(req)
      .then(res => { if (res && (res.ok || res.type === 'opaque')) cache.put(req, res.clone()); return res; })
      .catch(() => null);
    if (cached) { e.waitUntil(network); return cached; }
    const res = await network;
    if (res) return res;
    if (req.mode === 'navigate') return (await cache.match('./index.html')) || Response.error();
    return Response.error();
  })());
});
