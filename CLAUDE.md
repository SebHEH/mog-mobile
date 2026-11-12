# MOG (Master Ordering Guide) — Multi-store PWA + Apps Script backend

A Progressive Web App hosted at `sebheh.github.io/mog-mobile/` plus the Google Apps Script backend that runs inside each store's Google Sheet. KMs at each Happy Endings Hospitality location use the PWA on their phones to manage inventory orders; the Apps Script reads and writes the Sheet that holds the data.

This file is loaded into context at every Claude Code session start. Its @-imports are binding — read them before proposing any change.

## Canonical reference docs (read on session start)

If sources conflict, items higher in this list win for "what's currently in flight." `CLAUDE.md` itself wins for project structure and invariants.

@docs/MOG_CurrentState.md

Project facts and gotchas live in `docs/MOG_ProjectNotes.md`. It is not auto-loaded: read the section before working in that area. Sections: Direction, Stores, Deploys and rollout, Supabase (including the mail relay), HQ control, LTOs, Happy Supply (the warehouse), Local previews and the browser pane, CI and tests, Worktree sessions and pull requests, Google Drive connector, Claude on Windows. The full file inventory is `docs/MOG_FileInventory.md`.

## Latest session handoff

Replace the path here with the newest handoff at the end of each session that ships material changes. (The `mog-session-handoff` skill rewrites this line.)

@docs/MOG_SessionHandoff_2026_11_12.md
If `docs/` holds a newer `MOG_SessionHandoff_*.md` than the import above (sort by name), read the newest one first. The SessionStart context guard flags a lagging import.

## Quick orientation

- **Runtime / stack**: Vanilla JS PWA (no bundler, no framework) + Google Apps Script (V8 server-side; HTML modals run **browser-side in an IFRAME sandbox, ES6-safe** — see invariant #4) + Python templating (`build.py`)
- **Deploy**:
  - PWA: GitHub Pages auto-deploys from `main`. Edit `template/` → run `python build.py` → commit + push.
  - Apps Script: `clasp` via `deploy.py` (at repo root, alongside `build.py`). Edit `apps-script/<file>` → run `python deploy.py` (bound-sidebar-only changes) or `python deploy.py --redeploy` (any MOGApi.gs / `api_*` change — bumps each store's web-app `/exec` URL too). Push reaches all 11 targets (10 stores + the template) in ~40s; `--redeploy` adds ~3s/target.
- **Build / test**: CI (`.github/workflows/gates.yml`) runs `node tests/run_all.js` on every push and pull request, then the real SQL in PGlite (`npm ci`, then `node supabase/tests/run_pglite.mjs`: every schema file, every smoke test; then `node supabase/tests/backup_role_pglite.mjs` and `node supabase/tests/night_schedule_pglite.mjs`). `python build.py --dry-run` previews PWA build. `python deploy.py --dry-run` previews Apps Script deploy (combine with `--redeploy` to preview the redeploy phase too). `node tests/run_all.js` runs the order-math gates: the real `.gs` code under Node, no dependencies (see `tests/README.md`). Run it before deploying any change to `OrderMath.gs`, the count/dashboard path in `MOGApi.gs`, or `Sync.gs`. Everything else is verified manually (open the live URL, run an order).

## Layer routing

Every change anchors to one of these layers. Pick the layer before drafting any edits.

| Layer | Primary files | What lives here |
|---|---|---|
| **Hub** | `index.html`, `sw.js`, `manifest.json`, `stores.json` | Concept picker, manager mode, store registry. First thing a KM sees. |
| **Per-store PWA** | `template/index.html`, `template/sw.js` | The store-facing app. `build.py` copies this to every `<slug>/` dir with deployment URLs injected. |
| **Apps Script backend** | `apps-script/*.gs`, `apps-script/*.html`, `apps-script/appsscript.json` | Bound script that runs in each Sheet. Identical across all 11 deploy targets — per-store config lives in spreadsheet data, not code. |
| **Supabase** | `supabase/schema*.sql`, `supabase/tests/` | Every store runs on it: counts, Emergency Override, the cycle and the order log, the catalog (edited in the app), recipients and People. Phones talk to it directly (`phone_direct`); each Sheet is frozen for catalog edits and gets a nightly LOG_ORDERS backup. The whole database is dumped off-site every night by the private repo `SebHEH/mog-backup` (`supabase/backup_role.sql`'s read-only `mog_backup`; restore steps in its README). Design records: `docs/MOG_SupabaseMigration.md` and `docs/MOG_OneApp_Spec.md` (read them before touching this layer). A schema change runs on the maintainer's go for that file: Claude runs the repo's `schema_vN.sql` and then its smoke file through the Supabase connector, or the maintainer pastes them in the SQL Editor (skill `mog-supabase-schema`). Every other connector call is a read. |
| **Deploy infrastructure** | `build.py`, `deploy.py`, `apps-script/.clasp-targets.json` | How code reaches production. `.clasp-targets.json` holds both `scriptId` (for source push) and `deploymentId` (for web-app version bump) per target. `deploy.py --discover` finds deploymentIds on a fresh checkout. `deploy.py --relay` pushes and redeploys the mail relay (`mail-relay/`, its IDs in `mail-relay/relay-target.json`), apart from the stores. |
| **Generated (do NOT edit)** | `rpr/`, `rprfo/`, `rpt/`, `rptfo/`, `rpfr/`, `rpfrf/`, `tnyt/`, `tnytf/`, `tnyr/`, `tnyrf/`, `hq/` | Output of `build.py`. Overwritten on every build. `hq/` comes from `template/hq/`. |

**Anti-patterns:**
- Editing `rpr/index.html` directly instead of `template/index.html` → lost on next build.
- Editing code in the Apps Script editor for one store → overwritten on next `deploy.py` run; the other 10 targets stay stale until you also edit the local file.
- Adding a store to `stores.json` without running `build.py` → hub shows the tile but `/<slug>/` 404s.
- Putting per-store data (PINs, location names, vendor lists) into `.gs` files → breaks the "identical across all stores" invariant; spreadsheet data is the per-store layer.

## Standing invariants

Carry these across every session:

1. **Never edit generated `<slug>/` dirs.** They're overwritten by `build.py` on every build. Edit `template/` instead.
2. **Never edit code in the Apps Script editor.** `deploy.py` overwrites it. Edit `apps-script/<file>` locally, then deploy.
3. **`.gs` files are identical across all 11 deploy targets.** Per-store config (PIN, location name, vendor data) lives in the spreadsheet itself via PropertiesService or sheet contents — never hardcode in `.gs` files.
4. **Apps Script HTML modals render in the browser, not Rhino.** HtmlService serves `apps-script/*.html` into an IFRAME sandbox, so the `<script>` blocks run in the KM's browser JS engine — modern ES6 (arrow functions, `let`/`const`, template literals) works and already ships in production modals. The `.gs` files run on V8 (`runtimeVersion: "V8"` in `appsscript.json`). *(This invariant previously claimed modals run in Rhino/ES5 — that was inaccurate. The global `rhino-safe-html` skill still fires on modal edits; treat it as optional conservative style, not a hard constraint, pending a separate cross-repo reconcile.)*
5. **Six placeholders in `template/index.html` must each appear exactly once:** `__MOG_API_URL__`, `__MOG_THEME__`, `__MOG_APPLE_TOUCH_ICON__`, `/*__MOG_SUPABASE__*/null` (the Supabase config), `/* __MOG_ORDER_MATH__ build-injected */` (where `apps-script/OrderMath.gs` is copied in verbatim) and `/*__MOG_STORE__*/null` (the store profile from `stores.json`: the optional delivery `address`). `build.py` fails loud if not — never replace them by hand. `tests/pwa_direct.test.js` checks them too.
6. **The `STORE_REGISTRY` marker line in root `index.html` is build-injected.** Don't hand-edit the array; edit `stores.json` and run `build.py`.
7. **Bump `CACHE_VERSION`** in `template/sw.js` (and `sw.js` for hub changes) when shipping shell changes so old caches evict from KMs' phones.
8. **Slugs in `stores.json` are immutable once published.** KMs have bookmarks and home-screen icons at `/<slug>/`. Renaming breaks them.
9. **Source push and web-app redeploy are separate steps.** `clasp push` (default `python deploy.py`) updates the script project, which bound sidebars read from HEAD — that's enough for changes to `ManageVendors.html`, `ManageItems.html`, `OrderHistory.html`, etc. and the `.gs` functions they call directly. The PWA hits each Sheet's `/exec` URL, which serves a *versioned snapshot*, so changes to `MOGApi.gs` (or any `api_*` function the PWA calls) need `python deploy.py --redeploy` to bump the version. When unsure, use `--redeploy`.
10. **Every server function is private (`_`) unless it's on the reviewed list in `tests/public_surface.test.js`.** The web app runs as the owner for anonymous visitors, and Apps Script lets any page it serves call any public function, so a public function is reachable by anyone with a store's `/exec` URL (D18, 2026-10-16). Pages reach the server only through `webedit_call` (token check, then the `webeditDispatch_` allowlist) and the auth layer. Sheet dialogs get a token from the menu that opens them (`sheetBootJson_`). Menu items and triggers can call private functions; an editor-run function stays public and starts with `requireEditorRun_()`.

## Two maintainers (Sebastian and Donny)

Sebastian owns the accounts; Donny is a collaborator. Both edit, deploy and run SQL. Whoever continues pulls the latest first; the repo doesn't track who is working on it, and nobody has to be told before a deploy or SQL (Sebastian, 2026-11-12). Donny's setup and his session prompts: [ONBOARDING.md](ONBOARDING.md).

| Surface | Sebastian | Donny |
|---|---|---|
| GitHub `SebHEH/mog-mobile` | Owner. May push to `main`; merges pull requests. | Collaborator. Works on a branch (`donny/<topic>`) and opens a pull request. |
| Apps Script (11 projects, bound to Sebastian's Sheets) | Owner. | Editor on every Sheet; deploys with his own `clasp login`. |
| Supabase org "HEH" (free plan) | Owner. | Developer: runs SQL in the SQL Editor, can't change settings. |
| Claude's Supabase connector | Full access: runs as `postgres` (measured 2026-11-06). Writes only to run a schema or smoke file on his go; Pause project is blocked in claude.ai. | Read-only URL (ONBOARDING step 6), so his schema files are pasted in the SQL Editor. |

Where this file or a repo skill says "Sebastian" about testing, approving, running SQL or committing, read "the maintainer running this session". Account ownership stays Sebastian's.

1. **Start every session with `git pull`.** Donny's session-start prompt does it.
2. **Donny's changes go through a pull request, and Sebastian merges.**
   - Branch protection on `main` requires a pull request and the `gates` check.
   - CI (`.github/workflows/gates.yml`) runs `node tests/run_all.js` on every push and pull request.
3. **Generated store folders are never hand-merged.** After a merge or rebase that touches `template/` or `stores.json`, run `python build.py` and commit what it writes.
4. **Deploys:**
   - `deploy.py` fetches `origin/main` and refuses when this copy is missing commits from it.
   - A deploy to every store runs only from `main` with `apps-script/` committed.
   - A canary (`--target rprfo`) may run from a branch.
5. **Who the web app runs as.** `appsscript.json` has `executeAs: USER_DEPLOYING`, so after a `--redeploy` a store's `/exec` likely runs as whoever redeployed. That isn't measured yet. Before your first `--redeploy`, consent once in every store's project (ONBOARDING.md step 4), then redeploy the canary and check its `/exec` answers.
6. **Triggers and recap emails run as whoever installed them.** Today that's Sebastian on every store (the 3:30 AM close, installed by Move this store to Supabase). Any of these moves that store's close and recap email to your account:
   - re-installing a trigger (Move, or the Health Check's install fix);
   - onboarding a new store.
7. **Supabase SQL:** runs on either maintainer's go for that file, through `mog-supabase-schema`: Claude runs it through a connector that can write, or the maintainer pastes it in the SQL Editor. Pull before writing the next `schema_vN.sql`.
8. **Global skill lessons.** The proposal mailbox (`~/.claude/skills/_global-skill-proposals/`) is local to each computer, so only Sebastian's sessions file proposals. Donny's sessions write the lesson under the handoff's *Process lessons*, tagged `[→ global proposal]`, and Sebastian files it.
9. **Claude's memory is per computer.** Project facts go in the repo ([docs/MOG_ProjectNotes.md](docs/MOG_ProjectNotes.md), this file, the handoffs), never only in one person's memory.

## Skills

Skills auto-load and trigger via the descriptions in their frontmatter.

**Repo-specific** (`.claude/skills/<name>/SKILL.md` — only load in this repo):

| Skill | When it triggers |
|---|---|
| `mog-session-handoff` | End-of-session capture. Writes `docs/MOG_SessionHandoff_YYYY_MM_DD.md` and updates this file's @-import line. |
| `mog-deploy-workflow` | Any code change — routes the change to the right layer (`deploy.py` for backend, `build.py` + git push for PWA/config) and enforces canary-first deploys. After a push, `scripts/wait_live.py` waits until every store and HQ serve it and CI's `gates` run passes. |
| `mog-add-store` | New-store onboarding, end to end (template copy → Script ID + web-app deploy → `.clasp-targets.json` + `provision_stores.sql` → push → `?page=setup` wizard → Move this store to Supabase → Move the editor to the app, start empty → `stores.json` + `build.py` → push → the app's Overview checklist). `scripts/validate.py` checks every pasted value and the wiring. |
| `mog-cheatsheet` | On-demand command reference. Triggers on "cheat sheet" / "remind me the command" / "what was that flag" / "how do I deploy". Dumps the relevant `deploy.py` / `build.py` / git invocations verbatim. |
| `mog-rpc-consolidation` | Pattern for collapsing multiple `google.script.run` calls or duplicate sheet reads in modals into a single bootstrap or commit server fn. Triggers when a modal fires >1 RPC on load/save, on audit-punch-list items, or "consolidate the RPCs" / "merge these calls". |
| `mog-apps-script-caching` | `CacheService` + `getServerMutationTs_` recipe for `api_*` reads in `MOGApi.gs`. Triggers when adding caching to an existing `api_*` fn or introducing a new aggregation endpoint. Always pairs with `--redeploy`. |
| `mog-modal-ux-sweep` | Apply an identical UX micro-change consistently across the 5 save-capable modals (or all 7). Triggers on "do this to all the modals" / "make sure every modal has X" / fixing a flagged cross-modal inconsistency. |
| `mog-i18n-parity` | Deterministic EN/ES key-parity check across the modals (ships `scripts/check_i18n_parity.py`, `--all` scans `apps-script/*.html`). Triggers on "check the parity" / "did I drop a translation key" / end of any modal session that changed strings. Replaces the by-eye "102 keys each" count. |
| `mog-sheet-formula-verify` | Prove a data-model / order-math change is safe against the LIVE store sheet before shipping. Triggers on "does any formula use column X" / "can I repurpose the SKU column" / "verify the order math" / any MASTER_ITEMS column change. The discipline that caught the column-D-vs-O near-miss. |
| `mog-pwa-audit` | Full-file audit of the PWA layer (`template/index.html` + `sw.js`) for latent bugs / dead code / unlocalized strings / cache hygiene. PWA-layer twin of `appsscript-codebase-audit`. Triggers on "audit the PWA" / "review template/index.html" / after a big PWA edit. |
| `mog-editor-web-reskin` | Turnkey recipe for polishing one KM web-editor tool (dual-host modal via `doGet?page=…`) into a full-page web app — bespoke per tool, `body.mge-web`-gated so the Sheet dialog is untouched. Triggers on "polish the next tool" / "do Manage Vendors/Pick Path/Order History next" / before touching any editor modal's web rendering (step 1 = the `setLang` class-clobber fix is a hard prerequisite). Pins the web chrome + in-place-update + validation-clear patterns and the `/dev`-vs-`/exec` iterate rule. |
| `mog-health-check-extend` | Add a new diagnostic check (± one-click web fix) to the Store Health Check. Triggers on "add a health check for X" / "make the Health Check catch this" / "the Health Check said nothing was wrong but X was broken". Pins the `add()`/`runHealthFix`/`_core_` (no-`getUi()`) mechanics + the read-only rule + the `Health.gs`-not-`HealthCheck.gs` basename gotcha. |
| `mog-supabase-schema` | Any change under `supabase/` (a new `mog_*` function, table or column). Pins the files each schema version touches (`schema_vN.sql`, `smoke_vN.sql`, `check_api.sh`, `tests/fake_supabase.js`, the migration doc's function table), the ship order (the SQL first, on the maintainer's go per file, then the gates, then the deploy), its scripts (`sqlgen.py` generates a version from earlier definitions, `plant.py` checks the smoke catches planted defects), and the rule that a probe never sends a PIN to a real store. Stems off the global `supabase-schema-change`. |
| `mog-exec-repoint` | Per-store incident runbook: a store's PWA shows "Offline" because its `/exec` deployment rotted (code + GET fine, POST fails to deliver). Triggers on "store X is offline" / "the PWA won't load for [store]" / "[store] backend is down". Diagnose single-vs-global, cut a FRESH `clasp deploy` (not `--redeploy` of the same id), repoint `.clasp-targets.json` + `stores.json`, cache-bump. Happened tnytf 06-26, rprfo 07-06. |

**User-global** (`~/.claude/skills/<name>/SKILL.md` — load in every Claude Code session):

| Skill | When it triggers |
|---|---|
| `architectural-walkthrough` | Any non-trivial change. Runs FIRST. |
| `surgical-patch` | Generic anchor-and-assert edit discipline. |
| `source-of-truth-verification` | When an Edit fails (anchor not found) and drift is suspected. |
| `rhino-safe-html` | Editing any `apps-script/*.html` script block — enforces ES5 syntax. |
| `claude-code-project-setup` | First-time scaffold for a new repo. Not relevant here anymore. |

## Global skills are governed — do NOT edit them in this repo

The skills under `~/.claude/skills/` are owned by the **Claude-SKills** repo (the single
source of truth). In THIS repo, never edit or create one of those global skills directly —
a direct edit drifts from the canonical source and is overwritten on the next sync.

When a session reveals a global skill should change (a lesson to fold in, a gotcha, a new
global skill), invoke the **`global-skill-governance`** skill. It files a proposal into the
mailbox (`~/.claude/skills/_global-skill-proposals/`); the Claude-SKills repo reviews,
applies, and re-syncs. Do not apply it locally.

Repo-local skills in `./.claude/skills/` ARE owned by this repo — edit those in place, no proposal.

## Working conventions

1. **Architectural walkthrough only for genuinely architectural changes** (a new structure or data flow, a schema change, a new system). Everything else: state the plan in a line or two and do it (Sebastian, 2026-11-12).
2. **Canary first, fan out second.** For multi-target deploys (clasp to 11 targets, build.py to 10 store dirs), push to one canary, smoke-test it (open the live URL or run the function; Grok Bot can do this), then push to the rest without asking. Only a rollout that is a cutover asks first. **A deploy that changes nothing a live store does needs no question** (code behind a switch that's off, a canary of it, the close function while no store has `close_direct` on): run it, then report what ran, what the gates prove and the rollback. **Still ask first** before turning on any store's `close_direct` or any other cutover (Sebastian, 2026-11-12).
3. **Verification is opening the live URL or running the function** — not "no errors in tooling output." Sebastian validates by using the thing.
4. Read the actual file before editing — assume it may have drifted since the last session.
5. No "🤖 Generated with Claude Code" footers on commit messages.
6. **Commit and push when the work is done and the gates pass.** Don't ask first and don't print the message for approval; report the hash. A session handoff also commits and pushes (Sebastian, 2026-11-12; skill `mog-session-handoff`). Never `--no-verify`.
7. PowerShell PATH may be stale after a fresh tooling install on Windows. If `node`, `npm`, `clasp`, or `python` returns "not found" right after `winget install`, prefix the next command with `$env:Path = [System.Environment]::GetEnvironmentVariable("Path","Machine") + ";" + [System.Environment]::GetEnvironmentVariable("Path","User");`.
8. **Every request to run a function in the Apps Script editor names its file.** Paste the output of `python editor_link.py <function> <store>`: the `.gs` file, the function, the store, and direct links to that store's editor and Sheet (global skill `appsscript-editor-action`). Never a bare function name, and never leave the store implicit (one codebase, ten Sheets). Sebastian's standing rule, 2026-10-15.
9. **Every next step that involves a file links that file.** Whenever a suggestion, a hand-off, or a "next, do X" names a file Sebastian has to open, run, paste, or check (a SQL file to run in the Supabase SQL Editor, a smoke test, a doc, a generated page), give it as a clickable repo-relative Markdown link, e.g. [supabase/schema_v3.sql](supabase/schema_v3.sql), right where the step says to use it, with what to do with it. The links go in the turn's final message: the app collapses text written above a next-step question box into a one-line summary, so links placed there disappear. Never a bare file name. Sebastian's standing rule, 2026-10-16.

## Common pitfalls

1. **Editing `<slug>/index.html` (generated dir) instead of `template/index.html`** — lost on next build.
2. **Editing in the Apps Script editor** — overwritten by next `python deploy.py`. There's no "this one store has a custom hotfix" pattern; the discipline is local edit + deploy to all.
3. **Forgetting `python build.py` after editing `stores.json` or `template/`** — generated dirs go stale; hub picker may show a store with no working URL.
4. **Forgetting `python deploy.py` after editing `apps-script/<file>`** — local repo is ahead of every deployed Sheet; KMs run stale code until you remember.
4a. **Forgetting `--redeploy` after a MOGApi.gs change** — bound sidebars look right (they read HEAD), but the PWA's `/exec` URL is a versioned snapshot and still serves the old code. Use `python deploy.py --redeploy` for any change to `MOGApi.gs` or anything called from it.
5. **Assuming modal `<script>` blocks run server-side / in Rhino.** They do NOT — modals are browser-side (see invariant #4), so ES6 is safe there and already in use. The real boundary: modal `<script>` has no access to V8-server globals or `.gs` functions except via `google.script.run`; don't paste server helpers into a modal expecting them to resolve.
6. **Slug rename in `stores.json`** — breaks bookmarks and home-screen icons. If you really need to rename, leave a redirect.
7. **Not bumping `CACHE_VERSION`** — KMs' phones serve the old shell from disk forever. Bump on any HTML-shell change in `template/sw.js` (or root `sw.js` for hub changes).
8. **Hand-editing the `STORE_REGISTRY` line in root `index.html`** — `build.py` will overwrite it from `stores.json` on the next build.
9. **Pushing to a different account's clasp session** — `clasp` is logged in as one Google account at a time. Run `clasp login` again if you accidentally pushed nothing or got a permission error.
10. **Forgetting the master template `_template` in `.clasp-targets.json`** — new stores copied from it would start with stale code. The template is one of the 11 deploy targets for a reason.

## File inventory

Moved to `docs/MOG_FileInventory.md` (not auto-loaded). Read it when you need where a file lives.
