/************************************************************
 * MOG — Order history modal + par-review flags.
 * Split out of OrderGuideScript.gs (god-object split).
 * All .gs files share one global scope; global constants
 * live in Core.gs. Functions here reference them at call time.
 ************************************************************/





// Opens the Order History modal from the menu.
function showOrderHistoryModal_() {
  ensureLogSheet_();
  const tmpl = HtmlService.createTemplateFromFile("OrderHistory");
  tmpl.webBootJson = sheetBootJson_();   // in-Sheet dialog: web bits off, plus its token for webedit_call
  SpreadsheetApp.getUi().showModalDialog(
    tmpl.evaluate().setWidth(MODAL_LG_W).setHeight(MODAL_LG_H),
    "Order History"
  );
}




// Single-RPC modal-open path. Returns { vendors, rows } in one pass so the
// client doesn't need a separate vendor-list round-trip and the server
// doesn't read LOG_ORDERS twice. Vendor list is derived from the
// unfiltered log (the dropdown must show every vendor regardless of filter);
// rows are the filtered set, same shape getOrderHistory_ returns.
function getOrderHistoryBootstrap_(filters) {
  const logSheet = ensureLogSheet_();
  const lastRow  = logSheet.getLastRow();
  if (lastRow < 2) return { vendors: getVendorList(), rows: [] };

  // Deliberately a FULL read, not a readLogSlice_ one: this is the only caller
  // that consumes buildHistoryRows_'s unfiltered `vendors` set (it populates the
  // modal's vendor dropdown), and slicing would drop vendors whose only orders
  // fall outside the filter window. It still gains the memoized formatters.
  const data  = logSheet.getRange(2, 1, lastRow - 1, LOG_COL.QTY_ORDERED).getValues();
  const built = buildHistoryRows_(data, filters);
  return {
    vendors: built.vendors.length ? built.vendors : getVendorList(),
    rows:    built.rows
  };
}


// ── LOG_ORDERS read discipline ────────────────────────────────────────────
// LOG_ORDERS grows without bound: one row per item, per vendor, per cycle,
// forever. Every reader below is written to touch as little of it as possible,
// because the PWA's history tab used to pay for the WHOLE sheet (plus a full
// MASTER_ITEMS read, plus a Utilities.formatDate call per row per column) just
// to render a list of dates. Three levers, all output-identical:
//   1. readLogSlice_    — read only the rows that can match the date filter.
//   2. memoized formatters — one formatDate per DISTINCT date, not per row.
//   3. lazy pack map    — readers that never surface pack skip MASTER entirely.

// Formats a LOG_ORDERS date/timestamp cell, memoized by raw cell value.
// A cycle stamps the same orderDate onto every row it logs and the same
// timestamp onto every row of a vendor, so the same handful of values repeat
// across thousands of rows; Utilities.formatDate is comparatively expensive.
// Output is byte-identical to formatting each row independently — the memo key
// includes typeof so a numeric 5 and the string "5" can't collide (they parse
// to different dates).
function makeLogDateFormatter_(tz, pattern) {
  const memo = new Map();
  return function (v) {
    if (!v) return "";
    const key = (typeof v) + ':' + ((v instanceof Date) ? v.getTime() : v);
    const hit = memo.get(key);
    if (hit !== undefined) return hit;
    const d = (v instanceof Date) ? v : new Date(v);
    const out = isNaN(d.getTime()) ? String(v).trim() : Utilities.formatDate(d, tz, pattern);
    memo.set(key, out);
    return out;
  };
}

// Reads the LOG_ORDERS rows that could fall within [dateFrom, dateTo], cols
// 1..maxCol. Bounds the span by first scanning ONLY the order-date column —
// the cheapest possible full-height read — for the first and last matching
// row, then reading just that span.
//
// Deliberately makes NO assumption that the log is chronological: if matching
// rows are scattered the span simply widens, and the worst case degrades to
// exactly the old full-sheet read. In practice the log IS append-ordered by
// cycle, so a 30-day window reads a small tail and a single-day query reads a
// few dozen rows. Returns null when nothing can match.
//
// The span may still contain out-of-range rows — callers must keep filtering.
function readLogSlice_(logSheet, dateFrom, dateTo, maxCol, fmtDate) {
  const lastRow = logSheet.getLastRow();
  if (lastRow < 2) return null;
  const n = lastRow - 1;
  if (!dateFrom && !dateTo) {
    return logSheet.getRange(2, 1, n, maxCol).getValues();
  }
  const dates = logSheet.getRange(2, LOG_COL.ORDER_DATE, n, 1).getValues();
  let min = -1, max = -1;
  for (let i = 0; i < n; i++) {
    const d = fmtDate(dates[i][0]);
    if (dateFrom && d < dateFrom) continue;   // "" (blank date) sorts below any bound
    if (dateTo   && d > dateTo)   continue;
    if (min < 0) min = i;
    max = i;
  }
  if (min < 0) return null;
  return logSheet.getRange(2 + min, 1, max - min + 1, maxCol).getValues();
}


// Shared enrich + filter + sort for the order-history readers. Takes the
// raw LOG_ORDERS data rows (7 cols) + the filter object; returns { rows, vendors }
// — rows enriched, filtered, and date-desc (bootstrap shape); vendors the full
// UNFILTERED vendor set (for the dropdown), so callers that need a complete
// vendor list must pass UNSLICED data. itemPack is the CURRENT pack from
// MASTER_ITEMS (the log doesn't store pack) — rare pack changes are fine.
//
// opts.needPack: false skips the MASTER_ITEMS read entirely and leaves
// itemPack "" — for callers that only aggregate dates/vendors/counts. Defaults
// to true so every existing caller is unchanged.
// fmtDateShared: an existing memoized yyyy-MM-dd formatter to reuse, so a
// caller that already formatted the date column doesn't format it twice.
function buildHistoryRows_(data, filters, opts, fmtDateShared) {
  const needPack = !(opts && opts.needPack === false);
  const tz = SpreadsheetApp.getActiveSpreadsheet().getSpreadsheetTimeZone();

  // Same map buildPackByIdMap_ produces (COL.ID is 1, so the ranges and join
  // are identical) — consolidated onto it rather than kept as a second copy.
  const packMap = needPack ? buildPackByIdMap_() : null;

  const fmtDate      = fmtDateShared || makeLogDateFormatter_(tz, "yyyy-MM-dd");
  const fmtTimestamp = makeLogDateFormatter_(tz, "yyyy-MM-dd HH:mm");

  // LOG_ORDERS cells as history rows; the filter, sort and vendor list are
  // OrderMath.gs's (historyRowsFiltered_), shared with the app's order log.
  const rows = data.map(r => {
    const itemId = String(r[LOG_COL.ITEM_ID - 1] || "").trim();
    return {
      timestamp:  fmtTimestamp(r[LOG_COL.TIMESTAMP   - 1]),
      orderDate:  fmtDate(r[LOG_COL.ORDER_DATE   - 1]),
      vendor:     String(r[LOG_COL.VENDOR  - 1] || "").trim(),
      itemId:     itemId,
      itemName:   String(r[LOG_COL.ITEM_NAME   - 1] || "").trim(),
      itemPack:   packMap ? (packMap.get(itemId) || "") : "",
      onHandPrev: Number(r[LOG_COL.ON_HAND_PRV - 1]) || 0,
      qtyOrdered: Number(r[LOG_COL.QTY_ORDERED - 1]) || 0
    };
  });
  return historyRowsFiltered_(rows, filters);
}




// Serves Tab 1 (Recent Orders) and Tab 2 (Item History) in the modal.
// filters: { vendorFilter, dateFrom, dateTo }
// opts is forwarded to buildHistoryRows_ (see needPack there).
//
// Reads a date-bounded SLICE, not the whole log. Safe to slice here because
// every caller consumes only .rows — the unfiltered `vendors` set, which needs
// the full sheet to be complete, is used exclusively by
// getOrderHistoryBootstrap_, which keeps its own full read below.
function getOrderHistory_(filters, opts) {
  const logSheet = ensureLogSheet_();
  const f  = filters || {};
  const tz = SpreadsheetApp.getActiveSpreadsheet().getSpreadsheetTimeZone();
  // One memoized formatter shared by the slice scan AND the enrich pass, so
  // the order-date column costs one formatDate per DISTINCT date in total.
  const fmtDate = makeLogDateFormatter_(tz, "yyyy-MM-dd");
  const data = readLogSlice_(
    logSheet,
    String(f.dateFrom || '').trim(),
    String(f.dateTo   || '').trim(),
    LOG_COL.QTY_ORDERED,
    fmtDate
  );
  if (!data) return [];
  return buildHistoryRows_(data, filters, opts, fmtDate).rows;
}




// ── (removed 2026-06-01) getOrderSummary + getOrderHistoryVendorList ──
// Both dead. OrderHistory.html builds the Vendor Summary aggregation
// client-side from getOrderHistory_, and the vendor dropdown is populated
// inline by getOrderHistoryBootstrap_ — neither server fn had a caller.
// Recoverable via git history.


// Clears all data rows in LOG_ORDERS (header row preserved).
// Called by commitSelectiveReset_ when options.orderLog is true.
function clearOrderLog_() {
  const logSheet = ensureLogSheet_();
  const lastRow  = logSheet.getLastRow();
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
//   • 4-week rolling window (widened from 2 weeks, 2026-07-07): too many
//     slower-moving items never accumulated enough orders in 2 weeks to get
//     any verdict, so most of the catalog showed "No data yet". A 3x/week
//     vendor now lands ~12 data points; 2x/week ~8; 1x/week ~4.
//   • MIN_ORDERS=3 (raised from 2, 2026-07-07): the floor prevents a single
//     anomalous entry from triggering a flag; matches the client display
//     threshold in ManageItems.html (buildFlagPill / buildFlagDetail).
//   • Under-ordered uses on-hand ≤ 10% of par (not on-hand=0 directly)
//     because par=1 items would always read "empty" — at par=1 the only
//     possible non-stockout value IS 1. The 10% threshold treats "running
//     out" as a meaningful signal only when par is ≥ 3 (so 10% rounds to
//     a value that 0 actually distinguishes from). Items at par 1 or 2
//     are excluded from the under flag entirely.
//   • Over-ordered at 75%/50% (on-hand cutoff raised 50% → 75%, 2026-07-08):
//     On Hand is counted post-lunch, so ~half a daily par is legitimately
//     reserved for dinner service + PM prep — half-full at count time is
//     normal, not over. Only when 75%+ of par is still on the shelf, on ≥50%
//     of orders, is the par genuinely too high. Biased conservative on
//     purpose ("don't cut a par you might need"); the KM makes the final call.
//   • Over-ordered floor (2026-07-07): skip the flag on low-volume items —
//     base par < 1 unit (pre-calc), or the typical multiplied order averages
//     < 2 units (post-calc, reconstructed as qty + on hand). You can't order a
//     fraction of a unit, so trimming a 1–2-unit item's par isn't actionable
//     (mirrors UNDER_PAR_MIN on the under side).
//   • Over-ordered absolute floor (2026-07-08): skip it when the average On
//     Hand left is under 1 unit; base-par detection can flag a case-pack item
//     (a case of Pellegrino) on a fraction of a unit.
// The numbers themselves are parFlagRules_ in OrderMath.gs, and the math is
// parReviewFlags_ there: one copy for this Sheet and for the app's editor,
// which reads Supabase's order log (docs/MOG_OneApp_Spec.md E4, T1).




// FLAG VALUES returned in the map:
//   "empty"    → Always Empty  (under-ordered: on hand consistently near zero,
//                                par must be ≥ UNDER_PAR_MIN to qualify)
//   "over"     → Over-Ordered  (on hand ≥ 75% of par in ≥ 50% of orders)
//   "both"     → both conditions true simultaneously
//   null       → not enough data or no flag




// ── getParReviewFlags_ ────────────────────────────────────────────────────────
// Called by ManageItems on load.
// Reads LOG_ORDERS and MASTER_ITEMS (for par values), computes flags per item.
//
// Window: only orders from the last PAR_FLAG.WINDOW_DAYS (currently 28) are
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
function getParReviewFlags_(parMap) {
  const logSheet = ensureLogSheet_();
  const lastRow  = logSheet.getLastRow();
  if (lastRow < 2) return {};
  const data = logSheet.getRange(2, 1, lastRow - 1, 7).getValues();

  // Par lookup (itemId → par number, par>0 only). getManageItemsBootstrap_
  // passes a prebuilt map — it already read MASTER via getAllItemsForView_, so
  // this avoids a second MASTER read on the modal-open path (audit #13).
  // Called standalone (parMap omitted) it reads MASTER here, as before.
  if (!parMap) {
    parMap = new Map();
    const master     = getSheet_(SHEET_MASTER);
    const masterLast = master.getLastRow();
    if (masterLast >= 2) {
      master.getRange(2, COL.ID, masterLast - 1, COL.PAR - COL.ID + 1)
        .getValues()
        .forEach(r => {
          const id  = String(r[0] || "").trim();
          const par = Number(r[COL.PAR - COL.ID]);
          if (id && !isNaN(par) && par > 0) parMap.set(id, par);
        });
    }
  }

  // The window is counted in the script's calendar: an order date (a Date
  // cell, or text parsed as before) on or after the day WINDOW_DAYS before
  // today. Formatting both sides in the script's time zone keeps exactly the
  // old Date comparison (order date >= local midnight of the cutoff day).
  const tz = Session.getScriptTimeZone();
  const cutoff = new Date();
  cutoff.setHours(0, 0, 0, 0);
  cutoff.setDate(cutoff.getDate() - parFlagRules_().WINDOW_DAYS);
  const fmt = makeLogDateFormatter_(tz, "yyyy-MM-dd");
  const rows = data.map(r => {
    const raw = r[LOG_COL.ORDER_DATE - 1];
    const d   = (raw instanceof Date) ? raw : new Date(raw);
    return {
      itemId:     String(r[LOG_COL.ITEM_ID - 1] || "").trim(),
      orderDate:  isNaN(d.getTime()) ? "" : fmt(d),
      onHandPrev: Number(r[LOG_COL.ON_HAND_PRV - 1]) || 0,
      qtyOrdered: Number(r[LOG_COL.QTY_ORDERED - 1]) || 0
    };
  });
  return parReviewFlags_(rows, parMap, fmt(cutoff));
}
