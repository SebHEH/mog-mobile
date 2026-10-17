'use strict';
// GATE: schema v4's catalog tables (step 6, design record D19-D22). The real
// Sync.gs (the whole codebase in one fake context) over a fake Supabase whose
// seed and catalog builder mirror supabase/schema_v4.sql (fake_supabase.js;
// the SQL itself is pinned by supabase/tests/smoke_v4.sql). On randomized
// stores:
//   - a healthy Sheet (no drift) seeds with nothing to clean, the catalog built
//     from the tables equals buildCatalogPayload_ exactly, every phone screen
//     matches (every vendor x 7 days x override off/on, over this cycle's
//     counts), and the editor-run wrapper logs PASS
//   - a messy Sheet (mog_fixture's drift: case-variant and padded vendor names,
//     pick rows for vendors or items that don't exist, duplicate pick rows,
//     repeated item ids, storage areas that don't exist or repeat) always
//     seeds and is never refused; every cleanup is listed, and screens that
//     differ always come with a cleanup that explains them
//   - seeding again gives the same catalog; once editor_direct is on the seed
//     is refused (and says why), and so is a catalog push from the Sheet
//   - a copied Sheet's drift (pick rows in an area that's gone, an item pasted
//     in twice, two items sharing an ID) is flagged by the Store Health Check,
//     and its two fixes (restore_areas, fix_repeated_ids) make the parity
//     check pass with nothing left to clean, without changing a phone's count
//     screen. The ID fix asks for confirmation and gives a different item its
//     own ID instead of deleting it.
// Each has a planted-defect control: in Sync.gs, and in the tables' builder.
//
// Run bare: node tests/catalog_parity.test.js [stores]   (default 120)
// A passing run ends with "catalog_parity: ALL PASS".

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const F = require('./fake_apps_script.js');
const { makeStore, mulberry32 } = require('./mog_fixture.js');
const { FakeSupabase, fakeScriptApp, catalogFromTables } = require('./fake_supabase.js');

const STORES = Number(process.argv[2]) || 120;
const DIR = path.join(F.REPO, 'apps-script');
const GS = fs.readdirSync(DIR).filter(f => f.endsWith('.gs')).sort();
const SRC = file => F.source(null, file);
const SLUG = 'zztest';
const OWNER = 'owner@example.com';
const AREAS = [['Walk-in', 10], ['Dry Storage', 20], ['Freezer', 30], ['Entrance Shelf', 40]];

function compileAll(srcOf) {
  return new vm.Script(GS.map(f => srcOf('apps-script/' + f)).join('\n'), { filename: 'all-gs.js' });
}

function setCell(rows, r, c, v) {
  while (rows.length < r) rows.push([]);
  (rows[r - 1] = rows[r - 1] || [])[c - 1] = v;
}

// SETUP H:I. A messy table can also repeat a name in another case, or carry
// an area with no numeric order.
function addAreas(spec, rnd, messy) {
  let rows = AREAS.slice(0, 2 + Math.floor(rnd() * 3));
  if (messy && rnd() < 0.3) rows = rows.concat([[rows[0][0].toUpperCase(), 50]]);
  if (messy && rnd() < 0.3) rows = rows.concat([['Bar', 'x']]);
  rows.forEach(([n, o], i) => { setCell(spec.sheets.SETUP, i + 2, 8, n); setCell(spec.sheets.SETUP, i + 2, 9, o); });
  return rows;
}

// A realistic store made drift-free, the way a well-kept Sheet looks: unique
// trimmed Item IDs, primaries spelled as listed (or none), and a pick path
// whose rows name listed vendors, existing items and existing areas, carry
// the area's own order and the item's name, once per vendor. Returns the
// pick rows written.
function heal(spec, rnd) {
  const vendors = spec.vendors;
  const areas = addAreas(spec, rnd, false);
  const master = spec.sheets.MASTER_ITEMS;
  const seen = new Set();
  const rows = [master[0]];
  for (const r of master.slice(1)) {
    const id = String(r[0] || '').trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const p = String(r[2] || '').trim().toLowerCase();
    const canon = vendors.find(v => v.toLowerCase() === p) || '';
    r[2] = canon;
    r[14] = canon;
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
  return pick;
}

// The drift a copied, unmaintained Sheet carries (rpt/rpfr, 2026-10-17):
//   - pick rows of one vendor in an area the list doesn't have, no area order
//   - an item on a pick row pasted in again ABOVE itself, with another par
//     (phones read the later row, so its par must win)
//   - a different item pasted in above another item, reusing its ID
function addCopyDrift(spec, pick, rnd) {
  const setup = spec.sheets.SETUP;
  const master = spec.sheets.MASTER_ITEMS;
  const out = { lostRows: 0, same: 0, different: 0, otherName: null };
  if (pick.length) {
    const v = pick[Math.floor(rnd() * pick.length)][0];
    pick.forEach((row, i) => {
      if (row[0] === v && rnd() < 0.7) { setCell(setup, i + 2, 14, 'Expo'); setCell(setup, i + 2, 15, ''); out.lostRows++; }
    });
  }
  const onPick = new Set(pick.map(p => p[1]));
  const ids = master.slice(1).filter(r => onPick.has(String(r[0] || '').trim()));
  if (ids.length >= 2) {
    const a = ids[Math.floor(rnd() * ids.length)];
    const copy = a.slice();
    copy[6] = 99;
    master.splice(master.indexOf(a), 0, copy);
    out.same++;
    const b = ids.find(r => r !== a);
    const other = b.slice();
    other[1] = 'Scanned Stamp ' + b[0];
    other[2] = spec.vendors.find(v => v !== b[2]) || '';
    other[14] = other[2];
    master.splice(master.indexOf(b), 0, other);
    out.different++;
    out.otherName = other[1];
  }
  return out;
}

// Every count screen (and dashboard, prefixed D) for a catalog, no counts.
const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
function screens(c, catalog, state) {
  const out = [];
  for (const day of DAYS) for (const override of [false, true]) {
    const snap = JSON.parse(JSON.stringify({ catalog, state: Object.assign({}, state, { dayOfWeek: day, emergencyOverride: override }), counts: [] }));
    const inputs = c.orderInputsFromSnapshot_(snap);
    for (const v of catalog.vendorList) out.push(day + override + ' ' + v + ' ' + JSON.stringify(c.vendorItemsFromSnapshot_(inputs, v)));
    out.push('D' + day + override + ' ' + JSON.stringify(c.dashboardFromSnapshot_(inputs)));
  }
  return out;
}
const firstChange = (a, b) => { for (let i = 0; i < Math.max(a.length, b.length); i++) if (a[i] !== b[i]) return (a[i] || '(none)').slice(0, 160); return ''; };

function makeSide(spec, script, sb, props) {
  const logs = [];
  const side = F.makeContext(Object.assign({}, spec, { scriptProps: Object.assign({}, spec.scriptProps, props) }), {
    UrlFetchApp: sb.urlFetchApp(),
    ScriptApp: fakeScriptApp(),
    LockService: { getDocumentLock: () => ({ waitLock() {}, tryLock() { return true; }, releaseLock() {}, hasLock() { return true; } }) },
    Session: { getActiveUser: () => ({ getEmail: () => OWNER }), getEffectiveUser: () => ({ getEmail: () => OWNER }) },
    Logger: { log: s => logs.push(String(s)) }
  });
  script.runInContext(side.ctx);
  side.logs = logs;
  return side;
}
const NEW_EXECUTION = new vm.Script('_SB_CONFIG_ = null; _SB_SNAPSHOT_ = null; _SHEET_CACHE_.clear();');
const run = (side, fn) => { NEW_EXECUTION.runInContext(side.ctx); return fn(side.ctx); };

function runSuite(srcOf, stores, catalogDefect) {
  const script = compileAll(srcOf || SRC);
  const failures = [];
  const stats = { healthy: 0, screens: 0, counts: 0, repairs: 0, messy: 0, messyDiffer: 0, messyPassWithNotes: 0, notes: {} };
  const fail = (seed, scenario, what) => failures.push('seed ' + seed + ' [' + scenario + ']: ' + what);

  for (let seed = 1; seed <= stores; seed++) {
    const rnd = mulberry32(seed * 7919);

    // ---- A healthy Sheet ----
    try {
      const spec = makeStore(seed, { realistic: true });
      const pick = heal(spec, rnd);
      const sb = new FakeSupabase(spec.now);
      sb.catalogDefect = catalogDefect || null;
      const key = sb.provision(SLUG);
      const side = makeSide(spec, script, sb, { MOG_SUPABASE_SLUG: SLUG, MOG_SUPABASE_SYNC_KEY: key, MOG_BACKEND: 'supabase' });
      run(side, c => { c.pushCatalogNow_(); c.setDbStateFromSheet_(); });
      const s = sb.stores.get(SLUG);
      const ON_HAND = [0, 1, 2.5, '', 3, 7, 0.25];
      const counts = pick.filter(() => rnd() < 0.5)
        .map(r => ({ vendor: r[0], id: r[1], onHand: ON_HAND[Math.floor(rnd() * ON_HAND.length)] }));
      sb.upsert(s, s.state.cycleDate, null, counts);
      stats.counts += counts.length;

      const r = run(side, c => c.catalogTablesParity_());
      if (r.error) fail(seed, 'healthy', 'seed refused: ' + r.error);
      else {
        if (r.notes.length) fail(seed, 'healthy', 'cleaned a healthy Sheet: ' + r.notes[0].detail);
        if (r.report.payloadDiff) fail(seed, 'healthy', 'catalog JSON differs: ' + r.report.payloadDiff);
        if (!r.report.ok) fail(seed, 'healthy', 'screens differ: ' + r.report.diffs[0]);
        if (r.report.checks !== 14 * (r.report.vendors + 1)) fail(seed, 'healthy', 'compared ' + r.report.checks + ' screens');
        if (!r.ok) fail(seed, 'healthy', 'not ok');
        stats.healthy++;
        stats.screens += r.report.checks;

        // Seeding again gives the same catalog.
        const first = JSON.stringify(catalogFromTables(s));
        const again = run(side, c => c.catalogTablesParity_());
        if (again.error || JSON.stringify(catalogFromTables(s)) !== first) fail(seed, 'healthy', 'a second seed changed the catalog');

        // The editor-run wrapper.
        side.logs.length = 0;
        run(side, c => c.test_catalogTablesParity());
        const text = side.logs.join('\n');
        if (!/\nRESULT: PASS$/.test(text) || !/Phones: MATCH on every screen/.test(text)) fail(seed, 'healthy', 'wrapper log: ' + text.slice(-200));

        // Once the editor writes to Supabase, the Sheet can't seed or push.
        s.editorDirect = true;
        const tablesBefore = JSON.stringify(s.tables);
        const refused = run(side, c => c.catalogTablesParity_());
        if (!refused.error || !/EDITOR_DIRECT/.test(refused.error) || refused.ok) fail(seed, 'editor_direct', 'seed not refused');
        if (!/already writes to Supabase/.test(run(side, c => c.formatCatalogParity_(refused)))) fail(seed, 'editor_direct', 'no explanation');
        if (JSON.stringify(s.tables) !== tablesBefore) fail(seed, 'editor_direct', 'tables changed');
        let pushed = true;
        try { run(side, c => c.pushCatalogNow_()); } catch (e) { pushed = !/EDITOR_DIRECT/.test(e.message); }
        if (pushed) fail(seed, 'editor_direct', 'a Sheet catalog push went through');
      }
    } catch (e) { fail(seed, 'healthy', 'crashed: ' + e.stack); }

    // ---- A copied Sheet's drift, repaired by the two Health Check fixes ----
    try {
      const spec = makeStore(seed + 20000, { realistic: true });
      const rnd2 = mulberry32(seed * 104729);
      const pick = heal(spec, rnd2);
      const drift = addCopyDrift(spec, pick, rnd2);
      const sb = new FakeSupabase(spec.now);
      const key = sb.provision(SLUG);
      const side = makeSide(spec, script, sb, { MOG_SUPABASE_SLUG: SLUG, MOG_SUPABASE_SYNC_KEY: key, MOG_BACKEND: 'supabase' });
      run(side, c => { c.pushCatalogNow_(); c.setDbStateFromSheet_(); });
      const state = sb.stores.get(SLUG).state;
      const health = () => {
        const out = {};
        for (const ch of run(side, c => c.getStoreHealthReport_()).checks) out[ch.id] = ch;
        return out;
      };
      const masterRows = () => side.book.sheets.get('MASTER_ITEMS').rows.filter((r, i) => i > 0 && r && String(r[0] || '').trim());

      let h = health();
      const wantArea = drift.lostRows ? 'warn' : 'pass';
      if (!h.pick_areas || h.pick_areas.status !== wantArea) fail(seed, 'repair', 'storage-area row is ' + (h.pick_areas && h.pick_areas.status) + ', expected ' + wantArea);
      if (drift.lostRows && !/"Expo" \(\d+ rows?\)/.test(h.pick_areas.detail)) fail(seed, 'repair', 'storage-area row text: ' + h.pick_areas.detail);
      if (drift.same) {
        const r = h.repeated_ids;
        if (!r || r.status !== 'fail' || !r.destructive) fail(seed, 'repair', 'repeated-ID row: ' + JSON.stringify(r));
        else if (!/\(same item\)/.test(r.detail) || !/\(a different item\)/.test(r.detail)) fail(seed, 'repair', 'repeated-ID plan: ' + r.detail);
      }
      if (drift.lostRows || drift.same) {
        const pre = run(side, c => c.catalogTablesParity_());
        if (pre.ok) fail(seed, 'repair', 'parity passed before the repair');
      }

      const before = screens(side.ctx, run(side, c => c.buildCatalogPayload_()), state);
      run(side, c => c.runHealthFix_('restore_areas'));
      const mid = screens(side.ctx, run(side, c => c.buildCatalogPayload_()), state);
      const d1 = firstChange(before, mid);
      if (d1) fail(seed, 'repair', 'the area repair changed a phone screen: ' + d1);

      const rowsBefore = masterRows().length;
      const msg = run(side, c => c.runHealthFix_('fix_repeated_ids')).message;
      const after = screens(side.ctx, run(side, c => c.buildCatalogPayload_()), state);
      const d2 = firstChange(mid.filter(s => s[0] !== 'D'), after.filter(s => s[0] !== 'D'));
      if (d2) fail(seed, 'repair', 'the ID repair changed a count screen: ' + d2);
      if (masterRows().length !== rowsBefore - drift.same) fail(seed, 'repair', 'MASTER rows ' + rowsBefore + ' -> ' + masterRows().length + ': ' + msg);
      if (drift.different) {
        const moved = masterRows().filter(r => r[1] === drift.otherName);
        const ids = masterRows().map(r => String(r[0]).trim());
        if (moved.length !== 1 || ids.filter(x => x === String(moved[0][0]).trim()).length !== 1) {
          fail(seed, 'repair', 'the different item did not get its own ID: ' + msg);
        }
      }

      h = health();
      if (h.pick_areas.status !== 'pass' || h.repeated_ids.status !== 'pass') fail(seed, 'repair', 'Health rows after the fixes: ' + h.pick_areas.status + '/' + h.repeated_ids.status);
      const r = run(side, c => c.catalogTablesParity_());
      if (r.error) fail(seed, 'repair', 'seed refused after the repair: ' + r.error);
      else {
        if (r.notes.length) fail(seed, 'repair', 'still cleaned after the repair: ' + r.notes[0].detail);
        if (!r.ok) fail(seed, 'repair', 'parity fails after the repair: ' + r.report.diffs[0]);
      }
      if (drift.lostRows || drift.same) stats.repairs++;
    } catch (e) { fail(seed, 'repair', 'crashed: ' + e.stack); }

    // ---- A messy Sheet ----
    try {
      const spec = makeStore(seed + 10000);
      if (rnd() < 0.7) addAreas(spec, rnd, true);
      const sb = new FakeSupabase(spec.now);
      sb.catalogDefect = catalogDefect || null;
      const key = sb.provision(SLUG);
      const switched = rnd() < 0.5;
      const side = makeSide(spec, script, sb, Object.assign({ MOG_SUPABASE_SLUG: SLUG, MOG_SUPABASE_SYNC_KEY: key },
        switched ? { MOG_BACKEND: 'supabase' } : {}));
      if (switched) run(side, c => { c.pushCatalogNow_(); c.setDbStateFromSheet_(); c.importSheetCountsToDb_(); });

      const r = run(side, c => c.catalogTablesParity_());
      if (r.error) { fail(seed, 'messy', 'seed refused: ' + r.error); continue; }
      stats.messy++;
      for (const n of r.notes) stats.notes[n.kind] = (stats.notes[n.kind] || 0) + 1;
      if (!r.report.ok) {
        stats.messyDiffer++;
        if (!r.notes.length) fail(seed, 'messy', 'screens differ with no cleanup listed: ' + r.report.diffs[0]);
        const text = run(side, c => c.formatCatalogParity_(r));
        if (!/\nRESULT: FAIL$/.test(text) || !/screens DIFFER/.test(text)) fail(seed, 'messy', 'log does not say FAIL');
      } else if (r.notes.length) stats.messyPassWithNotes++;
    } catch (e) { fail(seed, 'messy', 'crashed: ' + e.stack); }
  }
  return { failures, stats };
}

// ---------------------------------------------------------------------------
let failed = 0;
const main = runSuite(null, STORES);
const st = main.stats;
console.log(`catalog_parity: ${st.healthy} healthy stores (${st.screens} screens, ${st.counts} counts), ` +
  `${st.repairs} copied Sheets repaired, ${st.messy} messy (${st.messyDiffer} differ, ${st.messyPassWithNotes} pass after harmless cleanups); ` +
  `cleanups by kind ${JSON.stringify(st.notes)}`);
if (main.failures.length) {
  failed++;
  console.log(`FAIL  ${main.failures.length} problem(s):`);
  for (const f of main.failures.slice(0, 15)) console.log('      ' + f);
} else {
  console.log('PASS  healthy Sheets seed clean and match exactly; messy Sheets always seed, with every cleanup listed; editor_direct locks the Sheet out');
}
if (st.healthy !== STORES) { failed++; console.log('FAIL  only ' + st.healthy + ' of ' + STORES + ' healthy stores ran'); }
if (!st.counts) { failed++; console.log('FAIL  fixtures never had counts'); }
if (st.repairs < STORES / 2) { failed++; console.log('FAIL  only ' + st.repairs + ' stores had drift to repair'); }
if (!st.messyDiffer) { failed++; console.log('FAIL  no messy store ever differed: the gate never saw drift'); }
if (!st.messyPassWithNotes) { failed++; console.log('FAIL  no messy store passed after harmless cleanups'); }
for (const k of ['vendor', 'area', 'item', 'pick']) {
  if (!st.notes[k]) { failed++; console.log('FAIL  no "' + k + '" cleanup ever happened'); }
}

const SYNC = 'apps-script/Sync.gs';
const NL = String.fromCharCode(13, 10);   // the .gs files use CRLF
const CONTROLS = [
  { name: 'a non-numeric par seeded as 0', scenario: 'healthy',
    find: "      par:           isNaN(m.par) ? null : m.par,\r\n      active:        m.active,",
    replace: "      par:           isNaN(m.par) ? 0 : m.par,\r\n      active:        m.active," },
  { name: 'duplicate pick rows not dropped', scenario: 'messy',
    find: '    if (onList.has(key)) {', replace: '    if (false) {' },
  { name: 'a storage area that does not exist kept', scenario: 'messy',
    find: '      area = canonArea.get(areaText.toLowerCase()) || null;',
    replace: '      area = canonArea.get(areaText.toLowerCase()) || areaText;' },
  { name: 'a primary vendor kept as typed', scenario: 'messy',
    find: '    const primary = m.primaryVendor ? (canonVendor.get(m.primaryVendor.toLowerCase()) || null) : null;',
    replace: '    const primary = m.primaryVendor || null;' },
  { name: 'override-on screens not compared', scenario: 'healthy',
    find: '    for (const override of [false, true]) {', replace: '    for (const override of [false]) {' },
  { name: 'restored areas get no order on their rows', scenario: 'repair', file: 'apps-script/PickPath.gs',
    find: '  if (drift.missing.length) writeAreaList_(setup, finalList);'+NL+'  syncPickDbAreaOrders_(setup);',
    replace: '  if (drift.missing.length) writeAreaList_(setup, finalList);' },
  { name: 'restored areas added at the front', scenario: 'repair', file: 'apps-script/PickPath.gs',
    find: 'const finalList = current.map(a => ({ name: a.name })).concat(drift.missing.map(m => ({ name: m.name })));',
    replace: 'const finalList = drift.missing.map(m => ({ name: m.name })).concat(current.map(a => ({ name: a.name })));' },
  { name: 'the row phones read is the one deleted', scenario: 'repair', file: 'apps-script/Items.gs',
    find: 'steps.push({ row: c.row, action: "delete", copy: c });', replace: 'steps.push({ row: keep.row, action: "delete", copy: c });' },
  { name: 'a different item deleted instead of given its own ID', scenario: 'repair', file: 'apps-script/Items.gs',
    find: 'else steps.push({ row: c.row, action: "reid", newId: "ITEM-" + String(++next).padStart(4, "0"), copy: c });',
    replace: 'else steps.push({ row: c.row, action: "delete", copy: c });' },
  { name: 'the ID repair runs without a confirmation', scenario: 'repair', file: 'apps-script/Health.gs',
    find: "        'fix_repeated_ids', true);", replace: "        'fix_repeated_ids', false);" }
];
const DEFECTS = [
  { name: 'tables builder sends a missing primary as null', scenario: 'healthy',
    fn: c => { for (const id of Object.keys(c.items)) if (c.items[id].primaryVendor === '') c.items[id].primaryVendor = null; return c; } },
  { name: 'tables builder loses the area order', scenario: 'healthy',
    fn: c => { c.pickRows = c.pickRows.map(r => r.slice(0, 4).concat([null, r[5]])); return c; } },
  { name: 'tables builder drops backup counts', scenario: 'healthy',
    fn: c => { c.backupCounts = {}; return c; } },
  { name: 'tables builder counts inactive items', scenario: 'healthy',
    fn: c => { c.itemCounts = Object.fromEntries(Object.entries(c.itemCounts).map(([k, n]) => [k, n + 1])); return c; } }
];
const N = Math.min(STORES, 40);
for (const c of CONTROLS.concat(DEFECTS)) {
  let res;
  try {
    if (c.fn) res = runSuite(null, N, c.fn);
    else {
      const file = c.file || SYNC;
      const planted = F.plant(SRC(file), c.find, c.replace);
      res = runSuite(f => (f === file ? planted : SRC(f)), N);
    }
  } catch (e) {
    failed++;
    console.log(`FAIL  control "${c.name}" crashed instead of biting: ${e.message}`);
    continue;
  }
  const hits = res.failures.filter(f => f.includes('[' + c.scenario + ']')).length;
  if (hits) console.log(`PASS  control "${c.name}" bites (${hits} in "${c.scenario}")`);
  else { failed++; console.log(`FAIL  control "${c.name}" did NOT bite "${c.scenario}"`); }
}

console.log(failed ? `catalog_parity: ${failed} FAILED` : 'catalog_parity: ALL PASS');
process.exit(failed ? 1 : 0);
