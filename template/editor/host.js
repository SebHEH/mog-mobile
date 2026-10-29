// MOG editor host: the Apps Script editor pages (Editor Home, Manage Items,
// Manage Vendors, Storage Areas, Shelf to Sheet) running as static pages on
// Supabase (docs/MOG_OneApp_Spec.md Phases 2 and 4).
//
// The page talks to its server only through google.script.run: the PIN gate
// calls editorAuth / editorPing, and every tool call goes through
// webedit_call(token, fn, args). This file supplies google.script.run so
// those calls are answered here instead:
//   editorAuth(pin)      -> mog_editor_login (same PIN, same lockout)
//   editorPing(token)    -> mog_editor_get   (validates and loads the tables)
//   webedit_call(fn, ..) -> catalogEdit.js on the tables held here; a write
//                           is sent with mog_editor_apply, then kept locally
// It loads before the page's own scripts (build.py puts it first in <head>),
// needs window.MOG_SUPABASE = { url, key, slug }, window.MOG_EDITOR_PAGE
// (which page this is) and window.CatalogEdit. On sign-in it fills the data
// the Apps Script page would have had baked in (VENDOR_TABLE, AREA_LIST,
// PICK_DATA), which each page reads in its start-up function.
//
// Links: every page links the others as BASE_URL + '?page=<name>', and
// build.py sets BASE_URL to index.html (Editor Home), so Editor Home sends
// ?page=<name> on to that page's file. Tools not in the app yet show as
// coming soon there.
//
// It also adds the Changes panel (the store's change log, with Undo), the
// Needs review panel, and the Import from MarginEdge button (meImport.js).
//
// On a computer these pages run inside the app (?embed=1, a frame beside the
// app's sidebar; docs/MOG_OneApp_Spec.md U2): the app holds the session and
// the language, and a page opened by itself there goes to the app.
(function () {
  'use strict';

  const cfg = window.MOG_SUPABASE || {};
  const CE = window.CatalogEdit;
  const PAGE = window.MOG_EDITOR_PAGE || 'items';
  // The pages in the app, by the ?page= name the Apps Script editor uses.
  const PAGES = { editor: 'index.html', items: 'items.html', vendors: 'vendors.html', areas: 'areas.html', pickpath: 'pickpath.html',
                  history: 'history.html', healthcheck: 'healthcheck.html', changes: 'changes.html', overview: 'overview.html' };

  // Inside the app (docs/MOG_OneApp_Spec.md U2): on a computer the app is the
  // one page that loads, and this page runs in a frame beside its sidebar
  // (<page>.html?embed=1). The app (window.MOG_SHELL) holds the session and
  // the language. EditorShell reads MOG_EMBED to drop its own chrome.
  const SHELL = (function () {
    try {
      if (window.parent === window || new URLSearchParams(location.search).get('embed') !== '1') return null;
      return window.parent.MOG_SHELL || null;   // same site, so same origin
    } catch (e) { return null; }
  })();
  window.MOG_EMBED = !!SHELL;
  if (SHELL) window.MOG_EMBED_OPEN = function (page) { SHELL.open(page); };   // EditorShell's "← Editor home"
  // Until its header is in place (EditorShell's mgeMountWebChrome_, or its
  // PIN card), the page stays hidden, so its in-Sheet look never flashes in
  // the app. Shown after 6 seconds whatever happens.
  if (SHELL && document.head && document.documentElement) {
    const hide = document.createElement('style');
    hide.textContent = 'html.mge-embed-boot body{visibility:hidden}';
    document.head.appendChild(hide);
    document.documentElement.classList.add('mge-embed-boot');
    setTimeout(function () { document.documentElement.classList.remove('mge-embed-boot'); }, 6000);
  }
  // The app's name for this page (its #<route>).
  const ROUTE = (function () {
    if (PAGE !== 'home') return PAGE;
    let want = null;
    try { want = new URLSearchParams(location.search).get('page'); } catch (e) { want = null; }
    return (want && want !== 'editor' && PAGES[want]) ? want : 'overview';
  })();
  // An editor page opened by itself on a computer (a bookmark, an old link)
  // goes to the app, which opens it beside the sidebar.
  if (!SHELL && window.parent === window && typeof window.matchMedia === 'function' &&
      window.matchMedia('(any-pointer: fine) and (min-width: 900px)').matches) {
    location.replace('../#' + ROUTE);
    return;
  }
  if (SHELL) {
    try { localStorage.setItem('mog_edit_lang', SHELL.lang() === 'es' ? 'es' : 'en'); } catch (e) { /* the page opens in English */ }
  }

  // Editor Home reached as index.html?page=<name>: open that page instead.
  if (PAGE === 'home' && typeof location !== 'undefined' && location.search && !SHELL) {
    const params = new URLSearchParams(location.search);
    const want = params.get('page');
    if (want && want !== 'editor' && PAGES[want]) {
      params.delete('page');
      const rest = params.toString();
      location.replace(PAGES[want] + (rest ? '?' + rest : ''));
    }
  }
  const H = { token: null, tables: null, changes: [], version: null, store: null };
  const TIMEOUT_MS = 15000;

  // The tool pages' EN/ES switch sets a body class without storing it; Editor
  // Home stores it (mog_edit_lang) instead.
  const lang = () => {
    const b = document.body;
    if (b && b.classList.contains('lang-es')) return 'es';
    if (b && b.classList.contains('lang-en')) return 'en';
    try { return localStorage.getItem('mog_edit_lang') === 'es' ? 'es' : 'en'; } catch (e) { return 'en'; }
  };
  const tr = (en, es) => (lang() === 'es' ? es : en);

  // The name this device counts under in the app ("Who's counting?").
  function whoName() {
    try { const v = localStorage.getItem('mog_name_' + (cfg.slug || '')); return v ? v : null; } catch (e) { return null; }
  }

  // The last calls' times, for checking the under-1s target
  // (__MOG_EDITOR_HOST__.timings in the console).
  const timings = [];

  async function rpc(fn, params) {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), TIMEOUT_MS);
    const t0 = Date.now();
    try {
      const resp = await fetch(cfg.url + '/rest/v1/rpc/' + fn, {
        method: 'POST',
        headers: { apikey: cfg.key, 'Content-Type': 'application/json' },
        body: JSON.stringify(params),
        signal: controller.signal
      });
      const text = await resp.text();
      timings.push({ fn: fn, ms: Date.now() - t0, bytes: text.length });
      if (timings.length > 50) timings.shift();
      let json = null;
      try { json = JSON.parse(text); } catch (e) { json = null; }
      if (resp.status !== 200 || !json || typeof json.ok !== 'boolean') {
        throw new Error('Supabase HTTP ' + resp.status + ' ' + String(text).substring(0, 120));
      }
      return json;
    } catch (e) {
      if (e && e.name === 'AbortError') throw new Error(tr('The server did not answer. Check the connection and try again.',
                                                          'El servidor no respondió. Revisa la conexión e inténtalo de nuevo.'));
      throw e;
    } finally {
      clearTimeout(t);
    }
  }

  // A sign-in answer (login or get) becomes what the page works on. A token
  // from ANOTHER store is refused: every store's editor shares this site's
  // storage, and the server would happily serve that other store's catalog.
  function adopt(data) {
    if (!data || !data.store || data.store.slug !== cfg.slug) return false;
    H.tables = data.tables;
    H.changes = data.changes || [];
    H.reviews = data.reviews || [];   // schema v7: phones' "just today" edits waiting for review
    H.version = data.catalogVersion;
    H.store = data.store;
    window.VENDOR_LIST = CE.vendorList(H.tables);
    if (data.store.abbr) window.MOG_ABBR = data.store.abbr;
    fillPage();
    // Manage Items keeps its own item cache between opens; the tables here
    // are always fresh, so mark that cache stale (its own invalidation key).
    try { localStorage.setItem('mog_lastMutationTs', String(Date.now())); } catch (e) { /* no cache, no problem */ }
    mountChanges();
    return true;
  }

  // What the Apps Script page would have had baked in, from the tables. The
  // first vendor A-Z opens Shelf to Sheet (the Sheet opens the one picked in
  // its SETUP tab, which the app doesn't have).
  function fillPage() {
    if (PAGE === 'vendors') window.VENDOR_TABLE = CE.call(H.tables, 'getVendorTableData', []).result;
    else if (PAGE === 'areas') window.AREA_LIST = CE.call(H.tables, 'getStorageAreaList', []).result;
    else if (PAGE === 'pickpath') {
      window.PICK_DATA = window.VENDOR_LIST.length ? CE.call(H.tables, 'getPickPathForSidebar', [window.VENDOR_LIST[0]]).result : {};
    } else if (PAGE === 'home' && Array.isArray(window.HOME_SECTIONS)) {
      for (const sec of window.HOME_SECTIONS) for (const c of sec.cards || []) if (!PAGES[c.page]) c.live = false;
    }
  }

  async function refresh() {
    const r = await rpc('mog_editor_get', { p_token: H.token });
    if (!r.ok || !adopt(r.data)) throw new Error('SESSION_EXPIRED');
  }

  function notDirect() {
    setTimeout(function () {
      if (typeof window.mgeErr_ === 'function') {
        window.mgeErr_("This store's catalog is still edited in the Sheet's web editor.",
                       'El catálogo de esta tienda todavía se edita en el editor de la hoja.');
      }
    }, 0);
  }

  // A tool call. Reads answer from the tables; a write is sent, and kept
  // locally once Supabase took it. A row someone else changed in the
  // meantime (CONFLICT): reload the tables and work the call out again, once.
  async function callTool(fn, args) {
    for (let pass = 0; pass < 2; pass++) {
      const out = CE.call(H.tables, fn, args);
      if (!out.ops || !out.ops.length) return out.result;
      const by = whoName();
      const r = await rpc('mog_editor_apply', { p_token: H.token, p_label: out.label, p_by: by, p_ops: out.ops });
      if (r.ok) {
        H.tables = CE.applyOps(H.tables, out.ops);
        H.version = r.data.catalogVersion;
        H.changes.unshift({ id: r.data.changeId, at: new Date().toISOString(), by: by, label: out.label, undoes: null, undoneBy: null });
        renderChanges();
        try { localStorage.setItem('mog_lastMutationTs', String(Date.now())); } catch (e) { /* see adopt */ }
        return out.result;
      }
      if (r.error === 'SESSION_EXPIRED' || r.error === 'EDITOR_NOT_DIRECT') throw new Error('SESSION_EXPIRED');
      if (r.error === 'CONFLICT' && pass === 0) { await refresh(); continue; }
      if (r.error === 'CONFLICT') {
        throw new Error(tr('Someone else changed this just now. Reload the page and try again.',
                           'Alguien más acaba de cambiar esto. Recarga la página e inténtalo de nuevo.'));
      }
      throw new Error(r.error || 'Save failed');
    }
  }

  // ---- Calls answered here, not by catalogEdit.js --------------------------------
  // Order History and the Par Review flags read Supabase's order log, and the
  // Health Check the store's status (docs/MOG_OneApp_Spec.md T1, T4); the
  // history and flag math is OrderMath.gs's (orderMath.js), the Sheet's own.

  async function history(dateFrom, dateTo) {
    const r = await rpc('mog_history', { p_token: H.token, p_from: dateFrom || null, p_to: dateTo || null });
    if (!r.ok) throw new Error(r.error === 'SESSION_EXPIRED' ? 'SESSION_EXPIRED' : String(r.error));
    return { rows: historyRowsFromLog_(r.data.rows), vendors: r.data.vendors || [], today: r.data.today };
  }

  // Items.gs getManageItemsBootstrap_: flags over the last 28 days, base pars
  // from the items Manage Items shows (par > 0).
  async function parFlags() {
    // A few days more than the 28-day window, so a computer clock a little
    // off still reads every row the window needs; the cutoff itself is the
    // store's own today (mog_history), as on the Sheet.
    const from = new Date(Date.now() - 35 * 86400000).toISOString().slice(0, 10);
    const h = await history(from, null);
    const parMap = new Map();
    for (const it of CE.call(H.tables, 'getAllItemsForView', []).result) {
      const par = Number(it.par);
      if (it.id && !isNaN(par) && par > 0) parMap.set(it.id, par);
    }
    return parReviewFlags_(h.rows, parMap, parFlagCutoff_(h.today));
  }

  const HOST_CALLS = {
    getManageItemsBootstrap: async function () {
      let flags = {};
      try { flags = await parFlags(); } catch (e) { flags = {}; }   // as Items.gs: no flags beats no page
      return CE.call(H.tables, 'getManageItemsBootstrap', [flags, parFlagRules_().MIN_ORDERS]).result;
    },
    // History.gs getOrderHistoryBootstrap_ / getOrderHistory_.
    getOrderHistoryBootstrap: async function (args) {
      const f = args[0] || {};
      const h = await history(f.dateFrom, f.dateTo);
      const vendors = h.vendors.slice().sort();
      return { vendors: vendors.length ? vendors : CE.vendorList(H.tables), rows: historyRowsFiltered_(h.rows, f).rows };
    },
    getOrderHistory: async function (args) {
      const f = args[0] || {};
      const h = await history(f.dateFrom, f.dateTo);
      return historyRowsFiltered_(h.rows, f).rows;
    },
    getStoreHealthReport: async function () {
      const r = await rpc('mog_editor_status', { p_token: H.token });
      if (!r.ok) throw new Error(r.error === 'SESSION_EXPIRED' ? 'SESSION_EXPIRED' : String(r.error));
      return CE.call(H.tables, 'getStoreHealthReport', [r.data, (H.store && H.store.location) || window.MOG_STORE]).result;
    },
    runHealthFix: async function (args) {
      if (args[0] === 'place_backups') {
        const res = await callTool('commitPlaceBackupVendors', []);
        return { ok: true, message: 'Placed ' + res.placed + ' item' + (res.placed === 1 ? '' : 's') +
                                    ' on their backup vendors\' lists. Undo it from Changes if needed.' };
      }
      if (args[0] === 'clear_lockout') {
        const r = await rpc('mog_editor_clear_lockout', { p_token: H.token });
        if (!r.ok) throw new Error(String(r.error));
        return { ok: true, message: 'The PIN lockout is cleared.' };
      }
      return { ok: false, message: 'That fix is not part of the app\'s Health Check.' };
    }
  };

  const SERVER = {
    editorAuth: async function (pin) {
      const r = await rpc('mog_editor_login', { p_slug: cfg.slug, p_pin: String(pin == null ? '' : pin) });
      if (r.ok && adopt(r.data)) { H.token = r.data.token; return { ok: true, token: r.data.token }; }
      if (r.error === 'EDITOR_NOT_DIRECT') notDirect();
      return { ok: false, lockout: !!r.lockout, retryAfterMs: r.retryAfterMs };
    },
    editorPing: async function (token) {
      const r = await rpc('mog_editor_get', { p_token: String(token || '') });
      if (r.ok && adopt(r.data)) { H.token = token; return { ok: true }; }
      // Inside the app, a session that ran out is the app's to renew: it
      // signs in again with the PIN it holds, so this page never asks.
      if (SHELL) {
        const fresh = await SHELL.token(String(token || ''));
        if (fresh && fresh !== token) {
          const again = await rpc('mog_editor_get', { p_token: fresh });
          if (again.ok && adopt(again.data)) {
            H.token = fresh;
            try { localStorage.setItem('mog_edit_token', fresh); } catch (e) { /* the app hands it over again */ }
            return { ok: true };
          }
        }
      }
      return { ok: false };
    },
    webedit_call: async function (token, fn, args) {
      if (fn === 'pushCatalogNow') return { __mogEnvelope: 1, result: null };   // Supabase rebuilds it on every save
      if (SHELL && H.token) token = H.token;   // the session the app renewed, not the page's first one
      if (!H.tables || token !== H.token) {
        if (!token || !(await SERVER.editorPing(token)).ok) throw new Error('SESSION_EXPIRED');
      }
      const own = Object.prototype.hasOwnProperty.call(HOST_CALLS, fn) ? HOST_CALLS[fn] : null;
      const run = () => (own ? own(args || []) : callTool(fn, args || []));
      let result;
      try {
        result = await run();
      } catch (e) {
        // Ran out mid-session inside the app: renew through the app, once.
        if (!SHELL || !e || e.message !== 'SESSION_EXPIRED' || !(await SERVER.editorPing(H.token)).ok) throw e;
        result = await run();
      }
      return { __mogEnvelope: 1, result: result, pushCatalog: false };
    }
  };

  // google.script.run: each access starts a fresh call chain, as in Apps Script.
  function runner() {
    let ok = null, fail = null;
    const proxy = new Proxy({}, {
      get: function (_, prop) {
        if (prop === 'withSuccessHandler') return function (f) { ok = f; return proxy; };
        if (prop === 'withFailureHandler') return function (f) { fail = f; return proxy; };
        if (prop === 'withUserObject') return function () { return proxy; };
        return function () {
          const args = [].slice.call(arguments);
          Promise.resolve()
            .then(function () {
              const fn = SERVER[prop];
              if (!fn) throw new Error('"' + String(prop) + '" is not allowed.');
              return fn.apply(null, args);
            })
            .then(function (res) { if (ok) ok(res); },
                  function (err) {
                    const e = err instanceof Error ? err : new Error(String(err));
                    if (fail) fail(e); else console.error(e);
                  });
        };
      }
    });
    return proxy;
  }

  window.google = {
    script: {
      get run() { return runner(); },
      url: {
        // A token in the URL (?t=) is handed to the gate's validate-first
        // path instead of its optimistic one: the page can't start before
        // the tables are here, so it must be checked (and loaded) first.
        getLocation: function (cb) {
          const parameter = {};
          new URLSearchParams(window.location.search).forEach(function (v, k) { parameter[k] = v; });
          if (parameter.t) {
            try { localStorage.setItem('mog_edit_token', parameter.t); } catch (e) { /* the PIN still works */ }
            delete parameter.t;
          }
          setTimeout(function () { cb({ parameter: parameter, hash: window.location.hash.replace(/^#/, '') }); }, 0);
        }
      },
      host: { close: function () { if (SHELL) SHELL.open('overview'); else window.location.href = '../'; } }
    }
  };

  // ---- The Changes panel ------------------------------------------------------

  const esc = s => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  function when(at) {
    const d = new Date(at);
    if (isNaN(d)) return '';
    return d.toLocaleString(lang() === 'es' ? 'es-US' : 'en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  }

  // ---- The rail ------------------------------------------------------------

  // The app's rail down the left (docs/MOG_OneApp_Spec.md L1), here with
  // Editor lit: Today, History and Settings go back to the app's own screens
  // (../, ../#history, ../#settings), Editor goes to Editor Home. Leaving
  // with unsaved edits asks first, through the page's leave guard.
  const RAIL_BADGE = { 'roll-play': 'RP', 'teasnyou': 'TY', 'an': 'ĂN' };
  const RAIL_ITEMS = [
    { id: 'today', href: '../', en: 'Today', es: 'Hoy',
      icon: '<path d="M5 12H3l9-9 9 9h-2"/><path d="M5 12v7a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-7"/>' },
    { id: 'history', href: '../#history', en: 'History', es: 'Historial',
      icon: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 3"/>' },
    { sep: true },
    { id: 'editor', href: 'index.html', en: 'Editor', es: 'Editor', active: true,
      icon: '<path d="M4 20h4L18.5 9.5a2.83 2.83 0 0 0-4-4L4 16v4"/><path d="M13.5 6.5l4 4"/>' },
    { spacer: true },
    { id: 'settings', href: '../#settings', en: 'Settings', es: 'Ajustes',
      icon: '<circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M4.2 4.2l2.1 2.1M17.7 17.7l2.1 2.1M2 12h3M19 12h3M4.2 19.8l2.1-2.1M17.7 6.3l2.1-2.1"/>' }
  ];

  function mountRail() {
    if (SHELL) { mountEmbed(); return; }   // the app's sidebar is the rail
    if (document.getElementById('mge-rail') || !document.body) return;
    const css = document.createElement('style');
    css.textContent =
      'body.mge-has-rail{padding-left:88px}' +
      '#mge-rail{position:fixed;top:0;bottom:0;left:0;width:88px;z-index:50;box-sizing:border-box;padding:14px 0;' +
      'display:flex;flex-direction:column;align-items:center;gap:6px;background:#fff;border-right:1px solid #d0d4da;font-family:Inter,Arial,sans-serif}' +
      '#mge-rail .mge-rail-badge{width:42px;height:42px;border-radius:12px;margin-bottom:12px;display:flex;align-items:center;justify-content:center;' +
      'background:var(--web-accent,#2d8c6b);color:var(--web-accent-text,#fff);font:800 14px Inter,Arial,sans-serif}' +
      '#mge-rail a{width:72px;padding:10px 0 8px;border-radius:12px;display:flex;flex-direction:column;align-items:center;gap:5px;' +
      'color:#555;font-size:11px;font-weight:600;text-decoration:none}' +
      '#mge-rail a:hover{background:#f4f5f7}' +
      '#mge-rail a.on{background:var(--web-accent-soft,#e6f3ee);color:var(--web-accent-dark,#216b51);font-weight:700}' +
      '#mge-rail svg{width:22px;height:22px}' +
      '#mge-rail .mge-rail-sep{width:40px;height:1px;background:#d0d4da;margin:6px 0}#mge-rail .mge-rail-spacer{flex:1}';
    document.head.appendChild(css);
    const rail = document.createElement('nav');
    rail.id = 'mge-rail';
    rail.setAttribute('aria-label', 'Main');
    const badge = document.createElement('div');
    badge.className = 'mge-rail-badge';
    badge.setAttribute('aria-hidden', 'true');
    const concept = typeof window.CONCEPT === 'string' ? window.CONCEPT : '';
    badge.textContent = RAIL_BADGE[concept] || String(window.MOG_STORE || 'Store').split(' ').map(s => s[0]).join('').slice(0, 2).toUpperCase();
    rail.appendChild(badge);
    for (const it of RAIL_ITEMS) {
      if (it.sep || it.spacer) {
        const d = document.createElement('div');
        d.className = it.sep ? 'mge-rail-sep' : 'mge-rail-spacer';
        rail.appendChild(d);
        continue;
      }
      const a = document.createElement('a');
      a.href = it.href;
      a.setAttribute('data-rail', it.id);
      if (it.active) { a.className = 'on'; a.setAttribute('aria-current', 'page'); }
      a.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
        it.icon + '</svg><span></span>';
      a.onclick = function (e) {
        if (it.active && PAGE === 'home') { e.preventDefault(); return; }
        if (typeof window.MGE_LEAVE_GUARD !== 'function') return;   // nothing unsaved to ask about
        e.preventDefault();
        window.MGE_LEAVE_GUARD(function () { window.location.href = it.href; });
      };
      rail.appendChild(a);
    }
    document.body.appendChild(rail);
    document.body.classList.add('mge-has-rail');
    // Relabel the rail and the bottom bar after the page's EN/ES switch.
    document.addEventListener('click', function (e) {
      if (e.target && e.target.closest && e.target.closest('.lang-btn')) setTimeout(renderChanges, 0);
    });
    renderRail();
  }

  // Inside the app: the app's title font, and a link to another editor page
  // (?page=<name>, Editor Home's tiles and the tools' "Open ... →") opens it
  // beside the sidebar instead of loading over the app.
  let embedMounted = false;
  function mountEmbed() {
    if (embedMounted || !document.body) return;
    embedMounted = true;
    const font = document.createElement('link');
    font.rel = 'stylesheet';
    font.href = 'https://fonts.googleapis.com/css2?family=Archivo+Black&display=swap';
    document.head.appendChild(font);
    document.addEventListener('click', function (e) {
      const a = e.target && e.target.closest ? e.target.closest('a[href]') : null;
      if (!a) return;
      let want = null;
      try { want = new URL(a.getAttribute('href'), location.href).searchParams.get('page'); } catch (err) { want = null; }
      if (!want) return;
      e.preventDefault();
      e.stopPropagation();
      SHELL.open(want === 'editor' ? 'overview' : want);
    }, true);
  }

  function renderRail() {
    for (const it of RAIL_ITEMS) {
      const a = it.id && document.querySelector('#mge-rail a[data-rail="' + it.id + '"] span');
      if (a) a.textContent = tr(it.en, it.es);
    }
  }

  // The panels, bottom left: ↶ Changes (the change log, with Undo) and
  // ⚑ Needs review (phones' "just today" edits, with Apply and Dismiss).
  function mountChanges() {
    mountRail();
    if (document.getElementById('mge-changes-btn') || !document.body) return;
    const css = document.createElement('style');
    css.textContent =
      '#mge-host-bar{position:fixed;left:104px;bottom:16px;z-index:60;display:flex;gap:8px}' +
      '#mge-host-bar button{border:1px solid #d0d4da;background:#fff;color:#333;' +
      'border-radius:999px;padding:8px 14px;font:600 13px Inter,Arial,sans-serif;box-shadow:0 2px 8px rgba(0,0,0,.12);cursor:pointer}' +
      '#mge-host-bar button:hover{background:#f4f5f7}#mge-host-bar button[hidden]{display:none}' +
      '#mge-reviews-btn{border-color:#d9a441 !important;color:#7a5200 !important}' +
      '.mge-panel{position:fixed;left:104px;bottom:62px;z-index:61;width:min(460px,calc(100vw - 32px));max-height:60vh;overflow:auto;' +
      'background:#fff;border:1px solid #d0d4da;border-radius:10px;box-shadow:0 8px 28px rgba(0,0,0,.18);font:13px Inter,Arial,sans-serif;color:#222}' +
      '.mge-panel[hidden]{display:none}' +
      '.mge-panel h3{margin:0;padding:12px 14px;font-size:14px;border-bottom:1px solid #eee;position:sticky;top:0;background:#fff}' +
      '.mge-ch{display:flex;gap:10px;align-items:flex-start;padding:10px 14px;border-bottom:1px solid #f0f0f0}' +
      '.mge-ch-main{flex:1;min-width:0}.mge-ch-label{word-wrap:break-word}.mge-ch-meta{color:#777;font-size:12px;margin-top:2px}' +
      '.mge-ch.undone .mge-ch-label{color:#999;text-decoration:line-through}' +
      '.mge-ch-btns{display:flex;gap:6px;flex-shrink:0}' +
      '.mge-ch button{border:1px solid #c9ced6;background:#fff;border-radius:6px;padding:4px 10px;font:600 12px Inter,Arial,sans-serif;cursor:pointer}' +
      '.mge-ch button:hover{background:#f4f5f7}.mge-ch-empty{padding:14px;color:#777}' +
      // Storage Areas and Shelf to Sheet have a Save footer along the bottom.
      'body.mge-host-raised #mge-host-bar{bottom:84px}body.mge-host-raised .mge-panel{bottom:130px}';
    document.head.appendChild(css);
    if (PAGE === 'areas' || PAGE === 'pickpath') document.body.classList.add('mge-host-raised');
    // Inside the app the bar goes: Changes is a page in the sidebar (spec
    // U8), ⚑ Needs review is on the Overview, and Import from MarginEdge sits
    // by Manage Items' title (and the Overview's).
    if (SHELL) css.textContent += '#mge-host-bar{display:none}' +
      '#mge-import-btn.mge-title-import{order:2;margin-left:auto;border:1px solid #d0d4da;background:#fff;color:#222;border-radius:10px;' +
      'padding:10px 16px;font:600 14px Inter,Arial,sans-serif;cursor:pointer}#mge-import-btn.mge-title-import:hover{background:#f4f5f7}';
    const bar = document.createElement('div');
    bar.id = 'mge-host-bar';
    const changesBtn = document.createElement('button');
    changesBtn.id = 'mge-changes-btn';
    changesBtn.type = 'button';
    changesBtn.onclick = function () { togglePanel('mge-changes'); };
    if (SHELL) changesBtn.hidden = true;
    const reviewsBtn = document.createElement('button');
    reviewsBtn.id = 'mge-reviews-btn';
    reviewsBtn.type = 'button';
    reviewsBtn.onclick = function () { togglePanel('mge-reviews'); };
    bar.appendChild(changesBtn);
    bar.appendChild(reviewsBtn);
    if (window.MeImport && PAGE === 'items') {
      const importBtn = document.createElement('button');
      importBtn.id = 'mge-import-btn';
      importBtn.type = 'button';
      importBtn.onclick = openImport;
      const title = SHELL && document.querySelector('.web-titlebar .web-title');
      if (title) { importBtn.className = 'mge-title-import'; title.appendChild(importBtn); }
      else bar.appendChild(importBtn);
    }
    document.body.appendChild(bar);
    for (const id of ['mge-changes', 'mge-reviews']) {
      const panel = document.createElement('div');
      panel.id = id;
      panel.className = 'mge-panel';
      panel.hidden = true;
      document.body.appendChild(panel);
    }
    renderChanges();
  }

  function togglePanel(id) {
    const other = id === 'mge-changes' ? 'mge-reviews' : 'mge-changes';
    const p = document.getElementById(id);
    p.hidden = !p.hidden;
    document.getElementById(other).hidden = true;
    renderChanges();
  }

  function renderChanges() {
    const btn = document.getElementById('mge-changes-btn');
    const panel = document.getElementById('mge-changes');
    if (!btn || !panel) return;
    btn.textContent = '↶ ' + tr('Changes', 'Cambios');
    renderRail();
    const importBtn = document.getElementById('mge-import-btn');
    if (importBtn) importBtn.textContent = '⬇ ' + tr('Import from MarginEdge', 'Importar de MarginEdge');
    renderReviews();
    // The Changes page (changes.html, spec U8): the whole log, on the page.
    const page = document.getElementById('mge-changes-page');
    if (page) fillChanges(page, false);
    if (typeof window.MOG_OVERVIEW_REFRESH === 'function') window.MOG_OVERVIEW_REFRESH();
    if (panel.hidden) return;
    fillChanges(panel, true);
  }

  // The change log, newest first, Undo on each change not yet undone.
  function fillChanges(el, withTitle) {
    let html = withTitle ? '<h3>' + esc(tr('Catalog changes', 'Cambios al catálogo')) + '</h3>' : '';
    if (!H.changes.length) html += '<div class="mge-ch-empty">' + esc(tr('No changes yet.', 'Todavía no hay cambios.')) + '</div>';
    for (const c of H.changes) {
      const undone = !!c.undoneBy;
      html += '<div class="mge-ch' + (undone ? ' undone' : '') + '"><div class="mge-ch-main">' +
        '<div class="mge-ch-label">' + esc(c.label) + '</div>' +
        '<div class="mge-ch-meta">' + esc(when(c.at)) + ' · ' + esc(c.by || tr('Someone', 'Alguien')) +
        (undone ? ' · ' + esc(tr('undone', 'deshecho')) : '') + '</div></div>' +
        (undone ? '' : '<button type="button" data-undo="' + esc(c.id) + '">' + esc(tr('Undo', 'Deshacer')) + '</button>') +
        '</div>';
    }
    el.innerHTML = html;
    el.querySelectorAll('button[data-undo]').forEach(function (b) {
      b.onclick = function () { askUndo(Number(b.getAttribute('data-undo'))); };
    });
  }

  // ---- Import from MarginEdge (meImport.js) -------------------------------------

  // The import saves through callTool like any edit (logged, undoable), then
  // the page reloads to show the new items, as after an Undo. Unsaved edits
  // on the page come first.
  function openImport() {
    const go = function () {
      window.MeImport.open({
        tables: function () { return H.tables; },
        call: callTool,
        tr: tr,
        done: function (res) {
          const n = res.itemsAdded, v = res.vendorsAdded.length, skip = res.skipped.length;
          const en = [n ? 'Imported ' + n + ' item' + (n === 1 ? '' : 's') + '. They are under Unassigned: give each a storage area and a par.' : '',
                      v ? 'Added ' + v + ' vendor' + (v === 1 ? '' : 's') + '. Set their delivery days in Manage Vendors; until then they order nothing.' : '',
                      skip ? skip + ' item' + (skip === 1 ? ' was' : 's were') + ' already in the catalog.' : ''].filter(Boolean).join(' ');
          const es = [n ? 'Se importaron ' + n + ' artículo' + (n === 1 ? '' : 's') + '. Están en el filtro Sin Área: dale a cada uno un área y un par.' : '',
                      v ? 'Se agregaron ' + v + ' proveedor' + (v === 1 ? '' : 'es') + '. Ponles días de entrega en Proveedores; hasta entonces no piden nada.' : '',
                      skip ? skip + ' ya estaba' + (skip === 1 ? '' : 'n') + ' en el catálogo.' : ''].filter(Boolean).join(' ');
          const reload = function () { window.location.reload(); };
          if (typeof window.mgeConfirm_ === 'function') {
            window.mgeConfirm_({ title: { en: 'Imported', es: 'Importado' }, msg: { en: en, es: es },
                                 confirmLabel: { en: 'OK', es: 'OK' }, onConfirm: reload });
          } else {
            window.alert(tr(en, es));
            reload();
          }
        }
      });
    };
    if (typeof window.MGE_LEAVE_GUARD === 'function') window.MGE_LEAVE_GUARD(go);
    else go();
  }

  // ---- Needs review: phones' "just today" edits (schema v7) ---------------------

  const num = v => (v === null || v === undefined ? '—' : String(Math.round(Number(v) * 1000) / 1000));
  const itemName = id => { const it = (H.tables ? H.tables.items : []).find(x => x.id === id); return it ? it.name : id; };
  const dayOf = d => {
    const x = new Date(String(d) + 'T12:00:00');
    return isNaN(x) ? String(d) : x.toLocaleDateString(lang() === 'es' ? 'es-US' : 'en-US', { month: 'short', day: 'numeric' });
  };
  function reviewLabel(r) {
    if (r.kind === 'par_today') {
      return tr('Par for one day', 'Par por un día') + ' (' + dayOf(r.cycleDate) + '): "' + itemName(r.itemId) + '" ' +
        num(r.parBefore) + ' → ' + num(r.parAfter);
    }
    return tr('Added to', 'Agregado a') + ' ' + r.vendor + ' ' + tr('for', 'para') + ' ' + dayOf(r.cycleDate) + ': "' +
      itemName(r.itemId) + '". ' + tr('Add it for good?', '¿Agregarlo para siempre?');
  }

  function renderReviews() {
    const btn = document.getElementById('mge-reviews-btn');
    const panel = document.getElementById('mge-reviews');
    if (!btn || !panel) return;
    const n = (H.reviews || []).length;
    btn.hidden = n === 0;
    btn.textContent = '⚑ ' + tr('Needs review', 'Por revisar') + ' (' + n + ')';
    if (!n) panel.hidden = true;
    if (panel.hidden) return;
    let html = '<h3>' + esc(tr("Phones' changes for one day", 'Cambios de un día desde teléfonos')) + '</h3>';
    for (const r of H.reviews) {
      html += '<div class="mge-ch"><div class="mge-ch-main">' +
        '<div class="mge-ch-label">' + esc(reviewLabel(r)) + '</div>' +
        '<div class="mge-ch-meta">' + esc(when(r.at)) + ' · ' + esc(r.by || tr('Someone', 'Alguien')) + '</div></div>' +
        '<div class="mge-ch-btns">' +
          '<button type="button" data-apply="' + esc(r.id) + '">' + esc(tr('Apply', 'Aplicar')) + '</button>' +
          '<button type="button" data-dismiss="' + esc(r.id) + '">' + esc(tr('Dismiss', 'Descartar')) + '</button>' +
        '</div></div>';
    }
    panel.innerHTML = html;
    panel.querySelectorAll('button[data-apply]').forEach(function (b) {
      b.onclick = function () { askReview(Number(b.getAttribute('data-apply')), 'applied'); };
    });
    panel.querySelectorAll('button[data-dismiss]').forEach(function (b) {
      b.onclick = function () { askReview(Number(b.getAttribute('data-dismiss')), 'dismissed'); };
    });
  }

  // Apply makes a one-day edit permanent, as a normal logged change (so it
  // can be undone): the par becomes the item's par; an added item goes on
  // that vendor's list for good (the Assign tab's own rule: eligible, and on
  // the list in its storage area). Dismiss only clears the flag.
  function reviewOps(r) {
    if (r.kind === 'par_today') {
      const row = H.tables.items.find(x => x.id === r.itemId);
      if (!row) throw new Error(tr('That item no longer exists.', 'Ese artículo ya no existe.'));
      if (JSON.stringify(row.par) === JSON.stringify(r.parAfter)) return { ops: [], label: '' };
      const after = Object.assign({}, row, { par: r.parAfter });
      return { ops: [{ t: 'items', key: row.id, before: row, after: after }],
               label: 'Applied a phone change: par of "' + row.name + '" ' + num(row.par) + ' → ' + num(r.parAfter) };
    }
    const onList = H.tables.pickRows.filter(p => p.vendor === r.vendor).map(p => p.id);
    if (onList.indexOf(r.itemId) >= 0) return { ops: [], label: '' };
    const out = CE.call(H.tables, 'commitSetVendorItems', [r.vendor, onList.concat([r.itemId])]);
    return { ops: out.ops, label: 'Applied a phone change: added "' + itemName(r.itemId) + '" to ' + r.vendor };
  }

  function askReview(id, status) {
    const r = (H.reviews || []).find(x => x.id === id);
    if (!r) return;
    const go = function () { doReview(r, status); };
    if (status === 'dismissed') { go(); return; }
    const confirmIt = function () {
      if (typeof window.mgeConfirm_ === 'function') {
        window.mgeConfirm_({ title: { en: 'Make this permanent?', es: '¿Hacerlo permanente?' },
                             msg: { en: reviewLabel(r), es: reviewLabel(r) },
                             confirmLabel: { en: 'Apply', es: 'Aplicar' }, onConfirm: go });
      } else if (window.confirm(tr('Make this permanent?', '¿Hacerlo permanente?') + '\n\n' + reviewLabel(r))) {
        go();
      }
    };
    if (typeof window.MGE_LEAVE_GUARD === 'function') window.MGE_LEAVE_GUARD(confirmIt);
    else confirmIt();
  }

  async function doReview(r, status) {
    try {
      if (status === 'applied') {
        const plan = reviewOps(r);
        if (plan.ops.length) {
          const a = await rpc('mog_editor_apply', { p_token: H.token, p_label: plan.label, p_by: whoName(), p_ops: plan.ops });
          if (!a.ok) {
            if (a.error === 'SESSION_EXPIRED' && typeof window.mgeReshowGate_ === 'function') { window.mgeReshowGate_(); return; }
            throw new Error(a.error === 'CONFLICT'
              ? tr('That item changed just now. Reload the page and try again.', 'Ese artículo cambió hace un momento. Recarga la página e inténtalo de nuevo.')
              : (a.error || 'Save failed'));
          }
        }
      }
      const m = await rpc('mog_editor_review', { p_token: H.token, p_id: r.id, p_status: status });
      if (!m.ok && m.error !== 'Not waiting for review') throw new Error(m.error || 'Save failed');
    } catch (e) {
      say(e.message, e.message);
      return;
    }
    if (status === 'applied') { window.location.reload(); return; }
    H.reviews = H.reviews.filter(x => x.id !== r.id);
    renderReviews();
    if (typeof window.MOG_OVERVIEW_REFRESH === 'function') window.MOG_OVERVIEW_REFRESH();
  }

  function say(en, es) {
    if (typeof window.mgeConfirm_ === 'function') {
      window.mgeConfirm_({ title: { en: 'Undo', es: 'Deshacer' }, msg: { en: en, es: es }, confirmLabel: { en: 'OK', es: 'OK' } });
    } else {
      window.alert(tr(en, es));
    }
  }

  function askUndo(id) {
    const c = H.changes.find(x => x.id === id);
    if (!c) return;
    const go = function () { doUndo(c); };
    const confirmIt = function () {
      if (typeof window.mgeConfirm_ === 'function') {
        window.mgeConfirm_({ title: { en: 'Undo this change?', es: '¿Deshacer este cambio?' },
                             msg: { en: c.label, es: c.label }, danger: true,
                             confirmLabel: { en: 'Undo', es: 'Deshacer' }, onConfirm: go });
      } else if (window.confirm(tr('Undo this change?', '¿Deshacer este cambio?') + '\n\n' + c.label)) {
        go();
      }
    };
    // Unsaved edits on the page come first (the page reloads after an undo).
    if (typeof window.MGE_LEAVE_GUARD === 'function') window.MGE_LEAVE_GUARD(confirmIt);
    else confirmIt();
  }

  async function doUndo(c) {
    let r;
    try {
      r = await rpc('mog_editor_undo', { p_token: H.token, p_change_id: c.id, p_by: whoName() });
    } catch (e) {
      say(e.message, e.message);
      return;
    }
    if (r.ok) { window.location.reload(); return; }
    if (r.error === 'CONFLICT') {
      const later = r.laterChange;
      say('Something this change touched has changed since' + (later ? ': "' + later.label + '". Undo that first.' : '.'),
          'Algo que tocó este cambio cambió después' + (later ? ': "' + later.label + '". Deshaz eso primero.' : '.'));
      return;
    }
    if (r.error === 'ALREADY_UNDONE') { window.location.reload(); return; }
    if (r.error === 'SESSION_EXPIRED' && typeof window.mgeReshowGate_ === 'function') { window.mgeReshowGate_(); return; }
    say(r.error || 'Undo failed', r.error || 'No se pudo deshacer');
  }

  // What the Overview page (Overview.html, spec U4) reads and does: the same
  // tables, change log and phone edits this page signed in with, and the
  // same Undo / Apply / Dismiss / Import as the panels.
  const overview = {
    counts: () => CE.call(H.tables, 'getOverviewCounts', [H.changes]).result,
    changes: () => H.changes.slice(),
    reviews: () => (H.reviews || []).slice(),
    reviewLabel: reviewLabel,
    when: when,
    undo: askUndo,
    review: askReview,
    importItems: () => (window.MeImport ? openImport() : null),
    parFlags: parFlags,
    health: () => HOST_CALLS.getStoreHealthReport([]),
    today: () => (SHELL && typeof SHELL.today === 'function' ? SHELL.today() : null),
    goToday: () => { if (SHELL && typeof SHELL.go === 'function') SHELL.go('today'); },
    store: () => H.store
  };

  // For tests (and the Overview).
  window.__MOG_EDITOR_HOST__ = { state: H, server: SERVER, timings: timings, reviewOps: reviewOps, doReview: doReview, overview: overview };
})();
