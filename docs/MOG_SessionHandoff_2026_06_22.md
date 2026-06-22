# Session Handoff — KM web editor polish: remaining tools + shared shell + consistency

**Session date:** 2026-06-22
**Session focus:** Finish the per-tool web re-skin (Manage Vendors, Reorder Pick Path, Order History), then make the editor genuinely consistent across pages.
**Outcome:** All 5 tools + the Home dashboard now share ONE editor shell — a centralized header band (brand logo → location → "Master Ordering Guide"), segmented EN/ES + circle "?", an info-note callout, and a token set all defined once in `EditorShell`. Per-concept accent now derives live (fixes Teas'n You gold). **Canary rpfrf `/dev` ONLY — NOT committed, NOT pushed, NOT fanned out.**
**Next session focus:** Code audit — hunt dead code + inefficiencies across the editor (`appsscript-codebase-audit` + `mog-pwa-audit`), per Sebastian.

---

## What shipped (all canary rpfrf via `deploy.py --redeploy --target rpfrf`)

**Per-tool web re-skins** (each `body.mge-web`-gated; in-Sheet dialog byte-identical; mockup-approved first):
- **Manage Vendors** (`ManageVendors.html`) — 920px column, vendor list + Add/Import/Remove panels as cards, accent band.
- **Reorder Pick Path** (`ReorderPickPath.html`) — **Treatment B** area headers (soft-accent tint + 3px accent edge-bar; **Unassigned stays amber** = semantic "not on the order sheet yet"), 780px, vendor picker promoted to its own card, sticky Save footer, web-only info-note. `setLang` clobber fixed.
- **Order History** (`OrderHistory.html`) — read-only; 1080px; 3 tabs → **pill/segmented tab bar**; filter → **toolbar card**; Recent → **responsive vendor-card grid** (`.hist-date-group` as CSS grid, date header spans full row); count badges/summary headers retinted to accent; no save footer. (Its `setLang` never clobbered `body.className`, so no fix needed there.)

**Modular accent** (`EditorShell.html`) — `mgeApplyConcept_` now derives **all four** `--web-accent*` tokens from `THEME.accent` via a new pure-JS `mgeMix_(hex, keep, toward)` (deterministic, **no `color-mix` dependency**). Removed the per-tool `--web-accent`/`-text` `setProperty` wiring. **Fixes the latent Teas'n You bug**: dark/soft shades were RP-teal-hardcoded in every tool, so a gold store would have shown teal accents. On RP the derived shades (`#247056`/`#e6f1ed`) are visually identical to the old hand-tuned values.

**Centralized header band** (`EditorShell.html`, shared) — the band was copy-pasted into each tool (why sizes drifted). Now defined ONCE: **brand horizontal logo → location → "Master Ordering Guide"** (replaces "MOG EDITOR → Location"). Horizontal logos (all 4 concepts) embedded from `heh-brand-kit/assets/logos/<c>/<c>-horizontal.svg`, recolored white via `currentColor`, shown per `data-concept`. EN/ES is a **segmented control** + "?" is a **26px circle**, both **fully owned by EditorShell with `!important`** so no host page's base `.lang-btn`/`.help-btn` can leak in. `--shell-width` (set per page to its content width) drives the band + breadcrumb inner width so the header **aligns with the content** on every page. Each tool calls `mgeMountWebChrome_()` (adds `mge-web`, reveals + fills the band, relocates the page's lang/help into it); **Home mounts it too** (its old `.app-header` hidden). Reference for the pattern: **MPS/MVS app shells** (`Master-Prep-Schedule`, `Master-Visual-Schedule` — one static shell + one CSS file).

**Info-note** (shared `.web-note` in EditorShell) — accent-tinted callout with an "i" badge for tool intros. **One-liner now on all 5 tools** (Storage Areas + Pick Path had it; added Manage Items / Manage Vendors / Order History). Bilingual, `body.mge-web`-only.

**Visual-consistency sweep** (web layer only — `appsscript-ui-consistency-audit`) — **centralized the web token set into `EditorShell` `:root`** (`--web-accent*`, `--shadow`, `--font`, `--r`, `--r-sm`, `--muted`, `--faint`); removed all 5 per-tool `:root` copies. **Fixed a real bug:** `ManageItems` referenced `var(--r)`/`var(--faint)` but never defined them (corners squared, faint text uncolored) — now inherits the shared set. Tokenized stray raw radii (Pick Path `5px`→`--r-sm`, Order History tab `10px`/`7px`→`--r`/`--r-sm`); normalized Pick Path vendor-select `15px`→`14px`. The scanner's large "raw hex" lists were the **Sheet-mode base CSS** (deliberately raw, out of scope) — left untouched.

**Bugs fixed mid-session** (all surfaced on `/dev`): (1) all four concept logos rendering at once — `.mge-web-logo svg { display:block }` (0,1,1) overrode `.mge-hl{display:none}` (0,1,0); fixed with scoped `!important` show/hide. (2) Location not shortened — store is `"Roll Play Founders FOH"` (space-separated, no dash); `mgeShortLoc_` now strips the concept-name prefix (apostrophe/case-tolerant) → "Founders FOH". (3) Home dashboard had no band — now mounts the shared one.

**Skills / memory:** NEW `mog-editor-web-reskin` skill (the turnkey per-tool recipe; from the 2026-06-21 later session, still uncommitted). Enhanced `mog-deploy-workflow` (`/dev` vs `/exec`, editor canary = rpfrf). NEW memory `feedback_shared_shell_owns_chrome` (a shared shell must OWN chrome styling + width, not just markup — `!important`; MPS/MVS are the reference). `Items.gs` `clearDataValidations()` add/edit fix also rides in this uncommitted batch (from 2026-06-21 polish).

## Outstanding (carry forward)

- **NOT committed / NOT pushed / NOT fanned out** — everything is canary **rpfrf** only. Working tree also still holds the **2026-06-21 later-session polish** (Manage Items + Storage Areas re-skin, the new skill, `Items.gs`) plus **4 unpushed base commits** (`4b5c353` `fe47a12` `1a3a799` `eeb4c00`). Suggested: ONE commit for the uncommitted editor work + docs, then `git push` (carries the 4 prior too).
- **Fan-out** is the remaining deploy step: `python deploy.py --redeploy` (NO `--target` — canary already satisfied). All `MOGApi.gs`/`Editor.gs`-adjacent web changes → `--redeploy`.
- **Guided tour** still deferred — `appsscript-guided-tour-help`; the shell has `#mge-*` mounts + `[data-tour]`-able controls.
- **Dead-code side-task** (from 2026-06-19, still open): verify whether `showAdminResetSidebar` / `goToOrderEntry` / 3× `toggle*Visibility` are dashboard-button-assigned (Sheet-side, invisible to grep), then delete the unwired ones. Folds naturally into next session's audit.

## Files touched this chat

- **Shared shell:** `apps-script/EditorShell.html` (band markup + horizontal logos + band/info-note CSS, `mgeMix_`, `mgeApplyWebAccent_`, `mgeMountWebChrome_`, `mgeShortLoc_`, centralized `:root` tokens), `apps-script/EditorHome.html` (mount the band, hide old `.app-header`, `--shell-width`).
- **Tools (web re-skin + shell wiring + token cleanup + info-note):** `apps-script/ManageItems.html`, `apps-script/ManageVendors.html`, `apps-script/StorageAreas.html`, `apps-script/ReorderPickPath.html`, `apps-script/OrderHistory.html`.
- **Server:** `apps-script/Items.gs` (`clearDataValidations()` — from 2026-06-21 polish).
- **Skills:** NEW `.claude/skills/mog-editor-web-reskin/`, `.claude/skills/mog-deploy-workflow/SKILL.md`.
- **Docs:** this handoff; `CLAUDE.md` (@-import bump + skills table); `docs/MOG_CurrentState.md`.
- **Deploys:** `deploy.py --redeploy --target rpfrf` (canary only, many iterations). No `build.py`, no fan-out, no push.

## Commits landed this session

```
(none — all work is uncommitted at handoff time; see Outstanding)
Pre-existing unpushed: eeb4c00, 1a3a799, fe47a12, 4b5c353
```

## Opening prompt for next session

```
Read docs/MOG_CurrentState.md first. The KM web editor is fully polished on
canary rpfrf /dev: all 5 tools (Manage Items, Manage Vendors, Storage Areas,
Reorder Pick Path, Order History) + the Home dashboard share ONE shell defined
in EditorShell — centralized header band (brand logo → location → Master
Ordering Guide), segmented EN/ES + circle ?, info-note one-liners, and web
tokens all defined once. Per-concept accent derives live (mgeMix_). Everything
is body.mge-web-scoped (Sheet dialogs untouched). It is canary-rpfrf ONLY —
NOT committed, NOT pushed, NOT fanned out.

This session: AUDIT the editor code for dead code + inefficiencies — run
appsscript-codebase-audit (.gs + behavior) and mog-pwa-audit-style review on
the editor HTML/JS. Fold in the open dead-code check: confirm whether
showAdminResetSidebar / goToOrderEntry / the 3 toggle*Visibility fns are
dashboard-button-assigned (Sheet-side, grep-invisible), then delete the unwired
ones. After the audit + fixes: guided tour (appsscript-guided-tour-help), then
fan out (deploy.py --redeploy, no --target), then git push.

Gotcha: a blank/old-looking editor page is usually a runtime issue (e.g. a
setLang clobbering the mge-web class), not a deploy/cache one — iterate on /dev
(live HEAD), never /exec (CDN-cached). google.script.run can't call _-suffixed
fns.
```

---

## Later session (same day) — audit done, fanned out, TNY gold-forward, Shelf-to-Sheet rename, grouped home + guided tour

**Session focus:** Run the editor code audit, then ship the editor (fan out), then polish (TNY color, rename, home layout, guided tour).
**Outcome:** Editor audit came back **clean** (one cosmetic fix). Everything from the parked editor work is now **fanned out to all 9 + master** and **committed + pushed** (`bdb44c7`, on top of the 4 prior base commits). TNY is gold-forward everywhere; "Reorder Pick Path" is renamed to "Shelf to Sheet"; the home is 3-sectioned with a first-run guided tour.
**Next session focus:** Build the first-time-setup wizard (the MVS/MPS-style setup version MOG lacks).

### What shipped (this session)

- **KM editor code audit — clean** (`appsscript-codebase-audit` + dead-code check). No dead helpers from the dual-host conversion, no redundant init RPCs (pages render from prebaked template vars), handoff cleanups left zero residue, all cross-file hooks wired. **Resolved the open dead-code check: KEEP all 5** of `showAdminResetSidebar` / `goToOrderEntry` / 3× `toggle*Visibility` — none are menu-wired or code-called, yet `showAdminResetSidebar` is the *sole* entry to the live "Sheet-only" Admin Reset, which proves they're **dashboard-drawing-button-assigned** (grep-invisible). One-time confirm via "Assign script" on a Home dashboard, but do NOT delete on grep evidence. One cosmetic fix applied: dropped `--font`/`--shadow`/`--muted`/`--faint` from `EditorHome` `:root` (EditorShell owns them; verified visual no-op).
- **Editor fanned out** — the parked Phase-1 + 06-22 polish went to all 9 + master via `deploy.py --redeploy` (no `--target`). First time the editor is on every store's `/exec`.
- **TNY gold-forward everywhere** (web editor band + Sheet dashboard banner + recap email). Split `CONCEPT_THEMES`'s single `accent` into `accent` (band/banner fill → gold `#D4A574`) and new **`ink`** (tiles, reset strip, recap-email vendor headers + "× qty" → charcoal `#1a1a1a`). `dashTheme_()` normalizes `ink: t.ink || t.accent`, so **RP and default are byte-unchanged**. `Dashboard.gs` tiles/strip/vendor-populated CF use `ink`; `MOGApi.gs` email `headInk = theme.ink` + a luminance-derived `bandSub` (muted dark on a light band). The earlier web-only `webAccent` override was removed (base theme is gold-forward now), so `mgeApplyWebAccent_` reverted to plain `accent`/`bannerFont`.
- **Removed the per-tool info-note one-liners** (markup in all 5 tools + the `.web-note` CSS in EditorShell). **Breadcrumb left-aligned** (`.mge-crumb` → `margin: 0`, flush at the 28px rail).
- **Renamed "Reorder Pick Path" → "Shelf to Sheet" / "Estante a Hoja"** everywhere shown: EditorHome tile, `Core.gs` menu, `Dashboard.gs` tile, `PickPath.gs` dialog title, the tool's own title/breadcrumb/help/Save button (now just "Save"/"Guardar"), cross-refs in ManageItems + StorageAreas, and HowToUse (nav/section/headings/concept prose). **Left unchanged:** code identifiers (`ReorderPickPath`, `page=pickpath`, `commitReorderPickPath`), comments, and AdminReset's "Pick Path DB/List" (those name SETUP data columns, not the tool). ES uses "Estante a Hoja" as a proper-noun label.
- **Editor home grouped into 3 sections** — Catalog (Items + Vendors), Order Sheet Layout (Storage Areas + Shelf to Sheet), Records (Order History) — plus a **first-run guided tour**: MVS/MPS-style **cutout-spotlight** coach-marks (4 dim panels around a bright pulsing hole), bilingual, 6 info steps, fires once per browser (`localStorage mog_edit_tour_seen`), language inherited from the PIN gate (no splash needed), replayable from the "Have a question?" help popup. Fixed the stale "Manage Items is ready now" home-help copy.

### Outstanding (carry forward)

- **Manual per-store step:** run **Rebuild Home Dashboard** in each Sheet to pick up the renamed tile (all 9) and the gold banner (the 2 TNY stores). Recap email re-themes on next send automatically.
- **Confirm (don't delete):** "Assign script" on a Home dashboard to verify the 5 button-bound fns above.
- **Tour engine still lives in `EditorHome.html`** (info-mode only). To support per-tool tours + the setup tour, **promote it to `EditorShell`** as shared infra (add `info`/`click`/`focus` modes + input-gating from the MVS engine, and the `--ink`/`--card` tokens it needs).
- **Per-tool mini-tours** still deferred (iterate per tool, Manage Items first).

### NEXT FOCUS — first-time-setup wizard (designed, not built)

MOG has **no web setup screen** — store setup is `setupMobileApi()` (6 `ui.prompt`s: PIN, location, abbr, concept, GM email, master PIN → PropertiesService), owner-run from the menu. The MVS/MPS "setup version" of the tour walks a web setup form MOG lacks. Build:
- `?page=setup` → new `Setup.html` + `renderStoreSetupWeb_` + **`commitStoreSetup({pin, location, abbr, concept, gmEmail})`** writing the same props as `setupMobileApi` (parity; keep the menu version as fallback). **Identity-only** — no data (areas/vendors/items have their own tools).
- **First-run routing:** when `MOG_API_PIN` is unset, `?page=editor` routes to the wizard (solves the chicken-and-egg — can't gate on a PIN that doesn't exist). This is where the **MVS language splash** finally fits (no lang chosen, no gate yet).
- **Gated setup tour** (focus steps, Next locked until each field is filled) → on Finish, save + redirect to the editor home + the home tour.
- **3 open decisions:** (1) master PIN in the wizard or owner-menu-only (it's sensitive)? (2) access model — open when unconfigured vs a one-time setup token (fresh-store `/exec` exposure)? (3) retire `setupMobileApi()` or keep as fallback (recommend keep)?
- Optional: Sebastian offered MVS/MPS setup screenshots.

### Files touched (this session)

- **Theme/server:** `apps-script/Dashboard.gs` (`CONCEPT_THEMES` accent/ink split, `dashTheme_` normalize, tile/strip/vendor-CF → `ink`), `apps-script/MOGApi.gs` (recap email `headInk`/`bandSub`), `apps-script/Core.gs` + `apps-script/PickPath.gs` (menu + dialog rename).
- **Editor HTML:** `apps-script/EditorShell.html` (info-note CSS removed, breadcrumb left-align, `mgeApplyWebAccent_` revert), `apps-script/EditorHome.html` (token dedup, 3-section `HOME_SECTIONS`, guided-tour engine + steps + replay, stale-copy fix), `apps-script/ManageItems.html` / `ManageVendors.html` / `StorageAreas.html` / `ReorderPickPath.html` / `OrderHistory.html` (info-note removal + rename).
- **Guide:** `apps-script/HowToUse.html` (Shelf-to-Sheet rename across nav/sections/prose).
- **Docs/memory:** this handoff; `docs/MOG_CurrentState.md`; new memory `project_editor_webonly_direction`.
- **Deploys:** `deploy.py --redeploy` (canary rpfrf, then full fan-out, several rounds). No `build.py` / no PWA / no hub changes. No new OAuth scopes.

### Commits landed (this session)

```
bdb44c7 feat(editor): TNY gold-forward, Shelf to Sheet rename, grouped home + guided tour
```
(plus the 4 pre-existing base commits `4b5c353` `fe47a12` `1a3a799` `eeb4c00`, all now pushed to origin/main)

### Opening prompt for next session (supersedes the one above)

```
Read docs/MOG_CurrentState.md first. The KM web editor is DONE and live on all 9
stores + master (committed + pushed, bdb44c7): audited clean, TNY gold-forward
everywhere, "Reorder Pick Path" renamed to "Shelf to Sheet", home is 3-sectioned
(Catalog / Order Sheet Layout / Records) with a first-run MVS-style cutout-
spotlight guided tour (replayable from the help popup).

This session: build the FIRST-TIME-SETUP WIZARD — the MVS/MPS-style setup screen
MOG lacks. Today setup is setupMobileApi() (6 ui.prompts → PropertiesService),
owner-run from the menu. Build ?page=setup + Setup.html + commitStoreSetup({pin,
location, abbr, concept, gmEmail}) writing the same props (keep the menu as
fallback); first-run routing (no MOG_API_PIN → wizard, since you can't gate on a
PIN that doesn't exist yet); the MVS language splash (fits here — no gate yet);
and a gated setup tour (focus steps) → on Finish, home + home tour. Identity-only
(no data). Decide first: master PIN in-wizard?, access model (open-when-unconfigured
vs setup token)?, retire setupMobileApi or keep as fallback? Also promote the tour
engine from EditorHome.html into EditorShell (add info/click/focus + gating from
the MVS engine) so the setup tour + per-tool tours reuse it.

Carry-forward: run Rebuild Home Dashboard per store (gold banner on the 2 TNY
stores, Shelf to Sheet tile on all). Editor canary is rpfrf; iterate on /dev, fan
out with deploy.py --redeploy (no --target). MVS tour engine reference:
Master-Visual-Schedule/MvsApp_Help.html.
```
