// MOG's nightly close and recap in Supabase (docs/MOG_SheetRetirement_Spec.md,
// step 2: R1, R2, R3, R8). The Edge Function `close` (index.ts) runs it every
// time pg_cron's tick finds something due (supabase/night_schedule.sql).
//
// Pure: no Deno, no database driver, no network of its own. index.ts hands it
// `db` (one call per mog.night_* SQL function, schema_v23.sql) and `mail`
// (relayMailer below: one email through the mail relay, mail-relay/Relay.gs),
// so tests/night_close.test.js runs this same file against the fake Supabase
// and a fake mailer, and tests/mail_relay.test.js runs relayMailer against the
// real Relay.gs.
//
// The order math and the email are the server's own: shared.mjs is
// apps-script/OrderMath.gs, Concepts.gs and RecapEmail.gs, copied in verbatim
// by build.py. Nothing here re-implements them.

import {
  orderInputsFromSnapshot_, orderLogRowsFromInputs_, recapFromLogRows_, conceptTheme_, recapEmailContent_
} from './shared.mjs';

// Sebastian, 2026-11-11: from noreply@hehfood.com, no Reply-To; 2026-11-12:
// sent by the mail relay (MailApp with noReply, Google's no-reply address on
// the domain), not a new email service. The name is the one Apps Script's
// MailApp sends under.
export const RECAP_NAME = 'Master Ordering Guide';

// One run stops picking up new work after this long, well inside the free
// plan's 150 s wall clock; what's left is due again on the next tick.
export const RUN_BUDGET_MS = 100000;

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

// Mon..Sun of a 'YYYY-MM-DD' (Apps Script's formatDate(now, tz, 'EEE') of the
// same day).
export function dowOf(dateStr) {
  return DAYS[new Date(String(dateStr) + 'T12:00:00Z').getUTCDay()];
}

// The close Apps Script's closeCycleInDb_ makes from this snapshot at night:
// the cycle Supabase is on, closed into the store's today (both from the
// snapshot, so in the store's own time zone), its order log worked out by
// OrderMath.gs, and no "today's log" (that's only for a same-day re-close,
// which the night never does). null when the cycle isn't behind today.
export function closeFromSnapshot(snap) {
  const st = (snap && snap.state) || {};
  if (!st.cycleDate || !st.today || !(st.cycleDate < st.today)) return null;
  return {
    closing:   st.cycleDate,
    newCycle:  st.today,
    newDow:    dowOf(st.today),
    rows:      orderLogRowsFromInputs_(orderInputsFromSnapshot_(snap)),
    todaysLog: []
  };
}

// A logged cycle's recap: { subject, text, html }, as Apps Script's
// sendPendingRecap_ builds it from the same log (buildRecapFromLog_ ->
// recapFromLogRows_ -> sendRecapEmail_), with the store's name and its
// concept's colours from mog.stores. null when the log has nothing to order.
export function recapEmail(store, rows, cycleDate) {
  const recap = recapFromLogRows_(rows || [], cycleDate);
  if (!recap.sections.length) return null;
  return recapEmailContent_(String(store.location || ''), conceptTheme_(store.concept),
                            recap.sections, recap.cycleDate, recap.totalItems);
}

// The mail relay keeps a key 6 hours: a second send of the same cycle's
// recap to the same person in that time is answered, not sent. A recap's
// tries are 15 minutes apart, 3 at most.
export function idempotencyKey(slug, cycleDate, email) {
  return ('mog-recap/' + slug + '/' + cycleDate + '/' + String(email || '').trim().toLowerCase()).slice(0, 256);
}

function message(e) {
  return String((e && e.message) || e || 'unknown error').slice(0, 300);
}

// The mailer index.ts gives runNight: one email per POST to the mail relay
// (mail-relay/Relay.gs), a standalone Apps Script that sends it with MailApp.
//   fetchFn  the runtime's fetch (the gate passes one that runs Relay.gs)
//   url      the relay's /exec address
//   secret   MOG_RELAY_SECRET
//   wait     ms => Promise, the pause between tries (the gate passes none)
// Apps Script answers 200 with JSON whatever happened, after a redirect fetch
// follows. Anything that isn't the relay's JSON, and a send the relay
// couldn't make, is tried again, 3 tries in all; a refusal (the secret, a bad
// address) is the answer at once. The key makes a retry safe.
const RELAY_REFUSALS = /^(NOT_ALLOWED|BAD_JSON|BAD_TO|NO_SUBJECT|NO_BODY|TOO_LONG_)/;
export function relayMailer(fetchFn, url, secret, wait) {
  const pause = wait || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  return {
    async send(m) {
      if (!url || /FILL_ME_IN/.test(url)) return { ok: false, error: 'the mail relay address is not set' };
      if (!secret) return { ok: false, error: 'MOG_RELAY_SECRET is not set' };
      const body = JSON.stringify({ secret, to: m.to, subject: m.subject, text: m.text, html: m.html,
                                    name: m.name || '', key: m.idempotencyKey || '' });
      let last = '';
      for (let attempt = 1; attempt <= 3; attempt++) {
        if (attempt > 1) await pause(1000 * (attempt - 1));
        let status = 0, text = '';
        try {
          const res = await fetchFn(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body, redirect: 'follow' });
          status = res.status;
          text = await res.text();
        } catch (e) {
          last = 'network: ' + message(e);
          continue;
        }
        let a = null;
        try { a = JSON.parse(text); } catch (_) { a = null; }
        if (a && a.ok === true) return { ok: true, id: a.duplicate ? 'duplicate' : null };
        if (a && a.error) {
          last = 'relay: ' + String(a.error).slice(0, 200);
          if (RELAY_REFUSALS.test(String(a.error))) break;
          continue;
        }
        last = 'HTTP ' + status + ': ' + text.slice(0, 200);
      }
      return { ok: false, error: last };
    }
  };
}

// One store's close, then its recap at once when the close owes one.
async function runClose(db, mail, slug, nowIso, clock) {
  const t0 = clock();
  const plan = await db.plan(slug, 'close');
  if (!plan || !plan.due) return { slug, step: 'close', due: false, reason: (plan && plan.reason) || null };
  const c = closeFromSnapshot(plan.snapshot);
  if (!c) return { slug, step: 'close', due: false, reason: 'the cycle is not behind today' };
  const r = await db.close(slug, c.closing, c.newCycle, c.newDow, c.rows, nowIso, clock() - t0);
  const d = (r && r.data) || {};
  const out = { slug, step: 'close', ok: !!(r && r.ok), closed: !!d.closed, logged: d.logged || 0,
                cycle: c.closing, error: (r && r.error) || null, heldError: d.heldError || null };
  if (r && r.recapDue) out.recap = await runRecap(db, mail, slug);
  return out;
}

// The recap a close owes: claimed first (one try, counted), then one email
// per active recipient, then the outcome.
async function runRecap(db, mail, slug) {
  const claim = await db.recapClaim(slug);
  if (!claim || !claim.due) return { slug, step: 'recap', due: false, reason: (claim && claim.reason) || null };
  const cycle = claim.cycle;
  const recipients = Array.isArray(claim.recipients) ? claim.recipients : [];
  let email = null;
  try {
    email = recipients.length ? recapEmail(claim, claim.rows, cycle) : null;
  } catch (e) {
    await db.recapDone(slug, cycle, 0, 0, { attempt: claim.attempt, error: 'building the email: ' + message(e) });
    return { slug, step: 'recap', cycle, sent: 0, error: message(e) };
  }
  if (!email) {
    await db.recapDone(slug, cycle, 0, 0, { attempt: claim.attempt, nothing: true,
                                            why: recipients.length ? 'nothing in the log' : 'no active recipients' });
    return { slug, step: 'recap', cycle, sent: 0, nothing: true };
  }
  let sent = 0, failed = 0;
  const errors = [];
  for (const r of recipients) {
    let res;
    try {
      res = await mail.send({ name: RECAP_NAME, to: r.email, subject: email.subject, text: email.text, html: email.html,
                              idempotencyKey: idempotencyKey(slug, cycle, r.email) });
    } catch (e) {
      res = { ok: false, error: message(e) };
    }
    if (res && res.ok) sent++;
    else { failed++; if (errors.length < 5) errors.push(String((res && res.error) || 'failed').slice(0, 200)); }
  }
  await db.recapDone(slug, cycle, sent, failed, Object.assign({ attempt: claim.attempt, recipients: recipients.length },
                                                              errors.length ? { errors } : {}));
  return { slug, step: 'recap', cycle, sent, failed };
}

// A store Apps Script still closes: the close Supabase would make, kept for
// the morning's comparison, written nowhere else.
async function runShadow(db, slug, clock) {
  const t0 = clock();
  const plan = await db.plan(slug, 'shadow');
  if (!plan || !plan.due) return { slug, step: 'shadow', due: false };
  const c = closeFromSnapshot(plan.snapshot);
  if (!c) return { slug, step: 'shadow', due: false };
  await db.shadowDone(slug, c.closing, c.rows, clock() - t0);
  return { slug, step: 'shadow', cycle: c.closing, rows: c.rows.length };
}

// One logged cycle's recap to one address, for a maintainer to see it
// (body: { step: 'test', slug, date, to }). Touches no flag; the address
// isn't logged.
async function runTest(db, mail, body) {
  const slug = String(body.slug || ''), date = String(body.date || ''), to = String(body.to || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) {
    return { ok: false, error: 'a test needs slug, date (YYYY-MM-DD) and to' };
  }
  const data = await db.testData(slug, date);
  if (!data || !data.ok) return { ok: false, error: (data && data.error) || 'no data' };
  const email = recapEmail(data, data.rows, date);
  if (!email) return { ok: false, error: 'nothing in the log for ' + slug + ' on ' + date };
  const res = await mail.send({ name: RECAP_NAME, to, subject: email.subject, text: email.text, html: email.html });
  await db.note(slug, 'test', date, !!(res && res.ok), res && res.ok ? { sent: 1 } : { error: String(res && res.error) });
  return { ok: !!(res && res.ok), subject: email.subject, error: res && res.ok ? null : res && res.error };
}

// ---- The backup watchdog (schema v24) -------------------------------------
// SebHEH/mog-backup writes a heartbeat after each good, matched backup; when
// none is newer than 30 hours, mog.night_due names { step: 'backup' } and
// this sends one email to the watch's address (mog.backup_watch.alert_to),
// at most once a day while it lasts (once an hour after a failed send).

export const BACKUP_ACTIONS_URL = 'https://github.com/SebHEH/mog-backup/actions/workflows/backup.yml';
const NY = 'America/New_York';

// "Thu Nov 12, 5:49 AM" in New York time, as every MOG time is read.
export function nyTime(iso) {
  const d = new Date(String(iso || ''));
  if (isNaN(d.getTime())) return '';
  const p = {};
  for (const x of new Intl.DateTimeFormat('en-US', { timeZone: NY, weekday: 'short', month: 'short', day: 'numeric',
                                                     hour: 'numeric', minute: '2-digit', hour12: true }).formatToParts(d)) {
    p[x.type] = x.value;
  }
  return p.weekday + ' ' + p.month + ' ' + p.day + ', ' + p.hour + ':' + p.minute + ' ' + String(p.dayPeriod || '').toUpperCase();
}

function escHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// The alert (or, with test, the test of it) from mog.backup_status's answer:
// { subject, text, html }.
export function backupAlertEmail(st, test) {
  st = st || {};
  const hours = Number(st.hours);
  const hoursText = isFinite(hours) ? (Math.round(hours * 10) / 10) + ' hours' : 'an unknown time';
  const newest = st.newest
    ? 'The newest good backup: ' + nyTime(st.newest) + ' New York time (run ' + st.run + ').'
    : 'No good backup has been recorded since the watch started, ' + nyTime(st.watchFrom) + ' New York time.';
  let subject, lines;
  if (test) {
    subject = '[TEST] MOG backup watchdog: the newest good backup is ' + hoursText + ' old';
    lines = [
      'This is a test of the MOG backup watchdog. Nothing is wrong because of this email.',
      newest,
      st.stale ? 'That is past the ' + st.staleHours + '-hour limit: a real alert is due too.'
               : 'An alert goes to this address when no good backup is newer than ' + st.staleHours + ' hours.',
      'The nightly backup: ' + BACKUP_ACTIONS_URL
    ];
  } else {
    subject = 'MOG backup: no good backup for ' + hoursText;
    lines = [
      'The nightly backup of MOG\'s database (SebHEH/mog-backup) has not finished a good, matched run for ' + hoursText + '.',
      newest,
      'What to do: open Actions, Nightly backup: ' + BACKUP_ACTIONS_URL,
      'A red run shows what failed. No run at all means the schedule did not start: press Run workflow.',
      'This email comes again once a day until a good backup lands.'
    ];
  }
  const text = lines.join('\n\n') + '\n';
  const html = '<div style="font-family:Arial,sans-serif;font-size:14px;color:#1a1a1a">' +
    lines.map(l => '<p>' + escHtml(l).replace(escHtml(BACKUP_ACTIONS_URL),
      '<a href="' + BACKUP_ACTIONS_URL + '">' + escHtml(BACKUP_ACTIONS_URL) + '</a>') + '</p>').join('') + '</div>';
  return { subject, text, html };
}

// The alert mog.night_due named: claimed first (so a second run doesn't send
// it too), sent, then its outcome kept.
async function runBackup(db, mail) {
  const claim = await db.backupClaim();
  if (!claim || !claim.due) return { step: 'backup', due: false };
  const email = backupAlertEmail(claim, false);
  let res;
  try {
    res = await mail.send({ name: RECAP_NAME, to: claim.to, subject: email.subject, text: email.text, html: email.html,
                            idempotencyKey: 'mog-backup-alert/' + String(claim.claimedAt || '') });
  } catch (e) {
    res = { ok: false, error: message(e) };
  }
  const ok = !!(res && res.ok);
  await db.backupDone('alert', ok, ok ? { sent: 1, hours: claim.hours } : { error: String((res && res.error) || 'failed').slice(0, 200) });
  return { step: 'backup', sent: ok ? 1 : 0, hours: claim.hours, error: ok ? null : String((res && res.error) || 'failed') };
}

// A test of the alert, to the watch's own address only (body: { step:
// 'backup_test' }; night_schedule.sql's mog.backup_watch_test()).
async function runBackupTest(db, mail) {
  const data = await db.backupTest();
  if (!data || !data.ok) return { ok: false, error: (data && data.error) || 'no data' };
  const email = backupAlertEmail(data, true);
  let res;
  try {
    res = await mail.send({ name: RECAP_NAME, to: data.to, subject: email.subject, text: email.text, html: email.html });
  } catch (e) {
    res = { ok: false, error: message(e) };
  }
  const ok = !!(res && res.ok);
  await db.backupDone('test', ok, ok ? { sent: 1 } : { error: String((res && res.error) || 'failed').slice(0, 200) });
  return { ok, subject: email.subject, error: ok ? null : res && res.error };
}

// The function's whole job. body.step 'test' sends a test email, and
// 'backup_test' a test of the backup alert; anything else does whatever
// mog.night_due names, closes first, one at a time, each in its own try so
// one store's failure leaves the others alone (and is logged; it's due again
// on the next tick).
//   opts.now()   the run's clock as a Date (tests set it)
//   opts.clock() milliseconds, for timings and the run's budget
export async function runNight(db, mail, body, opts) {
  opts = opts || {};
  const now = opts.now || (() => new Date());
  const clock = opts.clock || (() => Date.now());
  body = body || {};
  if (body.step === 'test') return runTest(db, mail, body);
  if (body.step === 'backup_test') return runBackupTest(db, mail);

  const started = clock();
  const due = (await db.due()) || [];
  const ran = [];
  for (const d of due) {
    if (clock() - started > RUN_BUDGET_MS) { ran.push({ slug: d.slug, step: d.step, skipped: 'out of time; due again next run' }); continue; }
    try {
      if (d.step === 'close') ran.push(await runClose(db, mail, d.slug, now().toISOString(), clock));
      else if (d.step === 'recap') ran.push(await runRecap(db, mail, d.slug));
      else if (d.step === 'shadow') ran.push(await runShadow(db, d.slug, clock));
      else if (d.step === 'backup') ran.push(await runBackup(db, mail));
    } catch (e) {
      ran.push({ slug: d.slug, step: d.step, error: message(e) });
      try { await db.note(d.slug, d.step, null, false, { error: message(e) }); } catch (e2) { /* the run's answer still has it */ }
    }
  }
  return { ok: true, ran };
}
