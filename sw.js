// sw.js - service worker (registered as an ES module).
// Jobs: 1) cache the app shell so the app opens offline,
//       2) receive Android shares (Web Share Target) and put them in the queue,
//       3) upload the queue on Background Sync when the browser supports it.

import { drain } from './uploader.js';
import { handleShare } from './share.js';

// BUMP THIS NUMBER whenever any file in the app shell changes.
// A new value makes the browser fetch every file again and drop the old cache.
const CACHE = 'cortex-capture-v1';

const SHELL = [
  './', './index.html', './app.js', './styles.css', './manifest.webmanifest',
  './icon.svg', './icon-192.png', './icon-512.png',
  './db.js', './enqueue.js', './uploader.js', './share.js',
  './lib/naming.js', './lib/capture.js', './lib/queue.js', './lib/protocol.js', './lib/b64.js', './lib/settings.js',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE)
      .then((cache) => cache.addAll(SHELL.map((url) => new Request(url, { cache: 'reload' }))))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

const SHARE_PATH = new URL('./share-target', self.registration.scope).pathname;

self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);

  // The Android share sheet POSTs here (see share_target in the manifest).
  if (request.method === 'POST' && url.pathname === SHARE_PATH) {
    event.respondWith((async () => {
      let count = 0;
      try {
        count = await handleShare(await request.formData());
      } catch (err) {
        console.error('share failed', err);
      }
      event.waitUntil(drain().catch(() => {})); // try to upload right away
      // 303 turns the POST into a GET of the app page.
      return Response.redirect(new URL(`./?shared=${count}`, self.registration.scope).href, 303);
    })());
    return;
  }

  // Everything else: cache first, network as fallback (same-origin GET only).
  if (request.method !== 'GET' || url.origin !== self.location.origin) return;
  event.respondWith(
    caches.match(request, { ignoreSearch: true }).then((hit) => hit || fetch(request).catch(() => (
      request.mode === 'navigate' ? caches.match('./index.html') : Response.error()
    ))),
  );
});

// Background Sync (Chrome on Android). The page registers the tag 'cortex-drain'.
self.addEventListener('sync', (event) => {
  if (event.tag === 'cortex-drain') {
    // If drain throws, the browser retries the sync later.
    event.waitUntil(drain({ force: true }).then((r) => { if (r.offline) throw new Error('offline'); }));
  }
});
