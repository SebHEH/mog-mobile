# Session Handoff — Vendor Cadence Audit + PWA decimal On Hand

**Session date:** 2026-05-29
**Session focus:** Walk through the ManageVendors edit-form redesign, then pivot to whatever fell out of that conversation; near the end, a quick PWA tweak Sebastian wanted shipped today.
**Outcome:** Two shipped. (A) Built a read-only **Vendor Cadence Audit** sidebar (commit `9b4c027`, deployed bound-sidebar to all 9 stores) that flags vendors whose stored mults wouldn't round-trip through the delivery-day picker — Sebastian's pre-flight check before promoting the picker to source of truth. (B) **PWA decimal On Hand input** (commit `daf354f`, CACHE_VERSION v11→v12, GitHub Pages auto-deployed) so KMs can type `.4`, `1.5`, etc. The ManageVendors edit-form redesign itself was deliberately **deferred** until the audit findings are worked through.
**Next session focus:** Once Sebastian has run the audit on all 9 stores and recalibrated anything flagged, return to the ManageVendors Edit-form disclosure work (hide raw mults grid behind an "Advanced" toggle).

---

## Section A — ManageVendors edit-form walkthrough (no code shipped)

The walkthrough surfaced that the framing in 2026-05-28's handoff was partly stale: the **delivery-day picker is already in Edit** (shipped 2026-05-26 as `c86d9d3`). What's actually still on the table is narrower.

Locked decisions:

- **Gate 1 = (b)** — when Sebastian said "Edit shows raw multipliers" he meant the mults grid sitting next to the picker. Want it collapsed behind an "Advanced" disclosure so the picker is THE input; the grid stays as an escape hatch.
- **Gate 2 = (b)** — **no lead-day picker.** The operational convention is "always pretend 1-day lead; size pars accordingly." Adding a lead-day input would confuse KMs.
- **Gate 3 = (c) defer** — no schema migration. With Gate 2 = no lead-day, the only remaining payoff was reversibility, and (1) Recalibrate Vendor already fixes stale mults; (2) the eventual Edit UX will write clean picker-derived mults on every save, eroding stale inventory naturally. Cost (new columns + per-store backfill + formula-verify pass) isn't justified yet.
- **Don't ship the disclosure yet** — Sebastian's call. Silent-rewrite-on-save risk on non-canonical vendors. Audit the data first, recalibrate where needed, *then* the UX change is risk-free.

This is the operational reason the audit tool exists: it narrows the eyeballing surface before the disclosure ships.

## Section B — Vendor Cadence Audit sidebar (commit `9b4c027`)

Read-only diagnostic at Ordering Guide → 📱 Mobile API → **Audit Vendor Cadence**.

- **Server in `OrderGuideScript.gs`:** `auditVendorCadence()` reads VENDOR_TABLE, runs `inferDeliveryFromMults_` → `computeMultsFromDelivery_` per vendor (server-side twins of the existing ManageVendors client helpers, ES6 const-style to match the .gs convention), classifies each as:
  - `canonical` — round-trip is lossless; safe to commit picker-derived mults later.
  - `mismatch` — recomputed mults differ from stored; **must recalibrate** before promoting the picker.
  - `everyday` — canonical but every day delivers and every mult is 1 (the rpr "1-day par everywhere" pattern); confirm the vendor actually delivers daily.
  Returns `[{name, mults, inferredDelivery, canonicalMults, status}]`. Plus `showVendorCadenceAuditSidebar()` opener and a menu entry under the existing Mobile API submenu (alongside Recalibrate Vendor Pars).
- **Modal `VendorCadenceAudit.html`** (new, 21 EN/ES keys, parity verified): summary chips (total / canonical / mismatch / everyday), legend, and a sortable table — mismatch first, then everyday, then canonical. Mismatch rows visually outline the specific mult cells that differ between stored and canonical so the discrepancy is obvious at a glance. Read-only — no save path. No `--redeploy` (bound-sidebar only).
- **Deploy:** canary rprfo via `python deploy.py --target rprfo`, Sebastian smoke-tested, then full fan-out via `python deploy.py`. All 9 ok.

Why this layer: pure read against the bound spreadsheet. PWA doesn't need to know about it; no /exec change. Audit and fix are intentionally **separate tools** — Audit narrows the eyeballing surface, Recalibrate Vendor Pars actually rewrites mults + items pars together (the discipline rpr needs).

## Section C — PWA decimal On Hand input (commit `daf354f`)

Quick pivot late in the session. KMs needed to enter fractional counts.

- **`template/index.html` — 3 edits:**
  - Count input (~line 3877): `inputmode="numeric"` → `inputmode="decimal"` + add `step="any"`. Triggers the iOS/Android decimal keypad and stops the browser from rejecting non-integer values on a `type="number"`.
  - Stepper +/− handler (`onStepperClick`, ~line 3916): `parseInt(raw, 10)` → `parseFloat(raw)`. So `1.5` + tap → `2.5`. Buttons still step by 1.
  - Typed-input handler (`onCountInputChange`, ~line 3927): `parseInt(raw, 10)` → `parseFloat(raw)`. `.4` and `1.5` survive.
- **`template/sw.js`:** `CACHE_VERSION` v11 → v12.
- **No backend change.** `api_saveOnHand_` already does `Number(it.onHand)` ([MOGApi.gs:658](apps-script/MOGApi.gs)), so decimals reach the vendor-tab cells correctly. No `--redeploy`.

Build + push: `python build.py` regenerated all 8 `<slug>/` dirs; `git push` triggers GitHub Pages auto-deploy.

---

## Outstanding (carry forward)

1. **Sebastian to run the Audit on all 9 stores** at his pace. For each ⚠ Mismatch → run Recalibrate Vendor Pars on that vendor (already deployed). For each ⓘ Every-day → confirm daily delivery is real; if not, Recalibrate.
2. **Then revisit ManageVendors Edit-form disclosure.** Hide raw mults grid behind an "Advanced" toggle; picker becomes THE input. Save derives mults from picker (Advanced closed) or trusts the raw inputs (Advanced open). Single-file change in `ManageVendors.html`, no backend, no schema. ~21 i18n keys probably (one new for "Advanced: raw multipliers"). Safe to ship once Section B's audit findings are worked through and the silent-rewrite risk is gone.
3. **PWA decimal On Hand smoke-test pending.** Sebastian to verify on live URL after GitHub Pages rebuild — pull-to-refresh once to activate `v12`, type `.4`/`1.5` into a count, confirm the decimal keypad shows and the suggestion pill recomputes.
4. **Pre-existing carry-forwards still open** (from 2026-05-28):
   - Recalibrate Vendor tool runs on rpr's vendors at Sebastian's pace.
   - Migrate Item Vendors per sheet (optional hygiene).
   - Parallelize `deploy.py` (deprioritized — "30s isn't hurting").
   - Reconcile the Rhino-ES5 invariant in CLAUDE.md / `rhino-safe-html` skill — modals run in the browser, but new code is still written ES5-safe by convention.
   - Retire `api_getHistory_` if the daily-recap auto-send caller is migrated.

**Standing caveats:** canary is **rprfo** (not rpr); the deploy router still prints `rpr`, override.

---

## Files touched this chat

**Apps Script source:**
- `apps-script/OrderGuideScript.gs` — `auditVendorCadence` + `computeMultsFromDelivery_` + `inferDeliveryFromMults_` + `showVendorCadenceAuditSidebar` + menu entry under 📱 Mobile API.
- `apps-script/VendorCadenceAudit.html` — **NEW** modal (21 EN/ES keys, parity verified).

**PWA source:**
- `template/index.html` — 3 edits in the count input render + handlers.
- `template/sw.js` — `CACHE_VERSION` v11 → v12.

**Generated (build.py output, do not hand-edit):**
- All 8 `<slug>/` dirs refreshed via `python build.py`.

**Docs:**
- `docs/MOG_SessionHandoff_2026_05_29.md` (this file).
- `docs/MOG_CurrentState.md` (updated below).
- `CLAUDE.md` (@-import line updated to this file).

**Deployed to:**
- Audit sidebar (bound-sidebar): all 9 clasp targets via `python deploy.py`.
- PWA decimal On Hand: GitHub Pages via `python build.py` + `git push`.

---

## Commits landed this session

```
9b4c027 feat(vendors): read-only cadence audit sidebar
daf354f feat(pwa): accept decimal On Hand input (.4, 1.5, etc)
```

---

# Later session — Manage Vendors multiplier clarity + Dashboard branding + #4 scoping

**Session focus:** Started from Sebastian's worry that the ManageVendors multiplier-tuning system was fragile; shipped two UX/branding features; then worked his backlog (PWA-perf question, an assign-after-reset bug, the Excel template) and ended scoping #4 (vendor-tab redesign + migration).
**Outcome:** Two features shipped to all 9 (deployed via clasp; **commits PENDING — Sebastian owns the commit**). The #2 bug was parked. #4 was scoped + de-risked, with a read-only audit tool now live on all 9 and a real safety finding (VENDOR_TEMPLATE was deleted on rprfo).
**Next session focus:** Build the #4 migration — re-establish VENDOR_TEMPLATE, harden add-vendor, dead-column strip + header branding, `migrateVendorTabs()` — after running the new audit across all 9 stores.

## What shipped (deployed all 9 — commits PENDING)

1. **ManageVendors multiplier→delivery clarity** (`ManageVendors.html`, bound-sidebar, no `--redeploy`).
   - Per-cell **"→ <delivery day>" arrows** under each active multiplier (Add + Edit) — `updateMultFeeds_` folded into `styleMultInput`, `data-day` attr on each input.
   - **Worked-example callout** at top of the Edit form (`multExample` glossary key, EN/ES) using the Mon/Thu/Sat case.
   - **Latent bug fixed:** `setLang` never re-rendered vendor cards, so the EN/ES toggle left card chrome (example box, cutoff/day labels) in the build-time language. Added `rerenderVendorCards_()` called from `setLang`. i18n parity 26/26. Canary rprfo → all 9.

2. **Dashboard per-store name + concept branding** (`MOGApi.gs` + `OrderGuideScript.gs`, `--redeploy`).
   - Root issue: `buildHomeBanner_` hardcoded `"ORDERING GUIDE · ROSSLYN"` — every store's rebuild stamped "ROSSLYN".
   - Banner now reads `MOG_LOCATION_NAME` (uppercased; neutral "ORDERING GUIDE" fallback). New `MOG_CONCEPT` property → `CONCEPT_THEMES` + memoized `dashTheme_()`; accent on banner + tiles + reset strip. RP = teal-dark `#2d8c6b`/white; TNY = charcoal `#1a1a1a`/gold `#D4A574` (mirror PWA themes). Unset → navy (graceful).
   - Set via extended `setupMobileApi()` (now 6 steps) **and** new standalone `setStoreConcept()` (Mobile API menu) for existing stores.
   - Canary rprfo (RP) + tnyt (TNY), both verified by Sebastian; fanned out all 9.

3. **#4 read-only audit tool** — `auditVendorTabStructure()` (Mobile API menu, all 9). Compares each vendor tab's load-bearing formulas (M spine, A-D/F spill, H mult, I/K order block, Q-T dead block) + N:P dead zone against the live VENDOR_TEMPLATE, or the first vendor tab if the template is gone (tab-vs-tab consistency). Pure read. **rprfo result: 5 tabs all consistent, but VENDOR_TEMPLATE MISSING.**

## #4 — scope + findings (next-session build)

Confirmed vendor-tab anatomy: **A–F** count grid (F = order math) · **H** multiplier (hidden) · **I–L** order block (**human-facing only** — recap email + daily log build server-side from A/B/E/F/M, never read I–L) · **M** spine (hidden, `SORT(FILTER(pick-DB))`) · **N–T = dead zone** (N–P empty; Q–T = unreferenced duplicate of A–D — order block reads `$A$3`/`$B$3`/`$F$3`, confirmed via I4/K4).

Locked: **keep** the order-block content (Sebastian copies it into emails / screenshots it) — only brand/polish it. Leave the A–F grid as-is.

Findings:
- **The uploaded xlsx is STALE vs live** — live uses unbounded ranges (`SETUP!$L$2:$L`); the xlsx is bounded (`…$L1000`) with `ARRAYFORMULA` wrappers stripped. **The live VENDOR_TEMPLATE is the source of truth, not the xlsx.**
- **VENDOR_TEMPLATE was deleted on rprfo.** Add-vendor doesn't *recreate* it — it *copies* it ([`OrderGuideScript.gs:887`](apps-script/OrderGuideScript.gs)), falling back to `ss.getSheets()[3]` (the 4th sheet) when missing — fragile. ⚠ **Do NOT Add Vendor on any template-missing store until hardened.**

**#4 deliverables (next session):** (A) re-establish a canonical hidden VENDOR_TEMPLATE per store from a healthy tab; (B) harden add-vendor to fail-safe when the template is missing; (C) dead-column strip (clear `Q3:T3`, hide `N:T`) + concept header branding, in template + all tabs; (D) `migrateVendorTabs()` — idempotent, defensive (per-tab structure check), On-Hand-safe. **Gate:** run the new audit on all 9 + a `mog-sheet-formula-verify` pass.

## Parked / answered (no code)

- **#2 assign-after-reset bug** — model fully confirmed (live spill keyed on M; On Hand E is position-pinned). Couldn't reproduce a hard failure on retest (likely recalc latency); parked "watch for recurrence." Real latent bug found regardless: `commitUpsertItem` **silently swallows** area-assignment failures (`catch` logs, returns `ok:true`) so the item just vanishes — small safe fix worth doing later (surface the error). Note: only the SETUP-col-B path is On-Hand-gated; the modal paths (`commitPickPathAreaAssignment`, `commitReorderPickPath`) write unconditionally.
- **PWA slower than the Sheet** — architectural, not a bug: `/exec` pays cold-start + HTTPS + redirect + re-auth + re-bind vs. warm in-Sheet `google.script.run`, plus the ~900ms animation floor. Levers: bootstrap/batch RPCs, more caching, trim the floor. No action taken.

## Outstanding (carry forward)

1. **Set concept + Rebuild Home Dashboard** on the 6 stores not yet done — RP: `rpr, rpt, rptfo, rpfr, rpfrf`; TNY: `tnytf` (rprfo + tnyt done). Rebuild preserves AE9 (no false-stale). At Sebastian's pace.
2. **Run `Audit Vendor Tab Structure`** on the other 8 stores → which lost VENDOR_TEMPLATE + any drift. Feeds the #4 migration.
3. **Build the #4 migration** (A–D above) — next-session main event. CANARY rprfo. `mog-sheet-formula-verify` gate.
4. **Commit this session's work** — 3 dirty files (below). Sebastian owns the commit.
5. Pre-existing: ManageVendors "Advanced" disclosure (still gated on cadence-audit cleanup); the silent-swallow fix; Recalibrate Vendor runs; parallelize `deploy.py`; reconcile the Rhino-ES5 invariant; retire `api_getHistory_`.

## Files touched this later session

**Apps Script source (deployed all 9, commits PENDING):**
- `apps-script/ManageVendors.html` — per-cell arrows + example callout + `rerenderVendorCards_` setLang fix.
- `apps-script/MOGApi.gs` — `PROP_CONCEPT`, `setupMobileApi` concept step, `setStoreConcept()`.
- `apps-script/OrderGuideScript.gs` — `CONCEPT_THEMES` + `dashTheme_()`, branded `buildHomeBanner_` / tiles / reset / vendor-CF, `auditVendorTabStructure()`, 2 menu items.

**Deployed to:** all 9 clasp targets. ManageVendors + audit = push only; branding = `--redeploy` (MOGApi.gs touched).

## Commits landed this later session

```
(none yet — all work deployed via clasp but uncommitted; Sebastian owns the commit decision)
```

## Opening prompt for next session

```
Resume MOG work. 2026-05-29 (later session) shipped two features to all 9
(deployed via clasp, COMMITS STILL PENDING — commit when ready):
  1. ManageVendors multiplier→delivery clarity — per-cell "→ <day>" arrows +
     worked-example callout in the Edit form + a setLang fix that re-renders
     vendor cards so EN/ES applies to card chrome.
  2. Dashboard per-store branding — buildHomeBanner_ reads MOG_LOCATION_NAME
     (was hardcoded ROSSLYN); new MOG_CONCEPT drives accent (Roll Play teal /
     Teas'n You charcoal+gold). Set via setStoreConcept() / setupMobileApi.

MAIN EVENT NEXT: build the #4 vendor-tab migration. Scope is locked:
  (A) re-establish a canonical hidden VENDOR_TEMPLATE per store (it was
      DELETED on rprfo — add-vendor copies it, doesn't recreate it, and
      falls back to ss.getSheets()[3] when missing → fragile);
  (B) harden add-vendor to fail-safe when the template is missing;
  (C) strip the dead zone (clear Q3:T3, hide N:T) + concept header branding,
      in the template + every vendor tab;
  (D) migrateVendorTabs() — idempotent, defensive (per-tab structure check),
      On-Hand-safe (never touches column E).
GATE before D: run "Mobile API → Audit Vendor Tab Structure" on all 9 (it's
deployed) to map which stores lost the template + any drift, then a
mog-sheet-formula-verify pass. The uploaded xlsx is STALE — trust the LIVE
VENDOR_TEMPLATE, not the file.

Order block (I–L) is human-facing only (recap/log build from A/B/E/F/M) — safe
to restyle; keep its content. A–F grid stays as-is. Q–T are an unreferenced
duplicate of A–D (order block reads A/B/F) — safe to strip.

Also carry: set concept + rebuild dashboard on the other 6 stores; the
commitUpsertItem silent-swallow fix (#2 carry); the #2 bug is parked
(watch for recurrence).

CANARY IS rprfo. Read docs/MOG_CurrentState.md for invariants. Deploy routing:
python .claude/skills/mog-deploy-workflow/scripts/route.py <file>.
```

A third commit will follow for the docs (this handoff + CurrentState + CLAUDE.md @-import update).

---

## Opening prompt for next session

```
Resume MOG work. 2026-05-29 shipped two things, both live on every store:

  1. Vendor Cadence Audit sidebar (commit 9b4c027). New entry at Ordering
     Guide -> Mobile API -> Audit Vendor Cadence. Read-only; per-vendor
     round-trip of stored mults through the picker. Flags ⚠ Mismatch
     (recalibrate before changing Edit UX) and ⓘ Every-day (confirm
     vendor really delivers daily). Sebastian to run this on all 9 stores
     at his pace and Recalibrate anything flagged.
  2. PWA decimal On Hand input (commit daf354f, CACHE_VERSION v12).
     inputmode="decimal" + step="any" + parseFloat in both handlers so
     KMs can enter .4, 1.5, etc. Server already coerces with Number().

Decisions locked from this session's walkthrough on ManageVendors Edit:
  - Gate 1 = hide raw mults grid behind "Advanced" disclosure (deferred).
  - Gate 2 = NO lead-day picker (operational convention: always 1-day lead).
  - Gate 3 = NO schema migration (defer; Recalibrate Vendor + future
    picker-as-truth saves erode stale mults naturally).

Top next direction (when ready): the ManageVendors Edit-form disclosure
work — but ONLY after Sebastian has worked through the audit findings
across all 9 stores. Until then, the silent-rewrite-on-save risk is real
and the change should not ship.

Other carry-forwards (still deferred): Migrate Item Vendors per sheet,
parallelize deploy.py, reconcile the Rhino-ES5 invariant in CLAUDE.md,
retire api_getHistory_ if the recap caller migrates.

CANARY IS rprfo (route.py still prints rpr — override).
Read docs/MOG_CurrentState.md for invariants. Deploy routing source of
truth: python .claude/skills/mog-deploy-workflow/scripts/route.py <file>.
```
