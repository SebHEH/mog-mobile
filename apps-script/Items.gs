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




  // First storage area seen per item (from any pick-path row). Drives both the
  // hasArea flag ("is it placed anywhere?") and the storageArea display used by
  // the Assign-to-Vendor tab. Area is technically per (vendor,item); the item's
  // first/primary area is the meaningful one here (and what a new backup row
  // defaults to).
  const areaById = new Map();
  readPickDb_(getSheet_(SHEET_SETUP)).forEach(r => {
    const id   = String(r[1] || "").trim();
    const area = String(r[3] || "").trim();
    if (id && area && !areaById.has(id)) areaById.set(id, area);
  });




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
        hasArea: areaById.has(id),
        storageArea: areaById.get(id) || ""
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
//   - Key is 'manageItems_v4_' + getServerMutationTs_()
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
  const cacheKey = 'manageItems_v4_' + ts;

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
  // Areas + vendor multipliers ride the same response so the modal opens on
  // ONE round-trip (they used to be 1–2 separate calls: getStorageAreaList
  // always, getVendorTableData on the web host for the par preview). Same
  // failure tolerance as flags — the item list must render even if these
  // side reads throw. Both are invalidated correctly by the mutation-ts key:
  // area and vendor commits all bump the ts.
  let areas = [];
  try { areas = getStorageAreaList(); } catch (e) { areas = []; }
  let vendorTable = [];
  try { vendorTable = getVendorTableData(); } catch (e) { vendorTable = []; }
  const payload = { items: items, flags: flags, areas: areas, vendorTable: vendorTable };

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
  // Pick-DB write lock (see withPickDbLock_ in Core.gs) — serializes this
  // save against concurrent pick-DB writers (other web commits, the in-sheet
  // onEdit auto-save). Reentrant, so the helpers this calls stay unwrapped.
  return withPickDbLock_(() => commitUpsertItem_locked_(payload));
}
function commitUpsertItem_locked_(payload) {
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
    // insertRowAfter copies the row-above's data-validation into the new row;
    // some stores carry a stray rule on the NAME column (B) that then rejects
    // the typed name ("violates data validation"). These are free text/number
    // fields with no legit validation, so clear it on the block before writing.
    // (The intentional checkbox validation on L:M is applied separately below.)
    const addBlock = sh.getRange(newRow, 1, 1, 7);
    addBlock.clearDataValidations();
    addBlock.setValues([[itemId, name, vendor, '', pack, '', par]]);

    // Eligible Vendors lives in column O, past the A:G block, so it's a
    // separate write. The active vendor (C) is always forced into the list.
    const eligibleAdd = normalizeEligibleList_(payload.eligibleVendors || [], vendor);
    const eligibleStr = serializeEligibleVendors_(eligibleAdd);
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
        commitPickPathAreaAssignment(itemId, vendor, String(payload.areaName).trim(), { itemName: name });
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
    // Place the item on every eligible vendor's tab (backups included), using
    // the area just assigned to the primary. No-op if no area yet. ctx passes
    // the values written above so the sync skips its full-MASTER re-read.
    syncItemEligiblePickRows_(itemId, { name: name, primary: vendor, eligible: eligibleAdd });
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
  editRange.clearDataValidations();   // strip any stray validation on A:G (e.g. NAME) before writing
  editRange.setValues([editVals]);

  // Eligible Vendors (column O, outside the A:G block): use the payload's list
  // when the form sent one; otherwise re-normalize whatever is stored so the
  // active vendor stays in the list. Separate read/write since O is past G.
  const eligibleCell   = sh.getRange(row, COL.ELIGIBLE_VENDORS);
  const eligibleSource = (payload.eligibleVendors !== undefined && payload.eligibleVendors !== null)
    ? payload.eligibleVendors
    : eligibleCell.getValue();
  const eligibleList = normalizeEligibleList_(eligibleSource, vendor);
  // Reassign = PROMOTE, not move (decision 2026-07-12): when the primary
  // changes, the old primary automatically stays as a secondary — the same
  // semantics as the View-detail "Make primary" quick-switch. Primaries swap
  // week to week on price/stock; the old source must stay orderable and its
  // pick row (with its area) survives via syncItemEligiblePickRows_ below.
  // To drop the old vendor entirely, uncheck it in a follow-up edit.
  const oldPrimary = String((existing && existing.vendor) || "").trim();
  if (oldPrimary &&
      oldPrimary.toLowerCase() !== vendor.toLowerCase() &&
      !eligibleList.some(v => v.toLowerCase() === oldPrimary.toLowerCase())) {
    eligibleList.push(oldPrimary);
  }
  eligibleCell.setNumberFormat("@").setValue(serializeEligibleVendors_(eligibleList));

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
      commitPickPathAreaAssignment(existing.id, vendor, String(payload.areaName).trim(), { itemName: editName });
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
  // Reconcile pick-path rows to the (possibly changed) eligible list: newly
  // checked vendors are placed on their tabs, unchecked ones removed. Skipped
  // when inactive — the block above already purged this item's rows. ctx
  // passes the values written above (incl. the promote-preserved eligible
  // list) so the sync skips its full-MASTER re-read.
  if (active) syncItemEligiblePickRows_(existing.id, { name: editName, primary: vendor, eligible: eligibleList });
  return { ok: true, mode: "edit", row, id: existing.id, assignedArea, areaError };
}




// Make another eligible vendor the PRIMARY (the one that drives order math).
// This rewrites MASTER_ITEMS column C only; it does NOT move the item off any
// tab. The previous primary keeps its pick-path row and stays as a secondary
// (reference/backup) appearance. The new primary gets a pick-path row if it
// didn't already have one, carrying the item's current storage area (areas are
// global, so the name is always valid). Par is untouched -- the new primary's
// day-multiplier on its tab applies automatically. In the two-vendor model an
// item can sit on several tabs at once; only the col-C vendor actually orders.
//
// Returns { ok, id, vendor, area, needsArea }. needsArea is true when the item
// had no storage area to carry over (it was unassigned), so the caller should
// prompt for one; it's still promoted, it just won't appear on the new
// primary's order sheet until an area is assigned.
function commitSwitchActiveVendor(itemId, newVendorRaw) {
  return withPickDbLock_(() => commitSwitchActiveVendor_locked_(itemId, newVendorRaw));
}
function commitSwitchActiveVendor_locked_(itemId, newVendorRaw) {
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

  // Flip the primary vendor (column C). The eligible list (O) already contains
  // newVendor, so O needs no change.
  master.getRange(row, COL.VENDOR).setValue(newVendor);

  // Promote to primary WITHOUT moving the item off any tab. In the multi-vendor
  // model an item can sit on several vendor tabs (one pick-path row each);
  // column C just marks the default order source. So we KEEP every existing
  // pick row — the old primary stays as a secondary/backup — and only ADD a row
  // for the new primary if it doesn't already have one, carrying the item's
  // current storage area so it lands on the new primary's order sheet.
  let assignedArea = "";
  const hasNewVendorRow = db.some(r =>
    String(r[0] || "").trim().toLowerCase() === newVendor.toLowerCase() &&
    String(r[1] || "").trim() === id);
  if (hasNewVendorRow) {
    assignedArea = currentArea;                 // already on the new primary's tab
  } else if (currentArea) {
    const areaOrderMap = getAreaOrderMap_();
    const areaOrder    = areaOrderMap.has(currentArea) ? areaOrderMap.get(currentArea) : 999;
    let   maxShelf     = 0;
    for (let j = 0; j < db.length; j++) {
      if (String(db[j][0] || "").trim().toLowerCase() === newVendor.toLowerCase() &&
          String(db[j][3] || "").trim() === currentArea) {
        maxShelf = Math.max(maxShelf, Number(db[j][5]) || 0);
      }
    }
    db.push([newVendor, id, name, currentArea, areaOrder, maxShelf + 10]);
    assignedArea = currentArea;
    writePickDb_(setup, db);
  }
  // (no area to carry → item is unassigned under the new primary; needsArea)

  // Refresh the SETUP working list if either vendor is the one selected there.
  reloadSetupIfVendorMatches_(oldVendor);
  reloadSetupIfVendorMatches_(newVendor);

  return { ok: true, id: id, vendor: newVendor, area: assignedArea, needsArea: !assignedArea };
}


// Reconcile ONE item's pick-path rows to its eligible list (MASTER col O) — the
// per-item "unify" that keeps col O and the vendor tabs in lockstep. Called by
// commitUpsertItem after a save, so checking a vendor in the Manage Items
// eligible list PLACES the item on that vendor's tab and unchecking REMOVES it:
//   * add a pick-path row for each eligible vendor that lacks one, defaulting to
//     the item's current storage area (so it lands next to its siblings);
//   * remove rows whose vendor is no longer eligible.
// The primary (col C) is always in the eligible list, so its row is never
// removed. If the item has no area anywhere yet, nothing can be placed (it's
// unassigned) — rows appear once an area is assigned. Returns {added, removed}.
//
// ctx (optional, ALL-OR-NOTHING): { name, primary, eligible } — passed by
// commitUpsertItem, which JUST WROTE those exact values to MASTER, so the
// full-MASTER findItemRow_ re-read (and col-O re-parse) is skipped. eligible
// must be the freshly-written normalized array — never a pre-edit read, or
// this reconciles the tabs to a stale list.
function syncItemEligiblePickRows_(itemId, ctx) {
  const id = String(itemId || "").trim();
  if (!id) return { added: 0, removed: 0 };
  let name, primary, eligible;
  if (ctx) {
    name     = String(ctx.name    || "").trim();
    primary  = String(ctx.primary || "").trim();
    eligible = ctx.eligible || [];
  } else {
    const found = findItemRow_(id);
    if (!found) return { added: 0, removed: 0 };
    const rv  = found.rowValues;
    name      = String(rv[COL.NAME   - 1] || "").trim();
    primary   = String(rv[COL.VENDOR - 1] || "").trim();
    const vendorMap = new Map(getVendorList().map(v => [v.toLowerCase(), v]));
    eligible  = normalizeEligibleList_(rv[COL.ELIGIBLE_VENDORS - 1], primary, vendorMap);
  }
  const eligLow = new Set(eligible.map(v => v.toLowerCase()));

  const setup = getSheet_(SHEET_SETUP);
  const db    = readPickDb_(setup);

  // The item's current storage area + which vendors already carry a row for it.
  let currentArea = "";
  const have = new Set();
  for (const r of db) {
    if (String(r[1] || "").trim() !== id) continue;
    if (!currentArea && String(r[3] || "").trim()) currentArea = String(r[3]).trim();
    const v = String(r[0] || "").trim();
    if (v) have.add(v.toLowerCase());
  }

  // Remove this item's rows whose vendor is no longer eligible.
  let removed = 0;
  const kept = db.filter(r => {
    if (String(r[1] || "").trim() !== id) return true;
    if (eligLow.has(String(r[0] || "").trim().toLowerCase())) return true;
    removed++;
    return false;
  });

  // Add a row for each eligible vendor missing one (needs an area to place onto).
  let added = 0;
  if (currentArea) {
    const areaOrderMap = getAreaOrderMap_();
    const areaOrder    = areaOrderMap.has(currentArea) ? areaOrderMap.get(currentArea) : 999;
    for (const vend of eligible) {
      if (have.has(vend.toLowerCase())) continue;
      let maxShelf = 0;
      for (const r of kept) {
        if (String(r[0] || "").trim().toLowerCase() === vend.toLowerCase() &&
            String(r[3] || "").trim() === currentArea) {
          maxShelf = Math.max(maxShelf, Number(r[5]) || 0);
        }
      }
      kept.push([vend, id, name, currentArea, areaOrder, maxShelf + 10]);
      added++;
    }
  }

  if (added || removed) {
    writePickDb_(setup, kept);
    eligible.forEach(v => reloadSetupIfVendorMatches_(v));
  }
  return { added: added, removed: removed };
}


// Vendor-first bulk assign — backs the "Assign to Vendor" tab. Given a vendor
// and the desired set of item IDs, reconciles that vendor's membership across
// ALL active items in one pass:
//   * items in `itemIds` (or where the vendor is their PRIMARY) → vendor added
//     to col O + placed on its tab, defaulting to the item's current area;
//   * items NOT in `itemIds` that list the vendor only as a BACKUP → vendor
//     removed from col O + dropped from its tab.
// An item's primary vendor (col C) is never removed here (that would orphan the
// item) — such rows stay on regardless of the checkbox. Items with no storage
// area yet are added to col O but can't be placed until assigned one; they're
// counted in `unplaced` so the UI can flag them. Batched: one col-O range write
// + one pick-DB write. Returns { ok, vendor, added, removed, unplaced }.
function commitSetVendorItems(vendorRaw, itemIds) {
  return withPickDbLock_(() => commitSetVendorItems_locked_(vendorRaw, itemIds));
}
function commitSetVendorItems_locked_(vendorRaw, itemIds) {
  bumpServerMutationTs_();
  const vendor = normalizeVendorOrThrow_(vendorRaw);
  const vLow   = vendor.toLowerCase();
  const wanted = new Set(
    (Array.isArray(itemIds) ? itemIds : []).map(x => String(x || "").trim()).filter(Boolean));

  const master  = getSheet_(SHEET_MASTER);
  const lastRow = master.getLastRow();
  if (lastRow < 2) return { ok: true, vendor: vendor, added: 0, removed: 0, unplaced: 0 };

  const vendorMap = new Map(getVendorList().map(v => [v.toLowerCase(), v]));
  const nRows = lastRow - 1;
  // One A:O block read replaces the five separate column reads this used to
  // make (ID, NAME, VENDOR, ACTIVE, O) — same data, one API round-trip.
  // oVals stays a standalone mutable array because col O is the only column
  // written back (single-column setValues on oRange below).
  const block  = master.getRange(2, 1, nRows, COL.ELIGIBLE_VENDORS).getValues();
  const oRange = master.getRange(2, COL.ELIGIBLE_VENDORS, nRows, 1);
  const oVals  = block.map(r => [r[COL.ELIGIBLE_VENDORS - 1]]);

  const setup = getSheet_(SHEET_SETUP);
  const db    = readPickDb_(setup);

  // Index: each item's current area + whether it already has a `vendor` row.
  const itemArea = new Map();
  const onVendor = new Set();
  for (const r of db) {
    const id   = String(r[1] || "").trim();
    const area = String(r[3] || "").trim();
    if (id && area && !itemArea.has(id)) itemArea.set(id, area);
    if (id && String(r[0] || "").trim().toLowerCase() === vLow) onVendor.add(id);
  }

  let added = 0, removed = 0, unplaced = 0, oChanged = false;
  const addRows   = [];
  const removeIds = new Set();

  for (let i = 0; i < nRows; i++) {
    const id = String(block[i][COL.ID - 1] || "").trim();
    if (!id) continue;
    const activeRaw = block[i][COL.ACTIVE - 1];
    const active = !(activeRaw === false ||
      (typeof activeRaw === "string" && activeRaw.trim().toLowerCase() === "false"));
    if (!active) continue;

    const primary   = String(block[i][COL.VENDOR - 1] || "").trim();
    const isPrimary  = primary.toLowerCase() === vLow;
    const want       = isPrimary || wanted.has(id);
    const eligible   = normalizeEligibleList_(oVals[i][0], primary, vendorMap);
    const hasElig    = eligible.some(v => v.toLowerCase() === vLow);

    if (want && !hasElig) {
      eligible.push(vendor);
      oVals[i][0] = serializeEligibleVendors_(eligible);
      oChanged = true;
    } else if (!want && hasElig && !isPrimary) {
      oVals[i][0] = serializeEligibleVendors_(eligible.filter(v => v.toLowerCase() !== vLow));
      oChanged = true;
    }

    const onTab = onVendor.has(id);
    if (want && !onTab) {
      const area = itemArea.get(id);
      if (area) { addRows.push({ id: id, name: String(block[i][COL.NAME - 1] || "").trim(), area: area }); added++; }
      else      { unplaced++; }
    } else if (!want && onTab && !isPrimary) {
      removeIds.add(id);
      removed++;
    }
  }

  if (oChanged) oRange.setNumberFormat("@").setValues(oVals);

  let newDb = db;
  if (removeIds.size) {
    newDb = newDb.filter(r =>
      !(String(r[0] || "").trim().toLowerCase() === vLow && removeIds.has(String(r[1] || "").trim())));
  }
  if (addRows.length) {
    const areaOrderMap = getAreaOrderMap_();
    const maxShelf = new Map();   // area -> max shelf order (this vendor)
    for (const r of newDb) {
      if (String(r[0] || "").trim().toLowerCase() !== vLow) continue;
      const a = String(r[3] || "").trim();
      const s = Number(r[5]) || 0;
      if ((maxShelf.get(a) || 0) < s) maxShelf.set(a, s);
    }
    for (const a of addRows) {
      const areaOrder = areaOrderMap.has(a.area) ? areaOrderMap.get(a.area) : 999;
      const shelf = (maxShelf.get(a.area) || 0) + 10;
      maxShelf.set(a.area, shelf);
      newDb.push([vendor, a.id, a.name, a.area, areaOrder, shelf]);
    }
  }
  if (removeIds.size || addRows.length) writePickDb_(setup, newDb);
  reloadSetupIfVendorMatches_(vendor);

  return { ok: true, vendor: vendor, added: added, removed: removed, unplaced: unplaced };
}


// Reconcile pick-path rows to the eligible lists — the "unify" backfill.
// Historically, adding a vendor to an item's eligible list (MASTER_ITEMS col O)
// did NOT create a pick-path row, so those vendors' tabs stayed empty (a vendor
// tab is built purely from SETUP pick-path rows). This places every eligible
// vendor onto its tab: for each ACTIVE item that already has a storage area
// somewhere, it ADDS a pick-path row (same area) for any eligible vendor that
// doesn't have one yet. Additive + idempotent — it never removes rows and never
// invents placements beyond what the eligible list already declares. Rows where
// the vendor isn't the item's primary (col C) are flagged as secondaries but are
// FULLY ORDERABLE — the badge only labels the default source (col C); On Hand
// per tab routes the order. Menu wrapper: syncEligibleVendorsToPickPath.
// Pass dryRun=true to COUNT the missing placements without writing (the
// Store Health Check uses this to decide whether to offer the fix).
function syncEligibleVendorsToPickPath_core_(dryRun) {
  // Dry runs only read — no lock needed (the health check calls this).
  if (dryRun) return syncEligibleVendorsToPickPath_run_(true);
  return withPickDbLock_(() => syncEligibleVendorsToPickPath_run_(false));
}
function syncEligibleVendorsToPickPath_run_(dryRun) {
  const master  = getSheet_(SHEET_MASTER);
  const lastRow = master.getLastRow();
  if (lastRow < 2) return { added: 0, byVendor: {}, itemsAffected: 0 };

  const vals      = master.getRange(2, 1, lastRow - 1, COL.ELIGIBLE_VENDORS).getValues(); // A..O
  const vendorMap = new Map(getVendorList().map(v => [v.toLowerCase(), v]));

  const setup = getSheet_(SHEET_SETUP);
  const db    = readPickDb_(setup);

  // Index existing pick-path state: which (vendor,id) rows exist, each item's
  // current area (first non-blank), and the max shelf order per (vendor,area).
  const have     = new Set();   // "vendorLower||id"
  const itemArea = new Map();   // id -> area
  const maxShelf = new Map();   // "vendorLower||area" -> max shelf order
  for (const r of db) {
    const v    = String(r[0] || "").trim();
    const id   = String(r[1] || "").trim();
    const area = String(r[3] || "").trim();
    const shelf = Number(r[5]) || 0;
    if (v && id) have.add(v.toLowerCase() + "||" + id);
    if (id && area && !itemArea.has(id)) itemArea.set(id, area);
    const mk = v.toLowerCase() + "||" + area;
    if ((maxShelf.get(mk) || 0) < shelf) maxShelf.set(mk, shelf);
  }

  const areaOrderMap = getAreaOrderMap_();
  const byVendor  = {};
  const affected  = new Set();
  const toAdd     = [];

  for (const row of vals) {
    const id = String(row[COL.ID - 1] || "").trim();
    if (!id) continue;
    const activeRaw = row[COL.ACTIVE - 1];
    const active = !(activeRaw === false ||
      (typeof activeRaw === "string" && activeRaw.trim().toLowerCase() === "false"));
    if (!active) continue;

    const area = itemArea.get(id);
    if (!area) continue;   // item isn't placed anywhere yet — nothing to mirror

    const name     = String(row[COL.NAME   - 1] || "").trim();
    const primary  = String(row[COL.VENDOR - 1] || "").trim();
    const eligible = normalizeEligibleList_(row[COL.ELIGIBLE_VENDORS - 1], primary, vendorMap);

    for (const vend of eligible) {
      const key = vend.toLowerCase() + "||" + id;
      if (have.has(key)) continue;                       // already on that tab
      const areaOrder = areaOrderMap.has(area) ? areaOrderMap.get(area) : 999;
      const mk    = vend.toLowerCase() + "||" + area;
      const shelf = (maxShelf.get(mk) || 0) + 10;
      maxShelf.set(mk, shelf);
      toAdd.push([vend, id, name, area, areaOrder, shelf]);
      have.add(key);
      byVendor[vend] = (byVendor[vend] || 0) + 1;
      affected.add(id);
    }
  }

  if (toAdd.length && !dryRun) {
    writePickDb_(setup, db.concat(toAdd));
    bumpServerMutationTs_();
  }
  return { added: toAdd.length, byVendor: byVendor, itemsAffected: affected.size };
}

// Menu wrapper for syncEligibleVendorsToPickPath_core_ (Ordering Guide →
// 📱 Mobile API → Place Backup Vendors on Tabs). Run per store.
function syncEligibleVendorsToPickPath() {
  const r  = syncEligibleVendorsToPickPath_core_();
  const ui = SpreadsheetApp.getUi();
  if (!r.added) {
    ui.alert("Place Backup Vendors on Tabs",
      "Every eligible vendor already has a pick-path row. Nothing to add.",
      ui.ButtonSet.OK);
    return;
  }
  const lines = Object.keys(r.byVendor).sort()
    .map(v => "  • " + v + ": " + r.byVendor[v]);
  ui.alert("Place Backup Vendors on Tabs",
    "Placed " + r.added + " item–vendor row(s) onto vendor tabs (" +
    r.itemsAffected + " item(s)):\n\n" + lines.join("\n") +
    "\n\nWhere the vendor isn't the item's primary, it appears as a secondary — " +
    "fully orderable; the badge just labels the default order source.",
    ui.ButtonSet.OK);
}


// One-time, idempotent backfill for the new Eligible Vendors column
// (MASTER_ITEMS column O). Sets the column-O header and seeds every item row's
// eligible list with the item's current active vendor (column C). SKU (column
// D) is left untouched. Reads self-heal regardless, so this is purely sheet
// hygiene -- it makes column O hold readable vendor names instead of blanks.
// Safe to re-run: a row already holding a normalized list is left unchanged.
// Run once per store from Ordering Guide -> Mobile API -> Migrate Item Vendors.
function migrateItemVendorsColumn() {
  const r  = migrateItemVendorsColumn_core_();
  const ui = SpreadsheetApp.getUi();
  if (!r.hadRows) {
    ui.alert("Eligible Vendors column header set. No item rows to seed.");
    return;
  }
  ui.alert(
    "Eligible Vendors column seeded.\n\n" +
    r.changed + " row(s) set to their current active vendor.\n" +
    "Header set to \"Eligible Vendors\" (column O). Safe to re-run anytime."
  );
}

// Headless core (no UI) — shared by the Sheet menu wrapper above and the web
// health-check fix (runHealthFix). Seeds MASTER_ITEMS column O from each row's
// active vendor; idempotent. Returns { changed, hadRows }.
function migrateItemVendorsColumn_core_() {
  const sh = getSheet_(SHEET_MASTER);
  sh.getRange(1, COL.ELIGIBLE_VENDORS).setValue("Eligible Vendors");

  const lastRow = sh.getLastRow();
  if (lastRow < 2) return { changed: 0, hadRows: false };

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
  return { changed: changed, hadRows: true };
}













function commitDeleteItem(itemId) {
  return withPickDbLock_(() => commitDeleteItem_locked_(itemId));
}
function commitDeleteItem_locked_(itemId) {
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




  // No re-sort needed: deleteRow shifts the rows below up and preserves the
  // existing (vendor, name) order, so the remaining block stays sorted.
  // Adds already insert in vendor order (getLastRowForVendor_), so MASTER
  // never needs a full re-sort here — dropping it makes delete near-instant
  // on large catalogs (the sort scanned the entire block on every delete).




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
