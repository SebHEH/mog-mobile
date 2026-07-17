# Session Handoff — MOG Logic Blueprint (owner-verified) + questionnaire

**Session date:** 2026-07-17
**Session focus:** Run `project-logic-blueprint` for MOG in anticipation of an eventual consolidation into a company operations website: draft the blueprint, produce an owner questionnaire to verify the whys, fold the answers in, and render a presentable HTML.
**Outcome:** Shipped `docs/MOG_LogicBlueprint.md` (owner-verified, Layers 1 to 3) + its rendered `docs/MOG_LogicBlueprint.html` + the completed `docs/MOG_Blueprint_Questionnaire.md`. All whys confirmed by Sebastian via the questionnaire; no ASSUMED flags remain. Also tweaked `mog-session-handoff` to bump the blueprint when MOG logic changes. Docs-only session, nothing deployed.
**Next session focus:** Back to the MOG backlog (the #17+ audit trail, MOGApi split, backup backfill), unless Sebastian wants the HEH-branded blueprint HTML.

---

## What shipped

- **`docs/MOG_LogicBlueprint.md` (new, canonical).** A three-layer, stack-agnostic description of MOG's behavior and rules, built to hand to any future builder (the anticipated consolidation into one HEH operations app). Layer 1 pitch, Layer 2 glossary + core flows + Mermaid connection map + **23 enumerated rules (R0 to R22)**, Layer 3 rebuild spec (data model, flow contracts with pseudocode for the order math, edge-cases-and-why, integration contracts, config table, growth seams, platform notes). Core math grounded in the actual source (`computeSuggestedQty_`, `vendorDayMultiplier_`, `readMasterItemMeta_`), not just the handoff prose. Stamped `current_as_of: 7806512 (2026-07-17)`.
- **`docs/MOG_Blueprint_Questionnaire.md` (new).** The `Guess:` / `▶` questionnaire (same format as the StoreReports one Sebastian referenced), completed by Sebastian. Kept in-repo as the source of the whys.
- **`docs/MOG_LogicBlueprint.html` (new, generated).** Rendered from the markdown via the bundled `project-logic-blueprint/scripts/render_blueprint_html.py` (neutral deterministic style, Mermaid draws live online). Regenerate any time from the markdown; do NOT hand-edit.
- **`.claude/skills/mog-session-handoff/SKILL.md` — new section "If the session changed MOG *logic*, bump the blueprint too."** Adds a conditional fourth close-out step: when a session changes a business rule / core flow / integration / business-decision constant, edit the blueprint + bump its stamp + regenerate the HTML in the same commit; explicitly excludes plumbing / deploy / UI / i18n / bug fixes, with the "would a rebuild on another stack behave differently?" test.

### Key content decisions baked into the blueprint (so they're not re-litigated)

- **R0: MOG does not place orders.** It is a guided inventory *count* that produces a *suggested order*; the recap email is the handoff people use to place the actual orders on vendor sites. (Corrected a wrong framing in the first draft.)
- **R6/R22: one shared par per item; the item list should be standardized per concept, with par (from each store's sales + product mix), vendor cadence, and vendor selection (regional availability) varying per store.** R22 is marked as intent, not current behavior (catalogs are hand-built today).
- **R21: par is a ~1-day par with a deliberate buffer** (order cutoff times, busy-day/catering spikes, vendor stock-outs), behaving like 1.5 to 2 days. A rebuild must not cut par to a literal single day.
- **R20: use-multiplier-off is for slow bulk items and set-size batch recipes** (avoid over-ordering), not "weekly-billed."
- **Biggest current constraint, elevated to the top growth seam:** manual new-store onboarding (create the Sheet, hook it up, hand-enter every vendor and item). **MarginEdge is reframed as a catalog-seeding source first** (populate the item list, not just cost); the existing Import Vendor feature is the partial step toward this.
- **Recap retry (Q-INT-1):** desired change — retry on send failure but still cap at once per cycle; today it is once-and-done. Logged in the blueprint as a forward item; a candidate for the real MOG code.

## Outstanding (carry forward)

- **HEH-branded blueprint HTML — offered, deferred.** Sebastian chose the neutral render for now (H3 confirmed he wants branded eventually). The branded version is a separate hand-styled pass (`heh-brand-kit` + `document-design-system`) that will NOT auto-regenerate from the markdown; the doc header says so. Pick this up when he's ready to share it widely.
- **Recap retry-on-failure (Q-INT-1)** — a genuine small backend backlog item surfaced by the blueprint (bounded retry, still once-per-cycle). Not a doc task; belongs in the MOG code backlog.
- **Blueprint upkeep** — now a rule (see the skill tweak): bump `docs/MOG_LogicBlueprint.md` + regenerate the HTML whenever a future session changes MOG logic.
- **Pre-existing MOG backlog is untouched this session** — run the Health Check "Vendor tab headers" fix per store; #24 MOGApi.gs split (`Recap.gs` + `Admin.gs`); the backup-vendor backfill (only rpr done); web-editor slowness profile; the audit continues at #17. See `docs/MOG_CurrentState.md`.

## Files touched this chat

- **New docs:** `docs/MOG_LogicBlueprint.md`, `docs/MOG_LogicBlueprint.html` (generated), `docs/MOG_Blueprint_Questionnaire.md`.
- **Skill edit:** `.claude/skills/mog-session-handoff/SKILL.md`.
- **Handoff docs (this close-out):** `docs/MOG_SessionHandoff_2026_07_17.md` (new), `CLAUDE.md` (@-import bump), `docs/MOG_CurrentState.md` (Pinned focus + Recent-changes row).
- **No code, no deploy, no build.py/deploy.py, no CACHE bump.**

## Commits landed this session

```
(none yet — all work is uncommitted; this handoff rides in the session's single commit)
```

## Opening prompt for next session

```
Read docs/MOG_CurrentState.md first. Last session (2026-07-17) was docs-only: ran
project-logic-blueprint for MOG and shipped docs/MOG_LogicBlueprint.md (owner-verified,
Layers 1 to 3, 23 rules R0 to R22) + its rendered .html + the completed
docs/MOG_Blueprint_Questionnaire.md. Key framing captured: MOG produces a suggested
order and does NOT place orders (recap email is the handoff); par is a buffered ~1.5-2
day par (R21); item list should be standardized per concept with par/cadence/vendors
varying per store (R22); biggest constraint is manual new-store onboarding, with
MarginEdge reframed as a catalog-seeding source. mog-session-handoff now says to bump
the blueprint whenever MOG logic changes.

Candidate directions: (a) HEH-branded blueprint HTML (deferred this session — separate
hand-styled pass, won't auto-regenerate); (b) recap retry-on-failure (Q-INT-1, a small
backend item the blueprint surfaced); (c) the standing backlog — Health Check "Vendor
tab headers" per store, #24 MOGApi split, backup backfill, audit from #17. Canary rprfo;
the web app (/exec) is the PRIMARY surface -> ALWAYS deploy.py --redeploy for backend.
```
