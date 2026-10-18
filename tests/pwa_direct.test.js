'use strict';
// GATE: step 5, the phone's direct mode (template/index.html, the DIRECT
// CLIENT block plus api()). Every count-path answer the phone builds from a
// Supabase snapshot must equal what /exec gives for the same store (DbApi.gs),
// which supabase_step4 already proves equals the Sheet. So phone == /exec ==
// Sheet, for every action, before and after every write.
//
// Each randomized store is built twice from the same spec, both moved to their
// own fake Supabase: P (the phone talks to it directly; its /exec runs on
// side P) and R (the reference, reached only through /exec). The phone code is
// the real template code (api, apiOnce_, the save queue, the DIRECT CLIENT
// block) plus OrderMath.gs, run in its own context. Also checked:
//   - sign-in on a store whose phones aren't direct, or with Supabase down,
//     falls back to /exec; a wrong PIN does not; the master PIN signs in as
//     manager
//   - actions outside the count path (history, reset) always go to /exec, and
//     an /exec write refreshes the snapshot
//   - a save queued in direct mode drains into its own cycle after the close
//   - an expired session signs in again; USE_EXEC mid-session moves to /exec
//   - the template carries each build placeholder exactly once
// Each has a planted-defect control.
//
// Run bare: node tests/pwa_direct.test.js [stores]   (default 60)
// A passing run ends with "pwa_direct: ALL PASS".

const vm = require('vm');
const F = require('./fake_apps_script.js');
const { slices } = require('./slice_js.js');
const { makeStore } = require('./mog_fixture.js');
const { FakeSupabase, fakeScriptApp, fakeContentService, compileStep4 } = require('./fake_supabase.js');

const STORES = Number(process.argv[2]) || 60;
const SRC = file => F.source(null, file);
const PIN = '1111';
const MASTER = '9999';
const SLUG = 'zztest';
const SB_URL = 'https://fake.supabase.co';
const EXEC_URL = 'https://script.google.com/macros/s/FAKE/exec';
const NL = SRC('template/index.html').includes('\r\n') ? '\r\n' : '\n';

const NEW_EXECUTION = new vm.Script(
  '_SB_CONFIG_ = null; _SB_SNAPSHOT_ = null; MOG_MUTATED_ = false; MOG_SKIP_CATALOG_QUEUE_ = false; _SHEET_CACHE_.clear();');

// ---- The Apps Script side of a store --------------------------------------
function makeSide(spec, script, sb, opts) {
  const props = Object.assign({}, spec.scriptProps, { MOG_API_PIN: PIN, MOG_API_MASTER_PIN: MASTER });
  if (opts.connected) Object.assign(props, { MOG_SUPABASE_SLUG: SLUG, MOG_SUPABASE_SYNC_KEY: opts.key });
  const side = F.makeContext(Object.assign({}, spec, { scriptProps: props }), {
    UrlFetchApp: sb.urlFetchApp(),
    ScriptApp: fakeScriptApp(),
    ContentService: fakeContentService,
    readRecipients_: () => [{ name: 'GM', email: 'gm@example.com', active: true }],
    sendRecapEmail_: () => {},
    requireEditorToken_: () => true
  }, { advancingClock: true });
  script.runInContext(side.ctx);
  side.exec = fn => { NEW_EXECUTION.runInContext(side.ctx); return fn(side.ctx); };
  side.raw = (body) => side.exec(c => c.doPost({ postData: { contents: body } }).getContent());
  side.post = (action, payload, pin) => JSON.parse(side.raw(JSON.stringify({ pin: pin || PIN, action, payload: payload || {} })));
  if (opts.connected && opts.switched) {
    side.exec(c => { c.pushPinsNow_(); c.pushCatalogNow_(); c.setDbStateFromSheet_(); c.importSheetCountsToDb_(); });
    side.scriptProps.set('MOG_BACKEND', 'supabase');
  }
  return side;
}

// ---- The phone ------------------------------------------------------------
const PRELUDE = [
  'var API_TIMEOUT_MS = 30000; var offlineState = false; var drainPromise_ = null;',
  "var OFFLINE_SLOTS = { QUEUE: 'save_queue' }; function nsKey_(s) { return 'mog_t_' + s; }",
  'function setOffline_() { offlineState = true; } function setOnline_() { offlineState = false; }',
  'function refreshBanner_() {} function showToast() {} function t(k) { return k; } function setDashboardFetchedAt_() {}'
].join('\n');
const PHONE_FNS = ['api', 'apiOnce_', 'isNetworkError_', 'readSaveQueue_', 'writeSaveQueue_', 'enqueueSave_',
  'drainSaveQueue_', 'drainSaveQueueRun_'];

function phoneScript(srcOf) {
  const html = srcOf('template/index.html');
  const a = html.indexOf('// >>> DIRECT CLIENT');
  const b = html.indexOf('// <<< DIRECT CLIENT');
  if (a < 0 || b < a) throw new Error('DIRECT CLIENT markers missing from template/index.html');
  return new vm.Script(srcOf('apps-script/OrderMath.gs') + '\n' + PRELUDE + '\n' + html.slice(a, b) + '\n' +
                       slices(html, PHONE_FNS) + '\n', { filename: 'phone-under-test.js' });
}

function makePhone(script, sb, execSide, pin) {
  const calls = { sb: [], exec: [] };
  const sbFetch = sb.fetchFn();
  const store = new Map();
  const ctx = {
    console, AbortController, setTimeout, clearTimeout,
    window: { MOG_SUPABASE: { url: SB_URL, key: 'pub', slug: SLUG } },
    state: { apiUrl: EXEC_URL, pin: pin || PIN, cache: {} },
    localStorage: { getItem: k => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: k => store.delete(k) },
    fetch: (url, opts) => {
      if (url.indexOf(SB_URL) === 0) { calls.sb.push(url.split('/rpc/')[1]); return sbFetch(url, opts); }
      calls.exec.push(JSON.parse(opts.body).action);
      return new Promise(resolve => {
        const out = execSide.raw(opts.body);
        resolve({ ok: true, status: 200, text: () => Promise.resolve(out) });
      });
    }
  };
  vm.createContext(ctx);
  script.runInContext(ctx);
  const run = code => vm.runInContext(code, ctx);
  return {
    ctx, calls, run,
    answer: async (action, payload) => {
      try { return { ok: true, data: await run('api')(action, payload) }; }
      catch (e) { return { ok: false, error: e.message, lockout: !!e.lockout }; }
    },
    forceFresh: () => run('direct.snapAt = 0'),
    mode: () => run('direct.mode')
  };
}

// ---------------------------------------------------------------------------
async function runSuite(srcOf, stores) {
  srcOf = srcOf || SRC;
  const server = compileStep4(srcOf);
  const phoneCode = phoneScript(srcOf);
  const failures = [];
  const stats = { stores: 0, compared: 0, writes: 0, staleDrains: 0, invalidations: 0 };
  const fail = (seed, scenario, what) => failures.push('seed ' + seed + ' [' + scenario + ']: ' + what);
  const clean = r => ({ ok: r.ok, data: r.ok ? r.data : undefined, error: r.ok ? undefined : r.error });

  for (let seed = 1; seed <= stores; seed++) {
    const spec = makeStore(seed, { realistic: true });
    stats.stores++;
    const sbP = new FakeSupabase(spec.now), sbR = new FakeSupabase(spec.now);
    const keyP = sbP.provision(SLUG), keyR = sbR.provision(SLUG);
    const sideP = makeSide(spec, server, sbP, { connected: true, switched: true, key: keyP });
    const sideR = makeSide(spec, server, sbR, { connected: true, switched: true, key: keyR });
    sbP.stores.get(SLUG).phoneDirect = true;
    const phone = makePhone(phoneCode, sbP, sideP);
    const vendors = spec.vendors.filter(v => sideR.exec(c => c.getVendorList_compute_()).includes(v));

    const same = (scenario, label, a, b) => {
      stats.compared++;
      const d = F.deepDiff(clean(a), clean(b));
      if (d) fail(seed, scenario, label + ': ' + d);
    };
    const reads = async (scenario, tag) => {
      for (const fresh of [false, true]) {
        const t2 = tag + (fresh ? ' (fresh)' : '');
        const q = async (action, payload) => { if (fresh) phone.forceFresh(); return phone.answer(action, payload); };
        same(scenario, t2 + ' getResetStatus', await q('getResetStatus'), sideR.post('getResetStatus'));
        same(scenario, t2 + ' getDashboard', await q('getDashboard'), sideR.post('getDashboard'));
        const names = vendors.concat(vendors.length ? [vendors[0].toLowerCase(), ' ' + vendors[0] + ' '] : [], ['No Such Vendor', '']);
        for (const v of names) same(scenario, t2 + ' getVendorItems(' + v + ')', await q('getVendorItems', { vendor: v }), sideR.post('getVendorItems', { vendor: v }));
        same(scenario, t2 + ' getVendorItemsBulk', await q('getVendorItemsBulk', { vendors: vendors.concat(['Nope']) }),
                                                   sideR.post('getVendorItemsBulk', { vendors: vendors.concat(['Nope']) }));
        same(scenario, t2 + ' getRecapData', await q('getRecapData'), sideR.post('getRecapData'));
        if (vendors.length) same(scenario, t2 + ' getRecapData(one)', await q('getRecapData', { vendors: [vendors[0]] }),
                                                                      sideR.post('getRecapData', { vendors: [vendors[0]] }));
      }
    };

    try {
      // Sign-in: one Supabase call, no /exec.
      same('sign-in', 'ping', await phone.answer('ping'), sideR.post('ping'));
      if (phone.mode() !== 'direct') fail(seed, 'sign-in', 'not in direct mode: ' + phone.mode());
      if (phone.calls.sb.join() !== 'mog_login' || phone.calls.exec.length) {
        fail(seed, 'sign-in', 'calls: sb=' + phone.calls.sb.join() + ' exec=' + phone.calls.exec.join());
      }
      await reads('reads', 'start');

      // Writes, each followed by the reads.
      const step = async (label, action, payload) => {
        stats.writes++;
        same('writes', label, await phone.answer(action, payload), sideR.post(action, payload));
        await reads('writes', 'after ' + label);
      };
      await step('override on', 'setEmergencyOverride', { on: true });
      if (vendors.length) {
        await step('day pick', 'setVendorOverride', { vendor: vendors[0], mult: 3 });
        await step('day pick, lower case', 'setVendorOverride', { vendor: vendors[0].toLowerCase(), mult: 2 });
        same('writes', 'bad day pick', await phone.answer('setVendorOverride', { vendor: vendors[0], mult: 9 }),
                                       sideR.post('setVendorOverride', { vendor: vendors[0], mult: 9 }));
        const items = (sideR.post('getVendorItems', { vendor: vendors[0] }).data || { items: [] }).items;
        const ids = items.map(it => it.id);
        const save = ids.slice(0, 5).map((id, i) => ({ id, onHand: [2, 0.5, '', 'abc', '7'][i] }))
          .concat(ids.length ? [{ id: ids[0], onHand: 4.2 }, { id: '', onHand: 1 }] : []);
        await step('count save', 'saveOnHand', { vendor: vendors[0], items: save });
        same('writes', 'save, no vendor', await phone.answer('saveOnHand', { vendor: '', items: save }),
                                          sideR.post('saveOnHand', { vendor: '', items: save }));
      }
      await step('override off', 'setEmergencyOverride', { on: false });
      const dbOf = sb => { const s = sb.stores.get(SLUG); return JSON.stringify({ state: s.state, counts: Array.from(s.counts.entries()).map(([c, m]) => [c, Array.from(m.values())]) }); };
      if (dbOf(sbP) !== dbOf(sbR)) fail(seed, 'writes', 'Supabase P and R differ after the same writes');
      if (phone.calls.exec.length) fail(seed, 'writes', 'the count path called /exec: ' + phone.calls.exec.join());

      // Outside the count path: /exec, same answer.
      const hist = { dateFrom: '2000-01-01', dateTo: '2100-01-01' };
      same('history', 'getHistoryDates', await phone.answer('getHistoryDates', hist), sideR.post('getHistoryDates', hist));
      if (phone.calls.exec.join() !== 'getHistoryDates') fail(seed, 'history', 'not on /exec: ' + phone.calls.exec.join());

      // The reset runs on /exec, and the snapshot is refreshed after it.
      const before = sbP.stores.get(SLUG).state.cycleDate;
      await phone.answer('getResetStatus');   // a snapshot younger than the reuse window
      same('reset', 'commitReset', await phone.answer('commitReset'), sideR.post('commitReset'));
      same('reset', 'getResetStatus right after', await phone.answer('getResetStatus'), sideR.post('getResetStatus'));
      if (sbP.stores.get(SLUG).state.cycleDate !== before) stats.invalidations++;

      // A save queued in direct mode (offline), the nightly close moves the
      // cycle on, then the queue drains: the count lands in its own day.
      const items0 = vendors.length ? ((sideR.post('getVendorItems', { vendor: vendors[0] }).data || { items: [] }).items) : [];
      if (items0.length) {
        const y = sbP.stores.get(SLUG).state.cycleDate;
        phone.run('enqueueSave_')(vendors[0], [{ id: items0[0].id, onHand: 77 }]);
        const entry = JSON.parse(phone.run('localStorage').getItem('mog_t_save_queue') || '[]')[0];
        if (!entry || entry.cycleDate !== y) fail(seed, 'stale drain', 'queued without its cycle: ' + JSON.stringify(entry));
        const z = new Date(Date.parse(y + 'T00:00:00Z') + 86400000).toISOString().slice(0, 10);
        const dow = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][new Date(z + 'T00:00:00Z').getUTCDay()];
        for (const [sb, key] of [[sbP, keyP], [sbR, keyR]]) {
          sb.handle('mog_sync_close_cycle', { p_slug: SLUG, p_key: key, p_closing: y, p_new_cycle: z, p_new_dow: dow, p_rows: [], p_todays_log: [] });
        }
        phone.forceFresh();   // the drain comes hours later, so the phone's snapshot is old by then
        await phone.run('drainSaveQueue_')();
        if (JSON.parse(phone.run('localStorage').getItem('mog_t_save_queue') || '[]').length) fail(seed, 'stale drain', 'queue not drained');
        const s = sbP.stores.get(SLUG);
        const has77 = c => Array.from((s.counts.get(c) || new Map()).values()).some(x => x.onHand === 77);
        if (has77(z) || !has77(y)) fail(seed, 'stale drain', 'queued count landed in ' + (has77(z) ? 'the new cycle' : 'neither cycle'));
        stats.staleDrains++;
        phone.forceFresh();
        same('stale drain', 'getDashboard on the new cycle', await phone.answer('getDashboard'), sideR.post('getDashboard'));
        if (vendors.length) same('stale drain', 'getVendorItems on the new cycle', await phone.answer('getVendorItems', { vendor: vendors[0] }), sideR.post('getVendorItems', { vendor: vendors[0] }));
      }

      // An expired session signs in again.
      sbP.stores.get(SLUG).sessions.clear();
      phone.calls.sb.length = 0;
      phone.forceFresh();
      same('session', 'getDashboard after expiry', await phone.answer('getDashboard'), sideR.post('getDashboard'));
      if (phone.calls.sb.filter(f => f === 'mog_login').length !== 1) fail(seed, 'session', 'did not sign in again: ' + phone.calls.sb.join());

      // Phones turned off mid-session: the next call goes to /exec, and stays there.
      sbP.stores.get(SLUG).phoneDirect = false;
      phone.calls.exec.length = 0;
      phone.forceFresh();
      same('use exec', 'getDashboard', await phone.answer('getDashboard'), sideR.post('getDashboard'));
      if (vendors.length) same('use exec', 'getVendorItems', await phone.answer('getVendorItems', { vendor: vendors[0] }), sideR.post('getVendorItems', { vendor: vendors[0] }));
      if (phone.mode() !== 'exec' || phone.calls.exec[0] !== 'getDashboard') fail(seed, 'use exec', 'mode ' + phone.mode() + ', exec calls ' + phone.calls.exec.join());
    } catch (e) {
      fail(seed, 'crash', (e.stack || String(e)).split('\n').slice(0, 3).join(' | '));
    }

    if (seed > 12) continue;
    // ---- Sign-in edge cases ----------------------------------------------
    try {
      // Not moved yet (Supabase doesn't know the store): /exec, after one try.
      const sbU = new FakeSupabase(spec.now);
      const sideU = makeSide(spec, server, sbU, { connected: false });
      const u = makePhone(phoneCode, sbU, sideU);
      same('not moved', 'ping', await u.answer('ping'), sideU.post('ping'));
      same('not moved', 'getDashboard', await u.answer('getDashboard'), sideU.post('getDashboard'));
      if (u.calls.sb.join() !== 'mog_login' || u.calls.exec.join() !== 'ping,getDashboard') {
        fail(seed, 'not moved', 'calls: sb=' + u.calls.sb.join() + ' exec=' + u.calls.exec.join());
      }

      // Supabase down at sign-in: /exec.
      const sbD = new FakeSupabase(spec.now);
      const sideD = makeSide(spec, server, sbD, { connected: true, switched: true, key: sbD.provision(SLUG) });
      sbD.stores.get(SLUG).phoneDirect = true;
      sbD.down = true;
      const d = makePhone(phoneCode, sbD, sideD);
      const dp = await d.answer('ping');
      sbD.down = false;
      same('supabase down', 'ping', dp, sideD.post('ping'));
      if (d.mode() !== 'exec') fail(seed, 'supabase down', 'mode ' + d.mode());

      // A wrong PIN on a direct store: refused by Supabase, never retried on
      // /exec; the fifth locks the store out.
      const w = makePhone(phoneCode, sbD, sideD, '0000');
      let last;
      for (let i = 0; i < 5; i++) last = await w.answer('ping');
      const first = sbD.stores.get(SLUG).failCount;
      if (last.ok || !last.lockout || w.calls.exec.length || first < 5) {
        fail(seed, 'wrong PIN', JSON.stringify(last) + ' exec=' + w.calls.exec.join());
      }
      sbD.stores.get(SLUG).failCount = 0; sbD.stores.get(SLUG).lockedUntil = 0;

      // The master PIN signs in as manager.
      const m = makePhone(phoneCode, sbD, sideD, MASTER);
      same('master PIN', 'ping', await m.answer('ping'), sideD.post('ping', {}, MASTER));
      if (m.mode() !== 'direct') fail(seed, 'master PIN', 'mode ' + m.mode());
    } catch (e) {
      fail(seed, 'crash', (e.stack || String(e)).split('\n').slice(0, 3).join(' | '));
    }
  }
  return { failures, stats };
}

// ---- Live counting (schema v5) ---------------------------------------------
// Two phones on one store, through the real DIRECT CLIENT code: the refresh
// tells Supabase who this device is and which vendor it has open, the other
// phone sees it (and the store's names), a save records who made it, a
// skipped name saves as nobody, and a Supabase without the v5 calls falls back
// to the v1 calls once and for the rest of the session.
async function liveSuite(srcOf, stores) {
  srcOf = srcOf || SRC;
  const server = compileStep4(srcOf);
  const phoneCode = phoneScript(srcOf);
  const failures = [];
  const stats = { stores: 0, presenceSeen: 0, savedBy: 0, fallbacks: 0 };
  const fail = (seed, scenario, what) => failures.push('seed ' + seed + ' [' + scenario + ']: ' + what);

  for (let seed = 1; seed <= stores; seed++) {
    const spec = makeStore(seed, { realistic: true });
    const sb = new FakeSupabase(spec.now);
    const key = sb.provision(SLUG);
    const side = makeSide(spec, server, sb, { connected: true, switched: true, key });
    const st = sb.stores.get(SLUG);
    st.phoneDirect = true;
    let vendor = null, item = null;
    try {
      const a = makePhone(phoneCode, sb, side), b = makePhone(phoneCode, sb, side);
      a.run("setLiveName_('Maria')");
      b.run("setLiveName_('Luis')");
      if (!(await a.answer('ping')).ok || !(await b.answer('ping')).ok) { fail(seed, 'live', 'sign-in failed'); continue; }
      for (const v of spec.vendors) {
        const r = await a.answer('getVendorItems', { vendor: v });
        if (r.ok && r.data.items && r.data.items.length) { vendor = v; item = r.data.items[0]; break; }
      }
      if (!vendor) continue;
      stats.stores++;

      // A opens the vendor; its next refresh says so, and B sees it.
      a.run("state.currentView = 'count'; state.countContext = { vendor: " + JSON.stringify(vendor) + ' };');
      a.forceFresh();
      await a.answer('getDashboard');
      if (a.calls.sb.indexOf('mog_snapshot2') < 0) fail(seed, 'live', 'phone A never sent mog_snapshot2');
      b.forceFresh();
      await b.answer('getDashboard');
      const live = JSON.parse(b.run('JSON.stringify(direct.live)'));
      if (!(live.presence || []).some(p => p.name === 'Maria' && p.vendor === vendor)) {
        fail(seed, 'live', 'B does not see Maria on ' + vendor + ': ' + JSON.stringify(live.presence));
      } else stats.presenceSeen++;
      if (JSON.stringify(live.people) !== '["Luis","Maria"]') fail(seed, 'live', 'names: ' + JSON.stringify(live.people));

      // A saves; B sees the count and who saved it.
      const saved = await a.answer('saveOnHand', { vendor, items: [{ id: item.id, onHand: 3 }] });
      if (!saved.ok) fail(seed, 'live', 'save failed: ' + saved.error);
      if (a.calls.sb.indexOf('mog_save_counts2') < 0) fail(seed, 'live', 'the save did not use mog_save_counts2');
      b.forceFresh();
      const bv = await b.answer('getVendorItems', { vendor });
      const bi = bv.ok && bv.data.items.find(i => i.id === item.id);
      if (!bi || bi.onHand !== 3) fail(seed, 'live', 'B does not see the count: ' + JSON.stringify(bi));
      const act = JSON.parse(b.run('JSON.stringify(direct.live.activity)'));
      if (!act.some(x => x.vendor === vendor && x.by === 'Maria')) fail(seed, 'live', 'activity: ' + JSON.stringify(act));
      else stats.savedBy++;

      // A device that skipped its name saves as nobody.
      const c = makePhone(phoneCode, sb, side);
      c.run("setLiveName_('')");
      await c.answer('ping');
      await c.answer('saveOnHand', { vendor, items: [{ id: item.id, onHand: 4 }] });
      const row = Array.from(sb.countsIn(st, st.state.cycleDate).values()).find(r => r.id === item.id && r.vendor === vendor);
      if (!row || row.countedBy !== null) fail(seed, 'live', 'a skipped name saved as ' + JSON.stringify(row && row.countedBy));
    } catch (e) { fail(seed, 'live', 'crashed: ' + e.stack); }

    // Supabase without schema v5: the v1 calls, found out once.
    if (!vendor) continue;
    try {
      sb.httpFor.mog_snapshot2 = 404;
      sb.httpFor.mog_save_counts2 = 404;
      const d = makePhone(phoneCode, sb, side);
      d.run("setLiveName_('Ana')");
      const answers = [await d.answer('ping')];
      d.forceFresh(); answers.push(await d.answer('getDashboard'));
      answers.push(await d.answer('saveOnHand', { vendor, items: [{ id: item.id, onHand: 2 }] }));
      d.forceFresh(); answers.push(await d.answer('getDashboard'));
      const bad = answers.find(r => !r.ok);
      if (bad) fail(seed, 'v4 only', 'an answer failed: ' + bad.error);
      if (d.run('direct.live.v5')) fail(seed, 'v4 only', 'still on the v5 calls');
      if (d.calls.sb.filter(f => f === 'mog_snapshot2').length !== 1) fail(seed, 'v4 only', 'mog_snapshot2 asked ' + d.calls.sb.filter(f => f === 'mog_snapshot2').length + ' times');
      if (d.calls.sb.indexOf('mog_save_counts2') >= 0) fail(seed, 'v4 only', 'tried mog_save_counts2 after finding out');
      if (d.calls.sb.indexOf('mog_snapshot') < 0 || d.calls.sb.indexOf('mog_save_counts') < 0) fail(seed, 'v4 only', 'v1 calls missing: ' + d.calls.sb.join(','));
      stats.fallbacks++;
    } catch (e) { fail(seed, 'v4 only', 'crashed: ' + e.stack); }
    finally { delete sb.httpFor.mog_snapshot2; delete sb.httpFor.mog_save_counts2; }
  }
  return { failures, stats };
}

// ---- The build placeholders -------------------------------------------------
function placeholderProblems(html) {
  const want = ['__MOG_API_URL__', '__MOG_THEME__', '__MOG_APPLE_TOUCH_ICON__',
                '/*__MOG_SUPABASE__*/null', '/* __MOG_ORDER_MATH__ build-injected */', '/*__MOG_STORE__*/null'];
  return want.map(p => [p, html.split(p).length - 1]).filter(([, n]) => n !== 1).map(([p, n]) => p + ' x' + n);
}

// ---------------------------------------------------------------------------
(async function main() {
  let failed = 0;
  const res = await runSuite(null, STORES);
  const s = res.stats;
  console.log(`pwa_direct: ${s.stores} stores, ${s.compared} answers compared, ${s.writes} writes, ` +
    `${s.invalidations} resets that moved the cycle, ${s.staleDrains} stale drains`);
  if (res.failures.length) {
    failed++;
    console.log(`FAIL  ${res.failures.length} problem(s):`);
    for (const f of res.failures.slice(0, 15)) console.log('      ' + f);
  } else {
    console.log('PASS  phone answers == /exec answers (fresh and reused snapshots), before and after every write');
  }
  if (!s.staleDrains || !s.writes) { failed++; console.log('FAIL  fixtures never moved a cycle or never wrote'); }

  const ph = placeholderProblems(SRC('template/index.html'));
  if (ph.length) { failed++; console.log('FAIL  template placeholders: ' + ph.join(', ')); }
  else console.log('PASS  template/index.html carries each build placeholder exactly once');

  const T = 'template/index.html';
  const CONTROLS = [
    { name: 'a queued save sent to the current cycle', scenario: 'stale drain',
      find: 'const cycle = payload.cycleDate || (await directSnapshot_()).state.cycleDate;',
      replace: 'const cycle = (await directSnapshot_()).state.cycleDate;' },
    { name: 'saves not applied to the held snapshot', scenario: 'writes',
      find: '    const snap = direct.snap;' + NL + '    if (!snap || snap.state.cycleDate !== cycle) return;',
      replace: '    return;' },
    { name: 'USE_EXEC not redone on /exec', scenario: 'use exec',
      find: '        if (viaDirect && err && err.useExec) { viaDirect = false; attempt--; continue; }' + NL, replace: '' },
    { name: 'sign-in does not fall back when Supabase is down', scenario: 'supabase down',
      find: 'if (e.useExec || isNetworkError_(e) ||', replace: 'if (e.useExec || false ||' },
    { name: 'every action routed direct', scenario: 'history',
      find: 'if (!window.MOG_SUPABASE || !DIRECT_ACTIONS[action]) return false;', replace: 'if (!window.MOG_SUPABASE) return false;' },
    { name: 'no sign-in again after the session expires', scenario: 'session',
      find: "if (body.error === 'SESSION_EXPIRED' && pass === 0) { direct.token = null; continue; }", replace: '' },
    { name: 'an /exec write leaves the snapshot as it was', scenario: 'reset',
      find: 'if (!retriable) directInvalidate_();', replace: '' },
    { name: 'a snapshot without the catalog wipes the catalog', scenario: 'reads',
      find: '    if (data.catalog) {' + NL + '      direct.catalog = data.catalog;',
      replace: '    if (true) {' + NL + '      direct.catalog = data.catalog;' },
    { name: 'a wrong PIN retried on /exec', scenario: 'wrong PIN',
      find: "      if (DIRECT_EXEC_SIGNALS[body.error]) { directUseExec_(); throw useExecError_(); }" + NL + "      throw envelopeError_(body);" + NL + "    }" + NL + "    direct.mode = 'direct';",
      replace: "      directUseExec_(); throw useExecError_();" + NL + "    }" + NL + "    direct.mode = 'direct';" }
  ];
  for (const c of CONTROLS) {
    let r;
    try {
      const planted = F.plant(SRC(T), c.find, c.replace);
      r = await runSuite(file => (file === T ? planted : SRC(file)), Math.min(STORES, 14));
    } catch (e) {
      failed++;
      console.log(`FAIL  control "${c.name}" crashed instead of biting: ${e.message}`);
      continue;
    }
    const hits = r.failures.filter(f => f.includes('[' + c.scenario + ']')).length;
    if (hits) console.log(`PASS  control "${c.name}" bites (${hits} in "${c.scenario}")`);
    else { failed++; console.log(`FAIL  control "${c.name}" did NOT bite "${c.scenario}" (${r.failures.length} other: ${r.failures[0] || '-'})`); }
  }
  const live = await liveSuite(null, Math.min(STORES, 30));
  const ls = live.stats;
  console.log(`pwa_direct live: ${ls.stores} stores, presence seen ${ls.presenceSeen}, saved-by ${ls.savedBy}, v4 fallbacks ${ls.fallbacks}`);
  if (live.failures.length) {
    failed++;
    console.log(`FAIL  ${live.failures.length} live-counting problem(s):`);
    for (const f of live.failures.slice(0, 10)) console.log('      ' + f);
  } else if (!ls.presenceSeen || !ls.savedBy || !ls.fallbacks) {
    failed++;
    console.log('FAIL  live counting never exercised (no vendor with items?)');
  } else {
    console.log('PASS  live counting: presence and names reach the other phone, saves record who, v1 fallback once');
  }
  const LIVE_CONTROLS = [
    { name: 'the refresh does not say which vendor is open', scenario: 'live',
      find: 'p_vendor: liveVendor_() }', replace: 'p_vendor: null }' },
    { name: 'saves do not say who', scenario: 'live',
      find: "Object.assign({ p_by: liveName_() || null }, saveParams)", replace: "Object.assign({ p_by: null }, saveParams)" },
    { name: 'presence from the snapshot dropped', scenario: 'live',
      find: '      direct.live.presence = data.presence;', replace: '      direct.live.presence = [];' },
    { name: 'a 404 asks for the v5 call again every time', scenario: 'v4 only',
      find: '        direct.live.v5 = false;' + NL, replace: '' }
  ];
  for (const c of LIVE_CONTROLS) {
    let r;
    try {
      const planted = F.plant(SRC(T), c.find, c.replace);
      r = await liveSuite(file => (file === T ? planted : SRC(file)), Math.min(STORES, 10));
    } catch (e) {
      failed++;
      console.log(`FAIL  control "${c.name}" crashed instead of biting: ${e.message}`);
      continue;
    }
    const hits = r.failures.filter(f => f.includes('[' + c.scenario + ']')).length;
    if (hits) console.log(`PASS  control "${c.name}" bites (${hits} in "${c.scenario}")`);
    else { failed++; console.log(`FAIL  control "${c.name}" did NOT bite "${c.scenario}" (${r.failures.length} other: ${r.failures[0] || '-'})`); }
  }

  const phPlanted = placeholderProblems(F.plant(SRC(T), '/* __MOG_ORDER_MATH__ build-injected */', ''));
  if (phPlanted.length) console.log('PASS  control "the order-math marker removed" bites');
  else { failed++; console.log('FAIL  control "the order-math marker removed" did NOT bite'); }

  console.log(failed ? `pwa_direct: ${failed} FAILED` : 'pwa_direct: ALL PASS');
  process.exit(failed ? 1 : 0);
})();
