# MOG — Current Project State

The running snapshot of where this codebase is *right now*. Updated at the end of every session that ships material changes. Future Claude reads this on session start (via `CLAUDE.md` @-import) and uses it to orient before touching anything.

If this doc and `CLAUDE.md` conflict on a specific fact, `CLAUDE.md` wins for structure / invariants; this doc wins for "what's currently in flight."

---

## Pinned focus

**PWA audit + fixes shipped (2026-05-27, fourth session) — live on all 8 stores (PWA layer: `build.py` + git push, `CACHE_VERSION` v7→v8, commit `b7b8aeb`, NO clasp / NO `--redeploy`).** Full read of `template/index.html` (6128 lines) + `sw.js`. The PWA is mature and clean — found **one real latent bug** + 4 minor cleanups, all fixed: (1) **`uiIsInteractive_()` was a dead safety gate** — the background-dashboard-refresh "don't repaint Today under an open modal/busy overlay" check was looking for a nonexistent `#modal-overlay` with class `.show`; the real elements are `#modal-backdrop`/`#busy-overlay` toggling `.open`, so it always returned false and the gate did nothing (regression from an earlier modal-id refactor). Now fixed. (2) localized two hardcoded `' vendors'` toasts (EN/ES). (3) removed a leftover reset `console.log`. (4) `--text-1`→`--text` undefined-CSS-var typo. (5) corrected a stale SWR comment in `sw.js` (handler is network-first). Also: **modals re-checked for consistency and left as-is** — the only candidate nits would break a layout (AdminReset centered status) or just shuffle which kind of consistency you have (ManageItems theme green), so no modal changes shipped. **Standing: canary is rprfo; rpr 1-day-par caveat still open.**

**Modal UX pass shipped (2026-05-27, third session) — live on all 9 stores (bound-sidebar, no `--redeploy`).** Three bundled bodies of work: (1) **chrome de-dup + Close consistency** — removed the self-added title (+ OrderHistory's top ✕) that doubled Google's `showModalDialog` chrome on OrderHistory & ManageVendors (Group A only; content-header modals untouched), and normalized a compact bottom-right footer Close across ManageItems/OrderHistory/ManageVendors/StorageAreas. (2) **ManageItems layout** — `.shell` `100vh→100%` (Apps Script iframe fill bug), right pane 390→300px + tighter columns + modal width 1200→1400 so all 8 cols show, and the **table header split into its own non-scrolling table (fixed layout + shared colgroup) so the scrollbar starts below the header**. (3) **OrderHistory revamp** — Recent → PWA-style date-grouped vendor **cards** w/ click-to-detail; Item History → per-item **accordion** (Item ID dropped, On Hand kept); Vendor Summary → **collapsible** (starts closed on All Vendors, Item ID→Case Pack, Avg On Hand dropped, totals show unique item count); **Copy→Print** (`window.print()` + `@media print`); card pop-out styling throughout. **All OrderHistory data still flows from the existing public `getOrderHistory`/`getOrderHistoryBootstrap` — zero MOGApi.gs change.** **Standing change: rprfo is now the canary (not rpr).** **CAVEAT (still):** rpr pars may not be true 1-day pars — recalc before using the active-vendor switch there.

### Next-session candidates (impact-ranked)

1. **ManageVendors edit-form redesign** (MEDIUM-HIGH). Add Vendor uses the friendly delivery-day + lead-day picker; Edit Vendor still shows raw multipliers. Needs an architectural walkthrough first — the mults→delivery mapping isn't trivially reversible; may need a small schema migration (store `deliveryDays[]` + `leadDays` as columns, compute mults at save). Sebastian-flagged.
2. **Parallelize `deploy.py`** (LOW). Deprioritized 2026-05-26 ("30s isn't hurting"). `ThreadPoolExecutor` + per-target temp working dirs that COPY apps-script/; default all-concurrent with `--jobs` throttle.
   - *Note:* glance at `.claude/skills/mog-deploy-workflow/scripts/route.py` first — deterministic deploy router, shouldn't need changes but parallelization alters deploy.py internals it documents.
3. **StorageAreas draft-mode UX** (MEDIUM). Replaces optimistic-immediate-fire with "stage → Save & Exit." Edge cases (rename collisions in draft, partial-save). Defer unless asked.
4. **Reconcile the Rhino-ES5 invariant** (HOUSEKEEPING). CLAUDE.md invariant #4 says modals are Rhino/ES5, but HtmlService modals render in the *browser* and ManageVendors.html + OrderHistory.html already use ES6 (`const`) in production. Update invariant #4 + the `rhino-safe-html` skill to match reality.
5. **OrderHistory scrollbar-below-header** (LOW, likely unnecessary). The ManageItems header-split wasn't applied to OrderHistory's item/summary tables (headers built in JS); the accordion design sidesteps the need. Revisit only if the look bothers anyone.

*(Done this session: PWA audit + the `uiIsInteractive_` gate fix + 4 cleanups; modal consistency re-checked and confirmed — no modal changes needed.)*

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
| 2026-05-27 (latest) | Modal consistency check + PWA audit + fixes | **PWA-layer, `build.py` + git push, `CACHE_VERSION` v7→v8, commit `b7b8aeb`, NO clasp / NO `--redeploy`.** Full audit of `template/index.html` (6128 lines) + `sw.js`. One real bug + 4 cleanups: (1) **`uiIsInteractive_()` dead gate** — the background-refresh "don't repaint Today under an open modal/busy overlay" check looked for a nonexistent `#modal-overlay`/`.show`; real elements are `#modal-backdrop`/`#busy-overlay` toggling `.open`, so it always returned false (regression from a modal-id refactor). Fixed. (2) localized two `' vendors'` toasts (EN/ES). (3) removed leftover reset `console.log` (+ unused `result`). (4) `--text-1`→`--text` undefined-var typo on `.recipient-name`. (5) corrected stale SWR comment in `sw.js` (handler is network-first). Modals re-checked vs each other and **left as-is** — candidate nits would break a layout (AdminReset centered status) or shuffle consistency (ManageItems theme green). Built to all 8 store dirs + pushed; verify on live URL (canary rprfo) at v8. |
| 2026-05-27 | Modal Close/chrome sweep + ManageItems layout + OrderHistory revamp | **Store-facing, big — all bound-sidebar, no `--redeploy`.** (A) Chrome de-dup: removed self-added title (+ OrderHistory top ✕) doubling Google's `showModalDialog` chrome on OrderHistory & ManageVendors (Group A only); compact bottom-right footer Close normalized across ManageItems/OrderHistory/ManageVendors/StorageAreas. (B) ManageItems layout: `.shell` `100vh→100%` (Apps Script iframe fill bug — `100vh` under-resolves in the sandboxed dialog), right pane 390→300px + cell padding 12→7px + dropped per-col max-widths + `showManageItemsSidebar` width 1200→1400 so all 8 cols show, **table header split into its own non-scrolling table (`table-layout:fixed` + shared `<colgroup>`) so the scrollbar starts below the header**, styled 12px scrollbar + matching head gutter for alignment. (C) OrderHistory revamp (100% client-side — already reads public `getOrderHistory`/`getOrderHistoryBootstrap`): Recent → PWA-style date-grouped vendor **cards** + click-to-detail; Item History → per-item **accordion** (Item ID dropped, repeated date gone, On Hand kept); Vendor Summary → **collapsible** (closed on All Vendors, auto-open when filtered; Item ID→Case Pack; Avg On Hand dropped; totals = unique item count); Copy→**Print** (`window.print()` + `@media print`); card pop-out styling. Dead code/i18n pruned, EN/ES at parity. Canary **rprfo** (~8 iterations), then all 9 via `python deploy.py`. **Standing change: rprfo is the canary now, not rpr.** |
| 2026-05-27 | ManageItems multi-vendor items + modal declutter | **Store-facing, big.** Items can be orderable from multiple vendors (eligible list in `MASTER_ITEMS` col **O** — a NEW column; SKU@D kept since every vendor tab `XLOOKUP`s D for its hidden SKU display) + a one-tap "Active vendor" quick-switch on the View detail. `commitSwitchActiveVendor` moves the item to that vendor's tab; **par is shared per-item, the vendor day-multiplier does the rest** — verified math-safe against the real RP_ROSSLYN_FOH sheet formulas. New `parse`/`serialize`/`normalizeEligibleList_` helpers (reads self-heal — eligible defaults to active vendor pre-backfill), `commitUpsertItem` writes O on add+edit, `migrateItemVendorsColumn` one-time per-store backfill (menu: Mobile API → Migrate Item Vendors; optional sheet hygiene). Declutter (6 asks): removed Edit tab + vestigial selectors (RPC removed — `loadItemIntoEdit`→`getItemForEdit`), legend reworded (Possible under-/over-ordering, dropped Inactive), no-scroll table, Inactive/Unassigned tab count chips, green Add panel, removed the modal's self-added title+✕ that doubled Google's `showModalDialog` chrome. Both cache keys bumped (`getAllItemsForView` item shape gained `eligibleVendors`). Bound-sidebar push to all 9 (no `--redeploy`); canary rprfo (3 iterations). **CAVEAT:** rpr pars may not be 1-day pars — recalc before using the switch there. |
| 2026-05-26 | PWA fixes + ManageVendors picker + modal sweep + build.py guard | **Store-facing, backlog-clearing session.** (1) PWA new-day reset overlay fix — `handlePinSubmit` now lets the transition bar finish/fade before the `z70` "Detected new day…" overlay (was hidden behind the `z80` bar on the PIN-entry path). (2) Cached PIN removed — session-only now; boot wipes any legacy `mog_pin`; master-PIN path untouched. (PWA `8aa491a`, `CACHE_VERSION` v7.) (3) **ManageVendors edit-form delivery-day picker** (`c86d9d3`) — NO schema change: `computeMultsFromDelivery` (shared with add-form) + `inferDeliveryFromMults` (display-only seed) + `recalcInlineMults`; non-destructive until the KM toggles a day. Canary rpr → all 9. (4) Modal close-affordance sweep (`588b20d`) — OrderHistory `×`→`✕`, HowToUse `btn-close` green→grey (lone outlier; 4/5 already grey). (5) `build.py` hub-registry injection now idempotent — `[skip]` no-op instead of crash on unchanged stores.json (`0c11016`). Housekeeping confirmed: old repo decommissioned, all 8 trigger installs done. Noted: invariant #4 (Rhino/ES5) is inaccurate — modals run in the browser; new code still written ES5-safe. |
| 2026-05-26 | New-day auto-reset + guaranteed recap email | **Store-facing.** Recap email now a deduped side-effect of `commitLogAndReset` (`sendRecapIfUnsent_` helper, gated by `MOG_LAST_RECAP_SENT_DATE`) so every reset path emails once per cycle — closed the gap where the PWA stale-gate and `api_commitReset_` never emailed. PWA auto-fires the reset on first open of a new day (`proceedAfterAuth` → `autoRunStaleReset` → shared `runStaleReset_`), with a "Detected new day" overlay; manual button kept as fallback. New installable `onOpen` trigger `dailyResetOnOpen_` + `ensureDailyResetTrigger_` installer (wired into `buildHomeDashboard`) does the same on Sheet-open — installable because a simple trigger can't call MailApp. Latent-bug fix: `buildHomeDashboard` now preserves AE9 across the rebuild (was blanked by the rows1-50×cols1-35 clear → banner reded out + rebuild looked like a new day). `CACHE_VERSION` v5→v6. Canary on rpr (@17) smoke-tested (banner-preserve + recap-on-reset confirmed), then fanned out to all 9 + PWA pushed. Commit `04b7098`. **Outstanding manual step:** run "Rebuild Home Dashboard" per Sheet (8×, one auth prompt each) to install the open-trigger; PWA path already live without it. |
| 2026-05-26 (later session) | Skills expansion + full skills audit | No store-facing code. MOG skill set 4 → 7: added `mog-rpc-consolidation`, `mog-apps-script-caching`, `mog-modal-ux-sweep` (patterns re-derived every session). Then a 3-part audit: (visibility) `disable-model-invocation` on add-store, `user-invocable:false` on the 3 pattern skills; (determinism) 3 new stdlib scripts — `mog-deploy-workflow/scripts/route.py` (deploy router, guards pitfall #4a), `mog-add-store/scripts/validate.py` (Script-ID/exec-URL checks), `mog-modal-ux-sweep/scripts/audit_modals.py` (modal drift detector); (composability) canary/redeploy logic de-duplicated from 5 skills into route.py as the single source of truth. All scripts smoke-tested. Gotcha caught: audit_modals.py's first close-button signature false-flagged AdminReset/ManageItems (their markup differs) — recalibrated to `google.script.host.close()`. Commits `d1d72e0`, `ebce6b9`, `79785bc`; the two final scripts + 2 SKILL.md wirings still uncommitted. |
| 2026-05-27 | Audit punch list close-out + modal UX polish | 6 of 7 audit items shipped: #3 dashboard CacheService + count-items-by-vendor loop hoist; #5 fetchCurrentArea removal + getVendorTableData read merge + getSheet_ per-execution memoization; #4 commitAreaListMutation_ helper (option A — server-side dedup, not full RPC consolidation); #7 CACHE_VERSION audit closed clean at v5. Plus UX polish: ✓ + green-flash on all 5 modals' .status.ok; new Close buttons on StorageAreas + ManageVendors; StorageAreas Delete Area panel removed (inline 🗑 + window.confirm covers it); inline trash now red at rest; flex-column scroll layout fix on StorageAreas (gotcha: `.body > * { flex-shrink: 0 }` needed or .list-card's overflow:hidden clips rows). All 9 targets pushed + redeployed. |
| 2026-05-26 | ManageVendors save consolidation + Python deploy tool | Audit item #2 shipped: `commitUpdateVendorMultsAndCutoff` server fn + flat one-RPC client (was two chained RPCs with shared row lookup). Deployed to all 9 targets (bound-sidebar-only — no web-app redeploy needed). Tooling overhaul: built the PowerShell `deploy.ps1` + `discover-deployments.ps1` pair with `-Redeploy` support, populated all 8 `deploymentId` fields in `.clasp-targets.json`, migrated TNYTF to a new script project, then ported the whole tool to Python (`deploy.py` at repo root, parallel to `build.py`). Closed the gap where MOGApi.gs changes silently didn't reach the PWA's `/exec` URL — `python deploy.py --redeploy` handles push + version bump in one command. Cross-platform, zero deps. Docs updated: `apps-script/README.md`, `CLAUDE.md`, this file, deploy-workflow + add-store skills. |
| 2026-05-25 | Order History modal RPC consolidation | Apps Script modal perf audit produced 7-item ranked punch-list. Item #1 shipped: `getOrderHistoryBootstrap` server fn + rewired `OrderHistory.html` window.onload → 1 RPC instead of 2 on modal open, 1 fewer `LOG_ORDERS` read. Deployed to all 9 clasp targets. Side-note: Node + clasp + clasp login installed on `sebcn` machine for the first time. |
| 2026-05-24 | Repo consolidation + Claude Code scaffold | Master-Ordering-Guide repo merged into mog-mobile; `apps-script/` folder created; clasp deploy workflow set up; 2 new stores (rpfrf, rptfo) onboarded; CLAUDE.md + docs/ + 3 repo-specific skills written. Commits: `d95080f`, `bb68221`, plus this scaffold commit. |
