'use strict';
// GATE: the mail relay (docs/MOG_SheetRetirement_Spec.md, step 2, R3).
// Supabase's nightly close sends its recap through mail-relay/Relay.gs, a
// standalone Apps Script project, instead of an outside email service
// (Sebastian, 2026-11-12).
//
//   A. Relay.gs under Node with fake Google services: the secret first (none
//      stored, wrong, missing, a copied trailing newline), one email per call
//      with what Recap.gs sendRecapEmail_ gives MailApp plus noReply, a key
//      sent once in 6 hours (hashed, so any length fits the cache), a failed
//      send not remembered, bad requests refused, the lock always released,
//      setupRelay's secret made once and never logged.
//   B. core.mjs relayMailer posting to the real Relay.gs: a test email and a
//      night's recap reach MailApp exactly as core.mjs builds them; the recap
//      tried again after lost answers sends nothing twice; a refusal is the
//      answer at once, an outage or a failed send is tried 3 times; a page
//      that isn't the relay's JSON fails; no address or secret, no call.
//   C. Wiring: index.ts mails only through relayMailer with MOG_RELAY_SECRET;
//      its address is relay-target.json's deployment; mail-relay/ holds only
//      the relay's files and clasp pushes only two of them; the manifest asks
//      only to send email and runs as the deployer for anyone; the only public
//      functions are doPost and setupRelay; Relay.gs uses no other service.
// Every part has planted-defect controls.
//
// Run bare: node tests/mail_relay.test.js
// A passing run ends with "mail_relay: ALL PASS".

const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const crypto = require('crypto');
const { pathToFileURL } = require('url');

const REPO = path.resolve(__dirname, '..');
const lf = s => String(s).replace(/\r\n/g, '\n');
const plain = f => lf(fs.readFileSync(path.join(REPO, f), 'utf8'));
const clone = v => JSON.parse(JSON.stringify(v === undefined ? null : v));
const SECRET = crypto.randomBytes(32).toString('hex');
const TEST_URL = 'https://script.google.com/macros/s/TESTDEPLOYMENT/exec';
const NAME = 'Master Ordering Guide';
const LONG_KEY = 'mog-recap/zz/2026-11-11/' + 'x'.repeat(240) + '@example.com';

// ---- Relay.gs in its own context, with fake Google services ------------------------
function makeRelay(srcOf, props) {
  const r = { mails: [], logs: [], props: Object.assign({}, props), cache: new Map(), locks: 0,
              lockFail: false, mailFail: null, down: false, htmlPage: false, loseAnswer: 0, posts: 0 };
  const lock = {
    tryLock() { if (r.lockFail) return false; r.locks++; return true; },
    waitLock() { r.locks++; },
    releaseLock() { r.locks--; }
  };
  const output = s => ({ s, mime: null, setMimeType(m) { this.mime = m; return this; }, getContent() { return this.s; } });
  r.ctx = vm.createContext({
    PropertiesService: { getScriptProperties: () => ({
      getProperty: k => (Object.prototype.hasOwnProperty.call(r.props, k) ? r.props[k] : null),
      setProperty: (k, v) => { r.props[k] = String(v); } }) },
    CacheService: { getScriptCache: () => ({
      get: k => (r.cache.has(k) ? r.cache.get(k) : null),
      put: (k, v, ttl) => {
        if (String(k).length > 250) throw new Error('Argument too large: key');
        if (!(ttl > 0 && ttl <= 21600)) throw new Error('bad expiration ' + ttl);
        r.cache.set(k, String(v));
      } }) },
    LockService: { getScriptLock: () => lock },
    MailApp: {
      sendEmail: o => { if (r.mailFail) throw new Error(r.mailFail); r.mails.push(clone(o)); },
      getRemainingDailyQuota: () => 1500 },
    ContentService: { MimeType: { JSON: 'JSON' }, createTextOutput: output },
    Utilities: {
      getUuid: () => crypto.randomUUID(),
      DigestAlgorithm: { SHA_256: 'SHA_256' }, Charset: { UTF_8: 'UTF_8' },
      computeDigest: (alg, s) => {
        if (alg !== 'SHA_256') throw new Error('digest ' + alg);
        return Array.from(crypto.createHash('sha256').update(String(s), 'utf8').digest()).map(b => (b > 127 ? b - 256 : b));
      },
      base64Encode: bytes => Buffer.from(bytes.map(b => b & 255)).toString('base64') },
    Logger: { log: s => r.logs.push(String(s)) }
  });
  vm.runInContext(srcOf('mail-relay/Relay.gs'), r.ctx, { filename: 'Relay.gs' });
  r.postRaw = contents => {
    r.posts++;
    const out = r.ctx.doPost({ postData: { contents, type: 'application/json' } });
    if (!out || out.mime !== 'JSON') throw new Error('doPost answered without the JSON type');
    return out.getContent();
  };
  r.post = body => JSON.parse(r.postRaw(typeof body === 'string' ? body : JSON.stringify(body)));
  // What the function's fetch reaches: Apps Script answers 200 whatever happened.
  r.fetch = async (url, init) => {
    r.fetches = (r.fetches || 0) + 1;
    if (r.down) throw new Error('connect ECONNREFUSED');
    if (r.htmlPage) return { status: 200, text: async () => '<!DOCTYPE html><html><title>Error</title></html>' };
    if (url !== TEST_URL || !init || init.method !== 'POST' || init.redirect !== 'follow' ||
        (init.headers || {})['Content-Type'] !== 'application/json') {
      return { status: 405, text: async () => 'unexpected request: ' + JSON.stringify({ url, init: init && { method: init.method, redirect: init.redirect } }) };
    }
    const text = r.postRaw(init.body);
    if (r.loseAnswer > 0) { r.loseAnswer--; throw new Error('the answer was lost'); }
    return { status: 200, text: async () => text };
  };
  return r;
}

const msg = o => Object.assign({ secret: SECRET, to: 'gm@example.com', subject: 'S', text: 'T', html: '<p>H</p>', name: NAME, key: '' }, o);
const viaMailApp = (to, email) => ({ to, subject: email.subject, body: email.text, htmlBody: email.html, name: NAME, noReply: true });

// ---- core.mjs, loaded from a copy so a control can plant into it --------------------
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'mog-mail-relay-'));
let loads = 0;
async function loadCore(srcOf) {
  const dir = path.join(TMP, String(++loads));
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, 'shared.mjs'), plain('supabase/functions/close/shared.mjs'));
  fs.writeFileSync(path.join(dir, 'core.mjs'), srcOf('supabase/functions/close/core.mjs'));
  return import(pathToFileURL(path.join(dir, 'core.mjs')).href);
}

// A cycle's order log as mog.night_log_rows answers it.
const ROWS = [
  { vendor: 'Sysco', id: 'I1', name: 'Rice & Beans', pack: '25 lb', area: 'Dry', onHandPrev: 1, qty: 2 },
  { vendor: 'Sysco', id: 'I2', name: 'Napkins "white"', pack: '', area: 'Dry', onHandPrev: null, qty: 1 },
  { vendor: 'B&T Distributors LLC', id: 'I3', name: 'Salmon <fresh>', pack: '10 lb', area: 'Walk-in', onHandPrev: 0.5, qty: 3 }
];
const STORE = { location: 'Roll Play Rosslyn FOH', concept: 'rollplay' };
const RECIPIENTS = [{ name: 'GM', email: 'gm@example.com' }, { name: 'KM', email: 'km@example.com' }];

function makeDb(log) {
  return {
    due: async () => [{ slug: 'zz', step: 'recap' }],
    recapClaim: async slug => clone(Object.assign({ due: true, cycle: '2026-11-11', attempt: 1, rows: ROWS, recipients: RECIPIENTS }, STORE)),
    recapDone: async (slug, cycle, sent, failed, detail) => { log.push({ slug, cycle, sent, failed, detail: clone(detail) }); return null; },
    testData: async () => clone(Object.assign({ ok: true, rows: ROWS }, STORE)),
    note: async () => null
  };
}

async function runSuite(srcOf) {
  const failures = [];
  const fail = (where, what) => failures.push(where + ': ' + what);
  const same = (where, what, a, b) => {
    if (JSON.stringify(a) !== JSON.stringify(b)) fail(where, what + '\n      got:  ' + JSON.stringify(a).slice(0, 300) + '\n      want: ' + JSON.stringify(b).slice(0, 300));
  };
  const guard = async (where, fn) => { try { await fn(); } catch (e) { fail(where, 'threw: ' + (e && e.message)); } };
  const stored = { MOG_RELAY_SECRET: SECRET };

  // ---- A. Relay.gs -------------------------------------------------------------------
  await guard('A no secret stored', () => {
    const r = makeRelay(srcOf);
    for (const s of ['', null, undefined, SECRET]) {
      const a = r.post(msg({ secret: s }));
      if (a.ok || a.error !== 'NOT_ALLOWED') fail('A no secret stored', JSON.stringify(s) + ' -> ' + JSON.stringify(a));
    }
    if (r.mails.length) fail('A no secret stored', r.mails.length + ' email(s) sent');
  });
  await guard('A wrong secret', () => {
    const r = makeRelay(srcOf, stored);
    for (const s of ['wrong', '', SECRET.slice(0, 32), SECRET + 'x', ' ' + SECRET.slice(1)]) {
      const a = r.post(msg({ secret: s }));
      if (a.ok || a.error !== 'NOT_ALLOWED') fail('A wrong secret', JSON.stringify(s) + ' -> ' + JSON.stringify(a));
    }
    const noField = msg({}); delete noField.secret;
    const a = r.post(noField);
    if (a.ok || a.error !== 'NOT_ALLOWED') fail('A wrong secret', 'no secret field -> ' + JSON.stringify(a));
    if (r.mails.length) fail('A wrong secret', r.mails.length + ' email(s) sent');
  });
  await guard('A copied newline', () => {
    const r1 = makeRelay(srcOf, stored);
    same('A copied newline', 'caller with a newline', r1.post(msg({ secret: SECRET + '\n' })), { ok: true, sent: true });
    const r2 = makeRelay(srcOf, { MOG_RELAY_SECRET: SECRET + '\n' });
    same('A copied newline', 'stored with a newline', r2.post(msg({})), { ok: true, sent: true });
  });
  await guard('A one email', () => {
    const r = makeRelay(srcOf, stored);
    const a = r.post(msg({ to: ' gm@example.com ', subject: 'Daily recap', text: 'plain', html: '<b>x</b>' }));
    same('A one email', 'answer', a, { ok: true, sent: true });
    same('A one email', 'what MailApp got', r.mails, [{ to: 'gm@example.com', subject: 'Daily recap', body: 'plain', htmlBody: '<b>x</b>', name: NAME, noReply: true }]);
  });
  await guard('A key', () => {
    const r = makeRelay(srcOf, stored);
    const k = 'mog-recap/rpr/2026-11-11/gm@example.com';
    same('A key', 'first', r.post(msg({ key: k })), { ok: true, sent: true });
    same('A key', 'again', r.post(msg({ key: k })), { ok: true, duplicate: true });
    same('A key', 'another person', r.post(msg({ key: k.replace('gm@', 'km@'), to: 'km@example.com' })), { ok: true, sent: true });
    same('A key', 'a long key', r.post(msg({ key: LONG_KEY })), { ok: true, sent: true });
    same('A key', 'the long key again', r.post(msg({ key: LONG_KEY })), { ok: true, duplicate: true });
    if (r.mails.length !== 3) fail('A key', r.mails.length + ' emails, want 3');
  });
  await guard('A no key', () => {
    const r = makeRelay(srcOf, stored);
    r.post(msg({})); r.post(msg({ key: '' }));
    if (r.mails.length !== 2) fail('A no key', r.mails.length + ' emails, want 2 (a test email sends every time)');
  });
  await guard('A failed send', () => {
    const r = makeRelay(srcOf, stored);
    r.mailFail = 'Service invoked too many times for one day: email.';
    const a = r.post(msg({ key: 'k1' }));
    if (a.ok || !/too many times/.test(a.error || '')) fail('A failed send', 'answer ' + JSON.stringify(a));
    r.mailFail = null;
    same('A failed send', 'the retry', r.post(msg({ key: 'k1' })), { ok: true, sent: true });
    if (r.mails.length !== 1) fail('A failed send', r.mails.length + ' emails, want 1');
  });
  await guard('A bad requests', () => {
    const r = makeRelay(srcOf, stored);
    const cases = [
      [msg({ to: 'a@example.com,b@example.com' }), 'BAD_TO'],
      [msg({ to: 'a@example.com b@example.com' }), 'BAD_TO'],
      [msg({ to: 'GM <gm@example.com>' }), 'BAD_TO'],
      [msg({ to: '' }), 'BAD_TO'],
      [msg({ to: 'nobody' }), 'BAD_TO'],
      [msg({ subject: '  ' }), 'NO_SUBJECT'],
      [msg({ text: '', html: '' }), 'NO_BODY'],
      [msg({ subject: 'x'.repeat(251) }), 'TOO_LONG_SUBJECT'],
      [msg({ html: 'x'.repeat(400001) }), 'TOO_LONG_HTML'],
      [msg({ key: 'k'.repeat(301) }), 'TOO_LONG_KEY'],
      ['not json', 'BAD_JSON'],
      ['null', 'BAD_JSON'],
      ['', 'BAD_JSON']
    ];
    for (const [body, want] of cases) {
      const a = r.post(body);
      if (a.ok || a.error !== want) fail('A bad requests', JSON.stringify(body).slice(0, 80) + ' -> ' + JSON.stringify(a) + ', want ' + want);
    }
    if (r.mails.length) fail('A bad requests', r.mails.length + ' email(s) sent');
  });
  await guard('A lock', () => {
    const r = makeRelay(srcOf, stored);
    r.post(msg({ key: 'L' })); r.post(msg({ key: 'L' }));
    r.mailFail = 'boom'; r.post(msg({ key: 'M' })); r.mailFail = null;
    if (r.locks !== 0) fail('A lock', 'held ' + r.locks + ' time(s) after the calls');
    r.lockFail = true;
    same('A lock', 'busy', r.post(msg({ key: 'N' })), { ok: false, error: 'BUSY' });
    if (r.mails.length !== 1) fail('A lock', r.mails.length + ' emails, want 1');
  });
  await guard('A setupRelay', () => {
    const r = makeRelay(srcOf);
    r.ctx.setupRelay();
    const s1 = r.props.MOG_RELAY_SECRET;
    if (!/^[0-9a-f]{64}$/.test(s1 || '')) fail('A setupRelay', 'secret ' + JSON.stringify(s1));
    r.ctx.setupRelay();
    if (r.props.MOG_RELAY_SECRET !== s1) fail('A setupRelay', 'a second run changed the secret');
    if (r.logs.some(l => s1 && l.indexOf(s1) >= 0)) fail('A setupRelay', 'the secret is in the log');
    same('A setupRelay', 'a call with it', r.post(msg({ secret: s1 })), { ok: true, sent: true });
    const other = makeRelay(srcOf);
    other.ctx.setupRelay();
    if (other.props.MOG_RELAY_SECRET === s1) fail('A setupRelay', 'two projects made the same secret');
  });

  // ---- B. relayMailer to the real Relay.gs -------------------------------------------
  let core = null;
  await guard('B load core.mjs', async () => { core = await loadCore(srcOf); });
  if (core) {
    const waits = [];
    const wait = async ms => { waits.push(ms); };
    await guard('B test email', async () => {
      const r = makeRelay(srcOf, stored);
      const mail = core.relayMailer(r.fetch, TEST_URL, SECRET, wait);
      const out = await core.runNight(makeDb([]), mail, { step: 'test', slug: 'zz', date: '2026-11-11', to: 'me@example.com' }, {});
      const email = core.recapEmail(STORE, clone(ROWS), '2026-11-11');
      if (!out.ok) fail('B test email', JSON.stringify(out));
      same('B test email', 'what MailApp got', r.mails, [viaMailApp('me@example.com', email)]);
    });
    await guard('B recap', async () => {
      const r = makeRelay(srcOf, stored);
      const mail = core.relayMailer(r.fetch, TEST_URL, SECRET, wait);
      const log = [];
      const email = core.recapEmail(STORE, clone(ROWS), '2026-11-11');
      r.loseAnswer = 2;   // both sends go out, both answers are lost: the next try must not send again
      await core.runNight(makeDb(log), mail, {}, { now: () => new Date('2026-11-12T08:31:00Z'), clock: () => 0 });
      same('B recap', 'what MailApp got', r.mails, RECIPIENTS.map(p => viaMailApp(p.email, email)));
      same('B recap', 'the outcome', log.map(l => [l.sent, l.failed]), [[2, 0]]);
      await core.runNight(makeDb(log), mail, {}, { now: () => new Date('2026-11-12T08:46:00Z'), clock: () => 0 });
      if (r.mails.length !== 2) fail('B recap', 'a second night run sent ' + (r.mails.length - 2) + ' more');
      same('B recap', 'the second outcome', log.map(l => [l.sent, l.failed]), [[2, 0], [2, 0]]);
    });
    await guard('B refusal', async () => {
      const r = makeRelay(srcOf, stored);
      const res = await core.relayMailer(r.fetch, TEST_URL, 'f'.repeat(64), wait).send({ name: NAME, to: 'gm@example.com', subject: 'S', text: 'T', html: 'H' });
      if (res.ok || !/NOT_ALLOWED/.test(res.error || '')) fail('B refusal', JSON.stringify(res));
      if (r.fetches !== 1) fail('B refusal', 'tried ' + r.fetches + ' times, want once');
    });
    await guard('B outage', async () => {
      const r = makeRelay(srcOf, stored);
      r.down = true;
      waits.length = 0;
      const res = await core.relayMailer(r.fetch, TEST_URL, SECRET, wait).send({ name: NAME, to: 'gm@example.com', subject: 'S', text: 'T', html: 'H', idempotencyKey: 'k' });
      if (res.ok || !/^network:/.test(res.error || '')) fail('B outage', JSON.stringify(res));
      if (r.fetches !== 3) fail('B outage', 'tried ' + r.fetches + ' times, want 3');
      same('B outage', 'pauses', waits, [1000, 2000]);
    });
    await guard('B not the relay', async () => {
      const r = makeRelay(srcOf, stored);
      r.htmlPage = true;
      const res = await core.relayMailer(r.fetch, TEST_URL, SECRET, wait).send({ name: NAME, to: 'gm@example.com', subject: 'S', text: 'T', html: 'H' });
      if (res.ok || !/^HTTP 200: <!DOCTYPE/.test(res.error || '')) fail('B not the relay', JSON.stringify(res));
      if (r.fetches !== 3) fail('B not the relay', 'tried ' + r.fetches + ' times, want 3');
    });
    await guard('B failed send', async () => {
      const r = makeRelay(srcOf, stored);
      r.mailFail = 'Service invoked too many times for one day: email.';
      const m = { name: NAME, to: 'gm@example.com', subject: 'S', text: 'T', html: 'H', idempotencyKey: 'k2' };
      const res = await core.relayMailer(r.fetch, TEST_URL, SECRET, wait).send(m);
      if (res.ok || !/^relay: Service invoked/.test(res.error || '')) fail('B failed send', JSON.stringify(res));
      if (r.posts !== 3) fail('B failed send', 'tried ' + r.posts + ' times, want 3');
      r.mailFail = null;
      const again = await core.relayMailer(r.fetch, TEST_URL, SECRET, wait).send(m);
      if (!again.ok || r.mails.length !== 1) fail('B failed send', 'the next try: ' + JSON.stringify(again) + ', ' + r.mails.length + ' email(s)');
    });
    await guard('B not set up', async () => {
      const r = makeRelay(srcOf, stored);
      const m = { name: NAME, to: 'gm@example.com', subject: 'S', text: 'T', html: 'H' };
      const a = await core.relayMailer(r.fetch, 'https://script.google.com/macros/s/FILL_ME_IN/exec', SECRET, wait).send(m);
      const b = await core.relayMailer(r.fetch, TEST_URL, '', wait).send(m);
      if (a.ok || b.ok || r.fetches) fail('B not set up', JSON.stringify([a, b]) + ', ' + (r.fetches || 0) + ' call(s)');
    });
  }

  // ---- C. Wiring -----------------------------------------------------------------------
  await guard('C index.ts', () => {
    const ts = srcOf('supabase/functions/close/index.ts');
    const code = ts.replace(/\/\/.*$/gm, '');
    if (!/const mail = relayMailer\(fetch, RELAY_URL, \(Deno\.env\.get\('MOG_RELAY_SECRET'\) \?\? ''\)\.trim\(\)\);/.test(code)) {
      fail('C index.ts', 'the mailer is not relayMailer(fetch, RELAY_URL, MOG_RELAY_SECRET)');
    }
    const fetches = code.match(/\bfetch\b/g) || [];
    if (fetches.length !== 1) fail('C index.ts', 'fetch named ' + fetches.length + ' times (only relayMailer may send)');
    if (/resend|RESEND/.test(code)) fail('C index.ts', 'still names Resend');
    const m = /^const RELAY_URL = 'https:\/\/script\.google\.com\/macros\/s\/([^/']+)\/exec';$/m.exec(ts);   // raw: the URL's // isn't a comment
    const target = JSON.parse(srcOf('mail-relay/relay-target.json'));
    if (!m) fail('C index.ts', 'no RELAY_URL');
    else if (m[1] !== target.deploymentId) fail('C index.ts', 'RELAY_URL is deployment ' + m[1] + ', relay-target.json has ' + target.deploymentId);
  });
  await guard('C mail-relay/', () => {
    const files = fs.readdirSync(path.join(REPO, 'mail-relay')).filter(f => f !== '.clasp.json').sort();
    same('C mail-relay/', 'files', files, ['.claspignore', 'Relay.gs', 'appsscript.json', 'relay-target.json']);
    same('C mail-relay/', '.claspignore', srcOf('mail-relay/.claspignore').trim().split('\n'), ['**/**', '!Relay.gs', '!appsscript.json']);
    if (fs.existsSync(path.join(REPO, 'apps-script', 'Relay.gs'))) fail('C mail-relay/', 'Relay.gs is in apps-script/ (every store would get it)');
    const manifest = JSON.parse(srcOf('mail-relay/appsscript.json'));
    same('C mail-relay/', 'scopes', manifest.oauthScopes, ['https://www.googleapis.com/auth/script.send_mail']);
    same('C mail-relay/', 'web app', manifest.webapp, { executeAs: 'USER_DEPLOYING', access: 'ANYONE_ANONYMOUS' });
    if (manifest.runtimeVersion !== 'V8') fail('C mail-relay/', 'runtime ' + manifest.runtimeVersion);
  });
  await guard('C Relay.gs', () => {
    const gs = srcOf('mail-relay/Relay.gs');
    const code = gs.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    const fns = Array.from(code.matchAll(/^function\s+([A-Za-z0-9_$]+)\s*\(/gm)).map(x => x[1]);
    same('C Relay.gs', 'public functions', fns.filter(f => !f.endsWith('_')).sort(), ['doPost', 'setupRelay']);
    const services = Array.from(new Set(code.match(/\b[A-Z][A-Za-z]*(App|Service|Utilities|Logger)\b/g) || [])).sort();
    const allowed = ['CacheService', 'ContentService', 'LockService', 'Logger', 'MailApp', 'PropertiesService', 'Utilities'];
    const extra = services.filter(s => !allowed.includes(s));
    if (extra.length) fail('C Relay.gs', 'uses ' + extra.join(', ') + ' (a new service needs a new permission)');
  });

  return failures;
}

// ---- Planted-defect controls -------------------------------------------------------
const RELAY = 'mail-relay/Relay.gs', CORE = 'supabase/functions/close/core.mjs', INDEX = 'supabase/functions/close/index.ts';
const CONTROLS = [
  { name: 'the relay skips the secret', file: RELAY,
    find: "  if (!relaySecretOk_(req.secret)) return relayAnswer_({ ok: false, error: 'NOT_ALLOWED' });\n", replace: '' },
  { name: 'a relay nobody set up takes an empty secret', file: RELAY,
    find: '  return want.length >= 32 && ', replace: '  return ' },
  { name: "a copied newline breaks the secret", file: RELAY,
    find: "String(given == null ? '' : given).trim() === want", replace: "String(given == null ? '' : given) === want" },
  { name: 'the relay forgets the key', file: RELAY,
    find: "    if (key && cache.get(key)) return relayAnswer_({ ok: true, duplicate: true });\n", replace: '' },
  { name: 'the key is remembered before the send', file: RELAY,
    find: "    MailApp.sendEmail(relayMessage_(req));\n    if (key) cache.put(key, '1', RELAY_KEY_TTL_S);",
    replace: "    if (key) cache.put(key, '1', RELAY_KEY_TTL_S);\n    MailApp.sendEmail(relayMessage_(req));" },
  { name: 'the key is not hashed', file: RELAY,
    find: "  return 'mog-relay:' + Utilities.base64Encode(digest);", replace: "  return 'mog-relay:' + key;" },
  { name: 'replies would reach the account', file: RELAY,
    find: '    noReply:  true\n', replace: '    noReply:  false\n' },
  { name: 'the sender name is dropped', file: RELAY,
    find: "    name:     String(r.name == null ? '' : r.name),\n", replace: '' },
  { name: 'plain text and HTML swapped', file: RELAY,
    find: "    body:     String(r.text == null ? '' : r.text),\n    htmlBody: String(r.html == null ? '' : r.html),",
    replace: "    body:     String(r.html == null ? '' : r.html),\n    htmlBody: String(r.text == null ? '' : r.text)," },
  { name: 'two addresses in one call', file: RELAY,
    find: "  if (!/^[^\\s@,;<>\"]+@[^\\s@,;<>\"]+\\.[^\\s@,;<>\"]+$/.test(to)) return 'BAD_TO';",
    replace: "  if (!/@/.test(to)) return 'BAD_TO';" },
  { name: 'the lock is never released', file: RELAY,
    find: '    lock.releaseLock();\n', replace: '' },
  { name: 'a public helper that sends anything', file: RELAY,
    find: 'function relayAnswer_(o) {', replace: "function sendAnything(to) { MailApp.sendEmail(to, 's', 'b'); }\n\nfunction relayAnswer_(o) {" },
  { name: 'a refusal is tried again', file: CORE,
    find: '          if (RELAY_REFUSALS.test(String(a.error))) break;\n', replace: '' },
  { name: "a page that isn't the relay's answer counts as sent", file: CORE,
    find: "        if (a && a.ok === true) return { ok: true, id: a.duplicate ? 'duplicate' : null };",
    replace: "        if (!a || a.ok === true) return { ok: true, id: a && a.duplicate ? 'duplicate' : null };" },
  { name: 'the key never reaches the relay', file: CORE,
    find: "name: m.name || '', key: m.idempotencyKey || '' });", replace: "name: m.name || '', key: '' });" },
  { name: 'an outage is not tried again', file: CORE,
    find: "          last = 'network: ' + message(e);\n          continue;", replace: "          last = 'network: ' + message(e);\n          break;" },
  { name: 'the recap goes out under no name', file: CORE,
    find: '      res = await mail.send({ name: RECAP_NAME, to: r.email,', replace: '      res = await mail.send({ to: r.email,' },
  { name: 'index.ts sends through Resend again', file: INDEX,
    find: "const mail = relayMailer(fetch, RELAY_URL, (Deno.env.get('MOG_RELAY_SECRET') ?? '').trim());",
    replace: "const mail = { send: async (m: any) => ({ ok: (await fetch('https://api.resend.com/emails', { method: 'POST', body: JSON.stringify(m) })).ok }) };" },
  { name: 'index.ts calls another deployment', file: INDEX,
    find: "const RELAY_URL = 'https://script.google.com/macros/s/", replace: "const RELAY_URL = 'https://script.google.com/macros/s/X" },
  { name: 'the relay asks to read Gmail', file: 'mail-relay/appsscript.json',
    find: '"https://www.googleapis.com/auth/script.send_mail"', replace: '"https://www.googleapis.com/auth/script.send_mail",\n    "https://mail.google.com/"' },
  { name: 'clasp would push relay-target.json', file: 'mail-relay/.claspignore',
    find: '!appsscript.json', replace: '!appsscript.json\n!relay-target.json' }
];

function planted(c) {
  return file => {
    const src = plain(file);
    if (file !== c.file) return src;
    const n = src.split(c.find).length - 1;
    if (n !== 1) throw new Error('plant "' + c.name + '": anchor found ' + n + ' times in ' + file);
    return src.replace(c.find, c.replace);
  };
}

(async () => {
  try {
    const failures = await runSuite(plain);
    if (failures.length) {
      console.log('FAIL  ' + failures.length + ' problem(s):');
      for (const f of failures.slice(0, 20)) console.log('  ' + f);
      process.exitCode = 1;
      return;
    }
    console.log('PASS  the relay sends what the function builds, once per key, only for the secret');
    let missed = 0;
    for (const c of CONTROLS) {
      const srcOf = planted(c);
      srcOf(c.file);   // the anchor must exist once
      const f = await runSuite(srcOf);
      if (f.length) console.log('PASS  control caught: ' + c.name + (process.env.MOG_VERBOSE ? '\n        by ' + f[0].split('\n')[0] : ''));
      else { missed++; console.log('FAIL  control MISSED: ' + c.name); }
    }
    if (missed) { process.exitCode = 1; console.log('mail_relay: ' + missed + ' control(s) missed'); return; }
    console.log('mail_relay: ALL PASS (' + CONTROLS.length + ' controls)');
  } catch (e) {
    console.log('FAIL  ' + (e && e.stack || e));
    process.exitCode = 1;
  } finally {
    try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) { /* a temp dir */ }
  }
})();
