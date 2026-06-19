/************************************************************
 * MOG — Vendor management — add/import/remove/recalibrate, cadence, templates.
 * Split out of OrderGuideScript.gs (god-object split).
 * All .gs files share one global scope; global constants
 * live in Core.gs. Functions here reference them at call time.
 ************************************************************/









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
