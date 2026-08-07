/***********************
 * MOG MOBILE API
 *
 * Web-app endpoints for the companion PWA (sebheh.github.io/mog-mobile).
 * doPost is the single PWA endpoint, dispatching on { pin, action, payload }.
 * doGet routes the KM web editor + first-run setup wizard (?page=…, rendered
 * in Editor.gs) and the JSON health probe (?page=api).
 *
 * SETUP (per location):
 *   The ?page=setup wizard on a fresh /exec deployment is the primary path
 *   (writes the identity props, minus the master PIN). The full end-to-end
 *   onboarding — Drive copy, Script ID, .clasp-targets.json, web-app deploy,
 *   stores.json — is the repo's mog-add-store skill. setupMobileApi()
 *   (Admin.gs) remains the editor-run fallback. Vendor cutoff times are set
 *   in Manage Vendors (stored in SETUP!AA); the VENDOR_META constant below
 *   is a legacy fallback only.
 *
 * NOTES:
 *   - All .gs files share one flat global scope. This file owns doGet/doPost,
 *     the api_* handlers, and the shared constants below. Recap + recipients
 *     live in Recap.gs; admin/config + test fns in Admin.gs (2026-07-24 split).
 *   - Reads MASTER_ITEMS, SETUP, LOG_ORDERS, and vendor tabs (On Hand col E
 *     + Item ID col M only — the order math is computed in code; see
 *     computeSuggestedQty_ / vendorDayMultiplier_).
 *   - Writes vendor-tab On Hand (col E), LOG_ORDERS (append on submit), the
 *     reset-date + Emergency Override cells on ORDER_ENTRY, and the recap
 *     recipients list (SETUP AB-AE). Counting in the PWA and typing in the
 *     Sheet update the same cells — the two surfaces share state.
 *   - The PWA hits a VERSIONED /exec snapshot: changes to this file (or
 *     anything it calls) ship via `python deploy.py --redeploy`, never
 *     push-only.
 *
 * CORS NOTE FOR PWA CLIENT:
 *   Apps Script Web Apps reject application/json POSTs (CORS preflight).
 *   The PWA must use Content-Type: text/plain;charset=utf-8 and put the
 *   JSON in the body. Apps Script reads it from e.postData.contents.
 ***********************/

const API_VERSION         = '0.9.0';
const PROP_PIN            = 'MOG_API_PIN';
const PROP_MASTER_PIN     = 'MOG_API_MASTER_PIN';  // multi-unit manager bypass
const PROP_GM_EMAIL       = 'MOG_GM_EMAIL';        // legacy: seed for recipients list on first read
const PROP_LOCATION       = 'MOG_LOCATION_NAME';
const PROP_LOCATION_ABBR  = 'MOG_LOCATION_ABBR';
const PROP_CONCEPT        = 'MOG_CONCEPT';        // dashboard branding: 'roll-play' | 'teasnyou' (unset → default navy)

// Cycle-date of the most recent successful recap send. Gates auto-send
// paths (PWA pre-reset, sheet-reset, bulk-mark) so the same cycle's
// email doesn't fire twice. Manual sends bypass via payload.force.
const PROP_LAST_RECAP_SENT_DATE = 'MOG_LAST_RECAP_SENT_DATE';

// Async recap handoff. The reset no longer sends the recap inline — it stamps
// the cycle here and arms a one-shot time-based trigger (sendPendingRecap_), so
// the KM's reset returns without waiting on Gmail. Holds
// {cycleDate, attempts}; deleted once the cycle is delivered or abandoned.
const PROP_PENDING_RECAP   = 'MOG_PENDING_RECAP';
const RECAP_SEND_DELAY_MS  = 60 * 1000;  // one-shot trigger delay (Apps Script rounds to ~1 min)
const RECAP_SEND_MAX_TRIES = 3;          // bounded retry — see sendPendingRecap_

// Recipient list lives in SETUP columns AB-AE, rows 2+.
// AB: name, AC: email, AD: active (TRUE/FALSE), AE: GM (TRUE/FALSE).
// GM rows are visible but locked from the PWA — only editable in the sheet.
// Header is row 1; written lazily on first read so existing stores get
// it without re-running setupMobileApi.
const RECIPIENTS_START_COL = 28;  // AB
const RECIPIENTS_NUM_COLS  = 4;
const RECIPIENTS_HEADER_ROW = 1;
const RECIPIENTS_START_ROW  = 2;

// PIN rate-limiting state. Counter increments on every failed PIN attempt
// and resets to zero on a successful match. When the counter hits
// PIN_MAX_ATTEMPTS, PROP_PIN_LOCKOUT_UNTIL is set to "now + PIN_LOCKOUT_MS"
// and further attempts (including correct ones) are rejected until that
// timestamp passes. Lockout is global per deployment — there's no reliable
// per-IP signal in Apps Script web apps, so the bucket is shared. If a
// real manager needs in during a lockout, run clearPinLockout() from the
// editor or wait it out.
const PROP_PIN_FAIL_COUNT   = 'MOG_PIN_FAIL_COUNT';
const PROP_PIN_LOCKOUT_UNTIL = 'MOG_PIN_LOCKOUT_UNTIL';
const PIN_MAX_ATTEMPTS = 5;
const PIN_LOCKOUT_MS   = 5 * 60 * 1000;  // 5 minutes

// Optional fallback vendor metadata. Cutoff times are now read primarily
// from SETUP column AA (see VENDOR_CUTOFF_COL in Core.gs) —
// edit them through the ManageVendors sidebar's Add tab or View All
// inline editor instead of touching this file.
//
// This map is kept as a compatibility fallback: if SETUP column AA is
// empty for a vendor, the dashboard falls back to whatever's listed
// here. Useful only during initial rollout / migration. Leave empty for
// production deployments once cutoffs have been entered in SETUP.
const VENDOR_META = {
  // 'Sysco':             { cutoffTime: '14:00' },
  // "Murray's Chicken":  { cutoffTime: '16:00' },
};


/***********************
 * 1) WEB APP ENTRY POINTS
 ***********************/

function doGet(e) {
  // Page routing (mirrors MVS/MPS). New pages are additive; the default
  // path below is unchanged, and the PWA never calls doGet (it only POSTs),
  // so adding routes here cannot affect the ordering app.
  const page = (e && e.parameter && e.parameter.page) ? String(e.parameter.page) : '';
  const props = PropertiesService.getScriptProperties();
  const configured = !!props.getProperty(PROP_PIN);

  // Health / API probe — an EXPLICIT endpoint so the plain /exec can open the
  // editor (below) while debugging + onboarding checks still have a JSON
  // response. Works in either configured state. (The PWA never needs this — it
  // only POSTs — but it preserves the old bare-GET payload for humans/tools.)
  if (page === 'api' || page === 'health') {
    return jsonResponse_({
      ok: true,
      service: 'MOG Mobile API',
      version: API_VERSION,
      location: props.getProperty(PROP_LOCATION) || 'Not configured',
      message: 'POST to this URL with { pin, action, payload }'
    });
  }

  // First-run: an UNCONFIGURED store sends every browser GET (including the bare
  // URL the owner opens right after deploying) to the setup wizard — you can't
  // gate on a PIN that doesn't exist yet.
  if (!configured) return renderStoreSetupWeb_();

  // CONFIGURED store. The PLAIN /exec opens the editor home — the easy link the
  // owner bookmarks for editing pars/items; page= picks a specific tool. The PWA
  // is unaffected: it only POSTs (doPost), which never reaches doGet. ?page=setup
  // stays viewable (one-shot-guarded server-side, so harmless once configured).
  if (page === 'setup')    return renderStoreSetupWeb_();     // Editor.gs — first-run wizard
  if (page === 'items')    return renderManageItemsWeb_();    // Editor.gs — Manage Items as a web page
  if (page === 'vendors')  return renderManageVendorsWeb_();  // Editor.gs — Manage Vendors as a web page
  if (page === 'history')  return renderOrderHistoryWeb_();   // Editor.gs — Order History as a web page
  if (page === 'areas')    return renderStorageAreasWeb_();   // Editor.gs — Storage Areas as a web page
  if (page === 'pickpath') return renderReorderPickPathWeb_();// Editor.gs — Reorder Pick Path as a web page
  if (page === 'healthcheck') return renderStoreHealthWeb_(); // Editor.gs — Store Health Check as a web page
  return renderEditorHome_();   // '' (plain link), 'editor', or anything else → editor home
}

function doPost(e) {
  let body;
  try {
    body = JSON.parse(e.postData.contents);
  } catch (err) {
    return jsonResponse_({ ok: false, error: 'Invalid JSON body' });
  }

  const pin     = String(body.pin || '');
  const action  = String(body.action || '');
  const payload = body.payload || {};

  // Lockout check first — happens before constant-time PIN comparison so
  // an attacker can't get even timing signal out of the comparator during
  // a lockout window. Returns structured error with retryAfterMs so the
  // client can show a useful countdown.
  const lockout = getPinLockoutState_();
  if (lockout.locked) {
    return jsonResponse_({
      ok: false,
      error: 'Too many attempts',
      lockout: true,
      retryAfterMs: lockout.retryAfterMs
    });
  }

  const authType = checkPin_(pin);
  if (!authType) {
    const after = recordPinFailure_();
    // If this failure tripped the lockout, surface that to the client
    // immediately. Otherwise just say invalid PIN — don't leak the
    // remaining-attempts counter (small but real info-leak avoidance).
    if (after.locked) {
      return jsonResponse_({
        ok: false,
        error: 'Too many attempts',
        lockout: true,
        retryAfterMs: after.retryAfterMs
      });
    }
    return jsonResponse_({ ok: false, error: 'Invalid PIN' });
  }
  // Successful auth — reset the failure counter. Cheap (one prop write
  // when counter was nonzero; skipped when already zero).
  recordPinSuccess_();

  try {
    let data;
    switch (action) {
      case 'ping':             data = api_ping_(authType);              break;
      case 'getResetStatus':   data = api_getResetStatus_();            break;
      case 'commitReset':      data = api_commitReset_();               break;
      case 'setEmergencyOverride': data = api_setEmergencyOverride_(payload); break;
      case 'setVendorOverride':    data = api_setVendorOverride_(payload);    break;
      case 'getDashboard':     data = api_getDashboard_();              break;
      case 'getVendorItems':   data = api_getVendorItems_(payload);     break;
      case 'getVendorItemsBulk': data = api_getVendorItemsBulk_(payload); break;
      case 'saveOnHand':       data = api_saveOnHand_(payload);         break;
      case 'emailRecap':       data = api_emailRecap_(payload);         break;
      case 'getRecapData':     data = api_getRecapData_(payload);       break;
      case 'getRecipients':    data = api_getRecipients_();             break;
      case 'saveRecipients':   data = api_saveRecipients_(payload);     break;
      case 'getHistoryDates':   data = api_getHistoryDates_(payload);     break;
      case 'getHistoryVendors': data = api_getHistoryVendors_(payload);   break;
      case 'getHistoryDetail':  data = api_getHistoryDetail_(payload);    break;
      default:
        return jsonResponse_({ ok: false, error: 'Unknown action: ' + action });
    }
    return jsonResponse_({ ok: true, data: data });
  } catch (err) {
    Logger.log('MOG API error in action "' + action + '": ' + (err.stack || err));
    return jsonResponse_({ ok: false, error: err.message || String(err) });
  }
}


/***********************
 * 2) AUTH
 ***********************/

function checkPin_(submitted) {
  // Returns:
  //   'store'  — submitted matches this location's store PIN
  //   'master' — submitted matches the multi-unit manager master PIN
  //   null     — no match (caller treats falsy as "reject")
  //
  // Auth type is propagated to api_ping_ so the client can render
  // a "manager mode" banner when the master PIN was used.
  //
  // Master PIN is OPTIONAL — locations without it set behave exactly
  // like before. To set, run setMasterPin() from the script editor.
  const props = PropertiesService.getScriptProperties();
  const storePin  = props.getProperty(PROP_PIN);
  const masterPin = props.getProperty(PROP_MASTER_PIN);
  if (!storePin) return null;
  if (constantTimeEq_(submitted, storePin)) return 'store';
  if (masterPin && constantTimeEq_(submitted, masterPin)) return 'master';
  return null;
}

function constantTimeEq_(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}


// ---------- PIN lockout helpers ----------

function getPinLockoutState_() {
  // Returns { locked: bool, retryAfterMs: int }. retryAfterMs is the
  // remaining lockout window in milliseconds (0 when not locked).
  // Also self-heals: if the lockout window has expired, clears the
  // properties so a subsequent failure restarts at attempt 1 rather
  // than carrying over the old counter.
  const props = PropertiesService.getScriptProperties();
  const until = parseInt(props.getProperty(PROP_PIN_LOCKOUT_UNTIL) || '0', 10);
  if (!until) return { locked: false, retryAfterMs: 0 };
  const remaining = until - Date.now();
  if (remaining <= 0) {
    // Lockout expired — clear the gate and the counter together so the
    // user gets a fresh 5 attempts.
    props.deleteProperty(PROP_PIN_LOCKOUT_UNTIL);
    props.deleteProperty(PROP_PIN_FAIL_COUNT);
    return { locked: false, retryAfterMs: 0 };
  }
  return { locked: true, retryAfterMs: remaining };
}

function recordPinFailure_() {
  // Increments the failure counter. If the new count reaches
  // PIN_MAX_ATTEMPTS, sets the lockout-until timestamp. Returns
  // { locked, retryAfterMs } so doPost can surface the right error.
  const props = PropertiesService.getScriptProperties();
  const count = parseInt(props.getProperty(PROP_PIN_FAIL_COUNT) || '0', 10) + 1;
  props.setProperty(PROP_PIN_FAIL_COUNT, String(count));
  if (count >= PIN_MAX_ATTEMPTS) {
    const until = Date.now() + PIN_LOCKOUT_MS;
    props.setProperty(PROP_PIN_LOCKOUT_UNTIL, String(until));
    return { locked: true, retryAfterMs: PIN_LOCKOUT_MS };
  }
  return { locked: false, retryAfterMs: 0 };
}

function recordPinSuccess_() {
  // Clear any failure state. Skips the write when nothing's set so the
  // common case (every legitimate request after the first) is free of
  // property writes.
  const props = PropertiesService.getScriptProperties();
  if (props.getProperty(PROP_PIN_FAIL_COUNT) ||
      props.getProperty(PROP_PIN_LOCKOUT_UNTIL)) {
    props.deleteProperty(PROP_PIN_FAIL_COUNT);
    props.deleteProperty(PROP_PIN_LOCKOUT_UNTIL);
  }
}


/***********************
 * 3) ACTION HANDLERS
 ***********************/

function api_ping_(authType) {
  const props = PropertiesService.getScriptProperties();
  return {
    location: props.getProperty(PROP_LOCATION) || 'Unknown',
    abbr:     props.getProperty(PROP_LOCATION_ABBR) || '',
    // Tells the client whether the active session was authenticated via
    // the master (multi-unit manager) PIN. Client uses this to show the
    // manager-mode banner.
    isManagerMode: authType === 'master'
  };
}


function api_getResetStatus_() {
  // New-day detection lives in Core's getResetStaleness_ (the AE2/AE9 read +
  // compare, single source of truth). Returns { today, lastReset, isStale } —
  // the exact shape the PWA expects.
  return getResetStaleness_();
}


function api_commitReset_() {
  // Mirrors the sheet's "Reset On Hand" workflow exactly:
  //   1. commitLogAndReset() — snapshots current On Hand to LOG_ORDERS for
  //      today's order date and clears all On Hand columns. Idempotent
  //      within a day (duplicate guard re-clears but skips re-logging).
  //   2. Stamp AE9 with today so isStale flips to false.
  //
  // Concurrency: two KMs hitting reset within seconds is safe — second call
  // hits the duplicate guard and just re-clears (no-op for already-blank
  // columns) and re-stamps AE9.
  //
  // Mirror the sheet reset's emergency-override clear: a new cycle always
  // starts with override off. The PWA now exposes override (api_setEmergencyOverride_)
  // and auto-runs this reset on the first open of a new day, so clearing here
  // stops an override from leaking into the new day on PWA-only stores.

  const result = commitLogAndReset();

  const oe = getSheet_(SHEET_ORDER_ENTRY);
  const today = new Date();
  oe.getRange(LAST_RESET_DATE_CELL).setValue(today);

  // Spreadsheet TZ, not script TZ — the LAST_OVERRIDE_DATE reader
  // (resetEmergencyOverrideOnOpen_) and every other writer compare
  // yyyy-MM-dd strings formatted with getSpreadsheetTimeZone() (audit #17).
  const tz = SpreadsheetApp.getActiveSpreadsheet().getSpreadsheetTimeZone();
  const overrideRange = oe.getRange(EMERGENCY_OVERRIDE_CELL);
  // Per-vendor day picks (SETUP!AF) clear unconditionally — belt-and-braces
  // alongside the AD2-gated clear below, so a pick can never outlive its
  // cycle even if the flag was somehow already off. Runs AFTER
  // commitLogAndReset above, so the log captured the picked multipliers.
  const clearedPicks = clearVendorOverrides_();
  if (overrideRange.getValue() === true) {
    overrideRange.setValue(false);
    PropertiesService.getDocumentProperties()
      .setProperty(EMERGENCY_OVERRIDE_LASTDATE_PROP,
                   Utilities.formatDate(today, tz, 'yyyy-MM-dd'));
    bumpServerMutationTs_(); // dashboard must recompute now that override is off
  } else if (clearedPicks) {
    bumpServerMutationTs_();
  }

  return {
    logged:        !!result.logged,
    rowsLogged:    result.rowsLogged || 0,
    orderDate:     result.orderDate || null,
    skippedReason: result.skippedReason || null,
    resetDate:     Utilities.formatDate(today, tz, 'yyyy-MM-dd')
  };
}


function api_setEmergencyOverride_(payload) {
  // Turn the Emergency Override (ORDER_ENTRY!AD2) on/off from the PWA.
  // When on, vendors off-schedule today become orderable at next-delivery
  // coverage (see vendorDayMultiplier_) and getDashboard shows all vendors.
  //
  // Bookkeeping mirrors the Sheet: stamp LAST_OVERRIDE_DATE = today when
  // turning on, so resetEmergencyOverrideOnOpen_ (which clears the box if the
  // stamp isn't today) leaves it alone for the rest of the day and clears it
  // on the next new day. Override also clears on the daily reset (api_commitReset_).
  const on = !!(payload && payload.on);
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const oe = ss.getSheetByName(SHEET_ORDER_ENTRY);
  if (!oe) throw new Error('ORDER_ENTRY sheet not found.');

  oe.getRange(EMERGENCY_OVERRIDE_CELL).setValue(on);
  if (on) {
    const today = Utilities.formatDate(new Date(), ss.getSpreadsheetTimeZone(), 'yyyy-MM-dd');
    PropertiesService.getDocumentProperties()
      .setProperty(EMERGENCY_OVERRIDE_LASTDATE_PROP, today);
  } else {
    // The per-vendor day picks (SETUP!AF) are children of this flag — turning
    // the mode off retires them together, so re-enabling later starts clean.
    clearVendorOverrides_(ss);
  }
  // Dashboard is cached by mutation ts — bump so the vendor list (which now
  // shows/hides off-schedule vendors based on override) recomputes immediately.
  bumpServerMutationTs_();

  // ROUND-TRIP COLLAPSE. Hand back the fresh dashboard with the ack so the PWA
  // doesn't spend a SECOND ~2s /exec execution asking for state we can compute
  // right here. The floor is per-EXECUTION overhead (measured 2.18s for a bare
  // no-work request, 2026-08-08), not per-byte, so folding the read into this
  // execution is close to free while a separate call is not.
  //
  // ORDER MATTERS: compute AFTER the AD2 write and AFTER the ts bump.
  // api_getDashboard_ keys its cache on getServerMutationTs_(), so computing
  // before the bump would store PRE-mutation data under the POST-bump key and
  // serve it for the full 300s TTL — the commitAddVendor trap from audit 07-29.
  //
  // Defensive by design: the write has ALREADY succeeded by this point, so a
  // read failure must never make a successful toggle look failed. Returning
  // without `dashboard` is a valid response — the client then fetches it
  // itself, which is exactly the old two-round-trip behavior.
  let dashboard = null;
  try { dashboard = api_getDashboard_(); } catch (e) { dashboard = null; }

  return { emergencyOverride: on, dashboard: dashboard };
}


function api_setVendorOverride_(payload) {
  // Record (or clear) one vendor's Emergency Override day pick from the PWA.
  // The KM answered "when is this vendor's next delivery after this one?" and
  // the client sends the FROZEN day count (mult 1-7 = days from tomorrow up to,
  // not including, that delivery). mult 0 clears the pick (back to auto-bridge).
  //
  // Only meaningful while the store-wide override (AD2) is on — the PWA only
  // shows the picker then, and vendorDayMultiplier_ ignores AF when the flag
  // is off. Refreshing LAST_OVERRIDE_DATE here keeps the stale-day sweep
  // (resetEmergencyOverrideOnOpen_) from clearing an actively-used override.
  const vendor = normalizeVendorOrThrow_(payload.vendor);
  const mult   = Math.floor(Number(payload && payload.mult));
  if (isNaN(mult) || mult < 0 || mult > 7) {
    throw new Error('Invalid override multiplier (expected 0-7): ' + (payload && payload.mult));
  }

  const ss    = SpreadsheetApp.getActiveSpreadsheet();
  const setup = ss.getSheetByName(SHEET_SETUP);
  if (!setup) throw new Error('SETUP sheet not found.');

  // Row-aligned with the vendor list (Z) — same keying as cutoffs (AA).
  const lastRow = setup.getLastRow();
  let targetRow = 0;
  if (lastRow >= 2) {
    const names = setup.getRange(2, VENDOR_LIST_COL, lastRow - 1, 1).getValues();
    for (let i = 0; i < names.length; i++) {
      if (String(names[i][0] || '').trim().toLowerCase() === vendor.toLowerCase()) {
        targetRow = i + 2;
        break;
      }
    }
  }
  if (!targetRow) throw new Error('Vendor not found in SETUP: ' + vendor);

  const cell = setup.getRange(targetRow, VENDOR_OVERRIDE_COL);
  if (mult > 0) {
    cell.setValue(mult);
    PropertiesService.getDocumentProperties()
      .setProperty(EMERGENCY_OVERRIDE_LASTDATE_PROP,
                   Utilities.formatDate(new Date(), ss.getSpreadsheetTimeZone(), 'yyyy-MM-dd'));
  } else {
    cell.clearContent();
  }

  // Suggested quantities changed for this vendor — bump so the cached
  // dashboard (and anything keyed on the mutation ts) recomputes.
  bumpServerMutationTs_();

  // ROUND-TRIP COLLAPSE — same rationale as api_setEmergencyOverride_: the day
  // pick used to cost two serial ~2s executions (write, then re-fetch), and the
  // second one asked for something this execution can already produce.
  //
  // Unlike the dashboard, api_getVendorItems_ is NOT CacheService-wrapped
  // (dispatch calls it directly), so there is no stale-key hazard here. It must
  // still run AFTER the AF write so every quantity reflects the pick just made
  // — vendorDayMultiplier_ reads that cell back through readVendorOverrides_.
  //
  // Defensive for the same reason as above: the pick is already saved, so a
  // read failure degrades to "client fetches it itself", never to a false error.
  let itemsPayload = null;
  try { itemsPayload = api_getVendorItems_({ vendor: vendor }); } catch (e) { itemsPayload = null; }

  return { vendor: vendor, overrideMult: mult, itemsPayload: itemsPayload };
}


// Cached entry point. The compute lives in api_getDashboard_compute_ — this
// wrapper is a near-copy of the getManageItemsBootstrap pattern: key by
// dateStr + getServerMutationTs_ so the cache invalidates on (a) midnight
// rollover and (b) any admin mutation that already bumps the shared ts.
// On-hand saves from the PWA also bump that ts (see api_saveOnHand_).
// Fail-safe: any CacheService error falls through to a fresh compute, never
// breaks the dashboard.
function api_getDashboard_() {
  const dateStr = getActiveOrderDate_().dateStr;
  const ts = getServerMutationTs_();
  const cacheKey = 'dashboard_v1_' + dateStr + '_' + ts;

  let cache = null;
  try { cache = CacheService.getDocumentCache(); } catch (e) { cache = null; }

  if (cache) {
    try {
      const hit = cache.get(cacheKey);
      if (hit) return JSON.parse(hit);
    } catch (e) {
      // bad cached content or read error — fall through to compute
    }
  }

  const payload = api_getDashboard_compute_();

  if (cache) {
    try {
      const json = JSON.stringify(payload);
      // CacheService caps at 100KB per key; leave headroom for overhead.
      if (json.length < 95000) cache.put(cacheKey, json, 300);
    } catch (e) {
      // non-fatal: payload already in hand
    }
  }
  return payload;
}


function api_getDashboard_compute_() {
  const active    = getActiveOrderDate_();
  const dateStr   = active.dateStr;
  const dayOfWeek = active.dayOfWeek;

  const setup        = getSheet_(SHEET_SETUP);
  const allVendors   = getVendorList();
  const vendorMults  = readVendorMultipliers_(setup);
  const vendorCutoffs = readVendorCutoffs_(setup);
  const todaysLog    = getTodaysLogByVendor_(dateStr);
  const itemCounts   = countActiveItemsByVendor_();
  // Emergency Override: when on, show ALL vendors (not just today's delivery
  // vendors) so a KM can order from one that's off-schedule today.
  const emergencyOverride = readEmergencyOverride_();

  // Shared read context for vendorOnHandSnapshot_ — built once so the per-vendor
  // "to order" count reads MASTER_ITEMS / SETUP a single time, not per vendor.
  const snapCtx = { masterMeta: readMasterItemMeta_(), vendorMults: vendorMults,
                    emergencyOverride: emergencyOverride, dayOfWeek: dayOfWeek,
                    vendorOverrides: readVendorOverrides_(setup) };
  const backupCounts = countBackupItemsByVendor_(snapCtx.masterMeta);

  const out = [];
  for (const vendorName of allVendors) {
    const mults = vendorMults.get(vendorName) || {};
    // Skip non-delivery vendors only when override is off. Under override the
    // whole list shows; the per-vendor screen (api_getVendorItems_) applies
    // next-delivery coverage.
    if (!emergencyOverride && (Number(mults[dayOfWeek]) || 0) <= 0) continue;

    const meta        = VENDOR_META[vendorName] || {};
    const itemCount   = itemCounts.get(vendorName) || 0;
    const backupCount = backupCounts.get(vendorName) || 0;
    const log         = todaysLog.get(vendorName);

    let status       = 'not_started';
    let sentAt       = null;
    let reference    = null;
    let toOrderCount = null;
    let enteredCount = 0;

    if (log) {
      status       = 'sent';
      sentAt       = log.sentAt;
      reference    = log.reference;
      toOrderCount = log.itemCount;
      // A sent vendor implicitly has all items "entered" — primaries AND
      // backups, matching the count screen's roster (the client denominator
      // is itemCount + backupCount).
      enteredCount = itemCount + backupCount;
    } else {
      const inProgress = vendorOnHandSnapshot_(vendorName, snapCtx);
      enteredCount = inProgress.enteredCount;
      if (inProgress.any) {
        status       = 'in_progress';
        toOrderCount = inProgress.toOrder;
      }
    }

    // Cutoff priority: SETUP column AA (via vendorCutoffs map) → legacy
    // VENDOR_META fallback (already merged in readVendorCutoffs_, but
    // checked again here in case meta wasn't visible at read time) →
    // null. Once all vendors have cutoffs entered in the sidebar,
    // VENDOR_META should be empty and this falls through cleanly.
    const cutoffFromSetup = vendorCutoffs.get(vendorName);
    const cutoff = cutoffFromSetup || meta.cutoffTime || null;

    out.push({
      name:         vendorName,
      itemCount:    itemCount,
      backupCount:  backupCount,
      cutoffTime:   cutoff,
      status:       status,
      sentAt:       sentAt,
      reference:    reference,
      toOrderCount: toOrderCount,
      enteredCount: enteredCount
    });
  }

  // Sort by cutoff (earliest first; null cutoffs last), then by name.
  out.sort((a, b) => {
    const at = a.cutoffTime || '99:99';
    const bt = b.cutoffTime || '99:99';
    if (at !== bt) return at.localeCompare(bt);
    return a.name.localeCompare(b.name);
  });

  return {
    date:      dateStr,
    dayOfWeek: dayOfWeek,
    location:  PropertiesService.getScriptProperties().getProperty(PROP_LOCATION) || 'Unknown',
    emergencyOverride: emergencyOverride,
    vendors:   out
  };
}


function api_getVendorItems_(payload, ctx) {
  // Reads the vendor tab for On Hand + the item roster only.
  //
  // Vendor tab structure (per VENDOR_TAB constant + script comments):
  //   E(5) = On Hand (user input)
  //   M(13)= Item ID (hidden, formula-driven from SETUP pick path)
  //   Data rows start at VENDOR_TAB.DATA_START_ROW (3).
  //
  // Those are the ONLY two columns this function consumes (the range read
  // below spans A:M for simplicity, but only E and M are used). Everything
  // else comes from code + canonical sources:
  //   * On Hand lives on the vendor tab — that's where users enter counts
  //     (manually in the sheet, or via this API for the mobile app). The
  //     dashboard's "X / Y entered" counter reads vendor tab column E too.
  //   * Item ID (M) defines WHICH items are on this vendor's order today
  //     (a SORT/FILTER spill over SETUP's pick path DB, blank when H2=0).
  //   * Name/pack come from MASTER_ITEMS!B/!E (via masterMeta) — the tab's
  //     A/B columns are just XLOOKUPs into those same cells.
  //   * par comes from MASTER_ITEMS!G (via masterMeta) — the tab's col-D
  //     formula is the same XLOOKUP.
  //   * Suggested Order Qty is computed here in code (par × day-multiplier −
  //     on-hand, honoring the Use Multiplier flag) — a faithful replication
  //     of the vendor tab's column F formula, which stays for the human view.
  //   Keeping all of this in code makes it versioned, uniform across stores,
  //   and portable off the sheet.
  //
  // Storage area / pick path order still come from SETUP's pick path DB
  // because the vendor tab itself doesn't carry that metadata.
  //
  // ctx (optional, ALL-OR-NOTHING): a shared read context for callers that
  // loop over many vendors (buildRecapSections_) so the pick DB / MASTER /
  // multiplier / override / cutoff reads happen once, not per vendor. When
  // provided it MUST carry every field — { pickDb, vendorMults,
  // emergencyOverride, dayOfWeek, masterMeta, cutoffs } — a partial ctx
  // would silently mix fresh and stale reads. Single-vendor callers (the
  // PWA dispatch) pass nothing and behave exactly as before.
  const vendor = normalizeVendorOrThrow_(payload.vendor);
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sh = ss.getSheetByName(vendor);
  if (!sh) throw new Error('Vendor tab not found: ' + vendor);

  const lastRow = sh.getLastRow();
  if (lastRow < VENDOR_TAB.DATA_START_ROW) {
    return { vendor: vendor, cutoffTime: null, items: [] };
  }

  // Pick path metadata — area + ordering — keyed by item ID
  const setup = getSheet_(SHEET_SETUP);
  const pickInfo = new Map();
  for (const r of (ctx ? ctx.pickDb : readPickDb_(setup))) {
    if (String(r[0] || '').trim() !== vendor) continue;
    const id = String(r[1] || '').trim();
    if (!id) continue;
    pickInfo.set(id, {
      area:       String(r[3] || '').trim(),
      areaOrder:  Number(r[4]) || 999,
      shelfOrder: Number(r[5]) || 999999
    });
  }

  // Pull E:M for every data row — On Hand (E) and Item ID (M) are the only
  // vendor-tab cells this path needs (name/par/suggested come from MASTER_ITEMS
  // + code below). Narrowed from A:M to skip 4 unused leading columns.
  const numRows  = lastRow - VENDOR_TAB.DATA_START_ROW + 1;
  const startCol = VENDOR_TAB.ON_HAND_COL;             // E (5)
  const data     = sh.getRange(VENDOR_TAB.DATA_START_ROW, startCol, numRows, VENDOR_TAB.ITEM_ID_COL - startCol + 1).getValues();

  // Day-of-week multiplier — computed in code (was: read from the vendor tab's
  // H2 formula). H2 = IF(AD2=TRUE, <emergency>, <today's SETUP mult>); we now
  // derive it from the SETUP multiplier table + the active order date + the
  // Emergency Override flag, so the order math is fully in code (no vendor-tab
  // formula read). Under Emergency Override we improve on the sheet's flat 1x
  // by bridging to the vendor's next scheduled delivery (see
  // vendorDayMultiplier_). The in-Sheet H2 formula is unchanged and still
  // drives the human view.
  const vendorMults       = ctx ? ctx.vendorMults : readVendorMultipliers_(setup);
  const emergencyOverride = ctx ? ctx.emergencyOverride : readEmergencyOverride_();
  const dayOfWeek         = ctx ? ctx.dayOfWeek : getActiveOrderDate_().dayOfWeek;
  const vendorOverrides   = ctx ? ctx.vendorOverrides : readVendorOverrides_(setup);
  const dayMult = vendorDayMultiplier_(vendorMults, vendor, dayOfWeek, emergencyOverride, vendorOverrides);

  // Map<itemId, {useMult, par, name, pack}> from MASTER_ITEMS. par (col G) is
  // the canonical per-item base par; useMult (col M) gates the day multiplier;
  // name/pack (cols B/E) are the display fields the tab's A/B XLOOKUPs mirror.
  // Consulted per-item below.
  const masterMeta = ctx ? ctx.masterMeta : readMasterItemMeta_();

  const items = [];
  for (const r of data) {
    const onHandRaw = r[0];                                  // E (range starts at E)
    const itemId    = String(r[VENDOR_TAB.ITEM_ID_COL - startCol] || '').trim(); // M, relative to E
    if (!itemId) continue;

    // Name/pack from MASTER_ITEMS (via masterMeta), not the tab's A/B — those
    // columns are XLOOKUP(id, MASTER!A, MASTER!B / MASTER!E) spills, so this
    // is the same text from its canonical source. No MASTER row, or a blank
    // name, skips the row — exactly the old `A === ""` skip (the tab's
    // XLOOKUP falls back to "" on a missing id).
    const meta = masterMeta.get(itemId);
    if (!meta || !meta.name) continue;
    const itemName = meta.name;
    const pack     = meta.pack;

    // Secondary/backup vendor: this item's PRIMARY is a different vendor
    // (MASTER col C). It's still fully orderable from here — a backup exists
    // precisely so you can order it when the primary isn't delivering today or
    // is out of stock. The flag only drives a "Backup · <primary>" badge in the
    // PWA so the KM knows this isn't the default source. On-Hand is per vendor
    // tab, so counting it here (and not on the primary) is what routes the
    // order to this vendor — nothing is double-counted unless the same item is
    // deliberately counted on two tabs the same day.
    const isSecondary = !!meta.primaryVendor &&
      meta.primaryVendor.toLowerCase() !== vendor.toLowerCase();

    const onHand = (onHandRaw === '' || onHandRaw === null)
      ? null
      : (isNaN(Number(onHandRaw)) ? null : Number(onHandRaw));

    // targetPar = par (MASTER_ITEMS col G) * day multiplier (H2), honoring the
    // per-item Use Multiplier flag. Surfacing it lets the PWA recompute live
    // suggestions as the user types (computeSuggested).
    //
    // par now comes from MASTER_ITEMS (via masterMeta) rather than the vendor
    // tab's column-D formula — the col-D value is itself just an XLOOKUP into
    // MASTER_ITEMS!G, so this is the same number from its canonical source.
    // (meta is guaranteed non-null here — rows without a MASTER entry were
    // skipped above.)
    //
    // Use Multiplier: items flagged FALSE in MASTER_ITEMS column M skip the
    // day multiplier (effectiveMult = 1) — a par already sized for the cycle.
    const parNum  = meta.par;
    const useMult = meta.useMult;
    const effectiveMult = useMult ? dayMult : 1;
    // The dayMult > 0 term mirrors computeSuggestedQty_'s gate exactly: when the
    // vendor isn't delivering (dayMult 0) the server suggests nothing REGARDLESS
    // of useMult, so targetPar has to be null too. Without it, a useMult=false
    // item kept a non-null targetPar and the PWA's computeSuggested — which
    // prefers targetPar over the server's suggestedQty so it can recompute live
    // as the KM types — would show an order quantity the recap email and order
    // log never record.
    const targetPar = (!isNaN(parNum) && dayMult > 0 && effectiveMult > 0)
      ? parNum * effectiveMult
      : null;

    // Suggested order qty — computed in code (was: read from the vendor tab's
    // column F formula) via the shared computeSuggestedQty_ helper, the single
    // source of this math across the count, order-log, and dashboard paths.
    const suggested = computeSuggestedQty_(parNum, useMult, dayMult, onHand);

    const pi = pickInfo.get(itemId) || { area: '', areaOrder: 999, shelfOrder: 999999 };

    items.push({
      id:            itemId,
      name:          itemName,
      pack:          pack,
      par:           (!isNaN(parNum) ? parNum : 0),
      targetPar:     targetPar,
      onHand:        onHand,
      suggestedQty:  suggested,
      secondary:     isSecondary,
      primaryVendor: meta.primaryVendor,
      storageArea:   pi.area,
      _areaOrder:    pi.areaOrder,
      _shelfOrder:   pi.shelfOrder
    });
  }

  // Vendor tab is already in pick-path order via its SORT/FILTER source
  // formula, but sort defensively in case anything's drifted.
  items.sort((a, b) => {
    if (a._areaOrder !== b._areaOrder) return a._areaOrder - b._areaOrder;
    if (a._shelfOrder !== b._shelfOrder) return a._shelfOrder - b._shelfOrder;
    return a.name.localeCompare(b.name);
  });
  for (const it of items) { delete it._areaOrder; delete it._shelfOrder; }

  // Cutoff: same priority as in getDashboard — SETUP column AA first,
  // then legacy VENDOR_META, then null. Read inline rather than via the
  // shared helper because we only need one vendor's value here.
  let cutoff = null;
  try {
    const cutoffMap = ctx ? ctx.cutoffs : readVendorCutoffs_(getSheet_(SHEET_SETUP));
    cutoff = cutoffMap.get(vendor) || null;
  } catch (e) {
    // If SETUP read fails for any reason, fall through to VENDOR_META.
    // We never want a cutoff lookup error to break the whole vendor
    // items response — items are the important payload.
  }
  if (!cutoff) {
    cutoff = (VENDOR_META[vendor] || {}).cutoffTime || null;
  }

  // Override context for the PWA count screen: `emergencyOverride` gates the
  // day-picker card, `overrideMult` (0 = no pick) highlights the chosen chip
  // and drives the "sized to last until <day> xN" note on count + review.
  const pickedMult = (emergencyOverride && vendorOverrides && vendorOverrides.get(vendor) > 0)
    ? Number(vendorOverrides.get(vendor)) : 0;

  return {
    vendor:            vendor,
    cutoffTime:        cutoff,
    emergencyOverride: emergencyOverride,
    overrideMult:      pickedMult,
    items:             items
  };
}


// Bulk sibling of api_getVendorItems_ — several vendors' payloads from ONE
// /exec execution.
//
// WHY: the PWA warms today's vendors after the dashboard renders, and it used to
// do that one vendor per request. Every request pays the web app's fixed
// per-execution overhead (measured 2.18s for a request that does no work at all,
// 2026-08-08), so warming 8 vendors burned ~20s of wall clock and a KM who
// tapped a vendor early still waited out a full cold fetch. The per-vendor WORK
// was never the bottleneck — the request COUNT was.
//
// The saving comes from the shared read context, exactly as buildRecapSections_
// does it: the pick DB / MASTER / multiplier / override / cutoff reads happen
// once for the whole batch instead of once per vendor, so each extra vendor
// costs only its own tab read. Per the ctx contract on api_getVendorItems_ the
// context must be ALL-OR-NOTHING — a partial ctx silently mixes fresh and stale
// reads.
//
// Per-vendor failures are ISOLATED rather than fatal: this feeds a background
// prefetch, so one unreadable vendor tab should cost that vendor its warm cache,
// not the whole batch.
function api_getVendorItemsBulk_(payload) {
  // Defensive ceiling on how many vendor tabs one execution will walk. No real
  // store is close (the largest today is ~11), so this should never fire — but
  // if it ever does, the dropped names come back in `failed` rather than being
  // silently truncated, and the client just fetches those on demand.
  const BULK_VENDOR_LIMIT = 30;

  const setup      = getSheet_(SHEET_SETUP);
  const allVendors = getVendorList();
  const known      = new Set(allVendors);

  // Same exact-match filter buildRecapSections_ uses: the client sends names
  // straight from the dashboard payload, which itself comes from getVendorList,
  // so exact match is the correct key.
  const requested = (payload && payload.vendors) || [];
  let list = requested.filter(v => known.has(v));

  const skipped = list.slice(BULK_VENDOR_LIMIT);
  list = list.slice(0, BULK_VENDOR_LIMIT);

  const active            = getActiveOrderDate_();
  const vendorMults       = readVendorMultipliers_(setup);
  const emergencyOverride = readEmergencyOverride_();
  const vendorOverrides   = readVendorOverrides_(setup);

  const ctx = {
    pickDb:            readPickDb_(setup),
    vendorMults:       vendorMults,
    emergencyOverride: emergencyOverride,
    vendorOverrides:   vendorOverrides,
    dayOfWeek:         active.dayOfWeek,
    masterMeta:        readMasterItemMeta_(),
    cutoffs:           readVendorCutoffs_(setup)
  };

  const vendors = {};
  const failed  = [];
  for (const vendor of list) {
    try {
      vendors[vendor] = api_getVendorItems_({ vendor: vendor }, ctx);
    } catch (e) {
      failed.push(vendor);
    }
  }

  return { vendors: vendors, failed: failed.concat(skipped) };
}


function api_saveOnHand_(payload) {
  // Writes On Hand to the vendor tab's column E by matching item ID in
  // column M. Mirrors how the user types counts directly in the sheet.
  //
  // Items not found in the vendor tab (stale ID, deactivated item, etc.)
  // are silently skipped — same forgiving behavior as the existing
  // sidebar-driven save flows.
  //
  // Performance: payload rows are resolved to (row, val) pairs first, then
  // written as a single bounded setValues call covering minRow → maxRow.
  // For a typical save (items already in pick-path order on the vendor tab,
  // so rows are contiguous), this is 1 read + 1 write regardless of how
  // many items the user is saving, instead of one round-trip per cell.
  const vendor = normalizeVendorOrThrow_(payload.vendor);
  const items  = Array.isArray(payload.items) ? payload.items : [];
  if (!items.length) return { saved: 0, vendor: vendor };

  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sh = ss.getSheetByName(vendor);
  if (!sh) throw new Error('Vendor tab not found: ' + vendor);

  const lastRow = sh.getLastRow();
  if (lastRow < VENDOR_TAB.DATA_START_ROW) return { saved: 0, vendor: vendor };

  // Build itemId → row map from column M (item ID, hidden)
  const numRows = lastRow - VENDOR_TAB.DATA_START_ROW + 1;
  const idCol   = sh.getRange(VENDOR_TAB.DATA_START_ROW, VENDOR_TAB.ITEM_ID_COL, numRows, 1).getValues();
  const idRowMap = new Map();
  for (let i = 0; i < idCol.length; i++) {
    const id = String(idCol[i][0] || '').trim();
    if (id) idRowMap.set(id, VENDOR_TAB.DATA_START_ROW + i);
  }

  // Resolve payload items → (row, val) pairs. Unmatched IDs are dropped
  // silently so a stale client doesn't fail the whole save.
  const updates = [];
  let minRow = Infinity;
  let maxRow = -Infinity;
  for (const it of items) {
    const row = idRowMap.get(String(it.id || '').trim());
    if (!row) continue;
    const val = (it.onHand === null || it.onHand === '' || it.onHand === undefined)
      ? ''
      : Number(it.onHand);
    updates.push({ row: row, val: val });
    if (row < minRow) minRow = row;
    if (row > maxRow) maxRow = row;
  }
  if (!updates.length) return { saved: 0, vendor: vendor };

  // Read the bounded On Hand span once, splice in new values for matched
  // rows (preserving any untouched rows that fall inside the span), then
  // write back in a single setValues call.
  const height = maxRow - minRow + 1;
  const range  = sh.getRange(minRow, VENDOR_TAB.ON_HAND_COL, height, 1);
  const block  = range.getValues();
  for (const u of updates) {
    block[u.row - minRow][0] = u.val;
  }
  range.setValues(block);

  // Invalidate the dashboard CacheService entry — enteredCount and
  // in_progress status reflect on-hand values, so a count save must show
  // up on the next dashboard hit. Shares the ts with the manage-items
  // bootstrap cache (cheap to recompute that one on the rare overlap).
  bumpServerMutationTs_();

  return { saved: updates.length, vendor: vendor };
}


function api_getHistoryDetail_(payload) {
  const date   = String(payload.date   || '');
  const vendor = String(payload.vendor || '');
  if (!date || !vendor) throw new Error('date and vendor are required.');

  // Pack metadata isn't stored in LOG_ORDERS, so buildHistoryRows_ joins it in
  // from MASTER_ITEMS as row.itemPack (via buildPackByIdMap_, same map this
  // used to build for itself). Reusing it drops a second full MASTER read that
  // produced an identical map — COL.ID is 1, so the ranges and join matched.
  const flat = getOrderHistory({ vendorFilter: vendor, dateFrom: date, dateTo: date });

  const items = flat.map(r => ({
    id:     r.itemId,
    name:   r.itemName,
    pack:   r.itemPack,
    onHand: r.onHandPrev,
    qty:    r.qtyOrdered
  }));

  return {
    vendor:    vendor,
    date:      date,
    timestamp: flat.length ? flat[0].timestamp : null,
    reference: generateReferenceFromDateStr_(vendor, date),
    items:     items,
    itemCount: items.length
  };
}

// ── History — chunked endpoints ──────────────────────────────────────────────
// The PWA's Order History tab loads progressively:
//   1. dates list       (api_getHistoryDates_)
//   2. vendors per date (api_getHistoryVendors_)
//   3. items per vendor (api_getHistoryDetail_, pre-existing)
// Each step is a separate, cheap network round-trip with its own CacheService
// entry, so a repeat tap inside the 5-min TTL skips the LOG_ORDERS scan
// entirely. Cache invalidation is keyed on getServerMutationTs_ — bumped by
// recap-send + reset + anything that mutates LOG_ORDERS — so the new caches
// share the eviction story with the dashboard cache.
function api_getHistoryDates_(payload) {
  payload = payload || {};
  const dateFrom = String(payload.dateFrom || '');
  const dateTo   = String(payload.dateTo   || '');
  const ts = getServerMutationTs_();
  const cacheKey = 'historyDates_v1_' + dateFrom + '_' + dateTo + '_' + ts;

  let cache = null;
  try { cache = CacheService.getDocumentCache(); } catch (e) { cache = null; }
  if (cache) {
    try {
      const hit = cache.get(cacheKey);
      if (hit) return JSON.parse(hit);
    } catch (e) { /* bad cached content — fall through */ }
  }

  // needPack:false — this payload is dates + vendor counts only, so the
  // MASTER_ITEMS read that populates itemPack would be pure waste.
  const flat = getOrderHistory(
    { vendorFilter: 'ALL', dateFrom: dateFrom, dateTo: dateTo },
    { needPack: false }
  );

  // Group by date → set of unique vendors. The set's size becomes the
  // "N vendors" badge on the dates-view card; the vendor list itself
  // ships separately via getHistoryVendors so this payload stays tiny.
  const vendorsByDate = new Map();
  for (const r of flat) {
    if (!vendorsByDate.has(r.orderDate)) vendorsByDate.set(r.orderDate, new Set());
    vendorsByDate.get(r.orderDate).add(r.vendor);
  }
  const dates = Array.from(vendorsByDate.keys())
    .sort()
    .reverse()
    .map(d => ({ date: d, vendorCount: vendorsByDate.get(d).size }));

  const payloadOut = { dates: dates };

  if (cache) {
    try {
      const json = JSON.stringify(payloadOut);
      if (json.length < 95000) cache.put(cacheKey, json, 300);
    } catch (e) { /* non-fatal */ }
  }
  return payloadOut;
}


function api_getHistoryVendors_(payload) {
  payload = payload || {};
  const date = String(payload.date || '');
  if (!date) throw new Error('date is required.');

  const ts = getServerMutationTs_();
  const cacheKey = 'historyVendors_v1_' + date + '_' + ts;

  let cache = null;
  try { cache = CacheService.getDocumentCache(); } catch (e) { cache = null; }
  if (cache) {
    try {
      const hit = cache.get(cacheKey);
      if (hit) return JSON.parse(hit);
    } catch (e) { /* fall through */ }
  }

  // needPack:false — vendor/itemCount/timestamp only, no pack surfaced.
  const flat = getOrderHistory(
    { vendorFilter: 'ALL', dateFrom: date, dateTo: date },
    { needPack: false }
  );

  // Group by vendor — itemCount + the vendor's order timestamp.
  const byVendor = new Map();
  for (const r of flat) {
    if (!byVendor.has(r.vendor)) {
      byVendor.set(r.vendor, {
        vendor:    r.vendor,
        itemCount: 0,
        timestamp: r.timestamp,
        reference: generateReferenceFromDateStr_(r.vendor, date)
      });
    }
    byVendor.get(r.vendor).itemCount++;
  }
  const vendors = Array.from(byVendor.values())
    .sort((a, b) => b.timestamp.localeCompare(a.timestamp));

  const payloadOut = { date: date, vendors: vendors };

  if (cache) {
    try {
      const json = JSON.stringify(payloadOut);
      if (json.length < 95000) cache.put(cacheKey, json, 300);
    } catch (e) { /* non-fatal */ }
  }
  return payloadOut;
}


function buildPackByIdMap_() {
  const master = getSheet_(SHEET_MASTER);
  const lastRow = master.getLastRow();
  if (lastRow < 2) return new Map();
  const rows = master.getRange(2, 1, lastRow - 1, Math.max(COL.ID, COL.PACK)).getValues();
  const out  = new Map();
  for (const r of rows) {
    const id   = String(r[COL.ID - 1]   || '').trim();
    const pack = String(r[COL.PACK - 1] || '').trim();
    if (id) out.set(id, pack);
  }
  return out;
}


/***********************
 * 4) HELPERS
 ***********************/

function jsonResponse_(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}


// getActiveOrderDate_ is defined in Core.gs (single source of truth for the
// AE2/AE9 order-cycle date). It stays globally callable from here.


function readMasterItemMeta_() {
  // Reads MASTER_ITEMS and returns
  // Map<itemId, {useMult, par, name, pack, primaryVendor}> — the per-item
  // order-math inputs + display fields, keyed by item id (col A):
  //   * par           = column G (Base Par Qty) — canonical, per-item base par.
  //   * useMult       = column M (Use Multiplier).
  //   * name          = column B (Item Name), pack = column E (Pack / Unit).
  //   * primaryVendor = column C — the default order source. An item can sit on
  //     several vendor tabs (one pick-path row each); every tab is fully
  //     orderable — tabs not matching this value are badged as secondaries.
  // All are read here in code so api_getVendorItems_ can build its payload
  // without reading the vendor tab's formula columns — col D (par), col A
  // (name), and col B (pack) are each just XLOOKUP(id, MASTER_ITEMS!A, …)
  // into the very cells read here (G / B / E respectively; verified against
  // the live template formulas 2026-07-02) — one MASTER read, math in code,
  // portable off the sheet.
  //
  // useMult: the day-of-week multiplier (H2) should not apply to items billed
  // flat (e.g., contracted weekly deliveries whose par is already sized for
  // the week). Column M lets the GM mark such items. Both the in-Sheet column
  // F formula (via XLOOKUP on M) and api_getVendorItems_ honor the flag, so
  // the code-computed suggested qty matches what the sheet shows. Items with
  // no MASTER row default to useMult=true; par is absent so targetPar is null.
  //
  // Column layout (MASTER_ITEMS):
  //   A=Item ID, B=Item Name, ..., G=Base Par Qty, ..., L=Active,
  //   M=Use Multiplier, N=Notes
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sh = ss.getSheetByName(SHEET_MASTER);
  const map = new Map();
  if (!sh) return map;
  const lastRow = sh.getLastRow();
  if (lastRow < 2) return map;
  // Read A:M (cols 1..13) in one range — same pattern as other readers.
  const data = sh.getRange(2, 1, lastRow - 1, 13).getValues();
  for (const r of data) {
    const id = String(r[0] || '').trim();
    if (!id) continue;
    // Column M (index 12). Treat exactly FALSE / false / "FALSE" / "false"
    // as "don't multiply." Everything else (including blank, TRUE, 1) is
    // true. Empty defaults to true so unconfigured items don't suddenly
    // lose their multiplier.
    const raw = r[12];
    let useMult = true;
    if (raw === false) useMult = false;
    else if (typeof raw === 'string' && raw.trim().toLowerCase() === 'false') useMult = false;
    // Column G (index 6) — base par. Number('') / Number(null) === 0, matching
    // the old vendor-tab col-D read (a blank par XLOOKUP'd to "" → 0).
    map.set(id, {
      useMult:       useMult,
      par:           Number(r[6]),
      name:          String(r[1] || '').trim(),   // B — Item Name
      pack:          String(r[4] || '').trim(),   // E — Pack / Unit
      primaryVendor: String(r[2] || '').trim(),   // C — active/primary vendor
      active:        r[11] === true               // L — Active flag
    });
  }
  return map;
}


function readVendorMultipliers_(setup) {
  // SETUP: Z (col 26) = vendor name; S:Y (cols 19–25) = Mon–Sun multipliers.
  // These match the column constants used in the bound scripts (Core.gs).
  const lastRow = setup.getLastRow();
  const map = new Map();
  if (lastRow < 2) return map;
  const numRows = lastRow - 1;
  const VENDOR_NAME_COL = (typeof VENDOR_LIST_COL !== 'undefined') ? VENDOR_LIST_COL : 26;
  const MULT_START_COL  = (typeof VENDOR_TABLE !== 'undefined' && VENDOR_TABLE.MULT_COL) ? VENDOR_TABLE.MULT_COL : 19;

  const names = setup.getRange(2, VENDOR_NAME_COL, numRows, 1).getValues();
  const mults = setup.getRange(2, MULT_START_COL, numRows, 7).getValues();
  const days = ['Mon','Tue','Wed','Thu','Fri','Sat','Sun'];
  for (let i = 0; i < numRows; i++) {
    const v = String(names[i][0] || '').trim();
    if (!v) continue;
    const m = {};
    for (let j = 0; j < 7; j++) m[days[j]] = Number(mults[i][j]) || 0;
    map.set(v, m);
  }
  return map;
}


function readEmergencyOverride_() {
  // ORDER_ENTRY!AD2 — the Emergency Override checkbox (true = on). When on,
  // the KM is ordering off the normal delivery schedule; see
  // vendorDayMultiplier_ for how the multiplier is derived in that case.
  const oe = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_ORDER_ENTRY);
  if (!oe) return false;
  return oe.getRange(EMERGENCY_OVERRIDE_CELL).getValue() === true;
}


function readVendorOverrides_(setup) {
  // Map<vendor, mult> from the per-vendor Emergency Override column
  // (SETUP!AF, row-aligned with the vendor list in Z). Only positive
  // numbers are kept — blanks / zeros / junk mean "no pick, use the
  // auto-bridge". Values here only exist while ORDER_ENTRY!AD2 is on
  // (they're cleared with it), and vendorDayMultiplier_ additionally
  // gates on the flag so a stray leftover can never inflate a normal day.
  const map = new Map();
  const lastRow = setup.getLastRow();
  if (lastRow < 2) return map;
  const numRows = lastRow - 1;
  // One read spanning Z..AF (vendor name .. override mult).
  const width = VENDOR_OVERRIDE_COL - VENDOR_LIST_COL + 1;
  const vals = setup.getRange(2, VENDOR_LIST_COL, numRows, width).getValues();
  for (let i = 0; i < vals.length; i++) {
    const v = String(vals[i][0] || '').trim();
    if (!v) continue;
    const m = Number(vals[i][width - 1]);
    if (!isNaN(m) && m > 0) map.set(v, m);
  }
  return map;
}


function vendorDayMultiplier_(vendorMults, vendor, dayOfWeek, emergencyOverride, vendorOverrides) {
  // Effective vendor multiplier for `vendor` on `dayOfWeek` — computed in code
  // to replace reading the vendor tab's H2 formula. Mirrors that formula:
  //   H2 = IF(AD2=TRUE, <emergency>, <today's mult from SETUP S:Y>)
  //
  // Normal (override off): today's multiplier from the SETUP S:Y table; 0 means
  // the vendor doesn't deliver today (items then blank, same as H2=0).
  //
  // Emergency Override (AD2 on): a flat 1x doesn't help a vendor that only
  // delivers some days (a 1-day order won't bridge the gap to its next drop).
  //
  // A KM PICK wins first (SETUP!AF via `vendorOverrides`): the auto-bridge
  // below derives coverage from the NORMAL schedule, which is exactly what's
  // abnormal in an emergency (a Fri+Sat vendor ordered Thursday is sized to
  // last one day — but if Saturday's drop is cancelled it must last seven).
  // The PWA's day picker asks "when is this vendor's next delivery after this
  // one?" and stores the frozen day count; that number is authoritative.
  //
  // No pick → "bridge to the next real delivery": scan forward from today
  // (inclusive) for the first day with mult > 0 and use that day's multiplier,
  // so an off-schedule emergency order covers what the next scheduled drop
  // would bring. If today is itself a delivery day, that's today's own mult
  // (override is a no-op for that vendor). An all-zero row (vendor never
  // delivers / misconfigured) falls back to 1 so the KM can still order.
  //
  // The pick is checked INSIDE the override branch on purpose — SETUP!AF is
  // cleared whenever AD2 clears, and the in-Sheet H2 formula nests the same
  // way (vendorTabH2Formula_), so code and sheet stay structurally identical.
  const m = vendorMults.get(vendor);
  if (!m) return 0;
  const DAYS = ['Mon','Tue','Wed','Thu','Fri','Sat','Sun'];
  const start = DAYS.indexOf(dayOfWeek);
  if (start < 0) return Number(m[dayOfWeek]) || 0;   // unknown day label — defensive
  if (!emergencyOverride) return Number(m[DAYS[start]]) || 0;
  const picked = vendorOverrides ? Number(vendorOverrides.get(vendor)) : NaN;
  if (!isNaN(picked) && picked > 0) return picked;
  for (let i = 0; i < 7; i++) {
    const mv = Number(m[DAYS[(start + i) % 7]]) || 0;
    if (mv > 0) return mv;
  }
  return 1;   // never-delivers row: let the KM still order something under override
}


// Suggested order qty for one item — THE single source of the count/order math,
// replacing the vendor-tab column-F formula. Called by api_getVendorItems_ (the
// PWA count screen, the recap email, and — via buildOrderCycleSnapshot_ — the
// order log) and by vendorOnHandSnapshot_ (dashboard "to order" counts), so the
// math lives in one place and can't drift. Faithful replication of the live F
// formula:
//   F = IF(name="" OR H2=0 OR onHand="", "",
//          qty = ROUNDUP(par*(useMult?H2:1) - onHand); qty<=0 ? "" : qty)
// Inputs: par = MASTER_ITEMS!G, useMult = MASTER_ITEMS!M, dayMult = H2 (from
// vendorDayMultiplier_), onHand = vendor-tab col E (null when nothing entered).
// Returns a positive integer, or null for every blank case (vendor not
// delivering today → dayMult 0; no On Hand entered; already at/above par).
function computeSuggestedQty_(par, useMult, dayMult, onHand) {
  if (isNaN(par) || dayMult <= 0 || onHand === null || onHand === undefined) return null;
  const effectiveMult = useMult ? dayMult : 1;
  if (effectiveMult <= 0) return null;
  // ORDERS ALWAYS ROUND UP — never down. A partial unit short is a whole unit
  // ordered, because you can't buy half a case. The only thing corrected here
  // is binary-float noise: `par * effectiveMult - onHand` is float arithmetic,
  // so a shortfall that is EXACTLY 1 in decimal can land at 1.0000000000000002
  // (e.g. par 1.1 x 2 - 1.2) and a bare Math.ceil would order 2 for a phantom
  // 2e-16 of a case.
  //
  // The epsilon is the right tool for that, NOT rounding to N decimals: it
  // cancels noise (a few ULP, ~1e-13 at these magnitudes) while leaving every
  // GENUINE fraction intact, so a real shortfall of 1.0001 still orders 2. A
  // fixed 3dp round would have shaved that to 1 — an under-order, which this
  // system must never do. 1e-9 sits ~1000x above float noise and ~100,000x
  // below the smallest fraction anyone could enter.
  //
  // The PWA's ceilQty_ and ManageItems.html's ppCeil_ use this same expression
  // and MUST stay identical — if they drift, the review screen the KM approves
  // disagrees with the recap email and the order log.
  const qty = Math.ceil((par * effectiveMult - onHand) - 1e-9);
  return qty > 0 ? qty : null;
}


// SETUP column AA holds cutoff times paired by row with the vendor names
// in column Z. Returns a Map<vendorName, "HH:MM"|null>. Stored as strings
// for consistency with the API response format; null means "no cutoff."
//
// Falls back to VENDOR_META if column AA is empty for a given vendor,
// so the system stays functional during the migration window where some
// vendors have been cutoff-entered via the sidebar and others haven't.
function readVendorCutoffs_(setup) {
  const map = new Map();
  const lastRow = setup.getLastRow();
  if (lastRow < 2) return map;
  const VENDOR_NAME_COL  = (typeof VENDOR_LIST_COL   !== 'undefined') ? VENDOR_LIST_COL   : 26;
  const VENDOR_CUTOFF    = (typeof VENDOR_CUTOFF_COL !== 'undefined') ? VENDOR_CUTOFF_COL : 27;
  const numRows = lastRow - 1;

  const names   = setup.getRange(2, VENDOR_NAME_COL, numRows, 1).getValues();
  const cutoffs = setup.getRange(2, VENDOR_CUTOFF,   numRows, 1).getValues();
  for (let i = 0; i < numRows; i++) {
    const v = String(names[i][0] || '').trim();
    if (!v) continue;
    const raw = cutoffs[i][0];
    const norm = normalizeCutoffForApi_(raw);
    if (norm) map.set(v, norm);
    else if (VENDOR_META[v] && VENDOR_META[v].cutoffTime) map.set(v, VENDOR_META[v].cutoffTime);
    else map.set(v, null);
  }
  return map;
}

// Sibling to Vendors.gs's normalizeCutoffString_ but lives in the
// API layer so MOGApi.gs has no compile-order dependency on the other
// file. Slightly simpler: only validates the "HH:MM" 24h shape we store
// after the sidebar normalizes input. Returns null on anything else.
function normalizeCutoffForApi_(raw) {
  if (raw === null || raw === undefined || raw === '') return null;
  if (Object.prototype.toString.call(raw) === '[object Date]') {
    const h = raw.getHours();
    const m = raw.getMinutes();
    return (h < 10 ? '0' : '') + h + ':' + (m < 10 ? '0' : '') + m;
  }
  const s = String(raw).trim();
  const m24 = s.match(/^(\d{1,2}):(\d{2})$/);
  if (m24) {
    const h = parseInt(m24[1], 10);
    const mins = parseInt(m24[2], 10);
    if (h >= 0 && h <= 23 && mins >= 0 && mins <= 59) {
      return (h < 10 ? '0' : '') + h + ':' + (mins < 10 ? '0' : '') + mins;
    }
  }
  // Defensive: accept 12-hour format too, in case somebody typed
  // directly into AA bypassing the sidebar normalizer.
  const m12 = s.match(/^(\d{1,2}):(\d{2})\s*(am|pm)$/i);
  if (m12) {
    let h = parseInt(m12[1], 10);
    const mins = parseInt(m12[2], 10);
    if (mins < 0 || mins > 59) return null;
    const isPm = m12[3].toLowerCase() === 'pm';
    if (h === 12) h = isPm ? 12 : 0;
    else if (isPm) h += 12;
    if (h < 0 || h > 23) return null;
    return (h < 10 ? '0' : '') + h + ':' + (mins < 10 ? '0' : '') + mins;
  }
  return null;
}


// One pick-DB scan returns, per vendor, how many ACTIVE items sit on its tab
// as BACKUPS — rows where the vendor is not the item's primary (MASTER col C).
// Complements countActiveItemsByVendor_ (primary counts). The dashboard card
// shows the two side by side ("N items · +M backup").
function countBackupItemsByVendor_(masterMeta) {
  const setup = getSheet_(SHEET_SETUP);
  const db    = readPickDb_(setup);
  const map   = new Map();
  const seen  = new Set();   // "vendorLower||id" — defensive dedupe
  for (const r of db) {
    const v  = String(r[0] || '').trim();
    const id = String(r[1] || '').trim();
    if (!v || !id) continue;
    const key = v.toLowerCase() + '||' + id;
    if (seen.has(key)) continue;
    seen.add(key);
    const meta = masterMeta.get(id);
    if (!meta || meta.active !== true) continue;   // deleted or inactive item
    const primary = String(meta.primaryVendor || '').trim();
    if (primary.toLowerCase() === v.toLowerCase()) continue;   // primary row
    map.set(v, (map.get(v) || 0) + 1);
  }
  return map;
}


// One MASTER_ITEMS scan returns active-item counts for every vendor at once.
// (The dashboard used to call a per-vendor singular variant inside its loop,
// rescanning master ~10x per hit; this folds it into a single pass.)
function countActiveItemsByVendor_() {
  const sh = getSheet_(SHEET_MASTER);
  const lastRow = sh.getLastRow();
  const map = new Map();
  if (lastRow < 2) return map;
  const data = sh.getRange(2, 1, lastRow - 1, COL.ACTIVE).getValues();
  for (const r of data) {
    if (r[COL.ACTIVE - 1] !== true) continue;
    const v = String(r[COL.VENDOR - 1] || '').trim();
    if (!v) continue;
    map.set(v, (map.get(v) || 0) + 1);
  }
  return map;
}


function vendorOnHandSnapshot_(vendor, ctx) {
  // Returns { any, toOrder, enteredCount } for the dashboard's per-vendor
  // status detection.
  //   any          — at least one On Hand value entered for this vendor today
  //   toOrder      — count of items whose suggested order qty > 0
  //   enteredCount — count of items with a numeric On Hand value entered
  //
  // Reads vendor-tab columns E (On Hand — real data) and M (Item ID — the
  // roster spill) only; the suggested qty is computed in code via
  // computeSuggestedQty_ (was: read from the col-F formula), so the dashboard
  // no longer depends on any vendor-tab formula. `ctx` carries the shared read
  // context built once by the caller — { masterMeta, vendorMults,
  // emergencyOverride, vendorOverrides, dayOfWeek } — so MASTER_ITEMS / SETUP
  // aren't re-read per vendor.
  const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(vendor);
  if (!sh) return { any: false, toOrder: 0, enteredCount: 0 };

  const lastRow = sh.getLastRow();
  if (lastRow < VENDOR_TAB.DATA_START_ROW) return { any: false, toOrder: 0, enteredCount: 0 };

  const numRows  = lastRow - VENDOR_TAB.DATA_START_ROW + 1;
  // One range read spanning E (On Hand) through M (Item ID).
  const startCol = VENDOR_TAB.ON_HAND_COL;                 // E (5)
  const data     = sh.getRange(VENDOR_TAB.DATA_START_ROW, startCol, numRows, VENDOR_TAB.ITEM_ID_COL - startCol + 1).getValues();
  const ID_IDX   = VENDOR_TAB.ITEM_ID_COL - startCol;      // M, relative to E

  const dayMult = vendorDayMultiplier_(ctx.vendorMults, vendor, ctx.dayOfWeek, ctx.emergencyOverride, ctx.vendorOverrides);

  let enteredCount = 0;
  let toOrder = 0;
  for (const r of data) {
    const onHandRaw = r[0];
    const entered   = (onHandRaw !== '' && onHandRaw !== null && !isNaN(Number(onHandRaw)));
    if (entered) enteredCount++;

    const itemId = String(r[ID_IDX] || '').trim();
    if (!itemId) continue;
    const meta = ctx.masterMeta.get(itemId);
    if (!meta || !meta.name) continue;   // non-roster / blank row — same skip as the count path

    const onHand    = entered ? Number(onHandRaw) : null;
    const suggested = computeSuggestedQty_(meta.par, meta.useMult, dayMult, onHand);
    if (suggested != null && suggested > 0) toOrder++;
  }
  return { any: enteredCount > 0, toOrder: toOrder, enteredCount: enteredCount };
}


function getTodaysLogByVendor_(dateStr) {
  const log = getSheet_(SHEET_ORDER_LOG);
  const map = new Map();
  const tz = SpreadsheetApp.getActiveSpreadsheet().getSpreadsheetTimeZone();

  // Date parsing stays THIS function's own rather than reusing the shared
  // makeLogDateFormatter_: a non-Date cell is truncated to its first 10 chars
  // here, where the history readers re-parse it through new Date(). The two
  // disagree on odd values, so keeping it local preserves behavior exactly.
  // Memoized because one cycle stamps the same date onto every row it logs.
  const dateMemo = new Map();
  const fmtLogDate = function (v) {
    const key = (typeof v) + ':' + ((v instanceof Date) ? v.getTime() : v);
    const hit = dateMemo.get(key);
    if (hit !== undefined) return hit;
    const out = (v instanceof Date)
      ? Utilities.formatDate(v, tz, 'yyyy-MM-dd')
      : String(v || '').trim().substring(0, 10);
    dateMemo.set(key, out);
    return out;
  };

  // Slice to today's rows instead of reading the whole log. This runs inside
  // api_getDashboard_compute_, whose CacheService entry is invalidated by every
  // bumpServerMutationTs_ — api_saveOnHand_ included — so while a KM is
  // counting, the next dashboard load recomputes on nearly every save. The log
  // grows forever; today's rows are a handful, and being append-ordered they
  // sit at the end. dateFrom == dateTo bounds the slice to exactly the
  // matching rows (readLogSlice_ returns null when none match).
  const data = readLogSlice_(log, dateStr, dateStr, LOG_COL.QTY_ORDERED, fmtLogDate);
  if (!data) return map;

  for (const r of data) {
    const orderDate = fmtLogDate(r[LOG_COL.ORDER_DATE - 1]);
    if (orderDate !== dateStr) continue;

    const vendor = String(r[LOG_COL.VENDOR - 1] || '').trim();
    if (!vendor) continue;

    const tsRaw = r[LOG_COL.TIMESTAMP - 1];
    const ts = tsRaw instanceof Date
      ? Utilities.formatDate(tsRaw, tz, 'HH:mm')
      : String(tsRaw).substring(11, 16);

    if (!map.has(vendor)) {
      map.set(vendor, {
        vendor:    vendor,
        sentAt:    ts,
        itemCount: 0,
        reference: generateReferenceFromDateStr_(vendor, orderDate)
      });
    }
    map.get(vendor).itemCount++;
  }
  return map;
}


function generateReferenceFromDateStr_(vendor, dateStr) {
  // dateStr in 'yyyy-MM-dd' form
  const parts = String(dateStr).split('-');
  if (parts.length < 3) return '';
  const md   = parts[1] + parts[2];
  const abbr = (PropertiesService.getScriptProperties().getProperty(PROP_LOCATION_ABBR) || 'LOC').toUpperCase();
  const v    = vendor.replace(/[^A-Za-z]/g, '').substring(0, 3).toUpperCase();
  return abbr + '-' + md + '-' + v;
}


