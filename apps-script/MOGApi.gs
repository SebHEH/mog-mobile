/***********************
 * MOG MOBILE API — v0.1.0
 *
 * Web app endpoints for the mobile companion PWA.
 * Single endpoint via doPost dispatching on { pin, action, payload }.
 *
 * SETUP (per location, one-time):
 *   1. Add this file to the script project in the location's spreadsheet
 *      (Extensions → Apps Script → File +).
 *   2. From the script editor, run setupMobileApi() — prompts for PIN,
 *      location name, abbreviation, and GM email.
 *   3. Edit VENDOR_META below to add cutoff times for each vendor.
 *   4. Deploy → New deployment → type "Web app"
 *        Execute as: Me
 *        Who has access: Anyone
 *      Copy the deployment URL — that is the per-location API endpoint.
 *   5. Add the URL + PIN into the mobile app config for that location.
 *
 * NOTES:
 *   - Does not modify any existing functions in the bound-script files.
 *   - Reads from MASTER_ITEMS, SETUP, LOG_ORDERS.
 *   - Writes only to MASTER_ITEMS.On_Hand (same column the existing system
 *     uses for in-progress counts) and LOG_ORDERS (append-only on submit).
 *   - The mobile app and the spreadsheet UI share state automatically —
 *     counting in either place updates the same On Hand column.
 *
 * CORS NOTE FOR PWA CLIENT:
 *   Apps Script Web Apps reject application/json POSTs (CORS preflight).
 *   The PWA must use Content-Type: text/plain;charset=utf-8 and put the
 *   JSON in the body. Apps Script reads it from e.postData.contents.
 *
 * TODO BEFORE V1 SHIP:
 *   - Audit log of API calls (who, what, when)
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

// MOG-specific columns in MASTER_ITEMS not present in the existing COL object.
// The COL object (Core.gs) only references columns through NOTES (14)
// because On Hand and the formula columns live on vendor tabs in that workflow.
// The mobile API reads On Hand straight from MASTER_ITEMS, so we declare it here.
const MOG_COL = {
  ON_HAND: 9 // I — "On Hand"
};

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
  if (page === 'editor')  return renderEditorHome_();        // Editor.gs — home dashboard (card launcher)
  if (page === 'items')   return renderManageItemsWeb_();    // Editor.gs — Manage Items as a web page
  if (page === 'vendors') return renderManageVendorsWeb_();  // Editor.gs — Manage Vendors as a web page
  if (page === 'history') return renderOrderHistoryWeb_();   // Editor.gs — Order History as a web page
  if (page === 'areas')   return renderStorageAreasWeb_();   // Editor.gs — Storage Areas as a web page
  if (page === 'pickpath')return renderReorderPickPathWeb_();// Editor.gs — Reorder Pick Path as a web page

  const location = PropertiesService.getScriptProperties().getProperty(PROP_LOCATION) || 'Not configured';
  return jsonResponse_({
    ok: true,
    service: 'MOG Mobile API',
    version: API_VERSION,
    location: location,
    message: 'POST to this URL with { pin, action, payload }'
  });
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
      case 'getDashboard':     data = api_getDashboard_();              break;
      case 'getVendorItems':   data = api_getVendorItems_(payload);     break;
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
  // Note: the spreadsheet's full-fat reset wrapper also resets the
  // emergency override checkbox. The mobile API doesn't expose emergency
  // override yet, so we don't touch it here. If it becomes a mobile feature,
  // mirror that behavior here too.

  const result = commitLogAndReset();

  const oe = getSheet_(SHEET_ORDER_ENTRY);
  const today = new Date();
  oe.getRange('AE9').setValue(today);

  const tz = Session.getScriptTimeZone();
  return {
    logged:        !!result.logged,
    rowsLogged:    result.rowsLogged || 0,
    orderDate:     result.orderDate || null,
    skippedReason: result.skippedReason || null,
    resetDate:     Utilities.formatDate(today, tz, 'yyyy-MM-dd')
  };
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
  const tz        = Session.getScriptTimeZone();
  const active    = getActiveOrderDate_();
  const dateStr   = active.dateStr;
  const dayOfWeek = active.dayOfWeek;

  const setup        = getSheet_(SHEET_SETUP);
  const allVendors   = getVendorList();
  const vendorMults  = readVendorMultipliers_(setup);
  const vendorCutoffs = readVendorCutoffs_(setup);
  const todaysLog    = getTodaysLogByVendor_(dateStr);
  const itemCounts   = countActiveItemsByVendor_();

  const out = [];
  for (const vendorName of allVendors) {
    const mults = vendorMults.get(vendorName) || {};
    if ((Number(mults[dayOfWeek]) || 0) <= 0) continue; // not an order day

    const meta      = VENDOR_META[vendorName] || {};
    const itemCount = itemCounts.get(vendorName) || 0;
    const log       = todaysLog.get(vendorName);

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
      enteredCount = itemCount; // a sent vendor implicitly has all items "entered"
    } else {
      const inProgress = vendorOnHandSnapshot_(vendorName);
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
    vendors:   out
  };
}


function api_getVendorItems_(payload) {
  // Reads items + On Hand + Suggested directly from the vendor tab.
  //
  // Vendor tab structure (per VENDOR_TAB constant + script comments):
  //   A(1) = Item Name      B(2) = Pack
  //   E(5) = On Hand        F(6) = Suggested Order Qty (formula-driven)
  //   M(13)= Item ID (hidden, formula-driven from SETUP pick path)
  //   Data rows start at VENDOR_TAB.DATA_START_ROW (3).
  //
  // Why read from the vendor tab and not MASTER_ITEMS:
  //   * On Hand lives on the vendor tab — that's where users enter counts
  //     (manually in the sheet, or via this API for the mobile app). The
  //     dashboard's "X / Y entered" counter reads vendor tab column E too.
  //   * Suggested Order Qty in column F is a formula already calibrated to
  //     today's day-of-week multiplier (via AE3). Reading the cell value
  //     means we always reflect what the sheet shows — no client-side or
  //     API-side multiplier math needed. Fix to AE3 (now anchored to AE9)
  //     propagates here automatically.
  //
  // Storage area / pick path order still come from SETUP's pick path DB
  // because the vendor tab itself doesn't carry that metadata.
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
  for (const r of readPickDb_(setup)) {
    if (String(r[0] || '').trim() !== vendor) continue;
    const id = String(r[1] || '').trim();
    if (!id) continue;
    pickInfo.set(id, {
      area:       String(r[3] || '').trim(),
      areaOrder:  Number(r[4]) || 999,
      shelfOrder: Number(r[5]) || 999999
    });
  }

  // Pull A:M (1..13) for every data row, AND read H2 (the day-of-week
  // multiplier in the vendor tab header). targetPar = parInD * mult.
  const numRows = lastRow - VENDOR_TAB.DATA_START_ROW + 1;
  const data    = sh.getRange(VENDOR_TAB.DATA_START_ROW, 1, numRows, 13).getValues();
  const dayMult = Number(sh.getRange('H2').getValue()) || 0;

  // Map<itemId, boolean> for the Use Multiplier flag from MASTER_ITEMS.
  // Consulted per-item below to optionally override targetPar/suggested
  // for items that should ignore the day multiplier.
  const useMultiplierMap = readUseMultiplierMap_();

  const items = [];
  for (const r of data) {
    const itemName = String(r[0]  || '').trim();   // A
    const pack     = String(r[1]  || '').trim();   // B
    const parRaw   = r[3];                              // D — base par
    const onHandRaw    = r[VENDOR_TAB.ON_HAND_COL - 1]; // E (5)
    const suggestedRaw = r[5];                          // F (6 → index 5)
    const itemId   = String(r[12] || '').trim();   // M (13 → index 12)

    if (!itemName || !itemId) continue;

    const onHand = (onHandRaw === '' || onHandRaw === null)
      ? null
      : (isNaN(Number(onHandRaw)) ? null : Number(onHandRaw));

    // targetPar = par (col D) * day multiplier (H2). This is what column F's
    // formula resolves to internally before subtracting on-hand. Surfacing
    // it lets the PWA compute live suggestions for items that hadn't been
    // counted yet (where suggestedQty alone can't be inferred).
    //
    // Use Multiplier override: items flagged "Use Multiplier = FALSE" in
    // MASTER_ITEMS column M get targetPar = par (no day multiplier). The
    // sheet's column F formula still applies the multiplier; we recompute
    // suggested directly below to match the corrected targetPar.
    const parNum = Number(parRaw);
    const useMult = (useMultiplierMap.has(itemId) ? useMultiplierMap.get(itemId) : true);
    const effectiveMult = useMult ? dayMult : 1;
    const targetPar = (!isNaN(parNum) && effectiveMult > 0)
      ? parNum * effectiveMult
      : null;

    let suggested = null;
    if (suggestedRaw !== '' && suggestedRaw !== null && !isNaN(Number(suggestedRaw))) {
      suggested = Math.max(0, Number(suggestedRaw));
    }
    // Suggested comes from the vendor tab's column F formula which
    // already honors the Use Multiplier flag via XLOOKUP. We trust that
    // output as-is — no client-side recomputation needed. The targetPar
    // override above keeps the PWA's computeSuggested helper (which
    // recomputes on every keystroke) in sync with the sheet.
    // The PWA hides the suggestion until On Hand is entered, even if the
    // formula has produced a number from a stale prior count. Mirror that.
    if (onHand === null) suggested = null;

    const pi = pickInfo.get(itemId) || { area: '', areaOrder: 999, shelfOrder: 999999 };

    items.push({
      id:           itemId,
      name:         itemName,
      pack:         pack,
      par:          (!isNaN(parNum) ? parNum : 0),
      targetPar:    targetPar,
      onHand:       onHand,
      suggestedQty: suggested,
      storageArea:  pi.area,
      _areaOrder:   pi.areaOrder,
      _shelfOrder:  pi.shelfOrder
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
    const cutoffMap = readVendorCutoffs_(getSheet_(SHEET_SETUP));
    cutoff = cutoffMap.get(vendor) || null;
  } catch (e) {
    // If SETUP read fails for any reason, fall through to VENDOR_META.
    // We never want a cutoff lookup error to break the whole vendor
    // items response — items are the important payload.
  }
  if (!cutoff) {
    cutoff = (VENDOR_META[vendor] || {}).cutoffTime || null;
  }

  return {
    vendor:     vendor,
    cutoffTime: cutoff,
    items:      items
  };
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
  const idCol   = sh.getRange(VENDOR_TAB.DATA_START_ROW, 13, numRows, 1).getValues();
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


function api_emailRecap_(payload) {
  // Builds and emails an end-of-day recap to every active recipient
  // configured in SETUP columns AB-AE. Recipients are server-side so a
  // single email goes to the same people regardless of which device or
  // which user triggers the send.
  //
  // This is purely a convenience email. It does NOT write to LOG_ORDERS —
  // that happens only when reset runs (the next morning) and snapshots the
  // current On Hand state into the log. The recap is just so the KMs and
  // GMs have a clean copy of the suggested order to actually place.
  //
  // Optional payload:
  //   force   (bool) — if true, send even when the current cycle already
  //                    had a successful recap. Used by manual sends. Auto-
  //                    triggered sends (bulk-mark, pre-reset) omit this so
  //                    they cleanly dedupe across the PWA + sheet-reset paths.
  //   vendors (array) — vendor names to include. Omit for all active-day
  //                     vendors with suggestions.
  //
  // Returns:
  //   { cycleDate, vendorCount, itemCount, sentCount, failedCount,
  //     failed: [{name, email, error}], alreadySent, vendors }
  //
  // Throws when there are zero configured recipients or zero items to
  // recap. Auto-send callers should catch and treat these as "no-op".
  ensureRecipientsHeader_();
  migrateGmEmailToRecipients_();

  const props = PropertiesService.getScriptProperties();
  const force = !!(payload && payload.force);
  const active = getActiveOrderDate_();
  const currentCycleDate = active.dateStr;
  const lastSent = props.getProperty(PROP_LAST_RECAP_SENT_DATE) || '';

  // Auto-send dedupe: if this cycle was already emailed, return a
  // structured no-op so the caller can show "already sent" state
  // without surfacing an error. Manual sends bypass via force.
  if (!force && lastSent === currentCycleDate) {
    return {
      cycleDate:    currentCycleDate,
      vendorCount:  0,
      itemCount:    0,
      sentCount:    0,
      failedCount:  0,
      failed:       [],
      alreadySent:  true,
      vendors:      []
    };
  }

  const recipients = readRecipients_().filter(r => r.active && r.email);
  if (!recipients.length) {
    throw new Error('No recipients configured. Add at least one in Settings → Recipients.');
  }

  const { sections, totalItems, cycleDate } = buildRecapSections_(
    payload && Array.isArray(payload.vendors) ? payload.vendors : null
  );
  if (!sections.length) {
    throw new Error('Nothing to recap — no vendors have items to order.');
  }

  // Send one email per recipient. Individual sends mean:
  //   - Per-address bounce isolation (one bad email doesn't kill the rest)
  //   - No shared distribution list visible in headers
  //   - Future per-recipient customization is straightforward
  const failed = [];
  for (const r of recipients) {
    try {
      sendRecapEmail_(r.email, sections, cycleDate, totalItems);
    } catch (err) {
      Logger.log('Recap send failed for ' + r.email + ': ' + (err.stack || err));
      failed.push({
        name:  r.name,
        email: r.email,
        error: String(err.message || err)
      });
    }
  }

  // Set the dedupe flag if at least one recipient received the email.
  // Total-failure case (every send threw): leave the flag alone so the
  // next legitimate attempt isn't gated by a failed cycle.
  if (failed.length < recipients.length) {
    props.setProperty(PROP_LAST_RECAP_SENT_DATE, cycleDate);
  }

  return {
    cycleDate:    cycleDate,
    vendorCount:  sections.length,
    itemCount:    totalItems,
    sentCount:    recipients.length - failed.length,
    failedCount:  failed.length,
    failed:       failed,
    alreadySent:  false,
    vendors:      sections.map(s => ({ vendor: s.vendor, itemCount: s.lines.length }))
  };
}

function api_getRecapData_(payload) {
  // Returns the same structured data emailRecap builds, but never sends
  // an email and never throws on empty. Used by the PWA's in-app
  // "View full order list" view.
  //
  // Returns:
  //   {
  //     cycleDate,
  //     vendorCount,
  //     itemCount,
  //     sections: [{ vendor, itemCount, lines: [{ name, pack, onHand, qty, area }] }]
  //   }
  // Empty cycles return an empty sections array instead of an error so the
  // PWA can render an empty state cleanly.
  const { sections, totalItems, cycleDate } = buildRecapSections_(
    payload && Array.isArray(payload.vendors) ? payload.vendors : null
  );
  return {
    cycleDate:   cycleDate,
    vendorCount: sections.length,
    itemCount:   totalItems,
    sections:    sections
  };
}

function buildRecapSections_(requestedVendors) {
  // Shared logic between emailRecap and getRecapData. Reads current state
  // and produces the {sections, totalItems, cycleDate} bundle.
  const setup       = getSheet_(SHEET_SETUP);
  const allVendors  = getVendorList();
  const vendorMults = readVendorMultipliers_(setup);
  const active      = getActiveOrderDate_();
  const dayOfWeek   = active.dayOfWeek;
  const cycleDate   = active.dateStr;

  let vendorsToCheck;
  if (requestedVendors && requestedVendors.length) {
    const known = new Set(allVendors);
    vendorsToCheck = requestedVendors.filter(v => known.has(v));
  } else {
    vendorsToCheck = allVendors.filter(v => {
      const m = vendorMults.get(v) || {};
      return (Number(m[dayOfWeek]) || 0) > 0;
    });
  }

  const sections = [];
  let totalItems = 0;
  for (const vendor of vendorsToCheck) {
    const result = api_getVendorItems_({ vendor: vendor });
    const lines = result.items
      .filter(it => it.suggestedQty != null && it.suggestedQty > 0)
      .map(it => ({
        name:   it.name,
        pack:   it.pack,
        onHand: it.onHand,
        qty:    it.suggestedQty,
        area:   it.storageArea
      }));
    if (lines.length) {
      sections.push({ vendor: vendor, itemCount: lines.length, lines: lines });
      totalItems += lines.length;
    }
  }

  return { sections: sections, totalItems: totalItems, cycleDate: cycleDate };
}




function api_getHistoryDetail_(payload) {
  const date   = String(payload.date   || '');
  const vendor = String(payload.vendor || '');
  if (!date || !vendor) throw new Error('date and vendor are required.');

  const flat = getOrderHistory({ vendorFilter: vendor, dateFrom: date, dateTo: date });

  // Pack metadata isn't stored in LOG_ORDERS — pull it from MASTER_ITEMS
  // and join by item ID. One-shot read; the map is local to this request.
  const packById = buildPackByIdMap_();

  const items = flat.map(r => ({
    id:     r.itemId,
    name:   r.itemName,
    pack:   packById.get(r.itemId) || '',
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

  const flat = getOrderHistory({ vendorFilter: 'ALL', dateFrom: dateFrom, dateTo: dateTo });

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

  const flat = getOrderHistory({ vendorFilter: 'ALL', dateFrom: date, dateTo: date });

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


function readUseMultiplierMap_() {
  // Reads MASTER_ITEMS columns A (Item ID) and M (Use Multiplier) and
  // returns Map<itemId, boolean>. Items without a row in MASTER_ITEMS,
  // or with an unparseable Use Multiplier value, default to true — the
  // multiplier applies unless explicitly turned off.
  //
  // Why: the vendor tab's Suggested column F formula multiplies par by
  // the day-of-week multiplier (H2) for every item, with no exception
  // for items that are billed flat (e.g., contracted weekly deliveries
  // where the par is already correct for the week). The "Use Multiplier"
  // flag in MASTER_ITEMS column M lets the GM mark such items, but the
  // current sheet formula and API both ignore it. This helper plus the
  // override in api_getVendorItems_ honor that flag at the API layer.
  //
  // Column layout (MASTER_ITEMS):
  //   A=Item ID, B=Item Name, ..., L=Active, M=Use Multiplier, N=Notes
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
    map.set(id, useMult);
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


function countActiveItemsForVendor_(vendor) {
  const sh = getSheet_(SHEET_MASTER);
  const lastRow = sh.getLastRow();
  if (lastRow < 2) return 0;
  const data = sh.getRange(2, 1, lastRow - 1, COL.ACTIVE).getValues();
  let count = 0;
  for (const r of data) {
    if (String(r[COL.VENDOR - 1] || '').trim() === vendor && r[COL.ACTIVE - 1] === true) count++;
  }
  return count;
}


// Bulk variant of countActiveItemsForVendor_ — one MASTER_ITEMS scan returns
// counts for every vendor at once. The dashboard used to call the singular
// form inside its per-vendor loop, rescanning master ~10x per hit; this
// folds it into a single pass.
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


function vendorOnHandSnapshot_(vendor) {
  // Returns { any, toOrder, enteredCount } for the dashboard's per-vendor
  // status detection.
  //   any          — at least one On Hand value entered for this vendor today
  //   toOrder      — count of items where the vendor tab's Suggested formula > 0
  //   enteredCount — count of items with a numeric On Hand value entered
  //
  // Reads vendor tab columns E and F directly, since the F formula is
  // already day-multiplier-aware via AE3 → AE9 indirection.
  const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(vendor);
  if (!sh) return { any: false, toOrder: 0, enteredCount: 0 };

  const lastRow = sh.getLastRow();
  if (lastRow < VENDOR_TAB.DATA_START_ROW) return { any: false, toOrder: 0, enteredCount: 0 };

  const numRows = lastRow - VENDOR_TAB.DATA_START_ROW + 1;
  // Read E (5) and F (6) — two adjacent columns, one range read
  const data = sh.getRange(VENDOR_TAB.DATA_START_ROW, VENDOR_TAB.ON_HAND_COL, numRows, 2).getValues();

  let enteredCount = 0;
  let toOrder = 0;
  for (const r of data) {
    const onHand    = r[0];
    const suggested = r[1];
    if (onHand !== '' && onHand !== null && !isNaN(Number(onHand))) enteredCount++;
    const sNum = Number(suggested);
    if (!isNaN(sNum) && sNum > 0) toOrder++;
  }
  return { any: enteredCount > 0, toOrder: toOrder, enteredCount: enteredCount };
}


function getTodaysLogByVendor_(dateStr) {
  const log = getSheet_(SHEET_ORDER_LOG);
  const lastRow = log.getLastRow();
  const map = new Map();
  if (lastRow < 2) return map;
  const data = log.getRange(2, 1, lastRow - 1, 7).getValues();
  const tz = Session.getScriptTimeZone();

  for (const r of data) {
    const orderDateRaw = r[LOG_COL.ORDER_DATE - 1];
    let orderDate;
    if (orderDateRaw instanceof Date) {
      orderDate = Utilities.formatDate(orderDateRaw, tz, 'yyyy-MM-dd');
    } else {
      orderDate = String(orderDateRaw || '').trim().substring(0, 10);
    }
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


function sendRecapEmail_(recipient, sections, cycleDate, totalItems) {
  const props    = PropertiesService.getScriptProperties();
  const location = props.getProperty(PROP_LOCATION) || '';
  const subject  = '[' + location + '] Daily order recap — ' + cycleDate +
                   ' (' + sections.length + ' vendors, ' + totalItems + ' items)';

  // Plain text — copy/paste-friendly, easy to scan from a phone. Mirrors the HTML:
  // "suggested" framing + the "Item × qty (pack)" line order, On Hand trailing.
  let body = 'SUGGESTED DAILY ORDER\n=====================\n\n';
  body += 'Suggested amounts based on today\'s On Hand — review before placing each order.\n\n';
  body += 'Location: ' + location + '\n';
  body += 'Date:     ' + cycleDate + '\n';
  body += 'Vendors:  ' + sections.length + '\n';
  body += 'Items:    ' + totalItems + '\n\n';

  for (const sec of sections) {
    body += '-- ' + sec.vendor.toUpperCase() + ' --\n';
    for (const line of sec.lines) {
      const onHand = (line.onHand === null || line.onHand === '') ? '—' : line.onHand;
      body += '  ' + line.name + ' × ' + line.qty + (line.pack ? ' (' + line.pack + ')' : '');
      body += '   [on hand: ' + onHand + ']\n';
    }
    body += '\n';
  }

  // HTML — brand-aligned recap. Email clients strip <style>/:root/var(), so all
  // colors are inlined as LITERAL hexes. The header band + accents are themed
  // PER STORE CONCEPT via dashTheme_() (MOG_CONCEPT property — same palette as the
  // Sheet dashboard, so email and dashboard stay coordinated):
  //   roll-play → teal-dark #2d8c6b + white · teasnyou → charcoal #1a1a1a + gold
  //   #D4A574 · unset/unknown → navy #1a1a2e + white (matches the modal --brand).
  // dashTheme_() lives in Dashboard.gs but shares global scope at runtime.
  const theme    = (typeof dashTheme_ === 'function')
                     ? dashTheme_()
                     : { accent: '#1a1a2e', bannerFont: '#ffffff' };
  const bandBg   = theme.accent;        // header band background (concept color)
  const bandText = theme.bannerFont;    // band title (white, or TNY charcoal)
  // Sub-line tone that reads on the band: light gray on a dark band, muted dark
  // on a light (e.g. TNY gold) band — picked from the band's luminance.
  let _bandHex = String(bandBg).replace('#', '');
  if (_bandHex.length === 3) _bandHex = _bandHex[0]+_bandHex[0]+_bandHex[1]+_bandHex[1]+_bandHex[2]+_bandHex[2];
  const bandLum  = parseInt(_bandHex.substr(0,2),16)*0.299 + parseInt(_bandHex.substr(2,2),16)*0.587 + parseInt(_bandHex.substr(4,2),16)*0.114;
  const bandSub  = (bandLum > 150) ? '#6b5f43'
                 : (String(bandText).toLowerCase() === '#ffffff') ? '#dcdce6' : '#cfcfcf';
  const headInk  = theme.ink;           // vendor headers + the "× qty" number (dark — reads on white)

  let html = '<div style="font-family:-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif;max-width:640px;margin:0 auto;color:#1f2937">';

  // Header band (store + date + counts) — concept-themed. Single-cell table for
  // client safety (Gmail/iOS render a table-cell background more reliably than a div).
  html += '<table role="presentation" style="width:100%;border-collapse:collapse;margin:0 0 14px">';
  html += '<tr><td style="background:' + bandBg + ';padding:18px 20px;border-radius:8px">';
  html += '<div style="color:' + bandText + ';font-size:22px;font-weight:700;line-height:1.2">' + escapeHtml_(location) + '</div>';
  html += '<div style="color:' + bandText + ';font-size:15px;font-weight:600;margin-top:4px">Suggested daily order</div>';
  html += '<div style="color:' + bandSub + ';font-size:12px;margin-top:6px">' + cycleDate + ' &middot; ' + sections.length + ' vendors &middot; ' + totalItems + ' items</div>';
  html += '</td></tr></table>';

  // Clarity caption — these are SUGGESTED amounts, not a placed order.
  html += '<p style="color:#444;font-size:13px;margin:0 0 18px;line-height:1.45">';
  html += 'Suggested order amounts based on today’s On Hand counts. ';
  html += 'Review each before placing the order through the vendor’s normal channel.';
  html += '</p>';

  for (const sec of sections) {
    html += '<h3 style="color:' + headInk + ';margin:20px 0 6px;font-size:16px;border-bottom:2px solid ' + headInk + ';padding-bottom:6px">' + escapeHtml_(sec.vendor) + '</h3>';
    html += '<table style="width:100%;border-collapse:collapse;font-size:14px">';
    html += '<tr style="background:#f4f5f7">';
    html += '<th style="padding:7px 8px;text-align:left;font-size:11px;letter-spacing:.04em;text-transform:uppercase;color:#888">Suggested order</th>';
    html += '<th style="padding:7px 8px;text-align:right;font-size:11px;letter-spacing:.04em;text-transform:uppercase;color:#aab0b6">On hand</th>';
    html += '</tr>';
    for (const line of sec.lines) {
      const onHand = (line.onHand === null || line.onHand === '') ? '—' : line.onHand;
      // One readable line: "Item Name × 3 (Pack)" — name in body ink, the × qty
      // bold in the concept accent (the action number), pack muted in parens.
      html += '<tr>';
      html += '<td style="padding:9px 8px;border-bottom:1px solid #eef0f2;line-height:1.4">';
      html += '<span style="color:#1f2937">' + escapeHtml_(line.name) + '</span>';
      html += '<strong style="color:' + headInk + ';white-space:nowrap;font-size:15px">&nbsp;&times; ' + line.qty + '</strong>';
      if (line.pack) {
        html += '<span style="color:#9aa0a6;font-size:13px">&nbsp;(' + escapeHtml_(line.pack) + ')</span>';
      }
      html += '</td>';
      html += '<td style="padding:9px 8px;border-bottom:1px solid #eef0f2;text-align:right;color:#aab0b6;font-size:12px;white-space:nowrap">' + onHand + '</td>';
      html += '</tr>';
    }
    html += '</table>';
  }

  html += '<p style="color:#888;font-size:12px;margin-top:22px;border-top:1px solid #e5e7eb;padding-top:12px">';
  html += 'This is a recap of suggested orders. Place each vendor\'s order through their normal channel ';
  html += '(portal, app, phone, email). Order History will populate when reset runs tomorrow.';
  html += '</p>';
  html += '</div>';

  // No CC anymore — each recipient gets their own individual email.
  // The recipient list is configured in SETUP AB-AE and read by
  // api_emailRecap_, which calls this helper once per active recipient.
  MailApp.sendEmail({
    to:       recipient,
    subject:  subject,
    body:     body,
    htmlBody: html,
    name:     'Master Ordering Guide'
  });
}


// Editor-run only (NOT menu-wired): sends the current cycle's recap to whoever
// runs it — Session.getActiveUser() — bypassing the configured recipient list,
// the once-per-day dedupe flag, and the On-Hand clear. Use it to preview the
// email design without emailing the real recipients. Throws a clear message if
// there's nothing to recap (no vendor has items to order right now).
function test_recapEmailToSelf() {
  const me = Session.getActiveUser().getEmail();
  if (!me) throw new Error('Could not resolve your email from Session.getActiveUser().');
  const recap = buildRecapSections_(null);
  if (!recap.sections.length) {
    throw new Error('Nothing to recap — no vendor has items to order right now. ' +
                    'Enter some On Hand counts first, then re-run.');
  }
  sendRecapEmail_(me, recap.sections, recap.cycleDate, recap.totalItems);
  Logger.log('Test recap sent to ' + me + ' — ' + recap.sections.length +
             ' vendors, ' + recap.totalItems + ' items (' + recap.cycleDate + ').');
}


function escapeHtml_(s) {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}


/***********************
 * 4b) RECIPIENTS — server-side email list in SETUP columns AB-AE
 *
 * Layout (one row per recipient, rows 2+):
 *   AB: Name          (string)
 *   AC: Email         (string)
 *   AD: Active        (TRUE/FALSE — whether they receive recaps)
 *   AE: GM            (TRUE/FALSE — when TRUE, the row is read-only from
 *                      the PWA. KMs can see the row but cannot edit,
 *                      toggle, or remove it. Setting GM=TRUE requires
 *                      editing the spreadsheet directly.)
 *
 * GM lock is enforced server-side in api_saveRecipients_: incoming
 * payloads are checked against the on-sheet GM rows, and any save that
 * would mutate or remove a GM row is rejected. New rows are coerced to
 * GM=FALSE regardless of what the client sends.
 ***********************/

function readRecipients_() {
  // Returns [{name, email, active, gm}] from SETUP AB-AE, rows 2+.
  //
  // Uses backward value-scan in column AB to find the last non-empty
  // row instead of getLastRow(), which can over-report due to formatting
  // or empty cells with data validation. Same pattern as readVendorMultipliers_.
  const setup = getSheet_(SHEET_SETUP);
  const maxRows = setup.getMaxRows();
  if (maxRows < RECIPIENTS_START_ROW) return [];

  const scanRows = maxRows - RECIPIENTS_START_ROW + 1;
  const nameCol = setup.getRange(RECIPIENTS_START_ROW, RECIPIENTS_START_COL, scanRows, 1).getValues();
  let lastIdx = -1;
  for (let i = nameCol.length - 1; i >= 0; i--) {
    if (String(nameCol[i][0] || '').trim()) { lastIdx = i; break; }
  }
  if (lastIdx < 0) return [];

  const numRows = lastIdx + 1;
  const values = setup
    .getRange(RECIPIENTS_START_ROW, RECIPIENTS_START_COL, numRows, RECIPIENTS_NUM_COLS)
    .getValues();
  const out = [];
  for (let i = 0; i < numRows; i++) {
    const name  = String(values[i][0] || '').trim();
    const email = String(values[i][1] || '').trim();
    // Skip blank rows in the middle — same as how readVendorMultipliers_
    // silently drops empty rows. Caller doesn't need to see structural gaps.
    if (!name && !email) continue;
    out.push({
      name:   name,
      email:  email,
      active: values[i][2] === true,
      gm:     values[i][3] === true
    });
  }
  return out;
}


function writeRecipients_(recipients) {
  // Atomic clear-then-write of the recipients block. Caller is
  // responsible for GM-preservation and coercing new rows to gm=false —
  // this helper just writes the array it receives.
  const setup = getSheet_(SHEET_SETUP);
  const maxRows = setup.getMaxRows();

  // Clear the entire AB-AE block from row 2 down. Keeps the sheet from
  // accumulating stale rows if the new list is shorter than the old one.
  if (maxRows >= RECIPIENTS_START_ROW) {
    setup
      .getRange(RECIPIENTS_START_ROW, RECIPIENTS_START_COL,
                maxRows - RECIPIENTS_START_ROW + 1, RECIPIENTS_NUM_COLS)
      .clearContent();
  }

  if (!recipients.length) return;
  const rows = recipients.map(r => [
    String(r.name || '').trim(),
    String(r.email || '').trim(),
    r.active === true,
    r.gm === true
  ]);
  setup
    .getRange(RECIPIENTS_START_ROW, RECIPIENTS_START_COL, rows.length, RECIPIENTS_NUM_COLS)
    .setValues(rows);
}


function ensureRecipientsHeader_() {
  // Idempotent: writes the AB-AE header row if absent. Called lazily at
  // the top of every recipient-related action so existing stores don't
  // need to re-run setupMobileApi to pick up the header.
  const setup = getSheet_(SHEET_SETUP);
  const headerVals = setup
    .getRange(RECIPIENTS_HEADER_ROW, RECIPIENTS_START_COL, 1, RECIPIENTS_NUM_COLS)
    .getValues()[0];
  if (headerVals.every(v => !String(v || '').trim())) {
    setup
      .getRange(RECIPIENTS_HEADER_ROW, RECIPIENTS_START_COL, 1, RECIPIENTS_NUM_COLS)
      .setValues([['Recipient Name', 'Recipient Email', 'Active', 'GM']]);
  }
}


function migrateGmEmailToRecipients_() {
  // One-time migration: if PROP_GM_EMAIL is set AND the recipients list
  // is empty, seed the legacy GM address as recipient #1 with
  // GM=TRUE, Active=TRUE. After seeding, future reads return the
  // recipient row and this branch is no-op'd (length > 0).
  //
  // PROP_GM_EMAIL is preserved (not deleted) so any code that still
  // reads it during a transition window stays safe. Future cleanup
  // can drop the property entirely.
  const props = PropertiesService.getScriptProperties();
  const gmEmail = (props.getProperty(PROP_GM_EMAIL) || '').trim();
  if (!gmEmail) return;
  const existing = readRecipients_();
  if (existing.length) return;
  writeRecipients_([{
    name:   'GM',
    email:  gmEmail,
    active: true,
    gm:     true
  }]);
}


function api_getRecipients_() {
  // Returns the full recipients list as { recipients: [...] }. Includes
  // both active and inactive entries so the PWA can render the toggle
  // state correctly. GM rows are flagged for the client to render with
  // a lock icon and no edit controls.
  ensureRecipientsHeader_();
  migrateGmEmailToRecipients_();
  return { recipients: readRecipients_() };
}


function api_saveRecipients_(payload) {
  // Writes the full recipients list to SETUP AB-AE atomically.
  //
  // Server-side GM-lock enforcement:
  //   1. Read current state from the sheet.
  //   2. For every existing GM row, find a match in the incoming payload
  //      by case-insensitive email. Reject the save if:
  //         - The GM row is missing entirely (KM tried to delete it)
  //         - The name or active flag differs from the sheet (mutation)
  //         - The incoming gm flag is anything but TRUE (demotion attempt)
  //   3. For every new (non-GM-matching) row, force gm=false regardless
  //      of what the client sent. There's no path to promote-via-PWA.
  //
  // Email shape validated per non-empty row; duplicates rejected with a
  // clear error. Blank rows silently dropped.
  ensureRecipientsHeader_();
  const incoming = (payload && Array.isArray(payload.recipients)) ? payload.recipients : [];

  const existing = readRecipients_();
  const existingGms = existing.filter(r => r.gm);
  const incomingByEmail = new Map();
  for (const r of incoming) {
    const key = String(r.email || '').trim().toLowerCase();
    if (key) incomingByEmail.set(key, r);
  }

  for (const gm of existingGms) {
    const key = gm.email.toLowerCase();
    const match = incomingByEmail.get(key);
    if (!match) {
      throw new Error('Cannot remove GM recipient "' + gm.name +
        '". GM rows are managed in the spreadsheet only.');
    }
    if (String(match.name || '').trim() !== gm.name ||
        match.active !== gm.active ||
        match.gm !== true) {
      throw new Error('Cannot modify GM recipient "' + gm.name +
        '". GM rows are managed in the spreadsheet only.');
    }
  }

  // Build sanitized list. Preserve existing GMs (already validated above)
  // and force gm=false on everything else. Validate non-empty rows.
  const sanitized = [];
  const seenEmails = new Set();
  for (const r of incoming) {
    const name  = String(r.name || '').trim();
    const email = String(r.email || '').trim();
    if (!name && !email) continue;
    if (!name)  throw new Error('Recipient is missing a name.');
    if (!email) throw new Error('Recipient "' + name + '" is missing an email.');
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      throw new Error('Recipient "' + name + '" has an invalid email: ' + email);
    }
    const key = email.toLowerCase();
    if (seenEmails.has(key)) {
      throw new Error('Duplicate email: ' + email);
    }
    seenEmails.add(key);

    // GM flag: TRUE only if this email is an existing GM on the sheet.
    // Client-side gm=true on a new row is ignored — no promotion path.
    const existingMatch = existing.find(e => e.email.toLowerCase() === key);
    const gmFlag = !!(existingMatch && existingMatch.gm);

    sanitized.push({
      name:   name,
      email:  email,
      active: r.active === true,
      gm:     gmFlag
    });
  }

  writeRecipients_(sanitized);
  return { recipients: sanitized };
}


/***********************
 * 5) ADMIN — RUN ONCE PER LOCATION
 ***********************/

function setupMobileApi() {
  const ui = SpreadsheetApp.getUi();
  const props = PropertiesService.getScriptProperties();

  const pinResp = ui.prompt(
    'Mobile API Setup — 1 of 6',
    'Enter a 4–8 digit PIN for this location.\n\n' +
    'KMs and managers will use this PIN to access the mobile app for this location only.',
    ui.ButtonSet.OK_CANCEL);
  if (pinResp.getSelectedButton() !== ui.Button.OK) return;
  const pin = pinResp.getResponseText().trim();
  if (!/^\d{4,8}$/.test(pin)) { ui.alert('PIN must be 4–8 digits.'); return; }

  const locResp = ui.prompt(
    'Mobile API Setup — 2 of 6',
    'Enter the location name (shown in the app).\n\nExample: Roll Play Rosslyn',
    ui.ButtonSet.OK_CANCEL);
  if (locResp.getSelectedButton() !== ui.Button.OK) return;
  const location = locResp.getResponseText().trim();
  if (!location) { ui.alert('Location name is required.'); return; }

  const abbrResp = ui.prompt(
    'Mobile API Setup — 3 of 6',
    'Enter a 2–5 letter abbreviation (used in order references).\n\nExample: RPR for Roll Play Rosslyn',
    ui.ButtonSet.OK_CANCEL);
  if (abbrResp.getSelectedButton() !== ui.Button.OK) return;
  const abbr = abbrResp.getResponseText().trim().toUpperCase();
  if (!/^[A-Z]{2,5}$/.test(abbr)) { ui.alert('Abbreviation must be 2–5 letters.'); return; }

  const conceptResp = ui.prompt(
    'Mobile API Setup — 4 of 6',
    'Enter this store\'s concept for home-dashboard branding:\n\n' +
    '  1 = Roll Play\n' +
    '  2 = Teas\'n You\n\n' +
    'Leave blank to skip (dashboard stays the default navy).',
    ui.ButtonSet.OK_CANCEL);
  if (conceptResp.getSelectedButton() !== ui.Button.OK) return;
  const conceptInput = conceptResp.getResponseText().trim();
  const concept = conceptInput === '1' ? 'roll-play'
                : conceptInput === '2' ? 'teasnyou'
                : '';
  if (conceptInput && !concept) { ui.alert('Enter 1, 2, or leave blank.'); return; }

  const gmResp = ui.prompt(
    'Mobile API Setup — 5 of 6',
    'Enter the GM email — seeded as the first locked recipient on the daily order email list.\n\n' +
    'You can add more recipients later via the app (Settings → Recipients) or directly in SETUP columns AB-AE.\n\n' +
    'Leave blank to skip.',
    ui.ButtonSet.OK_CANCEL);
  if (gmResp.getSelectedButton() !== ui.Button.OK) return;
  const gmEmail = gmResp.getResponseText().trim();

  const masterResp = ui.prompt(
    'Mobile API Setup — 6 of 6',
    'Optional: enter the multi-unit manager master PIN (4–8 digits).\n\n' +
    'Managers who know this code can access this location through the\n' +
    'hub in "manager mode" without typing the store PIN.\n\n' +
    'Leave blank to skip — only this location\'s store PIN will work.',
    ui.ButtonSet.OK_CANCEL);
  if (masterResp.getSelectedButton() !== ui.Button.OK) return;
  const masterPin = masterResp.getResponseText().trim();
  if (masterPin && !/^\d{4,8}$/.test(masterPin)) {
    ui.alert('Master PIN must be 4–8 digits, or blank.'); return;
  }

  props.setProperty(PROP_PIN, pin);
  props.setProperty(PROP_LOCATION, location);
  props.setProperty(PROP_LOCATION_ABBR, abbr);
  props.setProperty(PROP_GM_EMAIL, gmEmail);
  if (concept) props.setProperty(PROP_CONCEPT, concept);
  else         props.deleteProperty(PROP_CONCEPT);
  if (masterPin) props.setProperty(PROP_MASTER_PIN, masterPin);
  else           props.deleteProperty(PROP_MASTER_PIN);

  ui.alert(
    'Setup complete',
    'PIN:          ' + pin + '\n' +
    'Master PIN:   ' + (masterPin ? '****' + masterPin.slice(-1) : '(none)') + '\n' +
    'Location:     ' + location + ' (' + abbr + ')\n' +
    'Concept:      ' + (concept || '(none — default navy)') + '\n' +
    'GM email:     ' + (gmEmail || '(none)') + '\n\n' +
    'NEXT STEPS:\n' +
    '1. Add vendor cutoff times via Ordering Guide menu →\n' +
    '   Manage Vendors (Add tab or View All inline editor).\n' +
    '2. Deploy:\n' +
    '   • First deploy:  Deploy → New deployment ("Web app",\n' +
    '                    Execute as: Me, Who has access: Anyone).\n' +
    '   • Re-deploys:    Deploy → Manage deployments → edit ✏️ →\n' +
    '                    Version: New version. This keeps the URL\n' +
    '                    stable so KMs\' offline drafts and caches\n' +
    '                    keep working.\n' +
    '3. Copy the deployment URL into the mobile app config\n' +
    '   (stores.json + run build.py).\n' +
    '4. Test: visit the URL in a browser — should return JSON.\n\n' +
    'EMAIL RECIPIENTS:\n' +
    'The GM email above is seeded as a locked recipient on first run.\n' +
    'Add more recipients via Settings → Recipients in the app, or by\n' +
    'editing SETUP columns AB-AE directly. GM rows (column AE = TRUE)\n' +
    'are read-only from the app and can only be changed in the sheet.\n\n' +
    'TO UPDATE INDIVIDUAL FIELDS LATER:\n' +
    '• GM email →   Ordering Guide → Mobile API → Set GM Email\n' +
    '• Master PIN → Ordering Guide → Mobile API → Set Master PIN\n' +
    '• Concept →    Ordering Guide → Mobile API → Set Store Concept\n' +
    '• Full re-run → Ordering Guide → Mobile API → Setup',
    ui.ButtonSet.OK
  );
}


function setMasterPin() {
  // Set or rotate the multi-unit manager master PIN without re-running
  // the full setup wizard. Master PIN is OPTIONAL — clearing it (entering
  // blank) leaves only the location's store PIN active.
  const ui = SpreadsheetApp.getUi();
  const props = PropertiesService.getScriptProperties();
  const current = props.getProperty(PROP_MASTER_PIN);

  const resp = ui.prompt(
    'Set Master PIN',
    'Enter the multi-unit manager master PIN (4–8 digits).\n\n' +
    'Current: ' + (current ? '****' + current.slice(-1) : '(none)') + '\n\n' +
    'This code lets managers access this location through the hub\n' +
    'in "manager mode" without the location\'s store PIN.\n\n' +
    'Leave blank to remove the master PIN.',
    ui.ButtonSet.OK_CANCEL);
  if (resp.getSelectedButton() !== ui.Button.OK) return;
  const masterPin = resp.getResponseText().trim();
  if (masterPin && !/^\d{4,8}$/.test(masterPin)) {
    ui.alert('Master PIN must be 4–8 digits, or blank.'); return;
  }
  if (masterPin) {
    props.setProperty(PROP_MASTER_PIN, masterPin);
    ui.alert('Master PIN set: ****' + masterPin.slice(-1));
  } else {
    props.deleteProperty(PROP_MASTER_PIN);
    ui.alert('Master PIN removed.');
  }
}


function setStoreConcept() {
  // Set or clear this store's concept for home-dashboard branding without
  // re-running the full setup wizard. The dashboard reads PROP_CONCEPT on
  // rebuild (buildHomeDashboard → dashTheme_); unset → default navy palette.
  const ui = SpreadsheetApp.getUi();
  const props = PropertiesService.getScriptProperties();
  const current = props.getProperty(PROP_CONCEPT) || '(none — default navy)';

  const resp = ui.prompt(
    'Set Store Concept',
    'Current: ' + current + '\n\n' +
    'Enter this store\'s concept for home-dashboard branding:\n\n' +
    '  1 = Roll Play\n' +
    '  2 = Teas\'n You\n\n' +
    'Leave blank to clear (dashboard reverts to the default navy).',
    ui.ButtonSet.OK_CANCEL);
  if (resp.getSelectedButton() !== ui.Button.OK) return;
  const input = resp.getResponseText().trim();
  const concept = input === '1' ? 'roll-play'
                : input === '2' ? 'teasnyou'
                : '';
  if (input && !concept) { ui.alert('Enter 1, 2, or leave blank.'); return; }

  if (concept) props.setProperty(PROP_CONCEPT, concept);
  else         props.deleteProperty(PROP_CONCEPT);
  ui.alert(
    'Store concept ' + (concept ? 'set to "' + concept + '"' : 'cleared') + '.\n\n' +
    'Run Ordering Guide → 🏠 Rebuild Home Dashboard to apply the branding.');
}


function setGmEmail() {
  // Set or update the GM email. Maintains both:
  //   1. PROP_GM_EMAIL (legacy property — kept for any code that still reads it)
  //   2. The locked GM row in SETUP recipients (column AE = TRUE)
  //
  // Behavior:
  //   - Empty input + no existing GM row    → no-op
  //   - Empty input + existing GM row(s)    → remove all GM-flagged rows
  //   - Non-empty input + no existing GM row → add new GM row (Active=TRUE)
  //   - Non-empty input + existing GM row(s) → replace the first GM row's
  //     email; preserve name and active state. Other GM rows untouched.
  //
  // GM rows are visible-but-locked from the PWA, so this admin entry
  // point is the supported way to rotate the GM email without editing
  // SETUP directly.
  const ui = SpreadsheetApp.getUi();
  const props = PropertiesService.getScriptProperties();
  const current = props.getProperty(PROP_GM_EMAIL);

  const resp = ui.prompt(
    'Set GM Email',
    'Enter the GM email — locked recipient on the daily order email list.\n\n' +
    'Current: ' + (current || '(none)') + '\n\n' +
    'Leave blank to remove the GM recipient row entirely.',
    ui.ButtonSet.OK_CANCEL);
  if (resp.getSelectedButton() !== ui.Button.OK) return;
  const gmEmail = resp.getResponseText().trim();

  // Shape check only — we look for an @ with non-empty local and
  // domain halves and at least one dot in the domain. Google rejects
  // truly malformed addresses at send time anyway, so we don't bother
  // with full RFC validation here.
  if (gmEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(gmEmail)) {
    ui.alert('Email must contain @ and a domain, or be blank.'); return;
  }

  // Ensure header row exists before reading/writing the recipients block.
  ensureRecipientsHeader_();
  const recipients = readRecipients_();
  let gmIdx = recipients.findIndex(r => r.gm);

  if (!gmEmail) {
    // Clear path: drop the property and remove every GM row.
    props.deleteProperty(PROP_GM_EMAIL);
    const remaining = recipients.filter(r => !r.gm);
    writeRecipients_(remaining);
    ui.alert('GM email removed.');
    return;
  }

  // Set path: update property and the GM row in recipients.
  props.setProperty(PROP_GM_EMAIL, gmEmail);
  if (gmIdx < 0) {
    // No GM row exists yet — add one as a locked recipient.
    recipients.push({ name: 'GM', email: gmEmail, active: true, gm: true });
  } else {
    // Update the first GM row's email; preserve everything else.
    recipients[gmIdx] = {
      name:   recipients[gmIdx].name || 'GM',
      email:  gmEmail,
      active: recipients[gmIdx].active,
      gm:     true
    };
  }
  writeRecipients_(recipients);
  ui.alert('GM email set: ' + gmEmail);
}


function showMobileApiStatus() {
  const props = PropertiesService.getScriptProperties();
  const ui = SpreadsheetApp.getUi();
  // Read recipients count for the status dialog. Read errors fall back to
  // a question mark so a missing SETUP sheet doesn't break the status view.
  let recipientLine;
  try {
    ensureRecipientsHeader_();
    migrateGmEmailToRecipients_();
    const recs = readRecipients_();
    const active = recs.filter(r => r.active && r.email).length;
    const gms = recs.filter(r => r.gm).length;
    recipientLine = recs.length + ' total · ' + active + ' active · ' + gms + ' GM';
  } catch (e) {
    recipientLine = '(error reading: ' + (e.message || e) + ')';
  }
  ui.alert(
    'Mobile API Status',
    'Version:      ' + API_VERSION + '\n' +
    'Location:     ' + (props.getProperty(PROP_LOCATION) || '(not set)') + '\n' +
    'Abbreviation: ' + (props.getProperty(PROP_LOCATION_ABBR) || '(not set)') + '\n' +
    'PIN:          ' + (props.getProperty(PROP_PIN) ? '****' + props.getProperty(PROP_PIN).slice(-1) : '(not set)') + '\n' +
    'Master PIN:   ' + (props.getProperty(PROP_MASTER_PIN) ? '****' + props.getProperty(PROP_MASTER_PIN).slice(-1) : '(none)') + '\n' +
    'GM email:     ' + (props.getProperty(PROP_GM_EMAIL) || '(none)') + '\n' +
    'Recipients:   ' + recipientLine + '\n' +
    'Last sent:    ' + (props.getProperty(PROP_LAST_RECAP_SENT_DATE) || '(never)') + '\n\n' +
    'PIN failures: ' + (props.getProperty(PROP_PIN_FAIL_COUNT) || '0') + ' / ' + PIN_MAX_ATTEMPTS + '\n' +
    'Lockout:      ' + (function() {
      const until = parseInt(props.getProperty(PROP_PIN_LOCKOUT_UNTIL) || '0', 10);
      if (!until) return '(none)';
      const remaining = until - Date.now();
      if (remaining <= 0) return '(expired — clears on next request)';
      const mins = Math.ceil(remaining / 60000);
      return 'LOCKED for ~' + mins + ' more minute(s)';
    })() + '\n\n' +
    'Vendor meta entries: ' + Object.keys(VENDOR_META).length,
    ui.ButtonSet.OK
  );
}


function clearPinLockout() {
  // Manual unlock — for when a legitimate manager gets locked out and
  // can't wait 5 minutes, or when testing. Wired into the Mobile API
  // menu in Core.gs.
  const ui = SpreadsheetApp.getUi();
  const props = PropertiesService.getScriptProperties();
  const had = props.getProperty(PROP_PIN_FAIL_COUNT) ||
              props.getProperty(PROP_PIN_LOCKOUT_UNTIL);
  if (!had) {
    ui.alert('No lockout active. Failure counter is already clear.');
    return;
  }
  props.deleteProperty(PROP_PIN_FAIL_COUNT);
  props.deleteProperty(PROP_PIN_LOCKOUT_UNTIL);
  ui.alert('PIN lockout cleared. Next attempt starts a fresh counter.');
}


function clearMobileApiConfig() {
  const ui = SpreadsheetApp.getUi();
  const resp = ui.alert('Clear Mobile API Config',
    'This will remove the PIN, master PIN, location, abbreviation, GM email, and recap-sent state.\n\n' +
    'It will NOT clear the recipients block in SETUP — those rows remain (edit them in the sheet if needed).\n\n' +
    'Continue?',
    ui.ButtonSet.YES_NO);
  if (resp !== ui.Button.YES) return;
  const props = PropertiesService.getScriptProperties();
  props.deleteProperty(PROP_PIN);
  props.deleteProperty(PROP_MASTER_PIN);
  props.deleteProperty(PROP_LOCATION);
  props.deleteProperty(PROP_LOCATION_ABBR);
  props.deleteProperty(PROP_GM_EMAIL);
  props.deleteProperty(PROP_LAST_RECAP_SENT_DATE);
  // Also wipe the rate-limit state — fresh deployment should never
  // start with a stale lockout window from a previous tenant of the
  // script properties.
  props.deleteProperty(PROP_PIN_FAIL_COUNT);
  props.deleteProperty(PROP_PIN_LOCKOUT_UNTIL);
  ui.alert('Cleared. Run setupMobileApi() to reconfigure.');
}


/***********************
 * 6) TEST FUNCTIONS — run these from the script editor to verify the API
 *
 * To use:
 *   1. Pick a test function from the dropdown at the top of the editor
 *   2. Click Run
 *   3. View the output: View → Logs (or Cmd/Ctrl+Enter)
 *
 * These call the action handlers directly (not through doPost), which lets
 * you test logic without dealing with HTTP, PINs, or curl.
 ***********************/

function test_ping() {
  const result = api_ping_();
  Logger.log('--- test_ping ---');
  Logger.log(JSON.stringify(result, null, 2));
}


function test_getDashboard() {
  Logger.log('--- test_getDashboard ---');
  try {
    const result = api_getDashboard_();
    Logger.log('Date: ' + result.date + ' (' + result.dayOfWeek + ')');
    Logger.log('Location: ' + result.location);
    Logger.log('Vendors today: ' + result.vendors.length);
    Logger.log('');
    for (const v of result.vendors) {
      Logger.log(
        '  ' + v.name +
        ' — ' + v.itemCount + ' items' +
        ' — cutoff: ' + (v.cutoffTime || 'none') +
        ' — status: ' + v.status +
        (v.toOrderCount != null ? ' (' + v.toOrderCount + ' to order)' : '') +
        (v.sentAt ? ' at ' + v.sentAt : '')
      );
    }
    Logger.log('');
    Logger.log('Full JSON:');
    Logger.log(JSON.stringify(result, null, 2));
  } catch (err) {
    Logger.log('ERROR: ' + (err.stack || err));
  }
}


function test_getVendorItems() {
  // Edit this to a real vendor name from your sheet
  const TEST_VENDOR = 'Sysco';

  Logger.log('--- test_getVendorItems for "' + TEST_VENDOR + '" ---');
  try {
    const result = api_getVendorItems_({ vendor: TEST_VENDOR });
    Logger.log('Vendor: ' + result.vendor);
    Logger.log('Cutoff: ' + (result.cutoffTime || 'none'));
    Logger.log('Items: ' + result.items.length);
    Logger.log('');
    for (const it of result.items) {
      Logger.log(
        '  [' + it.storageArea + '] ' + it.name +
        ' (' + it.pack + ') — par ' + it.par +
        ' — on hand: ' + (it.onHand === null ? 'blank' : it.onHand) +
        ' — suggested: ' + (it.suggestedQty === null ? '—' : it.suggestedQty)
      );
    }
  } catch (err) {
    Logger.log('ERROR: ' + (err.stack || err));
  }
}


function test_doPostFlow() {
  // Simulates an actual HTTP POST end-to-end, including PIN check.
  // Useful to confirm the dispatch + auth layer works before testing from
  // the mobile app.
  Logger.log('--- test_doPostFlow ---');

  const pin = PropertiesService.getScriptProperties().getProperty(PROP_PIN);
  if (!pin) {
    Logger.log('No PIN set. Run setupMobileApi() first.');
    return;
  }

  // Test ping
  const fakeEvent1 = {
    postData: { contents: JSON.stringify({ pin: pin, action: 'ping' }) }
  };
  const resp1 = doPost(fakeEvent1);
  Logger.log('ping response: ' + resp1.getContent());

  // Test wrong PIN
  const fakeEvent2 = {
    postData: { contents: JSON.stringify({ pin: '0000', action: 'ping' }) }
  };
  const resp2 = doPost(fakeEvent2);
  Logger.log('bad PIN response: ' + resp2.getContent());

  // Test getDashboard
  const fakeEvent3 = {
    postData: { contents: JSON.stringify({ pin: pin, action: 'getDashboard' }) }
  };
  const resp3 = doPost(fakeEvent3);
  Logger.log('getDashboard response (first 500 chars): ' + resp3.getContent().substring(0, 500));
}



function test_getResetStatus() {
  Logger.log('--- test_getResetStatus ---');
  try {
    const r = api_getResetStatus_();
    Logger.log('today:      ' + r.today);
    Logger.log('lastReset:  ' + (r.lastReset || '(never)'));
    Logger.log('isStale:    ' + r.isStale);
  } catch (err) {
    Logger.log('ERROR: ' + (err.stack || err));
  }
}


function test_commitReset() {
  // ⚠ DESTRUCTIVE on a fresh state — this runs the same logic as the
  // "Reset On Hand" button on the spreadsheet. Snapshots current On Hand
  // values to LOG_ORDERS (if not already logged for today), clears all
  // On Hand columns, and stamps AE9 with today's date.
  //
  // Safe to run on the test sheet copy. Do not run on production data
  // unless you actually want to perform a reset.
  Logger.log('--- test_commitReset ---');
  try {
    const r = api_commitReset_();
    Logger.log('logged:        ' + r.logged);
    Logger.log('rowsLogged:    ' + r.rowsLogged);
    Logger.log('orderDate:     ' + r.orderDate);
    Logger.log('resetDate:     ' + r.resetDate);
    if (r.skippedReason) Logger.log('skippedReason: ' + r.skippedReason);
  } catch (err) {
    Logger.log('ERROR: ' + (err.stack || err));
  }
}


function test_emailRecap() {
  // ⚠ This actually sends an email — to every active recipient configured
  // in SETUP AB-AE. Make sure the recipients list is set up before running.
  // Doesn't write to LOG_ORDERS — recap is read-only / send-only.
  //
  // Passes force=true so this test path always sends, even if today's
  // cycle was already emailed via another path.
  Logger.log('--- test_emailRecap ---');
  try {
    const r = api_emailRecap_({ force: true });
    Logger.log('cycleDate:   ' + r.cycleDate);
    Logger.log('sentCount:   ' + r.sentCount);
    Logger.log('failedCount: ' + r.failedCount);
    Logger.log('vendorCount: ' + r.vendorCount);
    Logger.log('itemCount:   ' + r.itemCount);
    for (const v of r.vendors) {
      Logger.log('  ' + v.vendor + ' — ' + v.itemCount + ' items');
    }
    if (r.failedCount) {
      Logger.log('FAILURES:');
      for (const f of r.failed) {
        Logger.log('  ' + f.email + ' — ' + f.error);
      }
    }
  } catch (err) {
    Logger.log('ERROR: ' + (err.stack || err));
  }
}


function test_getRecipients() {
  // Read-only verification of the recipients list. Useful for confirming
  // the AB-AE layout is intact and the GM seed migration ran correctly.
  Logger.log('--- test_getRecipients ---');
  try {
    const r = api_getRecipients_();
    Logger.log('count: ' + r.recipients.length);
    for (const rec of r.recipients) {
      Logger.log('  ' + (rec.gm ? '[GM] ' : '     ') +
                 (rec.active ? '✓ ' : '  ') +
                 rec.name + ' <' + rec.email + '>');
    }
  } catch (err) {
    Logger.log('ERROR: ' + (err.stack || err));
  }
}