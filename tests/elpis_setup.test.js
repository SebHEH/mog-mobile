'use strict';
// GATE: checking deliveries in apart from ordering, and Elpis set up on one
// page (schema v19, 2026-11-04; the "Checking deliveries in apart from
// ordering, and Elpis set up on one page" row of the MOG HQ redesign canvas).
// Checks:
//   - catalogEdit.js heldMatches: a store's item is HEH's product when its
//     name is the product's (case and spaces aside), active ones only;
//     linked, match, taken (linked to another product) or missing
//   - catalogEdit.js commitHqHeldLinks: every match linked the way Send to
//     stores links one (the holder its main vendor, the product's pack), a
//     rename to a product's name applied first and linked, a name another
//     item has refused, nothing to do refused; the label; Undo exact
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
const PRODUCTS = [{ id: 7, name: 'RP Large Bowls', pack: 'CASE (300)', via: 'Elpis Wholesale' },
                  { id: 8, name: 'RP Large Bowl Lids', pack: 'CASE (300)', via: 'Elpis Wholesale' },
                  { id: 9, name: 'RP Small Bowls', pack: 'CASE (300)', via: 'Elpis Wholesale' }];

function problems(ceText, phoneHtml) {
  const out = [];
  const bad = (what, detail) => { if (out.length < 30) out.push(what + (detail ? ': ' + detail : '')); };
  let CE, PH;
  try { CE = loadCE(ceText); } catch (e) { return ['catalogEdit.js did not load: ' + e.message]; }
  try { PH = loadPhone(phoneHtml); } catch (e) { return ['the phone\'s check-in code did not load: ' + e.message]; }
  if (typeof CE.heldMatches !== 'function') return ['catalogEdit.js has no heldMatches'];

  // ---- heldMatches ----
  const A = tables([item('ITEM-0003', 'RP Large Bowls', 'Elpis Wholesale', { eligible: ['Elpis Wholesale', 'Amazon'] }),
                    item('ITEM-0004', ' rp  large bowl LIDS', 'Elpis Wholesale'),
                    item('ITEM-0006', 'RP Small Bowls', 'Elpis Wholesale', { active: false }),
                    item('ITEM-0007', 'RP Small Bowls (old)', 'Elpis Wholesale')]);
  const m = CE.heldMatches(A, PRODUCTS).map(x => [x.productId, x.status, x.itemId]);
  if (!same(m, [[7, 'match', 'ITEM-0003'], [8, 'match', 'ITEM-0004'], [9, 'missing', '']])) bad('matches: same name (case and spaces aside), active items only', JSON.stringify(m));
  const L = tables([item('ITEM-0003', 'RP Large Bowls', 'Elpis Wholesale', { whProduct: 7 }), item('ITEM-0004', 'RP Large Bowl Lids', 'Elpis Wholesale', { whProduct: 99 })]);
  const ml = CE.heldMatches(L, PRODUCTS.slice(0, 2)).map(x => [x.productId, x.status, x.itemId]);
  if (!same(ml, [[7, 'linked', 'ITEM-0003'], [8, 'taken', 'ITEM-0004']])) bad('matches: linked, and taken by another product', JSON.stringify(ml));

  // ---- commitHqHeldLinks ----
  let c;
  try { c = CE.call(A, 'commitHqHeldLinks', [{ vendorName: 'Elpis Wholesale', products: PRODUCTS, renames: [] }]); }
  catch (e) { bad('links: refused', e.message); }
  if (c) {
    const after = CE.applyOps(A, c.ops), it3 = after.items.find(x => x.id === 'ITEM-0003'), it4 = after.items.find(x => x.id === 'ITEM-0004');
    if (it3.whProduct !== 7 || it4.whProduct !== 8 || after.items.find(x => x.id === 'ITEM-0007').whProduct != null) bad('links: each match linked, nothing else', JSON.stringify(after.items.map(x => [x.id, x.whProduct])));
    if (it3.pack !== 'CASE (300)' || it3.primaryVendor !== 'Elpis Wholesale' || it4.primaryVendor !== 'Elpis Wholesale') bad('links: the product\'s pack, the holder the main vendor', JSON.stringify([it3, it4]));
    if (!/^HQ: linked 2 items to HEH's stock at Elpis Wholesale \(RP Large Bowls, RP Large Bowl Lids\)$/.test(c.label)) bad('links: the label', c.label);
    if (!same(CE.applyOps(after, CE.inverseOps(c.ops)), A)) bad('links: Undo isn\'t exact');
  }
  const B = tables([item('ITEM-0003', 'RP Large Bowls', 'Elpis Wholesale'), item('ITEM-0010', 'Large Bowl Lids (44oz)', 'Elpis Wholesale')]);
  try {
    const r = CE.call(B, 'commitHqHeldLinks', [{ vendorName: 'Elpis Wholesale', products: PRODUCTS.slice(0, 2), renames: [{ itemId: 'ITEM-0010', to: 'RP Large Bowl Lids' }] }]);
    const after = CE.applyOps(B, r.ops), it = after.items.find(x => x.id === 'ITEM-0010');
    if (it.name !== 'RP Large Bowl Lids' || it.whProduct !== 8) bad('renames: renamed to the product\'s name, then linked', JSON.stringify(it));
    if (r.label.indexOf('renamed "Large Bowl Lids (44oz)" to "RP Large Bowl Lids"') < 0) bad('renames: the label', r.label);
  } catch (e) { bad('renames: refused', e.message); }
  let refused = '';
  try { CE.call(B, 'commitHqHeldLinks', [{ vendorName: 'Elpis Wholesale', products: PRODUCTS.slice(0, 2), renames: [{ itemId: 'ITEM-0010', to: 'rp large bowls' }] }]); }
  catch (e) { refused = e.message; }
  if (!/has "RP Large Bowls" already/.test(refused)) bad('renames: a name another item has is refused', refused || 'taken');
  refused = '';
  try { CE.call(L, 'commitHqHeldLinks', [{ vendorName: 'Elpis Wholesale', products: PRODUCTS.slice(0, 1), renames: [] }]); }
  catch (e) { refused = e.message; }
  if (!/Nothing to link/.test(refused)) bad('links: nothing to do is refused', refused || 'taken');

  // ---- The fake: a product's concept ----
  const sb = new FakeSupabase(Date.UTC(2026, 10, 4, 15));
  sb.provision('zzrp');
  Object.assign(sb.stores.get('zzrp'), { profile: { location: 'Roll Play Test FOH', abbr: 'ZZ', concept: 'roll-play' }, editorDirect: true, tables: tables([]), version: 1 });
  const tok = sb.handle('mog_hq_claim', { p_name: 'Dan', p_code: sb.hqInvite('Dan', ['warehouse']), p_passphrase: 'correct horse battery' }).data.token;
  const wh = (kind, row) => sb.handle('mog_wh_save', { p_token: tok, p_kind: kind, p_row: row });
  wh('location', { name: 'Elpis', heldBy: 'Elpis Wholesale' });
  const r1 = wh('product', { name: 'RP Large Bowls', pack: 'CASE (300)', par: 0, handlingFee: 0, stores: [], active: true, via: 'Elpis Wholesale', concept: 'roll-play' });
  const p1 = r1.ok && r1.data.products.find(p => p.name === 'RP Large Bowls');
  if (!p1 || p1.concept !== 'roll-play') bad('fake: a product\'s concept is saved and read back', JSON.stringify(r1));
  const r2 = wh('product', { name: 'RP Small Bowls', pack: 'CASE', par: 0, handlingFee: 0, stores: [], active: true, concept: 'zz nowhere' });
  if (r2.ok || !/no store is in the concept/.test(String(r2.detail || r2.error))) bad('fake: a concept no store has is refused', JSON.stringify(r2));
  if (p1) {
    const r3 = wh('product', { id: p1.id, version: p1.version, name: p1.name, pack: p1.pack, par: 0, handlingFee: 0, stores: [], active: true });
    const p3 = r3.ok && r3.data.products.find(p => p.id === p1.id);
    if (!p3 || p3.concept !== 'roll-play') bad('fake: a save that leaves the concept out keeps it', JSON.stringify(r3));
    const r4 = p3 && wh('product', { id: p3.id, version: p3.version, name: p3.name, pack: p3.pack, par: 0, handlingFee: 0, stores: [], active: true, concept: '' });
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
else console.log('PASS  Elpis on one page and check-in: name matches, links and renames (label, Undo, refusals), a product\'s concept through the fake, ' +
                 '"To check in" on Today and never on a vendor card');

const CONTROLS = [
  { file: 'ce', name: 'an inactive item matches',
    find: '      const it = t.items.find(x => x.active === true && sameName(x.name, p.name));', replace: '      const it = t.items.find(x => sameName(x.name, p.name));' },
  { file: 'ce', name: 'names compared exactly as typed',
    find: "  const sameName = (a, b) => s_(a).replace(/\\s+/g, ' ').toLowerCase() === s_(b).replace(/\\s+/g, ' ').toLowerCase();",
    replace: '  const sameName = (a, b) => s_(a) === s_(b);' },
  { file: 'ce', name: 'a rename is never applied',
    find: '      it.name = to;\n', replace: '' },
  { file: 'ce', name: 'a rename onto another item\'s name goes through',
    find: "      if (clash) throw new Error('The store has \"' + s_(clash.name) + '\" already (' + s_(clash.id) + ').');\n", replace: '' },
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
