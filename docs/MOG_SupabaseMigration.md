# MOG → Supabase migration (count path)

**Status (2026-10-15):** schema live and verified (smoke test 40/40, public-key check 10/10). Step 3 (the shared `OrderMath.gs` + `Sync.gs`) is **deployed to all 10 stores + template** (`6584c10`, `--redeploy`). It passed the live `test_supabaseParity` on rprfo (2 delivering vendors, 25 items, plus the dashboard), and every store's health and POST probes pass. KMs see no change; the next step is step 4.
**Status (2026-10-16):** schema v2 live (smoke 21/21, public-key check 15/15). **rprfo counts in Supabase.** It moved that morning with 0 counts to copy, since it had already reset. Sebastian entered counts on the PWA; they skipped the Sheet and came back after a reload. Its first Supabase cycle close runs at 3:30 AM on 10-17. Step 4 plus the one-step **Move this store to Supabase** is **deployed to all 10 stores + template** (`--redeploy`; every store passed GET and POST probes) and is inactive until each store moves. **Plan (Sebastian):** once rprfo's 10-17 close checks out (recap email, LOG_ORDERS backup, the app on the new cycle), run `supabase/provision_stores.sql` and move the other 9 stores. **Step 5 (phones direct) is live:** schema v3 in (smoke 20/20, public-key check 17/17), app v0.18.0 on all 10 stores. **rprfo's phones went direct the same day**; Sebastian checked a phone: Settings shows "Supabase", with calls under 1s. Every other store's switch is still off.
**Status (2026-10-17):** rprfo's first Supabase close ran at 3:30 AM and its recap email went out. Sebastian moved the other 9 stores, ran `supabase/phones_direct.sql`, and all 10 stores show `phone_direct = true`. **Steps 1-5 are done on every store.** Next: step 6, the web editor (D15-D18).
**Status (2026-10-17, later):** step 6 part 1 is built, not yet run or deployed. That's `supabase/schema_v4.sql` (catalog tables, the SQL catalog builder, the seed, editor_direct) with `smoke_v4.sql`, plus `test_catalogTablesParity` in Sync.gs, gated by `tests/catalog_parity.test.js`. Two fold-ins ship with it: Move this store to Supabase turns `phone_direct` on itself, and the Store Health Check gained four Supabase rows (`tests/health_supabase.test.js`). Decisions D19-D22.
**Owner decisions:** Sebastian, 2026-10-15 (all recorded below with the reason).

This is the single design record for the move. Later sessions build from this file; if the code and this doc disagree, fix one of them in the same commit.

---

## 1. Why

Every PWA request through Apps Script `/exec` pays a fixed cost before doing any work. Stopping Sheet writes while staying on `/exec` would barely help, because the write isn't the cost; the request is.

Measured 2026-10-15 from Sebastian's PC against rprfo:

| Request | Median | Range | Runs |
|---|---|---|---|
| `/exec`, no work (the floor) | 1.70s | 1.19–4.24s | 12 |
| `/exec`, Manage Items page (reads the catalog) | 2.31s warm / 8.49s cold | 1.29–8.49s | 5 |
| Supabase, 300-item snapshot read (43 KB) | 0.39s | 0.16–0.54s | 14 |
| Supabase, count save | 0.32s (0.23s reused connection) | 0.11–0.44s | 13 |

Reads came in 4.4× faster than the no-work floor, under the 5× bar set beforehand. Against a real catalog read they're 6× (warm) to 22× (cold) faster. Sebastian chose to proceed, since real requests always do work on top of the floor and opening the app collapses several `/exec` calls into one read.

Gotcha from the test: a Supabase upsert that **updates** a row returns HTTP **200**, not 201/204.

Measured 2026-10-16 from inside rprfo's script (`test_supabasePushTiming`, 3 runs each):

| Call (Apps Script → Supabase) | Runs | Notes |
|---|---|---|
| Catalog push (12 KB) | 2.35s, 1.36s, 1.13s | Build (reading the Sheet) 1.6s cold / 0.8s warm; the send is 0.35–0.75s. |
| Snapshot read | 0.27s, 0.24s, 0.42s | The same read the PWA will make in step 5, against a ~2s `/exec` floor. |

The push never sits on a save: the web editor fires it as its own background request, and a Sheet edit only queues a one-shot trigger. Its cost is how long a phone waits to see an edit, not how long a save takes.

## 2. Decisions (2026-10-15)

| # | Decision | Chosen | Why |
|---|---|---|---|
| D1 | Scope | Counts + overrides to Supabase; catalog stays in the Sheet | The ~2s cost is per `/exec` request; only leaving `/exec` removes it. The editor isn't the speed complaint. |
| D2 | Database | Supabase (Postgres) | Plain `fetch` from the PWA (no library, no build step); SQL for history later; already the recorded direction. |
| D3 | Reset timing | Nightly timer (~3:30 AM per store) | Takes the 14–31s reset off the KM's first open. The old on-open reset stays as a fallback. |
| D4 | Data outside Google | Approved; Sebastian owns the account | — |
| D5 | Order math | One shared file, `apps-script/OrderMath.gs`, copied into the PWA by `build.py` | Phone, order log and email run identical code. A hand copy would be a new drift risk (the 08-03 bug class). |
| D6 | Sign-in | SQL functions + session token | Everything lives in `schema.sql`; nothing extra to deploy. |
| D7 | Catalog sync | Push on every editor save, retry within a minute, full push nightly | Phones see edits within seconds. |
| D8 | Sheet during the day | Vendor tabs' On Hand stays blank on switched stores | Counts live only in Supabase (D9). |
| D9 | The Sheet's role (later on 2026-10-15) | **Retired from the app's path.** Supabase is the operational store. The Sheet holds the Apps Script, the catalog the editor still edits (until step 6), and a backup. Nothing is ever copied back into it. | Sebastian: "remove the app writing to the sheet and back for performance sake ... [the Sheet] exists as a backup at most." Every design is judged on speed first. Replaces the copy-back design. |
| D10 | Order log backup | The nightly close appends the closed cycle to the Sheet's `LOG_ORDERS` | One write per night, off every hot path. Keeps the web editor's Order History and the par-review flags working until step 6 moves them. |
| D11 | Nightly timer rollout | Installed per store when it moves to Supabase | Each store's reset timing changes along with its migration, rprfo first. |
| D12 | Who decides a store's phones go direct (2026-10-16) | **A flag in Supabase**, `mog.stores.phone_direct`, default off (schema v3) | One switch for the backend and the phones: Switch back to the Sheet turns it off first, so phones can't count into Supabase while the Sheet counts. Rollback takes effect on each phone's next call, with no app update. Rejected: a `stores.json` flag (rollback needs a build, a push and phones updating, and a rollback could leave phones writing to Supabase). |
| D13 | Step 5 scope | **Count path only**: sign-in, reset status, dashboard, vendor lists, bulk prefetch, full order list, saves, override, day picks | That's where KMs wait. The reset fallback, recap email, history and recipients stay on `/exec`. |
| D15 | Step 6 hosting (2026-10-16) | **The web editor becomes static on GitHub Pages** and reads/writes Supabase directly | Measured on rprfo: each editor page is a `doGet` costing 1.1–3.1s of server time, and each save a `webedit_call` costing 2.6–6.2s. Supabase answers in ~0.3s. Only leaving Apps Script removes the per-page cost. Rejected: Apps Script pages with saves to Supabase (pages stay slow, and the Sheet dialogs stay a second writer). |
| D16 | Step 6 switch | **Whole catalog per store at once**, behind an `editor_direct` switch, after every tool is ported and tested on a test store | Items, vendors and the pick path are linked, so tool-by-tool would give the catalog two owners. |
| D17 | The Sheet after a store's editor switches | **Nightly copy of the catalog into MASTER_ITEMS / SETUP; the Sheet's own editing menus refuse that store** | The Sheet stays a readable backup and a rollback path. One writer per entity (§3). |
| D18 | Before step 6 | **Fix three issues the mapping found** (2026-10-16): server functions any `/exec` page can call without the PIN, `commitRemoveVendor` deleting a whole SETUP row, item saves erasing Notes | Step 6 is weeks of work; these can't wait for it. **Built 2026-10-16:**<br>- 51 functions became private (79 → 33 public, each reviewed in `tests/public_surface.test.js`).<br>- Pages and Sheet dialogs reach the server only through `webedit_call`; dialogs get a 6-hour token from their menu, and Admin Reset and Recalibrate need that Sheet token.<br>- Editor-run `test_*` and maintenance functions start with `requireEditorRun_()`.<br>- `commitLogAndReset` became private: it reset the cycle and sent the recap for any caller.<br>- Vendor removal deletes only R:AA and AF.<br>- Item saves keep Notes.<br>- Gate: `tests/editor_fixes.test.js`.<br>The bypass rests on Apps Script's documented rule (public = callable from any served page, private = invisible) plus the code; it was not reproduced live, because the browser pane couldn't open script.google.com. **Shipped 2026-10-16:** canary rprfo first. Sebastian clicked through the web editor tools, the Sheet's Manage Items dialog, Show API Status, Recalibrate Vendor Pars and `test_ping`, and all worked. Then all 10 stores + template (`--redeploy`); every store passed the API, POST and Manage Items checks. tnyt flaked right after both of the day's redeploys (a 31s POST, then a 27s 404 on GET), and both cleared on retry. Watch it: that's how `/exec` rot started at other stores (skill `mog-exec-repoint`). |
| D19 | Step 6 catalog tables (2026-10-17) | **Normalized, with the rules enforced by the database.** `mog.vendors`, `mog.areas`, `mog.items`, `mog.pick_rows`. A pick row must name a listed vendor, an existing item and an existing storage area; vendor and area names are unique ignoring case. A pick row stores neither the item's name nor the area's order; both are looked up. Renaming an area or vendor carries its rows along, and deleting an area deletes its pick rows, as the Sheet's area editor does. | The col-O drift finding and stale pick-row names become impossible, and an area rename is one update. Rejected: tables that mirror the Sheet's columns (a lossless seed, but every drift bug would move into Supabase). |
| D20 | Catalog parity gate (2026-10-17) | **PASS only when every phone screen matches**: every vendor x 7 days x override off/on, dashboard and count screens, over the cycle's counts. The seed cleans drift the tables can't hold and lists each cleanup. Drift that changes a screen gets fixed in the Sheet before that store's editor switches. Drift that changes no screen (a dead row, a padded id) is listed as information only. | Nobody's phone changes at flip time without a Sheet-side check. Rejected: passing whenever a reported cleanup explains every difference. |
| D21 | Test store for the editor port (2026-10-17) | **A Supabase-only copy** made by `mog.copy_store_catalog('rprfo', 'rprfotest')` in the SQL Editor. It has no Sheet, `editor_direct` on, `phone_direct` off, and the source's PINs. | The static editor talks only to Supabase, so it needs no Sheet; no phone or store page ever points at the copy. Rejected: a copied Google Sheet (about 30 minutes of setup and an 11th deploy target). |
| D22 | How phones get the catalog after the flip (2026-10-17) | **SQL builds today's schema-1 JSON from the tables** (`mog.catalog_from_tables`), so the phone code doesn't change (D16). The vendor list sorts with ICU's root collation, which matches JS `localeCompare`; `smoke_v4.sql` pins that order against a list computed in Node. Once a store's `editor_direct` is on, the Sheet's catalog push is refused, so the Sheet can't overwrite what Supabase owns. | One builder, in the one place every writer goes through. Rejected: sending the tables to phones and building the JSON there (it changes the snapshot shape mid-rollout, which old app versions can't read). |
| D23 | Removing a storage area or a vendor (2026-10-17) | **Items never disappear; they only lose the area or the vendor.** Removing an area drops its pick rows (v4 already does this). Removing a vendor drops its pick rows, takes it off every item's eligible list, and sets the primary vendor of items it supplied to none. To do in schema v5: change `items_slug_primary_vendor_fkey` to `on delete set null`; v4 refuses the delete instead. Items left with no vendor or area show up in Manage Items as Unassigned. | Sebastian: as long as removing a storage area or a vendor only takes it away from the items, nothing is lost, because the item list already shows which items have no area or aren't on the pick path. |
| D14 | Phone freshness | **One snapshot shared for ~3s, refreshed per screen** (open a vendor, pull down, Today, reopen); the catalog is skipped when unchanged | Other phones' counts show up at those moments, as today. Rejected: Supabase Realtime (a library, a websocket, and table policies for tables that are private by design). |

Rejected: stopping column-E writes but staying on `/exec` (still ~2s per screen); moving everything including the editor now (months, and the editor isn't the complaint); Firebase (workable, but not SQL).

## 3. Who owns what

**One writer per kind of data.** Nothing syncs both ways, so copies can't drift into disagreement.

| Data | Owner (the only writer) | Copies |
|---|---|---|
| Items, pars, use-multiplier, pack, primary/eligible vendors | Sheet (web editor) | `mog.catalog` (pushed) |
| Pick path / storage areas (SETUP K:P) | Sheet | `mog.catalog` |
| Vendors, day multipliers (S:Y), cutoffs (AA) | Sheet | `mog.catalog` |
| Store PIN + master PIN | Script Properties | `mog.stores` (bcrypt hashes, pushed) |
| **On-hand counts** | **Supabase `mog.counts`** | none: never copied back (D9) |
| **Store-wide Emergency Override** (was ORDER_ENTRY!AD2) | **Supabase `mog.store_state`** | none |
| **Per-vendor day picks** (was SETUP!AF) | **Supabase `mog.store_state`** | none |
| **Cycle date** (was ORDER_ENTRY!AE9) | **Supabase `mog.store_state`** on a switched store (the Sheet's AE9 is no longer updated there) | none |
| **Order log** | **Supabase `mog.order_log`** | Sheet `LOG_ORDERS`, appended nightly as a backup (D10) |
| Recap email | Apps Script (MailApp), built from `mog.order_log` | — |
| Recap recipients | Sheet SETUP AB:AE, read once per close (moves in step 6) | — |
| **Catalog tables** (`mog.vendors`, `mog.areas`, `mog.items`, `mog.pick_rows`, schema v4) | The Sheet, until the store's `editor_direct` flips (D16); Supabase after | Before the flip: an inert copy, written only by `test_catalogTablesParity`'s seed and read by nothing a phone uses. After: `mog.catalog` is built from them (D22). |

## 4. How a day works after the switch

1. **Open the app:** one `mog_snapshot` call returns the catalog, store state and this cycle's counts. The phone builds the dashboard and every vendor list locally.
2. **Count:** each save is one `mog_save_counts` call, per item, tagged with the cycle date. Two phones counting different items no longer overwrite each other. (Today's `saveOnHand` rewrites a block of rows, MOGApi.gs:963–969.)
3. **Override / day pick:** one call each (`mog_set_override`, `mog_set_vendor_pick`).
4. **Close the cycle (the nightly timer at 3:30 AM, or the PWA's fallback if that failed):**
   - Apps Script fetches the snapshot (`mog_sync_get_snapshot`) and runs `vendorItemsFromSnapshot_` for every vendor.
   - It keeps the items with a suggested quantity. That **is** the order log, by the same rule `buildOrderCycleSnapshot_` uses.
   - One call, `mog_sync_close_cycle`, writes those rows to `mog.order_log` and starts the new cycle (override off, picks cleared) in the same transaction. A second close of the same cycle is refused, so nothing is logged twice.
   - Then the recap email is scheduled, built from `mog.order_log`, and the rows are appended to the Sheet's `LOG_ORDERS` as a backup (D10).

**On a switched store, every reset path goes to that same close:** the PWA's `/exec commitReset`, the Sheet's open trigger and the dashboard checkbox all call `closeCycleInDb_`. Stores not yet switched keep the Sheet reset unchanged.

**`/exec` keeps working for a switched store, off Supabase.** Phones still on the old app call `/exec`. For a switched store, the count-path actions read and write Supabase through the same `OrderMath.gs` builders, never the Sheet: reset status, reset, dashboard, vendor items, saves, overrides and recap. So a store's backend can switch before its PWA does, and old phones see the same counts as new ones.

**Step 5, phones direct** (when Supabase has `phone_direct` on for the store): the PWA's `api()` answers the count-path actions itself, from one snapshot and the `OrderMath.gs` builders. It calls the same "answers from a snapshot" functions DbApi.gs uses, so the shapes and error messages are identical. It signs in with `mog_login` (a 12-hour token, kept in memory), shares one snapshot across reads for ~3s, and saves with `mog_save_counts` tagged with the cycle date. A queued save keeps its own cycle date. Sign-in tries Supabase first; `USE_EXEC`, an unknown store, or Supabase unreachable sends that session to `/exec`. `USE_EXEC` mid-session moves the next call to `/exec`. Settings shows "Server: Supabase · N ms (median M)".

**A phone that saves after the reset** has the old cycle date. Its counts land under that date, the phone gets `stale: true` back, and the new cycle stays clean. That's the late-drain bug from 07-12, fixed by construction.

## 5. Order math: one file, two places

**Built 2026-10-15; not deployed yet.** `apps-script/OrderMath.gs` holds pure functions with no Apps Script calls:

- `computeSuggestedQty_` and `vendorDayMultiplier_`, moved byte-for-byte out of MOGApi.gs.
- `buildVendorItemsPayload_`, `buildDashboardPayload_`, `rosterOnHandSnapshot_`, `buildPickInfo_`, extracted from `api_getVendorItems_`, `api_getDashboard_compute_` and `vendorOnHandSnapshot_` (now deleted). They return the **exact payload shapes the PWA already consumes**, so the rest of the PWA doesn't change.
- The phone side: `orderInputsFromSnapshot_` (snapshot JSON → the same Maps the server readers return), `rosterFromPickRows_`, `vendorItemsFromSnapshot_`, `dashboardFromSnapshot_`.

The server's `api_getVendorItems_` / `api_getDashboard_compute_` now only read the Sheet (the vendor tab through `readVendorTabRoster_`) and call the shared builders. The PWA will call the same builders with snapshot data. In step 5, `build.py` copies the file into the PWA at a marker, the same pattern as `STORE_REGISTRY`.

**Proof (`node tests/run_all.js`, see `tests/README.md`):**
- *Equivalence:* old (`c0b6dfb`) vs new produce identical output, order, errors and cells read on 400 randomized stores. That's 1,923 vendor lookups (with and without the shared context) and 400 dashboards. Every listed edge case was generated, and all 5 planted defects were caught.
- *Phone parity:* the phone's path reproduces the server through `Sync.gs`'s own parity report on 300 stores (872 vendors), and 5 planted defects were caught.
- *Purity:* `OrderMath.gs` runs bare, names no Apps Script service, and holds only functions.

**Parity test (the gate before any store switches):** `test_supabaseParity()` in `Sync.gs`, run from the Apps Script editor. It builds the catalog exactly as the sync will push it, sends it through a JSON round trip, runs the phone's path, and compares the result against `api_getVendorItems_` / `api_getDashboard_compute_` for every vendor. Any difference blocks the switch. This replaces reading the vendor tab's column-M formula: the Drive connector only returns sample values, and a behavior comparison is the stronger check anyway, because it catches any extra filter the formula has.

It can only compare vendors **delivering that day**. A non-delivering vendor's list is blank on both sides, so run it on a few different days (or with Emergency Override on) before trusting it for every vendor.

Roster rule the parity test confirms: column M = the pick-path rows whose SETUP K matches the tab vendor. The match ignores case, as Google Sheets' `=` does, and is empty when the day multiplier is 0 (07-06 formula verify; MOGApi.gs comment).

## 6. Catalog payload (schema 1)

Built by `buildCatalogPayload_()` (Sync.gs). It ships the server's own reader output, not a reshaped copy, so the phone rebuilds exactly the Maps the server uses:

```json
{
  "schema": 1,
  "timeZone": "America/New_York",
  "location": "Roll Play Rosslyn FOH",
  "abbr": "RPRFO",
  "concept": "roll-play",
  "vendorList": ["Amazon", "Elpis", "Webstaurant"],
  "vendorMults": { "Amazon": {"Mon":1,"Tue":0,"Wed":0,"Thu":0,"Fri":0,"Sat":0,"Sun":0} },
  "cutoffs": { "Amazon": "10:00", "Elpis": null },
  "items": {
    "ITEM-0059": { "useMult": true, "par": 3, "name": "Clear Scotch Tape", "pack": "PACK (3)",
                   "primaryVendor": "Amazon", "active": true }
  },
  "pickRows": [ ["Amazon", "ITEM-0059", "Clear Scotch Tape", "Back Storage", 10, 10] ],
  "itemCounts":   { "Amazon": 2 },
  "backupCounts": { "Webstaurant": 1 }
}
```

- `timeZone`: `getSpreadsheetTimeZone()`. The database uses it to work out "today" (and whether the cycle is stale) the same way the Sheet's `=TODAY()` does.
- `vendorList`: `getVendorList_compute_()`, the fresh read. A push runs right after an edit, and the cached list could hold the pre-edit list (the commitAddVendor trap, audit 07-29).
- `vendorMults`: `readVendorMultipliers_` verbatim.
- `cutoffs`: resolved for each listed vendor exactly as the count screen and dashboard resolve them (SETUP AA, then `VENDOR_META`, then null).
- `items`: `readMasterItemMeta_()` verbatim, except a non-numeric par travels as `null` and goes back to `NaN` on the phone. JSON has no `NaN`, and `0` would change the math.
- `pickRows`: `readPickDb_` rows (all 6 columns), with any typed **Date** converted to what the server's readers see: `String(date)` in the text columns, its time value in the two order columns. Without that, a date in an order cell would sort differently on the phone (a phone-parity control proves it).
- `itemCounts` / `backupCounts`: `countActiveItemsByVendor_` / `countBackupItemsByVendor_`, computed server-side so the phone never re-derives them.

## 7. Database API

Tables live in the private schema `mog`, which the Data API doesn't expose. **The public key can't touch any table.** Access goes only through these functions:

| Function | Caller | Credential |
|---|---|---|
| `mog_login(slug, pin)` → session token (12h) | PWA | store or master PIN; 5 tries then a 5-minute lockout per store, same as `checkPin_` |
| `mog_snapshot(token, haveCatalogVersion)` | PWA | token; skips the catalog if the phone's copy is current |
| `mog_save_counts(token, cycleDate, vendor, items)` | PWA | token |
| `mog_set_override(token, on)` | PWA | token; turning off clears the day picks (children of the flag) |
| `mog_set_vendor_pick(token, vendor, mult 0–7)` | PWA | token; 0 clears |
| (all five above, schema v3) | PWA | answer `USE_EXEC` while the store's `phone_direct` is off; `mog_login` checks it before the PIN, so a store whose phones aren't direct never touches its lockout counter |
| `mog_sync_set_phone_direct(slug, key, on)` | Apps Script (Switch back to the Sheet turns it off) | sync key |
| `mog_sync_push_catalog(slug, key, version, payload)` | Apps Script | store's sync key; an older push never overwrites a newer one |
| `mog_sync_set_pins(slug, key, pin, masterPin)` | Apps Script | sync key; a real PIN change signs out every phone for that store |
| `mog_sync_get_cycle(slug, key)` | Apps Script (connect / cutover checks) | sync key |
| `mog_sync_get_snapshot(slug, key)` | Apps Script (cycle close, `/exec` on switched stores) | sync key |
| `mog_sync_close_cycle(slug, key, closing, newCycle, newDow, rows, todaysLog)` | Apps Script | sync key; one transaction, and a second close of the same cycle is refused |
| `mog_sync_get_log(slug, key, date)` | Apps Script (recap email) | sync key |
| `mog_sync_set_override` / `mog_sync_set_vendor_pick` | Apps Script (`/exec` on switched stores) | sync key; same rules as the PWA versions (shared internally) |
| `mog_sync_put_counts(slug, key, cycleDate, rows)` | Apps Script (cutover import, `/exec` saves on switched stores) | sync key; a null cycle date means the current cycle |
| `mog_sync_set_state(slug, key, …)` | Apps Script (after reset, cutover) | sync key |
| `mog_sync_seed_catalog(slug, key, tables)` (schema v4) | Apps Script (`test_catalogTablesParity`) | sync key; replaces the catalog tables in one transaction and returns the JSON built from them. Bad data rejects the whole seed (`SEED_REJECTED: …`) and keeps the old tables; refused once `editor_direct` is on |
| `mog_sync_get_status(slug, key)` (schema v4) | Apps Script (Store Health Check) | sync key; `phoneDirect`, `editorDirect`, `hasCycle`, `tablesSeeded`, and the stored catalog |
| `mog_sync_push_catalog` (replaced in schema v4, same signature) | Apps Script | refused (`EDITOR_DIRECT`) once the store's `editor_direct` is on |
| `mog.catalog_from_tables(slug)` (schema v4) | internal | builds the schema-1 catalog JSON from the tables (D22) |
| `mog.copy_store_catalog(from, to)` (schema v4) | SQL Editor only | copies a seeded catalog to a test store (D21); refuses to overwrite a store that isn't a test store |
| `mog.provision_store(slug)` → sync key | SQL Editor only | not exposed to the API at all |
| `mog_editor_login(slug, pin)` (schema v6) | the editor page | store or master PIN, the same lockout counter as `mog_login`; answers `EDITOR_NOT_DIRECT` before the PIN while the store's editor is in the Sheet |
| `mog_editor_get(token)` (schema v6) | the editor page | any session token for the store (the phones' too); the catalog tables, the last 100 changes, the catalog version |
| `mog_editor_apply(token, label, by, ops)` (schema v6) | the editor page | token; writes only if every row is still what the editor read (else `CONFLICT`, nothing written), logs the change, rebuilds `mog.catalog` |
| `mog_editor_undo(token, changeId, by)` (schema v6) | the editor page | token; a change replayed backwards as a new change; `CONFLICT` names the later change to undo first |

**Per-store sync keys instead of the service-role key:** a bound script's Script Properties can be read by anyone who can edit that store's Sheet. A leaked sync key reaches only that one store; the service-role key would expose every store. The service-role key is never used outside the Supabase dashboard.

Session tokens and sync keys are stored as SHA-256 hashes, and PINs as bcrypt. Raw tokens only exist on the phone.

## 8. Rollout (one store at a time)

Each step ships separately. KMs notice nothing until step 5 switches a store.

1. ~~Speed test~~ (done 2026-10-15).
2. Run `supabase/schema.sql` (Sebastian), which also drops the `speedtest` table, then `supabase/tests/smoke.sql`; every row should say PASS. The smoke test checks the logic. Locking the public key out is checked separately over the API.
3. `OrderMath.gs`: move the two functions plus extract the builders, and refactor `api_getVendorItems_` / `api_getDashboard_compute_` to use them. `Sync.gs` gets the catalog builder and `test_supabaseParity()`, both read-only. **Done 2026-10-15:** gated by `node tests/run_all.js`, canaried on rprfo (live parity PASS), then deployed to all 10 stores + template.
4. **Step 4, server side (inactive until a store connects):**
   - Schema v2: `mog.order_log`, the cycle close, and sync versions of the override calls.
   - `Sync.gs` network half:
     - the catalog push after each web-editor save, fired by the editor as a separate background request so saves don't slow down (`webedit_call`, Editor.gs:357, flags which calls changed something)
     - a background push after Sheet-dialog edits, and the PIN push
     - the nightly timer and the cycle close
     - one menu item, **Move this store to Supabase** (connect + switch; it replaced separate Connect and Switch items on 2026-10-16)
   - `/exec` count-path handlers on Supabase for switched stores.

   **Moving a store** (code deployed with `deploy.py --redeploy`):
   1. Once for every store: run `supabase/provision_stores.sql` in the SQL Editor. It lists each store, its Sheet, and its **connect code** (`store:key`). A code goes into its own Sheet's prompt, never into a chat. Running the file again skips stores that already connected, so it never replaces a working key.
   2. In each Sheet: **📱 Mobile API → Move this store to Supabase**, paste the code, check the confirmation ("This Sheet: … / Code is for store: …"), then click Yes. It connects, pushes PINs and the catalog, copies the cycle and counts, installs the 3:30 AM run, switches, and (since 2026-10-17) turns the store's phones direct. If it stops part-way, run it again; it won't ask for the code a second time.
   3. Permission: Google's consent screen lets a person untick "Connect to an external service". A Sheet menu can't re-ask for it, and the editor only re-asks when a script requests it by name. When it's missing, Move shows Google's consent link instead. If that link doesn't work, run **`authorizeSupabase`** in `Sync.gs` from the editor (it calls `ScriptApp.requireScopes`). Every store is its own script project, so each one checks separately.

   rprfo moved on 2026-10-16 with the earlier two-item flow, which taught the permission step.
5. **Step 5:** the PWA reads and writes Supabase directly when the store's `phone_direct` is on (D12-D14). This is when KMs feel the speedup.
   - Built 2026-10-16: `supabase/schema_v3.sql` (+ `smoke_v3.sql`); the shared answers in `OrderMath.gs`, which `DbApi.gs` now calls too; the DIRECT CLIENT block and `api()` routing in `template/index.html`; `build.py` injects `OrderMath.gs` and the Supabase config (URL + publishable key read from `Sync.gs`, plus the slug). Gate: `tests/pwa_direct.test.js`.
   - Measured from a browser on Sebastian's PC (a `mog_login` for an unknown store, so nothing is touched): 1.12s for the first call (TLS + the CORS pre-check, which Supabase lets browsers cache for an hour), then 0.30–0.34s.
   - **Canary:** after the store has moved and its first close checked out, `update mog.stores set phone_direct = true where slug = 'rprfo';` in the SQL Editor. **Gate before any other store:** Settings on a KM phone at rprfo shows a vendor open or a save under 1s. Over that, stop and revisit.
   - **Order that matters:** the database switch ships before the app that relies on it. Schema v1's `mog_login` had no `phone_direct` check, so app v0.18 going out before schema v3 would have sent rprfo's phones direct with no switch.
   - Rollback for the phones alone: `update mog.stores set phone_direct = false where slug = '<slug>';` (takes effect on each phone's next call).
6. **Step 6:** the web editor reads and writes the catalog in Supabase, and recipients and order history move too. The Sheet then holds only the script and the nightly backup (D9's end state).
   1. **Catalog tables + parity gate** (built 2026-10-17, D19-D22). Schema v4 adds the tables, `mog.catalog_from_tables`, the seed, the status call, `editor_direct` (off) and `mog.copy_store_catalog`. `buildCatalogTables_` (Sync.gs) turns the Sheet into tables and lists every cleanup; `catalogParityReport_` compares every phone screen. **Order:** Sebastian runs `schema_v4.sql`, then `smoke_v4.sql` (every row PASS) and `check_api.sh`. Then `deploy.py --redeploy`, canary rprfo, then the rest. Then `test_catalogTablesParity` on each store until it says PASS, fixing in the Sheet whatever its cleanup list names.
   2. **Test store:** `select mog.copy_store_catalog('rprfo', 'rprfotest');` once rprfo passes.
   3. **Manage Items port** against `rprfotest` (built 2026-10-18, one-app spec E1-E4): schema v6 adds the editor's sign-in, read, write and Undo, plus the change log; `template/editor/catalogEdit.js` runs Manage Items' logic over the tables, and `host.js` runs the unchanged `ManageItems.html` as a static page (`build.py --preview rprfotest --like rprfo`). Target: page open and save each under 1s.
   4. Then Vendors, Areas, Shelf to Sheet, History, Health and Recipients, the flip procedure (D16, D17), and rprfo first.

**Cutover:** **Move this store to Supabase** imports the current column-E counts and override settings once, then `/exec` serves that store from Supabase. Do it right after a reset, when column E is empty, and there's nothing to import.

**Rollback (per store, emergency only):** **Switch back to the Sheet** copies the current cycle's counts, override settings and cycle date into the Sheet once, then clears `MOG_BACKEND`; `/exec` serves from the Sheet again. It's the only path that writes counts to the Sheet.

## 9. Open items

- **VERIFY:** nobody reads the raw Sheet's vendor tabs or HOME dashboard during the day (they'll show blank counts).
- **VERIFY:** no store counts after ~3:30 AM (nightly reset time).
- **VERIFY (parity test):** the roster rule in §5.
- ~~VERIFY (measure): how long a catalog push takes~~: 1.1–1.4s warm, 2.35s cold, off the save path (§1, 2026-10-16).
- History views on `/exec` read the Sheet's `LOG_ORDERS` backup until step 5/6 moves them to `mog.order_log`. Recipients stay on `/exec` until step 6.
- **Intended differences** after a store switches (recorded so nobody "fixes" them back):
  - **A duplicated pick-path row** (same vendor + item twice) shares one count in Supabase. The Sheet kept a separate On Hand per row, and the app could only ever write the last row.
  - **Counts stay with their item, not their row.** If a vendor's list changes mid-cycle, the Sheet's column E stayed put by position and could land on a different item; Supabase keys counts by item.
  - **`/exec saveOnHand` on a switched store** takes the vendor name as sent, without a lookup; the app always sends the dashboard's exact name. It saves into Supabase's current cycle, so an old-app phone that queued counts offline overnight could add them to the new day. The new PWA (step 5) sends its cycle date and can't.
- **Proof for step 4** (`node tests/run_all.js`): `supabase_step4` drives the same 150 randomized stores through the real `doPost` on the Sheet and on a fake Supabase. Answers are identical before and after every write. The close logs what `buildOrderCycleSnapshot_` would and touches only `LOG_ORDERS`. 9 planted defects are all caught. `supabase_move` drives Move this store to Supabase through a scripted fake menu: nothing changes before the code checks out and Yes, a move matches that seed path, and failures and rollbacks resume. 9 more planted defects are all caught.
- ~~Health Check: add "catalog in sync" and "nightly timer installed"~~: built 2026-10-17 (Health.gs section 9): moved, nightly 3:30 AM run (+ `install_nightly` fix), phones direct, catalog in sync (+ `push_catalog` fix). It compares the Sheet's payload with the stored one, which is stronger than a hash. Triggers belong to a Google account, so run it from the web editor (it runs as the store's owner).
- **Parity run, 2026-10-17:** rprfo, rpr and the four Teas'n You stores PASS. The four unused Tysons/Founders stores (rpt, rptfo, rpfr, rpfrf) FAILED on drift their copied Sheets carry: pick rows in storage areas missing from the list, plus 8 repeated Item IDs at rpfr. Two new Store Health Check rows find and fix both, with a one-click Fix each: "Storage areas on pick rows" (`restore_areas`, which adds the areas to the end of the list) and "Repeated Item IDs" (`fix_repeated_ids`, confirmed first). For a repeated ID, the row phones read keeps it; an extra copy of the same item is deleted, and a different item gets a new ID. That repeat also exposed a Sheet-era bug: Manage Items edits the first row with an ID while phones read the last. The tables make it impossible (the Item ID is the primary key). rpfr ran both fixes (`c5018ba`, canary) and now PASSES; rpt, rptfo and rpfrf need the code deployed, then the storage-areas Fix.
- ~~Move this store to Supabase should turn `phone_direct` on~~: done 2026-10-17. It turns phones direct last, once the store has switched. If that call fails, the move stands and the message says to run `supabase/phones_direct.sql`. Re-running Move on a store that already moved does NOT turn phones back on, so a deliberate phones-only rollback stays rolled back.
