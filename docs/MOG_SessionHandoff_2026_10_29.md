# Session Handoff — Supabase skills audit, and a second maintainer (Donny)

**Session date:** 2026-10-20 → 2026-10-29 (one chat)
**Author:** Sebastian
**Session focus:**
- mine the Supabase sessions for global skills;
- then set the project up so Sebastian and his assistant Donny can both maintain it.

**Outcome:** 3 commits (`eb907a0`, `2dd9264`, `1dbe516`), all pushed.
- **Skills:** two global Supabase skills (proposed, since applied by Claude-SKills) and a repo skill, `mog-supabase-schema`.
- **Probe fix:** `check_api.sh` no longer sends a wrong PIN to rprfo.
- **Two maintainers:** a section in CLAUDE.md, ONBOARDING.md for Donny, a git check in `deploy.py`, CI on GitHub, and Claude's memory moved into the repo.
- **CI:** the first GitHub run failed on line endings; after a fix the [second run passed](https://github.com/SebHEH/mog-mobile/actions/runs/40907682000).
- **Nothing the stores run changed.**

**Next session focus:** finish Donny's onboarding (Sebastian's invites, Donny's one-store test deploy), then back to the 2026-10-20 carry-forward: the Items page live check and the Vendors redesign.

---

## Section A — Supabase skills audit (2026-10-20)

- **What was mined:**
  - the 7 mog-mobile sessions from 10-15 to 10-20 (schema v1 → v9), through their handoffs' *Process lessons* and `docs/MOG_SupabaseMigration.md`;
  - this repo's last mining run was 08-03;
  - Supabase is used only in this repo.
- **Global proposals filed, both applied since by Claude-SKills:**
  - `supabase-schema-change`: the locked-down, functions-only pattern and the ritual every version repeated by hand. That covers:
    - re-runnable files;
    - the revoke + grant block (Postgres grants EXECUTE to PUBLIC, Supabase's defaults grant `anon`);
    - dropping an old signature;
    - `notify pgrst`;
    - the SQL smoke harness;
    - the public-key probe;
    - a JS fake that copies the foreign-key rules;
    - who runs the SQL.
  - `appsscript-to-supabase-migration`: moving an Apps Script + Sheets app one store at a time. It's based on one migration; Sebastian chose to file it anyway.
- **New repo skill [mog-supabase-schema](../.claude/skills/mog-supabase-schema/SKILL.md):**
  - the files every schema version touches;
  - the ship order (the SQL first, then the gates, then the deploy);
  - rollback;
  - the `zztestN` / `rprfotest` rules.
- **[route.py](../.claude/skills/mog-deploy-workflow/scripts/route.py)** used to send `supabase/schema_v9.sql` to `python deploy.py [UNKNOWN]`. It now routes `supabase/` and `tests/`, and prints a "FIRST: run the SQL" line.
- **Live finding, fixed:** [check_api.sh](../supabase/tests/check_api.sh) line 67 sent PIN `0` to rprfo's `mog_editor_login`, expecting `EDITOR_NOT_DIRECT`.
  - A read-only check showed every store `editor_direct = true` (all moved 10-19).
  - So the probe failed, and each run added a wrong PIN to rprfo's lockout counter, which its phones share.
  - It now probes `nosuchstore`; `smoke_v6.sql` still covers the refusal on `zztest6`.

## Section B — Two maintainers (2026-10-29)

**Decisions (Sebastian):**
- Donny works on branches and opens pull requests; Sebastian merges.
- Donny deploys too. He already has clasp; he consents once in each store first.
- Donny may run SQL in the Supabase SQL Editor.
- They tell each other before deploying or running SQL, so the git check is a light backstop.

**What was checked live:**
- GitHub `SebHEH/mog-mobile` is a public repo on a personal account: a collaborator gets write access, and nothing finer.
- Supabase org "HEH" is on the free plan, with one project. Read-only is a paid role, so Donny is a **Developer** (can run SQL, can't change settings).
- The Supabase MCP takes `read_only=true` in its URL.
- `appsscript.json` has `executeAs: USER_DEPLOYING`. Google's docs don't say whether another editor's redeploy switches who `/exec` runs as, so it's unmeasured.

**What shipped (commit `2dd9264`):**
- **[CLAUDE.md](../CLAUDE.md), section Two maintainers:**
  - who owns what on each service;
  - pull first; Donny's changes through a pull request;
  - never hand-merge the generated store folders;
  - the deploy rules;
  - who `/exec` and the triggers run as: whoever installed the 3:30 AM trigger sends the recap, so agree before re-installing one or onboarding a store;
  - SQL by either maintainer (tell the other which `schema_vN` you're taking);
  - handoffs name their author;
  - Donny's global-skill lessons go in his handoff, because the proposal mailbox is local to each computer.
- **[deploy.py](../deploy.py) git check:**
  - It fetches `origin/main` and refuses when this copy is missing commits from it. clasp pushes the local folder as it is, so a stale copy would roll the other person's Apps Script back on every store.
  - A deploy to every store needs `main` with `apps-script/` committed; a `--target` canary may run from a branch.
  - `--skip-git-check` is for emergencies.
  - Checked 9 of 9 cases in a scratch clone.
- **[gates.yml](../.github/workflows/gates.yml):** `node tests/run_all.js` on every push and pull request, with full git history (for `ordermath_equivalence`) and Python (for `editor_link`).
- **[docs/MOG_ProjectNotes.md](MOG_ProjectNotes.md), @-imported by CLAUDE.md:** the project facts that lived only in Claude's memory on Sebastian's computer, condensed. The old files sit unindexed in the memory folder's `_moved_to_repo_2026-10-29/`.
- **[ONBOARDING.md](../ONBOARDING.md):**
  - access and tools;
  - the team skills, then a first-time prompt;
  - `authorizeSupabase` in each of the 11 stores (links included);
  - a one-store test deploy;
  - the session-start and wrap-up prompts.
- **Skills:** `mog-supabase-schema` and `route.py` name either maintainer; `mog-deploy-workflow` explains the git check; `mog-session-handoff`'s spine has an **Author** line.

## Section C — CI's first run, and the line-ending fix (`1dbe516`)

- **The failure:** the first GitHub run failed 4 gates (catalog_parity, editor_fixes, supabase_move, supabase_step4). 12 planted-defect anchors were written with `\r\n`, which only a Windows checkout has; git stores LF and CI checks out LF.
- **Reproduced locally** on an LF clone with `TZ=UTC`: the same 4 gates failed.
- **The fix:** `plant()` in [tests/fake_apps_script.js](../tests/fake_apps_script.js) now rewrites the anchor and the replacement to the file's own line ending.
- **Result:** 24 of 24 on the LF clone, on Windows, and on GitHub.

## Outstanding (carry forward)

1. **Sebastian's setup steps** (click-paths are in this session's final message):
   1. GitHub collaborator on `SebHEH/mog-mobile` and `SebHEH/Claude-SKills`.
   2. Branch protection on `main`: a pull request with 1 approval, and the `gates` check required. Leave "Do not allow bypassing" unticked so Sebastian can still push.
   3. A Supabase invite to "HEH" as **Developer** (it expires after 24 h).
   4. Editor on the 11 Sheets (links in ONBOARDING.md step 4).
   5. PINs through the password manager.
   6. Send Donny the bootstrap prompt.
2. **Donny's first deploy is the measurement.** After consenting in all 11 stores, he runs `python deploy.py --redeploy --target rprfo` and checks rprfo's `/exec` (ONBOARDING.md step 5).
   - Record the result in `docs/MOG_ProjectNotes.md`, and drop "not measured" from CLAUDE.md rule 5.
   - If it fails, Sebastian redeploys rprfo from his computer.
3. **Still open from 2026-10-20 and not checked this session:**
   - Sebastian's live check of the Items page;
   - the Vendors redesign;
   - each store's recap going out once after the 10-20 fixes;
   - the held-back logic and redundancy items (CurrentState, Next-session candidates).
4. **Small:**
   - `mog-deploy-workflow`'s HTML-modal row still says modals run in Rhino ES5, which CLAUDE.md invariant #4 says is wrong.
   - GitHub warns that `actions/checkout@v4`, `setup-node@v4` and `setup-python@v5` target the deprecated Node 20, and that `ubuntu-latest` moves to Ubuntu 26. Bump the actions when newer majors are out, and watch the first run on Ubuntu 26.
   - The old memory files in `_moved_to_repo_2026-10-29/` can be deleted once nothing is found missing.

## Files touched this chat

- **Deploy:** `deploy.py` (git check).
- **CI:** `.github/workflows/gates.yml` (new).
- **Tests:**
  - `tests/fake_apps_script.js`: `plant()` matches the file's line ending.
  - `supabase/tests/check_api.sh`: the v6 probe now targets `nosuchstore`.
- **Docs:**
  - `CLAUDE.md` (Two maintainers, the Supabase row, the CI line, convention #6, the file inventory, the skills table);
  - `ONBOARDING.md` (new);
  - `docs/MOG_ProjectNotes.md` (new);
  - `docs/MOG_CurrentState.md`;
  - this handoff.
- **Repo skills:**
  - `mog-supabase-schema` (new);
  - `mog-deploy-workflow` (SKILL.md, `scripts/route.py`);
  - `mog-session-handoff` (Author line).
- **Outside the repo:**
  - two global proposals filed (applied since);
  - the session-mining log;
  - Claude's memory for this project, moved into the repo.

## Process lessons

- A probe whose expected answer depends on a real store's state goes stale when that store changes. The v6 editor-login probe became a real wrong-PIN attempt once rprfo's editor moved. Probe a store that doesn't exist, or use a bogus token or key. [→ .claude/skills/mog-supabase-schema/SKILL.md, supabase-schema-change]
- `route.py` had no rule for `supabase/`, so a schema file fell through to `deploy.py [UNKNOWN]`. A new layer needs a router rule the day it lands. [→ .claude/skills/mog-deploy-workflow/scripts/route.py]
- Gates written on Windows can rely on CRLF without anyone noticing, and CI on Linux checks out LF. To reproduce a CI failure locally, clone with `git -c core.autocrlf=false` and run with `TZ=UTC`. [→ tests/fake_apps_script.js, docs/MOG_ProjectNotes.md]
- GitHub Actions logs need a signed-in account even on a public repo: the logs API answers 403, and the page says "Sign in to view logs". The runs API gives status and step results without a token. [→ docs/MOG_ProjectNotes.md]
- When testing an edited tracked file inside a scratch clone, `git reset --hard` there quietly puts the old file back. Copy it in under an untracked name. [→ docs/MOG_ProjectNotes.md]
- With a second maintainer, Claude's memory and the global-proposal mailbox are both local to one computer. Project facts belong in the repo, and Donny's skill lessons go through his handoffs. [→ CLAUDE.md]

## Commits landed this session

```
1dbe516 tests: plant() matches the file's own line ending, so the gates pass on GitHub's Linux runner
2dd9264 Two maintainers: Donny joins (onboarding, roles, CI gates, a git check in deploy.py, project notes in the repo)
eb907a0 skills: mog-supabase-schema, a Supabase route in mog-deploy-workflow, and check_api.sh no longer sends a PIN to rprfo
```

## Opening prompt for next session

```
Read docs/MOG_CurrentState.md and docs/MOG_SessionHandoff_2026_10_29.md first. MOG has two
maintainers now (CLAUDE.md, Two maintainers): Sebastian merges Donny's pull requests, both can
deploy (deploy.py refuses a copy that is behind origin/main) and run SQL, and CI runs the 24 gates
on GitHub. Nothing the stores run changed since 2026-10-20 (app v0.26.1 / cache v67, schema v9).

First: ask whether Sebastian's setup steps for Donny are done and whether Donny's one-store test
deploy on rprfo worked; record that result in docs/MOG_ProjectNotes.md and CLAUDE.md rule 5. Then
the 2026-10-20 carry-forward: Sebastian's live check of the Items page, and the Vendors redesign
(https://claude.ai/artifact/BmVaV6v55MnHx39gJ7mH4K, screens 5-6) as an app-only
template/editor/Vendors.html. Run git pull before anything.
```
