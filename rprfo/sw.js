// MOG Service Worker — Phase 4 of offline support (Option A).
//
// Sole responsibility: let the PWA *page itself* load when offline.
// Application data is handled separately by the localStorage caches
// inside index.html — this file does not proxy or cache API calls.
//
// Strategy:
//   - HTML shell: stale-while-revalidate. Cached version paints
//     instantly; a fresh fetch runs in the background and updates
//     the cache so the next load (or next reload) picks up
//     deployments without manual cache-clearing.
//   - Tabler Icons CDN (CSS + woff2 font): cache-first runtime
//     caching. These are immutable enough that the first cached
//     copy is the only one we'll ever need.
//   - Apps Script API and everything else: passthrough. The SW
//     never touches /macros/s/... requests; those flow through to
//     the network normally and the page's own offline-aware code
//     handles them.
//
// Versioning: bump CACHE_VERSION when shipping a new HTML structure
// or service-worker behavior that needs old caches evicted. Old
// caches are deleted in the `activate` handler.

const CACHE_VERSION = 'v2';
const SHELL_CACHE   = 'mog-shell-' + CACHE_VERSION;
const RUNTIME_CACHE = 'mog-runtime-' + CACHE_VERSION;

// URLs to pre-cache on install. Both './' and './index.html' point
// at the same document under GitHub Pages, but a navigation request
// might match either depending on how the user opened the app
// (typed URL vs Add to Home Screen), so we cache both for safety.
const PRECACHE_URLS = [
  './',
  './index.html'
];

// The Tabler Icons CSS lives on jsdelivr and pulls in a woff2 file.
// We don't precache it (the woff2 URL isn't known until the CSS is
// parsed) — instead we runtime-cache anything from jsdelivr the
// first time it's requested.
function isIconCdn_(url) {
  return url.hostname === 'cdn.jsdelivr.net';
}

// The Apps Script API. Any request whose path includes /macros/s/
// is server work and must never be cached — application logic in
// index.html handles offline behavior for these.
function isAppsScriptApi_(url) {
  return url.hostname.endsWith('.google.com') &&
         url.pathname.indexOf('/macros/s/') >= 0;
}

self.addEventListener('install', (event) => {
  // Pre-cache the HTML shell so a first-launch-then-offline still
  // has something to serve. If precaching fails (network down at
  // install time) we don't block install — runtime caching will
  // backfill on the next online load.
  event.waitUntil(
    caches.open(SHELL_CACHE)
      .then(cache => cache.addAll(PRECACHE_URLS))
      .catch(err => console.warn('[sw] precache failed', err))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  // Drop any caches not in our current allow-list. This is how new
  // CACHE_VERSION deployments evict stale shells cleanly.
  const allow = new Set([SHELL_CACHE, RUNTIME_CACHE]);
  event.waitUntil(
    caches.keys().then(keys => Promise.all(
      keys.filter(k => k.indexOf('mog-') === 0 && !allow.has(k))
          .map(k => caches.delete(k))
    )).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  // GET only — we never cache POST/PUT/DELETE.
  if (req.method !== 'GET') return;

  const url = new URL(req.url);

  // API requests: passthrough. Do not even register a respondWith;
  // let the browser handle the fetch normally.
  if (isAppsScriptApi_(url)) return;

  // Navigation requests (i.e. the HTML document itself): SWR.
  // For any same-origin navigation we serve the cached shell and
  // refresh in the background. This is what lets the app launch
  // offline.
  if (req.mode === 'navigate') {
    event.respondWith(handleNavigation_(req));
    return;
  }

  // Tabler Icons CDN: cache-first.
  if (isIconCdn_(url)) {
    event.respondWith(handleCdnAsset_(req));
    return;
  }

  // Anything else: passthrough.
});

async function handleNavigation_(req) {
  const cache = await caches.open(SHELL_CACHE);
  // Try cached shell first. If we have it, return it immediately
  // and refresh in the background; otherwise fall through to a
  // network fetch.
  const cached = await cache.match('./index.html') || await cache.match('./');
  const networkPromise = fetch(req)
    .then(resp => {
      // Only cache 200s and basic/cors responses. Opaque responses
      // (no-cors fetches) can fill the cache with unusable entries.
      if (resp && resp.ok && (resp.type === 'basic' || resp.type === 'cors')) {
        cache.put('./index.html', resp.clone()).catch(() => {});
      }
      return resp;
    })
    .catch(() => null);

  if (cached) {
    // Fire and forget — the refresh updates the cache for next load.
    networkPromise.then(() => {});
    return cached;
  }
  // No cache yet: must wait for network. If that fails too (true
  // first-load offline), there's nothing we can do — return a
  // minimal error response so the browser doesn't hang.
  const fresh = await networkPromise;
  return fresh || new Response('Offline and no cached shell available.', {
    status: 503,
    headers: { 'Content-Type': 'text/plain' }
  });
}

async function handleCdnAsset_(req) {
  const cache = await caches.open(RUNTIME_CACHE);
  const cached = await cache.match(req);
  if (cached) return cached;
  try {
    const resp = await fetch(req);
    if (resp && resp.ok) {
      // CDN responses are often opaque (no-cors). Cache them anyway;
      // they'll render correctly even though we can't read their
      // contents in JS.
      cache.put(req, resp.clone()).catch(() => {});
    }
    return resp;
  } catch (err) {
    // Network failed and no cache — return a 503 so CSS/font load
    // fails cleanly. The page's text content still renders fine
    // without the Tabler font; we just get blank squares where
    // icons would be.
    return new Response('', { status: 503 });
  }
}
