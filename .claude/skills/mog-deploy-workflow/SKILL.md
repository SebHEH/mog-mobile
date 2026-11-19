---
name: mog-deploy-workflow
description: Route any MOG code change to the right layer and the right deploy mechanism. Use BEFORE writing any code edit in mog-mobile — it determines whether the change ships via build.py and a git push (template/, stores.json, apps-script/ sources), the Supabase connector (supabase/ SQL first, the Edge Function `close`), `deploy.py --relay` (mail-relay/), or just a git push (hub root, icons/, docs/). Trigger on phrases like "update the page", "fix the picker", "deploy the change", "ship this to the stores", "run the build", "push to all stores", or any change request where the deploy path isn't yet stated. Also trigger when Sebastian asks for a "small fix" or "quick change" — that's exactly when routing gets skipped and the wrong layer gets touched. Skip only for pure docs edits (`docs/*.md`, `*.md` at root that aren't user-facing) where the deploy is literally just `git push`.
---

# mog-deploy-workflow

The first decision before any code edit in mog-mobile: which layer owns this change, and what's the deploy path? Getting this wrong ships fixes to the wrong place (e.g., editing `rpr/index.html` instead of `template/index.html`, losing the change on the next build) or leaves them stranded (e.g., editing `apps-script/OrderMath.gs` and forgetting that the nightly close runs a copy of it in the Edge Function `close`).

Since Sheet retirement step 5 (2026-11-20) nothing deploys to the stores' Apps Script projects: their `/exec` deployments are archived and the Sheets stay in Drive, frozen. `apps-script/` is only a source for `build.py` (and the gates). The one Apps Script project still deployed is the mail relay.

## Deterministic router (run this first)

Don't eyeball the table — run the router. From repo root:

```
python .claude/skills/mog-deploy-workflow/scripts/route.py <changed-path> [<path> ...]
```

It prints the layer and every action the changed files need (a build, an Edge Function redeploy, the relay, SQL first), whether canary-first applies, and a VERIFY note for the ambiguous cases. The table below is the human-readable version of the same rules: use it to understand *why*; use the router to decide.

## The routing decision

Read the change request and answer: **which layer?**

| If the change is to... | Layer | Deploy mechanism | Verification |
|---|---|---|---|
| Per-store PWA UI (`template/index.html`, `template/sw.js`) | Per-store PWA | `python build.py` regenerates all `<slug>/` dirs → commit → push → GitHub Pages deploys (~1 min). Canary `rprfo` first (below). | Open `sebheh.github.io/mog-mobile/rprfo/` in incognito; verify the change. If the shell changed, bump `template/sw.js`'s `CACHE_VERSION` first. |
| `apps-script/OrderMath.gs`, `Concepts.gs` or `RecapEmail.gs` | Build source (pages and the nightly close) | `python build.py` (it injects `OrderMath.gs` into every store page and regenerates `supabase/functions/close/shared.mjs`) → commit → push; then redeploy the Edge Function `close` through the Supabase connector's `deploy_edge_function` (`index.ts`, `core.mjs`, `shared.mjs` as in the repo, `verify_jwt` false). | `node tests/run_all.js` (the order-math and `night_close` gates); the next morning's `close` rows in `mog.night_log`. |
| Any other `apps-script/` file (`Sync.gs`'s Supabase URL and key, the editor pages published under `<slug>/editor/`) | Build source | `python build.py` → commit → push. Nothing reaches a Sheet. | Open the changed page in the app on a computer (Manage). |
| `mail-relay/*` (the recap sender) | Mail relay | `python deploy.py --relay` (pushes and redeploys its one deployment; the address never changes). | A test email (`mog.backup_watch_test()` or the spec's test run), then the next recap's `recap` row. |
| `supabase/functions/*` | Supabase Edge Function | The connector's `deploy_edge_function` with the folder's files as in the repo, `verify_jwt` false. A deploy that changes what tonight's close does is a cutover: report what ran and the rollback. | A call without Vault's secret answers 401; the next `close` rows. |
| `supabase/schema_vN.sql` (a new or changed `mog_*` function, table or column) | Supabase | **Runs FIRST, before any deploy below.** On the maintainer's go for that file, Claude runs it through the Supabase connector, or the maintainer pastes it in the SQL Editor; then `smoke_vN.sql`, then `check_api.sh`. The database ships before the code that relies on it. Then the calling code's own row in this table. Files and order: **`mog-supabase-schema`**. | Every smoke row PASS, `check_api.sh` all PASS, then a read-only `execute_sql` check on project `mnfwqmrstdeuczveyykv`. |
| Hub picker (`index.html`, `sw.js` at root, `manifest.json`) | Hub | Commit and push (no build needed unless `stores.json` also changed). | Open `sebheh.github.io/mog-mobile/` in incognito (or with `?force_picker=1`); verify picker behavior. |
| `stores.json` (a new store, its `ns`) | Hub registry | `python build.py` → commit → push. Build re-injects `STORE_REGISTRY` in root `index.html` AND regenerates all per-store dirs. A new store: **`mog-add-store`**. | Open the hub; verify the new/changed tile appears and routes to the right URL. |
| `build.py` or `deploy.py` itself | Deploy infrastructure | Commit and push. Test by running the changed tool against a no-op input. | Run with `--dry-run` first, confirm output is what's expected, then run for real. |
| `icons/*` or `docs/*` | Static assets / docs | Commit and push. | For icons: verify the PWA install prompt shows the new icon on a fresh device or after clearing site data. |
| `tests/*` | Gates | Nothing deploys. `node tests/run_all.js`, then commit with the code it gates. | All gates pass. |

**After any push to `main`, check it's live with [`scripts/wait_live.py`](scripts/wait_live.py)**, in the background, instead of writing a poll script (one was written by hand for every push from 10-29 on):

```bash
python .claude/skills/mog-deploy-workflow/scripts/wait_live.py --marker "hq/warehouse.js=routesStopped" --marker "{store}/sw.js=CACHE_VERSION = 'v75'"
```

Each `--marker` is `PATH=TEXT`; `{store}` expands to all 10 stores. It refuses a marker the previous commit already has (`--base REV` to compare further back), polls every file with a cache-busting query, then waits for the CI run named `gates` on HEAD. Exit 0 live and green, 1 gates failed, 2 timed out or refused.

## Canary-first discipline (carry-forward from Sebastian's stated preference)

The canary store is **`rprfo`** (it moved from `rpr` on 2026-05-27 — rprfo is the least dangerous store, and rpr's pars may not be true 1-day pars). The authoritative value lives in `route.py`'s `CANARY` constant; this prose mirrors it. If the canary ever moves again, change the constant in `route.py` and re-run the router — don't hand-edit slugs into the skills.

For an app change (`build.py` regenerating every store folder), do the canary first, then fan out:

1. **Canary one store.** `build.py` regenerates every store folder, so: run it, then `git checkout -- <every other store folder>`, and commit the `template/` source plus only the canary's `<slug>/index.html` and `<slug>/sw.js`. The other stores keep serving their old page until the fan-out. Afterwards, check the canary's live `sw.js` shows the new `CACHE_VERSION` and another store's still shows the old one. Then ask Sebastian to test the canary's URL.
   **CI runs on the canary commit too, with the other stores still on the old build.** A gate that reads the built `<slug>/` folders checks each store against itself (its page and its published files agree), never the final state of every store. `manage_pages`' first version required that no store still had `editor/healthcheck.html` and would have gone red on the 2026-11-11 canary.
2. Wait for Sebastian to actually open the thing and confirm it works. Don't accept "no errors in tooling output" as verification.
3. **Fan out:** `python build.py` again with all store folders committed. Check it with `wait_live.py --marker "{store}/sw.js=CACHE_VERSION = 'vN'" --skip rprfo`: the canary's old file already has the marker, so without `--skip` the check refuses (2026-11-15).

**Two maintainers (since 2026-10-29):**
- Nobody is told before a deploy: whoever continues pulls the latest (CLAUDE.md, Two maintainers).
- `deploy.py --relay` fetches `origin/main` first and refuses when this copy is missing commits from it, or when `mail-relay/` has uncommitted changes, because clasp pushes the local folder as-is. `--skip-git-check` is for emergencies.
- A deploy that changes nothing a live store does (code behind a switch that's off, a canary of it) runs without a question: run it, then report. Turning on a store's `close_direct`, or any other cutover, runs without a question too since 2026-11-15, one store first and the rest after its nights are clean; report what ran, the gate line and the rollback (CLAUDE.md, Working conventions 2).
- Rollback is fix forward plus the nightly backup (`SebHEH/mog-backup`): there is no Apps Script to switch back to.

The reason for the canary: store data and per-store state vary subtly. A change that works in the canary's data shape may surface a bug in tnyt's. Catching it on the canary means 1 store affected, not 10.

**Staged-commit discipline (when a session is planned as N separate commits).** It's fine — often better — to bundle several logical changes onto *one* canary smoke test for efficiency. But **commit each logical change before you start editing the next one.** If you deploy change A to canary, then edit change B on top before committing A, you can no longer make two clean commits without reconstructing A from a scratchpad snapshot (the working tree now holds A+B intermingled). Commit A first → the second commit is then just B's diff. The canary bundling and the commit granularity are independent: deploy whenever it's efficient, but don't let an uncommitted stage pile onto the next.

## Removing or changing something KMs use: read the brief first

Before writing code that removes or changes a KM-facing feature (a button, an email, a screen, a
step in the daily routine), grep [docs/MOG_OrderingApp_KM_Brief.md](../../../docs/MOG_OrderingApp_KM_Brief.md)
and [docs/MOG_LogicBlueprint.md](../../../docs/MOG_LogicBlueprint.md) for it. A rule written there
("DO NOT SKIP", an owner-confirmed `R#`) is a decision Sebastian made; put it and the evidence in the
question **before** building, and rewrite the brief in the same change if the answer stands.
(2026-11-15: the Daily summary was removed on "nobody uses it"; the brief's 11-03 rule making it a
DO NOT SKIP step for placing orders surfaced only after the rprfo canary shipped, and the decision
had to be asked a second time.)

## When the layer choice isn't obvious

Common ambiguities and the right resolution:

- **"Fix the way Manage saves items."** Is it the page (`template/editor/*.html`, `catalogEdit.js`) or the Supabase function it calls (`mog_*` in `supabase/`)? If the save FAILS or returns wrong data → the function (a schema version). If the save works but the page doesn't reflect it → the page. Read the actual symptom before picking.
- **"The picker isn't showing the new store."** Did `build.py` run after the `stores.json` edit? Check `git log --oneline -5` for a build artifact. If no — that's the bug, not anything in code. A test store (`"test": true`) is never on the hub, by design.
- **"Bump the cache version."** Two SW files: `sw.js` (hub) and `template/sw.js` (store). Bump only the one whose shell changed. Both at once is a "throw out everything" move — fine occasionally, but call it out.
- **"It works on my computer but not on the store's iPad."** Service worker caching. Either bump CACHE_VERSION or have the user pull-to-refresh / hard-reload to bust the SW.
- **"The recap or the close is wrong."** The close runs in Supabase (`mog.night_close`, the Edge Function `close`), its order math and email from `apps-script/OrderMath.gs`, `Concepts.gs` and `RecapEmail.gs` via `shared.mjs`; the email leaves through the relay. A change to any of them is a build plus an Edge Function redeploy, not a Sheet change.

## Read before edit (always)

The local file may have drifted since the last session — Sebastian may have edited it directly in his editor, or a previous Claude session may have made changes. Before any Edit, read the relevant file first. The `source-of-truth-verification` user-global skill is the canonical reference for this.

## Anti-patterns specific to MOG

- **Editing `<slug>/index.html` (generated dir) "just this once" because it's faster.** Lost on the next build. Always edit `template/`.
- **Editing `supabase/functions/close/shared.mjs` by hand.** `build.py` generates it from the three `.gs` files; edit those and rebuild.
- **Changing `OrderMath.gs` and pushing without redeploying `close`.** The phones get the new math on the next build; the nightly close keeps the old copy until the Edge Function is redeployed.
- **Skipping `build.py` after `stores.json` edits "because the PWA already exists."** The `STORE_REGISTRY` injection in root `index.html` is build-managed. Skip the build and the picker won't show the new store.
- **Expecting a Sheet or its Apps Script to change anything.** The Sheets are frozen and nothing deploys to them; no store calls a store `/exec`.

## Decision template (use this in your response)

When routing a change, state the decision explicitly before editing:

```
Layer: <which layer from the table>
Files to edit: <absolute paths>
Deploy mechanism: <build.py + push / Edge Function / deploy.py --relay / SQL first / git only>
Verification: <how Sebastian will know it worked>
Canary-first: <yes — start with rprfo / no — single-target change>
```

This makes the routing decision auditable and gives Sebastian a chance to redirect before any edit happens.
