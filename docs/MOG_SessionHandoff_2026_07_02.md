# Session Handoff — Tier-3 order-math-in-code + Emergency Override (PWA)

**Session date:** 2026-07-02
**Session focus:** Tier-3 "Sheet = engine, not UI" — move order math off the vendor-tab formulas into `.gs`, one verified bite at a time; then redesign + expose Emergency Override.
**Outcome — ALL shipped to all 9 + master (+ PWA to GitHub Pages) and committed/pushed (2 commits `4a6b9cf`, `b835145`).** `api_getVendorItems_` now computes suggested qty, base par, and the day multiplier entirely in code — zero vendor-tab-formula reads for the count/order path — each step verified byte-identical against the live rpfrf `.xlsx`. Emergency Override was redesigned (flat 1× → "cover the next scheduled delivery") and exposed in the PWA with a home-screen button. Canary rpfrf confirmed par/suggested match the sheet ("looks like it's working").
**Next session focus:** live-verify the Emergency Override button end-to-end on rpfrf (+ optional TNY spot-check), then either continue Tier-3 or pick from the optional backlog.

---

## What shipped

Tier-3 was done as **three incremental bites**, each gated by a `mog-sheet-formula-verify` pass against the live `RP_FOUNDERS_FOH_ORDERING_GUIDE.xlsx` export (the actual formulas, via the `xlsx` skill), canaried on rpfrf, then fanned out. All land in `apps-script/MOGApi.gs`.

- **Bite 1 — suggested qty computed in code (drop col-F read).** `api_getVendorItems_` previously read `suggestedQty` from the vendor-tab column-F cell. The live F formula is a `LET` block: `ROUNDUP(par*(useMult?H2:1) - onHand)`, blank on `name=""` / `H2=0` / `onHand=""` / `qty<=0`. **Key correction to the plan:** F **already honors** the Use-Multiplier flag (the `MOGApi.gs` comment claiming "the sheet formula ignores it" was stale) — so this was a **true no-op for every item**, a pure relocation. Code now computes `max(0, ceil(targetPar - onHand))` with F's exact blanking rules.

- **Bite 2 — par from `MASTER_ITEMS!G` (drop vendor-tab col-D read).** Vendor-tab col D is an array formula `= XLOOKUP(id, MASTER!A, MASTER!G)`, so col D is *always* exactly `MASTER!G`. Renamed `readUseMultiplierMap_` → **`readMasterItemMeta_`** returning `Map<id, {useMult, par}>` (par from col G index 6) in one MASTER read; `api_getVendorItems_` reads par from there. Behavior-neutral.

- **Bite 3 — H2 day-multiplier computed in code + Emergency Override redesign.** The live `H2` formula is `IF(ORDER_ENTRY!AD2=TRUE, 1, INDEX(SETUP!S:Y, MATCH(vendor, SETUP!R), MATCH(day, SETUP!S1:Y1)))`. New helpers **`readEmergencyOverride_()`** (reads `ORDER_ENTRY!AD2`) and **`vendorDayMultiplier_(vendorMults, vendor, dayOfWeek, emergencyOverride)`** replace the H2-cell read. Verified: SETUP columns **R and Z hold the same vendors, same rows** (R keyed by the formula, Z by `readVendorMultipliers_`), so the existing Z-keyed reader matches; `getActiveOrderDate_().dayOfWeek` (`EEE`) matches the formula's `TEXT(...,"ddd")`. Normal-ops = byte-identical to the sheet (simulated against live mults). The **Emergency Override redesign** (see below) lives in this helper.

- **Emergency Override — redesigned + exposed in the PWA (new feature).**
  - **Behavior change (decided this session):** override was a flat **1×** for all vendors — useless for a vendor that only delivers some days (a 1-day order won't bridge to its next drop). Now under override, `vendorDayMultiplier_` **bridges to the next scheduled delivery**: scan the vendor's 7-day row forward from today (inclusive), use the first day with `mult > 0`; all-zero row → `1` fallback. E.g. a vendor delivering Thu=3×/Sun=4× now orders 3× Mon–Wed, 4× Fri–Sun instead of 1×.
  - **Backend:** `api_getDashboard_compute_` returns `emergencyOverride` and **stops skipping non-delivery vendors when override is on** (shows all vendors). New **`api_setEmergencyOverride_({on})`** (dispatch case `setEmergencyOverride`) flips `AD2` + stamps `LAST_OVERRIDE_DATE` + bumps the mutation ts (busts the dashboard cache). **`api_commitReset_` now clears the override** (it previously didn't — noted "not exposed yet"), so an override can't leak into a new day on PWA-only stores.
  - **PWA** (`template/index.html`, `CACHE_VERSION` v23→**v24**): a home-screen control in `renderToday` — a quiet dashed "⚠ Emergency override" pill when off (tap → **confirm dialog** → on), an amber "Emergency override on" banner + **Turn off** when on. `onOverrideToggle_` calls the setter, drops the dashboard + per-vendor caches, reloads Today. Bilingual EN/ES (new `T` keys). `dashboardsDiffer_` now compares `emergencyOverride` so a background refresh repaints on change.
  - **Decisions locked:** override multiplier = next-delivery coverage; show all vendors; **any KM** can use it; **confirm on turn-on**; **option A** — code-only (the in-Sheet H2 formula still does flat 1× under override; harmless since nobody orders from the raw sheet during an emergency).

## Outstanding (carry forward)

- **Live-verify the Emergency Override BUTTON on rpfrf** — the final end-to-end check (after GitHub Pages publishes + the SW v24 hard-refresh). Confirm: pill shows on Home; tap → confirm → all vendors appear; an off-schedule vendor is sized to its next delivery; Turn off reverts. Sebastian was about to do this at handoff time.
- **Optional TNY spot-check** — formula-verify was only run on a Roll Play store (rpfrf). The `H2`/`D`/`F` formulas are code-generated (identical across stores; only the multiplier/par *data* differs), so it generalizes — but a one-item check on **tnytf** (PWA suggested qty vs that vendor's col F in the sheet) is cheap belt-and-suspenders on a different concept/data. Store Health Check flags R/Z structural drift per store if a full sweep is ever wanted.
- **Optional — sync the in-Sheet H2 formula to the new override behavior** (deferred as option A). Currently the raw Sheet shows flat 1× under override while the PWA/recap use next-delivery coverage. To make them match, rewrite `vendorTabH2Formula_` / the template-sync path with the same lookahead (bigger change; touches the vendor-template machinery + re-runs "Sync Vendor Multiplier Formulas").
- **Verification artifact** — `RP_FOUNDERS_FOH_ORDERING_GUIDE.xlsx` is untracked in the repo root (used to close the formula-verify gate). `rm` it or gitignore `*.xlsx`; do not commit it.
- **Prior carry-forward (unchanged):** `Claude-SKills` mirror commit (separate session); ManageVendors Edit-form "Advanced" disclosure (gated on Vendor Cadence Audit run); per-concept brand SVGs on the hub; Batch D brand fonts / concept-aware modal theming.

## Files touched this chat

- **Apps Script (source):** `apps-script/MOGApi.gs` — `api_getVendorItems_` (suggested + par + dayMult all computed in code), `readUseMultiplierMap_`→`readMasterItemMeta_` (adds par), new `readEmergencyOverride_` + `vendorDayMultiplier_`, `api_getDashboard_compute_` (override flag + show-all), new `api_setEmergencyOverride_` + dispatch case, `api_commitReset_` (clears override). Deployed to all 9 + master via `deploy.py --redeploy`.
- **PWA:** `template/index.html` (override button: `T` keys, CSS `.override-banner`, `renderToday` markup, `onOverrideToggle_` + wiring, `dashboardsDiffer_`), `template/sw.js` (CACHE v23→v24), regenerated `<slug>/` dirs via `build.py`, pushed to GitHub Pages.
- **Docs:** `docs/MOG_SessionHandoff_2026_07_02.md` (this), `CLAUDE.md` (@-import → this file), `docs/MOG_CurrentState.md` (pinned focus, recent-changes row, candidates).
- **No new OAuth scopes.**

## Commits landed this session

```
b835145 feat(pwa): emergency-override button on Home (CACHE v24)
4a6b9cf feat(api): order math fully in code + emergency override backend
```
(Both already pushed to `origin/main`. The docs/handoff lands as a follow-up `docs:` commit.)

## Opening prompt for next session

```
Read docs/MOG_CurrentState.md first. Last session finished the Tier-3
"order math into .gs" work: api_getVendorItems_ now computes suggested qty,
base par (MASTER_ITEMS!G), and the day multiplier entirely in code — zero
vendor-tab-formula reads — each bite verified byte-identical to the live
rpfrf sheet (mog-sheet-formula-verify). It also redesigned Emergency Override
(flat 1x -> "cover the next scheduled delivery") and exposed it as a
home-screen button in the PWA (api_setEmergencyOverride_ + a confirm dialog;
CACHE v24). All live on all 9 + master; committed + pushed.

FIRST: live-verify the Emergency Override button on rpfrf
(sebheh.github.io/mog-mobile/rpfrf/, hard-refresh for SW v24): pill on Home ->
tap -> confirm -> all vendors show, off-schedule vendor sized to its next
delivery -> Turn off reverts. Optional cheap belt-and-suspenders: same one-item
suggested-qty-vs-sheet check on a Teas'n You store (tnytf) since formula-verify
was only run on Roll Play.

THEN pick a direction: (a) continue Tier-3 — the count path is now formula-free,
next candidates are moving item name/pack off vendor-tab A/B, or syncing the
in-Sheet H2 formula to the new next-delivery override behavior so the raw Sheet
matches the PWA under override (option A left them divergent, harmlessly); or
(b) the optional backlog (ManageVendors Advanced disclosure, per-concept brand
SVGs, Batch D). Canary is rpfrf; backend changes need deploy.py --redeploy,
PWA changes need build.py + git push (global — no per-store PWA canary).
Housekeeping: rm the untracked RP_FOUNDERS_FOH_ORDERING_GUIDE.xlsx verify artifact.
```
