# Session Handoff — Perf batch re-land + per-vendor Override day picker + refresh everywhere

**Session date:** 2026-08-07
**Session focus:** Land the two items the 08-06 handoff queued — pop the parked perf batch, then build the per-vendor Emergency Override day picker — plus a rider: refresh affordances on the hub and PIN screen.
**Outcome:** All three shipped and fanned out the same morning. Perf batch proven by rprfo's real morning reset + a delivered async recap email; day picker smoke-tested by Sebastian on rprfo then fanned out to all 9 + PWA v50; refresh-everywhere pushed at v51 / hub v9. Health Check H2 sync confirmed run on ALL stores — no per-store errand outstanding.
**Next session focus:** Override snappiness (ship `useMult` per item so the client resizes locally and skips the second `/exec` round-trip), or one of the standing candidates (TABNAME/SHEETGID cleanup, vendor-switch bulk prefetch, Tier-2 `onboard.py`).

---

## Section A — Perf batch re-landed (`e7ea333`)

`git stash pop` came back clean (4 files: `History.gs`, `MOGApi.gs`, `Recap.gs`, `ResetLog.gs` — no conflicts with the 08-06 PWA-only session). Canaried to rprfo at 7:42 AM with `--redeploy`.

**The canary proof was better than a smoke test:** Sebastian's rprfo Executions screenshot showed the store's real morning reset running on the new code at 7:48 (14.4s cold — well inside the 30s/120s timeouts), and **`sendPendingRecap_` firing as a Time-Driven trigger on the new version, completing in 5.95s**. The recap email arrived and was owner-verified correct. That exercised the unified reset sweep AND the async recap in production on day one — not just the read paths. Fanned out to all 9 + master at 7:58, spot-checked rpt/tnyt health probes clean.

The stash also carried the Override recap-filter correctness fix, which mattered hours later: the day picker (Section B) leans on `buildRecapSections_` filtering via the Override-aware `vendorDayMultiplier_`.

## Section B — Per-vendor Emergency Override day picker (`3bda45b`, PWA v50)

The 08-03 design, built and shipped. The flaw it fixes: the auto-bridge derives coverage from the *normal* schedule, which is exactly what's abnormal in an emergency (Fri+Sat vendor ordered Thursday → auto-sized to last one day; Saturday cancelled → must last seven, and the old override couldn't even express that since it only engaged when today's mult was 0).

**Design decisions as shipped:**

- **`SETUP!AF` stores the FROZEN multiplier number (1–7), not the day label.** Not just simpler — *correct*: the mult is relative to the day the order was placed, so it must freeze at pick time; a day label re-derived later would drift. Verified free before claiming: 1,428 formulas scanned on a fresh live export, zero references to column AF; R↔Z alignment 12/12. Vendor removal does `setup.deleteRow()`, so AF stays row-aligned for free.
- **Sebastian's UI call (replacing my always-visible collapsed row):** the picker is **gated behind the store-wide override**. Override on → every vendor's count screen leads with a prominent amber card — "When is this vendor's next delivery after this one?" — with 7 day chips (each showing ×N, days = tomorrow+1 … tomorrow+7). Picked → collapses to "Sized to last until \<day\> ×N" + Change; an **Auto** chip reverts to the auto-bridge. Same note on the review screen so the KM approving quantities knows why they're big. Consequence accepted: correcting a *normal* delivery day requires flipping override on first — consistent with it being a *mode*.
- **AF picks are children of AD2**: only settable while override is on, ignored when off (`vendorDayMultiplier_` checks the pick *inside* the override branch), and cleared wherever AD2 clears — `api_commitReset_` (after logging, so the log captures picked multipliers), `api_setEmergencyOverride_(off)`, and the stale-day open sweep (`resetEmergencyOverrideOnOpen_` → new `clearVendorOverrides_` in Core.gs). A pick cannot leak into the next cycle.
- **The in-Sheet H2 follows** (`vendorTabH2Formula_`): `ovr` branch nested inside the AD2=TRUE branch, structurally mirroring the code. Rollout self-flagged via Health Check → `sync_h2`; **Sebastian ran it on ALL stores — done, no errand.**
- **Plumbing:** new `readVendorOverrides_` (one Z..AF range read), `api_setVendorOverride_({vendor, mult})` + dispatch case, `vendorOverrides` threaded through every shared ctx (count, dashboard snapshot, recap, reset snapshot — the all-or-nothing ctx contract), `api_getVendorItems_` now returns `emergencyOverride` + `overrideMult` for the PWA. `VENDOR_OVERRIDE_COL = 32` in Core.gs.
- **Verified before canary:** 317,116-case differential test — no-pick behavior byte-identical to the old function; picks win only under override; junk/zero picks and unknown vendors fall through exactly like H2's `vrow=0`. Plus the usual parse + bilingual-key checks.
- **The PWA push was global but inert by construction**: the picker only renders when the backend returns the new fields, so non-canary stores saw nothing until their backend fan-out.

Blueprint bumped: **R10** rewritten (auto-bridge is a guess; the user's frozen per-vendor answer beats it; why a number not a label), **R11** gained the children-of-the-flag clause, state table gained the pick row. `current_as_of: 51e3928`.

## Section C — Refresh everywhere (`51e3928`, PWA v51, hub sw v9)

Sebastian's ask after the smoke test: KMs should get the chance to refresh *before* reaching a store, not just inside the app.

- **Hub**: a ↻ button pinned next to the EN/ES toggle (every hub screen). The hub SW serves the shell **stale-while-revalidate**, so a plain `location.reload()` would paint the *cached* hub and only catch up next visit — the handler instead fetches `./` with `cache:'reload'` first (which also proves we're online), then drops the `mog-hub-*` caches, kicks `registration.update()`, and reloads. Offline → leaves the cached page alone, stops the spinner.
- **PIN screen**: the "Reload the app" hatch (added 08-06, revealed only after a failed sign-in) is now **always visible**, reworded "App acting up? / ¿Problemas con la app?". Store navigations are network-first, so a plain reload suffices there. The failed-sign-in reveal code was removed.
- With the in-app pull-to-refresh from 08-06, refresh now exists at every stop: hub → PIN → all nine views.

## Section D — Drive connector unlocked for live-sheet verifies

Answering Sebastian's "couldn't I just give you the sheet links?": **yes — the Google Drive connector in this environment can search and read the live store spreadsheets directly** (all 9 ORDERING_GUIDE sheets + the master template found by name). Future `mog-sheet-formula-verify` passes don't need a manual export handoff. (This session still used his fresh `RP_AN_ROSSLYN_ORDERING_GUIDE.xlsx` download for the AF scan.) Note: Gmail MCP reads were blocked by the permission classifier — inbox checks still need Sebastian.

## Outstanding (carry forward)

1. **Override snappiness** (the one smoke-test complaint): turning override on and picking a day each cost two serial `/exec` round-trips (~2s floor each) under a blocking busy overlay. Clean fix: include `useMult` per item in the vendor-items payload so the client can resize quantities locally after a pick and skip the forced re-fetch (careful: that's flirting with a fourth implementation of the order math — keep it to `targetPar = par × (useMult ? mult : 1)` recompute, and grep every `ceil` per `mog-sheet-formula-verify` before calling it done). Alternatively just make the update non-blocking (stale-while-revalidate style).
2. **Standing candidates, unchanged:** TABNAME/SHEETGID custom-function cleanup (static values recomputed every recalc, DEADLINE_EXCEEDED during resets); vendor-switch bulk prefetch (biggest speed complaint); Tier-2 `onboard.py` (designed 07-29, unbuilt); recap retry Q-INT-1 (largely mooted by the async recap's bounded 3-try retry — verify and retire?); audits at #20 / A11; tnytf orphan archive (manual); disarm `FORCE_CLIENT_RELOAD` (hygiene, no deadline, do NOT touch `FORCE_RELOAD_ID`).
3. ~~Health Check H2 sync per store~~ — **DONE, Sebastian confirmed all sheets.**

## Files touched this chat

**Backend (all 9 + master via `deploy.py --redeploy`, canary rprfo):** `apps-script/Core.gs` (VENDOR_OVERRIDE_COL, `clearVendorOverrides_`, stale-day sweep), `apps-script/MOGApi.gs` (readVendorOverrides_, vendorDayMultiplier_ pick branch, api_setVendorOverride_ + dispatch, ctx threading, reset clear, getVendorItems override fields), `apps-script/Recap.gs` + `apps-script/ResetLog.gs` (ctx + filter), `apps-script/Vendors.gs` (H2 formula ovr branch) — plus the perf-batch re-land in History/MOGApi/Recap/ResetLog.
**PWA:** `template/index.html` (picker card + chips + review note + i18n, always-visible PIN reload), `template/sw.js` (v49→v51), root `index.html` (hub refresh button + handler), root `sw.js` (v8→v9), all 8 generated `<slug>/` dirs.
**Docs:** this handoff, `docs/MOG_CurrentState.md`, `docs/MOG_LogicBlueprint.md` + regenerated `.html` (R10/R11), `CLAUDE.md` (@-import).

## Commits landed this session

```
51e3928 feat(pwa+hub): refresh available everywhere - hub refresh button, always-visible PIN reload (v51, hub v9)
3bda45b feat(override): per-vendor Emergency Override day picker - SETUP!AF, H2 branch, PWA count-screen chips (v50)
e7ea333 perf: re-land the 4-part batch - history/dashboard read slicing, unified reset sweep, async recap + Override recap-filter fix
```

## Opening prompt for next session

```
Read docs/MOG_CurrentState.md first. Last session (2026-08-07) shipped three things, all live
on all 9 stores: (1) the parked 4-part perf batch re-landed (e7ea333) — proven by rprfo's real
morning reset + a delivered async recap email on day one; (2) the per-vendor Emergency Override
day picker (3bda45b, PWA v50) — SETUP!AF holds a FROZEN 1-7 multiplier (a number, not a day
label — it's relative to the order day), picks only exist while the store-wide override is on
and clear wherever AD2 clears, the H2 formula follows, and the Health Check H2 sync is already
DONE on all stores; (3) refresh everywhere (51e3928, PWA v51/hub v9) — hub ↻ button +
always-visible PIN reload.

Top candidate: override snappiness — the override toggle and day pick each cost two serial
/exec round-trips (~2s floor each) under a blocking overlay. Fix: ship useMult per item so the
client resizes locally after a pick (grep every ceil in the order path first — it's a fourth
implementation of the math if done sloppily), or make the refresh non-blocking. Other
candidates: TABNAME/SHEETGID cleanup, vendor-switch bulk prefetch, Tier-2 onboard.py.

Notes: the Google Drive connector can read the live store sheets directly — no manual xlsx
export needed for formula verifies. Backend = deploy.py --redeploy, canary rprfo (editor
canary rpfrf); PWA = build.py + CACHE bump + git push. Don't re-open the reset's residual
~26s, don't change FORCE_RELOAD_ID in template/sw.js.
```
