# MOG → Supabase migration (count path)

**Status (2026-10-15):** schema live and verified (smoke test 40/40, public-key check 10/10). Step 3 (the shared `OrderMath.gs` + `Sync.gs`) is built and passes `node tests/run_all.js`; not deployed. KMs see no change yet.
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
| D8 | Sheet during the day | Vendor tabs' On Hand stays blank until night | Least load. Counts are copied into column E only when a reset (or a manual recap send) needs them. |

Rejected: stopping column-E writes but staying on `/exec` (still ~2s per screen); moving everything including the editor now (months, and the editor isn't the complaint); Firebase (workable, but not SQL).

## 3. Who owns what

**One writer per kind of data.** Nothing syncs both ways, so copies can't drift into disagreement.

| Data | Owner (the only writer) | Copies |
|---|---|---|
| Items, pars, use-multiplier, pack, primary/eligible vendors | Sheet (web editor) | `mog.catalog` (pushed) |
| Pick path / storage areas (SETUP K:P) | Sheet | `mog.catalog` |
| Vendors, day multipliers (S:Y), cutoffs (AA) | Sheet | `mog.catalog` |
| Store PIN + master PIN | Script Properties | `mog.stores` (bcrypt hashes, pushed) |
| **On-hand counts** | **Supabase `mog.counts`** | Vendor tab column E, written only at reset |
| **Store-wide Emergency Override** (was ORDER_ENTRY!AD2) | **Supabase `mog.store_state`** | AD2, written only at reset |
| **Per-vendor day picks** (was SETUP!AF) | **Supabase `mog.store_state`** | AF, written only at reset |
| Cycle date (was ORDER_ENTRY!AE9) | Sheet; reset writes it, then copies it to `mog.store_state` | — |
| Order log, recap email, recipients | Sheet / Apps Script (unchanged) | — |

## 4. How a day works after the switch

1. **Open the app:** one `mog_snapshot` call returns the catalog, store state and this cycle's counts. The phone builds the dashboard and every vendor list locally.
2. **Count:** each save is one `mog_save_counts` call, per item, tagged with the cycle date. Two phones counting different items no longer overwrite each other. (Today's `saveOnHand` rewrites a block of rows, MOGApi.gs:963–969.)
3. **Override / day pick:** one call each (`mog_set_override`, `mog_set_vendor_pick`).
4. **Reset (nightly timer, or any old path):** `commitLogAndReset` (ResetLog.gs) first copies the database's counts and override settings back into the Sheet (`hydrateCountsFromDb_`). Then it runs **unchanged**: log, recap email, clear. Finally it tells the database the new cycle date, which clears overrides and starts fresh counts.

Every reset path goes through `commitLogAndReset`: the PWA (MOGApi.gs:344), opening the Sheet (Core.gs:614) and the dashboard checkbox (Core.gs:714 → ResetLog.gs:350). Putting the copy-back there covers all of them.

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
| `mog_sync_get_cycle(slug, key)` | Apps Script (copy-back) | sync key |
| `mog_sync_put_counts(slug, key, cycleDate, rows)` | Apps Script (cutover import, old-phone mirror) | sync key |
| `mog_sync_set_state(slug, key, …)` | Apps Script (after reset, cutover) | sync key |
| `mog.provision_store(slug)` → sync key | SQL Editor only | not exposed to the API at all |

**Per-store sync keys instead of the service-role key:** a bound script's Script Properties can be read by anyone who can edit that store's Sheet. A leaked sync key reaches only that one store; the service-role key would expose every store. The service-role key is never used outside the Supabase dashboard.

Session tokens and sync keys are stored as SHA-256 hashes, and PINs as bcrypt. Raw tokens only exist on the phone.

## 8. Rollout (one store at a time)

Each step ships separately. KMs notice nothing until step 5 switches a store.

1. ~~Speed test~~ (done 2026-10-15).
2. Run `supabase/schema.sql` (Sebastian), which also drops the `speedtest` table, then `supabase/tests/smoke.sql`; every row should say PASS. The smoke test checks the logic. Locking the public key out is checked separately over the API.
3. `OrderMath.gs`: move the two functions plus extract the builders, and refactor `api_getVendorItems_` / `api_getDashboard_compute_` to use them. `Sync.gs` gets the catalog builder and `test_supabaseParity()`, both read-only. **Built and gated 2026-10-15 (`node tests/run_all.js`).** Deploy with `--redeploy`, then run `test_supabaseParity` on a store to check the roster rule live.
4. `Sync.gs` network half: push on save (hooked after `webedit_call` dispatches, Editor.gs:357, since every web-editor action runs through it), PIN push, `setupSupabase()` (Admin.gs), plus the copy-back in `commitLogAndReset`. Inactive until a store's Script Property `MOG_BACKEND` = `supabase`.
5. PWA Supabase path behind `stores.json` `backend`. Canary rprfo: provision → `setupSupabase()` → parity test → nightly timer → flip after a reset, before counting starts → smoke test → next store.

**Cutover timing:** switch a store right after its reset, when column E is empty, so nothing needs importing. Phones still running the old PWA keep calling `/exec saveOnHand` until they auto-update. For switched stores, that call mirrors into the database (`mog_sync_put_counts`) so no count gets lost.

**Rollback (per store):** set `backend` back to `exec` in `stores.json`, run `hydrateCountsFromDb_()` once (today's counts go back into column E), and clear `MOG_BACKEND`. Build the copy-back first; it's both the nightly path and the rollback.

## 9. Open items

- **VERIFY:** nobody reads the raw Sheet's vendor tabs or HOME dashboard during the day (they'll show blank counts).
- **VERIFY:** no store counts after ~3:30 AM (nightly reset time).
- **VERIFY (parity test):** the roster rule in §5.
- `getRecapData` / manual `emailRecap` read column E: run the copy-back first, or build locally (the PWA already has `buildRecapLocally_`). Decide in step 5.
- History views and recipients stay on `/exec` (rare, not on the counting path).
- Health Check: add "catalog in sync" (Sheet hash vs pushed version) and "nightly timer installed".
