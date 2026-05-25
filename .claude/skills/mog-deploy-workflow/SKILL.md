---
name: mog-deploy-workflow
description: Route any MOG code change to the right layer and the right deploy mechanism. Use BEFORE writing any code edit in mog-mobile — it determines whether the change ships via clasp (apps-script/), build.py (template/ or stores.json), or just a git push (hub root, icons/, docs/). Trigger on phrases like "update the modal", "fix the picker", "deploy the change", "ship this to the stores", "run the build", "push to all stores", or any change request where the deploy path isn't yet stated. Also trigger when Sebastian asks for a "small fix" or "quick change" — that's exactly when routing gets skipped and the wrong layer gets touched. Skip only for pure docs edits (`docs/*.md`, `*.md` at root that aren't user-facing) where the deploy is literally just `git push`.
---

# mog-deploy-workflow

The first decision before any code edit in mog-mobile: which layer owns this change, and what's the deploy path? Getting this wrong ships fixes to the wrong place (e.g., editing `rpr/index.html` instead of `template/index.html`, losing the change on the next build) or leaves them stranded (e.g., editing `apps-script/MOGApi.gs` locally and forgetting to run `deploy.ps1`).

## The routing decision

Read the change request and answer: **which layer?**

| If the change is to... | Layer | Deploy mechanism | Verification |
|---|---|---|---|
| Server-side `.gs` logic (API, sheet ops, triggers) | Apps Script backend | `cd apps-script; .\deploy.ps1` (canary first: `-Target rpr`, then full) | Open the canary Sheet, exercise the changed function. After full deploy, spot-check 1-2 other stores. |
| HTML modal under `apps-script/*.html` | Apps Script backend | Same as above. **`rhino-safe-html` skill must trigger first** — modals run in Rhino ES5. | Open the modal in the canary Sheet, click through its workflow. |
| `apps-script/appsscript.json` (manifest, scopes) | Apps Script backend | Same. **Bump version awareness:** new OAuth scopes may require re-authorization in each Sheet. | After push, open the canary Sheet and run a function that uses the new scope; accept any re-auth prompt. |
| Per-store PWA UI (`template/index.html`, `template/sw.js`) | Per-store PWA | `python build.py` regenerates all `<slug>/` dirs → `git add -A; git commit; git push` → GitHub Pages auto-deploys (~1 min). | Open `sebheh.github.io/mog-mobile/rpr/` in incognito; verify the change. If shell changed, bump `template/sw.js`'s `CACHE_VERSION` first. |
| Hub picker (`index.html`, `sw.js` at root, `manifest.json`) | Hub | `git commit; git push` (no build needed unless `stores.json` also changed). | Open `sebheh.github.io/mog-mobile/` in incognito (or with `?force_picker=1`); verify picker behavior. |
| `stores.json` (new store, slug change, deployment URL update) | Hub registry | `python build.py` → `git commit; git push`. Build re-injects `STORE_REGISTRY` in root `index.html` AND regenerates all per-store dirs. | Open the hub; verify the new/changed tile appears and routes to the right URL. |
| `apps-script/.clasp-targets.json` (add/remove deploy target) | Deploy infrastructure | `git commit; git push` (config-only). Next `.\deploy.ps1` will pick it up. | `.\deploy.ps1 -DryRun` should list the new target without `FILL_ME_IN` errors. |
| `build.py` itself or `apps-script/deploy.ps1` | Deploy infrastructure | `git commit; git push`. Test by running the changed tool against a no-op input. | Run with `--dry-run` / `-DryRun` first, confirm output is what's expected, then run for real. |
| `icons/*` or `docs/*` | Static assets / docs | `git commit; git push`. | For icons: verify the PWA install prompt shows the new icon on a fresh device or after clearing site data. |

## Canary-first discipline (carry-forward from Sebastian's stated preference)

For ANY multi-target deploy (clasp to 9 stores; `build.py` regenerating 8 store dirs), do the canary first, then fan out:

1. Deploy to `rpr` only: `.\deploy.ps1 -Target rpr` for Apps Script changes. (For PWA changes, `build.py` already generates all 8 — but ASK Sebastian to test `sebheh.github.io/mog-mobile/rpr/` first before celebrating.)
2. Wait for Sebastian to actually open the thing and confirm it works. Don't accept "no errors in tooling output" as verification.
3. Only then run the full deploy: `.\deploy.ps1` for Apps Script, or just confirm the other 7 store URLs also work.

The reason: spreadsheet data and per-store state vary subtly. A change that works in rpr's data shape may surface a bug in tnyt's. Catching it on the canary means 1 store affected, not 9.

## When the layer choice isn't obvious

Common ambiguities and the right resolution:

- **"Fix the way the modal saves orders."** Is the modal the HTML (`apps-script/ManageItems.html`) or the server function (`apps-script/MOGApi.gs`)? If the save FAILS or returns wrong data → server. If the save works but the modal doesn't reflect it → modal. Read the actual symptom before picking.
- **"The picker isn't showing the new store."** Did `build.py` run after the `stores.json` edit? Check `git log --oneline -5` for a build artifact. If no — that's the bug, not anything in code.
- **"Bump the cache version."** Two SW files: `sw.js` (hub) and `template/sw.js` (store). Bump only the one whose shell changed. Both at once is a "throw out everything" move — fine occasionally, but call it out.
- **"It works on my computer but not on the store's iPad."** Service worker caching. Either bump CACHE_VERSION or have the user pull-to-refresh / hard-reload to bust the SW.

## Read before edit (always)

The local file may have drifted since the last session — Sebastian may have edited it directly in his editor, or a previous Claude session may have made changes. Before any Edit, read the relevant file first. The `source-of-truth-verification` user-global skill is the canonical reference for this.

## Anti-patterns specific to MOG

- **Editing `<slug>/index.html` (generated dir) "just this once" because it's faster.** Lost on the next build. Always edit `template/`.
- **Editing in the Apps Script editor for one store while iterating.** That edit gets blown away on the next `deploy.ps1` AND the other 8 targets keep running old code. Edit local, deploy to canary, smoke test, fan out.
- **Adding a `const STORE_SLUG = "rpr"` to a `.gs` file** to handle "just this one store's edge case." Breaks the "identical across all stores" invariant. Per-store config goes in spreadsheet data or PropertiesService.
- **Skipping `build.py` after `stores.json` edits "because the PWA already exists."** The `STORE_REGISTRY` injection in root `index.html` is build-managed. Skip the build and the picker won't show the new store.
- **Pushing to git without running `deploy.ps1` for Apps Script changes.** Git doesn't reach Google Apps Script. Two separate deploys.

## Decision template (use this in your response)

When routing a change, state the decision explicitly before editing:

```
Layer: <which layer from the table>
Files to edit: <absolute paths>
Deploy mechanism: <clasp / build.py / git only>
Verification: <how Sebastian will know it worked>
Canary-first: <yes — start with rpr / no — single-target change>
```

This makes the routing decision auditable and gives Sebastian a chance to redirect before any edit happens.
