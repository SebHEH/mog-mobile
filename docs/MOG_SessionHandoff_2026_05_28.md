# Session Handoff — Five UX/perf/data-tool wins

**Session date:** 2026-05-28
**Session focus:** Convert the StorageAreas modal to draft mode for consistency with Pick Path, then a wide UX/perf pass on the PWA, then build the data-fixer tool rpr has been waiting on.
**Outcome:** Five separate bodies of work shipped — StorageAreas draft mode + bulk save (commit `ed49a62`); PWA transition floor cut ~1.85s → ~900ms (`6f9197f`); api() fetch timeout + offline-path engagement on hung networks + `--r-sm` token tidy (`ba30b8e`); chunked 3-tier Order History (dates → vendors → items) with two new cached server endpoints (`47a1966`); and a new Recalibrate Vendor Pars tool (modal + 2 server fns + menu entry, **uncommitted as of this handoff** but deployed to all 9 stores). rpr now has the tool that unblocks its 1-day-par recalibration; Sebastian will run it per vendor at his pace.
**Next session focus:** ManageVendors edit-form redesign — the delivery-day + lead-day picker parity with Add (still the top open UX inconsistency). Mults→delivery mapping isn't trivially reversible; may need a small schema migration.

---

## Section A — StorageAreas: immediate → draft mode (`ed49a62`)

Converted the optimistic-immediate per-action commits into one bulk save matching Pick Path's pattern.

- Replaced the four granular RPCs (`commitAddStorageArea` / `commitRenameStorageArea` / `commitDeleteStorageArea` / `commitReorderStorageAreas`) + their shared `commitAreaListMutation_` helper with a single `commitStorageAreasDraft(finalList)` in `OrderGuideScript.gs`. Reconciles desired end-state against the sheet in one pass: deletes (current areas not in payload), renames (origName → name where they differ), adds (origName: null entries), reorder (payload order = new badge order). Validates fully before the first write so a rejected payload leaves the sheet untouched.
- **Latent name-swap bug fix as a bonus:** the previous sequential rename could corrupt a swap (A→B, B→A) by processing renames one-at-a-time and rewriting the same pick-DB cell twice. The new map-based remap rewrites each pick-DB row exactly once. Net robustness gain.
- `StorageAreas.html` modal: stripped per-action `google.script.run` calls; doAdd / submitRename / quickDelete / drag-reorder now mutate local state + markDirty. Added `doSave()` (bulk commit), `doClose()` (unsaved-changes guard), and a Save Areas button to the footer. `origName` captured at load gives each area a stable identity handle for the bulk commit; resets to the current name on successful save.
- **Drag-to-reorder REMOVED mid-session per Sebastian's call** — replaced with stacked ▲▼ buttons per row, consistent with Pick Path. Drag-and-drop felt out of place in a modal where every other reorder uses buttons.
- **Footer layout split:** Sebastian wanted Save and Close visually separated (not grouped). Final layout: Close (far left) → save-status (center) → Save Areas (far right) via `justify-content: space-between`.
- inUseCount messaging moved from per-delete to save-result (server only knows after the bulk commit). Confirm dialog on delete kept ("Assigned items will lose their area").
- EN/ES parity held: 14 keys each (`check_i18n_parity.py` PASS).
- **Deploy:** bound-sidebar only, `python deploy.py` (no --redeploy). Canary rprfo first, then fan-out.

## Section B — PWA transition floor cut (`6f9197f`)

`playTransitionAnimation` held a 1100ms minimum + ~750ms outro = ~1.85s on EVERY navigation, even when the wrapped work was a local cache patch finishing in milliseconds.

- `MIN_DURATION_MS` 1100 → 500.
- Outro setTimeout schedule: check 140 → 80, fade-out 480 → 240, resolve 750 → 400.
- Total: ~1.85s → ~900ms. Pulse phase still engages at `MIN_DURATION_MS + 100` (now 600ms instead of 1200ms), so slow-network work still reads as "still working" — just sooner.
- The mark-reviewed celebration animation (`playMarkReviewedAnimation`) is separate and intentionally untouched.
- `CACHE_VERSION` v8 → v9.

## Section C — PWA fetch timeout + radius-token tidy (`ba30b8e`)

`api()` had no timeout — a hung network (captive portal, half-dead cellular that never errors) left the fetch promise pending forever and froze the UI.

- Wrapped fetch in `AbortController` with `API_TIMEOUT_MS = 15000`. Apps Script `/exec` is usually 1-3s and ~10s on a cold start, so 15s leaves headroom while rescuing true hangs.
- Extended `isNetworkError_` to recognize `err.name === 'AbortError'` — a request we abort because the network hung is treated as a network failure, so the existing offline banner + save queue engage exactly as on any other network failure. `flushDirtyToServer`'s offline path (enqueue + "savedOffline" toast) works unchanged.
- `clearTimeout(timeoutId)` on both success and failure paths to prevent in-flight timers firing after a normal completion.
- **`--r-sm` token tidy** bundled in: `:root` defined `--r-md` and `--r-lg` but not `--r-sm`; the latter was used once at line 394 with a 6px fallback. Added `--r-sm: 6px` to complete the design-token scale. Zero visual change.
- `CACHE_VERSION` v9 → v10.

## Section D — Chunked Order History (`47a1966`)

The PWA's Order History tab used to load every date × every vendor × every item-count in a single fetch — felt slow to open. Split into three progressive chunks.

- **New endpoints in `MOGApi.gs`:**
  - `api_getHistoryDates_(payload)` — scans LOG_ORDERS, groups by date, returns `[{date, vendorCount}]`. Small payload.
  - `api_getHistoryVendors_(payload)` — for one date, returns `[{vendor, itemCount, timestamp}]`.
  - Both wrapped in `CacheService` (300s TTL, keyed on `getServerMutationTs_`) so repeat hits within the session skip the LOG_ORDERS scan entirely. Cache invalidates on the same events as the dashboard cache (recap-send / reset).
  - Dispatch wired at MOGApi.gs:168-171.
- **Pre-existing `api_getHistory_` stays** — used by the internal daily-recap auto-send caller. PWA stops calling it.
- **PWA: new `view-history-vendors` view between dates and detail.** `loadHistory` calls `getHistoryDates`; renders date cards with vendor-count badge via new `renderHistoryDates`. Tap a date card → `openHistoryDateCard(date)` shows the new middle view and fetches `getHistoryVendors`. Tap a vendor → `openHistoryDetail` unchanged.
- Caches: `state.cache.historyDates` (the list) + `state.cache.historyVendors[date]` (keyed map). Both invalidate together wherever the old `state.cache.history` was cleared.
- `goBack()` threads through all three layers: history-detail → history-vendors (same date, via `state.historyVendorsContext`), history-vendors → history.
- Two new i18n strings: `vendors` (en: "vendors", es: "proveedores") + the `'history-vendors'` view title.
- `CACHE_VERSION` v10 → v11.
- **Deploy: `python deploy.py --redeploy`** required (new api_* endpoints; PWA hits versioned `/exec` URL). Apps-script deployed first to all 9 (additive — `getHistory` untouched, so deploying backend before pushing PWA was safe), then PWA build + commit + push.

## Section E — Recalibrate Vendor Pars tool (deployed, **uncommitted**)

The standing rpr caveat — "pars aren't true 1-day pars; multi-vendor switching is blocked" — finally has a tool. Three-framing divisor picker + 0.5-rounded ceiling math + live preview.

- **New server fns in `OrderGuideScript.gs`:**
  - `showRecalibrateVendorSidebar()` — launches the modal.
  - `getVendorRecalibrationBootstrap(vendorName)` — returns `{currentMults:[7], items:[{id,name,par}]}`. Items filter: **active AND `useMult === true`** (items that don't use the multiplier have a different par semantic and must not be touched).
  - `commitVendorRecalibration({vendor, newMults, parDivisor})` — atomic: write new mults to vendor row + divide each filtered item's par by divisor. Writes only col G to avoid disturbing other columns. `bumpServerMutationTs_` invalidates the dashboard cache.
- **Rounding: always Math.ceil to nearest 0.5.** Formula: `Math.ceil(par/divisor * 2) / 2`. So 2.33 → 2.5, 2.51 → 3.0, 4.5 → 4.5. Sebastian's call — biases toward slight over-ordering so KMs don't silently under-order during the transition.
- **New modal `RecalibrateVendor.html`** (Mode B i18n, 20 EN/ES keys each):
  - Vendor dropdown → bootstrap loads current mults strip + items table.
  - Delivery-day picker (`computeMultsFromDelivery` / `inferDeliveryFromMults` ported verbatim from ManageVendors). Pre-fills with inferred schedule from current mults.
  - Three divisor framings + custom field, side-by-side:
    - Framing 1 — weekly demand: `7 / sum(currentMults)`. Preserves total weekly orders.
    - Framing 2 — deliveries per week: `count(deliveryDays)`. Sebastian's divide-by-N intuition.
    - Framing 3 — average gap: `7 / count(deliveryDays)`. Mathematical avg gap.
  - Live preview table updates as KM clicks between framings. Items count + per-item old → new par column.
  - Disabled framings (Framing 1 if sumOldMults=0, F2/F3 if no delivery days) render greyed.
- Menu wiring: added "Recalibrate Vendor Pars" under Ordering Guide → 📱 Mobile API submenu (admin tool, not for daily KMs).
- **Operational caveat surfaced in the modal:** "Par is global per item. If this store uses multi-vendor item switching, recalibrate every vendor at this store before re-enabling switching, or order quantities will be off when items are switched." Same discipline as before, now stated where the operator can see it.
- **Deploy:** bound-sidebar only, no --redeploy. Canary rprfo (visual), then deployed to rpr for Sebastian to do live math validation (he chose Framing 3 / custom per vendor based on schedule), then fan-out to all 9.

---

## Outstanding (carry forward)

1. **Run the Recalibrate Vendor tool on rpr's vendors** — Sebastian's own next-step. Tool ships; the actual data fix is operational. Once every rpr vendor is recalibrated, multi-vendor item switching at rpr becomes math-safe (the previously-blocking caveat).
2. **ManageVendors edit-form redesign** — top remaining UX inconsistency. Edit Vendor still shows raw multipliers; Add Vendor uses the delivery-day + lead-day picker. Mults → delivery isn't trivially reversible (multiple schedules can produce the same mults). Possible schema migration: store `deliveryDays[]` + `leadDays` as columns, compute mults at save. Needs walkthrough.
3. **Parallelize `deploy.py`** — still deferred ("30s isn't hurting").
4. **Pre-existing `api_getHistory_` could be removed** — only the internal daily-recap auto-send still calls it. If that path is also migrated to the new chunked endpoints, getHistory could go. Low-priority cleanup.

**Manual per-store TODO** (carried from prior sessions, still open):
- Run Mobile API → Migrate Item Vendors on each sheet (optional sheet hygiene; feature works without it).

**Standing caveats** still in force:
- Canary is **rprfo** (not rpr).
- Master-Ordering-Guide repo decommission deadline ~2026-05-31 (today is 28th).

---

## Files touched this chat

**Apps Script source:**
- `apps-script/OrderGuideScript.gs` — `commitStorageAreasDraft` (replaces 4 fns + helper); `showRecalibrateVendorSidebar` + `getVendorRecalibrationBootstrap` + `commitVendorRecalibration`; menu wiring update
- `apps-script/StorageAreas.html` — draft-mode rewrite, ▲▼ buttons, split footer
- `apps-script/RecalibrateVendor.html` — NEW modal (3-framing divisor + ceil-to-0.5 preview)
- `apps-script/MOGApi.gs` — `api_getHistoryDates_` + `api_getHistoryVendors_` + dispatch wiring

**PWA source:**
- `template/index.html` — playTransitionAnimation cut; api() AbortController + isNetworkError_ AbortError; --r-sm token; chunked History tier (new view container + render fns + caches + goBack arms)
- `template/sw.js` — `CACHE_VERSION` v8 → v9 → v10 → v11 across the day's three PWA-touching commits

**Docs:**
- `docs/MOG_CurrentState.md` (updated below)
- `docs/MOG_SessionHandoff_2026_05_28.md` (this file)
- `CLAUDE.md` (@-import line updated to this file)

**Generated (build.py output, do not hand-edit):**
- All 8 `<slug>/` dirs refreshed three times across the day's PWA commits

**Deployed to:**
- StorageAreas + Recalibrate Vendor (bound-sidebar): all 9 clasp targets via `python deploy.py`
- Chunked History backend (api_*): all 9 via `python deploy.py --redeploy`
- PWA layer (transition cut, fetch timeout, history UI): GitHub Pages via `python build.py` + `git push`

---

## Commits landed this session

```
47a1966 feat(history): chunked 3-tier load (dates -> vendors -> items)
ba30b8e fix(pwa): timeout hung api() requests + complete radius token
6f9197f perf(pwa): halve transition animation floor (1.85s -> 900ms)
ed49a62 feat(storage-areas): convert modal to draft mode with bulk save
```

Plus a fifth commit pending — the Recalibrate Vendor Pars tool (uncommitted as of writing this handoff; deployed to all 9 stores already).

---

## Opening prompt for next session

```
Resume MOG work. Yesterday (2026-05-28) shipped five separate things, all live
on every store:

  1. StorageAreas modal: immediate -> draft (commit ed49a62). Bulk save via
     commitStorageAreasDraft; drag-to-reorder replaced with stacked up/down
     buttons; Close + Save Areas split to opposite footer ends.
  2. PWA transition floor: 1.85s -> 900ms (6f9197f). MIN_DURATION_MS 1100->500
     + outro tightened. Pulse phase still engages for slow-network work.
  3. PWA fetch timeout (ba30b8e): AbortController + 15s in api(); isNetworkError_
     recognizes AbortError so hung requests fall into the offline queue. Bundled
     the --r-sm radius token tidy.
  4. Chunked Order History (47a1966): three tiers (dates -> vendors -> items),
     two new CacheService-backed server endpoints. PWA stops calling getHistory;
     state.cache.historyDates + historyVendors[date] cache the chunks locally.
  5. Recalibrate Vendor Pars tool (pending commit — but deployed via
     python deploy.py to all 9 stores). New modal at Ordering Guide -> Mobile
     API -> Recalibrate Vendor Pars. Three divisor framings (weekly-demand,
     deliveries-per-week, avg-gap) + custom; ceil-to-nearest-0.5 rounding;
     filters to items active for this vendor that use a multiplier.

CACHE_VERSION journey across the PWA commits: v8 -> v9 -> v10 -> v11.

Top next direction: ManageVendors edit-form redesign — Edit Vendor still shows
raw mults; Add Vendor uses the delivery-day + lead-day picker. Mults->delivery
isn't trivially reversible; needs a walkthrough and possibly a small schema
migration storing deliveryDays[] + leadDays as columns. This is the standing
top-of-backlog UX inconsistency now that everything else moved.

Operational TODO Sebastian owns:
  - Run the new Recalibrate Vendor tool on each rpr vendor at his pace. Once
    all rpr vendors are recalibrated, multi-vendor item switching at rpr
    becomes math-safe (the previously-blocking caveat is lifted).
  - Run Mobile API -> Migrate Item Vendors per sheet when convenient (existing
    optional hygiene step).

CANARY IS rprfo (route.py still prints rpr — override).
Read docs/MOG_CurrentState.md for invariants. Deploy routing source of truth:
python .claude/skills/mog-deploy-workflow/scripts/route.py <file>.
```
