# Session Handoff — Full two-layer audit + fix marathon (data-loss, UX, perf, locking)

**Session date:** 2026-07-12
**Session focus:** Run a full codebase audit, then work the punch-list: quick wins autonomously, then the ranked findings one by one with Sebastian approving each.
**Outcome:** 10 commits (`2db6a5b`→`9be8d4a`), ALL deployed to all 9 + master (multiple `deploy.py --redeploy` fan-outs, canary rpfrf each round) and pushed to GitHub Pages (CACHE v30→**v35**). Every audit finding is now closed except two deliberately-parked refactors (#19 MIRPC centralization, #24 MOGApi split) and a few cosmetics. All three data-loss-class bugs fixed and verified.
**Next session focus:** Sebastian runs the 7 remaining store backfills (now one click in each store's web Health Check); then #19/#24, Tier-3 remainder, or the deferred cosmetics.

---

## Section A — The audit (how this session started)

Two-layer audit per `appsscript-codebase-audit` + `mog-pwa-audit`, executed as three parallel read agents (backend .gs / modals / PWA) + deterministic scans (i18n parity 12/12 PASS, pwa_scan clean, deploy-infra cross-checks all clean). Produced a ~25-item ranked punch-list; top findings were **two backup-row data-loss bugs** in pick-path rewrite paths that predated multi-vendor, plus a PWA reset-path gap and an offline-queue race. Notable clean areas: web-host RPC allowlist (all 22 names), XSS escaping, DOM-id rot, the read auto-retry's write-safety. The audit also found the "Assign-tab close-modal guard" carry-forward was **already implemented** — retired from CurrentState.

## Section B — Audit quick wins (`2db6a5b`, `bae0fd1`, `534a29f`)

~25 mechanical fixes across all three layers, shipped autonomously (Sebastian pre-authorized): reverted "reference-only" wording fixed in operator-facing alert + docstrings; mutation-ts bumps added to `savePickPathSilent_` and the in-sheet Emergency Override toggle/on-open reset; dead code deleted (`commitDeactivateItem`, `countActiveItemsForVendor_`, `MOG_COL`, 6 dead i18n key pairs, `MGE_MODE`/`mgeTourActive_`, duplicate `id` attrs, orphaned `#stale-error`); every escaper now escapes single quotes; ~10 i18n leaks keyed EN/ES; Assign-tab re-click no longer wipes pending edits; `doAdd` carries `storageArea`; PIN screen uses `isNetworkError_`; missing `.cta-primary` CSS defined; `T.titles.history` added; stale comments batch-fixed; template-missing messages point at the Health Check fix (old menu entry was removed 2026-06-01); VendorCadenceAudit's `setLang` clobber defused.

## Section C — Manual reset button removed (`ba517fe`, CACHE v32)

Sebastian's call: the home-screen `hero-reset` button (full log+clear+recap behind a confirm) was redundant friction — the new-day reset has auto-run without prompting since `bf05d0a`. Removed the button, `onHomeResetClick`, 7 orphaned i18n key pairs, and its CSS. **The Sheet dashboard's Reset On Hand checkbox is now the only manual reset path** (admin-side, deliberate).

## Section D — Multi-vendor hardening (`c3ec600`, `147403f`, `ba8619d`)

- **Backup pick rows survive the legacy Sheet tools** (`c3ec600`): `rebuildAllPickPaths_` (the purge's tab rebuild) is now **DB-driven** — each vendor's roster rebuilds from its OWN pick rows (primary AND backup), names refreshed from MASTER, inactive dropped, removed-vendor leftovers passed through; the old MASTER-primary-filter roster silently deleted every backup placement (would have undone "Place Backup Vendors on Tabs"). `savePickPathSilent_` (SETUP working-list onEdit auto-save) scopes deletions to `listedIds` from `buildPickPathRows_` — the working list is primary-only by design, so backups it never shows now survive. Canary: manufactured backup row survived both the purge and an in-sheet area save.
- **Health Check maintenance fixes** (`147403f`): two new checks with one-click web fixes — **Backup vendor placement** (dry-runs `syncEligibleVendorsToPickPath_core_(true)` to count missing placements; Fix runs the backfill) and **PIN lockout** (shows minutes remaining; Fix clears via new `clearPinLockout_core_`). **Store backfills are now web-doable per store — no Sheet needed.** (Lockout fix requires an already-authenticated editor session; a locked-out phone can't reach it.)
- **Reassign = promote** (decision, `147403f`): the Edit-form "Reassign to Vendor" now keeps the old primary as a secondary (same semantics as Make-primary) — `commitUpsertItem` unions the old primary into the eligible list when col C changes. Primaries swap week-to-week on price/stock; dropping a vendor entirely = uncheck it in a follow-up edit. Bilingual hint added under the dropdown.
- **Vendor cards show backup counts** (decision, `ba8619d`, CACHE v33): card meta reads `12 items · +5 backups` (suffix only when backups exist, EN/ES singular/plural); "entered X / Y" denominator = primaries + backups (can't overflow on B&T); new `countBackupItemsByVendor_` (one pick-DB scan), `readMasterItemMeta_` gained the col-L `active` flag; `dashboardsDiffer_` compares the new counts; graceful with payloads lacking `backupCount`.

## Section E — Offline-queue vs auto-reset race (`cfda07b`, CACHE v34)

Last data-loss-class bug: counts queued offline raced the new-day auto-reset — reset-wins wiped them unlogged; drain-wins-late wrote yesterday's counts onto the fresh cycle. Fix: `drainSaveQueue_` exposes its **in-flight promise** (a second caller JOINS the running drain — the old boolean guard made awaiting a no-op), and `runStaleReset_` awaits the drain before `commitReset`, so previous-cycle counts reach the sheet before it's logged and cleared. Network failure → both fail together → Refresh screen with queue intact.

## Section F — Perf batch + locking (audit #13–18; `cb68e36` CACHE v35, `9be8d4a`)

- **#13**: cold count-open fired two concurrent `getVendorItems` (persisted-cache background kick + revalidate force). Any caller — including forced — now joins an in-flight server fetch via `inflightVendorFetches`. Stale-while-revalidate UX byte-identical (instant paint, one background update; Sebastian explicitly confirmed that behavior must survive).
- **#14**: `api_getVendorItems_(payload, ctx)` gained an optional **all-or-nothing** shared read context; `buildRecapSections_` builds it once — a recap/email went from ~5 redundant range reads × N vendors to 5 total. Single-vendor callers pass nothing.
- **#15**: `getManageItemsBootstrap` also returns `areas` + `vendorTable` (server cache key v3→v4); ManageItems dropped its separate `getStorageAreaList`/`getVendorTableData` open calls and its client cache stores the extras (key v3→v4) — **cache-hit opens = 0 RPCs, cold = 1** (was 2 Sheet / 3 web). Old server fns kept (additive-only; other modals use them).
- **#16**: edit-with-area saves do ONE full-MASTER read (was 3) — `commitPickPathAreaAssignment` takes `opts.itemName`, `syncItemEligiblePickRows_` takes ctx `{name, primary, eligible}`; the ctx eligible is the freshly-written list (correctness-critical — never a pre-edit read).
- **#17**: `commitSetVendorItems` reads one A:O block (was 5 column reads); `buildPickPathRows_` batches its ID backfill into one column write.
- **#18**: new **`withPickDbLock_`** (Core.gs) — `LockService` document lock, **reentrant per execution via a depth counter** (executions are single-threaded, so the counter is race-free and sidesteps LockService's murky re-acquire semantics). Wraps every pick-DB read-modify-write ENTRY POINT (six item/vendor commits, Shelf-to-Sheet, Areas draft, purge + place-backups cores, both onEdit paths, add-vendor cleanup); inner helpers stay unwrapped (callers hold the lock); dry-run place-backups skips it (read-only). Convention documented at the helper.

## Outstanding (carry forward)

- **Run the backfill on the 7 remaining stores** (only rpr done): each store's web editor → Maintenance → 🩺 Store Health Check → Fix on the *Backup vendor placement* row. Now safe in any order — the purge can no longer undo it.
- **#19 (MED)**: centralize the copy-pasted `MIRPC()`/`webHandleFail`/`editorClose` shim (6 modals, hand-maintained fn lists, bodies already diverging) into EditorShell.
- **#24 (HIGH, ride-along)**: MOGApi.gs split — recap+recipients → `Recap.gs` (~700 lines), setup/admin/tests → `Admin.gs` (~500). Pure code-motion, same discipline as the 2026-06-19 split.
- **Deferred cosmetics from the audit**: EN/ES toggle kicks the user out of an OrderHistory detail; ReorderPickPath's 2-way unsaved-changes `confirm` has no "stay" option (vs ManageItems' 3-button popup); EditorShell's "checking" gate state renders blank (add a card); `api_getVendorItems_` could narrow its A:M read to E:M (index-math change on the hot path — do it with care).
- **Tier-3 remainder** (pre-existing): move `snapshotVendorOrders_` / `vendorOnHandSnapshot_` off the vendor-tab col-A/F formula reads (heavier canary: run a reset on rpfrf, diff log + recap); sync the in-Sheet H2 formula to next-delivery override (accepted divergence).
- **Pre-existing carry-forwards unchanged**: Claude-SKills mirror commit; ManageVendors "Advanced" disclosure (gated on cadence audit); hub brand SVGs; Batch D.
- **Live-verify note**: everything was canaried on rpfrf per round, but the #16–18 batch's four-flow canary (edit-with-area, Assign save, Shelf-to-Sheet, Areas save) was approved by Sebastian without an itemized report back — worth a casual eye during normal use.

## Files touched this chat

- **Backend (.gs, all deployed all 9 + master):** `MOGApi.gs` (quick wins, backup counts, recap ctx, lockout core), `Items.gs` (quick wins, dry-run backfill, promote semantics, bootstrap extras, #16/#17, lock wraps), `PickPath.gs` (backup-row fixes, #16 opts, #17 batch write, lock wraps), `Core.gs` (mutation-ts bumps, `withPickDbLock_`, onEdit lock wraps), `Vendors.gs` (comments, cleanup lock wrap), `Health.gs` (2 checks + 2 fixes), `History.gs`/`Dashboard.gs` (comment fixes).
- **Modals (.html):** `ManageItems.html` (guards, i18n, hint, bootstrap consolidation), `ManageVendors.html`, `RecalibrateVendor.html`, `OrderHistory.html`, `ReorderPickPath.html`, `HealthCheck.html`, `VendorCadenceAudit.html`, `EditorShell.html` (escapers, dead code, small fixes).
- **PWA:** `template/index.html` (reset-path fixes, button removal, queue join, fetch dedupe, backup-count cards, i18n), `template/sw.js` (CACHE v30→v35) + all 8 generated store dirs via `build.py`.
- **Docs:** this handoff, `CLAUDE.md` @-import, `docs/MOG_CurrentState.md`.

## Commits landed this session

```
9be8d4a perf+safety: dedupe item-save MASTER reads, batch bulk reads/writes, lock pick-DB writers
cb68e36 perf: dedupe count-open fetch, share recap reads, one-RPC Manage Items open (CACHE v35)
cfda07b fix(pwa): flush offline-queued counts before the new-day auto-reset (CACHE v34)
ba8619d feat(pwa+api): vendor cards show backup counts; progress uses full roster (CACHE v33)
147403f feat(editor/api): health-check maintenance fixes + reassign-promotes semantics
c3ec600 fix(api): pick-path rewrites preserve backup-vendor rows (purge + in-sheet area save)
ba517fe feat(pwa): remove the home-screen manual reset button (CACHE v32)
534a29f fix(pwa): audit quick wins - manual reset timeout, network-error messages, i18n, cta-primary (CACHE v31)
bae0fd1 fix(editor): audit quick wins - assign-tab reclick guard, i18n leaks, escaper hardening, dead code
2db6a5b fix(api): audit quick wins - orderable-backup wording, mutation-ts bumps, dead code, stale comments
```

## Opening prompt for next session

```
Read docs/MOG_CurrentState.md first. Last session (2026-07-12) ran a full
two-layer audit and closed nearly all of it: 10 commits, all on all 9 + master,
PWA at CACHE v35. All three data-loss bugs are fixed (backup pick rows survive
the purge and in-sheet saves; offline-queued counts flush before the auto-reset),
pick-DB writers are serialized under withPickDbLock_, the manual reset button is
gone (auto-reset only), Reassign-to-Vendor promotes (old primary stays a backup),
vendor cards show "N items · +M backups", and Manage Items opens on 0-1 RPCs.

FIRST: if not yet done, run the backup backfill on the 7 remaining stores —
each store's web editor → Maintenance → Store Health Check → Fix on "Backup
vendor placement" (rpr already done; safe in any order now).

Candidate directions: #19 centralize the MIRPC shim into EditorShell; #24 the
MOGApi.gs split (Recap.gs + Admin.gs, pure code-motion); the Tier-3 remainder
(snapshotVendorOrders_/vendorOnHandSnapshot_ off vendor-tab formulas — needs a
reset canary on rpfrf); or the deferred cosmetics list in the 2026-07-12
handoff. Canary rpfrf; the web app (/exec) is the PRIMARY surface → ALWAYS
deploy.py --redeploy.
```
