# Session Handoff — Visual consistency sweep (Batches A + B + Manage Items) + basil brand fix

**Session date:** 2026-05-31
**Session focus:** Full read-only audit of MOG's visuals across Hub + PWA + Modals against three yardsticks (internal cross-surface consistency, Canva brand-kit alignment, UI polish), then ship the safe fixes with decision gates.
**Outcome:** Three commits shipped + deployed (`41f2e8b`, `3b48218`, `7210e0d`). PWA brand colors now actually re-theme per concept; modal chrome unified; Manage Items legend + Par Review column cleaned up. Plus the RP brand primary was corrected to **basil green `#53D3A5`** in the brand-kit skill (orange demoted to accent).
**Next session focus:** Optional strategic work only — per-concept hub theming (hub is still HEH-red for every concept) and/or "Batch D" (brand fonts, brand SVG concept marks, concept-aware modal theming). Nothing is in a broken or half-finished state.

---

## Section A — The visuals audit (read-only, the spine of the session)

Fanned out 3 parallel readers (Hub, PWA, Modals) against three dimensions. Key structural finding, recorded so we don't re-derive it:

**Four surfaces, three theming philosophies.** Hub brands by the HEH master (red wordmark, *no* per-concept theme); PWA + Dashboard brand *per concept*; the 9 Apps Script modals are a fixed navy/green that ignores concept entirely. And none of the four used either concept's actual brand-kit primary — which turned out to be the brand-kit doc being wrong, not the app (see Section D).

The audit was triaged into batches: **A** = PWA token re-theming (brand-neutral, safe), **B** = cross-surface quick wins, **C** = the brand decision (basil), **D** = strategic (fonts, SVG marks, concept-aware modals). A and B and part of C shipped; D deferred.

**One subagent false-positive caught by verification:** the Hub audit claimed the "Teas'n You" concept-icon lookup was broken by a straight-vs-curly apostrophe mismatch. Verified the actual bytes: both `stores.json` and the `CONCEPT_VISUALS` key use straight `U+0027`, so the lookup **works**. The real (low-sev) note is only that the displayed name uses a straight apostrophe vs the brand-standard curly `U+2019` — and the two are *coupled* (change one, must change both or the icon falls back). Not fixed this session.

## Section B — Batch A: PWA colors re-theme per concept (`41f2e8b`)

Several teal-tinted borders/toasts were hardcoded to the **default HEH teal**, so they stayed green on Roll Play (basil) and Teas'n You (gold) instead of following the theme.

- **New token `--teal-border`** in `template/index.html` `:root` (default `rgba(15,110,86,0.30)` ≈ the old `#b8dccd`, no visual change on default) and overridden per concept theme (`roll-play` `rgba(45,140,107,0.35)`, `teasnyou` `rgba(161,122,77,0.35)`, `leid` `rgba(181,21,121,0.30)`).
- **7 hardcoded literals → tokens:** `.toast.success #0e554a` → `var(--teal-dark)`; `.pill-done` + `.manager-banner` (×2) teal `rgba()` borders → `var(--teal-border)`; `.alldone-panel` / `.recipient-add-form` / `.vendor-card.status-reviewed` / `.recipient-toggle.on` `#b8dccd` → `var(--teal-border)`; `.recipient-toggle.on` `#d8efe1`/`#1a6b2e` → `var(--teal-light)`/`var(--teal-dark)`.
- **Cleanup:** merged the duplicate `body` block (token-based, no visual change).
- **Principle locked (the design decision behind the scope):** *primary/brand color re-themes per concept; semantic warning colors (red/amber) stay constant.* That's why the red/amber status tints were deliberately left hardcoded.
- **Mechanism:** `template/sw.js` `CACHE_VERSION` v12→**v13**; `python build.py` (all 8 dirs); `git push` (GitHub Pages). Sebastian canaried v13 on rprfo (basil borders/toasts confirmed).

## Section C — Batch B: cross-surface quick wins (`3b48218`)

- **`HowToUse.html`** — header green `#1a3a2e` → navy `#1a1a2e` (was the lone green header among 8 modals); page bg → `#f4f5f7`.
- **`ReorderPickPath.html`** — picker-close glyph `×` (U+00D7) → `✕` (U+2715) to match the app convention; page bg → `#f4f5f7`.
- **`AdminReset.html`, `ManageVendors.html`** — page bg `#f9f9f9` → `#f4f5f7` (unified all 9 modal page bodies to one grey; footer/component `#f9f9f9` uses intentionally left).
- **`index.html` (hub)** — `<meta name="theme-color">` teal `#0F6E56` → red `#fc0404` to match the manifest (installed-PWA chrome already matched); hub `sw.js` CACHE v5→**v6**.
- **Deliberately NOT changed:** ManageItems' navy base `.btn-primary` — it's documented-intentional (`:295-299`: navy = navigational, green = commit). Sebastian confirmed: leave it.
- **Mechanism:** modals deployed via `python deploy.py` (canary rprfo → all 9 + master, **push only, no `--redeploy`**); hub via `git push`. No i18n keys touched.

## Section D — Manage Items polish + basil brand-kit fix (`7210e0d` + skill edit)

**Manage Items (`ManageItems.html`, deployed all 9):**
- **Legend enlarged** to fill the dead space: `.table-legend` font 11→13px, swatches 10→13px, more padding + gap; emoji spans 11→14px.
- **Par Review column cleaned up** (`buildFlagPill`): reviewed-OK (≥5 orders, no flag) → solid gray **"✓ No change"** pill (`.pill-no`); `<5 orders` or no history → softer gray **"No data yet"** pill (new `.pill-nodata`); inactive → still `—`; real flags → still amber/red ⚠ pills. New `flagOk` i18n key (EN "No change" / ES "Sin cambio") — **parity verified 103/103**.
- **States kept distinct on purpose:** "no change" (reviewed) and "no data yet" (insufficient history) read differently but both stay calm-gray so only warnings pop. Did NOT fill every active cell with "No change" (would imply pars were reviewed when there's no history).

**Basil brand correction (outside the repo — `~/.claude/skills/heh-brand-kit/`):**
- Sebastian confirmed **Roll Play's primary brand color is basil green `#53D3A5`** (the RP theme's current `--teal`), with `#2d8c6b` as the darker shade — *not* the orange `#F73F06` the brand-kit markdown had inferred as primary.
- `references/per-brand/rp-design-tokens.md` updated: basil `#53D3A5` = PRIMARY, orange demoted to accent; `last_updated` bumped. Memory `rollplay_primary_is_basil.md` updated with the confirmed hex.
- **The PWA already used `#53D3A5` for RP**, so the app and the brand doc now agree — nothing to change in code.

---

## Outstanding (carry forward)

1. **Per-concept hub theming** (optional). The hub (`index.html`) is still HEH-red for every concept — no RP-basil / TNY-gold tiles. `CONCEPT_VISUALS` + `conceptIconHtml_` are already wired to accept per-concept brand SVGs (currently generic Tabler icons). Would be a hub `git push` + cache bump.
2. **Batch D** (strategic, deferred): brand fonts (Brother 1816 / Avenir for RP, Campaign Serif / Filson Pro for TNY — currently Archivo Black + Inter in PWA, Arial in modals); brand SVG concept marks on the hub; concept-aware modal theming (modals are fixed navy/green across all 9).
3. **Teas'n You apostrophe** (low): displayed concept name uses straight `U+0027` vs brand-standard curly `U+2019`. Coupled — `stores.json` registry string and the `CONCEPT_VISUALS` key must change together or the icon lookup falls back.
4. **`audit_modals.py` blind spots** (housekeeping): only checks 3 substrings on 5 modals; misses color/font/glyph drift and omits `RecalibrateVendor.html` (which exists) + the 3 read-only modals. Consider widening its coverage.
5. **Pre-existing carries** (still open): ManageVendors "Advanced" disclosure (gated on cadence-audit cleanup). *(Resolved 2026-05-31 housekeeping batch: `commitUpsertItem` silent-swallow fix, retired `api_getHistory_`, reconciled the Rhino-ES5 invariant. Parallelize `deploy.py` was dropped — not a backlog item; see `MOG_CurrentState.md` architecture notes.)*

**Canary reminder:** canary is **rprfo** (route.py still prints rpr — override). Any future modal change: `python deploy.py --target rprfo`, smoke-test in the Sheet, then `python deploy.py`.

---

## Files touched this chat

**PWA source (Batch A — `git push`, GitHub Pages):**
- `template/index.html` — `--teal-border` token + 4 theme scopes; 7 hardcoded-teal → token; merged duplicate `body`.
- `template/sw.js` — CACHE v12→v13.
- 8 generated `<slug>/` dirs refreshed via `python build.py`.

**Apps Script source (Batch B + Manage Items — `python deploy.py`, all 9 + master, push only):**
- `apps-script/HowToUse.html` — header navy + page bg.
- `apps-script/ReorderPickPath.html` — `×`→`✕` + page bg.
- `apps-script/AdminReset.html`, `apps-script/ManageVendors.html` — page bg.
- `apps-script/ManageItems.html` — legend sizing; `.pill-nodata`; `buildFlagPill` rewrite; `flagOk` EN/ES.

**Hub source (Batch B — `git push`):**
- `index.html` — meta theme-color → red.
- `sw.js` — hub CACHE v5→v6.

**Outside the repo (brand kit + memory):**
- `~/.claude/skills/heh-brand-kit/references/per-brand/rp-design-tokens.md` — basil primary.
- memory `rollplay_primary_is_basil.md` + `MEMORY.md` index.

**Docs:**
- `docs/MOG_SessionHandoff_2026_05_31.md` (this file); `docs/MOG_CurrentState.md`; `CLAUDE.md` @-import.

## Commits landed this session

```
7210e0d feat(manage-items): enlarge table legend; gray 'No change'/'No data yet' pills in Par Review column
3b48218 fix(modals+hub): unify HowToUse header, modal page bg, picker glyph; hub theme-color to red (hub CACHE v6)
41f2e8b fix(pwa): re-theme teal-tinted borders/toasts via --teal-border token (CACHE v13)
```
(A 4th docs commit for this handoff will follow.)

## Opening prompt for next session

```
Resume MOG work. 2026-05-31 ran a full visual-consistency sweep across
Hub + PWA + Modals and shipped three commits, all live + deployed:
  - Batch A (41f2e8b): PWA teal-tinted borders/toasts now re-theme per
    concept via a new --teal-border token (CACHE v13). Principle locked:
    primary/brand color re-themes; red/amber warnings stay constant.
  - Batch B (3b48218): HowToUse header → navy, modal page bg unified to
    #f4f5f7, ReorderPickPath picker glyph ×→✕, hub meta theme-color → red
    (hub CACHE v6). ManageItems navy base button LEFT navy (intentional).
  - Manage Items (7210e0d): bigger table legend; Par Review column now
    shows gray "✓ No change" / "No data yet" pills instead of bare dashes.
  - Brand fix (outside repo): Roll Play primary is BASIL GREEN #53D3A5
    (not orange) — rp-design-tokens.md corrected, orange demoted to accent.
    PWA already used #53D3A5 so app + brand doc now agree.

Nothing is broken or half-finished. Optional next directions:
  1. Per-concept HUB theming — hub is still HEH-red for every concept;
     CONCEPT_VISUALS/conceptIconHtml_ already accept per-concept brand SVGs.
  2. Batch D (strategic): brand fonts, brand SVG concept marks, concept-
     aware modal theming (modals are fixed navy/green across all 9).
  3. Housekeeping: widen audit_modals.py coverage; TNY straight-vs-curly
     apostrophe (coupled — change stores.json + CONCEPT_VISUALS together).

CANARY IS rprfo. Read docs/MOG_CurrentState.md for invariants. Deploy
routing: python .claude/skills/mog-deploy-workflow/scripts/route.py <file>.
```

---

# Later session — Hub 3-level nav + per-concept tile theming

**Session focus:** Took two of the three "optional next directions" above and one new ask: give the hub a 3-level picker (Concept → **Site** → BOH/FOH area), theme the concept tiles per concept, and the housekeeping pair (widen `audit_modals.py`, TNY curly apostrophe).
**Outcome:** Hub-only + tooling change, all verified in a live local preview. Concept → Site → Area navigation with auto-collapse, basil/gold per-concept theming carried into the sub-screens, curly TNY apostrophe synced across 3 files, and `audit_modals.py` rebuilt to auto-discover (now covers `RecalibrateVendor.html`). **No store rebuild / no clasp deploy** — the 8 generated dirs came out byte-identical. Hub `sw.js` CACHE **v6→v7**.
**Next session focus:** Optional — Batch D (brand fonts / SVG concept marks / concept-aware modal theming), or wire real per-concept brand SVGs into `CONCEPT_VISUALS` (currently generic Tabler icons + tints).

## What shipped (later session)

- **3-level hub navigation** (`index.html`). Was Concept → flat location list. Now Concept → **Site** (Rosslyn/Tysons/Founders) → **Area** (BOH/FOH). Site/area are **derived from the `location` string** (Option A — `parseLocation_` splits the trailing all-caps token; no `stores.json` schema change, no `build.py` change, no `mog-add-store` ripple). New `screen-area`, `buildSiteGroups_`, `onSiteTap_`; 3-level back-nav with `areaBackTarget`; manager banner added to the area screen (`refreshMgrBanners_`). **Collapse rules:** a single-site concept (Teas'n You) skips the site screen straight to its area picker (back → concept); a single-area site skips the area screen straight to the store. Why Option A: the `"<Site> BOH/FOH"` naming is 100% regular and `location` is already the downstream display string — explicit `site`/`area` fields would duplicate it and invite drift.
- **Per-concept tile theming** (`index.html`). `CONCEPT_VISUALS` gained `tint`/`tintDark`/`tintLight` (RP basil `#53D3A5`/`#2d8c6b`/`#e4f7f0`, TNY gold `#D4A574`/`#8a6d3b`/`#f7efe2`). Concept-card chips are tinted inline per-card; the tapped concept's tint is pushed onto `#app` as `--concept-dark`/`--concept-light` (`setActiveConceptTheme_`) so the site/area chips + back button inherit it, cleared back to HEH-red when returning to the picker. Principle held from Batch A: brand re-themes, the HEH-red master/manager chrome stays constant.
- **TNY curly apostrophe** — `Teas'n You` → `Teas’n You` (U+2019), synced across the **3 coupled spots** so the theme/icon lookup can't fall back: `stores.json` concept, hub `CONCEPT_VISUALS` key, `build.py` `CONCEPT_TO_THEME` key. Verified post-build: registry has curly, `tnyt`/`tnytf` still resolve to `data-theme="teasnyou"`.
- **`audit_modals.py` widened** (`.claude/skills/mog-modal-ux-sweep/scripts/`). Replaced the stale hardcoded 5-modal list with **auto-discovery** (the same `looks_save_capable` heuristic the global copy already uses, scoped to `apps-script/`). Now covers all 6 save-capable modals incl. `RecalibrateVendor.html`, auto-excludes the 3 read-only ones, and never goes stale again. Run clean: 6/6 consistent, exit 0. Per `checker-script-sync`, the global canonical was already ahead (it had `--all`) so no global edit needed — the fork just adopted its approach + kept the `apps-script/` path.
- **Latent bug fixed**: the concept-card "N locations" meta is built text, not static bilingual spans, so the EN/ES toggle never switched it. `toggleHubLang_` now re-renders the picker.
- **Skill ordering encoded**: added a "Run this BEFORE the feature commit" rule to `mog-session-handoff/SKILL.md` so the handoff's doc edits ride in the same commit as the code (no double-commit).

## Verification (later session)

Drove the hub in a local static preview (`python -m http.server`): RP "3 locations" → Founders/Rosslyn/Tysons → Rosslyn → BOH/FOH; basil `--concept-*` on sub-screens; back-nav at every level; TNY single-site collapse → its area screen with gold tint and correct back-to-concept; tint clears on return to picker. `node --check` on the extracted hub JS = clean; `audit_modals.py` = 6/6 green; no console errors. (The screenshot tool hung — renderer-side; colors confirmed via direct CSS inspection.)

## Files touched (later session)

**Hub source (`git push` → GitHub Pages):**
- `index.html` — 3-level nav (`parseLocation_`, `buildSiteGroups_`, `onSiteTap_`, `setActiveConceptTheme_`, `areaBackTarget`, `screen-area` markup + mgr banner), per-concept tints in `CONCEPT_VISUALS`, `--concept-*` CSS vars on `.ti-icon`/`.back-btn`, curly TNY key, `toggleHubLang_` re-render.
- `sw.js` — hub CACHE v6→v7.

**Build + config:**
- `stores.json` — TNY concept → curly U+2019 (both entries).
- `build.py` — `CONCEPT_TO_THEME` TNY key → curly.

**Tooling / skills:**
- `.claude/skills/mog-modal-ux-sweep/scripts/audit_modals.py` — auto-discovery rewrite.
- `.claude/skills/mog-session-handoff/SKILL.md` — handoff-before-commit ordering rule.

**Generated dirs:** `build.py` ran; all 8 `<slug>/` dirs came out byte-identical (no diff) — no redeploy.

## Opening prompt for next session

```
Resume MOG work. 2026-05-31 (later session) reworked the HUB: it's now a
3-level picker — Concept → Site (Rosslyn/Tysons/Founders) → Area (BOH/FOH),
with single-site/single-area screens auto-collapsing. Site/area are derived
from the location string in index.html (Option A — no stores.json schema
change). Concept tiles are now themed per concept (RP basil, TNY gold) and
the tint carries into the site/area sub-screens. TNY display name is now a
curly apostrophe (U+2019), synced across stores.json + hub CONCEPT_VISUALS +
build.py CONCEPT_TO_THEME. audit_modals.py was rebuilt to auto-discover
save-capable modals (now covers RecalibrateVendor.html). Hub CACHE v7.

This was a HUB-ONLY + tooling change: no clasp deploy, the 8 store dirs are
byte-identical. Deploys via git push (GitHub Pages) — no per-store canary.

Nothing is broken or half-finished. Optional next directions:
  1. Wire real per-concept brand SVGs into CONCEPT_VISUALS (currently
     generic Tabler icons + color tints).
  2. Batch D (strategic): brand fonts, brand SVG concept marks, concept-
     aware modal theming (modals are fixed navy/green across all 9).

Read docs/MOG_CurrentState.md for invariants. Deploy routing:
python .claude/skills/mog-deploy-workflow/scripts/route.py <file>.
```
