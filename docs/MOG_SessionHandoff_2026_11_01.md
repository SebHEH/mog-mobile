# Session Handoff — Vendor contacts, HQ control, warehouse spec

**Session date:** 2026-11-01
**Author:** Sebastian
**Session focus:** three new things on the Supabase side only:
- contact info on each store's vendors;
- an HQ control to add vendors or LTO items to many stores at once;
- a warehouse (Happy Supply) that works alongside the order guide.

**Outcome:** two features shipped and live, and the warehouse is specced.
- **Vendor contacts** (schema v10, the app-only Vendors page, a Contact sheet on the phone's vendor card), commit `1893926`.
- **HQ control** (schema v11, `hq/`), commit `39afc44`.
- **Checks:** both schema versions ran in the SQL Editor with every smoke row PASS (15/15, 27/27); the live probe passes 68/68; CI is green; 26 gates.
- **Contacts loaded:** Rosslyn BOH (10 vendors) and Founders BOH (8), from Rosslyn's vendor sheet and Tony's list, without passwords.
- **Spec:** the warehouse, a concept library and Sheet-less stores were specced and their build order agreed (`docs/MOG_Warehouse_Spec.md`).

**Next session focus:** the concept library (spec step 1), after Sebastian's first HQ sign-in and a test rollout.

---

## Section A — Vendor contacts (schema v10, commit `1893926`)

- **Data:** `mog.vendors.contact` (jsonb, `{}` = none) with eight keys: person, phone, email, how to order (`orderVia`), order email, website, account #, notes. `mog.vendor_contact_clean` trims and drops the rest; 200 characters, notes 500.
  - A vendor row carries `contact` only when it has one (`tables_json`, `editor_current`), and the phones' catalog gains `vendorContacts` only when a vendor has one. So every store read byte-identical until someone saved a contact, and no existing gate or smoke changed.
  - `editor_fields_match` compares contacts clean. Undo of an older vendor change is refused (CONFLICT) instead of wiping a contact saved since; smoke row 9.
  - `copy_store_catalog` (test stores only) doesn't copy contacts.
- **The app-only Vendors page** (`template/editor/Vendors.html`) replaces `ManageVendors.html` in the app (`build.py` `editor:Vendors`). `ManageVendors.html` stays for the Sheet dialog and `/exec`.
  - Built from the approved mockup (screens 5-6): delivery-day chips, what each order covers, order due by, an Advanced override for hand-set order sizes, Remove, and a Contact section.
  - One save covers all of it: `catalogEdit.js` `getVendorsPage` / `commitSaveVendor`.
- **Phone:** a Contact pill on a vendor card that has a contact opens a sheet.
  - Call and Text appear only for a real number, Email for an address, and the website only as http(s).
  - Today repaints when contacts change (`contactsSignature_`). App v0.27.0, store cache v68.
- **Gate `vendor_contacts`:** saves through the fake Supabase, CONFLICT, Undo, refusals, page counts equal to the phone card's on 200 stores, and the real phone card and sheet code via `slices()`. Eight planted-defect controls.
- **Loaded live** with a one-time SQL paste (kept out of the repo, which is public): Rosslyn BOH 10 vendors, Founders BOH 8, one logged change each. Logins are the username plus "Password: ask the GM".
  - Founders' Organic Butcher is Tony's "McLean Meat Co" (Sebastian confirmed).

## Section B — HQ control (schema v11, commit `39afc44`)

- **Page:** `https://sebheh.github.io/mog-mobile/hq/`, built by `build.py` `generate_hq` from `template/hq/index.html`, with `catalogEdit.js` beside it. `hq` is a reserved slug. English only.
- **Sign-in is per person:**
  - `select mog.hq_invite('<name>');` in the SQL Editor gives a one-use code for 24 hours; the person sets their own passphrase (12+ characters) on the page. A new invite also resets a forgotten passphrase; `mog.hq_remove_user` removes someone.
  - Five wrong tries lock only that person out for 15 minutes, never a store's PIN.
  - **Nobody is invited yet.**
- **Add LTO items:**
  - Items with their own main vendor and backups.
  - Each store's vendor is found by `matchVendor` and confirmed: a remembered name or exact match shows a green tag, a guess shows amber.
  - A vendor a store lacks is added with the days you set.
  - New items arrive with no par and no area (Needs setup). An item the store already has keeps its vendor, par and area, and gains only the vendors it didn't list (the "Add to a vendor" save).
- **Add a vendor:** a store that already has it is left alone, and a near match is flagged with "add anyway".
- **Saving:** every store or none (`mog_hq_apply`), one change per store signed "HQ · <name>", undoable in that store's Changes. The vendor names are remembered in `mog.hq_vendor_links`. Vendor names and Recent tabs.
- **Why the logic is in `catalogEdit.js`** (`commitHqRollout`) and not SQL: one copy of the editor's rules (Sebastian's pick). The SQL only signs in, reads and applies.
- **Shared code:** the delivery-day math moved into `catalogEdit.js` (HQ would have been its third copy). The MarginEdge import keeps a pack and notes when given (its rows have none, so imports are unchanged).
- **Gate `hq_rollout`:**
  - matching on real names;
  - one store's share;
  - 200 random stores untouched outside the rollout;
  - sign-in and lockout;
  - every store or none;
  - the store's own Undo.

  Five controls.
- **Who to invite:** maintainers only. An HQ sign-in can change every store's catalog; the page only adds, but the server takes any catalog change from it. Chef Dan's stock work belongs in the warehouse, with its own role (`docs/MOG_ProjectNotes.md`).

## Section C — Warehouse spec (`docs/MOG_Warehouse_Spec.md`, not built)

- **Three separate lists:**
  - warehouse products, only what HEH stocks;
  - each store's order guide, every vendor;
  - a concept library, a template with no stock.

  Only a store's Happy Supply items link to warehouse products.
- **Build order:**
  1. concept library;
  2. warehouse W1 and W2 for the stores already on MOG, and Dan;
  3. stores without a Google Sheet;
  4. Chasin' Tails and NUE join MOG, and warehouse W3 (chargebacks).
- **Decided:**
  - the library is per concept and side, seeded from a store Sebastian picks, then cleaned;
  - a Send to Happy Supply button on the review screen;
  - Dan signs in through the HQ invite with a warehouse role;
  - Dan's pricing model (average cost plus a handling fee hidden from stores, locked at ship);
  - Daniel's artifact data isn't moved (it isn't in use; the warehouse starts with a count).
- **Sheet-less stores** need homes for the close, the recap email, the LOG_ORDERS backup, setup, and two `/exec` uses. Central Apps Script or Supabase functions plus a mail service is decided in its own spec.

## Outstanding (carry forward)

1. **HQ first use (Sebastian):**
   1. Invite yourself (`select mog.hq_invite('Sebastian');`) and sign in at `/hq/`.
   2. Do a test rollout on the TEST store (rprfotest).
   3. Then add Happy Supply to every Roll Play store you use, with Chef Daniel's contact ((717) 992-9628, Daniel@hehfood.com, "Send the order guide to the Facebook chat") and its delivery days, which aren't known yet.
   4. Donny gets his own invite.
2. **Tell Donny:** schema v10 and v11 are taken; the audit work order's fix moves to the next free version (the work order now says so).
3. **Not seen on a screen yet** (the browser pane was hidden; all checks were by script):
   - the Vendors page layout;
   - the phone's Contact pill and sheet on a real phone (Rosslyn BOH and Founders BOH have contacts now);
   - the HQ page.
4. **Contact gaps:**
   - Rosslyn's Chef Center has no phone (Jayson at (571) 226-6010 is likely the same rep);
   - Rosslyn's B&T Distributions has no contact;
   - Founders still lacks Samuel and Sons, which needs its delivery days.
5. **Is Founders FOH (rpfrf) in use?** Unconfirmed; the notes list it as unused.
6. **The vendor sheet CSV** in Downloads holds plaintext passwords, several reused. Move them to a password manager, delete the CSV, and change the reused ones.
7. **Still open from before:**
   - Donny's onboarding (Sebastian's invites, Donny's one-store deploy measuring who `/exec` runs as);
   - the Items page live check;
   - the 2026-10-20 recap fixes held;
   - the audit work order's batches A-D;
   - the held-back logic items (`docs/MOG_CurrentState.md`).
8. **Before inviting anyone beyond the maintainers to HQ:** add a narrower role, or check `mog_hq_apply`'s ops server-side. Today an HQ token can change any catalog row at any store.

## Files touched this chat

- **Supabase:**
  - `supabase/schema_v10.sql` (new; its two long functions generated from v8 and v4 with asserted replacements);
  - `supabase/schema_v11.sql` (new);
  - `supabase/tests/smoke_v10.sql`, `smoke_v11.sql` (new);
  - `supabase/tests/check_api.sh` (v10, v11 blocks).
- **Editor:**
  - `template/editor/Vendors.html` (new);
  - `template/editor/catalogEdit.js` (contacts, `getVendorsPage`, `commitSaveVendor`, `commitHqRollout`, `matchVendor`, shared day math, the import's pack and notes).
- **HQ:** `template/hq/index.html` (new).
- **Phone:** `template/index.html` (Contact pill and sheet, v0.27.0), `template/sw.js` (cache v68).
- **Build:** `build.py` (`editor:Vendors`, `generate_hq`, `hq` reserved).
- **Tests:**
  - `tests/fake_supabase.js` (v10, v11);
  - `tests/vendor_contacts.test.js`, `tests/hq_rollout.test.js` (new);
  - `tests/me_import.test.js` (a control's anchor).
- **Docs:**
  - `docs/MOG_Warehouse_Spec.md` (new);
  - `docs/MOG_LogicBlueprint.md` and `.html` (R28, R22, the vendor contact field, growth seams, `current_as_of 39afc44`);
  - `docs/MOG_ProjectNotes.md` (Founders BOH in use, HQ how-to and who to invite, the public repo and passwords, planted anchors);
  - `docs/MOG_SupabaseMigration.md` (§7 rows);
  - `docs/MOG_CurrentState.md`;
  - `CLAUDE.md` (inventory, generated `hq/`, this handoff);
  - `MOG_ClaudeCodeTask_2026_10_30.md` (schema number).
- **Generated:** every store's `index.html`, `sw.js` and `editor/` (two builds), and `hq/`.
- **Outside the repo:** the one-time contacts SQL (scratchpad); the scratch preview servers.

## Process lessons

- The repo is public: a one-off data load holding people's phone numbers or emails stays out of it, and a password never goes into MOG (a vendor login keeps the username). [→ docs/MOG_ProjectNotes.md]
- Gates plant defects by exact text: changing a line in `catalogEdit.js` moved `me_import`'s par-control anchor. Grep `tests/` for a line before changing it. [→ docs/MOG_ProjectNotes.md]
- The handoff's lessons picker round was skipped silently (both lessons went to the project notes); Sebastian caught it. The step now always runs or says why not, records a Skill gate line, and the wrapper's `--check-lessons` refuses a handoff without one. [→ mog-session-handoff, .claude/skills/mog-session-handoff/scripts/handoff_facts.py, proposal session-handoff-2026-11-01]
- After a handoff, the next piece starts in a new session from the opening prompt; starting the library's walkthrough in the same chat was rejected. [→ proposal session-handoff-2026-11-01]
- A spec with several overlapping lists needs them drawn apart (with their one link) before build-order questions; the warehouse spec's order question was answered with confusion until a diagram showed the three lists. [→ proposal spec-first-2026-11-01]
- Schema v10 techniques: a new payload field appears only when filled; a nested jsonb field compared clean in all three compare sites, keys in jsonb order; a redefined long function generated from its earlier version. [→ mog-supabase-schema]
- The fake-Supabase preview server was rebuilt twice this session from the project notes' recipe; it should be a committed tool. [→ docs/MOG_CurrentState.md]
- The push of the docs commit was blocked by Claude Code's auto-mode check while two earlier pushes passed; Sebastian pushed by hand. [→ one-off]

**Skill gate:** one picker round, four questions, all Apply: the three schema rules into `mog-supabase-schema`; proposal `session-handoff-2026-11-01` (offer the next piece as a new session, plus the Skill gate line and check); proposal `spec-first-2026-11-01` (draw overlapping lists apart first); the preview tool as a next-session candidate. Made directly on Sebastian's request: `mog-session-handoff`'s lessons step and its wrapper check.

## Commits landed this session

```
39afc44 HQ control (schema v11): add a vendor or a concept's LTO items to many stores at once
1893926 Vendor contacts (schema v10) and the Vendors page in the app (v0.27.0, cache v68)
```

## Opening prompt for next session

```
Read docs/MOG_CurrentState.md, docs/MOG_SessionHandoff_2026_11_01.md and docs/MOG_Warehouse_Spec.md
first, and run git pull. Vendor contacts (schema v10) and HQ control (schema v11, /hq/) are live;
app v0.27.0 / cache v68; 26 gates. Next is the concept library (spec step 1): one list per concept
and side, seeded from a store Sebastian picks and cleaned in HQ, which a new store's order guide
starts from. Begin with an architectural walkthrough, ask which store seeds each library, and take
the next free schema number (check supabase/ and tell Donny). Ask first whether Sebastian has
signed in to HQ and run a test rollout on the TEST store.
```
