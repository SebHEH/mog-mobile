// MOG catalog editor: Manage Items' actions over the Supabase catalog tables.
//
// Pure: no DOM, no network, no Apps Script. A port of apps-script/Items.gs
// (and the PickPath.gs / Vendors.gs helpers it calls) from Sheet ranges to
// the schema-v4 tables, checked against Items.gs on the fake Sheet by
// tests/catalog_edit.test.js: same answers, same errors, same row order.
// One call is the editor's own, with no Items.gs twin: commitImportItems
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
//   result  what Items.gs returns (minus the Sheet row numbers)
//   ops     the changes, for mog_editor_apply (supabase/schema_v6.sql) and
//           applyOps below, in an order the database's links allow:
//     { shift: 'items', from: n }  every item with seq >= n moves down one
//                                  (a row inserted above them, as the Sheet does)
//     { t, key, before, after }    one row of table t; before null = insert,
//                                  after null = delete
// An error is thrown with Items.gs's own message.
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

  // The row changes from base to work, once base has the same seq shifts.
  // Deletes first (pick rows before items), then inserts and updates (items
  // before pick rows), so every step keeps the tables' links valid.
  function diff(base, work, shifts) {
    const b = clone(base);
    for (const from of shifts) for (const it of b.items) if (it.seq >= from) it.seq += 1;
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
    dels.sort((x, y) => rank(y) - rank(x));
    puts.sort((x, y) => rank(x) - rank(y));
    return shifts.map(from => ({ shift: 'items', from: from })).concat(dels, puts);
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
    return t;
  }

  // Undo: each row change reversed, last first. Seq shifts stay (a gap in the
  // order changes nothing).
  function inverseOps(ops) {
    return ops.filter(op => !op.shift).slice().reverse()
      .map(op => ({ t: op.t, key: op.key, before: op.after, after: op.before }));
  }

  // ---- What a change was, in words (the change log) -------------------------

  const fmt = v => (v === null || v === undefined || v === '') ? '(blank)' :
    Array.isArray(v) ? (v.join(', ') || '(none)') : (v === true ? 'yes' : v === false ? 'no' : String(v));
  const FIELD_LABEL = { name: 'name', primaryVendor: 'primary vendor', pack: 'pack', par: 'par', active: 'active',
                        useMult: 'use multiplier', notes: 'notes', eligible: 'vendors' };
  function describe(fn, args, base, result) {
    const nameOf = id => { const it = base.items.find(x => x.id === id); return it ? s_(it.name) : id; };
    if (fn === 'commitUpsertItem' && result.mode === 'add') {
      return 'Added "' + s_(args[0].name) + '" (' + result.id + ') to ' + normalizeVendorOrThrow(base, args[0].vendor);
    }
    if (fn === 'commitUpsertItem') {
      const before = base.items.find(x => x.id === result.id);
      const after = result.__after;
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
      return 'Imported ' + result.itemsAdded + ' item' + (result.itemsAdded === 1 ? '' : 's') + ' from MarginEdge' +
        (v ? ' and added ' + v + ' vendor' + (v === 1 ? '' : 's') + names : '');
    }
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
    getVendorTableData: t => getVendorTableData(t)
  };
  const WRITES = {
    commitUpsertItem: (w, args, shifts) => upsertItem(w, args[0] || {}, shifts),
    commitSwitchActiveVendor: (w, args) => switchActiveVendor(w, args[0], args[1]),
    commitSetVendorItems: (w, args) => setVendorItems(w, args[0], args[1]),
    commitDeleteItem: (w, args) => deleteItem(w, args[0]),
    commitImportItems: (w, args) => importItems(w, args[0] || {})
  };

  // A read answers { result }; a write { result, ops, label }. A name this
  // file doesn't serve throws, like webeditDispatch_ refusing an unlisted one.
  function call(tables, fn, args) {
    args = args || [];
    if (READS[fn]) return { result: READS[fn](tables, args) };
    if (!WRITES[fn]) throw new Error('"' + fn + '" is not allowed.');
    const work = clone(tables), shifts = [];
    const result = WRITES[fn](work, args, shifts);
    const ops = diff(tables, work, shifts);
    if (fn === 'commitUpsertItem' && result.mode === 'edit') {
      Object.defineProperty(result, '__after', { value: work.items.find(x => x.id === result.id), enumerable: false });
    }
    return { result: result, ops: ops, label: ops.length ? describe(fn, args, tables, result) : '' };
  }

  const api = { call: call, applyOps: applyOps, inverseOps: inverseOps, reads: Object.keys(READS),
                writes: Object.keys(WRITES), vendorList: vendorList };
  root.CatalogEdit = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : this);
