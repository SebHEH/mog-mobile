# Session Handoff — Catalog tables, Copy order, the one-app spec and live counting

**Session date:** 2026-10-17 → 2026-10-18 (one chat)
**Session focus:** start step 6 (the editor on Supabase): schema v4 and a catalog parity gate, then port Manage Items.
**Outcome:**
- **Step 6 part 1 is live.** The catalog tables are in Supabase, and the parity check passes on 7 of 10 stores (the other 3 are unused and need one click each).
- **Copy order for email** ships on every store, with each store's delivery address.
- Mid-session, Sebastian asked to make the ordering app and the editor **one app**. The spec is agreed (`docs/MOG_OneApp_Spec.md`), and **Phase 1 (live counting) is built and live on rprfo only**, waiting for his two-device test.

**Next session focus:** read Sebastian's rprfo live-counting test results, fix what he finds, roll Phase 1 out to every store, then start Phase 2 (the editor foundation).

---

## Section A — Step 6 part 1: catalog tables + parity gate (D19-D23)

- **schema v4** (`ffe9bf7`; Sebastian ran it, smoke_v4 45/45, check_api 23/23):
  - tables `mog.vendors`, `mog.areas`, `mog.items` and `mog.pick_rows`, normalized with database rules. A pick row must name a listed vendor, an existing item and an existing area; names are unique ignoring case; a pick row stores neither the item name nor the area order.
  - `mog.catalog_from_tables` builds today's schema-1 JSON, sorting the vendor list with ICU collation exactly like JS `localeCompare`. smoke_v4 pins that order.
  - `mog_sync_seed_catalog`, `mog_sync_get_status`, and an `editor_direct` switch (off everywhere). A Sheet push is refused once a store's switch is on.
  - `mog.copy_store_catalog`, run in the SQL Editor only: the Sheet-less test store **`rprfotest` exists** (6 vendors, 5 areas, 69 items, 52 pick rows).
- **`test_catalogTablesParity`** (Sync.gs) seeds the tables from the Sheet and compares every phone screen (every vendor × 7 days × override off/on). Policy D20: PASS only when the screens are identical, and drift gets fixed in the Sheet first.
  - **Results:** PASS on rprfo, rpr, rpfr and all four Teas'n You stores. rpt, rptfo and rpfrf fail only because pick rows sit in storage areas missing from their list ("Expo" at the FOH pair; "Hallway Fridge", "Bread/Noodle Shelf" and "Pho Line 1" at rpt).
  - Those are the **unused** copied Sheets (memory `project_unused_stores`).
- **Two Store Health Check repairs** (`c5018ba`):
  - "Storage areas on pick rows" (`restore_areas`): adds the missing areas at the end of the list.
  - "Repeated Item IDs" (`fix_repeated_ids`, confirmed first): the row phones read keeps the ID; an extra copy of the same item is deleted; a different item sharing the ID gets a new one.

  rpfr ran both and passes. The repeat also exposed a Sheet-era bug: Manage Items edits the **first** row with an ID while phones read the **last**.
- **Fold-ins:** Move this store to Supabase now turns `phone_direct` on itself, last. The Health Check gained 4 Supabase rows: moved, nightly run (+ fix), phones direct, catalog in sync (+ fix).
- **D23:** removing a storage area or a vendor never deletes items. For vendors this needs `items_slug_primary_vendor_fkey` → `on delete set null` (v4 refuses the delete instead), which belongs in the editor's schema.

## Section B — Copy order for email (all stores, v0.18.3)

- The review screen has an outline **Copy order for email** button. It copies an email-ready table: "<Vendor> order", **"Delivery Monday, Oct 19"** (the order day + 1), "Deliver to <store> - <address>" (BOH/FOH stripped), then Item | Order ("2 × CASE (3)"). The copy is rich HTML with a plain-text fallback, in the store's theme colours.
- `buildOrderEmail_` also returns a **subject**, ready for a future one-click "email this vendor" button. That button needs vendor email addresses, which belong with the vendor data in Supabase.
- Every store's address is in `stores.json` under a new optional `address` field. `build.py` injects it through a **sixth placeholder**, `/*__MOG_STORE__*/null` (CLAUDE.md invariant #5 updated).
- Gate: `tests/order_copy.test.js`, 8 planted defects.

## Section C — The one-app spec (decided, not yet built)

`docs/MOG_OneApp_Spec.md` holds everything; read it before touching the app or the editor.
- **A1-A7:**
  - One app at each store's address, with the Editor only on computers.
  - Phone quick edits: adjust par (just today, or from now on) and add an item to this vendor's list (today only). Both confirm, are logged, and leave a review flag in Manage Items.
  - The same PIN, plus a change log and Undo.
  - The desktop ordering layout comes after the editor.
  - Names come from the store's list.
  - Two people on one vendor get a warning, not a lock.
  - Live counting goes first.
- **Phases:** 1 live counting → 2 editor foundation (re-host `ManageItems.html` as a computer-only section of the app, plus the change log and Undo) → 3 phone quick edits through `OrderMath.gs` → 4 the remaining tools and switching each store → 5 desktop layout.

## Section D — Phase 1: live counting (rprfo only, v0.19.0)

- **schema v5** (`14c6a44`; Sebastian ran it, smoke_v5 25/25, check_api 29/29):
  - `mog.presence` (device, name, open vendor; gone after 90s);
  - `mog.store_people` (builds itself; a name unused for 30 days drops out of the picker);
  - `mog.counts.counted_by`;
  - `mog_snapshot2` (the 15-second refresh *is* the heartbeat);
  - `mog_save_counts2` (records who saved).

  The v1 calls are untouched.
- **App:**
  - Today and an open count screen refresh every 15s while on screen.
  - Others' counts fill in only on items this device hasn't touched.
  - Cards show "● Maria counting", or "Last count by Maria".
  - The count screen shows a banner when someone else has the vendor open.
  - "Who's counting?" is asked once per device (Skip allowed), plus a Settings row.
  - The app falls back to the v1 calls if schema v5 is missing.
- **Autosave (new behaviour):** counts used to reach Supabase only on Save or Review, so nobody else could see them. Now a count saves ~4s after the last change (Supabase stores only). Fixed on the way: a count typed while a save was in flight used to drop out of the unsaved list and never be sent.
- Published to **rprfo only** (`a2f7455`); the other stores stay on v0.18.3.
- Gates: `tests/live_counting.test.js` (5 controls) and a two-phone suite in `pwa_direct` (4 controls). 14 gates total.

## Outstanding (carry forward)

1. **Sebastian's rprfo live-counting test** (top). Two devices, two names, different vendors, then the same vendor. Fix what he finds, then **fan out**: `python build.py` with all store folders committed. **Canary first is already done; ask before the fan-out.**
2. **Bump the blueprint once Phase 1 is on every store.** Autosave, presence and concurrent counting change how counting behaves (R13-R15 area); regenerate the HTML afterwards.
3. **Phase 2 (editor foundation):** walk through it first.
   - The editor's schema: the 7 Manage Items actions in SQL behind one `mog_editor_call` dispatcher, the change log, Undo, and D23's `on delete set null`.
   - Re-host `ManageItems.html` + `EditorShell.html` as a computer-only section of the store app (the agreed "one app"; not a separate `editor/items.html`).
   - Par flags: move the math to shared JS and backfill `LOG_ORDERS` at the flip. Sebastian didn't pick this explicitly, but it's the recommended default; confirm it in the walkthrough.
   - Test on `rprfotest` (`editor_direct` on, phones off).
4. **The unused stores' parity:** rpt, rptfo and rpfrf each need Health Check → "Storage areas on pick rows" → Fix, then `test_catalogTablesParity`. No hurry; they flip last.
5. Small items left open:
   - the setup wizard rejects ĂN and Lei'd;
   - `mog-add-store` lacks the Supabase steps and stores.json's `address`;
   - tnyt `/exec` was healthy all session, but keep an eye on it;
   - polish of the loading screens stays parked until the migration is done.

## Files touched this chat

- **Supabase:** `supabase/schema_v4.sql`, `schema_v5.sql`; `supabase/tests/smoke_v4.sql`, `smoke_v5.sql`, `check_api.sh` (v4 and v5 lines).
- **Apps Script** (all 10 stores + template, `--redeploy`): `Sync.gs` (seed, parity report, Move → `phone_direct`), `Health.gs` (6 new rows, 4 fixes), `PickPath.gs` (`restorePickAreas_core_`), `Items.gs` (`planRepeatedItemIds_` / `fixRepeatedItemIds_core_`).
- **PWA:**
  - `template/index.html` (Copy order, the store profile, live counting, autosave), `template/sw.js` (v58);
  - `build.py` (the sixth placeholder);
  - `stores.json` (addresses);
  - store folders rebuilt: all at v0.18.3, rprfo at v0.19.0.
- **Tests:** new `catalog_parity`, `health_supabase`, `order_copy`, `live_counting`; extended `pwa_direct`, `supabase_move`, `public_surface`, `fake_supabase`.
- **Docs:** `docs/MOG_SupabaseMigration.md` (D19-D23, parity run), `docs/MOG_OneApp_Spec.md` (new), `CLAUDE.md` (invariant #5, inventory), `tests/README.md`, this handoff, `docs/MOG_CurrentState.md`.
- **Skill:** `.claude/skills/mog-deploy-workflow` (a PWA canary to one store).

## Process lessons

- In this environment the Bash tool strips one level of backslashes inside heredocs: `\\r\\n` became real CR LF, and a `'\u0001'` anchor broke. For text that contains backslashes, use the Edit tool, or build the backslash with `chr(92)` in Python. [→ memory reference_bash_heredoc_backslashes]
- A PWA change can be canaried to one store: build everything, `git checkout --` the other store folders, commit only the canary's folder. The old belief that "the PWA can't be split" was wrong. [→ .claude/skills/mog-deploy-workflow]
- Before promising a "live" feature, check when the data actually gets written. Counts reached Supabase only on Save or Review, so live visibility needed autosave. [→ docs/MOG_OneApp_Spec.md]
- The Google Drive connector returns only sample rows of a Sheet, and its download is one huge base64 blob. Put inspections in the code (a Health Check row or an editor-run function) instead. [→ memory reference_drive_connector_sheets]
- Inside one SQL `DO` block `now()` never moves, so a smoke test of "the latest" needs an explicit time gap. [→ supabase/tests/smoke_v5.sql]

## Commits landed this session

```
c13a8cb skills(mog-deploy-workflow): a PWA change can be canaried to one store
a2f7455 build: live counting (v0.19.0, cache v58) on rprfo only (canary)
14c6a44 feat: one-app spec + Phase 1 live counting (schema v5, app v0.19.0)
7977098 build: every store's delivery address on Copy order (v0.18.3, cache v57)
9ba9bd8 build: Copy order for email on every store (v0.18.2, cache v56)
2e641ae feat(pwa): Copy order shows the delivery day (canary: rpt only)
25ef3aa feat(pwa): Copy order for email on the review screen (canary: rpt only)
e606ba1 docs(supabase): D23 - removing an area or vendor never deletes items; rpfr passes parity
c5018ba feat(health): repair a copied Sheet's catalog drift (missing storage areas, repeated Item IDs)
ffe9bf7 feat(supabase): step 6 part 1 - catalog tables (schema v4) + parity gate
```

## Opening prompt for next session

```
Read docs/MOG_CurrentState.md, docs/MOG_OneApp_Spec.md and docs/MOG_SessionHandoff_2026_10_18.md
first. As of 2026-10-18: schema v4 (catalog tables) and v5 (live counting) are in Supabase; Copy
order for email is on every store (v0.18.3); live counting (v0.19.0: 15-second refresh, "Maria
counting" on cards, others' counts filling in, autosave ~4s, "Who's counting?") is live on rprfo
ONLY. Sebastian was testing it on rprfo with two devices.

First: get his test results, fix what he found, then (asking first) fan Phase 1 out to every store
with python build.py, and bump the logic blueprint. Then Phase 2, the editor foundation: walk it
through first (the editor's schema with the 7 Manage Items actions behind one mog_editor_call, the
change log + Undo, D23's on-delete-set-null; ManageItems.html re-hosted as a computer-only section
of the store app; test on rprfotest).

Rules: node tests/run_all.js before any deploy (14 gates); canary first (a PWA canary = commit
only that store's folder); schema files are run by Sebastian; editor_link.py for editor runs;
every next step that involves a file links it in the final message.
```
