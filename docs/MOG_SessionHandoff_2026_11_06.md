# Session Handoff — HQ routes (v21), and inactive items stop them (v22)

**Session date:** 2026-11-06 (started 2026-11-05, after the 11-04 handoff)
**Author:** Sebastian
**Session focus:** Sebastian's HQ setup was refused ("HEH supply isn't on the other stores"), and he asked for a deep look at why HQ kept missing the logic he wanted.
**Outcome:**
- **Routes are live (schema v21, `5754aca`; smoke_v21 31/31, probe 129/129).** A store takes an HQ item by a route on its own item: the place and the store vendor. SHRIMP is routed at Rosslyn and Founders BOH.
- **v22 is live (`48c1b26`; smoke_v22 15/15, probe 133/133).** An inactive HQ item or a closed place stops its routes. It was the first schema Claude ran through the connector, on Sebastian's go.
- **The session mining run added three scripts to the repo skills (`a609698`)**, and one global proposal is filed.

**Next session focus:** check the 11-07 close, the first on v22 and the first that can record real SHRIMP deliveries from Tysons. Then RP Tysons' own route once Dan answers.

**STILL OUTSTANDING (since 2026-11-03/04):**
- The TEST store's open Elpis deliveries and W2a's first use.
- Dan's answer on ordering by the pound.
- Horse Pho (rprfotest, change 237) and TnY Tysons FOH's "ELPIS" rename.
- The blueprint entry for Donny's count-list rule (PR #7).
- The KM brief's three open questions.
- Who types RP Tysons' Sunday count, and who drives shrimp to Rosslyn and Founders.

---

## Section A — Routes (schema v21)

- **Why it was needed:** HQ's Send to stores still ran v16's Happy-Supply-only rule beside v20's places, so linking Rosslyn's shrimp from Tysons was refused. v20 had also kept `via`, a product's `par` and "Which stores can order it" alive as fallbacks.
  - Sebastian's remembered vendor names had been cleared with Forget, and the stock side still read them.
  - Diagnosed against the live data, then a routes spec, mockups and a walkthrough, all approved (`docs/MOG_Warehouse_Spec.md` §2, "Routes spec", "v21 design", "Built").
- **What a route is:** three fields on the store's item row: `wh_product`, `wh_place` (empty = HEH's own) and `wh_vendor` (a foreign key, so a rename follows and a removed vendor empties it).
  - It sits in the row, so Undo restores it.
  - Every stock reader reads the route, never HQ's remembered names: the close, the phone's read and Send.
- **HQ:** set on the item's Stores table (`catalogEdit.js` `commitHqRoutes`). One undoable change per store, with a new vendor or a new item allowed in the row, plus End and Put back.
  - Broken routes show on Stock's "Needs you".
  - Send to stores, Places' linking and the first-word guess are gone. `via`, `par` and `stores` are unread until v23.
- **Live:** run in the SQL Editor; the one-time fill routed only the TEST store's bowls and lids. Store cache v74.
- **SHRIMP:** Sebastian set Rosslyn BOH and Founders BOH from Transfer (Tysons), changes 391 and 392. Both phones read 84 available. RP Tysons waits for Dan.
- **The 11/5 transfer:** Sebastian had typed it as a count of -20, which Who took what would have read as RP Tysons' own use.
  - A one-off SQL (tested in PGlite against the live shape, run by Sebastian) put the 20 back.
  - It recorded the 11-04 order log as deliveries EL-0003 (Rosslyn) and EL-0004 (Founders), received at 10 each by HQ · Sebastian, as he said they got.
  - Tysons is at 84. November's Who took what shows Rosslyn 10, Founders 10, RP Tysons' own use 0.

## Section B — An inactive item or a closed place stops its routes (schema v22)

- **The gap:** found answering "can we remove items?". On v21 the close still recorded deliveries for an inactive HQ item or a closed place, and HQ showed an inactive item's routes as Linked.
- **The rule (walkthrough, "Stop and flag", build now):** a route moves stock only while its item is active and its place is open.
  - The close, the phone's read and Send skip the rest.
  - `routeStatus` adds "The item is inactive in HQ".
  - Unticking Active or Open names the stores whose routes stop (`warehouse.js` `routesStopped`).
  - Active again or reopened resumes them with no store change.
- **Defaults stated:**
  - a delivery recorded before still checks in;
  - a store that moved its main vendor still records what it orders under the route's vendor ("Needs you"'s help line says so now).
- **Checks:**
  - PGlite: every older smoke file passes; 5 planted SQL defects all caught.
  - `wh_routes`: 10 controls. Full gates: `run_all: ALL PASS (37 gates)`.
  - Preview by script: RP Large Bowls made inactive named 2 stores, then showed on "Needs you".
  - Live: smoke_v22 `15/15 PASS`, probe `133 passed, 0 failed`. HQ was live after about 4.5 minutes, and CI's gates were green.
- **`supabase/tests/test_store_elpis.sql`:** it still called v21's dropped `wh_held_vendor`. It now reads routes; 9 PGlite checks pass.

## Section C — How SQL runs now, HQ people, the mining run

- **The Supabase connector is not read-only.** It runs as `postgres` with read-only off (measured 11-06 with `select current_user, current_setting('transaction_read_only')`). The project notes had said `read_only=true`.
  - Sebastian's rule now (CLAUDE.md Supabase row and rule 7, `docs/MOG_ProjectNotes.md`, `mog-supabase-schema`): Claude runs a repo schema file and then its smoke through `execute_sql` on his go per file, and every other call is a select.
  - No hook (his call).
  - In claude.ai the write tools are on Always allow except Pause project (his setting; not checked from here).
  - There are no backups on the free plan.
- **HQ people:** Donny and Dan were invited, both with both roles. Dan's invite first went out as warehouse only, from an 11-01 note; it was fixed with `mog.hq_set_roles`, and the notes now say to ask Sebastian for each person's roles.
  - Neither has claimed a code yet (checked 11-06).
- **Session mining run:** three scripts that were rewritten every session now live in the repo skills (`a609698`).
  - `mog-supabase-schema/scripts/sqlgen.py`: rebuilds `schema_v22.sql` byte for byte.
  - `mog-supabase-schema/scripts/plant.py`: catches v22's 5 plants; refuses a broken plant and a wrong count.
  - `mog-deploy-workflow/scripts/wait_live.py`: both refusals, two live passes.
  - Global proposal `supabase-schema-change-2026-11-06` filed.

## Outstanding (carry forward)

1. **The 11-07 close** (3:30 AM, the first on v22). Check read-only that every store's cycle moved to 11-07. If Rosslyn or Founders ordered SHRIMP from Transfer (Tysons) on 11-06, they each get a delivery; their phones show "To check in", and checking in takes it off Tysons.
2. **Dan and Donny claim their invites** at https://sebheh.github.io/mog-mobile/hq/ ("I have an invite code"). A code lasts 24 hours from the 11-05 evening run; `select mog.hq_invite('<name>', '{hq,warehouse}');` issues a new one.
3. **RP Tysons' own route** (Happy Supply → Tysons, its SHRIMP par to about 19). It waits for Dan: pound ordering and Happy Supply's delivery days.
4. **Schema v23:** drop `wh_products.via`, `par`, `stores` around 11-12, after a week of v21 live. Retire fully (rewrite older smoke rows), and search the repo first.
5. **Rosslyn's 11-04 SHRIMP:** ordered from both SamuelSon (9) and Transfer (Tysons) (9). Ask the KMs whether SamuelSon sent 9 too.
6. **The TEST store:**
   - Sebastian ended the bowls' route (a test of End); the lids are still routed from Elpis;
   - its 11-02/11-03 Elpis deliveries are still open;
   - `test_store_elpis.sql` now orders only the lids.
7. **Borderline skill candidates** (wait for another occurrence): a saved read-only morning-close query; a PGlite test of a one-off live data fix against the live shape.
8. **From earlier, still open:** the STILL OUTSTANDING block above, plus:
   - HQ's `logic.heldStock` is used only by the `wh_elpis` gate;
   - Rosslyn FOH has a vendor "testtt";
   - the Apps Script dialog wording waits for the next Apps Script deploy (canary rprfo, `--redeploy`).

## Files touched this chat

- **Supabase:**
  - `schema_v21.sql`, `schema_v22.sql` (new);
  - `tests/smoke_v21.sql`, `tests/smoke_v22.sql` (new);
  - older smoke files moved to routes: smoke_v13, v16, v17, v19, v20;
  - `tests/check_api.sh` (v21 and v22 blocks), `tests/test_store_elpis.sql` (reads routes).
- **HQ and editor:** `template/hq/warehouse.js`, `template/hq/index.html`, `template/editor/catalogEdit.js`.
- **Phone:** `template/sw.js` (cache v74).
- **Tests:**
  - `tests/wh_routes.test.js` (new);
  - `tests/fake_supabase.js`, `wh_orders`, `wh_elpis`, `wh_places`, `elpis_setup`, `lto`, `tests/preview_server.js`.
- **Generated (`build.py`):** every store's `sw.js` and `editor/catalogEdit.js`; `hq/`.
- **Skills (repo-local):**
  - `mog-supabase-schema`: rules, the go-per-file runs, `scripts/sqlgen.py`, `scripts/plant.py`;
  - `mog-deploy-workflow`: `scripts/wait_live.py`, the Supabase row.
- **Docs:**
  - `CLAUDE.md`, `docs/MOG_CurrentState.md`, `docs/MOG_ProjectNotes.md`, `docs/MOG_Warehouse_Spec.md`;
  - `docs/MOG_LogicBlueprint.md` and `.html` (R34 routes and v22, the Item entity's route, stamp `a609698`);
  - this handoff.
- **Outside the repo:**
  - the MOG HQ redesign canvas (Routes boards);
  - the global proposals `architectural-walkthrough-2026-11-05` and `supabase-schema-change-2026-11-06`;
  - the mining log;
  - scratchpad: the one-off shrimp SQL and its PGlite check, the v21/v22 generators and plants.

## Process lessons

- A retired field kept alive as a fallback (v20's `via`, `par`, stores) let an old rule keep refusing a new setup. Retire fully and rewrite the older smoke rows. [→ mog-supabase-schema]
- Mockups that show screens without walking the real task end to end missed the refusal Sebastian hit; a carried-over screen needs re-checking against the new model. [→ proposal]
- The connector was believed read-only for weeks; one query showed it runs as `postgres`. Measure a system's mode before stating it. [→ mog-supabase-schema, docs/MOG_ProjectNotes.md, proposal]
- Dropping a function broke a helper SQL file the PGlite chain never runs. Search the repo before a drop. [→ mog-supabase-schema, proposal]
- A permission default taken from an old note (Dan's warehouse-only role) was wrong. Ask for each person's roles. [→ docs/MOG_ProjectNotes.md]
- The schema generator, the defect planter and the Pages/CI poll were rewritten from scratch in 5 to 9 sessions each. [→ .claude/skills/mog-supabase-schema/scripts/sqlgen.py, .claude/skills/mog-supabase-schema/scripts/plant.py, .claude/skills/mog-deploy-workflow/scripts/wait_live.py]
- A hand workaround (a count of -20 for a transfer) skewed Who took what until it was re-recorded. Read the live moves after a first real setup. [→ one-off]

**Skill gate:** nothing new to ask. Every lesson was routed during the session: the skill rules, the three scripts and the proposals, each approved in that turn's picker. Checked: the Process lessons above; Sebastian's corrections (Dan's role, the connector's write access, no hook, the 11 connector tools left allowed except Pause project); no rejected tool uses.

## Commits landed this session

```
a609698 Skills: sqlgen.py, plant.py and wait_live.py, from the session mining run
48c1b26 An inactive HQ item or a closed place stops its routes (schema v22)
ba550c8 docs: HQ people's roles come from Sebastian; Dan has both
cf22c1b docs: schema v21 (routes) is live
5754aca Routes: a store takes an HQ item by route (schema v21)
```

Plus this handoff's commit.

## Opening prompt for next session

```
Read docs/MOG_CurrentState.md and docs/MOG_SessionHandoff_2026_11_06.md first, and run git pull.
Routes (v21) and the stop rule (v22) are live: SHRIMP is routed at Rosslyn and Founders BOH from Transfer (Tysons); an inactive HQ item or a closed place stops its routes. Claude now runs schema files through the Supabase connector on my go per file (it runs as postgres; every other call is a select).
Check read-only first: did the 11-07 close run at every store, and did it record any SHRIMP delivery from Tysons? Have Dan and Donny claimed their HQ invites?
Next: RP Tysons' own route once Dan answers on pound ordering, then schema v23 (drop via, par, stores) around 11-12. Use sqlgen.py and plant.py (mog-supabase-schema) for the schema and wait_live.py (mog-deploy-workflow) after the push.
STILL OUTSTANDING since 11-03/04: the TEST store's Elpis deliveries and W2a's first use, Dan's pound answer, Horse Pho, TnY Tysons FOH's ELPIS rename.
```
