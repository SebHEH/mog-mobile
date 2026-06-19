/************************************************************
 * MOG — Storage areas + reorder pick path.
 * Split out of OrderGuideScript.gs (god-object split).
 * All .gs files share one global scope; global constants
 * live in Core.gs. Functions here reference them at call time.
 ************************************************************/









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
