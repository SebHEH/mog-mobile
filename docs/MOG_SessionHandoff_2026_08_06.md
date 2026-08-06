# Session Handoff — PWA outage fix, pull-to-refresh, and self-updating installs

**Session date:** 2026-08-06
**Session focus:** Started as an urgent outage on Roll Play Rosslyn BOH (a KM staring at raw Google HTML on the PIN screen); became a full pass on how the PWA recovers from transient failures and how it keeps itself current.
**Outcome:** Eight commits, all pushed, PWA at **v49** on all 8 stores. The backend was never touched — no clasp, no `--redeploy`. A latched forced-reload migration is live and converting stale installs on browsers' own schedule.
**Next session focus:** `git stash pop` the parked perf batch after a clean morning reset, then the per-vendor Emergency Override day picker.

---

## Section A — The rpr outage (`3db6b09`, v43)

A KM at Rosslyn BOH couldn't sign in. The PIN box showed ~200 characters of Google error-page markup: `BAD_JSON: <!DOCTYPE html>…window['ppConfig'] = {productName: '…'`.

**It was NOT a rotted deployment, and nothing was repointed.** Measured at the time:

- `?page=api` GET: clean JSON, 2.0s
- POST: **18/18 clean JSON**, sub-second, across three rounds
- A *retired* deployment answers `<title>Page Not Found</title>` — a different signature, so the phone was not hitting a dead URL
- rpr's `/exec` last changed 2026-05-12, but the screenshot showed the brand-logo PIN screen that shipped 06-19, so that install's shell postdated the change

So: a transient Google **delivery** flake — the serving layer returned an HTML page instead of the JSON body for a request the script had already handled.

What turned a blip into an outage was the client. `api('ping')` retried **once, 700ms later**, so both attempts landed inside the same blip, and `handlePinSubmit`'s final `else errEl.textContent = m` printed the raw response.

Fixed: three attempts with escalating backoff (700ms, 1400ms — ~2.1s covered instead of 0.7s), and a `BAD_JSON` branch showing *"The server hiccupped. Tap Sign in again."* with the detail sent to the console. Plus a backstop so no unrecognized server string containing `<` or over 120 chars is ever rendered raw. Writes are still never retried.

**Probe technique worth reusing:** `doPost` returns `{ok:false,'Invalid JSON body'}` *before* the lockout check and before `checkPin_`, so POSTing a malformed body exercises the full POST + delivery path with **zero** risk of tripping the store's shared 5-minute PIN lockout. That is how the 18 probes were run without a PIN.

One mid-diagnosis overcall, recorded: an apparent "flake" on rpfrf was my own single-use echo URL expiring, not a store fault.

## Section B — Pull-to-refresh (`ed5a8df` v44, `32389d9` v45)

A home-screen install runs standalone (`apple-mobile-web-app-capable` + manifest `display:standalone`), so there is **no browser chrome and no reload path** — and because `body` sets `overscroll-behavior:none`, there was no native pull-to-refresh in a browser tab either.

Shipped on `#scroll-area`, the single scrolling container for all nine in-app views. **Soft refresh, not `location.reload()`:** each view re-runs its own authoritative loader with its cache dropped.

`refreshCurrentView_` has a real branch per view. `count` and `review` share `revalidateOrderItems_` — the old `revalidateCountItems_` parameterized by view, so the two paths can't drift; it preserves typed counts and won't yank a focused input. `settings` reads no server data, so a pull there is the version check alone.

Also added: a **"Reload the app"** button on the PIN screen, revealed only after a failed sign-in. That screen is the one place a KM can get genuinely wedged — no chrome, no session, and the gate's Refresh (`stale-reset-btn`) is downstream of auth so they never reach it.

Design notes worth not re-litigating: the pill is **fixed-position, not content-pushing** (translating the scroll container fights `-webkit-overflow-scrolling` momentum and the sticky topbar); the gesture is **inert while the busy/transition overlay is up** (the z-80 lesson from 08-03); listeners are passive and ignore touches starting on a control.

## Section C — Self-updating installs (`28169c9` v47, `eccfde6` v48, `5bea4af` v49)

**The real problem behind "the caching being old."** An iOS home-screen install *resumes from memory* rather than re-navigating, so a session runs its launch-time code until iOS evicts it — potentially weeks. Perversely, the most-used app is the least likely to be evicted, so the most active KMs went the stalest.

Three parts:

1. **The PIN now survives a reload.** `tryPin` mirrors it into `sessionStorage` (`mog_pin_session`); boot restores and **re-validates it server-side** via the same ping the master-PIN path uses, so a stale value is discarded rather than trusted. Cleared on `signOut` and on `switchStore_` — **`sessionStorage` is scoped per ORIGIN, not per path**, and all 8 stores share `sebheh.github.io`. This is materially different from the 2026-05-26 removal of the localStorage `mog_pin`, which survived app restarts and reboots; that value is still wiped at boot. Without this, every update prompt cost a re-PIN, which is a prompt KMs would rationally ignore.
2. **Updates apply themselves when free.** `maybeAutoUpdate_` reloads without asking when nothing is in progress — no dirty counts, no half-edited recipients, and either the PIN screen or the today view. Also checked on `visibilitychange`, so foregrounding is itself an update opportunity. The tap-to-reload pill remains for genuinely unsafe moments.
3. **A forced migration for installs too old to help themselves.** The graceful path only exists in v47+; a v43 client has no version check at all and page code can't reach it. But **`sw.js` is fetched and updated by the browser independent of the page's age**, so new worker code runs there. After `clients.claim()`, `client.navigate(client.url)` forces a re-navigation, and network-first navigation lands it on current code.

**The latch (`5bea4af`) is the important refinement.** v48 gated the hammer on a boolean alone, which meant every future `CACHE_VERSION` bump would re-reload everyone until someone remembered to disarm. Each client now records `FORCE_RELOAD_ID` once migrated and is never force-reloaded for that id again. Consequences: leaving it armed **cannot** double-reload anyone, forgetting to disarm is harmless, and a genuinely new migration requires deliberately changing the **id**.

The latch lives in its own version-independent cache added to the activate allow-list — without that exemption the existing "delete every `mog-*` cache not in the allow-list" cleanup would evict it every deploy and silently void the guarantee. It's written **before** navigating, since `navigate()` can end the worker's execution context mid-await.

Cost by population when the hammer lands: **pre-v47** keeps typed counts (drafts written per keystroke, re-seeded since `fb89ac5`) but hits the PIN screen once, since that code never wrote the sessionStorage mirror; **v47** is reloaded but keeps its session; **v48+** can answer the busy-check so future uses skip anyone mid-task.

### Two corrections I made to my own advice, recorded so they aren't repeated

- I first said to **disarm immediately after** the migration deploy. That was wrong and would have defeated it — stale clients only convert when their browser next fetches `sw.js`, on its own schedule (~24h). Disarm early and the stragglers never see the armed worker.
- With the latch in place there is **no urgency to disarm at all**. Staying armed is now the *safer* choice: stragglers keep converting while everyone already migrated is skipped.

## Section D — Landed the 2026-08-03 docs (`049408d`)

That session shipped its code but ended before its documentation commit, leaving the tree carrying an inconsistency: `CLAUDE.md`'s `@-import` already pointed at `MOG_SessionHandoff_2026_08_03.md` while that file was untracked. Committed together, which is what resolves it. Docs and skills only — verified no `sw.js` / `index.html` / store dirs, so it could not disturb the in-flight migration.

---

## ⚠ Do NOT "fix" the migration id

`FORCE_RELOAD_ID` reads `'2026-08-05-v48-stale-install-migration'` but the migration actually deployed on **2026-08-06**. The date in that string is a cosmetic misnomer and is **functionally irrelevant** — it is an opaque identifier, nothing parses it.

**Changing it re-fires the hammer on every client, including everyone already migrated.** Leave it exactly as-is. The only reason to ever change it is a deliberate new migration.

## Outstanding (carry forward)

1. **Re-land the parked perf batch** — `git stash pop` on `stash@{0}` (history reader slicing, dashboard log-read slicing, unified reset sweep, async recap, plus the Override recap-filter correctness fix). All four were differential-tested output-identical; the 08-03 revert was precautionary, not a defect. **Canary first** (`python deploy.py --redeploy --target rprfo`), smoke-test, then fan out — and **not right before an ordering window**, since a fan-out flushes every store's `CacheService`.
2. **Per-vendor Emergency Override day picker** — design approved 08-03, four decisions recorded there (per-vendor SETUP state, clears each cycle, no escape hatch yet, in-Sheet H2 must follow).
3. **TABNAME/SHEETGID cleanup** — both hit DEADLINE_EXCEEDED during resets and both values are static.
4. **Vendor switching** — still the biggest unaddressed speed complaint (sequential prefetch, ~2s floor each).
5. **Disarm `FORCE_CLIENT_RELOAD`** — hygiene only now, no deadline. A week or two out, once conversions have clearly tailed off. Set the boolean to `false`; do **not** touch the id.
6. **Verify the forced migration actually converted people.** Nothing measures this today — the only signal would be KMs no longer reporting stale behavior. If it matters, that's a real gap worth a deliberate check.
7. Next audits: code resumes at **#20**, visual at **A11**. Tier-2 `onboard.py` still designed-but-unbuilt. tnytf's old orphaned deployment still needs a manual archive.

## Files touched this chat

**PWA source:** `template/index.html` (retry budget, PIN-screen error handling + reload hatch, pull-to-refresh, `revalidateOrderItems_` split, `sessionStorage` PIN mirror + boot restore, `maybeAutoUpdate_`, `wireSwBusyProtocol_`, `switchStore_`), `template/sw.js` (v42→v49, forced-reload hammer, migration latch, allow-list exemption).
**Generated:** all 8 `<slug>/` dirs via `build.py`.
**Docs:** this handoff, `docs/MOG_CurrentState.md`, `docs/MOG_LogicBlueprint.md` + `.html` (R15 session-lifetime clause), `CLAUDE.md` (@-import). Plus the 08-03 docs landed in `049408d`.
**Backend:** none. No clasp, no `--redeploy`.

## Commits landed this session

```
049408d docs: land the 2026-08-03 session close-out
5bea4af fix(pwa): latch the forced client reload so it can only ever fire once per client
eccfde6 chore(pwa): one-shot forced client reload to drag stale installs onto current code
28169c9 feat(pwa): take app updates silently, and keep the KM signed in across a reload
fa4d510 chore(pwa): bump CACHE_VERSION to v46 to exercise the update prompt
32389d9 feat(pwa): pull-to-refresh on every view, plus a tap-to-reload prompt for a new app version
ed5a8df feat(pwa): pull-to-refresh on the main views and a reload escape hatch on the PIN screen
3db6b09 fix(pwa): ride out a delivery flake and stop showing KMs raw HTML at the PIN screen
```

## Opening prompt for next session

```
Read docs/MOG_CurrentState.md first. Last session (2026-08-06) was PWA-only — eight commits,
nothing backend, PWA now at v49 on all 8 stores. It started with an outage on Roll Play
Rosslyn BOH: a KM saw raw Google error-page HTML on the PIN screen. That was NOT a rotted
deployment (GET clean, 18/18 POSTs clean sub-second, and a retired deployment has a different
"Page Not Found" signature) — it was a transient Google delivery flake that the client turned
into a lockout by retrying only once, 700ms apart, then printing the raw response. Fixed with
three attempts + escalating backoff and a friendly bilingual message.

Then: pull-to-refresh on every view (soft per-view refresh, NOT location.reload — count/review
share revalidateOrderItems_ so typed counts survive), the PIN now surviving a reload via a
sessionStorage mirror that is re-validated server-side on boot, silent auto-updates when
nothing is in progress, and a LATCHED forced-reload migration in sw.js to drag pre-v47
installs forward (they can't self-update; an iOS home-screen install resumes from memory and
can run launch-time code for weeks).

DO NOT change FORCE_RELOAD_ID in template/sw.js. Its date string says 2026-08-05 but the
migration ran 08-06 — that is cosmetic and irrelevant. Changing the id re-fires the forced
reload on every client including those already migrated. FORCE_CLIENT_RELOAD is still armed
on purpose; disarming is hygiene with no deadline, and staying armed keeps converting
stragglers.

FIRST THING: git stash pop — stash@{0} holds the four-part perf batch (history reader
slicing, dashboard log-read slicing, unified reset sweep, async recap + the Emergency-Override
recap-filter correctness fix). All differential-tested output-identical; the revert was
precautionary. Canary rprfo, smoke-test, fan out — but not right before an ordering window,
since a fan-out flushes every store's CacheService.

Then the per-vendor Emergency Override day picker (design approved, four decisions in the
08-03 handoff). Also open: TABNAME/SHEETGID cleanup and vendor-switch prefetch.

Backend = deploy.py --redeploy, canary rprfo (editor canary rpfrf); PWA = build.py + CACHE
bump + git push. Do NOT re-open the reset's residual ~26s as tunable.
```
