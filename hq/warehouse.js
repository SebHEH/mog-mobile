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
  const logic = { round, avgAfter, storePrice, stockAt, owned, value, num, cs, money, countPayload, receivePayload, transferProblems };

  // ---- The page ----
  const VIEWS = ['wh-inventory', 'wh-incoming', 'wh-products', 'wh-history'];
  const PLUS = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" aria-hidden="true"><path d="M12 5l0 14"/><path d="M5 12l14 0"/></svg>';
  const CHECK = '<svg class="ck" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12l5 5l10 -10"/></svg>';
  const CHEV = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#5f5e5a" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 9l6 6l6 -6"/></svg>';
  const SECTIONS =
    '<section class="view" id="v-wh-inventory" aria-labelledby="whi-h" hidden>' +
      '<div class="page-head"><div><h1 id="whi-h">Inventory</h1><p>Cases on hand at each location. A count fixes the numbers, and every difference is kept in Stock history with its reason.</p></div>' +
      '<div class="actions"><button type="button" class="btn" data-whgo="newtr">Transfer</button><button type="button" class="btn primary" data-wh="count-open">Count a location</button></div></div>' +
      '<div class="status" id="whi-status" role="status"></div><div id="whi-body" class="view"></div></section>' +
    '<section class="view" id="v-wh-incoming" aria-labelledby="whn-h" hidden>' +
      '<div class="page-head"><div><h1 id="whn-h">Incoming</h1><p>Vendor orders on their way in, and transfers between locations. Receiving a vendor order adds its cases and updates the average cost.</p></div>' +
      '<div class="actions"><button type="button" class="btn" data-whgo="newtr">New transfer</button><button type="button" class="btn primary" data-whgo="newpo">New vendor order</button></div></div>' +
      '<div class="status" id="whn-status" role="status"></div><div id="whn-body" class="view"></div></section>' +
    '<section class="view" id="v-wh-products" aria-labelledby="whp-h" hidden>' +
      '<div class="page-head"><div><h1 id="whp-h">Products and prices</h1><p>What Happy Supply stocks. A store pays the average cost plus the handling fee per case, fixed on each line when its order ships. Stores never see the fee.</p></div>' +
      '<div class="actions"><button type="button" class="btn" data-wh="prod-new">' + PLUS + 'Add a product</button></div></div>' +
      '<div class="status" id="whp-status" role="status"></div><div id="whp-body" class="view"></div></section>' +
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
                inv: { filter: 'active', counting: false, loc: null, rows: {} },
                inc: { filter: 'open', sel: null, rcv: {}, po: null, tr: null },
                prod: { sel: null, draft: null },
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
    function take(data) { W.data = data; W.hist.moves = null; }
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
    const locName = id => { const l = D().locations.find(x => x.id === id); return l ? l.name : '?'; };
    const prodBy = id => D().products.find(p => p.id === Number(id));
    const lowList = () => D().products.filter(p => p.active && Number(p.par) > 0 && owned(p) < Number(p.par));
    const openCount = () => D().pos.filter(p => p.status === 'ordered').length + D().transfers.filter(t => t.status === 'in_transit').length;
    function selectHtml(attr, value, options, placeholder) {
      return '<span class="select small"><select ' + attr + '>' +
        (placeholder ? '<option value=""' + (value ? '' : ' selected') + ' disabled>' + esc(placeholder) + '</option>' : '') +
        options.map(o => '<option value="' + esc(o[0]) + '"' + (String(o[0]) === String(value) ? ' selected' : '') + '>' + esc(o[1]) + '</option>').join('') +
        '</select>' + CHEV + '</span>';
    }
    const inputHtml = (attr, value, extra) => '<input class="cell-in" ' + attr + ' value="' + esc(value == null ? '' : value) + '" inputmode="decimal"' + (extra || '') + '>';
    function emptyHtml(text) { return '<p class="empty" style="margin:0">' + text + '</p>'; }

    // ---- Inventory ----
    function renderInventory() {
      const d = D(), locs = activeLocs();
      const shownLocs = d.locations.filter(l => l.active || d.products.some(p => stockAt(p, l.id) > 0));
      const all = d.products, low = lowList();
      const total = round(all.reduce((t, p) => t + owned(p), 0), 2), moving = round(all.reduce((t, p) => t + Number(p.inTransit || 0), 0), 2);
      const list = all.filter(p => (W.inv.filter === 'active' ? p.active : W.inv.filter === 'low' ? low.indexOf(p) >= 0 : !p.active));
      let html = '<div class="stats">' +
        '<div class="stat"><div class="k">ON HAND</div><div class="v">' + esc(cs(total)) + '</div><div class="m">' + (moving ? esc(cs(moving)) + ' of them in transit' : 'None in transit') + '</div></div>' +
        '<div class="stat"><div class="k">VALUE AT AVERAGE COST</div><div class="v">' + money(value(all)) + '</div><div class="m">Before handling fees</div></div>' +
        '<div class="stat"><div class="k">BELOW PAR</div><div class="v">' + plural(low.length, 'product') + '</div><div class="m">' +
          (low.length ? esc(low.map(p => p.name).slice(0, 3).join(', ') + (low.length > 3 ? ' and ' + (low.length - 3) + ' more' : '')) : 'Everything is at or above par') + '</div></div></div>';
      html += '<section class="card" aria-labelledby="whi-t"><div class="card-head"><h2 id="whi-t">Stock by location</h2>' +
        '<div class="actions" role="group" aria-label="Show">' +
        [['active', 'Active · ' + all.filter(p => p.active).length], ['low', 'Below par · ' + low.length], ['inactive', 'Inactive']].map(f =>
          '<button type="button" class="pill" data-whinvf="' + f[0] + '" aria-pressed="' + (W.inv.filter === f[0]) + '">' + f[1] + '</button>').join('') + '</div></div>';
      if (!d.products.length) html += '<p class="empty">No products yet. Add them on <button type="button" class="linkbtn" data-nav="wh-products">Products and prices</button>.</p>';
      else if (!locs.length) html += '<p class="empty">No locations yet. Add them on <button type="button" class="linkbtn" data-nav="wh-products">Products and prices</button>.</p>';
      else if (!list.length) html += '<p class="empty">Nothing here.</p>';
      else {
        html += '<div class="scroll" style="margin-top:14px"><table><thead><tr><th>Product</th>' + shownLocs.map(l => '<th>' + esc(l.name) + '</th>').join('') +
          '<th>In transit</th><th>Total</th><th>Par</th><th>Avg cost / cs</th><th>Value</th></tr></thead><tbody>' +
          list.map(p => '<tr><td><b>' + esc(p.name) + '</b>' + (low.indexOf(p) >= 0 ? ' <span class="tag warn">Below par</span>' : '') +
            (p.pack ? '<div class="muted" style="font-size:13px">' + esc(p.pack) + '</div>' : '') + '</td>' +
            shownLocs.map(l => '<td>' + stockAt(p, l.id) + '</td>').join('') +
            '<td>' + (Number(p.inTransit) ? '<button type="button" class="linkbtn" data-nav="wh-incoming">' + Number(p.inTransit) + '</button>' : '<span class="muted">0</span>') + '</td>' +
            '<td><b>' + owned(p) + '</b></td><td class="muted">' + Number(p.par) + '</td><td>' + money(p.avgCost) + '</td><td>' + money(owned(p) * Number(p.avgCost)) + '</td></tr>').join('') +
          '</tbody></table></div>';
      }
      html += '</section>';
      if (W.inv.counting) html += countHtml();
      $('whi-body').innerHTML = html;
      if (W.inv.counting) updateCount();
    }
    function countProducts() {
      const loc = W.inv.loc;
      return D().products.filter(p => p.active || stockAt(p, loc) > 0);
    }
    function countHtml() {
      const loc = W.inv.loc, rows = W.inv.rows;
      const prods = countProducts();
      return '<section class="card focus" aria-labelledby="whc-h"><div class="card-head"><h2 id="whc-h">Count a location</h2>' +
        '<label class="field" style="flex-direction:row;align-items:center;gap:10px"><span class="sr">Location</span>' +
        selectHtml('data-whcloc="1"', loc, activeLocs().map(l => [l.id, l.name])) + '</label></div>' +
        '<p class="help">Type what is on the shelf. A number that differs from the record needs a reason. A product left blank keeps its number.</p>' +
        (!prods.length ? emptyHtml('No products to count.') :
        '<div class="scroll" style="margin-top:12px"><table><thead><tr><th>Product</th><th>On record</th><th>Counted</th><th>Difference</th><th>Why it\'s different</th></tr></thead><tbody>' +
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
      const prods = d.products.filter(p => p.active);
      if (!sups.length || !locs.length || !prods.length) {
        return '<h2>New vendor order</h2>' + emptyHtml('First add ' + [!sups.length && 'a supplier', !locs.length && 'a location', !prods.length && 'a product'].filter(Boolean).join(', ') +
          ' on <button type="button" class="linkbtn" data-nav="wh-products">Products and prices</button>.');
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
        return '<h2>New transfer</h2>' + emptyHtml('A transfer needs two locations and a product: add them on <button type="button" class="linkbtn" data-nav="wh-products">Products and prices</button>.');
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

    // ---- Products and prices ----
    function draftOf(p) {
      return p ? { id: p.id, version: p.version, name: p.name, pack: p.pack, par: String(Number(p.par)), fee: Number(p.handlingFee).toFixed(2),
                   limit: p.stores.length > 0, stores: p.stores.slice(), active: p.active }
               : { id: null, version: null, name: '', pack: '', par: '0', fee: '0.00', limit: false, stores: [], active: true };
    }
    function renderProducts() {
      const d = D(), list = d.products;
      if (W.prod.sel !== 'new' && !list.some(p => p.id === W.prod.sel)) { W.prod.sel = list.length ? list[0].id : 'new'; W.prod.draft = null; }
      if (!W.prod.draft) W.prod.draft = draftOf(W.prod.sel === 'new' ? null : prodBy(W.prod.sel));
      const pct = Number(d.settings.markupPct);
      let html = '<div class="cols"><section class="card list-card" style="flex:1 1 420px" aria-label="Products">' +
        (list.length ? list.map(p => '<button type="button" class="lrow" data-whpsel="' + p.id + '"' + (p.id === W.prod.sel ? ' aria-current="true"' : '') + '>' +
          '<span class="t"><span class="n">' + esc(p.name) + (p.active ? '' : ' <span class="tag">Inactive</span>') + '</span><span class="s">' +
          esc([p.pack, 'par ' + Number(p.par), p.stores.length ? plural(p.stores.length, 'store') : 'every store'].filter(Boolean).join(' · ')) + '</span></span>' +
          '<span class="at" style="text-align:right"><b style="color:var(--ink);font-size:15px">' + money(storePrice(p.avgCost, p.handlingFee, pct)) + '</b><br>store price / cs</span></button>').join('')
          : '<div class="list-foot">No products yet: add the first one.</div>') + '</section>';
      html += '<section class="card panel" style="flex:1 1 400px" aria-labelledby="whpp-h">' + productPanelHtml() + '</section></div>';
      html += '<div class="stats" style="grid-template-columns:repeat(auto-fit,minmax(260px,1fr))">' + listCardHtml('supplier', 'Suppliers', 'Picked on a vendor order. Tap one to hide it from new orders or show it again.', d.suppliers) +
        listCardHtml('location', 'Locations', 'Where stock sits. Tap one to close it (it has to be empty) or open it again.', d.locations) +
        '<section class="card" aria-labelledby="whs-h" style="padding:18px 20px"><h2 id="whs-h" style="font-size:16px">For every store</h2>' +
        '<p class="help" style="margin-top:4px">Both 0 to start. A store\'s price per case is the average cost plus the handling fee, plus the markup.</p>' +
        '<div class="grid2" style="margin-top:10px"><label class="field">Markup %<input id="whs-pct" class="text" inputmode="decimal" value="' + esc(String(Number(d.settings.markupPct))) + '"></label>' +
        '<label class="field">Delivery fee / order<input id="whs-fee" class="text" inputmode="decimal" value="' + esc(Number(d.settings.deliveryFee).toFixed(2)) + '"></label></div>' +
        '<div class="actions" style="margin-top:12px;justify-content:flex-end"><button type="button" class="btn" data-wh="settings-save">Save</button></div></section></div>';
      $('whp-body').innerHTML = html;
      updateProductPanel();
    }
    function listCardHtml(kind, title, help, rows) {
      return '<section class="card" style="padding:18px 20px" aria-label="' + title + '"><h2 style="font-size:16px">' + title + '</h2>' +
        '<p class="help" style="margin-top:4px">' + help + '</p>' +
        '<div class="chips">' + (rows.length ? rows.map(r => '<button type="button" class="chip" data-whtoggle="' + kind + '" data-id="' + r.id + '" aria-pressed="' + r.active + '">' + CHECK + esc(r.name) + '</button>').join('')
          : '<span class="muted">None yet.</span>') + '</div>' +
        '<div style="margin-top:12px;display:flex;gap:8px"><input class="text" id="whadd-' + kind + '" maxlength="60" placeholder="' + (kind === 'supplier' ? 'Supplier name' : 'Location name') + '" aria-label="New ' + kind + ' name" style="height:40px;font-size:14px">' +
        '<button type="button" class="btn small" data-whadd="' + kind + '" style="height:40px">Add</button></div></section>';
    }
    function productPanelHtml() {
      const f = W.prod.draft, p = f.id ? prodBy(f.id) : null, d = D();
      const idx = p ? d.products.indexOf(p) + 1 : 0;
      const stores = d.stores.slice().sort((a, b) => (a.isTest - b.isTest));
      return '<div class="card-head"><h2 id="whpp-h">' + (p ? esc(p.name) : 'New product') + '</h2>' + (p ? '<span class="muted">Product ' + idx + ' of ' + d.products.length + '</span>' : '') + '</div>' +
        '<label class="field">Product name<input data-whpf="name" value="' + esc(f.name) + '" maxlength="120"></label>' +
        '<div class="grid3"><label class="field">Pack<input data-whpf="pack" value="' + esc(f.pack) + '" maxlength="60" placeholder="e.g. 20 LB case"></label>' +
        '<label class="field">Par (cases)<input data-whpf="par" value="' + esc(f.par) + '" inputmode="decimal"></label>' +
        '<label class="field">Handling fee / cs<input data-whpf="fee" value="' + esc(f.fee) + '" inputmode="decimal"></label></div>' +
        '<div class="note-box" id="whpp-price"></div>' +
        '<div role="group" aria-labelledby="whpp-who"><div class="chips-label" id="whpp-who">Which stores can order it</div>' +
        '<div class="seg" style="display:inline-flex;margin-top:8px"><button type="button" data-whlimit="0" aria-pressed="' + !f.limit + '">Every store</button>' +
        '<button type="button" data-whlimit="1" aria-pressed="' + f.limit + '">Only these</button></div>' +
        (f.limit ? '<div class="chips">' + stores.map(s => '<button type="button" class="chip" data-whstore="' + esc(s.slug) + '" aria-pressed="' + (f.stores.indexOf(s.slug) >= 0) + '">' + CHECK +
          esc((s.location || s.slug) + (s.isTest && !/\(TEST\)\s*$/.test(s.location || '') ? ' (TEST)' : '')) + '</button>').join('') + '</div>' : '') + '</div>' +
        '<label class="check"><input type="checkbox" data-whpf="active"' + (f.active ? ' checked' : '') + '>Active: on new vendor orders and counts</label>' +
        '<div class="row-between" style="margin-top:0"><span class="muted" id="whpp-sum"></span><div class="actions" style="align-items:center">' +
        (p ? '' : '<button type="button" class="linkbtn" data-wh="prod-discard">Cancel</button>') +
        '<button type="button" class="btn primary" data-wh="prod-save" id="whpp-go">Save</button></div></div>';
    }
    function updateProductPanel() {
      const f = W.prod.draft, p = f.id ? prodBy(f.id) : null, pct = Number(D().settings.markupPct);
      const fee = num(f.fee), par = num(f.par);
      const box = $('whpp-price');
      if (box) {
        const avg = p ? Number(p.avgCost) : 0;
        box.innerHTML = '<div class="row-between" style="margin:0"><span>Average cost</span><b>' + (p && p.lastReceipt ? money(avg) + ' / cs' : 'No deliveries yet') + '</b></div>' +
          '<div class="muted" style="font-size:12px;margin-top:2px">' + (p && p.lastReceipt ? 'From deliveries; last one ' + esc(p.lastReceipt.ref) + ', ' + esc(day(p.lastReceipt.at)) + '. Not typed here.' : 'Set by the first delivery received. Not typed here.') + '</div>' +
          '<div class="row-between" style="margin:10px 0 0"><span>Store price</span><b>' + (fee === null || isNaN(fee) || fee < 0 ? '-' : money(storePrice(avg, round(fee, 2), pct)) + ' / cs') + '</b></div>' +
          '<div class="muted" style="font-size:12px;margin-top:2px">Average ' + money(avg) + ' + fee ' + (fee === null || isNaN(fee) ? '-' : money(round(fee, 2))) + ', markup ' + pct + '%. Fixed on each line when it ships.</div>';
      }
      const problems = [];
      if (!String(f.name).trim()) problems.push('give it a name');
      if (par === null || isNaN(par) || par < 0) problems.push('the par is a number of cases, 0 or more');
      if (fee === null || isNaN(fee) || fee < 0) problems.push('the handling fee is a dollar amount');
      if (f.limit && !f.stores.length) problems.push('pick at least one store, or choose Every store');
      const sum = $('whpp-sum'), go = $('whpp-go');
      if (sum) sum.textContent = problems.length ? upper(problems.join('; ')) + '.' : '';
      if (go) go.disabled = problems.length > 0;
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
      if (m.kind === 'count') return 'Count: ' + (m.reason || '');
      if (m.kind === 'shipped') return 'Shipped on ' + m.ref;
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

    // ---- Views ----
    function render(view) {
      if (!W.data) return;
      if (view === 'wh-inventory') renderInventory();
      if (view === 'wh-incoming') renderIncoming();
      if (view === 'wh-products') renderProducts();
      if (view === 'wh-history') renderHistory();
    }
    function badges() {
      if (!W.data) return;
      const n = openCount(), b = $('wh-badge-incoming'), dot = $('wh-dot-inventory');
      if (b) { b.hidden = !n; b.textContent = String(n); }
      if (dot) dot.hidden = !lowList().length;
    }
    function rerender() { render(host.view()); badges(); }

    // ---- Events ----
    document.addEventListener('click', async e => {
      const t = e.target.closest ? e.target.closest('button') : null;
      if (!t || t.disabled || !W.data || !t.closest('[id^="v-wh-"]')) return;
      const go = t.getAttribute('data-whgo');
      if (go) {
        W.inc.filter = 'open'; W.inc.sel = go;
        if (go === 'newpo') W.inc.po = { id: null, supplierId: '', locationId: (activeLocs()[0] || {}).id || '', note: '', lines: [blankLine()] };
        if (go === 'newtr') W.inc.tr = { fromId: '', toId: '', note: '', lines: [blankLine()] };
        say('whn-status', '', '');
        return host.go('wh-incoming');
      }
      const a = t.getAttribute('data-wh');
      // Inventory
      if (a === 'count-open') { W.inv.counting = true; W.inv.loc = W.inv.loc || (activeLocs()[0] || {}).id || null; W.inv.rows = {}; say('whi-status', '', ''); renderInventory(); const c = $('whc-h'); if (c) c.scrollIntoView({ block: 'start' }); return; }
      if (a === 'count-cancel') { W.inv.counting = false; W.inv.rows = {}; return renderInventory(); }
      if (a === 'count-save') {
        const done = await write('mog_wh_count', { p_count: countPayload(W.inv.loc, W.inv.rows) }, 'whi-status',
          x => 'Saved the count for ' + x.location + ': ' + plural(x.changed, 'product') + ' changed. Each is in Stock history with its reason.');
        if (done) { W.inv.counting = false; W.inv.rows = {}; }
        return rerender();
      }
      const invf = t.getAttribute('data-whinvf');
      if (invf) { W.inv.filter = invf; return renderInventory(); }
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
      // Products and prices
      const ps = t.getAttribute('data-whpsel');
      if (ps) { W.prod.sel = Number(ps); W.prod.draft = null; say('whp-status', '', ''); return renderProducts(); }
      if (a === 'prod-new') { W.prod.sel = 'new'; W.prod.draft = null; say('whp-status', '', ''); return renderProducts(); }
      if (a === 'prod-discard') { W.prod.sel = null; W.prod.draft = null; return renderProducts(); }
      const lim = t.getAttribute('data-whlimit');
      if (lim != null) { W.prod.draft.limit = lim === '1'; return renderProducts(); }
      const st = t.getAttribute('data-whstore');
      if (st) { const l = W.prod.draft.stores, i = l.indexOf(st); if (i >= 0) l.splice(i, 1); else l.push(st); return renderProducts(); }
      if (a === 'prod-save') {
        const f = W.prod.draft;
        const row = { name: f.name, pack: f.pack, par: num(f.par), handlingFee: num(f.fee), stores: f.limit ? f.stores : [], active: f.active };
        if (f.id) { row.id = f.id; row.version = f.version; }
        const done = await write('mog_wh_save', { p_kind: 'product', p_row: row }, 'whp-status', x => 'Saved ' + x.name + '.');
        if (done) { W.prod.sel = done.id; W.prod.draft = null; } else if (W.conflict) W.prod.draft = null;
        return rerender();
      }
      const tg = t.getAttribute('data-whtoggle');
      if (tg) {
        const list = tg === 'supplier' ? D().suppliers : D().locations, r = list.find(x => x.id === Number(t.getAttribute('data-id')));
        await write('mog_wh_save', { p_kind: tg, p_row: { id: r.id, name: r.name, active: !r.active } }, 'whp-status',
          x => (r.active ? (tg === 'location' ? 'Closed ' : 'Hid ') : (tg === 'location' ? 'Opened ' : 'Showing ')) + x.name + '.');
        return rerender();
      }
      const add = t.getAttribute('data-whadd');
      if (add) {
        const box = $('whadd-' + add), name = box.value.trim();
        if (!name) { box.focus(); return; }
        await write('mog_wh_save', { p_kind: add, p_row: { name: name } }, 'whp-status', x => 'Added ' + x.name + '.');
        return rerender();
      }
      if (a === 'settings-save') {
        const s = D().settings;
        await write('mog_wh_save', { p_kind: 'settings', p_row: { version: s.version, markupPct: num($('whs-pct').value), deliveryFee: num($('whs-fee').value) } },
          'whp-status', () => 'Saved the markup and delivery fee.');
        return rerender();
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
      if (t.getAttribute('data-whcloc')) { W.inv.loc = Number(t.value); W.inv.rows = {}; return renderInventory(); }
      const po = t.getAttribute('data-whpo');
      if (po && po !== 'note') { W.inc.po[po] = Number(t.value); return updatePoForm(); }
      const pol = t.getAttribute('data-whpol');
      if (pol != null && t.getAttribute('data-k') === 'productId') { W.inc.po.lines[Number(pol)].productId = Number(t.value); return updatePoForm(); }
      const tr = t.getAttribute('data-whtr');
      if (tr && tr !== 'note') { W.inc.tr[tr] = Number(t.value); if (tr === 'fromId' && W.inc.tr.toId === W.inc.tr.fromId) W.inc.tr.toId = ''; return renderIncoming(); }
      const trl = t.getAttribute('data-whtrl');
      if (trl != null && t.getAttribute('data-k') === 'productId') { W.inc.tr.lines[Number(trl)].productId = Number(t.value); return updateTrForm(); }
      if (t.getAttribute('data-whpf') === 'active') { W.prod.draft.active = t.checked; return updateProductPanel(); }
      const hh = t.getAttribute('data-whh');
      if (hh) { W.hist[hh] = t.value; return renderHistory(); }
    });
    document.addEventListener('input', e => {
      const t = e.target;
      if (!W.data || !t.closest || !t.closest('[id^="v-wh-"]')) return;
      const c = t.getAttribute('data-whc'), r = t.getAttribute('data-whr');
      if (c || r) { const k = c || r; W.inv.rows[k] = W.inv.rows[k] || {}; W.inv.rows[k][c ? 'counted' : 'reason'] = t.value; return updateCount(); }
      const rc = t.getAttribute('data-whrc'), rk = t.getAttribute('data-whrk');
      if (rc || rk) { const k = rc || rk; W.inc.rcv[k] = W.inc.rcv[k] || {}; W.inc.rcv[k][rc ? 'cases' : 'cost'] = t.value; return updateIncoming(); }
      if (t.getAttribute('data-whpo') === 'note') { W.inc.po.note = t.value; return; }
      const pol = t.getAttribute('data-whpol');
      if (pol != null) { W.inc.po.lines[Number(pol)][t.getAttribute('data-k')] = t.value; return updatePoForm(); }
      if (t.getAttribute('data-whtr') === 'note') { W.inc.tr.note = t.value; return; }
      const trl = t.getAttribute('data-whtrl');
      if (trl != null) { W.inc.tr.lines[Number(trl)][t.getAttribute('data-k')] = t.value; return updateTrForm(); }
      const pf = t.getAttribute('data-whpf');
      if (pf && pf !== 'active') { W.prod.draft[pf] = t.value; return updateProductPanel(); }
    });

    return { views: VIEWS, fetch: fetchData, take, render, badges, clear: () => { W.data = null; } };
  }

  root.HQWarehouse = { logic: logic, create: create };
})(typeof window !== 'undefined' ? window : this);
