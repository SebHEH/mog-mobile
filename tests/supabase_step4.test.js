'use strict';
// GATE: step 4 (docs/MOG_SupabaseMigration.md). A store that counts in
// Supabase must give the SAME answers as the Sheet, and closing its cycle must
// log exactly what the Sheet reset would, without touching the Sheet except the
// nightly LOG_ORDERS backup.
//
// Each randomized store is built twice from the same spec:
//   SHEET: not connected; the code as it ran before step 4.
//   DB:    connected + switched to a fake Supabase (fake_supabase.js), seeded
//          by the real connect/switch code (pushCatalogNow_,
//          setDbStateFromSheet_, importSheetCountsToDb_).
// Vendor tabs follow the documented column-M rule (as in the phone-parity
// gate), because only then can the two sides agree.
// Both are driven through the real doPost, and every count-path answer must
// match: reads, then each write (override on, a day pick, a bad pick, a count
// save, override off) followed by more reads. Then:
//   - the cycle close (closeCycleInDb_) logs the rows buildOrderCycleSnapshot_
//     would, writes nothing to the Sheet but LOG_ORDERS, and won't close twice
//   - Supabase unreachable: the close throws and changes nothing
//   - a store that isn't connected never calls Supabase
//   - webedit_call's envelope and the background-push queue behave
// Every check has a planted-defect control.
//
// Run bare: node tests/supabase_step4.test.js [stores]   (default 150)
// A passing run ends with "supabase_step4: ALL PASS".

const vm = require('vm');
const F = require('./fake_apps_script.js');
const { makeStore } = require('./mog_fixture.js');
const { FakeSupabase, fakeScriptApp, fakeContentService, compileStep4 } = require('./fake_supabase.js');

const STORES = Number(process.argv[2]) || 150;
const SRC = file => F.source(null, file);
const PIN = '1111';
const SLUG = 'zztest';

// The plan lives in fake_supabase.js, shared with supabase_move.test.js.
const compile = srcOf => compileStep4(srcOf || SRC);

// What Apps Script resets at the start of every execution.
const NEW_EXECUTION = new vm.Script(
  '_SB_CONFIG_ = null; _SB_SNAPSHOT_ = null; MOG_MUTATED_ = false; MOG_SKIP_CATALOG_QUEUE_ = false; _SHEET_CACHE_.clear();');

function makeSide(spec, script, sb, opts) {
  const props = Object.assign({}, spec.scriptProps, { MOG_API_PIN: PIN });
  if (opts.connected) Object.assign(props, { MOG_SUPABASE_SLUG: SLUG, MOG_SUPABASE_SYNC_KEY: opts.key });
  const scriptApp = fakeScriptApp();
  const emails = [];
  const side = F.makeContext(Object.assign({}, spec, { scriptProps: props }), {
    UrlFetchApp: sb.urlFetchApp(),
    ScriptApp: scriptApp,
    ContentService: fakeContentService,
    readRecipients_: () => [{ name: 'GM', email: 'gm@example.com', active: true }],
    sendRecapEmail_: (to, sections, cycleDate, total) => { emails.push({ to, sections, cycleDate, total }); },
    requireEditorToken_: () => true
  }, { advancingClock: true });
  script.runInContext(side.ctx);
  attachSpill(side);
  side.scriptApp = scriptApp;
  side.emails = emails;
  side.exec = fn => { NEW_EXECUTION.runInContext(side.ctx); return fn(side.ctx); };
  side.post = (action, payload) => side.exec(c => JSON.parse(
    c.doPost({ postData: { contents: JSON.stringify({ pin: PIN, action, payload: payload || {} }) } }).getContent()));
  return side;
}

// A vendor tab's column M is a live formula: re-spill it on every read from the
// side's CURRENT pick path, multipliers, Emergency Override and day picks.
// Column E stays where it is, by row, exactly like the real Sheet.
const SPILL_INFO = new vm.Script('(function () { var s = getSheet_(SHEET_SETUP); var a = getActiveOrderDate_(); ' +
  'return { vendors: getVendorList_compute_(), mults: readVendorMultipliers_(s), override: readEmergencyOverride_(), ' +
  'picks: readVendorOverrides_(s), dow: a.dayOfWeek, pickDb: readPickDb_(s) }; })()');
function attachSpill(side) {
  let busy = false;
  for (const [name, sheet] of side.book.sheets) {
    if (!sheet.rows[1] || sheet.rows[1][0] !== 'Item') continue;   // vendor tabs only
    sheet.onRead = () => {
      if (busy) return;
      busy = true;
      try {
        const info = SPILL_INFO.runInContext(side.ctx);
        const dayMult = side.ctx.vendorDayMultiplier_(info.mults, name, info.dow, info.override, info.picks);
        const ids = dayMult > 0
          ? info.pickDb.filter(r => String(r[0]).toLowerCase() === name.toLowerCase()).map(r => r[1])
          : [];
        const n = Math.max(ids.length, 1, sheet.rows.length - 2);
        for (let i = 0; i < n; i++) {
          const row = sheet.rows[2 + i] || (sheet.rows[2 + i] = []);
          row[12] = i < ids.length ? ids[i] : '';
          if (i === 0) row[2] = '<formula>';
        }
      } finally {
        busy = false;
      }
    };
  }
}

// One pick-path row per vendor + item. A duplicate is where the Sheet and
// Supabase INTENTIONALLY differ: the Sheet kept a separate On Hand per row (and
// the app could only ever write the last one); Supabase keeps one count per
// item. Design record section 9 records it; this gate compares everything else.
function dedupePickPath(spec) {
  const seen = new Set();
  const setup = spec.sheets.SETUP;
  for (let i = 1; i < setup.length; i++) {
    const r = setup[i];
    if (!r || r[11] === undefined || String(r[11]).trim() === '') continue;
    const key = String(r[10] === undefined ? '' : r[10]).toLowerCase() + '' + String(r[11]).trim();
    if (seen.has(key)) { for (let c = 10; c <= 15; c++) r[c] = ''; }
    else seen.add(key);
  }
}

// Vendor tabs as the live formulas would spill them (rows 1-2 headers; row 3
// always has formula anchors; one row per pick-path match; empty when H2=0).
function fillTabs(spec, script) {
  const tmp = F.makeContext(spec, {});
  script.runInContext(tmp.ctx);
  const info = vm.runInContext('(function () { var s = getSheet_(SHEET_SETUP); var a = getActiveOrderDate_(); ' +
    'return { vendors: getVendorList(), mults: readVendorMultipliers_(s), override: readEmergencyOverride_(), ' +
    'picks: readVendorOverrides_(s), dow: a.dayOfWeek, pickDb: readPickDb_(s) }; })()', tmp.ctx);
  const r = spec.pickRnd;
  const ON_HAND = [3, 0, 1.5, '', '', 'abc', '2', 7, 0.25, 4.2, 1];
  for (const v of info.vendors) {
    const dayMult = tmp.ctx.vendorDayMultiplier_(info.mults, v, info.dow, info.override, info.picks);
    const ids = dayMult > 0
      ? info.pickDb.filter(row => String(row[0] === '' ? '' : row[0]).toLowerCase() === v.toLowerCase()).map(row => row[1])
      : [];
    const countFor = new Map();
    const tab = [['Store', v], ['Item', 'Pack', 'SKU', 'Par', 'On Hand', 'Order', '', 'Multiplier']];
    for (const rawId of (ids.length ? ids : [''])) {
      const id = String(rawId || '').trim();
      if (!countFor.has(id)) countFor.set(id, id ? ON_HAND[Math.floor(r() * ON_HAND.length)] : '');
      const row = [];
      row[2] = '<formula>';
      row[4] = countFor.get(id);
      row[12] = rawId;
      tab.push(row);
    }
    spec.sheets[v] = tab;
  }
  return info.vendors;
}

function runSuite(srcOf, stores) {
  const script = compile(srcOf);
  const failures = [];
  const stats = { stores: 0, compared: 0, closes: 0, loggedRows: 0, mutations: 0, sameDay: 0 };
  const fail = (seed, what) => failures.push('seed ' + seed + ': ' + what);

  for (let seed = 1; seed <= stores; seed++) {
    const spec = makeStore(seed, { realistic: true, tabs: false });
    dedupePickPath(spec);
    const vendors = fillTabs(spec, script);
    const sb = new FakeSupabase(spec.now);
    const key = sb.provision(SLUG);
    const sheet = makeSide(spec, script, sb, { connected: false });
    const db = makeSide(spec, script, sb, { connected: true, key });
    stats.stores++;

    try {
      // Seed Supabase the way Connect + Switch do, then switch.
      db.exec(c => { c.pushCatalogNow_(); c.setDbStateFromSheet_(); c.importSheetCountsToDb_(); });
      db.scriptProps.set('MOG_BACKEND', 'supabase');

      const same = (label, a, b) => {
        stats.compared++;
        const d = F.deepDiff(a, b);
        if (d) fail(seed, label + ': ' + d);
      };
      const reads = tag => {
        same(tag + ' getDashboard', sheet.post('getDashboard'), db.post('getDashboard'));
        const names = vendors.concat(vendors.length ? [vendors[0].toLowerCase()] : [], ['No Such Vendor']);
        for (const v of names) same(tag + ' getVendorItems(' + v + ')', sheet.post('getVendorItems', { vendor: v }), db.post('getVendorItems', { vendor: v }));
        same(tag + ' getVendorItemsBulk', sheet.post('getVendorItemsBulk', { vendors: vendors.concat(['Nope']) }),
                                          db.post('getVendorItemsBulk', { vendors: vendors.concat(['Nope']) }));
        same(tag + ' getRecapData', sheet.post('getRecapData'), db.post('getRecapData'));
        if (vendors.length) same(tag + ' getRecapData(one)', sheet.post('getRecapData', { vendors: [vendors[0]] }),
                                                            db.post('getRecapData', { vendors: [vendors[0]] }));
      };

      reads('start');
      const ae9 = spec.sheets.ORDER_ENTRY[8] && spec.sheets.ORDER_ENTRY[8][30];
      if (ae9 && ae9.__date) same('getResetStatus', sheet.post('getResetStatus'), db.post('getResetStatus'));

      // Writes, on both sides, each followed by the reads.
      const step = (label, action, payload) => {
        stats.mutations++;
        same(label, sheet.post(action, payload), db.post(action, payload));
        reads('after ' + label);
      };
      step('override on', 'setEmergencyOverride', { on: true });
      if (vendors.length) {
        step('day pick', 'setVendorOverride', { vendor: vendors[0], mult: 3 });
        same('bad day pick', sheet.post('setVendorOverride', { vendor: vendors[0], mult: 9 }),
                             db.post('setVendorOverride', { vendor: vendors[0], mult: 9 }));
        const items = (sheet.post('getVendorItems', { vendor: vendors[0] }).data || { items: [] }).items;
        if (items.length) {
          const save = items.slice(0, 4).map((it, i) => ({ id: it.id, onHand: [2, 0.5, '', 5][i] }));
          stats.mutations++;
          sheet.post('saveOnHand', { vendor: vendors[0], items: save });
          db.post('saveOnHand', { vendor: vendors[0], items: save });
          reads('after count save');
        }
      }
      step('override off', 'setEmergencyOverride', { on: false });

      // ---- The cycle close ------------------------------------------------
      const orderDate = sheet.exec(c => c.getLogOrderDate_());
      const sheetRows = sheet.exec(c => c.buildOrderCycleSnapshot_(orderDate, new c.Date()).rows)
        .map(r => [r[1], r[2], r[3], r[4], r[5], r[6]]);
      const expectedRecap = db.exec(c => c.recapSectionsFromInputs_(c.orderInputsFromSnapshot_(c.supabaseSnapshot_(true)), null));
      const dbRows = db.exec(c => c.orderLogRowsFromInputs_(c.orderInputsFromSnapshot_(c.supabaseSnapshot_(true))));
      same('close: rows logged (vs the Sheet reset)', sheetRows,
           dbRows.map(r => [orderDate, r.vendor, r.id, r.name, r.onHandPrev, r.qty]));

      // Supabase unreachable: throws, changes nothing.
      const store = sb.stores.get(SLUG);
      const before = JSON.stringify({ state: store.state, log: store.log });
      db.book.writes.length = 0;
      sb.down = true;
      let threw = false;
      try { db.exec(c => c.closeCycleInDb_({ sameDay: true })); } catch (e) { threw = true; }
      sb.down = false;
      if (!threw) fail(seed, 'close with Supabase down did not throw');
      if (db.book.writes.length) fail(seed, 'close with Supabase down wrote to the Sheet');
      if (JSON.stringify({ state: store.state, log: store.log }) !== before) fail(seed, 'close with Supabase down changed Supabase');

      const today = sb.today();
      const closing = store.state.cycleDate;
      db.book.writes.length = 0;
      let res = db.exec(c => c.closeCycleInDb_());
      if (closing === today) {
        if (res.skippedReason == null) fail(seed, 'a cycle already on today was closed without sameDay');
        res = db.exec(c => c.closeCycleInDb_({ sameDay: true }));
        stats.sameDay++;
      }
      stats.closes++;
      const logged = store.log.filter(r => r.cycleDate === closing);
      stats.loggedRows += logged.length;
      same('close: Supabase log rows', dbRows.map(r => [r.vendor, r.id, r.name, r.pack, r.area, r.onHandPrev, r.qty]),
           logged.map(r => [r.vendor, r.id, r.name, r.pack, r.area, r.onHandPrev, r.qty]));
      if (res.rowsLogged !== logged.length) fail(seed, 'close: rowsLogged ' + res.rowsLogged + ' vs ' + logged.length);
      if (store.state.cycleDate !== today || store.state.emergencyOverride || Object.keys(store.state.vendorPicks).length) {
        fail(seed, 'close: new cycle not clean: ' + JSON.stringify(store.state));
      }
      const otherWrites = db.book.writes.filter(w => w.sheet !== 'LOG_ORDERS');
      if (otherWrites.length) fail(seed, 'close wrote outside LOG_ORDERS: ' + JSON.stringify(otherWrites[0]));
      const logSheet = db.book.sheets.get('LOG_ORDERS').rows;
      const backup = logSheet.filter(r => r && r[1] === closing).map(r => [r[1], r[2], r[3], r[4], r[5], r[6]]);
      same('close: LOG_ORDERS backup', dbRows.map(r => [closing, r.vendor, r.id, r.name, r.onHandPrev, r.qty]), backup);
      const pending = db.docProps.get('MOG_PENDING_RECAP') || db.scriptProps.get('MOG_PENDING_RECAP');
      if (!pending || JSON.parse(pending).cycleDate !== closing) fail(seed, 'close: recap not scheduled for ' + closing);
      if (!db.scriptApp.triggers.some(t => t.getHandlerFunction() === 'sendPendingRecap_')) fail(seed, 'close: no recap trigger');
      same('recap email (from the Supabase log) vs the full order list at close',
           db.exec(c => c.buildRecapFromLog_(closing)).sections, expectedRecap.sections);

      // A second close changes nothing.
      const after = JSON.stringify(store.log);
      db.book.writes.length = 0;
      const again = db.exec(c => c.closeCycleInDb_());
      if (!again.skippedReason || JSON.stringify(store.log) !== after || db.book.writes.length) {
        fail(seed, 'a second close did something: ' + JSON.stringify(again));
      }
    } catch (e) {
      fail(seed, 'crashed: ' + (e.stack || e).split('\n').slice(0, 3).join(' | '));
    }

    // Isolation check: run the SHEET side's whole flow again with a fresh
    // fake and count its calls.
    if (seed <= 20) {
      const sb2 = new FakeSupabase(spec.now);
      const lone = makeSide(spec, script, sb2, { connected: false });
      lone.post('getDashboard');
      if (vendors.length) lone.post('setVendorOverride', { vendor: vendors[0], mult: 2 });
      lone.post('setEmergencyOverride', { on: true });
      lone.exec(c => c.bumpServerMutationTs_());
      if (sb2.calls.length) fail(seed, 'a store that is not connected called Supabase: ' + sb2.calls.join(','));
      if (lone.scriptApp.triggers.length) fail(seed, 'a store that is not connected queued a trigger');
    }
  }

  // ---- webedit_call envelope + the background-push queue --------------------
  const spec = makeStore(7, { realistic: true });
  for (const connected of [true, false]) {
    const sb = new FakeSupabase(spec.now);
    const side = makeSide(spec, script, sb, { connected, key: sb.provision(SLUG) });
    side.ctx.webeditDispatch_ = name => ({
      commitX: () => { side.ctx.bumpServerMutationTs_(); return 'saved'; },
      getX:    () => 'read'
    })[name] || null;
    const w = side.exec(c => c.webedit_call('tok', 'commitX', [], { envelope: 1 }));
    const r = side.exec(c => c.webedit_call('tok', 'getX', [], { envelope: 1 }));
    const legacy = side.exec(c => c.webedit_call('tok', 'commitX', []));
    if (legacy !== 'saved') failures.push('a page from before the deploy (no envelope asked) got ' + JSON.stringify(legacy));
    const tag = connected ? 'connected' : 'not connected';
    if (!w || w.__mogEnvelope !== 1 || w.result !== 'saved') failures.push(tag + ': webedit_call envelope broken: ' + JSON.stringify(w));
    if (w.pushCatalog !== connected) failures.push(tag + ': a save reported pushCatalog=' + w.pushCatalog);
    if (r.pushCatalog !== false || r.result !== 'read') failures.push(tag + ': a read reported pushCatalog=' + r.pushCatalog);
    if (side.scriptApp.triggers.length) failures.push(tag + ': webedit_call queued a background push (the page pushes itself)');

    // A Sheet-dialog edit (no doPost / webedit_call around it).
    side.exec(c => c.bumpServerMutationTs_());
    side.exec(c => c.bumpServerMutationTs_());
    const queued = side.scriptApp.triggers.filter(t => t.getHandlerFunction() === 'catalogPushTrigger_').length;
    if (queued !== (connected ? 1 : 0)) failures.push(tag + ': two Sheet-dialog edits queued ' + queued + ' background pushes');
    if (connected) {
      sb.stores.get(SLUG).state = null;   // the push doesn't need state
      side.exec(c => c.catalogPushTrigger_());
      if (!sb.calls.includes('mog_sync_push_catalog')) failures.push('the queued push never pushed');
      if (side.scriptApp.triggers.length) failures.push('the queued push left its trigger behind');
      if (side.docProps.has('MOG_CATALOG_PUSH_QUEUED')) failures.push('the queued push left its flag behind');
    }
  }
  return { failures, stats };
}

// ---------------------------------------------------------------------------
let failed = 0;
const main = runSuite(null, STORES);
const s = main.stats;
console.log(`supabase_step4: ${s.stores} stores, ${s.compared} answers compared, ${s.mutations} writes, ` +
  `${s.closes} cycle closes (${s.sameDay} same-day), ${s.loggedRows} log rows`);
if (main.failures.length) {
  failed++;
  console.log(`FAIL  ${main.failures.length} problem(s):`);
  for (const f of main.failures.slice(0, 15)) console.log('      ' + f);
} else {
  console.log('PASS  Supabase answers == Sheet answers; the close logs what the Sheet would, touches only LOG_ORDERS, never twice');
}
if (!s.loggedRows || !s.sameDay || !s.mutations) { failed++; console.log('FAIL  fixtures never exercised logging / same-day close / writes'); }

const CONTROLS = [
  { name: 'cycle-close rows in reverse vendor order', file: 'apps-script/OrderMath.gs',
    find: '  for (const vendor of inputs.vendorList) {\r\n    const result = vendorItemsFromSnapshot_(inputs, vendor);\r\n    for (const it of result.items) {',
    replace: '  for (const vendor of inputs.vendorList.slice().reverse()) {\r\n    const result = vendorItemsFromSnapshot_(inputs, vendor);\r\n    for (const it of result.items) {' },
  { name: 'a cycle already on today closes again', file: 'apps-script/Sync.gs',
    find: "if (closing > today || (closing === today && !opts.sameDay)) {",
    replace: "if (closing > today || (closing === today && false)) {" },
  { name: 'reset status never stale', file: 'apps-script/DbApi.gs',
    find: 'return { today: st.today, lastReset: st.cycleDate, isStale: st.isStale };',
    replace: 'return { today: st.today, lastReset: st.cycleDate, isStale: false };' },
  { name: 'day-pick validation skipped', file: 'apps-script/DbApi.gs',
    find: "  if (isNaN(mult) || mult < 0 || mult > 7) {\r\n    throw new Error('Invalid override multiplier (expected 0-7): ' + (payload && payload.mult));\r\n  }\r\n  const snap = supabaseSync_('mog_sync_set_vendor_pick'",
    replace: "  const snap = supabaseSync_('mog_sync_set_vendor_pick'" },
  { name: 'count saves keyed under the wrong vendor', file: 'apps-script/DbApi.gs',
    find: "return { vendor: vendor, id: String(it.id || '').trim(), onHand: (v === null || isNaN(v)) ? null : v };",
    replace: "return { vendor: vendor.toLowerCase(), id: String(it.id || '').trim(), onHand: (v === null || isNaN(v)) ? null : v };" },
  { name: 'the background-push queue ignores the skip flag', file: 'apps-script/Core.gs',
    find: '  if (!MOG_SKIP_CATALOG_QUEUE_) {', replace: '  if (true) {' },
  { name: 'webedit_call always says "push"', file: 'apps-script/Editor.gs',
    find: "pushCatalog:   MOG_MUTATED_ && fnName !== 'pushCatalogNow' && supabaseConfig_().connected",
    replace: "pushCatalog:   true && fnName !== 'pushCatalogNow' && supabaseConfig_().connected" },
  { name: 'the envelope sent to pages that never asked for it', file: 'apps-script/Editor.gs',
    find: '  if (!(opts && opts.envelope)) return result;', replace: '' },
  { name: 'LOG_ORDERS backup columns swapped', file: 'apps-script/Sync.gs',
    find: 'return [timestamp, orderDate, r.vendor, r.id, r.name, r.onHandPrev, r.qty];',
    replace: 'return [timestamp, orderDate, r.id, r.vendor, r.name, r.onHandPrev, r.qty];' }
];
for (const c of CONTROLS) {
  let res;
  try {
    const planted = F.plant(SRC(c.file), c.find, c.replace);
    res = runSuite(file => (file === c.file ? planted : SRC(file)), Math.min(STORES, 60));
  } catch (e) {
    failed++;
    console.log(`FAIL  control "${c.name}" crashed instead of biting: ${e.message}`);
    continue;
  }
  const crashes = res.failures.filter(f => /crashed/.test(f)).length;
  if (res.failures.length && crashes < res.failures.length) console.log(`PASS  control "${c.name}" bites (${res.failures.length} problems)`);
  else if (crashes) { failed++; console.log(`FAIL  control "${c.name}" only crashed: ${res.failures[0]}`); }
  else { failed++; console.log(`FAIL  control "${c.name}" did NOT bite`); }
}

console.log(failed ? `supabase_step4: ${failed} FAILED` : 'supabase_step4: ALL PASS');
process.exit(failed ? 1 : 0);
