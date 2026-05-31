# MOG (Master Ordering Guide) — Multi-store PWA + Apps Script backend

A Progressive Web App hosted at `sebheh.github.io/mog-mobile/` plus the Google Apps Script backend that runs inside each store's Google Sheet. KMs at each Happy Endings Hospitality location use the PWA on their phones to manage inventory orders; the Apps Script reads and writes the Sheet that holds the data.

This file is loaded into context at every Claude Code session start. Its @-imports are binding — read them before proposing any change.

## Canonical reference docs (read on session start)

If sources conflict, items higher in this list win for "what's currently in flight." `CLAUDE.md` itself wins for project structure and invariants.

@docs/MOG_CurrentState.md

## Latest session handoff

Replace the path here with the newest handoff at the end of each session that ships material changes. (The `mog-session-handoff` skill rewrites this line.)

@docs/MOG_SessionHandoff_2026_05_31.md

## Quick orientation

- **Runtime / stack**: Vanilla JS PWA (no bundler, no framework) + Google Apps Script (V8 server-side, **Rhino ES5** in HTML modals) + Python templating (`build.py`)
- **Deploy**:
  - PWA: GitHub Pages auto-deploys from `main`. Edit `template/` → run `python build.py` → commit + push.
  - Apps Script: `clasp` via `deploy.py` (at repo root, alongside `build.py`). Edit `apps-script/<file>` → run `python deploy.py` (bound-sidebar-only changes) or `python deploy.py --redeploy` (any MOGApi.gs / `api_*` change — bumps each store's web-app `/exec` URL too). Push reaches all 9 targets in ~30s; `--redeploy` adds ~3s/target.
- **Build / test**: No CI yet. `python build.py --dry-run` previews PWA build. `python deploy.py --dry-run` previews Apps Script deploy (combine with `--redeploy` to preview the redeploy phase too). There are no automated tests — verification is manual (open the live URL, run an order).

## Layer routing

Every change anchors to one of these layers. Pick the layer before drafting any edits.

| Layer | Primary files | What lives here |
|---|---|---|
| **Hub** | `index.html`, `sw.js`, `manifest.json`, `stores.json` | Concept picker, manager mode, store registry. First thing a KM sees. |
| **Per-store PWA** | `template/index.html`, `template/sw.js` | The store-facing app. `build.py` copies this to every `<slug>/` dir with deployment URLs injected. |
| **Apps Script backend** | `apps-script/*.gs`, `apps-script/*.html`, `apps-script/appsscript.json` | Bound script that runs in each Sheet. Identical across all 9 deploy targets — per-store config lives in spreadsheet data, not code. |
| **Deploy infrastructure** | `build.py`, `deploy.py`, `apps-script/.clasp-targets.json` | How code reaches production. `.clasp-targets.json` holds both `scriptId` (for source push) and `deploymentId` (for web-app version bump) per target. `deploy.py --discover` finds deploymentIds on a fresh checkout. |
| **Generated (do NOT edit)** | `rpr/`, `rprfo/`, `rpt/`, `rptfo/`, `rpfr/`, `rpfrf/`, `tnyt/`, `tnytf/` | Output of `build.py`. Overwritten on every build. |

**Anti-patterns:**
- Editing `rpr/index.html` directly instead of `template/index.html` → lost on next build.
- Editing code in the Apps Script editor for one store → overwritten on next `deploy.py` run; the other 8 targets stay stale until you also edit the local file.
- Adding a store to `stores.json` without running `build.py` → hub shows the tile but `/<slug>/` 404s.
- Putting per-store data (PINs, location names, vendor lists) into `.gs` files → breaks the "identical across all stores" invariant; spreadsheet data is the per-store layer.

## Standing invariants

Carry these across every session:

1. **Never edit generated `<slug>/` dirs.** They're overwritten by `build.py` on every build. Edit `template/` instead.
2. **Never edit code in the Apps Script editor.** `deploy.py` overwrites it. Edit `apps-script/<file>` locally, then deploy.
3. **`.gs` files are identical across all 9 deploy targets.** Per-store config (PIN, location name, vendor data) lives in the spreadsheet itself via PropertiesService or sheet contents — never hardcode in `.gs` files.
4. **Apps Script HTML modals render in the browser, not Rhino.** HtmlService serves `apps-script/*.html` into an IFRAME sandbox, so the `<script>` blocks run in the KM's browser JS engine — modern ES6 (arrow functions, `let`/`const`, template literals) works and already ships in production modals. The `.gs` files run on V8 (`runtimeVersion: "V8"` in `appsscript.json`). *(This invariant previously claimed modals run in Rhino/ES5 — that was inaccurate. The global `rhino-safe-html` skill still fires on modal edits; treat it as optional conservative style, not a hard constraint, pending a separate cross-repo reconcile.)*
5. **Three placeholders in `template/index.html` must each appear exactly once:** `__MOG_API_URL__`, `__MOG_THEME__`, `__MOG_APPLE_TOUCH_ICON__`. `build.py` fails loud if not — never replace them by hand.
6. **The `STORE_REGISTRY` marker line in root `index.html` is build-injected.** Don't hand-edit the array; edit `stores.json` and run `build.py`.
7. **Bump `CACHE_VERSION`** in `template/sw.js` (and `sw.js` for hub changes) when shipping shell changes so old caches evict from KMs' phones.
8. **Slugs in `stores.json` are immutable once published.** KMs have bookmarks and home-screen icons at `/<slug>/`. Renaming breaks them.
9. **Source push and web-app redeploy are separate steps.** `clasp push` (default `python deploy.py`) updates the script project, which bound sidebars read from HEAD — that's enough for changes to `ManageVendors.html`, `ManageItems.html`, `OrderHistory.html`, etc. and the `.gs` functions they call directly. The PWA hits each Sheet's `/exec` URL, which serves a *versioned snapshot*, so changes to `MOGApi.gs` (or any `api_*` function the PWA calls) need `python deploy.py --redeploy` to bump the version. When unsure, use `--redeploy`.

## Skills

Skills auto-load and trigger via the descriptions in their frontmatter.

**Repo-specific** (`.claude/skills/<name>/SKILL.md` — only load in this repo):

| Skill | When it triggers |
|---|---|
| `mog-session-handoff` | End-of-session capture. Writes `docs/MOG_SessionHandoff_YYYY_MM_DD.md` and updates this file's @-import line. |
| `mog-deploy-workflow` | Any code change — routes the change to the right layer (`deploy.py` for backend, `build.py` + git push for PWA/config) and enforces canary-first deploys. |
| `mog-add-store` | New-store onboarding — the full end-to-end procedure (Drive copy → Script ID → `.clasp-targets.json` → `setupMobileApi()` → web-app deploy → `stores.json` → `build.py` → push). |
| `mog-cheatsheet` | On-demand command reference. Triggers on "cheat sheet" / "remind me the command" / "what was that flag" / "how do I deploy". Dumps the relevant `deploy.py` / `build.py` / git invocations verbatim. |
| `mog-rpc-consolidation` | Pattern for collapsing multiple `google.script.run` calls or duplicate sheet reads in modals into a single bootstrap or commit server fn. Triggers when a modal fires >1 RPC on load/save, on audit-punch-list items, or "consolidate the RPCs" / "merge these calls". |
| `mog-apps-script-caching` | `CacheService` + `getServerMutationTs_` recipe for `api_*` reads in `MOGApi.gs`. Triggers when adding caching to an existing `api_*` fn or introducing a new aggregation endpoint. Always pairs with `--redeploy`. |
| `mog-modal-ux-sweep` | Apply an identical UX micro-change consistently across the 5 save-capable modals (or all 7). Triggers on "do this to all the modals" / "make sure every modal has X" / fixing a flagged cross-modal inconsistency. |
| `mog-i18n-parity` | Deterministic EN/ES key-parity check across the modals (ships `scripts/check_i18n_parity.py`, `--all` scans `apps-script/*.html`). Triggers on "check the parity" / "did I drop a translation key" / end of any modal session that changed strings. Replaces the by-eye "102 keys each" count. |
| `mog-sheet-formula-verify` | Prove a data-model / order-math change is safe against the LIVE store sheet before shipping. Triggers on "does any formula use column X" / "can I repurpose the SKU column" / "verify the order math" / any MASTER_ITEMS column change. The discipline that caught the column-D-vs-O near-miss. |
| `mog-pwa-audit` | Full-file audit of the PWA layer (`template/index.html` + `sw.js`) for latent bugs / dead code / unlocalized strings / cache hygiene. PWA-layer twin of `appsscript-codebase-audit`. Triggers on "audit the PWA" / "review template/index.html" / after a big PWA edit. |

**User-global** (`~/.claude/skills/<name>/SKILL.md` — load in every Claude Code session):

| Skill | When it triggers |
|---|---|
| `architectural-walkthrough` | Any non-trivial change. Runs FIRST. |
| `surgical-patch` | Generic anchor-and-assert edit discipline. |
| `source-of-truth-verification` | When an Edit fails (anchor not found) and drift is suspected. |
| `rhino-safe-html` | Editing any `apps-script/*.html` script block — enforces ES5 syntax. |
| `claude-code-project-setup` | First-time scaffold for a new repo. Not relevant here anymore. |

## Working conventions

1. Architectural walkthrough before any non-trivial implementation. Sebastian explicitly prefers being walked through changes step-by-step (see [feedback_explicit_safe_steps](#) in memory).
2. **Canary first, fan out second.** For multi-target deploys (clasp to 9 stores, build.py to 8 store dirs), push to one canary, wait for Sebastian to smoke-test, then push to the rest.
3. **Verification is opening the live URL or running the function** — not "no errors in tooling output." Sebastian validates by using the thing.
4. Read the actual file before editing — assume it may have drifted since the last session.
5. No "🤖 Generated with Claude Code" footers on commit messages.
6. Suggest commits, don't auto-commit. Sebastian owns the commit decision.
7. PowerShell PATH may be stale after a fresh tooling install on Windows. If `node`, `npm`, `clasp`, or `python` returns "not found" right after `winget install`, prefix the next command with `$env:Path = [System.Environment]::GetEnvironmentVariable("Path","Machine") + ";" + [System.Environment]::GetEnvironmentVariable("Path","User");`.

## Common pitfalls

1. **Editing `<slug>/index.html` (generated dir) instead of `template/index.html`** — lost on next build.
2. **Editing in the Apps Script editor** — overwritten by next `python deploy.py`. There's no "this one store has a custom hotfix" pattern; the discipline is local edit + deploy to all.
3. **Forgetting `python build.py` after editing `stores.json` or `template/`** — generated dirs go stale; hub picker may show a store with no working URL.
4. **Forgetting `python deploy.py` after editing `apps-script/<file>`** — local repo is ahead of all 9 deployed Sheets; KMs run stale code until you remember.
4a. **Forgetting `--redeploy` after a MOGApi.gs change** — bound sidebars look right (they read HEAD), but the PWA's `/exec` URL is a versioned snapshot and still serves the old code. Use `python deploy.py --redeploy` for any change to `MOGApi.gs` or anything called from it.
5. **Assuming modal `<script>` blocks run server-side / in Rhino.** They do NOT — modals are browser-side (see invariant #4), so ES6 is safe there and already in use. The real boundary: modal `<script>` has no access to V8-server globals or `.gs` functions except via `google.script.run`; don't paste server helpers into a modal expecting them to resolve.
6. **Slug rename in `stores.json`** — breaks bookmarks and home-screen icons. If you really need to rename, leave a redirect.
7. **Not bumping `CACHE_VERSION`** — KMs' phones serve the old shell from disk forever. Bump on any HTML-shell change in `template/sw.js` (or root `sw.js` for hub changes).
8. **Hand-editing the `STORE_REGISTRY` line in root `index.html`** — `build.py` will overwrite it from `stores.json` on the next build.
9. **Pushing to a different account's clasp session** — `clasp` is logged in as one Google account at a time. Run `clasp login` again if you accidentally pushed nothing or got a permission error.
10. **Forgetting the master template `_template` in `.clasp-targets.json`** — new stores copied from it would start with stale code. The template is one of the 9 deploy targets for a reason.

## File inventory

```
mog-mobile/
├── CLAUDE.md                    This file. Load-on-start anchor.
├── README.md                    Human-facing docs (architecture, add-a-store walkthrough).
├── index.html                   Hub picker landing page.
├── sw.js                        Hub service worker.
├── manifest.json                PWA manifest for the hub.
├── stores.json                  Store registry: slug, concept, location, deployment URL.
├── build.py                     Python templating: stores.json + template/ → <slug>/ dirs + STORE_REGISTRY injection.
├── deploy.py                    Push (and optionally --redeploy) apps-script/ to all 9 clasp targets. Also handles --discover for deploymentId bootstrap.
├── icons/                       Branding (heh-180.png, rp-180.png, etc.).
├── template/                    PER-STORE PWA SOURCE.
│   ├── index.html               (311 KB — the store app UI).
│   └── sw.js                    (6.9 KB — store SW).
├── apps-script/                 APPS SCRIPT SOURCE.
│   ├── README.md                Apps Script workflow docs (setup + day-to-day).
│   ├── MOGApi.gs                Core API surface for PWA ↔ Sheet.
│   ├── OrderGuideScript.gs      Main bound script (menus, triggers, sheet logic).
│   ├── AdminReset.html          Admin reset modal.
│   ├── ManageItems.html         Item editor modal.
│   ├── ManageVendors.html       Vendor editor modal.
│   ├── OrderHistory.html        Past orders modal.
│   ├── ReorderPickPath.html     Reorder pick-path modal.
│   ├── StorageAreas.html        Storage area config modal.
│   ├── HowToUse.html            In-app help modal.
│   ├── appsscript.json          Manifest (timezone, OAuth scopes, webapp config).
│   └── .clasp-targets.json      Slug → {scriptId, deploymentId} map for deploy.py.
├── docs/
│   ├── MOG_CurrentState.md      Running snapshot — what's in flight, invariants, recent changes.
│   └── MOG_SessionHandoff_*.md  Per-session handoffs (newest @-imported above).
├── .claude/
│   └── skills/                  Repo-specific skills.
└── rpr/ rprfo/ rpt/ rptfo/      GENERATED — do not edit.
    rpfr/ rpfrf/ tnyt/ tnytf/    (per-store dirs from build.py)
```
