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
│   ├── index.html          Built from template/index.html with the Supabase config, store profile and order math injected
│   └── sw.js               Copy of template/sw.js
├── apps-script/            The retired per-Sheet backend, kept as a build source (OrderMath.gs, editor pages, the close's shared code)
│   ├── MOGApi.gs           doGet/doPost + api_* surface the PWA calls
│   ├── Core.gs             Constants, helpers, menu/triggers, order-cycle date helpers
│   ├── Vendors.gs Items.gs PickPath.gs ResetLog.gs History.gs Dashboard.gs   (domain modules)
│   ├── Editor.gs Health.gs Recap.gs Admin.gs   (KM web editor, health check, recap email, admin/test fns)
│   ├── *.html              (Manage*, OrderHistory, ReorderPickPath, StorageAreas, etc.)
│   └── README.md           Apps Script workflow docs
├── mail-relay/             The mail relay: the one Apps Script project still deployed (the nightly recap emails)
├── deploy.py               python deploy.py --relay: push and redeploy the mail relay (nothing else)
└── README.md               This file
```

Per-store directories (`rpr/`, future `rpt/`, `rpfc/`, etc.) are **generated** by `build.py`. Never edit them directly — your changes will be overwritten on the next build. Edit `template/` instead, then run `build.py`.

## Backend

Every store runs on Supabase: the phones, the Manage pages and HQ call it directly, and it closes each store just after midnight and sends the recap email through the mail relay (`mail-relay/`, deployed with `python deploy.py --relay`). The stores' Google Sheets and their Apps Script are retired (Sheet retirement step 5, 2026-11-20): frozen in Drive, their web apps archived. `apps-script/` stays as a source that `build.py` reads. See `CLAUDE.md` for the layers and `docs/MOG_SheetRetirement_Spec.md` for how the move went.

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

HQ → Stores → **New store** makes it in Supabase in one step (no Sheet); then it is published with `stores.json` and `build.py`. The steps are in `.claude/skills/mog-add-store/SKILL.md`. Each entry in `stores.json` holds `slug`, `concept`, `location`, an optional `address`, `"editor": "supabase"` and `ns` (the phones' storage key, `s_<slug>` for a new store); `build.py` refuses anything else it can't use.

## Store PINs and the manager PIN

Both are set in HQ → Stores: **Change PIN** per store (every phone there is signed out), and one **Manager PIN** for every store, which must differ from each store's PIN.

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
- **The build placeholders** in `template/index.html` (CLAUDE.md invariant 5): substituted by `build.py` per store.

## What IS safe to edit

- **`template/index.html`** — single source of truth for the store PWA. Run `build.py` after edits.
- **`template/sw.js`** — store service worker source. Bump `CACHE_VERSION` (e.g. `v2` → `v3`) when shipping HTML structure changes so old caches evict cleanly.
- **`index.html`** at root — hub picker. Only the `STORE_REGISTRY` line is build-managed; everything else is hand-edited.
- **`sw.js`** at root — hub service worker. Independent of the per-store SW versioning.
- **`stores.json`** — the registry.

## Troubleshooting

**Hub auto-redirects me but I want to switch stores.**
Visit `/?force_picker=1` once. To make this permanent, sign out from inside the store PWA — that clears the cached PIN but not `mog_hub_last_slug`. Sign out + `?force_picker=1` covers it. (We can add an in-PWA "switch store" button if this becomes annoying.)

**A KM types their PIN and it's rejected.**
PINs live in Supabase: check HQ → Stores (was it changed there?). Five misses lock the store for 5 minutes; a signed-in computer can clear it from Manage → Overview's "PIN lockout" fix.

**The manager banner doesn't show even though I entered the manager code.**
The manager PIN is one code for every store, set in HQ → Stores → Manager PIN. Check it was set there and that the code typed matches.

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
