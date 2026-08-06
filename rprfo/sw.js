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

const CACHE_VERSION = 'v49';
const SHELL_CACHE   = 'mog-shell-' + CACHE_VERSION;
const RUNTIME_CACHE = 'mog-runtime-' + CACHE_VERSION;

// ===========================================================================
// FORCE_CLIENT_RELOAD — one-shot migration hammer. ARMED.
// ===========================================================================
// SET THIS BACK TO false IMMEDIATELY AFTER THE MIGRATION DEPLOY.
//
// The problem it solves: the graceful auto-update in index.html only exists in
// v47+. A KM whose app is still running v43/v44 has no version check at all,
// and an iOS home-screen install RESUMES from memory instead of re-navigating,
// so that session can run launch-time code until iOS evicts it -- potentially
// weeks. They cannot be reached by page code, because the page code is the
// thing that's stale.
//
// Why the service worker CAN reach them: sw.js is fetched and updated by the
// browser on its own schedule, independent of how old the page's HTML/JS is.
// So new worker code runs on a v43 client. From here, client.navigate() forces
// that page to re-navigate, and because handleNavigation_ is network-first it
// lands on current code. No tap, no force-close.
//
// Cost, stated plainly: any client that does not answer the busy-check below
// gets reloaded whether or not someone is mid-count. The busy-check listener
// ships in v48, i.e. alongside this code -- so on the FIRST migration nothing
// out there can answer, and every open client is reloaded unconditionally.
// That is the entire point, and it is the price of the migration.
//
// What that costs each population:
//   - pre-v47: typed counts survive (drafts are written per keystroke and
//     re-seeded into ctx.dirty since fb89ac5), but they land on the PIN screen,
//     since pre-v47 never wrote the sessionStorage mirror that carries a
//     session across a reload.
//   - v47: reloaded too, but keeps its session -- nearly invisible.
//   - v48+: can answer the busy-check, so future uses of the hammer skip
//     anyone mid-task. This is what makes the mechanism safe to reuse.
//
// DEPLOY AT A QUIET HOUR. Not during an ordering window.
const FORCE_CLIENT_RELOAD = true;

// Identity of THIS migration. A client that has already been dragged forward
// records this id and is never force-reloaded for it again — so leaving the
// flag armed cannot double-reload anyone, and forgetting to disarm is
// harmless. To run a genuinely new migration later, change this id (that is
// the deliberate act; the boolean alone is no longer enough).
//
// This also makes leaving it armed the SAFER choice for a while: stragglers
// still on old code convert whenever their browser finally fetches this
// worker, while everyone already migrated is skipped.
const FORCE_RELOAD_ID = '2026-08-05-v48-stale-install-migration';

// Survives the activate cleanup below via the allow-list — if this cache were
// evicted with the old shells, the latch would be forgotten on every deploy
// and the whole guarantee would evaporate.
const MIGRATION_CACHE = 'mog-migrations';

async function migrationAlreadyRan_(id) {
  try {
    const c = await caches.open(MIGRATION_CACHE);
    return !!(await c.match('./__mog_migration__/' + id));
  } catch (err) {
    // Can't read the latch — assume it already ran. Skipping a reload is a
    // far cheaper mistake than reloading a KM mid-count on every deploy.
    console.warn('[sw] migration latch unreadable, skipping:', err);
    return true;
  }
}

async function markMigrationRan_(id) {
  try {
    const c = await caches.open(MIGRATION_CACHE);
    await c.put('./__mog_migration__/' + id, new Response('done'));
  } catch (err) {
    console.warn('[sw] could not record migration latch:', err);
  }
}

// How long to wait for clients to answer the busy-check before assuming
// silence means "old client, safe to reload". Short: a live page replies in
// ~1 frame, and every extra ms is delay on the activate handler.
const BUSY_CHECK_TIMEOUT_MS = 400;

// Asks one client whether it's mid-task. Resolves true (busy) only on an
// explicit "busy" answer; silence or any error resolves false, which is what
// makes stale clients reloadable.
function clientIsBusy_(client) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (v) => { if (!settled) { settled = true; resolve(v); } };
    try {
      const ch = new MessageChannel();
      ch.port1.onmessage = (e) => done(!!(e.data && e.data.busy));
      client.postMessage({ type: 'mog-busy-check' }, [ch.port2]);
    } catch (err) {
      done(false);
    }
    setTimeout(() => done(false), BUSY_CHECK_TIMEOUT_MS);
  });
}

async function forceStaleClientsForward_() {
  try {
    if (await migrationAlreadyRan_(FORCE_RELOAD_ID)) return;
    // Record BEFORE navigating, not after: navigate() tears the client's page
    // down and can end this worker's execution context mid-await, which would
    // leave the latch unwritten and re-fire on the next deploy.
    await markMigrationRan_(FORCE_RELOAD_ID);
    const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    await Promise.all(clients.map(async (client) => {
      if (await clientIsBusy_(client)) {
        console.warn('[sw] client reports busy — skipping forced reload');
        return;
      }
      try {
        // navigate() needs the client to be same-origin and is unsupported in
        // some engines; fall back to asking the page to reload itself, which
        // only v47+ will understand.
        if (typeof client.navigate === 'function') await client.navigate(client.url);
        else client.postMessage({ type: 'mog-force-reload' });
      } catch (err) {
        console.warn('[sw] forced reload failed for a client:', err);
      }
    }));
  } catch (err) {
    console.warn('[sw] forceStaleClientsForward_ failed:', err);
  }
}

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
  // MIGRATION_CACHE is version-independent ON PURPOSE: it holds the
  // forced-reload latch, and evicting it here would make every deploy forget
  // that a client had already been migrated — re-firing the hammer each time.
  const allow = new Set([SHELL_CACHE, RUNTIME_CACHE, MIGRATION_CACHE]);
  event.waitUntil(
    caches.keys().then(keys => Promise.all(
      keys.filter(k => k.indexOf('mog-') === 0 && !allow.has(k))
          .map(k => caches.delete(k))
    ))
    .then(() => self.clients.claim())
    // Must run AFTER claim(): an unclaimed client isn't ours to navigate, and
    // claiming first also means the reload it performs is served by this
    // worker rather than the outgoing one.
    .then(() => (FORCE_CLIENT_RELOAD ? forceStaleClientsForward_() : undefined))
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
