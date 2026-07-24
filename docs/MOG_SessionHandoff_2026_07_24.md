# Session Handoff — #24 MOGApi split + Tier-3 close-out (H2 override sync) + orphan-deployment cleanup

**Session date:** 2026-07-24
**Session focus:** Work the standing backlog — #24 (split `MOGApi.gs`, pure code-motion), then close out the Tier-3 remainder (sync the in-Sheet `H2` formula to the next-delivery Emergency Override behavior).
**Outcome:** Both shipped to all 9 + master via `deploy.py --redeploy`, each canaried on rprfo first (Sebastian smoke-tested the PWA order flow + recap email for the split, and the Health Check round-trip + override on/off spot check for the formula). **Tier-3 is now fully closed** — the order math is single-sourced in code and the sheet formula is a faithful mirror. Side-quest: root-caused a confusing Health Check discrepancy to a stale bookmark hitting rprfo's orphaned pre-07-06 `/exec` deployment; that dead deployment is now deleted and a full 9-target deployment sweep came back clean.
**Next session focus:** Sebastian finishes the per-store Health Check visits (three one-click fixes per store); then the next code audit (#19) / visual audit (A11), the web-editor slowness profile, or Tier-2 onboarding streamlining.

---

## What shipped

### A) #24 — MOGApi.gs split into Recap.gs + Admin.gs (`a68f7a5`, all 9 + master, `--redeploy`)

- **Pure code-motion:** `MOGApi.gs` (2,361 lines) → `MOGApi.gs` (1,300) + **`Recap.gs`** (542 — `api_emailRecap_`, `api_getRecapData_`, `buildRecapSections_`, `sendRecapEmail_`, `test_recapEmailToSelf`, `escapeHtml_`, and the whole 4b RECIPIENTS section) + **`Admin.gs`** (535 — the 5) ADMIN section + all 6) TEST functions).
- **Partition verified three independent ways before deploy:** byte-exact reassembly of the chunk partition (a deterministic slicer, same discipline as the 2026-06-19 Core split), `node --check` on all three files (via `.js` copies — node 24 rejects the `.gs` extension), and a duplicate-symbol scan across all 12 `.gs` (263 unique, 0 dups). The git diff on `MOGApi.gs` was 0 insertions / 1,061 deletions — pure relocation.
- **Routing decisions (grep-grounded, don't re-litigate):** `escapeHtml_` → Recap (its only caller is `sendRecapEmail_`); `getTodaysLogByVendor_` / `generateReferenceFromDateStr_` / `buildPackByIdMap_` **stay in MOGApi** (their callers are the dashboard + history handlers) — that's why Recap is ~540 lines, not the estimated ~700; all constants stay in `MOGApi.gs` (Core-split precedent, kills the top-level-const TDZ risk); recipients ride with Recap (consumers are the recap send path + PWA recipients screen); tests ride with Admin (both editor-run-only).
- **PWA impact: none by construction** — flat global namespace; `doPost` stayed in MOGApi and calls everything by name. Verified via the `/exec` health probe post-deploy + Sebastian's live smoke test.
- Doc inventories updated in the same commit: `CLAUDE.md` file tree, root `README.md` (also fixed pre-existing staleness — it was missing `Editor.gs`/`Health.gs`), `apps-script/README.md` file table (same staleness fixed), `MOG_CurrentState.md` flat-peers note (10 → 12 `.gs`), `MOG_AuditMap.md` #24 marked DONE, and 3 stale inline comment pointers (`Editor.gs` ×2, `ResetLog.gs` ×1) repointed to the new files.

### B) Tier-3 close-out — in-Sheet H2 synced to next-delivery override (uncommitted at handoff time; rides this commit)

- **`vendorTabH2Formula_()` (`Vendors.gs`) rewritten** so the generated per-tab H2 formula mirrors `vendorDayMultiplier_` (MOGApi.gs) **exactly**, closing the accepted "option A" divergence from 2026-07-02 (sheet showed flat 1× under override while the code did next-delivery coverage).
- New formula (LET-based): override off → today's multiplier from SETUP S:Y (unchanged); override on → `CHOOSECOLS`-rotate the vendor's Mon–Sun row to start at today, take the first `mult > 0` (next-delivery bridge), all-zero row → 1; unknown vendor or day label → **0 in both states** (code parity — note this intentionally changes the old override-on behavior for an unmatched vendor from 1 → 0). `N()` wraps coerce stray text/blanks to 0 like the code's `Number(x)||0`.
- **Verified:** formula rendered via node and paren-balance-checked; rotation math hand-checked; canary rprfo — Health Check flagged the stale H2 on template + all tabs, one-click `sync_h2` fix ran, re-check came back all-pass (proves the string round-trips `getFormula()`, so `LET`/`CHOOSECOLS`/`SEQUENCE` all parse), and Sebastian confirmed override on/off behavior live.
- **Rollout is per-store and self-flagging:** the deploy changes nothing in any sheet; each store's Health Check now flags "stale H2" with the existing one-click `sync_h2` fix (`updateVendorTabHeader2Formulas_` — also repairs `VENDOR_TEMPLATE`, and a dashboard rebuild triggers the same sync). rprfo synced; the other stores ride Sebastian's Health Check errand (below).
- **No blueprint bump:** the rule (override bridges to next delivery) was already stated in `MOG_LogicBlueprint.md`; this change makes the sheet conform to it — a rebuild on another stack behaves identically.

### C) Orphaned-deployment cleanup (operational, no code)

- **Root cause of "rprfo shows 8 Health Check checks, rpfrf shows 11":** Sebastian's bookmark pointed at rprfo's **pre-07-06 rotted `/exec` deployment**, deliberately left live during the 07-06 repoint and frozen at @44 (pre-07-12 code = 8 checks). Not a code problem — all stores on their current URLs run identical HEAD.
- **Swept all 9 script projects via `clasp deployments`:** every target is clean (one active + `@HEAD` each) except rprfo's orphan, which is now **deleted** (`clasp undeploy`) — stale bookmarks fail loudly now instead of silently serving year-old code.
- Lesson reinforced: **don't bookmark raw `/exec` URLs** — they change on every repoint (fresh deployment = new ID). Re-grab from `stores.json` when needed.

---

## Outstanding (carry forward)

- **Per-store Health Check visits (Sebastian, in progress)** — each remaining store (rpr, rpt, rptfo, rpfr, rpfrf, tnyt, tnytf; rprfo done): open the web editor → Maintenance → 🩺 Store Health Check → run the **three** one-click fixes in one visit: `sync_h2` (new, from B), "Vendor tab headers" (pre-existing), "Backup vendor placement" backfill (pre-existing; only rpr done). The per-store editor links were listed in this chat; they're also derivable from `stores.json`. `_template`'s VENDOR_TEMPLATE self-heals on its first sync or dashboard rebuild.
- **tnytf's old orphaned deployment** — lives on the store's *pre-05-26-migration script project*, which isn't in `.clasp-targets.json`, so clasp can't reach it from the repo. Manual one-off for Sebastian: script.google.com → find the old TNY Tysons FOH project → Deploy → Manage deployments → Archive. Low urgency.
- **Backlog unchanged otherwise:** next code audit resumes at **#19**, next visual audit at **A11** (web editor + PWA + hub scope only — modal layer is being phased out); web-editor slowness profile; Tier-2 onboarding streamline (`mog-add-store` friction). **Tier-3 is closed — remove it from candidate lists.**

---

## Files touched this chat

**Source (Apps Script):** `MOGApi.gs` (shrunk), `Recap.gs` + `Admin.gs` (new), `Vendors.gs` (`vendorTabH2Formula_`), `Editor.gs` + `ResetLog.gs` (comment pointers only).
**Docs:** `CLAUDE.md` (inventory + @-import), root `README.md`, `apps-script/README.md`, `docs/MOG_CurrentState.md`, `docs/MOG_AuditMap.md` (#24 DONE), this handoff.
**Deploys:** `deploy.py --redeploy` × 3 (canary rprfo for the split; all-9 fan-out for the split; canary + all-9 for the H2 formula) + one push-only (comment pointers). No PWA/hub changes — no `build.py`, no cache bumps.
**Operational:** `clasp undeploy` of rprfo's orphaned deployment (via temp `.clasp.json`, cleaned up).

---

## Commits landed this session

```
a68f7a5 refactor(api): split MOGApi.gs into Recap.gs + Admin.gs (#24, pure code-motion)
<this commit> feat(sheet): sync in-Sheet H2 formula to next-delivery Emergency Override (Tier-3 close-out) + session docs
```

---

## Gotchas surfaced this session (for future-me)

- **`node --check` rejects `.gs` on Node 24** (`ERR_UNKNOWN_FILE_EXTENSION`) — copy to a scratchpad `.js` first. Prior sessions' "node --check clean on all N `.gs`" presumably ran an older Node.
- **An orphaned `/exec` deployment is a stale-bookmark trap:** it serves its pinned old version forever and *looks* healthy (rprfo's showed a fully-green 8-check Health Check on year-old code). The check-count mismatch vs another store was the tell. After any `mog-exec-repoint`, archive the dead deployment (`clasp undeploy <id>`) instead of leaving it live.
- **The Health Check's canonical-string comparison doubles as the formula-rollout mechanism:** changing `vendorTabH2Formula_()` makes every store self-flag with a one-click fix — no manual per-tab work. Reusable pattern for future canonical-formula changes.

---

## Opening prompt for next session

```
Read docs/MOG_CurrentState.md first. Last session (2026-07-24) shipped #24 (MOGApi.gs
split into Recap.gs + Admin.gs, pure code-motion, byte-exact-verified) and closed out
Tier-3: vendorTabH2Formula_ now mirrors vendorDayMultiplier_ exactly (next-delivery
Emergency Override in the sheet formula too). Both on all 9 + master via deploy.py
--redeploy, canary rprfo. Also deleted rprfo's orphaned pre-07-06 /exec deployment
(stale-bookmark trap); tnytf's old orphan needs a manual archive on its old script
project.

Sebastian may still be mid-errand: per-store Health Check visits running three one-click
fixes each (sync_h2 + Vendor tab headers + Backup vendor placement) — rprfo done. Ask
before assuming stores are synced.

Likely next directions: (a) next code audit at #19 / visual audit at A11 (web editor +
PWA + hub only — modal layer being phased out); (b) web-editor slowness profile;
(c) Tier-2 onboarding streamline. Backend changes = deploy.py --redeploy, canary rprfo
(editor canary rpfrf); PWA = build.py + CACHE bump + git push. docs/MOG_AuditMap.md is
the resumable audit manifest.
```
