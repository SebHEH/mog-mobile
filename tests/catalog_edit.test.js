'use strict';
// GATE: the editor's Manage Items port (docs/MOG_OneApp_Spec.md Phase 2).
// template/editor/catalogEdit.js runs Manage Items' 7 server calls over the
// Supabase catalog tables. This drives it side by side with the REAL
// apps-script/Items.gs on the fake Sheet, from the same randomized store:
//   - the tables start as Sync.gs buildCatalogTables_ makes them from that
//     Sheet, and both sides build the same phone catalog (D22's builder)
//   - every step is a random add / edit / promote / assign / delete (valid
//     and not: unknown vendors and items, blank names, bad pars, unknown
//     areas) or one of the 3 reads. Both sides must give the same answer or
//     the same error, and afterwards the same phone catalog (the pick rows'
//     stored item name aside: the tables look it up, D19) and the same
//     Manage Items screen data
//   - every write undoes exactly (inverseOps), and the same change applied
//     twice is refused as a CONFLICT instead of applying again
// Planted-defect controls in catalogEdit.js must each be caught.
//
// Run bare: node tests/catalog_edit.test.js [stores]   (default 100)
// A passing run ends with "catalog_edit: ALL PASS".

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const F = require('./fake_apps_script.js');
const { makeStore, mulberry32 } = require('./mog_fixture.js');
const { catalogFromTables } = require('./fake_supabase.js');

const STORES = Number(process.argv[2]) || 100;
const STEPS = 30;
const DIR = path.join(F.REPO, 'apps-script');
const GS = fs.readdirSync(DIR).filter(f => f.endsWith('.gs')).sort();
const CE_FILE = 'template/editor/catalogEdit.js';
const SRC = file => F.source(null, file);
const AREAS = [['Walk-in', 10], ['Dry Storage', 20], ['Freezer', 30], ['Entrance Shelf', 40]];
const clone = x => JSON.parse(JSON.stringify(x));

const SHEET = new vm.Script(GS.map(f => SRC('apps-script/' + f)).join('\n'), { filename: 'all-gs.js' });
const NEW_EXECUTION = new vm.Script('_SB_CONFIG_ = null; _SB_SNAPSHOT_ = null; _SHEET_CACHE_.clear();');

function loadCatalogEdit(text) {
  const ctx = { console };
  vm.createContext(ctx);
  vm.runInContext(text, ctx, { filename: CE_FILE });
  return ctx.CatalogEdit;
}

function setCell(rows, r, c, v) {
  while (rows.length < r) rows.push([]);
  (rows[r - 1] = rows[r - 1] || [])[c - 1] = v;
}

// A realistic store the way a well-kept Sheet looks (catalog_parity's heal,
// plus clean cells: Active and Use Multiplier are checkboxes, par a number,
// and some items already have a backup vendor).
function heal(spec, rnd) {
  const vendors = spec.vendors;
  const areas = AREAS.slice(0, 2 + Math.floor(rnd() * 3));
  areas.forEach(([n, o], i) => { setCell(spec.sheets.SETUP, i + 2, 8, n); setCell(spec.sheets.SETUP, i + 2, 9, o); });
  const master = spec.sheets.MASTER_ITEMS;
  const seen = new Set();
  const rows = [master[0]];
  const PARS = [1, 2, 3, 0.33, 1.1, 2.2, 4.2, 0.5, 0, 1.75, 10];
  for (const r of master.slice(1)) {
    const id = String(r[0] || '').trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const p = String(r[2] || '').trim().toLowerCase();
    const canon = vendors.find(v => v.toLowerCase() === p) || '';
    r[2] = canon;
    r[6] = PARS[Math.floor(rnd() * PARS.length)];
    r[11] = rnd() < 0.85;
    r[12] = rnd() < 0.8;
    const backup = vendors.length > 1 && rnd() < 0.3 ? vendors.find(v => v !== canon) : '';
    r[14] = [canon, backup].filter(Boolean).join('|');
    rows.push(r);
  }
  spec.sheets.MASTER_ITEMS = rows;

  const setup = spec.sheets.SETUP;
  for (let r = 2; r <= setup.length; r++) for (let c = 11; c <= 16; c++) if (setup[r - 1]) setup[r - 1][c - 1] = '';
  const items = rows.slice(1).map(r => ({ id: r[0], name: String(r[1] || '').trim() }));
  const pick = [];
  const used = new Set();
  const n = items.length && vendors.length ? 1 + Math.floor(rnd() * 35) : 0;
  for (let i = 0; i < n; i++) {
    const v = vendors[Math.floor(rnd() * vendors.length)];
    const it = items[Math.floor(rnd() * items.length)];
    if (used.has(v + '|' + it.id)) continue;
    used.add(v + '|' + it.id);
    const [area, ord] = areas[Math.floor(rnd() * areas.length)];
    pick.push([v, it.id, it.name, area, ord, [10, 20, 30, 15, 40, 25][Math.floor(rnd() * 6)]]);
  }
  pick.forEach((row, i) => row.forEach((val, j) => setCell(setup, i + 2, 11 + j, val)));
  return areas.map(a => a[0]);
}

function makeSide(spec) {
  const side = F.makeContext(spec, {
    console: { log() {}, info() {}, warn() {}, error() {} },   // Items.gs logs every refused area
    LockService: { getDocumentLock: () => ({ waitLock() {}, tryLock() { return true; }, releaseLock() {}, hasLock() { return true; } }) },
    Session: { getActiveUser: () => ({ getEmail: () => 'owner@example.com' }), getEffectiveUser: () => ({ getEmail: () => 'owner@example.com' }) }
  }, { advancingClock: true });
  const rule = { requireCheckbox() { return rule; }, setAllowInvalid() { return rule; }, build() { return {}; } };
  side.ctx.SpreadsheetApp.newDataValidation = () => rule;
  SHEET.runInContext(side.ctx);
  return side;
}
const run = (side, fn) => { NEW_EXECUTION.runInContext(side.ctx); return fn(side.ctx); };

// JSON with every object's keys sorted: a map's key order means nothing to
// a phone (the Sheet lists vendors in SETUP Z order, the tables A to Z).
// Arrays keep their order, which does matter.
function canon(v) {
  if (Array.isArray(v)) return '[' + v.map(canon).join(',') + ']';
  if (v && typeof v === 'object') return '{' + Object.keys(v).sort().map(k => JSON.stringify(k) + ':' + canon(v[k])).join(',') + '}';
  return JSON.stringify(v === undefined ? null : v);
}
// The phone catalog, with each pick row's stored item name dropped: the
// Sheet keeps the name the row was written with, the tables look it up.
function phoneCatalog(c) {
  const x = clone(c);
  x.pickRows = x.pickRows.map(r => [r[0], r[1], r[3], r[4], r[5]]);
  return canon(x);
}
const tablesCatalog = (tables, profile) => catalogFromTables({ tables, profile });

// The Sheet's answer without the Sheet's row numbers.
function plain(v) {
  if (!v || typeof v !== 'object') return JSON.stringify(v === undefined ? null : v);
  const o = clone(v);
  delete o.row; delete o.sheetRow;
  return JSON.stringify(o);
}
// Manage Items' screen data, items in the Sheet's row order (the page sorts
// them, and ties keep this order).
function screen(b) {
  return JSON.stringify({
    items: b.items,
    areas: b.areas,
    vendorTable: b.vendorTable.map(v => [v.name, v.mults]).sort(),
    minOrders: b.minOrders
  });
}

function pickOne(rnd, list) { return list[Math.floor(rnd() * list.length)]; }

// A random server call, as the page would send it (and some it wouldn't).
function randomCall(rnd, tables, areaNames) {
  const vendors = tables.vendors.map(v => v.name);
  const items = tables.items;
  const someVendor = () => {
    const x = rnd();
    if (x < 0.75 && vendors.length) return pickOne(rnd, vendors);
    if (x < 0.85 && vendors.length) return pickOne(rnd, vendors).toLowerCase();
    if (x < 0.93) return 'No Such Vendor';
    return '';
  };
  const someItem = () => (items.length && rnd() < 0.9 ? pickOne(rnd, items).id : 'ITEM-9999');
  const someArea = () => {
    const x = rnd();
    if (x < 0.45) return '';
    if (x < 0.85) return pickOne(rnd, areaNames);
    if (x < 0.92) return 'Nowhere';
    return '  ';
  };
  const eligible = () => vendors.filter(() => rnd() < 0.35).concat(rnd() < 0.1 ? ['Ghost Vendor'] : []);
  const par = () => pickOne(rnd, [1, 2, 0.5, 3.25, 0, 6, 1.5, 'x', NaN]);
  const flag = () => pickOne(rnd, [true, false, 'true', 'false']);
  const k = rnd();
  if (k < 0.22) {
    return ['commitUpsertItem', [{ mode: 'add', name: rnd() < 0.08 ? '' : pickOne(rnd, ['Nori Sheets', 'Lime', '  Tofu  ', 'Item ITEM-003']),
      vendor: someVendor(), eligibleVendors: eligible(), pack: pickOne(rnd, ['CS', 'EA', '']), par: par(),
      useMult: flag(), active: rnd() < 0.85 ? 'true' : 'false', areaName: someArea() }]];
  }
  if (k < 0.5) {
    const it = items.length ? pickOne(rnd, items) : null;
    const p = { mode: 'edit', lookup: rnd() < 0.93 ? someItem() : 'Nobody', name: rnd() < 0.3 ? 'Renamed ' + Math.floor(rnd() * 9) : (it ? it.name : 'X'),
      vendor: rnd() < 0.6 && it && it.primaryVendor ? it.primaryVendor : someVendor(), pack: pickOne(rnd, ['CS', 'EA', 'BAG']), par: par(),
      active: flag(), useMult: flag(), areaName: someArea() };
    if (rnd() < 0.7) p.eligibleVendors = eligible();
    if (rnd() < 0.2) p.notes = 'note ' + Math.floor(rnd() * 9);
    return ['commitUpsertItem', [p]];
  }
  if (k < 0.62) {
    const it = items.length ? pickOne(rnd, items) : null;
    const v = it && it.eligible.length && rnd() < 0.6 ? pickOne(rnd, it.eligible) : someVendor();
    return ['commitSwitchActiveVendor', [someItem(), v]];
  }
  if (k < 0.72) return ['commitSetVendorItems', [someVendor(), items.filter(() => rnd() < 0.3).map(i => i.id).concat(rnd() < 0.1 ? ['ITEM-9999'] : [])]];
  if (k < 0.8) return ['commitDeleteItem', [rnd() < 0.9 ? someItem() : '']];
  if (k < 0.88) return ['getItemForEdit', [someItem()]];
  if (k < 0.94) return ['getUnassignedActiveItems', []];
  return ['getManageItemsBootstrap', []];
}

const SHEET_FN = { commitUpsertItem: 'commitUpsertItem_', commitSwitchActiveVendor: 'commitSwitchActiveVendor_',
  commitSetVendorItems: 'commitSetVendorItems_', commitDeleteItem: 'commitDeleteItem_', getItemForEdit: 'getItemForEdit_',
  getUnassignedActiveItems: 'getUnassignedActiveItems_', getManageItemsBootstrap: 'getManageItemsBootstrap_' };

function runSuite(ceText, stores) {
  const CE = loadCatalogEdit(ceText);
  const failures = [];
  const stats = { stores: 0, steps: 0, writes: 0, errors: 0, undos: 0, conflicts: 0, adds: 0, shifts: 0 };
  const fail = (seed, what) => failures.push('seed ' + seed + ': ' + what);

  for (let seed = 1; seed <= stores && failures.length < 20; seed++) {
    const rnd = mulberry32(seed * 6151);
    let side, tables, profile;
    try {
      const spec = makeStore(seed, { realistic: true });
      const areaNames = heal(spec, rnd);
      side = makeSide(spec);
      const built = run(side, c => c.buildCatalogTables_());
      if (built.notes.length) { fail(seed, 'the healed Sheet needed cleanup: ' + built.notes[0].detail); continue; }
      ({ profile } = built.tables);
      tables = { vendors: built.tables.vendors, areas: built.tables.areas, items: built.tables.items, pickRows: built.tables.pickRows };
      tables = JSON.parse(JSON.stringify(tables, (k, v) => (k === 'seq' ? Number(v) : v)));
      if (phoneCatalog(run(side, c => c.buildCatalogPayload_())) !== phoneCatalog(tablesCatalog(tables, profile))) {
        fail(seed, 'the tables and the Sheet start out different'); continue;
      }
      stats.stores++;

      for (let step = 0; step < STEPS; step++) {
        const [fn, args] = randomCall(rnd, tables, areaNames);
        const tag = 'step ' + step + ' ' + fn + ' ' + JSON.stringify(args).slice(0, 140);
        stats.steps++;
        let want, wantErr = null, got, gotErr = null, out = null;
        try { want = run(side, c => c[SHEET_FN[fn]].apply(null, clone(args))); } catch (e) { wantErr = e.message; }
        try { out = CE.call(tables, fn, clone(args)); got = out.result; } catch (e) { gotErr = e.message; }
        if (wantErr !== gotErr) { fail(seed, tag + ': error ' + JSON.stringify(gotErr) + ', Items.gs ' + JSON.stringify(wantErr)); break; }
        if (wantErr) { stats.errors++; continue; }
        if (fn === 'getManageItemsBootstrap') {
          if (screen(got) !== screen(want)) { fail(seed, tag + ': Manage Items data differs'); break; }
          continue;
        }
        if (plain(got) !== plain(want)) { fail(seed, tag + ': answer ' + plain(got) + ', Items.gs ' + plain(want)); break; }
        if (!out.ops) continue;

        // A write: apply it, then compare what phones and Manage Items see.
        stats.writes++;
        if (out.ops.some(op => op.shift)) stats.shifts++;
        if (fn === 'commitUpsertItem' && args[0].mode === 'add') stats.adds++;
        const before = tables;
        tables = CE.applyOps(tables, out.ops);
        const sheetCat = phoneCatalog(run(side, c => c.buildCatalogPayload_()));
        if (sheetCat !== phoneCatalog(tablesCatalog(tables, profile))) {
          fail(seed, tag + ': phones would see a different catalog');
          break;
        }
        const sheetScreen = screen(run(side, c => c.getManageItemsBootstrap_()));
        if (sheetScreen !== screen(CE.call(tables, 'getManageItemsBootstrap', []).result)) { fail(seed, tag + ': Manage Items data differs after the write'); break; }
        if (out.ops.length && !out.label) fail(seed, tag + ': a change with no description');

        // Undo gives back exactly what was there.
        if (out.ops.length) {
          const undone = CE.applyOps(tables, CE.inverseOps(out.ops));
          if (phoneCatalog(tablesCatalog(undone, profile)) !== phoneCatalog(tablesCatalog(before, profile)) ||
              screen(CE.call(undone, 'getManageItemsBootstrap', []).result) !== screen(CE.call(before, 'getManageItemsBootstrap', []).result)) {
            fail(seed, tag + ': undo does not give back the catalog before');
            break;
          }
          stats.undos++;
        }
        // The same change twice: refused, not applied again.
        if (out.ops.some(op => !op.shift && (op.before === null || op.after === null))) {
          let refused = false;
          try { CE.applyOps(tables, out.ops); } catch (e) { refused = /^CONFLICT/.test(e.message); }
          if (!refused) { fail(seed, tag + ': the same change applied twice'); break; }
          stats.conflicts++;
        }
      }
    } catch (e) { fail(seed, 'crashed: ' + e.stack); }
  }
  return { failures, stats };
}

const CONTROLS = [
  { name: 'a promoted item drops its old primary',
    find: '      eligibleList.push(oldPrimary);', replace: '' },
  { name: 'a new item goes at the end instead of after its vendor',
    find: '    return after + 1;\n', replace: '    return w.items.reduce((m, it) => Math.max(m, it.seq), 0) + 1;\n' },
  { name: 'an inactive item stays on its vendors\' lists',
    find: '    if (!active) w.pickRows = w.pickRows.filter(r => s_(r.id) !== existing.id);', replace: '' },
  { name: 'a new pick row lands at the top of its area',
    find: "    w.pickRows.push({ vendor: String(vendor).trim(), id: id, area: areaName, shelfOrder: maxShelf + 10, seq: nextPickSeq(w) });",
    replace: "    w.pickRows.push({ vendor: String(vendor).trim(), id: id, area: areaName, shelfOrder: 0, seq: nextPickSeq(w) });" },
  { name: 'promoting to a vendor that is not eligible',
    find: "    if (eligible.map(v => v.toLowerCase()).indexOf(newVendor.toLowerCase()) === -1) {",
    replace: "    if (false) {" },
  { name: 'the assign tab leaves the eligible list as it was',
    find: '      if (want && !hasElig) {', replace: '      if (false) {' },
  { name: 'undo leaves the deleted rows deleted',
    find: '      .map(op => ({ t: op.t, key: op.key, before: op.after, after: op.before }));',
    replace: '      .filter(op => op.after !== null).map(op => ({ t: op.t, key: op.key, before: op.after, after: op.before }));' },
  { name: 'a change applied twice is not refused',
    find: "        if (i >= 0) throw new Error('CONFLICT: ' + op.t + ' ' + op.key + ' already exists');", replace: '' }
];

const NL = SRC(CE_FILE).indexOf('\r\n') >= 0 ? '\r\n' : '\n';
const live = runSuite(SRC(CE_FILE), STORES);
const s = live.stats;
console.log(`catalog_edit: ${s.stores} stores, ${s.steps} steps, ${s.writes} writes (${s.adds} adds, ${s.shifts} with rows moved down), ` +
            `${s.errors} refused alike, ${s.undos} undone, ${s.conflicts} repeats refused`);
let failed = 0;
if (live.failures.length) {
  failed++;
  console.log(`FAIL  ${live.failures.length} difference(s) from Items.gs:`);
  for (const f of live.failures.slice(0, 10)) console.log('      ' + f);
} else if (!s.adds || !s.shifts || !s.undos || !s.conflicts || !s.errors) {
  failed++;
  console.log('FAIL  a case was never exercised');
} else {
  console.log('PASS  catalogEdit.js answers, refuses and changes the catalog exactly as Items.gs does, and every change undoes');
}
for (const c of CONTROLS) {
  let r;
  try {
    r = runSuite(F.plant(SRC(CE_FILE), c.find.replace(/\n/g, NL), c.replace.replace(/\n/g, NL)), Math.min(STORES, 40));
  } catch (e) { failed++; console.log(`FAIL  control "${c.name}" crashed: ${e.message}`); continue; }
  if (r.failures.length) console.log(`PASS  control "${c.name}" bites (${r.failures.length})`);
  else { failed++; console.log(`FAIL  control "${c.name}" did NOT bite`); }
}
console.log(failed ? `catalog_edit: ${failed} FAILED` : 'catalog_edit: ALL PASS');
process.exit(failed ? 1 : 0);
