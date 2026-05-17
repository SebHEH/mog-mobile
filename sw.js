// MOG Hub Service Worker.
//
// Lets the hub landing page itself load offline. Per-store PWAs at
// /<slug>/ have their own service workers with more-specific scope;
// this hub SW only handles requests for / and /index.html. Service
// worker scope rules mean a SW at /<slug>/sw.js takes precedence
// over this one within its subdirectory.
//
// Strategy mirrors the per-store SW (template/sw.js) at smaller
// scale:
//   - Hub shell: stale-while-revalidate. Cached version paints
//     instantly; a fresh fetch runs in background and updates the
//     cache so deployments propagate on the next load.
//   - Tabler Icons CDN: cache-first runtime caching, since the
//     hub uses the same font as the per-store PWAs.
//   - Everything else: passthrough.
//
// Versioning: bump CACHE_VERSION when shipping a new hub HTML
// structure that should evict old caches. Independent of the
// per-store SW's CACHE_VERSION.

const CACHE_VERSION = 'v4';
const HUB_CACHE     = 'mog-hub-' + CACHE_VERSION;
const RUNTIME_CACHE = 'mog-hub-runtime-' + CACHE_VERSION;

// Pre-cache on install. Both './' and './index.html' resolve to the
// same document under GitHub Pages, but a navigation request might
// match either depending on how the user opened the hub (typed URL
// vs. Add-to-Home-Screen vs. shared bookmark), so we cache both.
const PRECACHE_URLS = [
  './',
  './index.html'
];

function isIconCdn_(url) {
  return url.hostname === 'cdn.jsdelivr.net';
}

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(HUB_CACHE)
      .then(cache => cache.addAll(PRECACHE_URLS))
      .catch(err => console.warn('[hub sw] precache failed', err))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  // Drop any of our caches not in the current version allow-list.
  // Note: we only touch caches starting with 'mog-hub-' so we don't
  // accidentally evict per-store SW caches that live alongside this
  // SW's caches in the browser's cache storage.
  const allowList = new Set([HUB_CACHE, RUNTIME_CACHE]);
  event.waitUntil(
    caches.keys().then(keys => Promise.all(
      keys
        .filter(k => k.startsWith('mog-hub-') && !allowList.has(k))
        .map(k => caches.delete(k))
    )).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  let url;
  try { url = new URL(req.url); }
  catch (e) { return; }

  // Same-origin navigation requests: stale-while-revalidate against
  // the hub cache.
  //
  // Only handle navigations TO the hub itself — anything under a
  // /<slug>/ path should be left to that store's SW or to network.
  // We detect "hub-scoped" by checking that the URL path is either
  // '/' (or the registration scope's root) or ends in 'index.html'
  // at the same depth.
  if (req.mode === 'navigate' && url.origin === self.location.origin) {
    const scopePath = new URL(self.registration.scope).pathname; // e.g. '/' or '/mog-mobile/'
    const isHubRoot =
      url.pathname === scopePath ||
      url.pathname === scopePath + 'index.html';
    if (isHubRoot) {
      event.respondWith(staleWhileRevalidate_(req, HUB_CACHE));
      return;
    }
    // Navigations to /<slug>/* fall through to network / per-store SW.
    return;
  }

  // Tabler Icons CDN: cache-first.
  if (isIconCdn_(url)) {
    event.respondWith(cacheFirst_(req, RUNTIME_CACHE));
    return;
  }

  // Everything else (subresources, future API calls, etc.): network.
  // Explicitly no caching of /macros/s/... — the hub never calls the
  // Apps Script API, but in case a future change does, we defer to
  // the page's own offline handling.
});

function staleWhileRevalidate_(req, cacheName) {
  return caches.open(cacheName).then(cache => {
    return cache.match(req).then(cached => {
      const fetchPromise = fetch(req).then(networkResp => {
        if (networkResp && networkResp.ok) cache.put(req, networkResp.clone());
        return networkResp;
      }).catch(() => null);
      return cached || fetchPromise || fetch(req);
    });
  });
}

function cacheFirst_(req, cacheName) {
  return caches.open(cacheName).then(cache => {
    return cache.match(req).then(cached => {
      if (cached) return cached;
      return fetch(req).then(resp => {
        if (resp && (resp.ok || resp.type === 'opaque')) {
          cache.put(req, resp.clone());
        }
        return resp;
      });
    });
  });
}
