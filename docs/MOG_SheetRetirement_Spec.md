# MOG: retiring each store's Google Sheet (spec)

**Status:** approved by Sebastian, 2026-11-11 (spec-first: R1, R3, R4 and R5 picked as recommended; R2 and R6 to R11 approved as stated). Step 1 (the backup) is built and live (2026-11-11, "Step 1, built" below). Step 2 is built and gated: schema v23, the function and the schedule are live, and no store has switched yet ("Step 2" below). Steps 3 to 5 are not started. It replaces the stub in [MOG_Warehouse_Spec.md](MOG_Warehouse_Spec.md) §3, which links here.
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

After this, a store is a row in Supabase plus its folder on GitHub Pages. The nightly close, the recap email, PINs, backups and opening a store all run in Supabase (plus one email relay and one backup job), the same for every store. Only the email relay runs as a person's Google account: Sebastian's, one standalone Apps Script with no trigger (R3, revised 2026-11-12).

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
| R3 | **How the recap email is sent** | **Revised 2026-11-12: the mail relay.** One standalone Apps Script project (`mail-relay/`, bound to no Sheet, owned by Sebastian, no trigger) that the function posts each email to; it sends with MailApp from Google's no-reply address on hehfood.com, as the stores' recaps always have. No new account, no DNS. *Chosen 2026-11-11 and dropped before setup: an email service (Resend), which needed a new account, DNS records and an API key.* | Resend (a new account and DNS). The Gmail API (a Google Cloud project, a service account and domain-wide delegation). SMTP on port 465 (Edge Functions block only 25 and 587; untested, and it needs an app password with full access to a mailbox stored in Supabase). |
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
| 2 | The close and the recap email in Supabase (R1, R2, R3, R8): canary rprfo, then all | 2 sessions | The core. Needs the mail relay set up. |
| 3 | The phone off `/exec` (R7) | half to 1 session | Needs step 2's function. |
| 4 | PINs and New store in HQ (R5, R6); `mog-add-store` rewritten; tried on a TEST store | 1 session | Needs every store's PIN push gone (step 2). |
| 5 | Retire: the 11 projects' triggers, `deploy.py`'s targets, `mog-exec-repoint`, CLAUDE.md's layers, invariants and rules 5 and 6 | half a session | Last. |

About 4 to 5 sessions. Schema numbers are taken when each step is built.

### Step 1, built (2026-11-11)

Walkthrough approved as recommended: the restore checked every night, the password generated in the SQL and shown once, the role created on the live database.

- **What runs:** the private repo [SebHEH/mog-backup](https://github.com/SebHEH/mog-backup) (its README has the restore steps). A GitHub Action runs every day at 09:47 UTC (4:47 AM New York in winter, 5:47 AM in summer, after every close), by hand, and on a push to its workflow or scripts.
  1. It connects as `mog_backup` through the session pooler (IPv4) and checks it is that role and read-only.
  2. It dumps the `mog` and `public` schemas with `pg_dump` 17 and keeps the dump as the run's artifact for 90 days.
  3. It restores the dump into a throwaway Postgres 17 on the runner and compares it line for line with the live database: each function's definition and grants, each table's grants, the constraints, RLS, and every table's row count.
  4. Any difference turns the run red, and GitHub emails Sebastian.
- **The role:** [supabase/backup_role.sql](../supabase/backup_role.sql), run by Sebastian in the SQL Editor. It gives `mog_backup` login, BYPASSRLS (every `mog` table has RLS on with no policies), at most 2 connections and read-only by default, plus SELECT on every `mog` table and sequence, now and later.
  - It generates the password and shows it once: a typed password would land in the Postgres log (`log_statement = ddl`). Re-running the file rotates it.
  - [supabase/tests/backup_role_pglite.mjs](../supabase/tests/backup_role_pglite.mjs) (in CI) runs it as a non-superuser like Supabase's `postgres`.
- **Measured on the first green run (#4):**
  - Postgres 17.6: 36 tables, 17,609 rows; the dump is 710 KB and took 17 s; the restore took 1 s; the artifact is 745 KB.
  - About 67 MB of the 500 MB artifact storage held at once, and about 60 of the 2,000 minutes a month.
- **Met on the way** (runs #1 to #3, each fixed and kept in the scripts):
  - `nosuperuser` in the role file: only a superuser may name that attribute, and PGlite runs as one (lesson in `mog-supabase-schema`).
  - A trailing newline in the secret, picked up from the SQL Editor's grid: the script drops whitespace and describes a malformed secret without showing it.
  - The dump's `CREATE SCHEMA public` stops any restore, since every Postgres has that schema: a restore leaves that one entry out.
  - Supabase and the runner sort text differently: the comparison sorts byte by byte.
- **Restore tested:** every run restores its own dump (success criterion 4). A restore into a new Supabase project uses the same steps (the README).
- **The first scheduled night (11-12) never started:** GitHub picked up the schedule only after a push to the repo. Run #5, started by hand on 11-12, passed (37 tables, 17,766 rows, matched). **Not checked yet:** the 11-13 scheduled run (09:47 UTC). A backup watchdog (an email when no good backup is newer than 30 hours) is designed in step 2's session and waits for Sebastian's go.
- **Unchanged:** the Sheets' LOG_ORDERS copy runs until step 2. No Apps Script, store or schema version changed.

### Step 2: built and gated, not live yet (2026-11-11)

**Measured first:**
- `OrderMath.gs` loads unchanged as a strict ES module and closes a 600-item, 30-vendor store in 16 to 47 ms of CPU (Node, the same V8 as Deno), against the 2 s limit. rpr's live snapshot, the biggest, is 51 KB.
- Edge Functions (Supabase docs): 2 s CPU, 150 s wall clock, 256 MB, no `vm`, ports 25 and 587 closed. `SUPABASE_DB_URL` is built in, so the function calls `mog.*` directly and adds no public endpoint.
- The mail relay (2026-11-12, R3):
  - Apps Script's `doPost` can't read request headers, so the relay's secret rides in the body (HTTPS);
  - MailApp's quota for a Workspace account is 1,500 recipients a day (Google's quota page). `setupRelay` logged 1,485 left on 11-12 at about 9 AM, so about 15 were already used that day. That's against 21 active recipients across the 10 stores;
  - CacheService keeps a key at most 6 hours, and a recap's 3 tries are 15 minutes apart.
- ~~Resend (resend.com, 11-11): 3,000 emails a month and 100 a day, an `Idempotency-Key` kept 24 hours, records on `send` and `resend._domainkey`.~~ Dropped 2026-11-12 for the mail relay (R3).
- **The Daily summary already sets the once-per-cycle flag** (sent at 1:05 PM on 11-05 at Rosslyn BOH, at 4:01 PM on 11-01 at Tysons FOH), and that night's recap is then skipped. In step 2 it still runs in Apps Script, so the flag is shared.

**Decided in the walkthrough (Sebastian, 2026-11-11):**
- Apps Script's three recap paths read and write the flag in Supabase as well as the Script Property.
- Each store's 3:30 AM trigger deletes itself the first night its `close_direct` is on, and stamps `mog.stores.sheet_trigger_off_at`.
- The recap comes from `Master Ordering Guide <noreply@hehfood.com>`, with no Reply-To.
- Every night, each store Apps Script still closes gets a shadow run between 3:00 and 3:20 AM, compared each morning with what Apps Script logged.
- **2026-11-12:** the recaps go through the mail relay, not Resend: no new account (R3). From Google's no-reply address, under the name "Master Ordering Guide".

**How it runs:**
1. Every 15 minutes `pg_cron` runs `mog.night_tick()` ([supabase/night_schedule.sql](../supabase/night_schedule.sql)). When `mog.night_due()` names something, it posts once to the Edge Function `close` with Vault's secret.
2. The function ([supabase/functions/close/](../supabase/functions/close/)) does each due item in turn:
   - **Close:** a store with `close_direct` on, its cycle behind, from 3:30 AM its time. It reads the sync snapshot, runs `OrderMath.gs`, then calls `mog.night_close`, which is v17's close unchanged (`mog.close_cycle`).
   - **Recap:** claimed once per 15 minutes, at most 3 tries. It's built by `RecapEmail.gs` and posted to the mail relay ([mail-relay/Relay.gs](../mail-relay/Relay.gs)), one email per active recipient, with a key per cycle and person that the relay keeps 6 hours, so a retry never sends twice.
   - **Shadow:** worked out and kept in `mog.night_log` only.
3. Every close, recap, shadow and test leaves a row in `mog.night_log`.

**Built:**
- [supabase/schema_v23.sql](../supabase/schema_v23.sql), with smoke_v23: 48 rows; 11 planted defects all caught.
- [supabase/night_schedule.sql](../supabase/night_schedule.sql), with [night_schedule_pglite.mjs](../supabase/tests/night_schedule_pglite.mjs) in CI (stand-ins for Vault, `pg_net` and `pg_cron`).
- The function.
- [apps-script/Concepts.gs](../apps-script/Concepts.gs) and [RecapEmail.gs](../apps-script/RecapEmail.gs), moved unchanged.
- `Recap.gs` (the shared flag) and `Sync.gs` (`nightMovedToDb_`).
- The gate `tests/night_close.test.js`:
  - 30 stores closed both ways, with the same rows, log, cycle and emails byte for byte;
  - 60 email cases against the pre-move `sendRecapEmail_`;
  - 7 once-per-cycle scenarios;
  - 13 planted defects.
- The mail relay (2026-11-12): [mail-relay/](../mail-relay/) (`Relay.gs`, its manifest, `relay-target.json`), the function's `relayMailer` in `core.mjs`, `python deploy.py --relay`, and the gate `tests/mail_relay.test.js` (the real `Relay.gs` behind the function's mailer; 21 planted defects).

**Live so far (2026-11-11, each on Sebastian's go):**
- schema v23: smoke_v23 48/48, probe 142/142.
- The Edge Function `close` (version 1, JWT check off):
  - refuses a call without the secret, with a wrong one, and by GET (401, 401, 405), which also shows it boots in Deno and reaches the database;
  - a run with Vault's secret through `pg_net` answered HTTP 200 `{"ok":true,"ran":[]}`.
- `night_schedule.sql`: `pg_cron` 1.6 and `pg_net` on, the secret made in Vault, job `mog-night` every 15 minutes.
- `close_direct` is off at all 10 stores.
- **The first shadow night (11-11 → 11-12):** all 10 stores matched Apps Script's log row for row (vendor, item, name, pack, area, on hand, quantity): 118 rows at the four that ordered (rpr 64, rpt 30, rpfr 12, rprfo 12), and 0 against 0 at the six that ordered nothing. No count landed between the shadow and the close. One post to the function at 3:00 (HTTP 200); 61 ticks, all succeeded. Apps Script closed every store between 3:23 and 3:37.

**Still to do** (since 2026-11-12, a deploy that changes nothing a store does runs and is reported; turning on `close_direct`, steps 8 and 9, is asked first):
1. ~~Run v23, then smoke_v23.~~ Done 2026-11-11.
2. ~~Deploy the function.~~ Done 2026-11-11.
3. ~~Resend: signup, DNS, and the key.~~ Replaced 2026-11-12 by the mail relay, done the same day:
   1. ~~Create and deploy the relay with clasp.~~ Project and deployment @1 made by Claude; IDs in `relay-target.json` and `RELAY_URL`. It answered 403 until step 2.
   2. ~~Sebastian runs `setupRelay` and copies `MOG_RELAY_SECRET` into Edge Functions → Secrets.~~ Done; the relay then answered `NOT_ALLOWED` without the secret.
   3. ~~Redeploy the function.~~ Version 4 (JWT check off); still 401 without Vault's secret.
4. ~~Run `night_schedule.sql`.~~ Done 2026-11-11.
5. ~~Send a test email to Sebastian, timed.~~ Sent 11-12 14:31 UTC: rprfo's 11-11 recap (1 vendor, 12 items), about 2.6 s end to end.
6. Deploy Apps Script: ~~rprfo~~ (11-12, version @114, `/exec` health check answers), then the other 10 once rprfo's night checks out (it closes as before, sends one recap, and its new `Recap.gs` writes `mog.store_state.recap_sent_for`). Changes nothing a store does while `close_direct` is off, so it runs without a question (CLAUDE.md, Working conventions 2).
7. Run the shadow nights (night 1 matched, 11-12).
8. Turn on rprfo's `close_direct` for three nights.
9. Turn it on for the other nine.

## Not verified

- The trigger list in each of the 11 Apps Script projects (only the recap's sender was measured). Step 2's triggers remove themselves, so the list matters only for anything else installed.
- Whether anyone opens a store's Sheet today.
- ~~`OrderMath.gs` and the recap builder running unchanged in Supabase's Deno runtime.~~ Measured as a strict ES module in Node (same V8 as Deno), 2026-11-11. The first Deno run itself is the test email and the first shadow.
- ~~Resend's free-tier numbers.~~ Confirmed on resend.com 2026-11-11, then Resend was dropped (R3).
- ~~The relay's From line.~~ Seen by Sebastian on the test email, 11-12: from `Master Ordering Guide <noreply@hehfood.com>`, reply-to `noreply@`, signed by Google's `gappssmtp` key and mailed by `google.com` (the same signature as the stores' Apps Script recaps), subject and layout as usual.
- ~~That the function's POST reaches `doPost` through Apps Script's redirect.~~ Confirmed 11-12 by the test email (HTTP 200, sent 1).
- ~~How long one relay call takes.~~ Measured 11-12: the whole test run (pg_net, the function, the relay, MailApp) took about 2.6 s, so one send is under that, and 21 recipients fit the 100 s budget. No per-store batching.
- Whether `SUPABASE_DB_URL` reaches the database from the function (IPv6 direct host or the pooler): the first test email shows it.
- Whether each store's Script Property location matches `mog.stores.location`. Matched in the subjects sent for rpr, rprfo, rpfr, rpt and tnytf; the other five have sent no recap since 10-28.
- ~~GitHub Actions artifact retention on a private repo (90 days assumed).~~ Settled 2026-11-11: a private repo keeps artifacts 1 to 400 days (GitHub docs); the backup sets 90.
