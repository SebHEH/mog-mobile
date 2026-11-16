# Session Handoff — Sheet retirement step 5 (v27, app without /exec), v26 live, the first store made in HQ

**Session date:** 2026-11-15 evening to 2026-11-16 (one chat)
**Session focus:** read the first all-Supabase night, finish step 4 (schema v26 live, the manager PIN, a TEST store), then ask step 5's decisions and build in the proposed order.
**Outcome:**
- **Step 5 decided** (all four as proposed) and its items 1 and 2 are live: schema v27 refuses Apps Script's close and recap flag while `close_direct` is on; app v0.35.0 / cache v79 runs with no `/exec` at all 10 stores, with each store's storage key fixed in `stores.json` (`ns`).
- **Step 4 is live:** schema v26 (pasted by Grok Bot), smoke_v26 30/30, probe 160/160. The manager PIN is set in HQ (one code at every store), and the first store made in HQ, `leidtyson`, is published.
- **The first all-Supabase night (cycle 11-15) was clean** at all 10 stores.

**Next session focus:** Sebastian brings notes from Grok. Then the TEST store trial (its items, recipients, a count, its first close, a PIN change), and step 5's last items once that trial and the nights are clean.

---

## Section A: the first all-Supabase night and step 4

### What shipped
- **The first night (read 8:46 AM ET on 11-16):**
  - all 10 stores closed just after midnight;
  - rpr (70 lines) and rpfr (15) sent their recaps on the first try, 2 of 2 recipients each, none failed, no repeats;
  - rpt (27 lines) and tnytf (61) owed no recap: their Daily summaries had gone out at 1:43 and 1:47 PM on 11-15;
  - the other six stores ordered nothing;
  - each Sheet's 3:30 AM trigger retired itself between 3:23 and 3:37 AM (`sheet_trigger_off_at` at all 10).
  - Not seen: the `noreply@` sender. The relay's recaps aren't in Sebastian's mailbox (he isn't a recipient at rpr or rpfr).
- **Schema v26 live** (about 9 PM ET, 11-15):
  - pasted in the SQL Editor by Grok Bot, because the connector hangs on its `delete`s;
  - checked with reads: `mog_hq_stores`, `mog.manager_pin`, the trigger and the four new columns;
  - smoke_v26 30/30 through the connector (it rolled itself back, and every store's manager PIN came back as it was);
  - `check_api.sh` 160/160.
- **The manager PIN** was set in HQ at 7:49 AM on 11-16: one hash now at all 11 stores.
- **`leidtyson` published** (`fd8b786`):
  - "Lei'd Poke Tyson BOH (TEST)", made in HQ by Sebastian at 8:42 AM on 11-16;
  - no Sheet, no `/exec`, `ns` `s_leidtyson`, not on the hub;
  - `validate.py wired --published` OK, 43 gates, CI green;
  - the live page boots to the PIN screen with no calls and no script errors.
- **Logic Blueprint** R15a (PINs set in HQ, one locked manager PIN) and R15b (a store made in HQ in one step), stamped `f0c7882`.

### Outstanding (carry forward)
1. **The TEST store trial has only its sign-in.** At 4:47 PM ET on 11-16 `leidtyson` had one sign-in (about 9:05 AM), but 0 vendors, 0 items, 0 recipients, 0 counts, and its PIN unchanged since it was made. Left, from `mog-add-store` steps 3 and 4:
   - Settings → Recipients (with none, its recap has nobody to go to);
   - Manage → Overview's checklist: a vendor, items, areas, pars;
   - a phone sign-in and a count;
   - HQ → Stores → Change PIN, used the next morning;
   - the next morning, Claude reads its `close` row and recap.
2. Its name says "Tyson", the other stores "Tysons". HQ has no rename. Say if it matters (it's a test store).
3. **See v0.35.0 on a real phone once:** the rprfo canary was checked in a desktop browser (the same code; only the layout differs).

## Section B: Sheet retirement step 5

### What shipped
- **Decided** (spec "Step 5", all four as proposed):
  1. v27 refuses Apps Script's close and recap flag;
  2. a fixed `ns` per store in `stores.json`;
  3. all 10 store deployments archived at once, after the nights and the TEST trial are clean;
  4. rollback is fix forward plus the nightly backup (`select mog.night_tick();` re-runs a close).
- **Schema v27** (`ea6d4d6`; live about 9:15 PM ET on 11-15 through the connector, on Sebastian's go):
  - `mog_sync_close_cycle` and `mog_sync_set_recap_sent` answer `CLOSE_DIRECT` while the store's `close_direct` is on, after the key check;
  - the nightly close is untouched: it goes through `mog.night_close` → `mog.close_cycle`;
  - checked: smoke_v27 14/14 (rolls itself back, no `delete`), 4 planted defects caught, probe 160/160, and tonight's close still due at all 10 afterwards.
  - Five smoke_v23 rows that had Apps Script set the flag with `close_direct` on are skipped in PGlite, with the reason (`run_pglite.mjs` now takes several skip groups per file).
- **`ns` in `stores.json`** (`4008355`):
  - each store's phone storage key is now a field: the same 12 characters as before for a store from a Sheet, `s_<slug>` for a store made in HQ;
  - `build.py` requires it, checks it against the deployment while one is listed, refuses a shared one, and injects it into `window.MOG_STORE`; the app's `storeNs_` (was `deploymentNs_`) reads it;
  - `mog-add-store`'s `validate.py entry` writes it;
  - gate `store_ns`: for every store, the new page's key equals what v0.34.1's own code took from the address (5 controls).
- **App v0.35.0 / cache v79 with no `/exec`** (canary rprfo `67232ca`, the other nine `f0c7882`; all 10 serving v79, CI green):
  - removed: `apiOnce_`, the USE_EXEC redo, the `DIRECT_ACTIONS` / `DIRECT_WHEN_MOVED` routing, `DIRECT_EXEC_SIGNALS`, the `'exec'` mode and sign-in's fallback;
  - Supabase unreachable at sign-in is offline after three tries; a refusal (USE_EXEC, Unknown store, EDITOR_NOT_DIRECT) is the error on screen;
  - **found and guarded:** the save queue drains at app start, before the PIN. Through `/exec` that failed harmlessly; direct, it would have sent an empty PIN to `mog_login`, a lockout strike at the store. Now nothing is sent until sign-in, and the queue drains after it.
  - Gates reworked: `pwa_direct` (13 controls bite, 27 s instead of 52 s), `phone_harness`, `recipients_people`'s before-the-move case. Checked in Edge against the preview, and the live rprfo page booted with no calls before a PIN.
  - Grok Bot signed in at rprfo in a desktop browser and saved a count (Chopsticks, 1). It orders nothing (par 0.33 × 2 − 1 < 0) and belongs to cycle 11-15 only.
- `window.MOG_API_URL`, the `__MOG_API_URL__` placeholder and `stores.json`'s `deployment` stay, unused, until items 3 to 6.

### Outstanding (carry forward)
1. **Step 5, items 3 to 6** (once the TEST trial and a few more nights are clean; spec "Step 5"):
   - archive the 10 store `/exec` deployments (`clasp undeploy`; the addresses can't come back);
   - `deploy.py`'s store targets, `editor_link.py` and their gates, and `route.py`'s rows for `mail-relay/` and `supabase/functions/`;
   - `__MOG_API_URL__`, `window.MOG_API_URL` and `stores.json`'s `deployment` (CLAUDE.md invariant 5 then has five placeholders);
   - the obsolete skills (`mog-exec-repoint`, `mog-apps-script-caching`, `mog-rpc-consolidation`, `mog-editor-web-reskin`, `mog-health-check-extend`, `mog-sheet-formula-verify`, `mog-modal-ux-sweep`) and the partly stale ones;
   - CLAUDE.md's layers, invariants 2, 3, 9 and 10, and rules 5 and 6.
2. **A global proposal still to file:** a schema file with `delete` in a function body also hangs the connector (an addendum to `supabase-schema-change-2026-11-15-c`).
3. **From earlier handoffs, still open:** tell the KMs the Daily summary is gone (a draft for Sebastian); older smoke files' `delete`s (SQL Editor only); Horse Pho and the ELPIS renames; W2a's first use and the TEST store's Elpis deliveries; Dan's pound answer; Donny's onboarding.

## Files touched this chat

- **Supabase:** `supabase/schema_v27.sql` (new, live), `supabase/tests/smoke_v27.sql` (new), `supabase/tests/run_pglite.mjs` (skip groups; smoke_v23's v27 rows), `supabase/tests/check_api.sh` (v27 block).
- **App:** `template/index.html` (v0.35.0: no `/exec`, `storeNs_`, the no-PIN guard), `template/sw.js` (v79). Every store's `index.html` and `sw.js`, and `leidtyson/`, are generated.
- **Build and store list:** `build.py` (`ns` required, checked, injected; a preview gets its own), `stores.json` (`ns` at 10 stores, `leidtyson`).
- **Gates:** `tests/store_ns.test.js` (new), `tests/pwa_direct.test.js`, `tests/phone_harness.js`, `tests/recipients_people.test.js`, `tests/hq_stores.test.js`, `tests/fake_supabase.js` (v27's refusals), `tests/night_close.test.js` (the v27 scenario). 43 gates.
- **Skills:** `mog-add-store` (`SKILL.md`, `scripts/validate.py`: `ns`); from the lessons, `mog-pwa-audit` (item 9) and `mog-deploy-workflow` (`scripts/wait_live.py --skip`, the canary step).
- **Docs:** `docs/MOG_SheetRetirement_Spec.md` (Step 4 live, Step 5 decided and items 1 and 2), `docs/MOG_CurrentState.md`, `docs/MOG_SupabaseMigration.md`, `docs/MOG_FileInventory.md`, `docs/MOG_LogicBlueprint.md` and `.html` (R14, R15a, R15b), `docs/MOG_ProjectNotes.md` (the relay's recaps and Sebastian's mailbox), `CLAUDE.md` (the handoff import), this handoff.
- **Live data:** schema v26 (Grok Bot) and v27 (connector); the manager PIN and `leidtyson` (Sebastian, in HQ); one test count at rprfo (Grok Bot).

## Process lessons

- **Removing a fallback changes what runs before sign-in.** The save-queue drain at app start went to `/exec` with no PIN and failed harmlessly; direct, the same drain would have sent an empty PIN to `mog_login`, a lockout strike at the store on every start with a queue. Found only by tracing every caller of `api()` that can run before the PIN (the boot drain, the `online` event). [→ mog-pwa-audit]
- **A fan-out after a canary can't use `{store}` markers in `wait_live.py`:** the canary's old file already has the marker, so the check refuses. Listed the nine other stores' markers by hand. [→ mog-deploy-workflow]
- **The relay's recaps never reach Sebastian's mailbox** unless he is a recipient, so the morning check reads `mog.night_log`'s send counts and can't see the sender. [→ docs/MOG_ProjectNotes.md]
- **A reported hand step is checked in the database before it's recorded:** Grok Bot's "v26 is in" was confirmed with reads; "I think I did it" for the TEST trial showed only a sign-in. [→ one-off]
- **A planted control that can't bite is dropped, not kept:** `build.py`'s "no ns" check is shadowed by "ns must equal the deployment's", so its control could never fail. [→ one-off]
- **The Bash hook refuses a heredoc with a backslash in it:** Python edits with `\n` go through the Write tool and a script file, or the Edit tool. [→ one-off]

**Skill gate:** two questions. "Fold 'what runs before sign-in' into mog-pwa-audit?" → Apply (item 9). "Teach wait_live.py the fan-out after a canary?" → Script: `--skip <slug>` (and the line in mog-deploy-workflow's canary step). Both in `92a152d`. Checked: the lessons above; Sebastian's answers this session (all as recommended: step 5's four decisions, v27's go); the tool calls refused by the Bash hook (heredocs with a backslash, one-off) and the connector's two failed reads (wrong column names, one-off). The relay fact went into ProjectNotes.

## Commits landed this session

```
92a152d Skills: what runs before sign-in (mog-pwa-audit); wait_live --skip for a fan-out after a canary
5bd4942 docs: first all-Supabase night clean; leidtyson (TEST) published
fd8b786 Publish leidtyson: Lei'd Poke Tyson BOH (TEST), the first store made in HQ
6c2eaae docs: schema v26 and v27 live, app v0.35.0 at all 10 stores; Blueprint R15a and R15b
f0c7882 Step 5 item 2 fan-out: app v0.35.0 / cache v79 (no /exec) at the other nine stores
3fdaff6 docs: Sheet retirement step 5 decided; v27, ns and app v0.35.0 (canary) recorded
67232ca App without /exec (step 5, item 2; canary rprfo; app v0.35.0, cache v79)
4008355 Fixed per-store storage key: ns in stores.json (step 5, item 2; no change on a phone)
ea6d4d6 Schema v27: Apps Script's close and recap flag refused once close_direct is on (step 5, item 1; not run yet)
```

## Opening prompt for next session

```
Read docs/MOG_CurrentState.md, docs/MOG_SessionHandoff_2026_11_16.md and docs/MOG_SheetRetirement_Spec.md ("Step 4", "Step 5") first, and run git pull.
Live since 11-15/16: schema v26 and v27; app v0.35.0 / cache v79 with no /exec at all 10 stores (storage keys from stores.json ns); the manager PIN set in HQ; the TEST store leidtyson made in HQ and published. The first all-Supabase night (cycle 11-15) was clean.
First I'll paste notes from Grok: read them before anything else, check any claim against the database or the repo, and fold what they ask into the plan.
Then, read-only: last night's close at all 10 stores and at leidtyson (mog.night_log), and where the TEST trial stands (its vendors, items, recipients, counts, pin_set_at). Then step 5's items 3 to 6 once the trial and the nights are clean: archive the 10 store /exec deployments, retire deploy.py's store targets, __MOG_API_URL__ and stores.json's deployment, the obsolete skills, and CLAUDE.md's layers, invariants and rules 5 and 6.
```
