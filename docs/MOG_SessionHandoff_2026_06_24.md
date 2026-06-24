# Session Handoff — First-run setup wizard + editor guided tours + Manage Items QOL

**Session date:** 2026-06-24
**Session focus:** Build the first-time-setup wizard, then add guided tours (shared engine), then start Manage Items quality-of-life upgrades.
**Outcome:** Phase A (setup wizard + plain-`/exec`-opens-editor) is **committed (`8aa7f6e`), pushed, and fanned out to all 9 + master**. Phase B (shared tour engine + gated setup tour + home flow-tour) and the Manage Items upgrades (mini-tour, prerequisite warnings, natural-scroll layout, live per-delivery-day par preview) are **built and canary-tested but UNCOMMITTED and NOT fanned out**.
**Next session focus:** QOL #2 — the client-side "Recently adjusted" flag in the Par Review column — then fan out Phase B + commit.

---

## Section A — First-time-setup wizard + plain `/exec` (SHIPPED: `8aa7f6e`, all 9 + master)

- **`?page=setup` wizard** (`Setup.html` + `Editor.gs` `renderStoreSetupWeb_` + client-callable `commitStoreSetup`). Identity-only; writes the same PropertiesService keys as `setupMobileApi` **minus the master PIN** (owner-menu only). **One-shot, token-less guard:** `commitStoreSetup` runs only while `MOG_API_PIN` is unset and refuses once set (safe because a fresh `/exec` is unpublished + unguessable; mints a session token on success so the owner lands on the home without re-typing the PIN). 3 decisions locked (all "recommended"): open-when-unconfigured access model; master PIN out of the wizard; keep `setupMobileApi()` as fallback.
- **MVS/MPS-style wizard UX:** device gate → language splash (EN/ES, before the form) → identity form. Inputs reduced to **Concept dropdown + FOH/BOH dropdown + City (only free text)**; the store **name** and **code** are auto-built and shown in a live preview. **Code = CONCEPT + first-2-city-letters + full BOH/FOH** (e.g. Teas'n You + Rockville + BOH → `Teas'n You Rockville BOH` / `TNYROBOH`); cap raised to 10 chars. **Concept dropdown re-themes the whole page live** (`CONCEPT_THEME` client map mirrors server). Forced save bar (no exit until saved).
- **`doGet` routing inversion** (`MOGApi.gs`): the **plain `/exec` now opens the editor** (configured) or the **setup wizard** (unconfigured); `?page=editor` still works (old bookmarks). JSON health moved to **`?page=api`**. The PWA is unaffected — it only POSTs (`doPost`), and `doGet` routing never touches POST. **Verified** bare `/exec` on rpr/tnyt/rpfrf returns the editor and `?page=api` returns JSON.
- **`CONCEPT_THEMES` (`Dashboard.gs`): added ĂN (`#3C1124` Night Market burgundy, from the brand kit) and Lei'd (`#b51579`)** so those stores theme correctly on dashboard/editor band/recap email. RP/TNY/default byte-unchanged.
- **Why no manual store steps:** all 9 live stores are already configured (`MOG_API_PIN` set), so the first-run routing is a no-op for them; only a fresh template copy ever sees the wizard.

## Section B — Guided tours (shared engine) + Manage Items QOL (CANARY ONLY, uncommitted)

- **Promoted the tour engine into `EditorShell`** (`mgeStartTour_(steps, opts)`): cutout-spotlight coach-marks, now shared by every editor page. Added an **`info` mode** (home; Next always enabled) and a **`gated` mode** (setup; per-step `gate()` predicate, Next locked until the field validates, re-checked on input). `EditorHome.html` rewired to the shared engine (removed its local copy; fixed the help-popup replay button class `tour-btn`→`mge-tour-btn`).
- **Home tour reframed as the ordered setup FLOW** (anchored to individual tiles via `data-tour="tile-*"`): Welcome → Step 1 Vendors ("do first — items need a vendor") → Step 2 Items → Step 3 Storage Areas → Step 4 Shelf to Sheet → Order History → recap "Vendors → Items → Areas → Shelf to Sheet."
- **Gated setup tour** in `Setup.html` (concept→area→city→PIN, Next locked per field) + auto-fire once/browser + "Replay walkthrough" button.
- **Manage Items mini-tour** (`ManageItems.html`): info-mode, 5 steps with **MPS/MVS-voice copy** (rich opening explanation + why/consequences — patterned off `Master-Prep-Schedule/WebApp_Client.html` `TOUR_STEPS_ITEMS`). Auto-fires once/browser; "↻ Replay walkthrough" added to its `?` help popup.
- **Prerequisite warnings (Manage Items, web):** amber **block** when no vendors ("Add a vendor first" → Manage Vendors), soft accent **tip** when no storage areas ("create a storage area" → Storage Areas). Re-translates on EN/ES, updates when areas load.
- **Natural-scroll layout (the "B" conversion):** unlocked the dialog's `html,body { height:100%; overflow:hidden }` lock (scoped to `html.mge-web`, added only by Manage Items' init) so **the whole page scrolls like MVS/MPS** — a persistent **title + one-line description** now sits above the table without shrinking it; the table keeps its own internal scroll at `100vh − 340px`; the detail pane is `position:sticky`.
- **QOL #1 — live per-delivery-day par preview** (`renderParPreview_`): in the add/edit form, an "Order per delivery day" box shows each vendor delivery day's order, updating live as the par changes. **Math (operator-confirmed): `ceil(par × dayMultiplier)` — round UP to whole units (can't order a fraction; always up), applied AFTER the multiplier** (e.g. par 3.25 × 3 = 9.75 → 10); flat par when Use Multiplier is off. Mults from `getVendorTableData` (mults `[0..6]` = Mon–Sun, delivery days = mult > 0).
- **Bug fixed mid-session:** `MIRPC`'s web proxy exposes an **explicit allowlist** of server fns; my `getVendorTableData` call wasn't on it → threw mid-init → items stopped loading. Added `getVendorTableData` to the proxy AND moved the (optional) fetch to *after* `loadAllItems()` so it can never block the list again.
- **"Clear Config" menu (`clearMobileApiConfig`, `MOGApi.gs` + `Core.gs`):** relabeled **"Clear Config (reset for setup)"**, now also clears `MOG_CONCEPT`, and points at the wizard. This is the **reuse-the-template-for-testing** reset (un-configures → wizard fires again; data untouched). Replaced a redundant `resetStoreForReuse()` I briefly added then removed.

## Outstanding (carry forward)

- **QOL #2 — "Recently adjusted" flag (NOT started).** Agreed approach: **client-side** recency (mirror the "New" badge — per-store `localStorage`, set on a successful par edit, show a "Recently adjusted" pill in the Par Review column for ~7 days, taking precedence over the normal flag). No schema change.
- **Deep-link cold-start brick (open bug).** Opening a tool URL directly (`?page=items`) cold — before authenticating at the home — bricks (mini-tour + items don't load; "doesn't open to the PIN gate"). Works when you authenticate at the home first then click the tile (warm). The home tiles deep-link too, so worth fixing so a bookmarked tool page works standalone. Need a console error or repro to pin it, or harden blind (force the gate whenever there's no server-validated token before tool init). **Until fixed: always hand Sebastian the bare `/exec` home link, never a `?page=` deep link** (see memory `feedback_canary_include_exec_link`).
- **Fan out Phase B + Manage Items QOL.** Everything in Section B is **canary only** — rpfrf (editor/data) + `_template` (wizard). After verifying, fan out with `python deploy.py --redeploy` (no `--target`). Manual per-store step: none (Phase A already live; Section B is additive editor-web changes).
- **Per-tool mini-tours for the other 4 tools** (Manage Vendors, Storage Areas, Shelf to Sheet, Order History) — Manage Items is the proven template (steps array + `?`-popup replay button + once/browser auto-fire).
- **Natural-scroll + persistent subtitle for the other tools.** Only Manage Items got the "B" conversion. The others are still height-locked; convert per-tool (un-lock `html.mge-web`, cap the scroller, sticky detail) when adding their subtitles.

## Files touched this chat

- **Server (`.gs`):** `Editor.gs` (`renderStoreSetupWeb_`, `commitStoreSetup`) [committed]; `MOGApi.gs` (`doGet` inversion [committed]; `clearMobileApiConfig` concept-clear [uncommitted]); `Dashboard.gs` (`CONCEPT_THEMES` ĂN/Lei'd) [committed]; `Core.gs` (menu label) [uncommitted].
- **Editor HTML:** `Setup.html` (wizard [committed] + gated setup tour [uncommitted]); `EditorShell.html` (shared tour engine) [uncommitted]; `EditorHome.html` (shared-engine rewire + flow tour) [uncommitted]; `ManageItems.html` (mini-tour + prereq warnings + natural-scroll B + par preview + MIRPC fix) [uncommitted].
- **Config:** `apps-script/.clasp-targets.json` (recorded `_template` deploymentId) [committed].
- **Memory:** new `feedback_canary_include_exec_link.md` (+ MEMORY.md index).
- **Deploys:** `8aa7f6e` fanned out all 9 + master (`--redeploy`). Section B: canary `rpfrf` (editor) + `_template` (wizard) only, many `--redeploy --target` rounds. No `build.py` / PWA / hub changes. No new OAuth scopes.

## Commits landed this session

```
8aa7f6e feat(editor): first-run setup wizard + plain /exec opens editor
```
(Section B work is uncommitted — to be committed with this handoff. See "Suggested commit" in the wrap-up.)

## Opening prompt for next session

```
Read docs/MOG_CurrentState.md first. The KM web editor first-run setup wizard
(?page=setup) is DONE, committed (8aa7f6e), pushed, and fanned out to all 9 +
master, along with the routing inversion so the plain /exec opens the editor
(JSON health moved to ?page=api) and ĂN/Lei'd added to CONCEPT_THEMES.

UNCOMMITTED + canary-only (rpfrf for editor/data, _template for the wizard):
the shared guided-tour engine (mgeStartTour_ in EditorShell, info + gated modes),
the home flow-tour, the gated setup tour, and Manage Items upgrades — mini-tour,
prerequisite warnings (no-vendor block / no-area tip), the natural-scroll layout
+ persistent title/subtitle ("B"), and the live per-delivery-day par preview
(ceil(par × dayMultiplier) — round UP to whole units; mults from
getVendorTableData).

This session: (1) QOL #2 — the client-side "Recently adjusted" flag in the Par
Review column (mirror the New-badge localStorage pattern; show a pill for ~7 days,
precedence over the normal flag). (2) Then fan out Section B (deploy.py --redeploy,
no --target) and git push. Also open: the cold deep-link brick (open ?page=items
without authing at the home first → bricks) and the per-tool mini-tours for the
other 4 tools.

Gotchas: MIRPC's web proxy is an explicit allowlist — a server fn not listed
throws mid-init and stops items loading. ALWAYS hand Sebastian the bare /exec
HOME link, never a ?page= deep link (cold deep-link is buggy). Editor canary =
rpfrf (data) / _template (wizard); iterate on /dev, fan out with --redeploy.
```

---

## Later session — fan-out + validate-first gate + per-tool mini-tours + MVS voice/chrome parity

**Session focus:** Ship QOL #2, harden the editor's reliability and MVS/MPS fidelity (gate, tours, voice, chrome), then fan everything out.
**Outcome:** All of Section B plus this session's fixes are **fanned out to all 9 + master** (`deploy.py --redeploy`, every target push+deploy OK) and committed. The gate is now validate-first (no more redeploy-brick), all 5 tools have mini-tours, and the tour/help voice + `?`/EN-ES chrome match MVS/MPS.
**Next session focus:** Decide auto-fire vs replay-only for the 4 new mini-tours; optionally extend the natural-scroll "B" layout + per-tool subtitles to the other tools.

### What shipped

- **QOL #2 — "Recently adjusted" pill** (`ManageItems.html`): client-side per-store `mog_parAdjusted_<abbr>` localStorage map (7-day window, MOG_WEB-gated, self-pruning); `markParAdjusted_` fires in `doEdit` **only when the par value changed**; takes precedence over the historical flag in `buildFlagPill`/`buildFlagDetail`/`sortValue_`; new `✎ Recently adjusted` / `✎ Ajuste reciente` pill + `.pill-adjusted`. No schema change.
- **Table height matches the sidebar** (`ManageItems.html`): `.table-scroll` `max-height:calc(100vh−340px)` → `min-height:600px; max-height:clamp(600px, calc(100vh−220px), 680px)` so the list card matches the open edit form and never collapses below it.
- **Validate-first gate — the gate is the only door** (`EditorShell.html` + `Editor.gs`): root cause of "redeploy bricks the editor" — session tokens live in `CacheService`, which Google **flushes on a new deployment version**, so the old optimistic gate ran a tool with a dead token and bricked on the first RPC. Fix: new client-callable **`editorPing(token)`** (auth-layer; bypasses the `webedit_call` allowlist); `mgeStartGate_` now **validates a stored token server-side before running any tool** (brief "checking" → tool, else → PIN); init re-runs on **every** successful auth (`mgeRunCb_`) so a stale/expired token re-prompts and reloads cleanly instead of a blank page. Shared → all 5 tools + home, and kills the cold deep-link brick. Accepted trade-off: a mid-edit expiry reloads the tool on re-PIN, dropping unsaved form input.
- **Tour engine gate hint** (`EditorShell.html`): gated steps show `ⓘ Do this step to continue` + relabel the button **"Done with this step"** (was a silently-disabled Next — why setup gating "felt broken"). Mirrors MVS `tour_gate_hint`/`tour_step_done`.
- **Per-tool mini-tours for the 4 remaining tools** (Vendors/StorageAreas/ReorderPickPath/OrderHistory): info-mode `<TOOL>_TOUR_STEPS` + `start/replay/maybeAutoStart` trio + once-per-browser key + `.tour-replay-wrap` "↻ Replay walkthrough" in each `?` help; auto-fire once + replay. `.tour-replay-wrap` CSS centralized in `EditorShell`.
- **Voice rewrite (all 5 mini-tours)** to the MVS/MPS house voice: imperative titles, action-first bodies that name the control, em-dash why, warm close, **no "~20 seconds" meta-narration**; ES informal tú imperative. (The older Manage Items tour got the same treatment.)
- **`?` chrome relocated to match MVS** (`EditorShell.html`): moved out of the band into a **prominent filled-accent circle with a halo next to the breadcrumb title** (`.mge-crumb-help`, MVS `.vh-help`; held on `MGE_HELPBTN` so it survives breadcrumb re-renders). EN/ES stays alone in the band; `mgeMountWebChrome_` now relocates only the lang buttons.
- **Faded buttons fixed** (`EditorShell.html`): `.mge-tour-btn.primary` used `var(--accent)` — undefined on tool pages (they use `--web-accent`) → navy fallback; now `var(--web-accent, var(--accent, #1a1a2e))` so tour Next/Done + Replay are solid concept accent everywhere, with `:hover` brightness.
- **Home help-popup rewrite** (`EditorHome.html`): dropped the already-done steps (use a computer / enter PIN); now orients (what the editor is + build order Vendors → Items → Areas → Shelf to Sheet + "every tool has a ?"). Header band **colored with the accent** (white title/✕, card `overflow:hidden`) to match the MVS/MPS help modal.
- **Skill + docs updates:** `mog-deploy-workflow` — loud "NEVER `--redeploy` to iterate; push-only on `/dev`" note (CacheService token flush). `mog-editor-web-reskin` — **Rule 0 "port faithfully from MVS/MPS,"** centralized-chrome correction (per-tool band superseded by `mgeMountWebChrome_`/`setBreadcrumb_`), new **Tours & voice** section, accurate tool status. `MOG_CurrentState.md` — validate-first-gate architecture note. New memory `feedback_editor_iterate_on_dev`.

### Process corrections (this session's recurring friction)
- **Port faithfully, don't adapt.** The editor kept diverging from MVS/MPS (voice, `?`/EN-ES, gating) because it was built as an adaptation; each fix was "go match what MVS does." Encoded as `mog-editor-web-reskin` Rule 0.
- **Pull + confirm a clean `git status` before deploying.** A stale local checkout was deployed mid-session and rolled rpfrf back to the old layout (the "super small table") until a `git pull`.
- **Iterate push-only on `/dev`, never `--redeploy`.** `--redeploy` flushes CacheService session tokens (+ CDN-caches `/exec`), which bricked the editor repeatedly until the validate-first gate landed. `--redeploy` is fan-out only.

### Outstanding (carry forward)
- **Auto-fire vs replay-only** for the 4 new mini-tours (currently auto-fire once/browser, matching Manage Items). With the home flow-tour + 5 per-tool tours that may be a lot of coaching — switch to replay-only by dropping the `maybeAutoStart…` calls if so.
- **Natural-scroll "B" layout + persistent subtitle** only on Manage Items; the other 4 tools are still height-locked. Convert per-tool when adding subtitles.
- **Global-skill refinement deferred** (scoped to repo skills this round). The MVS/MPS-fidelity lessons could later fold into global `appsscript-guided-tour-help` / `appsscript-phrasing-glossary` / `appsscript-first-run-setup` / `architectural-walkthrough`.

### Files touched
- Server: `Editor.gs` (`editorPing`).
- Editor HTML: `EditorShell.html` (validate-first gate + gate hint + `?` relocation + button-accent fix + shared replay-wrap CSS), `EditorHome.html` (help-popup rewrite + colored header), `ManageItems.html` (QOL pill + table height + tour voice), `ManageVendors.html` / `StorageAreas.html` / `ReorderPickPath.html` / `OrderHistory.html` (mini-tours + voice).
- Docs/skills: `MOG_CurrentState.md`, `mog-deploy-workflow/SKILL.md`, `mog-editor-web-reskin/SKILL.md`. Memory: `feedback_editor_iterate_on_dev`.
- Deploy: `deploy.py --redeploy` (all 9 + master, every target OK). Iterated push-only on rpfrf `/dev` throughout.

### Opening prompt for next session
```
Read docs/MOG_CurrentState.md first. The KM web editor is fully fanned out to all
9 + master: validate-first gate (editorPing — survives redeploys), per-tool
mini-tours on all 5 tools + the home flow-tour + gated setup tour, MVS/MPS-voiced
tour/help copy, the ? as a prominent breadcrumb circle (EN/ES in the band), solid
concept-accent tour buttons, the Manage Items "Recently adjusted" pill +
table-height match, and a rewritten home help popup.

Open threads: (1) decide auto-fire vs replay-only for the 4 new mini-tours
(currently auto-fire once/browser). (2) Optionally extend the natural-scroll "B"
layout + persistent subtitle to the other 4 tools (only Manage Items has it). (3)
Optionally fold the MVS/MPS-fidelity lessons into the GLOBAL skills (this round
was repo-only).

Deploy discipline: iterate push-only on rpfrf /dev (never --redeploy to iterate —
it flushes CacheService session tokens); fan out with deploy.py --redeploy. Always
pull + confirm a clean git status before deploying. Editor canary = rpfrf.
```
