# Session Handoff — Editor tours/scroll + titlebars + no-re-PIN + tnytf fix + globalized MVS lessons

**Session date:** 2026-06-26
**Session focus:** Resolve the open editor threads (mini-tour fire policy, natural-scroll, "B" titlebars), kill the per-tool re-PIN friction, fold the MVS/MPS-fidelity lessons into the global skills, and fix a latent tnytf deployment mismatch found along the way.
**Outcome — ALL shipped to all 9 + master and committed/pushed (3 mog-mobile commits):**
- **(1) Fire policy** — per-tool tours replay-only; **home flow-tour also made replay-only** (was auto-popping on every editor open); only the gated setup-wizard tour still auto-fires (new store only). **Fanned out + committed.**
- **(2) Natural-scroll** (Vendors/Areas/History header band scrolls away) + **"B" persistent titlebars** on the 4 non-Items tools. **Fanned out + committed (`c744c71`).**
- **(3) No re-PIN across tools** — the editor session token now rides the URL between pages (`?t=`), read back via `google.script.url.getLocation` + `editorPing`; PIN once per session. Root cause: the HtmlService sandbox doesn't keep `localStorage` across a `?page=` navigation. **Fanned out + committed (`8367a7a`).**
- **(4) tnytf backend mismatch** fixed (PWA) — repointed off an orphaned `/exec` to the maintained deployment + cache bump v21. **Committed + pushed (`d200e75`).** *Live-verify (run an order at `sebheh.github.io/mog-mobile/tnytf/`) still pending.*
- **(5) MVS-fidelity lessons** applied to 4 global skills (device) + mirrored to the canonical `personal-web` bucket; `Claude-SKills` repo **uncommitted** (Sebastian's separate session), `_personal/` untouched.
- Deploy-iteration discipline **reversed** (redeploy-the-canary + open its `/exec`, not `/dev`); `CLAUDE.md` gained a **global-skill-governance** rule.

**Next session focus:** Live-verify tnytf (run an order); commit the `Claude-SKills` `personal-web` mirror + decide on `_personal/`; then the optional editor backlog.

---

## What shipped

- **Mini-tour fire policy → per-tool tours are REPLAY-ONLY.** Removed the `maybeAutoStart…_()` init call from all 5 tools (`ManageItems`/`ManageVendors`/`OrderHistory`/`ReorderPickPath`/`StorageAreas`); each call became a comment documenting the decision + the one-line re-enable, and the `maybeAutoStart…_` functions stay as the lever. The `↻ Replay walkthrough` button in each tool's `?` help is untouched, so every tour is still reachable. **Later in the session the home flow-tour was ALSO made replay-only** (it was auto-popping on every editor open — friction for KMs; replay via the home `?` help). **Only the gated setup-wizard tour still auto-fires**, and only on a brand-new unconfigured store. (Decisions: Sebastian chose "per-tool → replay-only," then "home tour → replay-only too, keep setup tour.")
- **Tools now scroll like Manage Items (header band scrolls away, not pinned).** The 3 height-locked tools were unlocked to natural page scroll:
  - `ManageVendors.html` — `html.mge-web`/`body.mge-web` unlock + release `.scroll-body`.
  - `StorageAreas.html` — same unlock + release `.body`; **Save footer pinned to the viewport bottom** (`position:sticky;bottom:0` + solid `var(--page)` bg) so it stays reachable on a long list.
  - `OrderHistory.html` — same unlock + release the nested `.content-area`/`.tab-panel`/`.table-wrap`/`.hist-detail`/`.hist-detail-list` scrollers so the page is the single scroller.
  - Each tool's init gained `document.documentElement.classList.add('mge-web')` (activates the `html.mge-web` rule). All scoped to `mge-web` → Sheet dialogs byte-unchanged. **Shelf to Sheet (ReorderPickPath) was already natural-scroll** (body not height-locked, header `position:static`) — left alone, confirmed fine.
- **"B" persistent titlebars on the 4 non-Items tools.** Title + one-line bilingual subtitle above each tool's content, matching Manage Items. **Centralized the `.web-titlebar`/`.web-title`/`.web-subtitle` CSS in `EditorShell`** (self-centers per tool via `--shell-width`) and **removed Manage Items' now-duplicate local copy** (identical values → Items unchanged). Added markup to `ManageVendors` (top of `.scroll-body`), `StorageAreas` (top of `.body`), `ReorderPickPath` (before `.header`), `OrderHistory` (top of `.shell`). Copy follows the Items voice (what it is + why it matters, informal *tú* in ES); `.en`/`.es` spans ride the existing lang toggle (no JS change).
- **No re-PIN across tool pages (`EditorShell`, fanned out + committed `8367a7a`).** Symptom: a KM PINs in on the editor home, then gets re-prompted on Manage Items (and every tool). **Root cause:** each tool opens via a full top-level `?page=` navigation, and the gate read the session token only from `localStorage` — but the HtmlService sandbox (`*.googleusercontent.com` iframe) does **not** reliably keep `localStorage` across a `?page=` navigation, so the token written on the home page wasn't found on the tool page. **Fix (EditorShell-only):** `mgeDecorateLinks_()` appends the validated token to every internal editor link (`?…&t=<token>`) after auth + in `setBreadcrumb_`; `mgeStartGate_` now tries stored token → **URL token** (`mgeTokenFromUrl_` via `google.script.url.getLocation`, validated by the existing `editorPing`) → PIN. PIN once per session, navigate freely. **Trade-off:** the token shows in the URL/history (the sandbox can't rewrite the top URL to strip it) — acceptable for a short-lived, sliding-TTL, PIN-derived token on an anonymous-access internal tool; same exposure class as the `localStorage` copy. Server (`Editor.gs`/`MOGApi.gs`) untouched — reuses `editorPing` + the script-wide `CacheService` token store.
- **Deploy-iteration discipline REVERSED** (`mog-deploy-workflow/SKILL.md` + memory `feedback_editor_iterate_on_dev`): the old "never `--redeploy` to iterate, use `/dev`" rule was a workaround for the *pre-gate brick*. The validate-first gate (shipped 2026-06-24) makes a token flush recover via re-PIN, so **iterate by `--redeploy`-ing the canary and handing Sebastian the bare `/exec` HOME link** — he tests on `/exec`, not `/dev` (push-only doesn't update `/exec`). The only cost of a canary redeploy now is re-entering the PIN.
- **Globalized the MVS/MPS-fidelity lessons** into 4 global skills (device copies in `~/.claude/skills/`):
  - `appsscript-guided-tour-help` — fire-policy rule (one orientation tour auto-fires, detail tours replay-only); gate-hint paragraph ("Do this step to continue" + "Done with this step", not a silently-disabled Next); prominent-`?` rule (filled-accent circle next to the title, EN/ES on its own control).
  - `appsscript-phrasing-glossary` — new "Tour & help copy voice" subsection (imperative title naming the action, action-first body naming the control + em-dash why, warm close, NO meta-narration like "~20 seconds", ES informal tú).
  - `appsscript-first-run-setup` — validate-first session-gate hard rule (CacheService tokens flush on a new deployment version → validate server-side before running, re-run init on every auth).
  - `architectural-walkthrough` — "Porting from a reference implementation" rule (default to fidelity, flag each divergence as a risk).
  - **Mirrored to the canonical repo:** the 4 edits were copied into `Claude-SKills/personal-web/<skill>/SKILL.md` (verified byte-identical to the device copies). `personal-web/` is the authoritative bucket — `sync-skills.ps1` (→ device) and `package_skill.py` (→ claude.ai zips) both read the buckets, not `_personal/`. **Left untouched:** `_personal/` (a separate committed "mirror" per `.gitignore` — already differs from the buckets, names the glossary `bilingual-phrasing-glossary`, and had a large pre-existing dirty tree); and the `Claude-SKills` commit (Sebastian will review in a dedicated session).
- **Fixed a latent tnytf backend mismatch (PWA layer).** `stores.json` pointed tnytf's PWA at deployment `AKfycbzkLs…/exec`, which **is not a deployment of tnytf's current script project** (`clasp deployments` shows only `@HEAD` + `AKfycbwu…@23`) — an orphan from the 2026-05-26 script-project migration. **Consequence:** every `MOGApi.gs`/`api_*` change since that migration `--redeploy`'d `AKfycbwu…` but the tnytf PWA called the orphan, so tnytf's phones ran stale backend code. Fix: repointed `stores.json` tnytf → `AKfycbwu…/exec` (Sebastian-confirmed canonical), bumped `CACHE_VERSION` v20→v21 (the API URL is baked into the cached `index.html`, so phones must evict), `python build.py` (only `tnytf/index.html` changed among the index files; all 8 `sw.js` got v21). **Verify: open `sebheh.github.io/mog-mobile/tnytf/` and run an order** — confirm the backend now responds with current behavior.
- **Added a global-skill-governance rule to `CLAUDE.md`** (after the Skills tables): the skills under `~/.claude/skills/` are owned by the **Claude-SKills** repo — do NOT edit/create them directly in this repo; instead invoke the **`global-skill-governance`** skill to file a proposal into the mailbox (`~/.claude/skills/_global-skill-proposals/`) for the Claude-SKills repo to apply + re-sync. Repo-local `./.claude/skills/` specializers stay editable in place. **Note:** this session's own global-skill edits (the 4 device copies + the `personal-web` mirror) predate the rule and were **left as-is** by decision — Sebastian folds them in during his Claude-SKills session. Going forward, global-skill changes from this repo go through a proposal.

## Outstanding (carry forward)

- **Live-verify tnytf.** The fix is committed + pushed (`d200e75`) and live on GitHub Pages; still confirm by opening `sebheh.github.io/mog-mobile/tnytf/` and running an order (it was on stale backend code before).
- **`Claude-SKills` repo — dedicated session.** The 4 `personal-web` edits are mirrored but **uncommitted**, sitting alongside a large pre-existing dirty tree. Sebastian will review/commit there separately and decide whether `_personal/` (the divergent mirror, `bilingual-phrasing-glossary` naming) needs reconciling.
- **Editor backlog** (unchanged, all optional): ManageVendors Edit-form "Advanced" disclosure (gated on the Vendor Cadence Audit run); real per-concept brand SVGs on the hub; Batch D (brand fonts / concept-aware modal theming).

### Operational gotcha — sharing the KM editor `/exec` link

A KM hit a Google "service error" opening the editor; **the deployment was fine** (verified anonymous access serves the editor page). Two real causes, both on the recipient's side:
- **Opened from inside a messaging app / Facebook/Messenger** (the link gets wrapped + opened in an account-bound in-app browser). → open it in a **real browser** (paste the raw link into Chrome).
- **Multiple Google accounts logged in** — a published `/exec` URL has no `/u/N/` index, so Google can't disambiguate and errors. → **Incognito**, or sign out of extra accounts, or hand out the account-pinned form `script.google.com/u/0/macros/s/<id>/exec`.
- And remember the editor is **desktop-only + PIN-gated** — KMs need a computer + the store PIN. Best channel for KM links: email / paste-into-Chrome, not a chat app.

## Files touched this chat

- **Editor HTML (`apps-script/`):** `EditorShell.html` (centralized `.web-titlebar` CSS; **URL token handoff** — `mgeDecorateLinks_`, `mgeTokenFromUrl_`, `mgeTryToken_`, rebuilt `mgeStartGate_`, `mgeRunCb_` + `setBreadcrumb_` decorate calls); `EditorHome.html` (**home flow-tour → replay-only**); `ManageItems.html` (replay-only comment + dropped local titlebar CSS); `ManageVendors.html` (replay-only + natural-scroll + init + titlebar markup); `OrderHistory.html` (replay-only + natural-scroll + init + titlebar markup); `ReorderPickPath.html` (replay-only comment + titlebar markup); `StorageAreas.html` (replay-only + natural-scroll + sticky footer + init + titlebar markup).
- **Repo skill:** `.claude/skills/mog-deploy-workflow/SKILL.md` (editor-iteration section rewritten).
- **Canonical skills repo (`Claude-SKills`, uncommitted):** `personal-web/{appsscript-guided-tour-help, appsscript-phrasing-glossary, appsscript-first-run-setup, architectural-walkthrough}/SKILL.md` mirrored from the device copies.
- **PWA layer (tnytf fix):** `stores.json` (tnytf deployment URL), `template/sw.js` (CACHE_VERSION v20→v21), and `build.py` output — `tnytf/index.html` + all 8 `<slug>/sw.js` regenerated.
- **Global skills (device copy, `~/.claude/skills/`):** `appsscript-guided-tour-help`, `appsscript-phrasing-glossary`, `appsscript-first-run-setup`, `architectural-walkthrough`.
- **Memory:** `feedback_editor_iterate_on_dev.md` rewritten (+ MEMORY.md index line).
- **Docs:** this handoff; `CLAUDE.md` (@-import bump + new "Global skills are governed" section); `MOG_CurrentState.md` row + pinned focus.
- **Deploys:** canary `rpfrf` (push, then `--redeploy` ×2), then full `deploy.py --redeploy` (all 9 + master, every target OK). No `build.py` / PWA / hub changes. No new OAuth scopes.

## Commits landed this session

```
8367a7a feat(editor): carry session token across tool pages so no re-PIN
d200e75 fix(pwa): repoint tnytf to its maintained /exec deployment
c744c71 feat(editor): replay-only tours + natural scroll + persistent titlebars
```
(All pushed to origin/main. The Claude-SKills `personal-web` mirror is a separate, still-uncommitted repo.)

## Opening prompt for next session

```
Read docs/MOG_CurrentState.md first. The KM web editor is fully shipped to all 9 +
master and committed (3 commits: c744c71, d200e75, 8367a7a). State: per-tool tours
AND the home flow-tour are replay-only (only the gated setup-wizard tour auto-fires,
new-store only); Vendors/Areas/History scroll the whole page like Manage Items;
all 4 non-Items tools have a persistent title+subtitle; and you PIN once per session
then move between tools with no re-PIN (the session token now rides the URL ?t= and
is read via google.script.url.getLocation + editorPing).

Remaining:
1. Live-verify tnytf — its PWA was repointed off an orphaned /exec deployment
   (committed+pushed d200e75); open sebheh.github.io/mog-mobile/tnytf/ and run an
   order to confirm it's on current backend code.
2. Claude-SKills repo (separate session) — 4 personal-web/*/SKILL.md edits mirrored
   but uncommitted, amid a pre-existing dirty tree; decide on _personal/.
3. Optional backlog: ManageVendors Edit-form "Advanced" disclosure (gated on the
   Vendor Cadence Audit run); per-concept brand SVGs on the hub; Batch D.

Deploy discipline: iterate by --redeploy-ing the canary (rpfrf) and opening its bare
/exec HOME link — NOT /dev (push-only doesn't update /exec); validate-first gate makes
redeploy safe. Pull + confirm clean git status before deploying. Never hand a ?page=
deep link — bare /exec only. Sharing editor links to KMs: real browser (not a chat
app's in-app browser), Incognito or /u/0/-pinned if they have multiple Google accounts;
editor is desktop-only + PIN-gated.
```
