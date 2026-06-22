# Session Handoff — KM web editor (Phase 1)

**Session date:** 2026-06-21
**Session focus:** Build the parked KM-editor feature — let KMs edit store data without opening the Google Sheet, computer-only + PIN-gated, MVS/MPS-style.
**Outcome:** Shipped a working web editor at the existing `/exec` URL (`doGet?page=…`) with **5 live tools** — Manage Items, Manage Vendors, Storage Areas, Reorder Pick Path, Order History — plus an MVS-faithful home dashboard, concept-themed PIN login, EN/ES toggle, and breadcrumbs. **3 commits, canary rpfrf ONLY. NOT pushed to GitHub, NOT fanned out.** Sebastian confirmed all 5 cards work.
**Next session focus:** Polish — now that each tool is a standalone web page (no longer boxed in a fixed Sheet modal), rethink each tool's layout/density/visuals; then the guided tour; then fan out.

---

## What shipped

**The architecture (the part not to re-litigate):**
- **`doGet` page routing** (`MOGApi.gs`): `?page=editor` → home dashboard, `?page=items|vendors|areas|pickpath|history` → that tool. The **default `doGet` JSON path is byte-identical**, and the PWA only ever POSTs (`doPost`), so the ordering app is completely unaffected. Verified: phones confirmed unaffected after every redeploy.
- **Dual-host modals (one source of truth, two hosts):** each existing modal (`ManageItems.html`, `ManageVendors.html`, `StorageAreas.html`, `ReorderPickPath.html`, `OrderHistory.html`) now serves BOTH the in-Sheet dialog AND the web page. A `MOG_WEB` flag (injected via `webBootJson`) gates the web-only bits; the Sheet launchers inject `web:false` so the dialog behaves exactly as before. **Parity is by construction — no second copy to drift.**
- **`Editor.gs` (new module):** `renderEditorHome_` + one `render<Tool>Web_` per page; `editorAuth(pin)` (token-backed PIN, reusing the existing `checkPin_` + lockout machinery); `requireEditorToken_`; and **one allowlisted dispatcher `webedit_call(token, fnName, args)`** that EVERY web RPC routes through. The `webeditDispatch_` switch IS the security allowlist.
- **`EditorShell.html` (new, shared):** concept-themed PIN login (real brand logo recolored via `currentColor` + accent from `dashTheme_()`), device gate (computer-only), EN/ES toggle, breadcrumb chrome, and the shared `mge*` gate JS. Included at the **top of `<body>`** on every editor page.
- **`EditorHome.html` (new):** home dashboard copied faithfully from the **MVS** design system (Inter, accent header with pill EN/ES toggle, 880px container, fixed 3-col tile grid, `--shadow` centered icon tiles, section labels) + a "Have a question?" help CTA banner with a bilingual help popup.
- **Client RPC shim `MIRPC()`** in each dual-host modal: in the Sheet it returns `google.script.run`; in the web app it returns a chainable proxy that prepends the session token and routes through `webedit_call`. The modal's call sites were swapped `google.script.run` → `MIRPC()`.

**Tools live (canary rpfrf):** Manage Items, Manage Vendors, Storage Areas, Reorder Pick Path, Order History (read-only). **Admin Reset deliberately left Sheet-only** (destructive; decided not to expose a reset to KMs from the web) — its tile was removed from the home.

**Deploys:** `python deploy.py --redeploy --target rpfrf` (canary only, ~10 iterations across the session). No fan-out.

## Gotchas worth remembering (cost real debugging time)

- **`google.script.run` cannot call functions whose names end in `_`.** That's why the client-callable server fns are `editorAuth` / `webedit_call` (no trailing underscore) while internal helpers keep theirs.
- **The `hidden` attribute loses to a class that sets `display`.** `.mge-overlay { display:flex }` overrode the UA `[hidden]{display:none}`, so the gate overlay stayed on top of the modal pages → blank screen (the home masked it via its own `[hidden]{display:none !important}`). Fixed with `.mge-overlay[hidden], .mge-crumb[hidden] { display:none !important }` inside `EditorShell` so the gate is host-independent. **If a new editor page goes blank, suspect a `hidden`-vs-display override first.**
- **Session token shared across pages via `localStorage`** (`mog_edit_token`) — reliable in this sandbox (the item cache already uses localStorage). PIN once on the home, navigate to a tool, no second prompt. Optimistic: a stale token just fails the first call (`SESSION_EXPIRED`) → reprompt.
- **Inter-page links use `target="_top"` + an injected `BASE_URL`** (`ScriptApp.getService().getUrl()`), because relative links resolve against the googleusercontent sandbox iframe, not `/exec`.
- **Modal height models differ** — Items + Order History use `height:100%`+`overflow:hidden` and needed a `body.mge-web { display:flex; … }` override to fit the breadcrumb; Vendors + Storage Areas are already `100vh` flex-column; Pick Path has no body height. Check the height model before adding the breadcrumb bar.
- **Brand logo SVGs must be copied byte-exact** — hand-truncating paths mangles the letterforms. They were extracted programmatically from `template/index.html` into `EditorShell.html` (all 4 concepts).

## Outstanding (carry forward)

- **NOT pushed to GitHub** — the 3 editor commits are local on `main` only. Safe to push anytime (push touches neither the stores nor the PWA; no `template/` files changed). Push when ready to back up.
- **NOT fanned out** — only canary **rpfrf** has the editor. Fan-out is `python deploy.py --redeploy` (no `--target`); **canary-first is already satisfied**, so the remaining step is just the all-targets redeploy on Sebastian's go.
- **Guided tour deferred** — now worth building (real tools to walk through, not placeholders). Use the global `appsscript-guided-tour-help` pattern; the shell already has `#mge-*` mounts and `[data-tour]`-able controls.
- **Dead-code side-task still open** (from the prior 2026-06-19 session, unrelated to the editor): confirm whether `showAdminResetSidebar` / `goToOrderEntry` / the 3 `toggle*Visibility` fns are dashboard-button-assigned (Sheet-side, invisible to grep), then delete the unwired ones.

## Files touched this chat

- **New:** `apps-script/Editor.gs`, `apps-script/EditorShell.html`, `apps-script/EditorHome.html`.
- **Backend edits:** `apps-script/MOGApi.gs` (doGet routing), `apps-script/Items.gs`, `apps-script/Vendors.gs`, `apps-script/PickPath.gs`, `apps-script/History.gs` (each launcher injects `webBootJson: {web:false}`).
- **Modal edits (dual-host):** `apps-script/ManageItems.html`, `apps-script/ManageVendors.html`, `apps-script/StorageAreas.html`, `apps-script/ReorderPickPath.html`, `apps-script/OrderHistory.html`.
- **Discarded mid-session:** an early Phase-1a stub (`MogEditor*.html`) + per-fn `webedit_*` wrappers — superseded by the dual-host + single-dispatcher approach.
- **Deploys:** `deploy.py --redeploy --target rpfrf` only. No `build.py`, no PWA change.

## Commits landed this session

```
1a3a799 feat(editor): add Storage Areas, Reorder Pick Path, Order History cards
fe47a12 feat(editor): Manage Vendors card, help banner, tab title; fix blank-modal overlay
4b5c353 feat(editor): computer-only PIN-gated KM web editor (Phase 1 base)
```
(Plus this handoff as a follow-up `docs:` commit. None pushed to origin yet.)

## Opening prompt for next session

```
Read docs/MOG_CurrentState.md first. Last session built the KM web editor
(Phase 1): a computer-only, PIN-gated web app at the existing /exec URL via
doGet?page=…, with 5 live tools (Manage Items, Manage Vendors, Storage Areas,
Reorder Pick Path, Order History), an MVS-style home dashboard, concept-themed
login, EN/ES, and breadcrumbs. Each tool's modal is now DUAL-HOST (serves both
the Sheet dialog and the web page via a MOG_WEB flag); all web RPCs route
through one token-guarded allowlist dispatcher (webedit_call in Editor.gs).
It's deployed to canary rpfrf ONLY — not pushed to GitHub, not fanned out.

Next focus: POLISH. Now that each tool is a standalone web page (not boxed in a
fixed Sheet modal), rethink each tool's layout/density/visuals one at a time.
After that: the guided tour (appsscript-guided-tour-help pattern), then fan out
to all 9 (deploy.py --redeploy, no --target — canary already done).

Gotcha to remember: a blank editor page usually means a `hidden`-attribute-vs-
CSS-display override (see EditorShell's .mge-overlay[hidden] fix); and
google.script.run can't call _-suffixed functions.
```

---

## Later session — Manage Items + Storage Areas web polish

**Session focus:** Bespoke per-tool web polish of the KM editor (Sebastian's "rethink each tool now it's a standalone page") — Manage Items first, then Storage Areas.
**Outcome:** Both tools fully re-skinned and shipped to canary rpfrf `/dev`; Sebastian confirmed each. Captured the repeatable recipe as a new skill. Still rpfrf-only — not pushed, not fanned out.
**Next session focus:** Same recipe on the remaining three — Manage Vendors, Reorder Pick Path, Order History (read-only, lightest).

### What shipped (canary rpfrf only, each via `deploy.py --redeploy --target rpfrf`)

**The fix that unblocked everything:** each modal's `setLang()` did `document.body.className = 'lang-'+lang`, which **wipes the `mge-web` class the whole re-skin is gated on** — so the new CSS was *delivered* (curl/clasp confirmed) but never *activated* (page looked like the old dialog). Fixed in both modals to toggle only the lang class. **Every remaining tool's `setLang` has the same bug — fix it FIRST.**

**Manage Items** (`ManageItems.html`):
- Web re-skin (all `body.mge-web`-gated): concept-accent header band (lang/help relocated in), centered 1500px master-detail column, Inter, cards/`--shadow`, quiet footer.
- On Sheet + Par Review now **sortable** (`sortValue_` ranks the derived states); Mult already was.
- Layout rework: tabs → an `Item details | + Add item` toggle above the sidebar; View All + Inactive tabs replaced by left **filter chips** (All active / Unassigned / Inactive, with counts); **"All active" excludes inactive** (they show only under the Inactive chip).
- **New badge** (client-side per-store first-seen, ~7 days).
- **In-place add/edit/delete** (no full reload): preserves place, auto-centers + flashes the affected row; blank sidebar after add; null-safe delete removal.
- Server (`Items.gs`): `clearDataValidations()` on the A:G block in `commitUpsertItem` add+edit — fixes the "cell B43 violates data validation" add failure (`insertRowAfter` inherited a stray rule on the NAME column).

**Storage Areas** (`StorageAreas.html`):
- Web re-skin (`body.mge-web`-gated): accent band, centered 760px column, card list, **always-visible Add-area row**, **sticky Save footer**, web-only intro. Draft/Save model preserved exactly.

**Skills/docs:**
- NEW **`mog-editor-web-reskin`** — turnkey per-tool recipe (setLang fix → web chrome → web-gated CSS + 0-bleed check → in-place/validation patterns → `/dev` iterate). Registered in `CLAUDE.md`.
- ENHANCED **`mog-deploy-workflow`** — `/dev` (live HEAD, iterate here) vs `/exec` (public CDN-cached snapshot); editor canary = **rpfrf**; "deployed but not rendering = runtime, not deploy."
- Memory: `feedback_delivered_vs_executing`.

### Outstanding (carry forward)

- **Remaining 3 tools** — Manage Vendors, Reorder Pick Path, Order History. Use `mog-editor-web-reskin`; **fix each `setLang` clobber first.** Order History is read-only → lightest.
- **Still canary rpfrf only** — not pushed, not fanned out. The 3 Phase-1 commits + this session's work are all unpushed.
- **Then:** guided tour (`appsscript-guided-tour-help`) → fan out (`deploy.py --redeploy`, no `--target`) → `git push`.
- **Iterate on `/dev`**, never `/exec`.

### Files touched (later session)

- Source: `apps-script/ManageItems.html`, `apps-script/StorageAreas.html`, `apps-script/Items.gs`.
- Skills/docs: NEW `.claude/skills/mog-editor-web-reskin/SKILL.md`; `.claude/skills/mog-deploy-workflow/SKILL.md`; `CLAUDE.md` (skills table); this handoff; `docs/MOG_CurrentState.md`.
- Deploys: `deploy.py --redeploy --target rpfrf` (canary only). No `build.py`, no fan-out, no push. Uncommitted at handoff time.

### Opening prompt for next session (polish continuation)

```
Read docs/MOG_CurrentState.md first. We're polishing the KM web editor tools
bespoke per tool (web-gated body.mge-web re-skin; the in-Sheet dialog stays
untouched). Manage Items + Storage Areas are DONE on canary rpfrf /dev. Next:
Manage Vendors, Reorder Pick Path, then Order History (read-only, lightest) —
follow the mog-editor-web-reskin skill, and FIRST fix each modal's setLang (it
does document.body.className = 'lang-'+lang, which wipes the mge-web class and
silently disables the whole re-skin). Iterate on the /dev URL (live HEAD), not
/exec (CDN-cached snapshot). Deploy: python deploy.py --redeploy --target rpfrf.
Still rpfrf-only — not pushed, not fanned out. After all tools: guided tour,
then fan out, then git push.
```
