# MOG → Supabase migration (count path)

**Status (2026-10-15):** schema live and verified (smoke test 40/40, public-key check 10/10). Step 3 (the shared `OrderMath.gs` + `Sync.gs`) is **deployed to all 10 stores + template** (`6584c10`, `--redeploy`). It passed the live `test_supabaseParity` on rprfo (2 delivering vendors, 25 items, plus the dashboard), and every store's health and POST probes pass. KMs see no change; the next step is step 4.
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
| D11 | Nightly timer rollout | Installed per store by Connect to Supabase | Each store's reset timing changes along with its migration, rprfo first. |

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
| `mog_sync_push_catalog(slug, key, version, payload)` | Apps Script | store's sync key; an older push never overwrites a newer one |
| `mog_sync_set_pins(slug, key, pin, masterPin)` | Apps Script | sync key; a real PIN change signs out every phone for that store |
| `mog_sync_get_cycle(slug, key)` | Apps Script (connect / cutover checks) | sync key |
| `mog_sync_get_snapshot(slug, key)` | Apps Script (cycle close, `/exec` on switched stores) | sync key |
| `mog_sync_close_cycle(slug, key, closing, newCycle, newDow, rows, todaysLog)` | Apps Script | sync key; one transaction, and a second close of the same cycle is refused |
| `mog_sync_get_log(slug, key, date)` | Apps Script (recap email) | sync key |
| `mog_sync_set_override` / `mog_sync_set_vendor_pick` | Apps Script (`/exec` on switched stores) | sync key; same rules as the PWA versions (shared internally) |
| `mog_sync_put_counts(slug, key, cycleDate, rows)` | Apps Script (cutover import, `/exec` saves on switched stores) | sync key; a null cycle date means the current cycle |
| `mog_sync_set_state(slug, key, …)` | Apps Script (after reset, cutover) | sync key |
| `mog.provision_store(slug)` → sync key | SQL Editor only | not exposed to the API at all |

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
     - the **Connect to Supabase** and **Switch counting to Supabase** menu items
   - `/exec` count-path handlers on Supabase for switched stores.
5. **Step 5:** the PWA reads and writes Supabase directly, behind `stores.json` `backend`, rprfo first. This is when KMs feel the speedup.
6. **Step 6:** the web editor reads and writes the catalog in Supabase, and recipients and order history move too. The Sheet then holds only the script and the nightly backup (D9's end state).

**Cutover:** **Switch counting to Supabase** imports the current column-E counts and override settings once, then `/exec` serves that store from Supabase. Do it right after a reset, when column E is empty, and there's nothing to import.

**Rollback (per store, emergency only):** **Switch back to the Sheet** copies the current cycle's counts, override settings and cycle date into the Sheet once, then clears `MOG_BACKEND`; `/exec` serves from the Sheet again. It's the only path that writes counts to the Sheet.

## 9. Open items

- **VERIFY:** nobody reads the raw Sheet's vendor tabs or HOME dashboard during the day (they'll show blank counts).
- **VERIFY:** no store counts after ~3:30 AM (nightly reset time).
- **VERIFY (parity test):** the roster rule in §5.
- **VERIFY (measure):** how long a catalog push takes (`test_supabasePushTiming` on rprfo). It runs in the background either way, but a slow one delays phones seeing an edit.
- History views on `/exec` read the Sheet's `LOG_ORDERS` backup until step 5/6 moves them to `mog.order_log`. Recipients stay on `/exec` until step 6.
- **Intended differences** after a store switches (recorded so nobody "fixes" them back):
  - **A duplicated pick-path row** (same vendor + item twice) shares one count in Supabase. The Sheet kept a separate On Hand per row, and the app could only ever write the last row.
  - **Counts stay with their item, not their row.** If a vendor's list changes mid-cycle, the Sheet's column E stayed put by position and could land on a different item; Supabase keys counts by item.
  - **`/exec saveOnHand` on a switched store** takes the vendor name as sent, without a lookup; the app always sends the dashboard's exact name. It saves into Supabase's current cycle, so an old-app phone that queued counts offline overnight could add them to the new day. The new PWA (step 5) sends its cycle date and can't.
- **Proof for step 4** (`node tests/run_all.js`): `supabase_step4` drives the same 150 randomized stores through the real `doPost` on the Sheet and on a fake Supabase. Answers are identical before and after every write. The close logs what `buildOrderCycleSnapshot_` would and touches only `LOG_ORDERS`. 9 planted defects are all caught.
- Health Check: add "catalog in sync" (Sheet hash vs pushed version) and "nightly timer installed".
