/************************************************************
 * MOG — Vendor management — add/import/remove/recalibrate, cadence, templates.
 * Split out of OrderGuideScript.gs (god-object split).
 * All .gs files share one global scope; global constants
 * live in Core.gs. Functions here reference them at call time.
 ************************************************************/









/***********************
 * 4) VENDORS
 ***********************/
function showManageVendorsSidebar_() {
  if (refuseCatalogToolInSheet_()) return;   // Sync.gs: the store edits its catalog in the app
  const tmpl = HtmlService.createTemplateFromFile("ManageVendors");
  // Pre-load the full vendor table data so the modal renders without a second
  // server roundtrip. Was previously also calling getVendorTableData_() on init.
  tmpl.vendorListJson  = JSON.stringify(getVendorList());
  tmpl.vendorTableJson = JSON.stringify(getVendorTableData_());
  tmpl.webBootJson     = sheetBootJson_();   // in-Sheet dialog: web bits off, plus its token for webedit_call
  SpreadsheetApp.getUi().showModalDialog(
    tmpl.evaluate().setWidth(MODAL_SM_W).setHeight(MODAL_SM_H),
    "Manage Vendors"
  );
}




// Returns all vendors with their 7-day multipliers for the View All tab.
// Returns [{name, mults: [mon,tue,wed,thu,fri,sat,sun]}]
// Cache wrapper (mog-apps-script-caching pattern A, 2026-07-29): read on the
// Manage Vendors doGet render + the Manage Items bootstrap. Same shared-ts
// invalidation and same mid-write caveat as getVendorList above.
function getVendorTableData_() {
  var ts  = getServerMutationTs_();
  var key = 'vendorTable_v1:' + ts;
  var cache = CacheService.getDocumentCache();
  try {
    var hit = cache.get(key);
    if (hit) return JSON.parse(hit);
  } catch (e) { /* fail-safe — compute on cache error */ }
  var result = getVendorTableData_compute_();
  try { cache.put(key, JSON.stringify(result), 300); } catch (e) { /* fail-safe */ }
  return result;
}

function getVendorTableData_compute_() {
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
function commitAddVendor_(vendorName, mults, cutoffTime) {
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
  // _compute_ (cache bypass): this fn bumped the mutation ts at its start, so
  // the cached wrapper would store this PRE-insert list under the POST-bump
  // key — serving a stale vendor list for up to the cache TTL after the add.
  const existing = getVendorList_compute_();
  if (existing.some(v => v.toLowerCase() === name.toLowerCase())) {
    throw new Error('"' + name + '" already exists.');
  }




  // 1b. Pre-emptive DB cleanup - if stale pick path rows exist for this vendor
  //     (e.g. from a previous remove + re-add cycle), clear them now so nothing
  //     carries over. Safe to call even if no rows exist for this vendor.
  // Locked: read-filter-write of the whole pick DB (see withPickDbLock_).
  withPickDbLock_(() => {
    const setupForCleanup = getSheet_(VENDOR_TABLE.SHEET);
    const existingDb      = readPickDb_(setupForCleanup);
    const vLowClean       = name.toLowerCase();
    const cleanedDb       = existingDb.filter(r => String(r[0] || "").trim().toLowerCase() !== vLowClean);
    if (cleanedDb.length !== existingDb.length) {
      writePickDb_(setupForCleanup, cleanedDb);
    }
  });




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
    "📱 Mobile API → 🩺 Store Health Check and use its Re-establish Template " +
    "fix before adding a vendor."
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
  // Tab reordering is cosmetic and only works from the Sheet UI — a web-app
  // (/exec editor) execution has no active sheet, so moveActiveSheet/
  // setActiveSheet throw "Please create an active sheet first". That throw used
  // to abort the add AFTER the vendor was already created (empty client refresh,
  // duplicate on retry). Best-effort: swallow the web-context failure.
  try { ss.moveActiveSheet(ss.getSheets().length); } catch (e) {}




  // Re-pin ORDER_ENTRY to position 1 (cosmetic; see the note above — best-effort).
  try {
    const orderEntry = ss.getSheetByName(SHEET_ORDER_ENTRY);
    if (orderEntry) { ss.setActiveSheet(orderEntry); ss.moveActiveSheet(1); }
  } catch (e) {}




  // 6. Strip ALL protections inherited from the template BEFORE writing B1.
  newSheet.getProtections(SpreadsheetApp.ProtectionType.SHEET).forEach(p => p.remove());
  newSheet.getProtections(SpreadsheetApp.ProtectionType.RANGE).forEach(p => p.remove());




  // Update B1 (merged B1:F1) — the vendor header. B1 drives BOTH the H2
  // multiplier match AND the M-spine FILTER, so if it doesn't land the tab
  // renders EMPTY (a plain setValue was seen not to persist on some clones —
  // the tab kept the template's "VENDOR TEMPLATE" header, silently breaking it).
  // setVendorHeaderB1_ writes it robustly (break-merge / write / re-merge /
  // flush / read-back-retry) so it can't quietly fail.
  const b1ok = setVendorHeaderB1_(newSheet, name);




  // 7. Apply fresh sheet protection: lock everything except E3:E1000 (On Hand).
  const protection = newSheet.protect().setDescription("Vendor tab - protected");
  protection.setUnprotectedRanges([newSheet.getRange("E3:E1000")]);
  protection.removeEditors(protection.getEditors());




  // b1ok = did the tab header (B1) actually land? A false here means the tab
  // was created but would render empty; the caller surfaces a warning and the
  // Store Health Check "Vendor tab headers" fix is the backstop.
  return { ok: true, name, b1ok };
}


// Write a vendor tab's B1 header (merged B1:F1) reliably. B1 drives BOTH the H2
// multiplier match and the M-spine FILTER, so a wrong/stale B1 silently empties
// the whole tab. A plain setValue on the merged cell has been observed NOT to
// persist on freshly-cloned tabs (they kept "VENDOR TEMPLATE"), so: break the
// merge, write, re-merge, flush, then read back and retry once. Returns true if
// B1 ends up correct. Shared by commitAddVendor_ and the Health Check fix.
function setVendorHeaderB1_(sheet, name) {
  const want = String(name).trim();
  const hdr  = sheet.getRange("B1:F1");
  const merged = hdr.isPartOfMerge();
  if (merged) hdr.breakApart();
  sheet.getRange("B1").setValue(want);
  if (merged) hdr.merge();
  SpreadsheetApp.flush();
  if (String(sheet.getRange("B1").getValue()).trim() !== want) {
    sheet.getRange("B1").setValue(want);
    SpreadsheetApp.flush();
  }
  return String(sheet.getRange("B1").getValue()).trim() === want;
}


// Health Check fix (fix_vendor_headers): repair any vendor tab whose B1 header
// drifted from its vendor name (e.g. a clone that kept "VENDOR TEMPLATE"), which
// makes the tab show a count but an empty list. UI-free core — callable from the
// web editor. Bumps the mutation ts so the PWA/dashboard caches refresh.
function fixVendorHeaders_core_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const fixed = [];
  getVendorList().forEach(function (v) {
    const sh = ss.getSheetByName(v);
    if (!sh) return;
    if (String(sh.getRange("B1").getValue()).trim() !== String(v).trim()) {
      setVendorHeaderB1_(sh, v);
      fixed.push(v);
    }
  });
  if (fixed.length && typeof bumpServerMutationTs_ === 'function') bumpServerMutationTs_();
  return { fixed: fixed.length, names: fixed };
}


// Called by ManageVendors sidebar - inline editor save.
// Commits multipliers (S:Y) AND cutoff (AA) for a vendor in a single
// RPC against one row lookup. Validates both inputs upfront so we fail
// before any write — no partial-success state where mults saved but
// cutoff didn't (or vice versa).
function commitUpdateVendorMultsAndCutoff_(vendorName, mults, cutoffTime) {
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


// ── Re-establish a clean hidden VENDOR_TEMPLATE from a healthy vendor tab ──
// The template is the clone source for Add Vendor. On some stores (e.g. rprfo)
// it was deleted, leaving Add Vendor to guess at ss.getSheets()[3] (now removed
// — see commitAddVendor_). This rebuilds it STRUCTURALLY rather than from
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

  // Re-pin ORDER_ENTRY to position 1 — cosmetic, and only works from the Sheet
  // UI (a web-app execution has no active sheet and would throw). Best-effort.
  try {
    const orderEntry = ss.getSheetByName(SHEET_ORDER_ENTRY);
    if (orderEntry) { ss.setActiveSheet(orderEntry); ss.moveActiveSheet(1); }
  } catch (e) {}

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
function commitRemoveVendor_(vendorName) {
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




  // Delete ONLY this vendor's cells: the vendor table R:AA (name, Mon-Sun
  // multipliers, list, cutoff) and its day pick in AF, shifting the vendors
  // below up so every vendor column stays row-aligned. Never the whole row:
  // SETUP's other tables share these rows, so deleteRow also removed a
  // pick-path row (K:P), a storage area (H:I) and a recipient (AB:AE) (D18).
  setup.getRange(deletedRow, VENDOR_TABLE.VENDOR_COL, 1, VENDOR_CUTOFF_COL - VENDOR_TABLE.VENDOR_COL + 1)
       .deleteCells(SpreadsheetApp.Dimension.ROWS);
  setup.getRange(deletedRow, VENDOR_OVERRIDE_COL, 1, 1)
       .deleteCells(SpreadsheetApp.Dimension.ROWS);




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




// Cache wrapper (mog-apps-script-caching pattern A, 2026-07-29 web-editor
// slowness fix): the vendor list is read on nearly every editor doGet render
// and by many server paths. Keyed on the shared mutation ts — every vendor
// mutator bumps it, so invalidation is free. WRITERS BEWARE: a mutator that
// bumps at its START and then reads the list BEFORE mutating must call
// getVendorList_compute_() directly (commitAddVendor_ does), or it caches the
// pre-mutation list under the post-bump key.
function getVendorList() {
  var ts  = getServerMutationTs_();
  var key = 'vendorList_v1:' + ts;
  var cache = CacheService.getDocumentCache();
  try {
    var hit = cache.get(key);
    if (hit) return JSON.parse(hit);
  } catch (e) { /* fail-safe — compute on cache error */ }
  var result = getVendorList_compute_();
  try { cache.put(key, JSON.stringify(result), 300); } catch (e) { /* fail-safe */ }
  return result;
}

function getVendorList_compute_() {
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
// entries. Used by buildHomeDashboard_ to size the vendor tile section.
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
//
// Mirrors vendorDayMultiplier_ (MOGApi.gs) exactly, including Emergency
// Override: override off → today's multiplier from SETUP S:Y; override on →
// the KM's per-vendor day pick (SETUP!AF, written by the PWA's "when is the
// next delivery after this one?" picker) when set, else "bridge to the next
// real delivery" (first mult > 0 scanning forward from today inclusive,
// wrapping the week; all-zero row → 1). Unknown vendor or day label → 0,
// both states — same as the code. The AF check nests INSIDE the override
// branch, matching vendorDayMultiplier_'s structure: AF is cleared whenever
// AD2 clears, and a stray leftover must not inflate a normal day. (Until
// 2026-07-24 the sheet diverged under override with a flat 1×; that was the
// accepted "option A" gap from the 07-02 override redesign, closed by this
// formula. The AF branch is the 2026-08-07 per-vendor day picker.)
function vendorTabH2Formula_() {
  const overrideRef = 'ORDER_ENTRY!' + toAbsoluteA1_(DASH.EMERGENCY_OVERRIDE);
  const dayRef      = 'ORDER_ENTRY!' + toAbsoluteA1_(DASH.ORDER_DAY);
  return '=LET(' +
      'vrow, IFERROR(MATCH(TRIM($B$1), ARRAYFORMULA(TRIM(SETUP!$R$2:$R)), 0), 0), ' +
      'dcol, IFERROR(MATCH(' + dayRef + ', ARRAYFORMULA(TRIM(SETUP!$S$1:$Y$1)), 0), 0), ' +
      'IF(OR(vrow=0, dcol=0), 0, ' +
        'LET(wk, ARRAYFORMULA(N(INDEX(SETUP!$S$2:$Y, vrow, 0))), ' +
            'ovr, IFERROR(N(INDEX(SETUP!$AF$2:$AF, vrow)), 0), ' +
          'IF(' + overrideRef + '=TRUE, ' +
            'IF(ovr>0, ovr, ' +
              'LET(rot, CHOOSECOLS(wk, ARRAYFORMULA(MOD(dcol-1+SEQUENCE(1,7,0),7)+1)), ' +
                  'pos, IFERROR(MATCH(TRUE, ARRAYFORMULA(rot>0), 0), 0), ' +
                  'IF(pos=0, 1, INDEX(rot, 1, pos)))), ' +
            'INDEX(wk, 1, dcol)))))';
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
