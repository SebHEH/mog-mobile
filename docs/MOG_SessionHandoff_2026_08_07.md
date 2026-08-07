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

---

# Later session — Override round-trip collapse + bulk vendor prefetch

**Session focus:** Ship the top candidate (override snappiness), then the biggest felt win, as low-risk quick wins ahead of Sebastian's vacation.
**Outcome:** Two commits (`c97ff43`, `118b83a`), both on all 9 + master via `--redeploy` and both on Pages (PWA v51→v52→v53). The `/exec` floor was **measured, not assumed**, and the number redirected the design away from the approach the morning handoff had proposed.
**Next session focus:** Neither change has been exercised by a human yet — smoke-test first (especially that counts survive a save→back→re-enter round trip). Then per-entity cache keys or the TABNAME/SHEETGID cleanup, both deliberately deferred as too behavior-changing to ship pre-vacation.

## Section A — The measurement (do this first next time)

`?page=api` on rprfo — no template, no sheet reads, no work — **2.18s**. That matches 07-29's 1.7–2.2s exactly: **the floor has not moved.** Two probes that verifiably reached `doPost` returned in 1.50s and 3.66s.

This is the whole basis of both changes: the cost is **per-EXECUTION overhead, not per-byte**, so removing a round trip is worth ~2s while shrinking a payload is worth ~0 (07-29 already proved that half).

**The probe technique, and how to run it correctly** — `doPost` (`MOGApi.gs:146`) parses the body and returns `Invalid JSON body` at line 148, **before** the lockout check at 159 and before `checkPin_`. So a malformed-body POST exercises the full delivery path with **zero PIN-lockout risk**. Verified in code before firing, not taken on trust from the 08-06 note.

Three curl mistakes cost most of the measurement time — all produce plausible-looking timings for requests that **never reached the script**:
- `-X POST` with `-L` forces POST onto the redirect hop → **411 Length Required** from Google's edge.
- `--post301/302/303` re-POSTs to the `googleusercontent.com` echo URL, which only accepts GET → **405 / "Page Not Found"**.
- Correct form is plain `curl -sL -d '...'` — curl converts to GET on the 302, which is what the PWA's `fetch` does.

**Always validate the response body before trusting a timing.** Gate on the expected string (`Invalid JSON body`); a 411/405 timing measures Google's edge rejecting you.

Also: rapid-fire scripted probes against a live store start returning 30s+ 404s. Stopped rather than keep hammering production to refine a number already in hand; a single health probe confirmed rprfo was fine.

## Section B — Why MOG is slow (the architectural conversation)

Sebastian asked what's fundamentally wrong with the data handling. Recorded because it reframes the backlog:

1. **~2s fixed tax per request**, 20–100× a normal backend's round trip. Makes *chattiness* catastrophic and is why the codebase evolved toward bootstrap endpoints and shared ctx. No warm process — nothing survives between executions, which is why `getSheet_` memoizes *within* a request.
2. **No query layer.** `readMasterItemMeta_` reads **all** of MASTER_ITEMS to serve one vendor. Sheets returns rectangles, not predicates — no index, no `WHERE`. **Cost scales with catalog size, not answer size**, so every store gets permanently slower as it grows. Even a cache hit costs two internal RPCs (PropertiesService for the ts, then CacheService).
3. **Global cache invalidation.** `bumpServerMutationTs_` (`Core.gs:251`) writes ONE key that every cached read keys on, so any write evicts everything — the cache is least effective during the busiest interaction (a KM typing counts). **Self-inflicted and fixable.**
4. **The storage layer is also a compute engine** — `TABNAME`/`SHEETGID` recalculating and contending with the script.

**Verdict on "where did I go wrong":** the platform choice was right for the constraints. The two genuine structural mistakes were letting the spreadsheet be database + compute + UI (already self-diagnosed and largely fixed by Tier-3) and the single global cache key. The decision that would have changed the most: **designing the API as "sync the store once" rather than "query per screen."**

**The legitimate redesign, if starting fresh:** local-first — one request downloads the whole store, the client computes every screen locally, writes queue and flush in batches. **MOG is already ~60% of that** (`buildRecapLocally_` builds the entire order list with zero network; `computeSuggested` recalculates live; drafts + offline queue) — it just kept a query-per-screen API in front of it. Same backend logic, different API shape.

**Strategic conclusion: stop expecting tuning to fix this.** Inside Apps Script the remaining wins are constant factors. Two orders of magnitude requires a different data store — a scheduled project, not something reached by optimizing. `don't migrate prematurely` still stands.

## Section C — Round-trip collapse (`c97ff43`, PWA v52)

Both mutation endpoints now return the fresh payload they already had everything to build, so each interaction is ONE execution instead of two.

- `api_setEmergencyOverride_` → returns `dashboard`; `api_setVendorOverride_` → returns `itemsPayload`.
- **Both reads run AFTER the write AND AFTER the ts bump.** `api_getDashboard_` keys its cache on `getServerMutationTs_()`, so computing before the bump would store pre-mutation data under the post-bump key for the full 300s TTL — the `commitAddVendor` trap from audit 07-29. `api_getVendorItems_` is **not** CacheService-wrapped, so it has no such hazard.
- **Both wrapped in try/catch on purpose:** the write has already succeeded, so a read failure must never make a successful write look failed. Omitting the field is a valid response.

**Chose this over the handoff's proposed `useMult` local-resize, and the `ceil` audit is why.** Exactly three implementations exist (`MOGApi.gs:1243`, `template/index.html:4446`, `ManageItems.html:1483`) and this change touches **none**. The payload already ships `par`, so `useMult` really was the only missing field — but `buildRecapLocally_` (`template/index.html:5520`) reads `it.suggestedQty` **straight from the cached payload**, not through `computeSuggested`. A local resize fixing only `targetPar` would leave the full order list showing pre-pick quantities; fixing that means re-deriving `suggestedQty` client-side — the fourth implementation, and the 08-03 bug class.

**Two client subtleties worth keeping:**
1. **`loadToday` needed a parameter, not a cache seed.** Its fast path deliberately skips GC + reviewed-flag self-heal on the grounds a cache hit was already reconciled. Seeding `state.cache.dashboard` and letting the fast path render would silently skip that on a genuinely fresh payload. `loadToday(preloaded)` skips only the network call.
2. **The pick handler must seed `state.cache.vendorItems` explicitly** — the forced fetch used to, and `buildRecapLocally_` reads it. Not an optimization; without it the order list shows pre-pick quantities.

## Section D — Bulk vendor prefetch (`118b83a`, PWA v53)

`prefetchTodaysVendors_` warmed one vendor per request, each paying the floor — ~20s for 8 vendors, and an early tap still ate a full cold fetch. New `api_getVendorItemsBulk_` returns many vendors from one execution using a shared ctx that **mirrors `buildRecapSections_` exactly** (all-or-nothing per the `api_getVendorItems_` ctx contract), so each extra vendor costs only its own tab read.

- Per-vendor failures isolated into `failed` — one bad tab shouldn't lose the batch.
- `BULK_VENDOR_LIMIT = 30` guards an unbounded tab loop in one execution; should never fire (largest store ~11) and dropped names are **reported, never silently truncated**.
- **Client seeding is NON-CLOBBERING**: a vendor already in cache when the batch lands was put there by something fresher (user opening it, or a forced refetch after a save), so overwriting could resurrect pre-save on-hand. **This is the sharpest edge in the change.**
- Falls back to the old sequential loop on any failure, so the build is safe ahead of its backend.

## Section E — Deploy decision: all stores, no canary

Sebastian called it, and the reasoning is sound enough to keep:

- A **backend-only canary is invisible** — a backend change does nothing until the PWA code that uses it is live. Literally true here.
- **The PWA can't be split.** `build.py` + `git push` ships all 8 stores at once, so the only real split state is "new PWA everywhere, new backend on one store" — a mismatch on 7 stores.

Since both changes are **bidirectionally compatible by design** (new PWA + old backend falls back; old PWA + new backend ignores extra fields), fanning out everything *minimizes* the mismatch window rather than widening it. **Backend was deployed BEFORE the PWA push** both times so no client could call an action its store didn't have (a `get*` miss burns 3 auto-retries before falling back).

## Outstanding (carry forward)

1. **Neither change has been human-smoke-tested.** Both are live on all 9. Verify: override on/pick feel faster; **full order list shows resized quantities**; vendor taps instant after Today loads; early tap much improved; and the sharpest one — **enter counts → save → back out → re-enter: counts must still be there** (the non-clobbering seed).
2. **Deferred as too behavior-changing pre-vacation:** per-entity cache keys (the biggest structural win — helps every screen) and the TABNAME/SHEETGID cleanup (mutates sheets across 9 stores).
3. Standing, unchanged: Tier-2 `onboard.py` (designed 07-29, unbuilt); audits at #20 / A11; tnytf orphan archive (manual); disarm `FORCE_CLIENT_RELOAD` (hygiene, no deadline — do NOT touch `FORCE_RELOAD_ID`); recap retry Q-INT-1 (likely mooted by the async recap's bounded retry — verify and retire?).
4. `stash@{0}` is an old GitHub Desktop stash touching `ManageItems.html` (48 insertions) — unrelated to the perf batch, still unexamined.

## Files touched this chat

**Backend (all 9 + master, two `--redeploy` fan-outs):** `apps-script/MOGApi.gs` — `api_setEmergencyOverride_`, `api_setVendorOverride_`, new `api_getVendorItemsBulk_`, dispatch case.
**PWA:** `template/index.html` (`loadToday(preloaded)`, `onOverrideToggle_`, `onOverridePickTap_`, `prefetchTodaysVendors_`), `template/sw.js` (v51→v53), all 8 generated `<slug>/` dirs.
**Docs:** this block, `docs/MOG_CurrentState.md`. No blueprint bump — no rule, flow, integration, or business constant changed.

## Commits landed this later session

```
118b83a perf(prefetch): warm today's vendors in one bulk /exec call instead of one per vendor (v53)
c97ff43 perf(override): collapse toggle + day pick to one /exec round-trip each (v52)
```

## Opening prompt for next session

```
Read docs/MOG_CurrentState.md first. The 2026-08-07 LATER session shipped two perf wins,
both live on all 9 stores and NEITHER human-smoke-tested yet: (1) c97ff43 / PWA v52 — the
override toggle and day pick each collapsed from two serial /exec executions to one, by
having api_setEmergencyOverride_ and api_setVendorOverride_ return the fresh payload after
the write and ts bump; (2) 118b83a / PWA v53 — api_getVendorItemsBulk_ warms today's
vendors in ONE execution using the shared-ctx pattern from buildRecapSections_.

FIRST: confirm the smoke test, especially "enter counts, save, back out, re-enter — counts
still there." The bulk prefetch writes into the same vendor cache the count screen reads;
the seed is deliberately NON-CLOBBERING to protect saved counts, and that's the sharpest
edge in the change.

Measured this session: a bare no-work /exec request costs 2.18s — the floor is
per-EXECUTION, not per-byte, so removing a round trip is the only lever with real
constant factors. Payload size is NOT a lever (proven 07-29). Deferred deliberately as
too behavior-changing pre-vacation: per-entity cache keys (bumpServerMutationTs_ is ONE
global key, so any write evicts every cached read — biggest structural win left) and the
TABNAME/SHEETGID cleanup.

Deploy: backend BEFORE PWA push (a get* miss burns 3 auto-retries). Sebastian's standing
call is to fan out to all stores together rather than canary — a backend-only canary is
invisible, and the PWA can't be split. Don't re-open the reset's residual ~26s, don't
change FORCE_RELOAD_ID.
```
