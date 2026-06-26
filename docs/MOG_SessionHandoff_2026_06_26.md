# Session Handoff — Editor tours/scroll + persistent titlebars + tnytf fix + globalized MVS lessons

**Session date:** 2026-06-26
**Session focus:** Resolve the open editor threads (mini-tour fire policy, natural-scroll for the other tools, the "B" persistent titlebars), fold the MVS/MPS-fidelity lessons into the global skills, and fix a latent tnytf deployment mismatch found along the way.
**Outcome (mixed deploy states — read carefully):**
- **(1) Fire policy** (per-tool tours → replay-only) + **natural-scroll** (Vendors/Areas/History): **FANNED OUT to all 9 + master**, canary-confirmed. **Uncommitted.**
- **(2) "B" persistent titlebars** on the 4 non-Items tools (EditorShell-centralized CSS + per-tool markup): **CANARY `rpfrf` @70 ONLY — NOT fanned out, awaiting Sebastian's sign-off. Uncommitted.**
- **(3) tnytf backend mismatch** fixed (PWA): **built (stores.json + cache bump + build.py), NOT pushed** (needs `git push` for GitHub Pages + a live order test).
- **(4) MVS-fidelity lessons** applied to 4 global skills (device) **and mirrored to the canonical `personal-web` bucket**; the `Claude-SKills` repo is **uncommitted** and `_personal/` was left untouched.
- Deploy-iteration discipline **reversed** (redeploy-the-canary + open its `/exec`, not `/dev`).

**Next session focus:** Verify the "B" titlebars on canary → fan out B (`deploy.py --redeploy`) + commit the editor work; commit **and push** the tnytf fix, then verify it live; in a dedicated `Claude-SKills` session, commit the `personal-web` mirror and decide what to do about `_personal/`.

---

## What shipped

- **Mini-tour fire policy → per-tool tours are REPLAY-ONLY.** Removed the `maybeAutoStart…_()` init call from all 5 tools (`ManageItems`/`ManageVendors`/`OrderHistory`/`ReorderPickPath`/`StorageAreas`); each call became a comment documenting the decision + the one-line re-enable, and the `maybeAutoStart…_` functions stay as the lever. The `↻ Replay walkthrough` button in each tool's `?` help is untouched, so every tour is still reachable. **Home flow-tour + gated setup wizard tour still auto-fire** once/browser — they're the orientation; per-tool detail tours were stacking coach-marks on a first pass. (Decision: Sebastian picked "per-tool → replay-only" over keeping everything auto-firing.)
- **Tools now scroll like Manage Items (header band scrolls away, not pinned).** The 3 height-locked tools were unlocked to natural page scroll:
  - `ManageVendors.html` — `html.mge-web`/`body.mge-web` unlock + release `.scroll-body`.
  - `StorageAreas.html` — same unlock + release `.body`; **Save footer pinned to the viewport bottom** (`position:sticky;bottom:0` + solid `var(--page)` bg) so it stays reachable on a long list.
  - `OrderHistory.html` — same unlock + release the nested `.content-area`/`.tab-panel`/`.table-wrap`/`.hist-detail`/`.hist-detail-list` scrollers so the page is the single scroller.
  - Each tool's init gained `document.documentElement.classList.add('mge-web')` (activates the `html.mge-web` rule). All scoped to `mge-web` → Sheet dialogs byte-unchanged. **Shelf to Sheet (ReorderPickPath) was already natural-scroll** (body not height-locked, header `position:static`) — left alone, confirmed fine.
- **"B" persistent titlebars on the 4 non-Items tools (CANARY `rpfrf` @70 ONLY — not fanned out).** Title + one-line bilingual subtitle above each tool's content, matching Manage Items. **Centralized the `.web-titlebar`/`.web-title`/`.web-subtitle` CSS in `EditorShell`** (self-centers per tool via `--shell-width`) and **removed Manage Items' now-duplicate local copy** (identical values → Items unchanged). Added markup to `ManageVendors` (top of `.scroll-body`), `StorageAreas` (top of `.body`), `ReorderPickPath` (before `.header`), `OrderHistory` (top of `.shell`). Copy follows the Items voice (what it is + why it matters, informal *tú* in ES); `.en`/`.es` spans ride the existing lang toggle (no JS change).
- **Deploy-iteration discipline REVERSED** (`mog-deploy-workflow/SKILL.md` + memory `feedback_editor_iterate_on_dev`): the old "never `--redeploy` to iterate, use `/dev`" rule was a workaround for the *pre-gate brick*. The validate-first gate (shipped 2026-06-24) makes a token flush recover via re-PIN, so **iterate by `--redeploy`-ing the canary and handing Sebastian the bare `/exec` HOME link** — he tests on `/exec`, not `/dev` (push-only doesn't update `/exec`). The only cost of a canary redeploy now is re-entering the PIN.
- **Globalized the MVS/MPS-fidelity lessons** into 4 global skills (device copies in `~/.claude/skills/`):
  - `appsscript-guided-tour-help` — fire-policy rule (one orientation tour auto-fires, detail tours replay-only); gate-hint paragraph ("Do this step to continue" + "Done with this step", not a silently-disabled Next); prominent-`?` rule (filled-accent circle next to the title, EN/ES on its own control).
  - `appsscript-phrasing-glossary` — new "Tour & help copy voice" subsection (imperative title naming the action, action-first body naming the control + em-dash why, warm close, NO meta-narration like "~20 seconds", ES informal tú).
  - `appsscript-first-run-setup` — validate-first session-gate hard rule (CacheService tokens flush on a new deployment version → validate server-side before running, re-run init on every auth).
  - `architectural-walkthrough` — "Porting from a reference implementation" rule (default to fidelity, flag each divergence as a risk).
  - **Mirrored to the canonical repo:** the 4 edits were copied into `Claude-SKills/personal-web/<skill>/SKILL.md` (verified byte-identical to the device copies). `personal-web/` is the authoritative bucket — `sync-skills.ps1` (→ device) and `package_skill.py` (→ claude.ai zips) both read the buckets, not `_personal/`. **Left untouched:** `_personal/` (a separate committed "mirror" per `.gitignore` — already differs from the buckets, names the glossary `bilingual-phrasing-glossary`, and had a large pre-existing dirty tree); and the `Claude-SKills` commit (Sebastian will review in a dedicated session).
- **Fixed a latent tnytf backend mismatch (PWA layer).** `stores.json` pointed tnytf's PWA at deployment `AKfycbzkLs…/exec`, which **is not a deployment of tnytf's current script project** (`clasp deployments` shows only `@HEAD` + `AKfycbwu…@23`) — an orphan from the 2026-05-26 script-project migration. **Consequence:** every `MOGApi.gs`/`api_*` change since that migration `--redeploy`'d `AKfycbwu…` but the tnytf PWA called the orphan, so tnytf's phones ran stale backend code. Fix: repointed `stores.json` tnytf → `AKfycbwu…/exec` (Sebastian-confirmed canonical), bumped `CACHE_VERSION` v20→v21 (the API URL is baked into the cached `index.html`, so phones must evict), `python build.py` (only `tnytf/index.html` changed among the index files; all 8 `sw.js` got v21). **Verify: open `sebheh.github.io/mog-mobile/tnytf/` and run an order** — confirm the backend now responds with current behavior.
- **Added a global-skill-governance rule to `CLAUDE.md`** (after the Skills tables): the skills under `~/.claude/skills/` are owned by the **Claude-SKills** repo — do NOT edit/create them directly in this repo; instead invoke the **`global-skill-governance`** skill to file a proposal into the mailbox (`~/.claude/skills/_global-skill-proposals/`) for the Claude-SKills repo to apply + re-sync. Repo-local `./.claude/skills/` specializers stay editable in place. **Note:** this session's own global-skill edits (the 4 device copies + the `personal-web` mirror) predate the rule and were **left as-is** by decision — Sebastian folds them in during his Claude-SKills session. Going forward, global-skill changes from this repo go through a proposal.

## Outstanding (carry forward)

- **"B" titlebars: verify on canary, then FAN OUT.** Live only on `rpfrf` `@70`. After Sebastian confirms the title/subtitle on all 4 tools, `python deploy.py --redeploy` (all 9 + master).
- **tnytf fix: commit + `git push`, then verify live.** The repoint + cache bump + rebuild are in the working tree but **not pushed**; GitHub Pages won't serve it until pushed. Then open `sebheh.github.io/mog-mobile/tnytf/` and run an order.
- **mog-mobile commits pending.** Everything this session is uncommitted (the editor replay/scroll is already fanned out; B is canary-only; tnytf needs push). Suggested commits below.
- **`Claude-SKills` repo — dedicated session.** The 4 `personal-web` edits are mirrored but **uncommitted**, sitting alongside a large pre-existing dirty tree. Sebastian will review/commit there separately and decide whether `_personal/` (the divergent mirror, `bilingual-phrasing-glossary` naming) needs reconciling.
- **Editor backlog** (unchanged, all optional): ManageVendors Edit-form "Advanced" disclosure (gated on the Vendor Cadence Audit run); real per-concept brand SVGs on the hub; Batch D (brand fonts / concept-aware modal theming).

## Files touched this chat

- **Editor HTML (`apps-script/`):** `EditorShell.html` (centralized `.web-titlebar` CSS); `ManageItems.html` (replay-only comment + dropped local titlebar CSS); `ManageVendors.html` (replay-only + natural-scroll + init + titlebar markup); `OrderHistory.html` (replay-only + natural-scroll + init + titlebar markup); `ReorderPickPath.html` (replay-only comment + titlebar markup); `StorageAreas.html` (replay-only + natural-scroll + sticky footer + init + titlebar markup).
- **Repo skill:** `.claude/skills/mog-deploy-workflow/SKILL.md` (editor-iteration section rewritten).
- **Canonical skills repo (`Claude-SKills`, uncommitted):** `personal-web/{appsscript-guided-tour-help, appsscript-phrasing-glossary, appsscript-first-run-setup, architectural-walkthrough}/SKILL.md` mirrored from the device copies.
- **PWA layer (tnytf fix):** `stores.json` (tnytf deployment URL), `template/sw.js` (CACHE_VERSION v20→v21), and `build.py` output — `tnytf/index.html` + all 8 `<slug>/sw.js` regenerated.
- **Global skills (device copy, `~/.claude/skills/`):** `appsscript-guided-tour-help`, `appsscript-phrasing-glossary`, `appsscript-first-run-setup`, `architectural-walkthrough`.
- **Memory:** `feedback_editor_iterate_on_dev.md` rewritten (+ MEMORY.md index line).
- **Docs:** this handoff; `CLAUDE.md` (@-import bump + new "Global skills are governed" section); `MOG_CurrentState.md` row + pinned focus.
- **Deploys:** canary `rpfrf` (push, then `--redeploy` ×2), then full `deploy.py --redeploy` (all 9 + master, every target OK). No `build.py` / PWA / hub changes. No new OAuth scopes.

## Commits landed this session

```
(none yet — editor code + docs to be committed together with this handoff)
```

## Opening prompt for next session

```
Read docs/MOG_CurrentState.md first. The KM web editor: per-tool mini-tours are
REPLAY-ONLY (only the home flow-tour + gated setup wizard tour auto-fire) and
Manage Vendors / Storage Areas / Order History scroll the whole page like Manage
Items (header band scrolls away; Areas' Save footer pinned) — BOTH fanned out to
all 9 + master, just uncommitted.

THREE things are NOT fully shipped, finish these first:
1. "B" persistent titlebars (title + 1-line subtitle above content) on the 4
   non-Items tools — CANARY rpfrf @70 ONLY. Verify on the canary /exec, then fan
   out (deploy.py --redeploy) and commit the editor work.
2. tnytf backend fix — stores.json pointed tnytf's PWA at an orphaned /exec
   deployment (not on its current script project), so tnytf ran stale backend code
   since the 2026-05-26 migration. Repointed to AKfycbwu…/exec + cache bump v21 +
   build.py, but it's NOT pushed. git push, then VERIFY at
   sebheh.github.io/mog-mobile/tnytf/ (run an order).
3. Claude-SKills repo (separate session) — the 4 personal-web/*/SKILL.md edits are
   mirrored but uncommitted, amid a pre-existing dirty tree; decide on _personal/.

Deploy discipline (REVERSED this session): iterate by --redeploy-ing the canary
(rpfrf) and opening its bare /exec HOME link — NOT /dev (push-only doesn't update
/exec). The validate-first gate makes a redeploy safe (token flush → re-PIN, no
brick). Always pull + confirm a clean git status before deploying. Never hand a
?page= deep link — bare /exec only.

Backlog after that (optional): ManageVendors Edit-form "Advanced" disclosure
(gated on the Vendor Cadence Audit run); per-concept brand SVGs on the hub; Batch D.
```
