# MOG — Current Project State

The running snapshot of where this codebase is *right now*. `CLAUDE.md` @-imports it, so every session starts with it. It stays short on purpose: the history lives in the dated handoffs (`docs/MOG_SessionHandoff_*.md`), and everything this file held before 2026-10-20 is unchanged in [docs/MOG_CurrentState_Archive.md](MOG_CurrentState_Archive.md), which is not auto-loaded.

If this doc and `CLAUDE.md` conflict on a fact, `CLAUDE.md` wins for structure and invariants; this doc wins for what's in flight.

---

## Pinned focus

**Every store runs on Supabase and one app (as of 2026-10-20).**

- **Phones** count straight into Supabase (`phone_direct` on all 10 stores).
- **The catalog, order history, recipients and People** live in Supabase and are edited in the app on a computer (`editor_direct` on all 10).
- **Each Sheet** is frozen for catalog edits. It still holds the Apps Script: the 3:30 AM close, the recap email, the onboarding moves. It also gets a nightly LOG_ORDERS backup.
- **On a computer** the order guide and Manage share one sidebar; Manage pages run in a frame (`?embed=1`).
- **Versions (newest first):** app v0.33.0 / store cache v76 (Manage finished, live on all 10 stores 2026-11-11, 38 gates); schema v23 (live 2026-11-11, see Sheet retirement step 2 below); v22 (live 2026-11-06), v21 (routes, live 2026-11-05, store cache v74). History: app v0.28.0 / store cache v69, hub cache v11, schema v14 (LTOs, live 2026-11-02: smoke_v14 26/26, probe 94/94; HQ side shipped in `6fee3a1`). Schema v15 (vendor rename) live 2026-11-02: smoke_v15 18/18, probe 96/96; the Vendors page's rename shipped with it, together with the Items page's new-LTO banner and HQ's library tick boxes (30 gates). Schema v16 (Happy Supply W2a, store orders) live 2026-11-02: smoke_v16 50/50, probe 105/105; the app (v0.28.0) and HQ shipped with it in `37588dd` (31 gates). Schema v17 (W2b, HEH's stock held at Elpis) live 2026-11-03: smoke_v17 47/47, probe 111/111; the app (v0.29.0, store cache v70) and HQ shipped with it in `42db1a9` (32 gates). Donny's count-screen change (PR #7, `de0b787`) followed the same day: **app v0.30.0 / store cache v71, 33 gates**. Schema v18 (HQ remembers a device: the sign-in's "Remember this device for 30 days" box, 30 days from each open; Sign out ends the sign-in on the server) live 2026-11-03: smoke_v18 18/18, probe 114/114; HQ's page shipped with it (gate `hq_remember`, **34 gates**). The wording pass (v0.30.1, cache v72) and Items' area fix followed on 11-04. Schema v19 (Elpis on one page: a warehouse product's concept) live 2026-11-04: smoke_v19 11/11, probe 116/116; HQ's four-step Elpis page and the phone's "To check in" list shipped with it: **app v0.31.0 / store cache v73, gate `elpis_setup`, 35 gates**. Schema v20 (W2c, HEH's stock at three places: a place's kind, an item's places and low points, a Happy Supply order into a holding store's place, the close by place, who took what) live 2026-11-04: smoke_v20 37/37, probe 123/123; HQ's HEH STOCK pages (Stock, Items, Places, Who took what) replaced Inventory, Products and prices and the Elpis page (gate `wh_places`, **36 gates**; the phone unchanged).
- **New stores** follow `mog-add-store` (11 steps, `scripts/validate.py`). The setup wizard and the Sheet menus accept all four concepts.
- **The three stores that moved empty:**
  - Rockville BOH (`tnyr`) and FOH (`tnyrf`): their KMs set them up themselves from the Overview checklist. Both import from the same Rockville MarginEdge file, each ticking only its own items; nothing stops an item landing in both.
  - Tysons BOH (`tnyt`): its KMs have been setting it up since 10-26 (208 items on 11-01). It seeds the Teas'n You BOH library.
- **The first all-Supabase night (10-19 → 10-20) was clean:**
  - all 10 stores closed between 3:23 and 3:38 AM;
  - rpr and rprfo had orders, and their recaps went to their Supabase recipients;
  - the other stores had nothing ordered, so no email (by design).

**2026-11-10 → 11-12: the count screen's backups, Manage finished, Sheet retirement started** (`docs/MOG_SessionHandoff_2026_11_12.md`).
- **Count screen (app v0.32.0, `6d1c225`, all 10 stores):** an item whose main vendor isn't ordered today lists on its backups; once one list counts it, the others show it read-only at the bottom, "Counted on [vendor]'s list today" (Blueprint R35). Not seen on a real phone yet.
- **Manage finished (app v0.33.0, store cache v76, `ad95379` then `3e37d02`):** Storage areas and Shelf to Sheet are app pages; the Health check is the Overview's Needs attention rows, and its page is gone.
- **Daily inventory dropped:** counted on MarginEdge Spot sheets instead (Dropped, below).
- **Sheet retirement:** spec approved (`e322e65`); step 1 (backup) and step 2 (the close and recap in Supabase) below.

**2026-11-11 (later): Sheet retirement step 2 is built; v23, the function and the schedule are live, no store has switched** (the close and the recap email in Supabase; `docs/MOG_SheetRetirement_Spec.md`, "Step 2").
- **Live, on Sebastian's go:**
  - schema v23: smoke_v23 48/48, probe 142/142;
  - the Edge Function `close` (version 1, JWT check off): refuses a call without Vault's secret (401), and an authenticated run answered `{"ok":true,"ran":[]}`;
  - `night_schedule.sql`: `pg_cron` job `mog-night`, every 15 minutes.
- **Not yet:**
  - `close_direct` is off at all 10 stores, so Apps Script still closes every store and sends every recap;
  - the first shadows run at 3:00 AM on 11-12.
- **Approved in the walkthrough:** Apps Script shares the once-per-cycle flag through Supabase (the Daily summary stays in Apps Script until step 3); each store's 3:30 AM trigger retires itself the first night its `close_direct` is on; recaps from `noreply@hehfood.com`, no Reply-To; a nightly shadow (3:00 to 3:20 AM) of every store Apps Script still closes, compared each morning with `supabase/tests/night_shadow_check.sql`.
- **Built:**
  - `supabase/schema_v23.sql` (smoke_v23, 11 planted defects caught) and `supabase/night_schedule.sql` (`pg_cron`, `pg_net`, the Vault secret);
  - the Edge Function `supabase/functions/close/` (its `shared.mjs` generated by `build.py`);
  - `apps-script/Concepts.gs` and `RecapEmail.gs` (moved out of `Dashboard.gs` and `Recap.gs` unchanged); the shared flag in `Recap.gs`; the self-retiring trigger in `Sync.gs`;
  - gate `night_close` (13 controls).
- **Takes schema v23:** the drop of `via`, `par` and `stores` moves to v24.
- **Live order** (a deploy that changes nothing a store does runs and is reported; step 7, turning on `close_direct`, is asked first):
  1. v23, then smoke_v23;
  2. the function's deploy;
  3. ~~Resend~~ the mail relay (decided 2026-11-12: no new account): **done 11-12**, the relay created and deployed, its secret in Edge Functions → Secrets, the function at version 4;
  4. `night_schedule.sql` (done 11-11), then a test email (**sent 11-12**, about 2.6 s end to end);
  5. the Apps Script deploy: rprfo **done 11-12** (@114), the other 10 after rprfo's night checks out;
  6. shadow nights;
  7. rprfo's `close_direct` on for three nights, then the other nine.

**2026-11-11: Manage is finished, live on all 10 stores** (`docs/MOG_SessionHandoff_2026_11_12.md`; canary `ad95379` on rprfo, checked by Sebastian, fan-out `3e37d02`; CI green; spec U12).
- **Storage areas and Shelf to Sheet are app-only pages** (`template/editor/Areas.html`, `ShelfToSheet.html`, boards 7 and 8 of the Manage canvas). Shelf to Sheet drags, and keeps up/down and Move to. Same saves as before.
- **The Health check lives in the Overview:** each warning is its own Needs attention row with its Items or Vendors filter or its fix, and a Store checks line (close, PIN, phones) always shows. The setup card takes vendors' days and items' areas and pars while it shows. The Health check page and sidebar entry are gone; `#healthcheck` opens the Overview.
- **Not seen on a screen:** the other nine stores (same build as rprfo).

**2026-11-11: the nightly off-site backup is live** (Sheet retirement step 1, decision R4; `docs/MOG_SheetRetirement_Spec.md`, "Step 1, built").
- **What runs:** the private repo `SebHEH/mog-backup` dumps the `mog` and `public` schemas every day at 09:47 UTC (4:47 AM New York in winter) and keeps each dump 90 days. It restores each one into a throwaway Postgres 17 and checks every table's rows, every function and every grant against the live database. A red run emails Sebastian.
- **The login:** `mog_backup`, read-only, made by `supabase/backup_role.sql`. Sebastian ran it 11-11; re-running it rotates the password. CI runs `supabase/tests/backup_role_pglite.mjs`.
- **First green run** (#4, 11-11): 36 tables, 17,609 rows, a 710 KB dump, matched.
- **The first scheduled night (11-12) never started** (GitHub picked up the schedule only after a push); run #5, by hand on 11-12, passed: 37 tables, 17,766 rows, matched.
- **Next:** check the 11-13 scheduled run, and approve or change the backup watchdog's design (step 2's session). The Sheets' LOG_ORDERS copy keeps running until step 2 (the close and the recap in Supabase).

**2026-11-05: routes, schema v21, live** (`5754aca`; smoke_v21 31/31 in the SQL Editor, probe 129/129, store cache v74). The one-time fill routed only the TEST store's bowls and lids (from Elpis); no real store has a route yet. Sebastian's first W2c setup was refused (Items → Send to stores still ran v16's Happy-Supply-only rule), so HQ's stock side got one record per store and item, a route, set on the HQ item's Stores table (`docs/MOG_Warehouse_Spec.md` §2, "Routes spec", mockup in the canvas's Routes row, "v21 design" and "Built"). Every stock reader now reads the route, never HQ's remembered names. smoke_v21 31/31 in PGlite with every older smoke file passing; gate `wh_routes` added (37 gates). SHRIMP is routed at Rosslyn and Founders BOH from Transfer (Tysons) (11-05; RP Tysons waits for Dan), and the 11/5 hand count was re-recorded as deliveries EL-0003/4.

**2026-11-05 (later): schema v22, an inactive HQ item or a closed place stops its routes; SQL live 2026-11-06** (run through the connector on Sebastian's go, the first under the new rule: smoke_v22 15/15, probe 133/133). On v21 the close still recorded deliveries for both. Now the close, the phone's read and Send skip them, HQ shows them on "Needs you", and active or reopened resumes them with no store change (`docs/MOG_Warehouse_Spec.md` §2, "v22"). smoke_v22 15/15 in PGlite with every older smoke file; `wh_routes` 10 controls; HQ only (no store cache bump). Also: `supabase/tests/test_store_elpis.sql` reads routes again. HQ's page live `48c1b26`, CI green. **Next** (`docs/MOG_SessionHandoff_2026_11_06.md`, Outstanding): the 11-07 close checked read-only (the first on v22, and the first that can record SHRIMP from Tysons); Dan and Donny claim their HQ invites; RP Tysons' own route once Dan answers; v23 drops `via`, `par` and `stores` around 11-12. Claude runs schema files on the maintainer's go per file (CLAUDE.md, Supabase row; the connector runs as `postgres`, measured 2026-11-06).

**2026-11-04: HEH's stock at three places (W2c) is live** (`docs/MOG_SessionHandoff_2026_11_04.md`; schema v20, `8fda25e`; smoke_v20 37/37, probe 123/123, 36 gates). Not in use yet.
- **The goal, drawn back with Sebastian:** Happy Supply (Dan's bulk) supplies RP Tysons, which holds shrimp for itself, Rosslyn BOH and Founders BOH (they order it from "Transfer (Tysons)"); Elpis holds HEH's paper goods; HQ shows how much is where and who took what.
- **Built:** a place's kind (HEH's own, held at a store, held by a vendor), an item's places with low points, a Happy Supply order from a holding store shipped as a move into its place, the 3:30 AM close recording deliveries by place, Who took what (cases). HQ's HEH STOCK pages (Stock, Items, Places, Who took what) replace Inventory, Products and prices and the Elpis page; the phone is unchanged. Detail: `docs/MOG_Warehouse_Spec.md` §2 "W2c".
- **Next:** the 11-05 close checked read-only (the first on v20); Sebastian's setup of "Transfer (Tysons)" as RP Tysons' place (handoff Outstanding 2); the new pages seen on a screen.
- **Earlier the same session:** HQ remembers a device (v18), the KM Tool Brief, the wording pass (v0.30.1), Items' area fix, checking deliveries in apart from ordering (v19, app v0.31.0 / cache v73).

**2026-11-03: Donny's count screen** (PR #7, `5a2767b`, merged `de0b787`): each item lists only on its main vendor's count screen, its other vendors behind an arrow; app v0.30.0, cache v71, gate `count_lists`. Checked against W2b the same day: nothing of it changed, 33 gates and the SQL check pass, live on all 10 stores (`docs/MOG_SessionHandoff_2026_11_03.md`, Section B). The blueprint doesn't describe it yet.

**2026-11-03: Happy Supply W2b, HEH's stock held at Elpis, live** (`docs/MOG_SessionHandoff_2026_11_03.md`; smoke_v17 47/47 in the SQL Editor, probe 111/111, `42db1a9`). Not in use: no location is held by a vendor yet.
- **Checked live first:** W2a not tried yet (no warehouse products, links or orders); Elpis still three spellings; Horse Pho not undone.
- **Decided (walkthrough, all four as recommended):** recorded at the 3:30 AM close (not at Mark as reviewed); a receipt beyond the records goes through, logged as a count; HQ can mark an unmarked delivery received; the warehouse role sees Elpis. Three mockup boards approved ("Happy Supply W2b" row).
- **Built:** schema v17 (`held_by`, `via`, deliveries EL-0001 in `mog.wh_orders`, the close's guarded step, `mog_wh_held_receive`), HQ's Elpis page, the phone's Elpis card, gate `wh_elpis` (32 gates). Detail: `docs/MOG_Warehouse_Spec.md` §2 "W2b design".
- **Next:** check read-only that the 11-04 close ran at every store as usual (nothing can be recorded until an Elpis location exists); then first use on the TEST store (HQ → Locations: Elpis held by Elpis Wholesale, the RP bowls and lids as products, a count from Elpis's report, Send to stores, an Elpis order, the close, Mark received).

**2026-11-02 (later, 5): Happy Supply W2a, store orders, live** (`docs/MOG_SessionHandoff_2026_11_02.md`, "Later session 5").
- **Spec and design:** the W2 spec, the W2a design and its three mockup boards are approved (`docs/MOG_Warehouse_Spec.md` §2).
- **HQ:** a product's Send to stores links an item a store has (Happy Supply its main vendor, the old one a backup) or adds one, at stores that already have Happy Supply (add it on Vendors first). Dan's Orders page ships from a location, starting at what's left after older orders, and locks each line's price.
- **Phone:** "N available" on Happy Supply items; the review's needed-by, note and Send to Happy Supply (also marks it reviewed); the card's order line and Mark received.
- **Schema v16:** the link in the item's row (`mog.items.wh_product`), store orders HS-0001, no price ever on a phone.
- **Live checks:** smoke_v16 50/50, probe 105/105, commit `37588dd`, CI green, Pages live on all 10 stores and HQ. 31 gates.
- **In use:** nobody yet. No store has a link and the warehouse has no products. Seen only in the preview, by script.
- **Next:** W2b, HEH's stock held at Elpis.

**2026-11-02 (later, 4): new LTO items first, library tick boxes, vendor rename, all live** (`docs/MOG_SessionHandoff_2026_11_02.md`, "Later session 4").
- **Items page:** each running LTO's items that lack a par or a storage area are pinned at the top under a banner, with an "LTO · name" chip and a panel note (`catalogEdit.js` `ltoWaiting`). LTO spec session 2 is done.
- **HQ Libraries:** tick boxes and Tick all; Remove from the library, or Send N items to stores (standard items, no LTO).
- **Vendors page:** a store can rename a vendor (schema v15): items, count lists, today's counts and edits, and HQ's remembered names follow; a taken name is refused; Undo renames back.
- **Live checks:** smoke_v15 18/18, `check_api.sh` 96/96, commit `abce087`, CI green, Pages live on all 10 stores and HQ. 30 gates.
- **Used live the same evening** (Sebastian: "all looked right"; checked read-only):
  - the Teas'n You BOH test library cleared with Tick all → Remove (5:36 PM);
  - B&T renamed to "B&T Distributors LLC" at Rosslyn, Founders and Tysons BOH (Rockville BOH already had it);
  - the first real LTO, **Fall Chicken Pho**, sent to Rosslyn, Founders and Tysons BOH (5:41 PM). It's meant to run; its chicken breast has no par yet at any of the three.
- **Not built:** live stock for Happy Supply and Elpis, now open W2 questions in `docs/MOG_Warehouse_Spec.md`.

**2026-11-02 (later, 3): LTOs, the HQ side, are live** (`docs/MOG_SessionHandoff_2026_11_02.md`, "Later session 3"; spec `docs/MOG_LTO_Spec.md`).
- **Schema v14:** an HQ rollout is a named LTO (`mog.ltos`, `mog.lto_stores`); each item it creates carries it in `mog.items.lto`, part of the item's row (a store's Undo brings it back, a reused item number never gets it).
- **HQ:** Roll out became **New LTO** (name required, the library box gone). The new **LTOs** page (`template/hq/ltos.js`) shows each LTO at each store and can Send to more stores, Make it standard (into the library), End (items inactive) or Roll back (as if never sent), every store or none.
- **Live checks:** smoke_v14 26/26 in the SQL Editor; `check_api.sh` 94 passed, 0 failed; commit `6fee3a1`, CI green, Pages live on HQ and all 10 stores. 29 gates. Nobody has used the live LTOs page yet.
- **Not tracked:** the rollouts sent before v14 (Horse Pho, Horse Meat, Fall Chicken Pho): undone by hand in each store's Changes.
- **Next:** session 2, the store's Items page (built in later session 4).

**2026-11-02 (later, 2): the local preview server** (`docs/MOG_SessionHandoff_2026_11_02.md`, "Later session 2").
- **`preview_start` "mog-preview"** (`tests/preview_server.js`) serves the app, the editor, HQ and Happy Supply against the fake Supabase at `http://127.0.0.1:8770/`: PIN 1111, HQ through `/__signin?who=`. Use it instead of building one.
- **`node tests/run_all.js` passes in a fresh Windows worktree** now (the slicer self-test's anchors were LF-only). PR 6, merged.

**2026-11-02 (later): Happy Supply W1, the warehouse, is live** (`docs/MOG_SessionHandoff_2026_11_02.md`, "Later session").
- **Schema v13:** HQ people have roles (`hq`, `warehouse` or both; Sebastian has both). The warehouse keeps its own stock per location (never below 0), vendor orders in (PO-0001), transfers (TR-0001), counts with reasons, and every change kept. The rules live in the SQL (`mog_wh_*`).
- **HQ's Happy Supply pages** (`template/hq/warehouse.js`): Inventory with Count a location, Incoming, Products and prices, Stock history, shown to the warehouse role.
- **Live checks:** smoke_v13 44/44 PASS in the SQL Editor; `check_api.sh` 88 passed, 0 failed; CI green; Sebastian saw the section on the live page: "It shows, looks right". The warehouse holds no data yet; Dan isn't invited.
- **CI now runs the real SQL** in PGlite (`supabase/tests/run_pglite.mjs`): every schema and smoke file, then the newest schema again, which must change no row. 28 gates.
- **Decided:** stock never below 0 (count first); Happy Supply reaches the Roll Play stores with W2's first products, in one HQ rollout per store; schema numbers aren't held for a person.

**2026-11-02: the concept library and the HQ redesign** (`docs/MOG_SessionHandoff_2026_11_02.md`).
- **Concept library** (schema v12): one standard item list per concept and side, kept on HQ's Libraries page. A library starts from one store, then gets cleaned, and sets up a store like an LTO (no par, no area). None is started yet (checked live 11-02).
- **HQ redesigned** in the order guide's computer look with the HEH brand. Stores are picked as a concept, then its stores. The main vendor is a dropdown and backups are chips. Sebastian saw it on a screen on 11-02: it looks right, no changes.
- **HQ in use:** Sebastian is signed up and ran one TEST rollout on rprfotest; its Undo is still untried. Checked live on 11-02: "Horse Pho" (change 237) isn't undone.

**2026-11-01: vendor contacts, HQ control, the warehouse spec** (`docs/MOG_SessionHandoff_2026_11_01.md`).
- **Vendor contacts** (schema v10): each store's vendors carry a contact, edited on the new app-only Vendors page, shown on the phone's vendor card. Rosslyn BOH and Founders BOH are loaded.
- **HQ control** (schema v11, `/hq/`): adds a vendor or LTO items to many stores at once, every store or none, one undoable change per store. Sign-in is per person by invite; only Sebastian is invited.
- **Spec approved:** `docs/MOG_Warehouse_Spec.md`, in the order concept library (built 11-02), warehouse (Happy Supply) W1-W2, stores without a Sheet, then Chasin' Tails and NUE.

**Two maintainers (2026-10-29).** Sebastian's assistant Donny now maintains MOG too (CLAUDE.md, Two maintainers; his setup in [ONBOARDING.md](../ONBOARDING.md)).
- **Changes:** Donny works on branches and opens pull requests; Sebastian merges.
- **Deploys and SQL:** both can deploy and run SQL. `deploy.py` refuses a copy that is behind `origin/main`, and sends a deploy to every store only from `main`.
- **CI:** the 24 gates run on GitHub (`.github/workflows/gates.yml`) on every push and pull request, and pass there.
- **Project notes:** what used to be Claude's memory on Sebastian's computer is now [docs/MOG_ProjectNotes.md](MOG_ProjectNotes.md).
- **Not finished:** Sebastian's invites and branch protection, then Donny's one-store test deploy, which measures who `/exec` runs as after his redeploy.

**The 2026-10-20 session, status at last update:**

- **Logic check:** all gates pass, and the order math is one shared copy. Four fixes are built and tested:
  - the recap's "already sent" check used a frozen Sheet date (duplicate emails possible);
  - offline counts that sync after the close were silently dropped;
  - the phone's rounding now calls `OrderMath.gs` (new gate `phone_rounding`);
  - typed negative counts become 0.
- **Cleanup:**
  - Import Vendor (CSV) removed: Import from MarginEdge replaces it.
  - Recalibrate Vendor Pars, Vendor Cadence Audit and How To Use deleted.
  - Dead code removed; "1 items" fixed.
- **Shipped:** commit `ffc816b`. Apps Script is on all 11 targets (every store's `/exec` answers), and the app is v0.26.1 / store cache v67.
- **Manage Items redesign: live on all 10 stores** (commit `a4e6e98`), built from the approved mockup ([artifact](https://claude.ai/artifact/BmVaV6v55MnHx39gJ7mH4K)). Its layout hasn't been seen on a screen yet: Sebastian checks it live.
  - The page: the app-only [template/editor/Items.html](../template/editor/Items.html).
    - A four-column list with search, a vendor dropdown ("On its list / Not on it"), an area filter, and Active / Needs setup / Par review / Inactive.
    - An item panel beside the list (previous/next, one Save for everything), and Add item as a button.
    - A bulk bar: add to / remove from a vendor, Move to area, Make active/inactive.
  - Three new one-change bulk saves in `catalogEdit.js`, gated by `tests/items_bulk.test.js`.
  - Each touches only the ticked items. The old Assign tab's save rewrote a vendor's whole list and dropped other items' drifted rows.
  - Saving an item now needs a par.
  - `ManageItems.html` stays for the Sheet dialog and `/exec`.
- **The Vendors redesign** shipped 2026-11-01 (app-only `template/editor/Vendors.html`, with each vendor's contact).

Read before touching the app, the editor or Supabase: [docs/MOG_OneApp_Spec.md](MOG_OneApp_Spec.md), [docs/MOG_SupabaseMigration.md](MOG_SupabaseMigration.md), [docs/MOG_LogicBlueprint.md](MOG_LogicBlueprint.md).

### Next-session candidates

1. **Finish lining up after later session 4** (Sebastian's steps, live; checked 11-02 evening):
   - rename Elpis to "Elpis Wholesale" in Manage → Vendors at Rosslyn FOH, Founders FOH, RP Tysons FOH and TnY Tysons FOH (Rockville BOH and FOH have it already);
   - undo "Horse Pho" in Rosslyn FOH (TEST)'s Manage → Changes (change 237); that also takes away the TEST store's "B&T".
   - Done: B&T lined up, the Teas'n You BOH test library cleared, a real LTO sent (Fall Chicken Pho).

   Later, its own spec: line up each concept's stores with its library, and items a store can't remove.
2. **Use the concept library** (schema v12, HQ's Libraries page; `docs/MOG_Warehouse_Spec.md` §1). Checked live 11-02 evening: Roll Play BOH and Teas'n You BOH are empty (the test cleared); the FOH libraries aren't started. Sebastian's steps:
   - start and clean all four (Rosslyn BOH and FOH, Tysons BOH, Rockville FOH);
   - set up a store from one, or send ticked items with "Send N items to stores".
3. **Start the warehouse** (W1 live; `docs/MOG_Warehouse_Spec.md` §2):
   - Sebastian invites Chef Dan (done 2026-11-05, both roles);
   - Dan adds the locations, suppliers and products, then a first count per location.

   Then W2 (store orders). **Its spec is approved** (2026-11-02, `docs/MOG_Warehouse_Spec.md` §2 "W2 spec"):
   - no Approve step (sent, shipped, received);
   - cases available on the phone; an order larger than that is sent with a warning;
   - KMs keep ordering HEH's stock at Elpis from Elpis: Elpis is a location, and the store's receipt lowers it (Sebastian keeps it for now);
   - built in two parts, W2a Happy Supply first, then W2b Elpis.

   W2a's design is approved too (same section, "W2a design": schema v16, the link on the item's row, the Happy Supply vendor from HQ's remembered names, needed-by from its delivery days). **W2a is live** (schema v16, `37588dd`) and untried (checked 11-03). First use on the TEST store:
   1. a product and a first count in HQ → Happy Supply;
   2. Happy Supply added to Rosslyn FOH (TEST) on HQ → Vendors, with its delivery days;
   3. Send to stores, then set the item up at the store;
   4. a phone order, Ship, Mark received.

   **W2b (HEH's stock at Elpis) is live too** (schema v17, `42db1a9`); the TEST store's two Elpis deliveries (`supabase/tests/test_store_elpis.sql`) are still open. **W2c (HEH's stock at three places) is live** (schema v20, `8fda25e`): Sebastian's setup steps are in `docs/MOG_SessionHandoff_2026_11_04.md`, Outstanding 2. Before Happy Supply's real use: Dan's answer on pound ordering, and Dan invited. Happy Supply goes to the Roll Play stores with W2's first products. Then W3 (chargebacks).
4. **Finish Donny's onboarding** ([docs/MOG_SessionHandoff_2026_10_29.md](MOG_SessionHandoff_2026_10_29.md), Outstanding 1-2):
   - Sebastian's steps: GitHub collaborator on both repos, branch protection on `main`, the Supabase Developer invite, Editor on the 11 Sheets, PINs.
   - Then Donny consents in each store and runs `python deploy.py --redeploy --target rprfo`.
   - Record the result in `docs/MOG_ProjectNotes.md` and CLAUDE.md rule 5.
5. **Confirm the 2026-10-20 fixes held:** each store's recap goes out once, and nothing new shows up in the nightly run's log (not checked since 10-20).
6. **Check the phone's Contact sheet live** (checked by script only). The Items page's LTO banner, the Vendors rename and HQ's library tick boxes were used live on 11-02 and looked right. (The Overview's "Give each item a storage area and a par" step opens Items on Needs setup since 11-11.)
7. **Logic findings held back on 2026-10-20** (edge cases; decide before fixing):
   - A same-day manual close from the Sheet, followed by that night's close of the same day, replaces the day's order log with an empty one.
   - Turning Emergency Override off before 3:30 AM drops the vendors ordered under it from that night's log and email.
   - A per-vendor day pick can be saved while Override is off.
   - The blueprint is still out of date in places (R5, R12, R14 and the Import Vendor note were fixed 2026-10-20):
     - the count-flow steps;
     - R1 cites the wrong file;
     - the R10 pseudocode leaves out the per-vendor pick;
     - R27's wording;
     - R16's evidence.
   - `audit_modals.py` (the `mog-modal-ux-sweep` skill) still looks for `google.script.host.close()`, so it flags Manage Items and Vendors, whose Close moved into EditorShell in July.
8. **Redundancy items held back on 2026-10-20:**
   - `VENDOR_META` is empty, but the equivalence gate compiles an older revision against the same constant list.
   - The nightly recipients copy is a no-op on all 10 stores; the `recipients_people` gate is built around it.
   - The old `/exec` editor still serves its pages for moved stores; it should send them to the app.
   - The Sheet Health Check's catalog rows still run, and three of its fixes can write to frozen Sheets.
   - Admin Reset can wipe a moved store's LOG_ORDERS backup.
   - `host.js`'s standalone rail and Changes panel only show off-app, on a narrow non-phone screen.
   - The v1 Supabase fallback (`mog_snapshot` / `mog_save_counts`) can go once old app versions are gone.
   - `template/sw.js` `FORCE_CLIENT_RELOAD`: never change `FORCE_RELOAD_ID`.
   - Stale repo skills: `mog-apps-script-caching`, `mog-rpc-consolidation`, `mog-editor-web-reskin`, `mog-sheet-formula-verify`, `mog-health-check-extend`.
9. **Small open items:**
   - Confirm this repo's origin in the desktop app (Help → Troubleshooting → Review Pinned Git Origins), so worktree sessions can merge `main` when it changed a skill.
   - No GitHub CLI on Sebastian's computer: pull requests are opened by hand and the app can't watch their CI (optional: install `gh`, then `gh auth login`).
   - `mog-deploy-workflow`'s HTML-modal row still says modals run in Rhino ES5 (CLAUDE.md invariant #4 says otherwise).
   - GitHub Actions warns that `checkout@v4`, `setup-node@v4` and `setup-python@v5` target the deprecated Node 20, and that `ubuntu-latest` moves to Ubuntu 26. Bump the actions when newer majors exist, and watch the first run on Ubuntu 26.
   - Clear Config doesn't clear the four Supabase keys (`Admin.gs`; walk through first).
   - `supabase_move`'s `provisionProblems` counts a commented-out SQL row.
   - Lei'd has no circular logo.
   - On the first real onboarding, record whether a copied Sheet keeps its Script Properties.
10. **Later:**
   - keep visited Manage pages alive;
   - send the recap email from Supabase;
   - retire the last `/exec` uses (Daily summary button, reset fallback);
   - the MarginEdge API for pack sizes.

> **Dropped (do not re-add):**
> - Parallelizing `deploy.py`. Repeatedly considered and abandoned: the serial push isn't hurting, and concurrent `clasp push` adds rate-limit risk.
> - **A daily inventory of the top items in the order guide** (Sebastian, 2026-11-10). It's counted in MarginEdge instead, on a Spot count sheet per BOH store (Spot Inventories: no effect on food cost, but they show in the Usage reports), Monday to Saturday. MarginEdge already holds the invoices (what arrived) and the company-wide recipes that turn prepped and cooked protein back into raw lb, which the order guide would have had to copy in every night. Nothing was built.

---

## Standing invariants

See `CLAUDE.md` → "Standing invariants" (10 rules). They aren't repeated here so the two copies can't drift.

---

## Deploy targets (apps-script/.clasp-targets.json)

11 targets: the master template plus 10 stores. The code is identical across all of them, and per-store config lives in each Sheet. Each target has a `scriptId` (for `clasp push`) and a `deploymentId` (for bumping its web app's `/exec` version).

| Slug | Store | Notes |
|---|---|---|
| `_template` | Master template | Copied to seed new stores. Push keeps it current. |
| `rpr` | Roll Play - Rosslyn BOH | |
| `rprfo` | Roll Play - Rosslyn FOH | Canary: the first to get every deploy. |
| `rpt` | Roll Play - Tysons BOH | In use (219 order lines in the 30 days to 11-04). |
| `rptfo` | Roll Play - Tysons FOH | Not used yet. |
| `rpfr` | Roll Play - Founders BOH | In use since 2026-11 (Founders Row is its own store now). |
| `rpfrf` | Roll Play - Founders FOH | Not used yet. |
| `tnyt` | Teas'n You - Tysons BOH | Being set up by its KMs since 10-26. Its `/exec` flaked after redeploys (10-16, 10-19) and recovered both times. |
| `tnytf` | Teas'n You - Tysons FOH | |
| `tnyr` | Teas'n You - Rockville BOH | Started empty; KMs setting it up. |
| `tnyrf` | Teas'n You - Rockville FOH | Started empty; KMs setting it up. |

| Goal | Command |
|---|---|
| Push + redeploy the web app (the default for any `.gs` or page change) | `python deploy.py --redeploy` |
| Push only (bound Sheet dialogs) | `python deploy.py` |
| One target | `python deploy.py --redeploy --target <slug>` |
| Dry run | `python deploy.py --dry-run` (add `--redeploy` to preview that step too) |
| Find deploymentIds on a fresh checkout | `python deploy.py --discover` |

---

## Live stores (stores.json)

10 entries, all with `"editor": "supabase"`. The template isn't published. Hub: `https://sebheh.github.io/mog-mobile/`.

| Slug | Concept | Location |
|---|---|---|
| `rpr` | Roll Play | Rosslyn BOH |
| `rprfo` | Roll Play | Rosslyn FOH |
| `rpt` | Roll Play | Tysons BOH |
| `rptfo` | Roll Play | Tysons FOH |
| `rpfr` | Roll Play | Founders BOH |
| `rpfrf` | Roll Play | Founders FOH |
| `tnyt` | Teas’n You | Tysons BOH |
| `tnytf` | Teas’n You | Tysons FOH |
| `tnyr` | Teas’n You | Rockville BOH |
| `tnyrf` | Teas’n You | Rockville FOH |

---

## Open issues / risks

- **CI runs the gates on GitHub's Linux runner** (`.github/workflows/gates.yml`), with LF files. Run `node tests/run_all.js` before every deploy anyway; the live URL is still the final check. Reproducing a CI-only failure: see [docs/MOG_ProjectNotes.md](MOG_ProjectNotes.md), CI and tests.
- **Two maintainers deploy from two computers.** `deploy.py`'s git check is the backstop: it refuses a copy that is behind `origin/main`. Whoever continues pulls the latest first.
- **`python3` on Windows** is the Microsoft Store stub; use `python` or `py`.
- **PowerShell PATH goes stale** after a `winget install` (see `CLAUDE.md` convention #7).
- **A store's `/exec` can rot or flake.** Test a freshly cut deployment before repointing: if it flakes too, it isn't rot (`mog-exec-repoint`).

---

## Architecture notes worth remembering

- **Two `CACHE_VERSION` constants**, `sw.js` (hub) and `template/sw.js` (stores), move independently. Bump the one whose shell changed.
- **`build.py` is idempotent.** It injects six placeholders into each store's page, `OrderMath.gs` among them, so the phone runs the server's order math verbatim. `--dry-run` previews; `--preview <slug> --like <slug>` builds a test store into `_preview/`.
- **The phone's live order quantity** calls `computeSuggestedQty_` from that injected copy and has no rounding of its own; `tests/phone_rounding.test.js` holds it there.
- **`deploy.py`:**
  - writes a temporary `apps-script/.clasp.json` per target, pushes, then cleans up;
  - is stdlib-only and serial on purpose;
  - treats source push and web-app redeploy as separate phases.

  The web app is the primary surface, so default to `--redeploy`.
- **All `apps-script/` files share one global scope.**
  - **17 `.gs`:** Admin, Concepts, Core, Dashboard, DbApi, Editor, Health, History, Items, MOGApi, OrderMath, PickPath, Recap, RecapEmail, ResetLog, Sync, Vendors.
  - **11 `.html`:** AdminReset, EditorHome, EditorShell, HealthCheck, ManageItems, ManageVendors, OrderHistory, ReorderPickPath, Setup, StorageAreas, Styles.
  - A `.gs` and an `.html` can't share a basename, which is why the server file is `Health.gs`.
- **Never put `.js` under `apps-script/`:** clasp pushes it to every store. Tests live in `tests/`.
- **`apps-script/.clasp-targets.json` is committed** with real Script IDs. They identify projects and aren't secrets; pushing still needs `clasp login`.
- **The `STORE_REGISTRY` marker** in root `index.html` is build-injected. Edit `stores.json`, never the line.
- **Every server function is private (`_`)** unless it's on the reviewed list in `tests/public_surface.test.js` (D18). Pages reach the server only through `webedit_call` and the auth layer.

---

## Recent significant changes

Most recent first. Keep about five; older rows move to the archive.

| Date | Session | Outcome |
|---|---|---|
| 2026-11-10 → 11-12 | Count screen backups, Sheet retirement steps 1 and 2 | A daily inventory spec was dropped for MarginEdge Spot sheets (lists in the RP KM Weekly repo). Count screen v0.32.0 (`6d1c225`): a main vendor off today puts its items on the backups, "Counted on [vendor]'s list today" (gate `count_lists` rewritten, 19 controls; Blueprint R35). Manage was finished in its own side session (next row). Sheet retirement spec (`e322e65`); step 1, the nightly off-site backup (`SebHEH/mog-backup`, run #5 green); step 2, schema v23, the Edge Function `close`, `pg_cron` every 15 minutes, the mail relay instead of Resend (`efc9ac2`, `2ef4a19`, `0697414`), shadow night 1 matched at all 10 stores, no store switched. Rules (`772492d`, `2aff545`): no one is told before a deploy or SQL, handoffs name no author, a deploy that changes nothing at a store needs no question. Detail: `docs/MOG_SessionHandoff_2026_11_12.md`. |
| 2026-11-11 | Finishing Manage (track B) | Mockups from live data (boards 7-10), approved as recommended (drag, the setup card takes its rows; spec U12). Storage areas and Shelf to Sheet as app-only pages (`getAreasPage`, `getShelfPage`, same saves); the Health check as the Overview's rows (`healthRows`) plus a Store checks line; its page and sidebar entry gone, `#healthcheck` to the Overview; links carry a filter to Items and Vendors. Gate `manage_pages` (38 total). Canary rprfo `ad95379`, checked by Sebastian, fan-out `3e37d02`, CI green; app v0.33.0, cache v76. The Sheet-retirement spec was started from here (`e322e65`). Detail: `docs/MOG_SessionHandoff_2026_11_12.md`. |
| 2026-11-05 → 11-06 | HQ routes (v21), inactive items stop them (v22), Claude runs schema files | Sebastian's shrimp link was refused (Send to stores still ran v16's rule; v20 kept retired fields as fallbacks), so: a routes spec, mockups and walkthrough, all approved; schema v21, a route on the store's item (HQ item, place, store vendor), every stock reader by route, HQ's Stores table (`commitHqRoutes`); live `5754aca` (smoke_v21 31/31, probe 129/129, cache v74). SHRIMP routed at Rosslyn and Founders BOH; the 11/5 hand count re-recorded as EL-0003/4. Schema v22: an inactive HQ item or a closed place stops its routes; run through the connector on Sebastian's go (smoke_v22 15/15, probe 133/133), `48c1b26`. The connector runs as postgres (measured); HQ invites for Donny and Dan (both roles). Mining run: `sqlgen.py`, `plant.py`, `wait_live.py` in the repo skills (`a609698`), global proposal filed. Gate `wh_routes` (37 total). Blueprint R34. Detail: `docs/MOG_SessionHandoff_2026_11_06.md`. |
| 2026-11-04 | HEH's stock at three places (W2c), and the week's smaller pieces | The TEST store's Elpis deliveries as SQL (`2aa7218`); HQ remembers a device (v18, `b8d3ac6`); the KM Tool Brief (`9f95318`); the wording pass (v0.30.1, `d6e999a`); a new storage area on every vendor's list (`700f46e`); checking in apart from ordering and Elpis on one page (v19, app v0.31.0 / cache v73, `fa4f694`). Then a reorientation (spec-first, two mockup rounds, a walkthrough, all as recommended): schema v20, places of three kinds, an item's places and low points, a holding store's Happy Supply order as a move, the close by place, `mog_wh_taken`; HQ's Stock, Items, Places and Who took what. Live: smoke_v20 37/37, probe 123/123, CI green. Gate `wh_places` (36 total). Blueprint R34. Commit `8fda25e`. Detail: `docs/MOG_SessionHandoff_2026_11_04.md`. |
| 2026-11-03 | Happy Supply W2b, HEH's stock held at Elpis | Live check first (W2a untried, Elpis three spellings), then the W2b walkthrough (recorded at the close, a receipt beyond the records goes through, HQ can mark one received, the warehouse role) and three mockup boards, all approved. Schema v17: `held_by`, `via`, deliveries EL-0001 in `mog.wh_orders`, the close's guarded step (`mog_sync_close_cycle` replaced, same signature), `mog_wh_held_receive`. HQ's Elpis page, "Stores order it from", "Held by", Send to stores for Elpis; the phone's "available at Elpis" and Elpis card (app v0.29.0, cache v70). Live: smoke_v17 47/47, probe 111/111, CI green, Pages live. Gate `wh_elpis` (32 total). Blueprint R33. Commit `42db1a9`. Donny's PR #7 (count screen, v0.30.0) merged on top and checked. Detail: `docs/MOG_SessionHandoff_2026_11_03.md`. |
| 2026-11-02 (later, 5) | The W2 spec, Happy Supply store orders (W2a) | Live check first (library cleared, B&T lined up, Elpis three spellings, Fall Chicken Pho real), then the W2 spec (no Approve step, cases available, over-order warned, Elpis as a location in W2b), the W2a design and three mockup boards, all approved. Schema v16: `mog.items.wh_product` in the item's row, `mog.wh_orders` / `wh_order_lines` (HS-0001), `mog_wh_send` / `mog_wh_received` (phone), `mog_wh_ship` / `mog_wh_order_cancel` (warehouse), `happySupply` in the 10-second read. `catalogEdit.js` `commitHqProduct`; HQ's Orders page and Send to stores; the phone's available, Send and Mark received (app v0.28.0, cache v69). Live: smoke_v16 50/50, probe 105/105, CI green, Pages live. Gate `wh_orders` (31 total). Blueprint R32. Commit `37588dd`. Detail: `docs/MOG_SessionHandoff_2026_11_02.md` (Later session 5). |
| 2026-11-02 (later, 4) | New LTO items first on Items, library tick boxes, vendor rename | The store's Items page pins each running LTO's items until set up (banner, chip, panel note; `catalogEdit.js` `ltoWaiting`). HQ Libraries: tick boxes, Remove, Send N items to stores without an LTO. Schema v15: a store renames a vendor with a rename step (items, lists, pick rows, today's counts and edits, HQ's names follow; a taken name refused). Live: smoke_v15 18/18, probe 96/96, CI green, Pages live. Gate `vendor_rename` (30 total). Blueprint R28, R31. Live stock for Happy Supply and Elpis left as open W2 questions. Commit `abce087`. Detail: `docs/MOG_SessionHandoff_2026_11_02.md` (Later session 4). |
