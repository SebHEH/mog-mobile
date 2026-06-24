---
name: mog-editor-web-reskin
user-invocable: false
description: The turnkey recipe for polishing one KM web-editor tool (a dual-host Apps Script modal served via doGet?page=…) into a real full-page web app — bespoke per tool, web-gated so the in-Sheet dialog is untouched. Use whenever Sebastian says "polish the next tool", "let's do <Manage Vendors / Reorder Pick Path / Order History> next", "rethink this tool's layout/density", "make it look like Manage Items", or any per-tool web-editor visual pass. ALSO trigger before touching ANY editor modal's web rendering, because step 1 (the setLang class-clobber fix) is a hard prerequisite that silently breaks the whole re-skin if skipped. Skip for the in-Sheet dialog behavior, the PWA (template/index.html), and pure server-logic changes.
---

# mog-editor-web-reskin

The KM web editor (Phase 1, 2026-06-21) serves each existing modal as BOTH the in-Sheet dialog AND a web page via `doGet?page=…` + a `MOG_WEB` flag (see `docs/MOG_SessionHandoff_2026_06_21.md`, `Editor.gs`). Sebastian's call is **bespoke per tool**: rethink each tool's layout/density now that it's a standalone page, not a fixed dialog. Manage Items and Storage Areas are done; this skill is the repeatable recipe so the rest (Manage Vendors, Reorder Pick Path, Order History) go fast and don't re-hit the traps.

**Hard invariant:** every visual change is scoped to `body.mge-web`, so the in-Sheet dialog (no `mge-web` class) is byte-identical. Behavior changes (sorting, in-place updates, validation-clear) are host-neutral and benefit both — that's fine and intended.

## Rule 0 — PORT FAITHFULLY FROM MVS/MPS, don't re-invent (read this first)

MOG's editor is a **port of the MVS/MPS editor pattern**, not a fresh design. Every divergence this project hit — wrong tour voice, a buried `?`, EN/ES placement, a setup tour that disabled Next with no hint — came from *adapting* instead of *replicating*. MPS/MVS don't have these problems because they're the originals; MOG drifts whenever someone builds "their own version." So before building/polishing ANY editor surface that has an MVS/MPS equivalent:

1. **Open the actual reference file and copy its mechanics.** The siblings live at `C:\Users\sebcn\Documents\Github\Master-Visual-Schedule\` and `…\Master-Prep-Schedule\`. Key references: `MvsApp_Help.html` (the guided-tour engine — 3 modes + gates), `MvsApp_Styles.html` (`.view-head` / `.v-title .vh-help` chrome), `MvsApp_Setup.html` + MPS `StoreSetupWizard.html` (first-run wizard), and the `T` dictionaries / `TOUR_STEPS_*` arrays (voice). Match the structure, not just the vibe.
2. **When in doubt about look/voice/behavior, the reference app is the source of truth — not your judgment of what reads well.** If a fix is "go see what MVS does and match it," that step was skippable up front.

## Where the chrome/voice/tours actually live now (2026-06-22+)

The per-tool `.web-hd` band described in Steps 1–2 below is **SUPERSEDED**. Chrome is **centralized in `EditorShell.html`** and shared by all 5 tools + home:

- **`mgeMountWebChrome_()`** (call in the tool's `if (MOG_WEB)` init branch) builds the shared band — brand logo → location → "Master Ordering Guide" — and relocates the tool's **EN/ES** `.lang-btn`s into the band as a segmented control. Do NOT build a per-tool band or per-tool `:root` tokens; the web tokens (`--web-accent*`, `--shadow`, `--r`, `--muted`, `--faint`) are defined ONCE in EditorShell, derived from `THEME.accent` via `mgeApplyConcept_`.
- **`setBreadcrumb_(ancestors, current)`** renders the breadcrumb AND relocates the tool's **`?` (`.help-btn`)** to sit right after the current-page name as a prominent **filled-accent circle with a halo** — the MVS `.v-title .vh-help` look (`.mge-crumb-help`, held on `MGE_HELPBTN` so it survives re-renders). The `?` goes by the TITLE; EN/ES goes in the BAND. Match MVS exactly — a `?` buried in the band reads as "not there."
- The tool only needs: the `setLang` class-preserve fix (Step 0), `mgeMountWebChrome_()` + `setBreadcrumb_()` in init, a `body.mge-web` content layer (Step 2's `:root` is now redundant — tokens are shared), and its mini-tour (see Tours & voice below).

## Step 0 — prerequisite that WILL bite you: fix `setLang`

Every modal's `setLang()` does `document.body.className = 'lang-' + lang;` — a **wholesale className reset that wipes the `mge-web` class** the entire re-skin is gated on. `init` adds `mge-web`, then `setLang` (called at the end of init) strips it, so the page renders with *none* of your `body.mge-web` rules and looks exactly like the old dialog. This cost a long session because the new code IS delivered (curl/clasp confirm it) but never *activates*. Fix first, in the tool's `setLang`:

```js
document.body.classList.remove('lang-en', 'lang-es');
document.body.classList.add('lang-' + lang);   // preserves mge-web; still drives body.lang-* (.saving::after)
```

## Step 1 — web chrome (markup + init)

- Add a web-only accent band before the navy header: `<div class="web-hd"><div class="web-hd-in"><div><div class="web-hd-eyebrow">MOG Editor</div><div class="web-hd-title" id="web-hd-title">…</div></div></div></div>`. Base rule `.web-hd{display:none}` so the Sheet never shows it.
- In the `if (MOG_WEB)` init branch (after the existing breadcrumb + `← Editor home` rename): add `document.body.classList.add('mge-web')`; set the accent from THEME; set the title; relocate the lang/help group into the band:

```js
var _root = document.documentElement.style;
_root.setProperty('--web-accent',      (THEME && THEME.accent)     ? THEME.accent     : '#2d8c6b');
_root.setProperty('--web-accent-text', (THEME && THEME.bannerFont) ? THEME.bannerFont : '#fff');
var _ht = byId('web-hd-title'); if (_ht) _ht.textContent = MOG_STORE || 'Store';
var _band = document.querySelector('.web-hd-in');
var _hr   = document.querySelector('.header .header-right');   // the WHOLE help+lang group, not just .lang-group
if (_band && _hr) _band.appendChild(_hr);
```

Relocate the node (don't duplicate) — `setLang`'s index-based `.lang-btn` loop assumes exactly two buttons.

## Step 2 — web-gated CSS layer (append before `</style>`)

Lead with a `:root` block defining every token you reference (an undefined `var(--shadow)` etc. silently no-ops — define them):

```css
:root { --web-accent:#2d8c6b; --web-accent-text:#fff; --web-accent-dark:#216b51; --web-accent-soft:#e9f4ef;
        --shadow:0 1px 3px rgba(0,0,0,.06),0 6px 18px rgba(0,0,0,.05);
        --font:'Inter',-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif;
        --r:10px; --r-sm:7px; --muted:#6b6f6b; --faint:#9aa3ad; }
```

Add the Inter `<link>` in `<head>` (font-family gated on `body.mge-web`, so the Sheet keeps Arial — the link is just an unused fetch there). Then, all `body.mge-web`-scoped: hide the navy header, accent band styling + light lang/help on it, **a centered `max-width` column** (pick the width for the tool's density — Items 1500px master-detail, Storage Areas 760px single list), Inter font, cards (`--shadow`, `--r`), and a footer treatment. Concept theming = band only; keep interior selection/focus navy.

## Step 3 — behavior patterns (apply where the tool has them)

- **In-place updates, never full reload.** Replace `allItems = []; loadAllItems()` after add/edit/delete with an in-memory mutation + a scroll-aware re-render, so the user keeps their place. Tag rows `data-id` and center the affected row:
  - `rerenderAndCenter_(id)` → `renderTable()` then `tr.scrollIntoView({block:'center'})` + a brief `.row-flash`.
  - `rerenderPreservingScroll_()` for delete (capture/restore `.table-scroll` scrollTop).
  - Make success handlers **null-safe** and key removal off the known id with a fallback (`(res && res.id) || lookup`) — a throw before the mutation leaves the row stale while the server change went through.
- **`clearDataValidations()` before writing MASTER_ITEMS rows** (Items.gs add/edit): `insertRowAfter` copies the row-above's validation onto the new row; a stray rule on a free-text column (e.g. NAME) then rejects the write ("violates data validation"). Clear the A:G block before `setValues`; the intentional L:M checkbox validation is applied separately.
- Draft-model tools (Storage Areas) already commit local state without a refetch — no in-place work needed.

## Step 4 — verify, deploy, iterate

- **Parse** the body script: `node -e 'const fs=require("fs");const s=fs.readFileSync("<file>","utf8");const i=s.lastIndexOf("<script>");const j=s.indexOf("</script>",i);new(require("vm").Script)(s.slice(i+8,j));console.log("OK")'`
- **Prove no Sheet bleed:** every selector in the re-skin block must start with `body.mge-web`, `:root`, a `.web-*{display:none}` base, or `@media`. Grep the block and assert zero unscoped selectors.
- **Deploy canary:** `python deploy.py --redeploy --target rpfrf` (the web page is served from the `/exec` versioned snapshot, so `--redeploy`, not push-only).
- **Iterate on `/dev`, NOT `/exec`.** `…/macros/s/<HEAD_DEPLOYMENT_ID>/dev?page=<tool>` serves live HEAD to the logged-in owner — every push shows on refresh, no cache. `/exec` is the public anonymous snapshot and CDN-caches hard (incognito won't help). Get the `/dev` deployment id from `clasp deployments` (the `@HEAD` one).
- **"Deployed but not showing" = runtime, not deploy.** If curl/clasp confirm the new code is served but the page looks unchanged, it's executing wrong (e.g. the `setLang` clobber), not a deploy/cache problem — open DevTools/console or "View frame source" and check whether `mge-web` is actually on `<body>`. Don't chase cache. (See `[[feedback_delivered_vs_executing]]` in memory.)

## Gotchas (each cost real time)

- `google.script.run` can't call `_`-suffixed functions — web RPCs route through `webedit_call` / `editorAuth` (no trailing underscore) per `Editor.gs`.
- HtmlService **strips HTML/CSS comments** when serving — don't grep the live page for a comment to confirm a deploy; grep for a class/id.
- Blank editor page → a `hidden`-attribute-vs-CSS-`display` override (EditorShell's `.mge-overlay[hidden]{display:none!important}` fix).

## Tours & voice (per-tool mini-tours + the setup tour)

The guided-tour ENGINE is shared in `EditorShell` — **`mgeStartTour_(steps, opts)`**, ported from `MvsApp_Help.html`. Reuse it; don't write a per-tool engine.

- **Modes:** `opts.mode === 'info'` (Next always enabled — every per-tool mini-tour) or `'gated'` (the setup tour). A gated step carries a `gate: function(){…}` predicate; Next stays disabled until it returns true. **A gated step MUST show the hint + relabel the button** (this was missing and made setup feel broken): the engine renders `ⓘ Do this step to continue` while locked and the advance button reads **"Done with this step"** — mirror MVS's `tour_gate_hint` / `tour_step_done`. A silently-disabled button is not enough.
- **Per-tool mini-tour pattern** (the proven template — Manage Items, then the other 4): a `<TOOL>_TOUR_STEPS` array of `{ sel, en:{title,body}, es:{title,body} }` (`sel:null` = centered bubble); `start<Tool>Tour()` (closes help, `mgeStartTour_(steps,{mode:'info'})`); `replay<Tool>Tour()`; `maybeAutoStart<Tool>Tour_()` (once per browser via a `mog_<tool>_tour_seen` localStorage key); a `.tour-replay-wrap` "↻ Replay walkthrough" button at the bottom of the tool's `?` help body (CSS is shared in EditorShell); and `if (MOG_WEB) maybeAutoStart<Tool>Tour_();` at the end of init. Anchor `sel` to ALWAYS-VISIBLE elements (a collapsed panel's body has a zero rect) — list containers, the panel HEADER, the save button.

**Voice = match the MVS/MPS `TOUR_STEPS_*` arrays exactly** (this is the #1 thing that drifts):
- **Titles** are short and **imperative**, or a quick question — "Pick a vendor", "Add an item", "Save to apply", "Where you count". NEVER noun labels ("Your vendors", "Three ways to look", "Manage Items").
- **Bodies** are 1–2 tight sentences that **lead with the action and name the real control** ("Tap + Add item —", "Press Save and the sheet updates"), with one em-dash "why" clause. Warm, second person.
- **NO meta-narration.** Kill "here's a quick look around — about 20 seconds" and "that's the tour"; MVS/MPS just start, and close warm ("You're all set") pointing to the `?`.
- **ES = informal tú imperative** ("Elige un proveedor", "Agrega un artículo", "Guarda para aplicar") — mirror the MVS/MPS Spanish register, not a literal EN translation.
- The home help popup orients (what the editor is + build order Vendors → Items → Areas → Shelf to Sheet + "every tool has a ?"); it does NOT list steps the user already did (use a computer / enter PIN).

## Tool status

All 5 tools re-skinned on the centralized EditorShell chrome: **Manage Items** (1500px master-detail, sortable, filter chips), **Storage Areas** (760px), **Manage Vendors** (920px), **Reorder Pick Path / Shelf to Sheet** (780px), **Order History** (read-only, 1080px). The re-skin + first-run **setup wizard** (`Setup.html`) are **live on all 9 + master**.

**Canary-only (rpfrf `/dev`), UNCOMMITTED as of 2026-06-24** — verify, then fan out with `python deploy.py --redeploy` + commit: per-tool **mini-tours** on all 5 (info mode) + the gate-**hint**/"Done with this step" engine fix + the **voice** rewrite; the **validate-first gate** (`editorPing`, re-runs init on every auth); the **`?` relocated** to a prominent breadcrumb circle (EN/ES stays in the band); Manage Items **"Recently adjusted" pill** + table-height match; the home help-popup rewrite.
