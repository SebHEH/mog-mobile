# MOG (Master Ordering Guide): multi-store PWA on Supabase

A Progressive Web App hosted at `sebheh.github.io/mog-mobile/` on a Supabase backend. KMs at each Happy Endings Hospitality location count and order on their phones; the catalog is edited in the same app on a computer, and HQ runs at `/hq/`. Supabase holds every store's data and closes each store every night; the recap emails go out through one small Apps Script project, the mail relay. The stores' Google Sheets are retired (Sheet retirement step 5, 2026-11-20): frozen in Drive, their web apps archived, nothing deployed to them.

This file is loaded into context at every Claude Code session start. Its @-imports are binding — read them before proposing any change.

## Canonical reference docs (read on session start)

If sources conflict, items higher in this list win for "what's currently in flight." `CLAUDE.md` itself wins for project structure and invariants.

@docs/MOG_CurrentState.md

Project facts and gotchas live in `docs/MOG_ProjectNotes.md`. It is not auto-loaded: read the section before working in that area. Sections: Direction, Stores, Deploys and rollout, Supabase (including the mail relay), HQ control, LTOs, Happy Supply (the warehouse), Local previews and the browser pane, CI and tests, Worktree sessions and pull requests, Google Drive connector, Claude on Windows. The full file inventory is `docs/MOG_FileInventory.md`.

## Latest session handoff

Replace the path here with the newest handoff at the end of each session that ships material changes. (The `mog-session-handoff` skill rewrites this line.)

@docs/MOG_SessionHandoff_2026_11_16.md
If `docs/` holds a newer `MOG_SessionHandoff_*.md` than the import above (sort by name), read the newest one first. The SessionStart context guard flags a lagging import.

## Quick orientation

- **Runtime / stack**: Vanilla JS PWA (no bundler, no framework) + Supabase (Postgres functions, `pg_cron`, the Edge Function `close`) + Python templating (`build.py`). `apps-script/` is a source only: `build.py` injects `OrderMath.gs` into every store page and the close function and publishes the editor pages from it (they run in the browser, ES6-safe: invariant #4); nothing deploys it. The mail relay (`mail-relay/`) is the one Apps Script project still deployed.
- **Deploy** (`python .claude/skills/mog-deploy-workflow/scripts/route.py <changed paths>` says which):
  - PWA and HQ: GitHub Pages auto-deploys from `main`. Edit `template/` → run `python build.py` → commit + push (an app change: canary `rprfo` first).
  - Supabase: a schema file on the maintainer's go (skill `mog-supabase-schema`); the Edge Function `close` through the connector's `deploy_edge_function` after `build.py`, when `OrderMath.gs`, `Concepts.gs`, `RecapEmail.gs` or `supabase/functions/close/` changed.
  - The mail relay: `python deploy.py --relay`.
- **Build / test**: CI (`.github/workflows/gates.yml`) runs `node tests/run_all.js` on every push and pull request, then the real SQL in PGlite (`npm ci`, then `node supabase/tests/run_pglite.mjs`: every schema file, every smoke test; then `node supabase/tests/backup_role_pglite.mjs` and `node supabase/tests/night_schedule_pglite.mjs`). `python build.py --dry-run` previews the build; `python deploy.py --relay --dry-run` previews the relay deploy. `node tests/run_all.js` runs every gate (the real code under Node; see `tests/README.md`): run it before any push that changes the app, `apps-script/`, `supabase/` or `build.py`. Everything else is verified by using it (open the live URL, run an order).

## Layer routing

Every change anchors to one of these layers. Pick the layer before drafting any edits.

| Layer | Primary files | What lives here |
|---|---|---|
| **Hub** | `index.html`, `sw.js`, `manifest.json`, `stores.json` | Concept picker, manager mode, store registry. First thing a KM sees. |
| **Per-store PWA** | `template/index.html`, `template/sw.js`, `template/editor/` | The store-facing app and its Manage pages. `build.py` copies it to every `<slug>/` dir with the store's Supabase config, its profile from `stores.json` (concept, `ns`, address) and `OrderMath.gs` injected. |
| **HQ** | `template/hq/` | HQ control (stores, PINs, libraries, Happy Supply), published by `build.py` to `hq/`. |
| **Apps Script sources (not deployed)** | `apps-script/*.gs`, `apps-script/*.html` | The old per-Sheet backend, kept as a source. `build.py` injects `OrderMath.gs` into every store page and copies it with `Concepts.gs` and `RecapEmail.gs` into the close function's `shared.mjs`; it publishes the editor pages (`EditorHome`, `OrderHistory` and their includes) and reads `Sync.gs`'s Supabase URL and publishable key. The 11 projects bound to the Sheets are no longer deployed: their web apps were archived in Sheet retirement step 5 (2026-11-20). |
| **Mail relay** | `mail-relay/` | One standalone Apps Script project that sends the nightly recap emails for Supabase's close. `python deploy.py --relay` pushes it and redeploys its one deployment (IDs in `mail-relay/relay-target.json`). |
| **Supabase** | `supabase/schema*.sql`, `supabase/tests/`, `supabase/functions/close/` | Every store runs on it: counts, Emergency Override, the cycle and the order log, the catalog (edited in the app), recipients and People, PINs (HQ → Stores). Phones and the editor talk to it directly. It closes each store just after midnight (`pg_cron` job `mog-night` → the Edge Function `close`) and sends the recaps through the mail relay. The whole database is dumped off-site every night by the private repo `SebHEH/mog-backup` (`supabase/backup_role.sql`'s read-only `mog_backup`; restore steps in its README). Design records: `docs/MOG_SupabaseMigration.md`, `docs/MOG_OneApp_Spec.md` and `docs/MOG_SheetRetirement_Spec.md` (read them before touching this layer). A schema change runs on the maintainer's go for that file: Claude runs the repo's `schema_vN.sql` and then its smoke file through the Supabase connector, or the maintainer pastes them in the SQL Editor (skill `mog-supabase-schema`). Every other connector call is a read, except flipping a store's switch (`close_direct`) under Working conventions 2 and deploying the Edge Function `close`. |
| **Deploy infrastructure** | `build.py`, `deploy.py`, `mail-relay/relay-target.json` | How code reaches production. `build.py` writes every store's page, HQ and the close function's `shared.mjs`; GitHub Pages serves what's pushed to `main`. `deploy.py --relay` deploys the mail relay, the only Apps Script deploy left. |
| **Generated (do NOT edit)** | `rpr/`, `rprfo/`, `rpt/`, `rptfo/`, `rpfr/`, `rpfrf/`, `tnyt/`, `tnytf/`, `tnyr/`, `tnyrf/`, `leidtyson/`, `hq/`, `supabase/functions/close/shared.mjs` | Output of `build.py`. Overwritten on every build. `hq/` comes from `template/hq/`; `shared.mjs` from `apps-script/`. |

**Anti-patterns:**
- Editing `rpr/index.html` directly instead of `template/index.html` → lost on next build.
- Editing `supabase/functions/close/shared.mjs` by hand → overwritten by the next `build.py`; edit the `.gs` source in `apps-script/`.
- Adding a store to `stores.json` without running `build.py` → hub shows the tile but `/<slug>/` 404s.
- Putting per-store data (PINs, vendor lists) into code → per-store data lives in Supabase (HQ and Manage edit it); `stores.json` holds only what the build needs (slug, concept, location, address, `ns`).

## Standing invariants

Carry these across every session:

1. **Never edit generated `<slug>/` dirs.** They're overwritten by `build.py` on every build. Edit `template/` instead.
2. **Never edit code in an Apps Script editor.** The mail relay's code lives in `mail-relay/`, and `python deploy.py --relay` overwrites its project. The Sheets' projects are frozen: nothing deploys to them, so an edit there ships nowhere.
3. **`apps-script/` is a build source, not a deployed backend.** `build.py` reads `OrderMath.gs` (every store page and the close), `Concepts.gs` and `RecapEmail.gs` (the close), `Sync.gs`'s Supabase config and the editor pages. A change to `OrderMath.gs`, `Concepts.gs` or `RecapEmail.gs` needs `python build.py` and a redeploy of the Edge Function `close` (`route.py` lists both). Per-store data lives in Supabase, never in code.
4. **Apps Script HTML modals render in the browser, not Rhino.** HtmlService serves `apps-script/*.html` into an IFRAME sandbox, so the `<script>` blocks run in the KM's browser JS engine — modern ES6 (arrow functions, `let`/`const`, template literals) works and already ships in production modals. The `.gs` files run on V8 (`runtimeVersion: "V8"` in `appsscript.json`). *(This invariant previously claimed modals run in Rhino/ES5 — that was inaccurate. The global `rhino-safe-html` skill still fires on modal edits; treat it as optional conservative style, not a hard constraint, pending a separate cross-repo reconcile.)*
5. **Five placeholders in `template/index.html` must each appear exactly once:** `__MOG_THEME__`, `__MOG_APPLE_TOUCH_ICON__`, `/*__MOG_SUPABASE__*/null` (the Supabase config), `/* __MOG_ORDER_MATH__ build-injected */` (where `apps-script/OrderMath.gs` is copied in verbatim) and `/*__MOG_STORE__*/null` (the store profile from `stores.json`: its concept, `ns` and the optional delivery `address`). `build.py` fails loud if not; never replace them by hand. `tests/pwa_direct.test.js` checks them too, and that `__MOG_API_URL__` (retired with the `/exec` addresses, step 5) stays gone.
6. **The `STORE_REGISTRY` marker line in root `index.html` is build-injected.** Don't hand-edit the array; edit `stores.json` and run `build.py`.
7. **Bump `CACHE_VERSION`** in `template/sw.js` (and `sw.js` for hub changes) when shipping shell changes so old caches evict from KMs' phones.
8. **Slugs and `ns` in `stores.json` are immutable once published.** KMs have bookmarks and home-screen icons at `/<slug>/`, and every phone files a store's drafts and unsent counts under its `ns` (`build.py`'s `LEGACY_NS` for the 10 stores from Sheets, `s_<slug>` for a store made in HQ; gate `store_ns`). Changing either breaks them.
9. **The mail relay keeps its one deployment.** `python deploy.py --relay` always redeploys the deployment in `mail-relay/relay-target.json`, so `RELAY_URL` in `supabase/functions/close/index.ts` never changes; a new deployment (a `clasp deploy` without that id) would leave the close mailing through an old version. The `mail_relay` gate holds the two IDs equal.
10. **The mail relay answers only with its secret.** Its web app runs as the deployer for anonymous callers, so `Relay.gs`'s `doPost` checks `MOG_RELAY_SECRET` before anything else, and `doPost` and `setupRelay` are its only public functions (gate `mail_relay`). The stores' `/exec` web apps, where D18's private-function rule mattered, are archived; `tests/public_surface.test.js` still holds `apps-script/` to that rule while the code is kept.

## Two maintainers (Sebastian and Donny)

Sebastian owns the accounts; Donny is a collaborator. Both edit, deploy and run SQL. Whoever continues pulls the latest first; the repo doesn't track who is working on it, and nobody has to be told before a deploy or SQL (Sebastian, 2026-11-12). Donny's setup and his session prompts: [ONBOARDING.md](ONBOARDING.md).

| Surface | Sebastian | Donny |
|---|---|---|
| GitHub `SebHEH/mog-mobile` | Owner. May push to `main`; merges pull requests. | Collaborator. Works on a branch (`donny/<topic>`) and opens a pull request. |
| Apps Script: the mail relay (standalone); the 11 Sheet projects, retired | Owner. | Editor on the retired Sheets. Deploying the relay needs edit access to its project and his own `clasp login` (rule 5). |
| Supabase org "HEH" (free plan) | Owner. | Developer: runs SQL in the SQL Editor, can't change settings. |
| Claude's Supabase connector | Full access: runs as `postgres` (measured 2026-11-06). Writes only to run a schema or smoke file on his go, or to flip a store's switch (Working conventions 2); Pause project is blocked in claude.ai. | Read-only URL (ONBOARDING step 6), so his schema files are pasted in the SQL Editor. |

Where this file or a repo skill says "Sebastian" about testing, approving, running SQL or committing, read "the maintainer running this session". Account ownership stays Sebastian's.

1. **Start every session with `git pull`.** Donny's session-start prompt does it.
2. **Donny's changes go through a pull request, and Sebastian merges.**
   - Branch protection on `main` requires a pull request and the `gates` check.
   - CI (`.github/workflows/gates.yml`) runs `node tests/run_all.js` on every push and pull request.
3. **Generated store folders are never hand-merged.** After a merge or rebase that touches `template/` or `stores.json`, run `python build.py` and commit what it writes.
4. **Deploys:**
   - An app or HQ change reaches the stores only from `main` (GitHub Pages), so Donny's goes live when its pull request merges.
   - `deploy.py --relay` fetches `origin/main` and refuses when this copy is missing commits from it, or when `mail-relay/` has uncommitted changes.
5. **Who the mail relay runs as.** `mail-relay/appsscript.json` has `executeAs: USER_DEPLOYING`, so after `deploy.py --relay` the relay likely runs as whoever deployed it, and every recap is sent from that account (its MailApp quota, its `noReply` sender). That isn't measured. After a first relay deploy from another account, send a test (`select mog.backup_watch_test();`, which mails through the relay) and read the next morning's `recap` rows in `mog.night_log`.
6. **Nothing at the stores runs on a trigger or as a person.** The nightly close and recap run in Supabase (`pg_cron` job `mog-night` every 15 minutes → the Edge Function `close` → the relay). Each Sheet's 3:30 AM trigger retired itself on 2026-11-16 (`sheet_trigger_off_at` at all 10). A Sheet's menu can still put it back (Move this store to Supabase); it would retire itself again that night, since `close_direct` is on, and schema v27 refuses its close.
7. **Supabase SQL:** runs on either maintainer's go for that file, through `mog-supabase-schema`: Claude runs it through a connector that can write, or the maintainer pastes it in the SQL Editor. Pull before writing the next `schema_vN.sql`.
8. **Global skill lessons.** The proposal mailbox (`~/.claude/skills/_global-skill-proposals/`) is local to each computer, so only Sebastian's sessions file proposals. Donny's sessions write the lesson under the handoff's *Process lessons*, tagged `[→ global proposal]`, and Sebastian files it.
9. **Claude's memory is per computer.** Project facts go in the repo ([docs/MOG_ProjectNotes.md](docs/MOG_ProjectNotes.md), this file, the handoffs), never only in one person's memory.

## Skills

Skills auto-load and trigger via the descriptions in their frontmatter.

**Repo-specific** (`.claude/skills/<name>/SKILL.md` — only load in this repo):

| Skill | When it triggers |
|---|---|
| `mog-session-handoff` | End-of-session capture. Writes `docs/MOG_SessionHandoff_YYYY_MM_DD.md` and updates this file's @-import line. |
| `mog-deploy-workflow` | Any code change: `scripts/route.py` lists what it needs (`build.py` + push with the canary `rprfo` first, the Edge Function `close`, `deploy.py --relay`, SQL first). After a push, `scripts/wait_live.py` waits until every store and HQ serve it and CI's `gates` run passes. |
| `mog-add-store` | A new store in four steps, no Sheet (schema v26): HQ → Stores → New store → Claude publishes it ("Publish <slug>": the row, `validate.py entry` → `stores.json`, `build.py`, push) → its items from a library or the Overview checklist → a smoke test and the next morning's close. |
| `mog-cheatsheet` | On-demand command reference. Triggers on "cheat sheet" / "remind me the command" / "what was that flag" / "how do I deploy". Dumps the relevant `build.py` / gates / git / `wait_live.py` / `deploy.py --relay` invocations verbatim. |
| `mog-i18n-parity` | Deterministic EN/ES key-parity check across the modals (ships `scripts/check_i18n_parity.py`, `--all` scans `apps-script/*.html`). Triggers on "check the parity" / "did I drop a translation key" / end of any modal session that changed strings. Replaces the by-eye "102 keys each" count. |
| `mog-pwa-audit` | Full-file audit of the PWA layer (`template/index.html` + `sw.js`) for latent bugs / dead code / unlocalized strings / cache hygiene. PWA-layer twin of `appsscript-codebase-audit`. Triggers on "audit the PWA" / "review template/index.html" / after a big PWA edit. |
| `mog-supabase-schema` | Any change under `supabase/` (a new `mog_*` function, table or column). Pins the files each schema version touches (`schema_vN.sql`, `smoke_vN.sql`, `check_api.sh`, `tests/fake_supabase.js`, the migration doc's function table), the ship order (the SQL first, on the maintainer's go per file, then the gates, then the deploy), its scripts (`sqlgen.py` generates a version from earlier definitions, `plant.py` checks the smoke catches planted defects), and the rule that a probe never sends a PIN to a real store. Stems off the global `supabase-schema-change`. |

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
2. **Canary first, fan out second.** For an app change (`build.py` to every store dir), push to one canary, smoke-test it (open the live URL or run the function), then push to the rest without asking. **Cutovers need no question either** (Sebastian, 2026-11-15, matching his global rule of 2026-11-13): turning on a store's `close_direct` or another switch that changes what a live store does runs once its gates pass, one store first (the canary's nights clean before the rest), then report what ran, the gate line and the rollback. Claude flips such a switch through the Supabase connector. A deploy that changes nothing a live store does was already question-free (2026-11-12).
3. **Verification is opening the live URL or running the function** — not "no errors in tooling output." Sebastian validates by using the thing.
4. Read the actual file before editing — assume it may have drifted since the last session.
5. No "🤖 Generated with Claude Code" footers on commit messages.
6. **Commit and push when the work is done and the gates pass.** Don't ask first and don't print the message for approval; report the hash. A session handoff also commits and pushes (Sebastian, 2026-11-12; skill `mog-session-handoff`). Never `--no-verify`.
7. PowerShell PATH may be stale after a fresh tooling install on Windows. If `node`, `npm`, `clasp`, or `python` returns "not found" right after `winget install`, prefix the next command with `$env:Path = [System.Environment]::GetEnvironmentVariable("Path","Machine") + ";" + [System.Environment]::GetEnvironmentVariable("Path","User");`.
8. **Every request to run a function in an Apps Script editor names its file and links its project.** Since step 5 that's only the mail relay: `mail-relay/Relay.gs`, the function, and https://script.google.com/home/projects/1zuYd1_f2iXIgbZY-w19mVcqFEneCnwbwlUngTBLafU0RDT-rorc3gLki/edit (global skill `appsscript-editor-action`). Never a bare function name. Sebastian's standing rule, 2026-10-15.
9. **Every next step that involves a file links that file.** Whenever a suggestion, a hand-off, or a "next, do X" names a file Sebastian has to open, run, paste, or check (a SQL file to run in the Supabase SQL Editor, a smoke test, a doc, a generated page), give it as a clickable repo-relative Markdown link, e.g. [supabase/schema_v3.sql](supabase/schema_v3.sql), right where the step says to use it, with what to do with it. The links go in the turn's final message: the app collapses text written above a next-step question box into a one-line summary, so links placed there disappear. Never a bare file name. Sebastian's standing rule, 2026-10-16.

## Common pitfalls

1. **Editing `<slug>/index.html` (generated dir) instead of `template/index.html`** — lost on next build.
2. **Editing the relay in its Apps Script editor** — overwritten by the next `python deploy.py --relay`. Edit `mail-relay/` locally, commit, then deploy.
3. **Forgetting `python build.py` after editing `stores.json`, `template/` or `apps-script/`** — generated dirs go stale; hub picker may show a store with no working URL.
4. **Changing `OrderMath.gs`, `Concepts.gs` or `RecapEmail.gs` without redeploying `close`** — the phones get the new code from `build.py`, but the nightly close keeps the old copy until the Edge Function is redeployed (`route.py` lists it).
5. **Assuming modal `<script>` blocks run server-side / in Rhino.** They do NOT — modals are browser-side (see invariant #4), so ES6 is safe there and already in use. The real boundary: modal `<script>` has no access to V8-server globals or `.gs` functions except via `google.script.run`; don't paste server helpers into a modal expecting them to resolve.
6. **Slug rename in `stores.json`** — breaks bookmarks and home-screen icons. If you really need to rename, leave a redirect.
7. **Not bumping `CACHE_VERSION`** — KMs' phones serve the old shell from disk forever. Bump on any HTML-shell change in `template/sw.js` (or root `sw.js` for hub changes).
8. **Hand-editing the `STORE_REGISTRY` line in root `index.html`** — `build.py` will overwrite it from `stores.json` on the next build.
9. **Deploying the relay from a different account's clasp session** — `clasp` is logged in as one Google account at a time. Run `clasp login` again if you pushed nothing or got a permission error (and see Two maintainers, rule 5).

## File inventory

Moved to `docs/MOG_FileInventory.md` (not auto-loaded). Read it when you need where a file lives.
