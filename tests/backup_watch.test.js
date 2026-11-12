'use strict';
// GATE: the backup watchdog (schema_v24.sql; supabase/functions/close/core.mjs's
// runBackup and runBackupTest). SebHEH/mog-backup writes a heartbeat after
// each good, matched backup; when none is newer than 30 hours, the night's
// list names { step: 'backup' } and the Edge Function `close` emails the
// watch's one address through the mail relay.
//
//   A. The alert, by core.mjs's runNight against the fake Supabase (whose
//      mog.backup_* copies smoke_v24.sql pins to the SQL): nothing without an
//      address or before 30 hours; one email at 31 hours to the address,
//      with the hours, the watch's start and the Actions link; not again for
//      a day; a failed send kept with its error and tried again after an
//      hour, not before; a heartbeat ends it and the next alert names it;
//      each claim its own idempotency key.
//   B. The test email: refused without an address, else one [TEST] email to
//      the address, kept apart from the alert.
//   C. Times read in New York (winter and summer).
//   D. index.ts calls the SQL functions schema_v24.sql defines.
// Planted-defect controls on core.mjs.
//
// Run bare: node tests/backup_watch.test.js     ends "backup_watch: ALL PASS"

const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');
const F = require('./fake_apps_script.js');
const { FakeSupabase } = require('./fake_supabase.js');

const H = 3600000;
const T0 = Date.UTC(2026, 10, 12, 15, 0, 0);   // the watch starts: Thu Nov 12, 10:00 AM New York
const TO = 'watch@example.com';
const CORE = 'supabase/functions/close/core.mjs';
const clone = v => JSON.parse(JSON.stringify(v === undefined ? null : v));
const read = f => fs.readFileSync(path.join(F.REPO, f), 'utf8');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'mog-backup-watch-'));
let loads = 0;
async function loadCore(coreSrc) {
  const dir = path.join(TMP, String(++loads));
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, 'shared.mjs'), read('supabase/functions/close/shared.mjs'));
  fs.writeFileSync(path.join(dir, 'core.mjs'), coreSrc);
  return import(pathToFileURL(path.join(dir, 'core.mjs')).href);
}

// The db index.ts gives runNight, on the fake; answers cross JSON as on the wire.
function makeDb(sb) {
  return {
    secretOk: async s => s === 'secret',
    due: async () => clone(sb.nightDue(sb.nowMs)),
    plan: async () => ({ due: false }),
    note: async () => null,
    backupClaim: async () => clone(sb.backupAlertClaim(sb.nowMs)),
    backupDone: async (kind, ok, detail) => clone(sb.backupAlertDone(kind, ok, clone(detail), sb.nowMs)),
    backupTest: async () => clone(sb.backupTestData(sb.nowMs))
  };
}
function makeMail() {
  const m = { sent: [], tried: 0, failing: false };
  m.send = async msg => {
    m.tried++;
    if (m.failing) return { ok: false, error: 'HTTP 500: fake outage' };
    m.sent.push(clone(msg));
    return { ok: true, id: 'fake-' + m.sent.length };
  };
  return m;
}

async function suite(core) {
  const fails = [];
  const bad = (part, what, got) => fails.push(part + ': ' + what + (got === undefined ? '' : ' :: ' + JSON.stringify(got).slice(0, 240)));
  const sb = new FakeSupabase(T0);
  const mail = makeMail();
  const at = ms => { sb.nowMs = ms; };
  const night = body => core.runNight(makeDb(sb), mail, body || {}, { now: () => new Date(sb.nowMs), clock: () => 0 });

  // ---- A. The alert ----
  at(T0 + 31 * H);
  await night();
  if (mail.tried) bad('A', 'no address: nothing is sent', mail.sent);
  sb.backupWatch.alertTo = TO;
  at(T0 + 29 * H);
  await night();
  if (mail.tried) bad('A', '29 hours: nothing is sent', mail.sent);

  at(T0 + 31 * H);
  const r1 = await night();
  const a1 = mail.sent[0];
  if (mail.sent.length !== 1 || !a1 || a1.to !== TO) bad('A', '31 hours: one email to the watch\'s address', mail.sent);
  else {
    if (a1.subject !== 'MOG backup: no good backup for 31 hours') bad('A', 'the subject names the hours', a1.subject);
    if (a1.text.indexOf('No good backup has been recorded since the watch started, Thu Nov 12, 10:00 AM New York time.') < 0) bad('A', 'the text names the watch\'s start in New York time', a1.text);
    if (a1.text.indexOf('https://github.com/SebHEH/mog-backup/actions/workflows/backup.yml') < 0) bad('A', 'the text has the Actions link', a1.text);
    if (a1.html.indexOf('<a href="https://github.com/SebHEH/mog-backup/actions/workflows/backup.yml">') < 0) bad('A', 'the HTML links it', a1.html);
    if (a1.name !== 'Master Ordering Guide') bad('A', 'sent under the recaps\' name', a1.name);
    if (!/^mog-backup-alert\/2026-11-13T22:00:00/.test(a1.idempotencyKey || '')) bad('A', 'the key is the claim\'s', a1.idempotencyKey);
  }
  if (!r1.ran.some(x => x.step === 'backup' && x.sent === 1)) bad('A', 'the run reports it', r1);
  if (sb.backupWatch.lastAlertOk !== true || sb.backupWatch.lastAlertAt !== T0 + 31 * H) bad('A', 'the send is kept as done', sb.backupWatch);

  at(T0 + 31 * H + 15 * 60000);
  await night();
  at(T0 + 54 * H + 45 * 60000);
  await night();
  if (mail.tried !== 1) bad('A', 'not again within the day', mail.tried);
  at(T0 + 55 * H);
  await night();
  if (mail.sent.length !== 2) bad('A', 'again a day later', mail.sent.length);
  else if (mail.sent[1].idempotencyKey === mail.sent[0].idempotencyKey) bad('A', 'each claim its own key', mail.sent[1].idempotencyKey);

  mail.failing = true;
  at(T0 + 79 * H);
  await night();
  const tried = mail.tried;
  if (sb.backupWatch.lastAlertOk !== false || !/fake outage/.test(JSON.stringify(sb.backupWatch.lastAlertDetail))) bad('A', 'a failed send is kept with its error', sb.backupWatch);
  at(T0 + 79 * H + 45 * 60000);
  await night();
  if (mail.tried !== tried) bad('A', 'a failed send is not tried again within the hour', mail.tried - tried);
  mail.failing = false;
  at(T0 + 80 * H);
  await night();
  if (mail.sent.length !== 3) bad('A', 'a failed send is tried again after an hour', mail.sent.length);

  at(T0 + 81 * H);
  sb.backupHeartbeat('19300000001', 37, 17766, 727000);   // Sun Nov 15, 7:00 PM New York
  at(T0 + 110 * H);
  await night();
  if (mail.sent.length !== 3) bad('A', 'a heartbeat 29 hours ago: nothing is sent', mail.sent.length);
  at(T0 + 112 * H);
  await night();
  const a4 = mail.sent[3];
  if (!a4 || a4.subject !== 'MOG backup: no good backup for 31 hours'
      || a4.text.indexOf('The newest good backup: Sun Nov 15, 7:00 PM New York time (run 19300000001).') < 0) bad('A', 'after a heartbeat, the alert names it', a4);

  // ---- B. The test email ----
  const before = clone(sb.backupWatch);
  sb.backupWatch.alertTo = null;
  const t0 = await night({ step: 'backup_test' });
  if (t0.ok || t0.error !== 'NO_ADDRESS' || mail.sent.length !== 4) bad('B', 'no address: refused, nothing sent', t0);
  sb.backupWatch.alertTo = TO;
  const t1 = await night({ step: 'backup_test' });
  const e = mail.sent[4];
  if (!t1.ok || !e || e.to !== TO || !/^\[TEST\] MOG backup watchdog: the newest good backup is 31 hours old$/.test(e.subject)) bad('B', 'one [TEST] email to the address', [t1, e]);
  if (e && e.text.indexOf('That is past the 30-hour limit: a real alert is due too.') < 0) bad('B', 'the test says a real alert is due when it is', e && e.text);
  if (sb.backupWatch.lastTestOk !== true || sb.backupWatch.lastAlertAt !== before.lastAlertAt || sb.backupWatch.lastAlertOk !== before.lastAlertOk) bad('B', 'kept apart from the alert', sb.backupWatch);

  // ---- C. New York time ----
  if (core.nyTime('2026-11-12T10:49:00Z') !== 'Thu Nov 12, 5:49 AM') bad('C', 'winter', core.nyTime('2026-11-12T10:49:00Z'));
  if (core.nyTime('2026-07-01T09:47:00Z') !== 'Wed Jul 1, 5:47 AM') bad('C', 'summer', core.nyTime('2026-07-01T09:47:00Z'));
  return fails;
}

function staticChecks() {
  const fails = [];
  const idx = read('supabase/functions/close/index.ts');
  const v24 = read('supabase/schema_v24.sql');
  for (const [call, def] of [['mog.backup_alert_claim()', 'create or replace function mog.backup_alert_claim(p_at timestamptz default now())'],
                             ['mog.backup_alert_done(${kind}, ${ok}, ${sql.json(detail as any)})', 'create or replace function mog.backup_alert_done(p_kind text, p_ok boolean, p_detail jsonb, p_at timestamptz default now())'],
                             ['mog.backup_test_data()', 'create or replace function mog.backup_test_data(p_at timestamptz default now())']]) {
    if (idx.indexOf(call) < 0) fails.push('D: index.ts calls ' + call);
    if (v24.indexOf(def) < 0) fails.push('D: schema_v24.sql defines ' + def);
  }
  return fails;
}

const CONTROLS = [
  { name: 'the night never runs the alert', find: "      else if (d.step === 'backup') ran.push(await runBackup(db, mail));\n", replace: '' },
  { name: 'the test step is not routed', find: "  if (body.step === 'backup_test') return runBackupTest(db, mail);\n", replace: '' },
  { name: 'the alert goes to another address', find: '    res = await mail.send({ name: RECAP_NAME, to: claim.to,', replace: "    res = await mail.send({ name: RECAP_NAME, to: 'x@example.com'," },
  { name: 'a failed send keeps no error', find: "  await db.backupDone('alert', ok, ok ? { sent: 1, hours: claim.hours } : { error:", replace: "  if (ok) await db.backupDone('alert', ok, ok ? { sent: 1, hours: claim.hours } : { error:" },
  { name: 'the test is kept as the alert', find: "  await db.backupDone('test', ok,", replace: "  await db.backupDone('alert', ok," },
  { name: 'the subject drops the hours', find: "    subject = 'MOG backup: no good backup for ' + hoursText;", replace: "    subject = 'MOG backup: no good backup';" },
  { name: 'the Actions link dropped', find: "      'What to do: open Actions, Nightly backup: ' + BACKUP_ACTIONS_URL,", replace: "      'What to do: open Actions, Nightly backup.'," },
  { name: 'times read in UTC', find: "new Intl.DateTimeFormat('en-US', { timeZone: NY,", replace: "new Intl.DateTimeFormat('en-US', { timeZone: 'UTC'," },
  { name: 'one key for every claim', find: "idempotencyKey: 'mog-backup-alert/' + String(claim.claimedAt || '') });", replace: "idempotencyKey: 'mog-backup-alert/' });" }
];

(async () => {
  try {
    const plain = read(CORE);
    const fails = (await suite(await loadCore(plain))).concat(staticChecks());
    if (fails.length) {
      console.log('FAIL  ' + fails.length + ' problem(s):');
      for (const f of fails) console.log('  ' + f);
      process.exitCode = 1;
      return;
    }
    console.log('PASS  the alert: nothing before 30 hours or without an address, one email, once a day, a failed one an hour later, a heartbeat ends it');
    console.log('PASS  the test email goes to the watch\'s address only, kept apart; times in New York; index.ts calls v24\'s functions');
    let missed = 0;
    for (const c of CONTROLS) {
      const planted = F.plant(plain, c.find, c.replace);
      let caught;
      try { caught = (await suite(await loadCore(planted))).length > 0; } catch (e) { caught = true; }
      if (!caught) { missed++; console.log('FAIL  control not caught: ' + c.name); }
    }
    if (missed) { process.exitCode = 1; return; }
    console.log('PASS  all ' + CONTROLS.length + ' planted defects caught');
    console.log('backup_watch: ALL PASS');
  } catch (e) {
    console.log('FAIL  ' + (e.stack || e));
    process.exitCode = 1;
  } finally {
    try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) { /* temp */ }
  }
})();
