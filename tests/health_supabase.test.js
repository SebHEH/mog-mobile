'use strict';
// GATE: the Store Health Check's Supabase rows (Health.gs section 9) and their
// two fixes, on the whole Apps Script codebase over a fake Supabase:
//   - a store not connected gets one row, "Moved to Supabase" (warn)
//   - a moved store: moved (pass), nightly 3:30 AM run (fail until installed,
//     then pass; the install_nightly fix installs it once), phones direct
//     (warn while off, pass when on), catalog in sync (pass; warn after a
//     Sheet edit that hasn't reached Supabase, and push_catalog fixes it;
//     pass once Supabase owns the catalog)
//   - connected but counting on the Sheet: phones direct ON is a fail
//   - Supabase unreachable, or schema v4 not installed: one fail row that
//     says what to do
//   - the report itself writes nothing, to the Sheet or to Supabase
// Each has a planted-defect control.
//
// Run bare: node tests/health_supabase.test.js [stores]   (default 30)
// A passing run ends with "health_supabase: ALL PASS".

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const F = require('./fake_apps_script.js');
const { makeStore } = require('./mog_fixture.js');
const { FakeSupabase, fakeScriptApp } = require('./fake_supabase.js');

const STORES = Number(process.argv[2]) || 30;
const DIR = path.join(F.REPO, 'apps-script');
const GS = fs.readdirSync(DIR).filter(f => f.endsWith('.gs')).sort();
const SRC = file => F.source(null, file);
const SLUG = 'zztest';
const OWNER = 'owner@example.com';

function compileAll(srcOf) {
  return new vm.Script(GS.map(f => srcOf('apps-script/' + f)).join('\n'), { filename: 'all-gs.js' });
}
const NEW_EXECUTION = new vm.Script('_SB_CONFIG_ = null; _SB_SNAPSHOT_ = null; _SHEET_CACHE_.clear();');

function makeSide(spec, script, sb, props) {
  const scriptApp = fakeScriptApp();
  const side = F.makeContext(Object.assign({}, spec, { scriptProps: Object.assign({}, spec.scriptProps, props) }), {
    UrlFetchApp: sb.urlFetchApp(),
    ScriptApp: scriptApp,
    LockService: { getDocumentLock: () => ({ waitLock() {}, tryLock() { return true; }, releaseLock() {}, hasLock() { return true; } }) },
    Session: { getActiveUser: () => ({ getEmail: () => OWNER }), getEffectiveUser: () => ({ getEmail: () => OWNER }) },
    HtmlService: { createTemplateFromFile: () => ({ evaluate: () => ({}) }) }
  });
  script.runInContext(side.ctx);
  side.scriptApp = scriptApp;
  side.run = fn => { NEW_EXECUTION.runInContext(side.ctx); return fn(side.ctx); };
  side.rows = () => {
    const rep = side.run(c => c.getStoreHealthReport_());
    const out = {};
    for (const ch of rep.checks) if (/^sb_/.test(ch.id)) out[ch.id] = ch;
    return out;
  };
  return side;
}

function runSuite(srcOf, stores) {
  const script = compileAll(srcOf || SRC);
  const failures = [];
  const stats = { stores: 0, catalogEdits: 0 };
  const fail = (seed, scenario, what) => failures.push('seed ' + seed + ' [' + scenario + ']: ' + what);
  const expect = (seed, scenario, rows, id, status, re) => {
    const r = rows[id];
    if (!r) { fail(seed, scenario, 'no ' + id + ' row (got ' + Object.keys(rows).join(',') + ')'); return null; }
    if (r.status !== status) fail(seed, scenario, id + ' is ' + r.status + ', expected ' + status + ': ' + r.detail);
    if (re && !re.test(r.detail + ' | ' + r.fix + ' | ' + r.fixId)) fail(seed, scenario, id + ' text: ' + r.detail + ' | ' + r.fix);
    return r;
  };

  for (let seed = 1; seed <= stores; seed++) {
    const spec = makeStore(seed, { realistic: true });
    stats.stores++;

    // ---- Not connected ----
    try {
      const sb = new FakeSupabase(spec.now);
      const side = makeSide(spec, script, sb, {});
      const rows = side.rows();
      expect(seed, 'not connected', rows, 'sb_moved', 'warn', /Not connected.*Move this store to Supabase/);
      if (Object.keys(rows).length !== 1) fail(seed, 'not connected', 'extra rows: ' + Object.keys(rows).join(','));
      if (sb.calls.length) fail(seed, 'not connected', 'called Supabase');
    } catch (e) { fail(seed, 'not connected', 'crashed: ' + e.stack); }

    // ---- Moved ----
    try {
      const sb = new FakeSupabase(spec.now);
      const key = sb.provision(SLUG);
      const side = makeSide(spec, script, sb, { MOG_SUPABASE_SLUG: SLUG, MOG_SUPABASE_SYNC_KEY: key, MOG_BACKEND: 'supabase' });
      side.run(c => { c.pushCatalogNow_(); c.setDbStateFromSheet_(); });
      const s = sb.stores.get(SLUG);

      sb.calls.length = 0;
      const writesBefore = side.book.writes.length;
      let rows = side.rows();
      if (sb.calls.some(fn => fn !== 'mog_sync_get_status')) fail(seed, 'read-only', 'the report called ' + sb.calls.join(','));
      if (side.book.writes.length !== writesBefore) fail(seed, 'read-only', 'the report wrote to the Sheet');
      if (side.scriptApp.triggers.length) fail(seed, 'read-only', 'the report installed a trigger');
      expect(seed, 'moved', rows, 'sb_moved', 'pass', new RegExp('store "' + SLUG + '"'));
      expect(seed, 'moved', rows, 'sb_phones', 'warn', /phones_direct\.sql/);
      expect(seed, 'moved', rows, 'sb_catalog', 'pass', /same catalog/);
      expect(seed, 'no trigger', rows, 'sb_nightly', 'fail', /install_nightly/);

      let msg = side.run(c => c.runHealthFix_('install_nightly')).message;
      if (!/^Installed/.test(msg)) fail(seed, 'no trigger', 'fix said: ' + msg);
      msg = side.run(c => c.runHealthFix_('install_nightly')).message;
      if (!/already installed/.test(msg)) fail(seed, 'no trigger', 'second fix said: ' + msg);
      if (side.scriptApp.triggers.filter(t => t.getHandlerFunction() === 'nightlyMaintenance_').length !== 1) {
        fail(seed, 'no trigger', 'not exactly one nightly trigger');
      }
      s.phoneDirect = true;
      rows = side.rows();
      expect(seed, 'no trigger', rows, 'sb_nightly', 'pass');
      expect(seed, 'moved', rows, 'sb_phones', 'pass', /straight to Supabase/);

      // A Sheet edit that hasn't reached Supabase yet.
      const master = side.book.sheets.get('MASTER_ITEMS').rows;
      const row = master.findLastIndex((r, i) => i > 0 && r && String(r[0] || '').trim());   // the row the app reads (last wins)
      if (row > 0) {
        master[row][6] = 987.5;
        rows = side.rows();
        const c = expect(seed, 'catalog edit', rows, 'sb_catalog', 'warn', /different catalog.*push_catalog/);
        if (c && c.destructive) fail(seed, 'catalog edit', 'push marked destructive');
        msg = side.run(cx => cx.runHealthFix_('push_catalog')).message;
        if (!/^Pushed this Sheet's catalog/.test(msg)) fail(seed, 'catalog edit', 'fix said: ' + msg);
        expect(seed, 'catalog edit', side.rows(), 'sb_catalog', 'pass');
        stats.catalogEdits++;
      }

      // Supabase owns the catalog.
      s.editorDirect = true;
      expect(seed, 'editor direct', side.rows(), 'sb_catalog', 'pass', /owns this store's catalog/);
      s.editorDirect = false;

      // No catalog at all.
      s.catalog = null;
      expect(seed, 'no catalog', side.rows(), 'sb_catalog', 'fail', /no catalog.*push_catalog/);

      // Schema v4 not installed, then Supabase down.
      sb.httpFor.mog_sync_get_status = 404;
      rows = side.rows();
      expect(seed, 'unreachable', rows, 'sb_status', 'fail', /schema_v4\.sql/);
      if (rows.sb_phones || rows.sb_catalog) fail(seed, 'unreachable', 'reported rows it could not check');
      delete sb.httpFor.mog_sync_get_status;
      sb.down = true;
      expect(seed, 'unreachable', side.rows(), 'sb_status', 'fail', /Could not read/);
      sb.down = false;
    } catch (e) { fail(seed, 'moved', 'crashed: ' + e.stack); }

    // ---- Connected, counting on the Sheet, phones still direct ----
    try {
      const sb = new FakeSupabase(spec.now);
      const key = sb.provision(SLUG);
      const side = makeSide(spec, script, sb, { MOG_SUPABASE_SLUG: SLUG, MOG_SUPABASE_SYNC_KEY: key });
      side.run(c => c.pushCatalogNow_());
      sb.stores.get(SLUG).phoneDirect = true;
      const rows = side.rows();
      expect(seed, 'rolled back', rows, 'sb_moved', 'warn', /back on the Sheet/);
      expect(seed, 'rolled back', rows, 'sb_phones', 'fail', /phone_direct = false where slug = 'zztest'/);
      expect(seed, 'rolled back', rows, 'sb_nightly', 'warn');
    } catch (e) { fail(seed, 'rolled back', 'crashed: ' + e.stack); }
  }
  return { failures, stats };
}

// ---------------------------------------------------------------------------
let failed = 0;
const main = runSuite(null, STORES);
console.log(`health_supabase: ${main.stats.stores} stores, ${main.stats.catalogEdits} catalog edits`);
if (main.failures.length) {
  failed++;
  console.log(`FAIL  ${main.failures.length} problem(s):`);
  for (const f of main.failures.slice(0, 15)) console.log('      ' + f);
} else {
  console.log('PASS  every Supabase row reports correctly, both fixes work, and the report writes nothing');
}
if (!main.stats.catalogEdits) { failed++; console.log('FAIL  no store had an item to edit'); }

const HEALTH = 'apps-script/Health.gs';
const CONTROLS = [
  { name: 'catalog never compared', scenario: 'catalog edit',
    find: "          const d = syncDiff_(buildCatalogPayload_(), status.catalog, ['Sheet', 'Supabase']);",
    replace: "          const d = '';" },
  { name: 'nightly trigger always seen', scenario: 'no trigger',
    find: "        .some(function (t) { return t.getHandlerFunction() === 'nightlyMaintenance_'; });",
    replace: '        .length >= 0;' },
  { name: 'the report pushes the catalog', scenario: 'read-only',
    find: "        status = supabaseSync_('mog_sync_get_status', {});",
    replace: "        status = supabaseSync_('mog_sync_get_status', {}); pushCatalogNow_();" },
  { name: 'phones direct on a Sheet-counting store not flagged', scenario: 'rolled back',
    find: '        } else if (direct) {', replace: '        } else if (false) {' }
];
for (const c of CONTROLS) {
  let res;
  try {
    const planted = F.plant(SRC(HEALTH), c.find, c.replace);
    res = runSuite(file => (file === HEALTH ? planted : SRC(file)), Math.min(STORES, 10));
  } catch (e) {
    failed++;
    console.log(`FAIL  control "${c.name}" crashed instead of biting: ${e.message}`);
    continue;
  }
  const hits = res.failures.filter(f => f.includes('[' + c.scenario + ']')).length;
  if (hits) console.log(`PASS  control "${c.name}" bites (${hits} in "${c.scenario}")`);
  else { failed++; console.log(`FAIL  control "${c.name}" did NOT bite "${c.scenario}"`); }
}

console.log(failed ? `health_supabase: ${failed} FAILED` : 'health_supabase: ALL PASS');
process.exit(failed ? 1 : 0);
