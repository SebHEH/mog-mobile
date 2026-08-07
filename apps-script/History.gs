/************************************************************
 * MOG — Order history modal + par-review flags.
 * Split out of OrderGuideScript.gs (god-object split).
 * All .gs files share one global scope; global constants
 * live in Core.gs. Functions here reference them at call time.
 ************************************************************/





// Opens the Order History modal from the menu.
function showOrderHistoryModal() {
  ensureLogSheet_();
  const tmpl = HtmlService.createTemplateFromFile("OrderHistory");
  tmpl.webBootJson = JSON.stringify({ web: false });   // in-Sheet dialog: web bits stay inert
  SpreadsheetApp.getUi().showModalDialog(
    tmpl.evaluate().setWidth(MODAL_LG_W).setHeight(MODAL_LG_H),
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

  const vendorFilter = String(filters && filters.vendorFilter || "ALL").trim();
  const dateFrom     = String(filters && filters.dateFrom     || "").trim();
  const dateTo       = String(filters && filters.dateTo       || "").trim();

  const vendorSet = new Set();
  const rows = data
    .map(r => {
      const itemId = String(r[LOG_COL.ITEM_ID - 1] || "").trim();
      const vendor = String(r[LOG_COL.VENDOR  - 1] || "").trim();
      if (vendor) vendorSet.add(vendor);
      return {
        timestamp:  fmtTimestamp(r[LOG_COL.TIMESTAMP   - 1]),
        orderDate:  fmtDate(r[LOG_COL.ORDER_DATE   - 1]),
        vendor:     vendor,
        itemId:     itemId,
        itemName:   String(r[LOG_COL.ITEM_NAME   - 1] || "").trim(),
        itemPack:   packMap ? (packMap.get(itemId) || "") : "",
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

  return { rows: rows, vendors: Array.from(vendorSet).sort() };
}




// Serves Tab 1 (Recent Orders) and Tab 2 (Item History) in the modal.
// filters: { vendorFilter, dateFrom, dateTo }
// opts is forwarded to buildHistoryRows_ (see needPack there).
//
// Reads a date-bounded SLICE, not the whole log. Safe to slice here because
// every caller consumes only .rows — the unfiltered `vendors` set, which needs
// the full sheet to be complete, is used exclusively by
// getOrderHistoryBootstrap, which keeps its own full read below.
function getOrderHistory(filters, opts) {
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
// client-side from getOrderHistory, and the vendor dropdown is populated
// inline by getOrderHistoryBootstrap — neither server fn had a caller.
// Recoverable via git history.


// Clears all data rows in LOG_ORDERS (header row preserved).
// Called by commitSelectiveReset when options.orderLog is true.
function clearOrderLog() {
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
const PAR_FLAG = {
  MIN_ORDERS:        3,    // minimum logged orders within the window (2→3, 2026-07-07)
  WINDOW_DAYS:       28,   // only count orders from the last 28 days (14→28, 2026-07-07)

  // Under-ordered ("Always Empty")
  UNDER_PAR_MIN:     3,    // par must be ≥ this for the flag to apply
  UNDER_ONHAND_PCT:  0.10, // On Hand ≤ 10% of par counts as "under"
  UNDER_FREQ_PCT:    0.75, // ≥ 75% of orders were "under" → flag

  // Over-ordered
  OVER_ONHAND_PCT:   0.75, // On Hand ≥ 75% of par counts as "over" (50%→75%, 2026-07-08: counts are post-lunch, ~half a daily par is reserved for dinner + PM prep)
  OVER_FREQ_PCT:     0.50, // ≥ 50% of orders were "over"  → flag
  OVER_MIN_BASE_PAR: 1,    // skip over-flag when base par < 1 unit (nothing to trim, 2026-07-07)
  OVER_MIN_EFF_PAR:  2,    // skip over-flag when avg multiplied order (qty+onHand) < 2 units
  OVER_MIN_AVG_ONHAND: 1   // skip over-flag when avg On Hand left < 1 unit (2026-07-08: base-par detection can flag a case-pack item on a fraction of a unit)
};




// FLAG VALUES returned in the map:
//   "empty"    → Always Empty  (under-ordered: on hand consistently near zero,
//                                par must be ≥ UNDER_PAR_MIN to qualify)
//   "over"     → Over-Ordered  (on hand ≥ 75% of par in ≥ 50% of orders)
//   "both"     → both conditions true simultaneously
//   null       → not enough data or no flag




// ── getParReviewFlags ────────────────────────────────────────────────────────
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
function getParReviewFlags(parMap) {
  const logSheet = ensureLogSheet_();
  const lastRow  = logSheet.getLastRow();
  if (lastRow < 2) return {};




  // Read entire log in one batch
  const data = logSheet
    .getRange(2, 1, lastRow - 1, 7)
    .getValues();




  // Par lookup (itemId → par number, par>0 only) so we can compute % of par per
  // item. getManageItemsBootstrap passes a prebuilt map — it already read MASTER
  // via getAllItemsForView, so this avoids a second MASTER read on the modal-open
  // path (audit #13). Called standalone (parMap omitted) it reads MASTER here, as
  // before. The map is only used to look up par for logged item IDs, so the extra
  // blank-name MASTER rows the bootstrap map omits are never referenced.
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




  // Aggregate per item
  const agg = new Map(); // itemId → { timesOrdered, underCount, overCount, totalOnHand, par }




  // Rolling window cutoff: only count orders from the last WINDOW_DAYS.
  // Anything older is excluded from the aggregation, so a par change made
  // recently isn't dragged down by old behavior. A 4-week window gives
  // 3x/week vendors ~12 data points and daily vendors ~28.
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
        totalEffPar:  0,
        par:          parMap.get(itemId) || ""
      });
    }




    const entry = agg.get(itemId);
    entry.timesOrdered++;
    entry.totalOnHand += onHand;
    // Effective (multiplied) par for this order ≈ qty ordered + on hand, since
    // qty = ceil(par×mult − onHand). Averaged later to gate the over flag.
    entry.totalEffPar += (qtyOrdered + onHand);




    const par = parMap.get(itemId);
    if (!par || par <= 0) return;  // no par → can't compute either flag




    // Under-ordered: on hand ≤ 10% of par, AND par is high enough that
    // 0 is a meaningful signal (not just an artifact of par=1 or par=2).
    if (par >= PAR_FLAG.UNDER_PAR_MIN && onHand <= par * PAR_FLAG.UNDER_ONHAND_PCT) {
      entry.underCount++;
    }




    // Over-ordered: on hand ≥ 75% of par (raised from 50%, 2026-07-08). Counts
    // are post-lunch, so ~half a daily par is legitimately reserved for dinner +
    // PM prep; only 75%+ still on the shelf reads as a genuinely high par.
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

    // Over-ordering is only actionable when there's a whole unit to trim, so
    // skip the flag when:
    //   • base par is sub-unit (< OVER_MIN_BASE_PAR, pre-calc), or
    //   • the typical multiplied order (qty + on hand) averages below
    //     OVER_MIN_EFF_PAR units (post-calc), or
    //   • the average On Hand actually left on the shelf is below
    //     OVER_MIN_AVG_ONHAND units — the detection compares On Hand to the
    //     BASE par, so a small-base-par / high-multiplier item (e.g. a case of
    //     Pellegrino) can trip "over" on a fraction of a unit even though
    //     there's nothing to trim. This absolute floor catches that.
    // You can't order a fraction, so a low-volume item reading "over" isn't a
    // par problem.
    const basePar        = Number(entry.par) || 0;
    const avgOnHand      = entry.totalOnHand / entry.timesOrdered;
    const avgEffPar      = entry.totalEffPar / entry.timesOrdered;
    const overActionable = basePar    >= PAR_FLAG.OVER_MIN_BASE_PAR
                        && avgEffPar   >= PAR_FLAG.OVER_MIN_EFF_PAR
                        && avgOnHand   >= PAR_FLAG.OVER_MIN_AVG_ONHAND;
    const isOver = (overRate >= PAR_FLAG.OVER_FREQ_PCT) && overActionable;




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
