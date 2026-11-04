# MOG (Master Ordering Guide): Logic Blueprint

`current_as_of: 8fda25e (2026-11-04) · covers: Layers 1 to 3, owner-verified via the blueprint questionnaire`
· maintained in `docs/MOG_LogicBlueprint.md`
<!-- Regenerate the presentable HTML any time with:
     python C:/Users/sebcn/.claude/skills/project-logic-blueprint/scripts/render_blueprint_html.py docs/MOG_LogicBlueprint.md -->

> **Status:** Built from the code, the project docs (`CLAUDE.md`, `docs/MOG_CurrentState.md`, the
> session handoffs), and the owner questionnaire (`docs/MOG_Blueprint_Questionnaire.md`, answered
> 2026-07-17). Every behavioral claim was confirmed in the source or the docs; every "why" was
> confirmed by the owner. A branded HTML rendering, when produced, will not auto-regenerate from
> this markdown.

---

## Layer 1: What this is

### The problem

Every quick-service store has to reorder inventory constantly, and getting the quantity right is
harder than it looks. Order too little and the line runs out mid-rush and has to 86 an item. Order
too much and product spoils, space runs out, or cash is tied up on a shelf. The person who actually
knows what is on hand is a kitchen manager standing in the walk-in with a phone, not someone at a
desk. The math is also non-obvious: a vendor who only delivers twice a week means today's order has
to cover several days, so the "right" number changes by day of week and by vendor. Doing that in
your head, or on a paper sheet, across dozens of items and several vendors, is slow and error-prone,
and it makes a store dependent on the one person who knows how to do it. Spreadsheets alone solve
the math but are miserable to operate one-handed on a phone in a cold room.

### What the system does about it

MOG turns "walk the shelves and figure out what to reorder" into a simple guided phone task:
counting. The user counts what is physically on hand for each item, and the system, which already
knows the target stock level, which vendor delivers when, and how many days this order needs to
cover, tells them the exact quantity to order for each item. It produces a clean suggested order and
emails it to the store's recipients. **MOG does not place orders.** The suggested order is a
handoff: whoever places orders (on vendor websites, by phone) works from that email. The value is
that anyone can do the count, so any competent person can keep a store stocked without inventing
their own process, and a KM can take a vacation without the store suffering.

### What "working" looks like

Someone opens the app on their phone, counts on-hand for a vendor's items, sees a suggested order
quantity appear next to each one, adjusts anything unusual, and submits the count. It takes a few
minutes per vendor. The store's manager and KM get the recap email, use it to place the actual
orders, and the day's counts reset cleanly for tomorrow. Nobody had to open the spreadsheet or do
the coverage math by hand.

### Where it's headed

MOG is one of several operational tools (its internal name is "Order Guides") that Happy Endings
Hospitality may fold into a company-wide operations app or portal alongside a visual schedule, a
prep schedule, and store-reporting tools. The end state is not firmly decided. That uncertainty is
exactly why this document describes MOG's *behavior and rules* independently of its current
implementation (a phone web app plus one Google Sheet per store). The order math, the coverage
model, the multi-vendor sourcing, and the per-store isolation are the durable assets. The Google
Sheet, the Apps Script runtime, and the nine separate deployments are current-platform facts a
rebuild can replace. The stated goal for a rebuild is to capture the logic; the stack is open.

---

## Layer 2: How it works

### Glossary

| Term | Means |
|---|---|
| **Store** | One physical location for one concept (for example Roll Play Rosslyn BOH). Fully isolated: its own data, its own app instance, its own recipients. |
| **Concept** | A restaurant brand under the parent company (Roll Play, Teas'n You, ĂN, Lei'd Poke). Drives theming and a small amount of concept-specific configuration, not different order math. |
| **BOH / FOH** | Back of house (kitchen) vs. front of house. A store is usually split into a BOH guide (mostly food items) and an FOH guide (mostly paper goods). |
| **User** | Anyone doing the count: kitchen managers, general managers, assistant (general) managers, back-of-house shift leads. Counting is the simple task anyone can do so the store is not dependent on one person. |
| **Item** | One thing that can be ordered (an ingredient, a supply). Has a base par, a pack/unit, and belongs to one or more vendors. |
| **Vendor** | A supplier the store buys from. Has a delivery cadence (which days it delivers) that drives the coverage math. |
| **Par (base par)** | The target on-hand quantity for an item for roughly a day. One number per item, shared across every vendor that can supply it. Carries a built-in safety buffer (see R6, R21). |
| **On hand** | The quantity the user physically counts during the session. The only number the user enters. |
| **Day multiplier** | How many days of par this order must cover, for a given vendor on a given weekday, derived from that vendor's delivery cadence. A vendor delivering every third day carries a larger multiplier. |
| **Suggested order quantity** | What the system tells the user to order for an item: enough to bring on-hand up to par times coverage, rounded up to a whole unit, never negative. |
| **Use-multiplier flag** | Per-item switch. When off, the item ignores the day multiplier and orders flat to par (for slow-moving bulk items and fixed-size batch recipes). |
| **Emergency override** | A store-level switch for ordering off the normal delivery schedule; changes coverage from "today's cadence" to "bridge to the next scheduled delivery." |
| **Primary vs. secondary vendor** | An item's default order source is its primary vendor; the same item can also sit on other (secondary/backup) vendor tabs and be ordered from them. All are fully orderable; par is shared. |
| **Pick path / storage area** | The user-defined ordering of items within a vendor, grouped by where they physically sit, so counting follows a walking route. |
| **Count session (the daily order)** | The set of counts plus suggested quantities a user submits for a vendor on a given day. |
| **Recap email** | The auto-generated "today's suggested order" email sent to the store's recipients once per order cycle. The handoff used to place the actual orders. |
| **Reset / new day** | Clearing the day's on-hand counts and snapshotting the completed session to history so the next day starts fresh. |
| **Store PIN vs. master PIN** | The store PIN (the store's street number) gates the phone app and the desktop editor; a separate master PIN gates destructive/admin actions. |
| **Web editor** | A desktop, PIN-gated web app (same URL, different door) where a user manages items, vendors, storage areas, pick path, and views order history. |
| **Hub** | The landing page that routes a user to their concept, site, and store before the store app opens. Prevents one store accidentally using another store's guide. |

### The core flows

#### Flow: Do the daily count (the main event)

- **Triggered by:** A user opening the store app and choosing a vendor to count.
- **What happens:**
  1. The app confirms it is still the same order day. If a new day has started it resets first (see the reset flow) so counts begin clean.
  2. The user picks a vendor. The app shows that vendor's items in the user's chosen walking order (by storage area / pick path).
  3. For each item the user enters the on-hand count (whole or decimal). Each count saves itself a few seconds after the user stops typing, so others counting at the same time see it (R25).
  4. As counts are entered, the system computes a suggested order quantity per item: it takes the item's par, scales it by how many days this vendor's order must cover today, subtracts what is on hand, and rounds up to a whole unit. Items where the vendor does not deliver today, or where on-hand already meets coverage, show nothing to order.
  5. The user reviews the vendor's full suggested order, adjusts any quantity, and submits the count.
  6. The session is recorded and the recap email goes to the store's recipients (once per cycle, no duplicates).
- **Ends with:** A submitted count for that vendor, a recap email on its way, and the user free to count the next vendor. The actual purchase happens later, outside MOG, from the recap.

#### Flow: New-day reset

- **Triggered by:** A nightly run at about 3:30 AM in the store's time zone. If that run failed, the first app open of the new day closes it instead (auto). An admin can also close the day early from the Sheet's dashboard control.
- **What happens:**
  1. The system detects the stored "current order day" is behind today.
  2. In one step that cannot half-happen, it logs the completed day's lines (each item with a positive suggested quantity) and starts the new day with Emergency Override off and no day picks. A day can only be closed once, so nothing is ever logged twice.
  3. The recap email is built from those logged lines and sent if it has not already gone out for that cycle.
  4. The new day starts with no counts. The old day's counts are kept with that day (as evidence, for 45 days) rather than wiped.
  5. A backup copy of the logged lines is appended to the order-history sheet.
- **Ends with:** A fresh order day before anyone opens the app; the user sees a clean count screen. The close is what guarantees the recap gets sent and the day gets logged.

#### Flow: Multi-vendor sourcing

- **Triggered by:** A user counting a vendor whose items are also available from other vendors, or a GM assigning an item to more than one vendor.
- **What happens:**
  1. An item can appear on several vendor tabs at once, sharing one par.
  2. One vendor is the item's primary (default source); the others are secondary/backup and are labeled as such but are fully orderable.
  3. Because each vendor tab tracks its own on-hand for the item, the user orders from whichever vendor makes sense that day (the one delivering, the one in stock, or the cheaper one this week). The per-tab on-hand is what routes the order.
- **Ends with:** The user can order the same item from any of its vendors without duplicating the item or recomputing par, and can recover from a stock-out by switching to a backup.

#### Flow: Manage the catalog (web editor)

- **Triggered by:** A user opening the desktop web editor and entering the store PIN.
- **What happens:**
  1. From a home dashboard they open a tool: Manage Items, Manage Vendors, Storage Areas, Shelf-to-Sheet (pick path), or Order History (read-only).
  2. They add/edit items (par, pack, use-multiplier, which vendors can supply it), add or import vendors with delivery days, arrange storage areas and the counting route, and review past orders.
  3. Changes write back to the store's data and show up on the phone app.
- **Ends with:** The store's catalog and layout updated without anyone editing the raw spreadsheet.

#### Flow: First-run store setup and health check

- **Triggered by:** A brand-new store's app URL being opened before it is configured, or a manager running the Store Health Check.
- **What happens:**
  1. Setup (unconfigured store only) collects identity (concept, front/back of house, city) and derives the store name and code, then marks the store configured.
  2. The Health Check is a read-only diagnostic that inspects the store's structure (config, vendor tabs, formulas, catalog consistency) and reports pass/warn/fail, with one-click fixes for a set of known repairs.
- **Ends with:** A store ready to take counts, or a manager with a clear list of what to fix.

### How the parts connect

```mermaid
flowchart LR
  USER([Store staff: KM, GM, AM/AGM, BOH Shift Lead]) -->|counts on-hand, submits| PWA[Phone app / intake<br/>currently a PWA]
  ADMIN([GM / KM on a computer]) -->|manage catalog| ED[Editor, inside the app on a computer<br/>currently static pages]
  HUB[Hub picker<br/>concept to site to store] --> PWA

  PWA <-->|one snapshot down, count saves up<br/>order math runs on the phone| DB[(Counts, current day, overrides, order log,<br/>catalog, recipients, change log<br/>currently Supabase / Postgres)]
  PWA -.->|reset fallback, recap resend| API[Rules engine + scheduler<br/>currently Apps Script /exec]
  ED <-->|catalog saves with Undo, order history, health| DB

  API -->|nightly close| DB
  DB -->|recipients, the day's order lines| API
  API -->|recap email once per cycle| MAIL[Notifier<br/>currently Gmail/MailApp]
  MAIL --> RCPT([Manager + KM])
  RCPT -.->|place the actual order, outside MOG| VENDOR([Vendor websites / phone])

  API -.->|nightly backup of the order log| LOG[(Order history backup<br/>currently a sheet tab)]
```

### The rules

*Enumerated so the rebuild spec can cite them. This is the highest-value section: these are what a
naive rebuild silently loses.*

- **R0. MOG produces a suggested order; it does not place orders.** The output is the count session
  plus the recap email; the actual purchase happens externally (vendor websites/phone) from that
  recap. *(Owner-confirmed.)*
- **R1. Suggested order quantity = round-up( par × coverage − on-hand ), never below zero.** If the
  result is zero or negative, the item shows nothing to order. *(Confirmed: `computeSuggestedQty_`,
  `MOGApi.gs`.)*
- **R2. Coverage = the vendor's day multiplier for today**, unless the item's use-multiplier flag is
  off, in which case coverage is a flat 1 (order straight to par). *(Confirmed:
  `computeSuggestedQty_`, `readMasterItemMeta_`.)*
- **R3. If a vendor's multiplier for today is 0, that vendor does not deliver today**: its items show
  nothing to order and are effectively out of the day's ordering. *(Confirmed: `vendorDayMultiplier_`
  returning 0, `computeSuggestedQty_` returning null.)*
- **R4. Always round the order up to a whole unit — but only on a REAL shortfall.** Two reasons to
  round up: you never intend to order short (running out mid-service is worse than a little extra),
  and vendors sell whole units (you cannot buy 0.25 of an item). The refinement: a shortfall of
  exactly zero, or exactly N, must not become one more unit. On a rebuild this matters because
  binary floating point turns an exact result into a phantom remainder — `par 1.1 × 2 − 1.2` is
  exactly 1 in decimal but computes as `1.0000000000000002`, and a bare round-up ordered 2. Guard
  with a small epsilon before rounding up, never by rounding to a fixed number of decimals: that
  also shaves a *genuine* fraction, and this system must never round an order down. Spreadsheet
  engines hide this (Sheets applies ~15-significant-digit final-result cleanup, so its `ROUNDUP`
  never saw the artifact) — a reimplementation on any other stack will not, unless it guards.
  Affects roughly 0.8% of decimal par/on-hand combinations, always over by exactly one unit.
  *(Confirmed: `computeSuggestedQty_` epsilon guard, verified against exact integer-scaled decimal
  arithmetic 2026-08-03; owner-confirmed the never-round-down intent.)*
- **R5. On-hand may be a decimal; par and the order are quantities in the item's pack/unit.**
  A count can't be negative: a typed negative is stored as 0, since it would otherwise order extra.
  *(Confirmed: PWA decimal input, `Number()` on save; the count box's minimum of 0 and
  `countRowsFromSave_`'s clamp, 2026-10-20.)*
- **R6. Par is one number per item, shared across every vendor that can supply it**, not a per-vendor
  par. The day multiplier, not a second par, handles vendor-specific coverage. This lets a user
  compare vendor prices and switch sources without duplicating the item or recomputing a new par, and
  lets a backup vendor cover a stock-out. *(Confirmed: par from `MASTER_ITEMS` col G; owner-confirmed
  why.)*
- **R7. An item can belong to multiple vendors; one is primary (default source), the rest are
  fully-orderable backups.** Placing an item on a vendor tab is what makes that vendor eligible.
  *(Confirmed: primary = col C, eligible list = col O; `syncItemEligiblePickRows_`.)*
- **R8. Per-vendor on-hand routes multi-vendor ordering.** The same item counted on two vendor tabs
  is two independent on-hand counts, so the user orders from whichever vendor is right that day. The
  system does not pick the vendor; the user does. *(Confirmed: vendor-tab structure; owner-confirmed
  intent.)*
- **R9. Reassigning an item's primary vendor promotes in place**: the old primary stays on as a
  backup rather than being removed, because it is still a valid source you will likely want again.
  *(Confirmed: `commitSwitchActiveVendor`; owner-confirmed why.)*
- **R10. Emergency override changes coverage from "today's cadence" to "bridge to the next
  delivery" — and a user's per-vendor answer beats the guess.** With no user input, scan forward
  from today for the first day the vendor delivers and use that day's multiplier; a vendor that
  delivers today is unaffected; a vendor that never delivers falls back to 1× so the user can still
  order. But that auto-bridge derives coverage from the NORMAL schedule, which is exactly what is
  abnormal in an emergency (a Fri+Sat vendor ordered Thursday is auto-sized to last one day; if
  Saturday's drop is cancelled it must last seven). So while override is on, the user can answer
  "when is this vendor's next delivery after this one?" per vendor, and the multiplier becomes the
  number of days from tomorrow (the arrival day, per the 1-day-lead convention R21) up to — not
  including — that day (1–7). The answer is stored as the FROZEN day count, not the chosen day
  label, because the multiplier is relative to the day the order was placed; re-deriving it later
  from a label would drift. *(Confirmed: `vendorDayMultiplier_` override branch + `SETUP!AF` picks;
  owner-designed 2026-08-03, shipped 2026-08-07.)*
- **R11. Emergency override is store-wide, any user can turn it on (with a confirm), and it clears on
  the next reset.** It is for vendor-cadence disruptions such as a holiday landing on a delivery day;
  vendors tend to share delivery days, so applying it store-wide keeps it simple, and it is an
  operational call rather than an admin action. **Per-vendor day picks (R10) are children of the
  store-wide flag**: they can only be made while it is on, they are ignored whenever it is off, and
  they clear wherever the flag clears (reset, turn-off, stale-day sweep) so a pick can never leak
  into a later cycle. *(Confirmed: `api_setEmergencyOverride_`/`api_setVendorOverride_`, reset and
  off-toggle clear both; owner-confirmed why.)*
- **R12. The recap email is sent exactly once per order cycle**, as a guaranteed side effect of the
  session/reset, regardless of which path triggered it. It goes to the manager and the KM: one counts,
  the other (or the same person later) places the orders from the email, and it doubles as an
  accountability record of what the par said to order. *(Confirmed: the last-sent date, checked against the store's own day (Supabase's once a store
  moved, fixed 2026-10-20) under a lock, so two phones finishing at once can't both send; a failed
  send is retried up to 3 times by `sendPendingRecap_`; owner-confirmed purpose.)*
- **R13. A new order day starts automatically every night** (about 3:30 AM, store time), so the day is
  already closed when the first person opens the app. The first app open is the fallback when the night
  run failed. There is no manual mid-day reset in the app. The close is also what guarantees the recap
  gets sent and the day gets logged. The close is all-or-nothing and can happen only once per day (a
  repeat or concurrent close changes nothing). Why nightly: the close took 14 to 31 seconds on a KM's
  first open. *(Confirmed: `nightlyMaintenance_` + `closeCycleInDb_` / `mog_sync_close_cycle`;
  owner decision D3, 2026-10-15; the manual app button was removed earlier.)*
- **R13a. Never let anyone order against a cycle you could not confirm.** If the system cannot verify
  that the current day has been reset, it must GATE — not proceed. The failure this rule exists to
  prevent is silent and expensive: the previous cycle's vendor list, pars and multipliers render
  identically to a normal day, so a user counts into a stale cycle and those counts get logged under
  the *old* cycle date with nothing on screen to hint at it. The correct behavior is a blocking screen
  offering a retry, plus — only when cached data exists — an explicit, user-chosen "work offline"
  path that makes the trade visible rather than automatic. On a rebuild: any error handler on the
  boot/auth path that falls through to "just show the app" is this bug. *(Confirmed:
  `gateOnUnconfirmedCycle_`, shipped 2026-08-03 after both boot paths were found failing open.)*
- **R14. Counts entered while offline are queued, and none is ever lost or filed under the wrong day.**
  This is a hard requirement: never lose a user's counts to a bad connection. Each queued count carries
  the day it was counted on. One that arrives after its day was closed lands in that day, and the
  server says so; it never leaks into the new day. The app then tells the user those counts weren't
  ordered, instead of reporting them synced, and the fallback path through Apps Script files them in
  their own day the same way. The app still flushes its queue before it closes a day itself.
  *(Confirmed: the queue's `cycleDate` + `mog_save_counts`' `stale` answer, the drain's late warning
  and `dbSaveOnHand_` (2026-10-20); `drainSaveQueue_` awaited by `runStaleReset_`; owner-confirmed
  hard requirement.)*
- **R15. The store PIN gates the app and the editor; a separate master PIN gates destructive/admin
  actions.** After repeated wrong PINs the store locks out for a cooldown window. The store PIN is the
  store's street number: easy for anyone on shift, and paired with the hub picker it stops one store
  from accidentally using another store's guide. Shift leads can use it because they have no company
  email. **A session lasts the life of the app session, not the life of a page load:** the PIN is
  re-entered after a full close, but survives a reload, so the app can restart itself (to pick up a
  new version, say) without pushing anyone back to the sign-in screen. Re-authentication is always
  validated against the server, never assumed from stored state. **Every server action goes through
  the PIN-checked door; there is no other way in.** A Sheet dialog uses a session the Sheet's own menu
  hands it, because whoever has the Sheet open is already trusted. Why: the current backend runs with
  the owner's rights for any visitor, so any other entry point would be a way around the PIN (found
  and closed 2026-10-16). Phones sign in to the database the same way: the store or master PIN buys
  a 12-hour session. PINs are stored there only as hashes, with the same lockout. *(Confirmed:
  `checkPin_`, lockout, `sessionStorage` mirror re-validated via `tryPin` on boot, `webedit_call` +
  `tests/public_surface.test.js`, `mog_login`; owner-confirmed why.)*
- **R16. Every store is strictly isolated**: one store's app only ever sees its own items, vendors,
  orders, and recipients. A user has no need to see another store's ordering, and it keeps the app
  simple. *(Confirmed: per-store Sheet + per-store deployment; owner-confirmed why.)*
- **R17. Item catalog, vendor delivery cadence, storage areas, and the pick path are store-owned
  data, not code.** Identical software runs every store; all per-store difference lives in the store's
  data. *(Confirmed: invariant #3.)*
- **R18. Storage areas and the pick path preserve the user's chosen order; other lists (vendors in
  pickers, catalog, recipients) sort alphabetically.** The pick path is a physical walking route, so
  its order is meaningful. *(Confirmed: 2026-07-16 alphabetize work; areas/pick-path left
  user-ordered.)*
- **R19. Par-review flags over- and under-ordering from order history**, as an informational nudge
  only; the GM/KM makes the final call because they know what the operation actually needs. An
  over-flag only fires when there is a whole unit's worth to trim (guardrails so it is not noisy).
  *(Confirmed: `History.gs` par-review; over-flag floors + 75% on-hand cutoff; owner-confirmed
  informational-only.)*
- **R20. The use-multiplier flag is off for slow-moving bulk items and fixed-size batch recipes.**
  Bulk items that cannot be ordered in smaller quantities, or are cheaper in bulk and do not spoil
  quickly, and batch recipes made to a set size, should not be scaled up by the day multiplier. The
  point is to avoid over-ordering them. *(Confirmed: `readMasterItemMeta_` honors col M;
  owner-confirmed which items.)*
- **R21. Par is a roughly-one-day par with a deliberate safety buffer.** It is not a literal single
  day's usage: it accounts for order cutoff times (you order mid-day, before the day is done, so some
  counted stock will still get used), for busy-day and catering spikes, and for a vendor being out of
  a needed item. In practice a "one-day" par behaves more like a 1.5 to 2 day par. *(Owner-confirmed;
  this is why suggested quantities are intentionally not cut to the bone.)*
- **R22. Within a concept the item list should be standardized; par, vendor cadence, and vendor
  selection vary by store.** Every store of a concept ideally orders the same catalog of items; what
  legitimately differs per store is the par (driven by that store's sales and product mix), the
  delivery cadence with its vendors, and sometimes the vendors themselves (some vendors are not
  available in every region). *(Owner-confirmed intent. Not enforced today: each store's catalog is
  currently built by hand, so standardization is a goal, not a guarantee. Since 2026-11-01 HQ rollouts
  (R28) add the same vendor or items to many stores at once, and since 2026-11-02 each concept keeps a
  library per side (R29), `docs/MOG_Warehouse_Spec.md`. See growth seams.)*
- **R23. One writer per kind of data; nothing syncs both ways.**
  - The database owns the counts, the current order day, the overrides and the order log.
  - A store's catalog (items, pars, vendors, storage areas, the pick path) is owned by its Sheet until the store moves, and copied one way into the database after every edit and nightly.
  - A store moves its catalog to the database in one step, from its Sheet's menu: either copying the Sheet's catalog (only when the parity check passes, so every phone screen stays the same; the menu runs the check and refuses otherwise) or starting empty, for a store whose Sheet is an unused copy. From then on the app's editor (Manage Items, Manage Vendors, Storage Areas, Shelf to Sheet) writes the catalog there directly, on a computer. **Every store moved on 2026-10-19**: seven copied their Sheet's catalog; Rockville BOH, Rockville FOH and Tysons BOH started empty (set up from MarginEdge).
  - The move also hands the database the store's order history (the Sheet's dates the database lacks, copied once) and the recap's recipients list (copied once). From then on the history screens, the Par Review flags and the recap email read them there; the recipients' GM row changes only on a computer. *(`docs/MOG_OneApp_Spec.md` T1, T2.)*
  - Every catalog change is logged (what, before and after, who, when) and can be undone; a change is refused, and nothing written, if a row it touches changed since the editor read it. *(One-app Phases 2 and 4, `docs/MOG_OneApp_Spec.md` E1-E4, S1-S5.)*
  - After a store moves, its Sheet keeps the catalog it had and is never updated again; its catalog tools refuse and point to the app. *(Owner decision 2026-10-18, S2: no copy back.)*
  - Nothing is copied back into the Sheet except a nightly backup of the order log.
  - Why: two copies that both accept writes eventually disagree, and then nobody knows which is right. Moving the catalog's ownership to the database is the planned next step (the web editor on the database), done in one step per store so the catalog never has two owners. *(Confirmed: design record `docs/MOG_SupabaseMigration.md` §3, D9, D16; owner direction 2026-10-15.)*
- **R27. Removing a vendor or a storage area never removes items.**
  - Removing a vendor takes it off every list it was on and off every item's vendors; the items it supplied keep their active flag and have no primary vendor until someone picks one.
  - Removing a storage area takes its items off the lists in that area; the items stay in the catalog.
  - Either way the items show as Unassigned in Manage Items, ready to be placed again.
  - Why: nothing is lost by removing a vendor or an area, because the item list already shows which items need a vendor or an area. *(Confirmed: design record D23, owner 2026-10-17. Stores still edited in their Sheet deactivate a removed vendor's items instead.)*
- **R24. A count belongs to its item, vendor and day, not to a row on a list.**
  - If the same item appears twice on one vendor's route, both rows share one count.
  - Two phones counting different items of the same vendor never overwrite each other.
  - Why: the old row-position storage could put a count on the wrong item when a list changed mid-day. *(Confirmed: `mog.counts` key; design record §9 "intended differences".)*
- **R25. Several people can count at once and see each other within seconds; nothing locks.**
  - A count saves itself a few seconds after the last change, not only on Save or Review, so the others can see it.
  - Someone else's count fills in only on items this device hasn't touched. What you typed stays yours.
  - Each vendor card shows who has it open ("Maria counting"), or who saved its latest count. Opening a vendor someone else has open shows a warning naming them. It does not lock: counts are kept per item, so a collision needs the exact same item, and then the last save wins.
  - Each device says once who is counting, picked from the store's own list of names (or typed, which adds it to the list; Skip shows "Someone"). It is a label, not a password: the shared store PIN stays the only gate (R15).
  - On a computer the list can be cleaned up: a renamed name follows to every device still using the old one, and a removed name isn't added back by a device still holding it (that device asks again; picking the name brings it back). Counts already saved keep the name they were saved with. *(`docs/MOG_OneApp_Spec.md` T3.)*
  - Why: KMs, GMs and shift leads often split the vendors between two people at the same time, and each needs to know what the other has done without asking. A lock would strand a vendor when someone walks away mid-count. *(Confirmed: `docs/MOG_OneApp_Spec.md` A5, A6, P1-P4, owner 2026-10-18.)*
- **R26. A phone can change today's order without changing the catalog, and every such change gets reviewed.**
  - "Just today" par: the item's par for this order day only, on every list the item is on (one par per item, R6). An existing, active item can be added to a vendor's list for today only; it shows in its usual storage area. The next order day has none of these.
  - They count everywhere the day's numbers come from: the count screens, the Today cards, the nightly order log and the recap.
  - Each one confirms, records who made it, can be taken back on the phone, and leaves a flag in Manage Items: Apply makes it permanent (a logged, undoable catalog change), Dismiss clears the flag.
  - "From now on" changes the catalog par itself (logged, with Undo), and only where the database owns the catalog (R23); everywhere else a phone offers "just today" only. Nothing that deletes or deactivates happens on a phone.
  - Why: the person at the shelf sees a busy day or a stock-out coming and needs today's order right without a computer, while managers keep control of the standing catalog. *(Confirmed: `docs/MOG_OneApp_Spec.md` A2, Q1-Q4, owner 2026-10-18.)*
- **R28. HQ adds to many stores at once; each store still owns its catalog.**
  - HQ (the maintainers, each signed in as themselves with the hq role, R30) adds a vendor, with starting delivery days, cutoff and contact, or new items (an LTO) to any set of stores in one save. Every store gets it or none does.
  - New items arrive with no par and no storage area: they wait in the store's Needs setup and are on no count list until the store sets them up. An item the store already has (same name) keeps its main vendor, par and area, and only gains the rollout's vendors it didn't list, as backups. A store that already has the vendor keeps it as it is.
  - HQ names a vendor once and remembers what each store calls it ("B&T" is "B&T Distributions" at Rosslyn BOH). HQ never renames a store's vendor; the store can, on its Vendors page, and HQ's remembered name follows.
  - A store renaming one of its vendors keeps everything that vendor had: its items' main and backup vendor, its count lists, the counts already saved today (one already under the new name keeps its place), the day's "just today" edits and day picks. Past orders keep the name they had. A name another vendor at the store has, ignoring capitals, is refused: two vendors are never merged by a rename. The store can undo it in its change log. *(Confirmed: owner 2026-11-02, schema v15.)*
  - Each store sees HQ's change in its own change log, signed by the person, and can undo it there (R23).
  - Why: a concept's stores should order the same items (R22), and an LTO has to reach every store at once, while pars, areas and cadence stay each store's. *(Confirmed: owner 2026-11-01; `docs/MOG_Warehouse_Spec.md`.)*
- **R29. Each concept keeps one standard item list per side (BOH, FOH): the concept library.**
  - A library item has a name, a pack, a main vendor, backup vendors and notes, with vendors by HQ's names. It has no par, no storage area and no stock: those stay each store's (R22).
  - A store's side comes from its location name (BOH or FOH), and the side picks its library.
  - An empty library starts from one store's active items. An item name listed twice there becomes one item, its other vendors as backups. HQ then cleans it. Seeds: Rosslyn BOH and FOH for Roll Play, Tysons BOH and Rockville FOH for Teas'n You.
  - Every save is the whole list and bumps a version. A save made from an older version is refused, and every save keeps the list it replaced.
  - Names are unique ignoring case, every item needs a main vendor, and a backup is never the main vendor.
  - Setting up a store from its library works like an LTO rollout (R28): items arrive with no par and no area, and an item the store already has keeps its own settings. An LTO's items reach the library only when HQ makes the LTO standard (R31); both happen in one save or neither does.
  - A library never changes a store's catalog or the phones by itself.
  - Why: the standard list of R22 needs one place to live, and a new store should start from it instead of typing its items. *(Confirmed: owner 2026-11-01, `docs/MOG_Warehouse_Spec.md` §1. The owner picked "no area, like an LTO" over carrying the library's storage areas into the store.)*
- **R30. HEH's warehouse (Happy Supply) keeps its own stock, apart from every store's catalog.**
  - The warehouse holds only what HEH stocks itself (king crab, shrimp), in its own storage locations (Berliner cold storage, a store's freezer). It is not the master item list: a store's other vendors never reach it.
  - Each person who signs in to HQ has a role: hq (the stores' catalogs, R28, R29), warehouse (only the warehouse), or both. The warehouse admin (Chef Dan) has warehouse only, so he can't change any store.
  - Stock is counted in cases per product and location and never goes below 0: a transfer that would take more than a location holds is refused, and the admin counts first.
  - Every change to stock is kept, never edited: what, where, how many, who, when, and why (a delivery's order number and cost, a transfer's number, a count's reason).
  - A vendor order in is numbered (PO-0001), edited or cancelled while ordered, and received once: what actually came in and what it cost, per line. Receiving moves the average cost; nothing else does.
  - The average cost per case covers every location and what's in transit: c cases in at cost k, with o owned at average a, make (o x a + c x k) / (o + c), kept to 4 decimals.
  - A transfer between locations is numbered (TR-0001); its cases leave on send, are in transit, and arrive when received.
  - A count at a location changes only the products given a number; a difference needs a reason, and a match changes nothing.
  - A store's price per case is the average cost plus the product's handling fee, plus the markup (0 to start), fixed when its order ships; stores never see the fee (R32).
  - Why: the warehouse's stock, costs and chargebacks need one honest record that matches a physical count, and its admin must not be able to touch the stores. *(Confirmed: owner 2026-11-01 and 2026-11-02, `docs/MOG_Warehouse_Spec.md` §2. The owner picked "refuse below zero" over allowing a negative balance until a count.)*
- **R31. An LTO is a named record HQ can end or take back at every store at once.**
  - Sending new items to stores (R28) makes one LTO: a name (required), one concept, the items as sent, the stores it went to, and a status: running, ended, rolled back or made standard.
  - Each item the LTO creates at a store carries the LTO's id as part of the item itself, so a store's edit keeps it and a store's Undo brings it back with the item. An item the store already had (same name) is never linked, and an item the store adds later never is, even when it takes a deleted item's number.
  - While it runs, HQ can send it to more stores, or do one of three things at every store it went to, every store or none, each store seeing one change it can undo:
    - **End** (it came off the menu): its items become inactive, off every count list, with par, storage area and order history kept, so they come back set up if it returns.
    - **Roll back** (a mistake or a test): its items are deleted even if a store set them up, the backup vendors it gave items a store already had come off again, and a vendor it added is removed when no item uses it, so the store is as it was before.
    - **Make it standard** (it stays on the menu): its items go into the concept library for each side it reached (R29) and stop being LTO items at the stores.
  - Where an LTO stands at each store (needs setup, set up, inactive, removed) is read from that store's own items, never stored apart, so a store's setup or Undo shows at once.
  - At the store, a running LTO's items that still lack a par or a storage area sit at the very top of the Items page, under a banner per LTO, newest first, until each has both; every LTO item carries an "LTO · name" mark.
  - An action made from an older view of the LTO is refused, as is any change to a store the action isn't about.
  - Why: an LTO reaches many stores in one step (R28) and has to leave them the same way, without a sign-in at each store. *(Confirmed: owner 2026-11-02, `docs/MOG_LTO_Spec.md`. The owner picked "inactive" for End over deleting, "delete anyway, name the stores" for Roll back, and "Make it standard" over the rollout's library box.)*
- **R32. A store orders from Happy Supply in its order guide, and the warehouse ships it.**
  - HQ links a store's item to a warehouse product (R30): it adds the item (no par, no area), or links one the store already has, which makes Happy Supply its main vendor (the old one stays a backup) and orders it in the product's case. The link is part of the item, so a store's Undo takes it off with the change and an item added later under a deleted item's number never inherits it.
  - A store's Happy Supply is the vendor that HQ's name "Happy Supply" maps to at that store (R28's remembered names). HQ adds it to a store, with its delivery days, before linking items there.
  - While counting, a KM sees each linked item's cases available: the warehouse's cases at every location, minus what other stores' sent orders hold. The store's own order this cycle is left out.
  - Send to Happy Supply sends the reviewed lines with a needed-by date (the next day Happy Supply delivers, by default) and a note, and marks the vendor reviewed. More than is available goes as typed, with a warning on the line; sending again in the same cycle replaces the order while it hasn't shipped. Every line is an active item on Happy Supply's list, linked to a product sold to that store.
  - An order is sent, then shipped, then received; it can be cancelled only while sent. There is no Approve step.
  - The warehouse ships each line from one location, at most what was ordered and never taking a location below 0. The Ship box starts with what's left after older sent orders (the number the store was told). Shipping drops the stock (a shipped move under the order's number) and fixes each line's price per case, (average cost + handling fee) x (1 + markup %) to the cent, and the order's delivery fee.
  - The store marks it received, each line at most what shipped; stock doesn't move then.
  - A phone never sees a price, a fee or a cost.
  - Why: a store's Happy Supply order went through a Facebook chat; this puts it in the warehouse's queue, with the stock and the fixed prices the monthly chargebacks (W3) read. *(Confirmed: owner 2026-11-02, `docs/MOG_Warehouse_Spec.md` §2, "W2 spec" and "W2a design". The owner picked no Approve step, cases available as a number, an over-order sent with a warning, the link in the item's row, and Ship starting with what's left after older orders. HEH's own stock held at Elpis follows as W2b, R33.)*
- **R33. HEH's own stock held at Elpis leaves the records when a store marks its Elpis delivery received.**
  - Elpis is a location in the warehouse's records held by a vendor (HQ's "Elpis Wholesale"); a product says where stores order it, Happy Supply or that vendor. A product held at Elpis keeps its stock there; Happy Supply never ships from it, and Send to Happy Supply refuses it.
  - KMs keep ordering it from their Elpis vendor as before (copy the order, email it). HQ links a store's own Elpis item to the product; Elpis stays its main vendor, and the store's Elpis is HQ's name for it there, picked the first time.
  - The night's close turns the store's ordered Elpis lines for linked items into one open delivery (EL-0001). Lines ordered from another vendor, or for unlinked items, aren't in it. A same-day re-close replaces or removes an open one; a received one stays. Nothing in this step can stop the close.
  - While counting, a KM sees each linked Elpis item's cases available at Elpis: the cases there, minus every open delivery (the store's own included, since its cycle has moved on). Another store's same-day order counts from the morning after its close.
  - The store checks the delivery in from the "To check in" list on Today, apart from ordering (v19: never on the vendor card), each line starting at what was ordered and changeable either way; only then do the cases leave Elpis. A delivery nobody checks in stays open and is listed for whoever keeps the Elpis stock, who can check it in for the store.
  - A receipt larger than the records goes through: the stock goes to 0, the difference is logged as a count with a reason naming the store and the delivery, and HQ flags it until the next real count at Elpis.
  - Each received line keeps the average cost; a phone never sees a price, a fee or a cost.
  - Why: HEH pays for its branded packaging up front and stores it at Elpis; the records have to match Elpis's own report without changing how KMs order. *(Confirmed: owner 2026-11-02 and 2026-11-03, `docs/MOG_Warehouse_Spec.md` §2, "W2 spec" and "W2b design". The owner picked recording at the close over at Mark as reviewed, a receipt beyond the records going through over refusing it, the keeper marking an unmarked delivery received, and the warehouse role over a separate Elpis role. Checking in apart from ordering: owner 2026-11-04, a vendor card that showed a delivery read as one to order from.)*
- **R34. HEH's stock sits at places, and a store's own vendor for an item decides which place its order comes from.**
  - A place is one of three kinds: HEH's own (Happy Supply's freezers), held at a store (RP Tysons holds shrimp for itself, Rosslyn BOH and Founders BOH), or held by a vendor (Elpis). A place at a store or a vendor carries the name the other stores order it under ("Transfer (Tysons)", "Elpis Wholesale").
  - An item sits at one or more places, each with a low point; below it, HQ's Stock page shows it amber. Instead of a par, an HQ item has a stock level and a low point at each place, and a price.
  - A store's order for an item comes from the held place whose name the store uses for that item's vendor, never from a place the store holds itself; otherwise from Happy Supply's own. The night's close records a held place's deliveries the same way (R33's rules, for any held place).
  - A store holding a place orders the item from Happy Supply as any store would; shipping it is a move into its place, not a sale: no price, no delivery fee, in transit until the store (or HQ for it) checks it in, then in that place. Its par has to cover the stores it holds for, since its KMs count the whole freezer.
  - The holder's own use is what its counts show: a count below the records is use, an opening count (nothing on record before it) isn't. Each month HQ lists, in cases, what each store took from each place (deliveries checked in, Happy Supply orders received, the holder's own use) and the moves between places apart, which nobody is charged for.
  - Why: HEH holds shrimp at RP Tysons for the other Roll Plays, and its paper goods at Elpis; HQ has to show how much is where and who took what without changing how KMs order. *(Confirmed: owner 2026-11-04, `docs/MOG_Warehouse_Spec.md` §2, "W2c spec" and "W2c design". The owner picked HEH's stock until a store takes it over RP Tysons buying it, RP Tysons ordering it on the phone over Dan restocking it, its own use from its MarginEdge count, cases only for now, and a table of items by place with Items and Places shaped like a store's Manage.)*

---

## Layer 3: Rebuild spec

*From here the reader is a developer on any stack, rebuilding MOG's behavior without its source.*

### Data model

*Conceptual entities. In the current implementation these map to tabs/columns in one Google Sheet
per store; a rebuild would model them as tables. Column letters are breadcrumbs only.*

#### Entity: Store (one per location; the whole dataset is scoped to it)
| Field | Type (conceptual) | Notes |
|---|---|---|
| slug | identifier | Immutable once published (bookmarks/home-screen icons depend on it). |
| concept | enum | Roll Play / Teas'n You / ĂN / Lei'd Poke. Drives theming plus minor config. |
| location name | text | Display name, for example "Rosslyn BOH". Encodes BOH vs. FOH. |
| side | BOH / FOH | Read from the location name; picks the store's concept library (R29). |
| store PIN | secret | The store's street number. Gates app + editor. |
| master PIN | secret | Gates destructive/admin actions. |
| recipients | list of {name, email, active, GM?} | Who gets the recap email; the GM row comes first and changes only on a computer. Owned by the database once the store's editor moved (R23). |
| configured? | boolean | False until first-run setup completes. |

#### Entity: Item
| Field | Type (conceptual) | Notes |
|---|---|---|
| item id | identifier | Stable key (MASTER_ITEMS col A). |
| name | text | col B. |
| pack / unit | text | col E. |
| base par | number | col G. Shared across all the item's vendors (R6). Carries a safety buffer (R21). |
| primary vendor | vendor ref | col C. Default order source (R7). |
| eligible vendors | list of vendor refs | col O. Every vendor that can supply it (R7). |
| use-multiplier | boolean | col M. Off = order flat to par, for bulk/batch items (R20). |
| active | boolean | col L. |
| notes | text | col N. |
| warehouse product | product ref or none | The Happy Supply product it comes from (R32), or HEH's product held at Elpis (R33). Set by HQ; part of the item, so Undo brings it back. |

#### Entity: Vendor
| Field | Type (conceptual) | Notes |
|---|---|---|
| name | identifier (per store) | Also the vendor-tab header, which drives its item spine. |
| delivery cadence | 7 day-multipliers | One multiplier per weekday; 0 = no delivery that day (R3). Drives coverage (R2). |
| cutoff time | time or null | Order-by time (informational). Part of why par carries a buffer (R21). |
| contact | person, phone, email, how to order, order email, website, account #, notes (all optional) | Per store: each store has its own accounts. Shown on the phone's vendor card. Never passwords. (2026-11-01) |

#### Entity: Concept library (one per concept and side, R29)
| Field | Type (conceptual) | Notes |
|---|---|---|
| concept + side | composite key | For example Roll Play BOH. |
| version | integer | Bumped on every save; a save made from an older version is refused. |
| seeded from | store ref | The store the list started from. |
| items | ordered list of {name, pack, main vendor, backup vendors, notes} | Names unique ignoring case; vendors by HQ's names. No par, area or stock. |
| log | list of {who, when, label, list before} | Every save keeps the list it replaced. |

#### Entity: LTO (R31)
| Field | Type (conceptual) | Notes |
|---|---|---|
| id | identifier | Made when it's sent; each item it creates carries it. |
| concept, name | concept ref, text | Name required. |
| items | list of {name, pack, main vendor, backup vendors, notes} | As sent, with HQ's vendor names. |
| status | running, ended, rolled back, made standard | Only a running LTO can change. |
| version | integer | An action made from an older version is refused. |
| stores | list of {store, when, the change it made there, vendors it added, backups it added} | What Roll back takes off again. |

#### Entity: Warehouse product (Happy Supply, R30)
| Field | Type (conceptual) | Notes |
|---|---|---|
| name, pack | text | Names unique ignoring case. |
| par | cases | Over every location. |
| average cost | money per case, 4 decimals | Set and moved only by deliveries received. |
| handling fee | money per case | Never shown to a store. |
| stores | list of store refs | The stores that may order it; none = every store. |
| places | list of {place, low point} | The places it sits at (R34); a store's own vendor for its item decides which one its order comes from. Replaces v17's single "via" (kept only for a product with no place yet). |
| stock | cases per place | Never below 0. A place is HEH's own, held at a store or held by a vendor (R34), one per holder name; Happy Supply never ships from a held one. |
| moves | list of {when, who, location, cases (+/-), kind, order or transfer number, cost, reason, cases after, average after} | Every change to stock; never edited. Kinds: received, transfer out, transfer in, count, shipped (R32; a held place's delivery is a shipped move under its EL number, R33; a Happy Supply line into a holding store's place is a transfer out, then a transfer in at its check-in, R34). |

#### Entity: Store order (Happy Supply, R32)
| Field | Type (conceptual) | Notes |
|---|---|---|
| number | text | HS-0001 on, from the orders there. |
| store, cycle | store ref, date | One sent order per store and cycle; sending again replaces it. |
| needed by, note, sent by | date, text, name | From the phone's review. |
| status | sent, shipped, received, cancelled | Cancelled only while sent. |
| lines | list of {store item and its name, product, cases ordered, shipped (and from where), the place it moves into, received, price per case, average cost} | Price and average fixed at ship; a line into a holding store's place has no price (R34); the phone never sees them. |
| delivery fee | money per order | Fixed at ship. |

#### Entity: Delivery from a held place (R33, R34)
| Field | Type (conceptual) | Notes |
|---|---|---|
| number | text | EL-0001 on, from the deliveries there. |
| store, cycle, place | store ref, date, place ref | One per store, cycle and held place (Elpis, RP Tysons); made by the night's close; never from a place the store holds. |
| status | ordered, received | Received by the store, or by HQ for it. |
| lines | list of {store item and its name, product, cases ordered, received, beyond the records, average cost} | Ordered from the order log; the average kept at receipt; the phone never sees it. |

#### Entity: Count line (per item, per vendor, per day)
| Field | Type (conceptual) | Notes |
|---|---|---|
| item id + vendor | composite ref | Each (item, vendor) tracks its own on-hand (R8). |
| on hand | number (decimal ok) | The user's count (R5). |
| counted by | name (optional) | Who saved it last, from the store's name list (R25). |
| suggested qty | number | Derived, not stored raw; computed via R1. |
| storage area + position | area ref + order | The user's walking route (R18). |

#### Entity: Order history record
| Field | Type (conceptual) | Notes |
|---|---|---|
| order date | date | Order cycle it belongs to. |
| vendor | vendor ref | |
| item + qty ordered | list | Only lines with a positive suggested qty are logged (see edge cases). |
| on-hand at time of count | number | Feeds par-review (R19) and usage history. |

#### Entity: Store state (order-cycle bookkeeping)
| Field | Type (conceptual) | Notes |
|---|---|---|
| active order date | date | The current cycle; "new day" = today past this (R13). |
| last recap sent date | date | Dedupe gate for the recap (R12). |
| emergency override | boolean | Store-wide; clears on reset (R11). |
| vendor override pick | integer 1–7 per vendor | Frozen day count while override is on; clears with the flag (R10/R11). |

### Flow contracts

#### Contract: Compute suggested order quantity (the heart of the system)
- **Inputs:** item base par; item use-multiplier flag; the vendor's multiplier for today; the user's on-hand count.
- **Validations:** par present and numeric; day multiplier > 0; on-hand present.
- **Logic (language-neutral pseudocode):**
  ```
  effectiveMult = useMultiplier ? vendorDayMultiplier(vendor, today) : 1
  if par is not a number OR effectiveMult <= 0 OR onHand is missing: return NOTHING_TO_ORDER
  qty = roundUp(par * effectiveMult - onHand)
  return qty > 0 ? qty : NOTHING_TO_ORDER
  ```
- **Outputs / side effects:** a per-item suggested quantity on the count screen; no persistence until submit.
- **On failure / missing data:** any missing input returns NOTHING_TO_ORDER (item shows blank), never a wrong number.
- **Rules applied:** R1, R2, R3, R4, R5, R21.

#### Contract: Vendor day multiplier
- **Inputs:** the vendor's 7-day cadence; today's weekday; the emergency-override flag.
- **Logic:**
  ```
  m = cadence[vendor]; if none: return 0
  if not emergencyOverride: return m[today] or 0        // 0 = no delivery today
  // emergency override: bridge to the next delivery
  for i in 0..6:
     v = m[(today + i) mod 7]
     if v > 0: return v
  return 1                                              // never-delivers fallback
  ```
- **Rules applied:** R3, R10, R11.

#### Contract: Submit a daily count
- **Inputs:** vendor; the per-item on-hand counts (and any user-adjusted quantities).
- **Validations:** same-day check; offline queue drained first (R14).
- **Outputs / side effects:** on-hand persisted per item a few seconds after the last change, with who saved it (R25); at the cycle's close, lines with positive suggested qty are logged to history and the recap email is sent if not already sent this cycle (R12).
- **On failure:** the submit runs under an extended timeout; if the client aborts but the server finished, the app re-checks status and enters the app rather than double-submitting or stranding the user.
- **Rules applied:** R0, R12, R14, R25.

#### Contract: New-day reset
- **Inputs:** active order date vs. today.
- **Logic:** nightly (and as the fallback on the first app open): if today > active order date, then in ONE transaction log every line with a positive suggested quantity under the closing day, set active order date = today, clear emergency override and day picks. Refuse (change nothing) when the stored day is no longer the one being closed, so a repeat or concurrent close is harmless. Then build the recap from the logged lines and send it if unsent; append a backup of the lines to the history sheet. The closed day's counts stay with that day; the new day starts with none.
- **On failure:** nothing changes (the transaction is all-or-nothing); the app's first open retries. If a client abort hid a finished close, re-poll status and enter the app.
- **Rules applied:** R11, R12, R13, R14, R23.

#### Contract: Reassign an item's primary vendor
- **Logic:** flip the item's primary vendor to the target; keep every existing eligible/backup vendor; ensure the new primary has a pick row; the former primary stays as a backup.
- **Rules applied:** R7, R9.

### Edge cases and why

*The why is the payload. A rebuilder without it will "fix" deliberate behavior.*

| Behavior | Why |
|---|---|
| Order quantities always round up, never down. | You would rather have a little extra than 86 an item mid-service, and vendors sell whole units so a fractional need has to become the next whole pack. |
| Par is per-item, not per-vendor; vendor differences are handled by the day multiplier only. | So a user can compare vendor prices and switch sources without duplicating the item or recomputing a par, can see at a glance where else an item is available, and can recover from a stock-out by ordering from a backup. One number also cannot drift between vendors. |
| Par is a "one-day" par but is intentionally sized to about 1.5 to 2 days. | Orders are placed mid-day before vendor cutoff times, so some counted stock still gets used before delivery; the buffer also absorbs busy-day and catering spikes and a vendor being out of an item. Cutting par to a literal single day would cause run-outs. |
| Suggested quantity is blank when the vendor does not deliver today. | You order to cover only until the next delivery (usually next-day). A restaurant has limited space for perishables and values freshness, so ordering more than needed causes waste and ties up cash. |
| The use-multiplier flag is off for bulk and batch-recipe items. | Bulk items you cannot order smaller, or that are cheaper in bulk and do not spoil, and set-size batch recipes, should not scale up by day; scaling them just over-orders. |
| Emergency override bridges to the next delivery instead of a flat 1×. | A flat 1× order cannot tide a store over to a vendor's next scheduled drop when the schedule is disrupted (for example a holiday on a delivery day); covering the gap is what "emergency" actually needs. |
| Emergency override is store-wide and any user can flip it. | Vendors tend to share delivery days, so a disruption usually hits all of them at once, and turning it on is an operational call, not an admin one. |
| The manual "start the new day" button was removed; the day closes itself every night, and the first app open is the fallback. | It was pure friction, and the close took 14 to 31 seconds when it ran on a KM's first open; at night nobody waits for it. It is still what guarantees the recap sends and the day logs. |
| A count saved after its day closed lands in its own day, not the new one. | A phone that queued counts offline overnight must not pollute the fresh day; the late count is kept as evidence for the day it was made. |
| The same item twice on one vendor's route shares one count. | A count belongs to the item, not the row (R24). |
| A "just today" par applies on every list the item is on. | One par per item (R6): a day-only par is the same number, for one day. |
| A "just today" change lands in the nightly order log and the recap, not only on the phone. | They are applied in the one place every reader goes through, so the phone, the log and the email can never disagree about what was meant to be ordered. |
| Two people on the same vendor get a warning, not a lock. | A lock strands a vendor when someone walks away mid-count; counts are per item, so only the exact same item can collide (R25). |
| An incoming count never overwrites one this device typed. | The person holding the phone is looking at that shelf; their number is the fresher one (R25). |
| Secondary/backup vendors are fully orderable, not reference-only. | A user needs to order from a backup when the primary is out of stock or not delivering that day, or when the backup is cheaper this week. |
| Only lines with a positive suggested quantity are logged. | History records what was actually meant to be ordered, not zero rows, which keeps the usage history clean. |
| Offline counts must flush before reset. | A user on a flaky connection must never lose a count to an auto-reset that fires first. |
| Storage areas and pick path stay in the user's manual order; everything else sorts A to Z. | The pick path is a physical walking route through the store; alphabetizing it would defeat the purpose. |
| Same identical code ships to every store; all per-store difference is data. | Nine stores cannot each carry a code fork; isolation (R16) keeps a user out of other stores' data. |
| The recap retries on a send failure, but still lands at most once per cycle. | The recap is the handoff used to place real orders and an accountability record, so a silent miss is costly; a failed send is retried up to 3 times, and the last-sent date keeps it to one email (Q-INT-1, built). |

### Integration contracts

| Integration | Direction | Payload | Frequency | If it's down |
|---|---|---|---|---|
| Phone app and database | Both | One snapshot (catalog, current day, overrides, this day's counts) down; count saves and override changes up; the order math runs on the phone | Sign-in, each screen (a snapshot is reused for ~3 s), each save | App shows "Offline"; counts queue locally with their day and flush on reconnect (R14). |
| Phone app and count engine | Both | Reset fallback, recap resend | When those actions are used | Those actions fail with an error; counting carries on against the database. |
| Count engine and database | Out (nightly close), In (snapshot, recipients and order lines for the close and the recap) | The nightly close; the PINs (stored as hashes); the one-time copies when a store's editor moves (catalog, order history, recipients) | Nightly; once per store | Catalog edits reach phones on the next successful push (the nightly one at the latest); a failed night close is retried by the first app open. |
| Count engine to recipients | Out | Recap email ("today's suggested order") | Once per order cycle | The session still records; a failed send is retried up to 3 times, still capped at once per cycle (Q-INT-1). |
| Recipients to vendors | Out (outside MOG) | The actual purchase order | Per order | Not a MOG boundary; MOG's job ends at the recap. Documented so a rebuilder does not try to place orders from MOG. |
| Count engine and per-store Sheet | Out | The nightly order-log backup (the Sheet keeps the catalog it had at the move and is never updated again) | Nightly | The backup waits; nothing else depends on the Sheet. |
| MarginEdge | In | Vendor Items export (CSV), uploaded in the editor: vendors first, then the items they sell. Each product becomes one item under its MarginEdge name; the vendor bought from most recently is its primary. Items arrive with no par, pack or storage area. | Once, when a store's catalog is set up (stores whose editor is on the database) | A bad or wrong file is refused before anything is saved; one import is one logged change, undoable. Not yet: pack sizes (MarginEdge's API has them, the CSV doesn't) and cost. |
| Web editor and database | Both | The catalog tables, the change log, saves and Undo, order history, the Health Check | Per editor action (every store since 2026-10-19, R23) | Editor unusable until back; each save is all-or-nothing. |
| **Future:** Toast (POS) | In (planned) | Sales / usage to inform pars | TBD | Not built; see growth seams. |

### Configuration and constants

| Setting | Controls | Business or technical |
|---|---|---|
| Base par (per item) | Target stock level plus safety buffer; the anchor of every suggested qty | **Business** |
| Vendor delivery cadence (7 multipliers) | Which days a vendor delivers and coverage per weekday | **Business** |
| Use-multiplier flag (per item) | Whether an item scales by coverage or orders flat to par | **Business** |
| Emergency override | Off-schedule ordering (bridge-to-next-delivery) | **Business** (operational switch) |
| Recipients list | Who gets the recap email | **Business** |
| Store PIN (street number) / master PIN | App + admin access | **Business** |
| Over-flag on-hand cutoff (75%) and whole-unit floors | Par-review noise threshold | **Business decision encoded as a knob** |
| Par-review window / min-orders (28 days / 3 orders) | How much history before flagging | Technical tuning of a business signal |
| PIN lockout threshold + cooldown | Brute-force protection | **Technical** |
| Live refresh (10s), autosave delay (~4s), "gone" after 90s unseen, names unused 30 days leave the picker | How quickly concurrent counters see each other (R25) | **Technical** |
| Cache TTLs, mutation timestamps | Read freshness vs. speed | **Technical** (platform note) |

### Growth seams

- **Automate new-store onboarding (the biggest current constraint).** Standing up a new store today
  is heavily manual: someone creates the store's Google Sheet, hooks it into the backend so the app
  works, then hand-enters every vendor and every item. That manual build is the single largest source
  of friction and the thing a rebuild should most reduce. The seam is a store-provisioning flow that
  creates a store and seeds its catalog with little or no hand entry. Import from MarginEdge
  (below) is the partial step built so far; the older Import Vendor CSV panel was retired in its
  favor on 2026-10-20. Creating a store with no Google Sheet at all is specced (2026-11-01,
  `docs/MOG_Warehouse_Spec.md` §3): the nightly close, the recap email and the setup need a home
  that isn't a per-store Sheet first.
- **Seed the catalog from MarginEdge.** Beyond cost, MarginEdge should be able to populate a store's
  item list, so onboarding a store becomes "pull the items" instead of "type in the items." The first
  version is built (2026-10-18): the Vendor Items CSV imported in the editor. Next steps are the API
  (pack sizes, no export step) and cost. This is the same data path as cost/sales below and is the
  highest-leverage integration for reducing setup labor. The Item entity is where seeded items land; the concept-standardization model (R22) is what
  they should conform to.
- **Standardize the catalog per concept (R22).** Every store of a concept should share one item list,
  with par, cadence, and vendor selection varying per store. The natural shape is a per-concept master
  catalog that each store inherits and then tunes (its own pars from its sales/product mix, its own
  vendor cadence, its own regionally-available vendors). Today each store's catalog is built
  independently, so this is a design target, not current behavior; a rebuild should make the concept
  catalog a real, inheritable entity. Built so far: HQ rollouts to many stores at once (R28,
  2026-11-01) and a per-concept, per-side library seeded from one store and cleaned in HQ, which a
  new store's order guide starts from (R29, 2026-11-02; `docs/MOG_Warehouse_Spec.md` §1). A store
  copies from its library once; nothing keeps the two in step afterwards.
- **HEH's own warehouse (Happy Supply).** HEH buys some products centrally, stores them (rented cold
  storage, a store's freezer) and sends them to stores, charging each store back monthly. Specced
  2026-11-01 (`docs/MOG_Warehouse_Spec.md` §2): the warehouse is one vendor among a store's vendors,
  with its own stock, costs and admin role behind it; only a store's items from that vendor link to
  warehouse products, and a KM sends that vendor's order to the warehouse from the review screen.
  Built so far (W1, 2026-11-02): the warehouse's own stock, vendor orders in, transfers, counts and
  history, and the warehouse role (R30); store orders from Happy Supply (W2a, R32); HEH's own stock
  held at Elpis, recorded at the close and checked in at the store (W2b, R33); HEH's stock at three
  places, RP Tysons holding shrimp for the other Roll Plays, and who took what in cases (W2c, R34).
  Next: monthly chargebacks (W3).
- **LTOs as records.** Built 2026-11-02 (R31, `docs/MOG_LTO_Spec.md`): HQ ends, rolls back or makes
  standard what it sent, and the store's Items page shows new LTO items first until set up. Next:
  lining up each concept's stores with its library, and items a store can't remove (its own spec).
- **Cost and sales integration.** Pull cost from MarginEdge and sales/usage from Toast so pars can be
  informed by real data and the recap can carry cost. The count engine is where these land; the Item
  and Order-history entities are where cost/usage fields attach. The goal is a plug-and-play system
  strong enough that KMs and GMs spend their time training people rather than on recurring manual
  tasks.
- **Par intelligence.** Par is currently a hand-set number with a manual safety buffer; the
  par-review flags are the seed of a system that could recommend par changes from history plus sales,
  while leaving the final call to the GM/KM (R19).
- **One portal, many tools.** MOG may become a module in a company-wide operations app alongside the
  visual schedule, prep schedule, and store reports. Whether they share one login and one
  people/store system is not yet decided, so the Store entity, the PIN/access model, and the
  recipients list should be built to be swapped for a shared identity/roster later.
- **Editability and per-concept flexibility.** A stated pain with the current version is how hard it
  is to adjust behavior per concept and to edit safely; a rebuild should make store/concept
  configuration a first-class, low-risk activity.

### Platform notes (safe to drop on rebuild)

*Everything here is an accommodation of the current stack (a PWA plus Google Apps Script plus one
Google Sheet per store). A rebuild on another stack can drop all of it and lose zero business
behavior.*

- **Order math was migrated out of sheet formulas into code** so the count path no longer depends on
  reading a live spreadsheet's formula cells. On a real database this whole concern disappears; the
  math (R1 to R3, R10) is the asset, not where it runs.
- **Nine separate deployments** (8 stores plus a master template), identical code, config-in-data.
  This is how the current platform does multi-tenancy; a rebuild would use one app with a store
  dimension in the data. The isolation (R16) is a rule; the nine deployments are a workaround.
- **Offline support is limited** by what a PWA plus service worker can cache and queue. Improving
  offline resilience is a stated goal; the requirement (R14, never lose counts) is the durable part.
- **"Push" vs. "redeploy"**: the phone app reads a versioned snapshot of the backend, so backend
  changes need an explicit version bump. Pure deployment mechanics.
- **Service-worker cache versioning**: the phone app caches its shell; a version bump evicts stale
  copies. PWA-specific.
- **Execution-time limits, cache TTLs, lock service, mutation timestamps, batched reads/writes**: all
  present to stay within Apps Script quotas and to serialize concurrent edits on a Sheet. A
  transactional database makes these moot.
- **Web editor served from the same URL via a different route (`doGet?page=…`), PIN-gated,
  desktop-only, token in the URL across page loads**: a consequence of hosting the editor inside the
  same Apps Script web app as the phone API. A rebuild would just have an authenticated admin UI.
- **Vendor "tabs," a hidden vendor template, a B1 header driving the item spine, storage-area and
  pick-path stored in SETUP columns**: spreadsheet-shaped storage. The entities in the data model
  above are the durable form.
- **Supabase specifics (2026-10)**: private tables reachable only through SQL functions, a per-store
  sync key for the Apps Script side, a public publishable key in the app, the per-store `phone_direct`
  switch, and the one-time "Move this store to Supabase" step. All migration scaffolding or platform
  security; the rules they serve are R14, R15, R23 and R24.
- **Every server function private except a reviewed list (`tests/public_surface.test.js`)**: how the
  current backend enforces R15's single door, because Apps Script exposes every public function to
  any page it serves.

---

## Resolved owner questions

All ASSUMED flags from the draft were resolved on 2026-07-17. The one item left open then, since built:

- **Q-INT-1 (recap retry):** The recap retries on a send failure but still lands at most once per
  cycle: `sendPendingRecap_` tries a failed send up to 3 times, and the last-sent date keeps it to one
  email. Kept here so a rebuild builds it in.
