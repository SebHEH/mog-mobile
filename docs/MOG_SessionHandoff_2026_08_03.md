# Session Handoff — Order-math alignment + PWA cycle gate (and a perf batch that got parked)

**Session date:** 2026-08-03
**Session focus:** Started as "investigate a screenshot that disagreed with the recap email," became a full order-math audit, then a PWA performance push, then an incident hunt on Roll Play Tysons BOH.
**Outcome:** Two commits shipped and pushed (`fb89ac5` order math, `efe75c7` PWA gate + timeouts). A four-part perf batch was built, differential-tested, deployed, then **deliberately reverted and parked in `stash@{0}`** after rpt failed its reset — the hunt proved the reverted code was NOT at fault, but the revert stands until a clean morning reset confirms the baseline. Four repo skills enhanced, one global proposal filed, blueprint bumped.
**Next session focus:** Re-land the parked perf work (`git stash pop`), then the per-vendor Emergency Override day picker (design approved, four decisions recorded below).

---

## Section A — Order-math alignment (SHIPPED, `fb89ac5`)

The trigger: BOH shift leads screenshotted the PWA review screen and the numbers didn't match the recap email or history. Traced **every** site in the repo that produces a number. Five real divergences:

1. **A restored draft was displayed but never saved.** Every keystroke writes a localStorage draft, and `openCount` merges it back on reopen — but `flushDirtyToServer` builds its payload from `ctx.dirty` alone, and `ctx.dirty` was **never seeded from the draft**. So after an app kill the KM saw their counts, approved them, and nothing reached the server. This is the reported bug. Fixed by seeding `ctx.dirty` for any drafted value that differs from the server's.
2. **`revalidateCountItems_` dismissed a changed `par`/`targetPar` as a "metadata-only diff"** and skipped the re-render, so a mid-cycle par edit left the count screen computing off stale math.
3. **`api_getVendorItems_` built `targetPar` without the `dayMult > 0` term** that `computeSuggestedQty_` gates on, so a `useMult=false` item on a non-delivery day showed a PWA quantity the email and log never recorded.
4. **`computeSuggestedQty_` over-ordered by one unit on float noise.** A bare `Math.ceil` on `par × mult − onHand`: a shortfall of exactly 1 in decimal computes as `1.0000000000000002` and ceils to 2. **~0.8% of realistic decimal par/on-hand combinations**, always over, never under.
5. **`ppCeil_` (par preview) and the PWA's `ceilQty_`** now use the same expression, so all three code ceils agree with each other and with the sheet.

**The rounding fix went through two iterations and the second one matters.** My first attempt rounded to 3 decimals before ceiling — Sebastian pushed back that orders must always round up, never down, and he was right: a fixed decimal round shaves a *genuine* `1.0001` down to 1. Switched to an epsilon (`Math.ceil(x - 1e-9)`), which cancels float noise while preserving every real fraction.

**The sheet was never wrong — the code was the outlier.** Owner-verified live: `=ROUNDUP(4.2-2.2,0)` returns **2** in Sheets, because Sheets applies ~15-significant-digit final-result cleanup. So col F has always been right and the code had drifted from it. I had earlier flagged col F as carrying the same exposure; **that was wrong and is retracted** — there is nothing to fix on the vendor tabs.

Verified across **2.27M** par/multiplier/on-hand combinations against exact integer-scaled decimal arithmetic: zero under-orders, zero over-orders, zero client/server mismatches.

## Section B — Perf batch (BUILT, DEPLOYED, then REVERTED — now `stash@{0}`)

All four were differential-tested against the previous implementations before deploying, and all were output-identical. **None of it is deployed.** Re-land with `git stash pop`.

- **History readers** (`History.gs`): new `readLogSlice_` bounds the read to rows that can match the date filter by first scanning only the order-date column — and deliberately assumes **nothing** about the log being chronological (a scattered match just widens the span; worst case degrades to the old full read). Memoized date formatting, because `Utilities.formatDate` was called once per row *per column* to resolve a handful of distinct dates. Lazy pack map so the dates/vendors tiers stop reading all of `MASTER_ITEMS` for a field they never surface. On ~8.6k rows: `getHistoryDates` 60,743 → 24,273 cells and **17,295 → 312** formatDate calls; single-day tiers −85% cells, −99% formatDate. Also removed a duplicate MASTER read in the detail tier.
- **Dashboard** (`getTodaysLogByVendor_`): read the entire log to find today's rows, inside `api_getDashboard_compute_` — whose cache *every* `saveOnHand` invalidates, so a KM counting re-read the whole order log on nearly every save. Sliced to today. −85% cells, −98% formatDate. Its date parsing is deliberately kept local (`substring` vs `new Date()`) because the shared formatter handles odd values differently.
- **Unified reset sweep** (`buildOrderCycleSnapshot_`, replacing `snapshotVendorOrders_`): one sweep via `api_getVendorItems_` instead of the snapshot and the recap each building their own read context and sweeping every vendor tab separately to compute the same numbers from two reads taken at two different moments.
- **Override recap-filter fix** (correctness, not perf): `buildRecapSections_` filtered vendors on the **raw** today multiplier while the order log used `vendorDayMultiplier_`, which is Override-aware. So with Override on, a vendor was counted, priced, written to history — and **silently dropped from the recap email and the in-app full order list**. Proven no-op with Override off; with Override on the test showed the log carrying `Alpha, Beta, Delta, Gamma` while the old email sent only `Alpha, Gamma`.
- **Async recap** (`scheduleRecapSend_` / `sendPendingRecap_` / `buildRecapFromLog_`): the recap moved off the KM's critical path to a one-shot trigger, rebuilt from the rows just logged. Makes the email *derived from* history, so they cannot disagree by construction. Bounded retry (3 attempts, still at most one delivered email per cycle) — required, not a bonus, since async removed the KM's feedback loop. Inline fallback if the trigger can't be armed, deliberately placed **above** `resetAllVendorOnHand_` because that builder reads live on-hand. Plus editor-only `test_recapFromLogToSelf()`. **This ran successfully in production once** (rpt, Sheet-trigger path, email delivered 1:14pm).

## Section C — The rpt incident (root-caused; fix SHIPPED as `efe75c7`)

rpt's PWA hung on load, never showed the reset bar, then landed on "Offline — using last loaded data" with a failing retry and **Sunday's** vendors. It cost a long hunt and three of my hypotheses were wrong, so the reasoning is worth recording.

**What it was NOT.** I built a temporary read-only `?page=diag` route on `doGet` (unauthenticated, so no PIN needed) to reproduce the exact web-app execution context the Apps Script editor can't. Every read helper passed, every symbol was present in the deployed snapshot, **`ScriptApp` trigger creation worked** (2→3 triggers, cleaned back to 2), and a full guarded `commitLogAndReset` **completed in 25.85s with no exception**. The reset code was fine.

**What it was.** The client was giving up on healthy responses. Measured on rpt (11 vendors), inside a real web-app execution:

| Work | Duration |
|---|---|
| bare `/exec` execution floor | ~2s |
| dashboard read set, cold cache | 8–15s |
| full `commitLogAndReset`, nothing to log | **~26s** |
| same, doing real work | ~31s |
| first request after any `--redeploy` | up to 20.1s |

`API_TIMEOUT_MS` was **15s** and `RESET_TIMEOUT_MS` **45s**. My fan-out minutes earlier had flushed `CacheService`, so the run was fully cold. An abort is classified by `isNetworkError_` as offline, so a slow-but-successful call rendered as "Offline" with a retry that failed identically — while Apps Script kept executing and finished.

**Sebastian's diagnosis beat mine, and it found the real bug.** He pointed out the PWA shouldn't show vendors at all if the cycle date doesn't match — it should gate. Both boot paths called `showMainApp()` from their `catch`, so an unconfirmed status check dropped the KM into the app on the **previous cycle**, visually identical to a normal day, where counts get logged under the old cycle date. That's now `gateOnUnconfirmedCycle_`, with an explicit user-chosen "work offline" escape shown only when cached data exists. The gate is deferred until the transition animation finishes — rendering it under the z-80 bar is why the Refresh button read as "flat."

Timeouts raised: `API_TIMEOUT_MS` 15s → 30s, `RESET_TIMEOUT_MS` 45s → 120s. `CACHE_VERSION` v41 → v42.

**Two reading errors of mine, recorded so they aren't repeated:** (1) `doPost` catches exceptions and returns `{ok:false}`, so **"Completed" in the Executions list does not mean the call succeeded** — I used a Completed row to rule out my own code. (2) The `Failed` rows were `TABNAME`/`SHEETGID` **custom functions** contending with the long reset, a symptom rather than a cause.

## Section D — Skills + blueprint

Mining run (mog backfill — the incremental stamp had never covered this repo). Four repo skills enhanced in place:

- **`mog-exec-repoint`** — new **first** diagnostic branch ("did the CLIENT give up on a healthy response?") with the measured baselines above; its old Step 1 only split single-store-rot vs global and pointed me at cutting a fresh deployment. Plus new sections on reading the Executions list without being misled and the `?page=diag` technique. Description rewritten so it triggers on the timeout case.
- **`mog-deploy-workflow`** — the `CacheService` flush was documented for editor tokens only; added the read-cache half (first request per store is a cold full recompute → can look like an outage; don't fan out into a reset window).
- **`mog-sheet-formula-verify`** — Sheets arithmetic ≠ JavaScript arithmetic; epsilon not decimal-round; the PWA is a third implementation of the same rounding. Fixed stale content (step 5 still called the Override H2 divergence permanent — closed 07-24).
- **`mog-pwa-audit`** — two new finding categories (fail-open boot paths incl. the z-80 overlay gotcha; client timeouts vs measured server work). Fixed stale "`CACHE_VERSION` currently v8".

Global proposal filed (**not** applied locally, per governance): **`appsscript-refactor-equivalence`** — proving a *rewrite* preserves behavior via a ported Node differential harness. Uncovered today: `appsscript-decompose-file` owns code motion (byte-exact, fails by definition on a rewrite), `mog-sheet-formula-verify` owns sheet→code. Mailbox: `appsscript-refactor-equivalence-2026-08-03.md`.

**Blueprint bumped** (`current_as_of` → `efe75c7`): **R4** refined with the real-vs-phantom-shortfall rule and why a rebuild on another stack must guard where a spreadsheet engine doesn't; **new R13a** — never let anyone order against a cycle you could not confirm. HTML regenerated.

---

## Outstanding (carry forward)

1. **Re-land the parked perf work** — `git stash pop`, then `python deploy.py --redeploy --target rpr` (or the canary of the day), smoke-test, fan out. Prefer doing this **after** a clean morning reset confirms the current baseline, and **not** immediately before a store's ordering window (the fan-out flushes every store's cache). All four pieces were differential-tested; the revert was precautionary, not a defect.
2. **Per-vendor Emergency Override day picker** — design approved, not built. The flaw: the multiplier encodes *how many days this delivery must cover*, derived from the next scheduled arrival. Override guesses that from the normal schedule, which is exactly what's abnormal in an emergency. Concretely: a vendor delivering Fri + Sat gives `mults[Thu] = 1`, so a Thursday order for Friday arrival is sized to last until Saturday — and if Saturday is cancelled it must last until the next real delivery, 7×. **Override cannot even express this today** (it only engages when today's multiplier is 0). Fix shape: a row of quick-tap buttons per vendor asking **"when is their next delivery after this one?"**, then `multiplier = days from tomorrow up to (not including) that day`. Four decisions recorded: **per-vendor** state (SETUP column, not the store-wide `AD2`); **no** "other day" escape hatch yet; choice **clears each cycle**; the in-Sheet **H2 must follow** (the sheet isn't being phased out yet), which means re-touching the formula that was aligned on 07-24.
3. **Custom-function cleanup** — `TABNAME()` sits in `I1:K1` on every vendor tab and `SHEETGID(A6)` in ORDER_ENTRY B6+ (one per vendor row). They're recomputed on every recalculation, each reaching into `SpreadsheetApp`, and they hit 60s DEADLINE_EXCEEDED *during* the reset. Both values are static — a tab's name and a sheet's GID never change — so the dashboard builder could write them once as plain values. Real contention, not cosmetic.
4. **Vendor switching** — still the biggest unaddressed speed complaint. `prefetchTodaysVendors_` warms **one vendor at a time**, each paying the full ~2s floor, so 8 vendors is ~20s before everything is warm and tapping early means a cold wait. Fix: a bulk endpoint using the shared-ctx pattern `buildRecapSections_` already proves. Watch payload size, and note it makes the first load slower to make every subsequent tap instant.
5. **The reset's remaining ~26s is not tuning-addressable.** It's one range read plus one clear-write per vendor tab; neither batches across sheets. The parked unified sweep already removed a duplicate pass. Going meaningfully below needs a different approach.
6. **BCC recap** — Sebastian chose it when the send was blocking. Async removes the reason (nobody waits) and per-recipient sends keep bounce isolation, so it's now optional. His choice stands if he still wants it; ~5 lines.
7. **Next audits** — code resumes at **#20**, visual at **A11**. `docs/MOG_AuditMap.md` is the manifest, all areas stamped `8a8de37`.
8. **Tier-2 `onboard.py`** — still designed-and-approved but unbuilt (Section D of the 07-29 handoff). `mog-add-store/SKILL.md` is stale independent of it.
9. **tnytf's old orphaned deployment** — still needs a manual archive on its pre-05-26 script project.

## Files touched this chat

**Shipped source:** `template/index.html` (order-math `ceilQty_` + draft-dirty seeding + revalidate diff + gate + timeouts), `template/sw.js` (v41 → v42), `apps-script/MOGApi.gs` (`computeSuggestedQty_` epsilon, `targetPar` gate), `apps-script/ManageItems.html` (`ppCeil_`), the 8 generated `<slug>/` dirs.
**Parked in `stash@{0}`:** `apps-script/History.gs`, `apps-script/MOGApi.gs`, `apps-script/Recap.gs`, `apps-script/ResetLog.gs`.
**Docs:** this handoff, `docs/MOG_CurrentState.md`, `docs/MOG_LogicBlueprint.md` + `.html`, `CLAUDE.md` (@-import).
**Skills:** `mog-exec-repoint`, `mog-deploy-workflow`, `mog-sheet-formula-verify`, `mog-pwa-audit`; `~/.claude/skills/_global-skill-proposals/appsscript-refactor-equivalence-2026-08-03.md`; `~/.claude/skills/_session-mining-log.md`.
**Deploys:** many rounds. Final state — **all 9 + master on `fb89ac5`** (the perf batch reverted off), diagnostic route removed, 8/8 stores health-probed. PWA pushed at `efe75c7`.

## Commits landed this session

```
efe75c7 fix(pwa): gate on an unconfirmed cycle instead of failing open; raise timeouts
fb89ac5 fix(order-math): align every quantity calculation across PWA, email, log and sheet
```

## Opening prompt for next session

```
Read docs/MOG_CurrentState.md first. Last session (2026-08-03) shipped two commits: fb89ac5
aligned every order-quantity calculation across the PWA, email, log and sheet (five
divergences, including a float-noise ceil that over-ordered by one unit on ~0.8% of decimal
pars — guarded with an epsilon, NOT a decimal round, because orders must never round down;
the in-Sheet ROUNDUP was never wrong, the code was the outlier). efe75c7 made the PWA GATE
on an unconfirmed cycle instead of failing open into the previous day's vendors, and raised
API_TIMEOUT_MS to 30s / RESET_TIMEOUT_MS to 120s from measured numbers (cold dashboard
8-15s, full reset ~26-31s on an 11-vendor store, first request after a --redeploy up to 20s).

FIRST THING: a four-part perf batch is parked in stash@{0} — history reader slicing,
dashboard log-read slicing, a unified reset sweep, and an async recap rebuilt from
LOG_ORDERS (plus an Emergency-Override recap-filter correctness fix). All differential-tested
and output-identical; it was reverted precautionarily during an incident that turned out NOT
to be its fault. `git stash pop`, canary, fan out — but not right before a store's ordering
window, since the fan-out flushes every store's CacheService.

Then: the per-vendor Emergency Override day picker (design approved, four decisions recorded
in the 08-03 handoff — per-vendor SETUP state, clears each cycle, no escape hatch yet, H2
must follow). Also open: the TABNAME/SHEETGID custom-function cleanup (they hit
DEADLINE_EXCEEDED during resets and both values are static), and vendor switching, which is
still the biggest speed complaint (sequential prefetch).

Backend = deploy.py --redeploy, canary rprfo (editor canary rpfrf); PWA = build.py + CACHE
bump + git push. Do NOT re-open the reset's residual ~26s as if it's tunable — it's one read
plus one clear-write per vendor tab and neither batches.
```
