---
name: mog-add-store
disable-model-invocation: true
description: End-to-end runbook for onboarding a new MOG store, current as of 2026-10-19 (every store counts in Supabase and edits its catalog in the app). Copy the master template Sheet → Script ID + web-app deploy → wire .clasp-targets.json + provision_stores.sql → push → ?page=setup wizard → Move this store to Supabase → Move the editor to the app (start empty) → stores.json + build.py + push → set the catalog up from the app's Overview checklist (Import from MarginEdge) → smoke test. Trigger when Sebastian asks to "add a new store", "set up a new location", "onboard a city or concept", "new sheet for a location", or any close variant. Most steps are his (Drive, Apps Script editor, Sheet menus, Supabase SQL Editor, the app); Claude sequences them, validates every pasted value with scripts/validate.py, and does the local file edits. Skip for changes to an existing store (a deployment URL or label is a stores.json edit + build.py; a PIN is the Sheet's Setup menu).
---

# mog-add-store

The procedure for adding a store. A new store ends in the same state as the other ten:
- phones count in Supabase directly (`phone_direct` on);
- the catalog is edited in the app, on a computer (`editor_direct` on);
- the cycle closes at 3:30 AM in Supabase, and the recap email goes out from the Sheet's script;
- the Sheet holds the script, the PINs (Script Properties) and the nightly LOG_ORDERS backup. Its catalog is frozen (one-app spec S2).

Background: `docs/MOG_SupabaseMigration.md` §8 (Move this store to Supabase) and `docs/MOG_OneApp_Spec.md` S2, S3, U10, U11 (Move the editor to the app).

**How to run it:** one step at a time. Say whose step it is, wait for Sebastian's result, check it, then go on. Validate every pasted value with the script instead of eyeballing it:

```
python .claude/skills/mog-add-store/scripts/validate.py <check> <value>
```

`OK` (exit 0) means go on; `INVALID` (exit 1) prints why.

## Before you start

Get these from Sebastian (ask with the picker; a missing one is a blocker, not a choice):

| Input | Rule | Check |
|---|---|---|
| **Slug** | 2-20 lowercase letters or digits, **no hyphens** (Supabase's `mog.stores` and the Move prompt refuse them, so `build.py` does too). Permanent once published: KMs bookmark `/<slug>/`. | `validate.py slug <slug>` |
| **Concept** | The exact `stores.json` string: `Roll Play`, `Teas’n You`, `ĂN` or `Lei’d Poke` (curly U+2019 apostrophes). `build.py` stops on any other spelling. | `validate.py concept "<Concept>"` |
| **Location** | `<Site> BOH` or `<Site> FOH` (the hub splits it into site and area). | `wired` checks it later |
| **Address** | The street address vendors deliver to (Copy order for email). Optional. | — |
| **Store PIN** | 4-8 digits; he types it into the wizard himself. | — |
| **Master PIN** | Optional; the shared manager PIN, so the store is reachable in manager mode. | — |
| **GM email** | Optional; the first daily-summary recipient. | — |

**`concept` says INVALID for a name nobody has used:** it's a new concept. Stop: that's its own change, so walk through it first. It needs the same name, spelled exactly alike, in:
- `apps-script/Dashboard.gs` `CONCEPT_THEMES` (its theme and `name`: the setup wizard and the Sheet menus accept only these);
- `apps-script/Setup.html` (the wizard's concept list, names, colors and store-code letters);
- `template/index.html` (`CONCEPT_NAMES_` and a `[data-theme]` block);
- `build.py` `CONCEPT_TO_THEME` and the hub's `CONCEPT_VISUALS`;
- `apps-script/EditorShell.html` (`mgeShortLoc_` and the logos);
- ideally a circular logo in the app's sprite (U6).

`tests/concepts.test.js` fails until they agree.

## The steps

### Step 1 (Sebastian, Drive): copy the master template Sheet

1. Copy **MASTER_ORDERING_GUIDE_TEMPLATE** (its Sheet ID is under `_template` in `apps-script/.clasp-targets.json`). **Never copy a live store's Sheet** (see step 2 for why).
2. Rename it in the concept's pattern:
   - Roll Play: `RP_<SITE>_ORDERING_GUIDE` / `RP_<SITE>_FOH_ORDERING_GUIDE`
   - Teas'n You: `BOH TNY_<SITE>_ORDERING_GUIDE` / `FOH TNY_<SITE>_ORDERING_GUIDE`

   The exact title goes into two files in step 4, so settle it now.
3. Paste the new Sheet's address back.

**Check:** `validate.py sheetid "<the address>"` prints the Sheet ID.

### Step 2 (Sebastian, Apps Script editor): Script ID, and an empty config

1. In the new Sheet: **Extensions → Apps Script → Project Settings** (gear icon).
2. Copy the **Script ID** and paste it back.
3. Scroll to **Script Properties** on the same page and report what's listed.

**Checks:**
- `validate.py scriptid <value>`. A deployment ID (`AKfycb…`) or a Sheet ID gets a specific message.
- **Script Properties must not contain `MOG_SUPABASE_SLUG`, `MOG_SUPABASE_SYNC_KEY`, `MOG_BACKEND` or `MOG_EDITOR`.** If any is there, stop and have him delete those four before anything else.
  - They belong to another store, so the wizard, Clear Config and Set Master PIN would push this Sheet's PINs into that store's Supabase row and sign its phones out.
  - Clear Config doesn't remove them.
- A `MOG_API_PIN` there means the copy came configured: step 5 handles it.

**VERIFY (first time only):** whether copying a Sheet carries its script's Script Properties hasn't been observed in this repo. Record what he sees in this skill.

### Step 3 (Sebastian, Apps Script editor): deploy the web app

1. **Deploy → New deployment**, gear → **Web app**:
   - Description: `Initial deploy`
   - Execute as: **Me** (sebastian@hehfood.com)
   - Who has access: **Anyone**
2. **Deploy**, then **Authorize access**.
   - This grant is what lets `/exec` run.
   - Keep **Connect to an external service** ticked: step 7 needs it to reach Supabase.
3. Copy the **Web app** URL and paste it back.

**Check:** `validate.py exec-url <url>` prints the `deploymentId`. An `/edit` or `/dev` URL is the wrong field.

(Deploying in the editor, rather than with `clasp deploy`, is deliberate: its Authorize step is the OAuth grant a fresh copy lacks. Whether a clasp-made deployment needs a separate grant is still open; see "Gaps".)

### Step 4 (Claude, local): wire the three registries, push the code

**1. `apps-script/.clasp-targets.json`:** add the entry next to its concept's stores (template stays first).

```json
{
  "slug": "<slug>",
  "label": "<Concept> - <Location>",
  "scriptId": "<step 2>",
  "deploymentId": "<step 3>",
  "sheet": { "title": "<exact Sheet title, step 1>", "id": "<step 1>" }
}
```

Both IDs go in at once. `deploy.py --redeploy` refuses to run for **every** store while any target lacks a `deploymentId`, and `sheet` is read by `editor_link.py` and the `supabase_move` gate.

**2. `supabase/provision_stores.sql`:** add a row with the next number.
- The store name is `<Concept> <Location>`, with a straight apostrophe doubled (`'Teas''n You …'`).
- The Sheet title must be identical to `.clasp-targets.json`'s.

```sql
  (11, '<slug>', '<Concept> <Location>', '<exact Sheet title>')
```

The `supabase_move` gate fails if this list and the deploy targets disagree.

**3. Check and push:**

```
python .claude/skills/mog-add-store/scripts/validate.py wired <slug>
node tests/run_all.js
python deploy.py --redeploy --target <slug>
```

- `wired` prints `stores.json: no entry yet` (expected at this point), then `OK`.
- `run_all` passes every gate (`run_all: ALL PASS`).
- `deploy.py` prints `PUSH OK: <slug>` and `DEPLOY OK: <slug>`.
  - The copy carries whatever code the template had, so this makes the store's `/exec` serve exactly the repo.
  - It touches only the new store.

**4. Verify:** `curl -sL "<exec URL>?page=api"` returns JSON with `"location": "Not configured"`.
- A store name there instead means the copy came configured (step 5 handles it).
- Use plain `curl -sL`: `-X POST` gives misleading results.

**`PUSH FAILED`:**
- "Project settings not found" usually means a wrong Script ID (back to step 2).
- A permission error means clasp is logged in as another Google account (`clasp login`).

### Step 5 (Sebastian, browser + Sheet): store identity

**The setup wizard:**
1. Open the bare `/exec` URL in a desktop browser. A store with no PIN always opens the wizard.
2. Pick the language, then concept, BOH/FOH and city; type the store PIN and GM email.
3. The wizard builds the store name (`Teas’n You Rockville BOH`) and code (`TNYROBOH`), then lands on the editor home.

The Sheet's **Ordering Guide → 📱 Mobile API → Setup / Re-run Setup** does the same in six prompts, if the wizard won't open. It also takes the master PIN, and the location prompt takes the full name (`<Concept> <Site> BOH`).

**If `/exec` shows a PIN screen instead of the wizard,** the copy came configured:
1. **📱 Mobile API → Status** shows whose config it is.
2. Then **📱 Mobile API → Clear Config (reset for setup)**, in **this new Sheet only**, after step 2's Supabase keys are confirmed gone.
3. Reload `/exec`.

**Then, in the Sheet:**
1. **📱 Mobile API → Set Master PIN**, if the store should be in manager mode. The wizard never sets it.
2. **📱 Mobile API → Status.** Check Location, Abbreviation, PIN, Master PIN and GM email. Then the **Recipients** line:
   - Opening Status also copies the GM email into the Sheet's recipient list, which step 8 copies to the app.
   - Expect `1 total · 1 active · 1 GM` with a GM email, `0 total` without one.
   - More than that means the template's rows came along. Fix them in the app after step 8 (Settings → Recipients).

### Step 6 (Sebastian, Supabase SQL Editor): the connect code

Run [supabase/provision_stores.sql](../../../supabase/provision_stores.sql).
- It lists only stores that haven't connected, so it should return one row: the new store's `connect_code` (`<slug>:<64 hex>`).
- The code goes straight into the Sheet in step 7. **Never into a chat.**
- Running the file again before step 7 issues a new code and voids the old one: use the latest.

### Step 7 (Sebastian, the Sheet): Move this store to Supabase

1. **Ordering Guide → 📱 Mobile API → Move this store to Supabase**, and paste the code.
2. Check the confirmation names this Sheet and `Code is for store: <slug>`, then **Yes**.
3. Run it as sebastian@hehfood.com: the 3:30 AM trigger it installs belongs to, and runs as, whoever runs this.

**Expect "Moved to Supabase":**
- Counts copied: 0
- Catalog pushed: the template's, replaced in step 8
- Nightly 3:30 AM run: installed
- Phones talk to Supabase directly: on

**Other outcomes:**
- **"One permission first":** use its Grant permission link, then run Move again. If the link asks nothing, have him run `authorizeSupabase`; paste `python editor_link.py authorizeSupabase <slug>` (convention #8).
- **"Not finished":** run Move again. It picks up where it stopped and doesn't ask for the code twice.
- **Phones "NOT turned on":** the move stands. Run [supabase/phones_direct.sql](../../../supabase/phones_direct.sql).
- **"BAD_SYNC_KEY":** the code is from an older run of the SQL file. Run it again and use the new code.

### Step 8 (Sebastian, the Sheet): Move the editor to the app (start empty)

1. **Ordering Guide → 📱 Mobile API → Move the editor to the app**, then **Yes = start empty**.
2. Type the slug to confirm.

**Expect "The editor is in the app":** "The app starts from an empty catalog", plus the recipients copied.

From now on this Sheet's catalog tools refuse and point to the app. Its catalog is frozen and never updated again (S2).

Start empty is right for a template copy:
- The catalog comes from MarginEdge in step 10.
- The copy path would also bring the template's LOG_ORDERS into the store's order history.
- Use **No (copy)** only for a Sheet deliberately filled with this store's real catalog. It refuses unless the parity check passes.

**Check (Claude, read-only Supabase connector, project `mnfwqmrstdeuczveyykv`):**

```sql
select s.slug, s.phone_direct, s.editor_direct, s.pin_hash is not null as has_pin,
       s.master_pin_hash is not null as has_master_pin, t.cycle_date
  from mog.stores s left join mog.store_state t on t.slug = s.slug
 where s.slug = '<slug>';
```

Expect `phone_direct`, `editor_direct` and `has_pin` all true. `cycle_date` may be the template's old date: the first app open or the 3:30 AM run starts a fresh day with nothing to log.

### Step 9 (Claude, local): publish the app

Publishing comes after both moves, so the store's first appearance on the hub is already on Supabase with its Manage section ready. No phone ever counts into this Sheet.

**1. `stores.json`:** add the entry next to its concept's stores.

```json
{
  "slug": "<slug>",
  "concept": "<exact concept string>",
  "location": "<Site> BOH",
  "address": "<street address>",
  "deployment": "<step 3 URL>",
  "editor": "supabase"
}
```

**2. Hub cache:** bump `CACHE_VERSION` in the root `sw.js`. The hub's store registry changes, so the cached hub must go (invariant #7). `template/sw.js` needs no bump.

**3. Build and check:**

```
python build.py
python .claude/skills/mog-add-store/scripts/validate.py wired <slug> --published
node tests/run_all.js
```

- `build.py` writes `<slug>/index.html`, `<slug>/sw.js` and `<slug>/editor/`, and the hub registry line in `index.html`.
- `wired --published` says `OK`.
- `run_all` passes every gate.

**4. Suggest the commit; Sebastian owns it:**

```
git add apps-script/.clasp-targets.json supabase/provision_stores.sql stores.json sw.js index.html <slug>/
git commit -m "Add <Concept> <Location> store (<slug>)"
git push origin main
```

GitHub Pages takes about a minute.

### Step 10 (Sebastian, a computer): set up the catalog in the app

1. Open `https://sebheh.github.io/mog-mobile/<slug>/` on a computer and sign in with the store PIN.
2. **Manage → Overview** shows the setup checklist:
   1. **Add your items:** Import from MarginEdge, using MarginEdge's Vendor Items export (`vendorItems.csv`).
      - Step 1 is vendors, step 2 items.
      - Imported items arrive with no par, pack or storage area.
   2. **Set each vendor's delivery days** (Vendors). A vendor without days never shows on Today.
   3. **Create storage areas** (Storage areas).
   4. **Give each item a storage area and a par** (Items).
   5. **Put each area in shelf order** (Shelf to Sheet). The first save marks it done.
3. Then:
   - **Manage → Health check**, every row passing;
   - **Settings → Recipients** (the GM row is editable on a computer);
   - **Settings → People**, if wanted.

### Step 11 (Sebastian, phone): smoke test

1. Open `https://sebheh.github.io/mog-mobile/` in a private tab, then concept → site → BOH/FOH → the store. A new site for an existing concept adds a site picker by itself.
2. Sign in with the store PIN. **Settings** shows `Server: Supabase · N ms`.
3. Today lists the vendors delivering today. Enter a count, leave the vendor and come back (or reload): the count is still there.
4. If a master PIN was set, check manager mode from the hub with it.

**Next morning (Claude):**
- Health check shows last night's close ran.
- If anything was ordered, the recap email reached the recipients.

## Troubleshooting

- **`/<slug>/` 404:** Pages hasn't rebuilt, or step 9's build wasn't committed.
- **PIN rejected:**
  - wrong PIN;
  - five misses lock the store for 5 minutes. The lockout is Supabase's, so the Sheet's Clear PIN Lockout doesn't touch it: wait, or on a signed-in computer use Manage → Health check, the "PIN lockout" row's fix;
  - the wizard didn't finish (Status shows PIN `(not set)`).
- **Settings → Server says `Apps Script`, not `Supabase`:** `phone_direct` is off. Run [supabase/phones_direct.sql](../../../supabase/phones_direct.sql), then sign in again.
- **No Manage in the sidebar on a computer:** step 8 didn't finish (`editor_direct` false), or the window is under 900px wide.
- **"Offline" on a store that worked:** its `/exec` rotted. Use skill `mog-exec-repoint`.
- **The hub tile shows a generic icon:** the hub has no `CONCEPT_VISUALS` entry for that exact concept string (`validate.py concept` warns).

## State to update afterward

- `docs/MOG_CurrentState.md`: add the store to the "Deploy targets" and "Live stores" tables.
- The session handoff runs only when Sebastian asks to wrap up (`mog-session-handoff`).

## Anti-patterns

- **Copying a live store's Sheet instead of the template.** It drags that store's catalog, recipients and order log along, and possibly its Supabase keys (step 2).
- **A slug with a hyphen or capital.** Supabase and the Move prompt refuse it, so the store could never connect (`build.py` and `validate.py slug` stop it first).
- **Adding the `.clasp-targets.json` entry without its `deploymentId` and `sheet`.** It breaks `deploy.py --redeploy` for every store and the `supabase_move` gate.
- **`python deploy.py` without `--target` during onboarding.** That pushes to all 11 targets.
- **Pasting a connect code anywhere but its own Sheet's prompt.**
- **Publishing (`stores.json`) before both moves.** Phones would count into the Sheet, and the store would show no Manage.
- **Editing the frozen Sheet's catalog after step 8.** Nothing there reaches the app.
- **Reusing a retired slug.** Old home-screen icons still point at it.

## When this skill should NOT run

- **A new deployment URL or label for an existing store:** a `stores.json` edit, `build.py`, push.
  - A rotted `/exec` is `mog-exec-repoint`, which also repoints `.clasp-targets.json`.
- **Changing a store PIN:** 📱 Mobile API → Setup / Re-run Setup (or Set Master PIN) in that store's Sheet. It pushes the PINs to Supabase.
- **Removing a store:** not covered.
  - Beyond `git rm -r <slug>/`, `stores.json`, `.clasp-targets.json`, `provision_stores.sql` and `build.py`, the store has Supabase rows (`mog.stores` and everything under it) and a 3:30 AM trigger in its Sheet.
  - Ask Sebastian before writing that procedure.

## Gaps (2026-10-19)

Fixed the same day: the wizard and both Sheet menus now accept all four concepts, Lei'd is `Lei’d Poke` everywhere, and `build.py` refuses a slug Supabase would and an unknown concept.

Still open:
- **Script Properties on a copied Sheet:** not yet observed (step 2's VERIFY). Clear Config doesn't clear the four Supabase keys.
- **`clasp deploy` instead of step 3's manual deploy** (the parked `onboard.py` design, 2026-07-29) is unproven. A clasp-made deployment may still need the OAuth grant from a Sheet menu run or `test_ping`.
