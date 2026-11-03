'use strict';
// GATE: Happy Supply store orders, W2a (supabase/schema_v16.sql,
// docs/MOG_Warehouse_Spec.md §2 "W2a design"): the client code that calls it,
// run against the fake Supabase (fake_supabase.js mirrors v16; the SQL is
// pinned in Postgres by supabase/tests/smoke_v16.sql). Checks:
//   - catalogEdit.js commitHqProduct, link: the item's whProduct, Happy Supply
//     its main vendor (the old main kept as a backup, with a count-list row in
//     the item's area), the product's pack; Undo exact
//   - add: a new item linked, no par and no area; refused when the store has
//     that name, a product linked twice, an inactive or missing item
//   - a KM's later save keeps the link; a row read before the link is a
//     CONFLICT (the link is compared), not an unlinked item
//   - productCandidates: the close name first, a linked item never the default
//   - on random stores: nothing outside the one item (and its rows) changes
//   - hq/warehouse.js: the store price is the SQL's sum; Ship starts with
//     what's left after older sent orders, capped at the location's stock;
//     the shipment payload
//   - the phone (template/index.html): the needed-by dates from the delivery
//     days, the Send payload, the card's line
//   - through the fake: HQ links an item, the phone sees cases available,
//     sends (replaced while sent, another store's order held), Dan ships
//     short, the store marks it received, and no price ever reaches a phone
// Each has a planted-defect control.
//
// Run bare: node tests/wh_orders.test.js
// A passing run ends with "wh_orders: ALL PASS".

const vm = require('vm');
const F = require('./fake_apps_script.js');
const { FakeSupabase, checkCatalogTables } = require('./fake_supabase.js');
const { slices } = require('./slice_js.js');

const SRC = file => F.source(null, file);
const CE_FILE = 'template/editor/catalogEdit.js', WH_FILE = 'template/hq/warehouse.js', PHONE_FILE = 'template/index.html';
const clone = x => JSON.parse(JSON.stringify(x));
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const STORES = Number(process.argv[2]) || 150;

function loadCE(text) {
  const ctx = { console };
  vm.createContext(ctx);
  vm.runInContext(text, ctx, { filename: CE_FILE });
  return ctx.CatalogEdit;
}
function loadWH(text) {
  const ctx = { console };
  vm.createContext(ctx);
  vm.runInContext(text, ctx, { filename: WH_FILE });
  return ctx.HQWarehouse.logic;
}
const STRINGS = { hsLineSent: 'Sent {num}', hsNeededBy: 'Needed by', hsLineShipped: 'Shipped {a} of {b} cases', hsFrom: 'from',
                  hsLineReceived: 'Received · {a} cases', hsLineCancelled: '{num} cancelled by Happy Supply' };
function loadPhone(html) {
  const ctx = { console, Date, state: { lang: 'en' }, direct: { mode: 'direct', live: {}, catalog: null },
                t: k => STRINGS[k] || k, fmtQty_: n => String(Number(n)), computeSuggested: it => it.sug };
  vm.createContext(ctx);
  vm.runInContext(slices(html, ['hs_', 'hsIsVendor_', 'hsLinked_', 'hsAvailable_', 'hsCardOrder_', 'hsYmd_', 'hsDay_',
                                'hsDeliveryDates_', 'hsSendPayload_', 'hsOrderLine_']), ctx);
  return ctx;
}
function rng(seed) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
}
const pick = (rnd, arr) => arr[Math.floor(rnd() * arr.length)];

function storeTables() {
  return checkCatalogTables({
    vendors: [{ name: 'Sysco', mults: [1, 1, 1, 1, 1, 0, 0], cutoff: null }, { name: 'Happy Supply', mults: [0, 2, 0, 3, 0, 0, 0], cutoff: null }],
    areas: [{ name: 'Freezer', ord: 10 }, { name: 'Dry Storage', ord: 20 }],
    items: [
      { id: 'ITEM-0003', name: 'SHRIMP 16-20', primaryVendor: 'Sysco', pack: 'CASE', par: 10, active: true, useMult: true, notes: '', sku: '', category: '', eligible: ['Sysco'], seq: 2 },
      { id: 'ITEM-0004', name: 'Crab Legs', primaryVendor: 'Happy Supply', pack: '20 LB case', par: 4, active: true, useMult: true, notes: '', sku: '', category: '', eligible: ['Happy Supply'], seq: 3 },
      { id: 'ITEM-0005', name: 'Rice', primaryVendor: 'Sysco', pack: 'BAG', par: 2, active: true, useMult: true, notes: '', sku: '', category: '', eligible: ['Sysco'], seq: 4 },
      { id: 'ITEM-0006', name: 'Old Shrimp Tempura', primaryVendor: 'Sysco', pack: 'CS', par: 1, active: false, useMult: true, notes: '', sku: '', category: '', eligible: ['Sysco'], seq: 5 }
    ],
    pickRows: [
      { vendor: 'Sysco', id: 'ITEM-0003', area: 'Freezer', shelfOrder: 10, seq: 2 },
      { vendor: 'Happy Supply', id: 'ITEM-0004', area: 'Freezer', shelfOrder: 10, seq: 3 },
      { vendor: 'Sysco', id: 'ITEM-0005', area: 'Dry Storage', shelfOrder: 10, seq: 4 }
    ]
  });
}
function randomTables(rnd) {
  const names = ['Sysco', 'Happy Supply', 'ELPIS', 'Baldor'].slice(0, 2 + Math.floor(rnd() * 3));
  const items = [], pickRows = [];
  let seq = 2, rowSeq = 2;
  const n = 3 + Math.floor(rnd() * 12);
  for (let i = 1; i <= n; i++) {
    const id = 'ITEM-' + String(i).padStart(4, '0');
    const primary = rnd() < 0.1 ? null : pick(rnd, names);
    const eligible = primary ? [primary].concat(names.filter(v => v !== primary && rnd() < 0.3)) : [];
    const active = rnd() < 0.85;
    items.push({ id, name: 'Item ' + i, primaryVendor: primary, pack: 'CS', par: rnd() < 0.2 ? null : 2, active, useMult: true,
                 notes: '', sku: '', category: '', eligible, seq: seq++ });
    if (!active || !primary) continue;
    const area = pick(rnd, ['Freezer', 'Dry Storage']);
    for (const v of eligible) if (v === primary || rnd() < 0.6) pickRows.push({ vendor: v, id, area, shelfOrder: 10, seq: rowSeq++ });
  }
  return checkCatalogTables({ vendors: names.map(nm => ({ name: nm, mults: [1, 0, 0, 0, 0, 0, 0], cutoff: null })),
                              areas: [{ name: 'Freezer', ord: 10 }, { name: 'Dry Storage', ord: 20 }], items, pickRows });
}

const SHRIMP = { id: 7, name: 'Shrimp 16/20', pack: '10 LB case' }, CRAB = { id: 8, name: 'King crab legs 9/12', pack: '20 LB case' };

function problems(ceText, whText, phoneHtml) {
  const out = [];
  const bad = (what, detail) => { if (out.length < 30) out.push(what + (detail ? ': ' + detail : '')); };
  const refused = fn => { try { fn(); return ''; } catch (e) { return e.message || String(e); } };
  const rules = (tb, what) => { try { checkCatalogTables(clone(tb)); } catch (e) { bad(what + ' rules', e.message); } };
  let CE, WH, PH;
  try { CE = loadCE(ceText); } catch (e) { return ['catalogEdit.js did not load: ' + e.message]; }
  try { WH = loadWH(whText); } catch (e) { return ['warehouse.js did not load: ' + e.message]; }
  try { PH = loadPhone(phoneHtml); } catch (e) { return ['the phone\'s Happy Supply code did not load: ' + e.message]; }
  if (CE.writes.indexOf('commitHqProduct') < 0 || typeof CE.productCandidates !== 'function') return ['commitHqProduct is not registered'];
  const run = (tb, args) => { const c = CE.call(tb, 'commitHqProduct', [args]); return { c, a: CE.applyOps(tb, c.ops) }; };
  const itemOf = (tb, id) => tb.items.find(x => x.id === id);

  // ---- Link an item the store has ----
  const t = storeTables();
  const link = run(t, { vendor: null, vendorName: 'Happy Supply', product: SHRIMP, link: 'ITEM-0003', item: { name: SHRIMP.name } });
  const s1 = itemOf(link.a, 'ITEM-0003');
  if (link.c.result.mode !== 'link' || s1.whProduct !== 7) bad('link: the item carries the product', JSON.stringify(s1));
  if (s1.primaryVendor !== 'Happy Supply' || s1.eligible.indexOf('Sysco') < 0 || s1.eligible.indexOf('Happy Supply') < 0) bad('link: Happy Supply main, Sysco a backup', JSON.stringify(s1));
  if (s1.pack !== '10 LB case' || s1.par !== 10) bad('link: the product\'s pack, the par kept', JSON.stringify(s1));
  if (!link.a.pickRows.some(r => r.vendor === 'Happy Supply' && r.id === 'ITEM-0003' && r.area === 'Freezer') ||
      !link.a.pickRows.some(r => r.vendor === 'Sysco' && r.id === 'ITEM-0003')) bad('link: a Happy Supply count-list row in its area, the Sysco one kept', JSON.stringify(link.a.pickRows));
  if (!/^HQ: linked "SHRIMP 16-20" to Happy Supply's Shrimp 16\/20; Happy Supply its main vendor, Sysco a backup; pack CASE → 10 LB case$/.test(link.c.label)) bad('link: the change\'s label', link.c.label);
  if (link.a.items.filter(x => !same(x, itemOf(t, x.id))).length !== 1) bad('link: another item changed');
  rules(link.a, 'link');
  if (!same(CE.applyOps(link.a, CE.inverseOps(link.c.ops)), t)) bad('link: Undo is not exact');

  // ---- Add a new one ----
  const add = run(t, { vendor: null, vendorName: 'Happy Supply', product: CRAB, link: '', item: { name: CRAB.name } });
  const c1 = add.a.items.find(x => x.name === CRAB.name);
  if (add.c.result.mode !== 'add' || !c1 || c1.whProduct !== 8 || c1.primaryVendor !== 'Happy Supply' || c1.par !== null || c1.pack !== '20 LB case' ||
      add.a.pickRows.some(r => r.id === c1.id)) bad('add: a new linked item, no par and no area', JSON.stringify(c1));
  if (add.c.label !== 'HQ: added "King crab legs 9/12" (' + (c1 && c1.id) + ') from Happy Supply\'s King crab legs 9/12') bad('add: the label', add.c.label);
  rules(add.a, 'add');
  if (!same(CE.applyOps(add.a, CE.inverseOps(add.c.ops)), t)) bad('add: Undo is not exact');

  // ---- Refusals ----
  if (!/link it instead/.test(refused(() => CE.call(t, 'commitHqProduct', [{ vendorName: 'Happy Supply', product: SHRIMP, link: '', item: { name: 'shrimp 16-20' } }])))) bad('refusal: a name the store has was added again');
  if (!/linked to Shrimp 16\/20 here already/.test(refused(() => CE.call(link.a, 'commitHqProduct', [{ vendorName: 'Happy Supply', product: SHRIMP, link: 'ITEM-0005' }])))) bad('refusal: a product linked to two items');
  if (!/inactive/.test(refused(() => CE.call(t, 'commitHqProduct', [{ vendorName: 'Happy Supply', product: SHRIMP, link: 'ITEM-0006' }])))) bad('refusal: an inactive item linked');
  if (!/any more/.test(refused(() => CE.call(t, 'commitHqProduct', [{ vendorName: 'Happy Supply', product: SHRIMP, link: 'ITEM-9999' }])))) bad('refusal: a missing item linked');
  if (!/Vendor "Nobody" is not in/.test(refused(() => CE.call(t, 'commitHqProduct', [{ vendorName: 'Nobody', product: SHRIMP, link: 'ITEM-0003' }])))) bad('refusal: an unknown vendor');
  if (!/Which product/.test(refused(() => CE.call(t, 'commitHqProduct', [{ vendorName: 'Happy Supply', product: {}, link: 'ITEM-0003' }])))) bad('refusal: no product');

  // ---- A KM's save keeps the link; a stale row is a CONFLICT ----
  const km = CE.call(link.a, 'commitUpsertItem', [{ mode: 'edit', lookup: 'ITEM-0003', name: 'SHRIMP 16-20', vendor: 'Happy Supply', pack: '10 LB case',
                                                     par: 12, useMult: true, active: true, areaName: 'Freezer' }]);
  const afterKm = CE.applyOps(link.a, km.ops);
  if (itemOf(afterKm, 'ITEM-0003').whProduct !== 7 || itemOf(afterKm, 'ITEM-0003').par !== 12) bad('a KM\'s save dropped the link', JSON.stringify(itemOf(afterKm, 'ITEM-0003')));
  const staleKm = CE.call(t, 'commitUpsertItem', [{ mode: 'edit', lookup: 'ITEM-0003', name: 'SHRIMP 16-20', vendor: 'Sysco', pack: 'CASE',
                                                    par: 11, useMult: true, active: true, areaName: 'Freezer' }]);
  const onlyLink = clone(t);
  itemOf(onlyLink, 'ITEM-0003').whProduct = 7;
  if (!/CONFLICT/.test(refused(() => CE.applyOps(onlyLink, staleKm.ops)))) bad('a row read before the link was taken (the link is not compared)');

  // ---- Candidates ----
  const cand = CE.productCandidates(t, 'Shrimp 16/20');
  if (cand.best !== 'ITEM-0003' || cand.items[0].id !== 'ITEM-0003' || cand.items.some(x => x.id === 'ITEM-0006')) bad('candidates: the close name first, inactive left out', JSON.stringify(cand));
  if (CE.productCandidates(link.a, 'Shrimp 16/20').best === 'ITEM-0003') bad('candidates: an item already linked is the default');
  if (CE.productCandidates(t, 'Lobster tails').best !== '') bad('candidates: a default with no close name');

  // ---- Random stores: only the one item changes ----
  for (let seed = 1; seed <= STORES; seed++) {
    const rnd = rng(seed), rt = randomTables(rnd);
    const live = rt.items.filter(x => x.active === true);
    const target = live.length && rnd() < 0.7 ? pick(rnd, live) : null;
    let rc;
    try { rc = run(rt, { vendorName: 'Happy Supply', product: { id: 50 + seed, name: 'Product ' + seed, pack: 'CASE 10' }, link: target ? target.id : '', item: { name: 'Product ' + seed } }); }
    catch (e) { bad('random threw', 'seed ' + seed + ': ' + e.message); continue; }
    const id = target ? target.id : rc.c.result.id;
    for (const it of rc.a.items) if (it.id !== id && !same(it, itemOf(rt, it.id))) { bad('random: another item changed', 'seed ' + seed + ' ' + it.id); break; }
    for (const r of rc.a.pickRows) if (r.id !== id && !rt.pickRows.some(x => same(x, r))) { bad('random: another count-list row changed', 'seed ' + seed); break; }
    if (itemOf(rc.a, id).whProduct !== 50 + seed || itemOf(rc.a, id).primaryVendor !== 'Happy Supply') bad('random: the item is not linked to Happy Supply', 'seed ' + seed);
    rules(rc.a, 'random seed ' + seed);
    if (!same(CE.applyOps(rc.a, CE.inverseOps(rc.c.ops)), rt)) bad('random undo', 'seed ' + seed);
  }

  // ---- hq/warehouse.js ----
  if (WH.storePrice(77.3095, 6, 5) !== 87.47 || WH.storePrice(120, 10, 0) !== 130) bad('warehouse: the store price is not the SQL\'s sum (smoke_v16 pins 87.47)');
  const products = [{ id: 7, stock: { 1: 9 } }, { id: 8, stock: { 1: 14, 2: 6 } }, { id: 9, stock: { 1: 3, 2: 3 } }];
  const orders = [
    { id: 6, number: 'HS-0006', status: 'sent', sentAt: '2026-11-02T13:30:00Z', lines: [{ ord: 1, productId: 7, cases: 5 }] },
    { id: 7, number: 'HS-0007', status: 'sent', sentAt: '2026-11-02T14:12:00Z', lines: [{ ord: 1, productId: 7, cases: 8 }, { ord: 2, productId: 8, cases: 2 }] },
    { id: 5, number: 'HS-0005', status: 'shipped', sentAt: '2026-11-01T14:00:00Z', lines: [{ ord: 1, productId: 7, cases: 3 }] },
    { id: 8, number: 'HS-0008', status: 'sent', sentAt: '2026-11-02T15:00:00Z', lines: [{ ord: 1, productId: 9, cases: 5 }] }
  ];
  const p7 = WH.shipPrefill(orders, products, orders[1]);
  if (!same(p7.map(x => [x.ord, x.cases, x.locationId, x.left, x.held]), [[1, 4, 1, 4, 5], [2, 2, 1, 20, 0]]) || p7[0].olderOrders.join() !== 'HS-0006') bad('warehouse: Ship starts with what\'s left after older sent orders', JSON.stringify(p7));
  if (WH.shipPrefill(orders, products, orders[0])[0].cases !== 5) bad('warehouse: the oldest order is held back by a newer one');
  if (WH.shipPrefill(orders, products, orders[3])[0].cases !== 3) bad('warehouse: Ship starts above what the location holds');
  if (!same(WH.shipPayload(orders[1], { 1: { cases: '4', locationId: '1' }, 2: { cases: '', locationId: '2' } }),
            { id: 7, version: undefined, lines: [{ ord: 1, cases: 4, locationId: 1 }, { ord: 2, cases: 0 }] })) bad('warehouse: the shipment payload', JSON.stringify(WH.shipPayload(orders[1], { 1: { cases: '4', locationId: '1' } })));

  // ---- The phone ----
  PH.direct.catalog = { vendorMults: { 'Happy Supply': { Mon: 0, Tue: 2, Wed: 0, Thu: 3, Fri: 0, Sat: 0, Sun: 0 } } };
  const dates = vm.runInContext('hsDeliveryDates_("Happy Supply", "2026-11-02")', PH);
  if (dates.join() !== '2026-11-04,2026-11-06,2026-11-11') bad('phone: the needed-by dates from the delivery days', dates.join());
  PH.direct.catalog.vendorMults['Happy Supply'].Mon = 3;
  if (vm.runInContext('hsDeliveryDates_("Happy Supply", "2026-11-02")', PH)[0] !== '2026-11-03') bad('phone: an order day itself delivers tomorrow');
  const payload = vm.runInContext('hsSendPayload_("Happy Supply", [{ id: "ITEM-0003", sug: 8 }, { id: "ITEM-0004", sug: 2.5 }], "2026-11-04", "  Running low ", "Maria")', PH);
  if (!same(payload, { vendor: 'Happy Supply', neededBy: '2026-11-04', note: 'Running low', by: 'Maria', lines: [{ itemId: 'ITEM-0003', cases: 8 }, { itemId: 'ITEM-0004', cases: 2.5 }] })) bad('phone: the Send payload', JSON.stringify(payload));
  const line = vm.runInContext('hsOrderLine_(' + JSON.stringify({ status: 'shipped', number: 'HS-0007', from: 'Berliner',
    lines: [{ cases: 6, casesShipped: 4 }, { cases: 2, casesShipped: 2 }] }) + ')', PH);
  if (line !== 'Shipped 6 of 8 cases · from Berliner') bad('phone: the card\'s line for a short shipment', line);

  // ---- Through the fake Supabase ----
  const sb = new FakeSupabase(Date.UTC(2026, 10, 2, 15));
  for (const slug of ['zza', 'zzb']) {
    sb.provision(slug);
    const s = sb.stores.get(slug);
    Object.assign(s, { pins: { pin: '4321' }, editorDirect: true, phoneDirect: true, version: 1,
      profile: { location: 'Test ' + slug + ' BOH', abbr: slug, concept: 'roll-play', timeZone: 'America/New_York' }, tables: storeTables() });
    s.state = { cycleDate: '2026-11-02', dayOfWeek: 'Mon', emergencyOverride: false, vendorPicks: {}, todaysLog: [] };
    sb.editorPublish(s);
  }
  const code = sb.hqInvite('Sebastian', ['hq', 'warehouse']);
  const tok = sb.handle('mog_hq_claim', { p_name: 'Sebastian', p_code: code, p_passphrase: 'correct horse battery' }).data.token;
  const wh = (fn, p) => sb.handle(fn, Object.assign({ p_token: tok }, p));
  const loc = wh('mog_wh_save', { p_kind: 'location', p_row: { name: 'Berliner' } }).data.done.id;
  const pid = wh('mog_wh_save', { p_kind: 'product', p_row: { name: 'Shrimp 16/20', pack: '10 LB case', par: 12, handlingFee: 6, stores: [], active: true } }).data.done.id;
  wh('mog_wh_count', { p_count: { locationId: loc, lines: [{ productId: pid, cases: 9, reason: 'first count' }] } });
  const ptok = slug => sb.handle('mog_login', { p_slug: slug, p_pin: '4321' }).data.token;
  const pa = ptok('zza'), pb = ptok('zzb');
  const snap = tk => sb.handle('mog_snapshot2', { p_token: tk, p_have_version: null }).data;
  if ('happySupply' in snap(pa)) bad('fake: a store with no link reads Happy Supply');
  const hqData = sb.handle('mog_hq_data', { p_token: tok }).data;
  const plan = ['zza', 'zzb'].map(slug => ({ slug, call: CE.call(hqData.stores.find(x => x.slug === slug).tables, 'commitHqProduct',
    [{ vendorName: 'Happy Supply', product: { id: pid, name: 'Shrimp 16/20', pack: '10 LB case' }, link: 'ITEM-0003', item: { name: 'Shrimp 16/20' } }]) }));
  const applied = sb.handle('mog_hq_apply', { p_token: tok, p_changes: plan.map(x => ({ slug: x.slug, label: x.call.label, ops: x.call.ops })),
    p_links: plan.map(x => ({ slug: x.slug, hqName: 'Happy Supply', vendor: 'Happy Supply' })) });
  if (!applied.ok) return out.concat(['fake: HQ\'s link was refused: ' + JSON.stringify(applied)]);
  const hs0 = snap(pa).happySupply;
  if (!hs0 || hs0.vendor !== 'Happy Supply' || !hs0.items['ITEM-0003'] || hs0.items['ITEM-0003'].available !== 9) bad('fake: the phone sees its linked item and cases available', JSON.stringify(hs0));
  const send = (tk, lines, extra) => sb.handle('mog_wh_send', { p_token: tk, p_order: Object.assign({ vendor: 'Happy Supply', neededBy: '2026-11-04', note: '', by: 'Maria', lines }, extra || {}) });
  const sb1 = send(pb, [{ itemId: 'ITEM-0003', cases: 5 }]);
  const sa1 = send(pa, [{ itemId: 'ITEM-0003', cases: 8 }]);
  if (!sb1.ok || !sa1.ok || sa1.data.happySupply.items['ITEM-0003'].available !== 4) bad('fake: another store\'s sent order holds its cases, the store\'s own doesn\'t', JSON.stringify(sa1));
  const sa2 = send(pa, [{ itemId: 'ITEM-0003', cases: 6 }]);
  if (!sa2.ok || sa2.data.order.id !== sa1.data.order.id || sa2.data.order.version !== 2) bad('fake: sending again replaces the order', JSON.stringify(sa2));
  if (!/isn't linked/.test(send(pa, [{ itemId: 'ITEM-0005', cases: 1 }]).error || '')) bad('fake: an unlinked item was sent');
  const orders1 = wh('mog_wh_data', {}).data.orders;
  const oa = orders1.find(o => o.slug === 'zza');
  const pre = WH.shipPrefill(orders1, wh('mog_wh_data', {}).data.products, oa);
  if (pre[0].cases !== 4) bad('fake: Dan\'s Ship starts with 4 (9 less Founders\' older 5)', JSON.stringify(pre));
  const ship = wh('mog_wh_ship', { p_ship: WH.shipPayload(oa, { 1: { cases: String(pre[0].cases), locationId: String(pre[0].locationId) } }) });
  if (!ship.ok || ship.data.done.cases !== 4) bad('fake: Dan ships short', JSON.stringify(ship));
  const hs1 = snap(pa).happySupply;
  if (hs1.orders[0].status !== 'shipped' || hs1.orders[0].lines[0].casesShipped !== 4 || hs1.orders[0].from !== 'Berliner') bad('fake: the phone sees it shipped', JSON.stringify(hs1.orders[0]));
  const rec = sb.handle('mog_wh_received', { p_token: pa, p_receipt: { id: oa.id, by: 'Maria', lines: [{ ord: 1, cases: 3 }] } });
  if (!rec.ok || rec.data.order.status !== 'received' || rec.data.order.lines[0].casesReceived !== 3) bad('fake: Mark received', JSON.stringify(rec));
  for (const [what, a] of [['send', sa1], ['shipped read', { data: { happySupply: hs1 } }], ['received', rec]]) {
    if (/price|fee|cost/i.test(JSON.stringify(a.data))) bad('fake: a price reached the phone (' + what + ')');
  }
  const ua = sb.stores.get('zza').changeLog.find(l => /^HQ: linked/.test(l.label));
  const ed = sb.handle('mog_editor_login', { p_slug: 'zza', p_pin: '4321' });
  const un = sb.handle('mog_editor_undo', { p_token: ed.data.token, p_change_id: ua.id, p_by: 'GM' });
  if (!un.ok || itemOf(sb.stores.get('zza').tables, 'ITEM-0003').whProduct !== undefined || 'happySupply' in snap(pa) && snap(pa).happySupply.items['ITEM-0003']) bad('fake: the store\'s Undo of HQ\'s link', JSON.stringify(un));
  return out;
}

let failed = 0;
const CE_TEXT = SRC(CE_FILE), WH_TEXT = SRC(WH_FILE), PHONE = SRC(PHONE_FILE);
const main = problems(CE_TEXT, WH_TEXT, PHONE);
if (main.length) { failed++; console.log('FAIL  ' + main.join('\n      ')); }
else console.log('PASS  Happy Supply orders: HQ links or adds an item (Undo exact, ' + STORES + ' random stores untouched), a KM\'s save keeps the link, ' +
                 'Ship starts with what\'s left, the phone\'s dates and payload, and Send, Ship and Mark received through the fake Supabase');

const CONTROLS = [
  { file: 'ce', name: 'linking leaves the old main vendor off',
    find: "        if (!(it.eligible || []).some(v => s_(v).toLowerCase() === hs.toLowerCase())) setItemsVendor(w, [s_(it.id)], hs, true);\n        switchActiveVendor(w, s_(it.id), hs);",
    replace: "        it.primaryVendor = hs; it.eligible = [hs];" },
  { file: 'ce', name: 'the link is not compared',
    find: "    items:    ['name', 'primaryVendor', 'pack', 'par', 'active', 'useMult', 'notes', 'sku', 'category', 'eligible', 'lto', 'whProduct'],",
    replace: "    items:    ['name', 'primaryVendor', 'pack', 'par', 'active', 'useMult', 'notes', 'sku', 'category', 'eligible', 'lto']," },
  { file: 'ce', name: 'a product can be linked twice',
    find: "    if (other) throw new Error",
    replace: "    if (false) throw new Error" },
  { file: 'ce', name: 'a new item is not linked',
    find: "    it.whProduct = pid;\n    return { ok: true, mode: 'add'",
    replace: "    return { ok: true, mode: 'add'" },
  { file: 'ce', name: 'a linked item is the default candidate',
    find: "    const best = scored.find(x => x.close && !x.linked) || null;",
    replace: "    const best = scored.find(x => x.close) || null;" },
  { file: 'wh', name: 'Ship starts with what was ordered',
    find: "      return { ord: l.ord, cases: Math.min(Number(l.cases), left, loc === null ? 0 : Number(stock[String(loc)])),",
    replace: "      return { ord: l.ord, cases: Number(l.cases)," },
  { file: 'wh', name: 'newer orders hold stock too',
    find: "(x.sentAt < o.sentAt || (x.sentAt === o.sentAt && x.id < o.id))",
    replace: "true" },
  { file: 'phone', name: 'needed-by is the order day\'s delivery whatever the days',
    find: "      if (Number(m[DAYS[day.getDay()]]) > 0) out.push(",
    replace: "      if (true) out.push(" },
  { file: 'phone', name: 'Send sends the on-hand count',
    find: "lines: toOrder.map(it => ({ itemId: it.id, cases: computeSuggested(it) })) };",
    replace: "lines: toOrder.map(it => ({ itemId: it.id, cases: it.onHand })) };" }
];
for (const c of CONTROLS) {
  let res;
  try {
    res = problems(c.file === 'ce' ? F.plant(CE_TEXT, c.find, c.replace) : CE_TEXT,
                   c.file === 'wh' ? F.plant(WH_TEXT, c.find, c.replace) : WH_TEXT,
                   c.file === 'phone' ? F.plant(PHONE, c.find, c.replace) : PHONE);
  } catch (e) { failed++; console.log(`FAIL  control "${c.name}" crashed instead of biting: ${e.message}`); continue; }
  if (res.length) console.log(`PASS  control "${c.name}" bites (${res[0].slice(0, 110)})`);
  else { failed++; console.log(`FAIL  control "${c.name}" did NOT bite`); }
}

console.log(failed ? `wh_orders: ${failed} FAILED` : 'wh_orders: ALL PASS');
process.exit(failed ? 1 : 0);
