# apps-script/

Source of truth for the Apps Script bound to each store's Master Ordering Guide Google Sheet. The code is identical across all store Sheets; differences live in the spreadsheet itself (sheet names, vendor lists, item data), not in the script.

`.clasp-targets.json` includes a `_template` entry — the master template Sheet that gets copied to set up new stores. Pushing the template means new stores are seeded with the latest code automatically.

## Files

| File | Purpose |
|---|---|
| `MOGApi.gs` | Core API for the PWA frontend to read/write order data |
| `OrderGuideScript.gs` | Main spreadsheet script: menus, modals, triggers |
| `AdminReset.html` | Admin-only reset/wipe modal |
| `ManageItems.html` | Item editor modal |
| `ManageVendors.html` | Vendor editor modal |
| `OrderHistory.html` | Past orders modal |
| `ReorderPickPath.html` | Pick-path reorder modal |
| `StorageAreas.html` | Storage area config modal |
| `HowToUse.html` | In-app help / how-to-use modal |
| `appsscript.json` | Apps Script manifest (timezone, OAuth scopes) |
| `.clasp-targets.json` | Maps each store's slug to its Apps Script Script ID |
| `deploy.ps1` | One-command push to all 6 stores (or one, with `-Target <slug>`) |

## One-time setup

1. Install Node.js LTS: <https://nodejs.org/>
2. Install clasp globally:
   ```powershell
   npm install -g @google/clasp
   ```
3. Log in once with the Google account that owns the store Sheets:
   ```powershell
   clasp login
   ```
4. Open each of the 6 Sheets, go to **Extensions > Apps Script > Project Settings (gear)**, copy the **Script ID**, and paste it into `.clasp-targets.json` (replace each `FILL_ME_IN`).
5. Pull the manifest from one store so the local `appsscript.json` matches what's deployed:
   ```powershell
   # In a throwaway temp folder:
   clasp clone <one-store-script-id>
   # Copy the resulting appsscript.json into this folder, then delete the temp folder.
   ```
6. **Reconciliation diff** (one-time, important): for each store's Script ID, `clasp clone` into a temp folder and diff against the files here. If any file in a Sheet's editor is newer or different, decide per-file what to keep — the goal is to make these local files the superset of truth **before** the first deploy. Otherwise the first deploy could roll back a recent hotfix.

## Daily workflow

After setup, the loop is:

1. Edit a file here (e.g. `MOGApi.gs`) locally.
2. Test the change (if possible).
3. Run:
   ```powershell
   .\deploy.ps1
   ```
4. All 6 Sheets now run the new code. Spreadsheet data, triggers, and named ranges are untouched.

**Do not edit code in the Apps Script editor anymore.** Edits in the editor get overwritten on the next `deploy.ps1` run. Treat this folder as the only source.

## Common commands

| Goal | Command |
|---|---|
| Deploy to all stores | `.\deploy.ps1` |
| Deploy to one store | `.\deploy.ps1 -Target rpr` |
| Dry run (no push) | `.\deploy.ps1 -DryRun` |
| Add a new store | 1) Copy the master template Sheet in Drive. 2) Open the new Sheet > Extensions > Apps Script > Project Settings > copy Script ID. 3) Append entry to `.clasp-targets.json`. 4) `.\deploy.ps1 -Target <newslug>` (optional — the copy already has latest code from the template, but redeploying is harmless and updates the manifest). 5) In the editor: run `setupMobileApi()`. 6) Deploy > New deployment > Web app. 7) Add the slug + deployment URL to `stores.json`, run `python build.py`, commit, push. |
| Roll back one store | In that Sheet's Apps Script editor: **File > See version history** > restore. Then fix the source here and redeploy. |

## Troubleshooting

- **"'clasp' is not recognized"** — Node.js or clasp not installed. See setup step 2.
- **"User has not enabled the Apps Script API"** — Go to <https://script.google.com/home/usersettings> and turn ON the Apps Script API for the account you logged into clasp with.
- **"Script ID not found"** — Wrong Script ID in `.clasp-targets.json`, or your clasp login account doesn't have edit access to that Script.
- **A push partially fails** — `deploy.ps1` continues to the next target and prints a per-target summary at the end. Re-run with `-Target <failed-slug>` after fixing.
- **Files in editor look out of date after push** — Reload the Apps Script editor tab. Clasp pushes immediately but the editor caches the file list.

## What's gitignored

- `.clasp.json` — rewritten per-target by `deploy.ps1`, never useful to commit.
- `.clasprc.json` — clasp login credentials, never commit.
