---
name: mog-pwa-audit
description: Audit the MOG PWA layer — template/index.html (~6100 lines) + template/sw.js — for latent bugs, dead code, unlocalized strings, and shell/cache hygiene, the way the 2026-05-27 session found the dead uiIsInteractive_ gate. Use when Sebastian asks to "audit the PWA", "review template/index.html", "find bugs in the app", "clean up the PWA", "is the offline/cache logic right", "check the service worker", or wants a read-through of the store-facing app rather than the Apps Script modals. ALSO trigger after a big PWA edit, to sweep for regressions. This is the PWA-layer counterpart to appsscript-codebase-audit (which covers the .gs/.html Apps Script backend). Skip for the Apps Script modals (that's appsscript-codebase-audit / mog-modal-ux-sweep) and for one specific known PWA bug fix (just fix it — don't audit the whole file).
---

# mog-pwa-audit

`template/index.html` is the store-facing PWA — a single ~6100-line vanilla-JS file plus `template/sw.js`. It's mature and well-commented, so an audit is mostly hunting for **latent** issues: gates that silently no-op after a refactor, strings that escaped localization, dead code, and cache/shell hygiene. The 2026-05-27 audit found exactly one real bug (a dead safety gate from an id-refactor) plus four small cleanups — that's the expected yield shape: a few real things in a clean file, not a pile.

## What you're auditing (and what you're NOT)

- **In scope:** `template/index.html` + `template/sw.js` only. This is the PWA layer — ships via `python build.py` + git push (GitHub Pages), **never** clasp / `--redeploy`. Bump `CACHE_VERSION` in `template/sw.js` on any shell change.
- **Out of scope:** the `apps-script/*.html` modals (→ `appsscript-codebase-audit` / `mog-modal-ux-sweep`), the `.gs` backend, the generated `<slug>/` dirs (overwritten by build — never edit; audit the `template/` source).
- **i18n note:** the PWA does NOT use a `var T = {en, es}` glossary. It localizes inline with `state.lang === 'en' ? '...' : '...'`. So `mog-i18n-parity` does NOT apply here — finding unlocalized strings is a manual grep (see below).

## Standing finding categories (where the bugs hide)

Ranked by what's actually turned up:

1. **Dead safety gates after an id/class refactor.** The canonical example: `uiIsInteractive_()` (~line 3461) is the gate that stops `maybeBackgroundRefreshDashboard_()` (~line 3483, fires on `visibilitychange`) from repainting Today under an open modal/overlay. It was checking a nonexistent `#modal-overlay` with class `.show` — but the real elements are **`#modal-backdrop`** and **`#busy-overlay`**, both of which toggle **`.open`** (not `.show`). So it always returned false and the gate did nothing. **Audit move:** for any element-id/class check, confirm the id and class still exist in the markup. Grep the id; grep the class toggle. A `getElementById` that returns null + a `classList.contains` of the wrong class = a silent no-op.
2. **Unlocalized hardcoded strings.** English words baked into a toast/label that should switch on `state.lang`. 2026-05-27 found two `' vendors'` literals (in `autoSendDailyRecap_` and `onDailySummaryClick`) showing English in Spanish. **Audit move:** grep for quoted user-facing words near `showToast`/`renderRecap`/innerHTML assignments; confirm each sits inside a `state.lang === 'en' ? … : …` (the file's own pattern — no new key needed).
3. **Undefined CSS custom properties.** `var(--something)` where `--something` isn't defined in `:root`. 2026-05-27 found `--text-1` (should be `--text`) on `.recipient-name` — latent because the values happened to coincide. **Audit move:** grep `var(--…)` usages against the `:root` definitions; any name with no definition is a typo waiting to render wrong.
4. **Leftover debug `console.log` + orphaned bindings.** e.g. `console.log('[reset] api result:', result)` in `onHomeResetClick` and the now-unused `result` it logged. **Audit move:** grep `console.log`; for each, check whether removing it orphans a variable.
5. **Stale comments after a behavior change.** `sw.js` had a comment describing stale-while-revalidate on a handler that's actually network-first. Comments don't run, but they mislead the next audit. **Audit move:** read each handler's comment against its actual control flow.
6. **`CACHE_VERSION` hygiene.** Any shell/HTML-structure change must bump `CACHE_VERSION` in `template/sw.js` (currently v8) or KMs' phones serve the old shell forever. **Audit move:** if this session changed shell markup, confirm the version bumped.

Also worth a glance but historically clean: XSS in hand-built HTML (vendor names ARE escaped at every insertion point — verify any NEW insertion does too), and the offline/network-first SW logic (sound as of v8).

## The discipline

0. **Run the deterministic pre-scan first.** Three of the finding categories below (dangling DOM-id refs, undefined CSS vars, leftover `console.log`s) are pure greps, not judgment — let the script find them so your read-through spends its attention on the categories that need a human:

   ```
   python .claude/skills/mog-pwa-audit/scripts/pwa_scan.py
   ```

   It prints, for `template/index.html`: [1] `getElementById`/`$('…')` references with no matching `id=` in the markup (the **dead-gate detector** — this is the check that catches the `uiIsInteractive_` class of bug), [2a] undefined CSS vars with **no fallback** (high signal — render as nothing, the `--text-1` class of typo), [2b] undefined vars **with** a fallback (low signal — harmless, always resolves to the fallback), and [3] leftover `console.log/debug/info` lines. Exit is **advisory** (1 if any candidates, 0 if clean) — a hit is a *candidate to eyeball*, not a confirmed bug (a dynamically-created id and a dead reference look identical to a grep; only you can tell them apart). The scanner removes the mechanical 80%; the categories below are the 20% it can't judge.

1. **Read the whole file, not excerpts.** It's ~6100 lines but cohesive; an audit that skims misses the dead-gate class of bug (the gate looked fine in isolation — only reading it against the markup revealed the mismatch). Budget for a full read of `index.html` + `sw.js`.
2. **Cross-check every DOM reference against the markup.** This is the single highest-yield move — every `getElementById`/`querySelector`/`classList` call is a claim about the HTML that may have rotted.
3. **Report findings ranked, separating real bugs from cosmetic cleanups.** The 2026-05-27 format: one "real latent bug" called out distinctly, then N minor cleanups. Don't bury the one that matters.
4. **Fix + bump + build + push.** Apply fixes, bump `CACHE_VERSION` if shell changed, `python build.py` (regenerates all 8 store dirs — confirm sw.js is uniform across them, e.g. same byte size = same version), then commit + `git push`. **No per-store canary exists for the PWA** — GitHub Pages serves all stores from one push. Verify on a live store URL after.
5. **Don't manufacture findings.** A clean file is a valid result. If a "nit" would break a layout or just trade one kind of consistency for another, leave it and say so (that's exactly what the modal-consistency pass concluded — the candidate nits weren't worth touching).

## Composition with other skills

- [[appsscript-codebase-audit]] is the backend counterpart (the `.gs` + modal layer); this skill is the PWA-layer twin. Same ranked-punch-list spirit.
- [[mog-deploy-workflow]] confirms the PWA deploy path (build.py + git push, never clasp). Run its router on `template/index.html` if unsure.
- [[mog-cheatsheet]] has the `build.py` commands.
- [[surgical-patch]] / [[source-of-truth-verification]] govern the actual edits once findings are confirmed.
- [[mog-session-handoff]] captures the audit outcome + any new caveat for the next session.
