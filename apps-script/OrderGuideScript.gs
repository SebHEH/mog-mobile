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
    .addItem("    Manage Pick Path",                   "showReorderPickPathSidebar")
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
      // #4 vendor-template work). The functions remain in OrderGuideScript.gs
      // and are still runnable from the Apps Script editor if ever needed.
      .addItem("    Recalibrate Vendor Pars","showRecalibrateVendorSidebar")
      .addItem("    Audit Vendor Cadence",   "showVendorCadenceAuditSidebar")
      .addItem("    Sync Vendor Multiplier Formulas","syncVendorMultiplierFormulasMenu_")
      .addItem("    Clear Config",           "clearMobileApiConfig"))
    .addToUi();
}




function menuHeader_() {}




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

    const todayRaw = oe.getRange(ORDER_ENTRY_DATE_CELL).getValue();  // AE2 =TODAY()
    const resetRaw = oe.getRange(LAST_RESET_DATE_CELL).getValue();   // AE9 last reset

    const todayStr = (todayRaw instanceof Date && !isNaN(todayRaw.getTime()))
      ? Utilities.formatDate(todayRaw, tz, 'yyyy-MM-dd')
      : Utilities.formatDate(new Date(), tz, 'yyyy-MM-dd');

    let lastResetStr = null;
    if (resetRaw instanceof Date && !isNaN(resetRaw.getTime())) {
      lastResetStr = Utilities.formatDate(resetRaw, tz, 'yyyy-MM-dd');
    }

    // Stale = never reset, or last reset is before today. If it's already
    // been reset today, this cycle is finalized — no-op.
    const isStale = (lastResetStr === null) || (lastResetStr < todayStr);
    if (!isStale) return;

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








/***********************
 * 4) VENDORS
 ***********************/
function showManageVendorsSidebar() {
  const tmpl = HtmlService.createTemplateFromFile("ManageVendors");
  // Pre-load the full vendor table data so the modal renders without a second
  // server roundtrip. Was previously also calling getVendorTableData() on init.
  tmpl.vendorListJson  = JSON.stringify(getVendorList());
  tmpl.vendorTableJson = JSON.stringify(getVendorTableData());
  SpreadsheetApp.getUi().showModalDialog(
    tmpl.evaluate().setWidth(MODAL_SM_W).setHeight(MODAL_SM_H),
    "Manage Vendors"
  );
}




// Returns all vendors with their 7-day multipliers for the View All tab.
// Returns [{name, mults: [mon,tue,wed,thu,fri,sat,sun]}]
function getVendorTableData() {
  const sh      = getSheet_(VENDOR_TABLE.SHEET);
  const lastRow = sh.getLastRow();
  if (lastRow < 2) return [];
  // Single 9-wide read covering S(mults start) through AA(cutoff). Layout:
  //   row[0..6] = S:Y multipliers (Mon-Sun)
  //   row[7]   = Z (vendor name)
  //   row[8]   = AA (cutoff time)
  // Previously this was 3 separate getRange calls; merging is cheaper per
  // call than the duplicated-Z-column concern that motivated the split,
  // since each .getValues() round-trip dominates the cost.
  const block = sh.getRange(2, VENDOR_TABLE.MULT_COL, lastRow - 1, 9).getValues();
  const out = [];
  for (let i = 0; i < block.length; i++) {
    const row = block[i];
    const n = String(row[7] || "").trim();
    if (!n) continue;
    out.push({
      name:       n,
      mults:      row.slice(0, 7).map(v => Number(v) || 0),
      cutoffTime: normalizeCutoffString_(row[8])
    });
  }
  return out;
}

// Normalizes whatever a user (or import) put in column AA to either a
// clean "HH:MM" 24-hour string or null. Accepts:
//   - "HH:MM" or "H:MM" 24-hour strings
//   - "H:MM AM/PM" 12-hour strings (case-insensitive)
//   - Empty/null/undefined → null (vendor has no cutoff)
//   - Date objects → converted using hours+minutes (in case Sheets coerced
//     a typed time to a Date)
// Invalid input → null, never throws. The dashboard handles null cutoffs
// gracefully (no badge, sorts last). We're permissive on input so a slip
// by an operator doesn't break the whole dashboard.
function normalizeCutoffString_(raw) {
  if (raw === null || raw === undefined || raw === "") return null;
  // Sheets sometimes coerces "14:00" typed into a cell into a Date for
  // the same calendar day at 14:00 local. Extract H/M directly in that
  // case — safer than relying on toString locale.
  if (Object.prototype.toString.call(raw) === '[object Date]') {
    const h = raw.getHours();
    const m = raw.getMinutes();
    return pad2_(h) + ':' + pad2_(m);
  }
  const s = String(raw).trim();
  if (!s) return null;
  // 12-hour with AM/PM
  let m = s.match(/^(\d{1,2}):(\d{2})\s*(am|pm)$/i);
  if (m) {
    let h = parseInt(m[1], 10);
    const mins = parseInt(m[2], 10);
    if (mins < 0 || mins > 59) return null;
    const isPm = m[3].toLowerCase() === 'pm';
    if (h === 12) h = isPm ? 12 : 0;
    else if (isPm) h += 12;
    if (h < 0 || h > 23) return null;
    return pad2_(h) + ':' + pad2_(mins);
  }
  // 24-hour
  m = s.match(/^(\d{1,2}):(\d{2})$/);
  if (m) {
    const h = parseInt(m[1], 10);
    const mins = parseInt(m[2], 10);
    if (h < 0 || h > 23 || mins < 0 || mins > 59) return null;
    return pad2_(h) + ':' + pad2_(mins);
  }
  return null;
}

function pad2_(n) { return (n < 10 ? '0' : '') + n; }




// Called by ManageVendors sidebar - Add Vendor tab.
// 1. Validates name is unique
// 2. Appends vendor name to column Z (feeds R dropdown validation)
// 3. Writes 7 multipliers to columns S:Y (same row as Z entry)
// 4. Writes vendor name to column R (Z already written so validation passes)
// 5. Copies 4th sheet (first vendor tab template), renames + updates B1
// 6. Protects all cells except E3:E1000, owner-only edit
function commitAddVendor(vendorName, mults, cutoffTime) {
  bumpServerMutationTs_();
  const name = String(vendorName || "").trim();
  if (!name) throw new Error("Vendor name is required.");
  if (!Array.isArray(mults) || mults.length !== 7) throw new Error("7 multiplier values required.");

  // Cutoff time is optional — null/empty means "no cutoff" (e.g.
  // walk-in pickup vendors). Normalize whatever the UI sends to a
  // clean "HH:MM" 24h string or null so column AA stays consistent.
  const cutoffNorm = (cutoffTime === undefined || cutoffTime === null || cutoffTime === '')
    ? null
    : normalizeCutoffString_(cutoffTime);




  const ss = SpreadsheetApp.getActiveSpreadsheet();




  // 1. Duplicate check
  const existing = getVendorList();
  if (existing.some(v => v.toLowerCase() === name.toLowerCase())) {
    throw new Error('"' + name + '" already exists.');
  }




  // 1b. Pre-emptive DB cleanup - if stale pick path rows exist for this vendor
  //     (e.g. from a previous remove + re-add cycle), clear them now so nothing
  //     carries over. Safe to call even if no rows exist for this vendor.
  const setupForCleanup = getSheet_(VENDOR_TABLE.SHEET);
  const existingDb      = readPickDb_(setupForCleanup);
  const vLowClean       = name.toLowerCase();
  const cleanedDb       = existingDb.filter(r => String(r[0] || "").trim().toLowerCase() !== vLowClean);
  if (cleanedDb.length !== existingDb.length) {
    writePickDb_(setupForCleanup, cleanedDb);
  }




  const setup   = getSheet_(VENDOR_TABLE.SHEET);
  const lastRow = setup.getLastRow();




  // 2. Append vendor name to column Z (validation source for column R).
  //    Must be written FIRST so the range-based dropdown validation on R
  //    accepts the value when we write it below.
  const zVals = setup.getRange(2, VENDOR_LIST_COL, Math.max(lastRow - 1, 1), 1).getValues();
  let zInsertRow = 2;
  for (let i = 0; i < zVals.length; i++) {
    if (String(zVals[i][0] || "").trim() !== "") zInsertRow = i + 3;
  }
  setup.getRange(zInsertRow, VENDOR_LIST_COL).setValue(name);




  // 3. Batch-write R + S:Y in one call (cols 18-25 = vendor name + 7 multipliers).
  //    Was previously two separate calls. Z is already written so R's
  //    dropdown validation will accept the value.
  setup
    .getRange(zInsertRow, VENDOR_TABLE.VENDOR_COL, 1, 8)
    .setValues([[name, mults[0], mults[1], mults[2], mults[3], mults[4], mults[5], mults[6]]]);


  // 4. Write cutoff time to column AA (separate call — AA is not
  //    contiguous with R:Y so bundling would require a 9-wide write
  //    including a duplicated Z that's already set above).
  //    Empty cutoff is written as empty string so the cell looks visually
  //    blank rather than displaying "null".
  setup.getRange(zInsertRow, VENDOR_CUTOFF_COL).setValue(cutoffNorm || '');




  // 5. Copy VENDOR_TEMPLATE, rename, move to end.
  //    Strict lookup — FAIL-SAFE. The old code fell back to ss.getSheets()[3]
  //    (the 4th sheet) when the template was missing, which could clone an
  //    arbitrary sheet (SETUP, MASTER_ITEMS, the wrong vendor) and corrupt the
  //    new tab. If the template is gone, refuse and point at the recovery tool.
  const templateSheet = ss.getSheetByName("VENDOR_TEMPLATE");
  if (!templateSheet) throw new Error(
    "VENDOR_TEMPLATE tab is missing on this store. Run Ordering Guide → " +
    "📱 Mobile API → Re-establish Vendor Template before adding a vendor."
  );




  const newSheet = templateSheet.copyTo(ss);
  newSheet.setName(name);

  // VENDOR_TEMPLATE is hidden in the spreadsheet (as it should be — KMs
  // and GMs shouldn't see it during normal use). Sheet.copyTo() inherits
  // the hidden property, so without this call the new vendor tab would
  // be invisible until someone manually unhid it from the sheet list.
  // Show it explicitly so the GM who just added the vendor can verify
  // the tab looks right.
  newSheet.showSheet();

  // copyTo() leaves the new sheet active. moveActiveSheet uses 1-based positions.
  ss.moveActiveSheet(ss.getSheets().length);




  // Re-pin ORDER_ENTRY to position 1.
  const orderEntry = ss.getSheetByName(SHEET_ORDER_ENTRY);
  if (orderEntry) {
    ss.setActiveSheet(orderEntry);
    ss.moveActiveSheet(1);
  }




  // 6. Strip ALL protections inherited from the template BEFORE writing B1.
  newSheet.getProtections(SpreadsheetApp.ProtectionType.SHEET).forEach(p => p.remove());
  newSheet.getProtections(SpreadsheetApp.ProtectionType.RANGE).forEach(p => p.remove());




  // Update B1 — merged across B1:F1, holds the vendor header label.
  newSheet.getRange("B1").setValue(name);




  // 7. Apply fresh sheet protection: lock everything except E3:E1000 (On Hand).
  const protection = newSheet.protect().setDescription("Vendor tab - protected");
  protection.setUnprotectedRanges([newSheet.getRange("E3:E1000")]);
  protection.removeEditors(protection.getEditors());




  return { ok: true, name };
}


// Called by the ManageVendors "Import Vendor" panel. Creates a vendor (reusing
// commitAddVendor, so the SETUP block + VENDOR_TEMPLATE clone + protections all
// stay in one place) and then bulk-inserts every item from a pasted/uploaded
// CSV into MASTER_ITEMS — par left BLANK and no storage-area assignment (the
// items exist in the data model but stay off the vendor's ordering tab until
// each is assigned an area via Manage Items / Pick Path).
//
// payload = { name, mults:[7], cutoff, csvText }
// CSV shape: one item per row, col 0 = Item Name, col 1 = Pack Size. A header
// row ("Item Name,Pack…") and #-comment / blank rows are skipped.
function commitImportVendor(payload) {
  bumpServerMutationTs_();
  payload = payload || {};
  const name    = String(payload.name || "").trim();
  const mults   = payload.mults;
  const cutoff  = payload.cutoff;
  const csvText = String(payload.csvText || "");

  if (!name) throw new Error("Vendor name is required.");
  if (!Array.isArray(mults) || mults.length !== 7) throw new Error("7 multiplier values required.");

  // 1. Parse the CSV into clean {name, pack} item rows.
  let rows;
  try {
    rows = Utilities.parseCsv(csvText);
  } catch (e) {
    throw new Error("Could not read the CSV file. Re-download the template and try again.");
  }

  const items   = [];
  const seen     = {};        // lowercased name -> true, to dedupe within the file
  const skipped  = [];        // { name, reason } for the success report
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i] || [];
    const itemName = String(row[0] || "").trim();
    const pack     = String(row[1] || "").trim();

    if (!itemName) continue;                                   // blank row
    if (itemName.charAt(0) === "#") continue;                  // comment row
    const low = itemName.toLowerCase();
    if (low === "item name" || low === "name") continue;       // header row
    if (seen[low]) { skipped.push({ name: itemName, reason: "duplicate in file" }); continue; }
    seen[low] = true;
    items.push({ name: itemName, pack: pack });
  }

  if (!items.length) throw new Error("No items found in the file. Each row needs an item name in the first column.");

  // 2. Create the vendor first (throws on duplicate name — caught by the UI).
  commitAddVendor(name, mults, cutoff);

  // 3. Bulk-insert the items into MASTER_ITEMS. A new vendor has no rows yet,
  //    so we append after the last item row. Build the blocks and write each
  //    column-group in a single setValues (not per-item like commitUpsertItem,
  //    which would be hundreds of I/O calls for a large catalog).
  const sh = getSheet_(SHEET_MASTER);

  // Next sequential ITEM-#### id.
  const lastDataRow = getLastItemRow_(sh);
  const existingIds = lastDataRow >= 2 ? sh.getRange(2, COL.ID, lastDataRow - 1, 1).getValues().flat() : [];
  let maxN = 0;
  existingIds.forEach(v => {
    const m = /^ITEM-(\d+)$/i.exec(String(v || "").trim());
    if (m) maxN = Math.max(maxN, Number(m[1]));
  });

  let insertAfterRow = getLastItemRow_(sh);
  if (insertAfterRow < 1) insertAfterRow = 1;
  const startRow = insertAfterRow + 1;
  const n        = items.length;
  sh.insertRowsAfter(insertAfterRow, n);

  // Block A:G — [ID, NAME, VENDOR, SKU(''), PACK, CATEGORY(''), PAR('')].
  // PAR is written as '' (blank) per the import contract — KMs set it later.
  const agBlock = items.map((it, k) => {
    const itemId = "ITEM-" + String(maxN + 1 + k).padStart(4, "0");
    return [itemId, it.name, name, '', it.pack, '', ''];
  });
  sh.getRange(startRow, 1, n, 7).setValues(agBlock);

  // Column O — eligible vendors; just this vendor for an imported catalog.
  const eligibleStr = serializeEligibleVendors_(normalizeEligibleList_([], name));
  const oBlock = items.map(() => [eligibleStr]);
  sh.getRange(startRow, COL.ELIGIBLE_VENDORS, n, 1).setNumberFormat("@").setValues(oBlock);

  // Block L:N — ACTIVE(true), USE_MULT(true), NOTES(''). Checkbox validation
  // on L:M across the whole inserted span in one call.
  applyCheckboxValidation_(sh.getRange(startRow, COL.ACTIVE, n, 2));
  const lnBlock = items.map(() => [true, true, '']);
  sh.getRange(startRow, COL.ACTIVE, n, 3).setValues(lnBlock);

  reloadSetupIfVendorMatches_(name);
  return { ok: true, vendor: name, itemsAdded: n, skipped: skipped };
}


// Called by ManageVendors sidebar - inline multiplier edit.
// Finds the vendor's row in column Z and overwrites S:Y with the new multipliers.
function commitUpdateVendorMults(vendorName, mults) {
  bumpServerMutationTs_();
  const name = String(vendorName || "").trim();
  if (!name) throw new Error("Vendor name is required.");
  if (!Array.isArray(mults) || mults.length !== 7) throw new Error("7 multiplier values required.");


  const setup   = getSheet_(VENDOR_TABLE.SHEET);
  const lastRow = setup.getLastRow();
  if (lastRow < 2) throw new Error("No vendors found.");


  // Find the matching row in column Z (source of truth for vendor names)
  const zVals = setup.getRange(2, VENDOR_LIST_COL, lastRow - 1, 1).getValues();
  let targetRow = -1;
  for (let i = 0; i < zVals.length; i++) {
    if (String(zVals[i][0] || "").trim().toLowerCase() === name.toLowerCase()) {
      targetRow = i + 2; // +2: 1-based + header offset
      break;
    }
  }


  if (targetRow === -1) throw new Error('"' + name + '" not found in vendor list.');


  // Write 7 multipliers to S:Y in the matched row
  setup.getRange(targetRow, VENDOR_TABLE.MULT_COL, 1, 7).setValues([mults]);


  return { ok: true };
}


// Called by ManageVendors sidebar - View All tab inline editor.
// Writes only the cutoff time for a vendor; leaves multipliers untouched.
// cutoffTime: "HH:MM" 24h, "H:MM AM/PM", null, or empty — all normalized.
function commitUpdateVendorCutoff(vendorName, cutoffTime) {
  bumpServerMutationTs_();
  const name = String(vendorName || "").trim();
  if (!name) throw new Error("Vendor name is required.");

  const cutoffNorm = (cutoffTime === undefined || cutoffTime === null || cutoffTime === '')
    ? null
    : normalizeCutoffString_(cutoffTime);
  // We accept null/empty as "clear the cutoff", but if the user typed
  // something that didn't parse (e.g. "2pm-ish"), normalize returned
  // null — surface that as an error instead of silently clearing.
  if (cutoffTime && cutoffNorm === null) {
    throw new Error('Cutoff time format not recognized. Use "HH:MM" (24h) or "H:MM AM/PM".');
  }

  const setup   = getSheet_(VENDOR_TABLE.SHEET);
  const lastRow = setup.getLastRow();
  if (lastRow < 2) throw new Error("No vendors found.");

  // Find the matching row in column Z (source of truth for vendor names)
  const zVals = setup.getRange(2, VENDOR_LIST_COL, lastRow - 1, 1).getValues();
  let targetRow = -1;
  for (let i = 0; i < zVals.length; i++) {
    if (String(zVals[i][0] || "").trim().toLowerCase() === name.toLowerCase()) {
      targetRow = i + 2;
      break;
    }
  }
  if (targetRow === -1) throw new Error('"' + name + '" not found in vendor list.');

  setup.getRange(targetRow, VENDOR_CUTOFF_COL).setValue(cutoffNorm || '');
  return { ok: true, cutoffTime: cutoffNorm };
}


// Called by ManageVendors sidebar - inline editor save.
// Commits multipliers (S:Y) AND cutoff (AA) for a vendor in a single
// RPC against one row lookup. Validates both inputs upfront so we fail
// before any write — no partial-success state where mults saved but
// cutoff didn't (or vice versa).
function commitUpdateVendorMultsAndCutoff(vendorName, mults, cutoffTime) {
  bumpServerMutationTs_();
  const name = String(vendorName || "").trim();
  if (!name) throw new Error("Vendor name is required.");
  if (!Array.isArray(mults) || mults.length !== 7) throw new Error("7 multiplier values required.");

  const cutoffNorm = (cutoffTime === undefined || cutoffTime === null || cutoffTime === '')
    ? null
    : normalizeCutoffString_(cutoffTime);
  if (cutoffTime && cutoffNorm === null) {
    throw new Error('Cutoff time format not recognized. Use "HH:MM" (24h) or "H:MM AM/PM".');
  }

  const setup   = getSheet_(VENDOR_TABLE.SHEET);
  const lastRow = setup.getLastRow();
  if (lastRow < 2) throw new Error("No vendors found.");

  const zVals = setup.getRange(2, VENDOR_LIST_COL, lastRow - 1, 1).getValues();
  let targetRow = -1;
  for (let i = 0; i < zVals.length; i++) {
    if (String(zVals[i][0] || "").trim().toLowerCase() === name.toLowerCase()) {
      targetRow = i + 2;
      break;
    }
  }
  if (targetRow === -1) throw new Error('"' + name + '" not found in vendor list.');

  setup.getRange(targetRow, VENDOR_TABLE.MULT_COL, 1, 7).setValues([mults]);
  setup.getRange(targetRow, VENDOR_CUTOFF_COL).setValue(cutoffNorm || '');

  return { ok: true, cutoffTime: cutoffNorm };
}


// ── Vendor Par Recalibration ─────────────────────────────────────────────────
// One-time tool for stores where pars were calibrated against the legacy
// (non-canonical) model — par sized to roughly "average delivery gap" with
// mults floating around 1.0 — and we want to switch to the canonical
// 1-day-par + canonical-multiplier model (mult_d = days until next delivery).
// rpr is the motivating case: switching items between vendors only gives
// correct order quantities when pars are 1-day-pars and mults are gap-days.
//
// The modal reads the vendor's current mults + every active-for-this-vendor
// item's current par, surfaces three divisor framings (weekly-demand,
// deliveries-per-week, average-gap) + a custom field, and previews each
// item's old→new par before commit. Mults and pars commit atomically here;
// bumpServerMutationTs_ ensures the dashboard recomputes order math on the
// next read.
//
// IMPORTANT operational discipline: at a store moving to multi-vendor item
// switching, recalibrate EVERY vendor before re-enabling switching. The
// par is global per item; mixing canonical and legacy calibration across
// a store's vendors will give wrong quantities when an item is switched
// to a vendor whose mults still expect the legacy par.
function showRecalibrateVendorSidebar() {
  const tmpl = HtmlService.createTemplateFromFile("RecalibrateVendor");
  tmpl.vendorListJson = JSON.stringify(getVendorList());
  SpreadsheetApp.getUi().showModalDialog(
    tmpl.evaluate().setWidth(MODAL_SM_W).setHeight(MODAL_SM_H),
    "Recalibrate Vendor Pars"
  );
}


// Bootstrap call on modal open and on vendor-dropdown change. Returns the
// vendor's current mults (S:Y on its row) and the items currently active
// for this vendor with their current par. The modal uses this to compute
// the three suggested divisors and render the side-by-side preview.
function getVendorRecalibrationBootstrap(vendorName) {
  const name = String(vendorName || "").trim();
  if (!name) throw new Error("Vendor name is required.");

  const setup   = getSheet_(VENDOR_TABLE.SHEET);
  const lastRow = setup.getLastRow();
  if (lastRow < VENDOR_TABLE.START_ROW) throw new Error("No vendors defined.");
  const zVals = setup.getRange(2, VENDOR_LIST_COL, lastRow - 1, 1).getValues();
  let vendorRow = -1;
  for (let i = 0; i < zVals.length; i++) {
    if (String(zVals[i][0] || "").trim().toLowerCase() === name.toLowerCase()) {
      vendorRow = i + 2;
      break;
    }
  }
  if (vendorRow === -1) throw new Error('"' + name + '" not found in vendor list.');
  const currentMults = setup
    .getRange(vendorRow, VENDOR_TABLE.MULT_COL, 1, 7)
    .getValues()[0]
    .map(v => Number(v) || 0);

  const master     = getSheet_(SHEET_MASTER);
  const masterLast = master.getLastRow();
  const items = [];
  if (masterLast >= 2) {
    const numCols = Math.max(COL.ID, COL.NAME, COL.VENDOR, COL.PAR, COL.ACTIVE, COL.USE_MULT);
    const rows    = master.getRange(2, 1, masterLast - 1, numCols).getValues();
    const vLow    = name.toLowerCase();
    rows.forEach(r => {
      const v       = String(r[COL.VENDOR - 1] || "").trim().toLowerCase();
      const isActv  = r[COL.ACTIVE - 1] === true;
      const useMult = r[COL.USE_MULT - 1] === true;
      // Recalibration only applies to items whose order math actually uses
      // the vendor multiplier (USE_MULT=true). Items with a fixed par that
      // ignores the multiplier shouldn't be divided — their par means
      // something different and the new mults won't be applied to them.
      if (v !== vLow || !isActv || !useMult) return;
      const id  = String(r[COL.ID   - 1] || "").trim();
      const nm  = String(r[COL.NAME - 1] || "").trim();
      const par = r[COL.PAR - 1];
      if (!id || !nm) return;
      items.push({
        id:   id,
        name: nm,
        par:  par === "" || par === null || par === undefined ? null : Number(par)
      });
    });
    items.sort((a, b) => a.name.localeCompare(b.name));
  }

  return { vendor: name, currentMults: currentMults, items: items };
}


// Atomic commit: writes new mults to the vendor row + divides every
// active-for-this-vendor item's par by parDivisor (1-decimal rounding,
// blank/null pars stay blank). bumpServerMutationTs_ invalidates the
// dashboard's cached order math.
function commitVendorRecalibration(payload) {
  bumpServerMutationTs_();
  payload = payload || {};
  const name     = String(payload.vendor || "").trim();
  const newMults = payload.newMults;
  const divisor  = Number(payload.parDivisor);

  if (!name) throw new Error("Vendor name is required.");
  if (!Array.isArray(newMults) || newMults.length !== 7) {
    throw new Error("7 multiplier values required.");
  }
  for (let i = 0; i < 7; i++) {
    const m = Number(newMults[i]);
    if (!isFinite(m) || m < 0) throw new Error("Multipliers must be non-negative numbers.");
    newMults[i] = m;
  }
  if (!isFinite(divisor) || divisor <= 0) {
    throw new Error("Par divisor must be a positive number.");
  }

  // Locate vendor row.
  const setup   = getSheet_(VENDOR_TABLE.SHEET);
  const lastRow = setup.getLastRow();
  if (lastRow < VENDOR_TABLE.START_ROW) throw new Error("No vendors defined.");
  const zVals = setup.getRange(2, VENDOR_LIST_COL, lastRow - 1, 1).getValues();
  let vendorRow = -1;
  for (let i = 0; i < zVals.length; i++) {
    if (String(zVals[i][0] || "").trim().toLowerCase() === name.toLowerCase()) {
      vendorRow = i + 2;
      break;
    }
  }
  if (vendorRow === -1) throw new Error('"' + name + '" not found in vendor list.');

  // Compute new pars (write only col G to avoid disturbing other columns).
  // Filter: must be active AND use the multiplier — items that don't use
  // the vendor multiplier have a different par semantic and must not be
  // divided here. ALWAYS rounds UP to the nearest 0.5 increment so the
  // recalibration biases toward slight over-ordering rather than risking
  // silent under-orders. (e.g. 2.33 -> 2.5, 2.51 -> 3.0, 4.5 -> 4.5).
  let itemCount = 0;
  const master     = getSheet_(SHEET_MASTER);
  const masterLast = master.getLastRow();
  if (masterLast >= 2) {
    const filterCols = Math.max(COL.VENDOR, COL.ACTIVE, COL.USE_MULT);
    const filterVals = master.getRange(2, 1, masterLast - 1, filterCols).getValues();
    const parRange   = master.getRange(2, COL.PAR, masterLast - 1, 1);
    const parVals    = parRange.getValues();
    const vLow       = name.toLowerCase();
    let mutated = false;
    for (let i = 0; i < parVals.length; i++) {
      const v       = String(filterVals[i][COL.VENDOR - 1] || "").trim().toLowerCase();
      const isActv  = filterVals[i][COL.ACTIVE - 1] === true;
      const useMult = filterVals[i][COL.USE_MULT - 1] === true;
      if (v !== vLow || !isActv || !useMult) continue;
      const oldPar = parVals[i][0];
      if (oldPar === "" || oldPar === null || oldPar === undefined) continue;
      const oldNum = Number(oldPar);
      if (!isFinite(oldNum)) continue;
      parVals[i][0] = Math.ceil((oldNum / divisor) * 2) / 2;
      mutated = true;
      itemCount++;
    }
    if (mutated) parRange.setValues(parVals);
  }

  // Write new mults.
  setup.getRange(vendorRow, VENDOR_TABLE.MULT_COL, 1, 7).setValues([newMults]);

  return { ok: true, vendor: name, itemCount: itemCount, divisor: divisor };
}


// Read-only diagnostic. For every vendor, runs the same round-trip the
// ManageVendors Edit form's delivery picker would perform if it were
// authoritative: inferDeliveryFromMults -> computeMultsFromDelivery. If the
// recomputed mults differ from what's stored, the picker (when later promoted
// to the source of truth) would silently rewrite this vendor's mults — flag it
// for manual review via Recalibrate Vendor Pars before that change ships.
//
// Status values returned per vendor:
//   'canonical' — round-trip is lossless; safe.
//   'mismatch'  — round-trip differs; recalibrate before promoting the picker.
//   'everyday'  — canonical but every day has a delivery and every mult is 1
//                 (the rpr-style "treat every day as 1-day par" pattern). Worth
//                 confirming the vendor actually delivers daily.
function auditVendorCadence() {
  const vendors = getVendorTableData(); // [{name, mults, cutoffTime}, ...]
  const out = [];
  for (let i = 0; i < vendors.length; i++) {
    const v        = vendors[i];
    const mults    = v.mults.slice(0, 7).map(m => Number(m) || 0);
    const delivery = inferDeliveryFromMults_(mults);
    const canon    = computeMultsFromDelivery_(delivery);
    let status     = 'canonical';
    for (let j = 0; j < 7; j++) {
      if (mults[j] !== canon[j]) { status = 'mismatch'; break; }
    }
    if (status === 'canonical') {
      const allOnes = mults.every(m => m === 1);
      const everyDay = delivery.every(d => d === true);
      if (allOnes && everyDay) status = 'everyday';
    }
    out.push({
      name:              v.name,
      mults:             mults,
      inferredDelivery:  delivery,
      canonicalMults:    canon,
      status:            status
    });
  }
  return out;
}


// Server-side twin of ManageVendors.html's computeMultsFromDelivery. Given a
// 7-element boolean delivery-day array (Mon..Sun), returns the 7 order-day
// multipliers under the 1-day-lead assumption: an order placed on day i
// arrives the next day and must cover the gap until the following delivery.
function computeMultsFromDelivery_(deliveryDays) {
  const mults = [0, 0, 0, 0, 0, 0, 0];
  for (let i = 0; i < 7; i++) {
    const tomorrow = (i + 1) % 7;
    if (!deliveryDays[tomorrow]) continue;
    let gap = 1;
    for (let j = 1; j <= 7; j++) {
      if (deliveryDays[(tomorrow + j) % 7]) { gap = j; break; }
    }
    mults[i] = gap;
  }
  return mults;
}


// Server-side twin of ManageVendors.html's inferDeliveryFromMults — display-
// only seed. A vendor is assumed to deliver on the day after any order-day
// with a non-zero multiplier.
function inferDeliveryFromMults_(mults) {
  const deliveryDays = [false, false, false, false, false, false, false];
  for (let i = 0; i < 7; i++) {
    if (mults[i] && mults[i] > 0) deliveryDays[(i + 1) % 7] = true;
  }
  return deliveryDays;
}


function showVendorCadenceAuditSidebar() {
  const tmpl = HtmlService.createTemplateFromFile("VendorCadenceAudit");
  tmpl.auditJson = JSON.stringify(auditVendorCadence());
  SpreadsheetApp.getUi().showModalDialog(
    tmpl.evaluate().setWidth(MODAL_SM_W).setHeight(MODAL_SM_H),
    "Audit Vendor Cadence"
  );
}


// ── READ-ONLY: vendor-tab structure audit ────────────────────────────────
// Pre-flight safety check before ANY vendor-tab migration. Compares every
// vendor tab against the LIVE VENDOR_TEMPLATE (the clone source — the real
// source of truth, NOT the exported xlsx) and flags drift on the load-
// bearing cells: the M spine, the A-D/F spill + order math, H multiplier,
// and the I/K order block. Also confirms the N:P dead zone is empty and the
// Q:T duplicate block matches (so the migration knows it's safe to strip).
// Writes NOTHING — pure read. Run from Ordering Guide → Mobile API → Audit
// Vendor Tab Structure before running the migration on a store.
function auditVendorTabStructure() {
  const ui = SpreadsheetApp.getUi();
  const ss = SpreadsheetApp.getActiveSpreadsheet();

  // Anchor cells whose formula must match the reference for a tab to be safe
  // to migrate. These are the spill anchors + order math + order block; the
  // formula TEXT is identical across tabs (they reference $B$1 / $M / the
  // SETUP & MASTER_ITEMS sheets — no per-tab literals), so exact-string
  // comparison is a precise drift detector.
  const FORMULA_CELLS = ["A3","B3","C3","D3","F3","H2","I4","K4","M3","Q3","R3","S3","T3"];

  // Reference = the live VENDOR_TEMPLATE when present. If it was deleted on
  // this store, fall back to the FIRST vendor tab (all tabs are clones, so
  // mutual consistency is what we can verify) and flag the missing template
  // loudly — re-establishing it is a migration prerequisite.
  const vendors = getVendorList();
  const tmpl = ss.getSheetByName("VENDOR_TEMPLATE");
  let refSheet, refLabel, templateMissing = false;
  if (tmpl) {
    refSheet = tmpl; refLabel = "VENDOR_TEMPLATE";
  } else if (vendors.length) {
    templateMissing = true;
    refSheet = ss.getSheetByName(vendors[0]);
    refLabel = 'vendor tab "' + vendors[0] + '"  (⚠ VENDOR_TEMPLATE MISSING)';
  } else {
    ui.alert("No VENDOR_TEMPLATE and no vendor tabs found — nothing to audit.");
    return;
  }

  const ref = {};
  FORMULA_CELLS.forEach(function (a) { ref[a] = refSheet.getRange(a).getFormula(); });

  const drift = [];
  let okCount = 0;

  vendors.forEach(function (v) {
    const sh = ss.getSheetByName(v);
    if (!sh) { drift.push('⚠ "' + v + '": tab not found'); return; }

    const notes = [];
    FORMULA_CELLS.forEach(function (a) {
      if (sh.getRange(a).getFormula() !== ref[a]) notes.push(a + " formula differs");
    });

    // N:P (cols 14-16) should be empty in the data region (rows 3+).
    const lastRow = sh.getLastRow();
    if (lastRow >= 3) {
      const np = sh.getRange(3, 14, lastRow - 2, 3).getValues();
      const npFilled = np.some(function (r) {
        return r.some(function (c) { return c !== "" && c !== null; });
      });
      if (npFilled) notes.push("N:P dead zone not empty");
    }

    if (notes.length === 0) okCount++;
    else drift.push('⚠ "' + v + '":\n     - ' + notes.join("\n     - "));
    Logger.log("[VendorTabAudit] " + v + ": " + (notes.length ? notes.join("; ") : "OK"));
  });

  const total = vendors.length;
  const summary =
    "Vendor Tab Structure Audit\n" +
    "Reference: " + refLabel + "\n\n" +
    (templateMissing
      ? "⚠ VENDOR_TEMPLATE is MISSING on this store. Add-vendor falls back\n" +
        "to ss.getSheets()[3] (the 4th sheet) — fragile. Re-establishing the\n" +
        "template is required before migrating. Audit below is tab-vs-tab\n" +
        "consistency only.\n\n"
      : "") +
    "Tabs audited: " + total + "\n" +
    "✓ Match reference: " + okCount + "\n" +
    (drift.length
      ? "⚠ Drift: " + drift.length + "\n\n" + drift.join("\n\n") +
        "\n\nDo NOT migrate the flagged tab(s) until reviewed."
      : "\nAll tabs match the reference — structurally consistent.") +
    "\n\n(Full per-tab detail in Extensions → Apps Script → Executions.)";
  ui.alert("Vendor Tab Structure Audit", summary, ui.ButtonSet.OK);
}


// ── Re-establish a clean hidden VENDOR_TEMPLATE from a healthy vendor tab ──
// The template is the clone source for Add Vendor. On some stores (e.g. rprfo)
// it was deleted, leaving Add Vendor to guess at ss.getSheets()[3] (now removed
// — see commitAddVendor). This rebuilds it STRUCTURALLY rather than from
// hardcoded formulas: clone the first structurally-healthy vendor tab, blank its
// vendor-specific inputs (B1 header → empties the M-spine FILTER spill; E On
// Hand), and hide it. NO-OP when VENDOR_TEMPLATE already exists.
// Returns { created:Boolean, source:String|null }.
function reestablishVendorTemplate_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  if (ss.getSheetByName("VENDOR_TEMPLATE")) {
    return { created: false, source: null };
  }

  // Pick a healthy clone source: a vendor tab with formulas intact in the
  // load-bearing cells (spill anchor A3, spine M3, order math F3, multiplier H2).
  const vendors = getVendorList();
  let source = null;
  for (let i = 0; i < vendors.length; i++) {
    const sh = ss.getSheetByName(vendors[i]);
    if (!sh) continue;
    if (sh.getRange("A3").getFormula() &&
        sh.getRange("M3").getFormula() &&
        sh.getRange("F3").getFormula() &&
        sh.getRange("H2").getFormula()) {
      source = sh;
      break;
    }
  }
  if (!source) {
    throw new Error(
      "No structurally-healthy vendor tab found to clone. Run Audit Vendor " +
      "Tab Structure first."
    );
  }

  const tmpl = source.copyTo(ss);
  tmpl.setName("VENDOR_TEMPLATE");

  // Blank the vendor-specific inputs. B1 drives the M-spine FILTER, so clearing
  // it empties the A–D/F spill and the I–L order block (which read $A$3/$B$3/$F$3).
  // E (On Hand) is cleared so no counts bleed into future cloned tabs.
  tmpl.getRange("B1").clearContent();
  const lastRow = tmpl.getLastRow();
  if (lastRow >= VENDOR_TAB.DATA_START_ROW) {
    tmpl.getRange(VENDOR_TAB.DATA_START_ROW, VENDOR_TAB.ON_HAND_COL,
                  lastRow - VENDOR_TAB.DATA_START_ROW + 1, 1).clearContent();
  }

  tmpl.hideSheet();

  // copyTo() leaves the new sheet active; re-pin ORDER_ENTRY to position 1.
  const orderEntry = ss.getSheetByName(SHEET_ORDER_ENTRY);
  if (orderEntry) { ss.setActiveSheet(orderEntry); ss.moveActiveSheet(1); }

  return { created: true, source: source.getName() };
}


// Menu wrapper for the standalone recovery action (referenced by the Add Vendor
// fail-safe error). Low blast radius — only re-creates the template, no strip.
function reestablishVendorTemplateMenu_() {
  const ui = SpreadsheetApp.getUi();
  try {
    const r = reestablishVendorTemplate_();
    ui.alert("Re-establish Vendor Template",
      r.created
        ? "Done — hidden VENDOR_TEMPLATE re-created from \"" + r.source + "\"."
        : "No action needed — VENDOR_TEMPLATE already exists.",
      ui.ButtonSet.OK);
  } catch (e) {
    ui.alert("Re-establish Vendor Template", "Failed: " + String(e.message || e), ui.ButtonSet.OK);
  }
}


// ── (removed 2026-06-01) brandAndStripVendorTab_ + migrateVendorTabs ──
// Shelved cosmetic vendor-tab dead-zone strip + concept-header branding from
// the 2026-05-29 #4 work. Never wired to a menu; the real fix shipped instead
// as syncVendorMultiplierFormulasMenu_ (template H2 repair). Deleted as dead
// code — recoverable via git history if the branding pass is ever revived.


// Called by ManageVendors sidebar - Remove tab.
// Removes vendor row from table and from data validation list.
// Tab, items, and pick path DB are left untouched.
function commitRemoveVendor(vendorName) {
  bumpServerMutationTs_();
  const name = String(vendorName || "").trim();
  if (!name) throw new Error("Vendor name is required.");




  const setup   = getSheet_(VENDOR_TABLE.SHEET);
  const lastRow = setup.getLastRow();
  if (lastRow < VENDOR_TABLE.START_ROW) throw new Error("No vendors found.");




  // Find and delete the row in the vendor table
  const tableData = setup
    .getRange(VENDOR_TABLE.START_ROW, VENDOR_TABLE.VENDOR_COL, lastRow - VENDOR_TABLE.START_ROW + 1, 1)
    .getValues();




  let deletedRow = -1;
  for (let i = 0; i < tableData.length; i++) {
    if (String(tableData[i][0] || "").trim().toLowerCase() === name.toLowerCase()) {
      deletedRow = VENDOR_TABLE.START_ROW + i;
      break;
    }
  }




  if (deletedRow === -1) throw new Error("\"" + name + "\" was not found in the vendor table.");




  setup.deleteRow(deletedRow);




  // Remove vendor name from column Z and matching multipliers from S:Y.
  // Shift remaining rows up to close the gap.
  const zLastRow = setup.getLastRow();
  if (zLastRow >= 2) {
    const numRows = zLastRow - 1;
    const zVals   = setup.getRange(2, VENDOR_LIST_COL, numRows, 1).getValues();
    const mVals   = setup.getRange(2, VENDOR_TABLE.MULT_COL, numRows, 7).getValues();




    let deleteIdx = -1;
    for (let i = 0; i < zVals.length; i++) {
      if (String(zVals[i][0] || "").trim().toLowerCase() === name.toLowerCase()) {
        deleteIdx = i;
        break;
      }
    }




    if (deleteIdx !== -1) {
      zVals.splice(deleteIdx, 1);
      mVals.splice(deleteIdx, 1);




      setup.getRange(2, VENDOR_LIST_COL, numRows, 1).clearContent();
      setup.getRange(2, VENDOR_TABLE.MULT_COL, numRows, 7).clearContent();




      if (zVals.length) {
        setup.getRange(2, VENDOR_LIST_COL, zVals.length, 1).setValues(zVals);
        setup.getRange(2, VENDOR_TABLE.MULT_COL, mVals.length, 7).setValues(mVals);
      }
    }
  }




  // Deactivate all MASTER_ITEMS rows for this vendor.
  // Column L already has checkbox validation applied — batch-write false in
  // one operation instead of looping with per-cell setValue + re-validation.
  const master        = getSheet_(SHEET_MASTER);
  const masterLastRow = master.getLastRow();
  if (masterLastRow >= 2) {
    const nameLow  = name.toLowerCase();
    const numRows  = masterLastRow - 1;
    const vendors  = master.getRange(2, COL.VENDOR, numRows, 1).getValues();
    const actives  = master.getRange(2, COL.ACTIVE, numRows, 1).getValues();
    // Build a new column of active values: false for matching vendor, otherwise unchanged.
    let anyChange = false;
    for (let i = 0; i < vendors.length; i++) {
      if (String(vendors[i][0] || "").trim().toLowerCase() === nameLow && actives[i][0] !== false) {
        actives[i][0] = false;
        anyChange = true;
      }
    }
    if (anyChange) {
      master.getRange(2, COL.ACTIVE, numRows, 1).setValues(actives);
    }
  }




  return { ok: true, name };
}




function getVendorList() {
  const sh      = getSheet_(VENDOR_TABLE.SHEET);
  const lastRow = sh.getLastRow();
  if (lastRow < 2) return [];
  const vals = sh
    .getRange(2, VENDOR_LIST_COL, Math.max(lastRow - 1, 1), 1)
    .getValues().flat();
  const seen = new Set();
  const out  = [];
  for (const v of vals) {
    const str = String(v || "").trim();
    if (!str) continue;
    const key = str.toLowerCase();
    if (!seen.has(key)) { seen.add(key); out.push(str); }
  }
  return out.sort((a, b) => a.localeCompare(b));
}




function normalizeVendorOrThrow_(vendorName) {
  const vendors = getVendorList();
  const map     = new Map(vendors.map(v => [v.toLowerCase(), v]));
  const input   = String(vendorName || "").trim();
  if (!input) throw new Error("Vendor is required.");
  const key = input.toLowerCase();
  if (!map.has(key)) throw new Error("Vendor \"" + input + "\" is not in SETUP vendor table (column R).");
  return map.get(key);
}




// ── Eligible-vendors list (MASTER_ITEMS column O) ───────────────────────────
// An item carries a list of vendors it MAY be ordered from; one of them (the
// value in column C) is the ACTIVE vendor that actually drives the order math.
// The list is stored as a pipe-delimited string in column O.

function parseEligibleVendors_(raw) {
  return String(raw == null ? "" : raw)
    .split(ELIGIBLE_VENDOR_DELIM)
    .map(s => s.trim())
    .filter(s => s !== "");
}

function serializeEligibleVendors_(arr) {
  return (arr || []).join(ELIGIBLE_VENDOR_DELIM);
}

// Returns a clean, validated, deduped array of canonical vendor names that
// ALWAYS includes the active vendor (listed first). Accepts either the raw
// column-O string or an array (e.g. a payload from the modal). Names that
// aren't in the SETUP vendor table are dropped -- this is what makes reads
// safe BEFORE the one-time backfill runs: an empty or stale column O simply
// falls back to [active vendor].
// Pass a precomputed vendorMap (lowercase -> canonical) to avoid a getVendorList
// call per row when normalizing many items at once.
function normalizeEligibleList_(raw, activeVendor, vendorMap) {
  const map = vendorMap || new Map(getVendorList().map(v => [v.toLowerCase(), v]));
  const names = Array.isArray(raw) ? raw : parseEligibleVendors_(raw);
  const out  = [];
  const seen = new Set();
  const add  = (v) => {
    const canon = map.get(String(v == null ? "" : v).trim().toLowerCase());
    if (!canon) return;
    const k = canon.toLowerCase();
    if (seen.has(k)) return;
    seen.add(k);
    out.push(canon);
  };
  if (activeVendor) add(activeVendor);   // active vendor is always eligible, listed first
  names.forEach(add);
  return out;
}








/***********************
 * 5) MASTER ITEMS
 ***********************/
function showManageItemsSidebar() {
  const tmpl = HtmlService.createTemplateFromFile("ManageItems");
  tmpl.vendorListJson = JSON.stringify(getVendorList());
  SpreadsheetApp.getUi().showModalDialog(
    tmpl.evaluate().setWidth(MODAL_LG_W).setHeight(MODAL_LG_H),
    "Manage Items"
  );
}








function getAllItemsForView() {
  const sh      = getSheet_(SHEET_MASTER);
  const lastRow = sh.getLastRow();
  if (lastRow < 2) return [];




  const assignedIds = new Set(
    readPickDb_(getSheet_(SHEET_SETUP))
      .filter(r => String(r[1] || "").trim() && String(r[3] || "").trim())
      .map(r => String(r[1] || "").trim())
  );




  const numCols   = Math.max(COL.USE_MULT, COL.ACTIVE, COL.PACK, COL.PAR, COL.ELIGIBLE_VENDORS);
  const vendorMap = new Map(getVendorList().map(v => [v.toLowerCase(), v]));
  return sh
    .getRange(2, 1, lastRow - 1, numCols)
    .getValues()
    .filter(r => String(r[COL.ID - 1] || "").trim() && String(r[COL.NAME - 1] || "").trim())
    .map(r => {
      const id     = String(r[COL.ID - 1] || "").trim();
      const vendor = String(r[COL.VENDOR - 1] || "").trim();
      return {
        id,
        name:    String(r[COL.NAME    - 1] || "").trim(),
        vendor:  vendor,
        eligibleVendors: normalizeEligibleList_(r[COL.ELIGIBLE_VENDORS - 1], vendor, vendorMap),
        pack:    String(r[COL.PACK    - 1] || "").trim(),
        par:     r[COL.PAR     - 1] !== "" ? Number(r[COL.PAR - 1]) : "",
        active:  r[COL.ACTIVE  - 1] === true,
        useMult: r[COL.USE_MULT - 1] === true,
        hasArea: assignedIds.has(id)
      };
    });
}




// ── getManageItemsBootstrap (cached, combined endpoint) ──────────────────
// Replaces the two parallel google.script.run calls that ManageItems used
// to make on open (getAllItemsForView + getParReviewFlags). Returns both
// in a single response, so the modal pays one network round-trip instead
// of two. The function is also wrapped with CacheService keyed by the
// current server mutation timestamp -- on the cache-hit path it skips the
// sheet reads entirely and returns parsed JSON.
//
// Cache lifecycle:
//   - Key is 'manageItems_v1_' + getServerMutationTs_()
//   - Any commit* bumps the timestamp -> next call sees a new key -> miss
//   - Stale entries (old timestamp) orphan and expire on their own TTL
//   - 5-minute TTL caps how long any single key can live
//   - On every error (CacheService down, payload too big, bad JSON), the
//     function silently falls through to a fresh compute. The cache layer
//     must never make the function fail.
//
// flags failure tolerance: the old client code treated getParReviewFlags
// failures as non-fatal (empty flags). Preserved here via try/catch so
// items still render even if the par-flag computation throws.
function getManageItemsBootstrap() {
  const ts = getServerMutationTs_();
  const cacheKey = 'manageItems_v2_' + ts;

  let cache = null;
  try { cache = CacheService.getDocumentCache(); } catch (e) { cache = null; }

  if (cache) {
    try {
      const hit = cache.get(cacheKey);
      if (hit) return JSON.parse(hit);
    } catch (e) {
      // bad cached content or read error -- fall through to compute
    }
  }

  const items = getAllItemsForView();
  let flags = {};
  try { flags = getParReviewFlags(); } catch (e) { flags = {}; }
  const payload = { items: items, flags: flags };

  if (cache) {
    try {
      const json = JSON.stringify(payload);
      // CacheService limit is 100KB per key; leave headroom for overhead.
      if (json.length < 95000) cache.put(cacheKey, json, 300);
    } catch (e) {
      // non-fatal: we already have the payload to return
    }
  }
  return payload;
}








function getItemsByVendor(vendor) {
  const sh      = getSheet_(SHEET_MASTER);
  const lastRow = sh.getLastRow();
  if (lastRow < 2) return [];
  const vLow = String(vendor || "").trim().toLowerCase();

  // Build a Map<itemId, areaName> from the pick-path DB so each item can
  // ship its currentArea inline — saves a follow-up getItemForEdit round
  // trip after the user picks an item in the edit form.
  const areaByItemId = new Map();
  const pickDb = readPickDb_(getSheet_(SHEET_SETUP));
  for (const r of pickDb) {
    const id   = String(r[1] || "").trim();
    const area = String(r[3] || "").trim();
    if (id && area && !areaByItemId.has(id)) areaByItemId.set(id, area);
  }

  return sh
    .getRange(2, 1, lastRow - 1, Math.max(COL.NOTES, COL.ACTIVE))
    .getValues()
    .filter(r => String(r[COL.VENDOR - 1] || "").trim().toLowerCase() === vLow
              && String(r[COL.ID   - 1] || "").trim()
              && String(r[COL.NAME - 1] || "").trim())
    .map(r => {
      const id = String(r[COL.ID - 1] || "").trim();
      return {
        id:          id,
        name:        String(r[COL.NAME   - 1] || "").trim(),
        vendor:      String(r[COL.VENDOR - 1] || "").trim(),
        pack:        String(r[COL.PACK   - 1] || "").trim(),
        par:         r[COL.PAR    - 1],
        active:      r[COL.ACTIVE - 1] === true,
        currentArea: areaByItemId.get(id) || ""
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}








function getUnassignedActiveItems() {
  const setup  = getSheet_(SHEET_SETUP);
  const master = getSheet_(SHEET_MASTER);




  const db = readPickDb_(setup);
  const assignedIds = new Set(
    db
      .filter(r => String(r[1] || "").trim() && String(r[3] || "").trim())
      .map(r => String(r[1] || "").trim())
  );




  const lastRow = master.getLastRow();
  if (lastRow < 2) return [];




  return master
    .getRange(2, 1, lastRow - 1, Math.max(COL.ACTIVE, COL.PACK))
    .getValues()
    .filter(r =>
      String(r[COL.ID     - 1] || "").trim() &&
      String(r[COL.NAME   - 1] || "").trim() &&
      r[COL.ACTIVE - 1] === true &&
      !assignedIds.has(String(r[COL.ID - 1] || "").trim())
    )
    .map(r => ({
      id:     String(r[COL.ID     - 1] || "").trim(),
      name:   String(r[COL.NAME   - 1] || "").trim(),
      vendor: String(r[COL.VENDOR - 1] || "").trim(),
      pack:   String(r[COL.PACK   - 1] || "").trim()
    }))
    .sort((a, b) => {
      const vCmp = a.vendor.localeCompare(b.vendor);
      return vCmp !== 0 ? vCmp : a.name.localeCompare(b.name);
    });
}








function getItemForEdit(query) {
  const found = findItemRow_(query);
  if (!found) return null;
  const r = found.rowValues;




  const id = String(r[COL.ID - 1] || "").trim();




  const db          = readPickDb_(getSheet_(SHEET_SETUP));
  const dbRow       = db.find(row => String(row[1] || "").trim() === id && String(row[3] || "").trim());
  const currentArea = dbRow ? String(dbRow[3] || "").trim() : "";




  const vendor = String(r[COL.VENDOR - 1] || "").trim();
  return {
    sheetRow:    found.sheetRow,
    id,
    name:        String(r[COL.NAME     - 1] || "").trim(),
    vendor:      vendor,
    eligibleVendors: normalizeEligibleList_(r[COL.ELIGIBLE_VENDORS - 1], vendor),
    pack:        String(r[COL.PACK     - 1] || "").trim(),
    par:         r[COL.PAR     - 1],
    active:      r[COL.ACTIVE   - 1] === true,
    useMult:     r[COL.USE_MULT - 1] === true,
    notes:       String(r[COL.NOTES   - 1] || "").trim(),
    currentArea
  };
}








function commitUpsertItem(payload) {
  bumpServerMutationTs_();
  const mode    = payload.mode;
  const name    = String(payload.name  || "").trim();
  const vendor  = normalizeVendorOrThrow_(payload.vendor);
  const pack    = String(payload.pack  || "").trim();
  const notes   = String(payload.notes || "").trim();
  const par     = Number(payload.par);
  if (!Number.isFinite(par)) throw new Error("Base Par must be a number.");
  const useMult = (payload.useMult === true || payload.useMult === "true");
  const active  = (payload.active  === true || payload.active  === "true");




  let targetRow = null;
  let existing  = null;




  if (mode === "edit") {
    existing = getItemForEdit(String(payload.lookup || "").trim());
    if (!existing) throw new Error("Could not find an item with that Item ID or name.");
    targetRow = existing.sheetRow;
  } else {
    if (!name) throw new Error("Item Name is required.");
  }




  const sh = getSheet_(SHEET_MASTER);




  // ── ADD ───────────────────────────────────────────────────────────────────
  if (mode === "add") {
    const lastDataRow = getLastItemRow_(sh);
    const ids = lastDataRow >= 2 ? sh.getRange(2, COL.ID, lastDataRow - 1, 1).getValues().flat() : [];
    let maxN = 0;
    ids.forEach(v => {
      const m = /^ITEM-(\d+)$/i.exec(String(v || "").trim());
      if (m) maxN = Math.max(maxN, Number(m[1]));
    });
    const itemId = "ITEM-" + String(maxN + 1).padStart(4, "0");




    let insertAfterRow = getLastRowForVendor_(sh, vendor);
    if (insertAfterRow === -1) {
      insertAfterRow = getLastItemRow_(sh);
      if (insertAfterRow < 1) insertAfterRow = 1;
    }
    const newRow = insertAfterRow + 1;
    sh.insertRowAfter(insertAfterRow);




    // Block A:G — single setValues for ID, NAME, VENDOR, PACK, PAR. SKU (D)
    // and CATEGORY (F) are not managed here; on a newly inserted row those
    // cells are blank, so writing empty strings is a no-op.
    sh.getRange(newRow, 1, 1, 7).setValues([[itemId, name, vendor, '', pack, '', par]]);

    // Eligible Vendors lives in column O, past the A:G block, so it's a
    // separate write. The active vendor (C) is always forced into the list.
    const eligibleStr = serializeEligibleVendors_(
      normalizeEligibleList_(payload.eligibleVendors || [], vendor)
    );
    sh.getRange(newRow, COL.ELIGIBLE_VENDORS).setNumberFormat("@").setValue(eligibleStr);

    // Block L:N — apply checkbox validation to L:M as a single 2-cell range
    // (one setDataValidation call instead of two), then write ACTIVE,
    // USE_MULT, NOTES together in a single setValues call.
    applyCheckboxValidation_(sh.getRange(newRow, COL.ACTIVE, 1, 2));
    sh.getRange(newRow, COL.ACTIVE, 1, 3).setValues([[active, useMult, notes]]);




    // Optional inline area assignment — client passes areaName instead of
    // making a second commitPickPathAreaAssignment roundtrip.
    let assignedArea = "";
    let areaError    = "";
    if (payload.areaName) {
      try {
        commitPickPathAreaAssignment(itemId, vendor, String(payload.areaName).trim());
        assignedArea = String(payload.areaName).trim();
      } catch (err) {
        // Don't fail the add — the item row IS created. But surface the reason
        // the area step failed so the client can show it; without an area the
        // item won't appear on the vendor tab and otherwise looks "vanished".
        areaError = (err && err.message) ? err.message : String(err);
        console.error('inline area assignment failed:', err);
      }
    } else {
      reloadSetupIfVendorMatches_(vendor);
    }
    return { ok: true, mode: "add", row: newRow, id: itemId, assignedArea, areaError };
  }




  // ── EDIT ──────────────────────────────────────────────────────────────────
  const row      = targetRow;
  const editName = name || existing.name;




  // Block A:G — read once, splice NAME/VENDOR/PACK/PAR, write back. Preserves
  // ID (A), SKU (D), and CATEGORY (F). One getValues + one setValues.
  const editRange = sh.getRange(row, 1, 1, 7);
  const editVals  = editRange.getValues()[0];
  editVals[COL.NAME   - 1] = editName;
  editVals[COL.VENDOR - 1] = vendor;
  editVals[COL.PACK   - 1] = pack;
  editVals[COL.PAR    - 1] = par;
  editRange.setValues([editVals]);

  // Eligible Vendors (column O, outside the A:G block): use the payload's list
  // when the form sent one; otherwise re-normalize whatever is stored so the
  // active vendor stays in the list. Separate read/write since O is past G.
  const eligibleCell   = sh.getRange(row, COL.ELIGIBLE_VENDORS);
  const eligibleSource = (payload.eligibleVendors !== undefined && payload.eligibleVendors !== null)
    ? payload.eligibleVendors
    : eligibleCell.getValue();
  eligibleCell.setNumberFormat("@").setValue(
    serializeEligibleVendors_(normalizeEligibleList_(eligibleSource, vendor))
  );

  // Block L:N — cells L and M already have checkbox validation applied
  // from the Add path, so no need to re-apply. Single setValues writes
  // ACTIVE, USE_MULT, NOTES together.
  sh.getRange(row, COL.ACTIVE, 1, 3).setValues([[active, useMult, notes]]);




  // If item is being set inactive, remove it from the pick path DB
  // so it disappears from vendor tabs immediately without a manual reload.
  if (!active) {
    const setup      = getSheet_(SHEET_SETUP);
    const currentDb  = readPickDb_(setup);
    const keptRows   = currentDb.filter(dbRow => String(dbRow[1] || "").trim() !== existing.id);
    if (keptRows.length !== currentDb.length) writePickDb_(setup, keptRows);
  }




  // Optional inline area reassignment — same as Add path.
  let assignedArea = "";
  let areaError    = "";
  if (active && payload.areaName) {
    try {
      commitPickPathAreaAssignment(existing.id, vendor, String(payload.areaName).trim());
      assignedArea = String(payload.areaName).trim();
    } catch (err) {
      // The item edits ARE saved; only the area reassignment failed. Surface
      // the reason instead of swallowing it into the log.
      areaError = (err && err.message) ? err.message : String(err);
      console.error('inline area reassignment failed:', err);
    }
  } else {
    reloadSetupIfVendorMatches_(vendor);
  }
  return { ok: true, mode: "edit", row, id: existing.id, assignedArea, areaError };
}




// Switch an item's ACTIVE vendor (the one that drives its order math) to
// another vendor already in its eligible list. This moves the item between
// vendor tabs: it rewrites MASTER_ITEMS column C and migrates the item's
// pick-path row from the old vendor to the new one, carrying the storage area
// over (storage areas are global, so the same area name is always valid for
// the new vendor). Par is untouched -- the new vendor's day-multiplier on its
// tab applies automatically.
//
// Returns { ok, id, vendor, area, needsArea }. needsArea is true when the
// item had no storage area to carry over (it was unassigned), so the caller
// should prompt for one; the item is still switched, it just won't appear on
// the new vendor's order sheet until an area is assigned.
function commitSwitchActiveVendor(itemId, newVendorRaw) {
  bumpServerMutationTs_();
  const id = String(itemId || "").trim();
  if (!id) throw new Error("Item ID is required.");
  const newVendor = normalizeVendorOrThrow_(newVendorRaw);

  const master = getSheet_(SHEET_MASTER);
  const found  = findItemRow_(id);
  if (!found) throw new Error("Could not find an item with ID " + id + ".");
  const row = found.sheetRow;
  const rv  = found.rowValues;

  const oldVendor = String(rv[COL.VENDOR - 1] || "").trim();
  const name      = String(rv[COL.NAME   - 1] || "").trim();

  // The target must already be in the item's eligible list.
  const eligible = normalizeEligibleList_(rv[COL.ELIGIBLE_VENDORS - 1], oldVendor);
  const eligibleLow = eligible.map(v => v.toLowerCase());
  if (eligibleLow.indexOf(newVendor.toLowerCase()) === -1) {
    throw new Error("\"" + newVendor + "\" is not in this item's eligible vendor list. " +
                    "Add it to the item first, then switch.");
  }

  if (newVendor.toLowerCase() === oldVendor.toLowerCase()) {
    return { ok: true, id: id, vendor: newVendor, area: "", needsArea: false, unchanged: true };
  }

  // Current storage area (under any vendor) so we can carry it over.
  const setup = getSheet_(SHEET_SETUP);
  const db    = readPickDb_(setup);
  let currentArea = "";
  for (let i = 0; i < db.length; i++) {
    if (String(db[i][1] || "").trim() === id && String(db[i][3] || "").trim()) {
      currentArea = String(db[i][3]).trim();
      break;
    }
  }

  // Flip the active vendor (column C). The eligible list (D) already contains
  // newVendor, so D needs no change.
  master.getRange(row, COL.VENDOR).setValue(newVendor);

  // Pick-path surgery: drop every row for this item (it should only ever live
  // under one vendor at a time), then re-add it under the new vendor if we
  // have an area to carry. Spans two vendors, so we edit the DB directly
  // rather than going through commitPickPathAreaAssignment (single-vendor).
  const kept = db.filter(r => String(r[1] || "").trim() !== id);

  let assignedArea = "";
  if (currentArea) {
    const areaOrderMap = getAreaOrderMap_();
    const areaOrder    = areaOrderMap.has(currentArea) ? areaOrderMap.get(currentArea) : 999;
    let   maxShelf     = 0;
    for (let j = 0; j < kept.length; j++) {
      if (String(kept[j][0] || "").trim().toLowerCase() === newVendor.toLowerCase() &&
          String(kept[j][3] || "").trim() === currentArea) {
        maxShelf = Math.max(maxShelf, Number(kept[j][5]) || 0);
      }
    }
    kept.push([newVendor, id, name, currentArea, areaOrder, maxShelf + 10]);
    assignedArea = currentArea;
  }
  writePickDb_(setup, kept);

  // Refresh the SETUP working list if either vendor is the one selected there.
  reloadSetupIfVendorMatches_(oldVendor);
  reloadSetupIfVendorMatches_(newVendor);

  return { ok: true, id: id, vendor: newVendor, area: assignedArea, needsArea: !assignedArea };
}




// One-time, idempotent backfill for the new Eligible Vendors column
// (MASTER_ITEMS column O). Sets the column-O header and seeds every item row's
// eligible list with the item's current active vendor (column C). SKU (column
// D) is left untouched. Reads self-heal regardless, so this is purely sheet
// hygiene -- it makes column O hold readable vendor names instead of blanks.
// Safe to re-run: a row already holding a normalized list is left unchanged.
// Run once per store from Ordering Guide -> Mobile API -> Migrate Item Vendors.
function migrateItemVendorsColumn() {
  const sh = getSheet_(SHEET_MASTER);
  sh.getRange(1, COL.ELIGIBLE_VENDORS).setValue("Eligible Vendors");

  const lastRow = sh.getLastRow();
  if (lastRow < 2) {
    SpreadsheetApp.getUi().alert("Eligible Vendors column header set. No item rows to seed.");
    return;
  }

  const vendorMap = new Map(getVendorList().map(v => [v.toLowerCase(), v]));
  const numRows   = lastRow - 1;
  const aVals  = sh.getRange(2, COL.ID,               numRows, 1).getValues();
  const cVals  = sh.getRange(2, COL.VENDOR,           numRows, 1).getValues();
  const oRange = sh.getRange(2, COL.ELIGIBLE_VENDORS, numRows, 1);
  const oVals  = oRange.getValues();

  let changed = 0;
  const out = [];
  for (let i = 0; i < numRows; i++) {
    const id = String(aVals[i][0] || "").trim();
    if (!/^ITEM-\d+$/i.test(id)) {       // leave non-item rows untouched
      out.push([oVals[i][0]]);
      continue;
    }
    const vendor     = String(cVals[i][0] || "").trim();
    const normalized = serializeEligibleVendors_(
      normalizeEligibleList_(oVals[i][0], vendor, vendorMap)
    );
    out.push([normalized]);
    if (String(oVals[i][0] == null ? "" : oVals[i][0]).trim() !== normalized) changed++;
  }

  oRange.setNumberFormat("@");   // plain text so pipe-delimited names aren't reformatted
  oRange.setValues(out);
  bumpServerMutationTs_();

  SpreadsheetApp.getUi().alert(
    "Eligible Vendors column seeded.\n\n" +
    changed + " row(s) set to their current active vendor.\n" +
    "Header set to \"Eligible Vendors\" (column O). Safe to re-run anytime."
  );
}








function commitDeactivateItem(itemId) {
  bumpServerMutationTs_();
  const id = String(itemId || "").trim();
  if (!id) throw new Error("Item ID is required.");
  const found = findItemRow_(id);
  if (!found) throw new Error("Item not found: " + id);
  const sh     = getSheet_(SHEET_MASTER);
  const r      = found.rowValues;
  const name   = String(r[COL.NAME   - 1] || "").trim();
  const vendor = String(r[COL.VENDOR - 1] || "").trim();




  // 1. Mark inactive in MASTER_ITEMS — column L already has validation applied.
  sh.getRange(found.sheetRow, COL.ACTIVE).setValue(false);




  // 2. Remove from pick path database so vendor tab stops showing it
  const setup    = getSheet_(SHEET_SETUP);
  const existing = readPickDb_(setup);
  const kept     = existing.filter(dbRow => String(dbRow[1] || "").trim() !== id);
  if (kept.length !== existing.length) writePickDb_(setup, kept);




  // 3. Reload SETUP working list so the vendor tab reflects the removal
  reloadSetupIfVendorMatches_(vendor);




  return { ok: true, name, id };
}








function commitDeleteItem(itemId) {
  bumpServerMutationTs_();
  const id = String(itemId || "").trim();
  if (!id) throw new Error("Item ID is required.");
  const found = findItemRow_(id);
  if (!found) throw new Error("Item not found: " + id);




  const r      = found.rowValues;
  const name   = String(r[COL.NAME   - 1] || "").trim();
  const vendor = String(r[COL.VENDOR - 1] || "").trim();




  const sh = getSheet_(SHEET_MASTER);
  sh.deleteRow(found.sheetRow);




  const lastDataRow = getLastItemRow_(sh);
  if (lastDataRow >= 3) {
    sh.getRange(2, 1, lastDataRow - 1, sh.getLastColumn()).sort([
      { column: COL.VENDOR, ascending: true },
      { column: COL.NAME,   ascending: true }
    ]);
  }




  const setup    = getSheet_(SHEET_SETUP);
  const existing = readPickDb_(setup);
  const kept     = existing.filter(dbRow => String(dbRow[1] || "").trim() !== id);
  if (kept.length !== existing.length) writePickDb_(setup, kept);




  // Reload vendor tab so the deleted item disappears immediately
  reloadSetupIfVendorMatches_(vendor);




  return { ok: true, name, vendor, id };
}








// ── Private helpers ──────────────────────────────────────────────────────
function getLastItemRow_(sheet) {
  const sh      = sheet || getSheet_(SHEET_MASTER);
  const lastRow = sh.getLastRow();
  if (lastRow < 2) return 1;
  // Read only used rows (bounded by getLastRow) instead of the full 1000-row column.
  const colA = sh.getRange(2, 1, lastRow - 1, 1).getValues();
  for (let i = colA.length - 1; i >= 0; i--) {
    if (/^ITEM-\d+$/i.test(String(colA[i][0] || "").trim())) return i + 2;
  }
  return 1;
}




function getLastRowForVendor_(sheet, vendor) {
  const sh      = sheet || getSheet_(SHEET_MASTER);
  const lastRow = sh.getLastRow();
  if (lastRow < 2) return -1;
  // Read only used rows (bounded by getLastRow) — was reading all 1000 rows of A:C.
  const data    = sh.getRange(2, 1, lastRow - 1, 3).getValues();
  const vLow    = vendor.toLowerCase();
  let foundRow  = -1;
  for (let i = 0; i < data.length; i++) {
    if (!String(data[i][0] || "").trim()) continue;
    if (String(data[i][2] || "").trim().toLowerCase() === vLow) foundRow = i + 2;
  }
  return foundRow;
}




function buildMasterIdLookup_() {
  const master  = getSheet_(SHEET_MASTER);
  const lastRow = master.getLastRow();
  if (lastRow < 2) return new Map();
  const data = master.getRange(2, 1, lastRow - 1, 3).getValues();
  const map  = new Map();
  for (const r of data) {
    const id     = String(r[0] || "").trim();
    const name   = String(r[1] || "").trim();
    const vendor = String(r[2] || "").trim();
    if (!id || !name || !vendor) continue;
    map.set(vendor.toLowerCase() + "||" + name.toLowerCase(), id);
  }
  return map;
}




function findItemRow_(query) {
  const sh      = getSheet_(SHEET_MASTER);
  const lastRow = sh.getLastRow();
  if (lastRow < 2) return null;
  const q = String(query || "").trim();
  if (!q) return null;
  const values = sh.getRange(2, 1, lastRow - 1, Math.max(COL.NOTES, COL.ACTIVE, COL.ELIGIBLE_VENDORS)).getValues();
  const qLower = q.toLowerCase();
  for (let i = 0; i < values.length; i++) {
    const id   = String(values[i][COL.ID   - 1] || "").trim();
    const name = String(values[i][COL.NAME - 1] || "").trim();
    if (id === q || name.toLowerCase() === qLower) {
      return { sheetRow: i + 2, rowValues: values[i] };
    }
  }
  return null;
}








/***********************
 * 6) STORAGE AREAS
 ***********************/
function readAreaBlock_(setup) {
  const rows  = AREA_TABLE.END_ROW - AREA_TABLE.START_ROW + 1;
  const range = setup.getRange(AREA_TABLE.START_ROW, AREA_TABLE.COL_AREA, rows, 2);
  return { range, rows, block: range.getValues() };
}




function getStorageAreaList() {
  const { block } = readAreaBlock_(getSheet_(SHEET_SETUP));
  return block
    .map(r => ({ name: String(r[0] || "").trim(), order: Number(r[1]) }))
    .filter(x => x.name !== "" && Number.isFinite(x.order))
    .sort((a, b) => a.order - b.order);
}




function writeAreaList_(setup, areas) {
  const { range, rows } = readAreaBlock_(setup);
  const out = Array.from({ length: rows }, (_, i) =>
    i < areas.length ? [areas[i].name, (i + 1) * 10] : ["", ""]
  );
  range.setValues(out);
}




function syncPickDbAreaOrders_(setup) {
  const existing = readPickDb_(setup);
  if (!existing.length) return;
  const areaOrderMap = getAreaOrderMap_();
  const updated = existing.map(r => {
    const area     = String(r[3] || "").trim();
    const newOrder = areaOrderMap.has(area) ? areaOrderMap.get(area) : Number(r[4]);
    return [r[0], r[1], r[2], r[3], newOrder, r[5]];
  });
  writePickDb_(setup, updated);
}




function getAreaOrderMap_() {
  const setup = getSheet_(SHEET_SETUP);
  return new Map(
    setup
      .getRange(AREA_TABLE.START_ROW, AREA_TABLE.COL_AREA, AREA_TABLE.END_ROW - AREA_TABLE.START_ROW + 1, 2)
      .getValues()
      .filter(r => String(r[0] || "").trim() !== "" && r[1] !== "")
      .map(r => [String(r[0]).trim(), Number(r[1])])
  );
}




function showStorageAreasSidebar() {
  const tmpl = HtmlService.createTemplateFromFile("StorageAreas");
  tmpl.areaListJson = JSON.stringify(getStorageAreaList());
  SpreadsheetApp.getUi().showModalDialog(
    tmpl.evaluate().setWidth(MODAL_SM_W).setHeight(MODAL_SM_H),
    "Storage Areas"
  );
}




// Single bulk commit for the Storage Areas modal's draft model. The modal
// stages every add / rename / delete / reorder locally and sends the desired
// final state here on Save. `finalList` is the ordered array the modal wants:
//   [{ origName, name }, ...]
//     - origName: the area's name at modal load (the stable identity handle),
//       or null/"" for an area added during this draft.
//     - name: the desired final name (differs from origName ⇒ rename).
// Deletions are implicit: any current area whose name isn't referenced by some
// entry's origName is being deleted. ALL validation runs before any write, so
// a rejected payload leaves the sheet untouched. (No transactions exist in
// Apps Script — if a later write throws mid-sequence the state can split; the
// modal recovers by refetching server truth on failure.)
function commitStorageAreasDraft(finalList) {
  bumpServerMutationTs_();
  if (!Array.isArray(finalList)) throw new Error("No areas provided.");

  const maxAreas = AREA_TABLE.END_ROW - AREA_TABLE.START_ROW + 1;
  if (finalList.length > maxAreas) {
    throw new Error("Too many areas — the maximum is " + maxAreas + ".");
  }

  const setup   = getSheet_(SHEET_SETUP);
  const current = getStorageAreaList();                       // [{name, order}]
  const currentByLower = new Map(current.map(a => [a.name.toLowerCase(), a.name]));

  // ── Validate the whole payload before touching the sheet ──
  const seenNames     = new Set();   // final names (lowercased) — must be unique
  const seenOrigNames = new Set();   // referenced origNames — no duplicate refs
  const renameMap     = new Map();   // currentNameLower -> newName (changed only)
  const keptOrigLower = new Set();   // current areas the payload keeps

  finalList.forEach(entry => {
    const name = String((entry && entry.name) || "").trim();
    if (!name) throw new Error("Area name cannot be blank.");
    const nameLower = name.toLowerCase();
    if (seenNames.has(nameLower)) throw new Error("\"" + name + "\" is listed twice.");
    seenNames.add(nameLower);

    const orig = String((entry && entry.origName) || "").trim();
    if (orig) {
      const origLower = orig.toLowerCase();
      if (!currentByLower.has(origLower)) {
        throw new Error("\"" + orig + "\" no longer exists — reopen the editor and try again.");
      }
      if (seenOrigNames.has(origLower)) throw new Error("\"" + orig + "\" is referenced twice.");
      seenOrigNames.add(origLower);
      keptOrigLower.add(origLower);
      if (origLower !== nameLower) renameMap.set(origLower, name);
    }
  });

  // Deletions: current areas not referenced by any kept origName.
  const deletedLower = new Set();
  current.forEach(a => {
    const low = a.name.toLowerCase();
    if (!keptOrigLower.has(low)) deletedLower.add(low);
  });

  // ── Pick DB reconcile (single pass: drop deleted rows, remap renamed) ──
  // Doing the remap via a map (not sequential renames) makes a name swap
  // (A→B, B→A) safe — each row is rewritten exactly once.
  const existingDb = readPickDb_(setup);
  let inUseCount = 0;
  const newDb = [];
  existingDb.forEach(r => {
    const areaLower = String(r[3] || "").trim().toLowerCase();
    if (deletedLower.has(areaLower)) { inUseCount++; return; }   // item loses its area
    if (renameMap.has(areaLower)) {
      newDb.push([r[0], r[1], r[2], renameMap.get(areaLower), r[4], r[5]]);
    } else {
      newDb.push(r);
    }
  });
  if (deletedLower.size > 0 || renameMap.size > 0) writePickDb_(setup, newDb);

  // Remap the in-sheet Pick Path List area column (SETUP rows 21+, col B) for
  // renames, so the live sheet view doesn't show a stale name before the next
  // pick-path rebuild. Deletes are left for the rebuild to clean (matching the
  // previous per-action delete behavior — the pick DB drop above is the
  // source of truth).
  if (renameMap.size > 0) {
    const listLast = setup.getRange("D:D").getLastRow();
    if (listLast >= SETUP_LIST_START_ROW) {
      const areaRange = setup.getRange(SETUP_LIST_START_ROW, 2, listLast - SETUP_LIST_START_ROW + 1, 1);
      areaRange.setValues(
        areaRange.getValues().map(r => {
          const v      = String(r[0] || "").trim();
          const mapped = renameMap.get(v.toLowerCase());
          return [mapped ? mapped : v];
        })
      );
    }
  }

  // Write the area block in the payload's order (writeAreaList_ assigns
  // order = (i+1)*10), then re-sync those orders into the pick DB.
  writeAreaList_(setup, finalList.map(entry => ({ name: String(entry.name).trim() })));
  syncPickDbAreaOrders_(setup);

  return {
    ok:           true,
    inUseCount:   inUseCount,
    deletedCount: deletedLower.size,
    savedCount:   finalList.length
  };
}








/***********************
 * 7) PICK PATH DATABASE
 ***********************/
function getLastWrittenPickDbRow_(setup) {
  const sh      = setup || getSheet_(SHEET_SETUP);
  const lastRow = sh.getLastRow();
  // getLastRow() returns the bottom of the most-populated column on the sheet,
  // which is always >= column K's last written row. Scan only that bounded
  // range instead of the full maxRows (typically 1000+) for column K.
  if (lastRow < PICKDB.START_ROW) return PICKDB.START_ROW - 1;

  const numRows = lastRow - PICKDB.START_ROW + 1;
  const values  = sh
    .getRange(PICKDB.START_ROW, PICKDB.START_COL, numRows, 1)
    .getValues();

  for (let i = values.length - 1; i >= 0; i--) {
    if (String(values[i][0] || "").trim() !== "") {
      return PICKDB.START_ROW + i;
    }
  }
  return PICKDB.START_ROW - 1;
}




function readPickDb_(setupSheet) {
  const setup   = setupSheet || getSheet_(SHEET_SETUP);
  const lastRow = getLastWrittenPickDbRow_(setup);
  if (lastRow < PICKDB.START_ROW) return [];
  return setup
    .getRange(PICKDB.START_ROW, PICKDB.START_COL, lastRow - PICKDB.START_ROW + 1, PICKDB.NUM_COLS)
    .getValues();
}




function writePickDb_(setupSheet, rows) {
  const setup   = setupSheet || getSheet_(SHEET_SETUP);
  const lastRow = getLastWrittenPickDbRow_(setup);




  if (lastRow >= PICKDB.START_ROW) {
    const clearCount = lastRow - PICKDB.START_ROW + 1;
    setup
      .getRange(PICKDB.START_ROW, PICKDB.START_COL, clearCount, PICKDB.NUM_COLS)
      .clearContent();
  }




  if (rows.length) {
    setup
      .getRange(PICKDB.START_ROW, PICKDB.START_COL, rows.length, PICKDB.NUM_COLS)
      .setValues(rows);
  }
}








/***********************
 * 8) PICK PATH LOGIC
 ***********************/
function rebuildAllPickPaths_() {
  bumpServerMutationTs_();
  const setup        = getSheet_(SHEET_SETUP);
  const master       = getSheet_(SHEET_MASTER);
  const areaOrderMap = getAreaOrderMap_();
  const vendors      = getVendorList();
  if (!vendors.length) return;




  const existingDb    = readPickDb_(setup);
  const masterLastRow = master.getLastRow();
  if (masterLastRow < 2) return;
  const masterData = master.getRange(2, 1, masterLastRow - 1, COL.ACTIVE).getValues();




  const dbByVendor = new Map();
  for (const r of existingDb) {
    const v = String(r[0] || "").trim();
    if (!v) continue;
    if (!dbByVendor.has(v)) dbByVendor.set(v, []);
    dbByVendor.get(v).push(r);
  }




  const newDb = [];




  vendors.forEach(vendor => {
    const vendorRows = dbByVendor.get(vendor) || [];




    const savedMap   = new Map();
    const savedOrder = new Map();
    for (const r of vendorRows) {
      const itemId = String(r[1] || "").trim();
      if (!itemId) continue;
      savedMap.set(itemId, String(r[3] || "").trim());
      savedOrder.set(itemId, { areaOrder: Number(r[4]), shelfOrder: Number(r[5]) });
    }




    const items = masterData
      .filter(r => String(r[COL.VENDOR - 1] || "").trim() === vendor && r[COL.ACTIVE - 1] === true)
      .map(r => ({
        id:   String(r[COL.ID   - 1] || "").trim(),
        name: String(r[COL.NAME - 1] || "").trim(),
        area: savedMap.get(String(r[COL.ID - 1] || "").trim()) || ""
      }))
      .filter(x => x.id && x.name && x.area);




    if (!items.length) return;




    items.sort((a, b) => {
      const ao = areaOrderMap.get(a.area) ?? 999;
      const bo = areaOrderMap.get(b.area) ?? 999;
      if (ao !== bo) return ao - bo;
      const so = savedOrder.get(a.id)?.shelfOrder ?? 999999;
      const to = savedOrder.get(b.id)?.shelfOrder ?? 999999;
      return so - to;
    });




    const counters = new Map();
    items.forEach(x => {
      const count = (counters.get(x.area) || 0) + 1;
      counters.set(x.area, count);
      newDb.push([vendor, x.id, x.name, x.area, areaOrderMap.get(x.area) ?? 999, count * 10]);
    });
  });




  const itemsWithArea = new Set(newDb.map(r => String(r[1] || "").trim()));
  for (const r of existingDb) {
    const itemId = String(r[1] || "").trim();
    if (itemId && !itemsWithArea.has(itemId)) newDb.push(r);
  }




  writePickDb_(setup, newDb);
}








function loadSetupVendorItems_() {
  const setup  = getSheet_(SHEET_SETUP);
  const master = getSheet_(SHEET_MASTER);




  const vendor = normalizeVendorOrThrow_(setup.getRange(SETUP_VENDOR_CELL).getDisplayValue());
  if (!vendor) return;




  // Clear the working list area (cols A, B, D for rows 21+).
  // Column C is unused in this region, so a single A:D clear is safe and
  // replaces three separate getLastRow + clearContent operations.
  const lastListRow = setup.getLastRow();
  if (lastListRow >= SETUP_LIST_START_ROW) {
    setup
      .getRange(SETUP_LIST_START_ROW, 1, lastListRow - SETUP_LIST_START_ROW + 1, 4)
      .clearContent();
  }




  const saved = readPickDb_(setup);




  const savedMap   = new Map();
  const savedOrder = new Map();
  for (const r of saved) {
    const v      = String(r[0] || "").trim();
    const itemId = String(r[1] || "").trim();
    if (v !== vendor || !itemId) continue;
    savedMap.set(itemId, String(r[3] || "").trim());
    savedOrder.set(itemId, { areaOrder: Number(r[4]), shelfOrder: Number(r[5]) });
  }
  const hasSaved = savedOrder.size > 0;




  const lastRow = master.getLastRow();
  if (lastRow < 2) return;




  const items = master
    .getRange(2, 1, lastRow - 1, COL.ACTIVE)
    .getValues()
    .filter(r => String(r[COL.VENDOR - 1] || "").trim() === vendor && r[COL.ACTIVE - 1] === true)
    .map(r => ({
      id:   String(r[COL.ID   - 1] || "").trim(),
      name: String(r[COL.NAME - 1] || "").trim(),
      area: ""
    }))
    .filter(x => x.id && x.name)
    .map(x => ({ ...x, area: savedMap.get(x.id) || "" }));




  if (!items.length) return;




  items.sort((a, b) => {
    if (!hasSaved) return a.name.localeCompare(b.name);
    const ao = savedOrder.get(a.id)?.areaOrder  ?? 999;
    const bo = savedOrder.get(b.id)?.areaOrder  ?? 999;
    if (ao !== bo) return ao - bo;
    const so = savedOrder.get(a.id)?.shelfOrder ?? 999999;
    const to = savedOrder.get(b.id)?.shelfOrder ?? 999999;
    if (so !== to) return so - to;
    return a.name.localeCompare(b.name);
  });




  setup.getRange(SETUP_LIST_START_ROW, 1, items.length, 1).setValues(items.map(x => [x.name]));
  setup.getRange(SETUP_LIST_START_ROW, 2, items.length, 1).setValues(items.map(x => [x.area]));
  const idRange = setup.getRange(SETUP_LIST_START_ROW, 4, items.length, 1);
  idRange.setNumberFormat("@");
  idRange.setValues(items.map(x => [x.id]));




  const missingArea = items.filter(x => !x.area);
  if (missingArea.length > 0) {
    SpreadsheetApp.getUi().alert(
      "Action Required: Missing Storage Areas",
      "The following " + missingArea.length + " item(s) have no Storage Area assigned.\n" +
      "They will NOT appear on the order sheet until you set one in column B:\n\n" +
      missingArea.map(x => "  - " + x.name).join("\n") + "\n\n" +
      "Assign a Storage Area -- it will save to the pick path automatically\n" +
      "(as long as On Hand is clear on the vendor tab).",
      SpreadsheetApp.getUi().ButtonSet.OK
    );
  }
}








function savePickPathSilent_(vendor) {
  const setup        = getSheet_(SHEET_SETUP);
  const areaOrderMap = getAreaOrderMap_();
  if (setup.getLastRow() < SETUP_LIST_START_ROW) return;
  const result = buildPickPathRows_(vendor, setup, areaOrderMap);
  if (!result.saved.length) return;
  const existing = readPickDb_(setup);
  const kept     = existing.filter(r => String(r[0] || "").trim() !== vendor);
  writePickDb_(setup, kept.concat(result.saved));
}








function buildPickPathRows_(vendor, setup, areaOrderMap) {
  const idLookup = buildMasterIdLookup_();
  const lastRow  = setup.getLastRow();
  const data     = setup.getRange(SETUP_LIST_START_ROW, 1, lastRow - SETUP_LIST_START_ROW + 1, 4).getValues();




  const saved    = [];
  const skipped  = [];
  const counters = new Map();




  data.forEach((r, i) => {
    const name = String(r[0] || "").trim();
    const area = String(r[1] || "").trim();
    let   id   = String(r[3] || "").trim();




    if (!name) return;




    if (!id) {
      id = idLookup.get(vendor.toLowerCase() + "||" + name.toLowerCase()) || "";
      if (id) setup.getRange(SETUP_LIST_START_ROW + i, 4).setValue(id);
    }




    if (!id) return;
    if (!area) { skipped.push(name); return; }




    const count = (counters.get(area) || 0) + 1;
    counters.set(area, count);
    saved.push([vendor, id, name, area, areaOrderMap.get(area) ?? 999, count * 10]);
  });




  return { saved, skipped };
}








function reloadSetupIfVendorMatches_(savedVendor) {
  try {
    const setup          = getSheet_(SHEET_SETUP);
    const selectedVendor = String(setup.getRange(SETUP_VENDOR_CELL).getDisplayValue()).trim();
    if (!selectedVendor) return;
    if (String(savedVendor || "").trim().toLowerCase() === selectedVendor.toLowerCase()) {
      loadSetupVendorItems_();
    }
  } catch (err) { console.error('reloadSetupIfVendorMatches_:', err); }
}








function commitPickPathAreaAssignment(itemId, vendor, areaName) {
  bumpServerMutationTs_();
  const id = String(itemId  || "").trim();
  if (!id)       throw new Error("Item ID is required.");
  if (!vendor)   throw new Error("Vendor is required.");
  if (!areaName) throw new Error("Storage Area is required.");




  const setup        = getSheet_(SHEET_SETUP);
  const areaOrderMap = getAreaOrderMap_();




  if (!areaOrderMap.has(areaName)) {
    throw new Error("\"" + areaName + "\" is not a recognised Storage Area.");
  }




  const existing = readPickDb_(setup);
  const vLow     = String(vendor).trim().toLowerCase();




  const kept = existing.filter(r =>
    !(String(r[0] || "").trim().toLowerCase() === vLow &&
      String(r[1] || "").trim() === id)
  );




  const areaRows = kept.filter(r =>
    String(r[0] || "").trim().toLowerCase() === vLow &&
    String(r[3] || "").trim() === areaName
  );
  const maxShelf = areaRows.reduce((max, r) => Math.max(max, Number(r[5]) || 0), 0);




  const found = findItemRow_(id);
  const name  = found ? String(found.rowValues[COL.NAME - 1] || "").trim() : id;




  kept.push([
    String(vendor).trim(),
    id,
    name,
    areaName,
    areaOrderMap.get(areaName),
    maxShelf + 10
  ]);




  writePickDb_(setup, kept);
  reloadSetupIfVendorMatches_(String(vendor).trim());




  return { ok: true, id, vendor, area: areaName };
}








/***********************
 * 9) PICK PATH SIDEBAR
 ***********************/
function showReorderPickPathSidebar() {
  const setup   = getSheet_(SHEET_SETUP);
  const vendors = getVendorList();
  if (!vendors.length) {
    SpreadsheetApp.getUi().alert("No vendors found. Add a vendor first.");
    return;
  }




  const b2Vendor = String(setup.getRange(SETUP_VENDOR_CELL).getDisplayValue()).trim();
  const vendor   = (b2Vendor && vendors.includes(b2Vendor)) ? b2Vendor : vendors[0];




  const data = getPickPathForSidebar(vendor);
  const tmpl = HtmlService.createTemplateFromFile("ReorderPickPath");
  tmpl.pickDataJson   = JSON.stringify(data);
  tmpl.vendorListJson = JSON.stringify(vendors);
  SpreadsheetApp.getUi().showModalDialog(
    tmpl.evaluate().setWidth(MODAL_SM_W).setHeight(MODAL_SM_H),
    "Pick Path"
  );
}




function getPickPathForSidebar(vendor) {
  const setup        = getSheet_(SHEET_SETUP);
  const master       = getSheet_(SHEET_MASTER);
  const areaOrderMap = getAreaOrderMap_();
  const db           = readPickDb_(setup);
  const vLow         = String(vendor || "").trim().toLowerCase();




  const dbRows = db
    .filter(r => String(r[0] || "").trim().toLowerCase() === vLow && String(r[1] || "").trim())
    .map(r => ({
      id:         String(r[1] || "").trim(),
      name:       String(r[2] || "").trim(),
      area:       String(r[3] || "").trim(),
      areaOrder:  Number(r[4]),
      shelfOrder: Number(r[5])
    }));




  const assignedIds = new Set(dbRows.filter(r => r.area).map(r => r.id));




  const masterLastRow = master.getLastRow();
  const unassigned = [];
  if (masterLastRow >= 2) {
    master.getRange(2, 1, masterLastRow - 1, COL.ACTIVE).getValues()
      .filter(r => String(r[COL.VENDOR - 1] || "").trim() === String(vendor).trim()
               && r[COL.ACTIVE - 1] === true)
      .forEach(r => {
        const id   = String(r[COL.ID   - 1] || "").trim();
        const name = String(r[COL.NAME - 1] || "").trim();
        if (id && name && !assignedIds.has(id)) {
          unassigned.push({ id, name });
        }
      });
  }




  const sorted = dbRows
    .filter(r => r.area)
    .sort((a, b) => {
      if (a.areaOrder !== b.areaOrder) return a.areaOrder - b.areaOrder;
      return a.shelfOrder - b.shelfOrder;
    });




  const groupMap   = new Map();
  const groupOrder = [];
  for (const r of sorted) {
    if (!groupMap.has(r.area)) { groupMap.set(r.area, []); groupOrder.push(r.area); }
    groupMap.get(r.area).push({ id: r.id, name: r.name });
  }




  const knownAreaNames = new Set(groupOrder);
  const emptyAreas = Array.from(areaOrderMap.entries())
    .sort((a, b) => a[1] - b[1])
    .filter(([area]) => !knownAreaNames.has(area));




  const groups = [
    ...groupOrder.map(area => ({
      area,
      areaOrder: areaOrderMap.get(area) ?? 999,
      items:     groupMap.get(area)
    })),
    ...emptyAreas.map(([area, order]) => ({
      area,
      areaOrder: order,
      items:     []
    }))
  ];




  return { vendor: String(vendor).trim(), unassigned, groups };
}




function commitReorderPickPath(vendor, payload) {
  bumpServerMutationTs_();
  if (!vendor) throw new Error("Vendor is required.");
  if (!Array.isArray(payload) || !payload.length) throw new Error("No items provided.");




  const setup        = getSheet_(SHEET_SETUP);
  const areaOrderMap = getAreaOrderMap_();




  const counters = new Map();
  const newRows  = payload
    .filter(x => x.id && x.area)
    .map(x => {
      const count = (counters.get(x.area) || 0) + 1;
      counters.set(x.area, count);
      return [
        vendor,
        x.id,
        x.name,
        x.area,
        areaOrderMap.get(x.area) ?? 999,
        count * 10
      ];
    });




  const existing = readPickDb_(setup);
  const vLow     = vendor.toLowerCase();
  const kept     = existing.filter(r => String(r[0] || "").trim().toLowerCase() !== vLow);
  writePickDb_(setup, kept.concat(newRows));




  reloadSetupIfVendorMatches_(vendor);




  return { ok: true, count: newRows.length };
}








/***********************
 * 10) ADMIN
 ***********************/
function toggleSetupTabVisibility() {
  const ui    = SpreadsheetApp.getUi();
  const setup = getSheet_(SHEET_SETUP);
  const hidden = setup.isSheetHidden();
  if (hidden) {
    setup.showSheet();
    ui.alert("SETUP tab is now visible.");
  } else {
    setup.hideSheet();
    ui.alert("SETUP tab is now hidden.");
  }
}




function toggleMasterItemsTabVisibility() {
  const ui     = SpreadsheetApp.getUi();
  const master = getSheet_(SHEET_MASTER);
  const hidden = master.isSheetHidden();
  if (hidden) {
    master.showSheet();
    ui.alert("MASTER_ITEMS tab is now visible.");
  } else {
    master.hideSheet();
    ui.alert("MASTER_ITEMS tab is now hidden.");
  }
}




function showAdminResetSidebar() {
  SpreadsheetApp.getUi().showModalDialog(
    HtmlService.createTemplateFromFile("AdminReset").evaluate()
      .setWidth(MODAL_SM_W).setHeight(MODAL_SM_H),
    "Admin Reset"
  );
}




/**
 * Selectively clears only the components checked in the AdminReset sidebar.
 *
 * @param {Object} options
 *   options.pickPathDb   {boolean} - Clear hidden pick path DB (SETUP K:P)
 *   options.pickPathList {boolean} - Clear working pick path list (SETUP rows 21+, cols A/B/D)
 *   options.vendors      {boolean} - Clear vendor table rows (SETUP R + S:Y) and name list (Z)
 *   options.areas        {boolean} - Clear storage area table (SETUP H:I rows 2-19)
 *   options.orderLog     {boolean} - Clear all rows in LOG_ORDERS (preserves header)
 */
function commitSelectiveReset(options) {
  bumpServerMutationTs_();
  if (!options) throw new Error("No options provided.");




  const setup  = getSheet_(SHEET_SETUP);
  const result = {
    clearedDb:       false,
    clearedList:     false,
    clearedVendors:  false,
    clearedAreas:    false,
    clearedOrderLog: false
  };




  // 1. Pick Path DB (SETUP K:P)
  if (options.pickPathDb) {
    writePickDb_(setup, []);
    result.clearedDb = true;
  }




  // 2. Pick Path List (SETUP rows 21+, cols A/B/D)
  if (options.pickPathList) {
    const listLastRow = setup.getLastRow();
    if (listLastRow >= SETUP_LIST_START_ROW) {
      const numListRows = listLastRow - SETUP_LIST_START_ROW + 1;
      setup.getRange(SETUP_LIST_START_ROW, 1, numListRows, 2).clearContent();
      setup.getRange(SETUP_LIST_START_ROW, 4, numListRows, 1).clearContent();
    }
    result.clearedList = true;
  }




  // 3. Vendor Table + Name List (SETUP R + S:Y + Z)
  if (options.vendors) {
    // Find the actual last row used by the vendor list (column Z) instead of
    // using the sheet's overall lastRow — which is usually dominated by the
    // pick path DB (column K) and would clear hundreds of empty rows.
    const sheetLastRow = setup.getLastRow();
    let vendorLastRow  = VENDOR_TABLE.START_ROW - 1;
    if (sheetLastRow >= 2) {
      const zVals = setup.getRange(2, VENDOR_LIST_COL, sheetLastRow - 1, 1).getValues();
      for (let i = zVals.length - 1; i >= 0; i--) {
        if (String(zVals[i][0] || "").trim() !== "") {
          vendorLastRow = i + 2;
          break;
        }
      }
    }
    if (vendorLastRow >= VENDOR_TABLE.START_ROW) {
      const numVendorRows = vendorLastRow - VENDOR_TABLE.START_ROW + 1;
      setup.getRange(VENDOR_TABLE.START_ROW, VENDOR_TABLE.VENDOR_COL, numVendorRows, 1).clearContent();
      setup.getRange(VENDOR_TABLE.START_ROW, VENDOR_TABLE.MULT_COL,   numVendorRows, 7).clearContent();
      setup.getRange(2,                      VENDOR_LIST_COL,          numVendorRows, 1).clearContent();
    }
    result.clearedVendors = true;
  }




  // 4. Storage Areas (SETUP H:I rows 2-19)
  if (options.areas) {
    const { range: areaRange } = readAreaBlock_(setup);
    areaRange.clearContent();
    result.clearedAreas = true;
  }




  // 5. Order Log (LOG_ORDERS data rows only — header preserved)
  if (options.orderLog) {
    const res = clearOrderLog();
    result.clearedOrderLog = res.ok;
  }




  return result;
}








/***********************
 * 11) ORDER LOG
 ***********************/




// Creates LOG_ORDERS if it doesn't exist, writes headers, hides + protects it.
function ensureLogSheet_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let   sh = ss.getSheetByName(SHEET_ORDER_LOG);




  if (!sh) {
    sh = ss.insertSheet(SHEET_ORDER_LOG);
    sh.getRange(1, 1, 1, 7).setValues([[
      "Timestamp", "Order Date", "Vendor",
      "Item ID", "Item Name", "On Hand (Prev)", "Qty Ordered"
    ]]);
    sh.setFrozenRows(1);
    sh.hideSheet();




    const prot = sh.protect().setDescription("LOG_ORDERS — append-only, do not edit manually");
    prot.removeEditors(prot.getEditors());
  }




  return sh;
}




// Reads the selected order date from ORDER_ENTRY.
// Returns a "yyyy-MM-dd" string, or today's date as fallback.
// Reads the active order date from ORDER_ENTRY.
// Returns the LAST RESET DATE (AE9) — the day this ordering cycle belongs
// to. Falls back to AE2 (=TODAY()) if AE9 is blank (fresh setup, never
// reset). Returns "yyyy-MM-dd".
//
// This is the date that gets stamped onto every LOG_ORDERS row when reset
// runs. It's also the date the duplicate guard keys off, which means a
// second reset on the same calendar day (after AE9 has been advanced)
// won't false-positive against the prior cycle's log entry.
function getLogOrderDate_() {
  const ss  = SpreadsheetApp.getActiveSpreadsheet();
  const oe  = ss.getSheetByName(SHEET_ORDER_ENTRY);
  const tz  = ss.getSpreadsheetTimeZone();

  if (!oe) return Utilities.formatDate(new Date(), tz, "yyyy-MM-dd");

  // Try AE9 (last reset date) first
  const resetRaw = oe.getRange(LAST_RESET_DATE_CELL).getValue();
  if (resetRaw instanceof Date && !isNaN(resetRaw.getTime())) {
    return Utilities.formatDate(resetRaw, tz, "yyyy-MM-dd");
  }

  // Fall back to AE2 (=TODAY()) if AE9 is blank or invalid
  const todayRaw = oe.getRange(ORDER_ENTRY_DATE_CELL).getValue();
  if (!todayRaw) return Utilities.formatDate(new Date(), tz, "yyyy-MM-dd");

  const d = (todayRaw instanceof Date) ? todayRaw : new Date(todayRaw);
  return isNaN(d.getTime())
    ? String(todayRaw).trim()
    : Utilities.formatDate(d, tz, "yyyy-MM-dd");
}




// Property key for the most recent log date — lets the duplicate guard
// short-circuit without scanning the entire LOG_ORDERS date column.
const LAST_LOG_DATE_PROP = "LAST_LOG_DATE";




// Returns true if LOG_ORDERS already has an entry for orderDate (duplicate guard).
// Fast path: check the LAST_LOG_DATE document property (O(1)).
// Fallback: scan the date column if the property is missing/stale, then update it.
function hasLogEntryForDate_(logSheet, orderDate) {
  const props      = PropertiesService.getDocumentProperties();
  const cachedDate = props.getProperty(LAST_LOG_DATE_PROP);
  if (cachedDate && cachedDate === orderDate) return true;

  const lastRow = logSheet.getLastRow();
  if (lastRow < 2) return false;

  const tz  = SpreadsheetApp.getActiveSpreadsheet().getSpreadsheetTimeZone();
  const dates = logSheet
    .getRange(2, LOG_COL.ORDER_DATE, lastRow - 1, 1)
    .getValues()
    .flat();

  const fmt = (v) => {
    if (!v) return "";
    const d = (v instanceof Date) ? v : new Date(v);
    return isNaN(d.getTime()) ? String(v).trim() : Utilities.formatDate(d, tz, "yyyy-MM-dd");
  };

  // Track newest date seen during the scan so we can refresh the cache.
  let newest = "";
  let found  = false;
  for (let i = 0; i < dates.length; i++) {
    const d = fmt(dates[i]);
    if (d === orderDate) found = true;
    if (d > newest) newest = d;
  }
  // Refresh the cache so future calls hit the fast path. If cache was stale
  // (e.g. someone cleared the log manually) this rebuilds it.
  if (newest && newest !== cachedDate) {
    props.setProperty(LAST_LOG_DATE_PROP, newest);
  }
  return found;
}




// Sweeps all vendor tabs and returns log rows for items where Suggested Qty > 0.
// ⚠ Verify column positions match your VENDOR_TEMPLATE before deploying.
function snapshotVendorOrders_(orderDate, timestamp) {
  const ss      = SpreadsheetApp.getActiveSpreadsheet();
  const vendors = getVendorList();
  const rows    = [];




  // Column layout based on actual VENDOR_TEMPLATE structure:
  // A(1)=Item Name, B(2)=Pack, E(5)=On Hand, F(6)=Suggested Order Qty
  // M(13)=Item ID (hidden, pulled from SETUP pick path via SORT/FILTER formula)
  // Read range must extend to col 13 to capture Item ID from M.
  const VTAB_ITEM_NAME_COL  = 1;  // A — Item Name
  const VTAB_ITEM_ID_COL    = 13; // M — Item ID (hidden column)
  const VTAB_ON_HAND_COL    = VENDOR_TAB.ON_HAND_COL; // E (5)
  const VTAB_SUGGESTED_COL  = 6;  // F — Suggested Order Qty
  const VTAB_READ_TO_COL    = 13; // must be >= largest column we need (M)




  vendors.forEach(vendor => {
    const sh = ss.getSheetByName(vendor);
    if (!sh) return;




    const lastRow = sh.getLastRow();
    if (lastRow < VENDOR_TAB.DATA_START_ROW) return;




    const numRows = lastRow - VENDOR_TAB.DATA_START_ROW + 1;
    const data    = sh
      .getRange(VENDOR_TAB.DATA_START_ROW, 1, numRows, VTAB_READ_TO_COL)
      .getValues();




    data.forEach(r => {
      const itemName  = String(r[VTAB_ITEM_NAME_COL - 1] || "").trim();
      const itemId    = String(r[VTAB_ITEM_ID_COL   - 1] || "").trim();
      const onHand    = r[VTAB_ON_HAND_COL   - 1];
      const suggested = r[VTAB_SUGGESTED_COL - 1];




      if (!itemName) return;




      const onHandNum    = Number(onHand)    || 0;
      const suggestedNum = Number(suggested) || 0;




      if (suggestedNum <= 0) return;




      rows.push([timestamp, orderDate, vendor, itemId || "", itemName, onHandNum, suggestedNum]);
    });
  });




  return rows;
}




// Clears column E (On Hand) on every vendor tab, rows DATA_START_ROW+.
function resetAllVendorOnHand_() {
  const ss      = SpreadsheetApp.getActiveSpreadsheet();
  const vendors = getVendorList();




  vendors.forEach(vendor => {
    const sh = ss.getSheetByName(vendor);
    if (!sh) return;




    const lastRow = sh.getLastRow();
    if (lastRow < VENDOR_TAB.DATA_START_ROW) return;




    sh.getRange(
      VENDOR_TAB.DATA_START_ROW,
      VENDOR_TAB.ON_HAND_COL,
      lastRow - VENDOR_TAB.DATA_START_ROW + 1,
      1
    ).clearContent();
  });
}




// ── PUBLIC ENTRY POINT — called by the "Reset On Hand" button ─────────────────
// 1. Shows a confirm dialog so the KM doesn't accidentally reset.
// 2. Logs the order snapshot (once per day — duplicate guard built in).
// 3. Clears On Hand on all vendor tabs.
// 4. Writes today's date to ORDER_ENTRY B3 (Last Reset Date).
//    B3 has conditional formatting: green = today, red = before today.
function resetOnHandAllVendors() {
  const ui  = SpreadsheetApp.getUi();
  const ss  = SpreadsheetApp.getActiveSpreadsheet();
  const tz  = ss.getSpreadsheetTimeZone();




  // ── Confirm dialog ───────────────────────────────────────────────────────
  const confirm = ui.alert(
    "Reset On Hand?",
    "This will:\n" +
    "  • Email the daily order recap to all active recipients\n" +
    "  • Log today's order to Order History\n" +
    "  • Clear On Hand on ALL vendor tabs\n\n" +
    "Make sure you have already submitted your orders to the vendor before continuing.\n\n" +
    "Continue?",
    ui.ButtonSet.YES_NO
  );




  if (confirm !== ui.Button.YES) return; // user cancelled




  // ── Run log + reset ──────────────────────────────────────────────────────
  // The recap email is now sent inside commitLogAndReset (deduped via
  // MOG_LAST_RECAP_SENT_DATE), so every reset path — this sheet menu, the
  // PWA reset button, and the PWA new-day auto-reset — emails exactly once
  // per cycle. result.emailResult carries the status for the message below.
  const result      = commitLogAndReset();
  const emailResult = result.emailResult || null;




  // ── Write today's date to B3 (Last Reset Date) and auto-clear override ──
  const oe = ss.getSheetByName(SHEET_ORDER_ENTRY);
  if (oe) {
    const today = new Date();
    // Write as a date value so conditional formatting (Date is today / before today) works correctly
    oe.getRange(LAST_RESET_DATE_CELL).setValue(today);

    // Reset the emergency override checkbox if it was on. Override is
    // intended for one-off emergency-only days; reset = "back to normal."
    // Also bump the property so the day-rollover guard doesn't redundantly
    // clear it again on next open.
    const overrideRange = oe.getRange(EMERGENCY_OVERRIDE_CELL);
    if (overrideRange.getValue() === true) {
      overrideRange.setValue(false);
      const todayStr = Utilities.formatDate(today, tz, "yyyy-MM-dd");
      PropertiesService.getDocumentProperties()
        .setProperty(EMERGENCY_OVERRIDE_LASTDATE_PROP, todayStr);
    }
  }




  // ── Confirmation message ─────────────────────────────────────────────────
  // Compose the email-status line first so both result branches share it.
  let emailLine = '';
  if (emailResult) {
    if (emailResult.sent !== undefined && emailResult.sent > 0) {
      emailLine = '✓ Recap email sent to ' + emailResult.sent + ' recipient(s)';
      if (emailResult.failed) emailLine += ' (' + emailResult.failed + ' failed — see logs)';
      emailLine += '.\n';
    } else if (emailResult.skipped === 'already-sent-this-cycle') {
      emailLine = '✓ Recap email already sent earlier today — skipped.\n';
    } else if (emailResult.skipped === 'no-recipients') {
      emailLine = '⚠ No active recipients configured — email not sent.\n';
    } else if (emailResult.skipped === 'no-items-to-recap') {
      emailLine = '⚠ Nothing to recap (no items to order) — email not sent.\n';
    } else if (emailResult.error) {
      emailLine = '⚠ Recap email error: ' + emailResult.error + '\n';
    } else if (emailResult.failed && !emailResult.sent) {
      emailLine = '⚠ Recap email failed for all recipients — see logs.\n';
    }
  }

  if (result.logged) {
    ui.alert(
      "Reset Complete",
      emailLine +
      "✓ Order logged: " + result.rowsLogged + " item(s) saved to Order History.\n" +
      "✓ On Hand cleared on all vendor tabs.\n" +
      "✓ Last Reset Date updated to today.",
      ui.ButtonSet.OK
    );
  } else {
    ui.alert(
      "Reset Complete",
      emailLine +
      "✓ On Hand cleared on all vendor tabs.\n" +
      "✓ Last Reset Date updated to today.\n\n" +
      "Note: " + (result.skippedReason || "Already logged today — no duplicate log entry created."),
      ui.ButtonSet.OK
    );
  }
}




// Core log + reset logic. Called by resetOnHandAllVendors().
// Returns { logged, orderDate, rowsLogged, skippedReason? }
function commitLogAndReset() {
  bumpServerMutationTs_();
  const ss        = SpreadsheetApp.getActiveSpreadsheet();
  const tz        = ss.getSpreadsheetTimeZone();
  const timestamp = new Date();
  const orderDate = getLogOrderDate_();
  const logSheet  = ensureLogSheet_();

  // Overwrite policy: if LOG_ORDERS already has entries for the current
  // order date, delete them before re-snapshotting. This means a same-day
  // re-reset always produces a single fresh entry instead of duplicates,
  // and it ensures the log reflects the most recently-finalized state.
  //
  // The old duplicate-guard behavior (skip if exists) caused a bug where
  // the home dashboard saw stale 'sent' status for vendors after a same-
  // day reset, because the prior reset's rows still lived in LOG_ORDERS
  // even though on-hand had been cleared.
  const deletedCount = deleteLogEntriesForDate_(logSheet, orderDate);

  // Snapshot all vendor tabs
  const rows = snapshotVendorOrders_(orderDate, timestamp);

  // Append to LOG_ORDERS
  if (rows.length > 0) {
    const startRow = logSheet.getLastRow() + 1;
    logSheet
      .getRange(startRow, 1, rows.length, rows[0].length)
      .setValues(rows);
    // Cache the date so the next duplicate-guard call (used elsewhere)
    // can short-circuit. We keep this property up to date even with the
    // new overwrite semantics so callers depending on it stay correct.
    PropertiesService.getDocumentProperties().setProperty(LAST_LOG_DATE_PROP, orderDate);
  }

  // Send the daily recap email BEFORE clearing on-hand — the email is
  // built from the live on-hand values, so it must run while they're still
  // populated. Deduped via MOG_LAST_RECAP_SENT_DATE so calling reset from
  // multiple paths (sheet menu, PWA button, PWA new-day auto-reset) sends
  // at most one email per cycle. Never blocks the reset on email failure.
  const emailResult = sendRecapIfUnsent_();

  // Reset On Hand after logging + emailing
  resetAllVendorOnHand_();

  return {
    logged:        rows.length > 0,
    orderDate,
    rowsLogged:    rows.length,
    rowsReplaced:  deletedCount,
    emailResult:   emailResult
  };
}


// Sends the daily recap email to every active recipient, at most once per
// order cycle. Deduped via the MOG_LAST_RECAP_SENT_DATE script property so
// it's safe to call from any reset path. Reads LIVE on-hand state, so call
// it BEFORE clearing on-hand. Never throws — returns a status object purely
// for optional UI messaging (the sheet reset dialog surfaces it).
//
// Guarded with typeof — if MOGApi.gs isn't present (a location not yet
// onboarded to the mobile API), the email step is silently skipped and the
// reset proceeds normally.
function sendRecapIfUnsent_() {
  if (typeof buildRecapSections_ !== 'function' ||
      typeof readRecipients_     !== 'function' ||
      typeof sendRecapEmail_     !== 'function') {
    return null;
  }
  try {
    const props        = PropertiesService.getScriptProperties();
    const lastSent     = props.getProperty('MOG_LAST_RECAP_SENT_DATE') || '';
    const orderDateStr = getLogOrderDate_();
    if (lastSent === orderDateStr) {
      return { skipped: 'already-sent-this-cycle' };
    }
    const recipients = readRecipients_().filter(r => r.active && r.email);
    if (!recipients.length) {
      return { skipped: 'no-recipients' };
    }
    const recap = buildRecapSections_(null);
    if (!recap.sections.length) {
      return { skipped: 'no-items-to-recap' };
    }
    let sent = 0, failed = 0;
    for (const r of recipients) {
      try {
        sendRecapEmail_(r.email, recap.sections, recap.cycleDate, recap.totalItems);
        sent++;
      } catch (e) {
        failed++;
        Logger.log('Recap send failed for ' + r.email + ': ' + (e.stack || e));
      }
    }
    if (sent > 0) {
      props.setProperty('MOG_LAST_RECAP_SENT_DATE', recap.cycleDate);
    }
    return { sent: sent, failed: failed, cycleDate: recap.cycleDate };
  } catch (e) {
    // Non-blocking — the reset still runs. Log for triage.
    Logger.log('sendRecapIfUnsent_ error: ' + (e.stack || e));
    return { error: String(e.message || e) };
  }
}


// Removes every row in LOG_ORDERS where the order_date column matches
// the given orderDate (yyyy-MM-dd). Returns the number of rows removed.
//
// Used by commitLogAndReset to implement overwrite-on-re-reset semantics.
// Deletes in a single contiguous-range scan to avoid the O(n²) cost of
// per-row deletion, walking from the bottom up so row indexes remain
// valid as we go.
function deleteLogEntriesForDate_(logSheet, orderDate) {
  const lastRow = logSheet.getLastRow();
  if (lastRow < 2) return 0;
  const tz = SpreadsheetApp.getActiveSpreadsheet().getSpreadsheetTimeZone();

  const dates = logSheet
    .getRange(2, LOG_COL.ORDER_DATE, lastRow - 1, 1)
    .getValues()
    .flat();

  const fmt = (v) => {
    if (!v) return "";
    const d = (v instanceof Date) ? v : new Date(v);
    return isNaN(d.getTime()) ? String(v).trim() : Utilities.formatDate(d, tz, "yyyy-MM-dd");
  };

  // Build a list of rows to delete (sheet rows are 1-indexed; data starts
  // at row 2). Walk bottom-up so each delete doesn't shift the indexes
  // of rows we still need to delete.
  const rowsToDelete = [];
  for (let i = dates.length - 1; i >= 0; i--) {
    if (fmt(dates[i]) === orderDate) rowsToDelete.push(i + 2);
  }

  // Group into contiguous ranges and delete each range in one call.
  // Bottom-up traversal means rowsToDelete is already sorted descending.
  let deleted = 0;
  let i = 0;
  while (i < rowsToDelete.length) {
    const end = rowsToDelete[i];      // larger (bottom) row of the range
    let start = end;
    let j = i;
    while (j + 1 < rowsToDelete.length && rowsToDelete[j + 1] === start - 1) {
      start = rowsToDelete[j + 1];
      j++;
    }
    logSheet.deleteRows(start, end - start + 1);
    deleted += end - start + 1;
    i = j + 1;
  }

  return deleted;
}




// Opens the Order History modal from the menu.
function showOrderHistoryModal() {
  ensureLogSheet_();
  SpreadsheetApp.getUi().showModalDialog(
    HtmlService.createTemplateFromFile("OrderHistory").evaluate()
      .setWidth(MODAL_LG_W)
      .setHeight(MODAL_LG_H),
    "Order History"
  );
}




// Single-RPC modal-open path. Returns { vendors, rows } in one pass so the
// client doesn't need a separate vendor-list round-trip and the server
// doesn't read LOG_ORDERS twice. Vendor list is derived from the
// unfiltered log (the dropdown must show every vendor regardless of filter);
// rows are the filtered set, same shape getOrderHistory returns.
function getOrderHistoryBootstrap(filters) {
  const logSheet = ensureLogSheet_();
  const lastRow  = logSheet.getLastRow();
  if (lastRow < 2) return { vendors: getVendorList(), rows: [] };

  const tz   = SpreadsheetApp.getActiveSpreadsheet().getSpreadsheetTimeZone();
  const data = logSheet.getRange(2, 1, lastRow - 1, 7).getValues();

  // itemId -> current pack from MASTER_ITEMS, batched once.
  const master     = getSheet_(SHEET_MASTER);
  const masterLast = master.getLastRow();
  const packMap    = new Map();
  if (masterLast >= 2) {
    master
      .getRange(2, COL.ID, masterLast - 1, COL.PACK - COL.ID + 1)
      .getValues()
      .forEach(r => {
        const id = String(r[0] || "").trim();
        const pk = String(r[COL.PACK - COL.ID] || "").trim();
        if (id) packMap.set(id, pk);
      });
  }

  const fmtDate = (v) => {
    if (!v) return "";
    const d = (v instanceof Date) ? v : new Date(v);
    return isNaN(d.getTime()) ? String(v).trim() : Utilities.formatDate(d, tz, "yyyy-MM-dd");
  };
  const fmtTimestamp = (v) => {
    if (!v) return "";
    const d = (v instanceof Date) ? v : new Date(v);
    return isNaN(d.getTime()) ? String(v).trim() : Utilities.formatDate(d, tz, "yyyy-MM-dd HH:mm");
  };

  const vendorFilter = String(filters && filters.vendorFilter || "ALL").trim();
  const dateFrom     = String(filters && filters.dateFrom     || "").trim();
  const dateTo       = String(filters && filters.dateTo       || "").trim();

  const vendorSet = new Set();
  const enriched  = data.map(r => {
    const itemId = String(r[LOG_COL.ITEM_ID - 1] || "").trim();
    const vendor = String(r[LOG_COL.VENDOR  - 1] || "").trim();
    if (vendor) vendorSet.add(vendor);
    return {
      timestamp:  fmtTimestamp(r[LOG_COL.TIMESTAMP   - 1]),
      orderDate:  fmtDate(r[LOG_COL.ORDER_DATE   - 1]),
      vendor:     vendor,
      itemId:     itemId,
      itemName:   String(r[LOG_COL.ITEM_NAME   - 1] || "").trim(),
      itemPack:   packMap.get(itemId) || "",
      onHandPrev: Number(r[LOG_COL.ON_HAND_PRV - 1]) || 0,
      qtyOrdered: Number(r[LOG_COL.QTY_ORDERED - 1]) || 0
    };
  });

  const rows = enriched
    .filter(row => {
      if (!row.vendor && !row.itemName) return false;
      if (vendorFilter !== "ALL" && row.vendor.toLowerCase() !== vendorFilter.toLowerCase()) return false;
      if (dateFrom && row.orderDate < dateFrom) return false;
      if (dateTo   && row.orderDate > dateTo)   return false;
      return true;
    })
    .sort((a, b) => b.orderDate.localeCompare(a.orderDate));

  const vendors = Array.from(vendorSet).sort();
  return {
    vendors: vendors.length ? vendors : getVendorList(),
    rows:    rows
  };
}




// Serves Tab 1 (Recent Orders) and Tab 2 (Item History) in the modal.
// filters: { vendorFilter, dateFrom, dateTo }
function getOrderHistory(filters) {
  const logSheet = ensureLogSheet_();
  const lastRow  = logSheet.getLastRow();
  if (lastRow < 2) return [];




  const tz   = SpreadsheetApp.getActiveSpreadsheet().getSpreadsheetTimeZone();
  const data = logSheet.getRange(2, 1, lastRow - 1, 7).getValues();




  // Build itemId -> current pack lookup from MASTER_ITEMS in one batched
  // read so every log row can be enriched without a per-row sheet query.
  // Note: this is the CURRENT pack from MASTER_ITEMS, not the pack as it
  // was at order time (the log doesn't store pack). If pack changes are
  // rare this is fine; if pack changed after the order, the displayed
  // unit reflects today's value — which is what the user is buying now.
  const master     = getSheet_(SHEET_MASTER);
  const masterLast = master.getLastRow();
  const packMap    = new Map();
  if (masterLast >= 2) {
    master
      .getRange(2, COL.ID, masterLast - 1, COL.PACK - COL.ID + 1)
      .getValues()
      .forEach(r => {
        const id = String(r[0] || "").trim();
        const pk = String(r[COL.PACK - COL.ID] || "").trim();
        if (id) packMap.set(id, pk);
      });
  }




  const fmtDate = (v) => {
    if (!v) return "";
    const d = (v instanceof Date) ? v : new Date(v);
    return isNaN(d.getTime()) ? String(v).trim() : Utilities.formatDate(d, tz, "yyyy-MM-dd");
  };




  const fmtTimestamp = (v) => {
    if (!v) return "";
    const d = (v instanceof Date) ? v : new Date(v);
    return isNaN(d.getTime()) ? String(v).trim() : Utilities.formatDate(d, tz, "yyyy-MM-dd HH:mm");
  };




  const vendorFilter = String(filters.vendorFilter || "ALL").trim();
  const dateFrom     = String(filters.dateFrom || "").trim();
  const dateTo       = String(filters.dateTo   || "").trim();




  return data
    .map(r => {
      const itemId = String(r[LOG_COL.ITEM_ID - 1] || "").trim();
      return {
        timestamp:  fmtTimestamp(r[LOG_COL.TIMESTAMP   - 1]),
        orderDate:  fmtDate(r[LOG_COL.ORDER_DATE   - 1]),
        vendor:     String(r[LOG_COL.VENDOR      - 1] || "").trim(),
        itemId:     itemId,
        itemName:   String(r[LOG_COL.ITEM_NAME   - 1] || "").trim(),
        itemPack:   packMap.get(itemId) || "",
        onHandPrev: Number(r[LOG_COL.ON_HAND_PRV - 1]) || 0,
        qtyOrdered: Number(r[LOG_COL.QTY_ORDERED - 1]) || 0
      };
    })
    .filter(row => {
      if (!row.vendor && !row.itemName) return false;
      if (vendorFilter !== "ALL" && row.vendor.toLowerCase() !== vendorFilter.toLowerCase()) return false;
      if (dateFrom && row.orderDate < dateFrom) return false;
      if (dateTo   && row.orderDate > dateTo)   return false;
      return true;
    })
    .sort((a, b) => b.orderDate.localeCompare(a.orderDate));
}




// ── (removed 2026-06-01) getOrderSummary + getOrderHistoryVendorList ──
// Both dead. OrderHistory.html builds the Vendor Summary aggregation
// client-side from getOrderHistory, and the vendor dropdown is populated
// inline by getOrderHistoryBootstrap — neither server fn had a caller.
// Recoverable via git history.


// Clears all data rows in LOG_ORDERS (header row preserved).
// Called by commitSelectiveReset when options.orderLog is true.
function clearOrderLog() {
  const logSheet = ensureLogSheet_();
  const lastRow  = logSheet.getLastRow();
  // Always clear the cached last-log-date so the next duplicate-guard call
  // doesn't false-positive against an empty log.
  PropertiesService.getDocumentProperties().deleteProperty(LAST_LOG_DATE_PROP);
  if (lastRow < 2) return { ok: true, cleared: 0 };




  const numDataRows = lastRow - 1;
  logSheet.getRange(2, 1, numDataRows, 7).clearContent();
  return { ok: true, cleared: numDataRows };
}




// Admin toggle — same pattern as SETUP and MASTER_ITEMS toggles.
function toggleOrderLogVisibility() {
  const ui = SpreadsheetApp.getUi();
  const sh = ensureLogSheet_();
  if (sh.isSheetHidden()) {
    sh.showSheet();
    ui.alert("LOG_ORDERS tab is now visible.");
  } else {
    sh.hideSheet();
    ui.alert("LOG_ORDERS tab is now hidden.");
  }
}




/***********************
 * 12) PAR REVIEW FLAGS
 ***********************/




// Thresholds — adjust here if requirements change.
//
// Design notes (set by Sebastian — Path A, 2026-05):
//   • 2-week rolling window: aligns with realistic vendor frequency. A
//     3x/week vendor lands ~6 data points; 2x/week lands ~4.
//   • MIN_ORDERS=2: window already filters noise; the floor just prevents
//     a single anomalous entry from triggering a flag.
//   • Under-ordered uses on-hand ≤ 10% of par (not on-hand=0 directly)
//     because par=1 items would always read "empty" — at par=1 the only
//     possible non-stockout value IS 1. The 10% threshold treats "running
//     out" as a meaningful signal only when par is ≥ 3 (so 10% rounds to
//     a value that 0 actually distinguishes from). Items at par 1 or 2
//     are excluded from the under flag entirely.
//   • Over-ordered tightened to 50%/50%: aligns with the goal of ending
//     Sunday with as little inventory as possible. If on-hand sits at half
//     the par half the time, the par should drop.
const PAR_FLAG = {
  MIN_ORDERS:        2,    // minimum logged orders within the window
  WINDOW_DAYS:       14,   // only count orders from the last 14 days

  // Under-ordered ("Always Empty")
  UNDER_PAR_MIN:     3,    // par must be ≥ this for the flag to apply
  UNDER_ONHAND_PCT:  0.10, // On Hand ≤ 10% of par counts as "under"
  UNDER_FREQ_PCT:    0.75, // ≥ 75% of orders were "under" → flag

  // Over-ordered
  OVER_ONHAND_PCT:   0.50, // On Hand ≥ 50% of par counts as "over"
  OVER_FREQ_PCT:     0.50  // ≥ 50% of orders were "over"  → flag
};




// FLAG VALUES returned in the map:
//   "empty"    → Always Empty  (under-ordered: on hand consistently near zero,
//                                par must be ≥ UNDER_PAR_MIN to qualify)
//   "over"     → Over-Ordered  (on hand ≥ 50% of par in ≥ 50% of orders)
//   "both"     → both conditions true simultaneously
//   null       → not enough data or no flag




// ── getParReviewFlags ────────────────────────────────────────────────────────
// Called by ManageItems on load.
// Reads LOG_ORDERS and MASTER_ITEMS (for par values), computes flags per item.
//
// Window: only orders from the last PAR_FLAG.WINDOW_DAYS (default 14) are
// counted. Older entries are excluded so a recent par adjustment isn't
// dragged down by stale behavior.
//
// Flags (Path A logic — see PAR_FLAG block above for thresholds):
//   • "empty"  → on-hand consistently near zero AND par ≥ UNDER_PAR_MIN
//   • "over"   → on-hand consistently at half-par or more
//   • "both"   → both conditions met (rare but possible if par is volatile)
//   • null     → no pattern detected, or fewer than MIN_ORDERS data points
//
// Returns: {
//   [itemId]: {
//     flag:         "empty" | "over" | "both" | null,
//     timesOrdered: number,   // within the window
//     emptyCount:   number,   // count of "under" hits (legacy field name)
//     overCount:    number,   // within the window
//     avgOnHand:    number,   // within the window
//     par:          number | ""
//   }
// }
function getParReviewFlags() {
  const logSheet = ensureLogSheet_();
  const lastRow  = logSheet.getLastRow();
  if (lastRow < 2) return {};




  // Read entire log in one batch
  const data = logSheet
    .getRange(2, 1, lastRow - 1, 7)
    .getValues();




  // Build par lookup from MASTER_ITEMS so we can compute 75% of par per item
  const master     = getSheet_(SHEET_MASTER);
  const masterLast = master.getLastRow();
  const parMap     = new Map(); // itemId → par number
  if (masterLast >= 2) {
    master.getRange(2, COL.ID, masterLast - 1, COL.PAR - COL.ID + 1)
      .getValues()
      .forEach(r => {
        const id  = String(r[0] || "").trim();
        const par = Number(r[COL.PAR - COL.ID]);
        if (id && !isNaN(par) && par > 0) parMap.set(id, par);
      });
  }




  // Aggregate per item
  const agg = new Map(); // itemId → { timesOrdered, underCount, overCount, totalOnHand, par }




  // Rolling window cutoff: only count orders from the last WINDOW_DAYS.
  // Anything older is excluded from the aggregation, so a par change made
  // recently isn't dragged down by old behavior. A 2-week window gives
  // 3x/week vendors ~6 data points and daily vendors ~14.
  const cutoff = new Date();
  cutoff.setHours(0, 0, 0, 0);
  cutoff.setDate(cutoff.getDate() - PAR_FLAG.WINDOW_DAYS);




  data.forEach(r => {
    const rawDate    = r[LOG_COL.ORDER_DATE   - 1];
    const itemId     = String(r[LOG_COL.ITEM_ID     - 1] || "").trim();
    const onHand     = Number(r[LOG_COL.ON_HAND_PRV - 1]) || 0;
    const qtyOrdered = Number(r[LOG_COL.QTY_ORDERED - 1]) || 0;




    if (!itemId || qtyOrdered <= 0) return; // skip blank / unordered rows




    // Window filter — order date can be Date object or yyyy-mm-dd string.
    const orderDate = (rawDate instanceof Date) ? rawDate : new Date(rawDate);
    if (isNaN(orderDate.getTime()) || orderDate < cutoff) return;




    if (!agg.has(itemId)) {
      agg.set(itemId, {
        timesOrdered: 0,
        underCount:   0,
        overCount:    0,
        totalOnHand:  0,
        par:          parMap.get(itemId) || ""
      });
    }




    const entry = agg.get(itemId);
    entry.timesOrdered++;
    entry.totalOnHand += onHand;




    const par = parMap.get(itemId);
    if (!par || par <= 0) return;  // no par → can't compute either flag




    // Under-ordered: on hand ≤ 10% of par, AND par is high enough that
    // 0 is a meaningful signal (not just an artifact of par=1 or par=2).
    if (par >= PAR_FLAG.UNDER_PAR_MIN && onHand <= par * PAR_FLAG.UNDER_ONHAND_PCT) {
      entry.underCount++;
    }




    // Over-ordered: on hand ≥ 50% of par. Tighter than before to align
    // with the goal of ending the week with as little inventory as possible.
    if (onHand >= par * PAR_FLAG.OVER_ONHAND_PCT) {
      entry.overCount++;
    }
  });




  // Convert to flag results
  const result = {};
  agg.forEach((entry, itemId) => {
    if (entry.timesOrdered < PAR_FLAG.MIN_ORDERS) {
      // Not enough data yet — return stats but no flag
      result[itemId] = {
        flag:         null,
        timesOrdered: entry.timesOrdered,
        emptyCount:   entry.underCount,  // legacy field name preserved for HTML compatibility
        overCount:    entry.overCount,
        avgOnHand:    Math.round((entry.totalOnHand / entry.timesOrdered) * 10) / 10,
        par:          entry.par
      };
      return;
    }




    const underRate = entry.underCount / entry.timesOrdered;
    const overRate  = entry.overCount  / entry.timesOrdered;




    const isUnder = underRate >= PAR_FLAG.UNDER_FREQ_PCT;
    const isOver  = overRate  >= PAR_FLAG.OVER_FREQ_PCT;




    result[itemId] = {
      flag:         isUnder && isOver ? "both" : isUnder ? "empty" : isOver ? "over" : null,
      timesOrdered: entry.timesOrdered,
      emptyCount:   entry.underCount,  // legacy field name preserved for HTML compatibility
      overCount:    entry.overCount,
      avgOnHand:    Math.round((entry.totalOnHand / entry.timesOrdered) * 10) / 10,
      par:          entry.par
    };
  });




  return result;
}








/***********************
 * 13) MAINTENANCE
 ***********************/




// ── purgeInactiveFromPickPath ────────────────────────────────────────────────
// One-time (or as-needed) maintenance function.
// Scans the entire pick path database (SETUP K:P) and removes any row where
// the referenced item is inactive in MASTER_ITEMS or no longer exists at all.
// Run from: Apps Script editor → select function → Run
// Or add a temporary menu item and call it once.
//
// Returns a summary object: { removed: number, kept: number, itemsNotFound: string[] }
function purgeInactiveFromPickPath() {
  const setup  = getSheet_(SHEET_SETUP);
  const master = getSheet_(SHEET_MASTER);
  const ui     = SpreadsheetApp.getUi();




  // Build a map of itemId -> active status from MASTER_ITEMS
  const masterLastRow = master.getLastRow();
  const activeMap     = new Map(); // itemId (string) -> boolean




  if (masterLastRow >= 2) {
    const numRows = masterLastRow - 1;
    const vals    = master
      .getRange(2, COL.ID, numRows, Math.max(COL.ACTIVE - COL.ID + 1, 12))
      .getValues();




    vals.forEach(r => {
      const id     = String(r[COL.ID     - COL.ID] || "").trim();
      const active = r[COL.ACTIVE - COL.ID];
      if (id) activeMap.set(id, active === true);
    });
  }




  // Read current pick path DB
  const existing = readPickDb_(setup);
  if (!existing.length) {
    ui.alert("Purge Complete", "Pick path database is already empty — nothing to do.", ui.ButtonSet.OK);
    return { removed: 0, kept: 0, itemsNotFound: [] };
  }




  const kept         = [];
  const removedNames = [];
  const notFound     = [];




  existing.forEach(row => {
    const itemId   = String(row[1] || "").trim(); // column index 1 = Item ID in K:P
    const itemName = String(row[2] || "").trim(); // column index 2 = Item Name




    if (!itemId) return; // skip blank rows




    if (!activeMap.has(itemId)) {
      // Item ID not in MASTER_ITEMS at all
      notFound.push(itemId + (itemName ? " (" + itemName + ")" : ""));
      removedNames.push(itemName || itemId);
      return;
    }




    if (!activeMap.get(itemId)) {
      // Item exists but is inactive
      removedNames.push(itemName || itemId);
      return;
    }




    kept.push(row);
  });




  const removedCount = existing.length - kept.length;




  if (removedCount === 0) {
    ui.alert(
      "Purge Complete",
      "No inactive or missing items found in the pick path database. Everything looks clean.",
      ui.ButtonSet.OK
    );
    return { removed: 0, kept: kept.length, itemsNotFound: notFound };
  }




  // Write cleaned database back
  writePickDb_(setup, kept);




  // Rebuild all vendor tabs to reflect the removal
  rebuildAllPickPaths_();




  // Report
  const msg =
    "Removed " + removedCount + " item(s) from the pick path database:\n\n" +
    removedNames.map(function(n) { return "  - " + n; }).join("\n") +
    (notFound.length ? "\n\nNote: " + notFound.length + " item(s) were not found in MASTER_ITEMS and were also removed." : "") +
    "\n\nAll vendor tabs have been rebuilt.";




  ui.alert("Purge Complete", msg, ui.ButtonSet.OK);




  return { removed: removedCount, kept: kept.length, itemsNotFound: notFound };
}













/***********************
 * 14) HOME DASHBOARD
 ***********************/




// ── COLORS ───────────────────────────────────────────────────────────────
// Match the Order Guide sidebars: dark navy + mint accents. Beige used
// for the date strip and section headers (matching Prep Sheets Manager).
const DASH_COLORS = {
  NAVY:        "#1a1a2e",
  NAVY_DEEP:   "#0f0f1f",  // section headers
  MINT:        "#7eb8a4",
  MINT_DIM:    "#4a8775",
  WHITE:       "#ffffff",
  TEXT_MUTED:  "rgba(255,255,255,0.55)",
  BEIGE:       "#faf6ed",
  BEIGE_DARK:  "#ede5d0",
  GREEN_OK:    "#1a6b2e",
  RED_STALE:   "#b91c1c",  // bright warning red — reads at a glance
  GRAY_BORDER: "#888888"
};


// Per-concept dashboard branding. `accent` is the background fill that
// replaces DASH_COLORS.NAVY on the banner + tiles (chosen dark enough for
// white text); `bannerFont` is applied to the banner text only (tiles keep
// white text for legibility). Colors mirror the PWA's concept themes so the
// Sheet dashboard matches what KMs see in the app. Static table — identical
// across all stores; the per-store choice comes from the MOG_CONCEPT property.
const CONCEPT_THEMES = {
  'roll-play': { accent: "#2d8c6b", bannerFont: "#ffffff" },  // RP teal-dark + white
  'teasnyou':  { accent: "#1a1a1a", bannerFont: "#D4A574" },  // TNY charcoal + Kintsugi gold
  'default':   { accent: DASH_COLORS.NAVY, bannerFont: DASH_COLORS.WHITE }
};

// Resolves this store's dashboard theme from the MOG_CONCEPT script property
// (set via setupMobileApi / Set Store Concept). Falls back to the default
// navy when unset or unrecognized, so a store with no concept configured
// renders exactly as before. Memoized for the life of one execution.
var _dashThemeCache = null;
function dashTheme_() {
  if (_dashThemeCache) return _dashThemeCache;
  var concept = String(
    PropertiesService.getScriptProperties().getProperty(PROP_CONCEPT) || ""
  ).trim().toLowerCase();
  _dashThemeCache = CONCEPT_THEMES[concept] || CONCEPT_THEMES['default'];
  return _dashThemeCache;
}




// ── PUBLIC ENTRY POINT ───────────────────────────────────────────────────
// Wipes ORDER_ENTRY and rebuilds the HOME dashboard from scratch. Confirm
// dialog up front because this is destructive (existing formulas, formats,
// merges, validations on ORDER_ENTRY rows 1-50 are all replaced). Drawings
// are preserved by Apps Script's clear() so the legacy Reset On Hand
// button drawing survives — user can delete it manually after rebuild.
function buildHomeDashboard() {
  const ui = SpreadsheetApp.getUi();
  const confirm = ui.alert(
    "Rebuild Home Dashboard?",
    "This rewrites the ORDER_ENTRY tab to the new tile-based dashboard.\n\n" +
    "  • Existing values, formats, merges, and validations on rows 1–50 will be replaced.\n" +
    "  • Vendor tabs and other sheets are not touched.\n" +
    "  • Reversible via File → Version History if needed.\n\n" +
    "Continue?",
    ui.ButtonSet.YES_NO
  );
  if (confirm !== ui.Button.YES) return;




  const sh = getSheet_(SHEET_ORDER_ENTRY);




  // === COMPUTE DYNAMIC LAYOUT ===
  // Vendor tile section grows to fit the master vendor list (SETUP!Z).
  // Always shows tiles in groups of 5 per row, minimum 2 rows (10 slots),
  // even if the master list is shorter — keeps layout balanced on small
  // setups. Empty tile slots stay white via conditional formatting and
  // visually disappear into the sheet background.
  const TILES_PER_ROW    = 4;
  const MIN_VENDOR_ROWS  = 2;
  const ROWS_PER_TILE    = 2;   // top row = bold+underlined name, bottom row = plain count
  const vendorCount      = countMasterVendors_();
  const vendorRows       = Math.max(MIN_VENDOR_ROWS, Math.ceil(vendorCount / TILES_PER_ROW));
  const sheetVendorRows  = vendorRows * ROWS_PER_TILE;

  // Section row positions. No spacer between date strip and Reset.
  // Single 8px spacer between each step.
  // Vendor box ends with a thin beige_dark "closing band" row (matching
  // the section header) to give the box a clear bottom edge inside its
  // border, before the 8px spacer to Manage.
  const layout = {
    // STEP 1 — Reset (rows 3–5)
    resetHeaderRow:    3,
    resetStatusRow:    4,
    resetCheckboxRow:  5,
    // 8px spacer at row 6
    // STEP 2 — Vendors
    vendorHeaderRow:   7,
    vendorFirstRow:    8,
    vendorLastRow:     8 + sheetVendorRows - 1,
    vendorClosingRow:  8 + sheetVendorRows,    // beige_dark band, inside the box
    // 8px spacer at vendorClosingRow + 1
    // STEP 3 — Manage
    manageHeaderRow:   8 + sheetVendorRows + 2,
    manageTilesRow:    8 + sheetVendorRows + 3,
    manageCheckboxRow: 8 + sheetVendorRows + 4
  };
  const totalRows = layout.manageCheckboxRow;




  // Preserve the last reset date (AE9) across the rebuild. A rebuild is a
  // layout operation, not a reset, so it must not change the ordering-cycle
  // state. The clear range below wipes AE9, so capture it now and restore it
  // after the layout is rebuilt. Without this the banner goes red on every
  // rebuild AND the daily-reset open trigger would treat the rebuild as a
  // new day and auto-fire a reset + recap email on the next open.
  const preservedResetDate = sh.getRange(DASH.RESET_DATE).getValue();

  // Strip protections (so subsequent writes don't fail) and break any
  // existing merges in the dashboard area before clearing. Use a generous
  // 50-row clear range so we always wipe any prior larger layout.
  sh.getProtections(SpreadsheetApp.ProtectionType.SHEET).forEach(p => p.remove());
  sh.getProtections(SpreadsheetApp.ProtectionType.RANGE).forEach(p => p.remove());
  const clearRange = sh.getRange(1, 1, Math.max(50, totalRows + 5), 35);
  clearRange.breakApart();
  clearRange.clearContent();
  clearRange.clearFormat();
  clearRange.clearDataValidations();
  clearRange.clearNote();
  sh.clearConditionalFormatRules();




  // Column widths: 30 visible cols × 36px = 1080px wide. AE (col 31) is
  // the hidden data backing column.
  for (let c = 1; c <= 30; c++) sh.setColumnWidth(c, 36);
  sh.setColumnWidth(31, 100);
  sh.hideColumns(31);




  // === ROW HEIGHTS ===
  // Layout (no spacer between date strip and Reset; thin 8px spacers
  // between sections, with a double-spacer gap before Manage so it
  // reads as a clear break from the vendor section):
  //   1 banner                      50
  //   2 date strip                  30
  //   STEP 1 — Reset
  //   3 reset section header        40
  //   4 reset status strip          32
  //   5 reset checkbox row          32
  //   6 spacer                       8
  //   STEP 2 — Vendors
  //   7 vendor section header       40
  //   8..vendorLastRow              30/25 (alternating: name/count)
  //   spacer                         8
  //   spacer                         8
  //   STEP 3 — Manage
  //   manage header                 40
  //   manage tiles                  60
  //   manage checkboxes             35
  sh.setRowHeight(1, 50);
  sh.setRowHeight(2, 30);
  sh.setRowHeight(layout.resetHeaderRow, 40);
  sh.setRowHeight(layout.resetStatusRow, 32);
  sh.setRowHeight(layout.resetCheckboxRow, 32);
  sh.setRowHeight(layout.resetCheckboxRow + 1, 8);   // spacer
  sh.setRowHeight(layout.vendorHeaderRow, 40);
  for (let r = layout.vendorFirstRow; r <= layout.vendorLastRow; r++) {
    // Within each tile pair: top row is name (taller, 30px), bottom row
    // is count (shorter, 25px). Pair sums to ~55px.
    const isTopRow = ((r - layout.vendorFirstRow) % 2 === 0);
    sh.setRowHeight(r, isTopRow ? 30 : 25);
  }
  sh.setRowHeight(layout.vendorClosingRow, 25);     // closing beige band, sized like a count row
  sh.setRowHeight(layout.vendorClosingRow + 1, 8);  // spacer between vendor and manage
  sh.setRowHeight(layout.manageHeaderRow, 40);
  sh.setRowHeight(layout.manageTilesRow, 60);
  sh.setRowHeight(layout.manageCheckboxRow, 35);




  // Hide gridlines for cleaner tile appearance.
  sh.setHiddenGridlines(true);




  // === SECTION BORDERS ===
  // Each step is a clearly bounded box — full perimeter border in a dark
  // color. Spacer rows between steps stay borderless so the boxes float
  // on the sheet background with visible breathing room between them.
  const borderColor = "#444444";
  const step1Range = sh.getRange(
    "A" + layout.resetHeaderRow + ":AD" + layout.resetCheckboxRow
  );
  const step2Range = sh.getRange(
    "A" + layout.vendorHeaderRow + ":AD" + layout.vendorClosingRow
  );
  const step3Range = sh.getRange(
    "A" + layout.manageHeaderRow + ":AD" + layout.manageCheckboxRow
  );
  [step1Range, step2Range, step3Range].forEach(rng => {
    rng.setBorder(
      true, true, true, true, false, false,  // top, left, bottom, right, vert, horiz
      borderColor, SpreadsheetApp.BorderStyle.SOLID_MEDIUM
    );
  });




  // === HIDDEN DATA BACKING (column AE) ===
  sh.getRange(DASH.DATE_FORMULA).setFormula("=TODAY()").setNumberFormat("yyyy-mm-dd");

  // AE3 = day-of-week of TODAY (Mon/Tue/...). Vendor tab H2 formulas use
  // this for their multiplier column lookup.
  //
  // IMPORTANT design note: the multiplier columns in SETUP (S:Y) represent
  // the day the ORDER IS PLACED, not the delivery day. So if today is Wed
  // and Wed's column has a 1, that means "order this item on Wed" (which
  // implicitly is for whatever delivery cycle that vendor runs on).
  //
  // Order day comes from the LAST RESET DATE (AE9), not today (AE2). This
  // keeps the active ordering cycle locked to whatever day was last reset
  // until the user resets again. Without this, midnight rollover would
  // silently switch every vendor's multipliers to the new day before
  // yesterday's order was actually placed and logged. Falls back to today
  // when AE9 is blank (fresh setup, never reset yet).
  // IMPORTANT design note: the multiplier columns in SETUP (S:Y) represent
  // the day the ORDER IS PLACED, not the delivery day. So if today is Wed
  // and Wed's column has a 1, that means "order this item on Wed" (which
  // implicitly is for whatever delivery cycle that vendor runs on).
  //
  // Order day comes from the LAST RESET DATE (AE9), not today (AE2). This
  // keeps the active ordering cycle locked to whatever day was last reset
  // until the user resets again. Without this, midnight rollover would
  // silently switch every vendor's multipliers to the new day before
  // yesterday's order was actually placed and logged. Falls back to today
  // when AE9 is blank (fresh setup, never reset yet).
  sh.getRange(DASH.ORDER_DAY).setFormula(
    '=TEXT(IF(' + DASH.RESET_DATE + '="", ' + DASH.DATE_FORMULA + ', ' + DASH.RESET_DATE + '), "ddd")'
  );

  // AE9 (RESET_DATE) starts blank; resetOnHandAllVendors writes to it.
  // Used only by the Reset On Hand status strip's conditional formatting.
  sh.getRange(DASH.RESET_DATE).setNumberFormat("yyyy-mm-dd");

  // Restore the pre-rebuild reset date so the banner keeps its true color
  // (green if already reset today) and the daily-reset open trigger doesn't
  // see a rebuild as a new day. Only restore a real date — a blank/invalid
  // value means "never reset," which should correctly stay blank (red).
  if (preservedResetDate instanceof Date && !isNaN(preservedResetDate.getTime())) {
    sh.getRange(DASH.RESET_DATE).setValue(preservedResetDate);
  }




  // === BUILD SECTIONS ===
  // Order matches the daily workflow: reset first, then enter on-hand counts
  // by visiting today's vendors, then admin functions if needed.
  buildHomeBanner_(sh);
  buildHomeDateStrip_(sh);
  buildHomeResetTile_(sh, layout);
  buildHomeVendorTiles_(sh, layout);
  buildHomeQuickActions_(sh, layout);
  buildHomeConditionalFormatting_(sh, layout);




  // === PERSIST DYNAMIC LAYOUT POSITIONS ===
  // The dashboard's edit dispatcher (handleDashboardEdit_) needs to know
  // which row holds the manage-section checkboxes — that row depends on
  // the dynamic vendor count. Save it now so dispatching works after
  // build completes.
  PropertiesService.getDocumentProperties()
    .setProperty(DASH.MANAGE_ROW_PROP, String(layout.manageCheckboxRow));




  // === SYNC VENDOR TABS ===
  // The legacy vendor-tab H2 formula referenced ORDER_ENTRY!$B$4 (override)
  // and ORDER_ENTRY!$D$2 (day) — both addresses are now swallowed by merged
  // ranges in the new layout. Rewrite every vendor tab's H2 to point at the
  // new authoritative cells (AD2 for override, AE3 for today's day-of-week).
  const vendorSync = updateVendorTabHeader2Formulas_();




  // === INSTALL EDIT TRIGGER ===
  // Quick-action checkboxes need to open sidebars, which simple onEdit
  // triggers cannot do. An installable trigger handles them with full auth.
  // First call may surface an authorization prompt.
  let triggerStatus = "already installed";
  try {
    const result = ensureDashboardEditTrigger_();
    triggerStatus = result.created ? "installed (you may need to authorize)" : "already installed";
  } catch (err) {
    triggerStatus = "FAILED — " + err.message + " (try running buildHomeDashboard from the script editor once to grant permissions)";
  }




  // === INSTALL DAILY-RESET OPEN TRIGGER ===
  // Auto-runs the reset (log + recap email + clear) the first time the
  // Sheet is opened on a new day. Must be installable so it can send email.
  // First call may surface an authorization prompt.
  let resetTriggerStatus = "already installed";
  try {
    const result = ensureDailyResetTrigger_();
    resetTriggerStatus = result.created ? "installed (you may need to authorize)" : "already installed";
  } catch (err) {
    resetTriggerStatus = "FAILED — " + err.message + " (try running buildHomeDashboard from the script editor once to grant permissions)";
  }




  ui.alert(
    "Dashboard built ✓",
    "The HOME dashboard is ready on the ORDER_ENTRY tab.\n\n" +
    "Vendor tabs synced:\n" +
    "  • " + vendorSync.updated + " vendor tab(s) updated to read the new override and delivery-day cells.\n" +
    (vendorSync.skipped > 0 ? "  • " + vendorSync.skipped + " vendor name(s) had no matching tab — skipped.\n" : "") +
    (vendorSync.errors.length > 0 ? "  • Errors: " + vendorSync.errors.join("; ") + "\n" : "") +
    "\nDashboard edit trigger: " + triggerStatus + "\n" +
    "Daily-reset open trigger: " + resetTriggerStatus + "\n" +
    "\nWhat to do next:\n" +
    "  • If you have an old Reset On Hand button drawing, you can delete it — the new Reset tile replaces it.\n" +
    "  • Tap any Quick Action checkbox to open that sidebar.\n" +
    "  • Tap the Reset On Hand checkbox to clear vendor on-hand counts (with confirm).\n" +
    "  • Toggle Emergency Override to set every vendor to 1× and show all vendors regardless of delivery schedule.",
    ui.ButtonSet.OK
  );
}




// ── ROW 1: BANNER ────────────────────────────────────────────────────────
function buildHomeBanner_(sh) {
  // Store name comes from the per-store MOG_LOCATION_NAME property (set via
  // setupMobileApi), uppercased. Falls back to a neutral title if unset so a
  // freshly-copied store never stamps the wrong name. Colors come from the
  // concept theme (default navy when no concept is configured).
  const location = String(
    PropertiesService.getScriptProperties().getProperty(PROP_LOCATION) || ""
  ).trim();
  const title = location ? "ORDERING GUIDE  ·  " + location.toUpperCase() : "ORDERING GUIDE";
  const theme = dashTheme_();
  const banner = sh.getRange("A1:AD1");
  banner.merge()
    .setValue(title)
    .setBackground(theme.accent)
    .setFontColor(theme.bannerFont)
    .setFontFamily("Arial")
    .setFontSize(15)
    .setFontWeight("bold")
    .setHorizontalAlignment("center")
    .setVerticalAlignment("middle");
}




// ── ROW 2: DATE STRIP ────────────────────────────────────────────────────
function buildHomeDateStrip_(sh) {
  // Strip background spans the full row.
  sh.getRange("A2:AD2").setBackground(DASH_COLORS.BEIGE);

  const labelStyle = { color: "#555", size: 10, weight: "normal", align: "right" };
  const valueStyle = { color: DASH_COLORS.NAVY, size: 12, weight: "bold", align: "left" };

  // Today's date (left). The "ddd" prefix already includes the day name,
  // so no separate Day/Día field is needed.
  applyHomeStripCell_(sh, "A2:F2",  "📅  Date / Fecha:",            labelStyle);
  applyHomeStripCell_(sh, "G2:O2",  '=TEXT(AE2, "dddd, mmm d, yyyy")', valueStyle, true);

  // Emergency override (right) — visible checkbox styled as a warning-only
  // control (bold red label + yellow-cream bg) so it doesn't look like a
  // normal toggle. Auto-clears when reset fires (see resetOnHandAllVendors)
  // and on first-open of a new day (see resetEmergencyOverrideOnOpen_).
  const warnLabelStyle = { color: "#a02020", size: 10, weight: "bold", align: "right" };
  applyHomeStripCell_(sh, "P2:AC2", "⚠  EMERGENCY OVERRIDE  /  Anulación:", warnLabelStyle);
  sh.getRange("P2:AC2").setBackground("#fff4d6");

  sh.getRange("AD2")
    .insertCheckboxes()
    .setValue(false)
    .setBackground("#fff4d6")
    .setHorizontalAlignment("center")
    .setVerticalAlignment("middle");
}

function applyHomeStripCell_(sh, range, valueOrFormula, style, isFormula) {
  const r = sh.getRange(range).merge()
    .setBackground(DASH_COLORS.BEIGE)
    .setFontFamily("Arial")
    .setFontColor(style.color)
    .setFontSize(style.size)
    .setFontWeight(style.weight)
    .setHorizontalAlignment(style.align)
    .setVerticalAlignment("middle");
  if (isFormula) r.setFormula(valueOrFormula);
  else r.setValue(valueOrFormula);
}




// ── MANAGE SECTION (header + tiles + checkboxes, dynamic rows) ───────────
// Position depends on how many vendor tile rows precede us. Header gets
// the ③ step badge. Tile columns are static (A:E, F:J, K:O, P:T, U:Y,
// Z:AD); checkbox cells are at column letters from QUICK_ACTION_COLUMNS.
function buildHomeQuickActions_(sh, layout) {
  const headerRow   = layout.manageHeaderRow;
  const tilesRow    = layout.manageTilesRow;
  const checkboxRow = layout.manageCheckboxRow;

  // Section header.
  buildSectionHeader_(sh, "A" + headerRow + ":AD" + headerRow,
    "③  MANAGE  —  Tap a box to open a tool",
    "ADMINISTRAR  —  Marca para abrir una herramienta");

  // Six tiles (5 cols each × 6 = 30 cols).
  const tileSpec = [
    { range: "A"+tilesRow+":E"+tilesRow,   en: "Manage Items",      es: "Artículos"        },
    { range: "F"+tilesRow+":J"+tilesRow,   en: "Manage Vendors",    es: "Proveedores"      },
    { range: "K"+tilesRow+":O"+tilesRow,   en: "Manage Pick Path",  es: "Ruta de Picking"  },
    { range: "P"+tilesRow+":T"+tilesRow,   en: "Storage Areas",     es: "Áreas"            },
    { range: "U"+tilesRow+":Y"+tilesRow,   en: "Order History",     es: "Historial"        },
    { range: "Z"+tilesRow+":AD"+tilesRow,  en: "How To Use",        es: "Cómo Usar"        }
  ];
  tileSpec.forEach(t => buildHomeTile_(sh, t.range, t.en, t.es, dashTheme_().accent));

  // Six checkbox cells matching tile widths. Each merged range contains a
  // single checkbox at its top-left cell. Top-left col letters match
  // DASH.QUICK_ACTION_COLUMNS, which is what the dispatch handler reads.
  const checkboxRanges = [
    "A"+checkboxRow+":E"+checkboxRow,
    "F"+checkboxRow+":J"+checkboxRow,
    "K"+checkboxRow+":O"+checkboxRow,
    "P"+checkboxRow+":T"+checkboxRow,
    "U"+checkboxRow+":Y"+checkboxRow,
    "Z"+checkboxRow+":AD"+checkboxRow
  ];
  checkboxRanges.forEach(r => {
    sh.getRange(r).merge()
      .setBackground(DASH_COLORS.BEIGE)
      .setHorizontalAlignment("center")
      .setVerticalAlignment("middle")
      .insertCheckboxes()
      .setValue(false);
  });
}




// ── Section header: beige-dark band with stacked bilingual rich text ─────
// Renders a section divider with EN line on top (navy, bold, 12pt) and
// ES line below (mint dim, italic, 10pt). Used for QUICK ACTIONS, RESET
// ON HAND, and TODAY'S VENDORS section dividers.
function buildSectionHeader_(sh, range, enText, esText) {
  sh.getRange(range).merge()
    .setBackground(DASH_COLORS.BEIGE_DARK)
    .setHorizontalAlignment("center")
    .setVerticalAlignment("middle")
    .setWrap(true);

  const text    = enText + "\n" + esText;
  const enEnd   = enText.length;
  const esStart = enEnd + 1;
  const esEnd   = esStart + esText.length;

  const enStyle = SpreadsheetApp.newTextStyle()
    .setForegroundColor(DASH_COLORS.NAVY)
    .setFontFamily("Arial")
    .setFontSize(12)
    .setBold(true)
    .build();
  const esStyle = SpreadsheetApp.newTextStyle()
    .setForegroundColor(DASH_COLORS.MINT_DIM)
    .setFontFamily("Arial")
    .setFontSize(10)
    .setBold(false)
    .setItalic(true)
    .build();

  const richText = SpreadsheetApp.newRichTextValue()
    .setText(text)
    .setTextStyle(0, enEnd, enStyle)
    .setTextStyle(esStart, esEnd, esStyle)
    .build();

  const topLeft = range.split(":")[0];
  sh.getRange(topLeft).setRichTextValue(richText);
}




// ── Single quick-action tile ─────────────────────────────────────────────
// Renders a tile with two stacked text styles in one merged cell:
//   line 1 — English label, white, 12pt bold
//   line 2 — Spanish label, mint, 10pt regular
// Achieved via Apps Script rich-text builder. Static text only — formula-
// driven tiles (Reset, vendors) use uniform styling instead since rich text
// doesn't apply to formula results.
function buildHomeTile_(sh, range, enText, esText, bgColor) {
  const merged = sh.getRange(range).merge()
    .setBackground(bgColor)
    .setFontFamily("Arial")
    .setHorizontalAlignment("center")
    .setVerticalAlignment("middle")
    .setWrap(true);

  const text    = enText + "\n" + esText;
  const enEnd   = enText.length;
  const esStart = enEnd + 1;            // skip the newline
  const esEnd   = esStart + esText.length;

  const enStyle = SpreadsheetApp.newTextStyle()
    .setForegroundColor(DASH_COLORS.WHITE)
    .setFontFamily("Arial")
    .setFontSize(12)
    .setBold(true)
    .build();
  const esStyle = SpreadsheetApp.newTextStyle()
    .setForegroundColor(DASH_COLORS.MINT)
    .setFontFamily("Arial")
    .setFontSize(10)
    .setBold(false)
    .build();

  const richText = SpreadsheetApp.newRichTextValue()
    .setText(text)
    .setTextStyle(0, enEnd, enStyle)
    .setTextStyle(esStart, esEnd, esStyle)
    .build();

  // Rich text writes to the top-left cell of the merged range.
  const topLeft = range.split(":")[0];
  sh.getRange(topLeft).setRichTextValue(richText);
}




// ── STEP 1: RESET ON HAND ────────────────────────────────────────────────
// Three rows: section header → status strip → checkbox row.
// (The redundant "Reset On Hand · Reiniciar En Stock" title tile was
// dropped — the header above and status strip below already carry the
// section's identity.)
function buildHomeResetTile_(sh, layout) {
  const headerRow   = layout.resetHeaderRow;
  const statusRow   = layout.resetStatusRow;
  const checkboxRow = layout.resetCheckboxRow;

  // Row N — section header with step ① badge.
  buildSectionHeader_(sh, "A" + headerRow + ":AD" + headerRow,
    "①  RESET ON HAND  —  Start here every day",
    "REINICIAR EN STOCK  —  Empieza aquí cada día");

  // Row N+1 — status strip. Conditional formatting flips this green when
  // today's reset is logged, red when empty or stale. INT(AE9) strips
  // any time component from the stored date.
  sh.getRange("A" + statusRow + ":AD" + statusRow).merge()
    .setFormula(
      '=IF(' + DASH.RESET_DATE + '="", ' +
        '"⚠  NOT RESET YET  —  Tap the box below to begin  ·  No reiniciado — Marca para empezar", ' +
        'IF(INT(' + DASH.RESET_DATE + ')=TODAY(), ' +
          '"✓  Reset complete:  " & TEXT(' + DASH.RESET_DATE + ', "ddd, mmm d, yyyy") & "  ·  Reinicio completo para hoy", ' +
          '"⚠  STALE  —  Last reset:  " & TEXT(' + DASH.RESET_DATE + ', "ddd, mmm d") & "  —  Reset for today\'s order  ·  Reinicia para hoy"' +
        ')' +
      ')'
    )
    .setBackground(dashTheme_().accent)
    .setFontColor(DASH_COLORS.WHITE)
    .setFontFamily("Arial")
    .setFontSize(11)
    .setFontWeight("bold")
    .setHorizontalAlignment("center")
    .setVerticalAlignment("middle");

  // Row N+2 — checkbox row with arrow labels framing the single-column
  // checkbox at O{checkboxRow} (DASH.RESET_CHECKBOX is a static "O7" in
  // the config; with the row pinned to checkboxRow, the dispatch handler
  // reads the same address).
  sh.getRange("A" + checkboxRow + ":N" + checkboxRow).merge()
    .setValue("Tap to confirm reset  →")
    .setBackground(DASH_COLORS.BEIGE)
    .setFontColor(DASH_COLORS.MINT_DIM)
    .setFontFamily("Arial")
    .setFontSize(11)
    .setFontWeight("bold")
    .setHorizontalAlignment("right")
    .setVerticalAlignment("middle");

  sh.getRange(DASH.RESET_CHECKBOX)
    .insertCheckboxes()
    .setValue(false)
    .setBackground(DASH_COLORS.BEIGE)
    .setHorizontalAlignment("center")
    .setVerticalAlignment("middle");

  sh.getRange("P" + checkboxRow + ":AD" + checkboxRow).merge()
    .setValue("←  Marca para confirmar")
    .setBackground(DASH_COLORS.BEIGE)
    .setFontColor(DASH_COLORS.MINT_DIM)
    .setFontFamily("Arial")
    .setFontSize(11)
    .setFontWeight("bold")
    .setHorizontalAlignment("left")
    .setVerticalAlignment("middle");
}




// ── VENDOR SECTION (header + dynamic-count tile rows) ────────────────────
// Header row, then `vendorRowCount` rows of 5 tiles each. Tile count scales
// with the master vendor list — minimum 10 slots (2 rows), grows in groups
// of 5 as more vendors are registered. Empty slots stay white via CF.
function buildHomeVendorTiles_(sh, layout) {
  const headerRow    = layout.vendorHeaderRow;
  const firstRow     = layout.vendorFirstRow;
  const lastRow      = layout.vendorLastRow;
  const headerRange  = "A" + headerRow + ":AD" + headerRow;

  // Section header. Day name already shows in the date strip above, so we
  // don't repeat it here. Two short bilingual lines.
  sh.getRange(headerRange).merge()
    .setFormula(
      '=IF(' + DASH.EMERGENCY_OVERRIDE + '=TRUE, ' +
        '"②  ALL VENDORS  —  Emergency Override active" & CHAR(10) & "TODOS LOS PROVEEDORES  —  Anulación activa", ' +
        '"②  TODAY\'S VENDORS  —  Tap a tile to enter on-hand counts" & CHAR(10) & ' +
        '"PROVEEDORES DE HOY  —  Toca una tarjeta para ingresar conteos")'
    )
    .setBackground(DASH_COLORS.BEIGE_DARK)
    .setFontColor(DASH_COLORS.NAVY)
    .setFontFamily("Arial")
    .setFontSize(11)
    .setFontWeight("bold")
    .setHorizontalAlignment("center")
    .setVerticalAlignment("middle")
    .setWrap(true);

  // Hidden FILTER spill — drives the tiles below. If override is on, show
  // all non-empty vendors from SETUP!Z; otherwise filter by today's
  // multiplier column.
  sh.getRange(DASH.VENDOR_FILTER_START).setFormula(
    '=IFERROR(' +
      'IF(' + DASH.EMERGENCY_OVERRIDE + '=TRUE, ' +
        'FILTER(SETUP!Z2:Z, SETUP!Z2:Z<>""), ' +
        'FILTER(SETUP!R2:R, ' +
          'INDEX(SETUP!S2:Y,, MATCH(' + DASH.ORDER_DAY + ', SETUP!S1:Y1, 0)) > 0)' +
      '), "")'
  );

  // Tile spec: 4 tiles per row, each spanning 7 columns (B:H, I:O, P:V,
  // W:AC), with 1-column visual margins at A and AD. Each tile occupies
  // TWO sheet rows (top = name, bottom = count) so we can style each
  // line independently.
  const tileSpans = [["B","H"], ["I","O"], ["P","V"], ["W","AC"]];

  // Start aeRow at the row of VENDOR_FILTER_START (AE100), since that's
  // where the spill output begins. Each tile in layout order reads one
  // sequential AE row — first tile = AE100, second = AE101, etc.
  const filterStartRow = parseInt(DASH.VENDOR_FILTER_START.replace(/[A-Z]/g, ""), 10);
  let aeRow = filterStartRow;
  // Iterate tile-pairs (each pair = 2 sheet rows). step = 2.
  for (let r = firstRow; r <= lastRow; r += 2) {
    const nameRow  = r;
    const countRow = r + 1;

    // Margin cells on both rows of the pair — match section header band.
    sh.getRange("A" + nameRow).setBackground(DASH_COLORS.BEIGE_DARK);
    sh.getRange("AD" + nameRow).setBackground(DASH_COLORS.BEIGE_DARK);
    sh.getRange("A" + countRow).setBackground(DASH_COLORS.BEIGE_DARK);
    sh.getRange("AD" + countRow).setBackground(DASH_COLORS.BEIGE_DARK);

    tileSpans.forEach(span => {
      const nameRange  = span[0] + nameRow  + ":" + span[1] + nameRow;
      const countRange = span[0] + countRow + ":" + span[1] + countRow;
      const sourceCell = "AE" + aeRow;
      buildVendorTilePair_(sh, nameRange, countRange, sourceCell);
      aeRow++;
    });
  }

  // Closing band — a beige_dark row inside the vendor box's bottom border.
  // Gives the section a clean visual close before the spacer to Manage.
  sh.getRange("A" + layout.vendorClosingRow + ":AD" + layout.vendorClosingRow)
    .setBackground(DASH_COLORS.BEIGE_DARK);
}




// ── Single vendor tile: 2 cells stacked (name on top, count below) ───────
// Top cell:
//   HYPERLINK formula → vendor name. Bold weight + auto-underlined as a
//   link. Clicking jumps to the vendor's tab.
// Bottom cell:
//   Plain formula → "X / Y entered" where X = COUNT of column E (numeric
//   on-hand entries; treats 0 as entered) and Y = COUNT of column D (Par
//   column — only true item rows have a numeric par). Plain weight, no
//   underline, not clickable (informational).
//
// Both cells start with white background. Conditional formatting in
// buildHomeConditionalFormatting_ flips bg to navy when there's a vendor
// in the slot. Empty slots stay white and disappear into the sheet bg.
function buildVendorTilePair_(sh, nameRange, countRange, sourceCell) {
  // Top cell: vendor name as a bold, underlined hyperlink to its tab.
  // Default bg is WHITE — empty tiles blend into the white tile field.
  // CF flips it to navy when populated.
  const nameFormula =
    '=IF(' + sourceCell + '="", "", ' +
      'HYPERLINK("#gid=" & SHEETGID(' + sourceCell + '), ' + sourceCell + ')' +
    ')';
  sh.getRange(nameRange).merge()
    .setFormula(nameFormula)
    .setBackground(DASH_COLORS.WHITE)
    .setFontColor(DASH_COLORS.WHITE)
    .setFontFamily("Arial")
    .setFontSize(12)
    .setFontWeight("bold")
    .setHorizontalAlignment("center")
    .setVerticalAlignment("middle");

  // Bottom cell: plain "X / Y entered" count. Same default bg as the name.
  const countFormula =
    '=IF(' + sourceCell + '="", "", ' +
      'IFERROR(COUNT(INDIRECT("\'" & ' + sourceCell + ' & "\'!E3:E1000")), 0) & ' +
      '" / " & ' +
      'IFERROR(COUNT(INDIRECT("\'" & ' + sourceCell + ' & "\'!D3:D1000")), 0) & ' +
      '" entered"' +
    ')';
  sh.getRange(countRange).merge()
    .setFormula(countFormula)
    .setBackground(DASH_COLORS.WHITE)
    .setFontColor(DASH_COLORS.WHITE)
    .setFontFamily("Arial")
    .setFontSize(11)
    .setFontWeight("normal")
    .setFontLine("none")
    .setHorizontalAlignment("center")
    .setVerticalAlignment("middle");
}




// ── Conditional formatting ───────────────────────────────────────────────
// Two independent CF zones:
//
// 1) Reset STATUS STRIP (row 6, inside the step-1 section):
//      GREEN  — last reset = today (ready to order)
//      RED    — last reset is empty OR < today (NOT ready: must reset first)
//    Rule order matters: green is checked first, so today's match wins.
//    INT(AE9) strips any time component (resetOnHand writes via new Date()
//    which can include hours/minutes; raw equality vs TODAY() would fail).
//
// 2) Vendor tile zone (layout.vendorFirstRow..vendorLastRow):
//      NAVY   — cell has a vendor (formula resolved to non-empty string)
//      WHITE  — cell empty (default fill); blends into sheet background
//    This is what makes empty vendor slots disappear instead of showing
//    as a navy band when fewer vendors fire today than the layout reserves.
function buildHomeConditionalFormatting_(sh, layout) {
  const statusRange = sh.getRange(
    "A" + layout.resetStatusRow + ":AD" + layout.resetStatusRow
  );
  const vendorRange = sh.getRange(
    "B" + layout.vendorFirstRow + ":AC" + layout.vendorLastRow
  );

  const greenRule = SpreadsheetApp.newConditionalFormatRule()
    .whenFormulaSatisfied('=INT($AE$9)=TODAY()')
    .setBackground(DASH_COLORS.GREEN_OK)
    .setFontColor(DASH_COLORS.WHITE)
    .setRanges([statusRange])
    .build();

  const redRule = SpreadsheetApp.newConditionalFormatRule()
    .whenFormulaSatisfied('=OR($AE$9="", INT($AE$9)<>TODAY())')
    .setBackground(DASH_COLORS.RED_STALE)
    .setFontColor(DASH_COLORS.WHITE)
    .setRanges([statusRange])
    .build();

  // Vendor tile fill — navy when populated. The "Cell is not empty"
  // condition fires when the merged tile's formula resolves to non-empty
  // text (i.e. there's a vendor in this slot). Cells whose source AE row
  // is empty stay at the default BEIGE_DARK background, blending into
  // the section header band so empty tile-pairs disappear into the frame.
  const vendorPopulatedRule = SpreadsheetApp.newConditionalFormatRule()
    .whenCellNotEmpty()
    .setBackground(dashTheme_().accent)
    .setFontColor(DASH_COLORS.WHITE)
    .setRanges([vendorRange])
    .build();

  const rules = sh.getConditionalFormatRules();
  rules.push(greenRule, redRule, vendorPopulatedRule);
  sh.setConditionalFormatRules(rules);
}




// ── Master vendor list count ─────────────────────────────────────────────
// Reads SETUP!Z (the master vendor list) and returns the count of non-empty
// entries. Used by buildHomeDashboard to size the vendor tile section.
function countMasterVendors_() {
  const ss      = SpreadsheetApp.getActive();
  const setupSh = ss.getSheetByName(SHEET_SETUP);
  if (!setupSh) return 0;

  const lastRow = setupSh.getLastRow();
  if (lastRow < 2) return 0;

  const vals = setupSh.getRange(2, 26, lastRow - 1, 1).getValues();
  return vals.flat().filter(v => v && String(v).trim() !== "").length;
}




// ── Vendor-tab formula sync ──────────────────────────────────────────────
// Each vendor tab carries an H2 formula that computes the tab's effective
// multiplier for today's order. The legacy formula referenced ORDER_ENTRY!
// $B$4 (override) and $D$2 (day-of-week) — both addresses are now gone in
// the new dashboard layout (swallowed by merged ranges). This rewrites
// every vendor tab's H2 to reference the new authoritative cells:
//
//   override   →  ORDER_ENTRY!$AD$2
//   order day  →  ORDER_ENTRY!$AE$3   (TODAY's day-of-week — the SETUP
//                                     multiplier columns are organized by
//                                     the day the order is PLACED)
//
// Returns a summary object: { updated, skipped, errors }.
// Canonical vendor-tab H2 multiplier formula — single source of truth, shared
// by the per-tab sync and the VENDOR_TEMPLATE repair. References the LIVE
// dashboard cells (AD2 override, AE3 day-of-week), never the dead legacy B4/D2.
function vendorTabH2Formula_() {
  const overrideRef = 'ORDER_ENTRY!' + toAbsoluteA1_(DASH.EMERGENCY_OVERRIDE);
  const dayRef      = 'ORDER_ENTRY!' + toAbsoluteA1_(DASH.ORDER_DAY);
  return '=IF(' + overrideRef + '=TRUE, 1, ' +
      'IFERROR(' +
        'INDEX(SETUP!$S$2:$Y, ' +
          'MATCH(TRIM($B$1), ARRAYFORMULA(TRIM(SETUP!$R$2:$R)), 0), ' +
          'MATCH(' + dayRef + ', ARRAYFORMULA(TRIM(SETUP!$S$1:$Y$1)), 0)' +
        '), 0)' +
    ')';
}


// Menu: Mobile API -> Sync Vendor Multiplier Formulas. Non-destructive repair
// that rewrites every vendor tab's H2 AND the VENDOR_TEMPLATE's H2 to the
// canonical multiplier formula — fixes anything left on the dead legacy B4/D2
// refs, without a full dashboard rebuild.
function syncVendorMultiplierFormulasMenu_() {
  const ui = SpreadsheetApp.getUi();
  const r  = updateVendorTabHeader2Formulas_();
  const msg =
    "Vendor multiplier formulas synced to the current layout.\n\n" +
    "Vendor tabs updated: " + r.updated + "\n" +
    "Template repaired:   " + (r.templateUpdated ? "yes" : "no template found") +
    (r.skipped ? "\nSkipped (no sheet):  " + r.skipped : "") +
    ((r.errors && r.errors.length) ? "\n\nErrors:\n  " + r.errors.join("\n  ") : "");
  ui.alert("Sync Vendor Multiplier Formulas", msg, ui.ButtonSet.OK);
}


function updateVendorTabHeader2Formulas_() {
  const ss      = SpreadsheetApp.getActive();
  const setupSh = ss.getSheetByName(SHEET_SETUP);
  const result  = { updated: 0, skipped: 0, errors: [] };
  if (!setupSh) return result;

  const lastRow = setupSh.getLastRow();
  if (lastRow < 2) return result;

  // Vendor list: SETUP column Z, rows 2..lastRow.
  const vendorVals = setupSh.getRange(2, 26, lastRow - 1, 1).getValues();
  const vendors    = vendorVals.flat()
    .filter(v => v && String(v).trim() !== "")
    .map(v => String(v).trim());

  const newFormula = vendorTabH2Formula_();

  vendors.forEach(name => {
    const sh = ss.getSheetByName(name);
    if (!sh) { result.skipped++; return; }
    try {
      sh.getRange("H2").setFormula(newFormula);
      result.updated++;
    } catch (e) {
      result.errors.push(name + ': ' + e.message);
    }
  });

  // Also repair VENDOR_TEMPLATE — the clone source for Add Vendor. It lives
  // OUTSIDE the vendor list, so the loop above never reaches it. That gap is
  // exactly why new-vendor clones inherited the dead legacy B4/D2 formula.
  // Keeping it synced means every newly-added vendor is born correct.
  const tmplSh = ss.getSheetByName("VENDOR_TEMPLATE");
  if (tmplSh) {
    try {
      tmplSh.getRange("H2").setFormula(newFormula);
      result.templateUpdated = true;
    } catch (e) {
      result.errors.push("VENDOR_TEMPLATE: " + e.message);
    }
  }

  return result;
}




// ── A1 utility: convert "AD2" → "$AD$2" for absolute references ──────────
function toAbsoluteA1_(a1) {
  const m = String(a1).match(/^([A-Z]+)(\d+)$/);
  return m ? ('$' + m[1] + '$' + m[2]) : a1;
}