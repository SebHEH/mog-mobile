'use strict';
// GATE: the Items page's bulk bar (template/editor/catalogEdit.js
// commitSetItemsVendor / commitSetItemsArea / commitSetItemsActive, which have
// no Items.gs twin). On random stores (with the drift real stores have: a row
// on a vendor the item doesn't list), each bulk save must leave the tables
// exactly where saving the same items one at a time in the item panel would
// (commitUpsertItem with only the vendors, the area or Active changed; that
// call is itself gated against Items.gs by catalog_edit). Also:
//   - items that weren't ticked, and their rows, never change (the Assign
//     tab's whole-list save dropped other items' drifted rows)
//   - an item that save would skip comes back in `skipped` and is untouched:
//     inactive items for Move to area, items already in the asked state;
//     an item whose vendor is gone (D23) can still be switched off and on
//   - an item with no par keeps no par (a one-at-a-time save would write 0)
//   - one logged change, Undo restores the tables exactly, the database's
//     rules hold afterwards (fake_supabase.js checkCatalogTables)
//   - the label, and the refusals (unknown area, no items picked)
// Each has a planted-defect control.
//
// Run bare: node tests/items_bulk.test.js
// A passing run ends with "items_bulk: ALL PASS".

const vm = require('vm');
const F = require('./fake_apps_script.js');
const { checkCatalogTables } = require('./fake_supabase.js');

const SRC = file => F.source(null, file);
const FILE = 'template/editor/catalogEdit.js';
const clone = x => JSON.parse(JSON.stringify(x));
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const STORES = Number(process.argv[2]) || 300;

function loadCE(text) {
  const ctx = { console };
  vm.createContext(ctx);
  vm.runInContext(text, ctx, { filename: FILE });
  return ctx.CatalogEdit;
}

function rng(seed) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
}
const pick = (rnd, arr) => arr[Math.floor(rnd() * arr.length)];

// A random store that obeys the database's rules.
function makeTables(rnd) {
  const vendorNames = ['Sysco', 'ELPIS', 'Webstaurant', 'Amazon', 'Funtea'].slice(0, 2 + Math.floor(rnd() * 4));
  const vendors = vendorNames.map(n => ({ name: n, mults: [1, 0, 0, 1, 0, 0, 0], cutoff: null }));
  const areas = ['Walk-in', 'Dry Storage', 'Freezer', 'Front'].slice(0, 2 + Math.floor(rnd() * 3)).map((n, i) => ({ name: n, ord: (i + 1) * 10 }));
  const items = [], pickRows = [];
  const n = 4 + Math.floor(rnd() * 20);
  let seq = 2, rowSeq = 2;
  for (let i = 1; i <= n; i++) {
    const id = 'ITEM-' + String(i).padStart(4, '0');
    const primary = rnd() < 0.1 ? null : pick(rnd, vendorNames);
    const eligible = primary ? [primary].concat(vendorNames.filter(v => v !== primary && rnd() < 0.3)) : [];
    // Stored lists aren't always tidy: the primary not first, a vendor since removed.
    const stored = eligible.slice();
    if (stored.length > 1 && rnd() < 0.3) stored.push(stored.shift());
    if (rnd() < 0.1) stored.push('Old Vendor');
    const active = rnd() < 0.85;
    const par = rnd() < 0.2 ? null : Math.round(rnd() * 40) / 4;
    items.push({ id: id, name: 'Item ' + i, primaryVendor: primary, pack: pick(rnd, ['CS', 'EA', '']), par: par, active: active,
                 useMult: rnd() < 0.6, notes: '', sku: '', category: '', eligible: stored, seq: seq++ });
    if (!active || !primary || rnd() < 0.25) continue;
    const area = pick(rnd, areas).name;
    for (const v of eligible) {
      if (v !== primary && rnd() < 0.4) continue;   // a backup not placed yet
      const where = rnd() < 0.1 ? pick(rnd, areas).name : area;
      pickRows.push({ vendor: v, id: id, area: where, shelfOrder: 10 * (1 + Math.floor(rnd() * 5)), seq: rowSeq++ });
    }
    // Drift seen on real stores: a row on a vendor the item doesn't list.
    const stray = vendorNames.filter(v => eligible.indexOf(v) < 0);
    if (stray.length && rnd() < 0.2) pickRows.push({ vendor: pick(rnd, stray), id: id, area: area, shelfOrder: 90, seq: rowSeq++ });
  }
  return checkCatalogTables({ vendors: vendors, areas: areas, items: items, pickRows: pickRows });
}

// The same items saved one at a time in the item panel, fields unchanged
// apart from `change`. Returns the tables, or null when that save would refuse.
function oneAtATime(CE, tables, ids, change) {
  let t = clone(tables);
  for (const id of ids) {
    const it = t.items.find(x => x.id === id);
    const payload = { mode: 'edit', lookup: id, name: it.name, vendor: it.primaryVendor, pack: it.pack, par: it.par,
                      useMult: it.useMult, active: it.active };
    Object.assign(payload, change);
    const out = CE.call(t, 'commitUpsertItem', [payload]);
    t = CE.applyOps(t, out.ops);
  }
  return t;
}

function problems(text) {
  const out = [];
  const CE = loadCE(text);
  const bad = (what, detail) => { if (out.length < 8) out.push(what + ': ' + detail); };
  let moved = 0, switched = 0, skippedSeen = 0, vendorChanged = 0;

  for (let seed = 1; seed <= STORES; seed++) {
    const rnd = rng(seed * 7919);
    const t = makeTables(rnd);
    const ids = t.items.filter(() => rnd() < 0.5).map(x => x.id);
    if (!ids.length) ids.push(t.items[0].id);
    const area = pick(rnd, t.areas).name;

    // Move to area.
    const call = CE.call(t, 'commitSetItemsArea', [ids, area]);
    const after = CE.applyOps(t, call.ops);
    const expectSkip = ids.filter(id => { const it = t.items.find(x => x.id === id); return !it.active || !it.primaryVendor; });
    const saveable = ids.filter(id => expectSkip.indexOf(id) < 0);
    if (!same(call.result.skipped.map(s => s.id), expectSkip)) bad('area skipped', JSON.stringify(call.result.skipped) + ' want ' + JSON.stringify(expectSkip));
    if (call.result.moved !== saveable.length) bad('area count', call.result.moved + ' want ' + saveable.length);
    // Compare with the panel's save, par as a number (the panel saves a blank par as 0).
    const withPar = clone(t);
    for (const it of withPar.items) if (it.par === null) it.par = -1;
    const bulkPar = CE.applyOps(withPar, CE.call(withPar, 'commitSetItemsArea', [ids, area]).ops);
    const seqPar = oneAtATime(CE, withPar, saveable, { areaName: area });
    if (!same(bulkPar, seqPar)) bad('area vs one at a time', 'seed ' + seed);
    for (const it of after.items) {
      const was = t.items.find(x => x.id === it.id);
      if (was.par === null && it.par !== null) bad('no par', it.id + ' got par ' + it.par);
    }
    for (const id of expectSkip) {
      const rowsBefore = t.pickRows.filter(r => r.id === id), rowsAfter = after.pickRows.filter(r => r.id === id);
      if (!same(rowsBefore, rowsAfter) || !same(t.items.find(x => x.id === id), after.items.find(x => x.id === id))) bad('skipped item changed', id);
    }
    for (const id of saveable) {
      const it = after.items.find(x => x.id === id);
      const prim = after.pickRows.find(r => r.id === id && r.vendor === it.primaryVendor);
      if (!prim || prim.area !== area) bad('primary row', id + ' is in ' + (prim && prim.area));
    }
    moved += call.result.moved;
    skippedSeen += expectSkip.length;
    untouched(t, after, ids, bad, 'area');
    checkAfter(CE, t, call, bad, 'area');
    if (call.ops.length && call.label !== 'Moved ' + call.result.moved + ' item' + (call.result.moved === 1 ? '' : 's') + ' to ' + area) bad('area label', call.label);

    // Make inactive / active.
    for (const active of [false, true]) {
      const c2 = CE.call(t, 'commitSetItemsActive', [ids, active]);
      const a2 = CE.applyOps(t, c2.ops);
      const already = ids.filter(id => t.items.find(x => x.id === id).active === active);
      if (!same(c2.result.skipped.map(s => s.id), already)) bad('active skipped', JSON.stringify(c2.result.skipped));
      const change = ids.filter(id => already.indexOf(id) < 0);
      const withVendor = change.filter(id => t.items.find(x => x.id === id).primaryVendor);
      if (withVendor.length) {
        const wp = clone(t);
        for (const it of wp.items) if (it.par === null) it.par = -1;
        const bulk = CE.applyOps(wp, CE.call(wp, 'commitSetItemsActive', [withVendor, active]).ops);
        const seqT = oneAtATime(CE, wp, withVendor, { active: active });
        if (!same(bulk, seqT)) bad('active vs one at a time', 'seed ' + seed + ' active ' + active);
      }
      for (const id of change) {
        const it = a2.items.find(x => x.id === id);
        if (it.active !== active) bad('active flag', id);
        if (!active && a2.pickRows.some(r => r.id === id)) bad('inactive item still listed', id);
      }
      switched += c2.result.changed;
      untouched(t, a2, ids, bad, active ? 'activate' : 'deactivate');
      checkAfter(CE, t, c2, bad, active ? 'activate' : 'deactivate');
      if (c2.ops.length && c2.label !== 'Made ' + c2.result.changed + ' item' + (c2.result.changed === 1 ? '' : 's') + (active ? ' active' : ' inactive')) bad('active label', c2.label);
    }

    // Add to / remove from a vendor.
    const vend = pick(rnd, t.vendors).name;
    for (const add of [true, false]) {
      const c3 = CE.call(t, 'commitSetItemsVendor', [ids, vend, add]);
      const a3 = CE.applyOps(t, c3.ops);
      const skip3 = ids.filter(id => { const it = t.items.find(x => x.id === id); return !it.primaryVendor || it.primaryVendor === vend; });
      if (!same(c3.result.skipped.map(s => s.id), skip3)) bad('vendor skipped', JSON.stringify(c3.result.skipped) + ' want ' + JSON.stringify(skip3));
      const ok3 = ids.filter(id => skip3.indexOf(id) < 0);
      if (ok3.length) {
        const wp = clone(t);
        for (const it of wp.items) if (it.par === null) it.par = -1;
        const bulk = CE.applyOps(wp, CE.call(wp, 'commitSetItemsVendor', [ok3, vend, add]).ops);
        // The panel: the item's vendors as the page shows them, with this one added or taken out.
        let seqT = clone(wp);
        for (const id of ok3) {
          const shown = CE.call(seqT, 'getAllItemsForView', []).result.find(x => x.id === id);
          const list = add ? (shown.eligibleVendors.indexOf(vend) >= 0 ? shown.eligibleVendors : shown.eligibleVendors.concat([vend]))
                           : shown.eligibleVendors.filter(v => v !== vend);
          const it = seqT.items.find(x => x.id === id);
          const out = CE.call(seqT, 'commitUpsertItem', [{ mode: 'edit', lookup: id, name: it.name, vendor: it.primaryVendor, pack: it.pack,
            par: it.par, useMult: it.useMult, active: it.active, eligibleVendors: list }]);
          seqT = CE.applyOps(seqT, out.ops);
        }
        if (!same(bulk, seqT)) bad('vendor vs one at a time', 'seed ' + seed + ' add ' + add);
      }
      for (const id of ok3) {
        const it = a3.items.find(x => x.id === id);
        if ((it.eligible.indexOf(vend) >= 0) !== add) bad('vendor list', id + ' add ' + add + ': ' + JSON.stringify(it.eligible));
        if (!add && a3.pickRows.some(r => r.id === id && r.vendor === vend)) bad('vendor row left', id);
      }
      untouched(t, a3, ids, bad, 'vendor');
      checkAfter(CE, t, c3, bad, 'vendor');
      if (c3.ops.length && c3.label !== (add ? 'Added ' : 'Removed ') + c3.result.changed + ' item' + (c3.result.changed === 1 ? '' : 's') + (add ? ' to ' : ' from ') + vend) bad('vendor label', c3.label);
      vendorChanged += c3.result.changed;
    }
  }
  if (!vendorChanged) bad('coverage', 'no vendor change ever made');

  // Refusals.
  const t = makeTables(rng(5));
  const refused = fn => { try { fn(); return ''; } catch (e) { return e.message; } };
  if (!/not a recognised Storage Area/.test(refused(() => CE.call(t, 'commitSetItemsArea', [[t.items[0].id], 'Nowhere'])))) bad('refusal', 'an unknown area was taken');
  if (!/Pick at least one item/.test(refused(() => CE.call(t, 'commitSetItemsArea', [[], t.areas[0].name])))) bad('refusal', 'no items was taken');
  if (!/Pick at least one item/.test(refused(() => CE.call(t, 'commitSetItemsActive', [[' '], false])))) bad('refusal', 'blank ids were taken');
  if (!moved || !switched || !skippedSeen) bad('coverage', 'moved ' + moved + ', switched ' + switched + ', skipped ' + skippedSeen);
  return out;
}

// Items that weren't ticked, and their rows on every list, stay exactly as
// they were (the Assign tab's whole-list save once dropped other items' rows).
function untouched(t, after, ids, bad, what) {
  const picked = new Set(ids);
  for (const it of t.items) {
    if (picked.has(it.id)) continue;
    const now = after.items.find(x => x.id === it.id);
    const rows = list => JSON.stringify(list.filter(r => r.id === it.id).map(r => [r.vendor, r.area, r.shelfOrder]));
    if (!same(it, now) || rows(t.pickRows) !== rows(after.pickRows)) bad(what + ' touched an unticked item', it.id);
  }
}

// One logged change; Undo restores the tables; the database's rules hold.
function checkAfter(CE, t, call, bad, what) {
  if (!call.ops.length) return;
  const after = CE.applyOps(t, call.ops);
  try { checkCatalogTables(clone(after)); } catch (e) { bad(what + ' rules', e.message); }
  const back = CE.applyOps(after, CE.inverseOps(call.ops));
  if (!same(back, t)) bad(what + ' undo', 'did not restore the tables');
}

let failed = 0;
const text = SRC(FILE);
const main = problems(text);
if (main.length) { failed++; console.log('FAIL  ' + main.join('\n      ')); }
else console.log('PASS  Add to / remove from a vendor, Move to area and Make active/inactive on ' + STORES +
                 ' stores = the item panel one at a time; unticked items untouched; skips, no-par, Undo, rules, labels');

const CONTROLS = [
  { name: 'Move to area leaves the backup vendors behind',
    find: "      syncEligiblePickRows(w, id, { name: s_(item.name), primary: vendor, eligible: item.eligible });\n      moved++;",
    replace: '      moved++;' },
  { name: 'Move to area moves inactive items too',
    find: "      if (item.active !== true) { skipped.push({ id: id, reason: 'inactive' }); continue; }\n      const vendor = settle(w, item, map);\n      if (!vendor) { skipped.push({ id: id, reason: 'no vendor' }); continue; }\n      assignArea",
    replace: "      const vendor = settle(w, item, map);\n      if (!vendor) { skipped.push({ id: id, reason: 'no vendor' }); continue; }\n      assignArea" },
  { name: 'an inactive item stays on its lists',
    find: '      if (!active) w.pickRows = w.pickRows.filter(r => s_(r.id) !== id);\n',
    replace: '      if (!active) { /* rows kept */ }\n' },
  { name: 'Remove from a vendor leaves it on the item',
    find: '      if (!add) item.eligible = item.eligible.filter(v => v.toLowerCase() !== vLow);\n', replace: '' },
  { name: 'Add to a vendor rewrites that vendor\'s whole list (the Assign tab\'s save)',
    find: "    const vendor = normalizeVendorOrThrow(w, vendorRaw);\n    const add = (addRaw === true || addRaw === 'true');\n",
    replace: "    const vendor = normalizeVendorOrThrow(w, vendorRaw);\n    const add = (addRaw === true || addRaw === 'true');\n    if (add) setVendorItems(w, vendor, idList(itemIdsRaw));\n" },
  { name: 'the eligible list is left as stored',
    find: '    item.eligible = normalizeEligibleList(item.eligible, vendor, map);\n', replace: '' }
];
for (const c of CONTROLS) {
  let res;
  try { res = problems(F.plant(text, c.find, c.replace)); }
  catch (e) { failed++; console.log(`FAIL  control "${c.name}" crashed instead of biting: ${e.message}`); continue; }
  if (res.length) console.log(`PASS  control "${c.name}" bites (${res[0].slice(0, 110)})`);
  else { failed++; console.log(`FAIL  control "${c.name}" did NOT bite`); }
}

console.log(failed ? `items_bulk: ${failed} FAILED` : 'items_bulk: ALL PASS');
process.exit(failed ? 1 : 0);
