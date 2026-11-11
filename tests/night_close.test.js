'use strict';
// GATE: Sheet retirement step 2 (docs/MOG_SheetRetirement_Spec.md, R1, R2,
// R8; success criteria 1 and 2). Supabase's nightly close and recap
// (supabase/functions/close/core.mjs, schema_v23.sql) must do what each
// store's Apps Script does today, and a cycle's recap must go out once,
// whoever sends it.
//
//   A. Close parity, on randomized stores moved to the fake Supabase by the
//      real Sync.gs: the same store closed twice, once by Apps Script's
//      closeCycleInDb_ (then its sendPendingRecap_), once by core.mjs's
//      runNight with close_direct on. Same closing day, new cycle and day,
//      the same rows sent (deep-equal p_rows), the same order log and new
//      cycle state, the same emails to the same people (subject, plain text
//      and HTML byte for byte), and the flag set on both.
//   B. The email, moved out of Recap.gs: the old sendRecapEmail_ (commit
//      e322e65, before the move) and the new one give MailApp the same
//      arguments, and core.mjs builds the same subject, text and HTML, for
//      every concept and awkward names (&, <, quotes, empty packs, blank on
//      hand).
//   C. Once per cycle, across the three senders: the Daily summary first
//      means no nightly recap; a failed send is tried again 15 minutes on,
//      never twice in one window, at most 3 times; a recap Supabase sent
//      stops Apps Script's own pending send; the 3:30 AM trigger retires
//      itself once close_direct is on (and only then); the shadow writes
//      nothing but its log row; nothing before 3:30; the test email touches
//      no flag; one store's failure leaves the others alone.
//   D. supabase/functions/close/shared.mjs holds OrderMath.gs, Concepts.gs
//      and RecapEmail.gs as they are now (python build.py rewrites it).
//   E. Concepts.gs and RecapEmail.gs are pure (they run with nothing).
// Every part has planted-defect controls.
//
// Run bare: node tests/night_close.test.js [stores]   (default 30)
// A passing run ends with "night_close: ALL PASS".

process.env.TZ = 'UTC';   // the fake formatDate is UTC; so is the fake Supabase's "today"

const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const { execFileSync } = require('child_process');
const { pathToFileURL } = require('url');
const F = require('./fake_apps_script.js');
const { makeStore, mulberry32 } = require('./mog_fixture.js');
const { FakeSupabase, fakeScriptApp, fakeContentService } = require('./fake_supabase.js');

const STORES = Number(process.argv[2]) || 30;
const BASE = 'e322e65';   // the last commit with the email inside Recap.gs sendRecapEmail_
const SLUG = 'zztest';
const PIN = '1111';
const DAY = 86400000;
const LOCATION = 'Roll Play Rosslyn FOH';
const RECIPIENTS = [{ name: 'GM', email: 'gm@example.com', active: true, gm: true },
                    { name: 'Off', email: 'off@example.com', active: false, gm: false },
                    { name: 'KM', email: 'km@example.com', active: true, gm: false }];
const CLOSE_SOURCES = ['OrderMath.gs', 'Concepts.gs', 'RecapEmail.gs'];
const CLOSE_EXPORTS = ['orderInputsFromSnapshot_', 'orderLogRowsFromInputs_', 'recapFromLogRows_', 'conceptTheme_', 'recapEmailContent_'];
const SRC = file => F.source(null, file);
const plain = SRC;
const GS = fs.readdirSync(path.join(F.REPO, 'apps-script')).filter(f => f.endsWith('.gs')).sort();
const NEW_EXECUTION = new vm.Script('_SB_CONFIG_ = null; _SB_SNAPSHOT_ = null; MOG_MUTATED_ = false; MOG_SKIP_CATALOG_QUEUE_ = false; _SHEET_CACHE_.clear(); _dashThemeCache = null;');
const run = (side, fn) => { NEW_EXECUTION.runInContext(side.ctx); return fn(side.ctx); };
const clone = v => JSON.parse(JSON.stringify(v === undefined ? null : v));
const lf = s => String(s).replace(/\r\n/g, '\n');

// ---- core.mjs, loaded from a copy so a control can plant into it or the .gs --------
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'mog-night-close-'));
let loads = 0;
function sharedModule(srcOf) {
  return CLOSE_SOURCES.map(f => lf(srcOf('apps-script/' + f))).join('\n') + '\nexport { ' + CLOSE_EXPORTS.join(', ') + ' };\n';
}
async function loadCore(srcOf) {
  const dir = path.join(TMP, String(++loads));
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, 'shared.mjs'), sharedModule(srcOf));
  fs.writeFileSync(path.join(dir, 'core.mjs'), srcOf('supabase/functions/close/core.mjs'));
  return import(pathToFileURL(path.join(dir, 'core.mjs')).href);
}

// ---- The database and the mailer the function gets -----------------------------
// index.ts calls the mog.night_* SQL; here the fake's copies (fake_supabase.js,
// pinned to the SQL by smoke_v23.sql). Arguments and answers cross JSON, as
// they cross the wire.
function makeDb(sb, opts) {
  const j = v => clone(v);
  const guard = (slug) => { if (opts && opts.failFor === slug) throw new Error('database unreachable for ' + slug); };
  return {
    secretOk: async s => s === 'secret',
    due: async () => j(sb.nightDue(sb.nowMs)),
    plan: async (slug, step) => { guard(slug); return j(sb.nightPlan(slug, step, sb.nowMs)); },
    close: async (slug, closing, newCycle, dow, rows, at, ms) => j(sb.nightClose(slug, closing, newCycle, dow, j(rows), at, ms)),
    recapClaim: async slug => { guard(slug); return j(sb.nightRecapClaim(slug, sb.nowMs)); },
    recapDone: async (slug, cycle, sent, failed, detail) => j(sb.nightRecapDone(slug, cycle, sent, failed, j(detail))),
    shadowDone: async (slug, cycle, rows, ms) => { sb.nightShadowDone(slug, cycle, j(rows), ms); return null; },
    testData: async (slug, date) => j(sb.nightTestData(slug, date)),
    note: async (slug, step, cycle, ok, detail) => { sb.nightNote(slug, step, cycle, ok, j(detail)); return null; }
  };
}
function makeMail(failing) {
  const m = { sent: [], tried: 0, failing: failing || (() => false) };
  m.send = async msg => {
    m.tried++;
    if (m.failing(msg)) return { ok: false, error: 'HTTP 500: fake outage' };
    m.sent.push(clone(msg));
    return { ok: true, id: 'fake-' + m.sent.length };
  };
  return m;
}
const night = (core, sb, mail, body, opts) =>
  core.runNight(makeDb(sb, opts), mail, body || {}, { now: () => new Date(sb.nowMs), clock: () => 0 });

// ---- A store moved to the fake Supabase by the real Sync.gs (history_app's way) -
function makeStoreSpec(seed) {
  const spec = makeStore(seed, { realistic: true });
  // One row per item id, so the Sheet's pars and the catalog's agree.
  const master = spec.sheets.MASTER_ITEMS, seen = new Set();
  spec.sheets.MASTER_ITEMS = [master[0]].concat(master.slice(1).filter(r => {
    const id = String(r[0] || '').trim();
    if (!id || seen.has(id)) return false;
    seen.add(id);
    return true;
  }));
  return spec;
}

function makeSide(spec, script, sb, key, concept) {
  const mails = [];
  const lock = { waitLock() {}, tryLock() { return true; }, releaseLock() {}, hasLock() { return true; } };
  const scriptApp = fakeScriptApp();
  const side = F.makeContext(Object.assign({}, spec, { scriptProps: Object.assign({}, spec.scriptProps, {
    MOG_SUPABASE_SLUG: SLUG, MOG_SUPABASE_SYNC_KEY: key, MOG_BACKEND: 'supabase', MOG_API_PIN: PIN,
    MOG_LOCATION_NAME: LOCATION, MOG_CONCEPT: concept }) }), {
    UrlFetchApp: sb.urlFetchApp(), ScriptApp: scriptApp, ContentService: fakeContentService,
    LockService: { getScriptLock: () => lock, getDocumentLock: () => lock },
    Session: { getScriptTimeZone: () => 'UTC', getActiveUser: () => ({ getEmail: () => '' }), getEffectiveUser: () => ({ getEmail: () => '' }) },
    MailApp: { sendEmail: o => { mails.push(clone(o)); } },
    Logger: { log: () => {} }
  });
  script.runInContext(side.ctx);
  side.ctx.readRecipients_ = () => clone(RECIPIENTS);
  side.mails = mails;
  side.scriptApp = scriptApp;
  side.setClock = ms => vm.runInContext('__FIX=' + Number(ms), side.ctx);
  return side;
}

// One store, moved; its clock at 3:35 AM UTC the day after the store's day.
function movedStore(seed, script, concept) {
  const spec = makeStoreSpec(seed);
  const sb = new FakeSupabase(spec.now);
  const key = sb.provision(SLUG);
  const side = makeSide(spec, script, sb, key, concept);
  run(side, c => { c.pushPinsNow_(); c.pushCatalogNow_(); c.setDbStateFromSheet_(); c.importSheetCountsToDb_(); });
  const s = sb.stores.get(SLUG);
  s.recipients = clone(RECIPIENTS);
  s.location = LOCATION;
  s.concept = concept;
  const day = spec.now - (spec.now % DAY);
  const at = (h, m, plusDays) => day + (plusDays === undefined ? 1 : plusDays) * DAY + h * 3600000 + m * 60000;
  return { spec, sb, key, side, s, at, setAt: ms => { sb.nowMs = ms; side.setClock(ms); } };
}

const CONCEPTS = ['roll-play', 'teasnyou', 'an', 'leid', '', 'not-a-concept'];

// ---- The suite --------------------------------------------------------------------
async function runSuite(srcOf, seeds) {
  srcOf = srcOf || plain;
  const failures = [];
  const fail = (where, what) => failures.push(where + ': ' + what);
  const same = (where, label, a, b) => { const d = F.deepDiff(clone(a), clone(b)); if (d) fail(where, label + ': ' + d); };
  const stats = { stores: 0, withRows: 0, rows: 0, emails: 0, emailCases: 0, scenarios: 0 };
  const script = new vm.Script(GS.map(f => srcOf('apps-script/' + f)).join('\n'), { filename: 'all-gs.js' });
  const core = await loadCore(srcOf);

  // ---- A. Close parity --------------------------------------------------------------
  const rowSeeds = [];
  for (const seed of seeds) {
    const where = 'A seed ' + seed;
    try {
      const concept = CONCEPTS[seed % CONCEPTS.length];
      const A = movedStore(seed, script, concept);
      const B = movedStore(seed, script, concept);
      const night330 = A.at(3, 35);
      A.setAt(night330); B.setAt(night330);
      if (!(A.s.state.cycleDate < A.sb.today())) { fail(where, 'the fixture cycle is not behind (' + A.s.state.cycleDate + ')'); continue; }
      same(where, 'both copies start equal', { log: A.s.log, state: A.s.state }, { log: B.s.log, state: B.s.state });

      // Apps Script closes A, then sends its recap the way its trigger does.
      let sent = null;
      const orig = A.sb.handle.bind(A.sb);
      A.sb.handle = (fn, p) => { if (fn === 'mog_sync_close_cycle') sent = clone(p); return orig(fn, p); };
      const snap = clone(orig('mog_sync_get_snapshot', { p_slug: SLUG, p_key: A.key }).data);
      const res = run(A.side, c => c.closeCycleInDb_());
      if (res.skippedReason) fail(where, 'Apps Script did not close: ' + JSON.stringify(res));
      run(A.side, c => c.sendPendingRecap_());

      // Supabase closes B.
      B.s.closeDirect = true;
      const mailB = makeMail();
      const out = await night(core, B.sb, mailB);

      // The same close, from the same snapshot.
      const plan = core.closeFromSnapshot(clone(snap));
      if (!sent) { fail(where, 'Apps Script sent no close'); continue; }
      if (!plan) { fail(where, 'core.mjs plans no close'); continue; }
      same(where, 'closing day', plan.closing, sent.p_closing);
      same(where, 'new cycle', plan.newCycle, sent.p_new_cycle);
      same(where, 'new day of week', plan.newDow, sent.p_new_dow);
      same(where, 'rows sent', plan.rows, sent.p_rows);
      same(where, "today's log", plan.todaysLog, sent.p_todays_log);
      const strip = log => log.map(r => Object.assign({}, r, { loggedAt: null }));
      same(where, 'order log written', strip(B.s.log), strip(A.s.log));
      same(where, 'new cycle state', B.s.state, A.s.state);
      const closeRow = (B.sb.nightLog || []).find(g => g.step === 'close');
      if (!closeRow || !closeRow.ok) fail(where, 'no ok close row in the night log: ' + JSON.stringify(out));

      // The same emails, to the same people.
      const aMails = A.side.mails, bMails = mailB.sent;
      same(where, 'email recipients', bMails.map(m => m.to), aMails.map(m => m.to));
      for (let i = 0; i < Math.min(aMails.length, bMails.length); i++) {
        same(where, 'email ' + i + ' subject', bMails[i].subject, aMails[i].subject);
        same(where, 'email ' + i + ' text', bMails[i].text, aMails[i].body);
        same(where, 'email ' + i + ' html', bMails[i].html, aMails[i].htmlBody);
        if (aMails[i].name !== 'Master Ordering Guide' || bMails[i].from !== 'Master Ordering Guide <noreply@hehfood.com>') {
          fail(where, 'sender: ' + aMails[i].name + ' / ' + bMails[i].from);
        }
      }
      if (sent.p_rows.length && !bMails.length) fail(where, 'rows were logged but Supabase sent no recap');
      if (bMails.length) {
        same(where, 'flag (Supabase)', B.s.recapSentFor, plan.closing);
        same(where, 'flag (Apps Script)', A.s.recapSentFor, plan.closing);
        const keys = new Set(bMails.map(m => m.idempotencyKey));
        if (keys.size !== bMails.length || !bMails.every(m => m.idempotencyKey.indexOf(SLUG + '/' + plan.closing + '/') >= 0)) {
          fail(where, 'idempotency keys: ' + bMails.map(m => m.idempotencyKey).join(', '));
        }
      }

      // A second run at once, and 20 minutes on: nothing more.
      const before = { log: clone(B.s.log), state: clone(B.s.state) };
      await night(core, B.sb, mailB);
      B.setAt(night330 + 20 * 60000);
      await night(core, B.sb, mailB);
      same(where, 'a second run changes nothing', { log: B.s.log, state: B.s.state }, before);
      if (mailB.sent.length !== bMails.length) fail(where, 'a second run sent more email');

      stats.stores++;
      stats.rows += sent.p_rows.length;
      stats.emails += bMails.length;
      if (sent.p_rows.length) { stats.withRows++; rowSeeds.push(seed); }
    } catch (e) {
      fail(where, 'threw: ' + (e.stack || e));
    }
  }
  if (!rowSeeds.length) fail('A', 'no store had anything to order: the fixture proves nothing about the recap');

  // ---- B. The email, moved out of Recap.gs -----------------------------------------
  try {
    const oldScript = new vm.Script(oldGsFiles().map(f => F.source(BASE, 'apps-script/' + f)).join('\n'), { filename: 'old-gs.js' });
    const r = mulberry32(2311);
    const pick = a => a[Math.floor(r() * a.length)];
    const names = ['Shrimp', 'Tea <Jasmine>', 'Cups & Lids', '"Big" Bowls', "Lei'd sauce", 'Ăn noodles', '  Spaced  ', ''];
    const vendors = ['Sysco', 'B&T Distributors LLC', 'Elpis <Wholesale>', 'Restaurant Depot', 'q"uote'];
    for (let n = 0; n < 60; n++) {
      const concept = pick(CONCEPTS.concat(['TEASNYOU ', 'default']));
      const location = pick([LOCATION, "Teas'n You Tysons FOH", 'A & B <Store>', '']);
      const rows = [];
      for (let i = 0, k = 1 + Math.floor(r() * 9); i < k; i++) {
        rows.push({ vendor: pick(vendors), id: 'ITEM-' + i, name: pick(names), pack: pick(['', 'CASE (10LBs)', 'BAG <5>']),
                    area: pick(['', 'Freezer']), onHandPrev: pick([null, '', 0, 2.5, 3, '4']), qty: pick([1, 2, 0.5, 12, 3.25]) });
      }
      const date = '2026-11-' + String(10 + (n % 19)).padStart(2, '0');
      const ctxFor = (scr) => {
        const mails = [];
        const side = F.makeContext({ now: Date.UTC(2026, 10, 11, 9), sheets: {}, scriptProps: { MOG_LOCATION_NAME: location, MOG_CONCEPT: concept } },
          { MailApp: { sendEmail: o => { mails.push(clone(o)); } }, Logger: { log: () => {} } });
        scr.runInContext(side.ctx);
        side.mails = mails;
        return side;
      };
      const oldSide = ctxFor(oldScript), newSide = ctxFor(script);
      const recap = clone(vm.runInContext('recapFromLogRows_', newSide.ctx)(clone(rows), date));
      if (!recap.sections.length) continue;
      oldSide.ctx.sendRecapEmail_('a@example.com', clone(recap.sections), recap.cycleDate, recap.totalItems);
      newSide.ctx.sendRecapEmail_('a@example.com', clone(recap.sections), recap.cycleDate, recap.totalItems);
      same('B case ' + n + ' (' + JSON.stringify(concept) + ')', 'MailApp arguments, old vs new', newSide.mails, oldSide.mails);
      const fnMail = core.recapEmail({ location, concept }, clone(rows), date);
      const o = oldSide.mails[0] || {};
      same('B case ' + n + ' (' + JSON.stringify(concept) + ')', 'core.mjs vs the old email',
           { subject: fnMail && fnMail.subject, text: fnMail && fnMail.text, html: fnMail && fnMail.html },
           { subject: o.subject, text: o.body, html: o.htmlBody });
      stats.emailCases++;
    }
  } catch (e) {
    fail('B', 'threw: ' + (e.stack || e));
  }

  // ---- C. Once per cycle, across the senders ----------------------------------------
  const seedC = rowSeeds[0];
  if (seedC) {
    const scen = (label, fn) => { stats.scenarios++; return fn().catch(e => fail('C ' + label, 'threw: ' + (e.stack || e))); };

    await scen('the Daily summary first', async () => {
      const X = movedStore(seedC, script, 'roll-play');
      const cycle = X.s.state.cycleDate;
      const day = run(X.side, c => c.api_emailRecap_({ force: false }));
      if (!day.sentCount) { fail('C Daily summary first', 'the Daily summary sent nothing: ' + JSON.stringify(day)); return; }
      if (X.s.recapSentFor !== cycle) fail('C Daily summary first', 'Apps Script did not mark the flag in Supabase (' + X.s.recapSentFor + ')');
      const again = run(X.side, c => c.api_emailRecap_({ force: false }));
      if (!again.alreadySent) fail('C Daily summary first', 'a second auto-send went out');
      X.s.closeDirect = true;
      X.setAt(X.at(3, 35));
      const mail = makeMail();
      await night(core, X.sb, mail);
      if (X.s.state.cycleDate === cycle) fail('C Daily summary first', 'the night did not close');
      if (mail.sent.length) fail('C Daily summary first', 'a nightly recap went out after the Daily summary (' + mail.sent.length + ')');
      const row = (X.sb.nightLog || []).find(g => g.step === 'close');
      if (!row || row.detail.recap !== 'already sent') fail('C Daily summary first', 'close row: ' + JSON.stringify(row));
    });

    await scen('a failed send is tried again', async () => {
      const X = movedStore(seedC, script, 'teasnyou');
      X.s.closeDirect = true;
      const t0 = X.at(3, 30);
      X.setAt(t0);
      let down = true;
      const mail = makeMail(() => down);
      await night(core, X.sb, mail);
      const cycle = X.s.recapDue;
      if (!cycle || mail.sent.length || X.s.recapSentFor) fail('C retry', 'first try: due ' + cycle + ', sent ' + mail.sent.length);
      X.setAt(t0 + 60000); down = false;
      await night(core, X.sb, mail);
      if (mail.sent.length) fail('C retry', 'a second try inside 15 minutes');
      X.setAt(t0 + 16 * 60000);
      await night(core, X.sb, mail);
      const active = RECIPIENTS.filter(r => r.active).length;
      if (mail.sent.length !== active || X.s.recapSentFor !== cycle || X.s.recapDue) {
        fail('C retry', 'second try: sent ' + mail.sent.length + ', flag ' + X.s.recapSentFor + ', due ' + X.s.recapDue);
      }
      X.setAt(t0 + 32 * 60000);
      await night(core, X.sb, mail);
      if (mail.sent.length !== active) fail('C retry', 'sent again after it went out');
      const states = (X.sb.nightLog || []).filter(g => g.step === 'recap').map(g => g.detail.state);
      same('C retry', 'recap rows', states, ['try again', 'sent']);

      // Apps Script's own pending send for that cycle now sends nothing.
      run(X.side, c => { c.PropertiesService.getScriptProperties().setProperty('MOG_PENDING_RECAP', JSON.stringify({ cycleDate: cycle, attempts: 0 })); c.sendPendingRecap_(); });
      if (X.side.mails.length) fail('C retry', 'Apps Script sent a second recap for a cycle Supabase sent (' + X.side.mails.length + ')');
    });

    await scen('three failed tries give up', async () => {
      const X = movedStore(seedC, script, 'an');
      X.s.closeDirect = true;
      const t0 = X.at(3, 30);
      const mail = makeMail(() => true);
      for (let i = 0; i < 5; i++) { X.setAt(t0 + i * 16 * 60000); await night(core, X.sb, mail); }
      const active = RECIPIENTS.filter(r => r.active).length;
      if (mail.tried !== 3 * active || X.s.recapTries !== 3 || X.s.recapSentFor) {
        fail('C give up', 'tried ' + mail.tried + ' sends, ' + X.s.recapTries + ' tries, flag ' + X.s.recapSentFor);
      }
      same('C give up', 'recap rows', (X.sb.nightLog || []).filter(g => g.step === 'recap').map(g => g.detail.state),
           ['try again', 'try again', 'gave up']);
    });

    await scen('the trigger retires itself', async () => {
      const X = movedStore(seedC, script, 'roll-play');
      run(X.side, c => c.ensureNightlyTrigger_());
      const has = () => X.side.scriptApp.triggers.some(t => t.getHandlerFunction() === 'nightlyMaintenance_');
      X.setAt(X.at(3, 30));
      const cycle = X.s.state.cycleDate;
      // close_direct off: Apps Script closes, as today, and keeps its trigger.
      run(X.side, c => c.nightlyMaintenance_());
      if (X.s.state.cycleDate === cycle || !has() || X.s.sheetTriggerOffAt) fail('C trigger', 'close_direct off: closed ' + (X.s.state.cycleDate !== cycle) + ', trigger ' + has());
      // close_direct on (the next night): the trigger deletes itself, stamps, and closes nothing.
      const Y = movedStore(seedC, script, 'roll-play');
      run(Y.side, c => c.ensureNightlyTrigger_());
      Y.s.closeDirect = true;
      Y.setAt(Y.at(3, 30));
      const yCycle = Y.s.state.cycleDate;
      const calls = Y.sb.calls.length;
      run(Y.side, c => c.nightlyMaintenance_());
      const yHas = Y.side.scriptApp.triggers.some(t => t.getHandlerFunction() === 'nightlyMaintenance_');
      if (yHas || !Y.s.sheetTriggerOffAt || Y.s.state.cycleDate !== yCycle || Y.sb.calls.slice(calls).some(f => f === 'mog_sync_close_cycle' || f === 'mog_sync_set_pins')) {
        fail('C trigger', 'close_direct on: trigger ' + yHas + ', stamp ' + Y.s.sheetTriggerOffAt + ', calls ' + Y.sb.calls.slice(calls).join(','));
      }
      // Supabase unreachable: no throw, the trigger stays, nothing stamped.
      const Z = movedStore(seedC, script, 'roll-play');
      run(Z.side, c => c.ensureNightlyTrigger_());
      Z.s.closeDirect = true;
      Z.sb.down = true;
      run(Z.side, c => c.nightlyMaintenance_());
      Z.sb.down = false;
      if (!Z.side.scriptApp.triggers.some(t => t.getHandlerFunction() === 'nightlyMaintenance_') || Z.s.sheetTriggerOffAt) {
        fail('C trigger', 'Supabase down: the trigger went away');
      }
    });

    await scen('the shadow, and nothing before 3:30', async () => {
      const X = movedStore(seedC, script, 'roll-play');
      X.setAt(X.at(3, 5));
      const snap = clone(X.sb.handle('mog_sync_get_snapshot', { p_slug: SLUG, p_key: X.key }).data);
      const before = clone({ log: X.s.log, state: X.s.state });
      const mail = makeMail();
      await night(core, X.sb, mail);
      const sh = (X.sb.nightLog || []).filter(g => g.step === 'shadow');
      if (sh.length !== 1) fail('C shadow', sh.length + ' shadow rows');
      else same('C shadow', 'shadow rows', sh[0].detail.rows, core.closeFromSnapshot(snap).rows);
      X.setAt(X.at(3, 15));
      await night(core, X.sb, mail);
      if ((X.sb.nightLog || []).filter(g => g.step === 'shadow').length !== 1) fail('C shadow', 'a second shadow for the same cycle');
      same('C shadow', 'the shadow writes nothing else', { log: X.s.log, state: X.s.state }, before);
      if (mail.sent.length) fail('C shadow', 'the shadow sent email');
      X.s.closeDirect = true;
      X.setAt(X.at(3, 25));
      await night(core, X.sb, mail);
      same('C shadow', 'close_direct on, 3:25 AM: nothing closed', { log: X.s.log, state: X.s.state }, before);
      X.setAt(X.at(3, 30));
      await night(core, X.sb, mail);
      if (X.s.state.cycleDate === before.state.cycleDate) fail('C shadow', 'close_direct on, 3:30 AM: not closed');
    });

    await scen('the test email', async () => {
      const X = movedStore(seedC, script, 'leid');
      X.s.closeDirect = true;
      X.setAt(X.at(3, 30));
      const mail = makeMail();
      await night(core, X.sb, mail);
      const cycle = X.s.recapSentFor;
      const n = mail.sent.length;
      const flags = clone({ sent: X.s.recapSentFor, due: X.s.recapDue, tries: X.s.recapTries });
      const r = await night(core, X.sb, mail, { step: 'test', slug: SLUG, date: cycle, to: 'me@example.com' });
      const t = mail.sent[n];
      if (!r.ok || mail.sent.length !== n + 1 || !t || t.to !== 'me@example.com' || t.subject !== mail.sent[0].subject || t.idempotencyKey) {
        fail('C test email', JSON.stringify(r) + ' / ' + JSON.stringify(t && { to: t.to, key: t.idempotencyKey }));
      }
      same('C test email', 'flags untouched', { sent: X.s.recapSentFor, due: X.s.recapDue, tries: X.s.recapTries }, flags);
      const row = (X.sb.nightLog || []).find(g => g.step === 'test');
      if (!row || JSON.stringify(row).indexOf('me@example.com') >= 0) fail('C test email', 'test row: ' + JSON.stringify(row));
      const bad = await night(core, X.sb, mail, { step: 'test', slug: SLUG, date: 'yesterday', to: 'me@example.com' });
      if (bad.ok) fail('C test email', 'a bad date was sent');
    });

    await scen('one store failing leaves the others', async () => {
      const X = movedStore(seedC, script, 'roll-play');
      const k2 = X.sb.provision('zzother');
      const s2 = X.sb.stores.get('zzother');
      Object.assign(s2, clone({ catalog: X.s.catalog, version: X.s.version, state: X.s.state, recipients: X.s.recipients }));
      s2.counts = new Map(Array.from(X.s.counts.entries()).map(([c, m]) => [c, new Map(m)]));
      s2.log = [];
      X.s.closeDirect = true; s2.closeDirect = true;
      X.setAt(X.at(3, 30));
      const mail = makeMail();
      const out = await core.runNight(makeDb(X.sb, { failFor: 'zzother' }), mail, {}, { now: () => new Date(X.sb.nowMs), clock: () => 0 });
      const errRow = (X.sb.nightLog || []).find(g => g.slug === 'zzother' && !g.ok);
      if (X.s.state.cycleDate === s2.state.cycleDate || !errRow || !out.ran.some(x => x.slug === 'zzother' && x.error)) {
        fail('C one store failing', JSON.stringify(out.ran.map(x => ({ slug: x.slug, step: x.step, error: x.error, closed: x.closed }))));
      }
      if (!k2) fail('C one store failing', 'no key');
    });
  }

  // ---- D. shared.mjs is today's .gs -------------------------------------------------
  {
    const shared = lf(fs.readFileSync(path.join(F.REPO, 'supabase/functions/close/shared.mjs'), 'utf8'));
    for (const f of CLOSE_SOURCES) {
      if (shared.indexOf(lf(srcOf('apps-script/' + f)).replace(/\n+$/, '')) < 0) {
        fail('D', 'supabase/functions/close/shared.mjs does not hold apps-script/' + f + ' as it is now: run python build.py');
      }
    }
    if (shared.indexOf('export { ' + CLOSE_EXPORTS.join(', ') + ' };') < 0) fail('D', 'shared.mjs exports differ from ' + CLOSE_EXPORTS.join(', '));
  }

  // ---- E. Concepts.gs and RecapEmail.gs are pure -------------------------------------
  {
    const SERVICES = /\b(SpreadsheetApp|PropertiesService|MailApp|GmailApp|Utilities|Session|Logger|ScriptApp|UrlFetchApp|CacheService|LockService|HtmlService|ContentService|DriveApp)\b/;
    for (const f of ['Concepts.gs', 'RecapEmail.gs']) {
      const code = srcOf('apps-script/' + f).replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
      const m = SERVICES.exec(code);
      if (m) fail('E', f + ' names the Apps Script service ' + m[1]);
    }
    try {
      const bare = vm.createContext({});
      vm.runInContext(srcOf('apps-script/Concepts.gs') + '\n' + srcOf('apps-script/RecapEmail.gs'), bare);
      const out = vm.runInContext('recapEmailContent_("S", conceptTheme_("teasnyou"), [{ vendor: "V", lines: [{ name: "n", pack: "", onHand: null, qty: 1 }] }], "2026-11-11", 1)', bare);
      if (!out || !/^\[S\] Daily order recap/.test(out.subject)) fail('E', 'recapEmailContent_ in a bare context: ' + JSON.stringify(out));
    } catch (e) {
      fail('E', 'Concepts.gs + RecapEmail.gs do not run bare: ' + e.message);
    }
  }

  return { failures, stats, rowSeeds };
}

function oldGsFiles() {
  return execFileSync('git', ['ls-tree', '--name-only', BASE, 'apps-script/'], { cwd: F.REPO, encoding: 'utf8' })
    .split('\n').map(s => s.trim()).filter(s => s.endsWith('.gs')).map(s => s.replace(/^apps-script\//, '')).sort();
}

// ---- Planted-defect controls -------------------------------------------------------
const CONTROLS = [
  { name: 'the close opens the new cycle on the closing day', file: 'supabase/functions/close/core.mjs',
    find: '    newCycle:  st.today,', replace: '    newCycle:  st.cycleDate,' },
  { name: 'the close never sends the recap it owes', file: 'supabase/functions/close/core.mjs',
    find: '  if (r && r.recapDue) out.recap = await runRecap(db, mail, slug);', replace: '' },
  { name: 'the idempotency key leaves out the person', file: 'supabase/functions/close/core.mjs',
    find: "'/' + String(email || '').trim().toLowerCase()).slice(0, 256);", replace: "'').slice(0, 256);" },
  { name: 'a failed try is never reported', file: 'supabase/functions/close/core.mjs',
    find: "  await db.recapDone(slug, cycle, sent, failed, Object.assign({ attempt: claim.attempt, recipients: recipients.length },",
    replace: "  if (sent) await db.recapDone(slug, cycle, sent, failed, Object.assign({ attempt: claim.attempt, recipients: recipients.length }," },
  { name: 'the test email marks the flag', file: 'supabase/functions/close/core.mjs',
    find: "  await db.note(slug, 'test', date, !!(res && res.ok), res && res.ok ? { sent: 1 } : { error: String(res && res.error) });",
    replace: "  await db.recapDone(slug, date, 1, 0, {});" },
  { name: 'the email header band changes colour', file: 'apps-script/RecapEmail.gs',
    find: "html += '<tr style=\"background:#f4f5f7\">';", replace: "html += '<tr style=\"background:#f4f5f8\">';" },
  { name: "Teas'n You's ink lost in the move", file: 'apps-script/Concepts.gs',
    find: 'bannerFont: "#1a1a1a", ink: "#1a1a1a" },', replace: 'bannerFont: "#1a1a1a" },' },
  { name: "Apps Script's Daily summary doesn't tell Supabase", file: 'apps-script/Recap.gs',
    find: "  try { supabaseSync_('mog_sync_set_recap_sent', { p_cycle: cycleDate }); }", replace: '  try { }' },
  { name: "Apps Script's pending send ignores Supabase's flag", file: 'apps-script/Recap.gs',
    find: "    return (supabaseSync_('mog_sync_night', {}).recapSentFor || '') === cycleDate;", replace: '    return false;' },
  { name: 'the trigger ignores close_direct', file: 'apps-script/Sync.gs',
    find: '  if (!night.closeDirect) return false;', replace: '  return false;' },
  { name: 'the trigger stays after the move', file: 'apps-script/Sync.gs',
    find: "  dropTriggersFor_('nightlyMaintenance_');\n  try { supabaseSync_('mog_sync_night', { p_trigger_off: true }); }",
    replace: "  try { supabaseSync_('mog_sync_night', { p_trigger_off: true }); }" },
  { name: 'OrderMath.gs changed without python build.py', file: 'apps-script/OrderMath.gs',
    find: 'function recapFromLogRows_(rows, orderDate) {', replace: 'function recapFromLogRows_(rows, orderDate) { // edited' },
  { name: 'RecapEmail.gs reads a Script Property', file: 'apps-script/RecapEmail.gs',
    find: 'function recapEmailContent_(location, theme, sections, cycleDate, totalItems) {',
    replace: 'function recapEmailContent_(location, theme, sections, cycleDate, totalItems) {\n  location = location || PropertiesService.getScriptProperties().getProperty("X");' }
];

(async () => {
  try {
    const main = await runSuite(plain, Array.from({ length: STORES }, (_, i) => i + 1));
    const s = main.stats;
    console.log('night_close: ' + s.stores + ' stores closed both ways (' + s.withRows + ' with orders, ' + s.rows + ' rows, ' +
                s.emails + ' emails compared), ' + s.emailCases + ' email cases old vs new vs core.mjs, ' + s.scenarios + ' once-per-cycle scenarios');
    if (main.failures.length) {
      console.log('FAIL  ' + main.failures.length + ' problem(s):');
      for (const f of main.failures.slice(0, 15)) console.log('  ' + f);
      process.exitCode = 1;
      return;
    }
    console.log('PASS  the night closes and emails as Apps Script does, once per cycle');

    // Controls run on stores that order something (else a control would fail
    // for the fixture, not the defect), plus one that may not.
    const controlSeeds = main.rowSeeds.slice(0, 3).concat([1]);
    let missed = 0;
    for (const c of CONTROLS) {
      const srcOf = f => (f === c.file ? F.plant(plain(f), c.find, c.replace) : plain(f));
      let caught;
      try {
        const r = await runSuite(srcOf, controlSeeds);
        caught = r.failures.length > 0;
        if (process.env.SHOW) console.log('  [' + c.name + '] ' + (r.failures[0] || 'nothing').slice(0, 220));
      }
      catch (e) { caught = !/plant:/.test(e.message); if (!caught) throw e; }
      if (!caught) { missed++; console.log('FAIL  control not caught: ' + c.name); }
    }
    if (missed) { process.exitCode = 1; return; }
    console.log('PASS  all ' + CONTROLS.length + ' planted defects caught');
    console.log('night_close: ALL PASS');
  } catch (e) {
    console.log('FAIL  ' + (e.stack || e));
    process.exitCode = 1;
  } finally {
    try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) { /* temp */ }
  }
})();
