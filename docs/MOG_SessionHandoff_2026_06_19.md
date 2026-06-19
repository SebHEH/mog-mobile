# Session Handoff — Reset-fix + brand logos + codebase audit & cleanup

**Session date:** 2026-06-19
**Session focus:** Fix KMs getting stuck on the reset screen; wire the new brand SVG logos onto the PWA splash; then audit the whole codebase and clear the cheap debt before expanding into a KM-editor feature.
**Outcome:** Three bodies of work shipped (4 commits, all pushed; backend cleanup fanned out to all 9 + master). A full two-layer audit found the codebase clean — only quick wins, fixed this session. The KM-editor feature is **scoped and parked** (decisions locked) behind a god-object split.
**Next session focus:** Split the `OrderGuideScript.gs` god-object (#4) + consolidate new-day detection (#5) — walkthrough first — then start the parked KM-editor feature.

---

## Section A — PWA auto-reset no longer strands KMs (`cdc13f2`)

**Symptom:** some KMs got stuck on the "Reset On Hand" screen, even though a new day is supposed to auto-reset. **Root cause:** the new-day auto-reset called `commitReset` under the default 15s API timeout, but `commitReset` is the heaviest call in the app (logs On Hand → LOG_ORDERS, clears columns, sends the recap email synchronously, stamps AE9). On a cold `/exec` it ran past 15s → the fetch aborted → the client treated it as failure and stranded the KM on the manual screen — **even though Apps Script finished the reset server-side** (it doesn't stop when the client aborts).

**Fix (`template/index.html`):**
- `api(action, payload, timeoutMs)` gained an optional per-call timeout; `commitReset` now uses `RESET_TIMEOUT_MS = 45000`.
- `runStaleReset_` now **re-polls `getResetStatus` on any failure** — if the day is no longer stale (the server completed despite the client abort), it enters the home screen via the new shared `finishResetAndEnterApp_()` instead of stranding. Manual fallback only shows on genuine offline.
- CACHE_VERSION v16 → v17. PWA-only (build.py + push), no clasp.

## Section B — Brand SVG logos on the PIN/splash screens (`e805147`, `dab9b51`)

The new Canva lockups (single-color black SVGs) now render on the PIN + stale-reset screens, recolored per concept via `currentColor`. Pattern: both SVGs sit in the DOM on every store; CSS `[data-theme="…"]` rules show the matching one and hide the default clipboard square.

- **Live now:** RP → `rp-stacked` in basil (`--teal-dark` #2d8c6b); TNY → `tny-horizontal` (the clean lockup, no coffee~teas~snacks tagline) in charcoal (`--text`).
- **Wired ahead of launch (dormant):** ĂN → `an-stacked` in HEH house green (`--teal`, auto-recolors when ĂN's palette lands); Lei'd → `leid-horizontal` (only variant on disk) in magenta (`--teal-dark`). Their `[data-theme="an"]/["leid"]` rules **only fire when a store ships that theme** — no store does yet, so nothing changed for live stores.
- Removed the dead `.rp-outer`/`.rp-inner` two-tone CSS (new marks are single-color). CACHE v17 → v18 → v19. PWA-only.
- Source SVGs: `heh-brand-kit/assets/logos/{rp,tny,an,leid}/`. The brand-kit tokens doc already lists them as on-disk.

## Section C — Codebase audit + quick-win cleanup (`c9023ab`)

Two-layer audit (Apps Script backend via `appsscript-codebase-audit`; PWA via `mog-pwa-audit`). **Verdict: clean** — no perf debt, no constant drift, no shell-hygiene issues; RPC fan-out already consolidated; the Rhino "violations" are non-findings (modals are browser-side ES6 by invariant #4). Findings were one cosmetic bug + a dead-code sweep, all fixed this session.

**Backend (pure deletions, 181 lines; `OrderGuideScript.gs` 5669 → 5497, `MOGApi.gs` 2149 → 2141):** removed `commitUpdateVendorMults` + `commitUpdateVendorCutoff` (superseded by the consolidated `commitUpdateVendorMultsAndCutoff`), the empty `menuHeader_`, the orphaned `reestablishVendorTemplateMenu_` wrapper, `hasLogEntryForDate_`, `getItemsByVendor`, and `generateReference_`. Kept `reestablishVendorTemplate_` (editor-run worker) and the consolidated vendor fn. Deployed to **all 9 + master via `deploy.py --redeploy`** — canary rpfrf smoke-tested first (Manage Vendors edit/save + menu both confirmed).

**PWA (`template/index.html`):** added the missing `recap` key to `T.titles` (the "Full order list" screen had a blank topbar); pointed the in-screen `back-count-btn` at `reopenCountFromContext_()` to match the breadcrumb + back button (avoids an offline stale-cache count revert); dropped dead `result.cancelled` branches (`sendDailyRecap` never returns that field) and a spent migration `console.log`. CACHE v19 → v20.

---

## Outstanding (carry forward)

- **VERIFY-then-delete dead-code candidates** (LOW). Left in place this session because they have zero code callers but may be assigned to **dashboard buttons** (invisible to a grep): `showAdminResetSidebar` (if dead, the AdminReset modal is unreachable — worth confirming how it opens today), `goToOrderEntry`, `toggleMasterItemsTabVisibility`, `toggleOrderLogVisibility`, `toggleSetupTabVisibility`. Next session: check the Sheet's dashboard buttons → delete the unwired ones.
- **#4 — Split `OrderGuideScript.gs` god-object (5,497 lines)** (HIGH effort). Already-mapped 7-file seam (Core / Vendors / Items / PickPath / ResetLog / History / Dashboard) in CurrentState. All `.gs` share one global scope → runtime-safe; `deploy.py` pushes all files. **Architectural-walkthrough first, own session, canary rpfrf (or rprfo).**
- **#5 — Consolidate new-day detection** (MED). The AE2 (today) vs AE9 (last reset) read-and-compare is reimplemented in ~5 sites across `MOGApi.gs` + `OrderGuideScript.gs` — extract one helper. Rides along with #4 (touches both files).
- **PARKED — KM-editor feature** (the bigger arc, after #4/#5). Goal: let KMs make edits more easily than opening the Google Sheet. **Decisions locked this session:** (1) **computer-only** — gate editing off on phones (PWA = ordering only; editor pages show "use a computer"); (2) **PIN-gated**. **Recommended path (Sebastian leaned rebuild, but computer-only flips the math toward reuse):** progressive Option A — route `doGet?page=items` to serve the existing desktop-sized modals (they already run browser-side via `google.script.run`), wrapped in a thin shared shell, linked from the PWA; rebuild individual editors into that shell later and retire the Sheet menu over time. **New scaffolding needed:** `doGet` page-routing (today `doGet` returns JSON only), a **PIN gate for web-app HTML pages** (distinct from the `doPost` JSON PIN check), and the device gate. Prototype **Manage Items** on canary first. Reference: MVS/MPS both serve an HtmlService SPA at `/exec` via `doGet` + `google.script.run` (`ANYONE_ANONYMOUS`, no PIN) — MOG can do the same at its existing `/exec` (the GitHub Pages hosting is just the PWA client; it doesn't block serving HTML from doGet).
- **Tooling (not MOG):** `appsscript-codebase-audit`'s scanner crashes on Windows cp1252 when a source line has a non-ASCII char (e.g. `→`). Re-run with `PYTHONUTF8=1`. Fix via `checker-script-sync`.

## Files touched this chat

- **PWA source:** `template/index.html` (reset fix, 4 logos + CSS, recap title, back-count, dead-code), `template/sw.js` (CACHE v16 → v20).
- **Backend source:** `apps-script/OrderGuideScript.gs`, `apps-script/MOGApi.gs` (dead-code removal).
- **Generated (build.py refresh):** all 8 `<slug>/` dirs.
- **Deploys:** `deploy.py --redeploy` to all 9 + master (backend cleanup); GitHub Pages pushes (PWA, ×4 commits).

## Commits landed this session

```
c9023ab chore: audit cleanup — remove dead code, fix recap title + back-to-count
dab9b51 feat(pwa): wire ĂN + Lei'd splash logos ahead of launch
e805147 feat(pwa): real RP + TNY brand logos on the PIN/splash screens
cdc13f2 fix(pwa): auto-reset no longer strands KMs on the reset screen
```

## Opening prompt for next session

```
Read docs/MOG_CurrentState.md first. Last session shipped the auto-reset
stranding fix, the RP/TNY splash logos (+ ĂN/Lei'd wired dormant), and a
two-layer codebase audit whose quick wins are all fixed and deployed.

Next up is the deferred #4 + #5: split the OrderGuideScript.gs god-object
(now 5,497 lines; 7-file seam already mapped in CurrentState) and extract the
duplicated new-day-detection (AE2/AE9) helper that rides along — architectural
walkthrough FIRST, own session, canary rpfrf. Quick side-task: verify whether
showAdminResetSidebar / goToOrderEntry / the three toggle*Visibility fns are
dashboard-button-assigned, then delete the unwired ones (audit left them in).

After #4/#5, the parked KM-editor feature is next (decisions locked: computer-only
+ PIN-gated; recommended progressive Option A — serve the existing modals via
doGet?page=…, PIN-gate them, gate editing off on phones, rebuild incrementally).
```

---
---

# Later session — God-object split (#4) + new-day-detection dedup (#5)

**Session focus:** Execute the deferred #4 + #5 — split `OrderGuideScript.gs` along the mapped 7-file seam and extract the duplicated AE2/AE9 new-day logic — architectural walkthrough first, canary rpfrf.
**Outcome:** Both shipped (3 commits) and deployed to all 9 + master via `deploy.py --redeploy`; canary rpfrf smoke-tested (menu, all modals, dashboard rebuild, reset, order history — all confirmed by Sebastian). Candidate **#1 and #5 are now DONE.**
**Next session focus:** Start the PARKED **KM-editor feature** (decisions locked — computer-only + PIN-gated; progressive Option A via `doGet?page=…`).

## What shipped (later session)

**(A) Split `OrderGuideScript.gs` god-object → Core + 6 files (`38382db`).** Pure code-motion, zero logic change. The 5,497-line file became **`Core.gs`** (global constants, generic helpers, menu/`onOpen`/`onEdit`/triggers, generic sidebar openers, order-cycle date helpers) + **`Vendors.gs`** / **`Items.gs`** / **`PickPath.gs`** / **`ResetLog.gs`** / **`History.gs`** / **`Dashboard.gs`**. Done with a **deterministic Python slicer** (in scratchpad) that partitions the file by top-level declaration, routes each chunk by name, and **verifies byte-exact reassembly + 144/144 declaration parity** before writing — so the move couldn't silently drop or duplicate code. Design hinge: the *only* top-level cross-references in the file are inside the global-constants block, so **keeping all constants in Core means zero cross-file top-level dependency → load order is irrelevant** (no `filePushOrder` / `deploy.py` change needed). The 2-file project (OrderGuide + MOGApi) already proved multi-file global-scope sharing works; this just extends it to 8. Verified: `node --check` clean on all 7, zero duplicate symbols across all 8 `.gs` (144 + 74 MOGApi = 218). Renamed `OrderGuideScript.gs` → `Core.gs` (clasp `push -f` handles the rename atomically; functions are global regardless of filename).

**(B) Dedup new-day detection into Core helpers (`a771767`).** The AE2(today)/AE9(last-reset) read-and-compare was reimplemented in 4 places. Extracted two canonical helpers in `Core.gs`: **`getActiveOrderDate_()`** → `{date, dateStr, dayOfWeek}` (AE9, else AE2, else now) and **`getResetStaleness_()`** → `{today, lastReset, isStale}`. Rewired: `api_getResetStatus_` (MOGApi) delegates; `getActiveOrderDate_` **removed from MOGApi** (now Core, still globally callable); `dailyResetOnOpen_` (Core) uses `getResetStaleness_().isStale`; `getLogOrderDate_` (ResetLog) returns `getActiveOrderDate_().dateStr`. **Timezone standardized on `getSpreadsheetTimeZone()`** (the two old paths split between Session-TZ and spreadsheet-TZ; all stores are US/Eastern so this is a no-op in practice, matching the `AE2 =TODAY()` frame). Net −8 lines.

**(C) Doc/skill/comment reference updates (`15ec141`).** Repointed every live reference off the deleted `OrderGuideScript.gs`: `CLAUDE.md` + `README.md` + `apps-script/README.md` file inventories, the "all `.gs` peers" architecture note in `MOG_CurrentState.md`, and the two pattern skills (`mog-rpc-consolidation`, `mog-apps-script-caching`) whose canonical-example pointers named the old file — also retired a stale `commitAreaListMutation_` example (that fn was removed sessions ago) in favor of `commitStorageAreasDraft`. Fixed 8 inline cross-file pointer comments in `MOGApi.gs`/`Core.gs` (`dashTheme_` → Dashboard.gs, `VENDOR_CUTOFF_COL` → Core.gs, etc.); comment-only, synced to all targets push-only. `route.py` needed no change (its generic `.gs` branch already routes the new files). The 6 `* Split out of OrderGuideScript.gs` provenance banners are kept as accurate history.

## Outstanding (carry forward — later session)

- **PARKED → now NEXT: the KM-editor feature.** Decisions locked (computer-only + PIN-gated; progressive Option A — route `doGet?page=…` to serve the existing desktop modals, PIN-gate them, gate editing off on phones, rebuild incrementally). **New scaffolding needed:** `doGet` page-routing (today `doGet` returns JSON only — lives in `MOGApi.gs`), a **PIN gate for web-app HTML pages** (distinct from the `doPost` JSON PIN check), and the device gate. Architectural-walkthrough first; prototype **Manage Items** on canary. The split makes this cleaner — `Items.gs` is now an isolable module.
- **Dead-code side-task still open** (Sebastian, in the Sheet): right-click each dashboard button → *Assign script*, note which of `showAdminResetSidebar` / `goToOrderEntry` / `toggleSetupTabVisibility` / `toggleMasterItemsTabVisibility` / `toggleOrderLogVisibility` are button-bound; delete the unwired ones next pass. `showAdminResetSidebar` is the one to watch (AdminReset isn't in the quick-actions, so a button is likely its only entry point). They now live in `ResetLog.gs` (AdminReset) / `Core.gs` (goToOrderEntry) / `PickPath.gs` (the 3 toggles).

## Commits landed (later session)

```
15ec141 docs: update file references for the OrderGuideScript.gs split
a771767 refactor(apps-script): dedup new-day detection into Core helpers (#5)
38382db refactor(apps-script): split OrderGuideScript.gs god-object into Core + 6 files
```

## Opening prompt for next session

```
Read docs/MOG_CurrentState.md first. The OrderGuideScript.gs god-object is now
split into Core.gs + 6 domain modules (Vendors/Items/PickPath/ResetLog/History/
Dashboard), and the AE2/AE9 new-day logic is deduped into Core's
getActiveOrderDate_/getResetStaleness_ — both shipped to all 9 + master.

Next up is the PARKED KM-editor feature: let KMs edit more easily than opening the
Google Sheet. Decisions are locked — computer-only (gate editing off on phones) +
PIN-gated; progressive Option A: route doGet?page=items to serve the existing
desktop modals (they already run browser-side via google.script.run), PIN-gate the
HTML pages, rebuild editors into a shared shell over time. New scaffolding: doGet
page-routing (today doGet is JSON-only, in MOGApi.gs), a PIN gate for web-app HTML
pages (separate from the doPost JSON PIN check), and a device gate. Architectural
walkthrough FIRST, prototype Manage Items on canary rpfrf. Reference: MVS/MPS both
serve an HtmlService SPA at /exec via doGet + google.script.run.

Side-task still open: confirm which of showAdminResetSidebar / goToOrderEntry /
the 3 toggle*Visibility fns are dashboard-button-assigned (Sheet-side, invisible
to grep), then delete the unwired ones.
```
