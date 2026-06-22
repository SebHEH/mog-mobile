/************************************************************
 * MASTER ORDERING GUIDE - Apps Script
 ************************************************************/








/***********************
 * 1) GLOBAL CONSTANTS
 ***********************/
const SHEET_MASTER      = "MASTER_ITEMS";
const SHEET_SETUP       = "SETUP";
const SHEET_ORDER_ENTRY = "ORDER_ENTRY";




const EMERGENCY_OVERRIDE_CELL          = "AD2";
const EMERGENCY_OVERRIDE_LASTDATE_PROP = "LAST_OVERRIDE_DATE";




const COL = {
  ID:       1,  // A
  NAME:     2,  // B
  VENDOR:   3,  // C  - the ACTIVE vendor (drives this item's vendor tab + order math)
  SKU:      4,  // D  - legacy Vendor SKU; unused day-to-day but still XLOOKUP'd by
                //      each vendor tab's (hidden) SKU display column, so left in place
  PACK:     5,  // E
  CATEGORY: 6,  // F
  PAR:      7,  // G
  ACTIVE:   12, // L
  USE_MULT: 13, // M
  NOTES:    14, // N
  ELIGIBLE_VENDORS: 15 // O - pipe-delimited list of vendors this item may be ordered
                       //      from; always includes the active vendor (C). New column,
                       //      referenced by no in-sheet formula. See normalizeEligibleList_.
};

// Delimiter for the Eligible Vendors list stored in MASTER_ITEMS column O.
// Pipe (not comma) so vendor names containing commas survive a round-trip.
const ELIGIBLE_VENDOR_DELIM = "|";




const SETUP_VENDOR_CELL    = "B2";
const SETUP_LIST_START_ROW = 21;




const AREA_TABLE = {
  COL_AREA:  8,  // H
  COL_ORDER: 9,  // I
  START_ROW: 2,
  END_ROW:   19
};




const PICKDB = {
  START_ROW: 2,
  START_COL: 11, // K
  NUM_COLS:  6   // K:P -> Vendor, ItemID, ItemName, Area, AreaOrder, ShelfOrder
};




// VENDOR_TABLE: R = vendor name dropdown (reads from Z automatically).
// S:Y (cols 19-25) = Mon-Sun multipliers. Script writes to S:Y only.
const VENDOR_TABLE = {
  SHEET:      SHEET_SETUP,
  START_ROW:  2,
  VENDOR_COL: 18, // R - dropdown fed by SETUP!Z2:Z, do not write here
  MULT_COL:   19  // S - first multiplier column (S:Y = Mon-Sun)
};




// Vendor name list column - SETUP column Z (26), rows 2+.
// R column validation rule: Dropdown from range -> SETUP!Z2:Z
// Script maintains this column; never write vendor names directly to R.
const VENDOR_LIST_COL = 26; // Z


// Vendor cutoff time column - SETUP column AA (27), rows 2+.
//
// Stored as a string "HH:MM" in 24-hour format, or empty for vendors
// with no cutoff (e.g. walk-in pickup, restaurant depot). Written by
// the ManageVendors sidebar (Add tab and View All inline editor) and
// read by the MOG mobile API to drive the dashboard's
// approaching-cutoff and missed-cutoff visual states.
//
// Lives in column AA — the next free column after the vendor list (Z)
// and the multiplier columns (S:Y) — so it parallels the existing
// vendor data structure without disturbing any existing layout. The
// column is purely script-managed; users edit cutoffs through the
// sidebar, not by typing in AA directly.
const VENDOR_CUTOFF_COL = 27; // AA




const VENDOR_TAB = {
  ON_HAND_COL:    5, // E
  DATA_START_ROW: 3
};




// Order log sheet name and column positions
const SHEET_ORDER_LOG = "LOG_ORDERS";
const LOG_COL = {
  TIMESTAMP:   1, // A
  ORDER_DATE:  2, // B
  VENDOR:      3, // C
  ITEM_ID:     4, // D
  ITEM_NAME:   5, // E
  ON_HAND_PRV: 6, // F
  QTY_ORDERED: 7  // G
};




// =========================================================================
// HOME DASHBOARD — cell registry
// =========================================================================
// Single source of truth for the HOME dashboard's interactive cells.
// buildHomeDashboard() writes the layout against these addresses, and
// onEdit reads them to dispatch checkbox-driven actions. To move a cell:
// update DASH only — the build function and edit handler will follow.
const DASH = {
  // Hidden data column (col AE = 31). Holds backing values + filter spill.
  HIDDEN_COL:          31,
  DATE_FORMULA:        "AE2",     // =TODAY() — today's calendar date
  ORDER_DAY:           "AE3",     // =TEXT(IF(AE9="",AE2,AE9),"ddd") — day-of-week of the active cycle
  RESET_DATE:          "AE9",     // written by resetOnHandAllVendors

  // Visible interactive cells. Static positions:
  EMERGENCY_OVERRIDE:  "AD2",     // checkbox in date strip
  RESET_CHECKBOX:      "O5",      // step-1 confirm checkbox

  // Quick action (Manage section) checkboxes — column letters are static,
  // ROW is computed at build time based on how many vendor tile rows are
  // needed. Dashboard stores the resolved row in DocumentProperties under
  // MANAGE_ROW_PROP so onEdit can dispatch correctly.
  //
  // Each entry: column letter + sidebar function name to invoke when the
  // checkbox in that column ticks TRUE.
  QUICK_ACTION_COLUMNS: [
    { col: "A", fn: "showManageItemsSidebar"     },
    { col: "F", fn: "showManageVendorsSidebar"   },
    { col: "K", fn: "showReorderPickPathSidebar" },
    { col: "P", fn: "showStorageAreasSidebar"    },
    { col: "U", fn: "showOrderHistoryModal"      },
    { col: "Z", fn: "showHowToUseSidebar"        }
  ],
  MANAGE_ROW_PROP:     "DASH_MANAGE_ROW",   // DocumentProperties key
  MANAGE_ROW_DEFAULT:  15,                  // fallback if prop unset

  // FILTER spill anchor for the vendor list. Placed well below the reset
  // date cell (AE9) and other hidden data so the spill never overwrites
  // them. Tiles compute source cells as AE100, AE101, ... linearly.
  VENDOR_FILTER_START: "AE100"
};


// Cell addresses below are pinned to the DASH registry so onEdit, the
// reset routine, and the override-clear-on-open all stay in sync.
const ORDER_ENTRY_DATE_CELL   = DASH.DATE_FORMULA;       // hidden, =TODAY()
const LAST_RESET_DATE_CELL    = DASH.RESET_DATE;         // hidden, written by reset
// EMERGENCY_OVERRIDE_CELL is declared above near the override-clear logic.








/***********************
 * 2) GENERIC HELPERS
 ***********************/
// Per-execution memoization of sheet handles. Apps Script V8 resets
// globals between invocations (doPost, sidebar callbacks, menu triggers
// each run in a fresh script context), so this Map naturally clears at
// the start of every request — no cross-execution pollution risk.
// Within one invocation, getSheet_(SHEET_SETUP) is often called 3-5
// times from independent helpers (e.g. api_getDashboard_compute_ chains
// readVendorMultipliers_, readVendorCutoffs_, getVendorList — each
// historically did its own getSheetByName). Memoizing here saves the
// repeated lookup without any callsite changes.
const _SHEET_CACHE_ = new Map();

function getSheet_(name) {
  let sh = _SHEET_CACHE_.get(name);
  if (sh) return sh;
  sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(name);
  if (!sh) throw new Error("Sheet not found: " + name);
  _SHEET_CACHE_.set(name, sh);
  return sh;
}




// ── Server-side mutation timestamp ───────────────────────────────────────
// Stored in DocumentProperties and read by getManageItemsBootstrap to key
// its CacheService entries. Every commit* function bumps this so the
// cache key naturally changes on the next read -> miss -> recompute. The
// old cache entry orphans on its own 5-minute TTL.
//
// Note: this is the SERVER-SIDE twin of the client-side localStorage
// 'mog_lastMutationTs' bump. They are independent: client bump
// invalidates the localStorage modal cache, server bump invalidates the
// CacheService bootstrap cache. Both need to fire on each mutation.
const SERVER_MUT_TS_KEY = 'mog_serverMutationTs';

function getServerMutationTs_() {
  try {
    return PropertiesService.getDocumentProperties().getProperty(SERVER_MUT_TS_KEY) || '0';
  } catch (e) {
    return '0';
  }
}

function bumpServerMutationTs_() {
  try {
    PropertiesService.getDocumentProperties()
      .setProperty(SERVER_MUT_TS_KEY, String(Date.now()));
  } catch (e) {
    // Non-fatal: PropertiesService rate-limited or down. The cache will
    // still self-invalidate via TTL within 5 minutes.
  }
}




// =========================================================================
// ORDER-CYCLE DATE — single source of truth for the AE2/AE9 logic
// =========================================================================
// The HOME dashboard keeps two hidden dates in ORDER_ENTRY:
//   AE2 (DATE_FORMULA) = =TODAY()        — today's calendar date
//   AE9 (RESET_DATE)   = last reset date — the cycle currently being worked
// Both helpers below are the ONLY place that logic should live. Callers in
// MOGApi.gs (api_getResetStatus_, getActiveOrderDate_ consumers) and the
// reset/log path (dailyResetOnOpen_, getLogOrderDate_) all route through them.
// Timezone is the spreadsheet's (every HEH store is US/Eastern), matching the
// frame of reference of the AE2 =TODAY() formula itself.

function getActiveOrderDate_() {
  // The cycle date the system treats as "the order being worked on":
  // AE9 (last reset) if set, else AE2 (=TODAY()), else now. After a reset
  // AE9 = today; before one it's the previous reset date, which is what every
  // multiplier and snapshot stays locked to until reset runs.
  // Returns { date, dateStr (yyyy-MM-dd), dayOfWeek (EEE) }.
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const oe = ss.getSheetByName(SHEET_ORDER_ENTRY);
  const tz = ss.getSpreadsheetTimeZone();
  let d = oe ? oe.getRange(LAST_RESET_DATE_CELL).getValue() : null;   // AE9
  if (!(d instanceof Date) || isNaN(d.getTime())) {
    d = oe ? oe.getRange(ORDER_ENTRY_DATE_CELL).getValue() : null;    // AE2
  }
  if (!(d instanceof Date) || isNaN(d.getTime())) {
    d = new Date();
  }
  return {
    date:      d,
    dateStr:   Utilities.formatDate(d, tz, 'yyyy-MM-dd'),
    dayOfWeek: Utilities.formatDate(d, tz, 'EEE')
  };
}

function getResetStaleness_() {
  // New-day detection: does the current cycle need a reset?
  // Stale = AE9 (last reset) is blank/invalid, or strictly before AE2 (today).
  // Returns { today (yyyy-MM-dd), lastReset (yyyy-MM-dd|null), isStale }.
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const oe = ss.getSheetByName(SHEET_ORDER_ENTRY);
  const tz = ss.getSpreadsheetTimeZone();

  const todayRaw = oe ? oe.getRange(ORDER_ENTRY_DATE_CELL).getValue() : null;  // AE2
  const resetRaw = oe ? oe.getRange(LAST_RESET_DATE_CELL).getValue() : null;   // AE9

  const todayStr = (todayRaw instanceof Date && !isNaN(todayRaw.getTime()))
    ? Utilities.formatDate(todayRaw, tz, 'yyyy-MM-dd')
    : Utilities.formatDate(new Date(), tz, 'yyyy-MM-dd');

  let lastResetStr = null;
  let isStale = true;
  if (resetRaw instanceof Date && !isNaN(resetRaw.getTime())) {
    lastResetStr = Utilities.formatDate(resetRaw, tz, 'yyyy-MM-dd');
    isStale = (lastResetStr < todayStr);
  }

  return { today: todayStr, lastReset: lastResetStr, isStale: isStale };
}




// --- Cell formula on every vendor tab (I1:K1): =UPPER(TABNAME())&" ORDER" ----
function TABNAME() {
  return SpreadsheetApp.getActiveSheet().getName();
}




// --- Cell formula in ORDER_ENTRY B6+: ----------------------------------------
//   =IF(A6="","",IF(SHEETGID(A6)="",A6,HYPERLINK("#gid="&SHEETGID(A6),A6)))
function SHEETGID(sheetName) {
  const name = String(sheetName || "").trim();
  if (!name) return "";
  const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(name);
  return sh ? sh.getSheetId() : "";
}




// --- "<- Back to Orders" button on every vendor tab ---------------------------
function goToOrderEntry() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sh = ss.getSheetByName(SHEET_ORDER_ENTRY);
  if (sh) ss.setActiveSheet(sh);
}




function applyCheckboxValidation_(range) {
  range.setDataValidation(
    SpreadsheetApp.newDataValidation()
      .requireCheckbox()
      .setAllowInvalid(false)
      .build()
  );
}




function isVendorOnHandClear_(vendorName) {
  const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(vendorName);
  if (!sh) return true;
  const lr = sh.getLastRow();
  if (lr < VENDOR_TAB.DATA_START_ROW) return true;
  return sh
    .getRange(VENDOR_TAB.DATA_START_ROW, VENDOR_TAB.ON_HAND_COL, lr - VENDOR_TAB.DATA_START_ROW + 1, 1)
    .getValues()
    .flat()
    .every(v => v === "" || v === null || v === undefined);
}








/***********************
 * 3) MENUS & TRIGGERS
 ***********************/
function resetEmergencyOverrideOnOpen_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sh = ss.getSheetByName(SHEET_ORDER_ENTRY);
  if (!sh) return;
  const overrideRange = sh.getRange(EMERGENCY_OVERRIDE_CELL);
  if (overrideRange.getValue() !== true) return;
  const props = PropertiesService.getDocumentProperties();
  const today = Utilities.formatDate(new Date(), ss.getSpreadsheetTimeZone(), "yyyy-MM-dd");
  if (props.getProperty(EMERGENCY_OVERRIDE_LASTDATE_PROP) !== today) {
    overrideRange.setValue(false);
    props.setProperty(EMERGENCY_OVERRIDE_LASTDATE_PROP, today);
  }
}








function onOpen(e) {
  resetEmergencyOverrideOnOpen_();




  SpreadsheetApp.getUi()
    .createMenu("Ordering Guide")




    .addItem("    How To Use This Guide",              "showHowToUseSidebar")
    .addSeparator()




    .addItem("    Manage Storage Areas",               "showStorageAreasSidebar")
    .addItem("    Manage Vendors",                     "showManageVendorsSidebar")
    .addItem("    Manage Items",                       "showManageItemsSidebar")
    .addItem("    Shelf to Sheet",                     "showReorderPickPathSidebar")
    .addItem("    View Order History",                 "showOrderHistoryModal")
    .addSeparator()
    .addItem("    🏠 Rebuild Home Dashboard",          "buildHomeDashboard")
    .addSeparator()
    // Mobile API admin — grouped under a submenu so KMs don't see
    // these in the main menu. Managers reach them via Ordering Guide
    // → Mobile API. setupMobileApi runs the full 5-step wizard;
    // the field-specific setters update one property in isolation.
    .addSubMenu(SpreadsheetApp.getUi().createMenu("    📱 Mobile API")
      .addItem("    Setup / Re-run Setup",   "setupMobileApi")
      .addItem("    Set GM Email",           "setGmEmail")
      .addItem("    Set Master PIN",         "setMasterPin")
      .addItem("    Set Store Concept",      "setStoreConcept")
      .addItem("    Status",                 "showMobileApiStatus")
      .addItem("    Clear PIN Lockout",      "clearPinLockout")
      .addSeparator()
      // Decluttered 2026-06-01: removed spent one-time/diagnostic entries —
      // Migrate Item Vendors (backfill, run everywhere), Audit Vendor Tab
      // Structure + Re-establish Vendor Template (diagnostics from the resolved
      // #4 vendor-template work). The functions remain in the bound-script
      // files (Items.gs / Vendors.gs) and are still runnable from the Apps
      // Script editor if ever needed.
      .addItem("    Recalibrate Vendor Pars","showRecalibrateVendorSidebar")
      .addItem("    Audit Vendor Cadence",   "showVendorCadenceAuditSidebar")
      .addItem("    Sync Vendor Multiplier Formulas","syncVendorMultiplierFormulasMenu_")
      .addItem("    Clear Config",           "clearMobileApiConfig"))
    .addToUi();
}






// Simple onEdit trigger — handles SETUP edits only.
// ORDER_ENTRY dashboard checkboxes need to open sidebars/dialogs, which
// SIMPLE onEdit triggers cannot do (no UI authorization). Those are handled
// by an INSTALLABLE trigger (dashboardOnEdit_) installed by ensureDashboardEditTrigger_.
function onEdit(e) {
  try {
    if (!e || !e.range) return;
    const sh   = e.range.getSheet();
    const name = sh.getName();

    if (name === SHEET_SETUP) {
      handleSetupEdit_(e);
      return;
    }
  } catch (err) {
    console.error('onEdit:', err);
  }
}




// Installable onEdit trigger — handles ORDER_ENTRY dashboard checkboxes.
// Runs with full user authorization, so it can call showSidebar() etc.
// Installed once via ensureDashboardEditTrigger_().
function dashboardOnEdit_(e) {
  try {
    if (!e || !e.range) return;
    const sh = e.range.getSheet();
    if (sh.getName() !== SHEET_ORDER_ENTRY) return;
    handleDashboardEdit_(e);
  } catch (err) {
    console.error('dashboardOnEdit_:', err);
  }
}




// Idempotent installer for the dashboard onEdit trigger. Creating the
// trigger requires user authorization — the first call after script
// install will surface a permission prompt. Subsequent calls find the
// trigger and no-op.
function ensureDashboardEditTrigger_() {
  const handlerName = 'dashboardOnEdit_';
  const existing = ScriptApp.getProjectTriggers().some(t =>
    t.getHandlerFunction() === handlerName &&
    t.getEventType() === ScriptApp.EventType.ON_EDIT
  );
  if (existing) return { created: false };

  ScriptApp.newTrigger(handlerName)
    .forSpreadsheet(SpreadsheetApp.getActive())
    .onEdit()
    .create();
  return { created: true };
}




// Installable open trigger — auto-runs the daily reset the first time the
// Sheet is opened on a new day. Mirrors the PWA's new-day auto-reset so a
// manager who opens the Sheet directly (without touching the PWA) still
// finalizes the cycle: logs the order, emails the recap, clears On Hand.
//
// Must be INSTALLABLE, not the simple onOpen: a simple trigger can't send
// email (MailApp needs authorization a simple trigger doesn't have). The
// installable trigger runs as whoever installed it, so the recap email
// sends under that account — which is exactly what authorizes MailApp.
//
// Idempotent: gated on AE9 (last reset) < today, so only the first open of
// the day does work; every later open in the same cycle is a two-cell read
// and return. Never throws — an open-trigger error must not block the Sheet.
function dailyResetOnOpen_() {
  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const oe = ss.getSheetByName(SHEET_ORDER_ENTRY);
    if (!oe) return;
    const tz = ss.getSpreadsheetTimeZone();

    // New-day detection lives in getResetStaleness_ (Core). Stale = never
    // reset, or last reset is before today. If already reset today, this
    // cycle is finalized — no-op.
    if (!getResetStaleness_().isStale) return;

    // Visible, non-blocking feedback — the Sheet equivalent of the PWA's
    // "Detected new day" overlay. toast() never blocks the open.
    ss.toast('Detected new day — resetting On Hand…', 'Daily reset', 5);

    // Log the prior cycle to Order History, email the recap (deduped via
    // MOG_LAST_RECAP_SENT_DATE), then clear On Hand on every vendor tab.
    const result = commitLogAndReset();

    // Advance the cycle: stamp AE9 so this won't re-fire today and the
    // PWA's getResetStatus stops reporting stale. Mirror the manual sheet
    // reset by also clearing the emergency override if it's on.
    const today = new Date();
    oe.getRange(LAST_RESET_DATE_CELL).setValue(today);
    const overrideRange = oe.getRange(EMERGENCY_OVERRIDE_CELL);
    if (overrideRange.getValue() === true) {
      overrideRange.setValue(false);
      PropertiesService.getDocumentProperties()
        .setProperty(EMERGENCY_OVERRIDE_LASTDATE_PROP,
                     Utilities.formatDate(today, tz, 'yyyy-MM-dd'));
    }

    const logged = result && result.logged
      ? (result.rowsLogged + ' item(s) logged. ')
      : '';
    ss.toast(logged + 'On Hand reset for the new day.', 'Daily reset', 6);
  } catch (err) {
    // An open-trigger error must never surface to the user or stop the
    // Sheet from opening. Log for triage and move on.
    Logger.log('dailyResetOnOpen_ error: ' + (err.stack || err));
  }
}




// Idempotent installer for the daily-reset open trigger. Creating the
// trigger requires user authorization — the first call surfaces a
// permission prompt. Subsequent calls find the existing trigger and no-op.
// Installed alongside the dashboard edit trigger from buildHomeDashboard.
function ensureDailyResetTrigger_() {
  const handlerName = 'dailyResetOnOpen_';
  const existing = ScriptApp.getProjectTriggers().some(t =>
    t.getHandlerFunction() === handlerName &&
    t.getEventType() === ScriptApp.EventType.ON_OPEN
  );
  if (existing) return { created: false };

  ScriptApp.newTrigger(handlerName)
    .forSpreadsheet(SpreadsheetApp.getActive())
    .onOpen()
    .create();
  return { created: true };
}




// Dispatch table for HOME dashboard quick-action checkboxes. Resolved at
// call time via the function name string so all references are robust to
// reordering of the file.
function getQuickActionDispatch_() {
  return {
    showManageItemsSidebar:     showManageItemsSidebar,
    showManageVendorsSidebar:   showManageVendorsSidebar,
    showReorderPickPathSidebar: showReorderPickPathSidebar,
    showStorageAreasSidebar:    showStorageAreasSidebar,
    showOrderHistoryModal:      showOrderHistoryModal,
    showHowToUseSidebar:        showHowToUseSidebar
  };
}




// Handles edits on the HOME dashboard (ORDER_ENTRY tab). Routes the seven
// dashboard checkboxes (6 quick actions + Reset On Hand) to their handlers
// and resets the checkbox after each. Other edits (e.g. Emergency Override
// toggle) flow through to formula recalc with no script action.
function handleDashboardEdit_(e) {
  const a1     = e.range.getA1Notation();
  const col    = e.range.getColumn();
  const row    = e.range.getRow();

  // Quick action checkboxes — open the matching sidebar. Row is dynamic
  // (depends on how many vendor tile rows the dashboard has). Match the
  // column letter against QUICK_ACTION_COLUMNS first, then verify row.
  const manageRow = getManageRow_();
  if (row === manageRow && e.value === "TRUE") {
    const colLetter = columnToLetter_(col);
    const quick     = DASH.QUICK_ACTION_COLUMNS.find(q => q.col === colLetter);
    if (quick) {
      e.range.setValue(false);  // reset first so a re-tap reopens cleanly
      const dispatch = getQuickActionDispatch_();
      const fn = dispatch[quick.fn];
      if (typeof fn === 'function') fn();
      return;
    }
  }

  // Reset On Hand checkbox — runs the existing reset flow (with its own
  // confirm dialog). Reset the checkbox first so cancellation leaves the
  // tile in its expected unchecked state.
  if (a1 === DASH.RESET_CHECKBOX && e.value === "TRUE") {
    e.range.setValue(false);
    resetOnHandAllVendors();
    return;
  }
}




// Resolves the current manage-section row from DocumentProperties, falling
// back to the static default if the property isn't set (i.e. the dashboard
// hasn't been built since this version of the code shipped).
function getManageRow_() {
  const stored = PropertiesService.getDocumentProperties().getProperty(DASH.MANAGE_ROW_PROP);
  const n      = parseInt(stored, 10);
  return isNaN(n) ? DASH.MANAGE_ROW_DEFAULT : n;
}




// Convert a 1-indexed column number to its A1 letter ("A", "B", …, "AA").
// Used by the dispatch handler to compare an edited cell's column against
// QUICK_ACTION_COLUMNS without parsing the A1 notation.
function columnToLetter_(col) {
  let s = "";
  while (col > 0) {
    const r = (col - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    col = Math.floor((col - 1) / 26);
  }
  return s;
}




function handleSetupEdit_(e) {
  const col = e.range.getColumn();
  const row = e.range.getRow();

  if (e.range.getA1Notation() === SETUP_VENDOR_CELL) {
    loadSetupVendorItems_();
    return;
  }

  // Storage area assigned to an item in the pick path list
  if (row >= SETUP_LIST_START_ROW && col === 2) {
    autoSavePickPathIfSafe_();
    return;
  }

  // Order number manually edited in H:I area table -> sort + renumber
  if (col === AREA_TABLE.COL_ORDER && row >= AREA_TABLE.START_ROW && row <= AREA_TABLE.END_ROW) {
    normalizeAreaOrder_();
  }
}




function normalizeAreaOrder_() {
  try {
    const setup = getSheet_(SHEET_SETUP);
    const { block } = readAreaBlock_(setup);
    const entries = block
      .map(r => ({ name: String(r[0] || "").trim(), order: Number(r[1]) }))
      .filter(x => x.name !== "" && Number.isFinite(x.order));
    if (!entries.length) return;
    entries.sort((a, b) => a.order - b.order);
    writeAreaList_(setup, entries);
    syncPickDbAreaOrders_(setup);
  } catch (err) { console.error('normalizeAreaOrder_:', err); }
}




function autoSavePickPathIfSafe_() {
  try {
    const setup  = getSheet_(SHEET_SETUP);
    const vendor = String(setup.getRange(SETUP_VENDOR_CELL).getDisplayValue()).trim();
    if (!vendor) return;
    if (!isVendorOnHandClear_(vendor)) return;
    savePickPathSilent_(vendor);
  } catch (err) { console.error('autoSavePickPathIfSafe_:', err); }
}








// Pulls a shared HTML partial (e.g. Styles.html) into a templated modal via
// <?!= include('Styles'); ?>. Single source of truth for the modal design tokens
// + universal chrome (lang toggle, [?] help overlay).
function include(name) {
  return HtmlService.createHtmlOutputFromFile(name).getContent();
}

// ── Modal sizing tiers ── keep modals visually consistent at two sizes.
// SMALL = forms / lists / audits;  LARGE = wide data tables (Items, Order
// History) + the How-To guide. Resize a whole tier by editing one pair here.
const MODAL_SM_W = 720, MODAL_SM_H = 680;
const MODAL_LG_W = 1400, MODAL_LG_H = 900;

function showHowToUseSidebar() {
  SpreadsheetApp.getUi().showModalDialog(
    HtmlService.createTemplateFromFile("HowToUse").evaluate()
      .setWidth(MODAL_LG_W)
      .setHeight(MODAL_LG_H),
    "Ordering Guide — How To Use"
  );
}




// ── A1 utility: convert "AD2" → "$AD$2" for absolute references ──────────
function toAbsoluteA1_(a1) {
  const m = String(a1).match(/^([A-Z]+)(\d+)$/);
  return m ? ('$' + m[1] + '$' + m[2]) : a1;
}