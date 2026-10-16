'use strict';
// GATE: 📱 Mobile API → Move this store to Supabase (Sync.gs moveToSupabase),
// the one-step connect + switch, run with a scripted fake menu UI over a fake
// Supabase (fake_supabase.js). Checks:
//   - nothing changes until the code checks out AND the person says Yes:
//     Cancel, a malformed code, a wrong key, a code for a store another Sheet
//     already connected, and No all leave the store exactly as it was
//   - a missing permission shows Google's consent link (escaped) and stops;
//     a permission error with no link available still explains the fix
//   - a move leaves Supabase exactly as the step-4 gate's seed path does
//     (pushPinsNow_ + pushCatalogNow_ + setDbStateFromSheet_ +
//     importSheetCountsToDb_), with one nightly trigger and MOG_BACKEND set
//   - a failure part-way leaves the store counting in the Sheet, and running
//     Move again finishes without asking for the code
//   - after Switch back to the Sheet, Move switches again without a code
//   - supabase/provision_stores.sql lists exactly the deploy targets' stores,
//     with their Sheets, and never re-keys a store that already connected
// Each has a planted-defect control.
//
// Run bare: node tests/supabase_move.test.js [stores]   (default 40)
// A passing run ends with "supabase_move: ALL PASS".

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const F = require('./fake_apps_script.js');
const { makeStore } = require('./mog_fixture.js');
const { FakeSupabase, fakeScriptApp, fakeContentService, compileStep4 } = require('./fake_supabase.js');

const STORES = Number(process.argv[2]) || 40;
const SRC = file => F.source(null, file);
const PIN = '1111';
const SLUG = 'zztest';

const NEW_EXECUTION = new vm.Script(
  '_SB_CONFIG_ = null; _SB_SNAPSHOT_ = null; MOG_MUTATED_ = false; MOG_SKIP_CATALOG_QUEUE_ = false; _SHEET_CACHE_.clear();');

// Scripted answers, consumed in order: a prompt takes { kind: 'prompt' }, a
// Yes/No alert takes { kind: 'confirm' }. An unexpected dialog throws.
const CODE = (s) => ({ kind: 'prompt', button: 'OK', text: s });
const CANCEL = { kind: 'prompt', button: 'CANCEL' };
const YES = { kind: 'confirm', button: 'YES' };
const NO = { kind: 'confirm', button: 'NO' };

function fakeUi(answers, log) {
  return {
    Button: { OK: 'OK', CANCEL: 'CANCEL', YES: 'YES', NO: 'NO' },
    ButtonSet: { OK: 'BS_OK', OK_CANCEL: 'BS_OK_CANCEL', YES_NO: 'BS_YES_NO' },
    prompt(title, msg) {
      const a = answers.shift();
      if (!a || a.kind !== 'prompt') throw new Error('unexpected prompt: ' + title);
      log.push({ kind: 'prompt', title, msg });
      return { getSelectedButton: () => a.button, getResponseText: () => a.text || '' };
    },
    alert(title, msg, buttons) {
      log.push({ kind: 'alert', title, msg: msg || '' });
      if (buttons !== 'BS_YES_NO') return 'OK';
      const a = answers.shift();
      if (!a || a.kind !== 'confirm') throw new Error('unexpected Yes/No: ' + title);
      return a.button;
    },
    showModalDialog(out, title) { log.push({ kind: 'dialog', title, msg: out.getContent() }); }
  };
}

function makeSide(spec, script, sb, opts) {
  const props = Object.assign({}, spec.scriptProps, { MOG_API_PIN: PIN }, (opts && opts.props) || {});
  const scriptApp = fakeScriptApp({ auth: opts && opts.auth });
  const answers = [];
  const log = [];
  const side = F.makeContext(Object.assign({}, spec, { scriptProps: props }), {
    UrlFetchApp: sb.urlFetchApp(),
    ScriptApp: scriptApp,
    ContentService: fakeContentService,
    HtmlService: { createHtmlOutput: s => ({ setWidth() { return this; }, setHeight() { return this; }, getContent: () => s }) }
  });
  side.ctx.SpreadsheetApp.getActiveSpreadsheet().getName = () => 'TEST_SHEET_' + spec.seed;
  side.ctx.SpreadsheetApp.getUi = () => fakeUi(answers, log);
  script.runInContext(side.ctx);
  side.scriptApp = scriptApp;
  side.exec = fn => { NEW_EXECUTION.runInContext(side.ctx); return fn(side.ctx); };
  // One menu run: the scripted answers must all be used.
  side.menu = (fnName, queued) => {
    answers.length = 0; answers.push(...(queued || [])); log.length = 0;
    side.exec(c => c[fnName]());
    if (answers.length) throw new Error(fnName + ' never asked for ' + JSON.stringify(answers));
    return log.slice();
  };
  return side;
}

// Everything a move could change: script properties, triggers, Sheet writes, Supabase.
function dbState(sb) {
  const s = sb.stores.get(SLUG);
  if (!s) return null;
  return { pins: s.pins, catalog: s.catalog, state: s.state,
           counts: Array.from(s.counts.entries()).map(([c, m]) => [c, Array.from(m.values())]) };
}
function fingerprint(side, sb) {
  return JSON.stringify({ props: Array.from(side.scriptProps.entries()).sort(),
    triggers: side.scriptApp.triggers.map(t => t.getHandlerFunction()),
    writes: side.book.writes.length, db: dbState(sb) });
}
const WRITE_CALL = fn => !/^mog_sync_get_/.test(fn);

function runSuite(srcOf, stores) {
  const script = compileStep4(srcOf);
  const failures = [];
  const stats = { stores: 0, moves: 0, countsCopied: 0 };
  const fail = (seed, scenario, what) => failures.push('seed ' + seed + ' [' + scenario + ']: ' + what);

  for (let seed = 1; seed <= stores; seed++) {
    const spec = makeStore(seed, { realistic: true });
    stats.stores++;

    // The reference: Supabase as the step-4 gate seeds it.
    const sbRef = new FakeSupabase(spec.now);
    const keyRef = sbRef.provision(SLUG);
    const ref = makeSide(spec, script, sbRef, { props: { MOG_SUPABASE_SLUG: SLUG, MOG_SUPABASE_SYNC_KEY: keyRef } });
    const refCopied = ref.exec(c => { c.pushPinsNow_(); c.pushCatalogNow_(); c.setDbStateFromSheet_(); return c.importSheetCountsToDb_(); });
    const expected = JSON.stringify(dbState(sbRef));

    // A scenario that must change nothing.
    const untouched = (scenario, auth, prep, answers, check) => {
      try {
        const sb = new FakeSupabase(spec.now);
        const key = sb.provision(SLUG);
        const side = makeSide(spec, script, sb, { auth });
        if (prep) prep(sb, key);
        const before = fingerprint(side, sb);
        const log = side.menu('moveToSupabase', typeof answers === 'function' ? answers(key) : answers);
        if (fingerprint(side, sb) !== before) fail(seed, scenario, 'changed something');
        const writes = sb.calls.filter(WRITE_CALL);
        if (writes.length) fail(seed, scenario, 'wrote to Supabase: ' + writes.join(','));
        if (check) { const why = check(log, sb); if (why) fail(seed, scenario, why); }
      } catch (e) { fail(seed, scenario, 'crashed: ' + e.message); }
    };
    const said = (log, re) => log.some(l => re.test(l.title + ' ' + l.msg));

    untouched('permission missing', 'required', null, [], (log, sb) => {
      const d = log.find(l => l.kind === 'dialog');
      if (!d) return 'no permission dialog';
      if (!d.msg.includes('href="https://accounts.google.com/o/oauth2/auth?client_id=x&amp;scope=&quot;s&quot;&lt;b>"')) return 'consent link missing or not escaped: ' + d.msg;
      if (sb.calls.length) return 'called Supabase: ' + sb.calls.join(',');
      return '';
    });
    untouched('cancel', null, null, [CANCEL], (log, sb) => (sb.calls.length ? 'called Supabase' : ''));
    untouched('malformed code', null, null, [CODE(SLUG + ':12ab')],
      (log, sb) => (sb.calls.length ? 'called Supabase' : (said(log, /isn't a connect code/) ? '' : 'no explanation')));
    untouched('wrong key', null, null, [CODE(SLUG + ':' + '0'.repeat(64))],
      log => (said(log, /doesn't match store "zztest"/) ? '' : 'no explanation'));
    untouched('already connected from another Sheet', null,
      sb => { sb.stores.get(SLUG).state = { cycleDate: '2026-10-15', dayOfWeek: 'Thu', emergencyOverride: false, vendorPicks: {}, todaysLog: [] }; },
      key => [CODE(SLUG + ':' + key)],
      log => (said(log, /already connected from another Sheet/) ? '' : 'no explanation'));
    untouched('says No', null, null, key => [CODE(SLUG + ':' + key), NO], log => {
      const c = log.find(l => l.title === 'Move this store to Supabase?');
      if (!c) return 'no confirmation';
      if (!c.msg.includes('TEST_SHEET_' + seed) || !c.msg.includes('Code is for store: ' + SLUG)) return 'confirmation lacks the Sheet or store: ' + c.msg;
      const loc = spec.scriptProps.MOG_LOCATION_NAME;
      if (loc && !c.msg.includes('(' + loc + ')')) return 'confirmation lacks the location';
      return '';
    });
    untouched('permission error, no link', 'unavailable', sb => { sb.denyFetch = true; }, key => [CODE(SLUG + ':' + key)], log => {
      const d = log.find(l => l.kind === 'dialog');
      return d && /authorizeSupabase/.test(d.msg) && !/href=/.test(d.msg) ? '' : 'no fallback explanation';
    });

    // A move that fails part-way, then finishes; checked against the reference.
    try {
      const sb = new FakeSupabase(spec.now);
      const key = sb.provision(SLUG);
      const side = makeSide(spec, script, sb, {});
      sb.failFns.add('mog_sync_set_state');
      let log = side.menu('moveToSupabase', [CODE('  "' + SLUG.toUpperCase() + ':' + key.toUpperCase() + '" '), YES]);
      if (!said(log, /Not finished/)) fail(seed, 'failure part-way', 'no "Not finished"');
      if (side.scriptProps.get('MOG_BACKEND')) fail(seed, 'failure part-way', 'switched anyway');
      sb.failFns.clear();
      log = side.menu('moveToSupabase', [YES]);   // no code asked this time
      if (!said(log, /Moved to Supabase/)) fail(seed, 'move', 'no "Moved to Supabase": ' + JSON.stringify(log));
      if (side.scriptProps.get('MOG_BACKEND') !== 'supabase') fail(seed, 'move', 'MOG_BACKEND not set');
      if (side.scriptProps.get('MOG_SUPABASE_SLUG') !== SLUG || side.scriptProps.get('MOG_SUPABASE_SYNC_KEY') !== key) {
        fail(seed, 'move', 'slug/key not saved as lower case');
      }
      const got = JSON.stringify(dbState(sb));
      if (got !== expected) fail(seed, 'move', 'Supabase differs from the reference: ' + F.deepDiff(JSON.parse(got), JSON.parse(expected)));
      if (!said(log, new RegExp('Counts copied: ' + refCopied + '\\n'))) fail(seed, 'move', 'reported count is not ' + refCopied);
      const nightly = side.scriptApp.triggers.filter(t => t.getHandlerFunction() === 'nightlyMaintenance_').length;
      if (nightly !== 1) fail(seed, 'move', nightly + ' nightly triggers');
      stats.moves++;
      stats.countsCopied += refCopied;

      sb.calls.length = 0;
      log = side.menu('moveToSupabase', []);
      if (!said(log, /already counts in Supabase/) || sb.calls.length) fail(seed, 'already moved', 'did something');

      // Rollback, then Move again: no code, one nightly trigger still.
      side.menu('switchBackToSheet', [YES]);
      if (side.scriptProps.get('MOG_BACKEND')) fail(seed, 'rollback', 'still switched');
      log = side.menu('moveToSupabase', [YES]);
      if (side.scriptProps.get('MOG_BACKEND') !== 'supabase') fail(seed, 'move after rollback', 'not switched');
      if (side.scriptApp.triggers.filter(t => t.getHandlerFunction() === 'nightlyMaintenance_').length !== 1) {
        fail(seed, 'move after rollback', 'nightly trigger count changed');
      }
    } catch (e) { fail(seed, 'move', 'crashed: ' + e.message); }
  }
  return { failures, stats };
}

// ---- provision_stores.sql vs the deploy targets ------------------------------
function provisionProblems(sql) {
  const rows = [];
  const re = /\(\s*\d+,\s*'([a-z0-9]+)',\s*'((?:[^']|'')*)',\s*'((?:[^']|'')*)'\)/g;
  let m;
  while ((m = re.exec(sql))) rows.push({ slug: m[1], store: m[2].replace(/''/g, "'"), sheet: m[3].replace(/''/g, "'") });
  const targets = JSON.parse(fs.readFileSync(path.join(F.REPO, 'apps-script/.clasp-targets.json'), 'utf8'))
    .filter(t => t.slug !== '_template');
  const stores = JSON.parse(fs.readFileSync(path.join(F.REPO, 'stores.json'), 'utf8'));
  const list = Array.isArray(stores) ? stores : stores.stores;
  const straight = s => String(s).replace(/[‘’]/g, "'");
  const problems = [];
  for (const t of targets) {
    const r = rows.find(x => x.slug === t.slug);
    if (!r) { problems.push(t.slug + ' is missing'); continue; }
    if (r.sheet !== t.sheet.title) problems.push(t.slug + ': Sheet "' + r.sheet + '" vs "' + t.sheet.title + '"');
    const s = list.find(x => x.slug === t.slug);
    if (s && straight(r.store) !== straight(s.concept + ' ' + s.location)) problems.push(t.slug + ': name "' + r.store + '"');
  }
  for (const r of rows) if (!targets.some(t => t.slug === r.slug)) problems.push(r.slug + ' is not a deploy target');
  if (!/where not exists \(select 1 from mog\.catalog c where c\.slug = v\.slug\)/.test(sql)) {
    problems.push('the guard that skips stores already connected is gone');
  }
  return problems;
}

// ---------------------------------------------------------------------------
let failed = 0;
const main = runSuite(null, STORES);
console.log(`supabase_move: ${main.stats.stores} stores, ${main.stats.moves} moves, ${main.stats.countsCopied} counts copied`);
if (main.failures.length) {
  failed++;
  console.log(`FAIL  ${main.failures.length} problem(s):`);
  for (const f of main.failures.slice(0, 15)) console.log('      ' + f);
} else {
  console.log('PASS  nothing changes before the code checks out and Yes; a move matches the step-4 seed path; failures and rollbacks resume');
}
if (!main.stats.countsCopied) { failed++; console.log('FAIL  fixtures never had counts to copy'); }

const SQL = SRC('supabase/provision_stores.sql');
const sqlProblems = provisionProblems(SQL);
if (sqlProblems.length) { failed++; console.log('FAIL  provision_stores.sql: ' + sqlProblems.join('; ')); }
else console.log('PASS  provision_stores.sql lists every deploy target with its Sheet, and skips stores already connected');

const CONTROLS = [
  { name: 'the code is saved before it is checked', scenario: 'wrong key',
    find: "    slug = m[1].toLowerCase();\r\n",
    replace: "    slug = m[1].toLowerCase();\r\n    props.setProperty(PROP_SB_SLUG, slug);\r\n" },
  { name: 'no confirmation', scenario: 'says No',
    find: "    ui.ButtonSet.YES_NO);\r\n  if (go !== ui.Button.YES) return;\r\n\r\n  let push, imported, nightly;",
    replace: "    ui.ButtonSet.YES_NO);\r\n\r\n  let push, imported, nightly;" },
  { name: 'the already-connected guard removed', scenario: 'already connected from another Sheet',
    find: '    if (check.ok) {', replace: '    if (false) {' },
  { name: 'the consent link not escaped', scenario: 'permission missing',
    find: "'<p><a href=\"' + attr(url) + '\"", replace: "'<p><a href=\"' + url + '\"" },
  { name: 'counts not copied', scenario: 'move',
    find: '    imported = importSheetCountsToDb_();', replace: '    imported = 0;' },
  { name: 'never switches', scenario: 'move',
    find: "    props.setProperty(PROP_BACKEND, 'supabase');\r\n    _SB_CONFIG_ = null;\r\n  } catch (e) {",
    replace: "    _SB_CONFIG_ = null;\r\n  } catch (e) {" },
  { name: 'a failure part-way still switches', scenario: 'failure part-way',
    find: "  } catch (e) {\r\n    ui.alert('Not finished'",
    replace: "  } catch (e) {\r\n    props.setProperty(PROP_BACKEND, 'supabase');\r\n    ui.alert('Not finished'" }
];
for (const c of CONTROLS) {
  let res;
  try {
    const planted = F.plant(SRC('apps-script/Sync.gs'), c.find, c.replace);
    res = runSuite(file => (file === 'apps-script/Sync.gs' ? planted : SRC(file)), Math.min(STORES, 12));
  } catch (e) {
    failed++;
    console.log(`FAIL  control "${c.name}" crashed instead of biting: ${e.message}`);
    continue;
  }
  const hits = res.failures.filter(f => f.includes('[' + c.scenario + ']')).length;
  if (hits) console.log(`PASS  control "${c.name}" bites (${hits} in "${c.scenario}")`);
  else { failed++; console.log(`FAIL  control "${c.name}" did NOT bite "${c.scenario}"`); }
}
for (const c of [
  { name: 'a deploy target dropped from provision_stores.sql', find: "  ( 5, 'rpfr',  'Roll Play Founders BOH',  'RP_FOUNDERS_ORDERING_GUIDE'),\r\n", replace: '' },
  { name: 'the already-connected guard dropped from provision_stores.sql', find: 'where not exists (select 1 from mog.catalog c where c.slug = v.slug)\r\n', replace: '' }
]) {
  let bit;
  try { bit = provisionProblems(F.plant(SQL, c.find, c.replace)).length > 0; }
  catch (e) { failed++; console.log(`FAIL  control "${c.name}" crashed: ${e.message}`); continue; }
  if (bit) console.log(`PASS  control "${c.name}" bites`);
  else { failed++; console.log(`FAIL  control "${c.name}" did NOT bite`); }
}

console.log(failed ? `supabase_move: ${failed} FAILED` : 'supabase_move: ALL PASS');
process.exit(failed ? 1 : 0);
