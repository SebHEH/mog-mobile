# Session Handoff — Modal design-system unification (shared Styles + sizing tiers)

**Session date:** 2026-06-04
**Session focus:** A modal cohesion sweep — unify the look across all 9 Apps Script modals, dedupe repeated CSS, and check the print/output generators.
**Outcome:** Built a shared `Styles.html` design-token + chrome partial included by all 9 modals; tokenized every brand/semantic color; introduced a two-tier modal sizing system; fixed the `[?]` help-button alignment/visibility regressions; bumped Order History readability. **Deployed to the rprfo canary only (push-only); NOT yet fanned out to the other 8 + master — awaiting Sebastian's live smoke-test.**
**Next session focus:** Smoke-test rprfo → fan out to all 9 + master; then Phase 2 (recap-email rebrand, needs `--redeploy`).

---

## What shipped (all to rprfo canary, push-only — fan-out PENDING)

Decision that framed the whole session: Sebastian chose **shared `Styles.html` include** (single source of truth) over per-file token blocks or loud-fixes-only.

### A. Shared design layer (`appsscript-ui-consistency-audit` findings A1–A6)
- **NEW `apps-script/Styles.html`** — the single source of truth: a `:root` token block (surfaces, brand, semantic, shape, type) + the universal chrome that was copy-pasted in every modal (`*` reset, `.lang-group`/`.lang-btn`, the entire `[?]` `.help-*` overlay). ~200 lines of duplicated CSS removed across the set.
- **`include()` helper** added to `OrderGuideScript.gs` (`HtmlService.createHtmlOutputFromFile(name).getContent()`). The 3 flat modals (HowToUse, AdminReset, OrderHistory) were converted from `createHtmlOutputFromFile` → `createTemplateFromFile().evaluate()` so all 9 can pull `<?!= include('Styles'); ?>`. *Confirmed all 3 had zero pre-existing scriptlets, so the conversion is safe.*
- **All 9 modals** now `<?!= include('Styles'); ?>` after `<base>`, with their duplicated chrome removed and brand/semantic hexes rewired to `var(--*)`. Done with a one-shot deterministic script (since deleted) operating only inside `<style>` blocks; AdminReset's `#7a1a1a` was excluded and hand-fixed.
- **Canonical palette** (edit in `Styles.html` only): `--brand #1a1a2e` (navy, modal header **everywhere**), `--brand-green #1a3a2e` (interior/section headers), `--accent #7eb8a4`, `--success #1a6b2e`, `--danger #c0392b`, `--warn #f0a500`; `--r-control 6px`/`--r-card 8px`; `--fs-label 10px`/`--fs-body 12px`.
- **AdminReset red→navy/danger split** (VERIFY-1 + VERIFY-2, both approved): the dark-red `#7a1a1a` was doing double duty. Header chrome (border + title) → `var(--brand)` (navy, uniform with every other modal); destructive affordances (reset button, danger badge, warning banner, confirm checkbox/focus, selection summary) → `var(--danger)`.
- **Print generator P2 (auto):** OrderHistory's `@media print` summary header tokenized to `var(--brand-green)` by the same pass.
- **Neutral greys intentionally left raw** (`#333/#888/#ccc/#ddd…`) — they're neutral chrome, not brand identity; tokenizing the full grey ramp is high-churn/low-cohesion-gain. Noted as optional follow-up.

### B. Help-button regressions + sizing + readability (Sebastian's live feedback)
- **`[?]` off-center on ManageItems + OrderHistory** — their `.top-bar` uses `align-items: stretch`, so the shared lang-group filled the bar height and pinned the 22px round button to the top. Fixed once in the shared partial: `.lang-group { align-items: center }`.
- **`[?]` "missing" on ReorderPickPath** — actually present but invisible: `.lang-bar` set a navy background with no text `color`, so the `currentColor` button rendered dark-on-navy. Fixed: `color:#fff` on `.lang-bar`.
- **Two-tier modal sizing** — new `MODAL_SM_W/H` (720×680) and `MODAL_LG_W/H` (1400×900) constants in `OrderGuideScript.gs`; every `showModalDialog` retrofitted to a tier. **SMALL:** ManageVendors (up from 620×600 — Sebastian's "slightly bigger, set as the small standard"), StorageAreas, AdminReset, ReorderPickPath, RecalibrateVendor, VendorCadenceAudit. **LARGE:** ManageItems, OrderHistory (now matches Items per request), HowToUse.
- **Order History readability** — it ran one tier below ManageItems (13px base / 12px tables vs 14/13). Bumped `html,body`→14 and `table`→13 (on-screen tables are auto-layout, so they reflow — no column wrapping). Card titles were already 14px; 10–11px micro-labels left as-is.

---

## Outstanding (carry forward)

1. **CANARY GATE OPEN — smoke-test rprfo, then fan out.** Open the rprfo Sheet → Ordering Guide menu and check: every modal opens + renders (a missing color would render black/transparent = a token didn't resolve); `[?]` centered on Items/History and **visible** on Pick Path; small modals all same 720×680, large all 1400×900; Order History text reads like Manage Items. **Then `python deploy.py` (push-only, no `--redeploy`) to fan out to all 9 + master.**
2. **Two sizing judgment calls to confirm** (trivial to nudge — they're two constant pairs): is 720×680 small / 1400×900 large right, and should **HowToUse** stay in the large tier or get its own size? If small modals (e.g. Admin Reset, a short checklist) feel empty at 720 wide, narrow the SMALL tier.
3. **Phase 2 — recap-email rebrand** (`MOGApi.gs:~1315`, `buildRecapSections_`): align the email's separate warm palette to the brand + add a store/date header band. **Needs `--redeploy`** (MOGApi.gs) and **cannot use CSS vars** (email clients strip `:root`/`var()`) — values stay literal but matched to the tokens. Separate deploy from the modal sweep.
4. **Optional grey tokenization** — finish the neutral-grey ramp into tokens if fully-tokenized source is wanted.
5. Carried from before: per-concept hub brand SVGs; Batch D (brand fonts / concept-aware modal theming — now much easier since the token layer exists: swap `:root` per concept); reconcile global `rhino-safe-html` cross-repo; ManageVendors "Advanced" disclosure (gated on Vendor Cadence Audit run).

---

## Files touched this chat

**Apps Script source (deployed to rprfo canary only, push-only):**
- **NEW** `apps-script/Styles.html` — shared `:root` tokens + reset + lang toggle + `[?]` help overlay.
- `apps-script/OrderGuideScript.gs` — `include()` helper; `MODAL_SM/LG` constants; 3 flat modals → template+evaluate; all 9 `showModalDialog` calls retrofitted to size tiers.
- `apps-script/AdminReset.html` — red `#7a1a1a` split: header→`--brand`, danger affordances→`--danger`.
- `apps-script/OrderHistory.html` — tokenized; readability bump (base 14, table 13); print header token.
- `apps-script/ReorderPickPath.html` — `.lang-bar { color:#fff }` (fix invisible `[?]`).
- `apps-script/ManageItems.html`, `ManageVendors.html`, `StorageAreas.html`, `RecalibrateVendor.html`, `VendorCadenceAudit.html`, `HowToUse.html` — include line + chrome removed + hexes tokenized.

**Docs:** `docs/MOG_SessionHandoff_2026_06_04.md` (new), `CLAUDE.md` (@-import bump), `docs/MOG_CurrentState.md` (Pinned focus + Recent-changes row).

## Verification done this session
- Static: scanner shows zero raw brand/semantic hexes remaining; 1 `include` per modal; 6 `[?]` help buttons intact; all `<style>` braces balanced; EN/ES parity **PASS 9/9** (Styles.html correctly skipped); all serving calls use the size constants.
- **NOT yet done: live render smoke-test on rprfo** (the open gate above).

## Commits landed this session

```
(committed at session close — this handoff rides in the same commit as the code)
```

## Opening prompt for next session

```
Resume MOG work. 2026-06-04 shipped a modal design-system unification —
deployed to the rprfo CANARY ONLY (push-only), NOT yet fanned out:
  - NEW apps-script/Styles.html: shared :root design tokens + universal
    chrome (reset, lang toggle, [?] help overlay), pulled into all 9 modals
    via <?!= include('Styles'); ?>. include() helper added; the 3 flat
    modals (HowToUse, AdminReset, OrderHistory) converted to templates.
    All brand/semantic colors tokenized; AdminReset red header -> navy,
    its destructive affordances -> --danger.
  - Two-tier modal sizing constants (MODAL_SM 720x680 / MODAL_LG 1400x900)
    in OrderGuideScript.gs; every modal retrofitted. Order History now
    matches Manage Items (large) + got a readability bump (base 14/table 13).
  - Fixed [?] off-center (Items/History) via .lang-group align-items:center
    in Styles, and [?] invisible on Pick Path via .lang-bar color:#fff.

OPEN GATE: smoke-test rprfo (every modal opens/renders, [?] centered +
visible, sizes consistent), THEN python deploy.py (push-only) to fan out to
all 9 + master. Confirm the two size judgment calls (720x680 / 1400x900,
and HowToUse tier). After fan-out: Phase 2 = recap-email rebrand
(MOGApi.gs buildRecapSections_, needs --redeploy, email can't use CSS vars).

CANARY IS rprfo. Read docs/MOG_CurrentState.md for invariants. Deploy
routing: python .claude/skills/mog-deploy-workflow/scripts/route.py <file>.
```

---

# Later session — Modal sweep fan-out + recap-email rebrand (Phase 2)

**Session focus:** Close the modal design-system canary gate (fan out to all 9), then do Phase 2 — rebrand the daily recap email to the brand.
**Outcome:** Modal sweep fanned out to all 9 + master (push-only). Recap email fully redesigned + per-concept themed and fanned out to all 9 + master (`--redeploy`). Sebastian smoke-tested the recap on rprfo via a new editor-only `test_recapEmailToSelf` helper and approved the final look.
**Next session focus:** Optional — per-concept hub brand SVGs, or Batch D (brand fonts / concept-aware modal theming, now easy via the token layer).

## What shipped

### A. Modal design-system unification — FANNED OUT
- After Sebastian confirmed the rprfo canary, ran `python deploy.py` (push-only, no `--redeploy` — bound-sidebar modal + `.gs` changes) to all 9 + master. All targets `PUSH OK`, 13 files each incl. the new `Styles.html`. The 2026-06-04 modal sweep (shared `Styles.html` tokens, two-tier sizing, `[?]` fixes) is now live everywhere. **The open gate from the earlier block is CLOSED.**

### B. Recap-email rebrand (Phase 2) — `MOGApi.gs` `sendRecapEmail_`, FANNED OUT via `--redeploy`
The daily recap email (built in `sendRecapEmail_`, sent per-recipient by `api_emailRecap_` and as a reset side-effect via `sendRecapIfUnsent_`) was on an old "warm" palette unrelated to the brand. Redesigned the HTML body (plain-text body lightly aligned too):
- **Per-concept header band** — themed via the existing `dashTheme_()` (reads `MOG_CONCEPT`; same palette as the Sheet dashboard, so email + dashboard stay coordinated): roll-play → teal-dark `#2d8c6b` + white, teasnyou → charcoal `#1a1a1a` + gold `#D4A574`, unset/unknown → navy `#1a1a2e` + white. `dashTheme_()` lives in `OrderGuideScript.gs` but is callable from `MOGApi.gs` (shared global scope); guarded with a `typeof` fallback. Band layout (Sebastian's final call): **location name bold on top**, "Suggested daily order" semi-bold below it, then `date · N vendors · M items` faint meta.
- **Careful "suggested" wording** — band title implies suggestion; new caption "Suggested order amounts based on today's On Hand counts. Review each before placing…"; table column header `Qty` → **"Suggested order."**
- **Each line reads left-to-right as a sentence** — `Item Name × 3 (Pack)`: name in body ink, the **× qty bold in the concept accent** (the action number pops), pack muted in parens. Replaces the old 4-column Qty/Item/Pack/On-hand grid.
- **On Hand isolated + de-emphasized** — its own right-hand column, right-aligned, smaller (12px) + faint grey `#aab0b6`, faint "On hand" header. Clearly secondary to the suggested amount.
- **Email-safe**: all colors literal hexes (email strips `:root`/`var()`); header band is a single-cell `<table>` (Gmail/iOS render table-cell bg reliably).

### C. `test_recapEmailToSelf()` — NEW editor-only helper in `MOGApi.gs`
Sends the current cycle's recap **only to whoever runs it** (`Session.getActiveUser().getEmail()`), bypassing the recipient list, the once-per-day dedupe flag, and the On-Hand clear. NOT menu-wired (KMs never see it). Throws a clear message if there's nothing to recap. This is the test path for the email design — Sebastian ran it on rprfo to approve the look.

### No-reauthorization guarantee
Verified against `apps-script/appsscript.json`: `userinfo.email`, `script.send_mail`, `spreadsheets` (+ scriptapp/container.ui/external_request) are **all already declared**. The recap rebrand + per-concept theming + the test helper use only `MailApp`, `PropertiesService`, and `Session.getActiveUser()` — **zero new OAuth scopes**, so the fan-out's `--redeploy` does not re-prompt anyone to authorize. **Do not add scopes to `appsscript.json`** (it's unified across all 9; a scope change = forced reauth for every menu user).

## Outstanding (carry forward)
1. **Recap literal-hex sync caveat** — the email can't read CSS vars, so its colors are literal. The brand colors flow from `dashTheme_()`/`CONCEPT_THEMES` (in `OrderGuideScript.gs`); the email's neutral greys are inline literals. If the concept palette ever changes, the email picks it up automatically via `dashTheme_()`; only the neutral chrome would need a manual touch.
2. **Two modal-sizing judgment calls** still nudgeable (720×680 / 1400×900, HowToUse tier) — now live on all 9, easy to change later (two constant pairs in `OrderGuideScript.gs`).
3. Carried from before: per-concept hub brand SVGs; Batch D (brand fonts / concept-aware modal theming — easier now that the token layer exists); reconcile global `rhino-safe-html` cross-repo; ManageVendors "Advanced" disclosure (gated on Vendor Cadence Audit run); `OrderGuideScript.gs` 7-file split + new-day-detection consolidation.

## Opening prompt for next session

```
Resume MOG work. 2026-06-04 (later session) shipped:
  - Modal design-system unification FANNED OUT to all 9 + master (push-only).
    The earlier canary gate is closed.
  - Recap-email rebrand (Phase 2), MOGApi.gs sendRecapEmail_, FANNED OUT to
    all 9 + master (--redeploy): per-concept header band via dashTheme_()
    (RP teal / TNY charcoal+gold / unset navy), location bold on top +
    "Suggested daily order" below, "suggested"-framed wording, each line
    reads "Item x qty (pack)" with the qty bold in the concept accent, and
    On Hand isolated in a faint right column. New editor-only helper
    test_recapEmailToSelf() sends a preview to whoever runs it (bypasses the
    recipient list) — that's the email test path.
  - NO new OAuth scopes were added; nobody needs to reauthorize.

Everything is committed, pushed, and deployed. Optional next: per-concept hub
brand SVGs, Batch D (brand fonts / concept-aware modal theming — easy now via
the :root token layer), or the OrderGuideScript.gs 7-file split.

CANARY IS rprfo. Read docs/MOG_CurrentState.md for invariants. Deploy routing:
python .claude/skills/mog-deploy-workflow/scripts/route.py <file>.
```
