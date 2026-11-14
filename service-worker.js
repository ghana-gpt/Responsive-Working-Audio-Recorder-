/**
 * Offline service worker.
 *
 * Strategy:
 *  - the app shell is precached on install so a cold start works offline;
 *  - navigations are network-first with a cached `index.html` fallback, so a
 *    deploy is picked up immediately but the app still opens with no network;
 *  - everything else same-origin is cache-first with a background refresh.
 *
 * The Whisper model (~40 MB of quantized ONNX graphs) is deliberately *not*
 * precached: it is cached by the same cache-first rule the first time you
 * transcribe, so you pay for it only if you use the feature and transcription
 * then keeps working offline. The runtime that loads it (transformers.js and the
 * ONNX Runtime WASM binary, ~4.6 MB) is app code, so it *is* precached.
 *
 * Recordings never touch the cache: they live in IndexedDB and blob: URLs.
 */

const VERSION = '1.4.2';
const CACHE_NAME = `audio-recorder-shell-${VERSION}`;

/** Files that make up the installable app shell (all relative to the scope). */
const SHELL_ASSETS = [
  './',
  './index.html',
  './manifest.webmanifest',
  './styles/main.css',
  './scripts/main.js',
  './scripts/modules/asr-worker.js',
  './scripts/modules/asr.js',
  './scripts/modules/audio-utils.js',
  './scripts/modules/conversion-view.js',
  './scripts/modules/conversion.js',
  './scripts/modules/db.js',
  './scripts/modules/dialogs.js',
  './scripts/modules/dom.js',
  './scripts/modules/format.js',
  './scripts/modules/i18n.js',
  './scripts/modules/library.js',
  './scripts/modules/library-view.js',
  './scripts/modules/live-transcript.js',
  './scripts/modules/mime.js',
  './scripts/modules/mp3-wasm.js',
  './scripts/modules/mp3-worker.js',
  './scripts/modules/mp3.js',
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
  './vendor/audiobox/NOTICE.md',
  './vendor/audiobox/mp3-encoder.wasm',
  './vendor/audiobox-0.5.1/LICENSE',
  './vendor/transformers/NOTICE.md',
  './vendor/transformers/LICENSE',
  './vendor/transformers/LICENSE.onnxruntime',
  './vendor/transformers/transformers.min.js',
  './vendor/transformers/ort-wasm-simd.wasm',
  './models/whisper-tiny/LICENSE',
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
    if (response.ok) {
      // Same rule as `handleAsset`: the write must not delay the response.
      const copy = response.clone();
      event.waitUntil(
        cache.put('./index.html', copy).catch((error) => {
          console.warn('[sw] could not cache the shell', error);
        }),
      );
    }
    return response;
  } catch {
    return (await cache.match('./index.html')) ?? (await cache.match('./')) ?? Response.error();
  }
}

/**
 * Cache-first for static assets, revalidating in the background.
 *
 * Cache writes are never awaited before the response is returned. A response
 * body is only pumped to the page once `respondWith` has produced it, so
 * awaiting `cache.put(clone)` first would stall every download until the
 * browser gives up — which is exactly what happened to the ~30 MB ONNX graphs
 * (Chromium reported them as `net::ERR_ABORTED` and the model "loaded"
 * forever). Writing in `waitUntil` keeps the copy going after the page has
 * received the bytes.
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
    // `clone()` must be taken before the page touches the body; the copy is
    // filled in as the download streams to the page.
    const copy = response.clone();
    event.waitUntil(
      cache.put(event.request, copy).catch((error) => {
        // Quota errors must not break playback of the asset being cached.
        console.warn('[sw] could not cache', event.request.url, error);
      }),
    );
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
