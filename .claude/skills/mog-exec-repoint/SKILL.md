---
name: mog-exec-repoint
description: Diagnose a MOG store whose PWA shows "Offline" / "Couldn't load" / won't finish loading, and fix it — either by raising a client timeout, or by cutting a FRESH /exec deployment and repointing the store when the deployment has rotted. Use when a store's phones can't reach the backend but code and GET health look fine, when the new-day reset doesn't run or gets skipped, or Sebastian says "store X is offline", "the PWA won't load for [store]", "[store] backend is down", "one store can't order", "did the deployment break". Diagnose FIRST — the same "Offline" symptom comes from a client abort on a slow-but-successful call (commonest), a rotted deployment (tnytf 2026-06-26, rprfo 2026-07-06), or a global outage, and the fixes differ. Also carries how to read the Executions list without being misled and the ?page=diag technique for reproducing the web-app execution context. Skip for a plain code bug with a clean error message.
---

# mog-exec-repoint

A store's PWA hits its Sheet's `/exec` web-app URL. That single deployment can **rot silently**: the code still executes and GET stays healthy, but POST intermittently fails to *deliver* its response (the `/exec` → `googleusercontent.com/echo` redirect never returns the body), so the PWA shows **"Offline" / "Couldn't load"**. A `--redeploy` of the *same* deploymentId does **not** fix it — the deployment itself is bad. The fix is to **mint a new deployment and repoint the store to it.** Seen on **tnytf (2026-06-26)** and **rprfo (2026-07-06)**; memory `[[reference_exec_deployment_can_rot]]`.

## Step 1 — Diagnose BEFORE cutting anything

Don't reflexively redeploy. Confirm it's a rotted single deployment, not something cheaper:

- **FIRST: did the CLIENT give up on a healthy response?** This is the cheapest cause, the most common
  one, and it wears the same "Offline" costume as rot — it cost hours on 2026-08-03 (rpt) before being
  found. The PWA aborts a request at `API_TIMEOUT_MS` (30s) or `RESET_TIMEOUT_MS` (120s), and an abort
  is classified as a network error by `isNetworkError_`, so a **slow but successful** call renders as
  "Offline — using last loaded data" with a retry that fails identically. Apps Script keeps executing
  after the client aborts, so the server-side work usually *finished*. Measured baselines on an
  11-vendor store (rpt), taken inside a real web-app execution:
  | Work | Duration |
  |---|---|
  | bare `/exec` execution floor | ~2s |
  | dashboard read set, cold cache | 8–15s |
  | full `commitLogAndReset`, **nothing to log** | ~26s |
  | same, doing real work | ~31s |
  | first request after any `--redeploy` (cache flushed) | up to 20s |
  Ask: was a `--redeploy` just run? (It flushes `CacheService`, so the next request per store is a cold
  full recompute — see [[mog-deploy-workflow]].) Was the store heavy, the cache cold, the timeout tight?
  If so this runbook is the wrong tool: raise the ceiling or cut the server work, don't cut a deployment.
- **Is it just this one store?** Open 2–3 other stores' PWAs (`sebheh.github.io/mog-mobile/<slug>/`). If they're all down → it's a **global** cause (Google Workspace incident, or a bad `deploy.py` push that broke every target) — this runbook is the wrong tool; check the Google status page and `git log` / redeploy the code fix instead. In both real incidents **only one store** was affected and there was **no declared Google incident**.
  - ⚠ A store that looks fine proves less than it seems if it has **no data** — an empty store skips
    the load-dependent paths entirely. Compare against a store of similar size.
- **Signature of a rotted `/exec`:** GET (health ping) returns clean JSON, the code clearly runs (e.g. PIN-lockout counters increment on attempts), but POST returns Google's **HTML error page** instead of JSON, intermittently. rpfr once **self-healed**; rprfo persisted 4+ hrs and **survived a version bump** → the deployment had rotted.
- **A `--redeploy` (same deploymentId) is NOT the fix** and can waste time — it bumps the version of the *same* rotted deployment. You need a *new* deployment.
- **Caveat — don't probe with dummy PINs.** Failed PIN attempts trip the store's **shared 5-minute lockout** (Apps Script has no per-IP signal). Diagnose with the health GET, not by hammering login. Never ask Sebastian for a PIN either — see the diag route below, which needs none.

### Reading the Executions list without being misled

Two traps that sent the 2026-08-03 diagnosis down blind alleys:

- **`doPost` "Completed" does NOT mean the API call succeeded.** `doPost` catches exceptions and returns
  `{ok:false, error}` as a normal JSON response, so a *failed* action still logs as **Completed** with a
  plausible duration. To know whether it actually worked, expand the row and read the Cloud log line
  (`MOG API error in action "<action>": …`) — or check a side effect (did `AE9` advance? did rows land in
  `LOG_ORDERS`?). Duration alone tells you nothing about success.
- **`Failed` rows are often *custom functions*, not the API.** `TABNAME` / `SHEETGID` are cell-formula
  helpers on every vendor tab and dashboard row. They contend with any long write and hit
  DEADLINE_EXCEEDED *during* a reset — a symptom of the slow reset, never its cause. Filter to the
  `doPost` / `doGet` / Trigger rows before drawing conclusions.
- **Trigger rows run HEAD; `doPost` rows run the deployed VERSION.** If the two behave differently, that
  is a context difference, not necessarily a code difference — and it's the single most useful signal in
  the list. Confirm the deployed version really is your code with `clasp deployments` (the description
  string is stamped on it).

### Reproducing the web-app context: the `?page=diag` route

The Apps Script editor runs functions in a **different context** than a web-app execution, so it cannot
reproduce `/exec`-only failures (audit #16's `setActiveSheet` throw, and the 2026-08-03 hunt). `doGet` is
unauthenticated by design, so a temporary route gives you an instrumented run of the real thing with **no
PIN and no reset**:

```js
// in doGet, above the `if (!configured)` line — DELETE when done
if (page === 'diag') return jsonResponse_(diag_resetContext_(e));
```

Shape that worked: wrap every step in its own try/catch so one failure still reports the rest; return
per-step `ms` plus `error`/`stack`; include a `typeof` block for each function involved (`typeof` on an
undeclared name is safe and returns `'undefined'`, which is how you detect a symbol **missing from the
deployed snapshot** — something reading the repo cannot tell you). Keep it read-only by default and put
anything that writes behind an explicit query flag, guarded so it refuses when real data is at stake
(the write probe checked `buildOrderCycleSnapshot_().rows.length > 0` and bailed rather than clear a
KM's counts).

Deploy it to **one** store with `--target`, curl it, then **remove it and redeploy that store** so it
doesn't drift from the rest.

## Step 2 — Cut a FRESH deployment

`deploy.py --redeploy` bumps the *existing* deploymentId — it will **not** replace a rotted one. You need a raw `clasp deploy` (no `--deploymentId`) against that store's script project, which mints a new deploymentId + `/exec` URL.

`deploy.py` owns `apps-script/.clasp.json` (writes a temp one per target, then deletes it). To cut a deployment by hand, point clasp at the store's `scriptId` (from `.clasp-targets.json`) and deploy, from inside `apps-script/`:

```
# from apps-script/ , with .clasp.json set to this store's scriptId:
clasp deploy --description "repoint <slug> <date>"
clasp deployments        # read back the NEW deploymentId + verify it's listed
```

Capture the new **deploymentId** (`AKfycb…`) and its `/exec` **URL** straight from this output — don't rely on `python deploy.py --discover`, which returns only the highest-versioned id and can't tell the fresh one from the rotted one.

## Step 3 — Verify the new deployment is healthy

Before repointing, prove the new `/exec` actually delivers:

- **GET** the new `/exec` → returns the JSON health object.
- **POST twice** to it (a real `api_*` call) → clean JSON both times, **not** an HTML error page. Two POSTs because the failure is intermittent — one success isn't enough.

## Step 4 — Repoint the store (two files) + bust the cache

1. `apps-script/.clasp-targets.json` → set this store's `deploymentId` to the new one.
2. `stores.json` → set this store's `deployment` URL to the new `/exec`.
3. Bump `CACHE_VERSION` in `template/sw.js` (a store-shell change ships to phones).
4. `python build.py` — regenerates that store's `<slug>/` dir (only that dir's content should change, plus all `sw.js` from the cache bump).
5. `git add -A && git commit && git push` — GitHub Pages redeploys the PWA (~1 min).

**Leave the old (rotted) deployment live** — it's harmless once nothing points at it, and deleting it buys nothing.

## Step 5 — Verify like Sebastian does

Open the store's PWA in incognito (or hard-reload for the new SW), enter the PIN, and **run an order** — that exercises POST, the exact path that was failing. Clean tooling output is not verification here; the whole bug is a transport failure the code layer can't see.

## Why not just harden the PWA?

A PWA auto-retry on `BAD_JSON` would *mask* these delivery flakes. A **read** auto-retry did ship (2026-07-06: `get*`/`ping` retried once on a cold `/exec` / `BAD_JSON` before showing Offline), but writes (POST orders) still surface a rotted deployment — by design, because silently retrying a write is riskier. So the repoint remains the real fix, not something to engineer away.

## Composition with other skills

- [[mog-deploy-workflow]] for the normal push/redeploy semantics this runbook deliberately departs from.
- [[mog-cheatsheet]] for the exact `clasp` / `build.py` / git invocations.
- [[mog-session-handoff]] — record the repoint (which store, old→new deploymentId) so the next session knows the URL moved.
- Memory `[[reference_exec_deployment_can_rot]]` is the one-line version of this runbook.
