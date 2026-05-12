# MOG Mobile — Multi-Store Hub

The Master Ordering Guide mobile PWA for HEH fast-casual locations. One GitHub Pages origin serves all stores; a concept-first picker routes to the right one.

## What this repo is

A single static site hosted at `https://sebheh.github.io/mog-mobile/` that:

1. **Lands users on a concept → location picker** when they visit the root URL.
2. **Routes them to the per-store PWA** at `/<slug>/` after picking. From there it's the familiar single-store experience: PIN gate, dashboard, vendor cards, history.
3. **Remembers their last store** so the next visit auto-redirects past the picker.
4. **Supports manager mode** for multi-unit operators (Ashley, Aaron, Cece, etc.) who need to bounce between stores without each location's PIN.

## Architecture

```
mog-mobile/
├── index.html              Hub landing page (concept→location picker, manager-mode entry)
├── sw.js                   Hub service worker (lets the picker load offline)
├── stores.json             Registry: which stores exist, which deployments they point at
├── build.py                Build script: generates per-store dirs from template/
├── template/               Single source of truth for the per-store PWA
│   ├── index.html          The store PWA — DO NOT edit copies in store dirs
│   └── sw.js               The store SW
├── rpr/                    GENERATED — Roll Play Rosslyn
│   ├── index.html          Built from template/index.html with deployment URL injected
│   └── sw.js               Copy of template/sw.js
└── README.md               This file
```

Per-store directories (`rpr/`, future `rpt/`, `rpfc/`, etc.) are **generated** by `build.py`. Never edit them directly — your changes will be overwritten on the next build. Edit `template/` instead, then run `build.py`.

## Day-to-day workflow

After editing **anything inside `template/`** (the store PWA source):

```bash
python3 build.py
git add -A
git commit -m "..."
git push
```

That's it. `build.py` is idempotent and zero-arg; running it without changes is a no-op. Use `python3 build.py --dry-run` to preview without writing.

If you only edited the hub (`index.html` or `sw.js` at root), you don't strictly need to run `build.py` — but running it costs nothing and keeps things consistent.

## Adding a new store

The full sequence, end to end:

### 1. Set up the spreadsheet + Apps Script for the new location

In the new location's spreadsheet:

1. Add `MOGApi.gs` (the version in this repo's project files, **v0.8.0 or later**).
2. From the Apps Script editor, run `setupMobileApi()`. Five prompts:
   - 4–8 digit store PIN
   - Location name (e.g. "Roll Play Tysons")
   - 2–5 letter abbreviation (e.g. "RPT")
   - GM email (optional)
   - Master PIN (optional — leave blank if you don't want this location accessible via manager mode, or enter the shared HEH master PIN)
3. Deploy: **Deploy → New deployment → Web app**, Execute as Me, Anyone access.
4. Copy the deployment URL.

### 2. Register the store in the hub

Edit `stores.json` and add an entry:

```json
{
  "slug": "rpt",
  "concept": "Roll Play",
  "location": "Tysons",
  "deployment": "https://script.google.com/macros/s/...XYZ.../exec"
}
```

`slug` must be lowercase letters/digits/hyphens only. `deployment` must match the Apps Script web app pattern. `build.py` validates both — it'll refuse to run with a clear error if either is wrong.

### 3. Build, commit, push

```bash
python3 build.py
git add -A
git commit -m "Add Roll Play Tysons to hub"
git push
```

`build.py` will:
- Create `rpt/` with `index.html` (deployment URL injected) and `sw.js`
- Update the hub's `STORE_REGISTRY` so the picker shows the new store

### 4. Smoke test

Open the hub URL in a private/incognito window:
- New store appears in the concept picker (or as an additional card if the concept already exists)
- Tapping it loads `/<slug>/`
- PIN gate accepts the store PIN you set in step 1
- If you set a master PIN, the manager-mode flow also works

## Setting / rotating the master PIN

Two ways:

**Per-store, manually.** For each Apps Script: open the editor, select `setMasterPin` from the function dropdown, run it. Prompt asks for the new master PIN; leave blank to remove. This is what you do for ad-hoc rotation.

**Per-store, at setup.** The 5th prompt of `setupMobileApi()` accepts the master PIN. Use this when onboarding a new store.

The master PIN is shared across all stores that should be reachable in manager mode. Today that's: whichever stores have a master PIN set. A store without a master PIN cannot be accessed via manager mode — its store PIN remains the only credential.

To rotate the master PIN org-wide, you need to update every store's Apps Script properties manually (5 minutes for 5 stores). Future improvement candidate: a one-shot admin script that does this via the Apps Script API.

## Manager-mode flow (from a user's perspective)

1. Visit hub URL.
2. Tap **Multi-Unit Manager** at the bottom of the concept picker.
3. Enter the master PIN (4–8 digits).
4. Pick any location from the flat list.
5. Lands inside that store's PWA with a teal **Manager mode — \<store name\>** banner at the top.
6. Use the app normally; counts, saves, history all work.
7. Tap **Exit** on the banner to bounce back to the hub. SessionStorage is cleared; the master PIN is forgotten.

The master PIN is stored in `sessionStorage`, which dies when the browser tab closes. So manager mode automatically expires; the manager re-enters the code next time they open the app.

## URL flags

| URL | Effect |
|---|---|
| `/` | Normal flow: auto-redirect if remembered, otherwise picker |
| `/?force_picker=1` | Skip auto-redirect this once. Useful for KMs switching stores from their phone. The flag is consumed (removed from URL) on load. |
| `/?master_failed=1` | Set automatically when a `/<slug>/` rejects a master PIN. Shows a clear "Master code not accepted" banner on the picker. |
| `/<slug>/` | The store PWA directly. Works the same as before the hub existed. |

## What NOT to edit

- **Generated store directories** (`rpr/`, `rpt/`, etc.) — overwritten by `build.py`.
- **The `__STORE_REGISTRY__` marker line** in `index.html` — `build.py` rewrites it on every build.
- **The `__MOG_API_URL__` placeholder** in `template/index.html` — substituted by `build.py` per store.

## What IS safe to edit

- **`template/index.html`** — single source of truth for the store PWA. Run `build.py` after edits.
- **`template/sw.js`** — store service worker source. Bump `CACHE_VERSION` (e.g. `v2` → `v3`) when shipping HTML structure changes so old caches evict cleanly.
- **`index.html`** at root — hub picker. Only the `STORE_REGISTRY` line is build-managed; everything else is hand-edited.
- **`sw.js`** at root — hub service worker. Independent of the per-store SW versioning.
- **`stores.json`** — the registry.

## Troubleshooting

**Hub auto-redirects me but I want to switch stores.**
Visit `/?force_picker=1` once. To make this permanent, sign out from inside the store PWA — that clears the cached PIN but not `mog_hub_last_slug`. Sign out + `?force_picker=1` covers it. (We can add an in-PWA "switch store" button if this becomes annoying.)

**A KM types their PIN and it's rejected after a deploy.**
Check that the store's Apps Script was redeployed (not just its source edited). Apps Script changes don't take effect until you redeploy. **Edit deployment → New version** keeps the same URL; **New deployment** gives a new URL that you'd need to update in `stores.json`.

**The manager banner doesn't show even though I entered the master code.**
Either the master PIN isn't set on that store's Apps Script (run `setMasterPin` to verify), or the master PIN entered doesn't match what that store has stored. Different stores can have different master PINs; for org-wide manager mode, set the same master PIN on every store.

**A store is missing from the picker.**
Check `stores.json` — is the entry there? Run `python3 build.py` and check the output. The registry is injected on every build.

**Localstorage migration loop / drafts disappearing.**
The migration runs once per browser, gated by `mog_migration_v1_done`. If you're testing migration flow, clear localStorage for the origin to force it to re-run on next load.

## Versioning

Three independent version numbers live in this system:

- `MOGApi.gs` — `API_VERSION` constant. Bump on backwards-incompatible API changes. Currently `0.8.0`.
- `template/sw.js` — `CACHE_VERSION` constant. Bump on store-PWA shell changes that should evict old caches.
- `sw.js` (hub) — `CACHE_VERSION` constant. Bump on hub shell changes.

These don't need to move together. The store SW version is the most user-visible (it controls when stale shells evict from KMs' phones).
