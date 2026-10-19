// MOG editor host: an Apps Script editor page (ManageItems.html, unchanged)
// running as a static page on Supabase (docs/MOG_OneApp_Spec.md Phase 2).
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
// needs window.MOG_SUPABASE = { url, key, slug } and window.CatalogEdit.
//
// It also adds the Changes panel (the store's change log, with Undo), the
// Needs review panel, and the Import from MarginEdge button (meImport.js).
(function () {
  'use strict';

  const cfg = window.MOG_SUPABASE || {};
  const CE = window.CatalogEdit;
  const H = { token: null, tables: null, changes: [], version: null, store: null };
  const TIMEOUT_MS = 15000;

  const lang = () => { try { return localStorage.getItem('mog_edit_lang') === 'es' ? 'es' : 'en'; } catch (e) { return 'en'; } };
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
    // Manage Items keeps its own item cache between opens; the tables here
    // are always fresh, so mark that cache stale (its own invalidation key).
    try { localStorage.setItem('mog_lastMutationTs', String(Date.now())); } catch (e) { /* no cache, no problem */ }
    mountChanges();
    return true;
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
      return { ok: false };
    },
    webedit_call: async function (token, fn, args) {
      if (fn === 'pushCatalogNow') return { __mogEnvelope: 1, result: null };   // Supabase rebuilds it on every save
      if (!H.tables || token !== H.token) {
        if (!token || !(await SERVER.editorPing(token)).ok) throw new Error('SESSION_EXPIRED');
      }
      return { __mogEnvelope: 1, result: await callTool(fn, args || []), pushCatalog: false };
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
      host: { close: function () { window.location.href = '../'; } }
    }
  };

  // ---- The Changes panel ------------------------------------------------------

  const esc = s => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  function when(at) {
    const d = new Date(at);
    if (isNaN(d)) return '';
    return d.toLocaleString(lang() === 'es' ? 'es-US' : 'en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  }

  // The two panels, bottom left: ↶ Changes (the change log, with Undo) and
  // ⚑ Needs review (phones' "just today" edits, with Apply and Dismiss).
  function mountChanges() {
    if (document.getElementById('mge-changes-btn') || !document.body) return;
    const css = document.createElement('style');
    css.textContent =
      '#mge-host-bar{position:fixed;left:16px;bottom:16px;z-index:60;display:flex;gap:8px}' +
      '#mge-host-bar button{border:1px solid #d0d4da;background:#fff;color:#333;' +
      'border-radius:999px;padding:8px 14px;font:600 13px Inter,Arial,sans-serif;box-shadow:0 2px 8px rgba(0,0,0,.12);cursor:pointer}' +
      '#mge-host-bar button:hover{background:#f4f5f7}#mge-host-bar button[hidden]{display:none}' +
      '#mge-reviews-btn{border-color:#d9a441 !important;color:#7a5200 !important}' +
      '.mge-panel{position:fixed;left:16px;bottom:62px;z-index:61;width:min(460px,calc(100vw - 32px));max-height:60vh;overflow:auto;' +
      'background:#fff;border:1px solid #d0d4da;border-radius:10px;box-shadow:0 8px 28px rgba(0,0,0,.18);font:13px Inter,Arial,sans-serif;color:#222}' +
      '.mge-panel[hidden]{display:none}' +
      '.mge-panel h3{margin:0;padding:12px 14px;font-size:14px;border-bottom:1px solid #eee;position:sticky;top:0;background:#fff}' +
      '.mge-ch{display:flex;gap:10px;align-items:flex-start;padding:10px 14px;border-bottom:1px solid #f0f0f0}' +
      '.mge-ch-main{flex:1;min-width:0}.mge-ch-label{word-wrap:break-word}.mge-ch-meta{color:#777;font-size:12px;margin-top:2px}' +
      '.mge-ch.undone .mge-ch-label{color:#999;text-decoration:line-through}' +
      '.mge-ch-btns{display:flex;gap:6px;flex-shrink:0}' +
      '.mge-ch button{border:1px solid #c9ced6;background:#fff;border-radius:6px;padding:4px 10px;font:600 12px Inter,Arial,sans-serif;cursor:pointer}' +
      '.mge-ch button:hover{background:#f4f5f7}.mge-ch-empty{padding:14px;color:#777}';
    document.head.appendChild(css);
    const bar = document.createElement('div');
    bar.id = 'mge-host-bar';
    const changesBtn = document.createElement('button');
    changesBtn.id = 'mge-changes-btn';
    changesBtn.type = 'button';
    changesBtn.onclick = function () { togglePanel('mge-changes'); };
    const reviewsBtn = document.createElement('button');
    reviewsBtn.id = 'mge-reviews-btn';
    reviewsBtn.type = 'button';
    reviewsBtn.onclick = function () { togglePanel('mge-reviews'); };
    bar.appendChild(changesBtn);
    bar.appendChild(reviewsBtn);
    if (window.MeImport) {
      const importBtn = document.createElement('button');
      importBtn.id = 'mge-import-btn';
      importBtn.type = 'button';
      importBtn.onclick = openImport;
      bar.appendChild(importBtn);
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
    const importBtn = document.getElementById('mge-import-btn');
    if (importBtn) importBtn.textContent = '⬇ ' + tr('Import from MarginEdge', 'Importar de MarginEdge');
    renderReviews();
    if (panel.hidden) return;
    let html = '<h3>' + esc(tr('Catalog changes', 'Cambios al catálogo')) + '</h3>';
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
    panel.innerHTML = html;
    panel.querySelectorAll('button[data-undo]').forEach(function (b) {
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
          const en = 'Imported ' + n + ' item' + (n === 1 ? '' : 's') + (v ? ' and ' + v + ' new vendor' + (v === 1 ? '' : 's') : '') + '.' +
            (skip ? ' ' + skip + ' were already in the catalog.' : '') +
            ' They are under Unassigned: give each a storage area and a par.' +
            (v ? ' The new vendors have no delivery days yet.' : '');
          const es = 'Se importaron ' + n + ' artículo' + (n === 1 ? '' : 's') + (v ? ' y ' + v + ' proveedor' + (v === 1 ? '' : 'es') + ' nuevo' + (v === 1 ? '' : 's') : '') + '.' +
            (skip ? ' ' + skip + ' ya estaban en el catálogo.' : '') +
            ' Están en el filtro Sin Área: dale a cada uno un área y un par.' +
            (v ? ' Los proveedores nuevos todavía no tienen días de entrega.' : '');
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

  // For tests.
  window.__MOG_EDITOR_HOST__ = { state: H, server: SERVER, timings: timings, reviewOps: reviewOps, doReview: doReview };
})();
