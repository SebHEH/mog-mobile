---
name: mog-add-store
disable-model-invocation: true
description: Runbook for opening a new MOG store, current from schema v26 (Sheet retirement step 4, 2026-11-15) - four steps, no Sheet, no Apps Script, no clasp. Sebastian makes the store in HQ → Stores → New store (one save in Supabase) → Claude publishes it (reads its row, validate.py entry prints the stores.json entry, build.py, push, wait_live) → its items from a library or the app's Overview checklist → a smoke test and the next morning's close. Trigger when Sebastian asks to "add a new store", "open a new location", "publish <slug>", "set up a new store", "onboard a city or concept", or any close variant. A test store follows the same steps ("Test store" ticked: built, never on the hub). Skip for a store's PIN (HQ → Stores → Change PIN), the manager PIN (HQ → Stores → Manager PIN), a new concept (a code change: walk it through first), and removing a store (not covered).
---

# mog-add-store

A new store ends in the same state as every other store:
- phones count in Supabase, the catalog is edited in the app on a computer, and Supabase closes its
  cycle each night from midnight and sends the recap;
- it has **no Sheet, no Apps Script project and no `/exec` address** (schema v26): its page makes
  every call to Supabase;
- its PIN is set in HQ, and the one manager PIN every store shares goes on it by itself.

Background: [docs/MOG_SheetRetirement_Spec.md](../../../docs/MOG_SheetRetirement_Spec.md), R5 and
R6 and "Step 4". **Needs schema v26 live** (`mog_hq_stores`); before it, HQ → Stores says so and
offers nothing.

**How to run it:** one step at a time. Say whose step it is, wait for the result, check it with the
script instead of by eye:

```
python .claude/skills/mog-add-store/scripts/validate.py {slug|concept|entry|wired} <value>
```

`OK` (exit 0) means go on; `INVALID` (exit 1) prints why.

## Step 1 (Sebastian, HQ): New store

`https://sebheh.github.io/mog-mobile/hq/` → **Stores** → **New store**:

1. **Which concept:** Roll Play, Teas'n You, ĂN or Lei'd Poke. The form takes that concept's
   colours and logo.
2. **The store:** BOH or FOH, the time zone, the site (the place only, like "Ballston"), the
   delivery address (optional: it goes on each vendor's Copy order for email), and **Test store**
   for a trial.
3. **Its address and code:** the web address (`/<slug>/`, permanent once published: phones bookmark
   it) and the store code are filled in from the concept, site and side; either can be typed over.
4. **Store PIN** twice (4 to 8 digits, not the manager PIN).
5. **GM email** (optional): the first person on the nightly recap.

**Create store** makes everything in one save, or nothing. The page then shows what was made and
"Tell Claude **Publish \<slug\>**". A refusal says what to fix (a taken web address, a name already
used, a PIN that is the manager PIN...).

To check a web address before typing it: `validate.py slug <slug>`.

## Step 2 (Claude): publish it

1. **Read its row** (Supabase connector, read-only, project `mnfwqmrstdeuczveyykv`):

   ```sql
   select slug, location, concept, side, address, is_test, phone_direct, editor_direct, close_direct,
          pin_hash is not null as has_pin, master_pin_hash is not null as has_manager_pin, created_by
     from mog.stores where slug = '<slug>';
   ```

   Expect `phone_direct`, `editor_direct`, `close_direct` and `has_pin` true and `created_by` set
   (made in HQ). `has_manager_pin` is false only until the manager PIN is first set in HQ.
2. **The stores.json entry:** `validate.py entry '<the row as JSON>'` prints it (the concept's
   stores.json spelling, the location without the concept and "(TEST)", `"editor": "supabase"`,
   no `deployment`, `"test": true` for a test store) and checks the slug is free. Paste it into
   `stores.json`: a store next to its concept's stores, a test store at the end.
3. **Hub cache:** a real store changes the hub's list, so bump `CACHE_VERSION` in the root `sw.js`
   (invariant #7). A test store isn't listed: no bump.
4. **Build and check:**

   ```
   python build.py
   python .claude/skills/mog-add-store/scripts/validate.py wired <slug> --published
   node tests/run_all.js
   ```

   `build.py` writes `<slug>/index.html`, `<slug>/sw.js` and `<slug>/editor/`, and the hub's list
   (a test store left out). `wired --published` says `OK`; `run_all` passes every gate.
5. **Commit and push** (CLAUDE.md convention 6; no question), then
   `python .claude/skills/mog-deploy-workflow/scripts/wait_live.py --marker "<slug>/sw.js=CACHE_VERSION"`
   in the background. GitHub Pages takes about a minute.
6. Tell Sebastian the address: `https://sebheh.github.io/mog-mobile/<slug>/`.

## Step 3 (Sebastian, a computer): its items

Either:
- **From a library:** HQ → Libraries → the concept and side → **Set up stores from it**, ticking the
  new store. Items arrive with no par and no storage area.
- **From MarginEdge:** open `https://sebheh.github.io/mog-mobile/<slug>/` on a computer, sign in with
  the store PIN, **Manage → Overview** and its checklist: Import from MarginEdge (vendors, then
  items), each vendor's delivery days, storage areas, each item's area and par, shelf order.

Then **Settings → Recipients** for more recap recipients, and **Settings → People** if wanted.

## Step 4 (Sebastian on a phone, then Claude the next morning): smoke test

1. A real store: the hub in a private tab → concept → site → BOH/FOH → the store. A test store: its
   address directly (it isn't on the hub).
2. Sign in with the store PIN. **Settings** shows `Server: Supabase · N ms`.
3. Today lists the vendors delivering today. Enter a count, leave the vendor and come back: the
   count is still there.
4. The manager PIN signs in too (manager mode), once it has been set in HQ.

**The next morning (Claude, read-only):** a `close` row for the store in `mog.night_log` just after
midnight its time; if anything was ordered, a `recap` row and the email at its recipients.

## Troubleshooting

- **`/<slug>/` 404:** Pages hasn't rebuilt yet, or step 2's build wasn't committed.
- **PIN rejected:** a wrong PIN; five misses lock the store for 5 minutes (wait, or on a signed-in
  computer Manage → Overview's "PIN lockout" fix). A forgotten PIN: HQ → Stores → Change PIN.
- **"Taking longer than usual · Refresh" in the morning:** the close hasn't run yet; it retries every
  15 minutes (`mog.night_log`).
- **No Manage in the sidebar on a computer:** the window is under 900px wide.
- **The hub tile shows a generic icon:** the hub has no `CONCEPT_VISUALS` entry for that exact
  concept string (`validate.py concept` warns).
- **Sign-in says the setup is wrong when Supabase is down:** a store made in HQ has no `/exec` to
  fall back to; it signs in once Supabase answers again.

## A new concept

Not this runbook: it's a code change, walked through first. The same name, spelled alike, in:
- `build.py` `CONCEPT_TO_THEME`, the hub's `CONCEPT_VISUALS`, a `[data-theme]` block and
  `CONCEPT_NAMES_` in `template/index.html`;
- `apps-script/Concepts.gs` `CONCEPT_THEMES` (the recap's colours; the close function bundles it);
- a new schema version's `mog.concept_name` (what HQ's New store accepts and the name it gives);
- `template/hq/stores.js` `NAMES`, `BRAND`, `LOGO`, `PREFIX` and `ORDER`, and its logo in
  `template/hq/`.

`tests/concepts.test.js` and `tests/hq_stores.test.js` fail until they agree.

## State to update afterward

- `docs/MOG_CurrentState.md`: add the store to the "Live stores" table (a test store: say so).
- The session handoff runs only when Sebastian asks to wrap up (`mog-session-handoff`).

## Anti-patterns

- **Publishing before the store exists in Supabase.** The page would sign in to nothing
  ("Unknown store"). HQ first, always.
- **A `deployment` field for a store made in HQ.** It has no Sheet; leave the field out.
- **Reusing a retired web address.** Old home-screen icons still point at it.
- **Copying a Sheet to make a store.** The 11-step Sheet runbook (in git history before 2026-11-15)
  is retired with the Sheets.

## When this skill should NOT run

- **A store's PIN:** HQ → Stores → Change PIN (every phone there is signed out).
- **The manager PIN:** HQ → Stores → Manager PIN, for every store at once.
- **Removing a store:** not covered. A store has Supabase rows (`mog.stores` and everything under
  it) and its folder; ask Sebastian before writing that procedure.
