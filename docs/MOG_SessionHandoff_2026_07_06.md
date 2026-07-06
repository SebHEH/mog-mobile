# Session Handoff — Tier-3 name/pack bite + rprfo PWA outage fix

**Session date:** 2026-07-06
**Session focus:** Live-verify the 2026-07-02 Emergency Override work, then continue Tier-3 (move item name/pack off the vendor tab into code). An unplanned production incident (Rosslyn FOH PWA "offline") was diagnosed and fixed mid-session.
**Outcome:** Emergency Override + name/pack both confirmed working live. The name/pack Tier-3 bite shipped to all 9 + master and is committed + pushed (`06a8eed`). Separately, rprfo's web-app deployment was serving intermittent Google error pages on POST (not a code bug, not a general Google outage) — fixed by cutting a **fresh `/exec` deployment** and repointing the PWA (staged, see Section B; needs the close-out commit).
**Next session focus:** Enable an item to be **orderable from two vendors at once** — reuse the same item + shared par across vendors that deliver on complementary days (B&T shares items with Chef Center; they deliver on each other's off-days).

---

## Section A — Tier-3: item name/pack computed in code

**Shipped, committed (`06a8eed`), pushed, fanned out to all 9 + master.**

- **What changed:** `api_getVendorItems_` ([apps-script/MOGApi.gs](../apps-script/MOGApi.gs)) no longer reads the vendor tab's column A (Item Name) or B (Pack). Both now come from `readMasterItemMeta_`, which was extended to return `{useMult, par, name, pack}` (name = MASTER_ITEMS!B, pack = MASTER_ITEMS!E) — inside the **same one-range MASTER read** it already did for par/useMult, so **zero extra sheet I/O**.
- **Why safe (formula-verified):** a fresh export of the live rpfrf sheet was pulled from Drive this session and its formulas read via the `xlsx` skill. Vendor-tab **A3** = `XLOOKUP($M, MASTER_ITEMS!$A, MASTER_ITEMS!$B, "")` and **B3** = the same into `MASTER_ITEMS!$E` — pure spills into the exact cells we now read directly. A 6-row value cross-check (Webstaurant + Amazon) matched MASTER B/E 6/6. So this is a **true no-op relocation**, same pattern as the par bite.
- **Blank/skip parity:** rows now key on the M-column id only; a row is skipped when `!itemId`, or when `masterMeta` has no entry / a blank name — byte-for-byte the old `A === ""` skip (the tab's XLOOKUP renders `""` for an unknown id).
- **The vendor tab is now consumed for On Hand (E) + Item ID (M) ONLY** in the count/order path. Verified: canary rpfrf ("looks like it's working"), then fanned out.

**Tier-3 state after this bite:** the PWA count/order path (`api_getVendorItems_`) is fully formula-free. Still reading vendor-tab formulas: `snapshotVendorOrders_` (reset → order-log → recap reads col A + col F) and `vendorOnHandSnapshot_` (dashboard "to order" counts read col F). Those are the remaining Tier-3 candidates — deferred (the count path was the priority, and the next feature took precedence).

## Section B — rprfo PWA outage + fresh-deployment fix

**Diagnosed + fixed; STAGED, not yet committed (rides the close-out commit below).**

- **Symptom:** Rosslyn FOH KMs saw the PWA "Offline — using last loaded data" banner; the app ran on cached data but couldn't reach the backend.
- **Diagnosis (ruled out, in order):** GitHub Pages was serving the v24 shell fine (HTTP 200, override code present). The backend GET health-probe returned clean JSON. **POST**, however, returned Google's HTML error page (the `/exec` → `googleusercontent.com/echo` redirect hop failing to *deliver* the response) — the code executed server-side (PIN lockout counters incremented correctly), Google just failed to return the body. The PWA can't read those CORS-less error pages, so `fetch` surfaces them as a network failure → offline banner. Google's status dashboard showed **no declared incident**; 6 of 8 stores were unaffected; rpfr self-healed within minutes; **rprfo persisted 4+ hours and survived a version bump (@44)** → the deployment itself was in a bad state on Google's side.
- **Fix:** cut a **new web-app deployment** on rprfo's script (`clasp deploy`, web-app config from `appsscript.json`, no new auth) → `AKfycby8-_goEn…` @45. Verified healthy: GET + **two consecutive POSTs** all returned clean JSON (the old deployment never managed two POSTs in a row). Repointed rprfo's `deploymentId` in [.clasp-targets.json](../apps-script/.clasp-targets.json) and its `deployment` URL in [stores.json](../stores.json); bumped `CACHE_VERSION` v24→**v25** and ran `build.py` so Rosslyn phones pick up the new API URL on SW refresh. Old deployment left live (harmless).
- **Same pattern as the 2026-06-26 tnytf repoint**, in the other direction. KMs' `github.io` bookmarks are unchanged; phones adopt the new URL when the service worker refreshes to v25.

**Incident lessons worth carrying:**
- **A single Apps Script `/exec` deployment can rot** (intermittent response-delivery failure) while the code and GET path stay healthy and no incident is declared. The fix is a fresh deployment + PWA repoint, not a code change or a redeploy of the same deployment id.
- **Diagnostic dummy-PIN probes trip the shared per-store PIN lockout** (5 attempts / 5-min window, global per store — no per-IP signal in Apps Script). During this session rprfo and rpfr were briefly locked out by probing; it self-clears in 5 min and the first correct PIN resets it. Warn the crew, or run `clearPinLockout()` from the Sheet editor to lift immediately.
- **Hardening idea (not done):** the PWA treats a `BAD_JSON` response (a Google error page) as a hard error. A single automatic retry on `BAD_JSON` would have hidden this entire incident from KMs. Small, high-value follow-up if we want resilience against transient delivery flakes.

---

## Outstanding (carry forward)

- **Verify Rosslyn FOH is back** — after GitHub Pages publishes v25, have the crew close + reopen the PWA (SW picks up the new API URL). Any counts entered while offline are queued locally and sync on the first successful call. *(Cannot verify from here — needs the real PIN or a KM on-site.)*
- **Optional PWA hardening:** auto-retry once on `BAD_JSON` before surfacing offline (see Section B lessons).
- **Tier-3 remaining bites** (deferred, lower priority than the two-vendor feature): move `snapshotVendorOrders_` (reset/recap) and `vendorOnHandSnapshot_` (dashboard counts) off the vendor-tab col-F/col-A formula reads — would make the **entire backend** formula-free. Heavier canary (run a reset on rpfrf, confirm log rows + recap match). Also still deferred: sync the in-Sheet H2 formula to the next-delivery override behavior (option A divergence, harmless).
- **Prior carry-forward (unchanged):** `Claude-SKills` mirror commit (separate session); ManageVendors Edit-form "Advanced" disclosure (gated on Vendor Cadence Audit run); per-concept brand SVGs on the hub; Batch D brand fonts / concept-aware modal theming.

## Files touched this chat

- **Apps Script (source):** [apps-script/MOGApi.gs](../apps-script/MOGApi.gs) — `readMasterItemMeta_` (+name/pack), `api_getVendorItems_` (name/pack from masterMeta, tab read now E+M only). Committed `06a8eed`, deployed all 9 + master via `deploy.py --redeploy`.
- **Deploy/config (Section B, STAGED):** [apps-script/.clasp-targets.json](../apps-script/.clasp-targets.json) (rprfo deploymentId → `AKfycby8-_goEn…`), [stores.json](../stores.json) (rprfo deployment URL), [template/sw.js](../template/sw.js) (CACHE_VERSION v24→v25).
- **Generated (build.py refresh):** all 8 `<slug>/sw.js` (v25 bump) + `rprfo/index.html` (new API URL — the only store index that changed content).
- **Docs:** this handoff, `CLAUDE.md` (@-import → this file), `docs/MOG_CurrentState.md` (Pinned focus, recent-changes row, candidates).
- **No new OAuth scopes.** No `.gs` change in Section B (fresh deployment reuses existing pushed code).

## Commits landed this session

```
06a8eed feat(api): item name/pack from MASTER_ITEMS - vendor tab read is now On Hand + ID only
59d06f1 docs: session handoff 2026-07-02 - Tier-3 order math in code + emergency override
```
*(Both already pushed. The rprfo fix in Section B + this handoff are still uncommitted — see the close-out commit suggestion.)*

## Next session focus — item orderable from TWO vendors at once

**The ask:** a new vendor **B&T** shares many items with **Chef Center** and delivers on the days Chef Center doesn't. We want to turn B&T on and **reuse the existing items and their pars** rather than re-entering them — the same physical item should be orderable from either vendor depending on the delivery day.

**Start with `architectural-walkthrough` + a `mog-sheet-formula-verify` pass — do NOT jump to code.** This touches the vendor-tab spill model and the pick-path DB, exactly the area where a wrong assumption breaks order math.

**What the current model already gives us (verified this session + from CurrentState):**
- **Par is shared per item** in `MASTER_ITEMS!G`, and every vendor tab's par column is `XLOOKUP(id, MASTER_ITEMS!A, MASTER_ITEMS!G)`. So "reuse the par" is free — any tab the item appears on uses the same base par.
- **Each vendor tab is a `SORT/FILTER` spill** over the pick-path DB (`SETUP!K:P`), filtered by `SETUP!K = <tab's vendor name>`. An item appears on a vendor's tab because there's a pick-path row with that vendor in column K.
- **Per-vendor, per-day multiplier (H2)** already encodes delivery cadence. On a day B&T delivers and Chef Center doesn't, Chef Center's H2 = 0 (item shows blank there) and B&T's H2 > 0 (item shows on B&T's tab). **Complementary-day behavior largely falls out of the existing multiplier table** — this is the good news.
- **Column O (Eligible Vendors)** is already a pipe-delimited plural list per item; `commitSwitchActiveVendor` currently *moves* an item's single active vendor (column C) rather than putting it on two tabs.

**The likely design:** give the shared item **two pick-path DB rows** (one per vendor, K=B&T and K=Chef Center), so it spills onto both tabs while keeping one par in `MASTER_ITEMS!G`. But confirm this against the live sheet first.

**Challenges to work through in the walkthrough:**
1. **On Hand truth / double-count (biggest one).** On Hand is entered per vendor tab (col E). If the item is on two tabs, there are two independent On-Hand cells for one physical item. Because the vendors deliver on complementary days you're only ordering from one on any given day — but the KM could still see/count the item on both screens. Decide: is On-Hand entered once and shared, or per-tab, and how does the count screen present a shared item so it isn't counted twice?
2. **Reset / order-log / recap dedup.** `snapshotVendorOrders_` sweeps ALL vendor tabs and logs items with suggested > 0. On a day both vendors happen to deliver (rare with complementary days, but possible), a shared item could be logged twice. Confirm the dedup story.
3. **The active-vendor model (column C) is singular.** `commitSwitchActiveVendor` and the Manage Items quick-switch assume one active vendor. Need new UX/semantics for "on for both" vs "switch," and a clear definition of what column C means when an item is genuinely on two tabs.
4. **Storage area / pick-path order is per (vendor, item) row.** Two pick-path rows need an area + order each. Manage Items area assignment is currently per-item (single-vendor assumption) — decide whether the two rows reuse the same area or can differ.
5. **The 1-day-par caveat still applies** — the multiplier does the day-scaling, so both vendors' order math is only correct if the base par is a true 1-day par (the standing rpr caveat).

---

## Opening prompt for next session

```
Read docs/MOG_CurrentState.md first. Last session shipped the Tier-3 name/pack
bite (api_getVendorItems_ now reads only On Hand + Item ID from the vendor tab;
name/pack/par all come from MASTER_ITEMS — committed 06a8eed, all 9 + master)
and fixed a Rosslyn FOH (rprfo) PWA outage by cutting a fresh /exec deployment
and repointing the PWA (CACHE v25). Confirm rprfo is back for the crew first.

MAIN GOAL: let a shared item be orderable from TWO vendors at once. New vendor
B&T shares many items with Chef Center and delivers on Chef Center's off-days;
we want to turn B&T on and reuse the existing items + their pars, not re-enter
them. START with architectural-walkthrough + mog-sheet-formula-verify against a
fresh live-sheet export — do not jump to code. The par is already shared
(MASTER_ITEMS!G) and per-vendor H2 already handles complementary delivery days;
the hard parts are On-Hand double-count (On Hand is per-vendor-tab), reset/recap
dedup, and that the active-vendor column C is currently singular. Full challenge
list is in docs/MOG_SessionHandoff_2026_07_06.md.

Canary is rpfrf; backend changes need deploy.py --redeploy, PWA changes need
build.py + git push (PWA push is global — no per-store canary). Incident note:
a single /exec deployment can rot (intermittent POST-delivery failure) with the
code + GET path still healthy — fix is a fresh deployment + repoint, not a code
change; and dummy-PIN probes trip the shared per-store 5-min lockout.
```
