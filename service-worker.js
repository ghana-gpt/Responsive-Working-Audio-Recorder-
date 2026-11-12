/**
 * Offline service worker.
 *
 * Strategy:
 *  - the app shell is precached on install so a cold start works offline;
 *  - navigations are network-first with a cached `index.html` fallback, so a
 *    deploy is picked up immediately but the app still opens with no network;
 *  - everything else same-origin is cache-first with a background refresh.
 *
 * Recordings never touch the cache: they live in IndexedDB and blob: URLs.
 */

const VERSION = '1.1.0';
const CACHE_NAME = `audio-recorder-shell-${VERSION}`;

/** Files that make up the installable app shell (all relative to the scope). */
const SHELL_ASSETS = [
  './',
  './index.html',
  './manifest.webmanifest',
  './styles/main.css',
  './scripts/main.js',
  './scripts/modules/audio-utils.js',
  './scripts/modules/db.js',
  './scripts/modules/dialogs.js',
  './scripts/modules/dom.js',
  './scripts/modules/format.js',
  './scripts/modules/i18n.js',
  './scripts/modules/library.js',
  './scripts/modules/library-view.js',
  './scripts/modules/mime.js',
  './scripts/modules/recorder.js',
  './scripts/modules/recorder-view.js',
  './scripts/modules/sanitize.js',
  './scripts/modules/settings.js',
  './scripts/modules/settings-view.js',
  './scripts/modules/state.js',
  './scripts/modules/store.js',
  './scripts/modules/toast.js',
  './scripts/modules/wav.js',
  './scripts/modules/zip.js',
  './scripts/modules/zip-reader.js',
  './icons/favicon.svg',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE_NAME);
      // `addAll` rejects when one asset 404s, which would leave the app
      // un-installable forever; add them individually instead.
      await Promise.all(
        SHELL_ASSETS.map(async (asset) => {
          try {
            await cache.add(new Request(asset, { cache: 'reload' }));
          } catch (error) {
            console.warn('[sw] could not precache', asset, error);
          }
        }),
      );
      await self.skipWaiting();
    })(),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys();
      await Promise.all(
        names.filter((name) => name !== CACHE_NAME).map((name) => caches.delete(name)),
      );
      await self.clients.claim();
    })(),
  );
});

/**
 * Network-first for navigations so a new deploy is visible on reload, but fall
 * back to the precached shell when the network is gone.
 *
 * @param {FetchEvent} event
 */
async function handleNavigation(event) {
  const cache = await caches.open(CACHE_NAME);
  try {
    const response = await fetch(event.request);
    if (response.ok) await cache.put('./index.html', response.clone());
    return response;
  } catch {
    return (await cache.match('./index.html')) ?? (await cache.match('./')) ?? Response.error();
  }
}

/**
 * Cache-first for static assets, revalidating in the background.
 *
 * @param {FetchEvent} event
 */
async function handleAsset(event) {
  const cache = await caches.open(CACHE_NAME);
  const cached = await cache.match(event.request, { ignoreSearch: true });
  if (cached) {
    event.waitUntil(
      (async () => {
        try {
          const fresh = await fetch(event.request);
          if (fresh.ok) await cache.put(event.request, fresh);
        } catch {
          /* offline: keep the cached copy */
        }
      })(),
    );
    return cached;
  }

  const response = await fetch(event.request);
  if (response.ok && response.type === 'basic') {
    await cache.put(event.request, response.clone());
  }
  return response;
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  // Blob URLs are recordings from IndexedDB: never cache them.
  if (request.url.startsWith('blob:')) return;

  if (request.mode === 'navigate') {
    event.respondWith(handleNavigation(event));
    return;
  }

  event.respondWith(handleAsset(event).catch(() => Response.error()));
});

/** Let the page trigger an immediate update when it shows the toast. */
self.addEventListener('message', (event) => {
  if (event.data === 'SKIP_WAITING') self.skipWaiting();
});
