'use strict';
// GATE: the phone's path (catalog JSON -> orderInputsFromSnapshot_ -> the
// shared builders) reproduces the server's answers, through Sync.gs's own
// supabaseParityReport_, the same report a store must pass live before it
// switches to Supabase.
//
// The vendor tabs here are BUILT by the documented column-M rule (pick-path
// rows whose vendor matches the tab, case-insensitive; empty when the day
// multiplier is 0). So this proves the plumbing: the catalog builder, the JSON
// trip, the input adapter, the parity report itself. It can NOT prove the
// documented rule matches the live formula; only test_supabaseParity on a
// real store can.
//
// Run bare: node tests/ordermath_phone_parity.test.js [stores]   (default 300)
// A passing run ends with "ordermath_phone_parity: ALL PASS".

const vm = require('vm');
const F = require('./fake_apps_script.js');
const { makeStore } = require('./mog_fixture.js');

const STORES = Number(process.argv[2]) || 300;
const NEW_SRC = file => F.source(null, file);

function compileNew(srcOf) {
  return F.compile(srcOf || NEW_SRC, F.READERS_PLAN.concat([
    { file: 'apps-script/MOGApi.gs', consts: F.API_CONSTS, fns: F.API_FNS.concat(['readVendorTabRoster_']) },
    { file: 'apps-script/Sync.gs', fns: ['buildCatalogPayload_', 'catalogPickRow_', 'supabaseParityReport_', 'syncDiff_', 'syncDiffAt_'] }
  ]), ['apps-script/OrderMath.gs']);
}

// Fill each vendor tab the way the live formulas would: rows 1-2 headers; one
// data row per roster entry (M = the pick row's raw item id, E = that item's
// count for this vendor); row 3 always has formula anchors, which is why a
// real tab's getLastRow() is >= 3 even when the spill is empty.
function buildTabs(spec, ctx, book, opts) {
  const r = spec.pickRnd;
  const pick = arr => arr[Math.floor(r() * arr.length)];
  const ON_HAND = [3, 0, 1.5, '', '', 'abc', '2', 7, 0.25, 4.2, 1];
  const info = vm.runInContext('(function () { var s = getSheet_(SHEET_SETUP); var a = getActiveOrderDate_(); ' +
    'return { vendors: getVendorList(), mults: readVendorMultipliers_(s), override: readEmergencyOverride_(), ' +
    'picks: readVendorOverrides_(s), dow: a.dayOfWeek, pickDb: readPickDb_(s) }; })()', ctx);
  const stats = { delivering: 0, rosterRows: 0 };
  for (const v of info.vendors) {
    const dayMult = ctx.vendorDayMultiplier_(info.mults, v, info.dow, info.override, info.picks);
    const ids = dayMult > 0
      ? info.pickDb.filter(row => String(row[0] === '' ? '' : row[0]).toLowerCase() === v.toLowerCase()).map(row => row[1])
      : [];
    if (dayMult > 0) stats.delivering++;
    const countFor = new Map();
    const tab = [['Store', v], ['Item', 'Pack', 'SKU', 'Par', 'On Hand', 'Order', '', 'Multiplier']];
    const rows = ids.length ? ids : [''];
    for (const rawId of rows) {
      const id = String(rawId || '').trim();
      if (!countFor.has(id)) countFor.set(id, id ? pick(ON_HAND) : '');   // one count per item, as the database keys it
      const row = [];
      row[2] = '<formula>';
      row[4] = countFor.get(id);
      row[12] = rawId;
      tab.push(row);
    }
    if (opts && opts.dropOneFrom === v && ids.length) tab.splice(2, 1);
    stats.rosterRows += ids.length;
    book.addSheet(v, tab);
  }
  return stats;
}

function runAll(srcOf, stores, opts) {
  const script = compileNew(srcOf);
  const failures = [];
  const totals = { stores: 0, vendors: 0, delivering: 0, rosterRows: 0, overrideOn: 0 };
  for (let seed = 1; seed <= stores; seed++) {
    const spec = makeStore(seed, { realistic: true, tabs: false });
    const side = F.makeContext(spec);
    script.runInContext(side.ctx);
    const vendorsNow = vm.runInContext('getVendorList()', side.ctx);
    const target = opts && opts.dropOne ? vendorsNow[0] : null;
    const st = buildTabs(spec, side.ctx, side.book, { dropOneFrom: target });
    let report;
    try {
      report = side.ctx.supabaseParityReport_();
    } catch (e) {
      failures.push(`seed ${seed}: parity report threw: ${e.message}`);
      continue;
    }
    totals.stores++;
    totals.vendors += report.vendors.length;
    totals.delivering += st.delivering;
    totals.rosterRows += st.rosterRows;
    if (report.emergencyOverride) totals.overrideOn++;
    if (!report.ok) {
      const bad = report.vendors.filter(v => !v.match).map(v => `${v.vendor}: ${v.diff}`);
      if (!report.dashboard.match) bad.push('dashboard: ' + report.dashboard.diff);
      failures.push(`seed ${seed}: ` + bad.join(' | '));
    }
  }
  return { failures, totals };
}

let failed = 0;
const main = runAll(null, STORES);
const t = main.totals;
console.log(`ordermath_phone_parity: ${t.stores} stores, ${t.vendors} vendors (${t.delivering} delivering), ` +
  `${t.rosterRows} roster rows, Emergency Override on in ${t.overrideOn}`);
if (main.failures.length) {
  failed++;
  console.log(`FAIL  phone and server differ in ${main.failures.length} store(s):`);
  for (const f of main.failures.slice(0, 10)) console.log('      ' + f);
} else {
  console.log('PASS  every store: phone == server for every vendor and the dashboard');
}
if (!t.overrideOn || !t.rosterRows || !t.delivering) {
  failed++;
  console.log('FAIL  fixtures never exercised override / delivering vendors / roster rows');
}

// ---- Controls --------------------------------------------------------------
const PLANTS = [
  { name: 'roster match becomes case-sensitive', file: 'apps-script/OrderMath.gs',
    find: 'if (k.toLowerCase() !== key) continue;', replace: 'if (k !== vendor) continue;' },
  { name: 'non-numeric par arrives as 0 instead of NaN', file: 'apps-script/OrderMath.gs',
    find: 'par:           (m.par === null || m.par === undefined) ? NaN : m.par,',
    replace: 'par:           (m.par === null || m.par === undefined) ? 0 : m.par,' },
  { name: 'catalog ships raw pick rows (a typed date breaks the sort)', file: 'apps-script/Sync.gs',
    find: 'pickRows:     readPickDb_(setup).map(catalogPickRow_),', replace: 'pickRows:     readPickDb_(setup),' },
  { name: 'phone ignores the Emergency Override day picks', file: 'apps-script/OrderMath.gs',
    find: 'if (!isNaN(m) && m > 0) vendorOverrides.set(v, m);', replace: 'if (false) vendorOverrides.set(v, m);' }
];
for (const c of PLANTS) {
  let res;
  try {
    const planted = F.plant(NEW_SRC(c.file), c.find, c.replace);
    res = runAll(file => (file === c.file ? planted : NEW_SRC(file)), STORES);
  } catch (e) {
    failed++;
    console.log(`FAIL  control "${c.name}" crashed instead of biting: ${e.message}`);
    continue;
  }
  if (res.failures.length) console.log(`PASS  control "${c.name}" bites (${res.failures.length} stores flagged)`);
  else { failed++; console.log(`FAIL  control "${c.name}" did NOT bite`); }
}
// A tab that disagrees with the pick path must be caught: that is exactly what
// the live parity test exists to find.
const drop = runAll(null, STORES, { dropOne: true });
if (drop.failures.length) console.log(`PASS  control "a vendor tab missing one roster row" bites (${drop.failures.length} stores flagged)`);
else { failed++; console.log('FAIL  control "a vendor tab missing one roster row" did NOT bite'); }

console.log(failed ? `ordermath_phone_parity: ${failed} FAILED` : 'ordermath_phone_parity: ALL PASS');
process.exit(failed ? 1 : 0);
