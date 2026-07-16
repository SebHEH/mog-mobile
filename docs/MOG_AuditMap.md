# MOG — Audit Map & Optimization Punch-List

Resumable audit manifest (per `codebase-audit-method`). Each area records the commit it was last swept at, so a later audit only re-reads what changed. The punch-list numbers **continue across audits**; refuted/dropped findings stay recorded so they're never re-flagged.

**How to resume:** pick the lowest open item number below, or re-sweep an area whose `last_swept` is behind `HEAD`.

---

## Area manifest

| Area | Files | last_swept | Verdict |
|---|---|---|---|
| Backend — core/order/reset/dashboard/recap | `Core.gs`, `ResetLog.gs`, `Dashboard.gs`, `MOGApi.gs` | `a08ca2b` (2026-07-16) | Clean; minor drift/dead-code |
| Backend — vendor/items/pickpath/history/health | `Vendors.gs`, `Items.gs`, `PickPath.gs`, `History.gs`, `Health.gs` | `a08ca2b` (2026-07-16) | Clean; drift + 1 verify |
| Web editor + modals | `Editor.gs`, `EditorShell.html`, `EditorHome.html`, all dual-host `*.html` | `a08ca2b` (2026-07-16) | Essentially clean (post-#19) |
| PWA + deploy infra | `template/index.html`, `template/sw.js`, `build.py`, `deploy.py`, root `index.html`/`sw.js`, `stores.json` | `a08ca2b` (2026-07-16) | Clean; 1 real bug |

Context: the codebase was deep-audited 2026-07-12 (11 commits) and again touched 2026-07-14 (8 commits). This sweep therefore concentrated on the 07-14 changes (Tier-3 formula→code, par-review overhaul, #19 RPC-shim, B1 fix/Health Check). The thin result set is expected.

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

*Progress: ALL 16 findings (#1–#16) closed and shipped on 2026-07-16. Audit complete — nothing open. The next audit continues numbering at #17 and re-sweeps only areas whose `last_swept` is behind HEAD.*
