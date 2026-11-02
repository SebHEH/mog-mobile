// HQ's LTOs page (schema v14, docs/MOG_LTO_Spec.md): every LTO HQ sent to a
// concept's stores, where it stands at each one, and what HQ can do with it
// while it runs: send it to more stores, make it standard (its items go into
// the concept library), end it (its items made inactive) or roll it back
// (its items deleted, as if never sent). Approved mockup: the "MOG HQ
// redesign" canvas, board "HQ · LTOs".
//
// Each store's change is worked out by catalogEdit.js (commitHqLto,
// commitHqRollout for more stores) and saved with the page's own save: every
// store or none, the LTO's record in the same transaction (mog_hq_apply's
// fifth argument), one change per store that the store can undo. Where an
// LTO stands at a store is read from that store's own rows
// (CatalogEdit.ltoStoreState), so a KM's setup or Undo shows here at once.
//
// index.html hands create() the helpers it shares (the store picker's
// vendor rows, rolloutPlan, save...), as warehouse.js gets rpc.
(function (root) {
  'use strict';

  const STATUS = { running: ['Running', 'ok'], ended: ['Ended', ''], rolledback: ['Rolled back', ''], standard: ['Made standard', 'blue'] };

  function create(hq) {
    const { CE, $, esc, plural, lc } = hq;
    // A list in a sentence: "A, B and C" (six names at most, then "and N more").
    const few = names => (names.length > 6 ? names.slice(0, 5).join(', ') + ' and ' + (names.length - 5) + ' more'
      : names.length > 1 ? names.slice(0, -1).join(', ') + ' and ' + names[names.length - 1] : names.join(''));
    const L = { sel: null, filter: 'running', confirm: null, more: {}, concept: null };

    const all = () => (Array.isArray(hq.S.data.ltos) ? hq.S.data.ltos : []);
    const ofConcept = () => all().filter(l => l.concept === L.concept);
    const byId = id => all().find(l => l.id === id) || null;
    const who = by => String(by || '').replace(/^HQ · /, '');
    const when = iso => { const d = new Date(iso); return isNaN(d) ? '' : d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }); };
    const whenLong = iso => { const d = new Date(iso); return isNaN(d) ? '' : d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }); };
    const isTest = rec => rec.stores.length > 0 && rec.stores.every(x => { const st = hq.storeBy(x.slug); return st && st.isTest; });
    const itemNames = rec => rec.items.map(it => it.name);

    // A fresh id, made here so the items can carry it in the same save.
    function newId() {
      const c = root.crypto;
      const r = c && c.randomUUID ? c.randomUUID().replace(/-/g, '') : Date.now().toString(36) + Math.random().toString(36).slice(2, 14);
      return 'lto_' + r.toLowerCase();
    }

    // Where the LTO stands at one store, from that store's rows.
    function storeRow(rec, x) {
      const st = hq.storeBy(x.slug);
      const row = (tag, cls, detail) => ({ st, slug: x.slug, name: st ? hq.shortName(st) : x.slug, tag, cls, detail });
      if (!st) return row('Gone', '', 'This store is no longer on MOG.');
      if (!hq.usable(st)) return row('Not reachable', '', 'Its editor isn\'t on the app, so HQ can\'t read it.');
      if (rec.status === 'standard') return row('Standard', 'blue', 'Now the store\'s own items.');
      const s = CE.ltoStoreState(st.tables, rec.id);
      if (!s.items.length) {
        return rec.status === 'rolledback' ? row('Removed', '', 'Rolled back by ' + who(rec.statusBy) + '. The store can undo it in its own Changes.')
          : row('Removed', '', x.changeId ? 'Deleted at the store.' : 'It already had these items, so nothing was added.');
      }
      if (rec.status === 'ended' && s.inactive < s.items.length) return row('Active again', 'warn', 'The store undid the end in its own Changes.');
      if (s.setup) {
        const need = s.items.filter(i => i.state === 'setup').map(i => i.name + ' (' + [i.par === '' ? 'no par' : '', i.area ? '' : 'no storage area'].filter(Boolean).join(', ') + ')');
        return row('Needs setup', 'warn', few(need) + '. Shown at the top of the store\'s Items page.');
      }
      if (s.inactive === s.items.length) return row('Inactive', '', 'Off the count list. Par, storage area and order history kept.');
      const one = s.items.length === 1 && s.items[0];
      return row('Set up', 'ok', one && one.state === 'ready' ? 'Par ' + one.par + ', ' + one.area : plural(s.ready, 'item') + ' set up' + (s.inactive ? ', ' + s.inactive + ' inactive' : ''));
    }
    function progress(rec) {
      if (rec.status !== 'running') return STATUS[rec.status][0] + ' at ' + plural(rec.stores.length, 'store');
      const ready = rec.stores.map(x => storeRow(rec, x)).filter(r => r.tag === 'Set up').length;
      return ready + ' of ' + plural(rec.stores.length, 'store') + ' set up';
    }

    // ---- What each action does at each store ----
    function planFor(rec, action) {
      return rec.stores.map(x => {
        const st = hq.storeBy(x.slug);
        if (!st || !hq.usable(st)) return { st: st || { slug: x.slug, location: x.slug }, error: 'not reachable' };
        try {
          return { st, out: CE.call(st.tables, 'commitHqLto', [{ action, lto: rec.id, name: rec.name,
            vendorsAdded: x.vendorsAdded, backupsAdded: x.backupsAdded }]) };
        } catch (err) { return { st, error: err.message }; }
      });
    }
    // Make it standard: its items into the library of each side it reached.
    function standardLibraries(rec) {
      const sides = [];
      for (const x of rec.stores) { const st = hq.storeBy(x.slug); if (st && !st.isTest && st.side && sides.indexOf(st.side) < 0) sides.push(st.side); }
      return sides.map(side => {
        const key = hq.libKey(rec.concept, side), lib = hq.libraryOf(key);
        try {
          const r = CE.libraryAdd(lib.items, rec.items);
          return { key, r, payload: r.added.length ? { concept: lib.concept, side: lib.side, version: lib.version, items: r.items,
            label: 'LTO "' + rec.name + '" made standard: added ' + plural(r.added.length, 'item') } : null };
        } catch (err) { return { key, error: err.message }; }
      });
    }
    function moreStores(rec) {
      const sent = new Set(rec.stores.map(x => x.slug));
      return hq.storesOf(rec.concept).filter(st => hq.usable(st) && !sent.has(st.slug));
    }

    function confirmHtml(rec) {
      const names = itemNames(rec), stores = rec.stores.map(x => hq.storeBy(x.slug)).filter(Boolean).map(hq.shortName);
      const everyOrNone = 'Every store or none. Each store sees one change by HQ · ' + hq.S.name + ' that it can undo in its own Changes.';
      let title = '', lines = [], warn = '', extra = '', foot = '', cta = '', danger = false, ok = true;
      if (L.confirm === 'end') {
        const plan = planFor(rec, 'end');
        L.plan = plan; L.libs = null;
        title = 'End ' + rec.name + '?';
        lines = [few(names) + (names.length === 1 ? ' becomes' : ' become') + ' inactive at ' + few(stores) + ': off the count list, with the par, storage area and order history kept.',
                 'If it comes back, each store makes it active again from Items, Inactive, already set up.'];
        foot = everyOrNone; cta = 'End it at ' + plural(stores.length, 'store');
        ok = !plan.some(p => p.error);
      } else if (L.confirm === 'rollback') {
        const plan = planFor(rec, 'rollback');
        L.plan = plan; L.libs = null;
        const vendors = [];
        for (const x of rec.stores) for (const v of (x.vendorsAdded || [])) if (!vendors.some(w => lc(w) === lc(v))) vendors.push(v);
        const setUp = rec.stores.filter(x => { const st = hq.storeBy(x.slug); return st && hq.usable(st) &&
          CE.ltoStoreState(st.tables, rec.id).items.some(i => i.par !== '' || i.area); }).map(x => hq.shortName(hq.storeBy(x.slug)));
        title = 'Roll back ' + rec.name + ' at ' + plural(stores.length, 'store') + '?';
        lines = [few(names) + (names.length === 1 ? ' is' : ' are') + ' deleted at ' + few(stores) + ', as if never sent.',
                 vendors.length ? 'Vendors it added (' + few(vendors) + ') go too, where no other item uses them.' : 'This LTO added no vendors.'];
        if (rec.stores.some(x => (x.backupsAdded || []).length)) lines.push('Backup vendors it gave items a store already had come off again.');
        if (setUp.length) warn = few(setUp) + (setUp.length === 1 ? ' already set it up' : ' already set them up') + ' (a par or a storage area). Rolling back deletes that too; the store gets it back with Undo in its own Changes.';
        foot = everyOrNone; cta = 'Roll back at ' + plural(stores.length, 'store'); danger = true;
        ok = !plan.some(p => p.error);
      } else if (L.confirm === 'standard') {
        const plan = planFor(rec, 'standard'), libs = standardLibraries(rec);
        L.plan = plan; L.libs = libs.filter(x => x.payload).map(x => x.payload);
        title = 'Make ' + rec.name + ' standard?';
        if (!libs.length) lines = ['The TEST store has no library: its items just stop being LTO items.'];
        else {
          lines = [few(names) + ' go' + (names.length === 1 ? 'es' : '') + ' into the ' + few(libs.map(x => hq.libName(x.key))) + (libs.length === 1 ? ' library.' : ' libraries.'),
                   names.length === 1 ? 'At each store it stops being an LTO item: its chip goes, and ending this LTO can no longer touch it.'
                     : 'At each store they stop being LTO items: their chips go, and ending this LTO can no longer touch them.'];
          const kept = [].concat.apply([], libs.map(x => (x.r ? x.r.kept : [])));
          if (kept.length) lines.push('Already in the library, kept as it is there: ' + few(kept) + '.');
        }
        const bad = libs.find(x => x.error);
        if (bad) warn = hq.libName(bad.key) + ': ' + bad.error;
        foot = 'The LTO stays in this list as Made standard.'; cta = 'Make it standard';
        ok = !plan.some(p => p.error) && !bad;
      } else if (L.confirm === 'more') {
        const can = moreStores(rec), picked = can.filter(st => L.more[st.slug]);
        title = 'Send ' + rec.name + ' to more stores';
        lines = [can.length ? 'Pick the stores to add. Each gets the items with no par and no storage area, at the top of its Items page.' : 'Every ' + hq.conceptName(rec.concept) + ' store has it already.'];
        extra = can.length ? '<div class="tiles" style="margin-top:4px">' + can.map(st => '<button type="button" class="tile" data-lto-more="' + esc(st.slug) + '" aria-pressed="' + !!L.more[st.slug] + '">' +
            '<span class="box">' + hq.TICK + '</span><span class="tile-text"><span class="tile-name">' + esc(hq.shortName(st)) + '</span>' +
            '<span class="tile-meta">' + esc(st.isTest ? 'TEST' : st.side || '') + '</span></span></button>').join('') + '</div>' : '';
        if (picked.length) {
          const plan = hq.rolloutPlan(rec.items, rec.name, picked, rec.id);
          L.plan = plan; L.libs = null;
          extra += '<h3 class="lt-h3">Vendor at each store</h3>' + hq.vendorRowsHtml(rec.items, picked) +
                   '<h3 class="lt-h3">What each store gets</h3>' + hq.previewHtml(plan, '');
          ok = !!plan && !plan.some(p => p.error);
        } else { L.plan = null; ok = false; }
        foot = can.length ? 'Every store or none.' : ''; cta = picked.length ? 'Send to ' + plural(picked.length, 'store') : 'Pick stores first';
      }
      return '<div class="confirm" role="region" aria-label="' + esc(title) + '"><div class="confirm-title">' + esc(title) + '</div>' +
        lines.map(t => '<p>' + esc(t) + '</p>').join('') + (warn ? '<p class="warnbox">' + esc(warn) + '</p>' : '') + extra +
        (foot ? '<p class="help" style="margin:0">' + esc(foot) + '</p>' : '') +
        '<div class="actions"><button type="button" class="btn ' + (danger ? 'danger' : 'primary') + '" data-lto-go' + (ok && !hq.S.busy ? '' : ' disabled') + '>' + esc(cta) + '</button>' +
        '<button type="button" class="btn" data-lto-cancel>Cancel</button></div></div>';
    }

    // ---- The page ----
    function render() {
      if (!L.concept) L.concept = hq.S.concept.rollout || hq.conceptKeys()[0];
      const known = Array.isArray(hq.S.data.ltos);
      $('lt-concept').innerHTML = '<span class="mark">' + hq.markHtml(L.concept) + '</span><label class="select"><span class="sr">Concept</span><select data-lto-concept>' +
        hq.conceptKeys().map(k => { const n = all().filter(l => l.concept === k).length;
          return '<option value="' + esc(k) + '"' + (k === L.concept ? ' selected' : '') + '>' + esc(hq.conceptName(k)) + (n ? ' · ' + plural(n, 'LTO') : '') + '</option>'; }).join('') +
        '</select>' + hq.CHEV + '</label>';
      if (!known) {
        $('lt-filters').innerHTML = '';
        $('lt-cols').innerHTML = '<p class="empty">The LTO list needs schema v14 in Supabase.</p>';
        return;
      }
      const list = ofConcept(), running = list.filter(l => l.status === 'running');
      const shown = list.filter(l => L.filter === 'all' || (L.filter === 'running') === (l.status === 'running'));
      $('lt-filters').innerHTML = [['running', 'Running · ' + running.length], ['finished', 'Finished · ' + (list.length - running.length)], ['all', 'All · ' + list.length]]
        .map(f => '<button type="button" class="pill" data-lto-filter="' + f[0] + '" aria-pressed="' + (L.filter === f[0]) + '">' + esc(f[1]) + '</button>').join('');
      if (!shown.some(l => l.id === L.sel)) { L.sel = shown.length ? shown[0].id : null; L.confirm = null; }
      const rec = byId(L.sel);
      const listHtml = shown.map(l => { const st = STATUS[l.status] || ['', ''];
        return '<button type="button" class="lrow" role="listitem" data-lto-sel="' + esc(l.id) + '" aria-current="' + (l.id === L.sel) + '">' +
          '<span class="t"><span class="n">' + esc(l.name) + (isTest(l) ? ' <span class="tag">TEST</span>' : '') + '</span>' +
          '<span class="s"><span class="tag ' + st[1] + '">' + esc(st[0]) + '</span> ' + esc(when(l.createdAt) + ' · ' + plural(l.items.length, 'item') + ' · ' + plural(l.stores.length, 'store')) + '</span>' +
          '<span class="s">' + esc(progress(l)) + '</span></span></button>'; }).join('') ||
        '<p class="empty" style="margin:16px 18px">' + (list.length ? 'None here.' : 'No ' + esc(hq.conceptName(L.concept)) + ' LTO yet. Send one from New LTO.') + '</p>';
      $('lt-cols').innerHTML = '<div class="card list-card lt-list"><div role="list">' + listHtml + '</div></div>' +
        '<section class="card lt-detail" aria-labelledby="lt-name">' + (rec ? detailHtml(rec) : '<p class="muted" style="margin:0">Pick an LTO.</p>') + '</section>';
    }
    function detailHtml(rec) {
      const st = STATUS[rec.status] || ['', ''];
      const rows = rec.stores.map(x => storeRow(rec, x));
      const vendors = [];
      for (const x of rec.stores) for (const v of (x.vendorsAdded || [])) if (!vendors.some(w => lc(w) === lc(v))) vendors.push(v);
      const status = rec.status !== 'running'
        ? '<p class="muted" style="margin:0">' + esc(st[0] + ' ' + whenLong(rec.statusAt) + ' by ' + who(rec.statusBy) + '. Each store can undo it in its own Changes.') + '</p>'
        : '<div class="actions" role="group" aria-label="What to do with this LTO">' +
          '<button type="button" class="btn" data-lto-act="more">Send to more stores</button>' +
          '<button type="button" class="btn" data-lto-act="standard">Make it standard</button>' +
          '<button type="button" class="btn" data-lto-act="end">End this LTO</button>' +
          '<button type="button" class="btn danger-line" data-lto-act="rollback">Roll back</button></div>';
      return '<div><div class="actions" style="align-items:center"><h2 id="lt-name">' + esc(rec.name) + '</h2><span class="tag ' + st[1] + '">' + esc(st[0]) + '</span>' +
          (isTest(rec) ? '<span class="tag">TEST store only</span>' : '') + '</div>' +
        '<p class="help">Sent ' + esc(whenLong(rec.createdAt)) + ' by ' + esc(who(rec.createdBy)) + '.</p></div>' +
        status + (L.confirm && rec.status === 'running' ? confirmHtml(rec) : '') +
        '<div><h3 class="lt-h3">Items</h3><div class="scroll"><table><thead><tr><th>Item</th><th>Pack</th><th>Main vendor</th><th>Backups</th></tr></thead><tbody>' +
        rec.items.map(it => '<tr><td><b>' + esc(it.name) + '</b></td><td>' + esc(it.pack) + '</td><td>' + esc(it.vendor) + '</td><td class="muted">' + esc((it.backups || []).join(', ') || 'None') + '</td></tr>').join('') +
        '</tbody></table></div>' + (vendors.length ? '<p class="help">Vendors this LTO added: ' + esc(few(vendors)) + '. A roll back takes each one off again where no other item uses it.</p>' : '') + '</div>' +
        '<div><h3 class="lt-h3">At each store</h3><div class="lt-stores">' + rows.map(r => '<div class="prow"><b>' + esc(r.name) +
          (r.st && r.st.isTest ? ' <span class="tag">TEST</span>' : '') + '</b><span><span class="tag ' + r.cls + '">' + esc(r.tag) + '</span> ' + esc(r.detail) + '</span></div>').join('') + '</div></div>';
    }

    // ---- Saving an action ----
    async function go() {
      const rec = byId(L.sel);
      if (!rec || !L.confirm || hq.S.busy) return;
      const action = L.confirm, lto = { action, id: rec.id, version: rec.version };
      if (action === 'more') {
        if (!L.plan) return;
        lto.stores = L.plan.map(p => ({ slug: p.st.slug, vendorsAdded: p.out.result.vendorsAdded, backupsAdded: p.out.result.backupsAdded }));
      }
      // Saved: keep showing it, though it no longer runs.
      const done = await hq.save(L.plan, 'lt-status', () => { L.confirm = null; L.more = {}; hq.S.map = {}; if (action !== 'more') L.filter = 'all'; }, L.libs, lto);
      if (done) render();
    }

    function click(t) {
      const sel = t.getAttribute('data-lto-sel');
      if (sel) { L.sel = sel; L.confirm = null; L.more = {}; status(''); render(); return true; }
      const f = t.getAttribute('data-lto-filter');
      if (f) { L.filter = f; render(); return true; }
      const act = t.getAttribute('data-lto-act');
      if (act) { L.confirm = act; L.more = {}; status(''); render(); return true; }
      const more = t.getAttribute('data-lto-more');
      if (more) { L.more[more] = !L.more[more]; render(); return true; }
      if (t.hasAttribute('data-lto-cancel')) { L.confirm = null; L.more = {}; render(); return true; }
      if (t.hasAttribute('data-lto-go')) { go(); return true; }
      return false;
    }
    function change(t) {
      if (!t.hasAttribute('data-lto-concept')) return false;
      L.concept = t.value; L.sel = null; L.confirm = null; status(''); render();
      return true;
    }
    function status(text) { const el = $('lt-status'); if (el) { el.className = 'status'; el.textContent = text; } }
    // After New LTO: open the one just sent.
    function show(id, concept) { L.concept = concept; L.sel = id; L.filter = 'running'; L.confirm = null; }
    function badge() {
      const el = $('lt-badge');
      if (!el) return;
      const n = Array.isArray(hq.S.data && hq.S.data.ltos) ? hq.S.data.ltos.filter(l => l.status === 'running').length : 0;
      el.hidden = !n; el.textContent = n;
    }

    return { views: ['ltos'], render, click, change, show, badge, newId };
  }

  root.HQLtos = { create };
})(typeof window !== 'undefined' ? window : this);
