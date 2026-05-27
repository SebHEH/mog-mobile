# Session Handoff — Audit punch list close-out + modal UX polish

**Session date:** 2026-05-27
**Session focus:** Continue the Apps Script modal perf audit (items #3–7) and address Sebastian's UX-consistency observations across the modals.
**Outcome:** 6 of 7 audit items now shipped (only #6 deploy.py parallelization remains, deferred as not-urgent). Plus a meaningful UX pass: strengthened "Saved" feedback across all 5 save-capable modals, added missing Close buttons (StorageAreas, ManageVendors), removed the redundant Delete Area panel from StorageAreas, and made the inline trash button visually red. All 9 targets deployed (push + redeploy).
**Next session focus:** Either start the ManageVendors edit-form UX redesign (delivery-day vs raw-mults inconsistency Sebastian flagged) or close out the audit's last item (parallelize deploy.py).

---

## What shipped

### Audit item #3 — `api_getDashboard_` caching + loop hoist
- New `countActiveItemsByVendor_()` in `MOGApi.gs` — one MASTER_ITEMS scan returns counts for every vendor, replaces the per-vendor scan inside the dashboard loop (~9 fewer full-sheet reads per hit on a 10-vendor day).
- `api_getDashboard_` now wraps `api_getDashboard_compute_()` with the same `CacheService` pattern as `getManageItemsBootstrap`. Keyed by `dateStr + getServerMutationTs_`, 300s TTL, fail-safe.
- Added `bumpServerMutationTs_()` to `api_saveOnHand_` so on-hand writes invalidate the dashboard cache (slight overlap with manage-items cache is intentional and cheap).
- **Architectural decision:** chose to reuse `getServerMutationTs_` rather than introducing a separate dashboard timestamp. Separate ts would have needed 11+ bump callsites; reuse needed 1. Trade-off: admin storage-area/pick-path edits also invalidate the dashboard cache, but those are rare and recompute is cheap.

### Audit item #5 — small wins (2 of 3 done)
- `fetchCurrentArea()` removed: `getItemsByVendor` now returns `currentArea` inline (1 follow-up RPC eliminated per item selection in ManageItems).
- `getVendorTableData` merged 3 range reads into 1 (S:AA, 9 columns). The original "Z duplicate column" concern was wrong — getRange round-trip dominates per-cell cost.
- `getSheet_` per-execution memoization via module-level Map. Apps Script V8 resets globals between invocations → no cross-execution pollution. Sheet creation paths don't invalidate cached names; sheet deletion doesn't exist in this codebase.

### Audit item #4 — StorageAreas server-side helper extraction
- New `commitAreaListMutation_(mutate)` helper. Add/delete/reorder commit functions now share the bump → read → mutate → write → sync skeleton. Rename keeps its own implementation (edits area block in place, doesn't fit the "rewrite list" shape).
- **NOT** done: full RPC consolidation to a single `mutateStorageAreas({add, delete})`. Original audit description was overoptimistic — the real win requires a draft-mode UX change that isn't what Sebastian wants. Pure code-hygiene win only.

### Audit item #7 — CACHE_VERSION audit
- Closed clean: `template/sw.js` and `sw.js` both correctly at v5. Last bump 2026-05-22 ([fdd1130](https://github.com/SebHEH/mog-mobile/commit/fdd1130)). Only commits to shell files since then were STORE_REGISTRY injections to root `index.html`, which the network-first SW handles without an eviction.

### Modal UX polish pass (Goal A from the architectural walkthrough)
- **Strengthened `.status.ok` across 5 modals** (AdminReset, ManageItems, ManageVendors, ReorderPickPath, StorageAreas): added ✓ prefix + brief green-tint background flash that fades in 0.9s. One CSS block, identical across all modals.
- **New Close button on StorageAreas** — was missing entirely (no top X, no main button). Sticky footer matches the AdminReset/ReorderPickPath pattern.
- **New Close button on ManageVendors** — same gap as StorageAreas, same fix.
- **StorageAreas layout restructure**: body became flex column (`100vh + overflow:hidden`), `.body` became the scrolling middle, modal-footer sits outside. **Subtle gotcha caught during canary**: flex children default to `shrink:1`, so `.list-card` with `overflow:hidden` was clipping rows instead of allowing `.body` to scroll. Fix: `.body > * { flex-shrink: 0 }` on all immediate children. Cost two failed push iterations before nailed.
- **StorageAreas Delete Area panel removed entirely.** Redundant with the inline 🗑 button which already has a `window.confirm` gate. Removed `doDelete`, `populateDeleteSelect`, all callsites, unused T strings, and the section's HTML. Simplified `quickDelete` feedback to optimistic-UI + `window.alert` for error/inUseCount messages (the deleted `delete-status` div made the previous setStatus calls into silent no-ops).
- **Inline 🗑 visually red at rest** (light pink bg, red border, red icon). Hover deepens to stronger red. Was only red on hover before — easy to miss as a destructive affordance.

### Deploy
- Both `--redeploy` and plain push were used at various points. Final fan-out used `python deploy.py --redeploy` because MOGApi.gs / getSheet_ memoization needs the per-store `/exec` URL bumped. All 9 targets succeeded.

---

## Outstanding (carry forward)

**Audit punch list (1 of 7 remaining):**
- Item #6: Parallelize `deploy.py` with `concurrent.futures.ThreadPoolExecutor`. Would drop 30s+ serial wait to ~5s. Not urgent — current sequential pattern works fine.

**Sebastian's flagged UX inconsistency (architectural walkthrough needed):**
- **ManageVendors edit-form vs add-form mismatch.** Add Vendor uses the user-friendly "pick delivery days + lead days → mults auto-calculated" model. Edit Vendor shows raw multipliers. Not trivially reversible (mults can correspond to multiple delivery+lead combinations). Two options sketched: (a) store `deliveryDays[]` and `leadDays` as separate columns and compute mults at save time — cleaner, schema migration; (b) infer most-likely delivery+lead from mults at load — fragile.

**Other deferred:**
- StorageAreas full draft-mode UX (Goal B from earlier walkthrough). Optimistic-immediate-fire currently works fine; switching to draft + Save & Exit is a bigger redesign.
- Decommission `Master-Ordering-Guide` GitHub repo (~2026-05-31 per prior plan).

**Verification gates not closed:**
- All canary/fan-out tests were validated by Sebastian opening the live URLs and exercising the actions. No automated tests. The full fan-out was confirmed to work on rpr before fanning out, but the other 8 targets weren't individually smoke-tested.

---

## Files touched this chat

**Apps Script source:**
- `apps-script/MOGApi.gs` — `countActiveItemsByVendor_`, dashboard cache wrap, `api_saveOnHand_` bump, fetchCurrentArea cleanup
- `apps-script/OrderGuideScript.gs` — `getSheet_` memoization, `getVendorTableData` read merge, `getItemsByVendor` currentArea enrich, `commitAreaListMutation_` helper
- `apps-script/AdminReset.html` — `.status.ok` flash
- `apps-script/ManageItems.html` — `.status.ok` flash, fetchCurrentArea replaced with setCurrentAreaFromItem
- `apps-script/ManageVendors.html` — `.status.ok` flash, new sticky-footer Close button
- `apps-script/ReorderPickPath.html` — `.status.ok` flash
- `apps-script/StorageAreas.html` — `.status.ok` flash, flex-column body restructure, new Close button, Delete Area panel removed, JS cleanup (doDelete, populateDeleteSelect), red `.btn-icon.danger` at rest, T-string pruning

**Docs:**
- `docs/MOG_CurrentState.md` — updated below
- `docs/MOG_SessionHandoff_2026_05_27.md` — this file
- `CLAUDE.md` — @-import line updated

**Deployed to:** all 9 clasp targets via `python deploy.py --redeploy`.

---

## Commits landed this session

```
e9eaab5 Modal upsates
341d3d8 Bummmmms
```

---

## Opening prompt for next session

```
Resume MOG work. Last session (2026-05-27) closed out 6 of 7 audit items:
api_getDashboard_ caching + loop hoist, fetchCurrentArea removal,
getVendorTableData read merge, getSheet_ per-execution memoization,
StorageAreas server-helper extraction (option A, not full RPC consolidation),
and the CACHE_VERSION audit. Item #6 (parallelize deploy.py) deferred as
not-urgent.

Also shipped a UX polish pass across all 5 save-capable modals:
strengthened the Saved beat (✓ + green flash), added missing Close
buttons (StorageAreas + ManageVendors), and reworked StorageAreas
(removed Delete Area panel, red inline trash button, scroll layout fix).

Two natural next directions:
1. ManageVendors edit-form UX redesign — Sebastian flagged the
   add-form/edit-form inconsistency (delivery-day + lead-day picker on
   add, raw mults on edit). Needs an architectural walkthrough first;
   the mults-to-delivery model isn't trivially reversible. May involve
   a small schema migration (store deliveryDays + leadDays as columns).
2. Parallelize deploy.py — the last audit item. ~30s → ~5s wall clock.
   Bounded scope, mechanical change.

Read docs/MOG_CurrentState.md for invariants and the deploy commands
before any code edits. Canary-first: `python deploy.py --target rpr`
(add --redeploy if touching MOGApi.gs).

Gotcha worth surfacing: StorageAreas modal now uses a flex-column body
with `.body > * { flex-shrink: 0 }` on the immediate children. If you
add new top-level cards inside .body, they need to remain flex children
or the scroll will silently break (.list-card has overflow:hidden, so
shrunk content gets clipped instead of triggering .body's overflow-y
scroll). Bit me twice last session.
```

---
---

# Later session — ManageItems multi-vendor items + modal declutter

**Session date:** 2026-05-27
**Session focus:** The ManageItems redesign — let an item be orderable from multiple vendors with a one-tap switchable *active* vendor, plus a declutter pass on the modal.
**Outcome:** Shipped to all 9 clasp targets (bound-sidebar push, no `--redeploy` — none of the changed functions are `api_*` endpoints the PWA hits). Canary rprfo smoke-tested by Sebastian across three iterations before fan-out. **Verified from the actual store sheet (downloaded xlsx) that the order math is independent of SKU and that par is shared per-item — so the multi-vendor model is math-safe.**
**Next session focus:** The modal-chrome de-dup sweep across the *other* modal-dialog modals (OrderHistory etc.), which Sebastian approved for "afterwards."

## What shipped

### Data model — eligible vendors in a NEW column O (not a repurpose of D)
- `apps-script/OrderGuideScript.gs` — `COL.ELIGIBLE_VENDORS = 15` (column **O**), a brand-new column. `COL.SKU` (D) was **kept**, not repurposed.
- **Why column O, not repurpose D (do NOT re-litigate):** the original plan was to repurpose the dead SKU column D. Reviewing the real `RP_ROSSLYN_FOH` xlsx showed every vendor tab's hidden "SKU" column (cols C and S) does `XLOOKUP(id, MASTER_ITEMS!A, MASTER_ITEMS!D)` — so writing vendor lists into D would surface them in those columns. SKU's column D is already blank for items (so SKU is effectively already gone). Column O is referenced by no in-sheet formula → purely additive, zero risk. Sebastian decided SKU doesn't need scrubbing (it's hidden).
- **Order math confirmed safe:** the vendor tab `Order` column (F) is `ROUNDUP(par × H2 − onHand)` where `par = XLOOKUP(id, MASTER_ITEMS!A, MASTER_ITEMS!G)` and H2 is the vendor's day-of-week multiplier. SKU isn't involved. Par is shared per-item; switching an item's active vendor moves it to that vendor's tab and applies that vendor's multiplier. "1-day par, multiplier does the rest" — verified from the sheet.
- New helpers: `parseEligibleVendors_`, `serializeEligibleVendors_`, `normalizeEligibleList_` (validates against the vendor table, always includes the active vendor, drops unknowns → reads self-heal even before the backfill). List stored pipe-delimited in O.
- `commitUpsertItem` writes the eligible list to O on add + edit (active vendor always forced in). `getAllItemsForView` (+ hoisted vendor map) and `getItemForEdit` now return `eligibleVendors`. `findItemRow_` read widened to include col O.
- **`commitSwitchActiveVendor(itemId, newVendor)`** (NEW) — the quick-switch backend. Validates the target is eligible, rewrites col C, migrates the pick-path row to the new vendor carrying the storage area over (areas are global), returns `needsArea:true` only if the item was unassigned. Par untouched.
- **`migrateItemVendorsColumn()`** (NEW, idempotent) — one-time per-store backfill wired into **Ordering Guide → Mobile API → Migrate Item Vendors**. Sets the O header to "Eligible Vendors" and seeds each item's list = its current vendor. **Optional** — purely sheet hygiene; reads self-heal so the feature works without it.
- Bumped both cache keys (`getManageItemsBootstrap` server key `manageItems_v1_`→`v2_`; client `ITEMS_CACHE_KEY` →`_v2`) since `getAllItemsForView`'s item shape gained `eligibleVendors`.

### Modal UI — `apps-script/ManageItems.html`
- **Eligible-vendor checklist** ("Also orderable from") in Add + Edit — lists every vendor except the active one (implicit). Wired into both `commitUpsertItem` saves.
- **Quick-switch "Active vendor" control** on the View detail. Always shown for consistency; enabled when the item has ≥2 eligible vendors, grayed with "Only orderable from one vendor." otherwise. Switch → `commitSwitchActiveVendor` → re-renders detail + refetches table; surfaces the `needsArea` warning.
- **Declutter (all 6 Sebastian asked for):** (1) removed the Edit top tab + the now-vestigial in-panel vendor/item selectors — editing is only via View → row → "Edit This Item", and `loadItemIntoEdit` now does one light `getItemForEdit` fetch instead of the whole-vendor-list `getItemsByVendor` (RPC removed); (2) legend shortened + reworded — 🟡 "Possible under-ordering", 🔴 "Possible over-ordering", "No storage area", Inactive entry dropped; (3) table set to `width:100%` + `overflow-x:hidden` so the Par Review column + legend show without horizontal scroll; (4) red count chip on the Unassigned tab; (5) count chip on the Inactive tab (both derived from `allItems`, no extra RPC); (6) Add panel given a green top accent + "＋ Add New Item" heading to distinguish it from Edit.
- **Removed the modal's self-added "Manage Items" title + ✕** from the dark bar — they doubled Google's `showModalDialog` chrome (title + X + border, which is unavoidable). Now a single title + single X.
- Removed dead code orphaned by the above (`loadEditItems`, `onEditItemChange`, `setItemSelectLoading_`, `setCurrentAreaFromItem`, `editItems` var, unused legend CSS). EN/ES parity maintained (102 keys each, verified).

## Outstanding (carry forward)

- **Run the backfill per store when convenient** — Ordering Guide → Mobile API → Migrate Item Vendors, on each of the 9 sheets. Optional (feature works without it); it just renames the O header + seeds vendor names. Like the trigger-install pattern, it's a per-Sheet manual step.
- **Modal-chrome de-dup sweep (next session, Sebastian-approved):** the other `showModalDialog` modals (OrderHistory, and check ManageVendors/StorageAreas/ReorderPickPath/AdminReset/HowToUse) likely add their own title + ✕ that doubles Google's chrome. Same fix as ManageItems. `mog-modal-ux-sweep` applies.
- **DATA-INTEGRITY CAVEAT — rpr (Roll Play Rosslyn BOH) pars:** may not be set up as true 1-day pars. If so, switching its items between vendors produces wrong order quantities (the multiplier assumes a 1-day par). Sebastian said he'll **manually recalc rpr's pars to true 1-day pars** before relying on multi-vendor there. rprfo (canary) already has correct pars. Quantify/fix rpr before using the switch on it.
- Pack stays single per item (Sebastian's call); SKU left in place but hidden (not scrubbed).
- Older backlog still open: ManageVendors edit-form redesign, parallelize deploy.py, StorageAreas draft-mode UX.

## Files touched (later session)

**Apps Script source:**
- `apps-script/OrderGuideScript.gs` — `COL` (SKU kept @D, `ELIGIBLE_VENDORS`@O), `ELIGIBLE_VENDOR_DELIM`, eligible helpers, `commitUpsertItem`, `commitSwitchActiveVendor` (new), `getAllItemsForView`, `getItemForEdit`, `findItemRow_`, `migrateItemVendorsColumn` (new), menu wiring, `getManageItemsBootstrap` cache key
- `apps-script/ManageItems.html` — eligible checklist, quick-switch, Edit-tab/selector removal + `loadItemIntoEdit` rewrite, legend reword, no-scroll table, tab chips, Add accent, chrome de-dup, dead-code + i18n, client cache key

**Docs:**
- `docs/MOG_SessionHandoff_2026_05_27.md` (this block), `docs/MOG_CurrentState.md`, `CLAUDE.md` (@-import → this file)

**Deployed to:** all 9 clasp targets via `python deploy.py` (bound-sidebar, no `--redeploy`). Canary rprfo first.

## Commits landed (later session)

```
(committed at end of session — feat: ManageItems multi-vendor items + modal declutter; docs: session handoff)
```

## Opening prompt for next session

```
Resume MOG work. Last session (2026-05-27, later block) shipped the ManageItems
multi-vendor redesign + a modal declutter, live on all 9 stores (bound-sidebar
push, no --redeploy). Items can now be orderable from multiple vendors (eligible
list in MASTER_ITEMS column O — a NEW column; SKU in D was left alone because
every vendor tab XLOOKUPs D for its hidden SKU column) with a one-tap "Active
vendor" quick-switch on the View detail (commitSwitchActiveVendor moves the item
to that vendor's tab; par is shared, the vendor's day-multiplier does the rest).
Declutter: removed the Edit tab + vestigial selectors, reworded the legend
(Possible under/over-ordering), no-scroll table, Inactive/Unassigned tab count
chips, green Add panel, and removed the modal's self-added title+X that doubled
Google's chrome.

Top next direction Sebastian approved: sweep the SAME chrome de-dup (remove
self-added title + ✕ that doubles showModalDialog's frame) across the other
modals — OrderHistory first, then check the rest. mog-modal-ux-sweep applies.

CAVEAT to surface immediately: rpr (Rosslyn BOH) pars may NOT be true 1-day
pars — switching its items between vendors would give wrong quantities until
Sebastian manually recalcs them. rprfo (canary) is fine.

Per-store TODO: run Ordering Guide → Mobile API → Migrate Item Vendors on each
sheet when convenient (optional sheet hygiene; feature works without it).

Read docs/MOG_CurrentState.md for invariants. Deploy routing has a deterministic
source of truth: python .claude/skills/mog-deploy-workflow/scripts/route.py
<file>. Canary-first (rprfo for ManageItems work — correct pars).
```

---
---

# Later session — Modal Close/chrome sweep + ManageItems layout + OrderHistory revamp

**Session date:** 2026-05-27
**Session focus:** Continue the modal-chrome de-dup sweep, then a full UX pass — ManageItems table layout fixes and an OrderHistory revamp toward the PWA's format.
**Outcome:** Shipped to all 9 stores via `python deploy.py` (all changes bound-sidebar / client-side — **no `--redeploy`**). Canary rprfo throughout (~8 smoke-test iterations). Verified from the live store sheet that OrderHistory already pulls flat rows from the public `getOrderHistory`/`getOrderHistoryBootstrap`, so the revamp needed **zero** MOGApi.gs change.
**Next session focus:** Either the ManageVendors edit-form redesign (delivery-day picker parity with Add — flagged earlier, needs a walkthrough/possible schema migration), or whatever new UX itch surfaces.

## What shipped

### A — Modal chrome de-dup + Close-button consistency
- **OrderHistory + ManageVendors:** removed the self-added title (and OrderHistory's top `✕`) that doubled Google's `showModalDialog` chrome. **Group A only** — Sebastian's call; the content-header modals (AdminReset/StorageAreas/ReorderPickPath/HowToUse) keep their headings.
- **Footer Close normalized** to a compact bottom-right button in a slim `.modal-footer` (`display:flex; justify-content:flex-end; padding:6px 12px`; button `padding:7px 24px`, grey `#e0e0e0/#333`) on ManageItems, OrderHistory, ManageVendors, StorageAreas — matches HowToUse. AdminReset/ReorderPickPath keep their two-button Close+primary row (correct for save modals).
- **Standing decision:** **rprfo is now the canary** (not rpr) — least dangerous store. Saved to memory (`feedback-canary-target`). The deploy router still prints `--target rpr`; override to rprfo.

### B — ManageItems layout
- **`.shell` `height:100vh` → `100%`** — Apps Script modal iframe fill bug: `100vh` under-resolves in the sandboxed `showModalDialog` iframe, leaving a white gap + squeezed table; `100%` chains correctly from `html,body{height:100%}`. (The 4 content-header modals use `body{height:100vh}` directly and are correct as-is — do NOT switch those to `100%` or the body collapses.)
- Right pane **390→300px**, table cell padding **12→7px**, per-column `max-width`s dropped, modal **`setWidth(1200)→1400`** so all 8 columns (incl PAR REVIEW) show without horizontal cutoff.
- **Header split into its own non-scrolling table** + shared `<colgroup>` (`table-layout:fixed`, % widths) so the **scrollbar starts below the header**; styled 12px scrollbar + matching 12px head gutter keeps the two tables column-aligned. Click-to-sort removed (was on the old single table); the View detail/Add/Edit panes unchanged.
- Secondary "Clear" button color unified to `#e0e0e0/#333`.

### C — OrderHistory revamp (100% client-side)
- **Why no server change (don't re-litigate):** the modal already gets flat rows from public `getOrderHistory(f)` + `getOrderHistoryBootstrap(f)` and does all grouping/aggregation in the browser. The PWA's `api_getHistory_` wraps the same `getOrderHistory`. So this was an `OrderHistory.html`-only rewrite → bound-sidebar push, no `--redeploy`.
- **Recent** → PWA-style: date groups ("Today/Yesterday · date"), vendor **cards** (vendor, order time, item-count badge, `›`), click → **detail drill-down** (items: name + on-hand + qty×pack, `‹ Back`). Card clicks wired via indexed `addEventListener` (robust to vendor names with apostrophes — `esc` doesn't escape `'`).
- **Item History** → per-item **accordion**: collapsible header (item name + Case Pack + order-count badge); expand → Date/Vendor/On Hand/Qty. Item ID dropped, repeated-date column gone, On Hand kept (par tuning). Column sort removed; item search kept; single search result auto-expands.
- **Vendor Summary** → **collapsible**, starts **closed** when filter = All Vendors (`autoOpen = getFilters().vendorFilter!=='ALL'`), auto-opens when filtered to one vendor. **Item ID → Case Pack** column; **Avg On Hand dropped** (+ its ⚠ flag); per-vendor totals row now shows **unique item count** ("TOTAL — Vendor: N items"); bottom desc shows total unique items.
- **Copy → Print:** `printSummary()` → `window.print()` + `@media print` (hides chrome/inactive tabs, force-opens collapsed summary bodies, prints a clean title + date-range header).
- **Card pop-out styling** (white, border, radius, shadow, spacing, hover lift) across Recent cards, Item History groups, Summary blocks.
- **Dead code removed:** `toggleVG`, `exportCurrentTab`, `flashCopy`, `sortItem`, `itemSortCol/Dir`, `.copy-flash` div+CSS, `sort-asc/desc` CSS, `.vendor-group`/`.date-subheader` CSS. i18n: removed `colItemId/sortHint/entries/copied/colAvgOnHand/highAvgTip`, added `today/yesterday/order/orders/colPack` — EN+ES kept at parity.

## Outstanding (carry forward)
- **rpr 1-day-par recalc** before using the active-vendor switch there (carried from earlier; rprfo fine).
- **Per-store Migrate Item Vendors** menu run (optional sheet hygiene; carried).
- **OrderHistory header-split (scrollbar-below-header) NOT applied** — its item/summary tables build headers in JS and the accordion design sidesteps the need. Revisit only if the scrollbar-over-header look bothers anyone.
- **ManageVendors edit-form redesign** still open (delivery-day picker parity with Add; needs walkthrough, maybe schema migration).
- Verification: all canary/fan-out validated by Sebastian on rprfo live URLs; the other 8 not individually smoke-tested (standard for this repo).

## Files touched this chat
**Apps Script source:**
- `apps-script/OrderHistory.html` — full revamp (cards, accordion, collapsible summary, print, card styling, dead-code/i18n cleanup)
- `apps-script/ManageItems.html` — chrome de-dup, footer Close, `100%` fill, right-pane/column tightening, header-split table + colgroup + styled scrollbar, secondary button color
- `apps-script/ManageVendors.html` — chrome de-dup (title removed), `top-bar` justify flex-end, footer Close compact
- `apps-script/StorageAreas.html` — footer Close compact bottom-right
- `apps-script/OrderGuideScript.gs` — `showManageItemsSidebar` width 1200→1400

**Docs:** `docs/MOG_SessionHandoff_2026_05_27.md` (this block), `docs/MOG_CurrentState.md`, `CLAUDE.md` (@-import already on today's file).

**Deployed to:** all 9 clasp targets via `python deploy.py` (bound-sidebar, no `--redeploy`). Canary rprfo first.

## Commits landed this session
```
(committed at end of session — feat: modal Close/chrome sweep + ManageItems layout + OrderHistory revamp)
```

## Opening prompt for next session
```
Resume MOG work. Last session (2026-05-27, third block) shipped a modal UX pass
live on all 9 stores (bound-sidebar, no --redeploy): (1) chrome de-dup + compact
bottom-right footer Close across ManageItems/OrderHistory/ManageVendors/StorageAreas;
(2) ManageItems layout — .shell 100vh→100% fill fix, narrower right pane + tighter
columns + modal width 1400 so all 8 cols show, table header split into its own
table so the scrollbar starts below the header; (3) OrderHistory revamp — Recent
is now PWA-style date-grouped vendor CARDS with click-to-detail, Item History is a
per-item ACCORDION (Item ID dropped, On Hand kept), Vendor Summary is collapsible
(starts closed on All Vendors, Item ID→Case Pack, Avg On Hand dropped, totals show
unique item count), and Copy became Print (window.print + @media print).

CANARY IS NOW rprfo (not rpr) — least dangerous store; the route.py still says rpr,
override it. CAVEAT still standing: rpr pars may not be true 1-day pars — recalc
before using the active-vendor switch there.

Likely next: ManageVendors edit-form redesign (delivery-day picker parity with the
Add form — needs an architectural walkthrough; the mults→delivery mapping isn't
trivially reversible, may need a small schema migration). Read docs/MOG_CurrentState.md
for invariants; deploy routing source of truth is
python .claude/skills/mog-deploy-workflow/scripts/route.py <file>.
```
