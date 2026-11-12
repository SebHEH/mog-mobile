// =====================================================================
// MOG mail relay: sends the nightly recap for Supabase's close
// =====================================================================
// docs/MOG_SheetRetirement_Spec.md, step 2, R3. A standalone Apps Script
// project, bound to no Sheet, owned by the account that deployed it. Its
// email goes out through MailApp, as the stores' own recaps always have,
// from Google's no-reply address, under the name the caller gives.
//
// The Edge Function `close` (supabase/functions/close/core.mjs, relayMailer)
// posts one email at a time as JSON:
//   { secret, to, subject, text, html, name, key }
// and gets JSON back (HTTP 200 whatever happened, as from any Apps Script):
//   { ok: true, sent: true }        sent
//   { ok: true, duplicate: true }   this key was sent in the last 6 hours
//   { ok: false, error }            nothing sent
//   secret  MOG_RELAY_SECRET in this project's Script Properties (made by
//           setupRelay) and in Supabase's Edge Functions -> Secrets. Checked
//           before anything else. It rides in the body: Apps Script can't
//           read a request's headers.
//   key     optional. The same key again within 6 hours is answered, not
//           sent, so a retry after a lost answer never emails twice.
//
// Deploy: python deploy.py --relay (pushes this folder, then redeploys the
// same deployment, so the address never changes). Never in apps-script/:
// that folder goes to every store's Sheet. tests/mail_relay.test.js runs
// this file under Node.
// =====================================================================

const RELAY_SECRET_PROP = 'MOG_RELAY_SECRET';
const RELAY_KEY_TTL_S = 21600;   // 6 hours, CacheService's longest
const RELAY_LIMITS = { to: 254, subject: 250, text: 200000, html: 400000, name: 100, key: 300 };

function doPost(e) {
  let req = null;
  try { req = JSON.parse((e && e.postData && e.postData.contents) || ''); } catch (err) { req = null; }
  if (!req || typeof req !== 'object') return relayAnswer_({ ok: false, error: 'BAD_JSON' });
  if (!relaySecretOk_(req.secret)) return relayAnswer_({ ok: false, error: 'NOT_ALLOWED' });
  const bad = relayCheck_(req);
  if (bad) return relayAnswer_({ ok: false, error: bad });

  const key = req.key ? relayCacheKey_(String(req.key)) : '';
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) return relayAnswer_({ ok: false, error: 'BUSY' });
  try {
    const cache = CacheService.getScriptCache();
    if (key && cache.get(key)) return relayAnswer_({ ok: true, duplicate: true });
    MailApp.sendEmail(relayMessage_(req));
    if (key) cache.put(key, '1', RELAY_KEY_TTL_S);
    return relayAnswer_({ ok: true, sent: true });
  } catch (err) {
    return relayAnswer_({ ok: false, error: String((err && err.message) || err).slice(0, 300) });
  } finally {
    lock.releaseLock();
  }
}

// Run once from the editor (Run > setupRelay): makes the secret if there's
// none, and asks Google's permission to send email as you. Logs nothing
// secret. Then copy MOG_RELAY_SECRET from Project Settings > Script
// properties into Supabase: Edge Functions > Secrets, under the same name.
function setupRelay() {
  const props = PropertiesService.getScriptProperties();
  if (!String(props.getProperty(RELAY_SECRET_PROP) || '').trim()) {
    props.setProperty(RELAY_SECRET_PROP, (Utilities.getUuid() + Utilities.getUuid()).replace(/-/g, ''));
  }
  Logger.log('Mail relay ready (emails left today: ' + MailApp.getRemainingDailyQuota() + '). Copy ' +
             RELAY_SECRET_PROP + ' from Project Settings > Script properties into Supabase: Edge Functions > Secrets.');
}

// The stored secret must exist (a project nobody set up refuses every call),
// and the caller's must equal it. A value copied by hand may carry a
// trailing newline: both sides are trimmed.
function relaySecretOk_(given) {
  const want = String(PropertiesService.getScriptProperties().getProperty(RELAY_SECRET_PROP) || '').trim();
  return want.length >= 32 && String(given == null ? '' : given).trim() === want;
}

// One address per call, a subject, a body, nothing oversized.
function relayCheck_(r) {
  const to = String(r.to == null ? '' : r.to).trim();
  if (!/^[^\s@,;<>"]+@[^\s@,;<>"]+\.[^\s@,;<>"]+$/.test(to)) return 'BAD_TO';
  if (!String(r.subject == null ? '' : r.subject).trim()) return 'NO_SUBJECT';
  if (!String(r.text == null ? '' : r.text) && !String(r.html == null ? '' : r.html)) return 'NO_BODY';
  for (const k in RELAY_LIMITS) {
    if (String(r[k] == null ? '' : r[k]).length > RELAY_LIMITS[k]) return 'TOO_LONG_' + k.toUpperCase();
  }
  return '';
}

// What MailApp gets: the same fields Apps Script's sendRecapEmail_ passes,
// plus noReply (Google's no-reply address on the domain; no Reply-To).
function relayMessage_(r) {
  return {
    to:       String(r.to).trim(),
    subject:  String(r.subject),
    body:     String(r.text == null ? '' : r.text),
    htmlBody: String(r.html == null ? '' : r.html),
    name:     String(r.name == null ? '' : r.name),
    noReply:  true
  };
}

// CacheService keys stop at 250 characters: the caller's key, hashed.
function relayCacheKey_(key) {
  const digest = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, key, Utilities.Charset.UTF_8);
  return 'mog-relay:' + Utilities.base64Encode(digest);
}

function relayAnswer_(o) {
  return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON);
}
