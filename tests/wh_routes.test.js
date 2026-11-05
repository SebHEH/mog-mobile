'use strict';
// GATE: routes, schema v21 (docs/MOG_Warehouse_Spec.md §2, "Routes spec" and
// "v21 design"): Sebastian's shrimp as it is live (2026-11-05), set on HQ's
// item and run through the fake Supabase (fake_supabase.js mirrors v21; the
// SQL is pinned in Postgres by supabase/tests/smoke_v21.sql). Stores:
//   zzt  like RP Tysons BOH: holds the "Transfer (Tysons)" place, orders SHRIMP from Capital
//   zzr  like Rosslyn BOH: SHRIMP from "Transfer (Tysons)", SamuelSon a backup
//   zzf  like Founders BOH: SHRIMP from "Transfer (Tysons)", Capital a backup
//   zze  like Rosslyn FOH (TEST): RP Large Bowls from "Elpis"
// Checks:
//   - catalogEdit.js commitHqRoutes: one change per store in one HQ save with
//     no remembered vendor names: Rosslyn and Founders from the Tysons place
//     (nothing else changes), RP Tysons from HEH's own with Happy Supply added
//     in the same change (Capital a backup), the bowls from Elpis; the labels;
//     moving a route to another item; a rename and a removed vendor followed
//     on the client the way the database follows them
//   - hq/warehouse.js routeStatus over the warehouse read's routes: fine,
//     then broken when a store moves its main vendor, fine again after Put back,
//     broken when its vendor is removed
//   - the fake: the phones read each item's place (Tysons 104 for Rosslyn,
//     HEH's own 30 for RP Tysons); the close records only the route's lines;
//     RP Tysons' order ships into its place; a store's Undo takes HQ's change off
// Each has a planted-defect control.
//
// Run bare: node tests/wh_routes.test.js
// A passing run ends with "wh_routes: ALL PASS".

const vm = require('vm');
const F = require('./fake_apps_script.js');
const { FakeSupabase, checkCatalogTables } = require('./fake_supabase.js');

const SRC = file => F.source(null, file);
const CE_FILE = 'template/editor/catalogEdit.js', WH_FILE = 'template/hq/warehouse.js';
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const clone = x => JSON.parse(JSON.stringify(x));

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
const vendor = (name, mults) => ({ name, mults: mults || [0, 0, 1, 0, 1, 0, 1], cutoff: null });
const item = (id, name, main, eligible, par, seq, pack) => ({ id, name, primaryVendor: main, pack: pack || 'CASE (10LBs)', par, active: true, useMult: true,
  notes: '', sku: '', category: 'Protein', eligible, seq });
const rows = (items) => [].concat.apply([], items.map((it, i) => it.eligible.map((v, j) => ({ vendor: v, id: it.id, area: 'Walk-in Freezer', shelfOrder: 10 * (i + 1), seq: 2 + i * 3 + j }))));
function tables(vendors, items) {
  return checkCatalogTables({ vendors, areas: [{ name: 'Walk-in Freezer', ord: 10 }], items, pickRows: rows(items) });
}
const STORES = {
  zzt: ['Roll Play Tysons BOH', () => tables([vendor('Capital', [1, 1, 1, 1, 1.5, 0, 1]), vendor('Transfer (Rosslyn)')],
                                             [item('ITEM-0091', 'SHRIMP', 'Capital', ['Capital'], 6, 2)])],
  zzr: ['Roll Play Rosslyn BOH', () => tables([vendor('Transfer (Tysons)', [0, 0, 1.2, 0, 1.2, 0, 1]), vendor('SamuelSon')],
                                              [item('ITEM-0091', 'SHRIMP', 'Transfer (Tysons)', ['Transfer (Tysons)', 'SamuelSon'], 7.15, 2),
                                               item('ITEM-0185', '12QT CONTAINERS', 'Transfer (Tysons)', ['Transfer (Tysons)'], 15, 3, 'CASE')])],
  zzf: ['Roll Play Founders BOH', () => tables([vendor('Transfer (Tysons)'), vendor('Capital'), vendor('Transfer (Rosslyn)')],
                                               [item('ITEM-0091', 'SHRIMP', 'Transfer (Tysons)', ['Transfer (Tysons)', 'Capital'], 6, 2)])],
  zze: ['Roll Play Rosslyn FOH (TEST)', () => tables([vendor('Elpis', [0, 1, 0, 1, 0, 0, 0]), vendor('Transfer')],
                                                     [item('ITEM-0003', 'RP Large Bowls', 'Elpis', ['Elpis'], 3, 2, 'CASE (300)')])]
};

function problems(ceText, whText) {
  const out = [];
  const bad = (what, detail) => { if (out.length < 30) out.push(what + (detail ? ': ' + detail : '')); };
  let CE, WH;
  try { CE = loadCE(ceText); } catch (e) { return ['catalogEdit.js did not load: ' + e.message]; }
  try { WH = loadWH(whText); } catch (e) { return ['warehouse.js did not load: ' + e.message]; }
  if (CE.writes.indexOf('commitHqRoutes') < 0 || typeof WH.routeStatus !== 'function') return ['commitHqRoutes or routeStatus is missing'];
  const itemOf = (tb, id) => tb.items.find(x => x.id === id);

  // ---- The client follows a rename and a removed vendor the way the database does ----
  const zr = STORES.zzr[1]();
  itemOf(zr, 'ITEM-0091').whProduct = 18; itemOf(zr, 'ITEM-0091').whPlace = 9; itemOf(zr, 'ITEM-0091').whVendor = 'Transfer (Tysons)';
  const ren = CE.applyOps(zr, [{ rename: 'vendors', from: 'Transfer (Tysons)', to: 'Transfer TY' }]);
  if (itemOf(ren, 'ITEM-0091').whVendor !== 'Transfer TY') bad('client: a store\'s rename leaves the route\'s vendor behind', JSON.stringify(itemOf(ren, 'ITEM-0091')));
  let rm;
  try { rm = CE.applyOps(zr, CE.call(zr, 'commitRemoveVendor', ['Transfer (Tysons)']).ops); } catch (e) { bad('client: removing the vendor threw', e.message); }
  if (rm && ('whVendor' in itemOf(rm, 'ITEM-0091') || itemOf(rm, 'ITEM-0091').whPlace !== 9)) bad('client: a removed vendor stays the route\'s vendor (the place stays)', JSON.stringify(itemOf(rm, 'ITEM-0091')));
  // Moving a route to another of the store's items unlinks the old one.
  try {
    const mv = CE.call(zr, 'commitHqRoutes', [{ product: { id: 18, name: 'SHRIMP', pack: 'CASE (10LBs)' }, end: ['ITEM-0091'],
                                                routes: [{ itemId: 'ITEM-0185', place: 9, placeName: 'Transfer (Tysons)', vendor: 'Transfer (Tysons)' }] }]);
    const ma = CE.applyOps(zr, mv.ops);
    if ('whProduct' in itemOf(ma, 'ITEM-0091') || itemOf(ma, 'ITEM-0185').whProduct !== 18) bad('client: a route moved to another item leaves both linked', JSON.stringify(ma.items.map(x => [x.id, x.whProduct])));
  } catch (e) { bad('client: moving a route to another item was refused', e.message); }

  // ---- HQ: the places and the items, as set up live on 11-04 ----
  const sb = new FakeSupabase(Date.UTC(2026, 10, 5, 15));
  const keys = {};
  for (const slug of Object.keys(STORES)) {
    keys[slug] = sb.provision(slug);
    const s = sb.stores.get(slug);
    Object.assign(s, { pins: { pin: '4321' }, editorDirect: true, phoneDirect: true, version: 1, isTest: slug === 'zze',
      profile: { location: STORES[slug][0], abbr: slug, concept: 'roll-play', timeZone: 'America/New_York' }, tables: STORES[slug][1]() });
    s.state = { cycleDate: '2026-11-06', dayOfWeek: 'Fri', emergencyOverride: false, vendorPicks: {}, todaysLog: [] };
    sb.editorPublish(s);
  }
  const tok = sb.handle('mog_hq_claim', { p_name: 'Sebastian', p_code: sb.hqInvite('Sebastian', ['hq', 'warehouse']), p_passphrase: 'correct horse battery' }).data.token;
  const wh = (fn, p) => sb.handle(fn, Object.assign({ p_token: tok }, p));
  const hs = wh('mog_wh_save', { p_kind: 'location', p_row: WH.placeRow({ name: 'Happy Supply', kind: 'own', active: true }) }).data.done.id;
  const tys = wh('mog_wh_save', { p_kind: 'location', p_row: WH.placeRow({ name: 'Transfer (Tysons)', kind: 'store', heldStore: 'zzt', active: true }) }).data.done.id;
  const elp = wh('mog_wh_save', { p_kind: 'location', p_row: WH.placeRow({ name: 'Elpis Wholesale', kind: 'vendor', heldBy: 'Elpis Wholesale', active: true }) }).data.done.id;
  const shrimp = wh('mog_wh_save', { p_kind: 'product', p_row: WH.itemRow({ name: 'SHRIMP', pack: 'CASE (10LBs)', concept: 'roll-play', fee: '0', active: true,
    places: [{ locationId: hs, low: '10' }, { locationId: tys, low: '20' }] }) }).data.done.id;
  const bowls = wh('mog_wh_save', { p_kind: 'product', p_row: WH.itemRow({ name: 'RP Large Bowls', pack: 'CASE (300)', concept: '', fee: '0', active: true,
    places: [{ locationId: elp, low: '0' }] }) }).data.done.id;
  wh('mog_wh_count', { p_count: { locationId: tys, lines: [{ productId: shrimp, cases: 104, reason: 'Starting inventory' }] } });
  wh('mog_wh_count', { p_count: { locationId: hs, lines: [{ productId: shrimp, cases: 30, reason: 'Added inventory' }] } });
  wh('mog_wh_count', { p_count: { locationId: elp, lines: [{ productId: bowls, cases: 9, reason: 'Elpis report' }] } });
  const d0 = wh('mog_wh_data', {}).data;
  if (d0.locations.find(l => l.id === tys).heldBy !== 'Transfer (Tysons)') bad('fake: a place at a store is held under its own name', JSON.stringify(d0.locations));
  if (!same(d0.products.find(p => p.id === shrimp).places.map(x => [x.locationId, x.lowPoint]), [[hs, 10], [tys, 0]])) bad('fake: the Tysons place keeps no low point of its own', JSON.stringify(d0.products));

  // ---- One HQ save, every store or none, with no remembered names ----
  const hq = sb.handle('mog_hq_data', { p_token: tok }).data;
  const T = slug => hq.stores.find(x => x.slug === slug).tables;
  const SH = { id: shrimp, name: 'SHRIMP', pack: 'CASE (10LBs)' };
  let plan;
  try {
    plan = [
      ['zzr', CE.call(T('zzr'), 'commitHqRoutes', [{ product: SH, routes: [{ itemId: 'ITEM-0091', place: tys, placeName: 'Transfer (Tysons)', vendor: 'Transfer (Tysons)' }] }])],
      ['zzf', CE.call(T('zzf'), 'commitHqRoutes', [{ product: SH, routes: [{ itemId: 'ITEM-0091', place: tys, placeName: 'Transfer (Tysons)', vendor: 'Transfer (Tysons)' }] }])],
      ['zzt', CE.call(T('zzt'), 'commitHqRoutes', [{ product: SH, routes: [{ itemId: 'ITEM-0091', place: null, placeName: 'Happy Supply', vendor: 'Happy Supply',
        newVendor: { name: 'Happy Supply', mults: CE.multsFromDays([true, false, false, true, false, true, false]), cutoff: '', contact: {} } }] }])],
      ['zze', CE.call(T('zze'), 'commitHqRoutes', [{ product: { id: bowls, name: 'RP Large Bowls', pack: 'CASE (300)' },
        routes: [{ itemId: 'ITEM-0003', place: elp, placeName: 'Elpis Wholesale', vendor: 'Elpis' }] }])]
    ];
  } catch (e) { return out.concat(['client: a route was refused: ' + e.message]); }
  const lab = Object.fromEntries(plan.map(([slug, c]) => [slug, c.label]));
  if (lab.zzr !== 'HQ SHRIMP: "SHRIMP" from Transfer (Tysons) as Transfer (Tysons)') bad('label: Rosslyn', lab.zzr);
  if (lab.zzt !== 'HQ SHRIMP: added vendor Happy Supply; "SHRIMP" from Happy Supply as Happy Supply (Capital a backup)') bad('label: RP Tysons', lab.zzt);
  const rA = CE.applyOps(T('zzr'), plan[0][1].ops);
  if (rA.items.filter(x => !same(x, itemOf(T('zzr'), x.id))).length !== 1 || itemOf(rA, 'ITEM-0091').primaryVendor !== 'Transfer (Tysons)' ||
      !same(itemOf(rA, 'ITEM-0091').eligible, ['Transfer (Tysons)', 'SamuelSon']) || itemOf(rA, 'ITEM-0091').pack !== 'CASE (10LBs)') bad('client: Rosslyn\'s route changed more than the link', JSON.stringify(itemOf(rA, 'ITEM-0091')));
  const applied = sb.handle('mog_hq_apply', { p_token: tok, p_changes: plan.map(([slug, c]) => ({ slug, label: c.label, ops: c.ops })), p_links: [] });
  if (!applied.ok) return out.concat(['fake: HQ\'s routes were refused: ' + JSON.stringify(applied)]);
  if (sb.hqLinks().length) bad('fake: routes needed remembered names', JSON.stringify(sb.hqLinks()));
  const zt = sb.stores.get('zzt').tables;
  if (!zt.vendors.some(v => v.name === 'Happy Supply') || itemOf(zt, 'ITEM-0091').primaryVendor !== 'Happy Supply' || itemOf(zt, 'ITEM-0091').eligible.indexOf('Capital') < 0 ||
      'whPlace' in itemOf(zt, 'ITEM-0091')) bad('fake: RP Tysons got Happy Supply, SHRIMP from HEH\'s own, Capital a backup', JSON.stringify(itemOf(zt, 'ITEM-0091')));

  // ---- The warehouse read's routes, as HQ shows them ----
  const status = () => {
    const d = wh('mog_wh_data', {}).data;
    return Object.fromEntries(d.routes.filter(r => r.productId === shrimp).map(r => [r.slug, WH.routeStatus(r, d.products.find(p => p.id === r.productId), d.locations)]));
  };
  const s0 = status();
  if (!['zzr', 'zzf', 'zzt'].every(k => s0[k] && s0[k].ok)) bad('read: every SHRIMP route is fine', JSON.stringify(s0));

  // ---- The phones ----
  const ptok = slug => sb.handle('mog_login', { p_slug: slug, p_pin: '4321' }).data.token;
  const live = slug => sb.handle('mog_snapshot2', { p_token: ptok(slug), p_have_version: null }).data.happySupply || {};
  const lr = live('zzr'), lt = live('zzt'), le = live('zze');
  if (!lr.items || lr.items['ITEM-0091'].available !== 104 || !same(lr.heldVendors, ['Transfer (Tysons)']) || lr.vendor !== null) bad('phone: Rosslyn counts on Tysons (104) under its Transfer (Tysons)', JSON.stringify(lr));
  if (!lt.items || lt.items['ITEM-0091'].available !== 30 || lt.vendor !== 'Happy Supply' || lt.heldVendors) bad('phone: RP Tysons counts on HEH\'s own (30), its Happy Supply is Happy Supply', JSON.stringify(lt));
  if (!le.items || le.items['ITEM-0003'].available !== 9) bad('phone: the bowls count on Elpis (9)', JSON.stringify(le));

  // ---- The close, by route ----
  const row = (v, id, name, qty) => ({ vendor: v, id, name, pack: '', area: 'Walk-in Freezer', onHandPrev: 0, qty });
  const close = (slug, rowsIn, from, to) => sb.handle('mog_sync_close_cycle', { p_slug: slug, p_key: keys[slug], p_closing: from || '2026-11-06', p_new_cycle: to || '2026-11-07',
    p_new_dow: 'Sat', p_rows: rowsIn, p_todays_log: [], p_logged_at: '2026-11-07T08:30:00Z' });
  close('zzr', [row('Transfer (Tysons)', 'ITEM-0091', 'SHRIMP', 4), row('SamuelSon', 'ITEM-0091', 'SHRIMP', 1), row('Transfer (Tysons)', 'ITEM-0185', '12QT CONTAINERS', 2)]);
  close('zzt', [row('Happy Supply', 'ITEM-0091', 'SHRIMP', 2), row('Capital', 'ITEM-0091', 'SHRIMP', 1)]);
  const dels = wh('mog_wh_data', {}).data.deliveries;
  const dr = dels.find(o => o.slug === 'zzr' && o.heldAt === tys);
  if (!dr || !same(dr.lines.map(l => [l.itemId, l.cases]), [['ITEM-0091', 4]]) || dr.vendor !== 'Transfer (Tysons)') bad('close: only Rosslyn\'s route lines, under the route\'s vendor, from Tysons', JSON.stringify(dels));
  if (dels.some(o => o.slug === 'zzt')) bad('close: a delivery for the holder from its own place');

  // ---- RP Tysons' Happy Supply order ships into its place ----
  sb.stores.get('zzt').state.cycleDate = '2026-11-07';
  const sent = sb.handle('mog_wh_send', { p_token: ptok('zzt'), p_order: { vendor: 'Happy Supply', by: 'Kim', lines: [{ itemId: 'ITEM-0091', cases: 6 }] } });
  if (!sent.ok) bad('send: RP Tysons\' Happy Supply order', JSON.stringify(sent));
  else {
    const o = wh('mog_wh_data', {}).data.orders.find(x => x.id === sent.data.order.id);
    const sh = wh('mog_wh_ship', { p_ship: { id: o.id, version: o.version, lines: [{ ord: 1, cases: 6, locationId: hs }] } });
    const so = sh.ok && sh.data.orders.find(x => x.id === o.id);
    if (!so || so.lines[0].toLocation !== tys || so.lines[0].price !== null) bad('ship: into the Tysons place, a move with no price', JSON.stringify(so || sh));
  }
  if (!/isn't this store's Happy Supply/.test(sb.handle('mog_wh_send', { p_token: ptok('zzr'), p_order: { vendor: 'Transfer (Tysons)', lines: [{ itemId: 'ITEM-0091', cases: 1 }] } }).error || '')) bad('send: Rosslyn\'s Transfer (Tysons) taken as Happy Supply');

  // ---- A store moves its main vendor; HQ puts it back ----
  const edF = sb.handle('mog_editor_login', { p_slug: 'zzf', p_pin: '4321' }).data.token;
  const sw = CE.call(sb.stores.get('zzf').tables, 'commitSwitchActiveVendor', ['ITEM-0091', 'Capital']);
  sb.handle('mog_editor_apply', { p_token: edF, p_label: sw.label, p_by: 'Tony', p_ops: sw.ops });
  if (!status().zzf || status().zzf.reason !== 'moved') bad('read: Founders moving SHRIMP to Capital shows as broken', JSON.stringify(status().zzf));
  const hq2 = sb.handle('mog_hq_data', { p_token: tok }).data;
  const pb = CE.call(hq2.stores.find(x => x.slug === 'zzf').tables, 'commitHqRoutes', [{ product: SH, putBack: ['ITEM-0091'] }]);
  const pbA = sb.handle('mog_hq_apply', { p_token: tok, p_changes: [{ slug: 'zzf', label: pb.label, ops: pb.ops }], p_links: [] });
  if (!pbA.ok || !status().zzf.ok) bad('read: HQ\'s Put back makes it fine again', JSON.stringify(pbA.ok ? status().zzf : pbA));

  // ---- A rename and a removed vendor at the store ----
  const edR = sb.handle('mog_editor_login', { p_slug: 'zzr', p_pin: '4321' }).data.token;
  const rn = sb.handle('mog_editor_apply', { p_token: edR, p_label: 'Renamed', p_by: 'Maria', p_ops: [{ rename: 'vendors', from: 'Transfer (Tysons)', to: 'Transfer TY' }] });
  if (!rn.ok || itemOf(sb.stores.get('zzr').tables, 'ITEM-0091').whVendor !== 'Transfer TY' || !same(live('zzr').heldVendors, ['Transfer TY'])) bad('fake: a store\'s rename follows into the route and the phone', JSON.stringify(rn));
  const rv = CE.call(sb.stores.get('zzr').tables, 'commitRemoveVendor', ['Transfer TY']);
  const rvA = sb.handle('mog_editor_apply', { p_token: edR, p_label: rv.label, p_by: 'Maria', p_ops: rv.ops });
  if (!rvA.ok || 'whVendor' in itemOf(sb.stores.get('zzr').tables, 'ITEM-0091') || status().zzr.reason !== 'vendor') bad('fake: a removed vendor empties the route, shown as broken', JSON.stringify(rvA.ok ? status().zzr : rvA));

  // ---- The store's Undo takes HQ's change off ----
  const edT = sb.handle('mog_editor_login', { p_slug: 'zzt', p_pin: '4321' }).data.token;
  const hc = sb.stores.get('zzt').changeLog.find(l => /^HQ SHRIMP/.test(l.label));
  const un = hc && sb.handle('mog_editor_undo', { p_token: edT, p_change_id: hc.id, p_by: 'GM' });
  const zt2 = sb.stores.get('zzt').tables;
  if (!un || !un.ok || 'whProduct' in itemOf(zt2, 'ITEM-0091') || itemOf(zt2, 'ITEM-0091').primaryVendor !== 'Capital' || zt2.vendors.some(v => v.name === 'Happy Supply')) {
    bad('fake: RP Tysons\' Undo takes off the route and the vendor added with it', JSON.stringify(un));
  }
  return out;
}

let failed = 0;
const CE_TEXT = SRC(CE_FILE), WH_TEXT = SRC(WH_FILE);
const main = problems(CE_TEXT, WH_TEXT);
if (main.length) { failed++; console.log('FAIL  ' + main.join('\n      ')); }
else console.log('PASS  routes, the live shrimp: one HQ save for four stores with no remembered names (a vendor added in the row), each phone\'s place, ' +
                 'the close by route, a move into the holder\'s place, a moved main vendor broken and put back, a rename and a removed vendor followed, Undo');

const CONTROLS = [
  { file: 'ce', name: 'a rename leaves the route\'s vendor behind',
    find: "      if (it.whVendor === from) it.whVendor = to;   // v21: the route's vendor follows (on update cascade)\n", replace: '' },
  { file: 'ce', name: 'a removed vendor stays the route\'s vendor',
    find: "      if (s_(it.whVendor).toLowerCase() === low) delete it.whVendor;   // v21: a route's vendor goes with it (on delete set null)\n", replace: '' },
  { file: 'ce', name: 'a route moved to another item leaves the old one linked',
    find: "      delete it.whProduct; delete it.whPlace; delete it.whVendor;\n      out.ended.push", replace: "      out.ended.push" },
  { file: 'ce', name: 'a new vendor in the row isn\'t added',
    find: "      if (r && r.newVendor) out.vendorsAdded.push(", replace: "      if (false) out.vendorsAdded.push(" },
  { file: 'ce', name: 'Put back changes nothing',
    find: "      makeMain(it, vend);\n      out.putBack.push(", replace: "      out.putBack.push(" },
  { file: 'wh', name: 'a removed vendor reads as a fine route',
    find: "    if (r.vendor == null) return { ok: false, reason: 'vendor'", replace: "    if (false) return { ok: false, reason: 'vendor'" },
  { file: 'wh', name: 'a place at a store sends a holder name',
    find: "    if (f.kind === 'vendor') row.heldBy = f.heldBy;", replace: "    if (f.kind !== 'own') row.heldBy = f.heldBy || 'Transfer (Rosslyn)';" }
];
for (const c of CONTROLS) {
  let res;
  try {
    res = problems(c.file === 'ce' ? F.plant(CE_TEXT, c.find, c.replace) : CE_TEXT, c.file === 'wh' ? F.plant(WH_TEXT, c.find, c.replace) : WH_TEXT);
  } catch (e) { failed++; console.log(`FAIL  control "${c.name}" crashed instead of biting: ${e.message}`); continue; }
  if (res.length) console.log(`PASS  control "${c.name}" bites (${res[0].slice(0, 110)})`);
  else { failed++; console.log(`FAIL  control "${c.name}" did NOT bite`); }
}

console.log(failed ? `wh_routes: ${failed} FAILED` : 'wh_routes: ALL PASS');
process.exit(failed ? 1 : 0);
