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
**Later session 2 (same day, Sebastian):** the local preview server and the slicer on Windows (PR 6). See "Later session — the local preview server".
**Later session 3 (same day, Sebastian):** LTOs, the HQ side (schema v14, live). See "Later session 3".
**Later session 4 (same day, Sebastian):** new LTO items first on Items, library tick boxes in HQ, vendor rename (schema v15, live). See "Later session 4".
**Later session 5 (same day, Sebastian):** the W2 spec, then Happy Supply store orders, W2a (schema v16, live). See the last section.

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
2. **Happy Supply:** add it to the Roll Play stores through HQ Roll out, once its delivery days are known. Then the warehouse W1 and W2 (spec §2).
3. **Commit the local test tools** (proposal card in this session):
   - the PGlite SQL runner;
   - the fake-Supabase preview, built a third time this session, this time for `/hq/` on port 8772.
4. **Still open:** the HQ token can change any catalog row at any store and now any library, so invite only maintainers until a narrower role exists. Also everything in `docs/MOG_CurrentState.md`'s candidates 3-9, plus the 11-01 handoff's contact gaps and the Downloads CSV with passwords.

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

1. **Sebastian:** invite Chef Dan when ready.
   - **Supabase SQL Editor:** `select mog.hq_invite('Dan', '{warehouse}');`, then give him the code.
   - He adds the locations (Berliner, Tysons freezer), suppliers and products, then a first count per location.
   - Never give Dan the hq role: an HQ sign-in can change every store.
2. **Before W2 (store orders):**
   - Dan confirms that no store orders crab or shrimp by the pound (a linked item orders in the product's case).
   - Sebastian decides whether a store order needs an Approve step (the mockup has New, Approved, Shipped; the spec has sent, shipped, received).
   - Price detail: a store's price uses the average to 4 decimals, so it can differ by a cent from the 2-decimal figures shown.
3. **W1 has no Undo.** A wrong delivery cost needs a maintainer in the SQL Editor; `mog.wh_moves` keeps each cost, so the average can be replayed.
4. **The fake-Supabase preview** was rebuilt a fourth time, for the warehouse, and is still not committed (CurrentState candidate 3). Done later the same day: PR 6, the last section.
5. **From the session above:** the Horse Pho undo and the four libraries (STILL OUTSTANDING, top of this section).

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
STILL OUTSTANDING: undo the TEST rollout "Horse Pho" on rprfotest, start the four libraries.
Ask first whether Chef Dan is invited (warehouse role only) and has
entered a first count. Then either help with that, or start W2 (store orders,
docs/MOG_Warehouse_Spec.md §2) with an architectural walkthrough: it needs Dan's answer on
pound-ordered items and Sebastian's call on an Approve step.
```

---

## Later session — the local preview server, the slicer on Windows

**Author:** Sebastian (a side session started from the session above)
**Session focus:** commit the fake-Supabase preview that sessions kept rebuilding in the scratchpad (CurrentState candidate 3).
**Outcome:** PR 6 is merged (`35cb81c`).
- `tests/preview_server.js` serves the built app, editor and HQ against the fake Supabase; `preview_start` "mog-preview" starts it.
- The slicer self-test now passes on Windows worktrees, so `node tests/run_all.js` passes in a fresh one: 28 gates.
- CI `gates` passed on the branch push and on the pull request.

**Next session focus:** unchanged from the session above (Chef Dan and the first count, then W2), now with the preview to click through it.

### What shipped

- **The preview server** (`tests/preview_server.js`, commit `8ea3603`):
  - `http://127.0.0.1:8770/` lists everything: the store app at `/rprfotest/` (PIN 1111) with the editor inside it, and HQ at `/__signin?who=both|hq|warehouse` (Sebastian, Donny, Dan). `/__token?who=` returns a token.
  - Six fake stores. The app's store is a `makeStore(10, {realistic: true})` Sheet moved through `Sync.gs`, as `history_app` does: readable item names, four storage areas, today's cycle and an order log. HQ has four more stores with items and an empty one; Happy Supply has the W1 mockup's sample.
  - It rebuilds `_preview/rprfotest/` at every start and serves the built `hq/`, saying when `hq/` no longer matches `template/hq/`.
  - Nothing reaches a real store: the `Sync.gs` Supabase address is swapped for the server's in every page served, and a page still naming a `supabase.co` address is refused.
  - `.claude/launch.json` "mog-preview" (127.0.0.1, never localhost); `tests/run_all.js` lists it as a helper; `docs/MOG_ProjectNotes.md` (Local previews) replaces the hand-built recipe.
- **The slicer self-test on Windows** (`tests/slice_js_selftest.js`, commit `94d496d`): a new desktop-app worktree checks `tests/slice_js.js` out with CRLF, and the three controls whose anchors span lines found nothing, so `run_all` failed in every new worktree (CI and the main checkout have LF). The controls now take the file's own line ending, as `plant()` does.

### Validation

- **Browser pane, against the fake** (hidden pane, driven by script at 1280×800):
  - the app's sign-in and a vendor's count;
  - all seven Manage pages, a storage-area save and its entry in Changes, Settings → Recipients;
  - HQ as each of the three people, and Happy Supply's four pages.

  No console errors from the pages.
- **The guard:** a planted file naming another `supabase.co` address got a 500; a path outside the served folders got a 404. After a restart, a signed-in app signs in again by itself.
- **Gates:** "run_all: ALL PASS (28 gates)" in a CRLF worktree. The slicer self-test passes 35 checks and 9 controls on CRLF and on LF; a missing anchor and a control that plants nothing still fail on both.
- **CI:** `gates` success on the branch push and on PR 6.

### Outstanding (carry forward)

1. **Sebastian, in the desktop app:** confirm this repo's origin (Help → Troubleshooting → Review Pinned Git Origins). Until then the app won't merge `main` into a worktree when `main` changed a skill; this handoff was written in a docs-only worktree from `main` for that reason.
2. **Optional:** this computer has no GitHub CLI, so a pull request is opened by hand from the compare link and the app can't follow its CI. Installing `gh` and running `gh auth login` lets sessions open the PR and the app watch it.
3. **From the sessions above:** everything in their lists, unchanged.

### Files touched (this session)

- **New:** `tests/preview_server.js`.
- **Changed:** `tests/run_all.js` (HELPERS), `tests/slice_js_selftest.js` (line endings), `tests/README.md`, `.claude/launch.json`.
- **Docs:** `docs/MOG_ProjectNotes.md` (Local previews; Worktree sessions and pull requests), `docs/MOG_CurrentState.md`, `CLAUDE.md` (the `tests/` line), this handoff.

### Process lessons

- Four sessions rebuilt the same throwaway preview server before it was committed; it's in the repo now, and the project notes say to use it. [→ tests/preview_server.js, docs/MOG_ProjectNotes.md]
- A control that compares anchor text itself (not through `plant()`) failed in every new Windows worktree: anchors must take the file's own line ending. [→ tests/slice_js_selftest.js, tests/README.md]
- A worktree session's branch predates the day's handoff, and the app won't merge `main` in while the origin is unconfirmed; this handoff went on top of `main` in a docs-only sparse worktree. [→ docs/MOG_ProjectNotes.md, proposal session-handoff-2026-11-02]
- With no `gh`, the pull request was opened by hand and the app couldn't bind it; CI was read through the public runs API. [→ docs/MOG_ProjectNotes.md]
- The hidden browser pane shows the phone layout, which has no Manage; `resize_window` 1280×800 and a reload bring the computer layout. [→ docs/MOG_ProjectNotes.md]

**Skill gate:** one picker round, one question, Apply: a worktree session checks where the docs stand on `origin/main` and writes the handoff on top of it (proposal `session-handoff-2026-11-02` to the global `session-handoff`). Not asked: the preview server and the line-ending rule (now in code and `tests/README.md`), no `gh` and the hidden pane's layout (project facts, in the project notes). Checked: the lessons above and Sebastian's picks this session; no corrections or rejected tool uses.

### Commits landed (this session)

```
35cb81c Merge pull request #6 from SebHEH/claude/zen-kepler-2339e3
94d496d tests: slice_js_selftest's controls take the file's line ending
8ea3603 tests: the local preview server, committed (fake Supabase, app, editor, HQ)
```

Plus this handoff's commit.

### Opening prompt for next session

```
Read docs/MOG_CurrentState.md and the two "Later session" blocks of docs/MOG_SessionHandoff_2026_11_02.md first, and run git pull.
Happy Supply W1 (schema v13) is live and empty; CI runs the real SQL in PGlite; 28 gates.
To click through the app, the editor, HQ or Happy Supply, use preview_start "mog-preview"
(tests/preview_server.js, fake Supabase, PIN 1111); never build another preview in the scratchpad.
STILL OUTSTANDING: undo the TEST rollout "Horse Pho" on rprfotest, start the four libraries.
Ask first whether Chef Dan is invited (warehouse role only) and has
entered a first count. Then either help with that, or start W2 (store orders,
docs/MOG_Warehouse_Spec.md §2) with an architectural walkthrough: it needs Dan's answer on
pound-ordered items and Sebastian's call on an Approve step.
```

---

## Later session 3 — LTOs, the HQ side

**Author:** Sebastian
**Session focus:** workshop Sebastian's LTO asks (label LTO items, flag new ones at the stores, roll back and remove, a list of each concept's LTOs, line up the concepts with the library), then build the first part.
**Outcome:** the HQ side is live.
- **Schema v14:** Sebastian ran it in the SQL Editor. smoke_v14: 26/26 PASS. `check_api.sh`: "94 passed, 0 failed".
- **Code:** commit `6fee3a1`, CI `gates` "completed success", Pages live on HQ and all 10 stores after about 80 s.
- **Sitewide:** nothing changed at a store yet. The store's side (Items banner, chip) is session 2.

**STILL OUTSTANDING (since 2026-11-02, the first session above):**
- **Horse Pho** (rprfotest, change 237) is still not undone. It's now part of the hand cleanup below.
- **Libraries:** two of the four are started.
  - Teas'n You BOH: 137 items from Tysons BOH (1:50 PM).
  - Roll Play BOH: holds only Horse Meat, put there by a rollout's library box (removed this session).
  - The two FOH libraries aren't started.

**Next session focus:** the store's Items page (session 2 of `docs/MOG_LTO_Spec.md`): new LTO items at the very top until they have a par and an area, the LTO chip, the panel note.

### Sebastian's asks and decisions

- **Checked live first (read-only):**
  - Chef Dan isn't invited (HQ has only Sebastian), and the warehouse is empty.
  - Earlier today Sebastian tested HQ on real stores:
    - "Horse Meat" went to Rosslyn, Founders and Tysons BOH and was deleted by hand at each one (three sign-ins);
    - "Fall Chicken Pho LTO" and an empty Happy Supply vendor are still at those three stores.
- **Spec** (`docs/MOG_LTO_Spec.md`, spec-first), all four picks as recommended:
  - LTOs first. The line-up with the libraries gets its own spec once the libraries hold items.
  - End makes an LTO's items inactive.
  - Roll back deletes them even when a store set them up, naming those stores.
  - "Make it standard" replaces the rollout's library box.
- **Mockup** (two boards on the "MOG HQ redesign" canvas, https://claude.ai/artifact/3pJWHSWbMxVUyaRjmXkXqg: "HQ · LTOs" and "Store · Items"): Sebastian approved it.
- **Walkthrough:**
  - The link lives on the item row (`mog.items.lto`), not in a list beside it, because item numbers are reused (highest + 1).
  - The three rollouts from before v14 are cleaned up by hand, not backfilled.
  - HQ side first.
  - Roll back takes off the backup vendors it gave items a store already had; End leaves those items alone. Sebastian didn't follow the abstract question, so the default stands.
- **Standing rule (new):** every session handoff commits and pushes as part of it (`mog-session-handoff`, CLAUDE.md convention 6).

### What shipped (`6fee3a1`)

- **`supabase/schema_v14.sql`:**
  - New tables `mog.ltos` and `mog.lto_stores`; the second keeps, per store, the change, the vendors added and the backups added.
  - `mog.items.lto` is part of the item's row: compared and written by the editor's saves, so a store's Undo brings it back.
  - `tables_json` gains the store's `ltos` only when it has one. `mog_hq_data` gains every LTO with its stores.
  - `mog_hq_apply` gains a 5th argument (send, more, end, rollback, standard): CONFLICT on a moved version; refused for an LTO that isn't running, a store of another concept, or a change at a store the action isn't about. The long functions are generated from v10 and v12 with asserted one-match replacements.
- **`template/editor/catalogEdit.js`:**
  - `hqRollout` stamps the LTO on the items it creates, and only those; `backupsAdded` now carries the item id.
  - New `commitHqLto`: end, rollback, standard.
  - New `ltoStoreState`.
  - `getAllItemsForView` adds an item's LTO only when it has one.
- **HQ:**
  - Roll out is now New LTO: the name is required, the library box is gone, and a send opens the LTO.
  - New `template/hq/ltos.js`: the LTOs page per concept (Running / Finished / All), where each LTO stands at each store, and Send to more stores, Make it standard, End and Roll back, each with a confirmation.
- **Checks:**
  - `smoke_v14.sql` (26 rows), a v14 block in `check_api.sh` (6 probes).
  - `tests/fake_supabase.js` mirrors v14, including the item's link to an existing LTO.
  - New gate `tests/lto.test.js`: one store, 200 random stores, the fake; 7 planted-defect controls; 29 gates in all.
- **Docs:** `docs/MOG_LTO_Spec.md` (new); `docs/MOG_Warehouse_Spec.md` (§1's library box replaced); Migration §7 rows; Blueprint R31, the LTO entity and the growth seam (`current_as_of 6fee3a1`); CLAUDE.md.

### Validation

- **PGlite:** "PASS  smoke_v14.sql: 26/26 PASS", "ok    schema_v14.sql (again), no row changed", "run_pglite: ALL PASS".
  - 9 planted SQL defects all turned a smoke row to FAIL. One plant first broke with a SQL error instead; it was re-planted until a row failed.
- **Gates:** "run_all: ALL PASS (29 gates)"; "lto: ALL PASS", all 7 controls biting.
- **Browser, against the fake (`mog-preview`):**
  - sent to 2 stores, then to 1 more;
  - rolled back at 3 stores, logged "HQ rolled back LTO "Fall Chicken Pho": deleted 1 item";
  - ended one LTO; made one standard, which landed in the Roll Play BOH library;
  - no console or server errors, no sideways scroll at 375 px.
  - Two fixes came out of this: plural wording in the confirmations, and an LTO vanishing from the Running list right after an action.
- **Live:**
  - smoke_v14 26/26 (Sebastian's paste);
  - `check_api.sh` "94 passed, 0 failed";
  - read-only: the 5-argument `mog_hq_apply`, both helpers, both tables, `items.lto`, no smoke rows left;
  - CI "completed success"; Pages live everywhere.
  - Nobody has used the live LTOs page yet.

### Outstanding (carry forward)

1. **Sebastian, in each store's Manage → Changes,** undo the rollouts from before v14:
   - "Horse Pho" at Rosslyn FOH (TEST);
   - "Fall Chicken Pho LTO" at Rosslyn BOH, Founders BOH and Tysons BOH;
   - "added vendor Happy Supply" at those three stores, if it was a test (asked, not answered).

   Then in **HQ** (https://sebheh.github.io/mog-mobile/hq/): Libraries → Roll Play → BOH → Horse Meat → Remove, so "Start from a store" comes back.
2. **Sebastian, in HQ:** a first live LTO on the TEST store. New LTO → Rosslyn FOH (TEST) → Send, then Roll back.
3. **Session 2** (`docs/MOG_LTO_Spec.md`): the store's Items page.
   - A banner at the very top per LTO.
   - Its items pinned first until each has a par and an area.
   - The "LTO · name" chip, and the panel note.
   - `catalogEdit.js` already gives each Items row its LTO (`row.lto`).
   - Bilingual (`T(en, es)`), and a gate for the pinned order.
4. **Later, its own spec:** line up each concept's stores with its library, and items a store can't remove. It needs the libraries started and cleaned first.
5. **From the sessions above, unchanged:** Chef Dan's invite and first count; W2's two questions; confirm the repo's origin in the desktop app; `gh`.

### Files touched (this session)

- **Supabase:** `supabase/schema_v14.sql` (new), `supabase/tests/smoke_v14.sql` (new), `supabase/tests/check_api.sh` (v14 block).
- **Editor rules:** `template/editor/catalogEdit.js`.
- **HQ:** `template/hq/index.html`, `template/hq/ltos.js` (new).
- **Tests:** `tests/fake_supabase.js`, `tests/lto.test.js` (new).
- **Generated** (`build.py`): `hq/index.html`, `hq/catalogEdit.js`, `hq/ltos.js`, every store's `editor/catalogEdit.js`.
- **Docs:** `docs/MOG_LTO_Spec.md` (new), `docs/MOG_Warehouse_Spec.md`, `docs/MOG_SupabaseMigration.md`, `docs/MOG_LogicBlueprint.md` and `.html`, `docs/MOG_CurrentState.md`, `docs/MOG_ProjectNotes.md`, `CLAUDE.md`, this handoff.
- **Skills:** `.claude/skills/mog-session-handoff/SKILL.md` (commit and push).
- **Outside the repo:**
  - the canvas's two LTO boards;
  - scratchpad: `gen_v14.py` and `v14_hand.sql` (they generated v14; the file is the record) and `plant_v14.sh` (one-off).

### Process lessons

- Checking the live database read-only before asking turned "is Dan invited, are the libraries started, is Horse Pho undone" into facts. It also found the real-store test (Horse Meat deleted by hand at three stores) behind the request. [→ docs/MOG_ProjectNotes.md]
- An edge-case question asked as a mechanism ("backups added to items a store already had") came back "not sure what the issue is". Named from the data (Rosslyn's own Chicken Breast gains Organic Butcher), it needed no question. [→ proposal architectural-walkthrough-2026-11-02-b]
- A planted SQL defect that broke the file (two assignments to one column) was counted as caught by a script that matched any FAIL line. It was re-planted until a smoke row failed. [→ mog-supabase-schema]
- A spec default (backfill the old rollouts) became a data-writing schema step at the walkthrough and was asked again as a CONFIRM; Sebastian chose the hand cleanup. [→ architectural-walkthrough]
- Driving HQ by script: a click redraws the picker, so element references found before it go stale. [→ docs/MOG_ProjectNotes.md]
- In a Design canvas board, `sc-if` and `sc-for` inside a `<table>` get moved out by the HTML parser. The existing boards use `role="table"` div grids, and the new one does too. [→ one-off]
- An action that changed an LTO's status hid it from the Running list ("Pick an LTO"). The page now keeps it shown. [→ one-off]
- Sebastian's rule: every handoff commits and pushes, with no separate step. [→ mog-session-handoff, CLAUDE.md]

**Skill gate:** one picker round, three questions: the push rule, MOG only (the `mog-session-handoff` skill and CLAUDE.md, no global proposal); the plant rule into `mog-supabase-schema`, Apply; the edge-case rule as proposal `architectural-walkthrough-2026-11-02-b`, Apply. Not asked: the read-only check and the CONFIRM on a spec default (already in the project notes and the skill), the HQ script fact (project notes), the canvas tables and the hidden LTO (one-off). Checked: Sebastian's corrections this session (the backup question, the push rule), every picker answer (all as recommended until this round's "MOG only"), and no rejected tool uses.

### Commits landed (this session)

```
6fee3a1 LTOs, HQ side (schema v14): New LTO, the LTOs page, End and Roll back
```

Plus this handoff's commits (skills, then docs).

### Opening prompt for next session

```
Read docs/MOG_CurrentState.md, docs/MOG_LTO_Spec.md and the last "Later session" of docs/MOG_SessionHandoff_2026_11_02.md first, and run git pull.
LTOs' HQ side is live (schema v14, commit 6fee3a1): New LTO, the LTOs page, End / Roll back / Make it standard; items carry their LTO in mog.items.lto; 29 gates.
STILL OUTSTANDING: undo the old test rollouts by hand (Horse Pho on rprfotest; Fall Chicken Pho at rpr, rpfr, rpt), remove Horse Meat from the Roll Play BOH library.
Ask first whether Sebastian sent a live TEST LTO and rolled it back. Then build session 2: the store's Items page shows each new LTO's items at the very top until they have a par and a storage area (banner, pinned rows, "LTO · name" chip, panel note), from the approved "Store · Items" board on the MOG HQ redesign canvas; getAllItemsForView already gives each row its lto. Walk through it first; use preview_start "mog-preview" to check it.
```

---

## Later session 4 — LTO items first on Items, library tick boxes, vendor rename

**Author:** Sebastian
**Session focus:** LTOs session 2 (the store's Items page), plus three asks Sebastian added: clear a library's items at once, rename vendors so the names line up across stores, and an easier way to set up Happy Supply and Elpis items with live stock for the people ordering.
**Outcome:** three of the four are live (commit `abce087`, CI `gates` success, Pages serving it at all 10 stores and HQ about 45 s after the push).
- Schema v15 (vendor rename) ran live: smoke_v15 18/18 PASS (Sebastian's paste), `check_api.sh` 96 passed, 0 failed, and a read-only check shows the new rename step, still closed to the public key.
- The fourth ask (live stock for Happy Supply and Elpis) is recorded as open W2 questions, not built.
- Everything was checked in the local preview only; nobody has used the new pages on a real screen.

**STILL OUTSTANDING (since earlier today):**
- Horse Pho on Rosslyn FOH (TEST) (change 237) is still not undone.

**Next session focus:** use what shipped (a live TEST LTO and its Roll back, clearing the Teas'n You BOH test library, lining up vendor names), then either clean the libraries or start W2 spec-first.

### Checked live first (read-only, before asking)

- No LTO has been sent yet (`mog.ltos` empty), so the live TEST LTO hasn't happened.
- Fall Chicken Pho and the empty Happy Supply vendor were deleted by hand at Rosslyn, Founders and Tysons BOH (3:23 to 3:25 PM). The Roll Play BOH library is empty (Horse Meat removed).
- The Teas'n You BOH library holds 133 items: Sebastian's test, to clear with the new tick boxes.
- Vendor names drift across stores: "B&T", "B&T Distributions", "B&T Distributors LLC"; "Elpis", "Elpis Wholesale", "ELPIS". Founders BOH's "B&T" has no items.

### Sebastian's decisions (one walkthrough, all three picks as recommended)

- **Vendor rename:** a rename step in the SQL (schema v15), not a delete and an add, so HQ's remembered name and today's counts follow and a change of capitals works.
- **Standard items without an LTO:** from the library (tick items, "Send N items to stores"), not a plain Add items page.
- **Live stock for Happy Supply and Elpis:** designed with W2, spec-first later; recorded now as open questions.
- Then: run v15 first, then commit and push everything in one push.

### What shipped (`abce087`)

- **The store's Items page** (`template/editor/Items.html`, LTO spec step 5, from the approved "Store · Items" board):
  - a banner per running LTO that still has items to set up ("New from HQ: <name> · N items to set up", the date, Set it up / Set them up);
  - those items pinned under "New from LTOs · set these up first" until each has a par and a storage area, then the rest under "All items";
  - an "LTO · name" chip on every LTO item (solid while pinned);
  - the panel's LTO note, and "Still needs a par and a storage area to go on the count list";
  - a "<name> is set up" note once the last item is done, until the page is left.
  - The pin rule is `catalogEdit.js` `ltoWaiting` (running LTOs only, newest first, items A to Z), held by gate `lto` (three new controls).
- **HQ Libraries** (`template/hq/index.html`):
  - a tick box per item, and "Tick all" for the items shown (search and filter apply);
  - a bar for the ticked items: Remove from the library (one versioned save; the confirm says there's no Undo button) or Send N items to stores;
  - Send uses the library's Set up path with only those items: no LTO record, no pinning, items wait in Needs setup.
- **Vendor rename** (`template/editor/Vendors.html`, `catalogEdit.js`, `supabase/schema_v15.sql`):
  - the Name field shows for an existing vendor, with a note while the name differs; the save is one change ("Renamed vendor "B&T" to "B&T Distribution"") that Undo reverses;
  - `saveVendor` records a `{ rename: 'vendors' }` step; `applyOps` and `diff` take it as they take an area rename;
  - v15's `mog.editor_apply_ops` (generated from v14 with one asserted replacement) renames the vendor (items' main vendor, pick rows and HQ's remembered names follow on update cascade) and renames it in the items' vendor lists, the counts (one already under the new name keeps its place), the "just today" edits, the override's day picks and presence;
  - refused: a name another vendor has ignoring capitals (merging is not a rename), a vendor not there by that name, an unknown rename kind.
  - Not renamed: past orders, and an LTO's record of the vendors it added (its Roll back then leaves a renamed vendor in place).
- **Tests:**
  - new gate `vendor_rename` (one store, 200 random stores, the fake; 5 controls): 30 gates;
  - `tests/fake_supabase.js` mirrors v15 (`followVendorRenames`);
  - `smoke_v15.sql` (18 rows) and a v15 block in `check_api.sh`;
  - `smoke_v8.sql`'s "only areas rename" probe now names a kind no version renames (`items`), so it passes on v8 and v15;
  - `editor_host`'s planted-defect anchor moved with the `diff()` line.
- **Docs:** LTO spec (session 2 built), warehouse spec (live stock and Elpis as open W2 questions), Blueprint R28 (a store can rename its vendor) and R31 (the Items page), migration §7, project notes, CLAUDE.md.
- **Preview:** `.claude/launch.json` gains `mog-preview-alt` (port 8771) for when another chat's preview holds 8770.

### Validation

- **Gates:** "run_all: ALL PASS (30 gates)"; `lto` and `vendor_rename` with every control biting.
- **PGlite:** every schema and smoke file, "smoke_v15.sql: 18/18 PASS", "schema_v15.sql (again), no row changed", "run_pglite: ALL PASS".
- **Planted SQL defects** in a scratch copy, each failing a named smoke_v15 row: vendor lists not renamed, counts not moved, a count under the new name overwritten, day picks not renamed, no CONFLICT on a taken name.
- **Preview (`mog-preview-alt`, driven by script in a hidden pane):**
  - an LTO sent to the TEST store: the banner, both items pinned, set up one by one down to "Fall Chicken Pho is set up";
  - a library started, a search with Tick all, Send 3 items to one store, then the whole library removed and "Start from a store" back; no sideways scroll at 375 px;
  - a vendor renamed, a taken name refused before any save, the rename's entry in Changes and its Undo;
  - no console or server errors.
- **Live:** smoke_v15 18/18, `check_api.sh` 96/96, read-only check of v15, CI `gates` success on `abce087`, Pages markers at all 10 stores and HQ.

### Outstanding (carry forward)

1. **Sebastian, live, now that it ships:**
   1. HQ → Libraries → Teas'n You → BOH → Tick all → Remove from the library: clears the 133-item test.
   2. Pick one spelling per vendor, then rename at each store (Manage → Vendors → the vendor → Name): B&T at Founders BOH, Rosslyn and Tysons BOH, Rockville BOH; Elpis at Rosslyn FOH, Founders FOH, Tysons FOH, Rockville BOH and FOH.
   3. A live TEST LTO: HQ → New LTO → Rosslyn FOH (TEST) → Send; check its Items banner; then HQ → LTOs → Roll back.
   4. Undo Horse Pho in Rosslyn FOH (TEST)'s Manage → Changes (change 237).
2. **Seen on a screen:** the Items banner, the HQ tick boxes and the Vendors rename were driven by script in a hidden pane; their layout hasn't been looked at.
3. **W2, spec-first** (`docs/MOG_Warehouse_Spec.md` §2, "Open for W2"): live stock for the people ordering, Elpis (held stock vs its own items, who records its shipments), plus Dan's pound question and the Approve step. Chef Dan still isn't invited.
4. **Small:** a store can't merge two vendors (a taken name is refused); renaming LTO-added vendors leaves them behind on Roll back; an offline phone still holding the old name can save a count under it after a rename (orphaned, not read).
5. **From the sessions above, unchanged:** start and clean the libraries, confirm the repo's origin in the desktop app, `gh`.

### Files touched (later session 4)

- **Supabase:** `supabase/schema_v15.sql` (new), `supabase/tests/smoke_v15.sql` (new), `supabase/tests/check_api.sh` (v15 block), `supabase/tests/smoke_v8.sql` (one probe).
- **Editor:** `template/editor/Items.html`, `template/editor/Vendors.html`, `template/editor/catalogEdit.js` (`ltoWaiting`, `renameVendor`, the rename in `saveVendor`, `applyOps`, `diff`, `describe`).
- **HQ:** `template/hq/index.html` (library tick boxes, the bar, Send items).
- **Tests:** `tests/vendor_rename.test.js` (new), `tests/lto.test.js`, `tests/fake_supabase.js`, `tests/editor_host.test.js`.
- **Generated** (`build.py`): every store's `editor/catalogEdit.js`, `editor/items.html` and `editor/vendors.html`; `hq/index.html`, `hq/catalogEdit.js`.
- **Docs:** `docs/MOG_LTO_Spec.md`, `docs/MOG_Warehouse_Spec.md`, `docs/MOG_LogicBlueprint.md` and `.html` (R28 after the push, stamp `abce087`), `docs/MOG_SupabaseMigration.md`, `docs/MOG_ProjectNotes.md`, `docs/MOG_CurrentState.md`, `CLAUDE.md`, this handoff.
- **Other:** `.claude/launch.json` (`mog-preview-alt`).
- **Outside the repo (scratchpad):** `gen_v15.py`, `v15_head.sql`, `v15_tail.sql` (they generated v15; the file is the record), `plant_v15.py` (one-off), `wait_live.sh`.

### Process lessons

- Checking the live database read-only before asking turned "did you send a TEST LTO?" into a fact (none sent) and found the 133-item test library and the vendor-name drift behind the asks. [→ docs/MOG_ProjectNotes.md]
- A line changed in `catalogEdit.js` (`diff()`'s rename line) was a gate's planted-defect anchor: `editor_host` failed "plant: anchor not found" until its find text moved. The project-notes rule was missed again; `run_all` caught it before the commit. [→ docs/MOG_ProjectNotes.md]
- A new schema widened what an older smoke row asserts is refused (smoke_v8's "only areas rename"). Skipping the row in the runner wasn't enough: the probe now really renamed Sysco, and two later rows of that file failed. Pointing the probe at a kind no version accepts kept smoke_v8 passing on v8 and v15. [→ mog-supabase-schema]
- A planted SQL defect that made the rename call itself throw (a key clash from the plant's own order) failed every rename row, and the plant script counted it as caught. It was re-planted until only the rows about that rule failed. [→ mog-supabase-schema]
- A gate control whose defect makes the code throw outside the check showed as "crashed instead of biting"; `vendor_rename` wraps its whole check so a throw is a reported problem. [→ tests/vendor_rename.test.js]
- Another chat's preview held port 8770; `mog-preview-alt` (8771) was added, and both rebuild the same `_preview/rprfotest/`. [→ docs/MOG_ProjectNotes.md, .claude/launch.json]
- In the hidden pane a tab stopped answering after a redirect (a new tab worked), and a page's `window.confirm` would block a scripted click. [→ docs/MOG_ProjectNotes.md]
- Four asks in one message, one of them W2-sized: three were built and the fourth recorded as open W2 questions, chosen in the walkthrough's picker. [→ one-off]

**Skill gate:** one picker round, two questions, both Apply, both into `mog-supabase-schema`: a newer schema that accepts what an older smoke row says is refused (point the probe at something no version accepts), and a plant that makes the call itself throw is not a catch. Not asked: the anchor rule and the live-check-first habit (already in the project notes), the preview port, the hung tab and `window.confirm` (project facts, in the project notes), the gate that wraps its check (in the test), the four-asks split (one-off). Checked: Sebastian's picks this session (all as recommended), no corrections, no rejected tool uses.

### Commits landed (later session 4)

```
abce087 LTO items first on Items, library tick boxes in HQ, vendor rename (schema v15)
```

Plus this handoff's commits.

### Opening prompt for next session

```
Read docs/MOG_CurrentState.md and the last "Later session" of docs/MOG_SessionHandoff_2026_11_02.md first, and run git pull.
Live since abce087: new LTO items pinned at the top of each store's Items page, tick boxes on HQ's Libraries (Remove, Send N items to stores without an LTO), and vendor rename on the Vendors page (schema v15: items, lists, counts, today's edits and HQ's names follow); 30 gates.
Ask first what Sebastian saw: did the Teas'n You BOH test library clear, were the B&T and Elpis names lined up, and did a live TEST LTO show its Items banner and roll back? STILL OUTSTANDING: Horse Pho on rprfotest.
Then either help clean the libraries, or start W2 (store orders) spec-first: live stock for the people ordering Happy Supply and Elpis, who records Elpis's shipments, Dan's pound question, the Approve step (docs/MOG_Warehouse_Spec.md §2, "Open for W2"). Use preview_start "mog-preview" (or "mog-preview-alt") to check anything you build.
```

---

## Later session 5 — the W2 spec, Happy Supply store orders (W2a)

**Author:** Sebastian
**Session focus:** check what Sebastian saw after later session 4, then spec W2 (store orders) spec-first and build its first part.
**Outcome:** W2a is live (commit `37588dd`).
- Sebastian ran schema v16 in the SQL Editor: smoke_v16 50/50 PASS (his paste). A read-only check matched; `check_api.sh` gave "105 passed, 0 failed".
- CI `gates` passed and Pages published it; the new build is live on all 10 stores (app v0.28.0, cache v69) and HQ.
- Nothing changes at any store until HQ links a product there. Checked live: no store has a link or an order yet.

**Next session focus:** first live use (Happy Supply on the TEST store through Vendors, Send to stores, a test order end to end), then W2b, HEH's stock held at Elpis.

### Checked live first (read-only, before asking)

- The Teas'n You BOH test library was cleared at 5:36 PM. Both started libraries are empty; the FOH ones aren't started.
- B&T is "B&T Distributors LLC" at every real store; only the TEST store still has "B&T", from Horse Pho.
- Elpis has three spellings: "Elpis" (Rosslyn FOH, Founders FOH, RP Tysons FOH), "Elpis Wholesale" (Rockville BOH and FOH) and "ELPIS" (TnY Tysons FOH).
- Fall Chicken Pho went to Rosslyn, Founders and Tysons BOH at 5:41 PM. It's a real LTO (Sebastian: keep it).
- Horse Pho (change 237) is still not undone.
- What stores order from Elpis: Roll Play's FOH stores get branded packaging (RP bowls, lids, bags, Magnum roll boxes, utensil packets) plus Elpis's own catalog (tea, Karat cups, gloves); Teas'n You gets boba, tea, cups, lids and straws.

### Sebastian's decisions

- **The three pages from later session 4** looked right on a screen.
- **Elpis:** one spelling at every store, "Elpis Wholesale" (his renames, below).
- **The W2 spec** (`docs/MOG_Warehouse_Spec.md` §2 "W2 spec"), picks as recommended unless noted:
  - KMs keep ordering HEH's stock at Elpis from Elpis; Elpis becomes a location, and the store's receipt lowers it;
  - no Approve step (sent, shipped, received);
  - KMs see cases available as a number; an order larger than that is sent with a warning;
  - who keeps the Elpis stock: "we can decide after, for now it can be me";
  - an Elpis delivery nobody marks stays open and is listed;
  - W2a (Happy Supply) first, W2b (Elpis) next.
- **The W2a design** (walkthrough):
  - the item's link in its row (not the design's link table);
  - a store's Happy Supply from HQ's remembered names;
  - needed-by defaults to the next delivery day and can be changed.
- **The mockups** (three boards, the "Happy Supply W2a" row of https://claude.ai/artifact/3pJWHSWbMxVUyaRjmXkXqg) approved, plus:
  - linking makes Happy Supply the main vendor, the old one a backup;
  - Send also marks the vendor reviewed;
  - Ship starts with what's left after older orders.
- **Shipping:** Claude runs the probe; push to every store at once (nothing shows until HQ links a product).

### What shipped (`37588dd`)

- **`supabase/schema_v16.sql`:**
  - `mog.items.wh_product`, in the item's row like `lto`: compared by `editor_fields_match`, written by `editor_apply_ops`, read back only when set;
  - `mog.wh_orders` / `wh_order_lines` (HS-0001, one sent order per store and cycle);
  - the phone's `mog_wh_send` / `mog_wh_received`, Dan's `mog_wh_ship` / `mog_wh_order_cancel`;
  - `happySupply` in the 10-second read (`mog.wh_live_json`): the vendor, cases available per linked item (`mog.wh_available`), the open and this cycle's orders. Never a price.
  - The price locks at ship (`mog.wh_store_price`, the same sum as `hq/warehouse.js` `storePrice`). `editor_apply_ops`, `live_json` and `wh_state` were generated from v15, v9 and v13 with asserted replacements.
- **`catalogEdit.js`:**
  - `commitHqProduct` links an item a store has (Happy Supply main, the old main a backup with its count-list row, the product's pack) or adds one (no par, no area); Undo is exact;
  - `productCandidates` gives the pick-only link choices;
  - `USER_FIELDS` carries `whProduct`.
- **HQ** (`template/hq/warehouse.js`, `index.html`):
  - the Orders page: the queue by needed-by, Ship with From per line, starting at what's left after older orders, what's left after, the price per case, Cancel, stock and open orders;
  - a product's Send to stores (hq role too), every store or none, through `mog_hq_apply` with HQ's remembered name.
- **Phone** (`template/index.html`, app v0.28.0, cache v69):
  - "N available" on linked items;
  - the review's needed-by (the next three delivery days), the warning, a note and Send to Happy Supply (which also marks it reviewed); Copy order and Mark as reviewed are hidden for Happy Supply;
  - the card's order line and Mark received (a sheet, each line at most what shipped).
- **Checks:**
  - `smoke_v16.sql` (50 rows), a v16 block in `check_api.sh`;
  - `tests/fake_supabase.js` mirrors v16;
  - new gate `tests/wh_orders.test.js` (9 controls, 31 gates);
  - the `lto` and `vendor_contacts` gates got their anchor and slice list moved.
- **Docs:**
  - the W2 spec, the W2a design and the mockup decisions in the warehouse spec;
  - migration §7 rows and Blueprint R32, the Store order entity and the item's product link (`current_as_of 37588dd`);
  - project notes, CurrentState, CLAUDE.md.

### Validation

- **PGlite:** "smoke_v16.sql: 50/50 PASS", "schema_v16.sql (again), no row changed". Six planted SQL defects each failed the rows about their rule:
  - the store's own order counted in its available;
  - the compare forgetting the link (caught only after a smoke row was added; Process lessons);
  - Ship taking more than ordered;
  - a price on the phone;
  - a product's store limit ignored;
  - more received than shipped.
- **Gates:** "run_all: ALL PASS (31 gates)", "wh_orders: ALL PASS" with all 9 controls biting.
- **Preview** (`mog-preview`, driven by script in a hidden pane):
  - HQ's Send to stores added "Shrimp 16/20" at the TEST store;
  - the KM's setup kept the link;
  - the phone showed "9 available", and the review warned "Only 9 available";
  - Send landed in Dan's queue with the note;
  - Ship started at 9 of 10 from Berliner ($84.50 a case, $760.50);
  - the card showed "Shipped 9 of 10 cases · from Berliner", and Mark received went through with 8 (capped at 9);
  - no console errors.
- **Live:**
  - smoke_v16 50/50 (Sebastian's paste);
  - read-only: the four calls and helpers, `items.wh_product`, the public key held off the tables and helpers, no smoke rows left, no store with a link;
  - `check_api.sh` 105/105;
  - CI `gates` success on `37588dd`;
  - Pages markers on all 10 stores and HQ.

### Outstanding (carry forward)

1. **Sebastian, live:**
   1. Rename Elpis to "Elpis Wholesale" in Manage → Vendors at Rosslyn FOH, Founders FOH, RP Tysons FOH and TnY Tysons FOH.
   2. Undo Horse Pho in Rosslyn FOH (TEST)'s Manage → Changes (change 237).
2. **First use of W2a, on the TEST store first:**
   - The warehouse holds no products or stock yet (Dan isn't invited).
   - Add a product and a first count in HQ → Happy Supply, and add Happy Supply to Rosslyn FOH (TEST) in HQ → Vendors, with its delivery days.
   - Then Products and prices → the product → Send to stores, set the item up at the store, order from the phone, Ship in Orders, and Mark received.
   - Nobody has seen the new pages on a real screen.
3. **W2b** (HEH's stock held at Elpis): the spec is decided, the build is next. Who keeps the Elpis stock: Sebastian for now, decided later.
4. **Before real orders:** Dan's answer on ordering by the pound, and Dan's invite (warehouse role only).
5. **Small, noticed:**
   - Right after a sign-in, the card's Happy Supply line waits for the first 10-second read.
   - The count screen's "N available" is drawn when the screen opens.
   - Send to stores can't add the Happy Supply vendor itself (Vendors first, with delivery days), which differs from the mockup's "Adds the vendor".
6. **From the sessions above, unchanged:** clean and start the libraries, the repo's origin in the desktop app, `gh`.

### Files touched (later session 5)

- **Supabase:** `supabase/schema_v16.sql` (new), `supabase/tests/smoke_v16.sql` (new), `supabase/tests/check_api.sh`.
- **Editor rules:** `template/editor/catalogEdit.js`.
- **HQ:** `template/hq/warehouse.js`, `template/hq/index.html`.
- **Phone:** `template/index.html`, `template/sw.js`.
- **Tests:** `tests/wh_orders.test.js` (new), `tests/fake_supabase.js`, `tests/lto.test.js`, `tests/vendor_contacts.test.js`.
- **Generated** (`build.py`): every store's `index.html`, `sw.js` and `editor/catalogEdit.js`; `hq/index.html`, `hq/warehouse.js`, `hq/catalogEdit.js`.
- **Docs:** `docs/MOG_Warehouse_Spec.md`, `docs/MOG_SupabaseMigration.md`, `docs/MOG_LogicBlueprint.md` and `.html`, `docs/MOG_ProjectNotes.md`, `docs/MOG_CurrentState.md`, `CLAUDE.md`, this handoff.
- **Skills:** `.claude/skills/mog-supabase-schema/SKILL.md` (two rules).
- **Outside the repo:** the canvas's three W2a boards; scratchpad `gen_v16.py` and `v16_src.sql` (they generated v16; the file is the record), `plant_v16.py` and `wait_live.sh` (one-off).

### Process lessons

- Checking the live database read-only before asking turned "were the names lined up, did the LTO roll back" into facts, and showed that the LTO went to real stores. The pickers then asked only what a person knows (is it real, did it look right). [→ docs/MOG_ProjectNotes.md]
- smoke_v16's first CONFLICT check also changed the vendor and pack, so a planted "the link isn't compared" passed until a row differing only by the link was added. [→ mog-supabase-schema]
- A gate value worked out by hand was wrong again (crab "left" 14; the code says 20, both locations). A pinned value comes from running the code or the SQL. [→ mog-supabase-schema]
- `vendor_contacts` slices `renderVendorCard`; once the card called the Happy Supply helpers, the gate failed with "hsIsVendor_ is not defined" until they joined its slice list. A sliced helper has to be a function declaration. [→ docs/MOG_ProjectNotes.md]
- In the hidden pane, a fresh sign-in reads a plain snapshot: the card's Happy Supply line came with the first 10-second read, so the first look said "Reviewed" only. [→ docs/MOG_ProjectNotes.md]
- The approved mockup's "Adds the vendor" on Send to stores met the pick-only rule (a store's new vendor goes in on Vendors, with its delivery days) only at build time, so the build differs from the mockup there. [→ one-off]
- `build.py` hit OSError Errno 22 once more; the rerun worked. [→ docs/MOG_ProjectNotes.md]

**Skill gate:** one picker round, two questions, both Apply, both into `mog-supabase-schema` (commit `3666d5d`): a CONFLICT check differs only in the field it guards, and a pinned value comes from running the SQL or the page's own code. Not asked: the live-check-first habit and the Errno 22 rerun (already in the project notes), the sliced-helper rule and the 10-second wait (project facts, added to the project notes), the mockup's vendor step (one-off). Checked: Sebastian's picks this session (all as recommended, except "we can decide after, for now it can be me" on who keeps the Elpis stock), no rejected tool uses.

### Commits landed (later session 5)

```
3666d5d skills: mog-supabase-schema on CONFLICT checks and values pinned from page code
37588dd Happy Supply W2a, store orders (schema v16): Send, Ship, Mark received
```

Plus this handoff's commit.

### Opening prompt for next session

```
Read docs/MOG_CurrentState.md and the last "Later session" of docs/MOG_SessionHandoff_2026_11_02.md first, and run git pull.
Happy Supply W2a is live (schema v16, commit 37588dd): HQ links store items to warehouse products (Send to stores), the phone shows cases available and sends to Happy Supply, Dan ships from HQ's Orders page, the store marks it received; 31 gates. No store has a link yet, and the warehouse holds no products.
Ask first whether Sebastian tried it on the TEST store (Vendors → Happy Supply with delivery days, a product and a count, Send to stores, a phone order, Ship, Mark received) and renamed Elpis at the four stores. STILL OUTSTANDING: Horse Pho on rprfotest.
Then build W2b, HEH's stock held at Elpis (docs/MOG_Warehouse_Spec.md §2, "W2 spec": Elpis as a location, the store's receipt lowers it, unmarked deliveries listed), starting with an architectural walkthrough and mockups. Use preview_start "mog-preview" to check it.
```
