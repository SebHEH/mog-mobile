# MOG — LTOs: spec

**Agreed:** 2026-11-02, Sebastian (spec-first, four picks below).
**Status:** approved; mockup approved (the "MOG HQ redesign" canvas, boards "HQ · LTOs" and "Store · Items", https://claude.ai/artifact/3pJWHSWbMxVUyaRjmXkXqg). **Session 1 (HQ side) built 2026-11-02, not run or shipped yet:** `supabase/schema_v14.sql` (smoke_v14 26/26 in PGlite, 9 planted defects caught), `catalogEdit.js` (`commitHqLto`, `ltoStoreState`, the stamp in `hqRollout`), HQ's New LTO and `template/hq/ltos.js`, gate `tests/lto.test.js` (29 gates). **Session 2:** the store's Items page (banner, pinned rows, chip, panel note) and Blueprint R31.

**Walkthrough decisions (2026-11-02):** the link lives on the item row (`mog.items.lto`), so a store's Undo brings it back and a reused item number never joins an LTO; the three rollouts sent before v14 are cleaned up by hand, not tracked; Roll back takes off the backup vendors it gave items a store already had, End leaves the store's items alone; HQ side first.
**Builds on:** HQ control (schema v11, `commitHqRollout`), the concept library (v12), a store's Changes and Undo (v6).

---

## Why (checked live, read-only, 2026-11-02)

- An HQ rollout leaves no mark on the items it adds: only the change log's label says where they came from, and the rollout's name is optional.
- Rolling one back means each store's own Undo, one sign-in per store. Sebastian's test "Horse Meat" went to Rosslyn BOH, Founders BOH and Tysons BOH at 1:34 PM and was deleted by hand at each store (changes 247-249).
- New items wait in the store's Needs setup, mixed with every other unfinished item, and on no count list (no area), so nobody is told they arrived.
- The rollout's "add to library" box started the Roll Play BOH library with Horse Meat as its only item, so "Start from a store" is no longer offered for it.

## The three lists

| List | What's in it | Lasts | Owner |
|---|---|---|---|
| Concept library | A concept's standard items, per side | For good | HQ |
| **LTO list** (new) | Each LTO: name, items, the stores it went to, status | Until it ends | HQ |
| A store's order guide | Everything the store orders | The store's own | The store |

**The link:** a store item may point at one library item or one LTO, never both. An LTO made standard moves its items' link to the library. (Linking store items to the library is the later line-up spec; this one builds the LTO link.)

## Spec

**Purpose.** HQ sends an LTO to a concept's stores, sees where it stands at each, and ends it or rolls it back in one action. Each store sees the new LTO items at the top of its Items page until they're set up.

**Who it's for:** HQ (Sebastian, Donny) sending and ending LTOs; the stores' KMs and GMs setting up what arrives.

**Not for:**
- Chef Dan (the warehouse role never sees store catalogs);
- KMs creating LTOs;
- the phone's count screen: unchanged, an LTO item reaches it once it has a storage area, as today.

**Success looks like:**
- A test LTO sent to three stores comes back out with one click and no store sign-ins.
- A KM opening Items sees "1 new item from Fall Chicken Pho: add a par and a storage area" at the very top.
- Ending an LTO takes its items off every store's count list in one action, and an item the store already had stays.

**Out of scope for this pass:**
- **Lining up the concepts' items and vendors with the library, and items a store can't remove.** It needs the four libraries started and cleaned first, so it gets its own spec after that. A multi-session foundation.
- LTOs that end on a date by themselves.
- A banner on the phone.

## Decided (Sebastian, 2026-11-02)

- **LTOs first.** The library line-up follows in its own spec once the libraries hold items. Warehouse W2 waits for Chef Dan (not invited yet).
- **Ending an LTO (it got pulled) makes its items inactive** at each store: off the count list, with their par, area and order history kept. If the LTO comes back, they come back set up. Each store can undo it in Changes.
- **Roll back (a mistake or a test) deletes the LTO's items at every store, even ones a KM already set up.** The confirm names the stores where a KM gave one a par or an area. Each store can undo the rollback in its own Changes, which brings that par and area back.
- **The Roll out page's "add to library" box goes.** LTO items go to the LTO list only; "Make it standard" on an LTO moves its items into the concept library. This replaces `docs/MOG_Warehouse_Spec.md` §1's "An HQ LTO rollout can add its items to the library".

## Build steps (defaults, for the walkthrough)

1. **LTOs as records (schema v14).** Name required, one concept, its items (name, pack, main vendor, backups as HQ names), the stores it went to, status (running, ended, rolled back). The items it creates at a store carry the LTO's link. An item the store already had isn't linked: ending the LTO never removes one of the store's own items. Today's HQ rollouts become records from the change log, so Horse Pho (rprfotest) and Fall Chicken Pho (Rosslyn, Founders and Tysons BOH) can be rolled back with the new button.
2. **HQ's LTOs page, per concept.** Every LTO, newest first; each opens to its items and, per store, where it stands (needs setup, set up, inactive, removed). "Send to more stores" while it runs. Roll out becomes "New LTO".
3. **Roll back,** from the LTO's page: every store or none, one change per store that the store can undo. A vendor the LTO added goes too when no other item uses it.
4. **End,** from the LTO's page: its items made inactive at every store it went to, every store or none.
5. **The store's Items page:** a banner at the very top ("N new items from <LTO>: add a par and a storage area") with those items pinned first until each has both, and an "LTO · <name>" chip on every LTO item in the list.
6. **Make it standard,** from the LTO's page: its items go into the concept library for each side it reached, and their store items' link moves to the library.

**Size:** about 2 sessions, mockup first.

## Open (for the walkthrough)

- Whether the Fall Chicken Pho item and the empty Happy Supply vendor at Rosslyn, Founders and Tysons BOH (11-02, 1:36 and 1:38 PM) are tests. If so, they're the first live tests of Roll back. (The spec had Happy Supply wait for W2's first products.)
- An item a store already had gets the LTO's vendors as backups today. Does Roll back take those backups off again, and does End?
- Whether an LTO can reach both sides of a concept (Roll out can tick BOH and FOH stores today).
- Whether "Send to more stores" is refused once an LTO has ended.
- The Roll Play BOH library holds only Horse Meat: deleting it there brings "Start from a store" back (Sebastian, in HQ).
