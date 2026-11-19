# apps-script/

The Apps Script that ran inside each store's Google Sheet, kept as a **source**, not deployed. The stores' Sheets were retired in Sheet retirement step 5 (2026-11-20): their web apps (`/exec`) are archived, the Sheets stay in Drive frozen, and nothing pushes to their projects any more (`deploy.py` deploys only the mail relay, `mail-relay/`).

What still reads this folder:

- `build.py`: `OrderMath.gs` is injected verbatim into every store page; `OrderMath.gs`, `Concepts.gs` and `RecapEmail.gs` become the close function's `supabase/functions/close/shared.mjs` (redeploy `close` after a change); `Sync.gs` holds the Supabase URL and publishable key; the editor pages (`EditorHome`, `OrderHistory` and their includes) are published under each store's `editor/`.
- The gates in `tests/`, which run this code under Node.

A change here ships with `python build.py` and a git push; `.claude/skills/mog-deploy-workflow/scripts/route.py` lists what else it needs.

## Files

| File | Purpose |
|---|---|
| `MOGApi.gs` | Core API for the PWA frontend to read/write order data (called via each Sheet's `/exec` URL) |
| `Core.gs` | Global constants, generic helpers, menu/`onOpen`/`onEdit`/triggers, generic sidebar openers, order-cycle date helpers (`getActiveOrderDate_`/`getResetStaleness_`) |
| `Vendors.gs` | Vendor add/import/remove/recalibrate, cadence audit, template repair |
| `Items.gs` | Manage Items modal CRUD + active-vendor switch |
| `PickPath.gs` | Storage areas + reorder pick path |
| `ResetLog.gs` | Reset / order-log snapshot / daily recap |
| `History.gs` | Order history modal + par-review flags |
| `Dashboard.gs` | HOME dashboard builder + per-concept theming |
| `Editor.gs` | KM web editor: doGet page routing, PIN gate/token, `webedit_call` dispatch, per-tool web renderers |
| `Health.gs` | Store Health Check — read-only diagnostic + one-click web fixes |
| `Recap.gs` | Daily recap email (build + send) + recipients list in SETUP AB-AE (split from `MOGApi.gs` 2026-07-24) |
| `Admin.gs` | Run-once admin/config functions (`setupMobileApi`, PINs, concept) + editor-run test functions (split from `MOGApi.gs` 2026-07-24) |
| `AdminReset.html` | Admin-only reset/wipe modal |
| `ManageItems.html` | Item editor modal |
| `ManageVendors.html` | Vendor editor modal |
| `OrderHistory.html` | Past orders modal |
| `ReorderPickPath.html` | Pick-path reorder modal |
| `StorageAreas.html` | Storage area config modal |
| `HowToUse.html` | In-app help / how-to-use modal |
| `appsscript.json` | Apps Script manifest (timezone, OAuth scopes) |

## What's gitignored

- `.clasp.json`: never useful to commit (nothing deploys from this folder now).
- `.clasprc.json` — clasp login credentials, never commit.
