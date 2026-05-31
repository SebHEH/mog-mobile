---
name: mog-add-store
disable-model-invocation: true
description: End-to-end checklist for onboarding a new store location to the MOG system — from copying the master template Sheet in Google Drive to the new store's PWA URL going live on the hub. Trigger when Sebastian asks to "add a new store", "set up a new location", "onboard a city or concept", "new sheet for a location", or any close variant. The procedure has 8 steps spanning Drive UI, Apps Script editor, local files, and git — most steps are user-actions Sebastian must perform himself; Claude's job is to guide the order, validate inputs along the way, and handle the local file edits in the middle. Skip when the user only wants to update an existing store's data or deployment URL — that's a `stores.json` edit, not a full onboarding.
---

# mog-add-store

The full procedure for adding a new store. It mixes external steps (Drive UI, Apps Script editor clicks) with local steps (file edits, build, deploy). Claude can't drive the external pieces — those need Sebastian to act and report back. The skill's value is sequencing, validation, and handling the local pieces correctly.

## Prerequisites

Before starting, confirm with Sebastian:
- **Slug** to use for the new store (e.g. `rpfo` for Roll Play Foundation, lowercase letters/digits/hyphens only, must not conflict with existing slugs in `stores.json`).
- **Concept** name (e.g. "Roll Play", "Teas'n You", "ĂN", "Lei'd Poke"). Existing concepts already have themes wired up in `build.py`'s `CONCEPT_TO_THEME` map; a brand-new concept means a `build.py` change too.
- **Location label** (e.g. "Tysons FOH", "Founders BOH"). Free-text, displayed in the hub picker.
- **Store PIN** Sebastian wants to set (4-8 digits). He sets this during `setupMobileApi()`; you just need to confirm he's ready.

If the concept is new (not in `build.py`'s `CONCEPT_TO_THEME` map): pause here, add the new concept to the map, and confirm a theme CSS block exists in `template/index.html` for the new theme slug. Don't proceed until that's settled — otherwise the PWA renders unthemed.

## The 8 steps

Walk Sebastian through them one at a time. Don't dump the full list at once — surface each step, wait for confirmation, then move to the next. The flow has natural pause points where his input is needed.

### Step 1 (Sebastian, in Drive) — Copy the master template Sheet

1. Open Google Drive in his browser as `sebastian@hehfood.com`.
2. Right-click the master template Sheet (the one whose Script ID is in `apps-script/.clasp-targets.json` as `_template`) → **Make a copy**.
3. Rename the copy to a descriptive name (e.g. "MOG - Roll Play Tysons FOH").
4. Move it to the appropriate Drive folder.

**Verification:** Sebastian confirms the copy exists and is renamed.

### Step 2 (Sebastian, in the new Sheet) — Grab the Script ID

1. Open the new Sheet.
2. **Extensions → Apps Script** (opens the bound script editor in a new tab).
3. **Project Settings (gear icon)** on the left sidebar.
4. Copy the **Script ID** from the "IDs" section.
5. Paste it back to Claude.

**Validation:** Run the deterministic validator instead of eyeballing it:

```
python .claude/skills/mog-add-store/scripts/validate.py scriptid <the pasted value>
```

`OK` (exit 0) means proceed. `INVALID` (exit 1) prints the reason — most commonly Sebastian grabbed a deployment ID (`AKfycb...`) instead of the Script ID; redirect him to Project Settings.

### Step 3 (Claude, locally) — Add to `.clasp-targets.json` and push code

Edit `apps-script/.clasp-targets.json`. Insert the new entry in a sensible spot (group by concept, keep template at top):

```json
{
  "slug": "<newslug>",
  "label": "<Concept> - <Location>",
  "scriptId": "<the script ID Sebastian just pasted>"
}
```

Then push code to ONLY the new store (canary-style; no need to redeploy the others). From the repo root:

```
python deploy.py --target <newslug>
```

**Verification:** `deploy.py` reports `PUSH OK: <newslug>` with 10 files pushed. If it errors with "Project settings not found" or similar, the Script ID is wrong — back up to Step 2.

### Step 4 (Sebastian, in the new Sheet's Apps Script editor) — Run `setupMobileApi()`

1. In the Apps Script editor (already open from Step 2), pick `setupMobileApi` from the function dropdown.
2. Click **Run**. Accept any authorization prompts (this is the first run; OAuth flow will trigger).
3. Five prompts will appear in order:
   - **Store PIN** (4-8 digits) — the credential KMs use to log into the PWA.
   - **Location name** (e.g. "Roll Play Tysons FOH") — displayed in the PWA header.
   - **Abbreviation** (2-5 letters, e.g. "RPTF") — short code used in UI.
   - **GM email** (optional) — leave blank if unknown.
   - **Master PIN** (optional) — leave blank if this store should NOT be reachable via the multi-unit manager-mode flow. Use the shared HEH master PIN to enable.

**Verification:** Sebastian confirms all 5 prompts went through without errors. The function prints "Setup complete" or similar on success.

### Step 5 (Sebastian, in the new Sheet's Apps Script editor) — Deploy as web app

1. **Deploy → New deployment**.
2. Click the gear next to "Select type" → **Web app**.
3. Fill in:
   - Description: e.g. "Initial deploy for Roll Play Tysons FOH" (free text, for audit trail).
   - Execute as: **Me** (`sebastian@hehfood.com`).
   - Who has access: **Anyone**.
4. Click **Deploy**.
5. Accept any authorization prompts.
6. Copy the **Web app URL** at the end (looks like `https://script.google.com/macros/s/<deployment-id>/exec`).
7. Paste it back to Claude.

**Validation:** Run the validator instead of eyeballing it:

```
python .claude/skills/mog-add-store/scripts/validate.py exec-url <the pasted URL>
```

`OK` means proceed. `INVALID` means it ends in `/edit` or `/dev` — Sebastian copied the wrong URL; redirect him to the "Web app URL" field specifically.

The deployment ID inside that URL is what `deploy.py --redeploy` needs for future MOGApi.gs changes to reach this store. Add it to `.clasp-targets.json` now so future deploys "just work":

```
python deploy.py --discover --target <newslug>
```

Paste the printed `deploymentId` into the entry you added in Step 3.

**Verification:** `deploy.py --discover` prints `Found deployment @1: AKfycb...`. If it prints "No versioned web-app deployment found", Step 5 didn't actually publish (re-check that "Deploy" was clicked, not just "Save").

### Step 6 (Claude, locally) — Add to `stores.json`

Edit `stores.json`. Insert a new entry, grouped with other stores of the same concept:

```json
{
  "slug": "<newslug>",
  "concept": "<Concept>",
  "location": "<Location label>",
  "deployment": "<the URL Sebastian just pasted>"
}
```

`build.py` validates the URL pattern on the next run; if it fails fast, the validation regex caught a wrong-shape URL.

### Step 7 (Claude, locally) — Run `build.py` and commit

```powershell
python build.py
```

**Verification:** Output shows `[done] mkdir <newslug>/` and `[done] write <newslug>/index.html`. New directory exists at `mog-mobile/<newslug>/`.

Then commit:

```
git add stores.json index.html <newslug>/
git commit -m "Add <Concept> <Location> store (<newslug>)"
git push origin main
```

**GitHub Pages takes ~1 min to redeploy.**

### Step 8 (Sebastian, on his phone or browser) — Smoke test

1. Open `https://sebheh.github.io/mog-mobile/` in an incognito tab.
2. New store should appear in the concept picker (or as an additional tile if the concept already exists).
3. Tap it → should load `/<newslug>/`.
4. PIN gate should accept the store PIN set in Step 4.
5. If the master PIN was set: also verify it via the multi-unit manager flow.

**Verification:** Sebastian confirms the new store loads and authenticates. If it doesn't, troubleshooting tree:
- 404 on `/<newslug>/`? Pages hasn't rebuilt yet, or `build.py` didn't run. Check the latest commit.
- PIN rejected? Wrong PIN typed, or `setupMobileApi()` didn't complete. Re-run in Apps Script editor.
- Page loads but says "deployment URL not set" or similar? `stores.json` entry has the wrong URL — back up to Step 5/6.
- "Master code not accepted" banner? Master PIN wasn't set (or set to a different value than the other stores) — re-run `setMasterPin` in the Apps Script editor.

## State to update afterward

After the 8 steps complete and smoke test passes:
- The `mog-session-handoff` skill should fire at session close (this onboarding is a "shipping session").
- `docs/MOG_CurrentState.md` should be updated: add the new store to the "Live stores" table and "Deploy targets" table.

## Anti-patterns

- **Don't skip the canary deploy in Step 3.** If you run `python deploy.py` (all targets) instead of `python deploy.py --target <newslug>`, you'd redeploy to 8 other stores unnecessarily. Harmless if the code hasn't changed locally, but wasteful and risks unintended pushes if it has.
- **Don't update `stores.json` BEFORE the web app is deployed.** `build.py` validates the deployment URL pattern; a placeholder URL will fail validation, and a real-but-not-yet-deployed URL will 500 when the PWA hits it.
- **Don't forget the `setupMobileApi()` step.** Without it, the Sheet has the code but no per-store PropertiesService config — the PWA will load but auth will fail mysteriously.
- **Don't reuse a slug that was previously published and then removed.** KMs may have home-screen icons at `/<slug>/`. Pick a new slug; the old one stays retired.
- **Don't add a brand-new concept (one not in `CONCEPT_TO_THEME`) without also updating `build.py` and `template/index.html`'s theme CSS.** The PWA will render but un-themed (default look) instead of brand-correct.

## When this skill should NOT run

- "Update the deployment URL for an existing store" → just a `stores.json` edit + `build.py` + push. No full onboarding needed.
- "Rename a store's location label" → same.
- "Change the store PIN" → run `setupMobileApi()` again in that store's Apps Script editor; no other steps.
- "Remove a store" → manual `git rm -r <slug>/`, remove from `stores.json`, `build.py`, push. No skill for this yet; ask Sebastian if he wants one.
