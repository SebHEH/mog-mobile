# MOG — Current Project State

The running snapshot of where this codebase is *right now*. Updated at the end of every session that ships material changes. Future Claude reads this on session start (via `CLAUDE.md` @-import) and uses it to orient before touching anything.

If this doc and `CLAUDE.md` conflict on a specific fact, `CLAUDE.md` wins for structure / invariants; this doc wins for "what's currently in flight."

---

## Pinned focus

**Two shipped + #4 scoped (2026-05-29, later session).** All deployed to 9 via clasp; **commits PENDING (Sebastian owns the commit).**

- **(A) ManageVendors multiplier→delivery clarity** (`ManageVendors.html`, bound-sidebar) — per-cell "→ <delivery day>" arrows under each active multiplier (Add + Edit) + a worked-example callout at the top of the Edit form (EN/ES). Latent fix: `setLang` never re-rendered the vendor cards, so the EN/ES toggle left card chrome in the build-time language → added `rerenderVendorCards_()`. i18n parity 26/26.
- **(B) Dashboard per-store branding** (`MOGApi.gs` + `OrderGuideScript.gs`, `--redeploy`) — `buildHomeBanner_` was hardcoded `"ORDERING GUIDE · ROSSLYN"` (every rebuild stamped ROSSLYN); now reads `MOG_LOCATION_NAME`. New `MOG_CONCEPT` property drives the accent via `CONCEPT_THEMES` + memoized `dashTheme_()` (RP teal-dark `#2d8c6b`/white, TNY charcoal `#1a1a1a`/gold `#D4A574`; unset→navy). Set via `setStoreConcept()` + extended `setupMobileApi()`. rprfo + tnyt verified; **Sebastian to set concept + rebuild dashboard on the other 6** (RP: rpr/rpt/rptfo/rpfr/rpfrf; TNY: tnytf).
- **(C) #4 (vendor-tab redesign) scoped + de-risked.** Read-only `auditVendorTabStructure()` shipped to all 9 (Mobile API menu). **Finding: VENDOR_TEMPLATE was DELETED on rprfo** — add-vendor *copies* it (doesn't recreate) and falls back to `ss.getSheets()[3]` when missing (fragile; ⚠ don't Add Vendor on a template-missing store). The uploaded xlsx is STALE vs live — trust the **live** VENDOR_TEMPLATE. Order block (I–L) is human-facing only (recap/log build from A/B/E/F/M); N–T are a dead zone (Q–T = unreferenced duplicate of A–D).

**#4 build is next session:** (A) re-establish a canonical hidden VENDOR_TEMPLATE per store; (B) harden add-vendor to fail-safe; (C) dead-column strip (clear `Q3:T3`, hide `N:T`) + concept header branding in template + all tabs; (D) `migrateVendorTabs()` — idempotent/defensive/On-Hand-safe. Gate: run the audit on all 9 + a `mog-sheet-formula-verify` pass. Canary rprfo.

**Parked:** #2 assign-after-reset bug (model confirmed: live spill keyed on M, On Hand E position-pinned; couldn't reproduce — watch for recurrence; latent `commitUpsertItem` silent-swallow of area-assign failures worth fixing). PWA-slower-than-Sheet = architectural (`/exec` cold-start + re-auth vs warm in-Sheet), no action.

### Prior session pinned focus (carried for context)

**Earlier 2026-05-29:** Vendor Cadence Audit sidebar (`9b4c027`) + PWA decimal On Hand (`daf354f`, CACHE_VERSION v11→v12). The ManageVendors Edit-form **"Advanced" disclosure** stays deferred (gated on cadence-audit cleanup): Gate 1 = hide raw mults grid behind "Advanced" toggle; Gate 2 = **NO** lead-day picker; Gate 3 = **NO** schema migration.

**2026-05-28:** Five wins (StorageAreas draft mode `ed49a62`, PWA transition-floor cut `6f9197f`, PWA fetch timeout `ba30b8e`, chunked Order History `47a1966`, Recalibrate Vendor Pars tool) — all live; `CACHE_VERSION` v8→v11. See the Recent-changes table below + handoffs for detail. *Recalibrate Vendor still to be run per-vendor at rpr at Sebastian's pace.*

### Next-session candidates (impact-ranked)

1. **#4 vendor-tab redesign + migration** (MEDIUM, **next-session main event**). (A) re-establish a canonical hidden VENDOR_TEMPLATE per store from a healthy tab; (B) harden add-vendor's `ss.getSheets()[3]` fallback to fail-safe when the template is missing; (C) dead-column strip (clear `Q3:T3`, hide `N:T`) + concept header branding in template + all tabs; (D) `migrateVendorTabs()` — idempotent, defensive (per-tab structure check), On-Hand-safe. **Gate:** run `auditVendorTabStructure()` (already deployed) on all 9 + a `mog-sheet-formula-verify` pass. Scope/anatomy fully mapped this session; the order block (I–L) is human-facing only and N–T are dead. Canary rprfo.
2. **`commitUpsertItem` silent-swallow fix** (LOW, safe). Area-assignment failures are caught + logged + return `ok:true`, so the item silently vanishes. Surface the error instead.
3. **ManageVendors Edit-form "Advanced" disclosure** (MEDIUM). Hide the raw mults grid behind an Advanced toggle so the delivery-day picker is THE input. **Gated on Sebastian running Vendor Cadence Audit across all 9 + recalibrating flagged vendors** — silent-rewrite-on-save risk. Walkthrough done.
4. **Parallelize `deploy.py`** (LOW). Deprioritized ("30s isn't hurting"). `ThreadPoolExecutor` + per-target temp dirs. Glance at `route.py` first.
5. **Reconcile the Rhino-ES5 invariant** (HOUSEKEEPING). CLAUDE.md invariant #4 says modals are Rhino/ES5, but they render in the browser and several modals already use ES6 `const` in production. Update invariant #4 + the `rhino-safe-html` skill.
6. **Retire `api_getHistory_`** (LOW). Only the internal daily-recap auto-send still calls it.

*(Done this later session: ManageVendors multiplier clarity + Dashboard branding shipped to all 9 (commits pending); #4 scoped with `auditVendorTabStructure()` deployed; #2 parked. Operational follow-ups: set concept + rebuild dashboard on the other 6 stores; run the structure audit on the other 8 stores.)*

---

## Standing invariants (carry forward)

Duplicated from `CLAUDE.md` so this doc reads standalone:

1. Never edit generated `<slug>/` dirs — overwritten by `build.py`.
2. Never edit code in the Apps Script editor — overwritten by `deploy.py`.
3. `.gs` files are identical across all 9 deploy targets; per-store config lives in spreadsheet data.
4. Apps Script HTML modals run in Rhino (ES5) — no arrow fn / `let` / `const` / template literals.
5. `template/index.html` placeholders (`__MOG_API_URL__`, `__MOG_THEME__`, `__MOG_APPLE_TOUCH_ICON__`) appear exactly once each; never replace by hand.
6. `STORE_REGISTRY` line in root `index.html` is build-injected; edit `stores.json` instead.
7. Bump `CACHE_VERSION` when shipping shell changes so KMs' phones evict stale caches.
8. Slugs in `stores.json` are immutable once published (bookmark/home-screen breakage).

---

## Deploy targets (apps-script/.clasp-targets.json)

9 targets total. Code is identical across all of them; `appsscript.json` manifest is unified to rpr's (which explicitly declares OAuth scopes).

Each non-template target has two identifiers committed to git: `scriptId` (for `clasp push` — source) and `deploymentId` (for `clasp deploy --deploymentId` — bumping the web-app `/exec` URL the PWA hits). `_template` has no `deploymentId` because it isn't published as a web app.

| Slug | Store | Notes |
|---|---|---|
| `_template` | Master template | Copied to seed new stores. Push keeps it current. No web-app deployment. |
| `rpr` | Roll Play - Rosslyn BOH | Canary target — first to receive new deploys for smoke testing. |
| `rprfo` | Roll Play - Rosslyn FOH | |
| `rpt` | Roll Play - Tysons BOH | |
| `rptfo` | Roll Play - Tysons FOH | Added 2026-05-24. |
| `rpfr` | Roll Play - Founders BOH | |
| `rpfrf` | Roll Play - Founders FOH | Added 2026-05-24. |
| `tnyt` | Teas'n You - Tysons BOH | |
| `tnytf` | Teas'n You - Tysons FOH | |

**Deploy commands from repo root:**

| Goal | Command |
|---|---|
| Push (bound-sidebar-only change) | `python deploy.py` |
| Push + redeploy web-app URL (MOGApi.gs / any `api_*` change) | `python deploy.py --redeploy` |
| Push + redeploy with a tag | `python deploy.py --redeploy --description "<msg>"` |
| Single target | `python deploy.py --target <slug>` (combine with `--redeploy` if needed) |
| Dry run | `python deploy.py --dry-run` (combine with `--redeploy` to preview the redeploy step too) |
| Discover deploymentIds (one-time per fresh checkout if `.clasp-targets.json` has `FILL_ME_IN`) | `python deploy.py --discover` |

**Push vs redeploy — when to use which:**
- *Bound sidebars* (ManageVendors, ManageItems, OrderHistory, etc.) read HEAD inside the Sheet. Push is enough.
- *PWA* hits each Sheet's `/exec` URL, which serves a versioned snapshot. MOGApi.gs changes need `--redeploy` or the PWA stays on old code.
- When unsure: `--redeploy`. Extra cost is ~3s per target.

---

## Live stores (stores.json)

8 entries — the master template isn't published to the PWA hub (it has no deployment URL because it isn't deployed as a web app).

| Slug | URL | Concept | Location |
|---|---|---|---|
| `rpr` | `sebheh.github.io/mog-mobile/rpr/` | Roll Play | Rosslyn BOH |
| `rprfo` | `.../rprfo/` | Roll Play | Rosslyn FOH |
| `rpt` | `.../rpt/` | Roll Play | Tysons BOH |
| `rptfo` | `.../rptfo/` | Roll Play | Tysons FOH |
| `rpfr` | `.../rpfr/` | Roll Play | Founders BOH |
| `rpfrf` | `.../rpfrf/` | Roll Play | Founders FOH |
| `tnyt` | `.../tnyt/` | Teas'n You | Tysons BOH |
| `tnytf` | `.../tnytf/` | Teas'n You | Tysons FOH |

Hub URL: `https://sebheh.github.io/mog-mobile/` — concept picker with auto-redirect on return visits.

---

## Open issues / risks

- **Master-Ordering-Guide repo still exists** at `github.com/SebHEH/Master-Ordering-Guide` and locally at `C:\Users\RAD-SEB\Documents\GitHub\Master-Ordering-Guide\`. Scheduled for deletion ~2026-05-31. Risk: someone (or future-Claude) opens a session from the old dir and edits stale files, splitting the source-of-truth again. Mitigation: when Sebastian opens a Claude Code session, confirm `cwd` is `mog-mobile`, not `Master-Ordering-Guide`.
- **No CI** — the only verification of a deploy is Sebastian opening the live URL. Workable for a 1-operator setup but means PRs from anyone else would have no safety net. Not urgent.
- **`python3` shim hijack on Windows** — the Microsoft Store stub intercepts `python3`. Use `python` or `py` instead. `build.py`'s shebang `#!/usr/bin/env python3` only matters on Unix.
- **PowerShell PATH staleness post-install.** After a `winget install`, in-session shells don't pick up new tools until PATH is refreshed from registry. The convention in `CLAUDE.md` covers this.

---

## Architecture notes worth remembering

- **Two separate `CACHE_VERSION` constants** — one in `sw.js` (hub) and one in `template/sw.js` (per-store). They move independently. Bump only the one whose shell actually changed.
- **`build.py` is idempotent and zero-arg.** Running it without changes is a no-op. `--dry-run` previews without writing.
- **`deploy.py` writes a temporary `apps-script/.clasp.json` per target, runs `clasp push -f` from inside `apps-script/`, then cleans up.** `.clasp.json` is gitignored. Don't try to maintain a permanent one — the deploy script owns that file. Discovery mode (`--discover`) uses the same temp-file pattern.
- **Source push and web-app redeploy are separate phases.** `clasp push` updates the script project (which bound sidebars read from HEAD). `clasp deploy --deploymentId <id>` bumps the version that the `/exec` URL the PWA hits actually serves. `deploy.py --redeploy` does both; the default does just push.
- **`deploy.py` is Python stdlib-only (no `pip install` step), zero-dep, cross-platform.** Replaced the earlier PowerShell pair (`deploy.ps1` + `discover-deployments.ps1`) on 2026-05-26 to match `build.py`'s placement and pattern and to drop the Windows-only ExecutionPolicy requirement.
- **The 6 store-bound HTML modal files (AdminReset, ManageItems, ManageVendors, OrderHistory, ReorderPickPath, StorageAreas, HowToUse) plus the 2 `.gs` files are all `apps-script/` peers.** No subdirectory structure inside `apps-script/`. Clasp's default file picker handles this fine.
- **`apps-script/.clasp-targets.json` is committed to git** with real Script IDs. Script IDs are project identifiers, not secrets — pushing still requires OAuth (`clasp login`) on the user's side. Committing makes the deploy workflow portable to a fresh machine.
- **The `STORE_REGISTRY` build-injection marker** in root `index.html` is the line containing `// __STORE_REGISTRY__ build-injected`. Exactly one such line; `build.py` fails loud otherwise.
- **rpr's `appsscript.json` was chosen as canonical** during 2026-05-24 reconciliation because it explicitly declared OAuth scopes (the other 5 stores had implicit/auto-detected scopes). The canonical manifest is now applied to all 9 targets.

---

## Recent significant changes

Most recent first. Trim entries older than ~5 sessions when this list gets unwieldy.

| Date | Session | Outcome |
|---|---|---|
| 2026-05-29 (latest) | Manage Vendors clarity + Dashboard branding + #4 scope | **Two features shipped to all 9 (deployed via clasp; commits PENDING — Sebastian owns the commit). (A) Manage Vendors multiplier→delivery clarity** (`ManageVendors.html`, bound-sidebar): per-cell "→ <day>" arrows under each active multiplier (Add+Edit; `updateMultFeeds_` folded into `styleMultInput` + `data-day` attr), a worked-example callout at the top of the Edit form (`multExample` key, EN/ES, Mon/Thu/Sat case), and a latent fix — `setLang` never re-rendered the vendor cards so the EN/ES toggle left card chrome in the build-time language → added `rerenderVendorCards_()`. Parity 26/26. **(B) Dashboard per-store branding** (`MOGApi.gs` + `OrderGuideScript.gs`, `--redeploy`): `buildHomeBanner_` was hardcoded "ORDERING GUIDE · ROSSLYN" (every rebuild stamped ROSSLYN) → now reads `MOG_LOCATION_NAME`; new `MOG_CONCEPT` property drives the accent via `CONCEPT_THEMES` + memoized `dashTheme_()` (RP teal-dark `#2d8c6b`/white, TNY charcoal `#1a1a1a`/gold `#D4A574`; unset→navy) on banner + tiles + reset strip; set via new `setStoreConcept()` + extended 6-step `setupMobileApi()`. Canary rprfo (RP) + tnyt (TNY) verified; **6 stores still need concept+rebuild**. **(C) #4 vendor-tab redesign scoped:** read-only `auditVendorTabStructure()` deployed all 9. Found **VENDOR_TEMPLATE DELETED on rprfo** (add-vendor *copies* it, doesn't recreate; falls back to fragile `ss.getSheets()[3]`); uploaded xlsx is STALE vs live (trust live template); order block I–L is human-facing only; N–T dead (Q–T = unreferenced dupe of A–D). **#2** assign-after-reset bug parked (model confirmed, couldn't reproduce). |
| 2026-05-29 | Vendor Cadence Audit + PWA decimal On Hand | **Two commits, both live.** (A) **Vendor Cadence Audit** (`9b4c027`, bound-sidebar, all 9): new entry at Ordering Guide → 📱 Mobile API → Audit Vendor Cadence. Read-only diagnostic — for each vendor, runs `inferDeliveryFromMults_` → `computeMultsFromDelivery_` (server-side twins of the existing client helpers) and flags 3 statuses: `canonical` (round-trips losslessly — picker promotion would be safe), `mismatch` (recompute differs from stored — recalibrate first), `everyday` (all 1s, every-day delivery — confirm vendor really delivers daily). Modal `VendorCadenceAudit.html` (NEW, 21 EN/ES keys, parity PASS): summary chips, legend, sorted table (mismatch → everyday → canonical) with cell-level diff outlines on mismatch rows. No save path, no schema change. Tool exists to clean the data before the deferred ManageVendors Edit-form disclosure ships. (B) **PWA decimal On Hand input** (`daf354f`, GitHub Pages, CACHE_VERSION v11→v12): 3 edits in `template/index.html` — `inputmode="numeric"` → `"decimal"` + `step="any"` on the count input; `parseInt` → `parseFloat` in `onStepperClick` and `onCountInputChange`. Server `api_saveOnHand_` already does `Number()` so decimals reach the Sheet cleanly. KMs can now enter `.4`, `1.5`, etc. (C) **Architectural walkthrough — ManageVendors edit-form redesign**: shipped no code but locked 3 decisions. Gate 1=(b) hide raw mults grid behind "Advanced" disclosure (deferred until audit findings are worked). Gate 2=(b) NO lead-day picker (operational convention: always 1-day lead, size pars accordingly). Gate 3=(c) defer schema migration. The "edit-form redesign" backlog item is now split — design done, ship gated. |
| 2026-05-28 | Five UX/perf/data-tool wins | **Multi-topic session; four commits + one pending. CACHE_VERSION v8→v9→v10→v11.** (A) **StorageAreas draft mode** (`ed49a62`, bound-sidebar): 4 granular RPCs + helper replaced by one `commitStorageAreasDraft(finalList)` atomic reconciler (delete/rename/add/reorder in one pass; map-based pick-DB remap fixes a latent name-swap bug). Drag-to-reorder retired → stacked ▲▼; Close + Save Areas split to opposite footer ends. (B) **PWA transition floor cut** (`6f9197f`): `playTransitionAnimation` MIN_DURATION_MS 1100→500 + outro 750→400 → ~1.85s→~900ms on every navigation. Pulse still engages for slow work. (C) **PWA fetch timeout** (`ba30b8e`): AbortController + 15s in `api()`; `isNetworkError_` recognizes `AbortError` → hung requests fall into the offline queue. Bundled `--r-sm: 6px` token completion. (D) **Chunked Order History** (`47a1966`): three-tier load (dates → vendors → items) via two new `CacheService`-wrapped server endpoints (`api_getHistoryDates_`, `api_getHistoryVendors_`). PWA stops calling `getHistory` (kept for internal daily-recap caller). `--redeploy` required. New PWA view `view-history-vendors`, local caches `state.cache.historyDates` + `historyVendors[date]`. (E) **Recalibrate Vendor Pars tool** (pending commit, deployed via `python deploy.py`): new modal at Ordering Guide → 📱 Mobile API → Recalibrate Vendor Pars. Three divisor framings + custom; **ceil-to-nearest-0.5** rounding bias (Sebastian's call); filters to items active for this vendor with `USE_MULT=true`. `getVendorRecalibrationBootstrap` + `commitVendorRecalibration` (atomic mults + filtered par division + `bumpServerMutationTs_`). 20 EN/ES keys, parity verified. Unblocks rpr's 1-day-par recalibration. |
| 2026-05-27 | Modal consistency check + PWA audit + fixes | **PWA-layer, `build.py` + git push, `CACHE_VERSION` v7→v8, commit `b7b8aeb`, NO clasp / NO `--redeploy`.** Full audit of `template/index.html` (6128 lines) + `sw.js`. One real bug + 4 cleanups: (1) **`uiIsInteractive_()` dead gate** — the background-refresh "don't repaint Today under an open modal/busy overlay" check looked for a nonexistent `#modal-overlay`/`.show`; real elements are `#modal-backdrop`/`#busy-overlay` toggling `.open`, so it always returned false (regression from a modal-id refactor). Fixed. (2) localized two `' vendors'` toasts (EN/ES). (3) removed leftover reset `console.log` (+ unused `result`). (4) `--text-1`→`--text` undefined-var typo on `.recipient-name`. (5) corrected stale SWR comment in `sw.js` (handler is network-first). Modals re-checked vs each other and **left as-is** — candidate nits would break a layout (AdminReset centered status) or shuffle consistency (ManageItems theme green). Built to all 8 store dirs + pushed; verify on live URL (canary rprfo) at v8. |
| 2026-05-27 | Modal Close/chrome sweep + ManageItems layout + OrderHistory revamp | **Store-facing, big — all bound-sidebar, no `--redeploy`.** (A) Chrome de-dup: removed self-added title (+ OrderHistory top ✕) doubling Google's `showModalDialog` chrome on OrderHistory & ManageVendors (Group A only); compact bottom-right footer Close normalized across ManageItems/OrderHistory/ManageVendors/StorageAreas. (B) ManageItems layout: `.shell` `100vh→100%` (Apps Script iframe fill bug — `100vh` under-resolves in the sandboxed dialog), right pane 390→300px + cell padding 12→7px + dropped per-col max-widths + `showManageItemsSidebar` width 1200→1400 so all 8 cols show, **table header split into its own non-scrolling table (`table-layout:fixed` + shared `<colgroup>`) so the scrollbar starts below the header**, styled 12px scrollbar + matching head gutter for alignment. (C) OrderHistory revamp (100% client-side — already reads public `getOrderHistory`/`getOrderHistoryBootstrap`): Recent → PWA-style date-grouped vendor **cards** + click-to-detail; Item History → per-item **accordion** (Item ID dropped, repeated date gone, On Hand kept); Vendor Summary → **collapsible** (closed on All Vendors, auto-open when filtered; Item ID→Case Pack; Avg On Hand dropped; totals = unique item count); Copy→**Print** (`window.print()` + `@media print`); card pop-out styling. Dead code/i18n pruned, EN/ES at parity. Canary **rprfo** (~8 iterations), then all 9 via `python deploy.py`. **Standing change: rprfo is the canary now, not rpr.** |
| 2026-05-27 | ManageItems multi-vendor items + modal declutter | **Store-facing, big.** Items can be orderable from multiple vendors (eligible list in `MASTER_ITEMS` col **O** — a NEW column; SKU@D kept since every vendor tab `XLOOKUP`s D for its hidden SKU display) + a one-tap "Active vendor" quick-switch on the View detail. `commitSwitchActiveVendor` moves the item to that vendor's tab; **par is shared per-item, the vendor day-multiplier does the rest** — verified math-safe against the real RP_ROSSLYN_FOH sheet formulas. New `parse`/`serialize`/`normalizeEligibleList_` helpers (reads self-heal — eligible defaults to active vendor pre-backfill), `commitUpsertItem` writes O on add+edit, `migrateItemVendorsColumn` one-time per-store backfill (menu: Mobile API → Migrate Item Vendors; optional sheet hygiene). Declutter (6 asks): removed Edit tab + vestigial selectors (RPC removed — `loadItemIntoEdit`→`getItemForEdit`), legend reworded (Possible under-/over-ordering, dropped Inactive), no-scroll table, Inactive/Unassigned tab count chips, green Add panel, removed the modal's self-added title+✕ that doubled Google's `showModalDialog` chrome. Both cache keys bumped (`getAllItemsForView` item shape gained `eligibleVendors`). Bound-sidebar push to all 9 (no `--redeploy`); canary rprfo (3 iterations). **CAVEAT:** rpr pars may not be 1-day pars — recalc before using the switch there. |
| 2026-05-26 | PWA fixes + ManageVendors picker + modal sweep + build.py guard | **Store-facing, backlog-clearing session.** (1) PWA new-day reset overlay fix — `handlePinSubmit` now lets the transition bar finish/fade before the `z70` "Detected new day…" overlay (was hidden behind the `z80` bar on the PIN-entry path). (2) Cached PIN removed — session-only now; boot wipes any legacy `mog_pin`; master-PIN path untouched. (PWA `8aa491a`, `CACHE_VERSION` v7.) (3) **ManageVendors edit-form delivery-day picker** (`c86d9d3`) — NO schema change: `computeMultsFromDelivery` (shared with add-form) + `inferDeliveryFromMults` (display-only seed) + `recalcInlineMults`; non-destructive until the KM toggles a day. Canary rpr → all 9. (4) Modal close-affordance sweep (`588b20d`) — OrderHistory `×`→`✕`, HowToUse `btn-close` green→grey (lone outlier; 4/5 already grey). (5) `build.py` hub-registry injection now idempotent — `[skip]` no-op instead of crash on unchanged stores.json (`0c11016`). Housekeeping confirmed: old repo decommissioned, all 8 trigger installs done. Noted: invariant #4 (Rhino/ES5) is inaccurate — modals run in the browser; new code still written ES5-safe. |
| 2026-05-26 | New-day auto-reset + guaranteed recap email | **Store-facing.** Recap email now a deduped side-effect of `commitLogAndReset` (`sendRecapIfUnsent_` helper, gated by `MOG_LAST_RECAP_SENT_DATE`) so every reset path emails once per cycle — closed the gap where the PWA stale-gate and `api_commitReset_` never emailed. PWA auto-fires the reset on first open of a new day (`proceedAfterAuth` → `autoRunStaleReset` → shared `runStaleReset_`), with a "Detected new day" overlay; manual button kept as fallback. New installable `onOpen` trigger `dailyResetOnOpen_` + `ensureDailyResetTrigger_` installer (wired into `buildHomeDashboard`) does the same on Sheet-open — installable because a simple trigger can't call MailApp. Latent-bug fix: `buildHomeDashboard` now preserves AE9 across the rebuild (was blanked by the rows1-50×cols1-35 clear → banner reded out + rebuild looked like a new day). `CACHE_VERSION` v5→v6. Canary on rpr (@17) smoke-tested (banner-preserve + recap-on-reset confirmed), then fanned out to all 9 + PWA pushed. Commit `04b7098`. **Outstanding manual step:** run "Rebuild Home Dashboard" per Sheet (8×, one auth prompt each) to install the open-trigger; PWA path already live without it. |
| 2026-05-26 (later session) | Skills expansion + full skills audit | No store-facing code. MOG skill set 4 → 7: added `mog-rpc-consolidation`, `mog-apps-script-caching`, `mog-modal-ux-sweep` (patterns re-derived every session). Then a 3-part audit: (visibility) `disable-model-invocation` on add-store, `user-invocable:false` on the 3 pattern skills; (determinism) 3 new stdlib scripts — `mog-deploy-workflow/scripts/route.py` (deploy router, guards pitfall #4a), `mog-add-store/scripts/validate.py` (Script-ID/exec-URL checks), `mog-modal-ux-sweep/scripts/audit_modals.py` (modal drift detector); (composability) canary/redeploy logic de-duplicated from 5 skills into route.py as the single source of truth. All scripts smoke-tested. Gotcha caught: audit_modals.py's first close-button signature false-flagged AdminReset/ManageItems (their markup differs) — recalibrated to `google.script.host.close()`. Commits `d1d72e0`, `ebce6b9`, `79785bc`; the two final scripts + 2 SKILL.md wirings still uncommitted. |
| 2026-05-27 | Audit punch list close-out + modal UX polish | 6 of 7 audit items shipped: #3 dashboard CacheService + count-items-by-vendor loop hoist; #5 fetchCurrentArea removal + getVendorTableData read merge + getSheet_ per-execution memoization; #4 commitAreaListMutation_ helper (option A — server-side dedup, not full RPC consolidation); #7 CACHE_VERSION audit closed clean at v5. Plus UX polish: ✓ + green-flash on all 5 modals' .status.ok; new Close buttons on StorageAreas + ManageVendors; StorageAreas Delete Area panel removed (inline 🗑 + window.confirm covers it); inline trash now red at rest; flex-column scroll layout fix on StorageAreas (gotcha: `.body > * { flex-shrink: 0 }` needed or .list-card's overflow:hidden clips rows). All 9 targets pushed + redeployed. |
| 2026-05-26 | ManageVendors save consolidation + Python deploy tool | Audit item #2 shipped: `commitUpdateVendorMultsAndCutoff` server fn + flat one-RPC client (was two chained RPCs with shared row lookup). Deployed to all 9 targets (bound-sidebar-only — no web-app redeploy needed). Tooling overhaul: built the PowerShell `deploy.ps1` + `discover-deployments.ps1` pair with `-Redeploy` support, populated all 8 `deploymentId` fields in `.clasp-targets.json`, migrated TNYTF to a new script project, then ported the whole tool to Python (`deploy.py` at repo root, parallel to `build.py`). Closed the gap where MOGApi.gs changes silently didn't reach the PWA's `/exec` URL — `python deploy.py --redeploy` handles push + version bump in one command. Cross-platform, zero deps. Docs updated: `apps-script/README.md`, `CLAUDE.md`, this file, deploy-workflow + add-store skills. |
| 2026-05-25 | Order History modal RPC consolidation | Apps Script modal perf audit produced 7-item ranked punch-list. Item #1 shipped: `getOrderHistoryBootstrap` server fn + rewired `OrderHistory.html` window.onload → 1 RPC instead of 2 on modal open, 1 fewer `LOG_ORDERS` read. Deployed to all 9 clasp targets. Side-note: Node + clasp + clasp login installed on `sebcn` machine for the first time. |
| 2026-05-24 | Repo consolidation + Claude Code scaffold | Master-Ordering-Guide repo merged into mog-mobile; `apps-script/` folder created; clasp deploy workflow set up; 2 new stores (rpfrf, rptfo) onboarded; CLAUDE.md + docs/ + 3 repo-specific skills written. Commits: `d95080f`, `bb68221`, plus this scaffold commit. |
