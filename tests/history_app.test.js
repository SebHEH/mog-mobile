'use strict';
// GATE: order history once a store's editor moves (docs/MOG_OneApp_Spec.md
// T1, E4). On randomized stores the Sheet's LOG_ORDERS is copied into the
// fake Supabase's order log by the real Sync.gs backfillOrderLogToDb_ (the
// fake mirrors schema_v9.sql's mog_sync_backfill_log and mog_history; the SQL
// itself is pinned by supabase/tests/smoke_v9.sql). Then, from that log:
//   - the phone's History tab (the DIRECT CLIENT block, which answers
//     getHistoryDates / getHistoryVendors / getHistoryDetail itself once the
//     editor has moved) gives exactly /exec's answers (MOGApi.gs over the
//     Sheet), and never calls /exec
//   - the editor's Order History (host.js answering getOrderHistoryBootstrap
//     and getOrderHistory) gives exactly History.gs's answers, filters and all
//   - Manage Items' Par Review flags (host.js, OrderMath.gs parReviewFlags_)
//     equal Items.gs getManageItemsBootstrap_'s, the Sheet's own
//   - a second copy adds nothing
// Planted-defect controls in OrderMath.gs, Sync.gs, host.js and the phone's
// block must each be caught.
//
// Run bare: node tests/history_app.test.js [stores]   (default 60)
// A passing run ends with "history_app: ALL PASS".

process.env.TZ = 'UTC';   // the fake formatDate is UTC; so is "today" on both sides

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const F = require('./fake_apps_script.js');
const { makeStore, mulberry32 } = require('./mog_fixture.js');
const { FakeSupabase, fakeScriptApp, fakeContentService } = require('./fake_supabase.js');

const STORES = Number(process.argv[2]) || 60;
const SRC = file => F.source(null, file);
const GS = fs.readdirSync(path.join(F.REPO, 'apps-script')).filter(f => f.endsWith('.gs')).sort();
const SLUG = 'zztest';
const PIN = '1111';
const SB_URL = 'https://fake.supabase.co';
const DAY = 86400000;
const NEW_EXECUTION = new vm.Script('_SB_CONFIG_ = null; _SB_SNAPSHOT_ = null; MOG_MUTATED_ = false; MOG_SKIP_CATALOG_QUEUE_ = false; _SHEET_CACHE_.clear();');
const run = (side, fn) => { NEW_EXECUTION.runInContext(side.ctx); return fn(side.ctx); };
const clean = v => JSON.parse(JSON.stringify(v === undefined ? null : v));

// ---- The phone (phone_harness.js) ---------------------------------------------
const H = require('./phone_harness.js');
const phoneScript = H.phoneScript;
const makePhone = (script, sb, side) => H.makePhone(script, sb,
  body => run(side, c => c.doPost({ postData: { contents: body } }).getContent()), { slug: SLUG, pin: PIN });

// ---- The editor: editor_host.test.js's tab ------------------------------------
function makeTab(sb, srcOf, nowMs) {
  const store = new Map();
  const ctx = {
    console, setTimeout, clearTimeout, AbortController, URLSearchParams,
    fetch: sb.fetchFn(),
    localStorage: { getItem: k => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: k => store.delete(k) },
    location: { search: '', hash: '', href: '', reload() {}, replace() {} },
    document: { body: null, head: null, getElementById: () => null }
  };
  ctx.window = ctx;
  ctx.MOG_SUPABASE = { url: SB_URL, key: 'pub', slug: SLUG };
  ctx.MOG_EDITOR_PAGE = 'history';
  vm.createContext(ctx);
  vm.runInContext(F.clockShim(nowMs), ctx);   // the computer's clock is the store's day, as in real use
  vm.runInContext(srcOf('apps-script/OrderMath.gs'), ctx, { filename: 'orderMath.js' });
  vm.runInContext(srcOf('template/editor/catalogEdit.js'), ctx);
  vm.runInContext(srcOf('template/editor/host.js'), ctx);
  const rpc = (name, ...args) => new Promise((resolve, reject) =>
    ctx.google.script.run.withSuccessHandler(resolve).withFailureHandler(reject)[name](...args));
  return {
    signIn: async () => (await rpc('editorAuth', PIN)).token,
    tool: async (token, fn, ...args) => (await rpc('webedit_call', token, fn, args, { envelope: 1 })).result
  };
}

// ---- A store whose editor moved, with its Sheet's log copied in ----------------
function makeStoreSpec(seed) {
  const rnd = mulberry32(seed * 7907);
  const int = (a, b) => a + Math.floor(rnd() * (b - a + 1));
  const pick = a => a[Math.floor(rnd() * a.length)];
  const spec = makeStore(seed, { realistic: true });
  // One row per item id, so the Sheet's pars and the tables' agree.
  const master = spec.sheets.MASTER_ITEMS, seen = new Set();
  spec.sheets.MASTER_ITEMS = [master[0]].concat(master.slice(1).filter(r => {
    const id = String(r[0] || '').trim();
    if (!id || seen.has(id)) return false;
    seen.add(id);
    if (rnd() < 0.8) r[6] = pick([0.5, 1, 2, 3, 4, 6, 10]);
    return true;
  }));
  const ids = Array.from(seen).concat(['ITEM-9999']);   // one id no longer in the catalog
  const vendors = spec.vendors.length ? spec.vendors.concat([spec.vendors[0].toUpperCase()]) : ['Sysco'];
  const today = spec.now - (spec.now % DAY);
  const log = [spec.sheets.LOG_ORDERS[0]];
  const days = Array.from({ length: int(0, 12) }, () => int(0, 40));
  for (const d of days) {
    const day = today - d * DAY;
    const closedAt = F.D(day + DAY + 7.5 * 3600000 + int(0, 30) * 60000);
    for (let i = 0, n = int(1, 14); i < n; i++) {
      log.push([closedAt, rnd() < 0.8 ? F.D(day) : F.D(day + int(1, 20) * 3600000), pick(vendors), pick(ids),
                pick(['Milk', ' Cups ', 'Tea', 'Lime', '']), pick([0, 1, 2.5, '', '3', 7, 0.25, 10, 'abc']),
                pick([1, 2, '4', 0.5, 6, 3])]);
    }
  }
  spec.sheets.LOG_ORDERS = log;
  return { spec, rnd, int, pick, today };
}

function makeSide(spec, script, sb, key) {
  const side = F.makeContext(Object.assign({}, spec, { scriptProps: Object.assign({}, spec.scriptProps,
    { MOG_SUPABASE_SLUG: SLUG, MOG_SUPABASE_SYNC_KEY: key, MOG_BACKEND: 'supabase', MOG_API_PIN: PIN }) }), {
    UrlFetchApp: sb.urlFetchApp(), ScriptApp: fakeScriptApp(), ContentService: fakeContentService,
    LockService: { getDocumentLock: () => ({ waitLock() {}, tryLock() { return true; }, releaseLock() {}, hasLock() { return true; } }) },
    Session: { getScriptTimeZone: () => 'UTC', getActiveUser: () => ({ getEmail: () => '' }), getEffectiveUser: () => ({ getEmail: () => '' }) },
    Logger: { log: () => {} }
  });
  script.runInContext(side.ctx);
  return side;
}

async function runSuite(srcOf, stores) {
  srcOf = srcOf || SRC;
  const script = new vm.Script(GS.map(f => srcOf('apps-script/' + f)).join('\n'), { filename: 'all-gs.js' });
  const phoneCode = phoneScript(srcOf);
  const failures = [];
  const stats = { stores: 0, rows: 0, dates: 0, compared: 0, flagged: 0 };
  const fail = (seed, scenario, what) => failures.push('seed ' + seed + ' [' + scenario + ']: ' + what);
  const same = (seed, scenario, label, a, b) => {
    stats.compared++;
    const d = F.deepDiff(clean(a), clean(b));
    if (d) fail(seed, scenario, label + ': ' + d);
  };

  for (let seed = 1; seed <= (stores || STORES); seed++) {
    try {
      const { spec, pick, today } = makeStoreSpec(seed);
      const sb = new FakeSupabase(spec.now);
      const key = sb.provision(SLUG);
      const side = makeSide(spec, script, sb, key);
      run(side, c => { c.pushPinsNow_(); c.pushCatalogNow_(); c.setDbStateFromSheet_(); c.importSheetCountsToDb_(); });
      const s = sb.stores.get(SLUG);
      run(side, c => c.supabaseSync_('mog_sync_seed_catalog', { p_tables: c.buildCatalogTables_().tables }));
      const copied = run(side, c => c.backfillOrderLogToDb_());
      const again = run(side, c => c.backfillOrderLogToDb_());
      if (again.inserted !== 0) fail(seed, 'copy', 'a second copy added ' + again.inserted + ' rows');
      s.phoneDirect = true;
      s.editorDirect = true;
      side.scriptProps.set('MOG_EDITOR', 'supabase');
      stats.stores++;
      stats.rows += copied.inserted;
      stats.dates += copied.dates;
      const ymd = ms => new Date(ms).toISOString().slice(0, 10);

      // ---- The phone's History tab vs /exec ----
      const phone = makePhone(phoneCode, sb, side);
      const signIn = await phone.answer('ping');
      if (!signIn.ok) { fail(seed, 'phone', 'sign-in: ' + signIn.error); continue; }
      const exec = (fn, p) => { try { return { ok: true, data: run(side, c => c[fn](p)) }; } catch (e) { return { ok: false, error: e.message }; } };
      const range = { dateFrom: ymd(today - 30 * DAY), dateTo: ymd(today) };
      same(seed, 'dates', 'getHistoryDates (30 days)', await phone.answer('getHistoryDates', range), exec('api_getHistoryDates_', range));
      same(seed, 'dates', 'getHistoryDates (all)', await phone.answer('getHistoryDates', {}), exec('api_getHistoryDates_', {}));
      const logDates = Array.from(new Set(s.log.map(r => r.cycleDate))).concat([ymd(today - 50 * DAY)]);
      for (let k = 0; k < 4; k++) {
        const date = pick(logDates);
        same(seed, 'vendors', 'getHistoryVendors ' + date, await phone.answer('getHistoryVendors', { date }), exec('api_getHistoryVendors_', { date }));
        const vendor = pick(s.log.filter(r => r.cycleDate === date).map(r => r.vendor).concat(['Nobody']));
        same(seed, 'detail', 'getHistoryDetail ' + vendor + ' ' + date,
             await phone.answer('getHistoryDetail', { vendor, date }), exec('api_getHistoryDetail_', { vendor, date }));
        const lower = String(vendor).toLowerCase();
        same(seed, 'detail', 'getHistoryDetail (any case) ' + lower,
             await phone.answer('getHistoryDetail', { vendor: lower, date }), exec('api_getHistoryDetail_', { vendor: lower, date }));
      }
      same(seed, 'vendors', 'getHistoryVendors with no date', await phone.answer('getHistoryVendors', {}), exec('api_getHistoryVendors_', {}));
      if (phone.calls.exec.length) fail(seed, 'phone', 'the History tab called /exec: ' + phone.calls.exec.join());

      // ---- The editor's Order History vs History.gs ----
      const tab = makeTab(sb, srcOf, spec.now);
      const token = await tab.signIn();
      const filters = [{}, { vendorFilter: 'ALL', dateFrom: ymd(today - 7 * DAY), dateTo: ymd(today) },
        { vendorFilter: spec.vendors[0] || 'Sysco' }, { vendorFilter: String(spec.vendors[0] || 'sysco').toLowerCase(), dateFrom: ymd(today - 20 * DAY) },
        { dateFrom: ymd(today - 3 * DAY), dateTo: ymd(today - DAY) }, { vendorFilter: 'Nobody' }];
      for (const f of filters) {
        same(seed, 'rows', 'getOrderHistory ' + JSON.stringify(f), await tab.tool(token, 'getOrderHistory', f), run(side, c => c.getOrderHistory_(f)));
      }
      same(seed, 'bootstrap', 'getOrderHistoryBootstrap', await tab.tool(token, 'getOrderHistoryBootstrap', filters[1]),
           run(side, c => c.getOrderHistoryBootstrap_(filters[1])));

      // ---- Par Review flags vs Items.gs ----
      const hostBoot = await tab.tool(token, 'getManageItemsBootstrap');
      const sheetBoot = run(side, c => c.getManageItemsBootstrap_());
      const byKey = o => Object.fromEntries(Object.keys(o || {}).sort().map(k => [k, o[k]]));   // a map: order doesn't matter
      same(seed, 'flags', 'Par Review flags', byKey(hostBoot.flags), byKey(sheetBoot.flags));
      if (hostBoot.minOrders !== sheetBoot.minOrders) fail(seed, 'flags', 'minOrders ' + hostBoot.minOrders + ' vs ' + sheetBoot.minOrders);
      stats.flagged += Object.values(sheetBoot.flags || {}).filter(x => x.flag).length;
    } catch (e) { fail(seed, 'crash', (e.stack || String(e)).split('\n').slice(0, 3).join(' | ')); }
  }
  return { failures, stats };
}

// ---------------------------------------------------------------------------
(async () => {
  let failed = 0;
  const main = await runSuite();
  const st = main.stats;
  console.log(`history_app: ${st.stores} stores, ${st.rows} log rows copied over ${st.dates} dates, ` +
              `${st.compared} answers compared, ${st.flagged} items flagged`);
  if (main.failures.length) {
    failed++;
    console.log(`FAIL  ${main.failures.length} problem(s):`);
    for (const f of main.failures.slice(0, 15)) console.log('      ' + f);
  } else {
    console.log('PASS  phone History tab = /exec, editor Order History = History.gs, Par Review flags = Items.gs, from the copied log');
  }
  if (!st.rows || !st.flagged) { failed++; console.log('FAIL  the fixtures never copied a log or flagged an item'); }

  const CONTROLS = [
    { name: 'the order log\'s pack not carried', scenario: 'detail', file: 'apps-script/OrderMath.gs',
      find: "    itemPack:   String(r.pack || '').trim(),", replace: "    itemPack:   ''," },
    { name: 'the copy puts a date\'s rows out of order', scenario: 'rows', file: 'apps-script/Sync.gs',
      find: '    batch = batch.concat(rows);', replace: '    batch = batch.concat(rows.slice().reverse());' },
    { name: 'the par window a day short', scenario: 'flags', file: 'apps-script/OrderMath.gs',
      find: '  const d = new Date(Date.UTC(p[0], p[1] - 1, p[2] - parFlagRules_().WINDOW_DAYS));',
      replace: '  const d = new Date(Date.UTC(p[0], p[1] - 1, p[2] - parFlagRules_().WINDOW_DAYS + 1));' },
    { name: 'the phone\'s detail ignores the vendor', scenario: 'detail', file: 'template/index.html',
      find: "          { vendorFilter: vendor, dateFrom: date, dateTo: date }).rows, vendor, date, h.abbr);",
      replace: "          { vendorFilter: 'ALL', dateFrom: date, dateTo: date }).rows, vendor, date, h.abbr);" },
    { name: 'the phone\'s references use no abbreviation', scenario: 'vendors', file: 'template/index.html',
      find: "    const abbr = h.abbr || (direct.catalog && direct.catalog.abbr) || 'LOC';", replace: "    const abbr = 'LOC';" },
    { name: 'the editor\'s vendor list unsorted', scenario: 'bootstrap', file: 'template/editor/host.js',
      find: '      const vendors = h.vendors.slice().sort();', replace: '      const vendors = h.vendors.slice().reverse();' },
    { name: 'the editor\'s flags from every pair, not par > 0', scenario: 'flags', file: 'template/editor/host.js',
      find: '      if (it.id && !isNaN(par) && par > 0) parMap.set(it.id, par);', replace: '      if (it.id) parMap.set(it.id, par || 1);' }
  ];
  const n = Math.min(STORES, 25);
  for (const c of CONTROLS) {
    let res;
    try {
      const planted = F.plant(SRC(c.file), c.find, c.replace);
      res = await runSuite(f => (f === c.file ? planted : SRC(f)), n);
    } catch (e) {
      failed++;
      console.log(`FAIL  control "${c.name}" crashed instead of biting: ${e.message}`);
      continue;
    }
    const hits = res.failures.filter(f => f.includes('[' + c.scenario + ']')).length;
    if (hits) console.log(`PASS  control "${c.name}" bites (${hits} in "${c.scenario}")`);
    else { failed++; console.log(`FAIL  control "${c.name}" did NOT bite "${c.scenario}"`); }
  }
  console.log(failed ? 'history_app: ' + failed + ' FAILED' : 'history_app: ALL PASS');
  process.exit(failed ? 1 : 0);
})();
