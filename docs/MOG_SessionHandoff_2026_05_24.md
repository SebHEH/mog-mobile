# Session Handoff — Repo consolidation + Claude Code scaffold

**Session date:** 2026-05-24
**Session focus:** Two unrelated bodies of work bundled into one session — (A) consolidating the separate `Master-Ordering-Guide` repo into `mog-mobile` with a `clasp`-based deploy workflow, and (B) setting up the Claude Code cross-session continuity infrastructure (CLAUDE.md + docs + repo skills) following the MVS pattern.
**Outcome:** Both shipped. `mog-mobile` is now the single canonical repo for the MOG system. Apps Script changes deploy to all 9 targets via one PowerShell command. Future Claude Code sessions auto-orient on first turn.
**Next session focus:** Decommission the old `Master-Ordering-Guide` repo ~2026-05-31 (1 week post-consolidation safety window), then resume whatever PWA/Apps Script feature work is next up.

---

## Section A — Repo consolidation + clasp deploy workflow

### What shipped

**Repo merge** (commit `d95080f`):
- `apps-script/` folder created under `mog-mobile/` with all 9 source files (`MOGApi.gs`, `OrderGuideScript.gs`, 7 HTML modals) + the canonical `appsscript.json` manifest pulled from rpr's deployed copy.
- `apps-script/.clasp-targets.json` committed with all 9 Script IDs (8 stores + master template).
- `apps-script/deploy.ps1` written — one-command push to all targets, supports `-Target <slug>` for single-store deploy and `-DryRun` for config validation.
- `apps-script/README.md` written — setup walkthrough (Node + clasp install, Script ID collection, reconciliation diff, daily workflow).
- Root `README.md` updated — new "Apps Script backend" section + Architecture diagram includes `apps-script/`.
- `.gitignore` added — excludes `.clasp.json` (rewritten per-deploy) and `.clasprc.json` (credentials).
- 2 new stores onboarded (commit `bb68221`): Roll Play Founders FOH (`rpfrf`) and Roll Play Tysons FOH (`rptfo`). Added to `stores.json`; `build.py` regenerated all 8 per-store dirs and re-injected the hub registry.

**Why this approach:**
- Single repo eliminates the manual copy/paste/rename loop between `Master-Ordering-Guide` and `mog-mobile`. The old repo was a Claude Project upload dump; with Claude Code running locally, that workflow is obsolete.
- `clasp` multi-push was chosen over an Apps Script Library because it requires zero refactor and keeps files individually readable. The Library route would have meant rewriting HTML modal access, menu binding, and custom function paths — high risk, low reward.
- The master template is included in the deploy targets so new stores copied from it inherit the latest code automatically.

**Reconciliation findings** (one-time diff between local source and deployed code at session start):
- All 9 deployed projects had byte-identical code modulo CRLF line endings (1939 CRs locally, 0 deployed).
- `appsscript.json` differed across stores — rpr was the only one with explicit OAuth scopes declared. Chose rpr's manifest as canonical and applied it to all 9 targets.

**Verification:**
- rpr canary deploy succeeded; Sebastian smoke-tested in the Sheet (menus, modals all working).
- Full deploy to remaining 8 targets succeeded in ~32s.
- PWA hub at `sebheh.github.io/mog-mobile/` verified loading the 6 pre-existing stores after the push.
- Hub re-verified after `bb68221` to show 8 stores including the 2 new ones.

### Outstanding from Section A (carry forward)

- **Decommission `Master-Ordering-Guide` repo** ~2026-05-31 (after 1 week of clean operation). GitHub: Settings → Delete repository. Locally: rename to `Master-Ordering-Guide.archive\` for one more week, then delete.
- **Verify the 2 new store PINs work** in their PWAs (`sebheh.github.io/mog-mobile/rpfrf/` and `.../rptfo/`). Sebastian said he'd check post-Pages-rebuild; if it's not confirmed, ask at session start.
- **Future: clasp-based deployment of the Apps Script web app itself.** Today the deploy URL is set up manually in the Apps Script editor (Deploy → New deployment → Web app). `clasp create-deployment` could automate this — relevant when adding stores. Not urgent.

---

## Section B — Claude Code scaffold setup

### What shipped

- `CLAUDE.md` at repo root — load-on-start anchor with @-imports for `docs/MOG_CurrentState.md` and `docs/MOG_SessionHandoff_2026_05_24.md`. Includes layer routing table, 8 standing invariants, skills index (3 repo-specific + 5 user-global), working conventions, and 10-item common-pitfalls list.
- `docs/MOG_CurrentState.md` — pinned focus, next-session candidates, invariants duplicated for offline readability, deploy targets + live stores tables, open issues, architecture notes, recent-changes table.
- `docs/MOG_SessionHandoff_2026_05_24.md` — this file.
- `.claude/skills/mog-session-handoff/SKILL.md` — end-of-session capture skill that writes the next dated handoff and updates CLAUDE.md's @-import line.
- `.claude/skills/mog-deploy-workflow/SKILL.md` — routes any code change to the right layer (backend → `deploy.ps1`; PWA → `build.py` + git; config → `build.py` + git); enforces canary-first.
- `.claude/skills/mog-add-store/SKILL.md` — end-to-end new-store onboarding checklist (Drive copy → Script ID → `.clasp-targets.json` → `setupMobileApi()` → web-app deploy → `stores.json` → `build.py` → push).

**Why this approach:**
- Mirrored the MVS+CS pattern Sebastian already uses successfully: `CLAUDE.md` auto-loads, @-imports the running state + latest handoff, repo-specific skills in `.claude/skills/`.
- `MOG_` prefix (3 letters, matches `MVS_`) keeps the convention tight across Sebastian's projects.
- 3 repo-specific skills was the right count for MOG's complexity — fewer than MVS (which has phase-routing + schema-cascade concerns MOG doesn't have).
- All 5 user-global skills already at `~/.claude/skills/` were correctly placed — no moves needed.

### Outstanding from Section B (carry forward)

- **Confirm session auto-orientation works.** Open a fresh Claude Code session in `mog-mobile/`; CLAUDE.md should load, @-imports should resolve, the 3 repo-specific skills should appear in the available skills list. Smoke test of the scaffold itself.
- **Update `MOG_CurrentState.md` and CLAUDE.md's @-import line on each future shipping session.** The `mog-session-handoff` skill does this; don't bypass it.

---

## Files touched this chat

**Section A (consolidation):**
- `apps-script/` (new dir): MOGApi.gs, OrderGuideScript.gs, 7 HTML modals, appsscript.json, .clasp-targets.json, deploy.ps1, README.md
- `README.md` (modified)
- `.gitignore` (new)
- `stores.json` (modified — 2 new entries)
- `index.html` (modified — hub registry re-injected by build.py)
- `rpfrf/` (new dir, generated by build.py)
- `rptfo/` (new dir, generated by build.py)
- All existing per-store `<slug>/index.html` files (refreshed by build.py — content identical to prior except for the registry section)

**Section B (scaffold):**
- `CLAUDE.md` (new)
- `docs/MOG_CurrentState.md` (new)
- `docs/MOG_SessionHandoff_2026_05_24.md` (new, this file)
- `.claude/skills/mog-session-handoff/SKILL.md` (new)
- `.claude/skills/mog-deploy-workflow/SKILL.md` (new)
- `.claude/skills/mog-add-store/SKILL.md` (new)

**Memory written** (`~/.claude/projects/.../memory/`):
- `user_role.md` — Sebastian's role at HEH and technical preferences
- `mog_architecture.md` — the two-layer system
- `apps_script_deploy_workflow.md` — clasp + deploy.ps1 pattern
- `repo_consolidation_2026_05.md` — the merge + decommission timeline
- `reference_urls.md` — production URLs
- `feedback_explicit_safe_steps.md` — canary-first preference

Mirrored to both `C--Users-RAD-SEB-Documents-GitHub-Master-Ordering-Guide/memory/` and `C--Users-RAD-SEB-Documents-GitHub-mog-mobile/memory/`.

## Commits landed this session

```
d95080f Consolidate Apps Script source + add clasp deploy workflow
bb68221 Add Founders FOH and Tysons FOH stores
<pending> docs: add CLAUDE.md, docs/, and repo-specific skills    # this scaffold
```

## Opening prompt for next session

```
Resume MOG work. The 2026-05-24 session consolidated Master-Ordering-Guide
into mog-mobile and added the Claude Code scaffold. Two candidates for this
session, in order of impact:

1. If today is on/after 2026-05-31: decommission the old Master-Ordering-Guide
   GitHub repo (delete on GitHub, rename local folder to .archive). Confirm
   first that nothing has touched the old repo in the past week.
2. Otherwise: pick a small Apps Script or PWA improvement to ship end-to-end
   through the new deploy workflow — first real exercise of edit → deploy.ps1
   (or build.py + git push) → smoke test. Confirms the workflow is real.

Read docs/MOG_CurrentState.md for invariants and recent changes before
proposing edits.
```
