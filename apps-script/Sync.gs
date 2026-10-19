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
// back the pre-edit list (the commitAddVendor_ trap, audit 07-29).
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
  requireEditorRun_();   // public for the editor's Run menu; refuses web callers (D18)
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
// labels names the two sides in the message (default: server, phone).
function syncDiff_(server, phone, labels) {
  const a = JSON.parse(JSON.stringify(server === undefined ? null : server));
  const b = JSON.parse(JSON.stringify(phone === undefined ? null : phone));
  return syncDiffAt_(a, b, '', labels || ['server', 'phone']);
}

function syncDiffAt_(a, b, path, labels) {
  const kind = function (v) { return Array.isArray(v) ? 'array' : (v === null ? 'null' : typeof v); };
  const show = function (v) {
    const s = JSON.stringify(v);
    return s.length > 120 ? s.slice(0, 117) + '...' : s;
  };
  const A = labels[0], B = labels[1];
  if (a === b) return '';
  if (kind(a) !== kind(b) || (kind(a) !== 'array' && kind(a) !== 'object')) {
    return (path || '(root)') + ': ' + A + ' ' + show(a) + ' vs ' + B + ' ' + show(b);
  }
  if (kind(a) === 'array') {
    if (a.length !== b.length) {
      const label = function (e) { return e && (e.id || e.name) ? String(e.id || e.name) : JSON.stringify(e); };
      const la = a.map(label), lb = b.map(label);
      const onlyA = la.filter(function (x) { return lb.indexOf(x) < 0; });
      const onlyB = lb.filter(function (x) { return la.indexOf(x) < 0; });
      return path + '.length: ' + A + ' ' + a.length + ' vs ' + B + ' ' + b.length +
        (onlyA.length ? ' (' + A + ' only: ' + onlyA.slice(0, 5).join(', ') + ')' : '') +
        (onlyB.length ? ' (' + B + ' only: ' + onlyB.slice(0, 5).join(', ') + ')' : '');
    }
    for (let i = 0; i < a.length; i++) {
      const d = syncDiffAt_(a[i], b[i], path + '[' + i + ']', labels);
      if (d) return d;
    }
    return '';
  }
  const keys = Object.keys(a);
  for (const k of Object.keys(b)) if (keys.indexOf(k) < 0) keys.push(k);
  for (const k of keys) {
    if (!(k in a)) return path + '.' + k + ': only the ' + B + ' has it';
    if (!(k in b)) return path + '.' + k + ': only the ' + A + ' has it';
    const d = syncDiffAt_(a[k], b[k], path + '.' + k, labels);
    if (d) return d;
  }
  return '';
}


// ===========================================================================
// Network half (step 4): Apps Script <-> Supabase
// ===========================================================================
// Two per-store switches, both in Script Properties:
//   connected  MOG_SUPABASE_SLUG + MOG_SUPABASE_SYNC_KEY are set. The catalog
//              and PINs are pushed and the 3:30 AM nightly run is installed.
//              On its own (only after Switch back to the Sheet) counting
//              uses the Sheet.
//   switched   connected AND MOG_BACKEND = "supabase". Menu: Move this store
//              to Supabase sets both. Counts, Emergency Override, the cycle and the
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
const PROP_EDITOR      = 'MOG_EDITOR';             // "supabase" once the catalog is edited in the app (schema v8)
const APP_BASE_URL     = 'https://sebheh.github.io/mog-mobile/';   // the store apps (GitHub Pages)
const PROP_CATALOG_PUSH_QUEUED = 'MOG_CATALOG_PUSH_QUEUED';  // doc prop: ms a background push was queued

// The one permission the sync needs beyond what each store already granted.
// Google's consent screen lets a person untick a permission, a Sheet menu can't
// re-ask for it, and the editor re-asks only when a script requests it. Move
// this store to Supabase shows Google's consent link instead (showFetchGrant_),
// with authorizeSupabase as the editor-run fallback.
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
  if (editorInApp_()) return { applied: false, skipped: 'edited in the app', buildMs: 0, sendMs: 0, bytes: 0 };
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
function pushCatalogFromPage_() {
  if (!supabaseConfig_().connected) return { pushed: false };
  try {
    return Object.assign({ pushed: true }, pushCatalogNow_());
  } catch (e) {
    Logger.log('pushCatalogFromPage_ failed, queuing a background retry: ' + e.message);
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
  if (editorInApp_()) return false;   // the app owns the catalog; nothing to push
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
// The switched store's version of commitLogAndReset_ + the AE9 stamp, with no
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
    // Same fallback as commitLogAndReset_: never silently lose the email.
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

// 3:30 AM on a connected store (installed by Move this store to Supabase):
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

// Editor-run fallback for the permission, for when the Move dialog's link
// doesn't work: asks Google for "Connect to an external service", then makes
// one call to show Supabase answers. When the permission is missing this run
// ends at the prompt; allow it and Run again. Also asks for the email
// permission requireEditorRun_ (Editor.gs) needs to recognize you in the editor.
// Not guarded itself: it changes nothing, and it's how a missing grant gets fixed.
function authorizeSupabase() {
  ScriptApp.requireScopes(ScriptApp.AuthMode.FULL,
    [SB_FETCH_SCOPE, 'https://www.googleapis.com/auth/userinfo.email']);
  const t0 = Date.now();
  const r = supabaseRpc_('mog_sync_get_cycle', { p_slug: 'zzping', p_key: '0'.repeat(64) });
  Logger.log('Permission granted. Supabase answered in ' + (Date.now() - t0) + ' ms (' +
    (r.ok ? 'ok' : r.error) + '; a refusal is expected, the test uses a made-up key). ' +
    'Next: 📱 Mobile API → Move this store to Supabase.');
}

// Google's consent link for SB_FETCH_SCOPE when this person hasn't granted it,
// '' when it's granted, null when Apps Script can't tell.
function supabaseFetchGrantUrl_() {
  try {
    const info = ScriptApp.getAuthorizationInfo(ScriptApp.AuthMode.FULL, [SB_FETCH_SCOPE]);
    return info.getAuthorizationStatus() === ScriptApp.AuthorizationStatus.REQUIRED
      ? (info.getAuthorizationUrl() || null) : '';
  } catch (e) { return null; }
}

// A Sheet menu can't open Google's consent screen, but a link to it can.
function showFetchGrant_(ui, url) {
  const attr = function (s) { return String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;'); };
  const html = '<div style="font:14px/1.5 Arial,sans-serif">' +
    '<p>This store\'s script needs Google\'s <b>Connect to an external service</b> permission first.</p>' +
    (url ? '<p><a href="' + attr(url) + '" target="_blank"><b>Grant permission</b></a> (opens a new tab)</p>' +
           '<p>Allow it there, close that tab, then run <b>📱 Mobile API → Move this store to Supabase</b> again.</p>' : '') +
    '<p style="color:#666">' + (url ? 'If the link doesn\'t ask you anything: ' : '') +
    'Extensions &gt; Apps Script, open Sync.gs, run <b>authorizeSupabase</b>, allow it, and Run again.</p></div>';
  ui.showModalDialog(HtmlService.createHtmlOutput(html).setWidth(460).setHeight(url ? 250 : 160), 'One permission first');
}

// Move this store to Supabase in one step: connect it (a connect code from
// supabase/provision_stores.sql), push the PINs and catalog, give Supabase the
// cycle and the counts entered so far, install the 3:30 AM run, switch, and
// then turn on direct phone access (schema v3's phone_direct). From then on
// phones read and save in Supabase, and /exec serves the count path from it
// for phones still on an old app. Each piece can run
// again, so after a failure the same menu item picks up where it stopped, and
// after Switch back to the Sheet it switches again without a code.
function moveToSupabase_() {
  MOG_SKIP_CATALOG_QUEUE_ = true;
  const ui = SpreadsheetApp.getUi();
  const props = PropertiesService.getScriptProperties();
  const cfg = supabaseConfig_();
  if (cfg.switched) { ui.alert('This store already counts in Supabase.'); return; }
  const grantUrl = supabaseFetchGrantUrl_();
  if (grantUrl) { showFetchGrant_(ui, grantUrl); return; }

  let slug = cfg.slug, key = cfg.key;
  if (!cfg.connected) {
    const resp = ui.prompt('Move this store to Supabase',
      'Paste this store\'s connect code, from supabase/provision_stores.sql in the Supabase SQL Editor ' +
      '(the store, a colon, then 64 characters):', ui.ButtonSet.OK_CANCEL);
    if (resp.getSelectedButton() !== ui.Button.OK) return;
    const m = /^\s*["']?([a-z0-9]{2,20}):([0-9a-f]{64})["']?\s*$/i.exec(resp.getResponseText());
    if (!m) { ui.alert('That isn\'t a connect code. One looks like rpr:3f9a… (the store, a colon, then 64 characters, 0-9 and a-f).'); return; }
    slug = m[1].toLowerCase();
    key  = m[2].toLowerCase();

    // Check the code before saving anything.
    let check;
    try { check = supabaseRpc_('mog_sync_get_cycle', { p_slug: slug, p_key: key }); }
    catch (e) {
      if (/script\.external_request/.test(e.message)) showFetchGrant_(ui, supabaseFetchGrantUrl_());
      else ui.alert('Could not reach Supabase: ' + e.message);
      return;
    }
    if (check.ok) {
      ui.alert('Store "' + slug + '" is already connected from another Sheet, so this code is probably for a ' +
        'different Sheet. Nothing was changed.');
      return;
    }
    if (check.error !== 'STORE_NOT_SYNCED') {
      ui.alert(check.error === 'BAD_SYNC_KEY'
        ? 'That code doesn\'t match store "' + slug + '". It may be from an older run of provision_stores.sql: run it again and use the new code.'
        : 'Supabase refused: ' + check.error);
      return;
    }
  }

  const location = props.getProperty(PROP_LOCATION);
  const go = ui.alert('Move this store to Supabase?',
    'This Sheet: ' + SpreadsheetApp.getActiveSpreadsheet().getName() + (location ? ' (' + location + ')' : '') + '\n' +
    'Code is for store: ' + slug + '\n\n' +
    'From now on its counts, Emergency Override, cycle and order log live in Supabase, and the app stops ' +
    'reading and writing them in this Sheet. Cycles close at 3:30 AM; the order log is still copied to ' +
    'LOG_ORDERS each night as a backup. Counts already entered this cycle are copied over once.\n\nContinue?',
    ui.ButtonSet.YES_NO);
  if (go !== ui.Button.YES) return;

  let push, imported, nightly;
  try {
    if (!cfg.connected) {
      props.setProperty(PROP_SB_SLUG, slug);
      props.setProperty(PROP_SB_SYNC_KEY, key);
      _SB_CONFIG_ = null;
    }
    pushPinsNow_();
    push = pushCatalogNow_();
    setDbStateFromSheet_();
    imported = importSheetCountsToDb_();
    nightly = ensureNightlyTrigger_();
    props.setProperty(PROP_BACKEND, 'supabase');
    _SB_CONFIG_ = null;
  } catch (e) {
    ui.alert('Not finished', 'Moving stopped: ' + e.message + '\n\nThis store still counts in the Sheet. ' +
      'Run 📱 Mobile API → Move this store to Supabase again; it picks up where it stopped.', ui.ButtonSet.OK);
    return;
  }
  // Phones last, only once the store counts in Supabase (D12). If this fails
  // the move still stands: phones keep using /exec, which now serves this
  // store from Supabase.
  let phones = 'on';
  try { supabaseSync_('mog_sync_set_phone_direct', { p_on: true }); }
  catch (e) { phones = 'NOT turned on (' + e.message + '). Run supabase/phones_direct.sql in the SQL Editor'; }
  ui.alert('Moved to Supabase',
    'Store: ' + slug + '\n' +
    'Counts copied: ' + imported + '\n' +
    'Catalog pushed: ' + Math.round(push.bytes / 1024) + ' KB\n' +
    'Nightly 3:30 AM run: ' + (nightly.created ? 'installed' : 'already installed') + '\n' +
    'Phones talk to Supabase directly: ' + phones + '\n\n' +
    'Rollback (emergency only): 📱 Mobile API → Switch back to the Sheet.', ui.ButtonSet.OK);
}

// EMERGENCY rollback: turn off direct phone access (schema v3, so phones go
// back through /exec), copy Supabase's current cycle back into the Sheet once
// (cycle date, Emergency Override, day picks, counts), then serve the count
// path from the Sheet again. The only code that writes counts to the Sheet.
function switchBackToSheet_() {
  MOG_SKIP_CATALOG_QUEUE_ = true;
  const ui = SpreadsheetApp.getUi();
  if (!supabaseConfig_().switched) { ui.alert('This store already counts in the Sheet.'); return; }
  const go = ui.alert('Switch counting back to the Sheet?',
    'Emergency rollback. This copies Supabase\'s current cycle (counts, Emergency Override, day picks, ' +
    'cycle date) into this Sheet once, and the app goes back to reading and writing the Sheet.\n\nContinue?',
    ui.ButtonSet.YES_NO);
  if (go !== ui.Button.YES) return;

  // Phones first: while the Sheet counts, no phone may write to Supabase.
  try { supabaseSync_('mog_sync_set_phone_direct', { p_on: false }); }
  catch (e) {
    // HTTP 404 = schema v3 isn't installed, so no phone can be direct anyway.
    if (!/HTTP 404/.test(e.message)) {
      ui.alert('Not switched', 'Could not turn off direct phone access first: ' + e.message +
        '\n\nNothing was changed. Try again in a minute.', ui.ButtonSet.OK);
      return;
    }
  }
  const written = writeDbCycleToSheet_(supabaseSnapshot_(true));
  PropertiesService.getScriptProperties().deleteProperty(PROP_BACKEND);
  _SB_CONFIG_ = null;
  ui.alert('Counting is back on the Sheet', written + ' count(s) copied into the vendor tabs.', ui.ButtonSet.OK);
}

// ---- The editor in the app (one app per store, Phase 4; schema v8) ----------

// Whether this store's catalog is edited in the app: Supabase owns it, the
// Sheet's catalog tools refuse (an edit here would never reach the app), and
// the Sheet stops pushing its catalog. The Sheet keeps the catalog it had and
// is not updated again (no copy back, Sebastian 2026-10-18).
function editorInApp_() {
  return PropertiesService.getScriptProperties().getProperty(PROP_EDITOR) === 'supabase';
}
function appEditorUrl_() { return APP_BASE_URL + supabaseConfig_().slug + '/editor/'; }
function editorMovedMessage_() {
  return 'This store\'s items, vendors, storage areas and lists are edited in the app now, on a computer: ' +
         appEditorUrl_() + ' (or Editor in the app\'s menu on the left).';
}
// The Sheet menu's catalog tools call this first; true = refused (and said so).
function refuseCatalogToolInSheet_() {
  if (!editorInApp_()) return false;
  const ui = SpreadsheetApp.getUi();
  ui.alert('Edited in the app', editorMovedMessage_(), ui.ButtonSet.OK);
  return true;
}

// 📱 Mobile API → Move the editor to the app. Either copies this Sheet's
// catalog into the app (seeded right before the switch, which Supabase then
// stops accepting), or starts the app from an empty catalog: for a Sheet that
// is an unused copy of another store's (TNY Rockville, Sebastian 2026-10-18),
// whose catalog then comes from MarginEdge. Running it again changes nothing.
// The copy goes ahead only when the parity check passes (D20): the seed is
// catalogTablesParity_'s own, so every phone screen is compared from exactly
// the tables the switch then hands to the editor.
function moveEditorToApp_() {
  MOG_SKIP_CATALOG_QUEUE_ = true;
  const ui = SpreadsheetApp.getUi();
  const cfg = supabaseConfig_();
  if (!cfg.connected) { ui.alert('Move this store to Supabase first (📱 Mobile API → Move this store to Supabase).'); return; }
  if (editorInApp_()) { ui.alert('Already in the app', editorMovedMessage_(), ui.ButtonSet.OK); return; }
  const grantUrl = supabaseFetchGrantUrl_();
  if (grantUrl) { showFetchGrant_(ui, grantUrl); return; }
  let status;
  try { status = supabaseSync_('mog_sync_get_status', {}); }
  catch (e) { ui.alert('Could not reach Supabase: ' + e.message); return; }
  if (status.editorDirect) {   // moved already (in the SQL Editor, say): only this Sheet needs to know
    PropertiesService.getScriptProperties().setProperty(PROP_EDITOR, 'supabase');
    dropTriggersFor_('catalogPushTrigger_');
    ui.alert('Already in the app', 'Supabase already owns this store\'s catalog; this Sheet now knows it.\n\n' +
      editorMovedMessage_(), ui.ButtonSet.OK);
    return;
  }

  const choice = ui.alert('Move the editor to the app',
    'From now on this store\'s items, vendors, storage areas and lists are edited in the app, on a computer, ' +
    'and this Sheet\'s catalog tools refuse. The Sheet keeps the catalog it has now but is not updated again.\n\n' +
    'Start the app from an EMPTY catalog?\n\n' +
    'Yes: start empty (for a Sheet that is an unused copy of another store\'s). Then import from MarginEdge.\n' +
    'No: copy this Sheet\'s catalog into the app.\n' +
    'Cancel: change nothing.', ui.ButtonSet.YES_NO_CANCEL);
  if (choice !== ui.Button.YES && choice !== ui.Button.NO) return;
  const startEmpty = choice === ui.Button.YES;
  if (startEmpty) {
    const sure = ui.prompt('Start empty',
      'This deletes the app\'s catalog for store "' + cfg.slug + '": every vendor, item, storage area and list. ' +
      'Its phones show nothing until it is set up again. Type the store code (' + cfg.slug + ') to continue.',
      ui.ButtonSet.OK_CANCEL);
    if (sure.getSelectedButton() !== ui.Button.OK || sure.getResponseText().trim().toLowerCase() !== cfg.slug) {
      ui.alert('Nothing was changed.');
      return;
    }
  }

  let res;
  try {
    if (!startEmpty) {
      const parity = catalogTablesParity_();
      if (!parity.ok) {
        const report = formatCatalogParity_(parity).split('\n');
        ui.alert('Not moved',
          'The app would not show this store exactly as this Sheet does, so the editor stays in the Sheet.\n\n' +
          report.slice(0, 20).join('\n') + (report.length > 20 ? '\n...' : '') + '\n\n' +
          'Fix those rows in the Sheet (📱 Mobile API → Store Health Check repairs most), then try again. ' +
          'The whole report: run test_catalogTablesParity in Sync.gs.', ui.ButtonSet.OK);
        return;
      }
    }
    res = supabaseSync_('mog_sync_switch_editor', { p_start_empty: startEmpty });
  } catch (e) {
    ui.alert('Not moved', 'Moving the editor stopped: ' + e.message + '\n\nThe editor is still in the Sheet. ' +
      (/HTTP 404/.test(e.message) ? 'Run supabase/schema_v8.sql in the SQL Editor first.' : 'Try again in a minute.'),
      ui.ButtonSet.OK);
    return;
  }
  PropertiesService.getScriptProperties().setProperty(PROP_EDITOR, 'supabase');
  dropTriggersFor_('catalogPushTrigger_');
  ui.alert('The editor is in the app',
    (res.alreadySwitched ? 'It already was in Supabase; this Sheet now knows it.'
      : startEmpty ? 'The app starts from an empty catalog.' : 'The app has this Sheet\'s catalog.') + '\n\n' +
    'Editor: ' + appEditorUrl_() + '\n' +
    'It opens once the store\'s editor is published (stores.json "editor": "supabase", then build.py).',
    ui.ButtonSet.OK);
}

// Emergency rollback, run from the Apps Script editor (Sync.gs): this Sheet's
// catalog tools work and push again. First, in the Supabase SQL Editor:
//   update mog.stores set editor_direct = false where slug = '<slug>';
// (until then Supabase refuses the Sheet's pushes). Anything edited in the
// app since the move is NOT in this Sheet.
function editorBackToSheet() {
  requireEditorRun_();
  PropertiesService.getScriptProperties().deleteProperty(PROP_EDITOR);
  Logger.log('This Sheet\'s catalog tools work again for ' + supabaseConfig_().slug + '. If not done yet, run ' +
    'update mog.stores set editor_direct = false where slug = \'' + supabaseConfig_().slug + '\'; in the Supabase ' +
    'SQL Editor, then push the catalog (Store Health Check). Edits made in the app since the move are not in this Sheet.');
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
  requireEditorRun_();   // public for the editor's Run menu; refuses web callers (D18)
  MOG_SKIP_CATALOG_QUEUE_ = true;
  if (!supabaseConfig_().connected) { Logger.log('Not connected: run 📱 Mobile API → Move this store to Supabase first.'); return; }
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


// ===========================================================================
// Step 6: the catalog in tables (schema v4, design record D19-D22)
// ===========================================================================
// Before a store's editor moves to Supabase, its catalog has to come out of
// Supabase's tables exactly as phones read it today. test_catalogTablesParity
// copies this Sheet's catalog into the tables (inert until the store's
// editor_direct switch is on, so a KM sees no change) and checks that every
// phone screen built from Supabase's version matches the Sheet's: every
// vendor, every day of the week, Emergency Override off and on.

// This Sheet's catalog as schema v4's tables. Same readers as
// buildCatalogPayload_, fresh reads only. The tables enforce rules the Sheet
// doesn't (a pick row names a listed vendor, an existing item and an existing
// storage area; names are unique ignoring case), so a row that breaks one is
// cleaned on the way in and the cleanup is listed in `notes`. Whether a
// cleanup changes what a phone shows is for catalogParityReport_ to say.
function buildCatalogTables_() {
  const ss    = SpreadsheetApp.getActiveSpreadsheet();
  const setup = getSheet_(SHEET_SETUP);
  const props = PropertiesService.getScriptProperties();
  const days  = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  const notes = [];
  const note  = function (kind, detail) { notes.push({ kind: kind, detail: detail }); };

  // ---- Vendors: the listed ones (SETUP Z deduped ignoring case, first spelling wins) ----
  const vendorList  = getVendorList_compute_();
  const canonVendor = new Map(vendorList.map(function (v) { return [v.toLowerCase(), v]; }));
  const multMap     = readVendorMultipliers_(setup);
  const cutoffMap   = readVendorCutoffs_(setup);
  const lastRow     = setup.getLastRow();
  if (lastRow >= 2) {
    setup.getRange(2, VENDOR_LIST_COL, lastRow - 1, 1).getValues().forEach(function (r, i) {
      const v = String(r[0] || '').trim();
      const canon = v ? canonVendor.get(v.toLowerCase()) : null;
      if (canon && canon !== v) note('vendor', 'SETUP Z' + (i + 2) + ' "' + v + '" is another spelling of "' + canon + '": left out');
    });
  }
  const vendors = vendorList.map(function (v) {
    const m = multMap.get(v) || {};   // the row vendorDayMultiplier_ reads for this exact name
    const mults = days.map(function (d) {
      const x = Number(m[d]) || 0;
      if (isFinite(x)) return x;
      note('vendor', v + ': ' + d + ' multiplier is not a finite number: stored as 0');
      return 0;
    });
    let cutoff = cutoffMap.get(v) || (VENDOR_META[v] || {}).cutoffTime || null;
    if (cutoff !== null && !/^([01][0-9]|2[0-3]):[0-5][0-9]$/.test(cutoff)) {
      note('vendor', v + ': cutoff "' + cutoff + '" is not HH:MM: stored as none');
      cutoff = null;
    }
    return { name: v, mults: mults, cutoff: cutoff };
  });

  // ---- Storage areas (SETUP H:I): a name with a numeric order, one per name ignoring case ----
  const areas     = [];
  const canonArea = new Map();
  const areaOrd   = new Map();
  readAreaBlock_(setup).block.forEach(function (r, i) {
    const name = String(r[0] || '').trim();
    if (!name) return;
    const ord = Number(r[1]);
    if (!Number.isFinite(ord)) { note('area', 'SETUP H' + (i + 2) + ' "' + name + '" has no numeric order: left out'); return; }
    const key = name.toLowerCase();
    if (canonArea.has(key)) { note('area', 'SETUP H' + (i + 2) + ' "' + name + '" repeats "' + canonArea.get(key) + '": left out'); return; }
    canonArea.set(key, name);
    areaOrd.set(name, ord);
    areas.push({ name: name, ord: ord });
  });

  // ---- Items (MASTER_ITEMS): the payload's own reader, plus the columns it skips ----
  const meta   = readMasterItemMeta_();   // a repeated Item ID: the last row wins, as the app reads it
  const extras = new Map();
  const master = getSheet_(SHEET_MASTER);
  const mLast  = master.getLastRow();
  if (mLast >= 2) {
    master.getRange(2, 1, mLast - 1, COL.ELIGIBLE_VENDORS).getValues().forEach(function (r, i) {
      const id  = String(r[COL.ID - 1] || '').trim();
      const row = i + 2;
      if (!id) {
        if (String(r[COL.NAME - 1] || '').trim() || r[COL.ACTIVE - 1] === true) {
          note('item', 'MASTER_ITEMS row ' + row + ' has no Item ID: left out');
        }
        return;
      }
      if (extras.has(id)) note('item', id + ' appears again on MASTER_ITEMS row ' + row + ': the last row wins');
      extras.set(id, {
        row:         row,
        notes:       String(r[COL.NOTES - 1] || '').trim(),
        sku:         String(r[COL.SKU - 1] || '').trim(),
        category:    String(r[COL.CATEGORY - 1] || '').trim(),
        eligibleRaw: r[COL.ELIGIBLE_VENDORS - 1]
      });
    });
  }
  const items = [];
  meta.forEach(function (m, id) {
    const x = extras.get(id) || {};
    const primary = m.primaryVendor ? (canonVendor.get(m.primaryVendor.toLowerCase()) || null) : null;
    if (m.primaryVendor && !primary) {
      note('item', id + ': primary vendor "' + m.primaryVendor + '" is not a listed vendor: stored as none');
    } else if (primary && primary !== m.primaryVendor) {
      note('item', id + ': primary vendor "' + m.primaryVendor + '" stored as "' + primary + '"');
    }
    items.push({
      id:            id,
      name:          m.name,
      primaryVendor: primary,
      pack:          m.pack,
      par:           isNaN(m.par) ? null : m.par,
      active:        m.active,
      useMult:       m.useMult,
      notes:         x.notes || '',
      sku:           x.sku || '',
      category:      x.category || '',
      eligible:      normalizeEligibleList_(x.eligibleRaw, primary || '', canonVendor),
      seq:           x.row || 0
    });
  });

  // ---- Pick rows (SETUP K:P) ----
  const itemIds  = new Set(items.map(function (it) { return it.id; }));
  const onList   = new Set();
  const pickRows = [];
  readPickDb_(setup).map(catalogPickRow_).forEach(function (r, i) {
    const row  = i + PICKDB.START_ROW;
    const rawV = (r[0] === null || r[0] === undefined) ? '' : String(r[0]);
    const vt   = rawV.trim();
    const id   = String(r[1] || '').trim();
    if (!vt && !id) return;   // an empty row
    const at = 'SETUP K' + row + ' ';
    const vendor = canonVendor.get(vt.toLowerCase());
    if (!vendor) { note('pick', at + '"' + vt + '" / ' + (id || '(no id)') + ': vendor is not listed: left out'); return; }
    if (rawV !== vendor) note('pick', at + 'vendor "' + rawV + '" stored as "' + vendor + '"');
    if (!id) { note('pick', at + vendor + ': no Item ID: left out'); return; }
    if (!itemIds.has(id)) { note('pick', at + vendor + ' / ' + id + ': not in MASTER_ITEMS: left out'); return; }
    const key = vendor + '\u0001' + id;
    if (onList.has(key)) { note('pick', at + vendor + ' / ' + id + ' is on that list already: left out'); return; }
    onList.add(key);

    const areaText = String(r[3] || '').trim();
    let area = null;
    if (areaText) {
      area = canonArea.get(areaText.toLowerCase()) || null;
      if (!area) note('pick', at + vendor + ' / ' + id + ': storage area "' + areaText + '" does not exist: stored as none');
      else if (area !== areaText) note('pick', at + vendor + ' / ' + id + ': storage area "' + areaText + '" stored as "' + area + '"');
    }
    // The tables look the order up from the area itself, so it can't drift.
    const sheetOrd = Number(r[4]) || 999;
    const tableOrd = area ? (Number(areaOrd.get(area)) || 999) : 999;
    if (sheetOrd !== tableOrd) {
      note('pick', at + vendor + ' / ' + id + ': area order ' + JSON.stringify(r[4]) + ' becomes ' +
        (area ? areaOrd.get(area) + ' (the order of ' + area + ')' : 'none'));
    }
    const shelf = (r[5] === '' || r[5] === null || r[5] === undefined) ? null : Number(r[5]);
    pickRows.push({ vendor: vendor, id: id, area: area,
                    shelfOrder: (shelf !== null && Number.isFinite(shelf)) ? shelf : null, seq: row });
  });

  return {
    tables: {
      profile: {
        timeZone: ss.getSpreadsheetTimeZone(),
        location: props.getProperty(PROP_LOCATION) || 'Unknown',
        abbr:     props.getProperty(PROP_LOCATION_ABBR) || '',
        concept:  props.getProperty(PROP_CONCEPT) || ''
      },
      vendors:  vendors,
      areas:    areas,
      items:    items,
      pickRows: pickRows
    },
    notes: notes
  };
}


// What a phone shows from two catalogs, compared: the Sheet's payload against
// the one Supabase built from its tables. Every vendor on either list, every
// day of the week, Emergency Override off and on (with the cycle's real day
// picks), the dashboard and every vendor's count screen, over this cycle's
// counts. Pure (OrderMath.gs only). ok = no screen differs. payloadDiff is the
// first difference in the raw JSON, for information: some differ without
// changing any screen (an item name stored on a pick row, say).
function catalogParityReport_(sheetCatalog, tableCatalog, state, counts) {
  const labels  = ['Sheet', 'tables'];
  const a       = JSON.parse(JSON.stringify(sheetCatalog));
  const b       = JSON.parse(JSON.stringify(tableCatalog));
  const days    = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  const vendors = (a.vendorList || []).slice();
  for (const v of (b.vendorList || [])) if (vendors.indexOf(v) < 0) vendors.push(v);

  const report = { vendors: vendors.length, checks: 0, diffs: [], diffCount: 0,
                   payloadDiff: syncDiff_(a, b, labels), ok: true };
  const add = function (what, d) {
    report.diffCount++;
    if (report.diffs.length < 30) report.diffs.push(what + ': ' + d);
  };
  const base = state || { cycleDate: '', vendorPicks: {}, todaysLog: [] };
  for (const day of days) {
    for (const override of [false, true]) {
      const st  = Object.assign({}, base, { dayOfWeek: day, emergencyOverride: override });
      const ia  = orderInputsFromSnapshot_({ catalog: a, state: st, counts: counts || [] });
      const ib  = orderInputsFromSnapshot_({ catalog: b, state: st, counts: counts || [] });
      const tag = day + (override ? ' (override on)' : '');
      report.checks++;
      const dd = syncDiff_(dashboardFromSnapshot_(ia), dashboardFromSnapshot_(ib), labels);
      if (dd) add(tag + ' dashboard', dd);
      for (const v of vendors) {
        report.checks++;
        const d = syncDiff_(vendorItemsFromSnapshot_(ia, v), vendorItemsFromSnapshot_(ib, v), labels);
        if (d) add(tag + ' ' + v, d);
      }
    }
  }
  report.ok = report.diffCount === 0;
  return report;
}


// Seed the tables from this Sheet and compare. Never throws: a refused seed
// (bad data, editor_direct on) comes back as ok:false with the reason.
function catalogTablesParity_() {
  const built  = buildCatalogTables_();
  const t      = built.tables;
  const result = { store: t.profile.location, slug: supabaseConfig_().slug, notes: built.notes,
                   seeded: null, error: null, report: null, ok: false };
  let seeded;
  try {
    seeded = supabaseSync_('mog_sync_seed_catalog', { p_tables: t });
  } catch (e) {
    result.error = e.message;
    return result;
  }
  result.seeded = seeded.seeded;

  // This cycle's state and counts, so in-progress screens are compared too.
  let state = null, counts = [];
  if (supabaseConfig_().switched) {
    try {
      const snap = supabaseSnapshot_(true);
      state  = snap.state;
      counts = snap.counts || [];
    } catch (e) { /* compare without counts */ }
  }
  result.report = catalogParityReport_(buildCatalogPayload_(), seeded.catalog, state, counts);
  result.ok = result.report.ok;
  return result;
}

function formatCatalogParity_(r) {
  const lines = ['Catalog tables parity: ' + r.store + (r.slug ? ' (' + r.slug + ')' : '')];
  if (r.error) {
    lines.push('Seed refused: ' + r.error);
    if (/EDITOR_DIRECT/.test(r.error)) {
      lines.push('This store\'s editor already writes to Supabase, so the Sheet can no longer seed its catalog.');
    }
  } else {
    const s = r.seeded || {};
    lines.push('Seeded: ' + s.vendors + ' vendors, ' + s.areas + ' storage areas, ' + s.items + ' items, ' +
               s.pickRows + ' pick rows');
  }
  if (r.notes.length) {
    lines.push('Cleaned on the way in (' + r.notes.length + '):');
    for (const n of r.notes.slice(0, 50)) lines.push('  [' + n.kind + '] ' + n.detail);
    if (r.notes.length > 50) lines.push('  ... and ' + (r.notes.length - 50) + ' more');
  }
  if (r.report) {
    const rep = r.report;
    if (rep.ok) {
      lines.push('Phones: MATCH on every screen (' + rep.vendors + ' vendors x 7 days x override off/on, ' +
                 rep.checks + ' screens)');
    } else {
      lines.push('Phones: ' + rep.diffCount + ' of ' + rep.checks + ' screens DIFFER:');
      for (const d of rep.diffs) lines.push('  ' + d);
      if (rep.diffCount > rep.diffs.length) lines.push('  ... and ' + (rep.diffCount - rep.diffs.length) + ' more');
      if (r.notes.length) lines.push('The cleanups above are the likely cause: fix those rows in the Sheet, then run this again.');
    }
    lines.push('Raw JSON: ' + (rep.payloadDiff ? 'first difference ' + rep.payloadDiff : 'identical'));
  }
  lines.push('RESULT: ' + (r.ok ? 'PASS' : 'FAIL'));
  return lines.join('\n');
}

// Editor-run (Run > test_catalogTablesParity). Copies this Sheet's catalog
// into Supabase's catalog tables and checks phones would show exactly the
// same thing from them. The tables are inert until the store's editor moves
// to Supabase, so this changes nothing a KM sees. A store's editor can only
// switch after a PASS (D20).
function test_catalogTablesParity() {
  requireEditorRun_();   // public for the editor's Run menu; refuses web callers (D18)
  if (!supabaseConfig_().connected) {
    Logger.log('Not connected: run 📱 Mobile API → Move this store to Supabase first.');
    return null;
  }
  const r = catalogTablesParity_();
  Logger.log(formatCatalogParity_(r));
  return r;
}
