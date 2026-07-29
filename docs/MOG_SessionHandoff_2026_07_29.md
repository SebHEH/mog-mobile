# Session Handoff — Audit #19 + web-editor slowness fixes + KM tool brief

**Session date:** 2026-07-29
**Session focus:** Work the standing backlog — resume the codebase audit at #19, then profile and fix the web-editor slowness. Two unplanned additions landed: a KM training brief, and an approved-but-unbuilt design for Tier-2 onboarding.
**Outcome:** Audit #19 swept clean (one doc-rot finding, fixed same session). The web-editor slowness was **measured, not guessed** — the dominant cost was 2–3 serial ~2s Apps Script executions per page view, and two fixes removed one of them entirely plus most of the render-time sheet reads; both shipped to all 9 + master, canary rpfrf smoke-tested by Sebastian ("definitely feels a bit better"). A KM tool brief for the ordering app is written and owner-verified. `onboard.py` (Tier-2) is designed + approved but **deliberately parked unbuilt**.
**Next session focus:** Build `onboard.py` + rewrite the `mog-add-store` skill around it (design is locked — see Outstanding).

---

## Section A — Audit #19 (code audit resumed)

- **Scope was small by design:** only two commits existed since the `2874ff6` stamp (`a68f7a5` #24 split, `8a8de37` H2 override-sync), so per `codebase-audit-method` this was a targeted pass, not a full re-read. All 4 areas re-stamped at `8a8de37`.
- **Mechanical scanner: clean.** Every hit was already in the recorded NOT-findings list; zero shared-constant drift. **Gotcha:** the scanner crashes on Windows with `UnicodeEncodeError` (cp1252 can't encode `→`) — re-run with `PYTHONIOENCODING=utf-8` and redirect to a file.
- **The H2 formula rewrite verified faithful** to `vendorDayMultiplier_` on all four branches (unknown vendor/day → 0 both states; override-off → today's mult; override-on → the `CHOOSECOLS` rotation picks the first `mult>0` exactly like the code's scan-forward loop; all-zero → 1). One microscopic nuance recorded as deliberate-accepted, NOT a bug: `N()` zeroes numeric *text* where `Number()||0` wouldn't — only reachable if a SETUP S:Y cell were text-formatted (data hygiene, and both readers see the same cells).
- **#24 split boundary re-verified adversarially:** 0 duplicate top-level symbols across all 12 `.gs`; `escapeHtml_`'s only server callers are in `Recap.gs` (the `VendorCadenceAudit.html:368` hit is that modal's own browser-side copy at :300).
- **#19 [LOW] found + FIXED (`cf37b26`):** `MOGApi.gs`'s 34-line file banner described the pre-wizard, pre-Tier-3 world — "Add this file to the script project," `setupMobileApi()` with no file pointer, "Edit VENDOR_META below to add cutoff times" (cutoffs live in SETUP!AA; VENDOR_META is an explicit legacy fallback), "writes only to MASTER_ITEMS.On_Hand" (verified false against `api_saveOnHand_` — it writes vendor-tab col E), and a fossil "TODO BEFORE V1 SHIP" at v0.9.0. Rewritten to the current flow; the CORS note kept verbatim (still load-bearing). **Pushed push-only** (comment-only, zero behavior delta) — the `/exec` snapshots absorb it on the next real `--redeploy`.
- **No visual audit items consumed:** the visual layers (web editor + PWA + hub) had zero rendered-surface changes since A7–A10, so there was nothing to re-audit. **Next visual item is still A11.**

## Section B — Web-editor slowness: profiled, then fixed

**The measurement came first and reframed the problem.** Live curl timings on rpfrf (3 runs/page) + a code trace of the boot chain:

| Request | Typical | Composition |
|---|---|---|
| `?page=api` (no template, no reads) | 1.7–2.2s | the bare Apps Script `/exec` execution floor |
| Home / Order History `doGet` | 1.4–2.5s | ≈ floor (no render-time reads) |
| Areas / Vendors `doGet` | 2.0–3.5s | floor + 1–2 live sheet reads |
| Items / Pick Path `doGet` | 2.5–4.1s | floor + reads + largest templates (323KB / 216KB) |

- **Payload size is NOT the bottleneck** (History at 220KB timed the same as Home at 176KB) — that killed the obvious-looking "trim the payload" lever before any code was written.
- **The real cost: 2–3 serial ~2s executions per page view**, only one of which (the `doGet`) is unavoidable. The gate ran `editorPing` as a blocking round-trip *before* the tool's init, even on internal navigation where the previous page had validated the same token seconds earlier.

**Fix A — optimistic URL-token adoption (`8d05efb`, `EditorShell.html` `mgeStartGate_` + new `mgeAdoptUrlToken_`).** A token arriving via `?t=` (written by `mgeDecorateLinks_` on the page the user just left) is now adopted immediately: reveal + run init, validate via `editorPing` in the background, and on ping failure fall through to `mgeReshowGate_()` — the *existing* mid-session-expiry recovery. localStorage/bookmark landings (token could be days old) keep validate-first untouched, so the cold-landing guarantee is unchanged. Security unchanged: baked template data was already served pre-PIN by design (`Editor.gs:12`), and every real RPC still hard-validates through `webedit_call`. Removes ~1.5–2s from **every internal page click** — the most common editor action.

**Fix B — CacheService on the four render-time reads (`140fb3e`).** `getVendorList` + `getVendorTableData` (Vendors.gs), `getStorageAreaList` + `getPickPathForSidebar` (PickPath.gs) now use the standard `mog-apps-script-caching` pattern A (shared mutation-ts key, 300s TTL, `_compute_` split, fail-safe get/put).

> **The non-obvious part — read this before wrapping any other read in a cache.** Two mutators bump the mutation ts at their *start* and then read the current list *before* mutating: `commitAddVendor` (duplicate check) and `commitStorageAreasDraft_locked_` (reconcile baseline). Left on the cached wrapper, each would have stored its **pre-mutation** list under the **post-bump** key — poisoning the fresh key and serving stale data for the full TTL *after* a successful save. Both now call `getVendorList_compute_()` / `getStorageAreaList_compute_()` directly, with the reason commented inline at both call sites and in both wrapper headers. Bump-at-start + read-before-write is the general trap; grep for it whenever adding a wrapper.

- **Verified:** ts-bump coverage confirmed across every vendor/area/pick-DB/item mutator (the 2-line `withPickDbLock_` wrappers delegate to `_locked_` bodies that hold the bumps — checking the wrapper alone gives a false negative). Both files parse clean, zero duplicate symbols.
- **Shipped:** canary rpfrf `--redeploy` → Sebastian smoke-tested → fanned out all 9 + master `--redeploy`, every target push+deploy OK; rprfo health probe verified post-fan-out.
- **Honest limit:** a tool page is still ~2.5–3.5s. The ~2s execution floor and occasional multi-second Google flakes (one `?page=api` run hit 8.5s) are platform, not code. **Do not re-open this as if it's fixable in the repo.**
- **Side effect of the fan-out:** the redeploy flushed every store's editor session tokens, so active KMs got one clean PIN reprompt (validate-first gate handles it by design).

## Section C — KM tool brief (docs, owner-verified)

- Wrote `docs/MOG_OrderingApp_KM_Brief.md` (`c93e20c`) — a 12-section training source for a 30-min KM session on the **phone ordering app** (the web editor is mentioned only as the admin-side boundary). Built from the actual code: exact on-screen labels, the real order math, the 90-minute cutoff warning, the 5-try/5-minute PIN lockout.
- **All 7 VERIFY flags answered by Sebastian and folded in** — the answers changed the teaching, not just the flags:
  - **"Count everything, type a number" is now a teaching pillar**, not a footnote. The why: every item should order ~weekly; 2+ weeks without ordering means sitting inventory tying up cash, and blanks erase the data points that reveal it. (Previously the brief taught blank-as-skip as normal.)
  - **Secondary-vendor ordering is KM judgment**, including watching MarginEdge for price climbs and proposing a Primary flip for the week.
  - Counting happens **after the lunch rush**; missed cutoff **slips a cycle** (recovery: rep favor, or add items to a similar vendor's delivery); orders are placed by **KM or GM, mostly KM**, and BOH shift leads may count; **Admin/HR/regional** own the Recipients list.

## Section D — Tier-2 onboarding: designed, approved, PARKED

- Full walkthrough approved (`onboard.py` + `mog-add-store` rewrite), then Sebastian parked it before implementation. **Nothing was built** — do not assume any of it exists.
- Design is preserved in the flow artifact: **https://claude.ai/code/artifact/a5f7986a-bdc3-4fc3-a3b0-483a1d5d1b6d** (published; explains the 8-step → 4-step collapse, the internal pipeline, and the open OAuth question).
- Shape: one `onboard.py` at repo root (stdlib-only, reusing `deploy.py`'s clasp plumbing) taking slug + Script ID + concept + location → validate (slug unique in both registries, Script-ID shape, concept in `CONCEPT_TO_THEME`) → write `.clasp-targets.json` → `clasp push` (single target) → **fresh `clasp deploy` to create the web app** (the big win: replaces the manual Deploy → New deployment click-through; same mechanism as the tnytf/rprfo repoints) → record the deploymentId → write `stores.json` → run `build.py` → print the commit command + the wizard `/exec` link. Never git-commits; never touches the other 8 stores.
- Sebastian's remaining manual surface: Drive copy (~30s), paste the Script ID (irreducible — no API can fetch a copied bound script's ID), then the `?page=setup` wizard + smoke test. The wizard already replaces the old `setupMobileApi()` 5-prompt sequence.
- **Open question to settle during the first real onboarding:** OAuth grant timing. A fresh Sheet copy has no grants; today the `setupMobileApi()` run doubles as the grant. `clasp deploy` will create the deployment fine, but *executing* `/exec` needs the grant — hence the planned "click Run on `test_ping` once while grabbing the Script ID" step as cheap insurance. Confirm whether it's actually required, then update the runbook.

---

## Outstanding (carry forward)

1. **Build `onboard.py` + rewrite `mog-add-store`** (the parked Section D work). Design is locked — don't re-run the walkthrough, just build it. Infra-only: nothing deploys to stores until it's used. Note the current `mog-add-store/SKILL.md` has **stale content** regardless (its step 4 still teaches `setupMobileApi()`'s 5 prompts, superseded by the wizard in June; "10 files pushed" is now 27).
2. **Next audits:** code resumes at **#20**, visual at **A11** (web editor + PWA + hub only — the Sheet-modal layer is being phased out). `docs/MOG_AuditMap.md` is the resumable manifest, all areas stamped `8a8de37`.
3. **tnytf's old orphaned deployment** still needs a manual archive (lives on its pre-05-26-migration script project, not in `.clasp-targets.json`, so clasp can't reach it from the repo). script.google.com → old TNY Tysons FOH project → Manage deployments → Archive. Low urgency.
4. **Per-store Health Check errand: DONE** — Sebastian confirmed all stores were visited (sync_h2 + Vendor tab headers + Backup vendor placement). Remove it from candidate lists.
5. Optional/unchanged backlog: recap retry-on-failure (Q-INT-1 from the blueprint), ManageVendors "Advanced" disclosure, per-concept hub brand SVGs, Batch D brand expression.

## Files touched this chat

**Source (Apps Script):** `EditorShell.html` (gate: `mgeStartGate_` rewrite + new `mgeAdoptUrlToken_`), `Vendors.gs` (2 cache wrappers + `_compute_` split + the `commitAddVendor` bypass), `PickPath.gs` (2 cache wrappers + `_compute_` split + the `commitStorageAreasDraft_locked_` bypass), `MOGApi.gs` (file banner only).
**Docs:** `docs/MOG_AuditMap.md` (#19 + re-stamps + new NOT-findings), `docs/MOG_OrderingApp_KM_Brief.md` (new), this handoff, `CLAUDE.md` (@-import), `docs/MOG_CurrentState.md`.
**Deploys:** `deploy.py` push-only ×2 (the two comment-only rounds), `--redeploy --target rpfrf` (canary), `--redeploy` all 9 + master (fan-out). **No PWA/hub changes** — no `build.py`, no CACHE bump.
**Not touched:** blueprint (`MOG_LogicBlueprint.md`) — this session changed no rule, flow, integration, or business constant. Perf + docs only.

## Commits landed this session

```
8d05efb perf(editor): adopt URL-carried session token optimistically — kills the serial editorPing round-trip (~1.5-2s) on every internal page navigation; bookmark/localStorage landings stay validate-first
140fb3e perf(editor): CacheService-wrap the four doGet render-time reads (vendor list/table, area list, pick-path preload) — mutation-ts keyed; mid-write callers in commitAddVendor + commitStorageAreasDraft bypass via _compute_ to avoid post-bump cache poisoning
cf37b26 docs(api): audit #19 — rewrite stale MOGApi.gs header + stamp audit map at 8a8de37
c93e20c docs: KM tool brief for the ordering app (training source, owner-verified)
<this commit> docs: session handoff 2026-07-29 + correct date stamps
```

## Gotchas surfaced this session (for future-me)

- **Cache-wrapping a read that a mutator calls mid-write poisons the fresh key.** See the Fix B blockquote above. Always check whether callers bump the ts *before* reading.
- **`scan_apps_script.py` dies on Windows cp1252** — prefix `PYTHONIOENCODING=utf-8`.
- **A 2-line `withPickDbLock_` wrapper hides the bump** — auditing "does this mutator bump the ts?" must read the `_locked_` body, not the wrapper.
- **I mis-stamped this session's dates as 07-27 when today is 07-29** (audit map, 4 code comments, the KM brief) — corrected in the handoff commit. Run `handoff_facts.py` *early* in a session that writes date stamps, not just at close.

## Opening prompt for next session

```
Read docs/MOG_CurrentState.md first. Last session (2026-07-29) closed audit #19 (clean;
the one finding was MOGApi.gs's stale file banner, rewritten) and shipped two web-editor
perf fixes to all 9 + master: (A) the gate now adopts a ?t= URL token optimistically and
pings in the background, removing a serial ~2s round-trip from every internal editor
navigation; (B) the four doGet render-time reads (vendor list/table, area list, pick-path
preload) are CacheService-wrapped on the mutation-ts key — with commitAddVendor and
commitStorageAreasDraft deliberately bypassing via _compute_ because they bump the ts
before reading. Editor pages are ~2.5-3.5s now; the residual is Google's ~2s /exec
execution floor, which is NOT fixable in the repo — don't re-open it.

Most likely next: build onboard.py + rewrite the mog-add-store skill (Tier-2 onboarding).
The design is ALREADY APPROVED and parked unbuilt — read Section D of
docs/MOG_SessionHandoff_2026_07_29.md plus the flow artifact
(https://claude.ai/code/artifact/a5f7986a-bdc3-4fc3-a3b0-483a1d5d1b6d) and build it; do
not re-run the walkthrough. Note mog-add-store/SKILL.md is stale independent of that work
(its step 4 still teaches setupMobileApi's 5 prompts — the ?page=setup wizard superseded
that in June). Open question for the first real onboarding: whether a fresh Sheet copy
needs a manual test_ping Run to grant OAuth before /exec will execute.

Alternatives: next code audit at #20, visual at A11 (web editor + PWA + hub only).
Backend changes = deploy.py --redeploy, canary rprfo (editor canary rpfrf); PWA =
build.py + CACHE bump + git push. docs/MOG_AuditMap.md is the audit manifest (all areas
stamped 8a8de37). Also still open: manually archive tnytf's old orphaned deployment on
its pre-05-26 script project.
```
