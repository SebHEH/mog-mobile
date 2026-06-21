/************************************************************
 * MOG — Item management — Manage Items modal CRUD + active-vendor switch.
 * Split out of OrderGuideScript.gs (god-object split).
 * All .gs files share one global scope; global constants
 * live in Core.gs. Functions here reference them at call time.
 ************************************************************/









/***********************
 * 5) MASTER ITEMS
 ***********************/
function showManageItemsSidebar() {
  const tmpl = HtmlService.createTemplateFromFile("ManageItems");
  tmpl.vendorListJson = JSON.stringify(getVendorList());
  tmpl.webBootJson    = JSON.stringify({ web: false });   // in-Sheet dialog: web bits stay inert
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
