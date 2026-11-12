# MOG - File inventory (moved out of CLAUDE.md 2026-11-12; not auto-loaded)

Not auto-loaded. Moved here unchanged on 2026-11-12 to keep session start small; nothing was deleted.


## Moved from `CLAUDE.md` on 2026-11-12

## File inventory

```
mog-mobile/
├── CLAUDE.md                    This file. Load-on-start anchor.
├── ONBOARDING.md                A second maintainer's setup (Donny) and his session-start / wrap-up prompts.
├── README.md                    Human-facing docs (architecture, add-a-store walkthrough).
├── .github/workflows/gates.yml  CI: node tests/run_all.js, then the SQL in PGlite, on every push and pull request.
├── package.json                 Only for the SQL check: @electric-sql/pglite (pinned), for supabase/tests/run_pglite.mjs.
├── index.html                   Hub picker landing page.
├── sw.js                        Hub service worker.
├── manifest.json                PWA manifest for the hub.
├── stores.json                  Store registry: slug, concept, location, deployment URL.
├── build.py                     Python templating: stores.json + template/ → <slug>/ dirs + STORE_REGISTRY injection.
├── deploy.py                    Push (and optionally --redeploy) apps-script/ to all 11 clasp targets. Also handles --discover for deploymentId bootstrap.
├── editor_link.py               Prints the exact "run X in the Apps Script editor" request: .gs file, store, editor + Sheet links (convention #8).
├── icons/                       Branding (heh-180.png, rp-180.png, etc.).
├── template/                    PER-STORE PWA SOURCE.
│   ├── index.html               (311 KB — the store app UI).
│   ├── sw.js                    (6.9 KB — store SW).
│   ├── hq/index.html            HQ control (schema v11): add a vendor or a concept's LTO items to many stores at once. build.py
│   │                            publishes it at hq/ with catalogEdit.js beside it; sign-in is a person's own HQ passphrase.
│   │                            Libraries (schema v12): each concept's standard items per side, started from a store,
│   │                            edited item by item, and sent to stores like an LTO ("Set up stores from it"). The page is
│   │                            the order guide's computer look with the HEH brand (sidebar: New LTO, LTOs, Libraries, Vendors,
│   │                            Vendor names); heh-logo.svg and the concept marks beside it come from the HEH brand kit.
│   │                            hq/ltos.js (schema v14): each concept's LTOs, where each stands at each store, and Send to
│   │                            more stores, Make it standard, End and Roll back (rules in catalogEdit.js commitHqLto).
│   │                            hq/warehouse.js (schema v13, pages rebuilt in v20): HEH STOCK: Stock (every item at each place, On the way), Items, Places, Who took what; Incoming (vendor
│   │                            orders in, transfers), Products and prices and Stock history, for the warehouse role. Each
│   │                            person sees the sections their roles (hq, warehouse) open. Orders (schema v16): the store
│   │                            orders sent from the phone, Ship from a location; a product's Send to stores links an item
│   │                            a store has, or adds one (catalogEdit.js commitHqProduct; the hq role too). Elpis (schema v17):
│   │                            HEH's stock held at Elpis, the deliveries the close records, Mark received for a store.
│   └── editor/                  The editor on Supabase (one-app Phases 2 and 4): catalogEdit.js (Manage Items, Manage Vendors,
│                                Storage Areas and Shelf to Sheet over the catalog tables, gated against Items.gs / Vendors.gs /
│                                PickPath.gs) + host.js (runs the pages and Editor Home as static pages) + meImport.js
│                                (Import from MarginEdge: vendors, then items, then one logged save). host.js also answers Order
│                                History, the Par Review flags (OrderMath.gs, copied in as orderMath.js) and the Health check
│                                (catalogEdit.js getStoreHealthReport, shown as the Overview's rows through healthRows) from
│                                Supabase. Items.html, Vendors.html, Areas.html, ShelfToSheet.html, Overview.html and Changes.html
│                                are pages only the app has (Manage Items since the 2026-10-20 redesign, with its bulk bar; Vendors
│                                since 2026-11-01, with each vendor's contact; Storage areas and Shelf to Sheet since 2026-11-11,
│                                Shelf to Sheet with drag; the Manage home, with the Health check in its Needs attention since
│                                2026-11-11; the change log). The Apps Script ManageItems, ManageVendors, StorageAreas,
│                                ReorderPickPath and HealthCheck pages stay for the Sheet dialog and /exec only. On a computer every page runs
│                                inside the app, in a frame beside its sidebar (?embed=1, spec U2). build.py publishes it at
│                                <slug>/editor/ for a store marked "editor": "supabase" (every store), and --preview for a test store.
├── apps-script/                 APPS SCRIPT SOURCE.
│   ├── README.md                Apps Script workflow docs (setup + day-to-day).
│   ├── MOGApi.gs                Core API surface for PWA ↔ Sheet (doGet/doPost, api_* fns, page routing).
│   ├── Core.gs                  Global constants, generic helpers, menu/onOpen/onEdit/triggers, order-cycle date helpers.
│   ├── Vendors.gs               Vendor add/import/remove/recalibrate, cadence, templates, H2 formula.
│   ├── Items.gs                 Manage Items CRUD + active-vendor switch.
│   ├── PickPath.gs              Storage areas + reorder pick path (+ purge core).
│   ├── ResetLog.gs              Reset / order-log snapshot / daily recap.
│   ├── History.gs               Order history modal + par-review flags.
│   ├── Dashboard.gs             HOME dashboard builder (its theme from Concepts.gs).
│   ├── Concepts.gs              CONCEPT_THEMES and conceptTheme_ (moved out of Dashboard.gs 2026-11-11). Pure: Supabase's nightly close runs it too.
│   ├── Editor.gs                KM web editor: doGet page routing, PIN gate/token, webedit_call dispatch, per-tool web renderers.
│   ├── Health.gs                Store Health Check — read-only diagnostic (getStoreHealthReport) + web fixes (runHealthFix).
│   ├── Recap.gs                 Daily recap email (send + the once-per-cycle flag, shared with Supabase since v23) + recipients list in SETUP AB-AE.
│   ├── RecapEmail.gs            The recap email's subject, text and HTML (moved out of Recap.gs 2026-11-11). Pure: Supabase's nightly close runs it too.
│   ├── Admin.gs                 Run-once admin/config fns (setupMobileApi_ via the Sheet menu, PINs, concept) + editor-run test fns (split from MOGApi.gs 2026-07-24).
│   ├── OrderMath.gs             The order math + the PWA's two payload builders. Pure functions, run VERBATIM by the PWA too (gated by tests/).
│   ├── Sync.gs                  Supabase sync: catalog/PIN push, the Move this store to Supabase menu item, nightly 3:30 AM run (retires itself once the store's
│                                close_direct is on, v23), cycle close in Supabase, parity + timing tests.
│   ├── DbApi.gs                 /exec's count path for a store that counts in Supabase (same answers as the Sheet handlers, no Sheet I/O).
│   ├── AdminReset.html          Admin reset modal.
│   ├── ManageItems.html         Item editor modal (Sheet dialog + /exec web; the app uses template/editor/Items.html).
│   ├── ManageVendors.html       Vendor editor modal (dual-host).
│   ├── OrderHistory.html        Past orders modal (dual-host, read-only).
│   ├── ReorderPickPath.html     Shelf-to-Sheet / reorder pick-path modal (Sheet dialog + /exec; the app uses template/editor/ShelfToSheet.html).
│   ├── StorageAreas.html        Storage area config modal (Sheet dialog + /exec; the app uses template/editor/Areas.html).
│   ├── HealthCheck.html         Store Health Check modal (Sheet dialog + ?page=healthcheck; in the app it's the Overview's rows).
│   ├── Setup.html               First-run store-setup wizard (?page=setup).
│   ├── EditorShell.html         Shared web-editor chrome (band, breadcrumb, PIN gate, tour engine, mge* helpers).
│   ├── EditorHome.html          Web-editor home dashboard (tool tiles).
│   ├── Styles.html              Shared modal design tokens + universal chrome (via include()).
│   ├── appsscript.json          Manifest (timezone, OAuth scopes, webapp config).
│   └── .clasp-targets.json      Slug → {scriptId, deploymentId} map for deploy.py.
├── mail-relay/                  THE MAIL RELAY (one standalone Apps Script, bound to no Sheet, owned by Sebastian): sends Supabase's
│                                nightly recap with MailApp (Relay.gs doPost, checked by the secret MOG_RELAY_SECRET; setupRelay makes it).
│                                appsscript.json (send email only), relay-target.json (scriptId, deploymentId), .claspignore.
│                                Deployed with python deploy.py --relay, never with the stores. Gate: tests/mail_relay.test.js.
├── supabase/                    SUPABASE LAYER (every store runs on it — see docs/MOG_SupabaseMigration.md).
│   ├── schema.sql               Private `mog` schema + the public mog_* functions (the only way in).
│   ├── schema_v2.sql            Order log + one-transaction cycle close + sync-key snapshot/override calls (run after schema.sql).
│   ├── schema_v3.sql            The per-store phone_direct switch (step 5) on the five PWA functions (run after v2).
│   ├── schema_v4.sql            Step 6 part 1: catalog tables (vendors/areas/items/pick_rows), the SQL catalog builder, the seed, editor_direct (run after v3).
│   ├── schema_v5.sql            Live counting (one-app Phase 1): presence, the store's name list, who saved each count, mog_snapshot2 / mog_save_counts2 (run after v4).
│   ├── schema_v6.sql            The editor writes the catalog (one-app Phase 2): change log, mog_editor_login/_get/_apply/_undo, D23 (run after v5).
│   ├── schema_v7.sql            Phone quick edits (one-app Phase 3): "just today" par/add in mog.quick_edits + the snapshot, mog_set_par, review list (run after v6).
│   ├── schema_v8.sql            One-app Phase 4: the area rename step for the editor's saves and Undo, mog_sync_switch_editor (run after v7).
│   ├── schema_v9.sql            Phase 4's rest: the order log read (mog_history) + the switch's LOG_ORDERS copy, recipients, People (rename/remove), the Health status (run after v8).
│   ├── schema_v10.sql           Vendor contacts: mog.vendors.contact, saved through mog_editor_apply, phones get vendorContacts in the catalog (run after v9).
│   ├── schema_v11.sql           HQ control: HQ people (invite, own passphrase and lockout), remembered vendor names, mog_hq_data / mog_hq_apply (all stores or none) (run after v10).
│   ├── schema_v12.sql           Concept library: mog.stores.side (from the location), mog.libraries / library_items / library_log, mog_hq_apply with libraries (run after v11).
│   ├── schema_v13.sql           Happy Supply W1: HQ roles (hq, warehouse), the warehouse tables (stock never below 0, every move kept), mog_wh_* (run after v12).
│   ├── schema_v14.sql           LTOs: mog.ltos / lto_stores, an item's lto (part of its row), mog_hq_apply's fifth argument (send, more, end, rollback, standard) (run after v13).
│   ├── schema_v15.sql           A vendor renamed at a store: the editor's rename step takes vendors (items, lists, counts, today's edits, HQ's names follow) (run after v14).
│   ├── schema_v16.sql           Happy Supply W2a, store orders: mog.items.wh_product (an item's product link, in its row), mog.wh_orders / wh_order_lines (HS-0001), mog_wh_send / mog_wh_received (phone), mog_wh_ship / mog_wh_order_cancel (warehouse), happySupply in the 10-second read (run after v15).
│   ├── schema_v17.sql           Happy Supply W2b, HEH's stock held at Elpis: a location held by a vendor (held_by), a product's via, the 3:30 AM close recording each store's Elpis delivery (EL-0001, guarded), Mark received at the store or by HQ (mog_wh_held_receive) dropping the stock, a receipt beyond the records logged as a count (run after v16).
│   ├── schema_v18.sql           HQ remembers a device: mog_hq_remember (30 days from each open, the sign-in's "Remember this device" box) and mog_hq_signout (Sign out ends the sign-in on the server) (run after v17).
│   ├── schema_v19.sql           Elpis on one page: mog.wh_products.concept (the concept whose stores carry a held product), saved by mog_wh_save, read in mog_wh_data (run after v18).
│   ├── schema_v20.sql           HEH's stock at three places (W2c): a place's kind (held_store, count_how), mog.wh_product_places (an item's places and low points), a Happy Supply line into a place (to_location), the close and the phone by place, mog_wh_taken (run after v19).
│   ├── schema_v21.sql           Routes: mog.items.wh_place and wh_vendor (a store item's place and the vendor it's ordered under, on its row), every stock reader by route (the close, the phone, Send), routes in mog_wh_data; via, par and stores unread until v23 (run after v20).
│   ├── schema_v22.sql           An inactive HQ item or a closed place stops its routes: the close's step, the phone's read and Send skip them (no table change) (run after v21).
│   ├── schema_v23.sql           Sheet retirement step 2: mog.stores.close_direct, the once-per-cycle recap flag in mog.store_state, mog.night_log, mog.close_cycle
│                                (v17's close without the key), the nightly function's mog.night_* SQL, mog_sync_night / mog_sync_set_recap_sent (run after v22).
│   ├── schema_v24.sql           The backup watchdog (mog.backup_heartbeats, mog.backup_watch, mog.backup_*; night_due names its alert) and the drop of
│                                mog.wh_products.via, par and stores, copied first to mog.wh_products_retired (run after v23).
│   ├── night_schedule.sql       Run once after v23 (again after v24): pg_cron + pg_net, the Vault secret, mog.night_tick every 15 minutes,
│                                mog.night_test (a test email), mog.backup_watch_test (the watchdog's test email).
│   ├── functions/close/         The Edge Function `close` (index.ts: the secret, the database, the mail relay's address; core.mjs: the close, the recap, the shadow, relayMailer;
│                                shared.mjs: OrderMath.gs + Concepts.gs + RecapEmail.gs, GENERATED by build.py). Deployed on the maintainer's go.
│   ├── provision_stores.sql     One query for every store's connect code (pasted into each Sheet's Move this store to Supabase prompt).
│   ├── phones_direct.sql        Turns phone_direct on for every moved store (Move does it itself since 2026-10-17; this is the fallback).
│   ├── backup_role.sql          The nightly backup's read-only login, mog_backup (pasted by a maintainer in the SQL Editor: it shows the
│                                new password once, for the private repo SebHEH/mog-backup's secret). Re-running rotates the password.
│   └── tests/                   smoke.sql … smoke_v24.sql (logic, run in the SQL Editor) + check_api.sh (public-key lockout)
│                                + test_store_elpis.sql (SQL Editor: two nights' held-place deliveries on the TEST store, which never closes, by route since v21)
│                                + run_pglite.mjs (every schema and smoke file in PGlite; CI runs it)
│                                + backup_role_pglite.mjs (backup_role.sql as a non-superuser like Supabase's postgres; CI runs it)
│                                + night_schedule_pglite.mjs (night_schedule.sql with stand-ins for Vault, pg_net, pg_cron; CI runs it)
│                                + night_shadow_check.sql (reads only: the night's shadows against Apps Script's log, and the night log).
├── tests/                       Node gates that run the real .gs code: `node tests/run_all.js`. Never put .js under apps-script/ (clasp pushes it to every store).
│                                preview_server.js (not a gate): the built app, editor and HQ against the fake Supabase (preview_start "mog-preview").
├── docs/
│   ├── MOG_CurrentState.md      Running snapshot — what's in flight, invariants, recent changes.
│   ├── MOG_ProjectNotes.md      Project facts and gotchas (moved from Claude's per-computer memory, 2026-10-29).
│   ├── MOG_SupabaseMigration.md Design record for the count-path move to Supabase (decisions, ownership, rollout).
│   ├── MOG_OneApp_Spec.md       Agreed spec: the ordering app and the editor become one app per store (decisions A1-A7, P1-P4, phases).
│   ├── MOG_Warehouse_Spec.md    Agreed spec (2026-11-01): the warehouse (Happy Supply), the concept library, stores without a Sheet, and their build order.
│   ├── MOG_LTO_Spec.md          Agreed spec (2026-11-02): LTOs as records in HQ (End, Roll back, Make it standard; schema v14, HQ side built) and new LTO items at the top of a store's Items page (built 2026-11-02).
│   └── MOG_SessionHandoff_*.md  Per-session handoffs (newest @-imported above).
├── .claude/
│   └── skills/                  Repo-specific skills.
├── _preview/                    GENERATED, git-ignored: build.py --preview output (app + editor) for Supabase test stores (rprfotest).
└── rpr/ rprfo/ rpt/ rptfo/      GENERATED — do not edit.
    rpfr/ rpfrf/ tnyt/ tnytf/    (per-store dirs from build.py)
    tnyr/ tnyrf/
```
