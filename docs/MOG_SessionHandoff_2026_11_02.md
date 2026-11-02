# Session Handoff — Concept library, HQ redesign

**Session date:** 2026-11-01 → 11-02 (the commits landed late on 11-01)
**Author:** Sebastian
**Session focus:** build the concept library (`docs/MOG_Warehouse_Spec.md` §1): one standard item list per concept and side, kept in HQ, which a new store's order guide starts from.

**Outcome:** the library is live (schema v12, commit `67cccb0`). HQ was then redesigned from Sebastian's feedback into the order guide's computer look with the HEH brand (commit `84ac2cb`).
- **Checks:** smoke_v12 21/21 PASS live; probe 74/74; 27 gates pass, locally and in CI.
- **Pages:** the new `/hq/` is live, and its HEH logo loads.
- **Live use so far:**
  - Sebastian is signed up in HQ.
  - One TEST rollout ran on rprfotest (10:10 PM 11-01, on the page before the redesign).
  - No library is started yet.

**Next session focus:** start and clean the four libraries in HQ, then set up a store from one (Rockville BOH is empty).
**Later session (same day, Sebastian):** Happy Supply W1 built and live (schema v13). See "Later session" at the end.

---

## Section A — The concept library (schema v12, commit `67cccb0`)

- **Decisions (Sebastian):**
  - Build now, test before use.
  - Seeds: Rosslyn BOH and FOH (rpr, rprfo) for Roll Play; Tysons BOH (tnyt) and Rockville FOH (tnyrf) for Teas'n You.
  - Setup items arrive with **no area, like an LTO**. Sebastian picked this over the recommended "library's areas, no par", so `commitHqRollout` didn't change.
- **Data** (`supabase/schema_v12.sql`):
  - `mog.stores.side` (BOH/FOH), read from the location name by `mog.side_from_location` and the `stores_side_fill` trigger. All 11 stores have one.
  - `mog.libraries` (one per concept and side, versioned) and `mog.library_items`: name, pack, main vendor, backups, notes. No par, area or stock.
  - `mog.library_log` keeps `items_before` for every save. A wrong save is put back from it in the SQL Editor; there's no Restore button.
- **Saving:**
  - `mog.library_put`: the whole list, refused with CONFLICT when the version moved.
  - It runs inside `mog_hq_apply`'s new 4-argument form (`p_libraries`), in the same all-or-none transaction as the store changes.
  - The 3-argument form now wraps it.
  - `mog_hq_data` returns each store's side and the libraries.
- **Rules live in `catalogEdit.js`:**
  - `cleanLibrary`: names unique ignoring case, a main vendor required, backups without the main vendor.
  - `librarySeed`: active items with a vendor; a name listed twice is merged, its other vendors become backups.
  - `libraryAdd` and `libraryLabel`.
- **Setting up a store from a library** goes through `commitHqRollout`, exactly like an LTO.
- **Gates:**
  - `tests/fake_supabase.js` mirrors v12, including jsonb's key order on reads.
  - New gate `concept_library` with five planted-defect controls (27 gates).
- **Checked before hand-over:** the whole chain `schema.sql`…`schema_v12.sql` plus smoke_v6…v12 ran in PGlite (Postgres in Node) from the scratchpad, including a re-run and a planted defect (version check removed, 6 rows FAIL).
- **Blueprint:** new R29, a Concept library entity, the Store's side, and the growth seam updated (`current_as_of 84ac2cb`).

## Section B — HQ redesign (commit `84ac2cb`)

- **Why:** Sebastian's feedback on the v12 page:
  - backups should be click-to-pick, not free text;
  - the main vendor should be a dropdown with no typing;
  - stores should be picked as a concept first, then that concept's stores;
  - the page should use the HEH brand and match the computer order guide.
- **The mockup came first**, and Sebastian approved it: "MOG HQ redesign", https://claude.ai/artifact/3pJWHSWbMxVUyaRjmXkXqg. Its Happy Supply screens wait for warehouse W1 and W2.
- **`template/hq/index.html` rewritten:**
  - **Shell:** a sidebar with Roll out, Libraries, Vendors, Vendor names and Recent changes, and the HEH logo.
  - **Picking stores:** a concept, then a grid of its stores by side, with TEST apart.
  - **Vendor choices:**
    - the main vendor is a dropdown only, so a brand-new vendor goes in through Vendors first;
    - backups are chips.
  - **Vendor at each store:** one block shared by Roll out and Set up. It offers the other side's delivery days when that store already has the vendor.
  - **Libraries:**
    - a list beside an item panel, one versioned save per item;
    - an "At one store only" filter, shown only when the side has two or more stores;
    - "At the X stores today" for each item.
  - **Set up stores from it** is its own page.
- **The rules didn't change:** every store's change is still `commitHqRollout`.
- **`build.py`** copies `template/hq/*.svg` into `hq/`: the brand kit's HEH logo and the Roll Play and Teas'n You marks.
- **Checked against the fake Supabase, by script only:**
  - every flow;
  - no console errors;
  - no sideways scroll at 375 px.

  The browser pane was hidden, so nobody has seen the layout on a screen.

## Outstanding (carry forward)

1. **Sebastian, in HQ** (https://sebheh.github.io/mog-mobile/hq/):
   1. Undo the TEST rollout "Horse Pho" in rprfotest's Manage → Changes. It added vendors B&T and Baldor and two items, and its Undo is still untested.
   2. Look at the new page: this is the first time it's on a real screen.
   3. Start the four libraries (Libraries → pick concept and side → Start from a store → Save as the library): Roll Play BOH from Rosslyn BOH, Roll Play FOH from Rosslyn FOH, Teas'n You BOH from Tysons BOH, Teas'n You FOH from Rockville FOH.
   4. Clean them: "At one store only" finds store-only items.
   5. Set up one store from its library. Rockville BOH is empty; Tysons BOH is being set up by its KMs and is the Teas'n You BOH seed.
2. **Tell Donny:** schema v12 is taken, so his audit fix moves to v13. The work order says so; whether he's been told isn't recorded.
3. **Happy Supply:** add it to the Roll Play stores through HQ Roll out, once its delivery days are known. Then the warehouse W1 and W2 (spec §2).
4. **Commit the local test tools** (proposal card in this session):
   - the PGlite SQL runner;
   - the fake-Supabase preview, built a third time this session, this time for `/hq/` on port 8772.
5. **Still open:** the HQ token can change any catalog row at any store and now any library, so invite only maintainers until a narrower role exists. Also everything in `docs/MOG_CurrentState.md`'s candidates 3-9, plus the 11-01 handoff's contact gaps and the Downloads CSV with passwords.

## Files touched this chat

- **Supabase:**
  - `supabase/schema_v12.sql` (new; `mog_hq_data` and `mog_hq_apply` generated from v11 with asserted replacements);
  - `supabase/tests/smoke_v12.sql` (new);
  - `supabase/tests/check_api.sh` (v12 block).
- **Editor rules:** `template/editor/catalogEdit.js` (`cleanLibrary`, `librarySeed`, `libraryAdd`, `libraryLabel`).
- **HQ:** `template/hq/index.html` (the Libraries tab, then the full redesign); `template/hq/heh-logo.svg`, `rp-mark.svg`, `tny-mark.svg` (new, from the brand kit).
- **Build:** `build.py` (`generate_hq` copies the SVGs).
- **Tests:** `tests/fake_supabase.js` (v12); `tests/concept_library.test.js` (new).
- **Docs:**
  - `docs/MOG_Warehouse_Spec.md` (§1 built, its decisions);
  - `docs/MOG_SupabaseMigration.md` (§7 rows);
  - `docs/MOG_ProjectNotes.md` (HQ libraries, the redesigned page, jsonb key order, Tysons BOH being set up, three lessons from this handoff);
  - `docs/MOG_LogicBlueprint.md` and `.html` (R29, the Concept library entity, the Store's side, the growth seam);
  - `docs/MOG_CurrentState.md`; `CLAUDE.md` (inventory, this handoff);
  - `MOG_ClaudeCodeTask_2026_10_30.md` (Donny's fix moves to v13).
- **Generated:** `hq/` (page, `catalogEdit.js`, SVGs) and every store's `editor/catalogEdit.js`.
- **Outside the repo (scratchpad):**
  - `gen_v12.py`;
  - the PGlite runner (`pgrun/`);
  - the HQ preview server (`hqprev/`);
  - the mockup files (`hqmock/`).

## Process lessons

- A new screen got built from the walkthrough with no mockup, and Sebastian sent its UI back (free-text vendors, three concept boxes). The mockup round that followed went through in one pass. [→ proposal architectural-walkthrough-2026-11-02]
- A choice among known values is pick-only on MOG's computer pages (a dropdown or chips, never free text beside a list), and new computer pages use the order guide's computer look with the HEH brand. [→ docs/MOG_ProjectNotes.md]
- A jsonb list read back from Postgres comes in jsonb's key order. The fake has to send the same order, or a gate never sees a raw-JSON compare make an untouched draft look changed. [→ mog-supabase-schema]
- Running the schema chain and the smoke file in PGlite before hand-over made the live run a formality (21/21 first time). Expected local failures: `smoke.sql`, `smoke_v2`, `smoke_v4` (v1 assertions changed by v3; ICU collation). [→ mog-supabase-schema]
- The GitHub runs API lists the Pages deploy run beside "gates", so a wait loop has to match the run by name. Mine first stopped on Pages' "completed". [→ docs/MOG_ProjectNotes.md]
- `build.py` once failed with OSError Errno 22 writing a store's `editor/` file (a passing Windows file lock); the rerun worked. [→ docs/MOG_ProjectNotes.md]
- The fake-Supabase preview was rebuilt a third time, for `/hq/`; it's candidate 2 there, and a proposal card in this session. [→ docs/MOG_CurrentState.md]

- Sebastian picked "No area, like an LTO" over the recommended "library's areas, no par": the simpler option that reuses the tested rollout path; it's recorded in blueprint R29 and the warehouse spec. [→ one-off]

**Skill gate:** one picker round, three questions, all Apply: the jsonb-list read order into `mog-supabase-schema`'s rules; the PGlite local run into its ship order (now, not after the runner is committed); proposal `architectural-walkthrough-2026-11-02` (a mockup as step one for any change that adds a screen). Not asked: the area pick (one-off) and the three project facts that went to the project notes.

## Commits landed this session

```
84ac2cb HQ redesign: the order guide's computer look with the HEH brand
67cccb0 Concept library (schema v12): each concept's standard items per side, kept in HQ
```

## Opening prompt for next session

```
Read docs/MOG_CurrentState.md and docs/MOG_SessionHandoff_2026_11_02.md first, and run git pull.
The concept library (schema v12) and the redesigned HQ (/hq/, commit 84ac2cb) are live; 27 gates.
Sebastian is signed up in HQ and ran one TEST rollout ("Horse Pho" on rprfotest), not yet undone;
no library is started. Ask first what he saw on the new HQ page and whether the four libraries are
started. Then either fix what the page needs, or add Happy Supply to the Roll Play stores through
HQ and begin the warehouse (docs/MOG_Warehouse_Spec.md §2) with an architectural walkthrough.
```

---

## Later session — Happy Supply W1, the warehouse

**Author:** Sebastian
**Session focus:** record Sebastian's answers on the new HQ page and the libraries, then design the warehouse (`docs/MOG_Warehouse_Spec.md` §2) and build its first phase, W1.
**Outcome:** W1 is live.
- Schema v13 adds HQ roles, the warehouse tables and nine `mog_wh_*` calls; HQ has Happy Supply pages.
- Sebastian ran v13 and smoke_v13 in the SQL Editor: 44/44 PASS. `check_api.sh`: "88 passed, 0 failed".
- Commits `f7352c3` and `aa48f85` are pushed; CI `gates` passed, including the new SQL step; Pages published `hq/warehouse.js`.
- Sebastian saw Happy Supply on the live page: "It shows, looks right". The warehouse holds no data yet.

**STILL OUTSTANDING (since 2026-11-02, the session above):**
- Undo the TEST rollout "Horse Pho" (rprfotest, change 237): still not undone, checked live this afternoon.
- Start the four libraries: none started (no rows in `mog.libraries`).
- Tell Donny which schema number is taken: now v13.

**Next session focus:** invite Chef Dan with the warehouse role and enter the first count; then W2 (store orders).

### Sebastian's answers and decisions

- **The redesigned HQ page:** seen on a screen, looks right, no changes.
- **Libraries:** none started (read-only check, not asked).
- **Walkthrough scope:** W1 and W2's data in one design, build W1 first.
- **Happy Supply at the Roll Play stores:** with W2's first products, in one HQ rollout per store (vendor and items in one change, one Undo), not now.
- **In the walkthrough (all four picks):**
  - approve the design, mockup next;
  - stock never below 0: a ship or transfer that would is refused until Dan counts;
  - commit the PGlite runner, so CI runs the real SQL;
  - schema numbers aren't held for a person: "either one of us can do it". Whoever writes the next schema file first takes the next number.
- **The W1 mockup** (three boards on the "MOG HQ redesign" canvas): approved, "build W1".

### What shipped

- **The design**, in `docs/MOG_Warehouse_Spec.md` §2 "Design: W1, with W2's data":
  - W1's tables and calls;
  - W2's tables designed (the store's Happy Supply vendor, an item's link to a product, store orders with the price locked at ship);
  - the rules live in the SQL, not the page: the handling fee never reaches a store, and two tabs can't take the same stock twice.
- **Schema v13** (`supabase/schema_v13.sql`):
  - **Roles:** `mog.hq_users.roles` (`hq`, `warehouse`). It is added once, with both roles for everyone already invited, so a re-run never widens anyone. `mog.hq_invite(name, roles)` and `mog.hq_set_roles` are for the SQL Editor only.
  - **The catalog calls answer only the hq role:** `mog.hq_session`, which `mog_hq_data` and `mog_hq_apply` call first, now checks it. No HQ function body was regenerated. Signing in returns the roles.
  - **Tables:** `wh_locations`, `wh_suppliers`, `wh_products`, `wh_stock` (never below 0), `wh_moves` (every change, never edited), `wh_pos` / `wh_po_lines`, `wh_transfers` / `wh_transfer_lines`, `wh_settings`.
  - **Calls:** `mog_wh_data`, `_history`, `_save`, `_po_save`, `_po_cancel`, `_po_receive`, `_transfer_send`, `_transfer_receive` and `_count`. Each write answers with the whole warehouse.
  - **The average cost** covers every location and what's in transit, to 4 decimals (`mog.wh_avg_after`).
  - **Numbers** (PO-0001, TR-0001) come from the rows there, not a sequence, so the smoke runs on the live database without using one up.
- **HQ page:**
  - `template/hq/warehouse.js`: Inventory with Count a location, Incoming, Products and prices, Stock history.
  - `template/hq/index.html` signs in with roles and shows each person their sections; a sign-in from before v13 asks for both.
  - `build.py` copies `template/hq/*.js` into `hq/`.
  - Two changes from the mockup: "Shipments" became "Incoming", and Orders and Chargebacks wait for W2 and W3.
- **Checks:**
  - `smoke_v13.sql` (44 rows) and a v13 block in `check_api.sh` (14 probes);
  - `tests/fake_supabase.js` mirrors v13;
  - new gate `warehouse` (the page's sums and payloads against the fake, 6 planted-defect controls; 28 gates).
- **The real SQL in CI:**
  - `supabase/tests/run_pglite.mjs`, with `package.json` and its lockfile (PGlite 0.3.16 pinned).
  - It runs the schema chain and every smoke file, then the newest schema again, and fails if any row changed.
  - It skips what PGlite can't pass, with the reason: `smoke.sql`, `smoke_v2`, `smoke_v4` and two rows of `smoke_v7`.
- **Blueprint:** R30 (the warehouse), the Warehouse product entity, R28's hq role and the growth seam; `current_as_of f7352c3`.

### Validation

- **PGlite, local and CI:** "PASS  smoke_v13.sql: 44/44 PASS", "ok    schema_v13.sql (again), no row changed", "run_pglite: ALL PASS". CI run 41469727917: every step success, including "Run node supabase/tests/run_pglite.mjs".
- **Planted SQL defects** (in a scratch copy), each caught:
  - below zero allowed;
  - the average leaving out what's in transit;
  - `hq_session` ignoring the role;
  - a count with no reason;
  - a re-run widening roles ("changed rows in: hq_users").
- **Gates:** "run_all: ALL PASS (28 gates)"; "warehouse: ALL PASS", all 6 controls biting.
- **Live:**
  - smoke_v13 44/44 PASS (Sebastian's paste);
  - `check_api.sh`: "88 passed, 0 failed";
  - read-only: 9 `mog_wh_*` calls, Sebastian `["hq","warehouse"]`, no smoke rows left, the public key can't read `mog.wh_stock`.
- **Browser, against the fake:**
  - as Dan and as Sebastian: a count, a receipt with a short line, a refused transfer, a transfer sent and received, a product, a supplier, the settings, the history;
  - no console errors, no sideways scroll at 375 px.
  - On the live page Sebastian saw the section; nobody has entered data there.

### Outstanding (carry forward)

1. **Sebastian:** tell Donny v13 is taken.
2. **Sebastian:** invite Chef Dan when ready.
   - **Supabase SQL Editor:** `select mog.hq_invite('Dan', '{warehouse}');`, then give him the code.
   - He adds the locations (Berliner, Tysons freezer), suppliers and products, then a first count per location.
   - Never give Dan the hq role: an HQ sign-in can change every store.
3. **Before W2 (store orders):**
   - Dan confirms that no store orders crab or shrimp by the pound (a linked item orders in the product's case).
   - Sebastian decides whether a store order needs an Approve step (the mockup has New, Approved, Shipped; the spec has sent, shipped, received).
   - Price detail: a store's price uses the average to 4 decimals, so it can differ by a cent from the 2-decimal figures shown.
4. **W1 has no Undo.** A wrong delivery cost needs a maintainer in the SQL Editor; `mog.wh_moves` keeps each cost, so the average can be replayed.
5. **The fake-Supabase preview** was rebuilt a fourth time, for the warehouse, and is still not committed (CurrentState candidate 3).
6. **From the session above:** the Horse Pho undo and the four libraries (STILL OUTSTANDING, top of this section).

### Files touched (later session)

- **Supabase:** `supabase/schema_v13.sql` (new), `supabase/tests/smoke_v13.sql` (new), `supabase/tests/check_api.sh` (v13 block), `supabase/tests/run_pglite.mjs` (new).
- **HQ:** `template/hq/warehouse.js` (new), `template/hq/index.html` (roles, the Happy Supply section, styles).
- **Build and CI:** `build.py` (copies `template/hq/*.js`), `.github/workflows/gates.yml` (the SQL step), `package.json` and `package-lock.json` (new).
- **Tests:** `tests/fake_supabase.js` (roles, the warehouse), `tests/warehouse.test.js` (new).
- **Docs:**
  - `docs/MOG_Warehouse_Spec.md` (the design, decisions, W1 built and live);
  - `docs/MOG_SupabaseMigration.md` (§7 rows);
  - `docs/MOG_ProjectNotes.md` (Happy Supply, PGlite in CI, a stale screenshot);
  - `docs/MOG_LogicBlueprint.md` and `.html` (R30);
  - `docs/MOG_CurrentState.md`, `CLAUDE.md`.
- **Skills:** `.claude/skills/mog-supabase-schema/SKILL.md` (the committed PGlite check; numbers from rows).
- **Generated:** `hq/index.html`, `hq/warehouse.js`.
- **Outside the repo:**
  - the "MOG HQ redesign" canvas: three W1 boards (https://claude.ai/artifact/3pJWHSWbMxVUyaRjmXkXqg);
  - scratchpad: the warehouse preview server and the planted-defect script.

### Process lessons

- Checking the live database read-only before asking turned "are the libraries started?" into a stated fact, so the picker asked only what a person sees. [→ docs/MOG_ProjectNotes.md]
- A bash heredoc stripped the backslashes of an escaped quote in a Python edit to `tests/fake_supabase.js` (a parse error, fixed with the Edit tool): the Windows rule in the project notes was missed again. [→ docs/MOG_ProjectNotes.md]
- Every smoke file cleans up its own rows, so no smoke can see a re-run that rewrites data. A per-table row digest around the re-run caught the planted "re-run widens roles". [→ supabase/tests/run_pglite.mjs, mog-supabase-schema]
- Numbers a person sees come from the rows there, not a sequence, so a smoke on the live database uses none up. [→ mog-supabase-schema]
- A browser screenshot showed the page before a click that had worked; reading it with `javascript_tool` told the truth. [→ docs/MOG_ProjectNotes.md]
- Two `smoke_v7` rows can't pass in PGlite: a check reads what its own call wrote in the same statement. The runner skips them by name, with the reason. [→ supabase/tests/run_pglite.mjs]
- Schema numbers aren't held for a person (Sebastian: "either one of us can do it"): whoever writes the next file first takes the next number and tells the other. [→ mog-supabase-schema]
- A gate's pinned value worked out by hand was wrong (77.5926; Postgres says 77.5968). A number a gate pins against the SQL comes from running the SQL. [→ mog-supabase-schema]

**Skill gate:** one picker round, two questions, both Apply: schema numbers aren't held for a person, and a pinned value comes from running the SQL, both into `mog-supabase-schema` (with its stale "schema v9" line fixed). Not asked: the PGlite runner's re-run digest, numbers from rows and the smoke_v7 skip (already in `aa48f85`), and the project facts that went to the project notes (live check before asking, heredoc backslashes, a stale screenshot).

### Commits landed (later session)

```
aa48f85 skills: mog-supabase-schema runs the committed PGlite check
f7352c3 Happy Supply W1 (schema v13): the warehouse in HQ, with roles
```

Plus this handoff's commit, and `0cf9aee` (the session before, pushed with these).

### Opening prompt for next session

```
Read docs/MOG_CurrentState.md and the "Later session" of docs/MOG_SessionHandoff_2026_11_02.md first, and run git pull.
Happy Supply W1 (schema v13) is live and empty: HQ roles (hq, warehouse), the warehouse's stock,
vendor orders in, transfers, counts; CI now runs the real SQL in PGlite; 28 gates.
STILL OUTSTANDING: undo the TEST rollout "Horse Pho" on rprfotest, start the four libraries,
tell Donny v13 is taken. Ask first whether Chef Dan is invited (warehouse role only) and has
entered a first count. Then either help with that, or start W2 (store orders,
docs/MOG_Warehouse_Spec.md §2) with an architectural walkthrough: it needs Dan's answer on
pound-ordered items and Sebastian's call on an Approve step.
```
