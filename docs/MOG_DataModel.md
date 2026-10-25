# MOG — Data Model

**Status:** First-pass draft (2026-05-25). Derived from `apps-script/*.gs` and modal HTML files. Gaps flagged inline with `⚠ TODO: confirm in live Sheet`.

This document is the **source of truth for the migration plan** (port modals to PWA → optional Supabase backend). It captures:
1. Every Sheet tab and its columns (the storage layer today)
2. Every server-side function and what it reads/writes (the API surface today)
3. Per-modal data flow (the read/write contract each UI assumes)
4. Cross-store assumptions (what's identical, what varies)
5. Responsive design notes for the PWA port
6. First-pass Supabase schema (appendix — for evaluation, not commitment)

When `MOG_DataModel.md` and `CLAUDE.md` conflict: `CLAUDE.md` wins for repo structure / invariants. This doc wins for "what shape does the data take."

---

## 1. Sheet inventory

Every store's Google Sheet is structurally identical. Per-store data (PINs, location name, vendor lists, items) lives **inside the Sheet** — never in `.gs` files. The 9 deploy targets share the same code.

| Tab | Purpose | Visibility | Protected? |
|---|---|---|---|
| `MASTER_ITEMS` | Item master — every item the store orders. | Visible | Read-only via UI; mutated only via Manage Items modal |
| `SETUP` | Multi-zone config sheet (vendors, areas, pick paths, cutoffs, recipients). | Hidden by default (admin can toggle) | All zones script-managed |
| `ORDER_ENTRY` | Home dashboard — date, day-of-week, vendor tiles, quick-action checkboxes, Reset button. | Visible (the landing tab) | Most cells protected; only the dashboard checkboxes are editable |
| `LOG_ORDERS` | Append-only daily order history. | Hidden | Protected (no manual edits) |
| `VENDOR_TEMPLATE` | Template copied to seed new vendor tabs. | Hidden | n/a — copied, not edited |
| **`<Vendor Name>`** (per vendor) | One tab per vendor — items, pars, on-hand, suggested qty. Auto-created by `commitAddVendor`. | Visible | Locked except column E (On Hand) |

---

## 2. Column layouts per tab

### 2.1 `MASTER_ITEMS`

Header row 1. Data rows 2+.

| Col | Letter | Constant | Field | Type | Notes |
|---|---|---|---|---|---|
| 1 | A | `COL.ID` | Item ID | string | Format: `ITEM-0001` (zero-padded). Immutable once assigned. |
| 2 | B | `COL.NAME` | Item Name | string | Display name; unique within a vendor (case-insensitive). |
| 3 | C | `COL.VENDOR` | Vendor | string | FK to vendor name in `SETUP!Z`. |
| 4 | D | `COL.SKU` | SKU | string | Optional — not currently surfaced in modals. |
| 5 | E | `COL.PACK` | Pack / Unit | string | Free text (e.g. `CASE (6)`, `EA`, `BAG`). |
| 6 | F | `COL.CATEGORY` | Category | string | Optional — not currently surfaced. |
| 7 | G | `COL.PAR` | Base Par | number | Daily par quantity. |
| 8 | H | — | (unused) | — | ⚠ TODO: confirm |
| 9 | I | — | On Hand (master copy) | number | ⚠ Referenced by `MOG_COL.ON_HAND = 9` in `MOGApi.gs` but ALSO described as living on vendor tabs only. Sheet probably has it for legacy or sync — confirm in live Sheet whether this column is still in use. |
| 10 | J | — | (unused) | — | ⚠ TODO: confirm |
| 11 | K | — | (unused) | — | ⚠ TODO: confirm |
| 12 | L | `COL.ACTIVE` | Active | boolean (checkbox) | When false, item hidden from vendor tabs + dashboard. |
| 13 | M | `COL.USE_MULT` | Use Multiplier | boolean (checkbox) | When false, item ignores the day-of-week multiplier (flat par every day). |
| 14 | N | `COL.NOTES` | Notes | string | Free-text notes. |

### 2.2 `SETUP` (multi-zone)

This sheet is busy. Each zone has its own row/column range. Zones do not overlap.

#### 2.2.1 Working pick-path list (zones A:D, rows 21+)

Visible when the SETUP tab is shown — used by the legacy in-sheet pick-path editor. Cleared/repopulated by `loadSetupVendorItems_` when B2 changes.

| Col | Letter | Field |
|---|---|---|
| 1 | A | Item Name (read-only display) |
| 2 | B | Storage Area (editable dropdown — triggers `autoSavePickPathIfSafe_` on edit) |
| 4 | D | Item ID (hidden, formatted as text) |

#### 2.2.2 Active-vendor pick path source

| Cell | Field |
|---|---|
| `B2` | Selected vendor name (dropdown) — drives `loadSetupVendorItems_` on edit. |

#### 2.2.3 Storage areas table (H:I, rows 2-19)

| Col | Letter | Constant | Field |
|---|---|---|---|
| 8 | H | `AREA_TABLE.COL_AREA` | Area Name |
| 9 | I | `AREA_TABLE.COL_ORDER` | Area Order (10, 20, 30…) |

Max 18 areas (rows 2-19). Order values normalized to multiples of 10 by `normalizeAreaOrder_`.

#### 2.2.4 Pick path database (K:P, rows 2+)

Hidden columns. Source of truth for which items go in which areas in what order. Read/written via `readPickDb_` / `writePickDb_`.

| Col | Letter | Index | Field |
|---|---|---|---|
| 11 | K | 0 | Vendor |
| 12 | L | 1 | Item ID |
| 13 | M | 2 | Item Name (denormalized) |
| 14 | N | 3 | Area Name |
| 15 | O | 4 | Area Order (denormalized from H:I) |
| 16 | P | 5 | Shelf Order (10, 20, 30… within area) |

#### 2.2.5 Vendor table (R:Y, rows 2+)

| Col | Letter | Constant | Field |
|---|---|---|---|
| 18 | R | `VENDOR_TABLE.VENDOR_COL` | Vendor name (dropdown sourced from Z) |
| 19 | S | `VENDOR_TABLE.MULT_COL` | Mon multiplier |
| 20 | T | | Tue multiplier |
| 21 | U | | Wed multiplier |
| 22 | V | | Thu multiplier |
| 23 | W | | Fri multiplier |
| 24 | X | | Sat multiplier |
| 25 | Y | | Sun multiplier |

Multipliers: `0` = no order day; `1.0` = standard par; higher = covers multiple days.

#### 2.2.6 Vendor name list + cutoffs (Z, AA, rows 2+)

| Col | Letter | Constant | Field |
|---|---|---|---|
| 26 | Z | `VENDOR_LIST_COL` | Vendor name (source of truth, feeds R dropdown validation) |
| 27 | AA | `VENDOR_CUTOFF_COL` | Cutoff time — string `"HH:MM"` 24h, or blank. |

#### 2.2.7 Recap recipients (AB:AE, rows 2+)

Header row 1 (`'Recipient Name', 'Recipient Email', 'Active', 'GM'`). Written lazily by `ensureRecipientsHeader_`.

| Col | Letter | Field |
|---|---|---|
| 28 | AB | Recipient Name |
| 29 | AC | Recipient Email |
| 30 | AD | Active (boolean) |
| 31 | AE | GM (boolean) — when true, row is read-only from PWA |

### 2.3 `ORDER_ENTRY`

Mix of layout + hidden data + interactive controls. Built by `buildHomeDashboard()`.

#### Hidden data column AE (col 31)

| Cell | Field |
|---|---|
| `AE2` | `=TODAY()` (today's calendar date) |
| `AE3` | `=TEXT(IF(AE9="",AE2,AE9),"ddd")` — day-of-week of active cycle |
| `AE9` | Last reset date (written by reset routine) |
| `AE100`+ | FILTER spill anchor for the vendor list |

#### Visible interactive cells

| Cell | Field |
|---|---|
| `AD2` | Emergency Override checkbox (auto-reset on next open if not used same day) |
| `O5` | Reset On Hand checkbox |
| Quick-action checkboxes | A/F/K/P/U/Z at dynamically-determined row (stored in DocumentProperties `DASH_MANAGE_ROW`, default 15). Trigger: Manage Items / Manage Vendors / Manage Pick Path / Storage Areas / Order History / How To Use modals. |

### 2.4 `LOG_ORDERS`

Append-only. Written once per order cycle by `commitLogAndReset()` via `snapshotVendorOrders_`. Header row 1.

| Col | Letter | Constant | Field | Type |
|---|---|---|---|---|
| 1 | A | `LOG_COL.TIMESTAMP` | Timestamp | Date/time |
| 2 | B | `LOG_COL.ORDER_DATE` | Order Date | Date — sourced from `AE9` (active cycle date) |
| 3 | C | `LOG_COL.VENDOR` | Vendor | string |
| 4 | D | `LOG_COL.ITEM_ID` | Item ID | string |
| 5 | E | `LOG_COL.ITEM_NAME` | Item Name | string (denormalized) |
| 6 | F | `LOG_COL.ON_HAND_PRV` | On Hand at order time | number |
| 7 | G | `LOG_COL.QTY_ORDERED` | Quantity ordered (= Suggested) | number |

Duplicate guard: `hasLogEntryForDate_` checks `LAST_LOG_DATE` DocumentProperty + scans column B; second reset on the same `AE9` is a no-op.

### 2.5 Per-vendor tab (`<Vendor Name>`)

Created by `commitAddVendor` by copying `VENDOR_TEMPLATE`. Layout identical across all vendors.

| Col | Letter | Field | Type | Source |
|---|---|---|---|---|
| 1 | A | Item Name | string | Formula from SETUP pick path |
| 2 | B | Pack | string | Formula from MASTER_ITEMS via XLOOKUP |
| 3 | C | ⚠ TODO: confirm | | |
| 4 | D | Base Par | number | Formula from MASTER_ITEMS via XLOOKUP |
| 5 | E | **On Hand** | number | **Only editable column.** KM enters count here. |
| 6 | F | Suggested Order Qty | number | Formula: `targetPar - onHand` clamped ≥ 0, where `targetPar = par * (useMult ? H2 : 1)` |
| 7-12 | G-L | ⚠ TODO: confirm | | |
| 13 | M | **Item ID** (hidden) | string | Formula from SETUP pick path |

| Cell | Field |
|---|---|
| `B1` | Vendor name (merged B1:F1) |
| `H2` | Day-of-week multiplier (= AE3 of ORDER_ENTRY via lookup against SETUP S:Y) |

Data rows start at row 3 (`VENDOR_TAB.DATA_START_ROW`).

Sheet protection: `protect()` with `setUnprotectedRanges([E3:E1000])`.

---

## 3. Relationships (foreign-key-like)

```
SETUP!Z (vendor list, immutable name)
    ↓ feeds dropdown validation
SETUP!R (vendor table)
    ↓ paired by row with
SETUP!S:Y (multipliers) + SETUP!AA (cutoff)

MASTER_ITEMS.Vendor (col C) ──→ SETUP!Z (vendor name)
MASTER_ITEMS.ID (col A)     ──→ used as PK across:
                                   • SETUP pick-path DB (col L)
                                   • Vendor tabs (col M hidden)
                                   • LOG_ORDERS (col D)

SETUP!H (area names)        ──→ SETUP pick-path DB (col N)

SETUP!AB-AE (recipients)    ──→ standalone; email targets only
```

**Denormalization:** Item Name, Vendor, Area Name, Area Order, Pack all appear in multiple places (vendor tab, pick path DB, LOG_ORDERS). Single source of truth is MASTER_ITEMS + SETUP areas — everything else is a denormalized copy refreshed on commit. This is necessary today because Sheet formulas have no JOIN.

In Supabase this collapses naturally to: `items` (PK = id), `vendors`, `storage_areas`, `pick_paths` (item_id, area_id, shelf_order), `order_log` (item_id FK + denormalized snapshot of pack/name/qty at order time).

---

## 4. Mobile API surface (PWA → Apps Script Web App)

Endpoint: per-store deployment URL. Single `POST` with body `{ pin, action, payload }`. Content-Type **must** be `text/plain;charset=utf-8` (Apps Script Web Apps reject `application/json` CORS preflight).

PIN authentication: store PIN OR master PIN (multi-unit manager). Lockout after 5 failed attempts for 5 minutes.

| Action | Payload | Returns | Reads | Writes |
|---|---|---|---|---|
| `ping` | — | `{location, abbr, isManagerMode}` | ScriptProperties | — |
| `getResetStatus` | — | `{today, lastReset, isStale}` | ORDER_ENTRY AE2, AE9 | — |
| `commitReset` | — | `{logged, rowsLogged, orderDate, skippedReason, resetDate}` | All vendor tabs | LOG_ORDERS (append), all vendor tabs (clear col E), ORDER_ENTRY AE9 |
| `getDashboard` | — | `{date, dayOfWeek, location, vendors: [...]}` | SETUP, vendor tabs, LOG_ORDERS | — |
| `getVendorItems` | `{vendor}` | `{vendor, cutoffTime, items: [...]}` | Vendor tab (A:M), SETUP pick path, MASTER_ITEMS (use-mult) | — |
| `saveOnHand` | `{vendor, items: [{id, onHand}]}` | `{saved, vendor}` | Vendor tab col M (id lookup) | Vendor tab col E |
| `emailRecap` | `{force?, vendors?}` | `{cycleDate, vendorCount, itemCount, sentCount, failedCount, failed[], alreadySent, vendors[]}` | SETUP recipients, all vendor tabs | ScriptProperties `MOG_LAST_RECAP_SENT_DATE`; sends emails |
| `getRecapData` | `{vendors?}` | `{cycleDate, vendorCount, itemCount, sections[]}` | same as emailRecap | — |
| `getRecipients` | — | `{recipients: [...]}` | SETUP AB:AE | (lazy header write) |
| `saveRecipients` | `{recipients: [...]}` | `{recipients: [...]}` | SETUP AB:AE | SETUP AB:AE (GM lock enforced) |
| `getHistory` | `{vendor?, dateFrom?, dateTo?}` | `{groups: [{date, vendors: [...]}]}` | LOG_ORDERS | — |
| `getHistoryDetail` | `{date, vendor}` | `{vendor, date, timestamp, reference, items: [...], itemCount}` | LOG_ORDERS, MASTER_ITEMS (pack lookup) | — |

**Per-cycle reference:** `<ABBR>-<MMDD>-<VVV>` (e.g. `RPR-0524-SYS`) — generated by `generateReferenceFromDateStr_`.

**`ScriptProperties` used by the API:**

| Key | Purpose |
|---|---|
| `MOG_API_PIN` | Store PIN |
| `MOG_API_MASTER_PIN` | Multi-unit manager PIN (optional) |
| `MOG_GM_EMAIL` | Legacy GM email (seeded into recipients on first read) |
| `MOG_LOCATION_NAME` | Display name |
| `MOG_LOCATION_ABBR` | 2-5 letter abbreviation (used in references) |
| `MOG_LAST_RECAP_SENT_DATE` | Dedupe gate for auto-send paths |
| `MOG_PIN_FAIL_COUNT` | Rate-limit counter |
| `MOG_PIN_LOCKOUT_UNTIL` | Rate-limit window expiry |

**`DocumentProperties` used by the system:**

| Key | Purpose |
|---|---|
| `mog_serverMutationTs` | Bumped on every commit; keys CacheService entries |
| `LAST_LOG_DATE` | Fast-path duplicate guard for LOG_ORDERS |
| `LAST_OVERRIDE_DATE` | Emergency override auto-reset gate |
| `DASH_MANAGE_ROW` | Dashboard quick-action row (dynamic per layout) |

---

## 5. Apps Script function inventory (modals → server)

These are the functions called via `google.script.run` from the 6 in-Sheet modal HTML files. **Every one of these needs an HTTP equivalent in the expanded `MOGApi.gs`** (or eventual Supabase RPC) to enable the PWA port.

### 5.1 Storage Areas (`StorageAreas.html`)

| Function | Reads | Writes |
|---|---|---|
| `getStorageAreaList()` | SETUP H:I rows 2-19 | — |
| `commitAddStorageArea(name)` | SETUP H:I | SETUP H:I, pick path DB (areaOrder sync) |
| `commitRenameStorageArea(old, new)` | SETUP H:I, pick path list, pick path DB | SETUP H:I, pick path list (col B), pick path DB |
| `commitDeleteStorageArea(name)` | SETUP H:I, pick path DB | SETUP H:I, pick path DB (rows with this area removed) |
| `commitReorderStorageAreas(orderedNames)` | SETUP H:I | SETUP H:I, pick path DB (areaOrder sync) |

### 5.2 Vendors (`ManageVendors.html`)

| Function | Reads | Writes |
|---|---|---|
| `getVendorList()` | SETUP Z | — |
| `getVendorTableData()` | SETUP Z, S:Y, AA | — |
| `commitAddVendor(name, mults, cutoff)` | SETUP Z, pick path DB | SETUP Z, R, S:Y, AA; new vendor tab (copy from VENDOR_TEMPLATE, protect, set B1) |
| `commitUpdateVendorMults(name, mults)` | SETUP Z | SETUP S:Y |
| `commitUpdateVendorCutoff(name, cutoff)` | SETUP Z | SETUP AA |
| `commitRemoveVendor(name)` | SETUP R, Z, S:Y, MASTER_ITEMS | SETUP R, Z, S:Y (rows deleted); MASTER_ITEMS col L set to false for matching vendor rows. **Does NOT delete the vendor tab or pick path DB entries** — left for manual cleanup. |

### 5.3 Items (`ManageItems.html`)

| Function | Reads | Writes |
|---|---|---|
| `getAllItemsForView()` | MASTER_ITEMS, pick path DB | — |
| `getManageItemsBootstrap()` | items + par flags, **CacheService-wrapped** | (cache write only) |
| `getItemsByVendor(vendor)` | MASTER_ITEMS | — |
| `getUnassignedActiveItems()` | MASTER_ITEMS, pick path DB | — |
| `getItemForEdit(query)` | MASTER_ITEMS, pick path DB | — |
| `commitUpsertItem(payload)` | MASTER_ITEMS, SETUP areas | MASTER_ITEMS (insert or update row), optionally pick path DB (inline area assignment) |
| `commitDeactivateItem(itemId)` | MASTER_ITEMS, pick path DB | MASTER_ITEMS col L → false; pick path DB row removed; SETUP pick-path list reloaded if active vendor matches |
| `commitDeleteItem(itemId)` | MASTER_ITEMS, pick path DB | MASTER_ITEMS row deleted + table resorted; pick path DB row removed |
| `getParReviewFlags()` | LOG_ORDERS, MASTER_ITEMS | — | ⚠ TODO: confirm — referenced but not yet read; computes flags from 14-day window |

### 5.4 Pick Path (`ReorderPickPath.html`)

| Function | Reads | Writes |
|---|---|---|
| `getPickPathForSidebar(vendor)` | SETUP pick path DB, areas, MASTER_ITEMS | — |
| `commitReorderPickPath(vendor, payload)` | SETUP areas | SETUP pick path DB (all rows for vendor replaced) |
| `commitPickPathAreaAssignment(itemId, vendor, areaName)` | SETUP areas, pick path DB, MASTER_ITEMS | SETUP pick path DB (single row upsert), pick path list reloaded if active |

### 5.5 Order History (`OrderHistory.html`)

| Function | Reads | Writes |
|---|---|---|
| `getOrderHistory(filters)` | LOG_ORDERS | — | ⚠ TODO: confirm — referenced but not yet read; returns flat array of log rows filtered by vendor + date range |
| `getOrderHistoryVendorList()` | LOG_ORDERS | — | ⚠ TODO: confirm — vendor distinct list from log |
| ~~`getOrderSummary()`~~ | — | — | Now computed client-side from `getOrderHistory()` rows |

### 5.6 Admin Reset (`AdminReset.html`)

| Function | Reads | Writes |
|---|---|---|
| `commitSelectiveReset(options)` | SETUP, LOG_ORDERS | Up to 5 zones cleared per options: pick path DB, pick path list, vendor table+list, storage areas, LOG_ORDERS data rows |

### 5.7 Reset flow (triggered from dashboard checkbox + mobile API)

| Function | Reads | Writes |
|---|---|---|
| `resetOnHandAllVendors()` | All vendor tabs | All vendor tabs col E (cleared), ORDER_ENTRY AE9 stamped | ⚠ TODO: confirm full impl |
| `commitLogAndReset()` | All vendor tabs, LOG_ORDERS | LOG_ORDERS (append for items with suggested > 0), all vendor tabs col E (cleared), DocumentProperties LAST_LOG_DATE | ⚠ TODO: confirm full impl |
| `snapshotVendorOrders_(orderDate, timestamp)` | All vendor tabs | Returns rows (caller writes to LOG_ORDERS) |
| `clearOrderLog()` | — | LOG_ORDERS data rows cleared | ⚠ TODO: confirm impl |

---

## 6. Per-modal data flow summary

For each modal: what data shape it bootstraps with, what it commits, and what UX assumptions it carries that the PWA port must preserve.

### 6.1 Manage Items
- **Bootstrap:** `getManageItemsBootstrap()` returns `{items: [...], flags: {itemId: {flag, ...}}}` in one round-trip. Cached server-side (CacheService keyed by mutation timestamp) and client-side (localStorage 10-min TTL, invalidated by cross-modal mutation timestamp).
- **Tabs:** View All / Add / Edit / Inactive / Unassigned
- **Writes:** `commitUpsertItem`, `commitDeactivateItem`, `commitDeleteItem`, `commitPickPathAreaAssignment` (inline from Add/Edit)
- **UX assumptions:** EN/ES bilingual, two-pane layout (item table left, form right), par-review flag column, "no storage area" red-highlight rows, real-time client-side filter + sort.

### 6.2 Manage Vendors
- **Bootstrap:** `vendorListJson` + `vendorTableJson` pre-baked into HTML template. No initial round-trip.
- **Sections:** View All (vendor cards with multiplier pills + cutoff badge) / Add (collapsible) / Remove (collapsible)
- **Writes:** `commitAddVendor` (also creates the vendor tab), `commitUpdateVendorMults`, `commitUpdateVendorCutoff`, `commitRemoveVendor`
- **UX assumptions:** EN/ES, cutoff input is `<input type="time">` (returns `"HH:MM"` 24h), inline edit per vendor card, auto-computed multipliers from selected delivery days.

### 6.3 Manage Pick Path
- **Bootstrap:** `pickDataJson` (active vendor's groups) + `vendorListJson` pre-baked. Vendor switch re-fetches via `getPickPathForSidebar(vendor)`.
- **UI:** Vertical list of area groups; unassigned bucket at top. Each row has ⇆ (move section) + ▲▼ (reorder within section). Picker modal for adding from unassigned.
- **Writes:** `commitReorderPickPath(vendor, payload)` — full replace of that vendor's rows in the DB.
- **UX assumptions:** EN/ES, optimistic local updates with snap-back on save failure, vendor-switch dirty-prompt.

### 6.4 Order History
- **Bootstrap:** `getOrderHistoryVendorList()` for filter dropdown; `getOrderHistory({last 7 days})` on initial load.
- **Tabs:** Recent Orders (grouped by vendor → date) / Item History (flat sortable table with search) / Vendor Summary (aggregated, client-side, copyable)
- **Writes:** None (read-only).
- **UX assumptions:** EN/ES, date-range presets (7/30/90/all/custom), client-side sort + filter, clipboard export for Summary.

### 6.5 Storage Areas
- **Bootstrap:** `areaListJson` pre-baked. Refetch on commit failure via `getStorageAreaList()`.
- **UI:** Single list with drag-handle ⠿ for reorder, ✎ rename, 🗑 delete. Add/Delete collapsibles below.
- **Writes:** `commitAddStorageArea`, `commitRenameStorageArea`, `commitDeleteStorageArea`, `commitReorderStorageAreas`
- **UX assumptions:** EN/ES, drag-and-drop reorder, optimistic local updates with snap-back, max ~18 areas.

### 6.6 Admin Reset
- **Bootstrap:** None — pure form.
- **UI:** 5 checkboxes (selective clear), confirm input ("type RESET").
- **Writes:** `commitSelectiveReset({pickPathDb, pickPathList, vendors, areas, orderLog})`
- **UX assumptions:** EN/ES, multi-select, type-to-confirm.

### 6.7 How To Use
- **Bootstrap:** None — static reference docs.
- **UX assumptions:** EN/ES, left-nav + collapsible cards.
- **Migration note:** Easiest of the 6 to port (no API surface). Good warm-up for the responsive design system.

---

## 7. Cross-store assumptions

The 9 deploy targets share **identical code**. Per-store variation lives only in the spreadsheet. Every assumption below holds for all 8 production stores + the master template.

| Assumption | Status |
|---|---|
| Sheet names: `MASTER_ITEMS`, `SETUP`, `ORDER_ENTRY`, `LOG_ORDERS`, `VENDOR_TEMPLATE` | Identical |
| All column layouts (sections 2.1-2.5) | Identical |
| Set of modals (6 + How To Use) | Identical |
| `commitAddVendor` copy-from logic | Looks up `VENDOR_TEMPLATE` by name; falls back to index 3. ⚠ Fragile — if a store has a 4th tab that isn't the template, vendor creation will fail. |
| Storage area count cap (18 = rows 2-19 in SETUP H:I) | Identical hard limit |
| Vendor count cap | No explicit cap; bounded only by sheet maxRows (typically 1000+) |
| Item count cap | No explicit cap; bounded only by MASTER_ITEMS maxRows |
| PIN auth model | Identical (4-8 digit numeric, optional master PIN) |
| Day-of-week math | Identical (Mon=index 0 in S:Y, day name from `AE3 = TEXT(...,"ddd")`) |
| Reference code format | `<ABBR>-<MMDD>-<VVV>` — abbr varies per store, format identical |

**What varies (per-store data):**

- Location name + abbr (ScriptProperties)
- Store PIN (ScriptProperties)
- GM email + recipient list (SETUP AB-AE)
- Set of vendors (SETUP Z + vendor tabs)
- Set of storage areas (SETUP H:I)
- Set of items (MASTER_ITEMS)
- Order history (LOG_ORDERS)
- Pick path config (SETUP K:P)

**Implication for Supabase:** A single multi-tenant Postgres with `tenant_id` (= store slug from `stores.json`) on every table is sufficient. RLS policies key off `tenant_id`. No per-store schemas needed.

---

## 8. Responsive design philosophy (for Phase 1+ port)

The current modals are **desktop-only** — `showModalDialog` with fixed pixel widths (480-1200px) and heights (540-900px). The PWA today is **mobile-only** — single-column, touch-targets, no desktop layout.

The port should be **genuinely responsive**, single codebase, breakpoint-driven.

### 8.1 Breakpoint targets

| Breakpoint | Width | Primary user | Primary use |
|---|---|---|---|
| Mobile | <768px | KMs on phones in the kitchen | Daily ordering (current PWA flow) |
| Tablet | 768-1023px | KMs on tablets, managers on the floor | Mixed |
| Desktop | ≥1024px | Managers at a desk | Admin (item/vendor CRUD), reporting, review |

### 8.2 Per-flow primary device

| Flow | Mobile-primary | Desktop-primary | Both equally |
|---|---|---|---|
| Daily ordering (KM counting + saving on-hand) | ✓ | | |
| Recap email send / review | ✓ | | |
| Recipient management | | | ✓ |
| Manage Items (CRUD) | | ✓ | |
| Manage Vendors (CRUD) | | ✓ | |
| Manage Pick Path | | | ✓ (mobile for in-kitchen walk; desktop for batch ops) |
| Storage Areas | | | ✓ |
| Order History (Recent) | | | ✓ |
| Order History (Summary / Item History) | | ✓ | |
| Admin Reset | | ✓ | |
| Par Review flags | | ✓ | |
| How To Use | | | ✓ |

### 8.3 Layout shifts at breakpoints

- **Mobile:** single-column cards, bottom-nav or hamburger, full-screen modals, large tap targets (≥44pt), no hover states.
- **Tablet:** two-column where useful (list + detail), modals can be centered dialogs.
- **Desktop:** sidebars, multi-column tables, hoverable rows, keyboard shortcuts (`/` to search, `Esc` to close, etc.), proper sortable tables (not card stacks).

### 8.4 Existing patterns to preserve

- EN/ES bilingual via class-based visibility — keep but consider migrating to a proper i18n lib (e.g. small custom hook with JSON dictionaries).
- The "saving overlay" pattern (dim + lock + label) from the current modals — keep; works at both breakpoints.
- Mutation timestamp pattern for cache invalidation — keep, but move from `localStorage` to a proper React Query / SWR setup if framework is introduced.

### 8.5 Open framework question

The PWA today is vanilla JS / no framework. For a responsive multi-modal app with shared state (auth, cache invalidation, etc.), some structure helps. Candidates:
- **Stay vanilla** — keep build.py + zero deps. Forces simple architecture but more boilerplate per modal.
- **Add Preact + HTM** — ~3KB, no JSX compile step, works inside `<script type="module">`. Adds component model without a build chain.
- **Switch to a real framework (React/Svelte/etc.) with a bundler** — biggest leap; gives full ecosystem but blows up the build.

⚠ Not a Phase 0 decision. Flag for discussion before Phase 1.

---

## 9. Open questions / gaps to verify

Items marked `⚠ TODO` above, consolidated:

1. **MASTER_ITEMS columns H, I, J, K** — `MOG_COL.ON_HAND = 9` is declared but the API reads on-hand from vendor tabs. Confirm what (if anything) currently lives in cols H-K on the master sheet.
2. **Vendor tab columns C, G-L** — only A/B/D/E/F/M are referenced in code. Confirm whether C and G-L are blank, formula-driven, or hold display-only data.
3. **`getParReviewFlags()` implementation** — referenced by `getManageItemsBootstrap` but not yet read. Need to confirm: 14-day window, ≥2 orders threshold, 10%/75%/par≥3 for "Always Empty", 50%/50% for "Over-Ordered" (per HowToUse.html).
4. **`getOrderHistory(filters)` implementation** — referenced by both PWA (`api_getHistory_`) and OrderHistory modal. Confirm date filter behavior, return shape, and how it joins LOG_ORDERS rows with item pack metadata.
5. **`getOrderHistoryVendorList()`** — vendor distinct from LOG_ORDERS, or all vendors regardless of history? Confirm.
6. **Full reset flow** (`resetOnHandAllVendors`, `commitLogAndReset`, `clearOrderLog`) — read all three to confirm the atomic write order and what happens on partial failure.
7. **VENDOR_TEMPLATE structure** — what's the canonical template look like? `commitAddVendor` copies it; if it drifts the new vendor tab inherits the drift.
8. **Dashboard build** (`buildHomeDashboard`) — what cells does it write, and what is the relationship between the dynamic manage-row and the AE100+ vendor filter spill?

For each of these, the gap is closeable by either (a) reading more of `OrderGuideScript.gs` or (b) Sebastian opening a live Sheet and confirming. The minimum viable Supabase schema can be drafted without these — they affect specific function ports.

---

## 10. Appendix — First-pass Supabase schema (draft, not committed)

For evaluation against the data model above. Every table carries `tenant_id text not null` (= store slug from `stores.json`); RLS policy: `using (tenant_id = current_setting('app.tenant_id'))`.

```sql
-- ── Tenants (stores) ──────────────────────────────────────────────────
create table tenants (
  id          text primary key,        -- 'rpr', 'rprfo', 'rpt', ...
  name        text not null,           -- 'Roll Play - Rosslyn BOH'
  abbr        text not null,           -- 'RPR'
  concept     text not null,           -- 'Roll Play' | 'Teas'n You'
  location    text not null,           -- 'Rosslyn BOH'
  created_at  timestamptz default now()
);

-- ── Vendors ─────────────────────────────────────────────────────────
create table vendors (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    text not null references tenants(id),
  name         text not null,
  cutoff_time  time,                   -- null = no cutoff
  -- 7 multipliers (mon..sun), parallel to SETUP S:Y
  mult_mon     numeric not null default 0,
  mult_tue     numeric not null default 0,
  mult_wed     numeric not null default 0,
  mult_thu     numeric not null default 0,
  mult_fri     numeric not null default 0,
  mult_sat     numeric not null default 0,
  mult_sun     numeric not null default 0,
  active       boolean not null default true,
  created_at   timestamptz default now(),
  unique (tenant_id, name)
);

-- ── Storage Areas ───────────────────────────────────────────────────
create table storage_areas (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   text not null references tenants(id),
  name        text not null,
  sort_order  int  not null,           -- 10, 20, 30...
  created_at  timestamptz default now(),
  unique (tenant_id, name)
);

-- ── Items ───────────────────────────────────────────────────────────
create table items (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    text not null references tenants(id),
  legacy_id    text,                   -- 'ITEM-0001' (preserve for migration)
  vendor_id    uuid not null references vendors(id) on delete restrict,
  name         text not null,
  sku          text,
  pack         text,
  category     text,
  base_par     numeric not null default 0,
  use_multiplier boolean not null default true,
  active       boolean not null default true,
  notes        text,
  created_at   timestamptz default now(),
  updated_at   timestamptz default now(),
  unique (tenant_id, vendor_id, name)
);

-- ── Pick-path assignments ────────────────────────────────────────────
create table pick_path_entries (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    text not null references tenants(id),
  item_id      uuid not null references items(id) on delete cascade,
  area_id      uuid not null references storage_areas(id) on delete restrict,
  shelf_order  int  not null,          -- 10, 20, 30... within area
  unique (tenant_id, item_id)          -- item lives in exactly one area
);

-- ── On-hand counts (replaces vendor-tab col E) ───────────────────────
-- One row per (item, cycle). Cycle = an order date.
create table on_hand_counts (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    text not null references tenants(id),
  item_id      uuid not null references items(id) on delete cascade,
  cycle_date   date not null,          -- the active cycle date
  on_hand      numeric not null,
  updated_at   timestamptz default now(),
  unique (tenant_id, item_id, cycle_date)
);
-- Suggested qty: computed view, not stored:
--   target_par = base_par * (use_multiplier ? vendor.mult_<dow> : 1)
--   suggested  = greatest(target_par - on_hand, 0)

-- ── Order log (= LOG_ORDERS) ─────────────────────────────────────────
create table order_log (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     text not null references tenants(id),
  cycle_date    date not null,
  vendor_id     uuid not null references vendors(id),
  item_id       uuid not null references items(id),
  -- Denormalized snapshot — survives item/vendor renames/deletes:
  vendor_name_at_time text not null,
  item_name_at_time   text not null,
  pack_at_time        text,
  on_hand_prev  numeric not null,
  qty_ordered   numeric not null,
  logged_at     timestamptz default now()
);
create index on order_log (tenant_id, cycle_date);
create index on order_log (tenant_id, item_id);

-- ── Recap recipients ─────────────────────────────────────────────────
create table recap_recipients (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   text not null references tenants(id),
  name        text not null,
  email       text not null,
  active      boolean not null default true,
  is_gm       boolean not null default false,
  unique (tenant_id, email)
);

-- ── Store config (replaces ScriptProperties) ─────────────────────────
create table store_config (
  tenant_id   text primary key references tenants(id),
  store_pin   text not null,           -- hash, not plain
  master_pin  text,                    -- hash
  gm_email    text,                    -- legacy seed
  last_recap_sent_date date,
  pin_fail_count int not null default 0,
  pin_lockout_until timestamptz
);
```

**Notes:**
- `on_hand_counts` keyed by `(item, cycle_date)` lets us preserve history of in-progress counts if useful, AND lets the dashboard's "is there an in-progress order today" check be a simple count.
- `order_log` denormalizes vendor/item name + pack at the time the row was written — so item renames/deletes don't break historical reports. Matches today's LOG_ORDERS behavior.
- No separate `vendor_tabs` table — vendor tabs were a UI artifact of Sheets. Supabase has one logical table per concept.
- `store_config` replaces ScriptProperties — same key/value role, but tabular.
- Vendor-tab `H2` day multiplier becomes a per-request lookup: `vendor.mult_<dow>` joined at query time. No persisted denormalization needed.

**Not included (defer):**
- Supabase Auth integration — Phase 1+ decision (per-store PIN today, per-user later).
- Realtime subscriptions — wins for "manager edits item → KM phone updates live" but adds complexity. Defer until UX is proven.
- Audit log — captured implicitly by `updated_at` + `logged_at`. Add an `audit_log` table only if compliance need arises.

---

*Last updated: 2026-05-25 — Section 9 gaps still open; pending live-Sheet validation by Sebastian.*
