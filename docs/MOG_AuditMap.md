# MOG — Audit Map & Optimization Punch-List

Resumable audit manifest (per `codebase-audit-method`). Each area records the commit it was last swept at, so a later audit only re-reads what changed. The punch-list numbers **continue across audits**; refuted/dropped findings stay recorded so they're never re-flagged.

**How to resume:** pick the lowest open item number below, or re-sweep an area whose `last_swept` is behind `HEAD`.

---

## Area manifest

| Area | Files | last_swept | Verdict |
|---|---|---|---|
| Backend — core/order/reset/dashboard/recap | `Core.gs`, `ResetLog.gs`, `Dashboard.gs`, `MOGApi.gs` | `dc77978` (2026-07-21) | Clean; 1 latent TZ drift (#17) |
| Backend — vendor/items/pickpath/history/health | `Vendors.gs`, `Items.gs`, `PickPath.gs`, `History.gs`, `Health.gs` | `dc77978` (2026-07-21) | Clean |
| Web editor + modals | `Editor.gs`, `EditorShell.html`, `EditorHome.html`, all dual-host `*.html` | `dc77978` (2026-07-21) | Clean behaviorally; visual items A1–A5 |
| PWA + deploy infra | `template/index.html`, `template/sw.js`, `build.py`, `deploy.py`, root `index.html`/`sw.js`, `stores.json` | `dc77978` (2026-07-21) | Clean; 1 visual nit (A6) |

Context: the codebase was deep-audited 2026-07-12 (11 commits) and again touched 2026-07-14 (8 commits). This sweep therefore concentrated on the 07-14 changes (Tier-3 formula→code, par-review overhaul, #19 RPC-shim, B1 fix/Health Check). The thin result set is expected.

**2026-07-21 re-sweep:** all 4 areas were CLEAN vs the 07-16 stamps (only docs/skill commits since `a08ca2b`), so this pass was (a) the mechanical scanner over the whole repo — every hit already in the recorded-NOT-findings list, zero shared-constant drift, i18n parity 12/12 PASS, CACHE v38 synced template + 8 dirs; (b) an adversarial re-verify of all 9 of the 07-16 fix commits (`f4e8c88`→`a08ca2b`) — all faithful, incl. the #13/#14 refactor (shared filter body identical to both originals; prebuilt par map matches the standalone read's `par>0` semantics) — which surfaced #17; and (c) the repo's first dedicated **visual-consistency sweep** (`appsscript-ui-consistency-audit` lenses) since 2026-06-22, covering the Sheet-modal layer, web-editor layer, and PWA → items A1–A6 below.

---

## Punch-list — audit 2026-07-16 (items #1–#16)

Ranked HIGH-value-LOW-effort first. Effort tag in brackets.

### Status (2026-07-16, later — all shipped to all 9 + master)

- **DONE:** #1 (`f4e8c88`), #4–#9 batch A1 (`78563bc`-ish A1 commit), #2/#3 batch A2, #16 (`87f6bd6`-area). All fanned out via `deploy.py --redeploy` + PWA push; canary rprfo verified (incl. the web-editor add-vendor flow).
- **#16 (NEW, found during A2 canary verification):** add-vendor threw "Please create an active sheet first" in the web editor — `moveActiveSheet`/`setActiveSheet` have no active sheet in a `/exec` execution and threw *after* the vendor was created (empty client refresh, duplicate on retry). This was **also the true root cause of the 07-14 B1 bug** (the throw aborted `commitAddVendor` before `setVendorHeaderB1_` ran, so the clone kept "VENDOR TEMPLATE"). Fixed by guarding the cosmetic reordering best-effort.
- **#15 → RESOLVED, no code change:** `snapshotVendorOrders_` only logs rows with `suggested > 0`, so LOG_ORDERS never holds 0-qty rows — the `qtyOrdered <= 0` filter is correct defensiveness. The over-flag's blindness to not-ordered-because-overstocked days is inherent to logging only actual orders (a future enhancement, not a bug).
- **#10 → KEPT:** the unreachable guard in `computeSuggestedQty_` is deliberate belt-and-suspenders in the order-math path; not worth touching.
- **DONE (batch B):** #11 (stale `handlePinSubmit` log label) + #12 (localized the generic error toast — `errGeneric`; 5 sites, audit undercounted as 3). Shipped to all stores, CACHE v38 (`02380fb`).
- **DONE:** #13 (`getManageItemsBootstrap` now passes a prebuilt par map to `getParReviewFlags` → one MASTER read on modal open, not two) + #14 (extracted `buildHistoryRows_` — the two Order History readers no longer duplicate ~60 lines). No behavior change. Fanned out to all 9 + master.
- **OPEN:** none — all 16 findings closed.

### Ship-worthy

**#1 [LOW] Settings screen header renders raw lowercase `settings` in both languages — `template/index.html:5633` (PWA).** CONFIRMED. `renderSettings()` builds the hero as `t('settings') || 'Settings'`, but `t()` (line 2450) resolves against `T.msg` only, and `settings` lives in `T.titles` (2259), not `T.msg`. The lookup returns the truthy raw key `'settings'`, so the `|| 'Settings'` fallback never fires — every KM sees a lowercase English header on the Settings tab, EN and ES alike. (Topbar title is fine; it reads `T.titles` directly.) → Inline it (`state.lang==='en'?'Settings':'Ajustes'`) or add a `settings` entry to `T.msg`. **value HIGH.**

**#2 [LOW] `commitAddVendor` discards `setVendorHeaderB1_`'s return — `Vendors.gs:259` (backend).** `setVendorHeaderB1_` returns a boolean (true only if B1 landed after retry), but the caller ignores it and always returns `{ok:true}`. If the retry still fails, Add Vendor reports success while the tab is born empty — the exact B1 failure the 07-14 fix targets; the Health Check is the only backstop. → Capture the return; on false, throw or include a warning flag so the add path self-reports. **value MED, confidence high.**

### Drift / correctness (freshly-changed, desync-prone)

**#3 [LOW] `MIN_ORDERS` par-review threshold duplicated as independent literals across layers — `History.gs:276` (`PAR_FLAG.MIN_ORDERS=3`) + `ManageItems.html:2275` (`MIN_FLAG_ORDERS_=3`) (backend/modal).** They "must match" only by comment; the 2→3 tuning this session had to touch both. A future change to one silently desyncs the display threshold from the server's flag gate. → Carry `MIN_ORDERS` in the `getManageItemsBootstrap`/par-review payload instead of re-declaring it client-side. **value MED, confidence high.**

**#4 [LOW] Stale over-flag threshold comments say 50%, code uses 75% — `History.gs:298, 439` (backend).** The FLAG VALUES doc block and the inline over-flag comment still describe `on hand ≥ 50% of par`, but the code now uses `OVER_ONHAND_PCT: 0.75` (the `PAR_FLAG` block at 264–285 is already correct). Misleads the next reader on a just-tuned path. → Update both comments to 75%. **value MED, confidence high.**

**#5 [LOW] Timezone source drift in log-date compare — `MOGApi.gs:1437` (`getTodaysLogByVendor_`) (backend).** Formats LOG_ORDERS dates with `Session.getScriptTimeZone()`, while `getActiveOrderDate_()` (the `dateStr` it compares) and `deleteLogEntriesForDate_` use `getSpreadsheetTimeZone()`. No-op today (all stores US/Eastern, manifest TZ matches), but a day-boundary mismatch if the two ever diverge. → Use `getSpreadsheetTimeZone()` to match Core's 2026-06-19 standardization. **value MED, confidence hunch (latent).**

**#6 [LOW] Vendor-tab Item-ID column M hardcoded as literal `13` in 4 spots — `MOGApi.gs:587,611,1406-1407`; `ResetLog.gs:224` (backend).** `VENDOR_TAB` (Core.gs:113) defines `ON_HAND_COL` but not the item-id column; Tier-3 made M the only *other* vendor-tab column read, so a template change to M needs edits in multiple files. → Add `ITEM_ID_COL: 13` to `VENDOR_TAB` and reference it. **value MED, confidence high.**

**#7 [LOW] Hardcoded `'AE9'` bypasses the reset-date cell constant — `MOGApi.gs:335` (backend).** Uses a string literal where `LAST_RESET_DATE_CELL` / `DASH.RESET_DATE` is the single source of truth used everywhere else; if the cell ever moves via `DASH`, this write silently targets the wrong cell. → Replace `'AE9'` with `LAST_RESET_DATE_CELL`. **value LOW, confidence high.**

### Dead code / cleanup

**#8 [LOW] Write-only dead property `LAST_LOG_DATE_PROP` — `ResetLog.gs:195,457` + `History.gs:211` (backend).** `setProperty`'d and `deleteProperty`'d but never `getProperty`'d anywhere (grep-confirmed tree-wide); vestigial of the old skip-if-exists guard replaced by overwrite-on-re-reset. → Delete the const, the set (457), and the delete (History.gs:211). **value LOW-MED, confidence high.**

**#9 [LOW] Unused local `tz` — `MOGApi.gs:425` (`api_getDashboard_compute_`) (backend).** Declared, never referenced. → Delete the line. **value LOW, confidence high.**

**#10 [LOW] Unreachable guard in `computeSuggestedQty_` — `MOGApi.gs:1266` (backend).** `if (effectiveMult <= 0) return null;` can't fire — the earlier `dayMult<=0` guard already returned, and `effectiveMult` is then `dayMult`(>0) or literal `1`. → Optional: remove, or keep as belt-and-suspenders. **value LOW, confidence high.**

**#11 [LOW] Stale `console.error` label in `handlePinSubmit` — `template/index.html:2917` (PWA).** Logs `'proceedAfterAuth error:'` but the code is in `handlePinSubmit` (label copy-pasted from line 2752). Misleads devtools debugging; no user impact. → Relabel to `'handlePinSubmit error:'`. **value LOW, confidence high.**

**#12 [LOW] English-only `'Error'` last-resort fallback in 3 server-error toasts — `template/index.html:3352, 3386, 5297` (PWA).** `showToast(msg || 'Error', …)` — the server message normally shows; the bare `'Error'` only appears if the exception carries no message. → Optional: localize the fallback. **value LOW, confidence high (arguably fine as-is).**

### Maintainability (cold-path / duplication)

**#13 [LOW] `getManageItemsBootstrap` reads MASTER twice on the cold path — `Items.gs:122-124` (backend).** `getAllItemsForView()` reads MASTER A:O and `getParReviewFlags()` re-reads MASTER ID:PAR in the same call (SETUP also touched 3×). CacheService-wrapped on the ts key, so cold-hit only. → Build the par map once in the bootstrap, pass a ctx into `getParReviewFlags(ctx)` (mirrors the recap shared-ctx pattern). **value LOW, confidence high.**

**#14 [LOW] `getOrderHistory` / `getOrderHistoryBootstrap` duplicate ~60 lines of pack-map + enrich + filter/sort — `History.gs:31-101` vs `108-192` (backend).** Both live (bootstrap on open, `getOrderHistory` on filter refetch + 3 MOGApi callers); a change to the enrich shape must be made in both. → Extract a shared `enrichLogRows_(data, filters)`. **value LOW, confidence high.**

### Needs verification before acting

**#15 [MED] Over-flag may be blind to zero-qty log rows — `History.gs:388` (backend).** `if (!itemId || qtyOrdered <= 0) return;` excludes 0-qty logged rows from ALL par-review aggregation (timesOrdered, totalOnHand, overCount, and `parPct_` severity). Over-ordered items are precisely those likeliest to have suggested qty 0 (on-hand already ≥ par) — so IF LOG_ORDERS stores 0-qty rows, the over-flag systematically under-counts the very observations that prove over-ordering. → **Verify `snapshotVendorOrders_`'s log-write semantics first:** if it never writes 0-qty rows, the filter is dead defensiveness (simplify); if it does, count them toward on-hand/over stats (skip only for effective-par reconstruction). **value MED, confidence LOW (hinges on log semantics not traced this sweep).**

---

## Punch-list — audit 2026-07-21 (items #17–#18)

### Status (2026-07-21, later)

- **DONE + FANNED OUT (all 9 + master, `deploy.py --redeploy`, 2026-07-21):** #17 (`MOGApi.gs` TZ swap + comment) + #18 (6 dead glossary lines deleted, parity 21/21). Rode the same fan-out as A3.

**#17 [LOW] `api_commitReset_` writes the override-date property with the script TZ, its reader compares with the spreadsheet TZ — `MOGApi.gs:337` (backend).** CONFIRMED. `api_commitReset_` formats `EMERGENCY_OVERRIDE_LASTDATE_PROP` with `Session.getScriptTimeZone()` (line 337 feeds lines 342–343 and the `resetDate` return at 352), while the property's reader `resetEmergencyOverrideOnOpen_` (Core.gs:415–416) and every other writer (Core.gs:593 via :569, ResetLog.gs:367 via :317, MOGApi.gs:375 via :373) use `getSpreadsheetTimeZone()`. Same latent class as closed item #5 — a no-op today (all stores US/Eastern, manifest TZ matches) but a day-boundary mismatch if they ever diverge, which would make the on-open guard clear a same-day override (or leave a stale one on). The A1 batch fixed `getTodaysLogByVendor_` but missed this sibling. → Swap line 337 to `SpreadsheetApp.getActiveSpreadsheet().getSpreadsheetTimeZone()`. `--redeploy` (api path). **value LOW-MED, confidence high (latent).**

**#18 [LOW] Dead i18n keys with stale window.confirm phrasing — `ReorderPickPath.html:588-590, 617-619` (modal).** `unsavedSwitch` / `unsavedSwitchEnd` / `unsavedClose` are defined in both languages but referenced nowhere (grep-confirmed) — orphaned when the 07-14 `rpp-guard` dialog replaced `window.confirm`. The copy still says "Click OK to save… or Cancel" — wrong for the 3-button dialog even if ever resurrected. Parity checker passes (both sides present); parity ≠ liveness. → Delete all six lines (EN + ES together). Push-only. **value LOW, confidence high.**

---

## Visual-consistency punch-list — 2026-07-21 (items A1–A6)

First A-numbered visual sweep (per `appsscript-ui-consistency-audit`); numbering continues across future visual audits. Scanner raw output kept out of the repo — the bulk of its raw-hex hits are the accepted neutral-greys-stay-raw decision (2026-06-04); items below are the judgment-filtered residue.

### Status (2026-07-21, later)

- **DONE (canary rpfrf):** A3 shipped — shared `mgeGuard3_`/`mgeConfirm_`/`mgeDialogEnsure_` + `.mge-dlg-*` CSS in EditorShell; ReorderPickPath + ManageItems converged onto `mgeGuard3_` (per-tool `.rpp-guard-*`/`.ig-*` copies + markup deleted); StorageAreas close→`mgeGuard3_` (upgraded 2-btn→3-btn Save/Don't-save/Cancel, `doSave` gained an optional onDone), delete→`mgeConfirm_`; HealthCheck destructive-fix→`mgeConfirm_`. JS parses, parity 12/12, no dangling refs, zero `window.confirm` left in the editor set. Net ~−70 lines.
- **A3 follow-up 1 — breadcrumb navigation now honors the guard** (found in rpfrf smoke test: clicking the breadcrumb bypassed the dirty guard and silently discarded edits — pre-existing; breadcrumb is EditorShell chrome that navigates via a raw `<a>`). Added a **leave-guard mechanism** to EditorShell: `mgeSetLeaveGuard_(fn)` + a one-time delegated click interceptor on `#mge-crumb` (`mgeWireCrumbGuard_`, wired from `setBreadcrumb_`) that routes ancestor-link clicks through the registered `fn(proceed)`. Each editable tool registers a `guardLeave_(proceed)`; footer `doClose`/`editorClose` delegate to it too — one code path for footer-close AND breadcrumb.
- **A3 follow-up 2 — two-step / free-text inputs also count as "dirty" now** (found in rpfrf: an in-progress Storage-Areas rename or typed Add field wasn't in the `isDirty` draft, so it slipped past the guard). Swept ALL web tools for the class and closed each:
  - **StorageAreas**: `hasPendingInput_` (open rename with changed text, or non-empty Add field) fires the 3-button guard; Save folds the pending text into the draft via `commitPendingInput_` first (Cancel leaves the open input untouched).
  - **ManageItems**: Assign tab keeps its 3-button (real save-all); the Add/Edit **item** forms (own Add/Save buttons, no unified save) now warn via a **2-button** "Leave without saving?" — Add dirty = any text field typed; Edit dirty = live form ≠ `editFormBaseline_` snapshot (captured in `setEditFormState_('loaded')`).
  - **ManageVendors** (had NO guard/dirty model at all): added `guardLeave_` + `vendorFormPending_` (Add name / Import name / chosen file / an open inline multiplier edit) → 2-button warn; `editorClose` now routes through it.
  - **ReorderPickPath**: every edit is a button that flips `isDirty` immediately, no free-text — already covered.
  - Read-only tools (OrderHistory/VendorCadenceAudit/HealthCheck) register nothing → breadcrumb navigates freely. **Guard-style decision (Sebastian): 2-button warn for the per-form tools** (they have their own Save buttons; no ambiguous dialog-Save), 3-button only where a unified draft-Save exists (StorageAreas, MI Assign).
- Re-parsed all edited files, parity 12/12. **DONE + FANNED OUT (all 9 + master, `deploy.py --redeploy`) + committed + pushed 2026-07-21 — Sebastian confirmed the guard works.**
- **A5 + A6 DONE + SHIPPED + committed + pushed 2026-07-21.** See the A5/A6 entries above. All visual punch-list items (A1–A6) are now resolved or deliberately dropped. **The A7 visual audit (web editor + PWA + hub) ran the same day → items A7–A10 below (all LOW polish, none fixed yet).**

> **SCOPING DECISION (Sebastian, 2026-07-21): the Sheet-dialog modal layer is being phased out** — the web editor is the surviving management surface. Modal-cosmetic investment is therefore wasted effort: **A1, A2, A4 DROPPED** (recorded below with their evidence so no future sweep re-derives them); **A3 rescoped to the web surface**; A5/A6 kept (pure web-editor / PWA). Future visual audits scope to **web editor + PWA + hub only** — do not sweep Sheet-dialog chrome.

**A3. [MED] (RESCOPED web-only) Web tools handle unsaved-changes / destructive confirms three different ways — `ManageItems` / `ReorderPickPath` / `StorageAreas` / `HealthCheck` (web editor).** ManageItems has its own styled 3-button guard (`ig-*`, :705-713), ReorderPickPath its own (`rpp-guard-*`, :505-513, built 07-14 explicitly because `window.confirm` is unreliable in the HtmlService iframe) — duplicated markup+CSS+JS, the same drift class #19 centralized for RPCs. Meanwhile StorageAreas still uses the flaky `window.confirm` for BOTH its dirty-close guard (:739) and delete-area confirm (:675), and HealthCheck for its destructive-fix gate (:133) — all four fire on the web surface, where the flakiness was actually observed. → Centralize one guard/confirm dialog in EditorShell (the #19 pattern: shared `mgeGuard3_`/`mgeConfirm_`), converge ManageItems + ReorderPickPath onto it, migrate StorageAreas + HealthCheck off `window.confirm`. This is also groundwork the phase-out wants anyway: shared web chrome living in EditorShell, not per-modal. (RecalibrateVendor's 3 confirms are Sheet-only — out of scope per the phase-out.)

**A5. [LOW] Web-editor radius tokens defined 3× under 2 naming schemes — `EditorShell.html` (`--r:10px/--r-sm:7px`) vs `Setup.html` (`--r:12px/--r-sm:9px` — same NAMES) vs `EditorHome.html` (`--radius:12px/--radius-sm:9px` — different names).** **DONE + FANNED OUT (all 9 + master, `deploy.py --redeploy`, 2026-07-21).** Cascade traced: EditorShell is `include()`d into `<body>` AFTER each page's `<head>` `:root`, so **Setup's `--r:12px` was silently clobbered by EditorShell's `--r:10px`** (Setup actually rendered 10px — its declaration was inert), and **EditorHome used the distinct `--radius` name precisely to dodge that clobber** (genuinely rendering 12px). Fix (zero pixels changed): added a shared **large scale `--r-lg:12px/--r-lg-sm:9px`** to EditorShell's base `:root`; pointed EditorHome at `--r-lg*` (dropped its orphan `--radius` scheme); deleted Setup's dead `--r/--r-sm` redeclaration (now inherits the 10px it already rendered). One naming system, defined once, no same-name collision. *Deferred option (not taken): point Setup at `--r-lg` so its wizard cards match Home's larger radius — honors Setup's declared-but-clobbered 12px intent, but that's a real (tiny) visual change; left pixel-identical.*

**A6. [LOW] PWA vendor badge pair mixes raw + token in one component — `template/index.html` (PWA).** **DONE + SHIPPED (CACHE v38→v39, `build.py` + `git push` → GitHub Pages, 2026-07-21).** `.vend-badge.vb-primary` hard-coded `#1a7a55`/`#e2f6ee` while its sibling `.vb-secondary` used `var(--amber-*)`. Minted fixed **`--green-light:#e2f6ee`/`--green-dark:#1a7a55`** beside the amber pair (same block, commented "NOT concept-themed"; `--teal` re-themes so it's not used) and rewired `.vb-primary` to them (alpha border left raw, matching the amber sibling). Exact same hex values → zero visual change by construction.

### Dropped per the modal phase-out (2026-07-21) — do not re-flag, do not fix

- **A1 (was: HealthCheck.html doesn't `include('Styles')`, hand-rolls ~40 hexes incl. a private pass/warn/fail palette).** True but moot: Styles.html is the *modal* design system and the Sheet dialog is retiring. When HealthCheck's web page gets its `mog-editor-web-reskin` pass, tokenize against the EditorShell web tokens then.
- **A2 (was: semantic state palette in near-miss shades across 6 modals — success ink `#1f6d2a` vs token `#1a6b2e`, 3 success-bgs, 2 warn inks, 3 danger reds vs the Styles trio).** Modal-chrome cosmetics; dropped. If any of these chips survive into web renderings during the phase-out, unify them at reskin time, not as a modal sweep.
- **A4 (was: `--r-control`/`--r-card` referenced 4× vs ~120 raw radii; micro-labels 8–11.5px vs `--fs-label`).** Sheet-modal-layer shape/type adoption; dropped outright.

### Visual sweep — recorded as NOT findings (do not re-flag)

- **Neutral greys raw everywhere** — deliberate (2026-06-04 unification: brand/semantic tokenized, neutral greys left raw). The scanner's ~700 raw-hex hits are overwhelmingly this.
- **Uppercase micro-labels/eyebrows** (`.section-label`, `.day-pill-label`, `.ah-eyebrow`, etc.) — house idiom, blessed by Styles.html's own `--fs-label: 10px; /* caps micro-labels */`. Not casing drift; buttons/actions are sentence case as convention requires.
- **Setup.html concept-theme table (L219-223)** — a DOCUMENTED intentional mirror of `CONCEPT_THEMES` (Dashboard.gs), comment at L215 says so; values verified in sync (RP `#2d8c6b`, ĂN `#3C1124`, TNY `#D4A574`, Lei'd `#b51579`). Watch item: re-verify when adding a concept.
- **`.status.warn` styling for the 07-16 `b1ok` warning** — exists and renders (ManageVendors:206); the raw `#9a2c2c` it uses is folded into A2, not a missing-style bug.
- **AdminReset `.badge-danger`** — already routes through `var(--danger)`/`var(--danger-bg)`; the scanner's ManageVendors/StorageAreas `.btn-danger "NOT via --danger"` lines are parse artifacts (rules setting only radius/inherited color).

---

## Visual-consistency punch-list — audit 2 (2026-07-21 later, items A7–A10)

Second visual sweep, **scoped web-first per the phase-out** (web editor + PWA + hub; Sheet-dialog chrome excluded). The hub (`index.html`) had never been visually audited; the PWA + web-editor got a fuller pass than the A1–A6 sweep (which only itemized what surfaced). **Honest verdict: this layer is mature — everything below is LOW / LOW-MED polish, no correctness issues or misfire hazards.** Scanner raw output in scratchpad; items are the judgment-filtered residue after the standing non-findings (neutral greys raw, uppercase micro-labels, brand/concept data tables).

### Status (2026-07-21, latest) — ALL of A7–A10 DONE

- **A7 (web editor) — DONE + FANNED OUT (all 9 + master, `deploy.py --redeploy`) + committed + pushed 2026-07-21.** Added `--danger: #c0392b` to EditorShell's `:root` (the one web-editor danger red, = Styles.html so tool pages are unchanged); `.mge-err` now uses it; Setup's redundant `--danger:#b3261e` re-declaration dropped (EditorShell, loaded later in `<body>`, always won anyway — the gate + Setup invalid-field red shift #b3261e→#c0392b, an imperceptible red-to-red move that IS the unification A7 asked for).
- **A8 + A9 + A10 — DONE + SHIPPED (PWA CACHE v39→v40, hub sw v7→v8, `build.py` regenerated 8 dirs, `git push` → GitHub Pages) 2026-07-21.** A8: minted a shared 5-token warning-amber ramp (`--warn-fill/-border/-text/-accent/-accent-active`) used by both the recap-stale and override banners, exact current values + the two off-state one-offs consolidated onto the ramp (imperceptible). A9: minted 5 fixed `--status-*`/`--cutoff-orange` tokens for the vendor-card status tints at exact values (kept fixed, not remapped to the themed `--red*`). A10: hub `body` + three radii now reference `--text`/`--bg-mute`/`--r-lg`/`--r-md`/`--r-sm`, and added the missing `--r-sm: 6px` so the hub token set matches the PWA.
- **Gotcha logged:** a bare `replace_all` of `#fef6e0`/`#7a5a13`/`#c08a1a` ran *after* the token defs were added and rewrote them into self-referential `--warn-x: var(--warn-x)` — caught by the post-edit grep, fixed to literals. Lesson: when tokenizing, add the `:root` literal def LAST, or anchor the usage-replacement with a prefix so the def line can't match.

**A7. [LOW] Web-editor "error/danger" red is two shades, and EditorShell has no danger token — `EditorShell.html` `.mge-err` (`#b3261e`), `Setup.html` `--danger:#b3261e`, vs the A3 dialog + tool pages at `#c0392b` (web editor).** The web token set (`--web-accent*`, `--muted`, `--faint`, `--r*`) has **no danger token**, so `.mge-err` hard-codes `#b3261e`; the shared A3 `.mge-dlg-danger` uses `var(--danger, #c0392b)` (gets `#c0392b` from Styles.html on tool pages, the raw fallback on EditorHome). Two similar-but-different reds for the same "danger" meaning across the surviving surfaces. → Add one `--danger` (or `--web-danger`) to EditorShell's `:root`; route `.mge-err`, `.mge-dlg-danger`, and Setup's `--danger` through it. **value LOW, confidence high.**

**A8. [LOW-MED] PWA warning banners hand-code a gold ramp instead of the `--amber-*` tokens — `template/index.html` `.recap-stale-banner` + `.override-banner` (~L419–475) (PWA).** Both prominent "warning" banners use raw `#fef6e0/#f0c97a/#7a5a13/#c08a1a/#9c6e10/#d9b463/#8a6d1a` — a 5-stop gold ramp that is (a) un-tokenized and (b) a different gold from `--amber-light/mid/dark`. If the amber palette ever moves, these two banners won't. → Either extend the amber ramp in `:root` (e.g. `--amber-bg/-border/-btn/-btn-active`) and reference it, or keep raw with a comment. Not a clean 1:1 (5 stops vs 3 tokens), so it's a small design call, not a mechanical swap. **value LOW-MED, effort LOW.**

**A9. [LOW] PWA vendor-card status colors partly raw — `template/index.html` (~L637–674) (PWA).** `#fde4e4 /*soft red*/`, `#f5c2c2`, `#f0d9a8`, `#ed8936` (orange edge bar), `#fbecec` are hand-coded on the vendor-card status rules rather than drawn from `--red*`/`--amber*`. → Map the ones that match existing tokens; mint a token for the orange edge bar if it's a distinct semantic (it doesn't match amber or red). **value LOW, confidence high.**

**A10. [LOW] Hub body + a few radii hard-code values that duplicate the hub's own tokens — `index.html:25-26` (body) (hub).** `body { color:#1f1e1b; background:#ebe9e0 }` exactly equal `--text` / `--bg-mute` declared in the `:root` right below; a few raw `10px`/`14px` radii duplicate `--r-md`/`--r-lg`. Pure hygiene — the tokens exist, they're just not referenced here. → Point body + those radii at the vars. **value LOW, confidence high.**

### Audit-2 recorded as NOT findings (do not re-flag)

- **PWA `.cta-danger` / `.danger` "NOT via --danger" (scanner) — false positive.** The PWA's danger token IS `--red` (semantic, re-themed per concept: RP `#F0532F`, base `#A32D2D`); both selectors route through `var(--red)`. Correct by the PWA's own convention.
- **PWA `.recipient-remove` → `var(--text-3)` (muted grey), not red — deliberate.** It's a low-emphasis text "remove" link in a list, not a destructive CTA; muted is the intended weight.
- **Hub has no `--r-sm` — not a gap.** It never references `var(--r-sm)`; the PWA's `var(--r-sm,6px)` hits are the PWA (which defines it). Nothing to add.
- **Hub concept-tint table (`CONCEPT_VISUALS`) + inline HEH logo SVG hexes — brand data, intentional** (same class as Setup's `CONCEPT_THEMES` mirror). Verify tints when adding a concept.
- **`theme-color` `<meta>` hexes (PWA `#0F6E56`, hub `#fc0404`) — raw by necessity** (a `<meta>` can't read a CSS var). Not drift.

**Deploy note for A7–A10 when worked:** A7 = web editor → `deploy.py --redeploy` (canary rpfrf). A8/A9/A10 = PWA + hub → `build.py` (A8/A9 need a CACHE bump; hub A10 bumps the hub `sw.js`) + `git push`.

---

## Recorded as NOT findings (do not re-flag)

- **EditorShell.html "5 `google.script.run`" (scanner lens 1) — false positive.** 3 distinct auth/dispatch paths that never co-fire on load: `editorPing` (validate-first gate), `editorAuth` (PIN submit), and the generic `webedit_call` inside the `mgeRpc_` Proxy. Not a fan-out.
- **RecalibrateVendor.html "2 calls" — false positive.** A read (`loadVendor`) + a save (`doSave`), not two reads on open; Sheet-only, outside the web-editor surface.
- **Vendors.gs:181 `setValue` — false hit.** One-shot write per `commitAddVendor`; the loop above only scans in-memory values.
- **Vendors.gs:308 / Health.gs:86-92 per-vendor B1 reads — inherent, not batchable.** B1 lives on a different sheet per vendor; O(vendors) one-read-each is unavoidable.
- **8 `maybeAutoStart*Tour_` functions defined-but-uncalled — deliberate.** The documented re-enable lever for per-tool tours (2026-06-26 "tours replay-only"). Keep; delete only if per-tool tours are permanently abandoned.
- **`auditVendorTabStructure` / `auditVendorCadence` / `reestablishVendorTemplate_` orphaned from menus — deliberate.** Kept editor-runnable per the 2026-06-01 decision. Do NOT delete.
- **ES6 in modal `<script>` blocks — non-issue.** Modals render browser-side in an IFRAME sandbox (invariant #4); the Rhino scanner's ~7,000 lines of "violations" are all false positives here.
- **Verified correct (07-14 changes):** `computeSuggestedQty_` faithfully matches the old col-F formula (`Math.ceil≡ROUNDUP`, all blank cases → null); Tier-3 hot paths build one shared read ctx (no per-vendor MASTER/SETUP re-reads); no leftover col-A/col-F reads; `#19` shim genuinely centralized (thin one-line delegates, no stale allowlists); `webeditDispatch_` has no orphan cases; no on-open double-fetch; `fixVendorHeaders_core_` bumps the mutation ts only when it fixes something; `parPct_` is div-by-zero guarded; `uiIsInteractive_` gate intact; CACHE v35 synced template + all 8 dirs; `build.py`/`deploy.py` fail loud.

## Known pre-existing carry-forward (not counted here)

- **#24 MOGApi.gs split → `Recap.gs` + `Admin.gs`** (pure code-motion) — already on the backlog from the 2026-07-12 audit; use `appsscript-decompose-file`. Not re-numbered.

---

*Progress: items #1–#16 closed and shipped 2026-07-16. The 2026-07-21 re-sweep (code + first visual audit) opened #17–#18 (code, both LOW) and A1–A6 (visual); A1/A2/A4 were then DROPPED per Sebastian's modal phase-out decision (Sheet-dialog layer retiring — see the scoping note above). Open: #17 + #18 (a 10-minute batch: one `--redeploy` + one push-only) and A3 (rescoped web-only, the biggest UX win) + A5/A6 (ride-alongs). The next code audit continues at #19, the next visual audit at A7 and scopes to web editor + PWA + hub only; re-sweep only areas whose `last_swept` is behind HEAD.*
