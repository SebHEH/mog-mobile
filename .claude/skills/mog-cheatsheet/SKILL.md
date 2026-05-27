---
name: mog-cheatsheet
description: On-demand command cheat sheet for the MOG (mog-mobile) repo — every `deploy.py` and `build.py` invocation Sebastian might want to run, organized by goal. Use whenever Sebastian asks for "the cheat sheet", "cheatsheet", "deploy commands", "build commands", "what was that command again", "remind me how to deploy", "how do I push to all stores", "what's the flag for redeploy", "what does --redeploy do", or any close variant of "show me the commands." ALSO trigger when Sebastian asks how to do a specific MOG operation that has a one-liner answer (e.g. "how do I deploy just to rpr", "how do I discover a deployment ID for a new store", "how do I dry-run a deploy"). When triggered, output the relevant section verbatim — don't paraphrase, don't reorder, don't add commentary. Skip when Sebastian is asking for the reasoning behind a command, the architecture of the deploy flow, or anything that requires explanation rather than recall — those go to `mog-deploy-workflow` instead.
---

# MOG Command Cheat Sheet

When this skill triggers, output the relevant section(s) below verbatim in the chat — pick by what Sebastian asked for. If he asked generically for "the cheat sheet", dump all sections.

All commands run from the **repo root** (`C:\Users\sebcn\Documents\Github\mog-mobile` on the `sebcn` machine), not from `apps-script/`.

---

## Apps Script deploy (deploy.py)

| Goal | Command |
|---|---|
| Push to all 9 stores (bound-sidebar change, e.g. ManageVendors / ManageItems / OrderHistory edits) | `python deploy.py` |
| Push + redeploy web-app URL to all (MOGApi.gs / any `api_*` change) | `python deploy.py --redeploy` |
| Push + redeploy with a description tag in deployment history | `python deploy.py --redeploy --description "<msg>"` |
| Canary push to one store only | `python deploy.py --target rprfo` |
| Canary push + redeploy to one store | `python deploy.py --target rprfo --redeploy` |
| Dry run (preview, nothing runs) | `python deploy.py --dry-run` |
| Dry run preview of push + redeploy | `python deploy.py --dry-run --redeploy` |
| Find deploymentIds for fresh checkout or new store | `python deploy.py --discover` |
| Find deploymentId for one new store | `python deploy.py --discover --target <slug>` |
| Show all flags | `python deploy.py --help` |

**When `--redeploy` is required:** any change to `MOGApi.gs` or any `api_*` function the PWA calls via the `/exec` URL. When unsure, pass `--redeploy` — costs ~3s/target extra. Bound-sidebar changes (Manage*, OrderHistory, etc.) don't need it.

**Canary-first discipline:** `--target rprfo` first, smoke-test, then fan out with no `--target` flag. (Canary = `rprfo`; `route.py`'s `CANARY` constant is the source of truth — if it ever moves again, change it there, not here.)

---

## PWA build (build.py)

| Goal | Command |
|---|---|
| Regenerate all per-store dirs from `template/` + `stores.json` | `python build.py` |
| Preview the build without writing | `python build.py --dry-run` |

**When to run:** after editing `template/index.html`, `template/sw.js`, or `stores.json`. Idempotent — no-op if nothing changed. Don't edit per-store `<slug>/` dirs directly; they get overwritten.

---

## Hub / PWA git workflow

Per-store PWA and hub changes go through git → GitHub Pages auto-deploys (~1 min).

| Goal | Command |
|---|---|
| Standard ship of PWA / hub changes | `git add -A && git commit -m "<msg>" && git push` |
| Check what's staged | `git status` |
| See what would push | `git log origin/main..HEAD --oneline` |

---

## One-time setup on a new machine

| Step | Command |
|---|---|
| Install Node.js LTS | <https://nodejs.org/> |
| Install clasp globally | `npm install -g @google/clasp` |
| Log in once | `clasp login` |
| Confirm Python is 3.8+ | `python --version` |
| Discover deploymentIds (only if `.clasp-targets.json` has `FILL_ME_IN`) | `python deploy.py --discover` |

Real `scriptId` and `deploymentId` values are committed to git — fresh checkouts only need `clasp login`, not the discovery step.

---

## Common end-to-end flows

**Bound-sidebar change (e.g. ManageVendors.html):**
```
# edit apps-script/ManageVendors.html
python deploy.py --target rprfo     # canary
# smoke-test the sidebar in the rprfo Sheet
python deploy.py                  # fan out
git add -A && git commit -m "<msg>" && git push
```

**MOGApi.gs change (PWA-facing):**
```
# edit apps-script/MOGApi.gs
python deploy.py --target rprfo --redeploy
# smoke-test the PWA at sebheh.github.io/mog-mobile/rprfo/
python deploy.py --redeploy
git add -A && git commit -m "<msg>" && git push
```

**stores.json or template/ change:**
```
# edit stores.json or template/<file>
python build.py                   # regenerate per-store dirs
git add -A && git commit -m "<msg>" && git push
# wait ~1 min for GitHub Pages
```

**Adding a new store:** see `.claude/skills/mog-add-store/SKILL.md` — full 8-step procedure.

---

## Quick reference: which flag does what

| Flag | Effect |
|---|---|
| `--target <slug>` | Limit to one target. Default: all 9. |
| `--dry-run` | Print what would happen; nothing runs. |
| `--redeploy` | After pushing, bump each store's web-app version (so PWA's `/exec` URL serves new code). Skipped for `_template`. |
| `--description "<msg>"` | Tag the redeploy in clasp's deployment history. Only used with `--redeploy`. |
| `--discover` | Discovery mode: find deploymentIds for non-template targets. Mutually exclusive with the push flow. |
