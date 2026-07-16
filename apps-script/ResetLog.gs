/************************************************************
 * MOG — Reset / order-log snapshot / daily recap.
 * Split out of OrderGuideScript.gs (god-object split).
 * All .gs files share one global scope; global constants
 * live in Core.gs. Functions here reference them at call time.
 ************************************************************/





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
  // Single source of truth: Core's getActiveOrderDate_ (AE9 first, AE2/today
  // fallback). This is the date stamped onto every LOG_ORDERS row and the key
  // the duplicate guard uses.
  return getActiveOrderDate_().dateStr;
}










// Sweeps all vendor tabs and returns log rows for items where Suggested Qty > 0.
// ⚠ Verify column positions match your VENDOR_TEMPLATE before deploying.
function snapshotVendorOrders_(orderDate, timestamp) {
  const ss      = SpreadsheetApp.getActiveSpreadsheet();
  const vendors = getVendorList();
  const rows    = [];

  // Log every tab where an item was actually counted (On Hand entered) and its
  // suggested qty > 0 — including backup/secondary vendors. On-Hand is per tab,
  // so an item is only ordered from the vendor(s) it was counted on; there's no
  // primary-only filter, so a legitimate backup order (primary out of stock or
  // not delivering) is captured.




  // Item Name and Suggested Qty are computed in code (Item Name from
  // MASTER_ITEMS via readMasterItemMeta_; Suggested via the shared
  // computeSuggestedQty_ helper) — NOT read from the vendor tab's col-A / col-F
  // formulas. That's the same math the PWA count screen and daily recap use, so
  // the logged order matches what the KM saw. The tab is read for On Hand
  // (col E, real data) and Item ID (col M, the roster spill) only.
  const VTAB_ITEM_ID_COL = VENDOR_TAB.ITEM_ID_COL;    // M — Item ID (hidden)
  const VTAB_ON_HAND_COL = VENDOR_TAB.ON_HAND_COL;    // E (5)
  const VTAB_READ_TO_COL = VENDOR_TAB.ITEM_ID_COL;    // read through M

  // Shared read context, built once for all vendors.
  const masterMeta        = readMasterItemMeta_();
  const vendorMults       = readVendorMultipliers_(getSheet_(SHEET_SETUP));
  const emergencyOverride = readEmergencyOverride_();
  const dayOfWeek         = getActiveOrderDate_().dayOfWeek;

  vendors.forEach(vendor => {
    const sh = ss.getSheetByName(vendor);
    if (!sh) return;

    const lastRow = sh.getLastRow();
    if (lastRow < VENDOR_TAB.DATA_START_ROW) return;

    const numRows = lastRow - VENDOR_TAB.DATA_START_ROW + 1;
    const data    = sh
      .getRange(VENDOR_TAB.DATA_START_ROW, 1, numRows, VTAB_READ_TO_COL)
      .getValues();

    const dayMult = vendorDayMultiplier_(vendorMults, vendor, dayOfWeek, emergencyOverride);

    data.forEach(r => {
      const itemId = String(r[VTAB_ITEM_ID_COL - 1] || "").trim();
      if (!itemId) return;

      // Non-roster / blank-name row — same skip as the count path (old code
      // skipped on a blank col-A, which is XLOOKUP(id,…)="" for these rows).
      const meta = masterMeta.get(itemId);
      if (!meta || !meta.name) return;

      const onHandRaw = r[VTAB_ON_HAND_COL - 1];
      const onHand = (onHandRaw === "" || onHandRaw === null || isNaN(Number(onHandRaw)))
        ? null
        : Number(onHandRaw);

      const suggested = computeSuggestedQty_(meta.par, meta.useMult, dayMult, onHand);
      if (suggested == null || suggested <= 0) return;

      rows.push([timestamp, orderDate, vendor, itemId, meta.name, (onHand === null ? 0 : onHand), suggested]);
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
