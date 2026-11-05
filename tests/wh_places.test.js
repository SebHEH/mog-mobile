'use strict';
// GATE: HEH's stock at three places, W2c (supabase/schema_v20.sql,
// docs/MOG_Warehouse_Spec.md §2 "W2c design"): the client code that reads and
// writes it, run against the fake Supabase (fake_supabase.js mirrors v20; the
// SQL is pinned in Postgres by supabase/tests/smoke_v20.sql). Checks:
//   - hq/warehouse.js logic: an item sits at its places (not by its v17 via
//     once it has places), a place's kind, a low point, an item's save (its
//     places and low points) and the counts it makes (only a changed Now), a
//     place's save (no holder for HEH's own, no store for a vendor's), HQ's
//     check-in of a shipment into a place (a blank line as shipped), a
//     month's span, who took what as CSV
//   - through the fake: HQ makes Happy Supply's own place and a place at a
//     store (RP Tysons) with the page's payloads, an item at both with low
//     points; each store's item linked; the holder counts on Happy Supply,
//     the taker on the place; the holder's order ships into the place (no
//     price), HQ checks it in; the taker's close records a delivery from the
//     place and never the holder's; its check-in; a count; who took what
// Each has a planted-defect control.
//
// Run bare: node tests/wh_places.test.js
// A passing run ends with "wh_places: ALL PASS".

const vm = require('vm');
const F = require('./fake_apps_script.js');
const { FakeSupabase, checkCatalogTables } = require('./fake_supabase.js');

const SRC = file => F.source(null, file);
const CE_FILE = 'template/editor/catalogEdit.js', WH_FILE = 'template/hq/warehouse.js';
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

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

const item = (id, name, vendor, eligible, seq) => ({ id, name, primaryVendor: vendor, pack: 'CASE (10LBs)', par: 6, active: true, useMult: true,
  notes: '', sku: '', category: '', eligible, seq });
function holderTables() {
  return checkCatalogTables({
    vendors: [{ name: 'Happy Supply', mults: [0, 1, 0, 1, 0, 0, 0], cutoff: null }, { name: 'Capital', mults: [1, 1, 1, 1, 1, 0, 0], cutoff: null }],
    areas: [{ name: 'Freezer', ord: 10 }],
    items: [item('ITEM-0001', 'Shrimp 21/25 P&D', 'Happy Supply', ['Happy Supply', 'Capital'], 2)],
    pickRows: [{ vendor: 'Happy Supply', id: 'ITEM-0001', area: 'Freezer', shelfOrder: 10, seq: 2 },
               { vendor: 'Capital', id: 'ITEM-0001', area: 'Freezer', shelfOrder: 10, seq: 3 }]
  });
}
function takerTables() {
  return checkCatalogTables({
    vendors: [{ name: 'Transfer (Tysons)', mults: [1, 0, 1, 0, 1, 0, 0], cutoff: null }],
    areas: [{ name: 'Freezer', ord: 10 }],
    items: [item('ITEM-0001', 'Shrimp 21/25 P&D', 'Transfer (Tysons)', ['Transfer (Tysons)'], 2)],
    pickRows: [{ vendor: 'Transfer (Tysons)', id: 'ITEM-0001', area: 'Freezer', shelfOrder: 10, seq: 2 }]
  });
}

function problems(whText) {
  const out = [], bad = (what, got) => out.push(what + (got === undefined ? '' : ' (got ' + (typeof got === 'string' ? got : JSON.stringify(got)) + ')'));
  const L = loadWH(whText), CE = loadCE(SRC(CE_FILE));

  // ---- The page's logic ----
  const tys = { id: 3, name: 'RP Tysons', heldBy: 'RP Tysons', heldStore: 'zzt', active: true }, elp = { id: 4, name: 'Elpis', heldBy: 'Elpis Wholesale', active: true };
  const ber = { id: 1, name: 'Berliner', active: true };
  const placed = { id: 9, name: 'Shrimp', places: [{ locationId: 1, lowPoint: 20 }, { locationId: 3, lowPoint: 12 }], stock: { 1: 40, 3: 10 } };
  if (!L.fits(placed, tys) || !L.fits(placed, ber) || L.fits(placed, elp)) bad('logic: an item sits at its places');
  if (L.fits({ id: 8, via: 'Elpis Wholesale', stock: {} }, elp)) bad('logic: an item with no place sits nowhere (v21: its via retired)');
  // v21: a store's route, as HQ shows it
  const locs = [ber, tys, elp];
  const rr = Object.assign.bind(null, {});
  const ok = { slug: 'zzr', vendor: 'Transfer (Tysons)', mainVendor: 'Transfer (Tysons)', active: true, placeId: 3 };
  const st = r => L.routeStatus(r, placed, locs);
  if (!st(ok).ok) bad('logic: a route from a place that has it, under the main vendor, is fine', st(ok));
  if (st(rr(ok, { mainVendor: 'SamuelSon' })).reason !== 'moved') bad('logic: a store that moved its main vendor breaks the route', st(rr(ok, { mainVendor: 'SamuelSon' })));
  if (st(rr(ok, { vendor: null })).reason !== 'vendor') bad('logic: a route whose vendor was removed is broken', st(rr(ok, { vendor: null })));
  if (st(rr(ok, { active: false })).reason !== 'inactive') bad('logic: an inactive item\'s route is broken');
  if (st(rr(ok, { placeId: 4 })).reason !== 'place') bad('logic: a route from a place that doesn\'t have it is broken');
  if (st(rr(ok, { slug: 'zzt' })).reason !== 'place') bad('logic: a store taking from a place it holds is broken');
  if (!st(rr(ok, { placeId: null, vendor: 'Happy Supply', mainVendor: 'Happy Supply' })).ok) bad('logic: a route to HEH\'s own, for an item there, is fine');
  if (L.routeStatus(rr(ok, { placeId: null }), { id: 9, places: [{ locationId: 3, lowPoint: 0 }] }, locs).reason !== 'place') bad('logic: a route to HEH\'s own for an item not there is broken');
  if (L.placeKind(ber) !== 'own' || L.placeKind(tys) !== 'store' || L.placeKind(elp) !== 'vendor') bad('logic: a place\'s kind', [L.placeKind(ber), L.placeKind(tys), L.placeKind(elp)]);
  if (!L.isLow(placed, tys) || L.isLow(placed, ber)) bad('logic: below its low point at Tysons (10 of 12), not at Berliner (40 of 20)');
  if (L.isLow({ id: 7, places: [{ locationId: 3, lowPoint: 0 }], stock: { 3: 0 } }, tys)) bad('logic: a low point of 0 is none');
  const draft = { id: 9, version: 4, name: ' Shrimp ', pack: 'CASE (10LBs)', concept: 'roll-play', fee: '2.50', active: true,
                  places: [{ locationId: 1, low: '20', now: '40', reason: '' }, { locationId: 3, low: '', now: '12', reason: 'Sunday count' }, { locationId: 4, low: '1', now: '', reason: '' }] };
  const row = L.itemRow(draft);
  if (!same(row, { name: 'Shrimp', pack: 'CASE (10LBs)', handlingFee: 2.5, active: true, concept: 'roll-play',
                   places: [{ locationId: 1, lowPoint: 20 }, { locationId: 3, lowPoint: 0 }, { locationId: 4, lowPoint: 1 }], id: 9, version: 4 })) bad('logic: an item\'s save', row);
  const counts = L.itemCounts(draft, placed);
  if (!same(counts, [{ locationId: 3, lines: [{ productId: 9, cases: 12, reason: 'Sunday count' }] }])) bad('logic: an item\'s save counts only a changed Now', counts);
  const pr1 = L.placeRow({ id: 3, name: ' RP Tysons ', kind: 'store', heldBy: 'Transfer (Tysons)', heldStore: 'zzt', countHow: '', active: true });
  const pr2 = L.placeRow({ name: 'Elpis', kind: 'vendor', heldBy: 'Elpis Wholesale', heldStore: 'zzt', countHow: '', active: true });
  const pr3 = L.placeRow({ name: 'Berliner', kind: 'own', heldBy: 'x', heldStore: 'zzt', countHow: '', active: false });
  // v21: a place at a store sends no heldBy (the server holds it under its own name)
  if (!same(pr1, { name: 'RP Tysons', active: true, heldStore: 'zzt', countHow: 'marginedge', id: 3 })
      || !same(pr2, { name: 'Elpis', active: true, heldStore: null, countHow: 'report', heldBy: 'Elpis Wholesale' })
      || !same(pr3, { name: 'Berliner', active: false, heldStore: null, countHow: 'hq', heldBy: null })) bad('logic: a place\'s save', [pr1, pr2, pr3]);
  const mv = L.moveInPayload({ id: 5, version: 2, lines: [{ ord: 1, cases: 16, casesShipped: 16 }, { ord: 2, cases: 4, casesShipped: 3 }] }, { 1: '15' });
  if (!same(mv, { id: 5, version: 2, lines: [{ ord: 1, cases: 15 }, { ord: 2, cases: 3 }] })) bad('logic: a blank line of a shipment arrives as shipped', mv);
  if (!same(L.monthSpan('2026-10'), { from: '2026-09-30', to: '2026-10-31' }) || !same(L.monthSpan('2026-03'), { from: '2026-02-28', to: '2026-03-31' })) {
    bad('logic: a month\'s span', [L.monthSpan('2026-10'), L.monthSpan('2026-03')]);
  }
  const csv = L.takenCsv({ taken: [{ store: 'Rosslyn BOH', place: 'RP Tysons', product: 'Shrimp, 21/25', pack: 'CASE', cases: 5, deliveries: 1 }],
                           used: [{ store: 'RP Tysons BOH', place: 'RP Tysons', product: 'Shrimp', pack: 'CASE', cases: 6, counts: 2 }],
                           moved: [{ from: 'Berliner', place: 'RP Tysons', product: 'Shrimp', pack: 'CASE', cases: 15, shipments: 1 }] });
  if (csv !== 'What,Store,From,To,Item,Pack,Cases,How we know\nTaken,Rosslyn BOH,RP Tysons,,"Shrimp, 21/25",CASE,5,1 checked in\n' +
              'Used at its own place,RP Tysons BOH,RP Tysons,,Shrimp,CASE,6,from 2 counts\nMoved between places,,Berliner,RP Tysons,Shrimp,CASE,15,1 shipments\n') bad('logic: who took what as CSV', csv);

  // ---- Through the fake Supabase ----
  const sb = new FakeSupabase(Date.UTC(2026, 10, 2, 15));
  const keys = {};
  const mk = (slug, location, tables) => {
    keys[slug] = sb.provision(slug);
    const s = sb.stores.get(slug);
    Object.assign(s, { pins: { pin: '4321' }, editorDirect: true, phoneDirect: true, version: 1,
      profile: { location, abbr: slug, concept: 'roll-play', timeZone: 'America/New_York' }, tables });
    s.state = { cycleDate: '2026-11-02', dayOfWeek: 'Mon', emergencyOverride: false, vendorPicks: {}, todaysLog: [] };
    sb.editorPublish(s);
  };
  mk('zzt', 'Test Tysons BOH', holderTables());
  mk('zzr', 'Test Rosslyn BOH', takerTables());
  const code = sb.hqInvite('Sebastian', ['hq', 'warehouse']);
  const tok = sb.handle('mog_hq_claim', { p_name: 'Sebastian', p_code: code, p_passphrase: 'correct horse battery' }).data.token;
  const wh = (fn, p) => sb.handle(fn, Object.assign({ p_token: tok }, p));
  const berliner = wh('mog_wh_save', { p_kind: 'location', p_row: L.placeRow({ name: 'Berliner', kind: 'own', active: true }) }).data.done.id;
  const rt = wh('mog_wh_save', { p_kind: 'location', p_row: L.placeRow({ name: 'RP Tysons', kind: 'store', heldBy: 'Transfer (Tysons)', heldStore: 'zzt', active: true }) });
  if (!rt.ok) return out.concat(['fake: the place at a store was refused: ' + JSON.stringify(rt)]);
  const tysons = rt.data.done.id, loc = rt.data.locations.find(l => l.id === tysons);
  if (!(loc.heldStore === 'zzt' && loc.store === 'Test Tysons BOH' && loc.countHow === 'marginedge' && loc.heldBy === 'RP Tysons')) bad('fake: a place at a store, held under its own name, by its store\'s name', loc);
  const ri = wh('mog_wh_save', { p_kind: 'product', p_row: L.itemRow({ name: 'Shrimp 21/25 P&D', pack: 'CASE (10LBs)', concept: 'roll-play', fee: '2.50', active: true,
    places: [{ locationId: berliner, low: '20' }, { locationId: tysons, low: '12' }] }) });
  if (!ri.ok) return out.concat(['fake: the item was refused: ' + JSON.stringify(ri)]);
  const shrimp = ri.data.done.id;
  wh('mog_wh_count', { p_count: { locationId: berliner, lines: [{ productId: shrimp, cases: 40, reason: 'Opening count' }] } });
  wh('mog_wh_count', { p_count: { locationId: tysons, lines: [{ productId: shrimp, cases: 6, reason: 'Opening count from MarginEdge' }] } });
  const hq = sb.handle('mog_hq_data', { p_token: tok }).data;
  // v21: each store's route, with no remembered vendor names at all.
  const plan = [['zzt', null, 'Happy Supply'], ['zzr', tysons, 'Transfer (Tysons)']].map(([slug, place, v]) => ({ slug, call: CE.call(hq.stores.find(x => x.slug === slug).tables, 'commitHqRoutes',
    [{ product: { id: shrimp, name: 'Shrimp 21/25 P&D', pack: 'CASE (10LBs)' }, routes: [{ itemId: 'ITEM-0001', place, vendor: v }] }]) }));
  const applied = sb.handle('mog_hq_apply', { p_token: tok, p_changes: plan.map(x => ({ slug: x.slug, label: x.call.label, ops: x.call.ops })), p_links: [] });
  if (!applied.ok) return out.concat(['fake: HQ\'s links were refused: ' + JSON.stringify(applied)]);
  const ptok = slug => sb.handle('mog_login', { p_slug: slug, p_pin: '4321' }).data.token;
  const pt = ptok('zzt'), pr = ptok('zzr');
  const avail = tk => ((sb.handle('mog_snapshot2', { p_token: tk, p_have_version: null }).data.happySupply || {}).items || {})['ITEM-0001'];
  sb.nowMs += 60000;
  const at = avail(pt), ar = avail(pr);
  if (!at || at.available !== 40) bad('fake: the holder counts on Happy Supply\'s own (40)', at);
  if (!ar || ar.available !== 6) bad('fake: the taker counts on the place it orders from (6)', ar);

  // The holder's Happy Supply order ships into its place; HQ checks it in.
  const sent = sb.handle('mog_wh_send', { p_token: pt, p_order: { vendor: 'Happy Supply', by: 'Kim', lines: [{ itemId: 'ITEM-0001', cases: 16 }] } });
  if (!sent.ok) return out.concat(['fake: the holder\'s order was refused: ' + JSON.stringify(sent)]);
  const hs = sent.data.order;
  const shipped = wh('mog_wh_ship', { p_ship: { id: hs.id, version: hs.version, lines: [{ ord: 1, cases: 16, locationId: berliner }] } });
  const ho = shipped.ok ? shipped.data.orders.find(o => o.id === hs.id) : null;
  if (!ho || ho.lines[0].toLocation !== tysons || ho.lines[0].price !== null || ho.deliveryFee !== 0) bad('fake: the holder\'s order ships into its place, with no price', ho);
  const inTransit = wh('mog_wh_data', {}).data.products.find(p => p.id === shrimp).inTransit;
  if (inTransit !== 16) bad('fake: shipped into a place, it\'s in transit', inTransit);
  sb.nowMs += 60000;
  const ci = wh('mog_wh_held_receive', { p_receipt: L.moveInPayload(ho, { 1: '15' }) });
  const stockT = () => (wh('mog_wh_data', {}).data.products.find(p => p.id === shrimp).stock || {})[String(tysons)];
  if (!ci.ok || stockT() !== 21) bad('fake: HQ\'s check-in puts what arrived into the place (6 + 15)', ci.ok ? stockT() : ci);

  // The taker's close records a delivery from the place; never the holder's.
  sb.nowMs += 60000;
  const logRow = (vendor, qty) => ({ vendor, id: 'ITEM-0001', name: 'Shrimp 21/25 P&D', pack: '', area: 'Freezer', onHandPrev: 0, qty });
  const close = (slug, rows) => sb.handle('mog_sync_close_cycle', { p_slug: slug, p_key: keys[slug], p_closing: '2026-11-02', p_new_cycle: '2026-11-03',
    p_new_dow: 'Tue', p_rows: rows, p_todays_log: [], p_logged_at: '2026-11-03T08:30:00Z' });
  const c1 = close('zzr', [logRow('Transfer (Tysons)', 5)]), c2 = close('zzt', [logRow('Capital', 2)]);
  const dels = wh('mog_wh_data', {}).data.deliveries;
  const d1 = dels.find(o => o.slug === 'zzr' && o.heldAt === tysons);
  if (!c1.ok || !d1 || d1.lines[0].cases !== 5) bad('fake: the taker\'s close records its delivery from the place', dels);
  if (!c2.ok || dels.some(o => o.slug === 'zzt')) bad('fake: never a delivery from the holder\'s own place', dels);
  sb.nowMs += 60000;
  const got = sb.handle('mog_wh_received', { p_token: ptok('zzr'), p_receipt: { id: d1 ? d1.id : 0, by: 'Lee' } });
  if (!got.ok || stockT() !== 16) bad('fake: the taker\'s check-in takes it from the place (21 - 5)', got.ok ? stockT() : got);
  sb.nowMs += 60000;
  wh('mog_wh_count', { p_count: { locationId: tysons, lines: [{ productId: shrimp, cases: 10, reason: 'Sunday count from MarginEdge' }] } });
  const span = L.monthSpan('2026-11');
  const tk = wh('mog_wh_taken', { p_from: span.from, p_to: span.to });
  if (!tk.ok) return out.concat(['fake: who took what was refused: ' + JSON.stringify(tk)]);
  const T = tk.data;
  if (!T.taken.some(r => r.slug === 'zzr' && r.placeId === tysons && r.cases === 5 && r.deliveries === 1) || T.taken.some(r => r.slug === 'zzt')) bad('fake: taken by a store', T.taken);
  if (!same(T.used.map(r => [r.slug, r.placeId, r.cases, r.counts]), [['zzt', tysons, 6, 1]])) bad('fake: the holder\'s own use from its count, the opening count left out', T.used);
  if (!T.moved.some(r => r.fromId === berliner && r.placeId === tysons && r.cases === 15 && r.shipments === 1)) bad('fake: moved between places', T.moved);
  if (L.takenCsv(T).indexOf('Used at its own place,Test Tysons BOH,RP Tysons,,Shrimp 21/25 P&D,CASE (10LBs),6,from 1 counts') < 0) bad('fake: who took what\'s CSV', L.takenCsv(T));
  return out;
}

let failed = 0;
const WH_TEXT = SRC(WH_FILE);
const main = problems(WH_TEXT);
if (main.length) { failed++; console.log('FAIL  ' + main.join('\n      ')); }
else console.log('PASS  places: an item at its places, a place\'s kind, a route\'s status, low points, the item\'s and place\'s saves, HQ\'s check-in of a shipment, a month\'s span, ' +
                 'the CSV; through the fake, the holder\'s order into its place, the taker\'s delivery from it, a count and who took what');

const CONTROLS = [
  { name: 'a store that moved its main vendor still reads fine',
    find: "    if (String(r.mainVendor || '') !== String(r.vendor)) {",
    replace: "    if (false) {" },
  { name: 'a store can take from a place it holds',
    find: "      if (L.heldStore === r.slug) return",
    replace: "      if (false) return" },
  { name: 'a place at a store sends its vendor name',
    find: "    if (f.kind === 'vendor') row.heldBy = f.heldBy;",
    replace: "    if (f.kind !== 'own') row.heldBy = f.heldBy;" },
  { name: 'a place at a store reads as a vendor\'s',
    find: "return !loc || !loc.heldBy ? 'own' : loc.heldStore ? 'store' : 'vendor';",
    replace: "return !loc || !loc.heldBy ? 'own' : 'vendor';" },
  { name: 'a low point of 0 counts',
    find: "return low > 0 && fits(p, loc) && stockAt(p, loc.id) < low;",
    replace: "return fits(p, loc) && stockAt(p, loc.id) <= low;" },
  { name: 'a blank low point is sent as null',
    find: "lowPoint: num(x.low) === null ? 0 : num(x.low)",
    replace: "lowPoint: num(x.low)" },
  { name: 'an unchanged Now is counted too',
    find: "      if (round(n, 2) === (p ? stockAt(p, x.locationId) : 0)) continue;\n",
    replace: "" },
  { name: 'a vendor\'s place keeps a store',
    find: "heldStore: f.kind === 'store' ? f.heldStore : null, countHow: how };",
    replace: "heldStore: f.heldStore || null, countHow: how };" },
  { name: 'a blank line of a shipment arrives as 0',
    find: "return { ord: l.ord, cases: n === null ? Number(l.casesShipped || 0) : n };",
    replace: "return { ord: l.ord, cases: n === null ? 0 : n };" },
  { name: 'a month starts on its 1st (its first day left out)',
    find: "return { from: iso(new Date(Date.UTC(yy, mm - 1, 0))), to: iso(new Date(Date.UTC(yy, mm, 0))) };",
    replace: "return { from: iso(new Date(Date.UTC(yy, mm - 1, 1))), to: iso(new Date(Date.UTC(yy, mm, 0))) };" },
  { name: 'the CSV leaves out a store\'s own use',
    find: "    for (const r of t.used) rows.push(['Used at its own place', r.store, r.place, '', r.product, r.pack, r.cases, 'from ' + r.counts + ' counts']);\n",
    replace: "" }
];
for (const c of CONTROLS) {
  let res;
  try { res = problems(F.plant(WH_TEXT, c.find, c.replace)); }
  catch (e) { failed++; console.log(`FAIL  control "${c.name}" crashed instead of biting: ${e.message}`); continue; }
  if (res.length) console.log(`PASS  control "${c.name}" bites (${res[0].slice(0, 110)})`);
  else { failed++; console.log(`FAIL  control "${c.name}" did NOT bite`); }
}

console.log(failed ? `wh_places: ${failed} FAILED` : 'wh_places: ALL PASS');
process.exit(failed ? 1 : 0);
