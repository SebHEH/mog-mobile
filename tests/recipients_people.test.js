'use strict';
// GATE: recipients and People move to Supabase (docs/MOG_OneApp_Spec.md T2,
// T3; schema v9). The fake Supabase mirrors schema_v9.sql (its recipients
// check written from the SQL; the SQL itself is pinned by
// supabase/tests/smoke_v9.sql).
//   Recipients
//   - the save's rules equal Recap.gs api_saveRecipients_'s on random lists
//     (the same accept or refuse, the same message, the same list kept),
//     except the GM messages' last sentence, which now points to a computer
//   - once the editor moves: the phone's Settings -> Recipients reads and
//     saves Supabase (never /exec), the GM row stays locked unless the save
//     comes from a computer, the nightly email (Recap.gs readRecipients_)
//     reads the same list, the Sheet's list is copied once (by the nightly
//     run or the first read) and a list emptied on purpose stays empty, an
//     older app's /exec save is refused, and with Supabase down the email
//     falls back to the Sheet's list
//   - before the move everything stays on /exec and the Sheet
//   People
//   - a rename reaches a phone still using the old name; a removed name
//     makes its phones ask again and isn't added back by a device that still
//     sends it; picking it again brings it back; renaming onto a listed name
//     merges the two
// Planted-defect controls in Recap.gs and the phone's block must be caught.
//
// Run bare: node tests/recipients_people.test.js [cases]   (default 400)
// A passing run ends with "recipients_people: ALL PASS".

process.env.TZ = 'UTC';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const F = require('./fake_apps_script.js');
const { makeStore, mulberry32 } = require('./mog_fixture.js');
const { FakeSupabase, fakeScriptApp, fakeContentService, recipientsCheck } = require('./fake_supabase.js');
const PH = require('./phone_harness.js');

const CASES = Number(process.argv[2]) || 400;
const SRC = file => F.source(null, file);
const GS = fs.readdirSync(path.join(F.REPO, 'apps-script')).filter(f => f.endsWith('.gs')).sort();
const SLUG = 'zztest';
const PIN = '1111';
const NEW_EXECUTION = new vm.Script('_SB_CONFIG_ = null; _SB_SNAPSHOT_ = null; MOG_MUTATED_ = false; MOG_SKIP_CATALOG_QUEUE_ = false; _SHEET_CACHE_.clear();');
const run = (side, fn) => { NEW_EXECUTION.runInContext(side.ctx); return fn(side.ctx); };
const clean = v => JSON.parse(JSON.stringify(v === undefined ? null : v));
// The GM messages' last sentence: the Sheet's says "managed in the
// spreadsheet only", Supabase's says "changed on a computer" (T2).
const gmMsg = m => String(m).replace(/ GM rows are managed in the spreadsheet only\.$| The GM row is changed on a computer\.$/, '');

function makeSide(spec, script, sb, key, props) {
  const side = F.makeContext(Object.assign({}, spec, { scriptProps: Object.assign({}, spec.scriptProps,
    { MOG_SUPABASE_SLUG: SLUG, MOG_SUPABASE_SYNC_KEY: key, MOG_BACKEND: 'supabase', MOG_API_PIN: PIN }, props || {}) }), {
    UrlFetchApp: sb.urlFetchApp(), ScriptApp: fakeScriptApp(), ContentService: fakeContentService,
    LockService: { getDocumentLock: () => ({ waitLock() {}, tryLock() { return true; }, releaseLock() {}, hasLock() { return true; } }) },
    Session: { getScriptTimeZone: () => 'UTC', getActiveUser: () => ({ getEmail: () => '' }), getEffectiveUser: () => ({ getEmail: () => '' }) },
    MailApp: { sendEmail: () => {}, getRemainingDailyQuota: () => 100 },
    Logger: { log: () => {} }
  });
  script.runInContext(side.ctx);
  return side;
}
const execPost = side => body => run(side, c => c.doPost({ postData: { contents: body } }).getContent());

// ---- Random recipients lists ----------------------------------------------
function randomCase(rnd) {
  const pick = a => a[Math.floor(rnd() * a.length)];
  const NAMES = ['GM', 'Ana', 'Bo', '  Cy ', 'Dee', 'Ed', ''];
  const MAILS = ['gm@example.com', 'ana@example.com', 'ANA@example.com', 'bo@example', 'x@y.z', '', ' cy@ex.com ', 'dee@ex.co', 'a b@c.d'];
  const stored = [];
  const seen = new Set();
  for (let i = 0, n = Math.floor(rnd() * 5); i < n; i++) {
    const email = pick(['gm@example.com', 'ana@example.com', 'boss@ex.com', 'dee@ex.co', 'ed@ex.com']);
    if (seen.has(email)) continue;
    seen.add(email);
    stored.push({ name: pick(['GM', 'Ana', 'Boss', 'Dee', 'Ed']), email: email, active: rnd() < 0.7, gm: rnd() < 0.35 });
  }
  let incoming = stored.map(r => Object.assign({}, r));
  for (let k = 0, ops = Math.floor(rnd() * 4); k < ops; k++) {
    const op = Math.floor(rnd() * 8);
    if (op === 0 && incoming.length) incoming.splice(Math.floor(rnd() * incoming.length), 1);
    else if (op === 1 && incoming.length) incoming[Math.floor(rnd() * incoming.length)].name = pick(NAMES);
    else if (op === 2 && incoming.length) { const r = incoming[Math.floor(rnd() * incoming.length)]; r.active = !r.active; }
    else if (op === 3 && incoming.length) incoming[Math.floor(rnd() * incoming.length)].gm = pick([true, false, undefined]);
    else if (op === 4) incoming.push({ name: pick(NAMES), email: pick(MAILS), active: pick([true, false, 'true', undefined]), gm: pick([true, false]) });
    else if (op === 5) incoming.push({ name: '', email: '', active: true });
    else if (op === 6 && incoming.length) incoming.push(Object.assign({}, incoming[0], { email: String(incoming[0].email).toUpperCase() }));
    else if (op === 7 && incoming.length) incoming[Math.floor(rnd() * incoming.length)].email = pick(MAILS);
  }
  if (rnd() < 0.2) incoming = incoming.reverse();
  return { stored, incoming };
}

async function runSuite(srcOf, cases) {
  srcOf = srcOf || SRC;
  const script = new vm.Script(GS.map(f => srcOf('apps-script/' + f)).join('\n'), { filename: 'all-gs.js' });
  const phoneCode = PH.phoneScript(srcOf);
  const failures = [];
  const stats = { cases: 0, refused: 0, kept: 0 };
  const fail = (scenario, what) => failures.push('[' + scenario + ']: ' + what);

  // ---- The save's rules: Recap.gs vs the SQL (its fake) ----
  {
    const spec = makeStore(1, { realistic: true });
    const sb = new FakeSupabase(spec.now);
    const side = makeSide(spec, script, sb, sb.provision(SLUG));
    const rnd = mulberry32(4242);
    for (let i = 0; i < (cases || CASES); i++) {
      const c = randomCase(rnd);
      run(side, x => x.writeRecipients_(c.stored));
      const stored = run(side, x => x.readRecipientsSheet_());
      let sheet;
      try { sheet = { ok: true, list: run(side, x => x.api_saveRecipients_({ recipients: clean(c.incoming) })).recipients }; }
      catch (e) { sheet = { ok: false, error: e.message }; }
      const db = recipientsCheck(stored, clean(c.incoming), false);
      stats.cases++;
      if (sheet.ok !== db.ok) { fail('rules', 'case ' + i + ': Sheet ' + (sheet.ok ? 'saved' : 'refused (' + sheet.error + ')') + ', Supabase ' + (db.ok ? 'saved' : 'refused (' + db.error + ')')); continue; }
      if (!sheet.ok) {
        stats.refused++;
        if (gmMsg(sheet.error) !== gmMsg(db.error)) fail('rules', 'case ' + i + ': "' + sheet.error + '" vs "' + db.error + '"');
      } else {
        stats.kept++;
        const d = F.deepDiff(clean(sheet.list), clean(db.list));
        if (d) fail('rules', 'case ' + i + ': lists differ: ' + d);
      }
    }
  }

  // ---- Once the editor has moved ----
  {
    const spec = makeStore(2, { realistic: true });
    const sb = new FakeSupabase(spec.now);
    const key = sb.provision(SLUG);
    const side = makeSide(spec, script, sb, key);
    run(side, c => { c.pushPinsNow_(); c.pushCatalogNow_(); c.setDbStateFromSheet_(); });
    side.scriptProps.set('MOG_EDITOR', 'supabase');   // the switch, after the Sheet's last push
    const s = sb.stores.get(SLUG);
    s.phoneDirect = true;
    s.editorDirect = true;
    const sheetList = [{ name: 'GM', email: 'gm@example.com', active: true, gm: true },
                       { name: 'Ana', email: 'ana@example.com', active: true, gm: false }];
    run(side, c => c.writeRecipients_(sheetList));

    // The nightly run copies the Sheet's list once.
    run(side, c => c.nightlyMaintenance_());
    if (!s.recipientsSeeded || JSON.stringify(s.recipients) !== JSON.stringify(sheetList)) fail('moved', 'the nightly run did not copy the Sheet\'s list: ' + JSON.stringify(s.recipients));

    const phone = PH.makePhone(phoneCode, sb, execPost(side), { slug: SLUG, pin: PIN });
    await phone.answer('ping');
    const got = await phone.answer('getRecipients');
    if (!got.ok || JSON.stringify(got.data.recipients) !== JSON.stringify(sheetList)) fail('moved', 'phone getRecipients: ' + JSON.stringify(got));
    const noGm = await phone.answer('saveRecipients', { recipients: [sheetList[1]], gmEdit: false });
    if (noGm.ok || !/^Cannot remove GM recipient "GM"/.test(noGm.error)) fail('moved', 'a phone removed the GM row: ' + JSON.stringify(noGm));
    const pc = await phone.answer('saveRecipients', { recipients: [sheetList[1], { name: 'New GM', email: 'new@ex.com', active: true, gm: true }], gmEdit: true });
    if (!pc.ok || !pc.data.recipients[1].gm) fail('moved', 'a computer could not change the GM row: ' + JSON.stringify(pc));
    if (phone.calls.exec.length) fail('moved', 'Recipients called /exec: ' + phone.calls.exec.join());
    const email = run(side, c => c.readRecipients_());
    if (JSON.stringify(email) !== JSON.stringify(s.recipients)) fail('moved', 'the nightly email reads ' + JSON.stringify(email) + ', the app saved ' + JSON.stringify(s.recipients));
    let refused = false;
    try { run(side, c => c.api_saveRecipients_({ recipients: [] })); } catch (e) { refused = /changed in the app now/.test(e.message); }
    if (!refused) fail('moved', 'an older app\'s /exec save was not refused');
    // Emptied on purpose: stays empty through the nightly run.
    await phone.answer('saveRecipients', { recipients: [], gmEdit: true });
    run(side, c => c.nightlyMaintenance_());
    if (s.recipients.length) fail('moved', 'the nightly run copied the Sheet\'s list over an emptied one');
    // Supabase down: the email falls back to the Sheet's list.
    sb.down = true;
    const fallback = run(side, c => c.readRecipients_());
    sb.down = false;
    if (JSON.stringify(fallback) !== JSON.stringify(sheetList)) fail('moved', 'with Supabase down the email read ' + JSON.stringify(fallback));
  }

  // ---- A moved store not copied yet: the first read copies it ----
  {
    const spec = makeStore(3, { realistic: true });
    const sb = new FakeSupabase(spec.now);
    const side = makeSide(spec, script, sb, sb.provision(SLUG), { MOG_EDITOR: 'supabase' });
    run(side, c => c.writeRecipients_([{ name: 'Ana', email: 'ana@example.com', active: true, gm: false }]));
    const first = run(side, c => c.readRecipients_());
    const s = sb.stores.get(SLUG);
    if (!s.recipientsSeeded || first.length !== 1) fail('moved', 'the first read did not copy the list: ' + JSON.stringify(first));
  }

  // ---- Before the move: /exec and the Sheet ----
  {
    const spec = makeStore(4, { realistic: true });
    const sb = new FakeSupabase(spec.now);
    const side = makeSide(spec, script, sb, sb.provision(SLUG));
    run(side, c => { c.pushPinsNow_(); c.pushCatalogNow_(); c.setDbStateFromSheet_(); });
    sb.stores.get(SLUG).phoneDirect = true;
    const phone = PH.makePhone(phoneCode, sb, execPost(side), { slug: SLUG, pin: PIN });
    await phone.answer('ping');
    await phone.answer('getRecipients');
    await phone.answer('saveRecipients', { recipients: [{ name: 'Ana', email: 'ana@example.com', active: true }] });
    if (phone.calls.exec.join() !== 'getRecipients,saveRecipients') fail('sheet', 'before the move Recipients went to ' + phone.calls.exec.join() + ' on /exec');
    if (sb.stores.get(SLUG).recipientsSeeded) fail('sheet', 'a store still on the Sheet got a Supabase list');
    if (run(side, c => c.readRecipientsSheet_()).length !== 1) fail('sheet', 'the /exec save did not reach the Sheet');
  }

  // ---- People ----
  {
    const spec = makeStore(5, { realistic: true });
    const sb = new FakeSupabase(spec.now);
    const side = makeSide(spec, script, sb, sb.provision(SLUG));
    run(side, c => { c.pushPinsNow_(); c.pushCatalogNow_(); c.setDbStateFromSheet_(); });
    const s = sb.stores.get(SLUG);
    s.phoneDirect = true;
    const nameKey = 'mog_name_' + SLUG;
    const phoneA = PH.makePhone(phoneCode, sb, execPost(side), { slug: SLUG, pin: PIN, storage: new Map([[nameKey, 'Maria']]) });
    const phoneB = PH.makePhone(phoneCode, sb, execPost(side), { slug: SLUG, pin: PIN, storage: new Map([[nameKey, 'Luis']]) });
    const tick = async p => { p.run('directExpire_()'); await p.answer('getDashboard'); };
    await phoneA.answer('ping'); await phoneB.answer('ping');
    await tick(phoneA); await tick(phoneB);
    const names = async p => ((await p.answer('getPeople')).data || { people: [] }).people.map(x => x.name);
    if ((await names(phoneB)).join() !== 'Luis,Maria') fail('people', 'list: ' + (await names(phoneB)).join());

    const ren = await phoneB.answer('renamePerson', { from: 'Maria', to: 'Maria G.' });
    if (!ren.ok || ren.data.name !== 'Maria G.') fail('people', 'rename: ' + JSON.stringify(ren));
    await tick(phoneA);
    if (phoneA.store.get(nameKey) !== 'Maria G.') fail('people', 'the phone using the old name still says ' + phoneA.store.get(nameKey));

    await phoneB.answer('removePerson', { name: 'Maria G.' });
    await tick(phoneA);
    if (phoneA.store.has(nameKey)) fail('people', 'a removed name stayed on its phone: ' + phoneA.store.get(nameKey));
    if (phoneA.run('direct.live.askName') !== true) fail('people', 'the phone was not told to ask "Who\'s counting?" again');
    // An older app still sends the removed name: it isn't added back.
    sb.handle('mog_snapshot2', { p_token: Array.from(s.sessions.keys())[0], p_device: 'oldDevice0001', p_name: 'Maria G.' });
    if ((await names(phoneB)).includes('Maria G.')) fail('people', 'a device still holding a removed name added it back');
    const back = await phoneA.answer('joinPerson', { name: 'maria g.' });
    if (!back.ok || back.data.name !== 'Maria G.' || !(await names(phoneB)).includes('Maria G.')) fail('people', 'picking a removed name did not bring it back: ' + JSON.stringify(back));
    const merge = await phoneB.answer('renamePerson', { from: 'Luis', to: 'MARIA G.' });
    if (!merge.ok || (await names(phoneB)).join() !== 'Maria G.') fail('people', 'renaming onto a listed name did not merge: ' + (await names(phoneB)).join());
    const bad = await phoneB.answer('renamePerson', { from: 'Maria G.', to: '' });
    if (bad.ok) fail('people', 'an empty name was accepted');
  }
  return { failures, stats };
}

(async () => {
  let failed = 0;
  const main = await runSuite();
  const st = main.stats;
  console.log(`recipients_people: ${st.cases} random lists (${st.kept} saved, ${st.refused} refused)`);
  if (main.failures.length) {
    failed++;
    console.log(`FAIL  ${main.failures.length} problem(s):`);
    for (const f of main.failures.slice(0, 15)) console.log('      ' + f);
  } else {
    console.log('PASS  the save\'s rules = Recap.gs; Recipients and People move with the editor and work end to end');
  }
  if (!st.refused || !st.kept) { failed++; console.log('FAIL  the random lists never both saved and refused'); }

  const CONTROLS = [
    { name: 'Recap.gs takes an email with no dot', scenario: 'rules', file: 'apps-script/Recap.gs',
      find: "    if (!/^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$/.test(email)) {", replace: "    if (!/^[^\\s@]+@[^\\s@]+$/.test(email)) {" },
    { name: 'the nightly email reads the Sheet after the move', scenario: 'moved', file: 'apps-script/Recap.gs',
      find: '  if (!editorInApp_() || !supabaseConfig_().connected) return readRecipientsSheet_();', replace: '  return readRecipientsSheet_();' },
    { name: 'an older app\'s /exec save still writes the Sheet', scenario: 'moved', file: 'apps-script/Recap.gs',
      find: "  if (editorInApp_()) throw new Error('Recipients are changed in the app now. Reload the app and try again.');", replace: '' },
    { name: 'the GM row unlocked on a phone', scenario: 'moved', file: 'template/index.html',
      find: 'p_gm_edit: payload.gmEdit === true', replace: 'p_gm_edit: true' },
    { name: 'a renamed name not followed', scenario: 'people', file: 'template/index.html',
      find: "    if (typeof data.nameNow === 'string' && data.nameNow && liveName_()) setLiveName_(data.nameNow);", replace: '' },
    { name: 'a removed name kept on its phone', scenario: 'people', file: 'template/index.html',
      find: '      try { localStorage.removeItem(liveNameKey_()); } catch (e) { /* asks again next start */ }', replace: '' }
  ];
  for (const c of CONTROLS) {
    let res;
    try {
      const planted = F.plant(SRC(c.file), c.find, c.replace);
      res = await runSuite(f => (f === c.file ? planted : SRC(f)), 150);
    } catch (e) {
      failed++;
      console.log(`FAIL  control "${c.name}" crashed instead of biting: ${e.message}`);
      continue;
    }
    const hits = res.failures.filter(f => f.includes('[' + c.scenario + ']')).length;
    if (hits) console.log(`PASS  control "${c.name}" bites (${hits} in "${c.scenario}")`);
    else { failed++; console.log(`FAIL  control "${c.name}" did NOT bite "${c.scenario}"`); }
  }
  console.log(failed ? 'recipients_people: ' + failed + ' FAILED' : 'recipients_people: ALL PASS');
  process.exit(failed ? 1 : 0);
})();
