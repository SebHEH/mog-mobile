// Happy Supply, the warehouse (schema v13, phase W1; docs/MOG_Warehouse_Spec.md
// §2): HQ's Inventory (with a count), Incoming (vendor orders in and transfers),
// Products and prices, and Stock history, for people with the warehouse role.
// Built from the approved mockup "MOG HQ redesign" (2026-11-02) in the HQ
// page's own look; build.py copies this file beside hq/index.html.
//
// The rules live in the database (mog_wh_*): stock never below 0, the average
// cost, the numbers, who and when. This file shows the warehouse and sends what
// is typed; every write answers with the whole warehouse. The few sums it
// shows before a save (the average after a delivery, a store's price per
// case) are the database's own sums, pinned by tests/warehouse.test.js.
(function (root) {
  'use strict';

  // ---- Sums and payloads (no page needed: tests/warehouse.test.js) ----
  // numeric's round: half away from zero.
  function round(v, d) { const f = Math.pow(10, d); const r = Math.round(Math.abs(v) * f) / f; return v < 0 ? -r : r; }
  // mog.wh_avg_after: c cases in at cost k, with o owned at average a.
  function avgAfter(owned, avg, cases, cost) {
    if (!(cases > 0)) return avg;
    if (owned <= 0) return round(cost, 4);
    return round((owned * avg + cases * cost) / (owned + cases), 4);
  }
  // What a store pays per case (W2 locks it when an order ships).
  function storePrice(avg, fee, markupPct) { return round((Number(avg) + Number(fee)) * (1 + Number(markupPct || 0) / 100), 2); }
  function stockAt(p, locId) { return Number((p.stock || {})[String(locId)] || 0); }
  // mog.wh_owned: every location plus what's in transit.
  function owned(p) { let n = Number(p.inTransit || 0); for (const k of Object.keys(p.stock || {})) n += Number(p.stock[k]); return round(n, 2); }
  function value(products) { return round(products.reduce((t, p) => t + owned(p) * Number(p.avgCost), 0), 2); }
  // A typed amount: null when blank, NaN when not a number ("$76.00" and "1,204" are numbers).
  function num(text) {
    const s = String(text == null ? '' : text).replace(/[$,\s]/g, '');
    if (s === '') return null;
    const n = Number(s);
    return isFinite(n) ? n : NaN;
  }
  function cs(n) { n = Number(n); return String(n) + (n === 1 ? ' case' : ' cases'); }
  function money(n) { return '$' + Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
  // A count: only the products given a number; each with its reason.
  //   rows: { productId: { counted: text, reason: text } }
  function countPayload(locationId, rows) {
    const lines = [];
    for (const id of Object.keys(rows)) {
      const r = rows[id], n = num(r.counted);
      if (n === null) continue;
      lines.push({ productId: Number(id), cases: n, reason: String(r.reason || '').trim() });
    }
    return { locationId: locationId, lines: lines };
  }
  // What came in on an order: every line, by its number.
  //   rows: { ord: { cases: text, cost: text } }
  function receivePayload(po, rows) {
    return { id: po.id, version: po.version, lines: po.lines.map(l => {
      const r = rows[l.ord] || {}, n = num(r.cases), c = num(r.cost);
      const line = { ord: l.ord, cases: n === null ? 0 : n };
      if (c !== null) line.cost = c;
      return line;
    }) };
  }
  // The lines a transfer can't send: more than the from-location holds (the
  // database refuses those; this says so before the send).
  function transferProblems(products, fromId, lines) {
    const out = [], want = {};
    lines.forEach((l, i) => {
      const n = num(l.cases);
      if (!l.productId || n === null || isNaN(n) || n <= 0) return;
      want[l.productId] = (want[l.productId] || 0) + n;
      const p = products.find(x => x.id === Number(l.productId));
      const have = p ? stockAt(p, fromId) : 0;
      if (p && want[l.productId] > have + 1e-9) out.push({ i: i, have: have, product: p.name });
    });
    return out;
  }
  // ---- Store orders (schema v16, W2a) ----
  // Each line's Ship box to start with: what's left for this order after the
  // sent orders older than it (the number its store was told), at most what
  // it ordered and what the chosen location holds; From: the location with
  // the most of it. held: what the older orders take.
  function shipPrefill(orders, products, o, heldIds) {
    const older = orders.filter(x => x.status === 'sent' && x.id !== o.id && (x.sentAt < o.sentAt || (x.sentAt === o.sentAt && x.id < o.id)));
    return o.lines.map(l => {
      const p = products.find(x => x.id === l.productId);
      const stock = Object.assign({}, p ? p.stock || {} : {});
      for (const k of heldIds || []) delete stock[String(k)];   // v17: never ships from a held location
      const total = Object.keys(stock).reduce((t, k) => t + Number(stock[k]), 0);
      const held = round(older.reduce((t, x) => t + x.lines.filter(y => y.productId === l.productId).reduce((s, y) => s + Number(y.cases), 0), 0), 2);
      const left = Math.max(0, round(total - held, 2));
      const locs = Object.keys(stock).filter(k => Number(stock[k]) > 0).sort((a, b) => (Number(stock[b]) - Number(stock[a])) || (Number(a) - Number(b)));
      const loc = locs.length ? Number(locs[0]) : null;
      return { ord: l.ord, cases: Math.min(Number(l.cases), left, loc === null ? 0 : Number(stock[String(loc)])), locationId: loc, left: left, held: held,
               olderOrders: older.filter(x => x.lines.some(y => y.productId === l.productId)).map(x => x.number) };
    });
  }
  // A shipment: every line, by its number (0 = none of it).
  //   rows: { ord: { cases: text, locationId } }
  function shipPayload(o, rows) {
    return { id: o.id, version: o.version, lines: o.lines.map(l => {
      const r = rows[l.ord] || {}, n = num(r.cases);
      const line = { ord: l.ord, cases: n === null ? 0 : n };
      if (line.cases > 0) line.locationId = r.locationId == null || r.locationId === '' ? null : Number(r.locationId);
      return line;
    }) };
  }
  // ---- HEH's stock held at Elpis (schema v17, W2b) ----
  const lcs = v => String(v == null ? '' : v).toLowerCase();
  // Does a product belong at a location: one held by a vendor takes the
  // products ordered through that vendor (via), HEH's own the rest.
  function fits(p, loc) {
    if (!loc) return true;
    if (p.places && p.places.length) return p.places.some(x => x.locationId === loc.id);   // v20: the places it sits at
    return lcs(p.via) === lcs(loc.heldBy);
  }
  // A held location's stock: each product ordered through its holder (or with
  // cases there): on hand, what open deliveries hold, and what's available,
  // mog.wh_available's sum for a held product (never below 0).
  function heldStock(products, deliveries, loc) {
    return products.filter(p => fits(p, loc) || stockAt(p, loc.id) > 0).map(p => {
      let open = 0;
      for (const o of deliveries) if (o.status === 'ordered' && o.heldAt === loc.id) for (const l of o.lines) if (l.productId === p.id) open += Number(l.cases);
      open = round(open, 2);
      const onHand = stockAt(p, loc.id);
      return { product: p, onHand: onHand, open: open, available: Math.max(0, round(onHand - open, 2)) };
    });
  }
  // The receipts that went beyond the records since the location's last real
  // count: what was received, and what the records held.
  function beyondSinceCount(deliveries, loc) {
    const out = [], since = loc.lastCount ? new Date(loc.lastCount).getTime() : -Infinity;
    for (const o of deliveries) {
      if (o.heldAt !== loc.id || o.status !== 'received' || !(new Date(o.receivedAt).getTime() > since)) continue;
      for (const l of o.lines) if (Number(l.beyond) > 0) out.push({ order: o, line: l, held: round(Number(l.casesReceived) - Number(l.beyond), 2) });
    }
    return out;
  }
  // Mark a store's delivery received: every line, a blank one as ordered.
  //   rows: { ord: text }
  function heldPayload(o, rows) {
    return { id: o.id, version: o.version, lines: o.lines.map(l => {
      const n = num(rows[l.ord]);
      return { ord: l.ord, cases: n === null ? Number(l.cases) : n };
    }) };
  }
  // ---- HEH's stock at three places (schema v20, W2c) ----
  // A place's kind: HEH's own, held at a store (RP Tysons), held by a vendor (Elpis).
  function placeKind(loc) { return !loc || !loc.heldBy ? 'own' : loc.heldStore ? 'store' : 'vendor'; }
  // A product's low point at a place (0 = none), and below it there.
  function lowAt(p, locId) { const x = (p.places || []).find(y => y.locationId === locId); return x ? Number(x.lowPoint) : 0; }
  function isLow(p, loc) { const low = lowAt(p, loc.id); return low > 0 && fits(p, loc) && stockAt(p, loc.id) < low; }
  // An item's save: its fields and its places, each with a low point.
  function itemRow(f) {
    const row = { name: String(f.name).trim(), pack: String(f.pack || '').trim(), par: Number(f.par || 0), handlingFee: num(f.fee),
                  stores: f.limit ? f.stores.slice() : [], active: !!f.active, concept: f.concept || '',
                  places: f.places.map(x => ({ locationId: x.locationId, lowPoint: num(x.low) === null ? 0 : num(x.low) })) };
    if (f.id) { row.id = f.id; row.version = f.version; }
    return row;
  }
  // The counts an item's save makes: one per place whose Now changed (a blank
  // Now is left alone), each with its reason.
  function itemCounts(f, p) {
    const out = [];
    for (const x of f.places) {
      const n = num(x.now);
      if (n === null || isNaN(n) || n < 0) continue;
      if (round(n, 2) === (p ? stockAt(p, x.locationId) : 0)) continue;
      out.push({ locationId: x.locationId, lines: [{ productId: p ? p.id : null, cases: round(n, 2), reason: String(x.reason || '').trim() }] });
    }
    return out;
  }
  // A place's save.
  function placeRow(f) {
    const how = f.countHow || (f.kind === 'own' ? 'hq' : f.kind === 'store' ? 'marginedge' : 'report');
    const row = { name: String(f.name).trim(), active: !!f.active, heldBy: f.kind === 'own' ? null : f.heldBy,
                  heldStore: f.kind === 'store' ? f.heldStore : null, countHow: how };
    if (f.id) row.id = f.id;
    return row;
  }
  // HQ's check-in of a Happy Supply shipment into a place: a blank line
  // arrived as shipped.
  function moveInPayload(o, rows) {
    return { id: o.id, version: o.version, lines: o.lines.map(l => {
      const n = num(rows[l.ord]);
      return { ord: l.ord, cases: n === null ? Number(l.casesShipped || 0) : n };
    }) };
  }
  // A month ('2026-10') as who took what's span: from the day before the 1st
  // (not counted) through its last day.
  function monthSpan(ym) {
    const yy = Number(ym.slice(0, 4)), mm = Number(ym.slice(5, 7)), iso = d => d.toISOString().slice(0, 10);
    return { from: iso(new Date(Date.UTC(yy, mm - 1, 0))), to: iso(new Date(Date.UTC(yy, mm, 0))) };
  }
  // Who took what as CSV, one row per store, place and item.
  function takenCsv(t) {
    const q = v => { const x = String(v == null ? '' : v); return /[",\n]/.test(x) ? '"' + x.replace(/"/g, '""') + '"' : x; };
    const rows = [['What', 'Store', 'From', 'To', 'Item', 'Pack', 'Cases', 'How we know']];
    for (const r of t.taken) rows.push(['Taken', r.store, r.place, '', r.product, r.pack, r.cases, r.deliveries + ' checked in']);
    for (const r of t.used) rows.push(['Used at its own place', r.store, r.place, '', r.product, r.pack, r.cases, 'from ' + r.counts + ' counts']);
    for (const r of t.moved) rows.push(['Moved between places', '', r.from, r.place, r.product, r.pack, r.cases, r.shipments + ' shipments']);
    return rows.map(r => r.map(q).join(',')).join('\n') + '\n';
  }

  const logic = { round, avgAfter, storePrice, stockAt, owned, value, num, cs, money, countPayload, receivePayload, transferProblems,
                  shipPrefill, shipPayload, fits, heldStock, beyondSinceCount, heldPayload,
                  placeKind, lowAt, isLow, itemRow, itemCounts, placeRow, moveInPayload, monthSpan, takenCsv };

  // ---- The page ----
  const VIEWS = ['wh-stock', 'wh-items', 'wh-places', 'wh-incoming', 'wh-orders', 'wh-taken', 'wh-history'];
  const PLUS = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" aria-hidden="true"><path d="M12 5l0 14"/><path d="M5 12l14 0"/></svg>';
  const CHECK = '<svg class="ck" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12l5 5l10 -10"/></svg>';
  const CHEV = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#5f5e5a" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 9l6 6l6 -6"/></svg>';
  const SECTIONS =
    '<section class="view" id="v-wh-stock" aria-labelledby="whk-h" hidden>' +
      '<div class="page-head"><div><h1 id="whk-h">Stock</h1><p>Every HEH item at each place, in cases. Amber is below that place\'s low point. A count fixes a place\'s numbers, and every difference is kept in Stock history with its reason.</p></div>' +
      '<div class="actions"><button type="button" class="btn primary" data-wh="count-open">Count a place</button></div></div>' +
      '<div class="status" id="whk-status" role="status"></div><div id="whk-body" class="view"></div></section>' +
    '<section class="view" id="v-wh-items" aria-labelledby="whit-h" hidden>' +
      '<div class="page-head"><div><h1 id="whit-h">Items</h1><p>Everything HEH keeps. An item sits at one or more places, the way a store item sits on vendors\' lists: instead of a par it has a stock level and a low point at each place, and a price.</p></div>' +
      '<div class="actions"><button type="button" class="btn" data-wh="item-new">' + PLUS + 'Add item</button></div></div>' +
      '<div class="status" id="whit-status" role="status"></div><div id="whit-body" class="view"></div></section>' +
    '<section class="view" id="v-wh-places" aria-labelledby="whpl-h" hidden>' +
      '<div class="page-head"><div><h1 id="whpl-h">Places</h1><p>Where HEH\'s stock sits, like the vendors on a store\'s Vendors page: Happy Supply\'s own, a store holding it for others, a vendor holding it. Stores order from a place under their own vendor name.</p></div>' +
      '<div class="actions"><button type="button" class="btn" data-wh="place-new">' + PLUS + 'Add place</button></div></div>' +
      '<div class="status" id="whpl-status" role="status"></div><div id="whpl-body" class="view"></div></section>' +
    '<section class="view" id="v-wh-incoming" aria-labelledby="whn-h" hidden>' +
      '<div class="page-head"><div><h1 id="whn-h">Incoming</h1><p>Vendor orders on their way in, and transfers between locations. Receiving a vendor order adds its cases and updates the average cost.</p></div>' +
      '<div class="actions"><button type="button" class="btn" data-whgo="newtr">New transfer</button><button type="button" class="btn primary" data-whgo="newpo">New vendor order</button></div></div>' +
      '<div class="status" id="whn-status" role="status"></div><div id="whn-body" class="view"></div></section>' +
    '<section class="view" id="v-wh-orders" aria-labelledby="who-h" hidden>' +
      '<div class="page-head"><div><h1 id="who-h">Orders</h1><p>Store orders sent from each order guide\'s review screen, soonest needed first. Ship from a location: the stock drops and the store\'s price locks.</p></div></div>' +
      '<div class="status" id="who-status" role="status"></div><div id="who-body" class="view"></div></section>' +
    '<section class="view" id="v-wh-taken" aria-labelledby="wht-h" hidden>' +
      '<div class="page-head"><div><h1 id="wht-h">Who took what</h1><p>Each store, from each place, in cases: what it checked in, and a store\'s own use at the place it holds, from its counts. Moves between HEH\'s places are listed apart: nobody is charged for them.</p></div></div>' +
      '<div class="status" id="wht-status" role="status"></div><div id="wht-body" class="view"></div></section>' +
    '<section class="view" id="v-wh-history" aria-labelledby="whh-h" hidden>' +
      '<div class="page-head"><div><h1 id="whh-h">Stock history</h1><p>Every change to the stock, newest first: deliveries, transfers and counts, with who, when and why.</p></div></div>' +
      '<div class="status" id="whh-status" role="status"></div><div id="whh-body" class="view"></div></section>';

  function create(host) {
    const $ = id => document.getElementById(id);
    const esc = s => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    const plural = (n, w) => n + ' ' + w + (n === 1 ? '' : 's');
    const signed = n => (n > 0 ? '+' : n < 0 ? '−' : '') + String(Math.abs(n));
    const day = iso => new Date(iso).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
    const when = iso => new Date(iso).toLocaleString('en-US', { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
    const W = { data: null, busy: false,
                inv: { counting: false, loc: null, rows: {} },
                stk: { q: '', concept: '', filter: 'all', open: null, rows: {} },
                inc: { filter: 'open', sel: null, rcv: {}, po: null, tr: null },
                ord: { filter: 'sent', sel: null, rows: {} },
                items: { sel: null, draft: null, q: '', place: '', concept: '', filter: 'active', send: null },
                places: { sel: null, draft: null, vend: {}, renames: {} },
                taken: { month: null, data: null, key: null },
                hist: { product: '', location: '', moves: null, more: false, key: null } };

    document.querySelector('#main .wrap').insertAdjacentHTML('beforeend', SECTIONS);

    // ---- Reading and writing ----
    function say(id, cls, text) { const el = $(id); if (el) { el.className = 'status' + (cls ? ' ' + cls : ''); el.textContent = text || ''; } }
    async function fetchData() {
      try { return await host.rpc('mog_wh_data', { p_token: host.token() }); }
      catch (e) { return null; }   // no warehouse here (a database before schema v13)
    }
    async function refresh() {
      const r = await fetchData();
      if (r && r.ok) take(r.data);
    }
    function take(data) { W.data = data; W.hist.moves = null; W.taken.data = null; }
    // One write: the whole warehouse comes back. A refusal says why; a
    // CONFLICT reloads what's saved (W.conflict says so to the caller, which
    // drops its draft so the next save starts from it).
    async function write(fn, params, statusId, okText) {
      if (W.busy) return null;
      W.busy = true; W.conflict = false;
      say(statusId, '', 'Saving…');
      document.querySelectorAll('[id^="v-wh-"] button').forEach(b => { if (!b.disabled) { b.disabled = true; b.setAttribute('data-whbusy', '1'); } });
      try {
        const r = await host.rpc(fn, Object.assign({ p_token: host.token() }, params));
        if (!r.ok) {
          if (r.error === 'SESSION_EXPIRED' || r.error === 'NOT_ALLOWED') { host.signedOut('Your sign-in ran out. Sign in again.'); return null; }
          if (r.error === 'CONFLICT') {
            W.conflict = true;
            await refresh();
            say(statusId, 'bad', 'Not saved: ' + r.detail + '. It now shows what is saved.');
            return null;
          }
          say(statusId, 'bad', 'Not saved: ' + upper(String(r.error).replace(/^REJECTED: /, '')) + '.');
          return null;
        }
        take(r.data);
        say(statusId, 'good', okText(r.data.done));
        return r.data.done;
      } catch (e) {
        say(statusId, 'bad', 'Not saved: ' + e.message);
        return null;
      } finally {
        W.busy = false;
        document.querySelectorAll('[data-whbusy]').forEach(b => { b.disabled = false; b.removeAttribute('data-whbusy'); });
      }
    }
    const upper = s => s.charAt(0).toUpperCase() + s.slice(1);

    // ---- Shared bits ----
    const D = () => W.data;
    const activeLocs = () => D().locations.filter(l => l.active);
    // v17: a location held by a vendor (Elpis), and the deliveries from it.
    const heldLocs = () => D().locations.filter(l => l.heldBy);
    const ownLocs = () => activeLocs().filter(l => !l.heldBy);
    const deliveries = () => D().deliveries || [];
    const locName = id => { const l = D().locations.find(x => x.id === id); return l ? l.name : '?'; };
    const prodBy = id => D().products.find(p => p.id === Number(id));
    const lowList = () => D().products.filter(p => p.active && activeLocs().some(l => isLow(p, l)));
    const openCount = () => D().pos.filter(p => p.status === 'ordered').length + D().transfers.filter(t => t.status === 'in_transit').length;
    function selectHtml(attr, value, options, placeholder) {
      return '<span class="select small"><select ' + attr + '>' +
        (placeholder ? '<option value=""' + (value ? '' : ' selected') + ' disabled>' + esc(placeholder) + '</option>' : '') +
        options.map(o => '<option value="' + esc(o[0]) + '"' + (String(o[0]) === String(value) ? ' selected' : '') + '>' + esc(o[1]) + '</option>').join('') +
        '</select>' + CHEV + '</span>';
    }
    const inputHtml = (attr, value, extra) => '<input class="cell-in" ' + attr + ' value="' + esc(value == null ? '' : value) + '" inputmode="decimal"' + (extra || '') + '>';
    function emptyHtml(text) { return '<p class="empty" style="margin:0">' + text + '</p>'; }

    // ---- Stock (schema v20): every item at each place ----
    const KIND_ORDER = { own: 0, store: 1, vendor: 2 };
    const HOW = { hq: 'In HQ', marginedge: 'From MarginEdge', report: 'From a report' };
    const placeList = () => activeLocs().slice().sort((a, b) => (KIND_ORDER[placeKind(a)] - KIND_ORDER[placeKind(b)]) || (a.ord - b.ord) || a.name.localeCompare(b.name));
    const howOf = l => HOW[l.countHow] || (placeKind(l) === 'own' ? HOW.hq : placeKind(l) === 'store' ? HOW.marginedge : HOW.report);
    const placeSub = l => (!l ? '' : placeKind(l) === 'own' ? 'HEH\'s own' : placeKind(l) === 'store' ? 'At ' + (l.store || l.heldStore) : 'Held by ' + l.heldBy) + ' · ' + howOf(l);
    const sitsSomewhere = p => activeLocs().some(l => fits(p, l)) || Object.keys(p.stock || {}).length > 0;
    const placeTotal = p => round(activeLocs().reduce((t, l) => t + stockAt(p, l.id), 0), 2);
    const conceptOpts = first => [['', first]].concat(Array.from(new Set(D().stores.map(x => x.concept).filter(Boolean)))
      .map(k => [k, host.conceptName ? host.conceptName(k) : k]));
    function stockList() {
      const f = W.stk, q = lcs(f.q).trim();
      return D().products.filter(p => p.active && sitsSomewhere(p))
        .filter(p => !q || lcs(p.name).indexOf(q) >= 0)
        .filter(p => !f.concept || !p.concept || p.concept === f.concept)
        .filter(p => f.filter !== 'low' || activeLocs().some(l => isLow(p, l)))
        .sort((a, b) => a.name.localeCompare(b.name));
    }
    function searchHtml(attr, value) {
      return '<input class="text" type="search" ' + attr + ' placeholder="Search items" aria-label="Search items" value="' + esc(value) + '" style="height:40px;font-size:14px;flex:0 1 260px;min-width:170px">';
    }
    function pillsHtml(attr, cur, list) {
      return '<div class="actions" role="group" aria-label="Show">' + list.map(f => '<button type="button" class="pill" ' + attr + '="' + f[0] + '" aria-pressed="' + (cur === f[0]) + '">' +
        esc(f[1]) + '</button>').join('') + '</div>';
    }
    function stockCell(p, l, beyond) {
      if (!fits(p, l) && !stockAt(p, l.id)) return '<td style="text-align:right" class="muted">·</td>';
      const n = stockAt(p, l.id), flag = beyond.some(b => b.line.productId === p.id) ? ' <span class="tag warn">count it</span>' : '';
      return isLow(p, l) ? '<td style="text-align:right"><span class="tag warn">' + n + '</span>' + flag + '<div class="muted" style="font-size:12px">low point ' + lowAt(p, l.id) + '</div></td>'
                         : '<td style="text-align:right"><b>' + n + '</b>' + flag + '</td>';
    }
    function renderStock() {
      const d = D(), places = placeList(), list = stockList();
      const all = d.products.filter(p => p.active && sitsSomewhere(p)).length;
      let html = '<div class="card toolbar">' + searchHtml('data-whkq="1"', W.stk.q) + selectHtml('data-whkc="1" aria-label="Concept"', W.stk.concept, conceptOpts('All concepts')) +
        pillsHtml('data-whkf', W.stk.filter, [['all', 'All · ' + all], ['low', 'Low · ' + lowList().length]]) + '</div>';
      if (!places.length) html += '<section class="card"><p class="empty" style="margin:0">No places yet. Add the first one on <button type="button" class="linkbtn" data-nav="wh-places">Places</button>.</p></section>';
      else {
        const beyond = {};
        for (const l of places) beyond[l.id] = placeKind(l) === 'own' ? [] : beyondSinceCount(deliveries(), l);
        html += '<section class="card" aria-labelledby="whk-t"><h2 id="whk-t" class="sr">Stock by place</h2><div class="scroll"><table><thead><tr><th>Item</th>' +
          places.map(l => '<th style="text-align:right"><button type="button" class="linkbtn" data-whplsel="' + l.id + '">' + esc(l.name) + '</button>' +
            '<div class="muted" style="font-size:12px;font-weight:500">' + esc(howOf(l) + ' · ' + (l.lastCount ? 'counted ' + day(l.lastCount) : 'not counted yet')) + '</div></th>').join('') +
          '<th style="text-align:right">In all</th></tr></thead><tbody>' +
          (list.length ? list.map(p => '<tr><td><button type="button" class="linkbtn" data-whitsel="' + p.id + '"><b>' + esc(p.name) + '</b></button>' +
            (p.pack ? '<div class="muted" style="font-size:12px">' + esc(p.pack) + '</div>' : '') + '</td>' + places.map(l => stockCell(p, l, beyond[l.id])).join('') +
            '<td style="text-align:right"><b>' + placeTotal(p) + '</b></td></tr>').join('')
            : '<tr><td colspan="' + (places.length + 2) + '" class="muted">' + (d.products.length ? 'Nothing here.' : 'No items yet: add the first one on Items.') + '</td></tr>') +
          '</tbody></table></div><p class="help" style="margin-top:10px">Click an item to open it on Items, or a place to open it on Places. "Count it": a store checked in more than the records held there.</p></section>';
      }
      html += onTheWayHtml();
      if (W.inv.counting) html += countHtml();
      $('whk-body').innerHTML = html;
      if (W.inv.counting) updateCount();
      updateOnTheWay();
    }
    // What's on its way out of a place or into one, until it's checked in.
    function onTheWay() {
      const out = [];
      for (const o of deliveries()) if (o.status === 'ordered') out.push({ key: 'o' + o.id, o, kind: 'held', from: locName(o.heldAt), to: storeShort(o), at: o.sentAt });
      for (const o of orders()) {
        const l = o.status === 'shipped' ? o.lines.find(x => x.toLocation != null) : null;
        if (l) out.push({ key: 'o' + o.id, o, kind: 'move', from: l.location || 'Happy Supply', to: l.to || locName(l.toLocation), at: o.shippedAt });
      }
      for (const t of D().transfers) if (t.status === 'in_transit') out.push({ key: 't' + t.id, t, kind: 'transfer', from: t.from, to: t.to, at: t.sentAt });
      return out.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
    }
    function onTheWayHtml() {
      const list = onTheWay();
      let html = '<section class="card" aria-labelledby="whk-w"><div class="card-head"><h2 id="whk-w">On the way' + (list.length ? ' · ' + list.length : '') + '</h2>' +
        '<span class="muted">Each leaves its place, or reaches it, when it\'s checked in</span></div>';
      if (!list.length) return html + '<p class="muted" style="margin:0">Nothing on its way.</p></section>';
      return html + list.map(x => {
        const lines = x.t ? x.t.lines.map(l => l.product + ' ' + l.cases) : x.o.lines.map(l => (l.product || l.name) + ' ' + Number(x.kind === 'move' ? l.casesShipped : l.cases));
        const meta = x.t ? x.t.number + ', sent ' + day(x.t.sentAt)
          : x.kind === 'move' ? x.o.number + ', shipped ' + day(x.o.shippedAt) + ' · it reaches ' + x.to + ' when ' + storeShort(x.o) + ' checks it in'
          : x.o.number + ', ordered ' + day(x.o.cycleDate + 'T12:00:00') + ' · not checked in';
        const open = W.stk.open === x.key;
        const btn = x.t ? '<button type="button" class="btn small" data-whgotr="' + x.t.id + '">Open in Incoming</button>'
          : '<button type="button" class="btn small" data-whkopen="' + x.key + '" aria-expanded="' + open + '">Check in for ' + esc(storeShort(x.o)) + '</button>';
        return '<div class="el-line"><div class="row-between" style="margin:0"><span><b>' + esc(x.from + ' → ' + x.to) + '</b>' +
          '<span class="muted" style="display:block;font-size:13px">' + esc(lines.join(' · ') + ' · ' + meta) + '</span></span>' + btn + '</div>' + (open ? checkInHtml(x) : '') + '</div>';
      }).join('') + '</section>';
    }
    function checkInHtml(x) {
      const o = x.o, move = x.kind === 'move', sent = l => Number(move ? l.casesShipped : l.cases);
      return '<div style="margin-top:10px"><p class="help" style="margin:0 0 8px">' + (move ? 'What reached ' + esc(x.to) + '. A blank line arrived as shipped; it can\'t be more.'
          : 'What ' + esc(storeShort(o)) + ' got. A blank line arrived as ordered; more is fine.') + '</p>' +
        '<div class="scroll"><table><thead><tr><th>Item</th><th>' + (move ? 'Shipped' : 'Ordered') + '</th><th>Arrived</th></tr></thead><tbody>' +
        o.lines.map(l => '<tr><td><b>' + esc(l.product || l.name) + '</b></td><td>' + sent(l) + '</td><td style="min-width:110px">' +
          inputHtml('data-whkr="' + l.ord + '" aria-label="' + esc(l.product || l.name) + ' arrived, cases"', W.stk.rows[l.ord], ' placeholder="' + sent(l) + '"') + '</td></tr>').join('') +
        '</tbody></table></div><div class="row-between"><span class="muted" id="whk-ci-sum"></span><div class="actions" style="align-items:center">' +
        '<button type="button" class="linkbtn" data-wh="ci-cancel">Cancel</button><button type="button" class="btn primary" data-wh="ci-go" id="whk-ci-go">Checked in</button></div></div></div>';
    }
    function updateOnTheWay() {
      const go = $('whk-ci-go'), sum = $('whk-ci-sum');
      if (!go) return;
      const bad = Object.keys(W.stk.rows).some(k => { const n = num(W.stk.rows[k]); return n !== null && (isNaN(n) || n < 0); });
      if (sum) sum.textContent = bad ? 'A line is a number of cases, 0 or more.' : 'Checks it in for the store; its card then shows it received by HQ.';
      go.disabled = bad;
    }
    // A count at any place (Tysons from its Sunday MarginEdge count, Elpis from its report).
    function countProducts() {
      const loc = W.inv.loc, L = D().locations.find(l => l.id === loc);
      return D().products.filter(p => (p.active && fits(p, L)) || stockAt(p, loc) > 0);
    }
    function countHtml() {
      const loc = W.inv.loc, rows = W.inv.rows;
      const prods = countProducts();
      return '<section class="card focus" aria-labelledby="whc-h"><div class="card-head"><h2 id="whc-h">Count a place</h2>' +
        '<label class="field" style="flex-direction:row;align-items:center;gap:10px"><span class="sr">Place</span>' +
        selectHtml('data-whcloc="1"', loc, placeList().map(l => [l.id, l.name])) + '</label></div>' +
        '<p class="help">Type what is there, in cases (MarginEdge counts pounds: a 10 LB case is 10 of them). A number that differs from the record needs a reason. An item left blank keeps its number.</p>' +
        (!prods.length ? emptyHtml('Nothing kept here yet: add items to this place on Items.') :
        '<div class="scroll" style="margin-top:12px"><table><thead><tr><th>Item</th><th>On record</th><th>Counted</th><th>Difference</th><th>Why it\'s different</th></tr></thead><tbody>' +
        prods.map(p => { const r = rows[p.id] || {};
          return '<tr><td><b>' + esc(p.name) + '</b></td><td>' + esc(cs(stockAt(p, loc))) + '</td>' +
            '<td style="min-width:110px">' + inputHtml('data-whc="' + p.id + '" aria-label="' + esc(p.name) + ' counted, cases"', r.counted, ' placeholder="Count"') + '</td>' +
            '<td id="whd-' + p.id + '"></td>' +
            '<td style="min-width:220px"><input class="cell-in" data-whr="' + p.id + '" aria-label="Why ' + esc(p.name) + ' differs" value="' + esc(r.reason || '') + '" maxlength="200"></td></tr>'; }).join('') +
        '</tbody></table></div>') +
        '<div class="row-between"><span class="muted" id="whc-sum"></span><div class="actions" style="align-items:center">' +
        '<button type="button" class="linkbtn" data-wh="count-cancel">Cancel</button>' +
        '<button type="button" class="btn primary big" data-wh="count-save" id="whc-save">Save count</button></div></div></section>';
    }
    // The difference cells, the reasons wanted and the summary, without
    // redrawing the boxes being typed in.
    function updateCount() {
      const loc = W.inv.loc, rows = W.inv.rows, changes = [], need = [];
      let bad = false;
      for (const p of countProducts()) {
        const r = rows[p.id] || {}, n = num(r.counted), cell = $('whd-' + p.id), why = document.querySelector('[data-whr="' + p.id + '"]');
        const box = document.querySelector('[data-whc="' + p.id + '"]');
        if (box) box.setAttribute('aria-invalid', String(n !== null && (isNaN(n) || n < 0)));
        if (n === null || isNaN(n) || n < 0) {
          if (n !== null) bad = true;
          if (cell) cell.innerHTML = n === null ? '<span class="muted">Not counted</span>' : '<span class="bad">Not a number</span>';
          if (why) why.disabled = true;
          continue;
        }
        const diff = round(round(n, 2) - stockAt(p, loc), 2);
        if (cell) cell.innerHTML = diff === 0 ? '<span class="tag ok">Matches</span>' : '<span class="tag warn">' + signed(diff) + ' cs</span>';
        if (why) why.disabled = diff === 0;
        if (diff !== 0) { changes.push(p.name + ' ' + signed(diff)); if (!String(r.reason || '').trim()) need.push(p.name); }
      }
      const sum = $('whc-sum');
      if (sum) sum.textContent = bad ? 'A count is a number of cases, 0 or more.'
        : need.length ? 'Say why ' + need.join(', ') + (need.length === 1 ? ' differs.' : ' differ.')
        : changes.length ? 'Saves the count for ' + locName(loc) + ': ' + changes.join(', ') + '.'
        : Object.keys(rows).some(k => num(rows[k].counted) !== null) ? 'Everything counted matches the record.' : 'Nothing counted yet.';
      const save = $('whc-save');
      if (save) save.disabled = bad || need.length > 0 || !changes.length;
    }

    // ---- Incoming ----
    function incomingList() {
      const d = D(), f = W.inc.filter;
      const pos = d.pos.filter(p => (f === 'open' ? p.status === 'ordered' : f === 'received' ? p.status === 'received' : p.status === 'cancelled'))
        .map(p => ({ key: 'po:' + p.id, at: p.createdAt, p: p }));
      const trs = f === 'cancelled' ? [] : d.transfers.filter(t => (f === 'open' ? t.status === 'in_transit' : t.status === 'received'))
        .map(t => ({ key: 'tr:' + t.id, at: t.sentAt, t: t }));
      return pos.concat(trs).sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
    }
    function renderIncoming() {
      const d = D(), list = incomingList();
      const editing = /^(newpo|newtr|editpo:)/.test(W.inc.sel || '');
      if (!editing && !list.some(x => x.key === W.inc.sel)) setSel(list.length ? list[0].key : null);
      const nOpen = openCount();
      let html = '<div class="actions" role="group" aria-label="Show">' +
        [['open', 'Open · ' + nOpen], ['received', 'Received'], ['cancelled', 'Cancelled']].map(f =>
          '<button type="button" class="pill" data-whincf="' + f[0] + '" aria-pressed="' + (W.inc.filter === f[0]) + '">' + f[1] + '</button>').join('') + '</div>';
      html += '<div class="cols"><section class="card list-card" style="flex:1 1 320px" aria-label="Vendor orders and transfers">' +
        (list.length ? list.map(x => {
          const cur = x.key === W.inc.sel;
          if (x.p) return '<button type="button" class="lrow" data-whsel="' + x.key + '"' + (cur ? ' aria-current="true"' : '') + '><span class="t"><span class="n">' + esc(x.p.number + ' · ' + x.p.supplier) + '</span>' +
            '<span class="s">To ' + esc(x.p.location) + ' · ordered ' + esc(day(x.p.createdAt)) + ' · ' + plural(x.p.lines.length, 'line') + '</span></span>' + statusTag(x.p.status) + '</button>';
          return '<button type="button" class="lrow" data-whsel="' + x.key + '"' + (cur ? ' aria-current="true"' : '') + '><span class="t"><span class="n">' + esc(x.t.number) + ' · transfer</span>' +
            '<span class="s">' + esc(x.t.from + ' to ' + x.t.to) + ' · sent ' + esc(day(x.t.sentAt)) + ' · ' + esc(x.t.lines.map(l => l.cases + ' cs ' + l.product).join(', ')) + '</span></span>' + statusTag(x.t.status) + '</button>';
        }).join('') : '<div class="list-foot">' + (W.inc.filter === 'open' ? 'Nothing on its way.' : 'None yet.') + '</div>') + '</section>';
      html += '<section class="card panel focus" style="flex:2 1 520px" aria-label="Details">' + panelHtml() + '</section></div>';
      html += '<div class="stats" style="grid-template-columns:repeat(auto-fit,minmax(260px,1fr))">' +
        listCardHtml('supplier', 'Suppliers', 'Picked on a vendor order. Tap one to hide it from new orders or show it again.', d.suppliers) + '</div>';
      $('whn-body').innerHTML = html;
      updateIncoming();
    }
    function statusTag(s) {
      const t = { ordered: ['Ordered', ''], received: ['Received', 'ok'], cancelled: ['Cancelled', ''], in_transit: ['In transit', 'warn'] }[s] || [s, ''];
      return '<span class="tag' + (t[1] ? ' ' + t[1] : '') + '">' + t[0] + '</span>';
    }
    function setSel(key) {
      W.inc.sel = key; W.inc.rcv = {};
      const po = key && key.indexOf('po:') === 0 ? D().pos.find(p => p.id === Number(key.slice(3))) : null;
      if (po && po.status === 'ordered') for (const l of po.lines) W.inc.rcv[l.ord] = { cases: String(Number(l.cases)), cost: l.cost == null ? '' : Number(l.cost).toFixed(2) };
    }
    function panelHtml() {
      const sel = W.inc.sel;
      if (!sel) return emptyHtml('Nothing on its way. Start one with New vendor order or New transfer.');
      if (sel === 'newpo' || sel.indexOf('editpo:') === 0) return poFormHtml();
      if (sel === 'newtr') return trFormHtml();
      if (sel.indexOf('po:') === 0) {
        const po = D().pos.find(p => p.id === Number(sel.slice(3)));
        return po.status === 'ordered' ? receiveHtml(po) : poDoneHtml(po);
      }
      const t = D().transfers.find(x => x.id === Number(sel.slice(3)));
      return transferHtml(t);
    }
    function receiveHtml(po) {
      return '<div class="card-head"><h2>Receive ' + esc(po.number) + '</h2><span class="muted">' + esc(po.supplier + ' · to ' + po.location + ' · ordered by ' + po.createdBy + ', ' + when(po.createdAt)) + '</span></div>' +
        (po.note ? '<p class="note-box" style="margin:0">' + esc(po.note) + '</p>' : '') +
        '<p class="help" style="margin:0">Type what actually came in and what it cost. The average covers every location.</p>' +
        '<div class="scroll"><table><thead><tr><th>Product</th><th>Ordered</th><th>Received</th><th>Cost / cs</th><th>Average after</th></tr></thead><tbody>' +
        po.lines.map(l => { const r = W.inc.rcv[l.ord] || {};
          return '<tr><td><b>' + esc(l.product) + '</b>' + (l.pack ? '<div class="muted" style="font-size:13px">' + esc(l.pack) + '</div>' : '') + '</td>' +
            '<td>' + Number(l.cases) + ' cs</td>' +
            '<td style="min-width:100px">' + inputHtml('data-whrc="' + l.ord + '" aria-label="' + esc(l.product) + ' received, cases"', r.cases) + '</td>' +
            '<td style="min-width:110px">' + inputHtml('data-whrk="' + l.ord + '" aria-label="' + esc(l.product) + ' cost per case"', r.cost, ' placeholder="$"') + '</td>' +
            '<td id="wha-' + l.ord + '"></td></tr>'; }).join('') +
        '</tbody></table></div>' +
        '<div class="note-box" id="wha-sum"></div>' +
        '<div class="row-between" style="margin-top:0"><div class="actions" style="align-items:center">' +
        '<button type="button" class="linkbtn" data-wh="po-edit">Edit this order</button>' +
        '<button type="button" class="linkbtn" data-wh="po-cancel">Cancel this order</button></div>' +
        '<button type="button" class="btn primary big" data-wh="po-receive" id="wha-go">Receive into ' + esc(po.location) + '</button></div>';
    }
    function updateIncoming() {
      const sel = W.inc.sel || '';
      if (sel.indexOf('po:') === 0) {
        const po = D().pos.find(p => p.id === Number(sel.slice(3)));
        if (po && po.status === 'ordered') updateReceive(po);
      }
      if (sel === 'newpo' || sel.indexOf('editpo:') === 0) updatePoForm();
      if (sel === 'newtr') updateTrForm();
    }
    function updateReceive(po) {
      let bad = false, any = false, total = 0;
      const gets = [], short = [], noCost = [];
      for (const l of po.lines) {
        const r = W.inc.rcv[l.ord] || {}, n = num(r.cases), c = num(r.cost), p = prodBy(l.productId), cell = $('wha-' + l.ord);
        const nBad = n !== null && (isNaN(n) || n < 0), cBad = n > 0 && (c === null || isNaN(c) || c < 0);
        const nBox = document.querySelector('[data-whrc="' + l.ord + '"]'), cBox = document.querySelector('[data-whrk="' + l.ord + '"]');
        if (nBox) nBox.setAttribute('aria-invalid', String(nBad));
        if (cBox) cBox.setAttribute('aria-invalid', String(!!cBad && c !== null));
        if (cBad && !nBad) noCost.push(l.product);
        if (nBad || cBad) { bad = true; if (cell) cell.innerHTML = '<span class="muted">' + (nBad ? 'Cases: a number, 0 or more' : 'Needs its cost') + '</span>'; continue; }
        const got = n === null ? 0 : round(n, 2);
        if (got > 0) {
          any = true; total += got * round(c, 2); gets.push(got + ' cs ' + l.product);
          const after = p ? avgAfter(owned(p), Number(p.avgCost), got, round(c, 2)) : null;
          if (cell) cell.innerHTML = p ? money(p.avgCost) + ' → <b>' + money(after) + '</b>' : '';
        } else if (cell) cell.innerHTML = '<span class="muted">None came</span>';
        if (got < Number(l.cases)) short.push(l.product + ' ' + plural(round(Number(l.cases) - got, 2), 'case') + ' short');
      }
      const sum = $('wha-sum');
      if (sum) sum.textContent = noCost.length ? 'Type what ' + noCost.join(' and ') + ' cost per case.'
        : bad ? 'Cases received are a number, 0 or more.'
        : !any ? 'Nothing came in: cancel the order instead.'
        : po.location + ' gets ' + gets.join(' and ') + ' (' + money(total) + ').' + (short.length ? ' ' + short.join('; ') + ': the order closes as received, so order the rest again if it is still needed.' : '');
      const go = $('wha-go');
      if (go) go.disabled = bad || !any;
    }
    function poDoneHtml(po) {
      return '<div class="card-head"><h2>' + esc(po.number) + '</h2>' + statusTag(po.status) + '</div>' +
        '<p class="muted" style="margin:0">' + esc(po.supplier + ' · to ' + po.location + ' · ordered by ' + po.createdBy + ', ' + when(po.createdAt) +
          (po.closedAt ? ' · ' + po.status + ' by ' + po.closedBy + ', ' + when(po.closedAt) : '')) + '</p>' +
        (po.note ? '<p class="note-box" style="margin:0">' + esc(po.note) + '</p>' : '') +
        '<div class="scroll"><table><thead><tr><th>Product</th><th>Ordered</th><th>Received</th><th>Cost / cs</th></tr></thead><tbody>' +
        po.lines.map(l => '<tr><td><b>' + esc(l.product) + '</b></td><td>' + Number(l.cases) + ' cs</td><td>' + (l.casesReceived == null ? '<span class="muted">-</span>' : Number(l.casesReceived) + ' cs') + '</td>' +
          '<td>' + (l.costReceived == null ? (l.cost == null ? '<span class="muted">-</span>' : money(l.cost) + ' <span class="muted">expected</span>') : money(l.costReceived)) + '</td></tr>').join('') +
        '</tbody></table></div>';
    }
    function transferHtml(t) {
      const open = t.status === 'in_transit';
      return '<div class="card-head"><h2>' + (open ? 'Receive ' : '') + esc(t.number) + '</h2>' + statusTag(t.status) + '</div>' +
        '<p class="muted" style="margin:0">' + esc(t.from + ' to ' + t.to + ' · sent by ' + t.sentBy + ', ' + when(t.sentAt) +
          (t.closedAt ? ' · received by ' + t.closedBy + ', ' + when(t.closedAt) : '')) + '</p>' +
        (t.note ? '<p class="note-box" style="margin:0">' + esc(t.note) + '</p>' : '') +
        '<div class="scroll"><table><thead><tr><th>Product</th><th>Cases</th></tr></thead><tbody>' +
        t.lines.map(l => '<tr><td><b>' + esc(l.product) + '</b></td><td>' + Number(l.cases) + ' cs</td></tr>').join('') + '</tbody></table></div>' +
        (open ? '<div class="row-between" style="margin-top:0"><span class="muted">It left ' + esc(t.from) + ' when it was sent; receiving puts it in ' + esc(t.to) + '.</span>' +
          '<button type="button" class="btn primary big" data-wh="tr-receive">Receive at ' + esc(t.to) + '</button></div>' : '');
    }
    function blankLine() { return { productId: '', cases: '', cost: '' }; }
    function poFormHtml() {
      const f = W.inc.po, d = D();
      const sups = d.suppliers.filter(s => s.active || s.id === f.supplierId), locs = d.locations.filter(l => l.active || l.id === f.locationId);
      const to = d.locations.find(l => l.id === Number(f.locationId));
      const prods = d.products.filter(p => p.active && (fits(p, to) || f.lines.some(l => Number(l.productId) === p.id)));
      if (!sups.length || !locs.length || !prods.length) {
        return '<h2>New vendor order</h2>' + emptyHtml('First add ' + [!sups.length && 'a supplier (below)', !locs.length && 'a place (on <button type="button" class="linkbtn" data-nav="wh-places">Places</button>)',
          !prods.length && 'an item kept there (on <button type="button" class="linkbtn" data-nav="wh-items">Items</button>)'].filter(Boolean).join(', ') + '.');
      }
      return '<h2>' + (f.id ? 'Edit ' + esc(f.number) : 'New vendor order') + '</h2>' +
        '<div class="grid2"><label class="field">Supplier' + selectHtml('data-whpo="supplierId"', f.supplierId, sups.map(s => [s.id, s.name]), 'Choose a supplier') + '</label>' +
        '<label class="field">Goes to' + selectHtml('data-whpo="locationId"', f.locationId, locs.map(l => [l.id, l.name]), 'Choose a location') + '</label></div>' +
        '<div class="scroll"><table><thead><tr><th>Product</th><th>Cases</th><th>Expected cost / cs</th><th></th></tr></thead><tbody>' +
        f.lines.map((l, i) => '<tr><td style="min-width:220px">' + selectHtml('data-whpol="' + i + '" data-k="productId"', l.productId, prods.map(p => [p.id, p.name + (p.pack ? ' · ' + p.pack : '')]), 'Choose a product') + '</td>' +
          '<td style="min-width:90px">' + inputHtml('data-whpol="' + i + '" data-k="cases" aria-label="Cases, line ' + (i + 1) + '"', l.cases) + '</td>' +
          '<td style="min-width:120px">' + inputHtml('data-whpol="' + i + '" data-k="cost" aria-label="Expected cost per case, line ' + (i + 1) + '"', l.cost, ' placeholder="Optional"') + '</td>' +
          '<td><button type="button" class="linkbtn" data-whpodrop="' + i + '">Remove</button></td></tr>').join('') + '</tbody></table></div>' +
        '<div><button type="button" class="btn small" data-wh="po-addline">' + PLUS + 'Add a line</button></div>' +
        '<label class="field">Note<input data-whpo="note" value="' + esc(f.note) + '" maxlength="300" placeholder="Optional"></label>' +
        '<div class="row-between" style="margin-top:0"><span class="muted" id="whpo-sum"></span><div class="actions" style="align-items:center">' +
        '<button type="button" class="linkbtn" data-wh="form-cancel">Cancel</button>' +
        '<button type="button" class="btn primary big" data-wh="po-save" id="whpo-go">Save the order</button></div></div>';
    }
    function poPayload() {
      const f = W.inc.po;
      const out = { supplierId: Number(f.supplierId) || null, locationId: Number(f.locationId) || null, note: f.note,
        lines: f.lines.filter(l => l.productId || num(l.cases) !== null).map(l => {
          const line = { productId: Number(l.productId) || null, cases: num(l.cases) };
          const c = num(l.cost);
          if (c !== null) line.cost = c;
          return line;
        }) };
      if (f.id) { out.id = f.id; out.version = f.version; }
      return out;
    }
    function updatePoForm() {
      const p = poPayload(), go = $('whpo-go'), sum = $('whpo-sum');
      const problems = [];
      if (!p.supplierId) problems.push('choose a supplier');
      if (!p.locationId) problems.push('choose where it goes');
      if (!p.lines.length) problems.push('add a product');
      if (p.lines.some(l => !l.productId)) problems.push('choose each line\'s product');
      if (p.lines.some(l => l.cases === null || isNaN(l.cases) || l.cases <= 0)) problems.push('give each line its cases');
      if (p.lines.some(l => l.cost !== undefined && (isNaN(l.cost) || l.cost < 0))) problems.push('an expected cost is a dollar amount');
      const ids = p.lines.map(l => l.productId).filter(Boolean);
      if (new Set(ids).size !== ids.length) problems.push('each product once');
      if (sum) sum.textContent = problems.length ? upper(problems.join(', ')) + '.' : plural(p.lines.length, 'line') + ' to ' + locName(p.locationId) + '.';
      if (go) go.disabled = problems.length > 0;
    }
    function trFormHtml() {
      const f = W.inc.tr, d = D(), locs = activeLocs();
      if (locs.length < 2 || !d.products.length) {
        return '<h2>New transfer</h2>' + emptyHtml('A transfer needs two places and an item: add them on <button type="button" class="linkbtn" data-nav="wh-places">Places</button> and <button type="button" class="linkbtn" data-nav="wh-items">Items</button>.');
      }
      return '<h2>New transfer</h2>' +
        '<div class="grid2"><label class="field">From' + selectHtml('data-whtr="fromId"', f.fromId, locs.map(l => [l.id, l.name]), 'Choose a location') + '</label>' +
        '<label class="field">To' + selectHtml('data-whtr="toId"', f.toId, locs.filter(l => String(l.id) !== String(f.fromId)).map(l => [l.id, l.name]), 'Choose a location') + '</label></div>' +
        '<div class="scroll"><table><thead><tr><th>Product</th><th>Cases</th><th></th></tr></thead><tbody>' +
        f.lines.map((l, i) => '<tr><td style="min-width:240px">' + selectHtml('data-whtrl="' + i + '" data-k="productId"', l.productId,
            d.products.filter(p => p.active || stockAt(p, Number(f.fromId)) > 0).map(p => [p.id, p.name + (f.fromId ? ' · ' + stockAt(p, Number(f.fromId)) + ' cs there' : '')]), 'Choose a product') + '</td>' +
          '<td style="min-width:90px">' + inputHtml('data-whtrl="' + i + '" data-k="cases" aria-label="Cases, line ' + (i + 1) + '"', l.cases) + '</td>' +
          '<td><button type="button" class="linkbtn" data-whtrdrop="' + i + '">Remove</button></td></tr>').join('') + '</tbody></table></div>' +
        '<div><button type="button" class="btn small" data-wh="tr-addline">' + PLUS + 'Add a line</button></div>' +
        '<p class="err" id="whtr-err" role="alert" hidden></p>' +
        '<label class="field">Note<input data-whtr="note" value="' + esc(f.note) + '" maxlength="300" placeholder="Optional"></label>' +
        '<div class="row-between" style="margin-top:0"><span class="muted" id="whtr-sum"></span><div class="actions" style="align-items:center">' +
        '<button type="button" class="linkbtn" data-wh="form-cancel">Cancel</button>' +
        '<button type="button" class="btn primary big" data-wh="tr-send" id="whtr-go">Send the transfer</button></div></div>';
    }
    function trPayload() {
      const f = W.inc.tr;
      return { fromId: Number(f.fromId) || null, toId: Number(f.toId) || null, note: f.note,
        lines: f.lines.filter(l => l.productId || num(l.cases) !== null).map(l => ({ productId: Number(l.productId) || null, cases: num(l.cases) })) };
    }
    function updateTrForm() {
      const p = trPayload(), go = $('whtr-go'), sum = $('whtr-sum'), err = $('whtr-err');
      const problems = [];
      if (!p.fromId || !p.toId) problems.push('choose both locations');
      if (p.fromId && p.fromId === p.toId) problems.push('pick two different locations');
      if (!p.lines.length) problems.push('add a product');
      if (p.lines.some(l => !l.productId)) problems.push('choose each line\'s product');
      if (p.lines.some(l => l.cases === null || isNaN(l.cases) || l.cases <= 0)) problems.push('give each line its cases');
      const ids = p.lines.map(l => l.productId).filter(Boolean);
      if (new Set(ids).size !== ids.length) problems.push('each product once');
      const over = p.fromId ? transferProblems(D().products, p.fromId, W.inc.tr.lines) : [];
      document.querySelectorAll('[data-whtrl][data-k="cases"]').forEach(b => b.setAttribute('aria-invalid', String(over.some(o => o.i === Number(b.getAttribute('data-whtrl'))))));
      if (err) {
        err.hidden = !over.length;
        err.textContent = over.map(o => locName(p.fromId) + ' has ' + cs(o.have) + ' of ' + o.product + '.').join(' ') + (over.length ? ' If that\'s wrong, count it first: Inventory, Count a location.' : '');
      }
      if (sum) sum.textContent = problems.length ? upper(problems.join(', ')) + '.' : over.length ? '' : 'Leaves ' + locName(p.fromId) + ' now, and shows in transit until ' + locName(p.toId) + ' receives it.';
      if (go) go.disabled = problems.length > 0 || over.length > 0;
    }

    // ---- Items (schema v20): like a store's Items page ----
    const canSend = () => !!(host.hq && host.hq() && host.CE);
    function listCardHtml(kind, title, help, rows) {
      return '<section class="card" style="padding:18px 20px" aria-label="' + title + '"><h2 style="font-size:16px">' + title + '</h2>' +
        '<p class="help" style="margin-top:4px">' + help + '</p>' +
        '<div class="chips">' + (rows.length ? rows.map(r => '<button type="button" class="chip" data-whtoggle="' + kind + '" data-id="' + r.id + '" aria-pressed="' + r.active + '">' + CHECK + esc(r.name) + '</button>').join('')
          : '<span class="muted">None yet.</span>') + '</div>' +
        '<div style="margin-top:12px;display:flex;flex-wrap:wrap;gap:8px"><input class="text" id="whadd-' + kind + '" maxlength="60" placeholder="Supplier name" aria-label="New ' + kind + ' name" style="height:40px;font-size:14px;flex:1 1 160px">' +
        '<button type="button" class="btn small" data-whadd="' + kind + '" style="height:40px">Add</button></div></section>';
    }
    const ownAt = p => activeLocs().some(l => placeKind(l) === 'own' && fits(p, l));
    function itemDraft(p) {
      if (!p) return { id: null, name: '', pack: '', concept: '', fee: '0.00', par: 0, active: true, limit: false, stores: [], places: [] };
      return { id: p.id, version: p.version, name: p.name, pack: p.pack, concept: p.concept || '', fee: Number(p.handlingFee).toFixed(2), par: Number(p.par),
               active: p.active, limit: p.stores.length > 0, stores: p.stores.slice(),
               places: D().locations.filter(l => fits(p, l) || stockAt(p, l.id) > 0).sort((a, b) => a.id - b.id)
                 .map(l => ({ locationId: l.id, low: String(lowAt(p, l.id)), now: String(stockAt(p, l.id)), reason: '' })) };
    }
    function itemList() {
      const f = W.items, q = lcs(f.q).trim(), at = f.place ? D().locations.find(l => l.id === Number(f.place)) : null;
      return D().products.filter(p => (f.filter === 'inactive' ? !p.active : f.filter === 'low' ? p.active && activeLocs().some(l => isLow(p, l)) : p.active))
        .filter(p => !q || lcs(p.name).indexOf(q) >= 0)
        .filter(p => !at || fits(p, at))
        .filter(p => !f.concept || !p.concept || p.concept === f.concept)
        .sort((a, b) => a.name.localeCompare(b.name));
    }
    const itemPrice = p => (ownAt(p) ? money(storePrice(p.avgCost, p.handlingFee, D().settings.markupPct)) + ' / cs' : 'No Happy Supply price');
    function renderItems() {
      const d = D(), f = W.items, list = itemList();
      if (f.sel !== 'new' && f.sel != null && !prodBy(f.sel)) { f.sel = null; f.draft = null; }
      if (f.sel == null && list.length) f.sel = list[0].id;
      if (f.sel != null && !f.draft) f.draft = itemDraft(f.sel === 'new' ? null : prodBy(f.sel));
      let html = '<div class="card toolbar">' + searchHtml('data-whitq="1"', f.q) +
        selectHtml('data-whitp="1" aria-label="Place"', f.place, [['', 'All places']].concat(placeList().map(l => [l.id, l.name]))) +
        selectHtml('data-whitc="1" aria-label="Concept"', f.concept, conceptOpts('All concepts')) +
        pillsHtml('data-whitfl', f.filter, [['active', 'Active · ' + d.products.filter(p => p.active).length], ['low', 'Low · ' + lowList().length],
                                            ['inactive', 'Inactive · ' + d.products.filter(p => !p.active).length]]) + '</div>';
      html += '<div class="cols"><section class="card list-card" style="flex:1 1 440px" aria-label="Items">' +
        (list.length ? list.map(p => '<button type="button" class="lrow" data-whitsel="' + p.id + '"' + (p.id === f.sel ? ' aria-current="true"' : '') + '>' +
          '<span class="t"><span class="n">' + esc(p.name) + (activeLocs().some(l => isLow(p, l)) ? ' <span class="tag warn">Low</span>' : '') + '</span>' +
          '<span class="s">' + esc([p.pack, placeList().filter(l => fits(p, l)).map(l => l.name).join(', ') || 'At no place yet'].filter(Boolean).join(' · ')) + '</span></span>' +
          '<span class="at" style="text-align:right"><b style="color:var(--ink);font-size:15px">' + placeTotal(p) + ' cs</b><br>' + esc(itemPrice(p)) + '</span></button>').join('')
          : '<div class="list-foot">' + (d.products.length ? 'Nothing here.' : 'No items yet: add the first one.') + '</div>') + '</section>';
      html += '<section class="card panel" style="flex:1 1 420px" aria-labelledby="whit-ph">' + (f.draft ? itemPanelHtml() : '<p class="muted" style="margin:0">Pick an item, or add one.</p>') + '</section></div>';
      if (f.send && f.send.productId !== f.sel) f.send = null;
      if (f.send) html += sendHtml();
      html += settingsHtml();
      $('whit-body').innerHTML = html;
      if (f.draft) updateItemPanel();
      if (f.send) updateSend();
    }
    function settingsHtml() {
      const d = D();
      return '<section class="card" aria-labelledby="whs-h" style="padding:18px 20px"><h2 id="whs-h" style="font-size:16px">For every store</h2>' +
        '<p class="help" style="margin-top:4px">Both 0 to start. A store\'s price per case is the average cost plus the handling fee, plus the markup. Stores never see the fee.</p>' +
        '<div class="grid2" style="margin-top:10px;max-width:520px"><label class="field">Markup %<input id="whs-pct" class="text" inputmode="decimal" value="' + esc(String(Number(d.settings.markupPct))) + '"></label>' +
        '<label class="field">Delivery fee / order<input id="whs-fee" class="text" inputmode="decimal" value="' + esc(Number(d.settings.deliveryFee).toFixed(2)) + '"></label></div>' +
        '<div class="actions" style="margin-top:12px;justify-content:flex-end"><button type="button" class="btn" data-wh="settings-save">Save</button></div></section>';
    }
    function itemPanelHtml() {
      const f = W.items.draft, p = f.id ? prodBy(f.id) : null, d = D(), list = itemList();
      const concepts = Array.from(new Set(d.stores.map(x => x.concept).filter(Boolean)));
      const rows = f.places.map(x => {
        const l = d.locations.find(y => y.id === x.locationId), have = p ? stockAt(p, x.locationId) : 0, nm = l ? l.name : '?';
        return '<tr><td><b>' + esc(nm) + '</b><div class="muted" style="font-size:12px">' + esc(placeSub(l)) + '</div></td>' +
          '<td style="width:96px">' + inputHtml('data-whitn="' + x.locationId + '" aria-label="' + esc(nm) + ' now, cases"', x.now) + '</td>' +
          '<td style="width:96px">' + inputHtml('data-whitl="' + x.locationId + '" aria-label="' + esc(nm) + ' low point, cases"', x.low) + '</td>' +
          '<td style="width:36px">' + (have > 0 ? '' : '<button type="button" class="linkbtn" data-whitx="' + x.locationId + '" aria-label="Take it off ' + esc(nm) + '">✕</button>') + '</td></tr>' +
          '<tr id="whitr-' + x.locationId + '" hidden><td colspan="4"><input class="cell-in" data-whitr="' + x.locationId + '" aria-label="Why ' + esc(nm) + ' changed" ' +
          'placeholder="Why it\'s different (Sunday count, damaged…)" value="' + esc(x.reason) + '" maxlength="200"></td></tr>';
      }).join('');
      const addable = placeList().filter(l => !f.places.some(x => x.locationId === l.id));
      const stores = d.stores.slice().sort((a, b) => (a.isTest - b.isTest));
      return '<div class="card-head"><h2 id="whit-ph">' + (p ? esc(p.name) : 'New item') + '</h2>' + (p && list.indexOf(p) >= 0 ? '<span class="muted">Item ' + (list.indexOf(p) + 1) + ' of ' + list.length + '</span>' : '') + '</div>' +
        '<label class="field">Name<input data-whitf="name" value="' + esc(f.name) + '" maxlength="120" placeholder="Exactly as the stores name it"></label>' +
        '<div class="grid2"><label class="field">Pack<input data-whitf="pack" value="' + esc(f.pack) + '" maxlength="60" placeholder="e.g. CASE (10LBs)"></label>' +
        '<label class="field">Concept' + selectHtml('data-whitf="concept"', f.concept, [['', 'Every concept']].concat(concepts.map(k => [k, host.conceptName ? host.conceptName(k) : k]))) + '</label></div>' +
        '<div role="group" aria-labelledby="whit-pl"><div class="chips-label" id="whit-pl">Places</div>' +
        '<div class="scroll"><table><thead><tr><th>Place</th><th>Now (cs)</th><th>Low point</th><th><span class="sr">Take off</span></th></tr></thead><tbody>' +
        (rows || '<tr><td colspan="4" class="muted">At no place yet: add it to one.</td></tr>') + '</tbody></table></div>' +
        (addable.length ? '<div style="margin-top:8px">' + selectHtml('data-whitadd="1" aria-label="Add to a place"', '', addable.map(l => [l.id, l.name]), '+ Add to a place') + '</div>' : '') +
        '<p class="help" style="margin-top:6px">Changing Now saves a count for that place and asks why. Below its low point, the Stock page turns it amber.</p></div>' +
        '<div class="note-box" id="whit-price"></div>' +
        '<label class="field" style="max-width:200px">Handling fee / cs<input data-whitf="fee" value="' + esc(f.fee) + '" inputmode="decimal"></label>' +
        '<div role="group" aria-labelledby="whit-who"><div class="chips-label" id="whit-who">Which stores can order it</div>' +
        '<div class="seg" style="display:inline-flex;margin-top:8px"><button type="button" data-whitlim="0" aria-pressed="' + !f.limit + '">Every store</button>' +
        '<button type="button" data-whitlim="1" aria-pressed="' + f.limit + '">Only these</button></div>' +
        (f.limit ? '<div class="chips">' + stores.map(x => '<button type="button" class="chip" data-whitst="' + esc(x.slug) + '" aria-pressed="' + (f.stores.indexOf(x.slug) >= 0) + '">' + CHECK +
          esc((x.location || x.slug) + (x.isTest && !/\(TEST\)\s*$/.test(x.location || '') ? ' (TEST)' : '')) + '</button>').join('') + '</div>' : '') + '</div>' +
        '<label class="check"><input type="checkbox" data-whitf="active"' + (f.active ? ' checked' : '') + '>Active: on counts and vendor orders</label>' +
        '<div class="row-between" style="margin-top:0"><span class="muted" id="whit-sum"></span><div class="actions" style="align-items:center">' +
        (p ? '' : '<button type="button" class="linkbtn" data-wh="item-discard">Cancel</button>') +
        (p && p.active && canSend() && !W.items.send && ownAt(p) ? '<button type="button" class="btn" data-wh="send-open">Send to stores</button>' : '') +
        '<button type="button" class="btn primary" data-wh="item-save" id="whit-go">Save</button></div></div>';
    }
    function updateItemPanel() {
      const f = W.items.draft, p = f.id ? prodBy(f.id) : null, d = D(), pct = Number(d.settings.markupPct), fee = num(f.fee);
      const own = f.places.some(x => placeKind(d.locations.find(l => l.id === x.locationId)) === 'own');
      const box = $('whit-price');
      if (box) {
        const avg = p ? Number(p.avgCost) : 0;
        box.innerHTML = '<div class="row-between" style="margin:0"><span>Cost per case</span><b>' + (p && p.lastReceipt ? money(avg) : 'No deliveries yet') + '</b></div>' +
          '<div class="muted" style="font-size:12px;margin-top:2px">' + (p && p.lastReceipt ? 'From deliveries; last one ' + esc(p.lastReceipt.ref) + ', ' + esc(day(p.lastReceipt.at)) + '. Not typed here.' : 'Set by the first delivery received. Not typed here.') + '</div>' +
          (own ? '<div class="row-between" style="margin:10px 0 0"><span>Store price / cs</span><b>' + (fee === null || isNaN(fee) || fee < 0 ? '-' : money(storePrice(avg, round(fee, 2), pct))) + '</b></div>' +
                 '<div class="muted" style="font-size:12px;margin-top:2px">Average ' + money(avg) + ' + fee, markup ' + pct + '%. Locked on each line when it ships.</div>'
               : '<div class="muted" style="font-size:12px;margin-top:8px">Not at Happy Supply\'s own places: stores take it from where it sits, and the cost is kept for the monthly charges.</div>');
      }
      const problems = [];
      if (!String(f.name).trim()) problems.push('give it a name');
      if (fee === null || isNaN(fee) || fee < 0) problems.push('the handling fee is a dollar amount');
      if (f.limit && !f.stores.length) problems.push('pick at least one store, or choose Every store');
      if (!f.places.length) problems.push('add it to a place');
      for (const x of f.places) {
        const l = d.locations.find(y => y.id === x.locationId), n = num(x.now), lo = num(x.low), have = p ? stockAt(p, x.locationId) : 0;
        const changed = n !== null && !isNaN(n) && n >= 0 && round(n, 2) !== have, row = $('whitr-' + x.locationId);
        if (row) row.hidden = !changed;
        if (n !== null && (isNaN(n) || n < 0)) problems.push(l.name + '\'s Now is a number of cases');
        if (lo !== null && (isNaN(lo) || lo < 0)) problems.push(l.name + '\'s low point is a number of cases');
        if (changed && !String(x.reason || '').trim()) problems.push('say why ' + l.name + ' changed');
      }
      const sum = $('whit-sum'), go = $('whit-go');
      if (sum) sum.textContent = problems.length ? upper(problems.join('; ')) + '.' : '';
      if (go) go.disabled = problems.length > 0;
    }
    // ---- Orders (schema v16) ----
    const orders = () => D().orders || [];
    const sentCount = () => orders().filter(o => o.status === 'sent').length;
    const storeShort = o => String(o.store || o.slug) + (o.isTest && !/\(TEST\)\s*$/.test(o.store || '') ? ' (TEST)' : '');
    function orderList() {
      const f = W.ord.filter, list = orders().filter(o => o.status === f);
      if (f === 'sent') return list.sort((a, b) => (String(a.neededBy || '9999') < String(b.neededBy || '9999') ? -1 : String(a.neededBy || '9999') > String(b.neededBy || '9999') ? 1 : 0) ||
                                                  (a.sentAt < b.sentAt ? -1 : a.sentAt > b.sentAt ? 1 : a.id - b.id));
      return list.sort((a, b) => b.id - a.id);
    }
    const dayOf = ymd => (ymd ? day(ymd + 'T12:00:00') : '');
    function orderMeta(o) {
      const n = plural(o.lines.length, 'line');
      if (o.status === 'sent') return (o.neededBy ? 'Needed by ' + dayOf(o.neededBy) + ' · ' : '') + n + ' · sent' + (o.sentBy ? ' by ' + o.sentBy : '') + ', ' + when(o.sentAt);
      if (o.status === 'shipped') return 'Shipped ' + when(o.shippedAt) + ' · ' + n + ' · waiting for the store to mark it received';
      if (o.status === 'received') return 'Received ' + when(o.receivedAt) + (o.receivedBy ? ' by ' + o.receivedBy : '') + ' · ' + n;
      return 'Cancelled ' + when(o.cancelledAt) + (o.cancelledBy ? ' by ' + o.cancelledBy : '');
    }
    // Under the product: the store's own name for it, when it differs, and the pack.
    const lineSub = l => [String(l.name || '').toLowerCase() !== String(l.product || '').toLowerCase() ? 'Store calls it ' + l.name : '', l.pack].filter(Boolean).join(' · ');
    function orderTag(s) {
      const t = { sent: ['Sent', 'blue'], shipped: ['Shipped', ''], received: ['Received', 'ok'], cancelled: ['Cancelled', ''] }[s] || [s, ''];
      return '<span class="tag' + (t[1] ? ' ' + t[1] : '') + '">' + t[0] + '</span>';
    }
    function selectOrder(id) {
      W.ord.sel = id; W.ord.rows = {};
      const o = orders().find(x => x.id === id);
      if (o && o.status === 'sent') {
        for (const r of shipPrefill(orders(), D().products, o, heldLocs().map(l => l.id))) W.ord.rows[r.ord] = { cases: String(r.cases), locationId: r.locationId == null ? '' : String(r.locationId) };
      }
    }
    function renderOrders() {
      const list = orderList();
      if (!list.some(o => o.id === W.ord.sel)) selectOrder(list.length ? list[0].id : null);
      const count = s => orders().filter(o => o.status === s).length;
      let html = '<div class="actions" role="group" aria-label="Show">' +
        [['sent', 'Sent · ' + count('sent')], ['shipped', 'Shipped · ' + count('shipped')], ['received', 'Received'], ['cancelled', 'Cancelled']].map(f =>
          '<button type="button" class="pill" data-whordf="' + f[0] + '" aria-pressed="' + (W.ord.filter === f[0]) + '">' + f[1] + '</button>').join('') + '</div>';
      html += '<div class="cols"><section class="card list-card" style="flex:1 1 320px" aria-label="Store orders">' +
        (list.length ? list.map(o => '<button type="button" class="lrow" data-whosel="' + o.id + '"' + (o.id === W.ord.sel ? ' aria-current="true"' : '') + '>' +
          '<span class="t"><span class="n">' + esc(storeShort(o) + ' · ' + o.number) + '</span><span class="s">' + esc(orderMeta(o)) + '</span></span>' + orderTag(o.status) + '</button>').join('')
          : '<div class="list-foot">' + (W.ord.filter === 'sent' ? 'No orders waiting. A store\'s Send to Happy Supply lands here.' : 'None yet.') + '</div>') + '</section>';
      html += '<section class="card panel focus" style="flex:2 1 560px" aria-label="Order">' + orderPanelHtml() + '</section></div>';
      html += stockCardHtml();
      $('who-body').innerHTML = html;
      updateShip();
    }
    function orderPanelHtml() {
      const o = orders().find(x => x.id === W.ord.sel);
      if (!o) return emptyHtml('Pick an order.');
      const head = '<div class="card-head"><h2>' + esc(storeShort(o)) + '</h2><span class="muted">' + esc(o.number + ' · ' + orderMeta(o)) + '</span></div>' +
        (o.note ? '<p class="note-box" style="margin:0">“' + esc(o.note) + '”</p>' : '');
      if (o.status !== 'sent') {
        return head + '<div class="scroll"><table><thead><tr><th>Product</th><th>Ordered</th><th>Shipped</th><th>From</th><th>Received</th><th>Price / cs</th></tr></thead><tbody>' +
          o.lines.map(l => '<tr><td><b>' + esc(l.product) + '</b><div class="muted" style="font-size:13px">' + esc(lineSub(l)) + '</div></td>' +
            '<td>' + esc(cs(l.cases)) + '</td><td>' + (l.casesShipped == null ? '<span class="muted">-</span>' : esc(cs(l.casesShipped))) + '</td>' +
            '<td>' + esc(l.location || '-') + '</td><td>' + (l.casesReceived == null ? '<span class="muted">-</span>' : esc(cs(l.casesReceived)) +
              (Number(l.casesReceived) < Number(l.casesShipped) ? ' <span class="tag warn">Short</span>' : '')) + '</td>' +
            '<td>' + (l.price == null ? '<span class="muted">-</span>' : money(l.price)) + '</td></tr>').join('') + '</tbody></table></div>' +
          (o.status === 'shipped' || o.status === 'received'
            ? '<div class="row-between"><span class="muted">' + (o.deliveryFee ? 'Delivery fee ' + money(o.deliveryFee) + '. ' : '') + 'Prices fixed when it shipped.</span><b>' +
              money(o.lines.reduce((t, l) => t + Number(l.casesShipped || 0) * Number(l.price || 0), 0) + Number(o.deliveryFee || 0)) + '</b></div>' : '');
      }
      const pre = shipPrefill(orders(), D().products, o, heldLocs().map(l => l.id)), pct = Number(D().settings.markupPct);
      return head + '<div class="scroll"><table><thead><tr><th>Product</th><th>Ordered</th><th>Ship</th><th>From</th><th>Left after</th><th>Price / cs</th></tr></thead><tbody>' +
        o.lines.map((l, i) => {
          const p = prodBy(l.productId), r = W.ord.rows[l.ord] || {}, x = pre[i];
          const locs = ownLocs().map(lc => [lc.id, lc.name + ' · ' + Number(p ? stockAt(p, lc.id) : 0) + ' cs']);
          const short = x.cases < Number(l.cases)
            ? '<tr class="sub"><td colspan="6"><p class="note-box warn" style="margin:0">Short: ' + Number(x.cases) + ' of ' + Number(l.cases) + '.' +
              (x.held ? ' ' + esc(x.olderOrders.join(', ')) + ' (older) take' + (x.olderOrders.length === 1 ? 's' : '') + ' ' + Number(x.held) + '. The store was told "Only ' + Number(x.left) + ' available". Ship more and the older order gets less.' : ' That\'s all there is.') + '</p></td></tr>' : '';
          return '<tr><td><b>' + esc(l.product) + '</b><div class="muted" style="font-size:13px">' + esc(lineSub(l)) + '</div></td>' +
            '<td><b>' + esc(cs(l.cases)) + '</b></td>' +
            '<td style="min-width:90px">' + inputHtml('data-whship="' + l.ord + '" aria-label="' + esc(l.product) + ' cases to ship"', r.cases) + '</td>' +
            '<td style="min-width:180px">' + selectHtml('data-whfrom="' + l.ord + '" aria-label="Ship ' + esc(l.product) + ' from"', r.locationId, locs, 'Pick a location') + '</td>' +
            '<td id="whleft-' + l.ord + '"></td><td>' + (p ? money(storePrice(p.avgCost, p.handlingFee, pct)) : '-') + '</td></tr>' + short;
        }).join('') + '</tbody></table></div>' +
        '<div class="row-between"><button type="button" class="linkbtn" data-wh="ord-cancel">Cancel order</button>' +
        '<div class="actions" style="align-items:center"><span class="muted" id="whship-sum"></span>' +
        '<button type="button" class="btn primary big" data-wh="ord-ship" id="whship-go">Ship</button></div></div>';
    }
    // What's left, the summary and whether Ship can go, without redrawing the boxes.
    function updateShip() {
      const o = orders().find(x => x.id === W.ord.sel);
      if (!o || o.status !== 'sent') return;
      const pct = Number(D().settings.markupPct), problems = [];
      let n = 0, total = 0, ordered = 0;
      for (const l of o.lines) {
        const r = W.ord.rows[l.ord] || {}, c = num(r.cases), p = prodBy(l.productId), cell = $('whleft-' + l.ord);
        const box = document.querySelector('[data-whship="' + l.ord + '"]');
        const bad = c !== null && (isNaN(c) || c < 0 || c > Number(l.cases));
        if (box) box.setAttribute('aria-invalid', String(bad));
        ordered += Number(l.cases);
        if (bad) { problems.push(isNaN(c) || c < 0 ? 'a number of cases, 0 or more' : l.product + ': at most ' + cs(l.cases)); if (cell) cell.innerHTML = '<span class="bad">-</span>'; continue; }
        const cases = c === null ? 0 : round(c, 2), loc = r.locationId ? Number(r.locationId) : null;
        if (cases > 0 && !loc) problems.push('where ' + l.product + ' ships from');
        const after = p && loc ? round(stockAt(p, loc) - cases, 2) : null;
        if (after !== null && after < 0) problems.push(locName(loc) + ' has ' + cs(stockAt(p, loc)) + ' of ' + l.product);
        if (cell) cell.innerHTML = after === null ? '<span class="muted">-</span>' : (after < 0 ? '<span class="bad">' + esc(cs(after)) + '</span>'
          : esc(cs(after) + ' at ' + locName(loc)) + (p && Number(p.par) > 0 && owned(p) - cases < Number(p.par) ? ' <span class="tag warn">Below par</span>' : ''));
        n += cases;
        if (p) total += cases * storePrice(p.avgCost, p.handlingFee, pct);
      }
      if (!problems.length && n === 0) problems.push('ship at least one case, or cancel the order');
      const sum = $('whship-sum'), go = $('whship-go');
      if (sum) sum.innerHTML = problems.length ? esc(upper(problems.join('; ')) + '.') : 'Ships ' + esc(String(round(n, 2))) + ' of ' + esc(cs(ordered)) + ' · <b>' + money(round(total, 2)) + '</b> to ' + esc(storeShort(o));
      if (go) go.disabled = problems.length > 0;
    }
    function stockCardHtml() {
      const d = D(), locs = ownLocs(), held = {};
      for (const o of orders()) if (o.status === 'sent') for (const l of o.lines) held[l.productId] = round((held[l.productId] || 0) + Number(l.cases), 2);
      const prods = d.products.filter(p => p.active && ownAt(p));
      if (!prods.length) return '';
      return '<section class="card" aria-labelledby="whos-h"><div class="card-head"><h2 id="whos-h">Stock and open orders</h2>' +
        '<button type="button" class="linkbtn" data-nav="wh-stock">Stock</button></div>' +
        '<div class="scroll"><table><thead><tr><th>Product</th>' + locs.map(l => '<th>' + esc(l.name) + '</th>').join('') + '<th>Ordered</th><th>Low points</th></tr></thead><tbody>' +
        prods.map(p => { const have = locs.reduce((t, l) => t + stockAt(p, l.id), 0), want = held[p.id] || 0;
          return '<tr><td><b>' + esc(p.name) + '</b>' + (want > have ? ' <span class="tag warn">' + round(want - have, 2) + ' short</span>' : '') + '</td>' +
            locs.map(l => '<td>' + stockAt(p, l.id) + '</td>').join('') + '<td>' + want + '</td><td class="muted">' + locs.reduce((t, l) => t + lowAt(p, l.id), 0) + '</td></tr>'; }).join('') +
        '</tbody></table></div><p class="help" style="margin-top:10px">Ordered: sent by stores, not shipped yet. Stores see what\'s left as "available".</p></section>';
    }

    // ---- Places (schema v20): like a store's Vendors page ----
    const KIND_TEXT = { own: 'HEH\'s own', store: 'Held at a store', vendor: 'Held by a vendor' };
    const placeItems = l => D().products.filter(p => fits(p, l) || stockAt(p, l.id) > 0);
    function placeDraft(l) {
      if (!l) return { id: null, name: '', kind: 'own', heldBy: '', heldStore: '', countHow: '', active: true };
      return { id: l.id, name: l.name, kind: placeKind(l), heldBy: l.heldBy || '', heldStore: l.heldStore || '', countHow: l.countHow || '', active: l.active };
    }
    // The stores that take from a held place: each one whose vendor HQ's name maps to.
    function placeTakers(l) {
      if (placeKind(l) === 'own') return null;
      return D().stores.filter(x => x.slug !== l.heldStore && host.linkFor && host.linkFor(x.slug, l.heldBy)).map(x => x.location || x.slug);
    }
    function renderPlaces() {
      const d = D(), f = W.places, list = placeList().concat(d.locations.filter(l => !l.active));
      if (f.sel !== 'new' && f.sel != null && !d.locations.some(l => l.id === f.sel)) { f.sel = null; f.draft = null; }
      if (f.sel == null && list.length) f.sel = list[0].id;
      if (f.sel != null && !f.draft) f.draft = placeDraft(f.sel === 'new' ? null : d.locations.find(l => l.id === f.sel));
      let html = '<div class="cols"><section class="card list-card" style="flex:1 1 440px" aria-label="Places">' +
        (list.length ? list.map(l => {
          const t = placeTakers(l), n = placeItems(l).length;
          const takes = t == null ? 'Stores order it from Happy Supply' : t.length ? 'Taken by ' + t.join(', ') + ' as "' + l.heldBy + '"' : 'No store takes from it yet';
          return '<button type="button" class="lrow" data-whplsel="' + l.id + '"' + (l.id === f.sel ? ' aria-current="true"' : '') + '><span class="t"><span class="n">' + esc(l.name) +
            (l.active ? '' : ' <span class="tag">Closed</span>') + '</span><span class="s">' + esc([placeSub(l), plural(n, 'item'), takes].join(' · ')) + '</span></span></button>';
        }).join('') : '<div class="list-foot">No places yet: add the first one.</div>') + '</section>';
      html += '<section class="card panel" style="flex:1 1 440px" aria-labelledby="whpl-ph">' + (f.draft ? placePanelHtml() : '<p class="muted" style="margin:0">Pick a place, or add one.</p>') + '</section></div>';
      const cur = f.sel !== 'new' ? d.locations.find(l => l.id === f.sel) : null;
      const linking = cur && placeKind(cur) !== 'own' && placeItems(cur).length > 0;
      if (linking) html += '<section class="card" aria-labelledby="whpl-st"><div class="card-head"><h2 id="whpl-st">Stores that take from ' + esc(cur.name) + '</h2></div>' + elLinksHtml(cur) + '</section>';
      $('whpl-body').innerHTML = html;
      if (f.draft) updatePlacePanel();
      if (linking) updateElLinks(cur);
    }
    function placePanelHtml() {
      const f = W.places.draft, d = D(), l = f.id ? d.locations.find(x => x.id === f.id) : null;
      const seg = (attr, val, opts) => '<div class="seg" style="display:inline-flex;flex-wrap:wrap;margin-top:8px">' + opts.map(o => '<button type="button" ' + attr + '="' + o[0] + '" aria-pressed="' + (val === o[0]) + '">' + esc(o[1]) + '</button>').join('') + '</div>';
      const how = f.countHow || (f.kind === 'own' ? 'hq' : f.kind === 'store' ? 'marginedge' : 'report');
      const names = (d.vendorNames || []).filter(n => lcs(n) !== 'happy supply');
      const items = l ? placeItems(l) : [];
      return '<div class="card-head"><h2 id="whpl-ph">' + (l ? esc(l.name) : 'New place') + '</h2></div>' +
        '<label class="field">Name<input data-whplf="name" value="' + esc(f.name) + '" maxlength="60" placeholder="e.g. RP Tysons"></label>' +
        '<div role="group" aria-labelledby="whpl-k"><div class="chips-label" id="whpl-k">Kind</div>' + seg('data-whplk', f.kind, ['own', 'store', 'vendor'].map(k => [k, KIND_TEXT[k]])) + '</div>' +
        (f.kind === 'store' ? '<label class="field">Held at' + selectHtml('data-whplf="heldStore"', f.heldStore,
            d.stores.map(x => [x.slug, (x.location || x.slug) + (x.isTest && !/\(TEST\)\s*$/.test(x.location || '') ? ' (TEST)' : '')]), 'Pick the store') + '</label>' : '') +
        (f.kind !== 'own' ? '<label class="field">Stores order it as' + selectHtml('data-whplf="heldBy"', f.heldBy, names.map(n => [n, n]), 'Pick the vendor name') +
          '<span class="muted" style="font-size:13px">' + (f.kind === 'store' ? 'The vendor the other stores order it from in their order guide, like "Transfer (Tysons)".'
            : 'The vendor that keeps it, as the stores name it, like "Elpis Wholesale".') + '</span></label>' : '') +
        '<div role="group" aria-labelledby="whpl-h"><div class="chips-label" id="whpl-h">How it\'s counted</div>' + seg('data-whplh', how, [['hq', HOW.hq], ['marginedge', HOW.marginedge], ['report', HOW.report]]) + '</div>' +
        (f.kind === 'store' ? '<div class="note-box"><div class="row-between" style="margin:0"><span>Gets its stock from</span><b>Happy Supply</b></div>' +
          '<div class="muted" style="font-size:12px;margin-top:2px">The store orders it from its Happy Supply; Dan ships it into this place, and it lands here when the store checks it in.</div></div>' : '') +
        (l ? '<div class="note-box"><div class="row-between" style="margin:0"><span>Items here</span><b>' + items.length + '</b></div>' +
          (items.length ? '<div class="muted" style="font-size:12px;margin-top:4px">' + esc(items.slice(0, 6).map(p => p.name + ' ' + stockAt(p, l.id) + (lowAt(p, l.id) ? ' (low point ' + lowAt(p, l.id) + ')' : '')).join(' · ') +
            (items.length > 6 ? ' and ' + (items.length - 6) + ' more' : '')) + '</div>' : '<div class="muted" style="font-size:12px;margin-top:4px">None yet: add items to it on Items.</div>') +
          '<button type="button" class="linkbtn" data-whitplace="' + l.id + '" style="margin-top:6px">Open in Items</button></div>' : '') +
        '<label class="check"><input type="checkbox" data-whplf="active"' + (f.active ? ' checked' : '') + '>Open: on counts and vendor orders</label>' +
        '<div class="row-between" style="margin-top:0"><span class="muted" id="whpl-sum"></span><div class="actions" style="align-items:center">' +
        (l ? '' : '<button type="button" class="linkbtn" data-wh="place-discard">Cancel</button>') +
        '<button type="button" class="btn primary" data-wh="place-save" id="whpl-go">Save</button></div></div>';
    }
    function updatePlacePanel() {
      const f = W.places.draft, problems = [];
      if (!String(f.name).trim()) problems.push('give it a name');
      if (f.kind === 'store' && !f.heldStore) problems.push('pick the store it sits at');
      if (f.kind !== 'own' && !f.heldBy) problems.push('pick the name stores order it under');
      const sum = $('whpl-sum'), go = $('whpl-go');
      if (sum) sum.textContent = problems.length ? upper(problems.join('; ')) + '.' : '';
      if (go) go.disabled = problems.length > 0;
    }
    // Linking stores to a held place's items, by name (catalogEdit.js
    // heldMatches / commitHqHeldLinks, v19): never the store holding it.
    const heldProds = loc => (loc ? D().products.filter(p => fits(p, loc)) : []);
    function heldStores(loc) {
      const prods = heldProds(loc), every = prods.some(p => !p.concept);
      const keys = every ? host.conceptKeys() : Array.from(new Set(prods.map(p => p.concept)));
      const out = [];
      for (const k of keys) for (const st of host.storesOf(k)) if (host.usable(st) && st.slug !== loc.heldStore && out.indexOf(st) < 0) out.push(st);
      return out.sort((a, b) => (a.isTest - b.isTest) || host.shortName(a).localeCompare(host.shortName(b)));
    }
    function heldStoreState(st, loc) {
      const prods = heldProds(loc).filter(p => !p.concept || p.concept === (st.concept || ''));
      const known = storeHs(st, loc.heldBy), picked = W.places.vend[st.slug], guess = guessVendor(st, loc.heldBy);
      const vend = known ? known.name : picked || guess || '';
      const ren = W.places.renames[st.slug] || {};
      const view = host.CE.heldMatches(st.tables, prods).map(x =>
        (x.status === 'missing' && ren[x.productId]) ? Object.assign({}, x, { status: 'rename', itemId: ren[x.productId] }) : x);
      return { st, prods, known, vend, view, linked: view.filter(x => x.status === 'linked').length,
               toLink: view.filter(x => x.status === 'match' || x.status === 'rename').length };
    }
    function heldPlan(loc) {
      if (!loc || !canSend()) return [];
      return heldStores(loc).map(st => heldStoreState(st, loc)).filter(x => x.vend && x.toLink > 0).map(x => {
        const ren = W.places.renames[x.st.slug] || {};
        const args = { vendorName: x.vend, products: x.prods.map(p => ({ id: p.id, name: p.name, pack: p.pack, via: loc.name })),
                       renames: Object.keys(ren).map(pid => ({ itemId: ren[pid], to: prodBy(pid).name })) };
        const links = [{ slug: x.st.slug, hqName: loc.heldBy, vendor: x.vend }];
        try { return { st: x.st, links, out: host.CE.call(x.st.tables, 'commitHqHeldLinks', [args]) }; }
        catch (err) { return { st: x.st, links, error: err.message }; }
      });
    }
    function elLinksHtml(loc) {
      if (!canSend()) return '<p class="help" style="margin:0">Linking stores changes their order guides, so it needs an HQ sign-in with the hq role.</p>';
      const states = heldStores(loc).map(st => heldStoreState(st, loc));
      const shown = states.filter(s => s.vend && s.prods.length), none = states.filter(s => !s.vend).map(s => host.shortName(s.st));
      return '<p class="help" style="margin:0">Linked by name: on each store\'s ' + esc(loc.heldBy) + ' list, an item named exactly like a product above is HEH\'s. One line per store; only what doesn\'t match needs you.</p>' +
        '<div class="el-lines">' + (shown.length ? shown.map(s => elStoreLine(s, loc)).join('') : '<p class="muted" style="margin:10px 0">No store here has a ' + esc(loc.heldBy) + ' vendor yet.</p>') +
        (none.length ? '<div class="muted" style="font-size:13px;padding:10px 0">No ' + esc(loc.heldBy) + ' vendor at ' + esc(none.join(', ')) + '.</div>' : '') + '</div>' +
        '<div class="row-between"><span class="muted" id="whelk-sum" style="max-width:660px"></span><div class="actions" style="align-items:center">' +
        '<button type="button" class="btn primary" data-wh="el-link-go" id="whelk-go">Link</button></div></div>';
    }
    function elStoreLine(s, loc) {
      const st = s.st, total = s.prods.length;
      const name = esc(host.shortName(st)) + (st.isTest ? ' <span class="tag">TEST</span>' : '');
      const vend = s.known ? 'Its ' + esc(loc.heldBy) + ' vendor: ' + esc(s.vend)
        : '<span class="el-row" style="gap:8px;align-items:center">Its ' + esc(loc.heldBy) + ' vendor:' +
          selectHtml('data-whelv="' + esc(st.slug) + '" aria-label="' + esc(host.shortName(st)) + '\'s vendor for ' + esc(loc.heldBy) + '"', s.vend, st.tables.vendors.map(v => [v.name, v.name])) + '</span>';
      const pill = s.linked === total ? '<span class="tag ok">✓ ' + s.linked + ' of ' + total + ' linked</span>'
        : '<span class="tag ' + (s.toLink ? 'blue' : 'warn') + '">' + (s.linked + s.toLink) + ' of ' + total + ' match' + (s.toLink ? ' · ' + s.toLink + ' to link' : '') + '</span>';
      const vlow = lcs(s.vend), used = new Set(s.view.filter(x => x.itemId).map(x => x.itemId));
      const cands = st.tables.items.filter(it => it.active === true && it.whProduct == null && !used.has(it.id) &&
        (lcs(it.primaryVendor) === vlow || (it.eligible || []).some(v => lcs(v) === vlow)));
      const fix = s.view.map(x => {
        const p = prodBy(x.productId);
        if (x.status === 'taken') return '<div class="el-fix">"' + esc(x.itemName) + '" is linked to another product here.</div>';
        if (x.status === 'rename') {
          const it = st.tables.items.find(y => y.id === x.itemId);
          return '<div class="el-fix"><span style="flex:1 1 260px">Renames <b>' + esc(it ? it.name : x.itemId) + '</b> to <b>' + esc(p.name) + '</b> when you link.</span>' +
            '<button type="button" class="linkbtn" data-whelru="' + esc(st.slug + '|' + p.id) + '">Undo</button></div>';
        }
        if (x.status !== 'missing') return '';
        return '<div class="el-fix"><span style="flex:1 1 260px">No item named <b>' + esc(p.name) + '</b>. Rename theirs to match:</span>' +
          (cands.length ? selectHtml('data-whelr="' + esc(st.slug + '|' + p.id) + '" aria-label="' + esc(host.shortName(st)) + ' item to rename to ' + esc(p.name) + '"', '', cands.map(it => [it.id, it.name]), 'Pick one of its ' + s.vend + ' items')
                        : '<span class="muted">It has no other ' + esc(s.vend) + ' item.</span>') + '</div>';
      }).join('');
      return '<div class="el-line"><div class="row-between" style="margin:0"><span><b>' + name + '</b><span class="muted" style="display:block;font-size:13px">' + vend + '</span></span>' + pill + '</div>' + fix + '</div>';
    }
    function updateElLinks(loc) {
      const go = $('whelk-go'), sum = $('whelk-sum');
      if (!go) return;
      const plan = heldPlan(loc), bad = plan.filter(x => x.error);
      if (sum) sum.textContent = bad.length ? bad.map(x => host.shortName(x.st) + ': ' + x.error).join(' ')
        : !plan.length ? 'Nothing to link: every match is linked.'
        : 'Each store keeps ordering from its own ' + loc.heldBy + ' vendor. A rename and a link show in that store\'s Changes, undoable there.';
      go.disabled = !plan.length || bad.length > 0;
      go.textContent = plan.length ? 'Link ' + plural(plan.length, 'store') : 'Link';
    }

    // ---- Send a product to stores (schema v16; HQ's catalog, so the hq role) ----
    // A Happy Supply product goes to each store's Happy Supply. One ordered
    // through a held location's holder (v17, Elpis) goes to the store's own
    // vendor for it: remembered as HQ's name, or picked from the store's
    // vendors the first time (pick-only) and remembered with the change.
    const HS = 'Happy Supply';
    const sendHq = p => p.via || HS;
    function storeHs(st, hq) {
      hq = hq || HS;
      const linked = host.linkFor(st.slug, hq);
      if (linked) return { name: linked, remembered: true };
      const v = st.tables.vendors.find(x => x.name.toLowerCase() === hq.toLowerCase());
      return v ? { name: v.name, remembered: false } : null;
    }
    // The store's vendor whose name shares the holder's first word ("Elpis"
    // for "Elpis Wholesale", "ELPIS"), to start the pick with; else none.
    function guessVendor(st, hq) {
      const w = lcs(hq).split(/[^a-z0-9]+/).filter(Boolean)[0] || '';
      const v = w ? st.tables.vendors.find(x => lcs(x.name).split(/[^a-z0-9]+/).indexOf(w) >= 0) : null;
      return v ? v.name : '';
    }
    // The vendor a product goes to at a store: { name, remembered } or null.
    function sendVendor(st, p) {
      const v = storeHs(st, sendHq(p));
      if (v || !p.via) return v;
      const r = W.items.send && W.items.send.rows[st.slug];
      return r && r.vend ? { name: r.vend, remembered: false, picked: true } : null;
    }
    function sendOpen(p) {
      const keys = host.conceptKeys().filter(k => host.storesOf(k).some(host.usable));
      W.items.send = { productId: p.id, concept: keys[0] || null, rows: {} };
      sendConcept(W.items.send.concept);
    }
    function sendConcept(k) {
      const s = W.items.send, p = prodBy(s.productId);
      s.concept = k; s.rows = {};
      for (const st of host.storesOf(k).filter(host.usable)) {
        const c = host.CE.productCandidates(st.tables, p.name);
        s.rows[st.slug] = { on: false, mode: c.best ? 'link' : 'add', link: c.best || (c.items[0] ? c.items[0].id : ''),
                            vend: p.via && !storeHs(st, p.via) ? guessVendor(st, p.via) : '' };
      }
    }
    function sendPlan() {
      const s = W.items.send, p = prodBy(s.productId);
      if (!s || !p) return [];
      return host.storesOf(s.concept).filter(host.usable).filter(st => s.rows[st.slug] && s.rows[st.slug].on).map(st => {
        const r = s.rows[st.slug], hs = sendVendor(st, p);
        if (!hs) return { st, links: [], error: p.via ? 'Pick which vendor is ' + p.via + ' here.' : 'Add ' + HS + ' to this store on Vendors first (with its delivery days).' };
        const args = { vendor: null, vendorName: hs.name, product: { id: p.id, name: p.name, pack: p.pack, via: p.via || '' }, link: r.mode === 'link' ? r.link : '', item: { name: p.name } };
        const links = [{ slug: st.slug, hqName: sendHq(p), vendor: hs.name }];
        try { return { st, links, out: host.CE.call(st.tables, 'commitHqProduct', [args]) }; }
        catch (err) { return { st, links, error: err.message }; }
      });
    }
    function sendHtml() {
      const s = W.items.send, p = s && prodBy(s.productId);
      if (!s || !p) return '';
      const hq = sendHq(p);
      const keys = host.conceptKeys().filter(k => host.storesOf(k).some(host.usable));
      const stores = host.storesOf(s.concept).filter(host.usable).sort((a, b) => (a.isTest - b.isTest) || String(a.side).localeCompare(String(b.side)) || host.shortName(a).localeCompare(host.shortName(b)));
      const rows = stores.map(st => {
        const r = s.rows[st.slug], known = storeHs(st, hq), hs = sendVendor(st, p), linked = st.tables.items.find(it => Number(it.whProduct) === p.id);
        const allowed = !p.stores.length || p.stores.indexOf(st.slug) >= 0;
        const name = esc(host.shortName(st)) + (st.isTest ? ' <span class="tag">TEST</span>' : '');
        if (linked) return '<tr><td></td><td><b>' + name + '</b></td><td>' + esc(hs ? hs.name : hq) + '</td><td><span class="tag ok">Linked</span> ' + esc(linked.name) + ' (' + esc(linked.id) + ')</td></tr>';
        if (!allowed) return '<tr><td></td><td><b>' + name + '</b></td><td colspan="2" class="muted">' + esc(p.name) + ' isn\'t sold to this store (Which stores can order it, above).</td></tr>';
        if (!p.via && !hs) return '<tr><td></td><td><b>' + name + '</b></td><td colspan="2" class="muted">No ' + HS + ' here yet. Add it on <button type="button" class="linkbtn" data-nav="vendor">Vendors</button> first, with its delivery days.</td></tr>';
        if (p.via && !known && !guessVendor(st, hq)) return '<tr><td></td><td><b>' + name + '</b></td><td colspan="2" class="muted">No ' + esc(hq) + ' here (no vendor by that name). Add it on <button type="button" class="linkbtn" data-nav="vendor">Vendors</button> first.</td></tr>';
        const vendCell = known ? 'Has it: "' + esc(known.name) + '"'
          : '<div style="display:flex;flex-direction:column;gap:6px">' +
              selectHtml('data-whsvend="' + esc(st.slug) + '" aria-label="' + esc(host.shortName(st)) + '\'s vendor for ' + esc(hq) + '"', r.vend,
                st.tables.vendors.map(v => [v.name, v.name]), 'Pick its vendor') +
              '<span class="muted" style="font-size:13px">Saved as HQ\'s "' + esc(hq) + '" here</span></div>';
        const c = host.CE.productCandidates(st.tables, p.name);
        const opts = c.items.filter(x => !x.linked).slice(0, 30).map(x => [x.id, x.name + (x.vendor ? ' (' + x.vendor + ', ' + x.id + ')' : ' (' + x.id + ')')]);
        const choose = '<div class="stack" style="display:flex;flex-direction:column;gap:8px">' +
          (opts.length ? '<label class="check"><input type="radio" name="whsm-' + esc(st.slug) + '" data-whsmode="' + esc(st.slug) + '" value="link"' + (r.mode === 'link' ? ' checked' : '') + '>Link an item it has</label>' +
            (r.mode === 'link' ? selectHtml('data-whslink="' + esc(st.slug) + '" aria-label="' + esc(host.shortName(st)) + ' item to link"', r.link, opts) +
              '<span class="muted" style="font-size:13px">' + esc(linkNote(st, r.link, hs ? hs.name : '', p)) + '</span>' : '') : '') +
          '<label class="check"><input type="radio" name="whsm-' + esc(st.slug) + '" data-whsmode="' + esc(st.slug) + '" value="add"' + (r.mode === 'add' || !opts.length ? ' checked' : '') + '>Add a new item: ' + esc(p.name) + '</label>' +
          (r.mode === 'add' || !opts.length ? '<span class="muted" style="font-size:13px">' + (c.items.some(x => x.close) ? 'It has a close match: link it instead, so its par and count history stay.' : 'It waits in Needs setup with no par and no storage area, like an LTO.') + '</span>' : '') + '</div>';
        return '<tr><td><input type="checkbox" data-whson="' + esc(st.slug) + '" aria-label="Send to ' + esc(host.shortName(st)) + '"' + (r.on ? ' checked' : '') + ' style="width:20px;height:20px"></td>' +
          '<td><b>' + name + '</b></td><td>' + vendCell + '</td><td>' + choose + '</td></tr>';
      }).join('');
      return '<section class="card focus" aria-labelledby="whsend-h"><div class="card-head"><h2 id="whsend-h">Send ' + esc(p.name) + ' to stores</h2>' +
        '<button type="button" class="linkbtn" data-wh="send-close">Close</button></div>' +
        '<p class="help" style="margin:0">' + (p.via
          ? 'Each ticked store gets one change it can undo in its Changes: its own item linked to this product, ' + esc(p.via) + ' its main vendor, so KMs keep ordering it from ' + esc(p.via) + ' and its par and count history stay. Or a new item with no par and no storage area. Every store or none.'
          : 'Each ticked store gets one change it can undo in its Changes: the item with no par and no storage area, and its link to this product. Or link an item the store already has, so its par and count history stay. Every store or none.') + '</p>' +
        '<label class="field" style="max-width:320px">Concept' + selectHtml('data-whsconcept="1"', s.concept, keys.map(k => [k, host.conceptName(k)])) + '</label>' +
        (stores.length ? '<div class="scroll"><table><thead><tr><th><span class="sr">Send</span></th><th>Store</th><th>' + esc(p.via ? p.via + ' here' : HS) + '</th><th>The item</th></tr></thead><tbody>' + rows + '</tbody></table></div>'
          : emptyHtml('No stores in this concept use the app\'s editor.')) +
        '<div class="row-between"><span class="muted" id="whsend-sum"></span><div class="actions" style="align-items:center">' +
        '<button type="button" class="btn primary big" data-wh="send-go" id="whsend-go">Send</button></div></div>' +
        '<div class="status" id="whsend-status" role="status"></div></section>';
    }
    function linkNote(st, id, vend, p) {
      const it = st.tables.items.find(x => x.id === id);
      if (!it || !vend) return '';
      const parts = [];
      if (lcs(it.primaryVendor) !== lcs(vend)) parts.push(vend + ' becomes its main vendor' + (it.primaryVendor ? ', ' + it.primaryVendor + ' stays as a backup' : ''));
      if (p.pack && it.pack !== p.pack) parts.push('pack becomes ' + p.pack + (it.pack ? ' (was ' + it.pack + ')' : ''));
      return parts.length ? upper(parts.join('. ')) + '.' : 'Nothing else changes.';
    }
    function updateSend() {
      const plan = sendPlan(), go = $('whsend-go'), sum = $('whsend-sum');
      const bad = plan.filter(x => x.error);
      const named = plan.filter(x => !x.error && x.links.some(l => !host.linkFor(l.slug, l.hqName))).length;
      if (sum) sum.textContent = !plan.length ? 'Tick the stores to send it to.'
        : bad.length ? bad.map(x => host.shortName(x.st) + ': ' + x.error).join(' ')
        : plural(plan.length, 'store') + ': ' + plural(plan.filter(x => x.out.result.mode === 'link').length, 'item') + ' linked, ' +
          plural(plan.filter(x => x.out.result.mode === 'add').length, 'item') + ' added' +
          (named ? ', ' + plural(named, 'store') + ' naming ' + sendHq(prodBy(W.items.send.productId)) : '') + '.';
      if (go) { go.disabled = !plan.length || bad.length > 0; go.textContent = plan.length ? 'Send to ' + plural(plan.length, 'store') : 'Send'; }
    }

    // ---- Stock history ----
    async function loadHistory(before) {
      const h = W.hist;
      const r = await host.rpc('mog_wh_history', { p_token: host.token(), p_product_id: h.product ? Number(h.product) : null,
        p_location_id: h.location ? Number(h.location) : null, p_before_id: before || null });
      if (!r.ok) { if (r.error === 'SESSION_EXPIRED' || r.error === 'NOT_ALLOWED') host.signedOut('Your sign-in ran out. Sign in again.'); else say('whh-status', 'bad', r.error); return; }
      h.moves = (before ? h.moves : []).concat(r.data.moves);
      h.more = r.data.moves.length === 200;
      h.key = h.product + '|' + h.location;
    }
    function moveWhat(m) {
      if (m.kind === 'received') return 'Received on ' + m.ref + (m.unitCost != null ? ' at ' + money(m.unitCost) + ' / cs' : '');
      if (m.kind === 'transfer_out') return 'Sent on ' + m.ref;
      if (m.kind === 'transfer_in') return 'Arrived on ' + m.ref;
      if (m.kind === 'count') return 'Count: ' + (m.reason || '') + (m.ref ? ' (' + m.ref + ')' : '');
      if (m.kind === 'shipped') return (/^EL-/.test(m.ref || '') ? 'Delivered to the store on ' : 'Shipped on ') + m.ref;
      return m.kind;
    }
    async function renderHistory() {
      const d = D(), h = W.hist;
      const head = '<div class="card toolbar"><label class="field" style="flex-direction:row;align-items:center;gap:10px">Product' +
        selectHtml('data-whh="product"', h.product, [['', 'All products']].concat(d.products.map(p => [p.id, p.name]))) + '</label>' +
        '<label class="field" style="flex-direction:row;align-items:center;gap:10px">Location' +
        selectHtml('data-whh="location"', h.location, [['', 'All locations']].concat(d.locations.map(l => [l.id, l.name]))) + '</label></div>';
      if (h.moves === null || h.key !== h.product + '|' + h.location) {
        $('whh-body').innerHTML = head + '<p class="muted">Loading…</p>';
        try { await loadHistory(null); } catch (e) { say('whh-status', 'bad', e.message); return; }
        if (host.view() !== 'wh-history') return;
      }
      $('whh-body').innerHTML = head + '<section class="card"><div class="scroll">' + (!h.moves.length ? '<p class="muted" style="margin:0">Nothing yet.</p>' :
        '<table><thead><tr><th>When</th><th>Product</th><th>Location</th><th>Change</th><th>What</th><th>After</th><th>By</th></tr></thead><tbody>' +
        h.moves.map(m => '<tr><td style="white-space:nowrap">' + esc(when(m.at)) + '</td><td><b>' + esc(m.product) + '</b></td><td>' + esc(m.location) + '</td>' +
          '<td style="white-space:nowrap"><b class="' + (Number(m.cases) < 0 ? 'bad' : 'good') + '">' + signed(Number(m.cases)) + ' cs</b></td><td>' + esc(moveWhat(m)) + '</td>' +
          '<td>' + Number(m.casesAfter) + ' cs</td><td>' + esc(m.by) + '</td></tr>').join('') + '</tbody></table>') + '</div>' +
        (h.more ? '<div style="margin-top:12px"><button type="button" class="btn small" data-wh="hist-more">Show older</button></div>' : '') + '</section>';
    }

    // ---- Who took what (schema v20) ----
    function monthKeys() {
      const out = [], now = new Date();
      for (let i = 0; i < 12; i++) out.push(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1)).toISOString().slice(0, 7));
      return out;
    }
    const monthName = ym => new Date(ym + '-15T12:00:00Z').toLocaleDateString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' });
    function takenTable(title, id, cols, rows, empty) {
      return '<section class="card" aria-labelledby="' + id + '"><h2 id="' + id + '" style="font-size:16px">' + title + '</h2>' +
        (rows.length ? '<div class="scroll" style="margin-top:10px"><table><thead><tr>' + cols.map((c, i) => '<th' + (i === cols.length - 2 ? ' style="text-align:right"' : '') + '>' + c + '</th>').join('') + '</tr></thead><tbody>' +
          rows.map(r => '<tr>' + r.map((c, i) => '<td' + (i === r.length - 2 ? ' style="text-align:right"' : '') + '>' + (i === 0 ? '<b>' + esc(c) + '</b>' : esc(c)) + '</td>').join('') + '</tr>').join('') + '</tbody></table></div>'
          : '<p class="muted" style="margin:8px 0 0">' + empty + '</p>') + '</section>';
    }
    async function renderTaken() {
      const t = W.taken, keys = monthKeys();
      if (!t.month) t.month = keys[1];
      const head = '<div class="card toolbar"><label class="field" style="flex-direction:row;align-items:center;gap:10px">Month' +
        selectHtml('data-whtm="1"', t.month, keys.map(k => [k, monthName(k)])) + '</label>' +
        '<button type="button" class="btn small" data-wh="taken-csv"' + (t.data && t.key === t.month ? '' : ' disabled') + '>Download CSV</button></div>';
      if (!t.data || t.key !== t.month) {
        $('wht-body').innerHTML = head + '<p class="muted">Loading…</p>';
        const span = monthSpan(t.month);
        let r;
        try { r = await host.rpc('mog_wh_taken', { p_token: host.token(), p_from: span.from, p_to: span.to }); }
        catch (e) { say('wht-status', 'bad', e.message); return; }
        if (!r.ok) { if (r.error === 'SESSION_EXPIRED' || r.error === 'NOT_ALLOWED') host.signedOut('Your sign-in ran out. Sign in again.'); else say('wht-status', 'bad', String(r.error).replace(/^REJECTED: /, '')); return; }
        t.data = r.data; t.key = t.month;
        if (host.view() !== 'wh-taken') return;
        return renderTaken();
      }
      const d = t.data, short = r => (r.store || r.slug) + (r.isTest && !/\(TEST\)\s*$/.test(r.store || '') ? ' (TEST)' : '');
      $('wht-body').innerHTML = head +
        takenTable('Taken by a store', 'wht-a', ['Store', 'From', 'Item', 'Cases', 'How we know'],
          d.taken.map(r => [short(r), r.place || '', r.product, String(Number(r.cases)), plural(r.deliveries, 'delivery').replace('deliverys', 'deliveries') + ' checked in']),
          'No store checked anything in this month.') +
        takenTable('Used at a store\'s own place', 'wht-b', ['Store', 'Place', 'Item', 'Cases', 'How we know'],
          d.used.map(r => [short(r), r.place, r.product, String(Number(r.cases)), 'From ' + plural(r.counts, 'count')]),
          'No count at a place a store holds this month.') +
        takenTable('Moved between HEH\'s places', 'wht-c', ['To', 'From', 'Item', 'Cases', 'How we know'],
          d.moved.map(r => [r.place, r.from || '', r.product, String(Number(r.cases)), plural(r.shipments, 'shipment') + ' checked in']),
          'Nothing moved between places this month.') +
        '<p class="muted" style="margin:0">Cases only: the average cost, handling fee and markup come with the monthly charges. A store\'s own use is what its counts show it used ' +
        '(an opening count isn\'t use).</p>';
    }

    // ---- Views ----
    function render(view) {
      if (!W.data) return;
      if (view === 'wh-stock') renderStock();
      if (view === 'wh-items') renderItems();
      if (view === 'wh-places') renderPlaces();
      if (view === 'wh-incoming') renderIncoming();
      if (view === 'wh-orders') renderOrders();
      if (view === 'wh-taken') renderTaken();
      if (view === 'wh-history') renderHistory();
    }
    function badges() {
      if (!W.data) return;
      const n = openCount(), b = $('wh-badge-incoming');
      if (b) { b.hidden = !n; b.textContent = String(n); }
      const dot = $('wh-dot-items');
      if (dot) dot.hidden = !lowList().length;
      const ob = $('wh-badge-orders'), on = sentCount();
      if (ob) { ob.hidden = !on; ob.textContent = String(on); }
      const sb = $('wh-badge-stock'), sn = onTheWay().filter(x => !x.t).length;
      if (sb) { sb.hidden = !sn; sb.textContent = String(sn); }
    }
    function rerender() { render(host.view()); badges(); }
    // Re-draw a page while its search box is being typed in, keeping the cursor.
    function keepTyping(attr, draw) {
      draw();
      const box = document.querySelector('[' + attr + ']');
      if (box) { box.focus(); try { box.setSelectionRange(box.value.length, box.value.length); } catch (e) { /* a search box may not allow it */ } }
    }

    // ---- Events ----
    document.addEventListener('click', async e => {
      const t = e.target.closest ? e.target.closest('button') : null;
      if (!t || t.disabled || !W.data || !t.closest('[id^="v-wh-"]')) return;
      const go = t.getAttribute('data-whgo');
      if (go) {
        W.inc.filter = 'open'; W.inc.sel = go;
        if (go === 'newpo') W.inc.po = { id: null, supplierId: '', locationId: (ownLocs()[0] || {}).id || '', note: '', lines: [blankLine()] };
        if (go === 'newtr') W.inc.tr = { fromId: '', toId: '', note: '', lines: [blankLine()] };
        say('whn-status', '', '');
        return host.go('wh-incoming');
      }
      const a = t.getAttribute('data-wh');
      // Stock
      if (a === 'count-open') { W.inv.counting = true; W.inv.loc = (placeList().find(l => l.id === W.inv.loc) || placeList()[0] || {}).id || null; W.inv.rows = {}; say('whk-status', '', ''); renderStock(); const c = $('whc-h'); if (c) c.scrollIntoView({ block: 'start' }); return; }
      if (a === 'count-cancel') { W.inv.counting = false; W.inv.rows = {}; return renderStock(); }
      if (a === 'count-save') {
        const done = await write('mog_wh_count', { p_count: countPayload(W.inv.loc, W.inv.rows) }, 'whk-status',
          x => 'Saved the count for ' + x.location + ': ' + plural(x.changed, 'item') + ' changed. Each is in Stock history with its reason.');
        if (done) { W.inv.counting = false; W.inv.rows = {}; }
        return rerender();
      }
      const kf = t.getAttribute('data-whkf');
      if (kf) { W.stk.filter = kf; return renderStock(); }
      const kopen = t.getAttribute('data-whkopen');
      if (kopen) { W.stk.open = W.stk.open === kopen ? null : kopen; W.stk.rows = {}; say('whk-status', '', ''); return renderStock(); }
      if (a === 'ci-cancel') { W.stk.open = null; W.stk.rows = {}; return renderStock(); }
      if (a === 'ci-go') {
        const x = onTheWay().find(y => y.key === W.stk.open);
        if (!x || !x.o) return;
        const payload = x.kind === 'move' ? moveInPayload(x.o, W.stk.rows) : heldPayload(x.o, W.stk.rows);
        const done = await write('mog_wh_held_receive', { p_receipt: payload }, 'whk-status',
          r => 'Checked in ' + r.number + ' for ' + storeShort(x.o) + (x.kind === 'move' ? ': it\'s at ' + x.to + ' now.' : ': the stock at ' + x.from + ' dropped.') + ' It\'s in Stock history.');
        if (done) { W.stk.open = null; W.stk.rows = {}; }
        return rerender();
      }
      const gotr = t.getAttribute('data-whgotr');
      if (gotr) { W.inc.filter = 'open'; setSel('tr:' + gotr); return host.go('wh-incoming'); }
      // Items
      const its = t.getAttribute('data-whitsel');
      if (its) { W.items.sel = Number(its); W.items.draft = null; say('whit-status', '', ''); return host.view() === 'wh-items' ? renderItems() : host.go('wh-items'); }
      const itp = t.getAttribute('data-whitplace');
      if (itp) { W.items.place = itp; W.items.filter = 'active'; W.items.sel = null; W.items.draft = null; return host.go('wh-items'); }
      const itfl = t.getAttribute('data-whitfl');
      if (itfl) { W.items.filter = itfl; W.items.sel = null; W.items.draft = null; return renderItems(); }
      if (a === 'item-new') { W.items.sel = 'new'; W.items.draft = itemDraft(null); W.items.send = null; say('whit-status', '', ''); return renderItems(); }
      if (a === 'item-discard') { W.items.sel = null; W.items.draft = null; return renderItems(); }
      const itx = t.getAttribute('data-whitx');
      if (itx) { W.items.draft.places = W.items.draft.places.filter(x => x.locationId !== Number(itx)); return renderItems(); }
      const lim = t.getAttribute('data-whitlim');
      if (lim != null) { W.items.draft.limit = lim === '1'; return renderItems(); }
      const ist = t.getAttribute('data-whitst');
      if (ist) { const l = W.items.draft.stores, i = l.indexOf(ist); if (i >= 0) l.splice(i, 1); else l.push(ist); return renderItems(); }
      if (a === 'item-save') {
        const f = W.items.draft;
        const done = await write('mog_wh_save', { p_kind: 'product', p_row: itemRow(f) }, 'whit-status', x => 'Saved ' + x.name + '.');
        if (!done) { if (W.conflict) W.items.draft = null; return rerender(); }
        const counts = itemCounts(f, prodBy(done.id));
        for (const c of counts) {
          c.lines[0].productId = done.id;
          const ok = await write('mog_wh_count', { p_count: c }, 'whit-status',
            () => 'Saved ' + done.name + ' and ' + (counts.length === 1 ? 'its count' : 'its counts') + '. Each is in Stock history with its reason.');
          if (!ok) break;
        }
        W.items.sel = done.id; W.items.draft = null;
        return rerender();
      }
      if (a === 'send-open') { const p = prodBy(W.items.sel); if (p) sendOpen(p); say('whit-status', '', ''); return renderItems(); }
      if (a === 'send-close') { W.items.send = null; return renderItems(); }
      if (a === 'send-go') {
        const plan = sendPlan(), p = prodBy(W.items.send.productId);
        if (!plan.length || plan.some(x => x.error)) return;
        const ok = await host.save(plan, 'whsend-status', () => {});
        if (ok) { W.items.send = null; renderItems(); say('whit-status', 'good', 'Sent ' + p.name + ' to ' + plural(plan.length, 'store') + '. Each store sees it in Manage → Changes, and can undo it there.'); }
        else updateSend();
        return;
      }
      if (a === 'settings-save') {
        const st = D().settings;
        await write('mog_wh_save', { p_kind: 'settings', p_row: { version: st.version, markupPct: num($('whs-pct').value), deliveryFee: num($('whs-fee').value) } },
          'whit-status', () => 'Saved the markup and delivery fee.');
        return rerender();
      }
      // Places
      const pls = t.getAttribute('data-whplsel');
      if (pls) { W.places.sel = Number(pls); W.places.draft = null; W.places.vend = {}; W.places.renames = {}; say('whpl-status', '', ''); return host.view() === 'wh-places' ? renderPlaces() : host.go('wh-places'); }
      if (a === 'place-new') { W.places.sel = 'new'; W.places.draft = placeDraft(null); say('whpl-status', '', ''); return renderPlaces(); }
      if (a === 'place-discard') { W.places.sel = null; W.places.draft = null; return renderPlaces(); }
      const plk = t.getAttribute('data-whplk');
      if (plk) { const f = W.places.draft; f.kind = plk; f.countHow = ''; if (plk === 'own') { f.heldBy = ''; f.heldStore = ''; } if (plk === 'vendor') f.heldStore = ''; return renderPlaces(); }
      const plh = t.getAttribute('data-whplh');
      if (plh) { W.places.draft.countHow = plh; return renderPlaces(); }
      if (a === 'place-save') {
        const done = await write('mog_wh_save', { p_kind: 'location', p_row: placeRow(W.places.draft) }, 'whpl-status', x => 'Saved ' + x.name + '.');
        if (done) { W.places.sel = done.id; W.places.draft = null; } else if (W.conflict) W.places.draft = null;
        return rerender();
      }
      const elru = t.getAttribute('data-whelru');
      if (elru) { const [slug, pid] = elru.split('|'); if (W.places.renames[slug]) delete W.places.renames[slug][pid]; return renderPlaces(); }
      if (a === 'el-link-go') {
        const loc = D().locations.find(l => l.id === W.places.sel), plan = heldPlan(loc);
        if (!plan.length || plan.some(x => x.error)) return;
        const ok = await host.save(plan, 'whpl-status', () => {});
        if (ok) { W.places.renames = {}; W.places.vend = {}; say('whpl-status', 'good', 'Linked ' + plural(plan.length, 'store') + '. Each store sees it in Manage → Changes, and can undo it there.'); }
        return rerender();
      }
      // Incoming
      const incf = t.getAttribute('data-whincf');
      if (incf) { W.inc.filter = incf; setSel(null); say('whn-status', '', ''); return renderIncoming(); }
      const sel = t.getAttribute('data-whsel');
      if (sel) { setSel(sel); say('whn-status', '', ''); return renderIncoming(); }
      if (a === 'form-cancel') { setSel(null); return renderIncoming(); }
      if (a === 'po-addline') { W.inc.po.lines.push(blankLine()); return renderIncoming(); }
      if (a === 'tr-addline') { W.inc.tr.lines.push(blankLine()); return renderIncoming(); }
      const pd = t.getAttribute('data-whpodrop');
      if (pd != null) { W.inc.po.lines.splice(Number(pd), 1); if (!W.inc.po.lines.length) W.inc.po.lines.push(blankLine()); return renderIncoming(); }
      const td = t.getAttribute('data-whtrdrop');
      if (td != null) { W.inc.tr.lines.splice(Number(td), 1); if (!W.inc.tr.lines.length) W.inc.tr.lines.push(blankLine()); return renderIncoming(); }
      if (a === 'po-save') {
        const done = await write('mog_wh_po_save', { p_po: poPayload() }, 'whn-status', x => 'Saved ' + x.number + '. Receive it here when it arrives.');
        if (done) setSel('po:' + done.id); else if (W.conflict && W.inc.po.id) setSel('po:' + W.inc.po.id);
        return rerender();
      }
      if (a === 'po-edit' || a === 'po-cancel' || a === 'po-receive') {
        const po = D().pos.find(p => p.id === Number(W.inc.sel.slice(3)));
        if (a === 'po-edit') {
          W.inc.po = { id: po.id, number: po.number, version: po.version, supplierId: po.supplierId, locationId: po.locationId, note: po.note,
                       lines: po.lines.map(l => ({ productId: l.productId, cases: String(Number(l.cases)), cost: l.cost == null ? '' : Number(l.cost).toFixed(2) })) };
          W.inc.sel = 'editpo:' + po.id;
          return renderIncoming();
        }
        if (a === 'po-cancel') {
          if (!window.confirm('Cancel ' + po.number + ' from ' + po.supplier + '? Nothing has come in on it, and it moves to Cancelled.')) return;
          await write('mog_wh_po_cancel', { p_id: po.id, p_version: po.version }, 'whn-status', x => 'Cancelled ' + x.number + '.');
          setSel(null);
          return rerender();
        }
        const done = await write('mog_wh_po_receive', { p_receipt: receivePayload(po, W.inc.rcv) }, 'whn-status',
          x => 'Received ' + x.number + ' into ' + po.location + '. The stock and average cost are updated; it\'s in Stock history.');
        if (done || W.conflict) setSel('po:' + po.id);
        return rerender();
      }
      if (a === 'tr-send') {
        const done = await write('mog_wh_transfer_send', { p_transfer: trPayload() }, 'whn-status', x => 'Sent ' + x.number + '. It shows in transit until it\'s received.');
        if (done) setSel('tr:' + done.id);
        return rerender();
      }
      if (a === 'tr-receive') {
        const tr = D().transfers.find(x => x.id === Number(W.inc.sel.slice(3)));
        const done = await write('mog_wh_transfer_receive', { p_id: tr.id }, 'whn-status', x => 'Received ' + x.number + ' at ' + tr.to + '.');
        if (done) setSel('tr:' + tr.id);
        return rerender();
      }
      const tg = t.getAttribute('data-whtoggle');
      if (tg) {
        const r = D().suppliers.find(x => x.id === Number(t.getAttribute('data-id')));
        await write('mog_wh_save', { p_kind: 'supplier', p_row: { id: r.id, name: r.name, active: !r.active } }, 'whn-status', x => (r.active ? 'Hid ' : 'Showing ') + x.name + '.');
        return rerender();
      }
      const add = t.getAttribute('data-whadd');
      if (add) {
        const box = $('whadd-' + add), name = box.value.trim();
        if (!name) { box.focus(); return; }
        await write('mog_wh_save', { p_kind: 'supplier', p_row: { name: name } }, 'whn-status', x => 'Added ' + x.name + '.');
        return rerender();
      }
      // Orders
      const ordf = t.getAttribute('data-whordf');
      if (ordf) { W.ord.filter = ordf; W.ord.sel = null; say('who-status', '', ''); return renderOrders(); }
      const osel = t.getAttribute('data-whosel');
      if (osel) { selectOrder(Number(osel)); say('who-status', '', ''); return renderOrders(); }
      if (a === 'ord-ship' || a === 'ord-cancel') {
        const o = orders().find(x => x.id === W.ord.sel);
        if (!o) return;
        if (a === 'ord-cancel') {
          if (!window.confirm('Cancel ' + o.number + ' from ' + storeShort(o) + '? Nothing has shipped; the store sees it cancelled.')) return;
          await write('mog_wh_order_cancel', { p_id: o.id, p_version: o.version }, 'who-status', x => 'Cancelled ' + x.number + '.');
          selectOrder(o.id);
          return rerender();
        }
        const done = await write('mog_wh_ship', { p_ship: shipPayload(o, W.ord.rows) }, 'who-status',
          x => 'Shipped ' + x.number + ' to ' + storeShort(o) + ': ' + cs(x.cases) + '. The stock dropped and the prices are fixed; it\'s in Stock history.');
        if (done) { W.ord.filter = 'shipped'; selectOrder(o.id); } else if (W.conflict) selectOrder(o.id);
        return rerender();
      }
      // Who took what
      if (a === 'taken-csv') {
        if (!W.taken.data) return;
        const url = URL.createObjectURL(new Blob([takenCsv(W.taken.data)], { type: 'text/csv' }));
        const link = document.createElement('a');
        link.href = url; link.download = 'who-took-what-' + W.taken.month + '.csv';
        document.body.appendChild(link); link.click(); link.remove();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
        return;
      }
      // History
      if (a === 'hist-more') {
        const h = W.hist;
        try { await loadHistory(h.moves[h.moves.length - 1].id); } catch (err) { say('whh-status', 'bad', err.message); }
        return renderHistory();
      }
    });
    document.addEventListener('change', e => {
      const t = e.target;
      if (!W.data || !t.closest || !t.closest('[id^="v-wh-"]')) return;
      if (t.getAttribute('data-whcloc')) { W.inv.loc = Number(t.value); W.inv.rows = {}; return renderStock(); }
      if (t.getAttribute('data-whkc')) { W.stk.concept = t.value; return renderStock(); }
      if (t.getAttribute('data-whitp')) { W.items.place = t.value; W.items.sel = null; W.items.draft = null; return renderItems(); }
      if (t.getAttribute('data-whitc')) { W.items.concept = t.value; W.items.sel = null; W.items.draft = null; return renderItems(); }
      const itf = t.getAttribute('data-whitf');
      if (itf === 'concept') { W.items.draft.concept = t.value; return; }
      if (itf === 'active') { W.items.draft.active = t.checked; return updateItemPanel(); }
      if (t.getAttribute('data-whitadd') && t.value) {
        const p = W.items.draft.id ? prodBy(W.items.draft.id) : null, id = Number(t.value);
        W.items.draft.places.push({ locationId: id, low: '0', now: p ? String(stockAt(p, id)) : '', reason: '' });
        return renderItems();
      }
      const plf = t.getAttribute('data-whplf');
      if (plf === 'heldStore' || plf === 'heldBy') { W.places.draft[plf] = t.value; return updatePlacePanel(); }
      if (plf === 'active') { W.places.draft.active = t.checked; return updatePlacePanel(); }
      const elv = t.getAttribute('data-whelv');
      if (elv) { W.places.vend[elv] = t.value; delete W.places.renames[elv]; return renderPlaces(); }
      const elr = t.getAttribute('data-whelr');
      if (elr && t.value) { const [slug, pid] = elr.split('|'); W.places.renames[slug] = W.places.renames[slug] || {}; W.places.renames[slug][pid] = t.value; return renderPlaces(); }
      if (t.getAttribute('data-whtm')) { W.taken.month = t.value; return renderTaken(); }
      const po = t.getAttribute('data-whpo');
      if (po && po !== 'note') { W.inc.po[po] = Number(t.value); return po === 'locationId' ? renderIncoming() : updatePoForm(); }
      const pol = t.getAttribute('data-whpol');
      if (pol != null && t.getAttribute('data-k') === 'productId') { W.inc.po.lines[Number(pol)].productId = Number(t.value); return updatePoForm(); }
      const tr = t.getAttribute('data-whtr');
      if (tr && tr !== 'note') { W.inc.tr[tr] = Number(t.value); if (tr === 'fromId' && W.inc.tr.toId === W.inc.tr.fromId) W.inc.tr.toId = ''; return renderIncoming(); }
      const trl = t.getAttribute('data-whtrl');
      if (trl != null && t.getAttribute('data-k') === 'productId') { W.inc.tr.lines[Number(trl)].productId = Number(t.value); return updateTrForm(); }
      const hh = t.getAttribute('data-whh');
      if (hh) { W.hist[hh] = t.value; return renderHistory(); }
      const from = t.getAttribute('data-whfrom');
      if (from) { W.ord.rows[from] = W.ord.rows[from] || {}; W.ord.rows[from].locationId = t.value; return updateShip(); }
      if (t.getAttribute('data-whsconcept')) { sendConcept(t.value); return renderItems(); }
      const son = t.getAttribute('data-whson');
      if (son) { W.items.send.rows[son].on = t.checked; return updateSend(); }
      const smode = t.getAttribute('data-whsmode');
      if (smode) { W.items.send.rows[smode].mode = t.value; return renderItems(); }
      const slink = t.getAttribute('data-whslink');
      if (slink) { W.items.send.rows[slink].link = t.value; return renderItems(); }
      const svend = t.getAttribute('data-whsvend');
      if (svend) { W.items.send.rows[svend].vend = t.value; return renderItems(); }
    });
    document.addEventListener('input', e => {
      const t = e.target;
      if (!W.data || !t.closest || !t.closest('[id^="v-wh-"]')) return;
      const c = t.getAttribute('data-whc'), r = t.getAttribute('data-whr');
      if (c || r) { const k = c || r; W.inv.rows[k] = W.inv.rows[k] || {}; W.inv.rows[k][c ? 'counted' : 'reason'] = t.value; return updateCount(); }
      if (t.getAttribute('data-whkq')) { W.stk.q = t.value; return keepTyping('data-whkq', renderStock); }
      const kr = t.getAttribute('data-whkr');
      if (kr) { W.stk.rows[kr] = t.value; return updateOnTheWay(); }
      if (t.getAttribute('data-whitq')) { W.items.q = t.value; W.items.sel = null; W.items.draft = null; return keepTyping('data-whitq', renderItems); }
      const itf = t.getAttribute('data-whitf');
      if (itf === 'name' || itf === 'pack' || itf === 'fee') { W.items.draft[itf] = t.value; return updateItemPanel(); }
      const itn = t.getAttribute('data-whitn'), itl = t.getAttribute('data-whitl'), itr = t.getAttribute('data-whitr');
      if (itn || itl || itr) {
        const x = W.items.draft.places.find(y => y.locationId === Number(itn || itl || itr));
        if (x) x[itn ? 'now' : itl ? 'low' : 'reason'] = t.value;
        return updateItemPanel();
      }
      if (t.getAttribute('data-whplf') === 'name') { W.places.draft.name = t.value; return updatePlacePanel(); }
      const rc = t.getAttribute('data-whrc'), rk = t.getAttribute('data-whrk');
      if (rc || rk) { const k = rc || rk; W.inc.rcv[k] = W.inc.rcv[k] || {}; W.inc.rcv[k][rc ? 'cases' : 'cost'] = t.value; return updateIncoming(); }
      if (t.getAttribute('data-whpo') === 'note') { W.inc.po.note = t.value; return; }
      const pol = t.getAttribute('data-whpol');
      if (pol != null) { W.inc.po.lines[Number(pol)][t.getAttribute('data-k')] = t.value; return updatePoForm(); }
      if (t.getAttribute('data-whtr') === 'note') { W.inc.tr.note = t.value; return; }
      const trl = t.getAttribute('data-whtrl');
      if (trl != null) { W.inc.tr.lines[Number(trl)][t.getAttribute('data-k')] = t.value; return updateTrForm(); }
      const sh = t.getAttribute('data-whship');
      if (sh) { W.ord.rows[sh] = W.ord.rows[sh] || {}; W.ord.rows[sh].cases = t.value; return updateShip(); }
    });

    return { views: VIEWS, fetch: fetchData, take, render, badges, clear: () => { W.data = null; } };
  }

  root.HQWarehouse = { logic: logic, create: create };
})(typeof window !== 'undefined' ? window : this);
