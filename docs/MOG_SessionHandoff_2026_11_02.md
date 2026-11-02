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
