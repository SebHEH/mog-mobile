// MOG Service Worker — offline support for the PWA shell.
//
// Sole responsibility: let the PWA *page itself* load when offline.
// Application data is handled separately by the localStorage caches
// inside index.html — this file does not proxy or cache API calls.
//
// Strategy:
//   - HTML shell: NETWORK-FIRST with cache fallback. When online,
//     always fetch fresh HTML so deployments take effect on the very
//     next navigation (not the one after). When offline (or fetch
//     fails), fall back to the cached shell so the app still launches
//     from the home screen.
//
//     Historical note: this used to be stale-while-revalidate, which
//     paints instantly from cache and updates in the background. That
//     was great for first-paint speed but bad for an app shell that
//     changes meaningfully between deploys — boot-time auth flags,
//     new sessionStorage handlers, etc. were silently invisible for
//     one full load cycle after each deploy, which broke flows like
//     master-PIN auto-login from the hub. Network-first eats a small
//     latency hit (sub-second when online) in exchange for never
//     serving stale code to a working network.
//
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

const CACHE_VERSION = 'v15';
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

  // Navigation requests (i.e. the HTML document itself): NETWORK-FIRST
  // with cache fallback (see handleNavigation_). When online we always
  // fetch fresh HTML so deploys take effect on the next navigation; when
  // the network fails we serve the cached shell so the app still launches
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
  // Network-first: try the network and update the cache on success.
  // Falls back to cache only when the network actually fails (offline,
  // DNS error, server down, etc.). This guarantees that when online
  // the user always sees the latest deployed HTML — no "next load
  // picks up the change" lag.
  try {
    const resp = await fetch(req);
    // Only cache 200s and basic/cors responses. Opaque responses
    // (no-cors fetches) can fill the cache with unusable entries.
    if (resp && resp.ok && (resp.type === 'basic' || resp.type === 'cors')) {
      cache.put('./index.html', resp.clone()).catch(() => {});
    }
    return resp;
  } catch (err) {
    // Network failed — fall back to cached shell. This is the offline
    // path: home-screen launches and reloads still work because the
    // install handler precached the shell, and every successful
    // network nav since has refreshed it.
    const cached = await cache.match('./index.html') || await cache.match('./');
    if (cached) return cached;
    // True first-load offline: nothing cached, network down. Return
    // a minimal error response so the browser doesn't hang.
    return new Response('Offline and no cached shell available.', {
      status: 503,
      headers: { 'Content-Type': 'text/plain' }
    });
  }
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
