'use strict';
// GATE: checking deliveries in apart from ordering, and Elpis set up on one
// page (schema v19, 2026-11-04; the "Checking deliveries in apart from
// ordering, and Elpis set up on one page" row of the MOG HQ redesign canvas).
// Checks (v21 retired v19's linking by name, heldMatches and
// commitHqHeldLinks: a route picks the store's own item; tests/wh_routes.test.js):
//   - the fake: a product's concept saved and read back, refused when no
//     store has it, kept when left out, cleared when empty
//   - the phone (template/index.html): "To check in" lists an Elpis
//     delivery still ordered and a Happy Supply order shipped, nothing else,
//     each with its Check in button; what was checked in today under them;
//     Today draws it above the vendors; a vendor card never carries Check in
// Each has a planted-defect control.
//
// Run bare: node tests/elpis_setup.test.js
// A passing run ends with "elpis_setup: ALL PASS".

const vm = require('vm');
const F = require('./fake_apps_script.js');
const { FakeSupabase, checkCatalogTables } = require('./fake_supabase.js');
const { slice, slices } = require('./slice_js.js');

const SRC = file => F.source(null, file);
const CE_FILE = 'template/editor/catalogEdit.js', PHONE_FILE = 'template/index.html';
const clone = x => JSON.parse(JSON.stringify(x));
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

function loadCE(text) {
  const ctx = { console };
  vm.createContext(ctx);
  vm.runInContext(text, ctx, { filename: CE_FILE });
  return ctx.CatalogEdit;
}
const STRINGS = { hsToCheckIn: 'To check in', hsCheckIn: 'Check in', hsFromV: 'From {v}', hsFrom: 'from',
                  hsMetaHeld: "HEH's items ordered {day} · {n} · {num}", hsMetaShipped: 'Shipped {day}{from} · {a} of {b} cases · {num}',
                  hsItemsN: '{n} items', hsItems1: '1 item', hsCheckedToday: 'Checked in today: {list}' };
function loadPhone(html) {
  const ctx = { console, Date, state: { lang: 'en' }, direct: { mode: 'direct', live: {}, catalog: null },
                t: k => STRINGS[k] || k, fmtQty_: n => String(Number(n)),
                escapeHtml: s => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;') };
  vm.createContext(ctx);
  vm.runInContext(slices(html, ['hs_', 'hsYmd_', 'hsDay_', 'hsCheckIns_', 'hsCheckedToday_', 'hsCheckInVendor_', 'hsCheckInMeta_', 'hsCheckInHtml_']), ctx);
  return ctx;
}

function item(id, name, vendor, extra) {
  return Object.assign({ id, name, primaryVendor: vendor, pack: 'CASE', par: 2, active: true, useMult: true, notes: '', sku: '', category: '',
                         eligible: [vendor], seq: Number(id.slice(-4)) }, extra || {});
}
function tables(items) {
  return checkCatalogTables({
    vendors: [{ name: 'Elpis Wholesale', mults: [0, 1, 0, 1, 0, 0, 0], cutoff: null }, { name: 'Amazon', mults: [1, 1, 1, 1, 1, 0, 0], cutoff: null }],
    areas: [{ name: 'Dry', ord: 10 }],
    items: items,
    pickRows: items.filter(it => it.active).map((it, i) => ({ vendor: it.primaryVendor, id: it.id, area: 'Dry', shelfOrder: 10 * (i + 1), seq: i + 2 }))
  });
}

function problems(ceText, phoneHtml) {
  const out = [];
  const bad = (what, detail) => { if (out.length < 30) out.push(what + (detail ? ': ' + detail : '')); };
  let CE, PH;
  try { CE = loadCE(ceText); } catch (e) { return ['catalogEdit.js did not load: ' + e.message]; }
  try { PH = loadPhone(phoneHtml); } catch (e) { return ['the phone\'s check-in code did not load: ' + e.message]; }
  if (CE.writes.indexOf('commitHqHeldLinks') >= 0 || 'heldMatches' in CE) bad('catalogEdit.js still links by name (v21 retired it)');

  // ---- The fake: a product's concept ----
  const sb = new FakeSupabase(Date.UTC(2026, 10, 4, 15));
  sb.provision('zzrp');
  Object.assign(sb.stores.get('zzrp'), { profile: { location: 'Roll Play Test FOH', abbr: 'ZZ', concept: 'roll-play' }, editorDirect: true, tables: tables([]), version: 1 });
  const tok = sb.handle('mog_hq_claim', { p_name: 'Dan', p_code: sb.hqInvite('Dan', ['warehouse']), p_passphrase: 'correct horse battery' }).data.token;
  const wh = (kind, row) => sb.handle('mog_wh_save', { p_token: tok, p_kind: kind, p_row: row });
  wh('location', { name: 'Elpis', heldBy: 'Elpis Wholesale' });
  const r1 = wh('product', { name: 'RP Large Bowls', pack: 'CASE (300)', handlingFee: 0, active: true, concept: 'roll-play' });
  const p1 = r1.ok && r1.data.products.find(p => p.name === 'RP Large Bowls');
  if (!p1 || p1.concept !== 'roll-play') bad('fake: a product\'s concept is saved and read back', JSON.stringify(r1));
  const r2 = wh('product', { name: 'RP Small Bowls', pack: 'CASE', handlingFee: 0, active: true, concept: 'zz nowhere' });
  if (r2.ok || !/no store is in the concept/.test(String(r2.detail || r2.error))) bad('fake: a concept no store has is refused', JSON.stringify(r2));
  if (p1) {
    const r3 = wh('product', { id: p1.id, version: p1.version, name: p1.name, pack: p1.pack, handlingFee: 0, active: true });
    const p3 = r3.ok && r3.data.products.find(p => p.id === p1.id);
    if (!p3 || p3.concept !== 'roll-play') bad('fake: a save that leaves the concept out keeps it', JSON.stringify(r3));
    const r4 = p3 && wh('product', { id: p3.id, version: p3.version, name: p3.name, pack: p3.pack, handlingFee: 0, active: true, concept: '' });
    const p4 = r4 && r4.ok && r4.data.products.find(p => p.id === p1.id);
    if (!p4 || 'concept' in p4) bad('fake: an empty concept clears it', JSON.stringify(r4));
  }

  // ---- The phone ----
  const now = new Date(), y = new Date(now.getTime() - 86400000);
  PH.direct.live.hs = { vendor: 'Happy Supply', orders: [
    { id: 11, number: 'EL-0002', held: true, heldVendor: 'Elpis', status: 'ordered', cycleDate: '2026-11-03', lines: [{ ord: 1, cases: 1 }, { ord: 2, cases: 1 }] },
    { id: 12, number: 'EL-0001', held: true, heldVendor: 'Elpis', status: 'received', cycleDate: '2026-11-02', receivedAt: now.toISOString(), receivedBy: 'Maria', lines: [{ ord: 1, cases: 2 }] },
    { id: 13, number: 'HS-0004', status: 'shipped', from: 'Berliner', shippedAt: now.toISOString(), lines: [{ ord: 1, cases: 4, casesShipped: 3 }] },
    { id: 14, number: 'HS-0005', status: 'sent', lines: [{ ord: 1, cases: 2 }] },
    { id: 15, number: 'HS-0003', status: 'received', receivedAt: y.toISOString(), lines: [{ ord: 1, cases: 2, casesReceived: 2 }] }] };
  const ids = vm.runInContext('hsCheckIns_().map(o => o.id)', PH);
  if (!same(Array.from(ids), [11, 13])) bad('phone: to check in is an Elpis delivery still ordered and a Happy Supply order shipped', JSON.stringify(ids));
  const html = vm.runInContext('hsCheckInHtml_()', PH);
  for (const want of ['To check in &middot; 2', 'From Elpis', 'From Happy Supply', 'data-hs-receive="11"', 'data-hs-receive="13"', 'HEH\'s items ordered', '3 of 4 cases', 'Checked in today: EL-0001']) {
    if (html.indexOf(want) < 0) bad('phone: the list says "' + want + '"', html.slice(0, 300));
  }
  for (const not of ['HS-0005', 'HS-0003', 'data-hs-receive="12"']) if (html.indexOf(not) >= 0) bad('phone: the list leaves out ' + not, html.slice(0, 300));
  PH.direct.live.hs = { vendor: 'Happy Supply', orders: [] };
  if (vm.runInContext('hsCheckInHtml_()', PH) !== '') bad('phone: nothing to check in draws nothing');
  let card = '';
  try { card = slice(phoneHtml, 'renderVendorCard'); } catch (e) { bad('phone: renderVendorCard', e.message); }
  if (/data-hs-receive|hsHeldCardOrder_/.test(card)) bad('phone: a vendor card carries Check in');
  if (!/html \+= hsCheckInHtml_\(\);\r?\n\s*html \+= '<div class="section-label">' \+ escapeHtml\(t\('vendorsToday'\)\)/.test(phoneHtml)) bad('phone: Today draws "To check in" above the vendors');
  return out;
}

let failed = 0;
const ce = SRC(CE_FILE), html = SRC(PHONE_FILE);
const base = problems(ce, html);
if (base.length) { failed++; console.log('FAIL  Elpis on one page and check-in:\n      ' + base.join('\n      ')); }
else console.log('PASS  Elpis on one page and check-in: no linking by name left (v21), a product\'s concept through the fake, ' +
                 '"To check in" on Today and never on a vendor card');

const CONTROLS = [
  { file: 'phone', name: 'a sent Happy Supply order is listed to check in',
    find: "(!o.held && o.status === 'shipped')", replace: "(!o.held && (o.status === 'shipped' || o.status === 'sent'))" },
  { file: 'phone', name: 'checked in on any day shows as today',
    find: "o.status === 'received' && o.receivedAt && hsYmd_(new Date(o.receivedAt)) === today", replace: "o.status === 'received'" },
  { file: 'phone', name: 'the vendor card carries Check in again',
    find: "    if (hsOrder) hsHtml = '<div class=\"vendor-meta hs-meta\">' + escapeHtml(hsOrderLine_(hsOrder)) + '</div>';",
    replace: "    if (hsOrder) { hsHtml = '<div class=\"vendor-meta hs-meta\">' + escapeHtml(hsOrderLine_(hsOrder)) + '</div>'; pillHtml = '<button data-hs-receive=\"' + hsOrder.id + '\">'; }" },
  { file: 'phone', name: 'Today leaves "To check in" out',
    find: '    html += hsCheckInHtml_();\n', replace: '' }
];
for (const c of CONTROLS) {
  let res;
  try { res = c.file === 'ce' ? problems(F.plant(ce, c.find, c.replace), html) : problems(ce, F.plant(html, c.find, c.replace)); }
  catch (e) { failed++; console.log(`FAIL  control "${c.name}" crashed instead of biting: ${e.message}`); continue; }
  if (res.length) console.log(`PASS  control "${c.name}" bites (${res[0].slice(0, 120)})`);
  else { failed++; console.log(`FAIL  control "${c.name}" did NOT bite`); }
}

console.log(failed ? `elpis_setup: ${failed} FAILED` : 'elpis_setup: ALL PASS');
process.exit(failed ? 1 : 0);
