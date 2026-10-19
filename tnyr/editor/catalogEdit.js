// MOG catalog editor: the editor's actions over the Supabase catalog tables.
//
// Pure: no DOM, no network, no Apps Script. A port of the Sheet editor's
// server code from Sheet ranges to the schema-v4 tables: Manage Items
// (Items.gs), Manage Vendors (Vendors.gs), Storage Areas and Shelf to Sheet
// (PickPath.gs). tests/catalog_edit.test.js runs it next to that real code on
// the fake Sheet: same answers, same errors, same row order. Intended
// differences, each pinned there:
//   - removing a vendor takes it off its items and lists and leaves the items
//     active (D23); the Sheet deactivates them
//   - names the database can't hold (a vendor over 100 characters, an item
//     over 300) are refused instead of written
// One call is the editor's own, with no Sheet twin: commitImportItems
// (Import from MarginEdge), checked by tests/me_import.test.js.
// The store is never part of this file: the tables it gets are one store's,
// and mog_editor_apply takes the store from the sign-in token.
//
// tables = { vendors:  [{ name, mults, cutoff }],
//            areas:    [{ name, ord }],
//            items:    [{ id, name, primaryVendor, pack, par, active, useMult,
//                         notes, sku, category, eligible, seq }],
//            pickRows: [{ vendor, id, area, shelfOrder, seq }] }
// The shape Sync.gs buildCatalogTables_ builds and mog_editor_get returns.
// items and pickRows are in seq order, which is the Sheet's row order:
// MASTER_ITEMS for items, SETUP K:P for pick rows.
//
// A write never changes the tables it's given. It returns { result, ops }:
//   result  what the Sheet's code returns (minus the Sheet row numbers)
//   ops     the changes, for mog_editor_apply (supabase/schema_v8.sql) and
//           applyOps below, in an order the database's links allow:
//     { shift: 'items', from: n }        every item with seq >= n moves down
//                                        one (a row inserted above them, as
//                                        the Sheet does)
//     { rename: 'areas', from, to }      a storage area renamed; its pick rows
//                                        follow (the database's on update
//                                        cascade)
//     { t, key, before, after }          one row of table t; before null =
//                                        insert, after null = delete
//   Order: shifts, renames, then pick-row and area deletes, then inserts and
//   updates (vendors, areas, items, pick rows), then item and vendor deletes.
//   So a vendor's items lose it before it goes, and an area's rows go before
//   it does.
// An error is thrown with the Sheet code's own message.
(function (root) {
  'use strict';

  const DELIM = '|';                       // Core.gs ELIGIBLE_VENDOR_DELIM
  const MIN_ORDERS = 3;                    // History.gs PAR_FLAG.MIN_ORDERS
  const TABLES = ['vendors', 'areas', 'items', 'pickRows'];
  const s_ = v => String(v || '').trim();  // Items.gs's String(x || "").trim()
  const clone = x => JSON.parse(JSON.stringify(x));

  function keyOf(t, row) {
    if (t === 'items') return row.id;
    if (t === 'pickRows') return row.vendor + '\u0001' + row.id;
    return row.name;
  }

  // ---- Helpers (Vendors.gs / PickPath.gs, over the tables) -----------------

  // getVendorList: the listed vendors, A to Z the way localeCompare sorts.
  function vendorList(t) {
    const seen = new Set(), out = [];
    for (const v of t.vendors) {
      const n = s_(v.name), k = n.toLowerCase();
      if (n && !seen.has(k)) { seen.add(k); out.push(n); }
    }
    return out.sort((a, b) => a.localeCompare(b));
  }
  const vendorMap = t => new Map(vendorList(t).map(v => [v.toLowerCase(), v]));

  function normalizeVendorOrThrow(t, vendorName) {
    const map = vendorMap(t);
    const input = String(vendorName || '').trim();
    if (!input) throw new Error('Vendor is required.');
    const key = input.toLowerCase();
    if (!map.has(key)) throw new Error('Vendor "' + input + '" is not in SETUP vendor table (column R).');
    return map.get(key);
  }

  function parseEligibleVendors(raw) {
    return String(raw == null ? '' : raw).split(DELIM).map(s => s.trim()).filter(s => s !== '');
  }

  // normalizeEligibleList_: canonical, deduped, the active vendor first.
  function normalizeEligibleList(raw, activeVendor, map) {
    const names = Array.isArray(raw) ? raw : parseEligibleVendors(raw);
    const out = [], seen = new Set();
    const add = v => {
      const canon = map.get(String(v == null ? '' : v).trim().toLowerCase());
      if (!canon) return;
      const k = canon.toLowerCase();
      if (seen.has(k)) return;
      seen.add(k);
      out.push(canon);
    };
    if (activeVendor) add(activeVendor);
    names.forEach(add);
    return out;
  }

  const areaOrderMap = t => new Map(t.areas.filter(a => s_(a.name) !== '').map(a => [s_(a.name), Number(a.ord)]));

  // findItemRow_: the first item whose ID is the query, or whose name is,
  // ignoring case.
  function findItem(t, query) {
    const q = String(query || '').trim();
    if (!q) return null;
    const ql = q.toLowerCase();
    for (const it of t.items) {
      if (s_(it.id) === q || s_(it.name).toLowerCase() === ql) return it;
    }
    return null;
  }

  // The item's storage area: the first pick row (Sheet order) that has one.
  function firstArea(t, id) {
    for (const r of t.pickRows) if (s_(r.id) === id && s_(r.area)) return s_(r.area);
    return '';
  }

  const nextPickSeq = t => t.pickRows.reduce((m, r) => Math.max(m, Number(r.seq) || 0), 0) + 1;
  const shelfNum = r => Number(r.shelfOrder) || 0;

  // ---- Reads ---------------------------------------------------------------

  // getAllItemsForView_
  function getAllItemsForView(t) {
    const areaById = new Map();
    for (const r of t.pickRows) {
      const id = s_(r.id), area = s_(r.area);
      if (id && area && !areaById.has(id)) areaById.set(id, area);
    }
    const map = vendorMap(t);
    return t.items.filter(it => s_(it.id) && s_(it.name)).map(it => {
      const id = s_(it.id), vendor = s_(it.primaryVendor);
      return {
        id: id,
        name: s_(it.name),
        vendor: vendor,
        eligibleVendors: normalizeEligibleList(it.eligible, vendor, map),
        pack: s_(it.pack),
        par: it.par === null || it.par === undefined ? '' : Number(it.par),
        active: it.active === true,
        useMult: it.useMult === true,
        hasArea: areaById.has(id),
        storageArea: areaById.get(id) || ''
      };
    });
  }

  // getStorageAreaList_compute_: areas in their order.
  function getStorageAreaList(t) {
    return t.areas.map(a => ({ name: s_(a.name), order: Number(a.ord) }))
      .filter(x => x.name !== '' && Number.isFinite(x.order))
      .sort((a, b) => a.order - b.order);
  }

  // getVendorTableData_compute_ (the fields Manage Items reads).
  function getVendorTableData(t) {
    return t.vendors.filter(v => s_(v.name)).map(v => ({
      name: s_(v.name),
      mults: (v.mults || []).slice(0, 7).map(x => Number(x) || 0),
      cutoffTime: v.cutoff || null
    }));
  }

  // getManageItemsBootstrap_. Par Review flags read the order history, which
  // moves with History (Phase 4); until then they are empty ("No data yet").
  function getManageItemsBootstrap(t) {
    return { items: getAllItemsForView(t), flags: {}, areas: getStorageAreaList(t),
             vendorTable: getVendorTableData(t), minOrders: MIN_ORDERS };
  }

  // getUnassignedActiveItems_: active items with no storage area anywhere.
  function getUnassignedActiveItems(t) {
    const assigned = new Set(t.pickRows.filter(r => s_(r.id) && s_(r.area)).map(r => s_(r.id)));
    return t.items
      .filter(it => s_(it.id) && s_(it.name) && it.active === true && !assigned.has(s_(it.id)))
      .map(it => ({ id: s_(it.id), name: s_(it.name), vendor: s_(it.primaryVendor), pack: s_(it.pack) }))
      .sort((a, b) => {
        const v = a.vendor.localeCompare(b.vendor);
        return v !== 0 ? v : a.name.localeCompare(b.name);
      });
  }

  // getItemForEdit_
  function getItemForEdit(t, query) {
    const it = findItem(t, query);
    if (!it) return null;
    const id = s_(it.id), vendor = s_(it.primaryVendor);
    return {
      sheetRow: it.seq,
      id: id,
      name: s_(it.name),
      vendor: vendor,
      eligibleVendors: normalizeEligibleList(it.eligible, vendor, vendorMap(t)),
      pack: s_(it.pack),
      par: it.par === null || it.par === undefined ? '' : it.par,
      active: it.active === true,
      useMult: it.useMult === true,
      notes: s_(it.notes),
      currentArea: firstArea(t, id)
    };
  }

  // ---- Writes, on a working copy w ------------------------------------------

  // commitPickPathAreaAssignment_ (PickPath.gs): the item's row on this
  // vendor's list moves to areaName, at the end of that area.
  function assignArea(w, itemId, vendor, areaName, opts) {
    const id = String(itemId || '').trim();
    if (!id) throw new Error('Item ID is required.');
    if (!vendor) throw new Error('Vendor is required.');
    if (!areaName) throw new Error('Storage Area is required.');
    const orders = areaOrderMap(w);
    if (!orders.has(areaName)) throw new Error('"' + areaName + '" is not a recognised Storage Area.');
    const vLow = String(vendor).trim().toLowerCase();
    w.pickRows = w.pickRows.filter(r => !(s_(r.vendor).toLowerCase() === vLow && s_(r.id) === id));
    const maxShelf = w.pickRows
      .filter(r => s_(r.vendor).toLowerCase() === vLow && s_(r.area) === areaName)
      .reduce((m, r) => Math.max(m, shelfNum(r)), 0);
    void opts;   // the Sheet stores the item's name on the row; the tables look it up
    w.pickRows.push({ vendor: String(vendor).trim(), id: id, area: areaName, shelfOrder: maxShelf + 10, seq: nextPickSeq(w) });
  }

  // syncItemEligiblePickRows_ (Items.gs): the item's pick rows follow its
  // eligible list. Rows for vendors no longer eligible go; an eligible vendor
  // without a row gets one in the item's current area (none if it has none).
  function syncEligiblePickRows(w, itemId, ctx) {
    const id = String(itemId || '').trim();
    if (!id) return { added: 0, removed: 0 };
    const eligible = ctx.eligible || [];
    const eligLow = new Set(eligible.map(v => v.toLowerCase()));
    let currentArea = '';
    const have = new Set();
    for (const r of w.pickRows) {
      if (s_(r.id) !== id) continue;
      if (!currentArea && s_(r.area)) currentArea = s_(r.area);
      const v = s_(r.vendor);
      if (v) have.add(v.toLowerCase());
    }
    let removed = 0;
    const kept = w.pickRows.filter(r => {
      if (s_(r.id) !== id) return true;
      if (eligLow.has(s_(r.vendor).toLowerCase())) return true;
      removed++;
      return false;
    });
    let added = 0;
    if (currentArea) {
      for (const vend of eligible) {
        if (have.has(vend.toLowerCase())) continue;
        const maxShelf = kept
          .filter(r => s_(r.vendor).toLowerCase() === vend.toLowerCase() && s_(r.area) === currentArea)
          .reduce((m, r) => Math.max(m, shelfNum(r)), 0);
        kept.push({ vendor: vend, id: id, area: currentArea, shelfOrder: maxShelf + 10,
                    seq: kept.reduce((m, r) => Math.max(m, Number(r.seq) || 0), 0) + 1 });
        added++;
      }
    }
    w.pickRows = kept;
    return { added: added, removed: removed };
  }

  // A new MASTER_ITEMS row goes after the vendor's last item, else after the
  // last ITEM-#### row, else first (getLastRowForVendor_ / getLastItemRow_).
  function insertSeqFor(w, vendor) {
    const vLow = vendor.toLowerCase();
    let after = -1;
    for (const it of w.items) if (s_(it.id) && s_(it.primaryVendor).toLowerCase() === vLow) after = it.seq;
    if (after === -1) {
      after = 1;
      for (const it of w.items) if (/^ITEM-\d+$/i.test(s_(it.id))) after = it.seq;
      if (after < 1) after = 1;
    }
    return after + 1;
  }

  // commitUpsertItem_ (Items.gs), add or edit.
  function upsertItem(w, payload, shifts) {
    const mode = payload.mode;
    const name = String(payload.name || '').trim();
    const vendor = normalizeVendorOrThrow(w, payload.vendor);
    const pack = String(payload.pack || '').trim();
    const notes = String(payload.notes || '').trim();
    const par = Number(payload.par);
    if (!Number.isFinite(par)) throw new Error('Base Par must be a number.');
    const useMult = (payload.useMult === true || payload.useMult === 'true');
    const active = (payload.active === true || payload.active === 'true');

    let existing = null, item = null;
    if (mode === 'edit') {
      existing = getItemForEdit(w, String(payload.lookup || '').trim());
      if (!existing) throw new Error('Could not find an item with that Item ID or name.');
      item = findItem(w, String(payload.lookup || '').trim());
    } else if (!name) {
      throw new Error('Item Name is required.');
    }

    if (mode === 'add') {
      let maxN = 0;
      for (const it of w.items) {
        const m = /^ITEM-(\d+)$/i.exec(s_(it.id));
        if (m) maxN = Math.max(maxN, Number(m[1]));
      }
      const itemId = 'ITEM-' + String(maxN + 1).padStart(4, '0');
      const seq = insertSeqFor(w, vendor);
      for (const it of w.items) if (it.seq >= seq) it.seq += 1;
      shifts.push(seq);
      const eligibleAdd = normalizeEligibleList(payload.eligibleVendors || [], vendor, vendorMap(w));
      w.items.push({ id: itemId, name: name, primaryVendor: vendor, pack: pack, par: par, active: active,
                     useMult: useMult, notes: notes, sku: '', category: '', eligible: eligibleAdd, seq: seq });
      w.items.sort((a, b) => a.seq - b.seq);

      let assignedArea = '', areaError = '';
      if (payload.areaName) {
        try {
          assignArea(w, itemId, vendor, String(payload.areaName).trim(), { itemName: name });
          assignedArea = String(payload.areaName).trim();
        } catch (err) {
          areaError = (err && err.message) ? err.message : String(err);
        }
      }
      syncEligiblePickRows(w, itemId, { name: name, primary: vendor, eligible: eligibleAdd });
      return { ok: true, mode: 'add', id: itemId, assignedArea: assignedArea, areaError: areaError };
    }

    // Edit. ID, SKU and category stay as they are.
    const editName = name || existing.name;
    item.name = editName;
    item.primaryVendor = vendor;
    item.pack = pack;
    item.par = par;
    const eligibleSource = (payload.eligibleVendors !== undefined && payload.eligibleVendors !== null)
      ? payload.eligibleVendors : item.eligible;
    const eligibleList = normalizeEligibleList(eligibleSource, vendor, vendorMap(w));
    // Reassign = promote: the old primary stays on as a backup.
    const oldPrimary = String((existing && existing.vendor) || '').trim();
    if (oldPrimary && oldPrimary.toLowerCase() !== vendor.toLowerCase() &&
        !eligibleList.some(v => v.toLowerCase() === oldPrimary.toLowerCase())) {
      eligibleList.push(oldPrimary);
    }
    item.eligible = eligibleList;
    const keepNotes = (payload.notes === undefined || payload.notes === null);
    item.active = active;
    item.useMult = useMult;
    item.notes = keepNotes ? String((existing && existing.notes) || '').trim() : notes;

    // An inactive item leaves every vendor's list.
    if (!active) w.pickRows = w.pickRows.filter(r => s_(r.id) !== existing.id);

    let assignedArea = '', areaError = '';
    if (active && payload.areaName) {
      try {
        assignArea(w, existing.id, vendor, String(payload.areaName).trim(), { itemName: editName });
        assignedArea = String(payload.areaName).trim();
      } catch (err) {
        areaError = (err && err.message) ? err.message : String(err);
      }
    }
    if (active) syncEligiblePickRows(w, existing.id, { name: editName, primary: vendor, eligible: eligibleList });
    return { ok: true, mode: 'edit', id: existing.id, assignedArea: assignedArea, areaError: areaError };
  }

  // commitSwitchActiveVendor_ (Items.gs): another eligible vendor becomes the
  // primary. The old one keeps its row; the new one gets a row in the item's
  // area if it had none.
  function switchActiveVendor(w, itemId, newVendorRaw) {
    const id = String(itemId || '').trim();
    if (!id) throw new Error('Item ID is required.');
    const newVendor = normalizeVendorOrThrow(w, newVendorRaw);
    const item = findItem(w, id);
    if (!item) throw new Error('Could not find an item with ID ' + id + '.');
    const oldVendor = s_(item.primaryVendor);
    const eligible = normalizeEligibleList(item.eligible, oldVendor, vendorMap(w));
    if (eligible.map(v => v.toLowerCase()).indexOf(newVendor.toLowerCase()) === -1) {
      throw new Error('"' + newVendor + '" is not in this item\'s eligible vendor list. ' +
                      'Add it to the item first, then switch.');
    }
    if (newVendor.toLowerCase() === oldVendor.toLowerCase()) {
      return { ok: true, id: id, vendor: newVendor, area: '', needsArea: false, unchanged: true };
    }
    const currentArea = firstArea(w, id);
    item.primaryVendor = newVendor;
    let assignedArea = '';
    const hasNewVendorRow = w.pickRows.some(r => s_(r.vendor).toLowerCase() === newVendor.toLowerCase() && s_(r.id) === id);
    if (hasNewVendorRow) {
      assignedArea = currentArea;
    } else if (currentArea) {
      const maxShelf = w.pickRows
        .filter(r => s_(r.vendor).toLowerCase() === newVendor.toLowerCase() && s_(r.area) === currentArea)
        .reduce((m, r) => Math.max(m, shelfNum(r)), 0);
      w.pickRows.push({ vendor: newVendor, id: id, area: currentArea, shelfOrder: maxShelf + 10, seq: nextPickSeq(w) });
      assignedArea = currentArea;
    }
    return { ok: true, id: id, vendor: newVendor, area: assignedArea, needsArea: !assignedArea };
  }

  // commitSetVendorItems_ (Items.gs): the Assign-to-Vendor tab's save. The
  // checked items are on this vendor's list (and eligible for it); the rest
  // are not, except items it's the primary of.
  function setVendorItems(w, vendorRaw, itemIds) {
    const vendor = normalizeVendorOrThrow(w, vendorRaw);
    const vLow = vendor.toLowerCase();
    const wanted = new Set((Array.isArray(itemIds) ? itemIds : []).map(x => String(x || '').trim()).filter(Boolean));
    if (!w.items.length) return { ok: true, vendor: vendor, added: 0, removed: 0, unplaced: 0 };
    const map = vendorMap(w);

    const itemArea = new Map(), onVendor = new Set();
    for (const r of w.pickRows) {
      const id = s_(r.id), area = s_(r.area);
      if (id && area && !itemArea.has(id)) itemArea.set(id, area);
      if (id && s_(r.vendor).toLowerCase() === vLow) onVendor.add(id);
    }

    let added = 0, removed = 0, unplaced = 0;
    const addRows = [], removeIds = new Set();
    for (const it of w.items) {
      const id = s_(it.id);
      if (!id) continue;
      if (it.active === false) continue;
      const primary = s_(it.primaryVendor);
      const isPrimary = primary.toLowerCase() === vLow;
      const want = isPrimary || wanted.has(id);
      const eligible = normalizeEligibleList(it.eligible, primary, map);
      const hasElig = eligible.some(v => v.toLowerCase() === vLow);
      if (want && !hasElig) {
        eligible.push(vendor);
        it.eligible = eligible;
      } else if (!want && hasElig && !isPrimary) {
        it.eligible = eligible.filter(v => v.toLowerCase() !== vLow);
      }
      const onTab = onVendor.has(id);
      if (want && !onTab) {
        const area = itemArea.get(id);
        if (area) { addRows.push({ id: id, area: area }); added++; }
        else unplaced++;
      } else if (!want && onTab && !isPrimary) {
        removeIds.add(id);
        removed++;
      }
    }
    if (removeIds.size) {
      w.pickRows = w.pickRows.filter(r => !(s_(r.vendor).toLowerCase() === vLow && removeIds.has(s_(r.id))));
    }
    if (addRows.length) {
      const maxShelf = new Map();
      for (const r of w.pickRows) {
        if (s_(r.vendor).toLowerCase() !== vLow) continue;
        const a = s_(r.area), s = shelfNum(r);
        if ((maxShelf.get(a) || 0) < s) maxShelf.set(a, s);
      }
      for (const a of addRows) {
        const shelf = (maxShelf.get(a.area) || 0) + 10;
        maxShelf.set(a.area, shelf);
        w.pickRows.push({ vendor: vendor, id: a.id, area: a.area, shelfOrder: shelf, seq: nextPickSeq(w) });
      }
    }
    return { ok: true, vendor: vendor, added: added, removed: removed, unplaced: unplaced };
  }

  // commitDeleteItem_ (Items.gs): the item and every pick row it has.
  function deleteItem(w, itemId) {
    const id = String(itemId || '').trim();
    if (!id) throw new Error('Item ID is required.');
    const item = findItem(w, id);
    if (!item) throw new Error('Item not found: ' + id);
    const out = { ok: true, name: s_(item.name), vendor: s_(item.primaryVendor), id: id };
    w.items = w.items.filter(x => x !== item);
    // By ID (the database's link); Items.gs matched the query, which the page
    // always sends as the ID.
    w.pickRows = w.pickRows.filter(r => s_(r.id) !== item.id);
    return out;
  }

  // ---- Manage Vendors (Vendors.gs) -------------------------------------------

  const pad2 = n => (n < 10 ? '0' : '') + n;

  // normalizeCutoffString_: "HH:MM" (24h) or "H:MM AM/PM" to "HH:MM", else null.
  function normalizeCutoff(raw) {
    if (raw === null || raw === undefined || raw === '') return null;
    const s = String(raw).trim();
    if (!s) return null;
    let m = s.match(/^(\d{1,2}):(\d{2})\s*(am|pm)$/i);
    if (m) {
      let h = parseInt(m[1], 10);
      const mins = parseInt(m[2], 10);
      if (mins < 0 || mins > 59) return null;
      const isPm = m[3].toLowerCase() === 'pm';
      if (h === 12) h = isPm ? 12 : 0;
      else if (isPm) h += 12;
      if (h < 0 || h > 23) return null;
      return pad2(h) + ':' + pad2(mins);
    }
    m = s.match(/^(\d{1,2}):(\d{2})$/);
    if (m) {
      const h = parseInt(m[1], 10);
      const mins = parseInt(m[2], 10);
      if (h < 0 || h > 23 || mins < 0 || mins > 59) return null;
      return pad2(h) + ':' + pad2(mins);
    }
    return null;
  }

  const multsOf = mults => mults.map(m => Number(m) || 0);   // what the Sheet's readers make of S:Y
  const findVendor = (w, name) => w.vendors.find(v => s_(v.name).toLowerCase() === name.toLowerCase()) || null;

  // commitAddVendor_. The Sheet also clones VENDOR_TEMPLATE into the vendor's
  // tab; the tables have no tabs, so the tab header always "lands" (b1ok).
  function addVendor(w, vendorName, mults, cutoffTime) {
    const name = String(vendorName || '').trim();
    if (!name) throw new Error('Vendor name is required.');
    if (!Array.isArray(mults) || mults.length !== 7) throw new Error('7 multiplier values required.');
    const cutoffNorm = (cutoffTime === undefined || cutoffTime === null || cutoffTime === '') ? null : normalizeCutoff(cutoffTime);
    if (vendorList(w).some(v => v.toLowerCase() === name.toLowerCase())) throw new Error('"' + name + '" already exists.');
    if (name.length > 100) throw new Error('Vendor name "' + name + '" is longer than 100 characters.');
    w.vendors.push({ name: name, mults: multsOf(mults), cutoff: cutoffNorm });
    return { ok: true, name: name, b1ok: true };
  }

  // commitImportVendor_: the vendor, then every item in the CSV (col 0 name,
  // col 1 pack; header, #-comment, blank and repeated rows skipped), after the
  // last ITEM-#### row, with no par and no storage area.
  function importVendor(w, payload, shifts) {
    payload = payload || {};
    const name = String(payload.name || '').trim();
    if (!name) throw new Error('Vendor name is required.');
    if (!Array.isArray(payload.mults) || payload.mults.length !== 7) throw new Error('7 multiplier values required.');
    const rows = parseCsv(String(payload.csvText || ''));
    const items = [], seen = {}, skipped = [];
    for (const row of rows) {
      const itemName = String(row[0] || '').trim();
      const pack = String(row[1] || '').trim();
      if (!itemName) continue;
      if (itemName.charAt(0) === '#') continue;
      const low = itemName.toLowerCase();
      if (low === 'item name' || low === 'name') continue;
      if (seen[low]) { skipped.push({ name: itemName, reason: 'duplicate in file' }); continue; }
      seen[low] = true;
      items.push({ name: itemName, pack: pack });
    }
    if (!items.length) throw new Error('No items found in the file. Each row needs an item name in the first column.');
    const long = items.find(it => it.name.length > 300);
    if (long) throw new Error('Item name "' + long.name.substring(0, 60) + '…" is longer than 300 characters.');
    addVendor(w, name, payload.mults, payload.cutoff);

    let maxN = 0, after = 1;
    for (const it of w.items) {
      const m = /^ITEM-(\d+)$/i.exec(s_(it.id));
      if (m) { maxN = Math.max(maxN, Number(m[1])); after = it.seq; }
    }
    const start = after + 1, n = items.length;
    for (const it of w.items) if (it.seq >= start) it.seq += n;
    for (let k = 0; k < n; k++) shifts.push(start);
    items.forEach(function (it, k) {
      w.items.push({ id: 'ITEM-' + String(maxN + 1 + k).padStart(4, '0'), name: it.name, primaryVendor: name, pack: it.pack, par: null,
                     active: true, useMult: true, notes: '', sku: '', category: '', eligible: [name], seq: start + k });
    });
    w.items.sort((a, b) => a.seq - b.seq);
    return { ok: true, vendor: name, itemsAdded: n, skipped: skipped };
  }

  // commitUpdateVendorMultsAndCutoff_
  function updateVendor(w, vendorName, mults, cutoffTime) {
    const name = String(vendorName || '').trim();
    if (!name) throw new Error('Vendor name is required.');
    if (!Array.isArray(mults) || mults.length !== 7) throw new Error('7 multiplier values required.');
    const cutoffNorm = (cutoffTime === undefined || cutoffTime === null || cutoffTime === '') ? null : normalizeCutoff(cutoffTime);
    if (cutoffTime && cutoffNorm === null) throw new Error('Cutoff time format not recognized. Use "HH:MM" (24h) or "H:MM AM/PM".');
    const v = findVendor(w, name);
    if (!v) throw new Error('"' + name + '" not found in vendor list.');
    v.mults = multsOf(mults);
    v.cutoff = cutoffNorm;
    return { ok: true, cutoffTime: cutoffNorm };
  }

  // commitRemoveVendor_, the D23 way: the vendor leaves every list it was on
  // and every item's vendors; items it supplied have no primary vendor but
  // stay active (they show as Unassigned). The Sheet deactivates them.
  function removeVendor(w, vendorName) {
    const name = String(vendorName || '').trim();
    if (!name) throw new Error('Vendor name is required.');
    const v = findVendor(w, name);
    if (!v) throw new Error('"' + name + '" was not found in the vendor table.');
    const low = s_(v.name).toLowerCase();
    w.pickRows = w.pickRows.filter(r => s_(r.vendor).toLowerCase() !== low);
    for (const it of w.items) {
      const eligible = (it.eligible || []).filter(x => s_(x).toLowerCase() !== low);
      if (eligible.length !== (it.eligible || []).length) it.eligible = eligible;
      if (s_(it.primaryVendor).toLowerCase() === low) it.primaryVendor = null;
    }
    w.vendors = w.vendors.filter(x => x !== v);
    return { ok: true, name: name };
  }

  // ---- Storage Areas (PickPath.gs) ---------------------------------------------

  const MAX_AREAS = 18;   // Core.gs AREA_TABLE: SETUP rows 2-19

  // A rename, as the database does it (on update cascade): the area and its
  // pick rows take the new name.
  function renameArea(t, from, to) {
    for (const a of t.areas) if (a.name === from) a.name = to;
    for (const r of t.pickRows) if (r.area === from) r.area = to;
  }

  // commitStorageAreasDraft_: the whole list at once. Each entry is
  // { name, origName }: origName is the area it was when the page loaded
  // (renamed when the names differ), none for a new area. A current area no
  // entry names is deleted, and its pick rows with it (the items lose that
  // area). The list's order becomes the areas' order (10, 20, 30...).
  // Renames are recorded in `renames`, for the rename ops.
  function storageAreasDraft(w, finalList, renames) {
    if (!Array.isArray(finalList)) throw new Error('No areas provided.');
    if (finalList.length > MAX_AREAS) throw new Error('Too many areas — the maximum is ' + MAX_AREAS + '.');
    const current = getStorageAreaList(w);
    const currentByLower = new Map(current.map(a => [a.name.toLowerCase(), a.name]));
    const seenNames = new Set(), seenOrigNames = new Set(), kept = new Set(), pairs = [];
    for (const entry of finalList) {
      const name = String((entry && entry.name) || '').trim();
      if (!name) throw new Error('Area name cannot be blank.');
      const nameLower = name.toLowerCase();
      if (seenNames.has(nameLower)) throw new Error('"' + name + '" is listed twice.');
      seenNames.add(nameLower);
      const orig = String((entry && entry.origName) || '').trim();
      if (orig) {
        const origLower = orig.toLowerCase();
        if (!currentByLower.has(origLower)) throw new Error('"' + orig + '" no longer exists — reopen the editor and try again.');
        if (seenOrigNames.has(origLower)) throw new Error('"' + orig + '" is referenced twice.');
        seenOrigNames.add(origLower);
        kept.add(origLower);
        const from = currentByLower.get(origLower);
        if (from !== name) pairs.push({ from: from, to: name });
      }
      if (name.length > 100) throw new Error('Area name "' + name + '" is longer than 100 characters.');
    }
    const deleted = new Set(current.map(a => a.name.toLowerCase()).filter(low => !kept.has(low)));
    const inUse = w.pickRows.filter(r => deleted.has(s_(r.area).toLowerCase())).length;

    // Renames run before deletes (the op order), so a name still in use goes
    // through a temporary one: a deleted area another one is renamed to steps
    // aside first, and a kept one (a swap, A to B and B to A) too.
    const step = (from, to) => { renameArea(w, from, to); renames.push({ rename: 'areas', from: from, to: to }); };
    let n = 0;
    const tempName = function () {
      let tmp;
      do { tmp = '(renaming ' + (++n) + ')'; }
      while (w.areas.some(a => a.name.toLowerCase() === tmp.toLowerCase()) || seenNames.has(tmp.toLowerCase()));
      return tmp;
    };
    const targets = new Set(pairs.map(p => p.to.toLowerCase()));
    const doomed = new Set();
    for (const a of w.areas.slice()) {
      const low = s_(a.name).toLowerCase();
      if (!deleted.has(low)) continue;
      if (targets.has(low)) { const tmp = tempName(); step(a.name, tmp); doomed.add(tmp.toLowerCase()); }
      else doomed.add(low);
    }
    const taken = new Set(w.areas.map(a => a.name.toLowerCase()));
    const viaTemp = pairs.filter(p => p.from.toLowerCase() !== p.to.toLowerCase() && taken.has(p.to.toLowerCase()));
    const direct = pairs.filter(p => viaTemp.indexOf(p) < 0);
    const temps = viaTemp.map(function (p) { const tmp = tempName(); step(p.from, tmp); return { from: tmp, to: p.to }; });
    direct.forEach(p => step(p.from, p.to));
    temps.forEach(p => step(p.from, p.to));

    // Deleted areas go with their pick rows: those items lose that area.
    w.pickRows = w.pickRows.filter(r => !doomed.has(s_(r.area).toLowerCase()));
    w.areas = w.areas.filter(a => !doomed.has(s_(a.name).toLowerCase()));

    finalList.forEach(function (entry, i) {
      const name = String(entry.name).trim();
      const a = w.areas.find(x => x.name === name);
      if (a) a.ord = (i + 1) * 10;
      else w.areas.push({ name: name, ord: (i + 1) * 10 });
    });
    w.areas.sort((a, b) => a.ord - b.ord);
    return { ok: true, inUseCount: inUse, deletedCount: deleted.size, savedCount: finalList.length };
  }

  // ---- Shelf to Sheet (PickPath.gs) --------------------------------------------

  const itemNameOf = (t, id) => { const it = t.items.find(x => x.id === id); return it ? s_(it.name) : ''; };

  // getPickPathForSidebar_compute_: the vendor's list by area and shelf order,
  // then the areas with nothing on it yet; plus its active items (as their
  // primary vendor) with no area on its list.
  function pickPathForSidebar(t, vendor) {
    const orders = areaOrderMap(t);
    const vLow = String(vendor || '').trim().toLowerCase();
    const rows = t.pickRows
      .filter(r => s_(r.vendor).toLowerCase() === vLow && s_(r.id))
      .map(r => ({ id: s_(r.id), name: itemNameOf(t, s_(r.id)), area: s_(r.area),
                   areaOrder: orders.has(s_(r.area)) ? orders.get(s_(r.area)) : 0, shelfOrder: Number(r.shelfOrder) }));
    const assigned = new Set(rows.filter(r => r.area).map(r => r.id));
    const unassigned = [];
    for (const it of t.items) {
      const id = s_(it.id), name = s_(it.name);
      if (s_(it.primaryVendor) === String(vendor).trim() && it.active === true && id && name && !assigned.has(id)) {
        unassigned.push({ id: id, name: name });
      }
    }
    const sorted = rows.filter(r => r.area).sort((a, b) => (a.areaOrder !== b.areaOrder ? a.areaOrder - b.areaOrder : a.shelfOrder - b.shelfOrder));
    const groupMap = new Map(), groupOrder = [];
    for (const r of sorted) {
      if (!groupMap.has(r.area)) { groupMap.set(r.area, []); groupOrder.push(r.area); }
      groupMap.get(r.area).push({ id: r.id, name: r.name });
    }
    const emptyAreas = Array.from(orders.entries()).sort((a, b) => a[1] - b[1]).filter(([area]) => !groupMap.has(area));
    const groups = groupOrder.map(area => ({ area: area, areaOrder: orders.has(area) ? orders.get(area) : 999, items: groupMap.get(area) }))
      .concat(emptyAreas.map(([area, order]) => ({ area: area, areaOrder: order, items: [] })));
    return { vendor: String(vendor).trim(), unassigned: unassigned, groups: groups };
  }

  // commitReorderPickPath_: the vendor's whole list as the page now has it,
  // [{ id, name, area }] in order; rows without an area leave the list. Shelf
  // orders restart at 10 in each area, and the vendor's rows go to the end of
  // the pick path, as the Sheet rewrites them. The database holds only listed
  // vendors, items and areas, so anything else is refused.
  function reorderPickPath(w, vendor, payload) {
    if (!vendor) throw new Error('Vendor is required.');
    if (!Array.isArray(payload) || !payload.length) throw new Error('No items provided.');
    const canon = normalizeVendorOrThrow(w, vendor);
    const orders = areaOrderMap(w);
    const counters = new Map(), seen = new Set();
    const rows = payload.filter(x => x.id && x.area).map(function (x) {
      if (!orders.has(x.area)) throw new Error('"' + x.area + '" is not a recognised Storage Area.');
      if (!w.items.some(it => it.id === x.id)) throw new Error('Item not found: ' + x.id);
      if (seen.has(x.id)) throw new Error('Item ' + x.id + ' is on the list twice.');
      seen.add(x.id);
      const count = (counters.get(x.area) || 0) + 1;
      counters.set(x.area, count);
      return { vendor: canon, id: x.id, area: x.area, shelfOrder: count * 10 };
    });
    const vLow = String(vendor).toLowerCase();
    const kept = w.pickRows.filter(r => s_(r.vendor).toLowerCase() !== vLow);
    let seq = kept.reduce((m, r) => Math.max(m, Number(r.seq) || 0), 0);
    w.pickRows = kept.concat(rows.map(r => Object.assign(r, { seq: ++seq })));
    return { ok: true, count: rows.length };
  }

  // ---- CSV (Import Vendor, Import from MarginEdge) -------------------------------

  // RFC 4180: quoted fields, "" inside quotes, commas and line breaks in
  // quotes, a byte-order mark. Blank lines are dropped.
  function parseCsv(text) {
    const s = String(text == null ? '' : text).replace(/^﻿/, '');
    const rows = [];
    let row = [], field = '', quoted = false;
    for (let i = 0; i < s.length; i++) {
      const c = s[i];
      if (quoted) {
        if (c !== '"') field += c;
        else if (s[i + 1] === '"') { field += '"'; i++; }
        else quoted = false;
      } else if (c === '"') {
        quoted = true;
      } else if (c === ',') {
        row.push(field); field = '';
      } else if (c === '\n' || c === '\r') {
        if (c === '\r' && s[i + 1] === '\n') i++;
        row.push(field); rows.push(row); row = []; field = '';
      } else {
        field += c;
      }
    }
    if (field !== '' || row.length) { row.push(field); rows.push(row); }
    return rows.filter(r => r.some(f => String(f).trim() !== ''));
  }

  // Import from MarginEdge (meImport.js builds the payload). Supabase editor
  // only, so unlike the calls above it has no Items.gs twin. New vendors start
  // with no delivery days, so they order nothing until Manage Vendors sets
  // them. Items come in the way Import Vendor's do (Vendors.gs
  // commitImportVendor_): active, par blank, no storage area, at the end of
  // the list, so they wait under Unassigned. A name already in the catalog is
  // skipped, never doubled.
  // payload = { newVendors: [name], items: [{ name, primaryVendor, eligible: [name], sku, category }] }
  function importItems(w, payload) {
    const newVendors = Array.isArray(payload.newVendors) ? payload.newVendors : [];
    const rows = Array.isArray(payload.items) ? payload.items : [];
    const known = vendorMap(w);
    const vendorsAdded = [];
    for (const raw of newVendors) {
      const name = String(raw || '').trim();
      if (!name) throw new Error('Vendor name is required.');
      if (name.length > 100) throw new Error('Vendor name "' + name + '" is longer than 100 characters.');
      if (known.has(name.toLowerCase())) throw new Error('Vendor "' + name + '" already exists.');
      known.set(name.toLowerCase(), name);
      w.vendors.push({ name: name, mults: [0, 0, 0, 0, 0, 0, 0], cutoff: null });
      vendorsAdded.push(name);
    }

    let maxN = 0, seq = 0;
    const taken = new Set();
    for (const it of w.items) {
      const m = /^ITEM-(\d+)$/i.exec(s_(it.id));
      if (m) maxN = Math.max(maxN, Number(m[1]));
      seq = Math.max(seq, Number(it.seq) || 0);
      if (s_(it.name)) taken.add(s_(it.name).toLowerCase());
    }
    const skipped = [];
    let itemsAdded = 0;
    for (const row of rows) {
      const name = String((row && row.name) || '').trim();
      if (!name) throw new Error('Item Name is required.');
      if (name.length > 300) throw new Error('Item name "' + name.substring(0, 60) + '…" is longer than 300 characters.');
      if (taken.has(name.toLowerCase())) { skipped.push({ name: name, reason: 'already in the catalog' }); continue; }
      const primary = normalizeVendorOrThrow(w, row.primaryVendor);
      const eligible = [primary];
      for (const v of (Array.isArray(row.eligible) ? row.eligible : [])) {
        const canon = normalizeVendorOrThrow(w, v);
        if (eligible.indexOf(canon) < 0) eligible.push(canon);
      }
      taken.add(name.toLowerCase());
      maxN++;
      seq++;
      w.items.push({ id: 'ITEM-' + String(maxN).padStart(4, '0'), name: name, primaryVendor: primary, pack: '', par: null,
                     active: true, useMult: true, notes: '', sku: s_(row.sku), category: s_(row.category),
                     eligible: eligible, seq: seq });
      itemsAdded++;
    }
    return { ok: true, vendorsAdded: vendorsAdded, itemsAdded: itemsAdded, skipped: skipped };
  }

  // ---- Changes ---------------------------------------------------------------

  function sameRow(a, b) { return JSON.stringify(a) === JSON.stringify(b); }

  // The row changes from base to work, once base has the same seq shifts and
  // area renames. In the order the header describes, so every step keeps the
  // tables' links valid.
  function diff(base, work, shifts, renames) {
    const b = clone(base);
    for (const from of shifts) for (const it of b.items) if (it.seq >= from) it.seq += 1;
    for (const r of renames) renameArea(b, r.from, r.to);
    const dels = [], puts = [];
    for (const t of TABLES) {
      const before = new Map(b[t].map(r => [keyOf(t, r), r]));
      const after = new Map(work[t].map(r => [keyOf(t, r), r]));
      for (const [k, r] of before) if (!after.has(k)) dels.push({ t: t, key: k, before: r, after: null });
      for (const [k, r] of after) {
        const old = before.has(k) ? before.get(k) : null;
        if (!old || !sameRow(old, r)) puts.push({ t: t, key: k, before: old, after: r });
      }
    }
    const rank = op => TABLES.indexOf(op.t);
    const early = dels.filter(op => op.t === 'pickRows' || op.t === 'areas').sort((x, y) => rank(y) - rank(x));
    const late = dels.filter(op => op.t === 'items' || op.t === 'vendors').sort((x, y) => rank(y) - rank(x));
    puts.sort((x, y) => rank(x) - rank(y));
    return shifts.map(from => ({ shift: 'items', from: from })).concat(renames, early, puts, late);
  }

  // The fields a row's "before" must still match for a change to apply. The
  // order fields (seq) are not part of it: they only place a row.
  const USER_FIELDS = {
    vendors:  ['mults', 'cutoff'],
    areas:    ['ord'],
    items:    ['name', 'primaryVendor', 'pack', 'par', 'active', 'useMult', 'notes', 'sku', 'category', 'eligible'],
    pickRows: ['area', 'shelfOrder']
  };
  function matches(t, row, want) {
    return USER_FIELDS[t].every(f => JSON.stringify(row[f] === undefined ? null : row[f]) ===
                                     JSON.stringify(want[f] === undefined ? null : want[f]));
  }

  // Apply ops to tables (a copy), as mog_editor_apply does: refused with
  // CONFLICT when a row isn't what the change expects. An updated item keeps
  // its own seq; an updated pick row takes the new one.
  function applyOps(tables, ops) {
    const t = clone(tables);
    for (const op of ops) {
      if (op.shift) {
        for (const it of t.items) if (it.seq >= op.from) it.seq += 1;
        continue;
      }
      if (op.rename) {
        if (op.rename !== 'areas' || !t.areas.some(a => a.name === op.from)) throw new Error('CONFLICT: areas ' + op.from + ' changed');
        if (op.from.toLowerCase() !== op.to.toLowerCase() && t.areas.some(a => a.name.toLowerCase() === op.to.toLowerCase())) {
          throw new Error('CONFLICT: areas ' + op.to + ' already exists');
        }
        renameArea(t, op.from, op.to);
        continue;
      }
      const list = t[op.t];
      const i = list.findIndex(r => keyOf(op.t, r) === op.key);
      if (op.before === null) {
        if (i >= 0) throw new Error('CONFLICT: ' + op.t + ' ' + op.key + ' already exists');
      } else if (i < 0 || !matches(op.t, list[i], op.before)) {
        throw new Error('CONFLICT: ' + op.t + ' ' + op.key + ' changed');
      }
      if (op.after === null) list.splice(i, 1);
      else if (i < 0) list.push(clone(op.after));
      else list[i] = Object.assign(clone(op.after), op.t === 'items' ? { seq: list[i].seq } : {});
    }
    t.items.sort((a, b) => a.seq - b.seq);
    t.pickRows.sort((a, b) => a.seq - b.seq);
    t.areas.sort((a, b) => a.ord - b.ord);
    return t;
  }

  // Undo: each change reversed, last first; a rename goes back. Seq shifts
  // stay (a gap in the order changes nothing).
  function inverseOps(ops) {
    return ops.filter(op => !op.shift).slice().reverse()
      .map(op => (op.rename ? { rename: op.rename, from: op.to, to: op.from }
                            : { t: op.t, key: op.key, before: op.after, after: op.before }));
  }

  // ---- What a change was, in words (the change log) -------------------------

  const fmt = v => (v === null || v === undefined || v === '') ? '(blank)' :
    Array.isArray(v) ? (v.join(', ') || '(none)') : (v === true ? 'yes' : v === false ? 'no' : String(v));
  const FIELD_LABEL = { name: 'name', primaryVendor: 'primary vendor', pack: 'pack', par: 'par', active: 'active',
                        useMult: 'use multiplier', notes: 'notes', eligible: 'vendors' };
  const plural = (n, word) => n + ' ' + word + (n === 1 ? '' : 's');
  function describe(fn, args, base, result, work) {
    const nameOf = id => { const it = base.items.find(x => x.id === id); return it ? s_(it.name) : id; };
    if (fn === 'commitUpsertItem' && result.mode === 'add') {
      return 'Added "' + s_(args[0].name) + '" (' + result.id + ') to ' + normalizeVendorOrThrow(base, args[0].vendor);
    }
    if (fn === 'commitUpsertItem') {
      const before = base.items.find(x => x.id === result.id);
      const after = work.items.find(x => x.id === result.id);
      const parts = [];
      if (before && after) {
        for (const f of Object.keys(FIELD_LABEL)) {
          if (JSON.stringify(before[f]) !== JSON.stringify(after[f])) parts.push(FIELD_LABEL[f] + ' ' + fmt(before[f]) + ' → ' + fmt(after[f]));
        }
      }
      if (result.assignedArea) parts.push('area ' + result.assignedArea);
      return 'Edited "' + nameOf(result.id) + '"' + (parts.length ? ': ' + parts.join('; ') : '');
    }
    if (fn === 'commitSwitchActiveVendor') return 'Made ' + result.vendor + ' the primary vendor of "' + nameOf(result.id) + '"';
    if (fn === 'commitSetVendorItems') return 'Assigned items to ' + result.vendor + ': ' + result.added + ' added, ' + result.removed + ' removed';
    if (fn === 'commitDeleteItem') return 'Deleted "' + result.name + '" (' + result.id + ')';
    if (fn === 'commitImportItems') {
      const v = result.vendorsAdded.length;
      const names = v <= 6 ? ' (' + result.vendorsAdded.join(', ') + ')' : '';   // the log keeps 300 characters
      const vendors = plural(v, 'vendor') + names;
      if (!result.itemsAdded) return 'Added ' + vendors + ' from MarginEdge';
      return 'Imported ' + plural(result.itemsAdded, 'item') + ' from MarginEdge' + (v ? ' and added ' + vendors : '');
    }
    if (fn === 'commitAddVendor') return 'Added vendor "' + result.name + '"';
    if (fn === 'commitImportVendor') return 'Added vendor "' + result.vendor + '" with ' + plural(result.itemsAdded, 'item') + ' from a file';
    if (fn === 'commitUpdateVendorMultsAndCutoff') {
      const before = findVendor(base, s_(args[0])), after = findVendor(work, s_(args[0]));
      const parts = [];
      if (before && after && JSON.stringify(before.mults) !== JSON.stringify(after.mults)) {
        parts.push('day multipliers ' + before.mults.join(' ') + ' → ' + after.mults.join(' '));
      }
      if (before && after && before.cutoff !== after.cutoff) parts.push('cutoff ' + fmt(before.cutoff) + ' → ' + fmt(after.cutoff));
      return 'Updated vendor "' + (before ? before.name : s_(args[0])) + '"' + (parts.length ? ': ' + parts.join('; ') : '');
    }
    if (fn === 'commitRemoveVendor') {
      const v = findVendor(base, s_(args[0]));
      return 'Removed vendor "' + (v ? v.name : s_(args[0])) + '"';
    }
    if (fn === 'commitStorageAreasDraft') {
      const oldNames = new Map(base.areas.map(a => [a.name.toLowerCase(), a.name]));
      const parts = [];
      const added = args[0].filter(e => !s_(e && e.origName)).map(e => s_(e.name));
      const renamed = args[0].filter(e => s_(e && e.origName) && oldNames.get(s_(e.origName).toLowerCase()) !== s_(e.name))
        .map(e => oldNames.get(s_(e.origName).toLowerCase()) + ' → ' + s_(e.name));
      const kept = new Set(args[0].map(e => s_(e && e.origName).toLowerCase()).filter(Boolean));
      const removed = base.areas.map(a => a.name).filter(n => !kept.has(n.toLowerCase()));
      if (added.length) parts.push('added ' + added.join(', '));
      if (renamed.length) parts.push('renamed ' + renamed.join(', '));
      if (removed.length) parts.push('removed ' + removed.join(', '));
      return 'Saved the storage areas' + (parts.length ? ': ' + parts.join('; ') : ' (new order)');
    }
    if (fn === 'commitReorderPickPath') return 'Saved the ' + normalizeVendorOrThrow(base, args[0]) + ' list (' + plural(result.count, 'item') + ')';
    return fn;
  }

  // ---- The page's server calls, by name -------------------------------------

  const READS = {
    getManageItemsBootstrap: t => getManageItemsBootstrap(t),
    getAllItemsForView: t => getAllItemsForView(t),
    getUnassignedActiveItems: t => getUnassignedActiveItems(t),
    getItemForEdit: (t, args) => getItemForEdit(t, args[0]),
    getVendorList: t => vendorList(t),
    getStorageAreaList: t => getStorageAreaList(t),
    getVendorTableData: t => getVendorTableData(t),
    getPickPathForSidebar: (t, args) => pickPathForSidebar(t, args[0])
  };
  const WRITES = {
    commitUpsertItem: (w, args, shifts) => upsertItem(w, args[0] || {}, shifts),
    commitSwitchActiveVendor: (w, args) => switchActiveVendor(w, args[0], args[1]),
    commitSetVendorItems: (w, args) => setVendorItems(w, args[0], args[1]),
    commitDeleteItem: (w, args) => deleteItem(w, args[0]),
    commitImportItems: (w, args) => importItems(w, args[0] || {}),
    commitAddVendor: (w, args) => addVendor(w, args[0], args[1], args[2]),
    commitImportVendor: (w, args, shifts) => importVendor(w, args[0], shifts),
    commitUpdateVendorMultsAndCutoff: (w, args) => updateVendor(w, args[0], args[1], args[2]),
    commitRemoveVendor: (w, args) => removeVendor(w, args[0]),
    commitStorageAreasDraft: (w, args, shifts, renames) => storageAreasDraft(w, args[0], renames),
    commitReorderPickPath: (w, args) => reorderPickPath(w, args[0], args[1])
  };

  // A read answers { result }; a write { result, ops, label }. A name this
  // file doesn't serve throws, like webeditDispatch_ refusing an unlisted one.
  function call(tables, fn, args) {
    args = args || [];
    if (READS[fn]) return { result: READS[fn](tables, args) };
    if (!WRITES[fn]) throw new Error('"' + fn + '" is not allowed.');
    const work = clone(tables), shifts = [], renames = [];
    const result = WRITES[fn](work, args, shifts, renames);
    const ops = diff(tables, work, shifts, renames);
    return { result: result, ops: ops, label: ops.length ? describe(fn, args, tables, result, work) : '' };
  }

  const api = { call: call, applyOps: applyOps, inverseOps: inverseOps, reads: Object.keys(READS),
                writes: Object.keys(WRITES), vendorList: vendorList, parseCsv: parseCsv };
  root.CatalogEdit = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : this);
