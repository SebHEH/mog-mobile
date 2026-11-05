'use strict';
// GATE: HEH's stock held at Elpis, W2b (supabase/schema_v17.sql,
// docs/MOG_Warehouse_Spec.md §2 "W2b design"): the client code that reads and
// writes it, run against the fake Supabase (fake_supabase.js mirrors v17; the
// SQL is pinned in Postgres by supabase/tests/smoke_v17.sql). Checks:
//   - hq/warehouse.js: a held location's stock (on hand, what open deliveries
//     hold, available never below 0, only the products ordered through its
//     holder), the receipts beyond the records since its last real count, the
//     Mark received payload (a blank line as ordered), Ship's start leaving a
//     held location out, which products a location takes
//   - catalogEdit.js commitHqRoutes (v21) for an item held at Elpis: the store's
//     own Elpis item routed from the Elpis place, Elpis stays its main vendor, the label
//   - the phone (template/index.html): a held vendor, its card's delivery
//     (open first, only its own), Happy Supply's card never showing one, the
//     card's line for an open delivery
//   - through the fake: HQ sets up the location and a product, links a
//     store's item and names its Elpis; the phone sees what's left at Elpis;
//     the night's close records the delivery; the store marks it received
//     short (the stock drops); HQ marks another one received beyond the
//     records; Happy Supply never ships from Elpis or sells its products; no
//     price or cost on a phone
// Each has a planted-defect control.
//
// Run bare: node tests/wh_elpis.test.js
// A passing run ends with "wh_elpis: ALL PASS".

const vm = require('vm');
const F = require('./fake_apps_script.js');
const { FakeSupabase, checkCatalogTables } = require('./fake_supabase.js');
const { slices } = require('./slice_js.js');

const SRC = file => F.source(null, file);
const CE_FILE = 'template/editor/catalogEdit.js', WH_FILE = 'template/hq/warehouse.js', PHONE_FILE = 'template/index.html';
const clone = x => JSON.parse(JSON.stringify(x));
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
const STRINGS = { hsLineOrdered: "HEH's items ordered {day} · {num}", hsLineReceived: 'Received · {a} cases' };
function loadPhone(html) {
  const ctx = { console, Date, state: { lang: 'en' }, direct: { mode: 'direct', live: {}, catalog: null },
                t: k => STRINGS[k] || k, fmtQty_: n => String(Number(n)) };
  vm.createContext(ctx);
  vm.runInContext(slices(html, ['hs_', 'hsIsVendor_', 'hsCardOrder_', 'hsHeld_', 'hsHeldCardOrder_', 'hsDay_', 'hsOrderLine_']), ctx);
  return ctx;
}

function storeTables() {
  return checkCatalogTables({
    vendors: [{ name: 'Elpis', mults: [0, 1, 0, 1, 0, 0, 0], cutoff: null }, { name: 'Amazon', mults: [1, 1, 1, 1, 1, 0, 0], cutoff: null },
              { name: 'Happy Supply', mults: [0, 0, 1, 0, 1, 0, 0], cutoff: null }],
    areas: [{ name: 'Dry', ord: 10 }],
    items: [
      { id: 'ITEM-0003', name: 'RP Large Bowls', primaryVendor: 'Elpis', pack: 'CASE (300)', par: 3, active: true, useMult: true, notes: '', sku: '', category: '', eligible: ['Elpis', 'Amazon'], seq: 2 },
      { id: 'ITEM-0004', name: 'RP Large Bowl Lids', primaryVendor: 'Elpis', pack: 'CASE (300)', par: 3, active: true, useMult: true, notes: '', sku: '', category: '', eligible: ['Elpis'], seq: 3 },
      { id: 'ITEM-0005', name: 'KARAT Cups', primaryVendor: 'Elpis', pack: 'CASE', par: 2, active: true, useMult: true, notes: '', sku: '', category: '', eligible: ['Elpis'], seq: 4 }
    ],
    pickRows: [
      { vendor: 'Elpis', id: 'ITEM-0003', area: 'Dry', shelfOrder: 10, seq: 2 },
      { vendor: 'Amazon', id: 'ITEM-0003', area: 'Dry', shelfOrder: 10, seq: 3 },
      { vendor: 'Elpis', id: 'ITEM-0004', area: 'Dry', shelfOrder: 20, seq: 4 },
      { vendor: 'Elpis', id: 'ITEM-0005', area: 'Dry', shelfOrder: 30, seq: 5 }
    ]
  });
}

function problems(ceText, whText, phoneHtml) {
  const out = [];
  const bad = (what, detail) => { if (out.length < 30) out.push(what + (detail ? ': ' + detail : '')); };
  let CE, WH, PH;
  try { CE = loadCE(ceText); } catch (e) { return ['catalogEdit.js did not load: ' + e.message]; }
  try { WH = loadWH(whText); } catch (e) { return ['warehouse.js did not load: ' + e.message]; }
  try { PH = loadPhone(phoneHtml); } catch (e) { return ['the phone\'s Elpis code did not load: ' + e.message]; }
  if (typeof WH.heldStock !== 'function' || typeof WH.beyondSinceCount !== 'function' || typeof WH.heldPayload !== 'function') return ['warehouse.js has no held-stock helpers'];

  // ---- hq/warehouse.js ----
  const loc = { id: 3, name: 'Elpis', heldBy: 'Elpis Wholesale', lastCount: '2026-11-01T12:00:00Z' };
  const products = [{ id: 7, name: 'RP Large Bowls', places: [{ locationId: 3, lowPoint: 0 }], stock: { 3: 40 } },
                    { id: 8, name: 'RP Large Bowl Lids', places: [{ locationId: 3, lowPoint: 0 }], stock: { 3: 3 } },
                    { id: 9, name: 'Shrimp', places: [{ locationId: 1, lowPoint: 0 }], stock: { 1: 9, 3: 2 } },
                    { id: 10, name: 'Crab', places: [{ locationId: 1, lowPoint: 0 }], stock: { 1: 5 } }];
  const dels = [
    { id: 1, number: 'EL-0006', heldAt: 3, status: 'ordered', sentAt: '2026-10-30T07:30:00Z', lines: [{ ord: 1, productId: 7, cases: 2 }] },
    { id: 2, number: 'EL-0009', heldAt: 3, status: 'ordered', sentAt: '2026-11-03T07:30:00Z', lines: [{ ord: 1, productId: 7, cases: 2 }, { ord: 2, productId: 8, cases: 4 }] },
    { id: 3, number: 'EL-0007', heldAt: 3, status: 'received', receivedAt: '2026-11-02T15:00:00Z', lines: [{ ord: 1, productId: 8, product: 'RP Large Bowl Lids', cases: 3, casesReceived: 3, beyond: 2 }] },
    { id: 4, number: 'EL-0003', heldAt: 3, status: 'received', receivedAt: '2026-10-28T15:00:00Z', lines: [{ ord: 1, productId: 7, product: 'RP Large Bowls', cases: 1, casesReceived: 1, beyond: 1 }] },
    { id: 5, number: 'EL-0010', heldAt: 4, status: 'ordered', sentAt: '2026-11-03T07:30:00Z', lines: [{ ord: 1, productId: 7, cases: 5 }] }
  ];
  const hs = WH.heldStock(products, dels, loc);
  if (!same(hs.map(x => [x.product.id, x.onHand, x.open, x.available]), [[7, 40, 4, 36], [8, 3, 4, 0], [9, 2, 0, 2]])) bad('warehouse: a held location\'s stock (open deliveries held, available never below 0)', JSON.stringify(hs.map(x => [x.product.id, x.onHand, x.open, x.available])));
  const by = WH.beyondSinceCount(dels, loc);
  if (!same(by.map(x => [x.order.number, x.held]), [['EL-0007', 1]])) bad('warehouse: the receipts beyond the records since the last real count', JSON.stringify(by.map(x => x.order.number)));
  if (WH.beyondSinceCount(dels, Object.assign({}, loc, { lastCount: null })).length !== 2) bad('warehouse: no count yet, every receipt beyond the records shows');
  const pay = WH.heldPayload(Object.assign({ version: 1 }, dels[1]), { 2: '3' });
  if (!same(pay, { id: 2, version: 1, lines: [{ ord: 1, cases: 2 }, { ord: 2, cases: 3 }] })) bad('warehouse: Mark received\'s payload (a blank line as ordered)', JSON.stringify(pay));
  if (!WH.fits(products[0], loc) || WH.fits(products[2], loc) || !WH.fits(products[2], { id: 1, name: 'Berliner' }) || WH.fits(products[0], { id: 1, name: 'Berliner' })) bad('warehouse: which products a location takes');
  const orders = [{ id: 11, number: 'HS-0011', status: 'sent', sentAt: '2026-11-03T13:00:00Z', lines: [{ ord: 1, productId: 9, cases: 11 }] }];
  const pre = WH.shipPrefill(orders, products, orders[0], [3]);
  if (pre[0].cases !== 9 || pre[0].locationId !== 1 || pre[0].left !== 9) bad('warehouse: Ship starts with stock at a held location', JSON.stringify(pre));

  // ---- catalogEdit.js: route a store's own Elpis item from the Elpis place (v21) ----
  const t = storeTables();
  const c = CE.call(t, 'commitHqRoutes', [{ product: { id: 7, name: 'RP Large Bowls', pack: 'CASE (300)' },
                                            routes: [{ itemId: 'ITEM-0003', place: 3, placeName: 'Elpis', vendor: 'Elpis' }] }]);
  const a = CE.applyOps(t, c.ops), it = a.items.find(x => x.id === 'ITEM-0003');
  if (it.whProduct !== 7 || it.whPlace !== 3 || it.whVendor !== 'Elpis' || it.primaryVendor !== 'Elpis' || !same(it.eligible, ['Elpis', 'Amazon']) || it.par !== 3) bad('link: routed from Elpis, Elpis stays the main vendor, the item otherwise as it was', JSON.stringify(it));
  if (c.label !== 'HQ RP Large Bowls: "RP Large Bowls" from Elpis as Elpis') bad('link: the change\'s label', c.label);
  if (!same(CE.applyOps(a, CE.inverseOps(c.ops)), t)) bad('link: Undo is not exact');

  // ---- The phone ----
  PH.direct.live.hs = { vendor: 'Happy Supply', heldVendors: ['Elpis'], items: {}, orders: [
    { id: 9, number: 'EL-0009', status: 'received', held: true, heldVendor: 'Elpis', cycleDate: '2026-11-03', lines: [{ cases: 2, casesReceived: 2 }] },
    { id: 7, number: 'EL-0002', status: 'ordered', held: true, heldVendor: 'ELPIS', cycleDate: '2026-11-01', lines: [{ cases: 1 }] },
    { id: 8, number: 'EL-0008', status: 'ordered', held: true, heldVendor: 'Elpis', cycleDate: '2026-11-02', lines: [{ cases: 2 }] },
    { id: 6, number: 'HS-0006', status: 'sent', cycleDate: '2026-11-03', lines: [{ cases: 1 }] }] };
  if (!vm.runInContext('hsHeld_("Elpis")', PH) || vm.runInContext('hsHeld_("Happy Supply")', PH)) bad('phone: which vendor holds HEH\'s stock');
  const hc = vm.runInContext('hsHeldCardOrder_("Elpis")', PH);
  if (!hc || hc.number !== 'EL-0008') bad('phone: the Elpis card shows its own open delivery first', hc && hc.number);
  const hsc = vm.runInContext('hsCardOrder_()', PH);
  if (!hsc || hsc.number !== 'HS-0006') bad('phone: Happy Supply\'s card shows an Elpis delivery', hsc && hsc.number);
  const line = vm.runInContext('hsOrderLine_(' + JSON.stringify(hc) + ')', PH);
  if (!/^HEH's items ordered .+ · EL-0008$/.test(line)) bad('phone: the card\'s line for an open delivery', line);

  // ---- Through the fake Supabase ----
  const sb = new FakeSupabase(Date.UTC(2026, 10, 3, 15));
  const keys = {};
  for (const slug of ['zza', 'zzb']) {
    keys[slug] = sb.provision(slug);
    const s = sb.stores.get(slug);
    Object.assign(s, { pins: { pin: '4321' }, editorDirect: true, phoneDirect: true, version: 1,
      profile: { location: 'Test ' + slug + ' FOH', abbr: slug, concept: 'roll-play', timeZone: 'America/New_York' }, tables: storeTables() });
    s.state = { cycleDate: '2026-11-03', dayOfWeek: 'Tue', emergencyOverride: false, vendorPicks: {}, todaysLog: [] };
    sb.editorPublish(s);
  }
  const code = sb.hqInvite('Sebastian', ['hq', 'warehouse']);
  const tok = sb.handle('mog_hq_claim', { p_name: 'Sebastian', p_code: code, p_passphrase: 'correct horse battery' }).data.token;
  const wh = (fn, p) => sb.handle(fn, Object.assign({ p_token: tok }, p));
  const berliner = wh('mog_wh_save', { p_kind: 'location', p_row: { name: 'Berliner' } }).data.done.id;
  const r0 = wh('mog_wh_save', { p_kind: 'location', p_row: { name: 'Elpis', heldBy: 'Elpis Wholesale' } });
  const elpis = r0.data.done.id;
  if (!r0.data.locations.some(l => l.id === elpis && l.heldBy === 'Elpis Wholesale' && l.lastCount === null) || r0.data.locations.some(l => l.id === berliner && 'heldBy' in l)) bad('fake: a location held by a vendor', JSON.stringify(r0.data.locations));
  if (!/is held by/.test(wh('mog_wh_save', { p_kind: 'location', p_row: { name: 'Elpis 2', heldBy: 'elpis wholesale' } }).error || '')) bad('fake: two locations with one holder');
  // v21: an item sits at places (its via, par and store limit retired).
  const bowls = wh('mog_wh_save', { p_kind: 'product', p_row: { name: 'RP Large Bowls', pack: 'CASE (300)', handlingFee: 0, active: true, places: [{ locationId: elpis }] } }).data.done.id;
  const shrimp = wh('mog_wh_save', { p_kind: 'product', p_row: { name: 'Shrimp', pack: '10 LB case', handlingFee: 6, active: true, places: [{ locationId: berliner }] } }).data.done.id;
  const d0 = wh('mog_wh_data', {}).data;
  const pb0 = d0.products.find(p => p.id === bowls), ps0 = d0.products.find(p => p.id === shrimp);
  if (!same(pb0.places.map(x => x.locationId), [elpis]) || !same(ps0.places.map(x => x.locationId), [berliner]) || 'via' in pb0 || 'par' in pb0 || 'stores' in pb0) bad('fake: each item at its places, no via, par or store limit', JSON.stringify([pb0, ps0]));
  wh('mog_wh_count', { p_count: { locationId: elpis, lines: [{ productId: bowls, cases: 40, reason: 'Elpis report' }] } });
  wh('mog_wh_count', { p_count: { locationId: berliner, lines: [{ productId: shrimp, cases: 9, reason: 'first count' }] } });
  if (!/has stock/.test(wh('mog_wh_save', { p_kind: 'product', p_row: { id: bowls, version: 1, name: 'RP Large Bowls', pack: 'CASE (300)', handlingFee: 0, active: true, places: [] } }).error || '')) bad('fake: an item left a place while it has stock there');

  // HQ routes each store's own bowls from Elpis, under its "Elpis" (v21: no remembered names).
  const hqData = sb.handle('mog_hq_data', { p_token: tok }).data;
  const plan = ['zza', 'zzb'].map(slug => ({ slug, call: CE.call(hqData.stores.find(x => x.slug === slug).tables, 'commitHqRoutes',
    [{ product: { id: bowls, name: 'RP Large Bowls', pack: 'CASE (300)' }, routes: [{ itemId: 'ITEM-0003', place: elpis, placeName: 'Elpis', vendor: 'Elpis' }] }]) }));
  const applied = sb.handle('mog_hq_apply', { p_token: tok, p_changes: plan.map(x => ({ slug: x.slug, label: x.call.label, ops: x.call.ops })), p_links: [] });
  if (!applied.ok) return out.concat(['fake: HQ\'s link was refused: ' + JSON.stringify(applied)]);
  const ptok = slug => sb.handle('mog_login', { p_slug: slug, p_pin: '4321' }).data.token;
  const pa = ptok('zza'), pb = ptok('zzb');
  const snap = tk => sb.handle('mog_snapshot2', { p_token: tk, p_have_version: null }).data;
  const h0 = snap(pa).happySupply;
  if (!h0 || !same(h0.heldVendors, ['Elpis']) || h0.items['ITEM-0003'].available !== 40) bad('fake: the phone sees its Elpis and what\'s left there', JSON.stringify(h0));
  // An item routed from Elpis is refused on a Happy Supply order (the store's Happy Supply: its route to HEH's own).
  sb.stores.get('zzb').tables.items.find(x => x.id === 'ITEM-0003').eligible = ['Elpis', 'Amazon', 'Happy Supply'];
  sb.stores.get('zzb').tables.items.push({ id: 'ITEM-0009', name: 'Shrimp', primaryVendor: 'Happy Supply', pack: '10 LB case', par: 10, active: true, useMult: true,
                                           notes: '', sku: '', category: '', eligible: ['Happy Supply'], seq: 9, whProduct: shrimp, whVendor: 'Happy Supply' });
  if (!/comes from Elpis, not Happy Supply/.test(sb.handle('mog_wh_send', { p_token: pb, p_order: { vendor: 'Happy Supply', lines: [{ itemId: 'ITEM-0003', cases: 1 }] } }).error || '')) bad('fake: an Elpis item went to Happy Supply');

  // The night's close records the delivery (an hour after the count).
  sb.nowMs += 3600 * 1000;
  const close =(slug, rows, next) => sb.handle('mog_sync_close_cycle', { p_slug: slug, p_key: keys[slug], p_closing: '2026-11-03', p_new_cycle: next || '2026-11-04',
    p_new_dow: next === '2026-11-03' ? 'Tue' : 'Wed', p_rows: rows, p_todays_log: [], p_logged_at: '2026-11-04T08:30:00Z' });
  const row = (vendor, id, name, qty) => ({ vendor, id, name, pack: '', area: 'Dry', onHandPrev: 0, qty });
  const c1 = close('zza', [row('Elpis', 'ITEM-0003', 'RP Large Bowls', 2), row('Elpis', 'ITEM-0005', 'KARAT Cups', 1), row('Amazon', 'ITEM-0003', 'RP Large Bowls', 1)]);
  const del = wh('mog_wh_data', {}).data.deliveries.find(o => o.slug === 'zza');
  if (!c1.ok || 'heldError' in c1.data || !del || del.status !== 'ordered' || !/^EL-\d{4}$/.test(del.number) || !same(del.lines.map(l => [l.itemId, l.cases]), [['ITEM-0003', 2]])) bad('fake: the close records the linked Elpis line only', JSON.stringify(del || c1));
  if (wh('mog_wh_data', {}).data.orders.some(o => o.id === (del && del.id))) bad('fake: a delivery shows with Happy Supply\'s orders');
  const hb = snap(pb).happySupply;
  if (hb.items['ITEM-0003'].available !== 38) bad('fake: an open delivery holds its cases', JSON.stringify(hb.items));
  const ha = snap(pa).happySupply, o1 = ha.orders.find(o => o.held);
  if (!o1 || o1.heldVendor !== 'Elpis' || o1.status !== 'ordered' || /price|cost|beyond|fee/i.test(JSON.stringify(ha))) bad('fake: the phone gets its delivery, with no price or cost', JSON.stringify(o1));
  if (!o1) return out;

  // The store marks it received short; the stock drops.
  const rec = sb.handle('mog_wh_received', { p_token: pa, p_receipt: { id: o1.id, by: 'Maria', lines: [{ ord: 1, cases: 1 }] } });
  const st1 = wh('mog_wh_data', {}).data.products.find(p => p.id === bowls).stock[String(elpis)];
  if (!rec.ok || rec.data.order.status !== 'received' || st1 !== 39) bad('fake: the store marks it received short and the stock drops', JSON.stringify(rec) + ' stock ' + st1);

  // HQ marks the other store's delivery received, beyond the records.
  close('zzb', [row('Elpis', 'ITEM-0003', 'RP Large Bowls', 45)]);
  const db = wh('mog_wh_data', {}).data.deliveries.find(o => o.slug === 'zzb' && o.status === 'ordered');
  if (!/CONFLICT/.test(wh('mog_wh_held_receive', { p_receipt: { id: db.id, version: 99 } }).error || '')) bad('fake: HQ\'s Mark received on an old version');
  const hr = wh('mog_wh_held_receive', { p_receipt: WH.heldPayload(db, {}) });
  const dl = hr.ok && hr.data.deliveries.find(o => o.id === db.id);
  if (!dl || dl.status !== 'received' || dl.lines[0].beyond !== 6 || dl.receivedBy !== 'HQ · Sebastian') bad('fake: HQ marks it received beyond the records', JSON.stringify(dl || hr));
  const hl = hr.data.locations.find(l => l.id === elpis);
  if (WH.beyondSinceCount(hr.data.deliveries, hl).length !== 1) bad('warehouse: the receipt beyond the records isn\'t flagged for a count', JSON.stringify(hl));

  // Happy Supply never ships from Elpis.
  sb.stores.get('zza').tables.items.push({ id: 'ITEM-0009', name: 'Shrimp', primaryVendor: 'Happy Supply', pack: '10 LB case', par: 10, active: true, useMult: true,
                                           notes: '', sku: '', category: '', eligible: ['Happy Supply'], seq: 9, whProduct: shrimp, whVendor: 'Happy Supply' });
  sb.stores.get('zza').state.cycleDate = '2026-11-04';
  const sent = sb.handle('mog_wh_send', { p_token: pa, p_order: { vendor: 'Happy Supply', lines: [{ itemId: 'ITEM-0009', cases: 2 }] } });
  const ho = sent.ok && wh('mog_wh_data', {}).data.orders.find(o => o.id === sent.data.order.id);
  if (!ho) bad('fake: a Happy Supply order', JSON.stringify(sent));
  else if (!/never ships from Elpis/.test(wh('mog_wh_ship', { p_ship: { id: ho.id, version: ho.version, lines: [{ ord: 1, cases: 1, locationId: elpis }] } }).error || '')) bad('fake: Happy Supply shipped from Elpis');
  return out;
}

let failed = 0;
const CE_TEXT = SRC(CE_FILE), WH_TEXT = SRC(WH_FILE), PHONE = SRC(PHONE_FILE);
const main = problems(CE_TEXT, WH_TEXT, PHONE);
if (main.length) { failed++; console.log('FAIL  ' + main.join('\n      ')); }
else console.log('PASS  Elpis: the held location\'s stock, receipts beyond the records and Mark received\'s payload, the route (Elpis stays main), ' +
                 'the phone\'s Elpis card, and the close, Mark received (store and HQ) and the refusals through the fake Supabase');

const CONTROLS = [
  { file: 'wh', name: 'open deliveries hold nothing',
    find: "for (const o of deliveries) if (o.status === 'ordered' && o.heldAt === loc.id)",
    replace: "for (const o of []) if (o.status === 'ordered' && o.heldAt === loc.id)" },
  { file: 'wh', name: 'available can go below 0',
    find: "available: Math.max(0, round(onHand - open, 2)) };",
    replace: "available: round(onHand - open, 2) };" },
  { file: 'wh', name: 'every receipt beyond the records shows, counted or not',
    find: "const out = [], since = loc.lastCount ? new Date(loc.lastCount).getTime() : -Infinity;",
    replace: "const out = [], since = -Infinity;" },
  { file: 'wh', name: 'a blank line is sent as 0',
    find: "return { ord: l.ord, cases: n === null ? Number(l.cases) : n };",
    replace: "return { ord: l.ord, cases: n === null ? 0 : n };" },
  { file: 'wh', name: 'Ship starts with stock at a held location',
    find: "      for (const k of heldIds || []) delete stock[String(k)];",
    replace: "" },
  { file: 'ce', name: 'a route to Elpis keeps no place',
    find: "      if (place === null) delete it.whPlace; else it.whPlace = place;",
    replace: "      delete it.whPlace;" },
  { file: 'phone', name: 'Happy Supply\'s card shows Elpis deliveries',
    find: "const h = hs_(), list = (h && Array.isArray(h.orders) ? h.orders : []).filter(o => !o.held);",
    replace: "const h = hs_(), list = (h && Array.isArray(h.orders) ? h.orders : []);" },
  { file: 'phone', name: 'the Elpis card shows another vendor\'s delivery',
    find: ".filter(o => o.held && o.heldVendor === vendor);",
    replace: ".filter(o => o.held);" },
  { file: 'phone', name: 'no vendor holds HEH\'s stock',
    find: "function hsHeld_(vendor) { const h = hs_(); return !!(h && Array.isArray(h.heldVendors) && h.heldVendors.indexOf(vendor) >= 0); }",
    replace: "function hsHeld_(vendor) { return false; }" }
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

console.log(failed ? `wh_elpis: ${failed} FAILED` : 'wh_elpis: ALL PASS');
process.exit(failed ? 1 : 0);
