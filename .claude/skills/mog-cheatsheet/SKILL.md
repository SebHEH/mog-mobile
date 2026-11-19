---
name: mog-cheatsheet
description: On-demand command cheat sheet for the MOG (mog-mobile) repo — every `build.py`, `deploy.py --relay`, `wait_live.py` and git invocation Sebastian might want to run, organized by goal. Use whenever Sebastian asks for "the cheat sheet", "cheatsheet", "deploy commands", "build commands", "what was that command again", "remind me how to deploy", "how do I push to all stores", "how do I deploy the relay", or any close variant of "show me the commands." ALSO trigger when Sebastian asks how to do a specific MOG operation that has a one-liner answer (e.g. "how do I dry-run the build", "how do I check it's live", "how do I canary one store"). When triggered, output the relevant section verbatim — don't paraphrase, don't reorder, don't add commentary. Skip when Sebastian is asking for the reasoning behind a command, the architecture of the deploy flow, or anything that requires explanation rather than recall — those go to `mog-deploy-workflow` instead.
---

# MOG Command Cheat Sheet

When this skill triggers, output the relevant section(s) below verbatim in the chat — pick by what Sebastian asked for. If he asked generically for "the cheat sheet", dump all sections.

All commands run from the **repo root** (`mog-mobile`).

Since Sheet retirement step 5 (2026-11-20) nothing deploys to the stores' Apps Script projects: the stores' `/exec` deployments are archived. `deploy.py` deploys only the mail relay.

---

## PWA build (build.py)

| Goal | Command |
|---|---|
| Regenerate all per-store dirs (and `hq/`, the hub registry, `supabase/functions/close/shared.mjs`) from `template/`, `apps-script/` and `stores.json` | `python build.py` |
| Preview the build without writing | `python build.py --dry-run` |
| Build a test store's app and editor into `_preview/` (git-ignored) | `python build.py --preview <slug> --like <slug>` |

**When to run:** after editing `template/`, `stores.json`, or a build source in `apps-script/` (`OrderMath.gs`, `Concepts.gs`, `RecapEmail.gs`, `Sync.gs`, the published editor pages). Idempotent — no-op if nothing changed. Don't edit per-store `<slug>/` dirs directly; they get overwritten.

---

## Gates

| Goal | Command |
|---|---|
| Every Node gate | `node tests/run_all.js` |
| The SQL in PGlite (after `npm ci` once) | `node supabase/tests/run_pglite.mjs` |

---

## Hub / PWA git workflow

Per-store PWA and hub changes go through git → GitHub Pages auto-deploys (~1 min).

| Goal | Command |
|---|---|
| Standard ship of PWA / hub changes | `git add -A && git commit -m "<msg>" && git push` |
| Check what's staged | `git status` |
| See what would push | `git log origin/main..HEAD --oneline` |
| Wait until every store serves it and CI is green | `python .claude/skills/mog-deploy-workflow/scripts/wait_live.py --marker "{store}/sw.js=CACHE_VERSION = 'vN'"` |
| The same after a canary (skip the canary's already-live file) | `python .claude/skills/mog-deploy-workflow/scripts/wait_live.py --marker "{store}/sw.js=CACHE_VERSION = 'vN'" --skip rprfo` |

---

## Mail relay deploy (deploy.py)

| Goal | Command |
|---|---|
| Push + redeploy the mail relay (Supabase's recap sender, `mail-relay/`) | `python deploy.py --relay` |
| The same with a description tag in its deployment history | `python deploy.py --relay --description "<msg>"` |
| Dry run of the mail relay deploy | `python deploy.py --relay --dry-run` |
| Show all flags | `python deploy.py --help` |

`--relay` fetches `origin/main` first and refuses a copy that's behind it or has uncommitted `mail-relay/` changes (`--skip-git-check` for emergencies).

---

## One-time setup on a new machine

| Step | Command |
|---|---|
| Install Node.js LTS | <https://nodejs.org/> |
| Confirm Python is 3.8+ | `python --version` |
| Only for the mail relay: install clasp globally | `npm install -g @google/clasp` |
| Only for the mail relay: log in once | `clasp login` |

The relay's `scriptId` and `deploymentId` are committed in `mail-relay/relay-target.json`.

---

## Common end-to-end flows

**template/ change (canary rprfo first):**
```
# edit template/<file>; bump CACHE_VERSION in template/sw.js if the shell changed
python build.py
git checkout -- <every store folder except rprfo>
git add -A && git commit -m "<msg> (canary rprfo)" && git push
# Sebastian tests sebheh.github.io/mog-mobile/rprfo/
python build.py                   # fan out
git add -A && git commit -m "<msg> (fan-out)" && git push
```

**stores.json change:**
```
# edit stores.json
python build.py                   # regenerate per-store dirs and the hub registry
git add -A && git commit -m "<msg>" && git push
# wait ~1 min for GitHub Pages
```

**OrderMath.gs, Concepts.gs or RecapEmail.gs change:**
```
# edit apps-script/<file>
node tests/run_all.js
python build.py                   # store pages + supabase/functions/close/shared.mjs
git add -A && git commit -m "<msg>" && git push
# then redeploy the Edge Function close through the Supabase connector (deploy_edge_function, verify_jwt false)
```

**Adding a new store:** see `.claude/skills/mog-add-store/SKILL.md`.
