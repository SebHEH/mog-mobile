# apps-script/

Source of truth for the Apps Script bound to each store's Master Ordering Guide Google Sheet. The code is identical across all store Sheets; differences live in the spreadsheet itself (sheet names, vendor lists, item data), not in the script.

`.clasp-targets.json` includes a `_template` entry — the master template Sheet that gets copied to set up new stores. Pushing the template means new stores are seeded with the latest code automatically.

## Files

| File | Purpose |
|---|---|
| `MOGApi.gs` | Core API for the PWA frontend to read/write order data (called via each Sheet's `/exec` URL) |
| `OrderGuideScript.gs` | Main spreadsheet script: menus, modals, triggers, bound-sidebar handlers |
| `AdminReset.html` | Admin-only reset/wipe modal |
| `ManageItems.html` | Item editor modal |
| `ManageVendors.html` | Vendor editor modal |
| `OrderHistory.html` | Past orders modal |
| `ReorderPickPath.html` | Pick-path reorder modal |
| `StorageAreas.html` | Storage area config modal |
| `HowToUse.html` | In-app help / how-to-use modal |
| `appsscript.json` | Apps Script manifest (timezone, OAuth scopes) |
| `.clasp-targets.json` | Maps each store's slug to its `scriptId` (source push) and `deploymentId` (web-app /exec URL) |
| `deploy.ps1` | One-command push + optional web-app redeploy to all 9 targets |
| `discover-deployments.ps1` | One-time helper: finds each store's web-app deployment ID and prints a JSON snippet to paste into `.clasp-targets.json` |

## Two phases: source push vs. web-app redeploy

Apps Script has two distinct concepts that the deploy workflow has to handle. Confusing them costs hours.

| Phase | What it does | When you need it |
|---|---|---|
| **Source push** (`clasp push`) | Updates the bound script project's files. The Sheet's *bound sidebars* (ManageVendors, ManageItems, OrderHistory, etc.) read from HEAD, so they pick up changes on next sidebar open. | Every code change. |
| **Web-app redeploy** (`clasp deploy --deploymentId <id>`) | Publishes a new version under the Sheet's existing `/exec` URL. The PWA calls that URL — and it's a *versioned snapshot*, not HEAD, so pushes alone don't reach it. | Any change to `MOGApi.gs` (or any `.gs` function the PWA calls via `/exec`). |

**Rule of thumb:**
- Edited a `.gs` function that's only called by a `<file>.html` bound sidebar? **Push is enough** (`.\deploy.ps1`).
- Edited anything in `MOGApi.gs`, or any function with an `api_` prefix? **Redeploy too** (`.\deploy.ps1 -Redeploy`).
- Unsure? **Just `-Redeploy`**. It adds ~3s per target.

## One-time setup (per machine)

1. Install Node.js LTS: <https://nodejs.org/>
2. Install clasp globally:
   ```powershell
   npm install -g @google/clasp
   ```
3. Log in once with the Google account that owns the store Sheets:
   ```powershell
   clasp login
   ```
4. Allow local scripts to run (one-time, per Windows user):
   ```powershell
   Set-ExecutionPolicy -Scope CurrentUser -ExecutionPolicy RemoteSigned
   ```
5. If `.clasp-targets.json` has any `"scriptId": "FILL_ME_IN"` entries (new store), open each Sheet, **Extensions > Apps Script > Project Settings > Script ID**, paste into the file.
6. If `.clasp-targets.json` has any `"deploymentId": "FILL_ME_IN"` entries (fresh checkout that hasn't run discovery yet, or new store), run:
   ```powershell
   .\discover-deployments.ps1
   ```
   Paste the printed IDs into the matching entries.

**On a fresh machine with the repo already committed:** steps 1–4 + `clasp login`. Steps 5 and 6 only apply if `.clasp-targets.json` has placeholders. Real script IDs and deployment IDs are committed to git — they're project identifiers, not secrets.

## Daily workflow

After setup, the loop is:

1. Edit a file here locally (e.g. `MOGApi.gs` or `ManageVendors.html`).
2. Decide push-only or push+redeploy based on the rule of thumb above.
3. Canary first to `rpr`:
   ```powershell
   .\deploy.ps1 -Target rpr            # push only
   .\deploy.ps1 -Target rpr -Redeploy  # push + redeploy
   ```
4. Smoke-test in the live target (open the Sheet's sidebar, or the PWA at `sebheh.github.io/mog-mobile/rpr/`).
5. Fan out:
   ```powershell
   .\deploy.ps1            # push only, all 9
   .\deploy.ps1 -Redeploy  # push + redeploy, all 9 (template skips redeploy phase)
   ```

**Do not edit code in the Apps Script editor.** Edits there get overwritten on the next `deploy.ps1` run. This folder is the only source.

## Common commands

| Goal | Command |
|---|---|
| Push to all stores (bound-sidebar-only change) | `.\deploy.ps1` |
| Push + redeploy to all stores (MOGApi change) | `.\deploy.ps1 -Redeploy` |
| Push + redeploy with a tag | `.\deploy.ps1 -Redeploy -Description "Dashboard cache"` |
| Push to one store | `.\deploy.ps1 -Target rpr` |
| Push + redeploy one store | `.\deploy.ps1 -Target rpr -Redeploy` |
| Dry run (preview only) | `.\deploy.ps1 -DryRun` or `.\deploy.ps1 -DryRun -Redeploy` |
| Discover deployment IDs (one-time per machine, only if not committed) | `.\discover-deployments.ps1` |
| Discover for one new store | `.\discover-deployments.ps1 -Target <slug>` |
| Add a new store | See `.claude/skills/mog-add-store/SKILL.md` (the canonical onboarding procedure) |
| Roll back one store | In that Sheet's Apps Script editor: **File > See version history** > restore. Then fix the source here and redeploy. |

## Troubleshooting

- **"'clasp' is not recognized"** — Node.js or clasp not installed. See setup steps 1–2.
- **"-Redeploy requested but these targets are missing a deploymentId"** — Run `.\discover-deployments.ps1` and paste the printed IDs into `.clasp-targets.json`.
- **"No versioned web-app deployment found for this Sheet"** (during discovery) — The Sheet has never had a web app published. Open the script editor and **Deploy > New deployment > Web app** first, then re-run discovery.
- **"User has not enabled the Apps Script API"** — Go to <https://script.google.com/home/usersettings> and turn ON the Apps Script API for the account you logged into clasp with.
- **"Script ID not found"** — Wrong Script ID in `.clasp-targets.json`, or your clasp login account doesn't have edit access to that Script.
- **Push succeeds but PWA still serves old code** — You forgot `-Redeploy`. The bound sidebar will show the new code immediately; the PWA needs the web-app version bump.
- **A push or redeploy partially fails** — `deploy.ps1` continues to the next target and prints a per-target summary at the end. Re-run with `-Target <failed-slug>` after fixing.
- **Files in editor look out of date after push** — Reload the Apps Script editor tab. Clasp pushes immediately but the editor caches the file list.

## What's gitignored

- `.clasp.json` — rewritten per-target by `deploy.ps1` and `discover-deployments.ps1`, never useful to commit.
- `.clasprc.json` — clasp login credentials, never commit.
