/***********************
 * SUPABASE SYNC — the Sheet's side of the count-path migration
 *
 * Design record: docs/MOG_SupabaseMigration.md. The first half only READS
 * the Sheet; the network half (below the second banner) talks to Supabase.
 *   - buildCatalogPayload_(): the catalog block (design record, section 6)
 *     that Apps Script will push to Supabase after every edit.
 *   - test_supabaseParity(): editor-run. Feeds that catalog, plus this
 *     cycle's counts as the database would hold them, through the PWA's code
 *     path (OrderMath.gs) and compares the result with this server's own
 *     answer for every vendor and for the dashboard. A store has to pass
 *     before it switches to Supabase.
 ***********************/


// The catalog block for this store. Built from the same readers the API uses,
// so the phone sees exactly what the server sees. Fresh reads only, never the
// CacheService-wrapped ones: a push runs right after an edit, and several
// editors bump the mutation ts at their START, so a cached read could hand
// back the pre-edit list (the commitAddVendor trap, audit 07-29).
function buildCatalogPayload_() {
  const ss    = SpreadsheetApp.getActiveSpreadsheet();
  const setup = getSheet_(SHEET_SETUP);
  const props = PropertiesService.getScriptProperties();

  const vendorList = getVendorList_compute_();
  const multMap    = readVendorMultipliers_(setup);
  const cutoffMap  = readVendorCutoffs_(setup);
  const masterMeta = readMasterItemMeta_();

  const toObj = function (map) {
    const o = {};
    map.forEach(function (val, key) { o[key] = val; });
    return o;
  };

  // Resolved exactly as api_getVendorItems_ and the dashboard resolve one.
  const cutoffs = {};
  for (const v of vendorList) {
    cutoffs[v] = cutoffMap.get(v) || (VENDOR_META[v] || {}).cutoffTime || null;
  }

  // readMasterItemMeta_ verbatim, except a non-numeric par travels as null:
  // JSON has no NaN, and the phone turns null back into NaN
  // (orderInputsFromSnapshot_). Sending 0 would change the math.
  const items = {};
  masterMeta.forEach(function (m, id) {
    items[id] = {
      useMult:       m.useMult,
      par:           isNaN(m.par) ? null : m.par,
      name:          m.name,
      pack:          m.pack,
      primaryVendor: m.primaryVendor,
      active:        m.active
    };
  });

  return {
    schema:       1,
    timeZone:     ss.getSpreadsheetTimeZone(),
    location:     props.getProperty(PROP_LOCATION) || 'Unknown',
    abbr:         props.getProperty(PROP_LOCATION_ABBR) || '',
    concept:      props.getProperty(PROP_CONCEPT) || '',
    vendorList:   vendorList,
    vendorMults:  toObj(multMap),
    cutoffs:      cutoffs,
    items:        items,
    pickRows:     readPickDb_(setup).map(catalogPickRow_),
    itemCounts:   toObj(countActiveItemsByVendor_()),
    backupCounts: toObj(countBackupItemsByVendor_(masterMeta))
  };
}


// One SETUP K:P row made JSON-safe WITHOUT changing what the readers see.
// The builders read columns 0-3 with String() and columns 4-5 (area order,
// shelf order) with Number(). A Date typed into one of those cells would turn
// into an ISO string in JSON, which both String() and Number() read
// differently than the server's Date. So convert it up front to exactly what
// the server would see: String(date) for text columns, its time value for
// number columns.
function catalogPickRow_(r) {
  return r.map(function (v, i) {
    if (!(v instanceof Date)) return v;
    return i >= 4 ? v.getTime() : String(v);
  });
}


// Editor-run. Read-only: changes nothing in the Sheet or anywhere else.
// Run it from the Apps Script editor (Run > test_supabaseParity) and read the
// log. RESULT: PASS means the phone, fed this store's catalog and counts,
// shows exactly what /exec shows today.
function test_supabaseParity() {
  const report = supabaseParityReport_();
  const lines = [];
  lines.push('Supabase parity: ' + report.store + ', cycle ' + report.cycleDate +
             ' (' + report.dayOfWeek + '), Emergency Override ' + (report.emergencyOverride ? 'ON' : 'off'));
  for (const v of report.vendors) {
    lines.push((v.match ? '  MATCH  ' : '  DIFF   ') + v.vendor +
               (v.match ? ' (' + v.items + ' items' + (v.delivering ? '' : ', not delivering today') + ')' : ': ' + v.diff));
  }
  lines.push((report.dashboard.match ? '  MATCH  ' : '  DIFF   ') + 'dashboard' +
             (report.dashboard.match ? '' : ': ' + report.dashboard.diff));
  if (report.notDelivering) {
    lines.push('NOTE: ' + report.notDelivering + ' vendor(s) are not delivering today, so their item lists are empty ' +
               'on both sides. Their lists can only be compared on a delivery day (or with Emergency Override on).');
  }
  lines.push('RESULT: ' + (report.ok ? 'PASS' : 'FAIL') + ' (' + report.matched + '/' + report.vendors.length +
             ' vendors' + (report.dashboard.match ? ' + dashboard' : ', dashboard differs') + ')');
  Logger.log(lines.join('\n'));
  return report;
}


function supabaseParityReport_() {
  const ss      = SpreadsheetApp.getActiveSpreadsheet();
  const setup   = getSheet_(SHEET_SETUP);
  const active  = getActiveOrderDate_();
  const catalog = buildCatalogPayload_();
  const emergencyOverride = readEmergencyOverride_();
  const vendorOverrides   = readVendorOverrides_(setup);

  // This cycle's counts exactly as the database would hold them: one per
  // vendor-tab row that has an item id and a numeric On Hand (mog.to_onhand
  // stores blanks and junk as a cleared count, so those carry nothing).
  const counts = [];
  for (const v of catalog.vendorList) {
    const sh = ss.getSheetByName(v);
    const roster = sh ? readVendorTabRoster_(sh) : null;
    if (!roster) continue;
    for (const row of roster) {
      const raw = row.onHandRaw;
      if (!row.id || raw === '' || raw === null || isNaN(Number(raw))) continue;
      counts.push({ vendor: v, id: row.id, onHand: Number(raw) });
    }
  }

  const picks = {};
  vendorOverrides.forEach(function (m, v) { picks[v] = m; });

  // Exactly what survives the trip to the phone.
  const snap = JSON.parse(JSON.stringify({
    catalog: catalog,
    state: {
      cycleDate:         active.dateStr,
      dayOfWeek:         active.dayOfWeek,
      emergencyOverride: emergencyOverride,
      vendorPicks:       picks,
      todaysLog:         Array.from(getTodaysLogByVendor_(active.dateStr).values())
    },
    counts: counts
  }));
  const inputs = orderInputsFromSnapshot_(snap);

  // The server side, with one shared read context (the bulk-prefetch shape).
  const ctx = {
    pickDb:            readPickDb_(setup),
    vendorMults:       readVendorMultipliers_(setup),
    emergencyOverride: emergencyOverride,
    vendorOverrides:   vendorOverrides,
    dayOfWeek:         active.dayOfWeek,
    masterMeta:        readMasterItemMeta_(),
    cutoffs:           readVendorCutoffs_(setup)
  };

  const report = {
    store: catalog.location, cycleDate: active.dateStr, dayOfWeek: active.dayOfWeek,
    emergencyOverride: emergencyOverride, vendors: [], dashboard: null,
    matched: 0, notDelivering: 0, ok: true
  };
  for (const v of catalog.vendorList) {
    const delivering = vendorDayMultiplier_(inputs.vendorMults, v, inputs.dayOfWeek,
                                            inputs.emergencyOverride, inputs.vendorOverrides) > 0;
    if (!delivering) report.notDelivering++;
    let server = null;
    let diff   = '';
    try {
      server = api_getVendorItems_({ vendor: v }, ctx);
    } catch (e) {
      diff = 'server threw: ' + e.message;
    }
    const phone = vendorItemsFromSnapshot_(inputs, v);
    if (!diff) diff = syncDiff_(server, phone);
    report.vendors.push({
      vendor: v, delivering: delivering, match: !diff, diff: diff || null,
      items: server && server.items ? server.items.length : 0
    });
    if (diff) report.ok = false; else report.matched++;
  }

  const dDiff = syncDiff_(api_getDashboard_compute_(), dashboardFromSnapshot_(inputs));
  report.dashboard = { match: !dDiff, diff: dDiff || null };
  if (dDiff) report.ok = false;
  return report;
}


// First place two payloads differ, or '' when they match. Both sides go
// through a JSON round trip first, because that's how the PWA receives either
// one. A list-length difference names the entries only one side has.
function syncDiff_(server, phone) {
  const a = JSON.parse(JSON.stringify(server === undefined ? null : server));
  const b = JSON.parse(JSON.stringify(phone === undefined ? null : phone));
  return syncDiffAt_(a, b, '');
}

function syncDiffAt_(a, b, path) {
  const kind = function (v) { return Array.isArray(v) ? 'array' : (v === null ? 'null' : typeof v); };
  const show = function (v) {
    const s = JSON.stringify(v);
    return s.length > 120 ? s.slice(0, 117) + '...' : s;
  };
  if (a === b) return '';
  if (kind(a) !== kind(b) || (kind(a) !== 'array' && kind(a) !== 'object')) {
    return (path || '(root)') + ': server ' + show(a) + ' vs phone ' + show(b);
  }
  if (kind(a) === 'array') {
    if (a.length !== b.length) {
      const label = function (e) { return e && (e.id || e.name) ? String(e.id || e.name) : JSON.stringify(e); };
      const la = a.map(label), lb = b.map(label);
      const onlyA = la.filter(function (x) { return lb.indexOf(x) < 0; });
      const onlyB = lb.filter(function (x) { return la.indexOf(x) < 0; });
      return path + '.length: server ' + a.length + ' vs phone ' + b.length +
        (onlyA.length ? ' (server only: ' + onlyA.slice(0, 5).join(', ') + ')' : '') +
        (onlyB.length ? ' (phone only: ' + onlyB.slice(0, 5).join(', ') + ')' : '');
    }
    for (let i = 0; i < a.length; i++) {
      const d = syncDiffAt_(a[i], b[i], path + '[' + i + ']');
      if (d) return d;
    }
    return '';
  }
  const keys = Object.keys(a);
  for (const k of Object.keys(b)) if (keys.indexOf(k) < 0) keys.push(k);
  for (const k of keys) {
    if (!(k in a)) return path + '.' + k + ': only the phone has it';
    if (!(k in b)) return path + '.' + k + ': only the server has it';
    const d = syncDiffAt_(a[k], b[k], path + '.' + k);
    if (d) return d;
  }
  return '';
}


// ===========================================================================
// Network half (step 4): Apps Script <-> Supabase
// ===========================================================================
// Two per-store switches, both in Script Properties:
//   connected  MOG_SUPABASE_SLUG + MOG_SUPABASE_SYNC_KEY are set (menu:
//              Connect to Supabase). The catalog and PINs are pushed and the
//              3:30 AM nightly run is installed. Counting still uses the Sheet.
//   switched   connected AND MOG_BACKEND = "supabase" (menu: Switch counting
//              to Supabase). Counts, Emergency Override, the cycle and the
//              order log live in Supabase. /exec serves the count path from
//              there (DbApi.gs) and never reads or writes the Sheet for it;
//              the Sheet only gets the nightly order-log backup (D10).
// A store with neither behaves exactly as before: nothing here runs.

// The same for every store, and public by design (the PWA ships them too).
const SUPABASE_URL             = 'https://mnfwqmrstdeuczveyykv.supabase.co';
const SUPABASE_PUBLISHABLE_KEY = 'sb_publishable_Rk1wXHSydLtczfnc98LJBg_yzQ0sl93';

const PROP_SB_SLUG     = 'MOG_SUPABASE_SLUG';      // e.g. "rprfo"
const PROP_SB_SYNC_KEY = 'MOG_SUPABASE_SYNC_KEY';  // from mog.provision_store; never logged
const PROP_BACKEND     = 'MOG_BACKEND';            // "supabase" once counting has switched
const PROP_CATALOG_PUSH_QUEUED = 'MOG_CATALOG_PUSH_QUEUED';  // doc prop: ms a background push was queued

// The one permission the sync needs beyond what each store already granted.
// Google's consent screen lets a person untick a permission, a Sheet menu can't
// re-ask for it, and the editor re-asks only when a script requests it
// (authorizeSupabase below).
const SB_FETCH_SCOPE = 'https://www.googleapis.com/auth/script.external_request';

const CATALOG_PUSH_DELAY_MS = 60 * 1000;   // Apps Script rounds a one-shot trigger to ~1 min
const NIGHTLY_HOUR          = 3;           // script time zone (America/New_York)
const NIGHTLY_MINUTE        = 30;

let _SB_CONFIG_   = null;   // per-execution memos (globals reset every execution)
let _SB_SNAPSHOT_ = null;

function supabaseConfig_() {
  if (_SB_CONFIG_) return _SB_CONFIG_;
  const p = PropertiesService.getScriptProperties().getProperties();   // one read for all three
  const slug = String(p[PROP_SB_SLUG] || '');
  const key  = String(p[PROP_SB_SYNC_KEY] || '');
  const connected = !!(slug && key);
  _SB_CONFIG_ = { slug: slug, key: key, connected: connected,
                  switched: connected && p[PROP_BACKEND] === 'supabase' };
  return _SB_CONFIG_;
}

// POST one public.mog_* function. Returns its { ok, data | error } envelope;
// throws only when the request itself failed (network, HTTP error, not JSON).
function supabaseRpc_(fn, params) {
  const res = UrlFetchApp.fetch(SUPABASE_URL + '/rest/v1/rpc/' + fn, {
    method:             'post',
    contentType:        'application/json',
    headers:            { apikey: SUPABASE_PUBLISHABLE_KEY },
    payload:            JSON.stringify(params || {}),
    muteHttpExceptions: true
  });
  const code = res.getResponseCode();
  const text = res.getContentText();
  let body = null;
  try { body = JSON.parse(text); } catch (e) { body = null; }
  if (code !== 200 || !body || typeof body.ok !== 'boolean') {
    throw new Error('Supabase ' + fn + ' failed (HTTP ' + code + '): ' + String(text).slice(0, 200));
  }
  return body;
}

// A sync-key call for THIS store; returns its data, throws on any failure. The
// key travels only in the request body and never appears in an error message.
function supabaseSync_(fn, params) {
  const cfg = supabaseConfig_();
  if (!cfg.connected) throw new Error('This store is not connected to Supabase.');
  const body = supabaseRpc_(fn, Object.assign({ p_slug: cfg.slug, p_key: cfg.key }, params || {}));
  if (!body.ok) throw new Error('Supabase ' + fn + ': ' + body.error);
  return body.data;
}

// The store's snapshot (catalog + state + this cycle's counts), read at most
// once per execution unless `fresh`.
function supabaseSnapshot_(fresh) {
  if (!_SB_SNAPSHOT_ || fresh) _SB_SNAPSHOT_ = supabaseSync_('mog_sync_get_snapshot', {});
  return _SB_SNAPSHOT_;
}


// ---- Catalog + PIN pushes ---------------------------------------------------

// Push this store's catalog. Returns timings so the cost can be measured;
// throws on failure (each caller decides whether that matters).
function pushCatalogNow_() {
  const t0 = Date.now();
  const payload = buildCatalogPayload_();
  const bytes = JSON.stringify(payload).length;
  const t1 = Date.now();
  const data = supabaseSync_('mog_sync_push_catalog', { p_version: t1, p_payload: payload });
  try { PropertiesService.getDocumentProperties().deleteProperty(PROP_CATALOG_PUSH_QUEUED); } catch (e) { /* best effort */ }
  return { applied: !!data.applied, buildMs: t1 - t0, sendMs: Date.now() - t1, bytes: bytes };
}

// The web editor's background push: the page fires it as its own request
// right after a save that changed something (webedit_call's envelope), so the
// save never waits on Supabase. Never throws into the page; a failure queues
// the timer-based retry instead.
function pushCatalogNow() {
  if (!supabaseConfig_().connected) return { pushed: false };
  try {
    return Object.assign({ pushed: true }, pushCatalogNow_());
  } catch (e) {
    Logger.log('pushCatalogNow failed, queuing a background retry: ' + e.message);
    try { scheduleCatalogPush_(); } catch (e2) { /* the nightly push is the last backstop */ }
    return { pushed: false };
  }
}

function pushPinsNow_() {
  const props = PropertiesService.getScriptProperties();
  return supabaseSync_('mog_sync_set_pins', {
    p_pin:        props.getProperty(PROP_PIN) || '',
    p_master_pin: props.getProperty(PROP_MASTER_PIN) || ''
  });
}

// Call after any PIN change. A no-op on a store that isn't connected; never
// throws, since the PIN change itself already succeeded (the nightly run
// pushes again).
function pushPinsQuietly_() {
  _SB_CONFIG_ = null;
  if (!supabaseConfig_().connected) return;
  try { pushPinsNow_(); } catch (e) { Logger.log('PIN push failed (the nightly run retries): ' + e.message); }
}

// Queue ONE background catalog push about a minute out, for edits that don't
// come through the web editor: Sheet dialogs, Recalibrate Vendor Pars, Admin
// Reset, cell edits that bump the mutation ts. Called from
// bumpServerMutationTs_ on connected stores; at most one is queued at a time.
function scheduleCatalogPush_() {
  const doc = PropertiesService.getDocumentProperties();
  const queued = Number(doc.getProperty(PROP_CATALOG_PUSH_QUEUED) || 0);
  if (queued && Date.now() - queued < 10 * 60 * 1000) return false;   // one is already on its way
  doc.setProperty(PROP_CATALOG_PUSH_QUEUED, String(Date.now()));
  dropTriggersFor_('catalogPushTrigger_');
  ScriptApp.newTrigger('catalogPushTrigger_').timeBased().after(CATALOG_PUSH_DELAY_MS).create();
  return true;
}

function catalogPushTrigger_() {
  try {
    pushCatalogNow_();
  } catch (e) {
    Logger.log('Background catalog push failed (the nightly run retries): ' + e.message);
  } finally {
    try { PropertiesService.getDocumentProperties().deleteProperty(PROP_CATALOG_PUSH_QUEUED); } catch (e) { /* best effort */ }
    dropTriggersFor_('catalogPushTrigger_');
  }
}

// One-shot triggers stay behind (disabled) after they fire; Apps Script caps
// triggers per script, so every handler removes its own.
function dropTriggersFor_(handler) {
  for (const t of ScriptApp.getProjectTriggers()) {
    if (t.getHandlerFunction() === handler) {
      try { ScriptApp.deleteTrigger(t); } catch (e) { /* already gone */ }
    }
  }
}


// ---- Closing a cycle in Supabase -------------------------------------------

// Close the cycle Supabase is on: log it and start the next one (one
// transaction), back the log up to the Sheet, and schedule the recap email.
// The switched store's version of commitLogAndReset + the AE9 stamp, with no
// Sheet reads on the way.
//   opts.sameDay  close even if the cycle is already today's (the dashboard's
//                 manual reset). Without it, a cycle that's already today's is
//                 left alone, so a repeated or concurrent call can't wipe it.
// Returns api_commitReset_'s shape (+ emailResult). Throws when Supabase can't
// be reached, so nothing is logged or cleared on a guess.
function closeCycleInDb_(opts) {
  opts = opts || {};
  const tz    = SpreadsheetApp.getActiveSpreadsheet().getSpreadsheetTimeZone();
  const now   = new Date();
  const today = Utilities.formatDate(now, tz, 'yyyy-MM-dd');
  const dow   = Utilities.formatDate(now, tz, 'EEE');

  const snap    = supabaseSnapshot_(true);
  const closing = snap.state.cycleDate;
  if (closing > today || (closing === today && !opts.sameDay)) {
    return { logged: false, rowsLogged: 0, orderDate: closing,
             skippedReason: 'cycle is already ' + closing, resetDate: today };
  }

  const rows      = orderLogRowsFromInputs_(orderInputsFromSnapshot_(snap));
  const todaysLog = (closing === today) ? todaysLogFromRows_(rows, today, now, tz) : [];
  const res = supabaseSync_('mog_sync_close_cycle', {
    p_closing: closing, p_new_cycle: today, p_new_dow: dow,
    p_rows: rows, p_todays_log: todaysLog, p_logged_at: now.toISOString()
  });
  _SB_SNAPSHOT_ = null;
  if (!res.closed) {
    return { logged: false, rowsLogged: 0, orderDate: closing,
             skippedReason: 'cycle already moved to ' + res.cycleDate, resetDate: today };
  }

  // Both are off the critical path: neither may undo a close that happened.
  try { appendLogBackup_(closing, now, rows); }
  catch (e) { Logger.log('Order-log backup to the Sheet failed (Supabase has the log): ' + (e.stack || e)); }
  let emailResult;
  try {
    emailResult = scheduleRecapSend_(closing);
  } catch (e) {
    // Same fallback as commitLogAndReset: never silently lose the email.
    Logger.log('Recap scheduling failed, sending inline: ' + (e.stack || e));
    try { emailResult = sendRecapRowsNow_(closing, rows); } catch (e2) { emailResult = { sent: 0 }; }
  }

  return { logged: res.logged > 0, rowsLogged: res.logged, orderDate: closing,
           skippedReason: null, resetDate: today, emailResult: emailResult };
}

// The dashboard's "sent" summary after a SAME-DAY re-close: what
// getTodaysLogByVendor_ would read back from the Sheet log.
function todaysLogFromRows_(rows, dateStr, at, tz) {
  const sentAt = Utilities.formatDate(at, tz, 'HH:mm');
  const byVendor = new Map();
  for (const r of rows) {
    if (!byVendor.has(r.vendor)) {
      byVendor.set(r.vendor, { vendor: r.vendor, sentAt: sentAt, itemCount: 0,
                               reference: generateReferenceFromDateStr_(r.vendor, dateStr) });
    }
    byVendor.get(r.vendor).itemCount++;
  }
  return Array.from(byVendor.values());
}

// The one Sheet write a switched store keeps (D10): the closed cycle appended
// to LOG_ORDERS, replacing that date's rows (a same-day re-close), in the
// Sheet log's own column order.
function appendLogBackup_(orderDate, timestamp, rows) {
  const logSheet = ensureLogSheet_();
  deleteLogEntriesForDate_(logSheet, orderDate);
  if (!rows.length) return 0;
  const values = rows.map(function (r) {
    return [timestamp, orderDate, r.vendor, r.id, r.name, r.onHandPrev, r.qty];
  });
  logSheet.getRange(logSheet.getLastRow() + 1, 1, values.length, values[0].length).setValues(values);
  return values.length;
}

// Inline recap send from rows already in hand: the fallback when the async
// send can't be scheduled. Deduped like every other recap path.
function sendRecapRowsNow_(orderDate, rows) {
  const props = PropertiesService.getScriptProperties();
  if ((props.getProperty(PROP_LAST_RECAP_SENT_DATE) || '') === orderDate) return { sent: 0, alreadySent: true };
  const recap = recapFromLogRows_(rows, orderDate);
  const recipients = readRecipients_().filter(function (r) { return r.active && r.email; });
  if (!recipients.length || !recap.sections.length) return { sent: 0 };
  let sent = 0;
  for (const r of recipients) {
    try { sendRecapEmail_(r.email, recap.sections, recap.cycleDate, recap.totalItems); sent++; }
    catch (e) { Logger.log('Recap send failed for ' + r.email + ': ' + (e.stack || e)); }
  }
  if (sent > 0) props.setProperty(PROP_LAST_RECAP_SENT_DATE, orderDate);
  return { sent: sent };
}


// ---- The nightly run --------------------------------------------------------

// 3:30 AM on a connected store (installed by Connect to Supabase):
//   1. Close the cycle: in Supabase if switched, otherwise the Sheet's own reset
//      (the same one the PWA triggers), so nobody waits on it in the morning.
//   2. Full catalog + PIN push: the backstop for edits typed straight into the
//      Sheet and for any push that failed during the day.
// Never throws; each part logs its own failure. If the close fails, the PWA's
// on-open reset is still there as the fallback.
function nightlyMaintenance_() {
  MOG_SKIP_CATALOG_QUEUE_ = true;   // step 2 pushes anyway
  const cfg = supabaseConfig_();
  if (!cfg.connected) return;
  try {
    if (cfg.switched) closeCycleInDb_();
    else if (getResetStaleness_().isStale) api_commitReset_();
  } catch (e) {
    Logger.log('Nightly close failed: ' + (e.stack || e));
  }
  try { pushCatalogNow_(); } catch (e) { Logger.log('Nightly catalog push failed: ' + e.message); }
  try { pushPinsNow_(); } catch (e) { Logger.log('Nightly PIN push failed: ' + e.message); }
}

function ensureNightlyTrigger_() {
  const handler = 'nightlyMaintenance_';
  if (ScriptApp.getProjectTriggers().some(function (t) { return t.getHandlerFunction() === handler; })) {
    return { created: false };
  }
  ScriptApp.newTrigger(handler).timeBased().atHour(NIGHTLY_HOUR).nearMinute(NIGHTLY_MINUTE).everyDays(1).create();
  return { created: true };
}


// ---- Menu: 📱 Mobile API ------------------------------------------------------

// Connect this store: check its sync key, push the PINs and catalog, give
// Supabase the current cycle on a first connect, install the nightly run.
// Counting stays on the Sheet until Switch counting to Supabase.
// Editor-run, once per store by whoever connects it: asks Google for "Connect
// to an external service", then makes one call to show Supabase answers. When
// the permission is missing this run ends at the prompt; allow it and Run again.
function authorizeSupabase() {
  ScriptApp.requireScopes(ScriptApp.AuthMode.FULL, [SB_FETCH_SCOPE]);
  const t0 = Date.now();
  const r = supabaseRpc_('mog_sync_get_cycle', { p_slug: 'zzping', p_key: '0'.repeat(64) });
  Logger.log('Permission granted. Supabase answered in ' + (Date.now() - t0) + ' ms (' +
    (r.ok ? 'ok' : r.error) + '; a refusal is expected, the test uses a made-up key). ' +
    'Next: 📱 Mobile API → Connect to Supabase.');
}

// True only when this person is known not to have granted SB_FETCH_SCOPE.
function supabaseFetchNeedsGrant_() {
  try {
    return ScriptApp.getAuthorizationInfo(ScriptApp.AuthMode.FULL, [SB_FETCH_SCOPE])
      .getAuthorizationStatus() === ScriptApp.AuthorizationStatus.REQUIRED;
  } catch (e) { return false; }   // can't tell: the fetch itself will say
}

function alertFetchGrant_(ui) {
  ui.alert('One permission first',
    'This store\'s script needs Google\'s "Connect to an external service" permission, and a menu can\'t ask for it.\n\n' +
    'Open Extensions > Apps Script, open Sync.gs, pick authorizeSupabase in the function dropdown and press Run. ' +
    'Allow the permission, press Run once more, then come back here and connect.', ui.ButtonSet.OK);
}

function connectSupabase() {
  MOG_SKIP_CATALOG_QUEUE_ = true;
  const ui = SpreadsheetApp.getUi();
  if (supabaseFetchNeedsGrant_()) { alertFetchGrant_(ui); return; }
  const slugResp = ui.prompt('Connect to Supabase (1 of 2)',
    'This store\'s slug, as in stores.json (for example rprfo):', ui.ButtonSet.OK_CANCEL);
  if (slugResp.getSelectedButton() !== ui.Button.OK) return;
  const slug = slugResp.getResponseText().trim().toLowerCase();
  if (!/^[a-z0-9]{2,20}$/.test(slug)) { ui.alert('That doesn\'t look like a store slug.'); return; }

  const keyResp = ui.prompt('Connect to Supabase (2 of 2)',
    'Paste this store\'s sync key. To get one, run this in the Supabase SQL Editor and copy the result:\n\n' +
    '    select mog.provision_store(\'' + slug + '\');\n\n' +
    'Running it again replaces the key, so the old one stops working.', ui.ButtonSet.OK_CANCEL);
  if (keyResp.getSelectedButton() !== ui.Button.OK) return;
  const key = keyResp.getResponseText().trim();
  if (!/^[0-9a-f]{64}$/.test(key)) { ui.alert('A sync key is 64 characters, 0-9 and a-f.'); return; }

  // Check the key before saving anything.
  let check;
  try { check = supabaseRpc_('mog_sync_get_cycle', { p_slug: slug, p_key: key }); }
  catch (e) {
    if (/script\.external_request/.test(e.message)) alertFetchGrant_(ui);
    else ui.alert('Could not reach Supabase: ' + e.message);
    return;
  }
  if (!check.ok && check.error !== 'STORE_NOT_SYNCED') {
    ui.alert(check.error === 'BAD_SYNC_KEY'
      ? 'That key doesn\'t match store "' + slug + '". Run provision_store again and paste the new key.'
      : 'Supabase refused: ' + check.error);
    return;
  }

  const props = PropertiesService.getScriptProperties();
  props.setProperty(PROP_SB_SLUG, slug);
  props.setProperty(PROP_SB_SYNC_KEY, key);
  _SB_CONFIG_ = null;

  pushPinsNow_();
  const push = pushCatalogNow_();
  if (!check.ok) setDbStateFromSheet_();   // first connect: Supabase gets this store's cycle
  const nightly = ensureNightlyTrigger_();

  ui.alert('Connected to Supabase',
    'Store: ' + slug + '\n' +
    'Catalog pushed: ' + Math.round(push.bytes / 1024) + ' KB (built in ' + push.buildMs + ' ms, sent in ' + push.sendMs + ' ms)\n' +
    'Nightly 3:30 AM run: ' + (nightly.created ? 'installed' : 'already installed') + '\n\n' +
    'Counting still uses the Sheet. When you\'re ready: 📱 Mobile API → Switch counting to Supabase.',
    ui.ButtonSet.OK);
}

// Move this store's counting to Supabase: copy the cycle, Emergency Override,
// day picks and the counts entered so far, once; from then on /exec serves
// the count path from Supabase. Best right after a reset (no counts to copy).
function switchCountingToSupabase() {
  MOG_SKIP_CATALOG_QUEUE_ = true;
  const ui = SpreadsheetApp.getUi();
  const cfg = supabaseConfig_();
  if (!cfg.connected) { ui.alert('Connect to Supabase first (📱 Mobile API → Connect to Supabase).'); return; }
  if (cfg.switched)   { ui.alert('This store already counts in Supabase.'); return; }
  const go = ui.alert('Switch counting to Supabase?',
    'From now on this store\'s counts, Emergency Override, cycle and order log live in Supabase, and the ' +
    'app stops reading and writing them in this Sheet. Cycles close at 3:30 AM; the order log is still ' +
    'copied to LOG_ORDERS each night as a backup.\n\n' +
    'Counts already entered this cycle are copied over once. It\'s cleanest right after a reset.\n\nContinue?',
    ui.ButtonSet.YES_NO);
  if (go !== ui.Button.YES) return;

  pushCatalogNow_();
  setDbStateFromSheet_();
  const imported = importSheetCountsToDb_();
  PropertiesService.getScriptProperties().setProperty(PROP_BACKEND, 'supabase');
  _SB_CONFIG_ = null;
  ui.alert('Counting switched to Supabase', imported + ' count(s) copied over.', ui.ButtonSet.OK);
}

// EMERGENCY rollback: copy Supabase's current cycle back into the Sheet once
// (cycle date, Emergency Override, day picks, counts), then serve the count
// path from the Sheet again. The only code that writes counts to the Sheet.
function switchBackToSheet() {
  MOG_SKIP_CATALOG_QUEUE_ = true;
  const ui = SpreadsheetApp.getUi();
  if (!supabaseConfig_().switched) { ui.alert('This store already counts in the Sheet.'); return; }
  const go = ui.alert('Switch counting back to the Sheet?',
    'Emergency rollback. This copies Supabase\'s current cycle (counts, Emergency Override, day picks, ' +
    'cycle date) into this Sheet once, and the app goes back to reading and writing the Sheet.\n\nContinue?',
    ui.ButtonSet.YES_NO);
  if (go !== ui.Button.YES) return;

  const written = writeDbCycleToSheet_(supabaseSnapshot_(true));
  PropertiesService.getScriptProperties().deleteProperty(PROP_BACKEND);
  _SB_CONFIG_ = null;
  ui.alert('Counting is back on the Sheet', written + ' count(s) copied into the vendor tabs.', ui.ButtonSet.OK);
}

// Give Supabase the Sheet's current cycle: date, Emergency Override, day picks,
// and the dashboard's "sent" summary. Clears Supabase's counts for that cycle
// (importSheetCountsToDb_ refills them when switching).
function setDbStateFromSheet_() {
  const setup  = getSheet_(SHEET_SETUP);
  const active = getActiveOrderDate_();
  const picks  = {};
  readVendorOverrides_(setup).forEach(function (m, v) { picks[v] = m; });
  return supabaseSync_('mog_sync_set_state', {
    p_cycle_date:         active.dateStr,
    p_day_of_week:        active.dayOfWeek,
    p_emergency_override: readEmergencyOverride_(),
    p_vendor_picks:       picks,
    p_todays_log:         Array.from(getTodaysLogByVendor_(active.dateStr).values()),
    p_clear_cycle_counts: true
  });
}

// Copy the counts entered in the Sheet this cycle (vendor-tab column E) into
// Supabase, once, at the switch. Returns how many were copied.
function importSheetCountsToDb_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const cycle = getActiveOrderDate_().dateStr;
  let rows = [];
  for (const v of getVendorList_compute_()) {
    const sh = ss.getSheetByName(v);
    const roster = sh ? readVendorTabRoster_(sh) : null;
    if (!roster) continue;
    for (const r of roster) {
      if (!r.id || r.onHandRaw === '' || r.onHandRaw === null || isNaN(Number(r.onHandRaw))) continue;
      rows.push({ vendor: v, id: r.id, onHand: Number(r.onHandRaw) });
    }
  }
  let copied = 0;
  for (let i = 0; i < rows.length; i += 1000) {
    copied += supabaseSync_('mog_sync_put_counts', { p_cycle_date: cycle, p_rows: rows.slice(i, i + 1000) }).saved;
  }
  return copied;
}

// The rollback's copy into the Sheet: cycle date (AE9), Emergency Override (AD2),
// day picks (AF, row-aligned with the vendor list in Z), and each count onto
// its vendor tab's row for that item. Returns the counts written.
function writeDbCycleToSheet_(snap) {
  const ss    = SpreadsheetApp.getActiveSpreadsheet();
  const oe    = getSheet_(SHEET_ORDER_ENTRY);
  const setup = getSheet_(SHEET_SETUP);
  const st    = snap.state;
  const p     = st.cycleDate.split('-');
  oe.getRange(LAST_RESET_DATE_CELL).setValue(new Date(Number(p[0]), Number(p[1]) - 1, Number(p[2])));
  oe.getRange(EMERGENCY_OVERRIDE_CELL).setValue(st.emergencyOverride === true);

  const lastRow = setup.getLastRow();
  if (lastRow >= 2) {
    const names = setup.getRange(2, VENDOR_LIST_COL, lastRow - 1, 1).getValues();
    const picks = names.map(function (n) {
      const m = st.vendorPicks ? Number(st.vendorPicks[String(n[0] || '').trim()]) : NaN;
      return [(!isNaN(m) && m > 0) ? m : ''];
    });
    setup.getRange(2, VENDOR_OVERRIDE_COL, picks.length, 1).setValues(picks);
  }

  const counts = new Map();
  for (const c of snap.counts) counts.set(c.vendor + '\u0001' + c.id, c.onHand);
  let written = 0;
  for (const v of getVendorList_compute_()) {
    const sh = ss.getSheetByName(v);
    if (!sh || sh.getLastRow() < VENDOR_TAB.DATA_START_ROW) continue;
    const numRows = sh.getLastRow() - VENDOR_TAB.DATA_START_ROW + 1;
    const ids  = sh.getRange(VENDOR_TAB.DATA_START_ROW, VENDOR_TAB.ITEM_ID_COL, numRows, 1).getValues();
    const col  = sh.getRange(VENDOR_TAB.DATA_START_ROW, VENDOR_TAB.ON_HAND_COL, numRows, 1);
    const vals = col.getValues();
    let changed = false;
    for (let i = 0; i < ids.length; i++) {
      const key = v + '\u0001' + String(ids[i][0] || '').trim();
      if (!counts.has(key)) continue;
      const val = counts.get(key);
      vals[i][0] = (val === null || val === undefined) ? '' : val;
      changed = true;
      written++;
    }
    if (changed) col.setValues(vals);
  }
  bumpServerMutationTs_();
  return written;
}


// ---- Measuring ----------------------------------------------------------------

// Editor-run on a connected store: what a catalog push and a snapshot read
// cost from Apps Script. Read-only apart from re-pushing the same catalog.
function test_supabasePushTiming() {
  MOG_SKIP_CATALOG_QUEUE_ = true;
  if (!supabaseConfig_().connected) { Logger.log('Not connected: run 📱 Mobile API → Connect to Supabase first.'); return; }
  const lines = [];
  for (let i = 1; i <= 3; i++) {
    const r = pushCatalogNow_();
    lines.push('catalog push ' + i + ': build ' + r.buildMs + ' ms + send ' + r.sendMs + ' ms, ' +
               Math.round(r.bytes / 1024) + ' KB' + (r.applied ? '' : ' (NOT applied)'));
  }
  for (let i = 1; i <= 3; i++) {
    const t0 = Date.now();
    supabaseSnapshot_(true);
    lines.push('snapshot read ' + i + ': ' + (Date.now() - t0) + ' ms');
  }
  Logger.log(lines.join('\n'));
}
