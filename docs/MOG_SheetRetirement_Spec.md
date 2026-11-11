# MOG: retiring each store's Google Sheet (spec)

**Status:** approved by Sebastian, 2026-11-11 (spec-first: R1, R3, R4 and R5 picked as recommended; R2 and R6 to R11 approved as stated). Nothing is built. Step 1 starts with an architectural walkthrough. It replaces the stub in [MOG_Warehouse_Spec.md](MOG_Warehouse_Spec.md) §3, which links here.
**Read with:** [MOG_SupabaseMigration.md](MOG_SupabaseMigration.md) (D9: the Sheet is retired from the app's path), [MOG_OneApp_Spec.md](MOG_OneApp_Spec.md).

---

## Why

- Every store already counts, orders and edits in Supabase. Its Sheet is frozen, but its bound Apps Script still runs jobs that have nothing to do with the Sheet's data.
- That costs: 11 clasp targets and `deploy.py`, a nightly trigger per store that runs as one person's Google account, two `/exec` fallbacks on the phone, and an 11-step new-store runbook with 6 steps in Drive or Apps Script.
- Sebastian's goal (Warehouse spec §3): create the next Roll Play, Lei'd Poke, Chasin' Tails or NUE store entirely in Supabase, with no Sheet copy and no per-store setup.

## What each Sheet still does (inventory, from the code and the live database, 2026-11-11)

| # | Job | Where it runs today | Measured or read |
|---|---|---|---|
| 1 | **The 3:30 AM close** | `Sync.gs` `nightlyMaintenance_` → `closeCycleInDb_`: reads the snapshot (`mog_sync_get_snapshot`), runs the order math in Apps Script (`OrderMath.gs` `orderInputsFromSnapshot_`, `orderLogRowsFromInputs_`), then `mog_sync_close_cycle` (the log, the new cycle, and since v17 the held deliveries). A daily trigger installed by Move this store to Supabase (`ensureNightlyTrigger_`). | All 10 stores closed 11-11 between 3:23 and 3:38 AM (`mog.store_state.updated_at`). |
| 2 | **The nightly recap email** | `Recap.gs` `scheduleRecapSend_` → a one-shot trigger `sendPendingRecap_` (3 tries) → `buildRecapFromLog_` (`mog_sync_get_log`) → `sendRecapEmail_` (MailApp; band colours from `dashTheme_`, the store name from Script Properties). Sent once per cycle: the Script Property `MOG_LAST_RECAP_SENT_DATE`. | Sent from **sebastian@hehfood.com** as "Master Ordering Guide" (his Sent folder, 11-10 and 11-11 around 3:36 to 3:40 AM). 21 active recipients across the 10 stores (`mog.recipients`). 1 to 4 stores have orders on a night (`mog.order_log`, 10-28 to 11-10), so under 20 emails a night. |
| 3 | **The Daily summary during the day** | The app's Send email, and the auto-send on "mark all reviewed" → `/exec` `emailRecap` → `Recap.gs` `api_emailRecap_` (the live order from Supabase, MailApp). Same once-per-cycle flag as 2. | `template/index.html` `sendDailyRecap` is the app's only email path. |
| 4 | **The LOG_ORDERS backup** | `Sync.gs` `appendLogBackup_`, after each close. | The only copy of anything outside Supabase, and it covers the order log only: the catalog, change log, recipients, People and warehouse have no copy. The free plan has **no Supabase backups** (Supabase docs: daily backups on Pro and up; free projects should export with `supabase db dump` and keep it off-site). Database: 18 MB; `mog.order_log` 11,302 rows, 2 MB. |
| 5 | **PINs** | Store PIN and master PIN live in each Sheet's Script Properties, set by the setup wizard (`Editor.gs` `commitStoreSetup`) or the Sheet menu (`Admin.gs` `setupMobileApi_`, `setMasterPin_`), and **pushed to Supabase every night** (`pushPinsNow_` in `nightlyMaintenance_`). | So the Sheet owns each PIN: a PIN set in Supabase today would be overwritten at 3:30 AM. |
| 6 | **Store identity** | Location, store code, concept and GM email in Script Properties (`commitStoreSetup`). | `mog.stores` already holds location, abbr, concept, time zone and side for all 10 stores. Only the email band reads the Sheet's copy. |
| 7 | **A new store** | `mog-add-store`, 11 steps: 1 to 3 (copy the template Sheet, Script ID, web-app deploy), 5 (the `?page=setup` wizard), 7 (Move this store to Supabase: the connect code from `provision_stores.sql`, PIN and catalog push, the nightly trigger, phones direct) and 8 (Move the editor to the app) need a Sheet; 6 is the SQL Editor. | |
| 8 | **The phone's `/exec` calls** | `commitReset`: the app finds yesterday's cycle on open and asks `/exec` to close it (`runStaleReset_` → `MOGApi.gs` → `DbApi.gs` → `closeCycleInDb_`). `emailRecap` (row 3). Sign-in falls back to `/exec` when Supabase can't be reached. | Every other action is direct (`DIRECT_ACTIONS`, `DIRECT_WHEN_MOVED`). The sign-in fallback gives nothing: a moved store's `/exec` reads Supabase too. The editor and HQ make no `/exec` call. |
| 9 | **The Sheet's own tools** | Menus (catalog tools refuse since each store moved), the Sheet Health Check (`Health.gs`; in the app's Overview since 11-11), Admin Reset (`ResetLog.gs`; can wipe a moved store's LOG_ORDERS), the HOME dashboard (`Dashboard.gs`), the open and edit triggers (`dailyResetOnOpen_` returns at once on a moved store), `test_*` functions, the `/exec` editor pages. | Nothing a moved store needs. |
| 10 | Recipients copy | `seedRecipientsToDb_`, nightly. | A no-op: `recipients_seeded` is true at all 10 stores. |
| 11 | Catalog push | `pushCatalogNow_`, nightly and after Sheet edits. | Skipped: `editor_direct` is on at all 10 stores. |

**Who it runs as:** a trigger runs as whoever installed it. The recap's sender shows the close runs as Sebastian's account. Not measured: the trigger list in each of the 11 projects.

---

## Purpose

After this, a store is a row in Supabase plus its folder on GitHub Pages. The nightly close, the recap email, PINs, backups and opening a store all run in Supabase (plus one email service and one backup job), the same for every store, and as no person's Google account.

## Who it's for

- **Sebastian and Donny:** one place to look when a night goes wrong; no clasp, no 11 deploy targets, no trigger that belongs to one account (CLAUDE.md, Two maintainers, rules 5 and 6 go away).
- **HQ, opening a store:** one HQ form instead of six Sheet steps.
- **KMs:** nothing changes except the recap's sender. The morning fallback stops going through `/exec` (about 2 s before any work, measured 2026-10-15).

## Who it's not for

- KMs' daily flow: counting, ordering and Manage stay as they are.
- Anyone reading a Sheet: it stops updating (counts and the catalog already stopped). **Not verified:** whether anyone still opens a store's HOME dashboard or LOG_ORDERS.
- Chasin' Tails and NUE themselves (Warehouse spec §4). This unblocks them.

## Success looks like

1. Seven nights in a row, every store's cycle moves by 4:00 AM New York with no Apps Script trigger for it, and its order log and held deliveries are what Apps Script would have written (a gate runs the new close against the same snapshots).
2. Each cycle with orders sends one recap per active recipient, never two, looking as it does today.
3. The app makes no `/exec` call (network log), and a phone that opens on yesterday's cycle closes it in under 3 seconds.
4. A nightly off-site backup of every `mog` table exists, and one restore into a scratch database has been tested.
5. A TEST store is created from HQ with no Sheet, Script ID or clasp: its PIN works, it counts, it closes that night and emails its recap.
6. A PIN changed in HQ still works the next morning.
7. No store has an Apps Script trigger, `deploy.py`'s store targets are retired, and CLAUDE.md's layers say so.

## Out of scope

- **Deleting** the Sheets or their Apps Script projects: they stay in Drive as an archive. Deleting is its own later question.
- Removing `apps-script/` from the repo: the gates still compare `catalogEdit.js` with `Items.gs`, `Vendors.gs` and `PickPath.gs`. A later cleanup.
- The hub reading stores from Supabase: `stores.json` and `build.py` stay, so a new store is still one push.
- A new recap design, the MarginEdge API, schema v23, new concepts' themes.

---

## Decisions (Sebastian, 2026-11-11)

| # | Decision | Chosen | Alternatives (not chosen) |
|---|---|---|---|
| R1 | **Where the close runs** | **A Supabase Edge Function** (`close`) running `OrderMath.gs` verbatim, copied in at build time as `build.py` does for the phone, started by `pg_cron` through `pg_net`. It calls the same `mog_sync_close_cycle` steps, so the held-delivery step (v17 to v22) runs unchanged. | One central Apps Script project, not bound to a Sheet, closing every store (reuses today's code, keeps Google and one account). A GitHub Actions schedule (start times drift, and the repo is public). |
| R2 | When it runs | **Every 15 minutes**, a SQL check picks the stores whose local time is past 3:30 AM and whose cycle is behind, and only then calls the function. A failed close retries 15 minutes later; daylight saving and each store's `time_zone` are handled. | A fixed 3:30 AM (pg_cron runs in UTC, so two schedules around daylight saving, and a missed night waits for a phone). |
| R3 | **How the recap email is sent** | **An email service (Resend)** called by the function, from an address on hehfood.com. Needs DNS records (SPF and DKIM) on hehfood.com, which Sebastian adds himself when step 2 starts. Free tier about 3,000 a month and 100 a day (confirm at signup), against under 20 a night today. | Google keeps sending: one central Apps Script sends what Supabase queues (as Sebastian, no DNS; one project and one trigger stay). The Gmail API with a stored Google token (no DNS; a token to keep alive). SMTP is out: Edge Functions block ports 25 and 587. |
| R4 | **What replaces the LOG_ORDERS backup** | **A nightly `pg_dump` of the `mog` schema** by a scheduled GitHub Action in a new private repo, kept 90 days, through a read-only database role. Covers every table, off Supabase, free. | Supabase Pro (about $25 a month: 7 daily backups restorable from the dashboard, kept by the same company). Both. |
| R5 | **How a new store is created** | **HQ → Stores → New store** (hq role): name, concept, side, store code, slug, time zone, PIN and master PIN. One transaction creates the store with phones and editor on Supabase and an open cycle. Then Claude adds it to `stores.json`, builds and pushes, and the Overview checklist (or a concept library) sets it up. `mog-add-store` drops to about 4 steps. | A SQL function a maintainer runs in the SQL Editor, the GM choosing the PIN on first open with a one-use code (as HQ invites work). |
| R6 | PINs | HQ → Stores sets a store's PIN and master PIN. Supabase owns them from the night its Sheet's trigger is removed (the PIN push goes with it). | A PIN change in the store's own Settings with the master PIN. |
| R7 | The phone's fallbacks | The app asks the close function to close its own store with its PIN session (the code the night runs). Daily summary goes to the same function's email path. Sign-in no longer falls back to `/exec`. | The phone computes the log itself and sends the rows. |
| R8 | The recap's look | The email builder moves out of `Recap.gs` into a shared file the function uses: same subject and layout, band colours from `mog.stores.concept`. The once-per-cycle flag moves to `mog.store_state`. | |
| R9 | Rollout | The backup first. Then the close and email on the canary rprfo for three nights with its Apps Script trigger removed, then the other nine at once. | All ten at once. |
| R10 | The Sheets afterward | Triggers removed, no more deploys, the Sheets left untouched in Drive as an archive. | Delete them (its own question, later). |
| R11 | `OrderMath.gs` | Stays the one copy of the order math; the build copies it into the phone and the function. Its folder may move out of `apps-script/` (walkthrough). | |

**Facts behind R1 to R4 (measured 2026-11-11):** `pg_cron` 1.6.4 and `pg_net` 0.20.0 are available and not installed; Vault is installed; no Edge Function exists yet. Edge Function limits (Supabase docs): 2 s of CPU per request, 150 s wall clock on the free plan, no Node `vm` (so `OrderMath.gs` is bundled as a module, not loaded the way the gates do). An Edge Function deploy is a new deploy surface: it runs on the maintainer's go, like a schema file.

## Order of work

Each step ships on its own. Sizes are estimates.

| # | Step | Size | Why here |
|---|---|---|---|
| 1 | The backup (R4) | half a session | A store's LOG_ORDERS copy stops the night its close moves, so the new backup comes first. |
| 2 | The close and the recap email in Supabase (R1, R2, R3, R8): canary rprfo, then all | 2 sessions | The core. Needs the email account and DNS ready. |
| 3 | The phone off `/exec` (R7) | half to 1 session | Needs step 2's function. |
| 4 | PINs and New store in HQ (R5, R6); `mog-add-store` rewritten; tried on a TEST store | 1 session | Needs every store's PIN push gone (step 2). |
| 5 | Retire: the 11 projects' triggers, `deploy.py`'s targets, `mog-exec-repoint`, CLAUDE.md's layers, invariants and rules 5 and 6 | half a session | Last. |

About 4 to 5 sessions. Schema numbers are taken when each step is built.

## Not verified

- The trigger list in each of the 11 Apps Script projects (only the recap's sender was measured).
- Whether anyone opens a store's Sheet today.
- `OrderMath.gs` and the recap builder running unchanged in Supabase's Deno runtime.
- Resend's free-tier numbers (from memory; confirm at signup).
- GitHub Actions artifact retention on a private repo (90 days assumed).
