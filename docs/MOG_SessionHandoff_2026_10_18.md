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

---

## Later session — live counting everywhere, the editor on Supabase, phone quick edits

**Session focus:** take Sebastian's rprfo live-counting results, roll Phase 1 out, then build Phase 2 (the editor foundation) and Phase 3 (phone quick edits) of `docs/MOG_OneApp_Spec.md`.
**Outcome:** Phases 1 and 3 are live on all 10 stores (app v0.20.0, cache v60). Phase 2 is built and tested on the Sheet-less test store `rprfotest`: page open 353 ms, save 596 ms, Undo 296 ms. Schemas v6 and v7 are installed (smoke all PASS, check_api 42/42), and there are 17 gates.
**Next session focus:** Phase 4: port the remaining editor tools onto Supabase the same way, then switch each store's catalog over (rprfo first).

### Section E — Live counting on every store (v0.19.1, `f2ac2a5`)

- **Sebastian's test:** fine overall, but the other device was slow and "Maria counting" was unreliable.
- **Cause:** each phone said which vendor it had open only at its next 15s tick, and nothing at all while locked.
- **Fix:**
  - `liveBeat_` (in `showView`) sends the heartbeat the moment a vendor opens or closes, and again on return from the lock screen. A beat sent during a read already in flight waits for that read, then sends its own.
  - The refresh now runs every 10s.
  - `pwa_direct` gained two planted defects for this.
- **Rollout:** to all 10 stores at once, without a canary (Sebastian's call).
- **Blueprint:** new rule R25, counting at the same time (`f27a3ae`).

### Section F — Phase 2: Manage Items on Supabase (`3c4d0b1`, schema v6)

- **Decisions E1-E4** (spec):
  - Manage Items' logic is shared JS (`template/editor/catalogEdit.js`), not 7 SQL actions.
  - The unchanged `ManageItems.html` is rendered as a static page, with `template/editor/host.js` standing in for `google.script.run`. No `apps-script/` file changed.
  - Testing is on a local preview (`python build.py --preview rprfotest --like rprfo`, git-ignored `_preview/`).
  - Par Review flags wait for Phase 4 (History).
- **Schema v6:**
  - `mog.change_log`;
  - `mog_editor_login` (needs `editor_direct`; same PIN and lockout);
  - `mog_editor_get`;
  - `mog_editor_apply` (writes rows only if they're still what the editor read, else CONFLICT and nothing written; logs; rebuilds the phones' catalog);
  - `mog_editor_undo` (refuses, naming the later change);
  - D23 (`on delete set null (primary_vendor)`, PG15+).
  - The store always comes from the token.
- **Gates:**
  - `catalog_edit`: 3,000 random steps next to the real `Items.gs` give the same answers, errors, phone catalog and item order; every write undoes; 8 planted defects.
  - `editor_host`: against a fake Supabase written apart from `catalogEdit.js`.
- **Page safeguard:** `host.js` refuses a token from another store. Every store shares one site's storage, so a stored token could otherwise show store A's catalog under store B's name.
- **Item order:** a new item goes after its vendor's last item via a `shift` op, so item order matches the Sheet exactly.
- **Tested:** Sebastian clicked through all 7 actions and Undo. Manage Items has no "remove area" action, and Sebastian doesn't want one: an item loses its area only when the area or vendor is removed (D23).

### Section G — Phase 3: phone quick edits (`1f20681`, schema v7, v0.20.0 on every store)

- **Decisions Q1-Q4** (spec):
  - "From now on" only where Supabase owns the catalog; elsewhere "just today" plus a note.
  - An item added for today shows in its usual storage area.
  - A today par applies on every list the item is on (R6).
  - Only today-only edits get review flags.
- **How it works:**
  - `mog.quick_edits` rides in the snapshot (`state.todayEdits`, plus `editorDirect`).
  - `orderInputsFromSnapshot_` (`OrderMath.gs`) applies the edits. It's the one place the phone, `/exec` (DbApi.gs), the 3:30 AM order log and the recap all read, so they agree. With no edits the answers are byte-identical.
- **Phone:**
  - Tap an item: a sheet with "Just today", "From now on" (where allowed), "Back to normal par" and "Take off today's list".
  - "+ Add an item to this list (today only)" opens a search picker.
  - New "Today only" badge, and every row's meta line shows its par.
- **Editor:** a ⚑ Needs review panel. Apply is a logged, undoable catalog change; Dismiss only clears the flag (`mog_editor_review`).
- **Schema v7 also adds:**
  - `mog_set_par`: "from now on" (CONFLICT on a stale par, logged, ends the today par);
  - `mog.prepare_test_store`: SQL Editor only; gives a test store a cycle and turns its phones on.
- **`build.py --preview`** also builds the test store's app, with an `/exec` that leads nowhere.
- **Gates:**
  - new `quick_edits`: a today edit behaves exactly like the same catalog edit across count screens, Today cards, order log and recap; 7 planted defects;
  - `pwa_direct`: 174 quick edits, phone == `/exec`; "from now on";
  - `editor_host`: Apply / Dismiss.
- **Deploy:**
  - Apps Script (`OrderMath.gs`) went to all 10 stores + template with `--redeploy`; every `/exec` probe was healthy.
  - The app went to rprfo (`2d1eeee`), then to every store (`232d408`) without waiting for rprfo's first close (Sebastian's call, since nothing changes until someone makes an edit).
- **Blueprint:** R23 gained the editor-on-Supabase clause; new R26 covers quick edits; two edge-case rows.

### Outstanding (carry forward)

1. **The first real close with quick edits (tomorrow, 3:30 AM).** Once KMs use them, check that a store's recap email and order log carry the day's edits.
   - Reviews from real stores wait in `mog.quick_edits` and show in Manage Items only after that store's editor switches (Phase 4).
2. **Phase 4.** Walk it through first.
   - Port Vendors, Storage Areas, Shelf to Sheet, History, Health, Recipients and People the Phase 2 way: logic in shared JS gated against the tool's `.gs`, the unchanged page plus `host.js`.
   - History needs the order log backfilled from LOG_ORDERS, with the par-flag math in shared JS (E4).
   - Then the switch procedure (D16, D17):
     - the store's `editor_direct` on;
     - a nightly copy back to the Sheet;
     - the Sheet's editing menus refuse that store;
     - the app's Editor entry on computers.
   - Order: rprfo first, the unused Tysons/Founders stores last.
   - "From now on" turns on by itself per store at the switch.
3. **Live-counting latency:** 10s polling. If it still feels slow, Supabase Realtime (push) is the next step. Not urgent.
4. **`rprfotest`:** no Sheet, so its cycle never closes. Run `select mog.prepare_test_store('rprfotest');` for a fresh day.
5. **Still open from this morning:**
   - the setup wizard rejects ĂN and Lei'd;
   - `mog-add-store` lacks the Supabase steps and `stores.json`'s `address`;
   - rpt, rptfo and rpfrf need Health Check → "Storage areas on pick rows" → Fix before parity.

### Files touched (later session)

- **Supabase:** `supabase/schema_v6.sql`, `schema_v7.sql`; `supabase/tests/smoke_v6.sql`, `smoke_v7.sql`, `check_api.sh` (v6 + v7 lines).
- **Apps Script** (all 10 stores + template, `--redeploy`): `OrderMath.gs` (today edits in `orderInputsFromSnapshot_`, the two optional row flags).
- **PWA:** `template/index.html` (heartbeat, 10s refresh, quick edits, v0.20.0), `template/sw.js` (v60); every store folder rebuilt.
- **Editor:** `template/editor/catalogEdit.js`, `template/editor/host.js` (new).
- **Build:** `build.py` (editor pages, `--preview` app + editor, theme read from `Dashboard.gs`), `.gitignore` (`_preview/`), `.claude/launch.json` (`mog-static` preview server).
- **Tests:**
  - new `catalog_edit`, `editor_host`, `quick_edits`;
  - extended `pwa_direct`, `fake_supabase`, `fake_apps_script` (`insertRowAfter`), `tests/README.md`.
- **Docs:** `docs/MOG_OneApp_Spec.md` (E1-E4, Q1-Q4, deploy order), `docs/MOG_SupabaseMigration.md` (API rows, step 6.3), `docs/MOG_LogicBlueprint.md` + `.html` (R23, R25, R26), `CLAUDE.md` (inventory), this handoff, `docs/MOG_CurrentState.md`.

### Process lessons

- Postgres binds `-` tighter than `->`: `r -> 'data' - 'tables'` reads as `r -> ('data' - 'tables')`. Parenthesize `(r -> 'data') - 'tables'`. [→ supabase/tests/smoke_v6.sql]
- Python run from Git Bash prints CRLF lines, so a `while read` loop fed from it gets a trailing CR on every value (every `/exec` probe failed until `tr -d` stripped it). Writing a script or doc that contains quotes or backslashes as a heredoc failed three more times; the Write tool plus a scratch file worked. [→ memory reference_bash_heredoc_backslashes]
- The app's file viewer reads a `/path` in chat as a file at the drive root ("Couldn't load this preview"). Give local preview pages as full `http://localhost:8765/...` addresses and open them in the browser pane. [→ memory feedback_preview_urls]
- An Apps Script page rendered static needs its own `<meta charset>` (and viewport): HtmlService sends them as response headers, so a static server showed `Â·` until added. [→ build.py]
- Every store's static page shares one site's storage, so a token one store's page saved reaches another store's page. The page must check the token's store, not just that it's valid. [→ template/editor/host.js]
- To prove a new input to the order math, compare it with the same change made by hand in the catalog (a today par vs a catalog par of that number) instead of hand-computing expected quantities. That way every reader is covered at once. [→ tests/quick_edits.test.js]
- Sebastian skips the overnight canary wait when the gates prove a change does nothing until someone uses it. Offer the canary, state what could break, and let him choose. [→ memory feedback_rollout_speed]

### Commits landed (later session)

```
232d408 build: quick edits (v0.20.0, cache v60) on every store
2d1eeee build: quick edits (v0.20.0, cache v60) on rprfo only (canary)
1f20681 feat(phones): one app, Phase 3 - quick edits from the count screen (schema v7, app v0.20.0)
3c4d0b1 feat(editor): one app, Phase 2 - Manage Items on Supabase (schema v6)
f27a3ae docs(blueprint): rule R25, counting at the same time (live counting on every store)
f2ac2a5 feat(pwa): live counting on every store, names show faster (v0.19.1, cache v59)
```

### Opening prompt for next session

```
Read docs/MOG_CurrentState.md, docs/MOG_OneApp_Spec.md and the LATER-SESSION block of
docs/MOG_SessionHandoff_2026_10_18.md first. As of 2026-10-18: one-app Phases 1 (live counting)
and 3 (phone quick edits: "just today" par and adds, v0.20.0) are live on all 10 stores; Phase 2
(Manage Items on Supabase: catalogEdit.js + host.js + schema v6) is built and tested on the
Sheet-less test store rprfotest only. Schemas v6 and v7 are installed.

First: check that the first nightly closes with quick edits look right (recap email + order log).
Then Phase 4: walk it through first - port the remaining editor tools the Phase 2 way (shared JS
gated against each tool's .gs, the unchanged page + host.js), History with the order log
backfilled from LOG_ORDERS and the par flags in shared JS, then the per-store switch
(editor_direct on, nightly copy back to the Sheet, Sheet menus refuse, the app's Editor entry),
rprfo first, the unused Tysons/Founders stores last.

Rules: node tests/run_all.js before any deploy (17 gates); canary first, but Sebastian may skip
the wait when the gates prove a change is inert; schema files are run by Sebastian; preview with
python build.py --preview rprfotest --like rprfo and the mog-static server; every next step that
involves a file links it in the final message.
```
