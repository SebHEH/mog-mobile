'use strict';
// GATE: the Store Health Check in the app (docs/MOG_OneApp_Spec.md T4):
// catalogEdit.js getStoreHealthReport over the catalog tables and
// mog_editor_status, its one-click fixes, and host.js answering the page's
// two calls (getStoreHealthReport, runHealthFix) against the fake Supabase
// (schema_v9.sql's status and lockout calls; the SQL is pinned by
// supabase/tests/smoke_v9.sql).
//   - a healthy store: every row passes, in a fixed order, in Health.gs's
//     report shape
//   - each catalog problem turns exactly its own row to a warning, naming
//     what's wrong; an inactive item never counts
//   - the store's rows: phones not on Supabase, last night's close missed
//     (only after 4 AM), no cycle at all, a PIN lockout
//   - "Place backups": adds exactly the missing rows, in the item's own area
//     at the end, logged and undoable through the host; a second run adds
//     nothing; "Clear lockout" clears it
// Planted-defect controls in catalogEdit.js and host.js must each be caught.
//
// Run bare: node tests/health_app.test.js   A pass ends "health_app: ALL PASS".

const vm = require('vm');
const F = require('./fake_apps_script.js');
const { FakeSupabase, checkCatalogTables } = require('./fake_supabase.js');

const SRC = file => F.source(null, file);
const clone = x => JSON.parse(JSON.stringify(x));
const IDS = ['phones', 'nightly', 'lockout', 'vendors_days', 'items_area', 'items_par', 'items_primary', 'backups_placed', 'item_names'];

function healthy() {
  return {
    vendors: [{ name: 'Amazon', mults: [1, 0, 0, 0, 0, 0, 0], cutoff: null },
              { name: 'Sysco', mults: [1, 0, 1, 0, 1, 0, 0], cutoff: '10:00' }],
    areas: [{ name: 'Walk-in', ord: 10 }, { name: 'Dry Storage', ord: 20 }],
    items: [
      { id: 'ITEM-0001', name: 'Lime', primaryVendor: 'Sysco', pack: 'CS', par: 3, active: true, useMult: true, notes: '', sku: '', category: '', eligible: ['Sysco', 'Amazon'], seq: 2 },
      { id: 'ITEM-0002', name: 'Tape', primaryVendor: 'Amazon', pack: 'EA', par: 1, active: true, useMult: false, notes: '', sku: '', category: '', eligible: ['Amazon'], seq: 3 },
      { id: 'ITEM-0003', name: 'Nori', primaryVendor: null, pack: 'BAG', par: null, active: false, useMult: true, notes: '', sku: '', category: '', eligible: [], seq: 4 }
    ],
    pickRows: [
      { vendor: 'Sysco', id: 'ITEM-0001', area: 'Walk-in', shelfOrder: 10, seq: 2 },
      { vendor: 'Amazon', id: 'ITEM-0001', area: 'Walk-in', shelfOrder: 10, seq: 3 },
      { vendor: 'Amazon', id: 'ITEM-0002', area: 'Dry Storage', shelfOrder: 10, seq: 4 }
    ]
  };
}
const GOOD = { phoneDirect: true, timeZone: 'America/New_York', localNow: '2026-10-19 15:30', cycleDate: '2026-10-19', lockedForMs: 0, failCount: 0 };

function loadCE(srcOf) {
  const ctx = { console };
  vm.createContext(ctx);
  vm.runInContext(srcOf('template/editor/catalogEdit.js'), ctx);
  return ctx.CatalogEdit;
}

function makeTab(sb, srcOf) {
  const store = new Map();
  const ctx = {
    console, setTimeout, clearTimeout, AbortController, URLSearchParams, fetch: sb.fetchFn(),
    localStorage: { getItem: k => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: k => store.delete(k) },
    location: { search: '', hash: '', href: '', reload() {}, replace() {} },
    document: { body: null, head: null, getElementById: () => null }
  };
  ctx.window = ctx;
  ctx.MOG_SUPABASE = { url: 'https://fake.supabase.co', key: 'pub', slug: 'zzhealth' };
  ctx.MOG_EDITOR_PAGE = 'healthcheck';
  vm.createContext(ctx);
  vm.runInContext(srcOf('apps-script/OrderMath.gs'), ctx);
  vm.runInContext(srcOf('template/editor/catalogEdit.js'), ctx);
  vm.runInContext(srcOf('template/editor/host.js'), ctx);
  const rpc = (name, ...args) => new Promise((resolve, reject) =>
    ctx.google.script.run.withSuccessHandler(resolve).withFailureHandler(reject)[name](...args));
  return { signIn: async () => (await rpc('editorAuth', '4321')).token,
           tool: async (token, fn, ...args) => (await rpc('webedit_call', token, fn, args, { envelope: 1 })).result };
}

async function runSuite(srcOf) {
  srcOf = srcOf || SRC;
  const CE = loadCE(srcOf);
  const failures = [];
  const fail = (scenario, what) => failures.push('[' + scenario + ']: ' + what);
  const report = (t, st) => CE.call(t, 'getStoreHealthReport', [st || GOOD, 'Test Store']).result;
  const row = (rep, id) => rep.checks.find(c => c.id === id) || {};
  const onlyWarn = (scenario, t, id, mustSay) => {
    const rep = report(t);
    const off = rep.checks.filter(c => c.status !== 'pass').map(c => c.id);
    if (off.join() !== id) fail(scenario, 'expected only ' + id + ' to warn, got ' + JSON.stringify(off));
    else if (mustSay && row(rep, id).detail.indexOf(mustSay) < 0) fail(scenario, id + ' does not name "' + mustSay + '": ' + row(rep, id).detail);
  };

  // ---- A healthy store ----
  {
    const rep = report(healthy());
    if (rep.checks.map(c => c.id).join() !== IDS.join()) fail('healthy', 'rows: ' + rep.checks.map(c => c.id).join());
    if (rep.checks.some(c => c.status !== 'pass')) fail('healthy', 'not all pass: ' + JSON.stringify(rep.checks.filter(c => c.status !== 'pass')));
    if (JSON.stringify(rep.summary) !== JSON.stringify({ pass: 9, warn: 0, fail: 0 })) fail('healthy', 'summary ' + JSON.stringify(rep.summary));
    if (rep.generatedAt !== 'Oct 19, 2026 3:30 PM' || rep.store !== 'Test Store') fail('healthy', 'header ' + rep.generatedAt + ' / ' + rep.store);
    if (rep.checks.some(c => c.destructive)) fail('healthy', 'a fix marked destructive');
  }

  // ---- Each catalog problem: its own row only ----
  {
    let t = healthy(); t.vendors[0].mults = [0, 0, 0, 0, 0, 0, 0];
    onlyWarn('catalog', t, 'vendors_days', 'Amazon');
    t = healthy(); t.pickRows = t.pickRows.filter(r => r.id !== 'ITEM-0002');
    onlyWarn('catalog', t, 'items_area', 'Tape');
    t = healthy(); t.items[1].par = null;
    onlyWarn('catalog', t, 'items_par', 'Tape');
    t = healthy(); t.items[1].primaryVendor = null;
    onlyWarn('catalog', t, 'items_primary', 'Tape');
    t = healthy(); t.items[1].eligible = ['Amazon', 'sysco'];
    onlyWarn('catalog', t, 'backups_placed', 'Tape (Sysco)');
    t = healthy(); t.items[1].name = 'LIME';
    onlyWarn('catalog', t, 'item_names', 'Lime (2)');
    t = healthy(); t.items[2].eligible = ['Sysco']; t.items[2].name = 'lime';   // inactive: never counts
    onlyWarn('catalog', t, '', null);
    t = healthy(); t.items[1].eligible = ['Amazon', 'Nobody'];   // a vendor not listed: nothing to place
    onlyWarn('catalog', t, '', null);
  }

  // ---- The Overview's numbers (docs/MOG_OneApp_Spec.md U4, U9): the rows' own rules ----
  {
    const counts = (t, changes) => CE.call(t, 'getOverviewCounts', [changes || []]).result;
    let c = counts(healthy());
    if (c.items !== 2 || c.inactive !== 1 || c.vendors.join() !== 'Amazon,Sysco' || c.vendorsNoDays.length ||
        c.areas.join() !== 'Walk-in,Dry Storage' || c.itemsNoArea || c.itemsNoPar || c.shelfSaved) fail('overview', 'a healthy store: ' + JSON.stringify(c));
    const t = healthy();
    t.vendors[0].mults = [0, 0, 0, 0, 0, 0, 0];
    t.pickRows = t.pickRows.filter(r => r.id !== 'ITEM-0002');
    t.items[0].par = null;
    c = counts(t);
    if (c.vendorsNoDays.join() !== 'Amazon' || c.itemsNoArea !== 1 || c.itemsNoPar !== 1) fail('overview', 'a store with gaps: ' + JSON.stringify(c));
    // Shelf to Sheet is done once a save of it (its real change label) is in the log, not undone.
    const save = CE.call(healthy(), 'commitReorderPickPath', ['Amazon', [{ id: 'ITEM-0002', area: 'Dry Storage' }, { id: 'ITEM-0001', area: 'Walk-in' }]]);
    if (!save.label) fail('overview', 'the Shelf to Sheet save has no label');
    const log = [{ id: 1, label: 'Edited "Lime": par 3 → 5' }, { id: 2, label: save.label }];
    if (!counts(healthy(), log).shelfSaved) fail('overview', 'a Shelf to Sheet save ("' + save.label + '") did not count');
    if (counts(healthy(), [log[0]]).shelfSaved) fail('overview', 'another change counted as a Shelf to Sheet save');
    if (counts(healthy(), [Object.assign({}, log[1], { undoneBy: 3 })]).shelfSaved) fail('overview', 'an undone Shelf to Sheet save counted');
  }

  // ---- The store's rows ----
  {
    const t = healthy();
    const st = (over, id, want, say) => {
      const r = row(report(t, Object.assign({}, GOOD, over)), id);
      if (r.status !== want) fail('store', id + ' with ' + JSON.stringify(over) + ' is ' + r.status + ', expected ' + want);
      else if (say && r.detail.indexOf(say) < 0) fail('store', id + ' does not say "' + say + '": ' + r.detail);
      return r;
    };
    st({ phoneDirect: false }, 'phones', 'warn');
    st({ cycleDate: '2026-10-18', localNow: '2026-10-19 09:00' }, 'nightly', 'fail', 'still 2026-10-18');
    st({ cycleDate: '2026-10-18', localNow: '2026-10-19 02:10' }, 'nightly', 'pass');
    st({ cycleDate: null }, 'nightly', 'fail', 'no cycle');
    const lock = st({ lockedForMs: 90000 }, 'lockout', 'warn', '2 more minutes');
    if (lock.fixId !== 'clear_lockout') fail('store', 'the lockout row has no fix');
  }

  // ---- Place backups ----
  {
    const t = healthy();
    t.items[1].eligible = ['Amazon', 'Sysco'];
    t.items[0].eligible = ['Sysco', 'Amazon'];
    t.pickRows.push({ vendor: 'Sysco', id: 'X', area: 'Dry Storage', shelfOrder: 40, seq: 9 });   // Sysco's last row in Dry Storage
    const tt = clone(t); tt.items.push({ id: 'X', name: 'Cups', primaryVendor: 'Sysco', pack: '', par: 1, active: true, useMult: true, notes: '', sku: '', category: '', eligible: ['Sysco'], seq: 9 });
    const out = CE.call(tt, 'commitPlaceBackupVendors', []);
    const added = out.ops.filter(o => o.t === 'pickRows' && !o.before).map(o => o.after);
    if (out.result.placed !== 1 || added.length !== 1 || added[0].vendor !== 'Sysco' || added[0].id !== 'ITEM-0002'
        || added[0].area !== 'Dry Storage' || added[0].shelfOrder !== 50) {
      fail('fix', 'placed ' + JSON.stringify(out.result) + ' with ' + JSON.stringify(added));
    }
    const after = CE.applyOps(tt, out.ops);
    if (row(report(after), 'backups_placed').status !== 'pass') fail('fix', 'still warns after the fix');
    if (CE.call(after, 'commitPlaceBackupVendors', []).ops.length) fail('fix', 'a second run changed something');
    if (!/^Placed 1 item on their backup vendors' lists/.test(out.label)) fail('fix', 'label: ' + out.label);
  }

  // ---- Through the host, against the fake Supabase ----
  {
    const sb = new FakeSupabase(Date.UTC(2026, 9, 19, 19, 30));
    sb.provision('zzhealth');
    const s = sb.stores.get('zzhealth');
    s.pins = { pin: '4321' };
    s.editorDirect = true;
    s.phoneDirect = true;
    s.profile = { location: 'Health Store', abbr: 'ZZH', concept: 'roll-play' };
    const t = healthy(); t.items[1].eligible = ['Amazon', 'Sysco'];
    s.tables = checkCatalogTables(t);
    s.version = 1;
    s.state = { cycleDate: '2026-10-18', dayOfWeek: 'Sun', emergencyOverride: false, vendorPicks: {}, todaysLog: [] };
    const tab = makeTab(sb, srcOf);
    const token = await tab.signIn();
    s.lockedUntil = sb.nowMs + 120000;   // 5 wrong PINs on a phone since this computer signed in
    let rep = await tab.tool(token, 'getStoreHealthReport');
    if (rep.store !== 'Health Store') fail('host', 'store ' + rep.store);
    if (row(rep, 'nightly').status !== 'fail' || row(rep, 'lockout').status !== 'warn' || row(rep, 'backups_placed').status !== 'warn') {
      fail('host', 'rows: ' + JSON.stringify(rep.checks.map(c => c.id + ':' + c.status)));
    }
    const fix = await tab.tool(token, 'runHealthFix', 'place_backups');
    const logged = (s.changeLog || []).slice(-1)[0];
    if (!fix.ok || !logged || !/Health Check/.test(logged.label)) fail('host', 'the fix was not logged: ' + JSON.stringify(fix) + ' ' + JSON.stringify(logged));
    if (!s.tables.pickRows.some(r => r.vendor === 'Sysco' && r.id === 'ITEM-0002')) fail('host', 'the fix did not reach Supabase');
    const unlock = await tab.tool(token, 'runHealthFix', 'clear_lockout');
    if (!unlock.ok || s.lockedUntil) fail('host', 'the lockout was not cleared');
    rep = await tab.tool(token, 'getStoreHealthReport');
    if (row(rep, 'backups_placed').status !== 'pass' || row(rep, 'lockout').status !== 'pass') fail('host', 'after the fixes: ' + JSON.stringify(rep.checks.map(c => c.id + ':' + c.status)));
    const unknown = await tab.tool(token, 'runHealthFix', 'purge_pickpath');
    if (unknown.ok !== false) fail('host', 'a Sheet-only fix ran in the app');
    if (logged) {
      const undo = sb.handle('mog_editor_undo', { p_token: token, p_change_id: logged.id, p_by: 'x' });
      if (!undo.ok || s.tables.pickRows.some(r => r.vendor === 'Sysco' && r.id === 'ITEM-0002')) fail('host', 'Undo did not take the placed row back');
    }
  }
  return { failures };
}

(async () => {
  let failed = 0;
  const main = await runSuite();
  if (main.failures.length) {
    failed++;
    console.log(`FAIL  ${main.failures.length} problem(s):`);
    for (const f of main.failures.slice(0, 15)) console.log('      ' + f);
  } else {
    console.log('PASS  every row, each problem on its own row, the store rows, both fixes through the host, Undo');
  }
  const CE_FILE = 'template/editor/catalogEdit.js', HOST = 'template/editor/host.js';
  const CONTROLS = [
    { name: 'the Overview counts an undone Shelf to Sheet save', scenario: 'overview', file: CE_FILE,
      find: '      shelfSaved: (changes || []).some(c => c && !c.undoneBy && !c.undoes && SHELF_SAVE_RE.test(String(c.label || \'\')))',
      replace: '      shelfSaved: (changes || []).some(c => c && SHELF_SAVE_RE.test(String(c.label || \'\')))' },
    { name: 'the Overview counts inactive items', scenario: 'overview', file: CE_FILE,
      find: '      items: live.length,', replace: '      items: t.items.length,' },
    { name: 'inactive items counted', scenario: 'catalog', file: CE_FILE,
      find: "    const active = t.items.filter(it => it.active === true && s_(it.id) && s_(it.name));",
      replace: "    const active = t.items.filter(it => s_(it.id) && s_(it.name));" },
    { name: 'the close counted missed before 4 AM', scenario: 'store', file: CE_FILE,
      find: "    } else if (st.cycleDate >= today || hhmm < '04:00') {", replace: "    } else if (st.cycleDate >= today) {" },
    { name: 'backups placed for items with no area', scenario: 'catalog', file: CE_FILE,
      find: '      if (!area) continue;', replace: "      if (!area) { out.push({ id: id, name: s_(it.name), vendor: s_(it.primaryVendor), area: '' }); continue; }" },
    { name: 'repeated names matched by case', scenario: 'catalog', file: CE_FILE,
      find: '      const k = s_(it.name).toLowerCase();', replace: '      const k = s_(it.name);' },
    { name: 'placed rows go first in their area', scenario: 'fix', file: CE_FILE,
      find: '      w.pickRows.push({ vendor: m.vendor, id: m.id, area: m.area, shelfOrder: maxShelf + 10, seq: nextPickSeq(w) });',
      replace: '      w.pickRows.push({ vendor: m.vendor, id: m.id, area: m.area, shelfOrder: 1, seq: nextPickSeq(w) });' },
    { name: 'the host\'s fix not saved to Supabase', scenario: 'host', file: HOST,
      find: "        const res = await callTool('commitPlaceBackupVendors', []);",
      replace: "        const res = CE.call(H.tables, 'commitPlaceBackupVendors', []).result;" },
    { name: 'the host\'s lockout fix does nothing', scenario: 'host', file: HOST,
      find: "        const r = await rpc('mog_editor_clear_lockout', { p_token: H.token });", replace: "        const r = { ok: true };" }
  ];
  for (const c of CONTROLS) {
    let res;
    try {
      const planted = F.plant(SRC(c.file), c.find, c.replace);
      res = await runSuite(f => (f === c.file ? planted : SRC(f)));
    } catch (e) {
      failed++;
      console.log(`FAIL  control "${c.name}" crashed instead of biting: ${e.message}`);
      continue;
    }
    const hits = res.failures.filter(f => f.includes('[' + c.scenario + ']')).length;
    if (hits) console.log(`PASS  control "${c.name}" bites (${hits} in "${c.scenario}")`);
    else { failed++; console.log(`FAIL  control "${c.name}" did NOT bite "${c.scenario}"`); }
  }
  console.log(failed ? 'health_app: ' + failed + ' FAILED' : 'health_app: ALL PASS');
  process.exit(failed ? 1 : 0);
})();
