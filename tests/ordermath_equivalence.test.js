'use strict';
// GATE: the 2026-10-15 extraction of the order math into OrderMath.gs did not
// change a single server answer.
//
// OLD = MOGApi.gs at commit c0b6dfb (the last commit before the extraction).
// NEW = the working tree: MOGApi.gs + OrderMath.gs.
// For every randomized store, every vendor (plus a case-variant name and an
// unknown one), api_getVendorItems_ is called with and without the shared read
// context, and api_getDashboard_compute_ once; OLD and NEW must return the
// same output (values, then ORDER as a separate assertion), throw the same
// errors, and read exactly as many cells.
//
// The OLD reference is pinned on purpose. If a later change MEANS to alter
// these answers, this gate fails, and that is the prompt to re-pin BASE to the
// commit that carries the intended change.
//
// Run bare: node tests/ordermath_equivalence.test.js [stores]   (default 400)
// A passing run ends with "ordermath_equivalence: ALL PASS".

const vm = require('vm');
const F = require('./fake_apps_script.js');
const { makeStore } = require('./mog_fixture.js');

const BASE = 'c0b6dfb';
const STORES = Number(process.argv[2]) || 400;

const OLD_SRC = file => F.source(BASE, file);
const NEW_SRC = file => F.source(null, file);

const OLD_SCRIPT = F.compile(OLD_SRC, F.READERS_PLAN.concat([{
  file: 'apps-script/MOGApi.gs', consts: F.API_CONSTS,
  fns: F.API_FNS.concat(['vendorOnHandSnapshot_', 'vendorDayMultiplier_', 'computeSuggestedQty_'])
}]));
function compileNew(srcOf) {
  return F.compile(srcOf || NEW_SRC, F.READERS_PLAN.concat([{
    file: 'apps-script/MOGApi.gs', consts: F.API_CONSTS, fns: F.API_FNS.concat(['readVendorTabRoster_'])
  }]), ['apps-script/OrderMath.gs']);
}

function call(side, fn) {
  side.book.reads.calls = 0;
  side.book.reads.cells = 0;
  try {
    const value = fn(side.ctx);
    return { ok: true, value, reads: Object.assign({}, side.book.reads) };
  } catch (e) {
    return { ok: false, error: String(e && e.message), reads: Object.assign({}, side.book.reads) };
  }
}

// Run every store; return mismatches. newSrcOf lets a control plant a defect.
function runAll(newSrcOf, stores) {
  const newScript = compileNew(newSrcOf);
  const mismatches = [];
  const stats = { stores: 0, vendorCalls: 0, dashboards: 0, items: 0, throws: 0, orderOnly: 0, readsOld: 0, readsNew: 0 };
  const coverage = {};
  for (let seed = 1; seed <= stores; seed++) {
    const spec = makeStore(seed);
    for (const k of Object.keys(spec.coverage)) coverage[k] = (coverage[k] || 0) + spec.coverage[k];
    const oldSide = F.makeContext(spec);
    const newSide = F.makeContext(spec);
    OLD_SCRIPT.runInContext(oldSide.ctx);
    newScript.runInContext(newSide.ctx);
    stats.stores++;

    // Warm getVendorList's cache on BOTH sides, or the cold side pays one extra
    // read on its first lookup and the cell counts below diverge for no reason.
    const names = vm.runInContext('getVendorList()', oldSide.ctx).slice();
    vm.runInContext('getVendorList()', newSide.ctx);
    if (names.length) names.push(names[0].toLowerCase());   // normalizeVendorOrThrow_ canonicalizes
    names.push('No Such Vendor');                           // both must throw the same way

    const compare = (label, a, b) => {
      stats.readsOld += a.reads.cells;
      stats.readsNew += b.reads.cells;
      if (a.ok !== b.ok) {
        mismatches.push(`seed ${seed} ${label}: old ${a.ok ? 'returned' : 'threw ' + a.error}, new ${b.ok ? 'returned' : 'threw ' + b.error}`);
        return;
      }
      if (!a.ok) {
        stats.throws++;
        if (a.error !== b.error) mismatches.push(`seed ${seed} ${label}: error "${a.error}" vs "${b.error}"`);
        return;
      }
      const d = F.deepDiff(a.value, b.value);
      if (d) {
        // Separately: is it ONLY an order difference?
        const sortKey = v => JSON.stringify(v);
        const asSet = v => (v && v.items ? v.items : (v && v.vendors ? v.vendors : [])).map(sortKey).sort().join('\n');
        if (asSet(a.value) === asSet(b.value) && (a.value.items || a.value.vendors)) stats.orderOnly++;
        mismatches.push(`seed ${seed} ${label}: ${d}`);
      }
      if (a.reads.calls !== b.reads.calls || a.reads.cells !== b.reads.cells) {
        mismatches.push(`seed ${seed} ${label}: reads old ${a.reads.calls} calls/${a.reads.cells} cells, new ${b.reads.calls}/${b.reads.cells}`);
      }
    };

    for (const v of names) {
      stats.vendorCalls++;
      const a = call(oldSide, c => c.api_getVendorItems_({ vendor: v }));
      const b = call(newSide, c => c.api_getVendorItems_({ vendor: v }));
      if (a.ok && a.value.items) stats.items += a.value.items.length;
      compare(`getVendorItems(${JSON.stringify(v)})`, a, b);

      const oldCtx = F.BUILD_CTX.runInContext(oldSide.ctx);
      const newCtx = F.BUILD_CTX.runInContext(newSide.ctx);
      compare(`getVendorItems(${JSON.stringify(v)}, ctx)`,
        call(oldSide, c => c.api_getVendorItems_({ vendor: v }, oldCtx)),
        call(newSide, c => c.api_getVendorItems_({ vendor: v }, newCtx)));
    }
    stats.dashboards++;
    compare('getDashboard', call(oldSide, c => c.api_getDashboard_compute_()), call(newSide, c => c.api_getDashboard_compute_()));
  }
  return { mismatches, stats, coverage };
}

// ---------------------------------------------------------------------------
let failed = 0;
const main = runAll(null, STORES);
const s = main.stats;
console.log(`ordermath_equivalence: ${s.stores} stores, ${s.vendorCalls} vendor lookups x2 (with/without ctx), ` +
  `${s.dashboards} dashboards, ${s.items} items compared, ${s.throws} matching errors`);
console.log(`  cells read: old ${s.readsOld}, new ${s.readsNew}`);
console.log('  edge cases hit: ' + Object.keys(main.coverage).sort().map(k => `${k} x${main.coverage[k]}`).join(', '));
if (main.mismatches.length) {
  failed++;
  console.log(`FAIL  old and new differ in ${main.mismatches.length} place(s)` +
    (s.orderOnly ? ` (${s.orderOnly} of them order-only)` : '') + ':');
  for (const m of main.mismatches.slice(0, 15)) console.log('      ' + m);
} else {
  console.log('PASS  outputs identical, order identical, errors identical, cells read identical');
}

// Every edge case the generator exists for must actually have turned up,
// or a green run proves less than it claims.
const REQUIRED = ['Emergency Override on', 'non-numeric par', 'junk On Hand', 'duplicate item id in MASTER_ITEMS',
  'case-variant pick-path vendor', 'vendor with no tab', 'tab with no data rows', 'order logged this cycle',
  'per-vendor day pick', 'date typed into area order', 'padded item id in pick path'];
const missing = REQUIRED.filter(k => !main.coverage[k]);
if (missing.length) { failed++; console.log('FAIL  edge cases never generated: ' + missing.join(', ')); }
else console.log('PASS  every required edge case was generated at least once');

// ---- Controls: each planted defect must make the gate fail ----------------
const CONTROLS = [
  { name: 'targetPar loses its dayMult > 0 gate', file: 'apps-script/OrderMath.gs',
    find: 'const targetPar = (!isNaN(parNum) && dayMult > 0 && effectiveMult > 0)',
    replace: 'const targetPar = (!isNaN(parNum) && effectiveMult > 0)' },
  { name: 'a sent vendor stops counting backups as entered', file: 'apps-script/OrderMath.gs',
    find: 'enteredCount = itemCount + backupCount;', replace: 'enteredCount = itemCount;' },
  { name: 'junk On Hand counts as entered', file: 'apps-script/OrderMath.gs',
    find: "const entered   = (onHandRaw !== '' && onHandRaw !== null && !isNaN(Number(onHandRaw)));",
    replace: "const entered   = (onHandRaw !== '' && onHandRaw !== null);" },
  { name: 'count screen drops the SETUP cutoff', file: 'apps-script/MOGApi.gs',
    find: 'cutoff = cutoffMap.get(vendor) || null;', replace: 'cutoff = null;' },
  { name: 'roster ids not trimmed', file: 'apps-script/MOGApi.gs',
    find: "return { id: String(r[ID_IDX] || '').trim(), onHandRaw: r[0] };",
    replace: "return { id: String(r[ID_IDX] || ''), onHandRaw: r[0] };" }
];
for (const c of CONTROLS) {
  let result;
  try {
    const planted = F.plant(NEW_SRC(c.file), c.find, c.replace);
    result = runAll(file => (file === c.file ? planted : NEW_SRC(file)), Math.min(STORES, 200));
  } catch (e) {
    failed++;
    console.log(`FAIL  control "${c.name}" crashed instead of biting: ${e.message}`);
    continue;
  }
  if (result.mismatches.length) {
    console.log(`PASS  control "${c.name}" bites (${result.mismatches.length} differences)`);
  } else {
    failed++;
    console.log(`FAIL  control "${c.name}" did NOT bite: the gate can't see this defect`);
  }
}

console.log(failed ? `ordermath_equivalence: ${failed} FAILED` : 'ordermath_equivalence: ALL PASS');
process.exit(failed ? 1 : 0);
