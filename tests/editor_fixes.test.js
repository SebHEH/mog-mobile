'use strict';
// GATE: the three fixes of 2026-10-16 (design record D18), on the WHOLE
// Apps Script codebase loaded into one fake context:
//   - removing a vendor deletes only that vendor's cells (R:AA and AF) and
//     leaves SETUP's other tables alone: storage areas (H:I), the pick path
//     (K:P), recipients (AB:AE)
//   - saving an item from a form that doesn't send notes keeps them; a form
//     that sends notes still sets them
//   - the dispatcher: Sheet-only actions need a 'sheet' token, every action
//     maps to a private function, an unknown one is refused; editor-run
//     functions refuse a web caller
//   - a store whose catalog is edited in the app (schema v8): catalog writes,
//     catalog repairs and pushes through the Sheet are refused with where to go
// Each has a planted-defect control.
//
// Run bare: node tests/editor_fixes.test.js [stores]   (default 40)
// A passing run ends with "editor_fixes: ALL PASS".

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const F = require('./fake_apps_script.js');
const { makeStore } = require('./mog_fixture.js');

const STORES = Number(process.argv[2]) || 40;
const DIR = path.join(F.REPO, 'apps-script');
const GS = fs.readdirSync(DIR).filter(f => f.endsWith('.gs')).sort();
const SRC = file => F.source(null, file);
const OWNER = 'owner@example.com';

function compileAll(srcOf) {
  return new vm.Script(GS.map(f => srcOf('apps-script/' + f)).join('\n'), { filename: 'all-gs.js' });
}

// SETUP's other tables, which share rows with the vendor table.
function addSideTables(spec, seed) {
  const setup = spec.sheets.SETUP;
  const set = (r, c, v) => { while (setup.length < r) setup.push([]); (setup[r - 1] = setup[r - 1] || [])[c - 1] = v; };
  ['Walk-in', 'Dry Storage', 'Freezer', 'Front Shelf', 'Bar'].slice(0, 2 + (seed % 4)).forEach((a, i) => {
    set(i + 2, 8, a); set(i + 2, 9, (i + 1) * 10);
  });
  ['GM', 'Chef', 'Owner', 'KM'].slice(0, 1 + (seed % 4)).forEach((n, i) => {
    set(i + 2, 28, n); set(i + 2, 29, n.toLowerCase() + '@example.com'); set(i + 2, 30, true); set(i + 2, 31, i === 0);
  });
}

function makeSide(spec, script, session) {
  const side = F.makeContext(spec, {
    LockService: { getDocumentLock: () => ({ waitLock() {}, tryLock() { return true; }, releaseLock() {}, hasLock() { return true; } }) },
    Session: session || { getActiveUser: () => ({ getEmail: () => OWNER }), getEffectiveUser: () => ({ getEmail: () => OWNER }) }
  });
  side.ctx.Utilities.getUuid = () => 'tok-' + Math.random().toString(36).slice(2);
  script.runInContext(side.ctx);
  return side;
}

const cols = (rows, c0, c1, from) => rows.slice(from - 1).map(r => {
  const out = [];
  for (let c = c0; c <= c1; c++) { const v = (r || [])[c - 1]; out.push(v === undefined || v === null ? '' : v); }
  return out;
});
const trimTail = grid => { const g = grid.map(r => JSON.stringify(r)); while (g.length && /^\[("",?)*\]$/.test(g[g.length - 1])) g.pop(); return g; };

function runSuite(srcOf, stores) {
  const script = compileAll(srcOf);
  const failures = [];
  const stats = { removals: 0, notesEdits: 0 };
  const fail = (seed, scenario, what) => failures.push('seed ' + seed + ' [' + scenario + ']: ' + what);

  for (let seed = 1; seed <= stores; seed++) {
    const spec = makeStore(seed, { realistic: true });
    addSideTables(spec, seed);

    // ---- Removing a vendor ------------------------------------------------
    try {
      const vendors = spec.vendors;
      if (vendors.length >= 2) {
        const side = makeSide(spec, script);
        const setupBefore = side.book.sheets.get('SETUP').rows.map(r => (r || []).slice());
        const victim = vendors[Math.floor(vendors.length / 2)];
        const victimRow = 2 + vendors.indexOf(victim);
        side.ctx.commitRemoveVendor_(victim);
        const setupAfter = side.book.sheets.get('SETUP').rows;
        for (const [label, c0, c1] of [['storage areas H:I', 8, 9], ['pick path K:P', 11, 16], ['recipients AB:AE', 28, 31]]) {
          const a = trimTail(cols(setupBefore, c0, c1, 2)), b = trimTail(cols(setupAfter, c0, c1, 2));
          if (JSON.stringify(a) !== JSON.stringify(b)) fail(seed, 'remove vendor', label + ' changed');
        }
        for (const [label, c0, c1] of [['vendor table R:AA', 18, 27], ['day picks AF', 32, 32]]) {
          const want = cols(setupBefore, c0, c1, 2);
          want.splice(victimRow - 2, 1);
          const a = trimTail(want), b = trimTail(cols(setupAfter, c0, c1, 2));
          if (JSON.stringify(a) !== JSON.stringify(b)) fail(seed, 'remove vendor', label + ' not shifted up by exactly that vendor');
        }
        const master = side.book.sheets.get('MASTER_ITEMS').rows;
        for (let i = 1; i < master.length; i++) {
          const r = master[i] || [];
          if (String(r[2] || '').trim().toLowerCase() === victim.toLowerCase() && r[11] !== false) {
            fail(seed, 'remove vendor', 'an item of the removed vendor is still active');
          }
        }
        stats.removals++;
      }
    } catch (e) { fail(seed, 'remove vendor', 'crashed: ' + e.message); }

    // ---- Saving an item keeps its notes -----------------------------------
    try {
      const master = spec.sheets.MASTER_ITEMS;
      const rowIdx = master.findIndex((r, i) => i > 0 && r && r[0] && String(r[1] || '').trim() &&
        spec.vendors.some(v => v.toLowerCase() === String(r[2] || '').trim().toLowerCase()));
      if (rowIdx > 0) {
        const id = master[rowIdx][0];
        const vendor = spec.vendors.find(v => v.toLowerCase() === String(master[rowIdx][2]).trim().toLowerCase());
        const base = { mode: 'edit', lookup: id, name: String(master[rowIdx][1]).trim(), vendor, pack: 'CS', par: 4, useMult: true, active: true };
        for (const [label, payload, want] of [
          ['form without notes', base, 'Keep cold, rotate stock'],
          ['form with notes', Object.assign({}, base, { notes: 'New note' }), 'New note']
        ]) {
          const s2 = JSON.parse(JSON.stringify(spec));
          s2.sheets.MASTER_ITEMS[rowIdx][13] = 'Keep cold, rotate stock';
          const side = makeSide(s2, script);
          side.ctx.commitUpsertItem_(payload);
          const got = side.book.sheets.get('MASTER_ITEMS').rows[rowIdx][13];
          if (got !== want) fail(seed, 'notes', label + ': notes are ' + JSON.stringify(got) + ', expected ' + JSON.stringify(want));
          const par = side.book.sheets.get('MASTER_ITEMS').rows[rowIdx][6];
          if (par !== 4) fail(seed, 'notes', label + ': the par did not save (' + par + ')');
          stats.notesEdits++;
        }
      }
    } catch (e) { fail(seed, 'notes', 'crashed: ' + e.message); }
  }

  // ---- The dispatcher and the editor-run guard ----------------------------
  try {
    const side = makeSide(makeStore(5, { realistic: true }), script);
    const c = side.ctx;
    if (c.webeditDispatch_('commitSelectiveReset', 'store') !== null) failures.push('[dispatch] a web token reaches Admin Reset');
    if (typeof c.webeditDispatch_('commitSelectiveReset', 'sheet') !== 'function') failures.push('[dispatch] a sheet token cannot reach Admin Reset');
    if (c.webeditDispatch_('getVendorList', 'sheet') !== null) failures.push('[dispatch] an unlisted name resolved');
    c.putEditorToken_('webtok', 'store');
    c.putEditorToken_('sheettok', 'sheet');
    let refused = false;
    try { c.webedit_call('webtok', 'commitSelectiveReset', [{}]); } catch (e) { refused = /not allowed/.test(e.message); }
    if (!refused) failures.push('[dispatch] webedit_call let a web token run Admin Reset');
    if (!Array.isArray(c.webedit_call('sheettok', 'getVendorTableData', []))) failures.push('[dispatch] a sheet token could not read through webedit_call');
    let expired = false;
    try { c.webedit_call('nope', 'getVendorTableData', []); } catch (e) { expired = /SESSION_EXPIRED/.test(e.message); }
    if (!expired) failures.push('[dispatch] an unknown token was accepted');

    // A store whose catalog is edited in the app (schema v8): catalog writes
    // through the Sheet are refused with where to go; reads and Admin Reset
    // still work.
    side.scriptProps.set('MOG_SUPABASE_SLUG', 'zzapp');
    side.scriptProps.set('MOG_EDITOR', 'supabase');
    vm.runInContext('_SB_CONFIG_ = null', c);
    const writes = [['commitAddVendor', ['Costco', [1, 0, 0, 0, 0, 0, 0], '']], ['commitStorageAreasDraft', [[]]],
                    ['commitUpsertItem', [{ mode: 'add', name: 'X', vendor: 'x', par: 1 }]], ['commitVendorRecalibration', [{}]]];
    for (const [fn, args] of writes) {
      let moved = '';
      try { c.webedit_call('sheettok', fn, args); } catch (e) { moved = e.message; }
      if (!/edited in the app now, on a computer: https:\/\/sebheh\.github\.io\/mog-mobile\/zzapp\/editor\//.test(moved)) {
        failures.push('[moved] ' + fn + ' was not refused: ' + (moved || 'it ran'));
      }
    }
    if (!Array.isArray(c.webedit_call('sheettok', 'getVendorTableData', []))) failures.push('[moved] reads stopped working');
    if (!/edited in the app now/.test(c.runHealthFix_('restore_areas').message)) failures.push('[moved] a catalog repair ran');
    if (!c.pushCatalogNow_().skipped) failures.push('[moved] the Sheet still pushes its catalog');
    side.scriptProps.delete('MOG_EDITOR');
  } catch (e) { failures.push('[dispatch] crashed: ' + e.message); }

  for (const [label, active, effective, allowed] of [
    ['the owner in the editor', OWNER, OWNER, true],
    ['an anonymous web visitor', '', OWNER, false],
    ['another signed-in person on the web app', 'someone@hehfood.com', OWNER, false]
  ]) {
    try {
      const side = makeSide(makeStore(5, { realistic: true }), script,
        { getActiveUser: () => ({ getEmail: () => active }), getEffectiveUser: () => ({ getEmail: () => effective }) });
      let ok = true;
      try { side.ctx.requireEditorRun_(); } catch (e) { ok = false; }
      if (ok !== allowed) failures.push('[guard] ' + label + ': ' + (ok ? 'allowed' : 'refused'));
    } catch (e) { failures.push('[guard] crashed: ' + e.message); }
  }
  return { failures, stats };
}

// ---------------------------------------------------------------------------
let failed = 0;
const res = runSuite(SRC, STORES);
console.log(`editor_fixes: ${res.stats.removals} vendor removals, ${res.stats.notesEdits} item saves`);
if (res.failures.length) {
  failed++;
  console.log(`FAIL  ${res.failures.length} problem(s):`);
  for (const f of res.failures.slice(0, 15)) console.log('      ' + f);
} else {
  console.log('PASS  removing a vendor leaves areas, pick path and recipients alone; saves keep notes; dispatcher tiers and the guard hold');
}
if (!res.stats.removals || !res.stats.notesEdits) { failed++; console.log('FAIL  fixtures never removed a vendor or saved an item'); }

const CONTROLS = [
  { name: 'removing a vendor deletes the whole row again', file: 'apps-script/Vendors.gs', bites: 'remove vendor',
    find: "  setup.getRange(deletedRow, VENDOR_TABLE.VENDOR_COL, 1, VENDOR_CUTOFF_COL - VENDOR_TABLE.VENDOR_COL + 1)",
    replace: "  setup.deleteRow(deletedRow); if (false) setup.getRange(deletedRow, VENDOR_TABLE.VENDOR_COL, 1, VENDOR_CUTOFF_COL - VENDOR_TABLE.VENDOR_COL + 1)" },
  { name: 'the day pick column left behind', file: 'apps-script/Vendors.gs', bites: 'remove vendor',
    find: "  setup.getRange(deletedRow, VENDOR_OVERRIDE_COL, 1, 1)\r\n       .deleteCells(SpreadsheetApp.Dimension.ROWS);",
    replace: "" },
  { name: 'an edit blanks the notes again', file: 'apps-script/Items.gs', bites: 'notes',
    find: "sh.getRange(row, COL.ACTIVE, 1, 3).setValues([[active, useMult, editNotes]]);",
    replace: "sh.getRange(row, COL.ACTIVE, 1, 3).setValues([[active, useMult, notes]]);" },
  { name: 'Admin Reset open to web tokens', file: 'apps-script/Editor.gs', bites: '[dispatch]',
    find: "  if (tier !== 'sheet') return null;", replace: "" },
  { name: 'the editor-run guard trusts any signed-in person', file: 'apps-script/Editor.gs', bites: '[guard]',
    find: "  if (!active || active !== effective) {", replace: "  if (!active) {" }
];
for (const c of CONTROLS) {
  let r;
  try {
    const planted = F.plant(SRC(c.file), c.find, c.replace);
    r = runSuite(file => (file === c.file ? planted : SRC(file)), Math.min(STORES, 12));
  } catch (e) {
    failed++;
    console.log(`FAIL  control "${c.name}" crashed instead of biting: ${e.message}`);
    continue;
  }
  const hits = r.failures.filter(f => f.includes(c.bites)).length;
  if (hits) console.log(`PASS  control "${c.name}" bites (${hits})`);
  else { failed++; console.log(`FAIL  control "${c.name}" did NOT bite (${r.failures[0] || 'no failures'})`); }
}

console.log(failed ? `editor_fixes: ${failed} FAILED` : 'editor_fixes: ALL PASS');
process.exit(failed ? 1 : 0);
