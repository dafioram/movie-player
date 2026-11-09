// Service worker: caches the app's own files (never media) so it works offline once installed.
// A new version installs in the background and waits; the page asks the user before switching.

const VERSION = 'v1.0.0';
const CACHE = 'movie-player-' + VERSION;
const ASSETS = [
  './',
  'index.html',
  'help.html',
  'manifest.webmanifest',
  'css/player.css',
  'icons/icon.svg',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/icon-maskable-512.png',
  'js/main.js',
  'js/app.js',
  'js/intake.js',
  'js/zip.js',
  'js/names.js',
  'js/movie.js',
  'js/storage.js',
  'js/thumbs.js',
  'js/decoder-info.js',
  'js/demux/mpeg.js',
  'js/demux/mkv.js',
  'js/engine/fmp4.js',
  'js/engine/annexb.js',
  'js/engine/remux.js',
  'js/codec/avcore.js',
  'js/codec/flac.js',
  'js/codec/worker.js',
  'js/codec/client.js',
  'js/subs/manager.js',
  'js/subs/text.js',
  'js/subs/encoding.js',
  'js/subs/pgs.js',
  'js/subs/vobsub.js',
  'js/subs/fontnames.js',
  'js/ui/dom.js',
  'js/ui/menus.js',
  'js/ui/notices.js',
  'js/ui/details.js',
  'lib/mediabunny/mediabunny.min.mjs',
  'lib/avcore/avcore.wasm',
  'lib/jassub/jassub.js',
  'lib/jassub/worker/worker.js',
  'lib/jassub/wasm/jassub-worker.js',
  'lib/jassub/wasm/jassub-worker.wasm',
  'lib/jassub/wasm/jassub-worker-modern.js',
  'lib/jassub/wasm/jassub-worker-modern.wasm',
  'lib/jassub/default.woff2',
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)));
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) if (key.startsWith('movie-player-') && key !== CACHE) await caches.delete(key);
    await self.clients.claim();
  })());
});

self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'skipWaiting') self.skipWaiting();
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    if (req.mode === 'navigate') {
      // the app is one page: launches from "Open with" land here too
      const page = url.pathname.endsWith('help.html') ? 'help.html' : 'index.html';
      const hit = await cache.match(page);
      if (hit) return hit;
    }
    const hit = await cache.match(req, { ignoreSearch: true });
    if (hit) return hit;
    try {
      return await fetch(req);
    } catch (e) {
      return new Response('Offline', { status: 503, statusText: 'Offline' });
    }
  })());
});
