/* =====================================================================
 * sw.js — service worker: makes the app work offline.
 *
 * Strategy: "stale-while-revalidate". Files are served from the cache
 * instantly; in the background the newest version is fetched and cached,
 * so an update appears the NEXT time you open the app.
 *
 * When you change the app's files, bump VERSION so old caches are cleared.
 * ===================================================================== */

const VERSION = 'piano-coach-v2';
const FILES = [
  './', 'index.html', 'manifest.webmanifest', 'css/style.css',
  'js/app.js', 'js/audio.js', 'js/coach.js', 'js/metronome.js', 'js/mic.js',
  'js/onset-worklet.js', 'js/fx.js', 'js/planner.js', 'js/recorder.js', 'js/store.js', 'js/timing.js',
  'icons/icon-192.png', 'icons/icon-512.png', 'icons/apple-touch-icon.png', 'icons/kora-white.png',
  ...['one','two','three','four','five','six','seven','eight','nine','ten','eleven','twelve'].map(w => `sounds/${w}.wav`),
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(VERSION).then(c => c.addAll(FILES)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(k => k !== VERSION).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET' || new URL(e.request.url).origin !== location.origin) return;
  e.respondWith(caches.open(VERSION).then(async cache => {
    const cached = await cache.match(e.request, { ignoreSearch: true });
    const network = fetch(e.request).then(res => {
      if (res && res.ok) cache.put(e.request, res.clone());
      return res;
    }).catch(() => null);
    return cached || (await network) || new Response('Offline', { status: 503 });
  }));
});
