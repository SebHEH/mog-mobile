# Session Handoff — Sheet retirement steps 2 and 3 live (Supabase closes every store)

**Session date:** 2026-11-15
**Session focus:** pick up from 11-12: check the backups and shadow nights, finish step 2's rollout, then step 3 (the phone off `/exec`).
**Outcome:**
- **Supabase closes every store, just after midnight.** `close_direct` is on at all 10 stores, and schema v25 moved the close from 3:30 AM to midnight (smoke_v25 11/11, probe 149/149).
- **App v0.34.0 / cache v77 on all 10 stores:** the phone never closes a cycle and the Daily summary is gone. CI `gates` green on every commit.
- **The first all-Supabase night is tonight** (cycle 11-15). A read-only check is scheduled for 7:41 AM on 11-16.

**Next session focus:** get everything ready for the full move off the Sheets: read the first night's check, then step 4 (PINs and New store in HQ), then step 5's retirement checklist.

---

## What shipped

### Checks (read-only) before anything moved
- **Backups:** one heartbeat a day since 11-13 (40 tables, about 18,200 rows); the watchdog sent no alert.
- **Shadow nights:** cycles 11-11, 11-12 and 11-13 matched Apps Script row for row at all 10 stores.
  - Cycle 11-14: nobody ordered.
  - rpt's 11-14 cycle had been closed at 00:01 by the phone's new-day reset (a KM opened the app after midnight), so it had no shadow.
- **rprfo's new Apps Script** (deployed 11-12): closed the 11-12 cycle (9 rows) and wrote `recap_sent_for`. Each of its 4 recipients got one recap.
- **The shared once-per-cycle flag works live:** the Daily summaries sent today at rpt (1:43 PM) and tnytf (1:47 PM) set `recap_sent_for = 2026-11-15`. Tonight's close skips their recap.

### Step 2 finished: Supabase closes every store
- **Apps Script to the other 10 targets** (`deploy.py --redeploy`, about 1:30 PM ET).
  - All 11 targets pushed and deployed OK; every store's `/exec` answers a bad-JSON POST in about 1.5 s.
  - `--redeploy` was needed because the phone's reset and the recap still ran through `/exec` at that point.
- **`close_direct` on:** rprfo at 1:40 PM ET, then the other nine at about 1:55 PM. Sebastian's pick: all nine at once, dropping R9's three canary nights.
- **Rollback for a store:** `close_direct = false`, then Move this store to Supabase in its Sheet, which re-installs the 3:30 AM trigger.

### Step 3: the phone stops closing; the close moves to midnight; the Daily summary goes
Sebastian's decisions, 2026-11-15 (spec "Step 3"):
- **One place closes a day.** R7 had the phone ask the function to close; replaced by: the phone never closes.
- **Midnight, not 3:30 AM.** The only counts after midnight in 4 weeks were RP Tysons BOH's Saturday-night Chef Center count (12:01 to 12:38 AM), which the phone's midnight reset filed under Sunday's order. Nobody counted between 11 PM and midnight.
- **The Daily summary is removed**, asked twice. The second time Sebastian had the KM brief's 11-03 "DO NOT SKIP" rule in front of him, and the actual use: 9 sends on about 58 store-days with orders. Orders are now placed from the app (View full order list, Copy order for email); the recap after the close is the day's record.

What went live:
- **Schema v25** (`ec8c9ea`): `mog.night_due` names a close from midnight.
  - Live at about 2:45 PM ET: smoke_v25 11/11, `check_api.sh` 149/149.
  - PGlite all pass; 4 planted defects caught.
  - smoke_v23's three "not before 3:30" rows are skipped in PGlite, with the reason.
- **smoke_v25 rolls itself back** instead of deleting its test store. The Supabase connector asks to confirm any `delete` or `truncate`, the app never shows that question, and the call hung 10 minutes. The tool's error: "The server asked the user a question, and no answer came before the time limit."
- **App v0.34.0 / store cache v77:** canary rprfo `220d3d2`, then the other nine `aeb165d`.
  - The phone runs no new-day reset. A cycle still behind shows "Taking longer than usual · Refresh", without the work-offline button.
  - Every Daily summary entry point is removed: the all-done button, the out-of-date banner, the order list's button, Settings → Daily summary, and the send after Mark all reviewed.
  - The old sent markers are pruned on boot.
  - Checked: 41 gates; every built page's scripts parse; a headless Edge run against the local fake Supabase (a normal day: only `mog_login` and `mog_snapshot2`, no `/exec`; a stale day: the Refresh screen, no close call).
  - Not yet opened on a real phone (that needs a PIN).
- **Docs:**
  - the KM brief: steps 6 to 8, the daily rhythm, what goes wrong, Q&A, what's new;
  - the Logic Blueprint (`3e3c743`): R0, R12, R13, R13a, the new-day flow and contract, the diagram, integrations;
  - the spec, CurrentState, FileInventory.
- **Moved to step 5:** sign-in's fallback to `/exec` when Supabase can't be reached. It sits in the direct client that `tests/pwa_direct.test.js` runs as written, and it never fires while Supabase answers.

### Rules changed
- **Cutovers run without a question** (CLAUDE.md convention 2, ProjectNotes, `mog-deploy-workflow`), matching Sebastian's global rule of 11-13. The connector may flip a store's switch.
- **Schema files through the connector** were approved for v25 ("run it when gated"). The repo rule for later schema files is unchanged: a schema file still asks first.

## Outstanding (carry forward)

1. **The first all-Supabase night (cycle 11-15, closed just after midnight on 11-16).** The scheduled task "Check the first all-Supabase close (10 stores)" fires at 7:41 AM ET into this chat.
   - It checks: a `close` row per store in `mog.night_log`; recaps (none expected for rpt and tnytf); `sheet_trigger_off_at` set at all 10; Gmail (no duplicates, no bounce, sender `noreply@`).
   - If this chat isn't open, run the same reads in the next session.
   - If the phone change wasn't live at midnight, a phone could have closed a store through `/exec` first. It was live from about 4 PM, so that shouldn't happen.
2. **Tell the KMs** the Daily summary is gone: orders go from View full order list or Copy order for email, and the recap arrives just after midnight. The message is Sebastian's to send; Claude can draft it.
3. **See v0.34.0 on a real phone once:** sign in at any store, open Settings (no Daily summary row), and finish a vendor (the all-done panel has no email button).
4. **The global proposal** `supabase-schema-change-2026-11-15-c` (an addendum to Toast's `supabase-schema-change-2026-11-15`) waits for review in Claude-SKills.
5. **Older smoke files still `delete`:** run them in the SQL Editor, not the connector (`mog-supabase-schema`).
6. **From earlier handoffs, still open:**
   - Horse Pho and the ELPIS renames;
   - W2a's first use and the TEST store's Elpis deliveries;
   - Dan's pound answer;
   - Donny's onboarding;
   - Sebastian's QoL and UI list;
   - the MarginEdge daily sheets.

## Files touched this chat

- **Supabase:** `supabase/schema_v25.sql` (new), `supabase/tests/smoke_v25.sql` (new, rolls itself back), `supabase/tests/run_pglite.mjs` (skips three smoke_v23 rows), `supabase/night_schedule.sql` (comment).
- **Gates:** `tests/fake_supabase.js` (close due from midnight), `tests/night_close.test.js` (the midnight scenario).
- **App:** `template/index.html` (v0.34.0: no reset, no Daily summary), `template/sw.js` (v77); every store's `index.html` and `sw.js` (generated).
- **Apps Script:** no code change; deployed to all 11 targets.
- **Docs:**
  - `CLAUDE.md` (convention 2, the connector's writes);
  - `docs/MOG_CurrentState.md`, `docs/MOG_SheetRetirement_Spec.md`, `docs/MOG_ProjectNotes.md` (cutovers, clasp, the Git Bash clock, preview without Playwright), `docs/MOG_FileInventory.md`;
  - `docs/MOG_OrderingApp_KM_Brief.md`, `docs/MOG_LogicBlueprint.md` and `.html`; this handoff.
- **Skills:** `.claude/skills/mog-supabase-schema/SKILL.md` (smoke files roll themselves back), `.claude/skills/mog-deploy-workflow/SKILL.md` (cutovers).
- **Outside the repo:** the global proposal `supabase-schema-change-2026-11-15-c`; clasp 3 reinstalled globally (`npm install -g @google/clasp@3`).
- **Live data:** `mog.stores.close_direct` on at 10 stores; rpt's bouncing recipient removed by Sebastian in the app.

## Process lessons

- **The Supabase connector hangs on `delete` and `truncate`** (a confirmation the app never shows); `update`, `create or replace` and `revoke` pass. A smoke file rolls itself back instead. [→ mog-supabase-schema, proposal supabase-schema-change-2026-11-15-c]
- **Before removing a KM-facing feature, read what the KM brief and the Blueprint say about it.** The Daily summary was a "DO NOT SKIP" step in the brief, found only after the canary shipped; the decision had to be asked a second time. [→ mog-deploy-workflow]
- **Git Bash's `TZ=America/New_York date` prints UTC** (no time zone data), and a deploy was logged five hours late. Read the time from the database. [→ docs/MOG_ProjectNotes.md]
- **clasp can disappear while its login stays:** reinstall clasp 3, no new login. [→ docs/MOG_ProjectNotes.md]
- **The Write tool turns a `í` escape into the character itself,** so a script matching a JS escape must build the backslash with `chr(92)`. The guarded script stopped before writing, as it should. [→ docs/MOG_ProjectNotes.md]
- **A real-browser check works without Playwright or the browser pane:** `playwright-core` in a scratch folder, the installed Edge, the repo's preview server. [→ docs/MOG_ProjectNotes.md]
- **Other sessions can't be read from here** when they only accept trusted devices. [→ one-off]

**Skill gate:** one question: "Fold 'read the KM brief and Blueprint before removing a KM-facing feature' into mog-deploy-workflow?" → Apply (new section "Removing or changing something KMs use: read the brief first"). The connector lesson was already applied in `mog-supabase-schema` and proposed globally during the session; the rest are project facts in ProjectNotes. Checked: the lessons above, Sebastian's corrections (the Daily summary asked twice, the clarification on Saturday counting), and the rejected tool calls (the two `list_events` reads of other sessions, refused as untrusted).

## Commits landed this session

```
3e3c743 docs: Logic Blueprint for steps 2 and 3 (the midnight close, no phone reset, orders placed from the app)
aeb165d Step 3 fan-out: no phone reset, no Daily summary at the other nine stores (app v0.34.0, cache v77); KM brief rewritten
220d3d2 Phone stops closing the cycle; Daily summary removed (step 3, canary rprfo; app v0.34.0, cache v77)
ec8c9ea Schema v25: the nightly close from midnight (Sheet retirement step 3, live)
9891870 docs: close_direct on at all 10 stores (Sheet retirement step 2, step 9)
91c562e rprfo's close_direct on (Sheet retirement step 2, step 8); cutovers no longer ask first
b2be233 docs: Apps Script fan-out live on all 11 targets; shadow nights matched; backups daily
```

## Opening prompt for next session

```
Read docs/MOG_CurrentState.md, docs/MOG_SessionHandoff_2026_11_15.md and docs/MOG_SheetRetirement_Spec.md ("Order of work", "Step 3") first, and run git pull.
Live since 11-15: Supabase closes all 10 stores just after midnight (close_direct on everywhere, schema v25); app v0.34.0 has no phone reset and no Daily summary. Each Sheet's Apps Script should have retired its 3:30 AM trigger on the first night.
First, read-only: did the first all-Supabase night (cycle 11-15) work? night_log close rows at all 10, recaps (none expected for rpt and tnytf), sheet_trigger_off_at at all 10, Gmail (no duplicates, from noreply@). If the 7:41 AM scheduled check already reported in the old chat, use that.
Goal: everything ready for the full move off the Sheets, even if not all of it ships. Step 4 first: PINs owned by Supabase and set in HQ, HQ -> Stores -> New store in one transaction, mog-add-store down to about 4 steps, tried on a TEST store (needs a walkthrough and schema v26; smoke files roll themselves back, never delete). Then step 5's retirement checklist: the sign-in /exec fallback (and tests/pwa_direct.test.js), deploy.py's store targets, the Sheets' remaining triggers, mog-exec-repoint, CLAUDE.md's layers and rules 5 and 6.
```

---

## Later session — HQ Stores (step 4) and the step 5 checklist

**Session focus:** read the first all-Supabase night, then step 4 (PINs and New store in HQ, `mog-add-store` down to about 4 steps, a TEST store), then step 5's retirement checklist.
**Outcome:**
- **The night check couldn't run yet:** the database clock said 3:33 PM on 11-15, so the first all-Supabase night is the coming one. Checked instead: all 10 due at 12:16 AM, nothing before; the 3:30 AM trigger retires itself whatever the cycle says (`Sync.gs:558`).
- **Step 4 is built and its code is live; schema v26 has not run.** The connector hung on it (the word `delete` in two function bodies) and ran nothing; Grok Bot is to paste it in the SQL Editor.
- **Step 5's checklist is written** (spec, "Step 5"), with a proposed order and the decisions it needs.

**Next session focus:** v26's smoke and probe, the manager PIN set once, the TEST store trial; then step 5's decisions.

### What shipped

- **Walkthrough and mockups approved** (https://claude.ai/artifact/665XFnU7VfRaKXntyXLtxu). Sebastian's picks:
  - manager PIN first per store, then changed on seeing the form: **one manager PIN for every store and concept, locked to one PIN**;
  - **the New store form takes the picked concept's colours and logo**;
  - the TEST store published but hidden (`"test": true`);
  - v26 asks first (then "run it now").
- **Schema v26** (`efcaf52`, not run): `mog_hq_stores(token, action, row)`:
  - `create`: a whole store with no Sheet in one transaction;
  - `pin`: a store's PIN, ending every sign-in there;
  - `managerPin`: one hash at every store, kept by the trigger `stores_manager_pin`; refused when it's any store's PIN.
  - `mog_sync_set_pins` answers `PINS_IN_HQ` once Supabase closes the store; `mog_hq_data` gains each store's PIN record, flags, time zone, address and recap count.
  - Generated with `sqlgen.py` (`mog_hq_data` from v14, `mog_sync_set_pins` from schema.sql). PGlite 30/30, the whole chain re-run clean, 11 planted defects caught.
- **HQ → Stores and New store** (`template/hq/stores.js`; ĂN and Lei'd marks from the brand kit). Before v26 the page says it needs it. Checked in headless Edge against the fake: a Lei'd Poke store created, a PIN changed, the manager PIN set, no sideways scroll at 390 px.
- **A store with no Sheet:**
  - `build.py` takes a store with no `deployment` (it must have `"editor": "supabase"`) and `"test": true` (built, never on the hub);
  - the app keys such a store's local storage by slug and never falls back to `/exec` for it (app v0.34.1, cache v78; canary rprfo `efcaf52`, fan-out `7535744`; no change for the 10 stores, all serving v78, CI green).
  - Found on the way: the app's storage namespace is the store's deployment id, so dropping a `deployment` would orphan drafts and save queues.
- **`mog-add-store` rewritten to four steps** (HQ, "Publish <slug>", items, smoke test). `validate.py` loses the Sheet checks and gains `entry` (the store's row into its `stores.json` entry).
- **Gate `tests/hq_stores.test.js`**: 12 controls, covering parity with the SQL, the form, Create, Change PIN, the manager PIN, before v26, and `build.py`. 42 gates.
- **Docs** (`6f8fff8`): the spec's Step 4, CurrentState, ProjectNotes (HQ Stores), the function table, FileInventory, CLAUDE.md's `mog-add-store` row. Step 5's checklist in the spec (this commit).

### Outstanding (carry forward)

1. **Schema v26:** Grok Bot pastes [supabase/schema_v26.sql](../supabase/schema_v26.sql) in the SQL Editor (Sebastian is asking it).
   - Then Claude checks with reads (`mog_hq_stores`, `mog.manager_pin`, the trigger, `mog.stores.pin_set_at`; none existed at the end of this session).
   - Then `smoke_v26.sql` through the connector (no `delete` in it; 30 rows) and `check_api.sh`.
2. **Then, in HQ → Stores (Sebastian):** set the manager PIN once (every store gets it), and create a TEST store. Claude publishes it ("Publish <slug>", `mog-add-store`). A phone sign-in and a count follow. The next morning: its close and recap, and a PIN changed in HQ still working.
3. **The Logic Blueprint** for the PIN rules (one manager PIN, PINs set in HQ, a store made in HQ), once v26 is live.
4. **The first all-Supabase night** (cycle 11-15, closed just after midnight on 11-16): still to read, unless the 7:41 AM check reported in the first 11-15 chat.
5. **Step 5** (spec, "Step 5"): ask its decisions first:
   - v27 refusing Apps Script's close and recap once `close_direct` is on: the Sheet's Reset On Hand checkbox and old app versions can still close a cycle and send a MailApp recap;
   - a fixed per-store storage namespace before the app drops `/exec`;
   - archiving the store `/exec` deployments;
   - what replaces the two Apps Script rollbacks.
6. **A global proposal** (an addendum to `supabase-schema-change-2026-11-15-c`): a schema file with `delete` in a function body also hangs the connector.
7. **From the first 11-15 block, still open:** tell the KMs the Daily summary is gone (a draft for Sebastian), see v0.34 on a real phone, the global proposal `-c`, older smoke files' `delete`s.

### Files touched this chat (later session)

- **Supabase:** `supabase/schema_v26.sql` (new, not run), `supabase/tests/smoke_v26.sql` (new), `supabase/tests/check_api.sh` (v26 block).
- **HQ:** `template/hq/stores.js` (new), `template/hq/index.html` (Stores nav, views, CSS, hooks), `template/hq/an-mark.svg` and `leid-mark.svg` (new). `hq/` is generated.
- **App:** `template/index.html` (v0.34.1: the slug namespace, no `/exec` fallback without an address), `template/sw.js` (v78). Every store's `index.html` and `sw.js` are generated.
- **Build and gates:** `build.py`, `tests/fake_supabase.js`, `tests/hq_stores.test.js` (new).
- **Skills:** `mog-add-store` (`SKILL.md`, `scripts/validate.py`), `mog-supabase-schema` (the connector and `delete` in a schema file).
- **Docs:** `docs/MOG_SheetRetirement_Spec.md` (Step 4, Step 5), `docs/MOG_CurrentState.md`, `docs/MOG_ProjectNotes.md`, `docs/MOG_SupabaseMigration.md`, `docs/MOG_FileInventory.md`, `CLAUDE.md`, this handoff.
- **Live data:** none (v26 not run; the connector's attempt ran nothing).

### Process lessons

- **The connector holds any SQL containing `delete` for a confirmation, inside a function body too, and that question never reaches the app.** v26 hung 10 minutes and ran nothing. Grep a schema file before running it through the connector; on a hit, the maintainer pastes it. The global proposal is still to file (Outstanding 6). [→ mog-supabase-schema]
- **The app's local storage is keyed by the store's `/exec` deployment id**, and no gate checks it (the harness stubs `nsKey_`). Any change to a store's `deployment` orphans the drafts and save queues on its phones. Also in the spec's Step 5. [→ docs/MOG_ProjectNotes.md]
- **A helper added to a function that gates slice by name crashes those gates** (`hasExec_` inside `api()`). Inline the check or add the helper to every slice plan (mog-supabase-schema already has the slice-plan rule). [→ one-off]
- **The preview server keeps its data in memory between browser runs:** a second run needs fresh names. [→ one-off]

**Skill gate:** no question this time. The one skill lesson was applied during the session and shown in chat (mog-supabase-schema, `6f8fff8`). The others are project facts already in ProjectNotes and the spec, or one-offs. Checked: the lessons above; Sebastian's corrections (the manager PIN changed after the mockup; the concept's look on the form); the rejected tool call (the connector's hang).

### Commits landed this session (later)

```
efcaf52 HQ Stores: new store in one save, PINs in Supabase, one manager PIN (step 4, canary rprfo; schema v26 not run yet)
7535744 Step 4 fan-out: app v0.34.1 / cache v78 at the other nine stores
6f8fff8 docs: Sheet retirement step 4 built (HQ Stores, one manager PIN); schema v26 waits for the SQL Editor
```

### Opening prompt for next session

```
Read docs/MOG_CurrentState.md, the "Later session" block of docs/MOG_SessionHandoff_2026_11_15.md and docs/MOG_SheetRetirement_Spec.md ("Step 4", "Step 5") first, and run git pull.
First, read-only: the first all-Supabase night (cycle 11-15, closed just after midnight on 11-16): a close row per store in mog.night_log, sheet_trigger_off_at at all 10, recaps from noreply@ with no duplicates (none expected for rpt and tnytf). If the 7:41 AM check already reported in the first 11-15 chat, use that.
Then step 4's last part: was schema v26 pasted in the SQL Editor (Grok Bot)? Check with reads (mog_hq_stores, mog.manager_pin, the trigger stores_manager_pin, mog.stores.pin_set_at), then run supabase/tests/smoke_v26.sql through the connector (no delete in it; 30 rows) and check_api.sh. Then I set the manager PIN once in HQ -> Stores and make a TEST store; "Publish <slug>" follows mog-add-store; its close and a PIN change are checked the next morning; then the Logic Blueprint for the PIN rules.
Then step 5: ask the spec's Step 5 decisions first (v27 refusing Apps Script's close and recap once close_direct is on; a fixed per-store storage namespace before the app drops /exec; archiving the store /exec deployments; what replaces the Apps Script rollbacks), then build in the proposed order.
```
