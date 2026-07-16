---
name: mog-exec-repoint
description: Diagnose and fix a single MOG store whose PWA shows "Offline" / "Couldn't load" because its Apps Script /exec deployment has rotted — cut a FRESH web-app deployment and repoint the store to it. Use when one store's phones can't reach the backend but the code and GET health look fine, or Sebastian says "store X is offline", "the PWA won't load for [store]", "[store] backend is down", "one store can't order", "did the deployment break". This is a per-store incident runbook, distinct from a normal deploy. It has happened twice (tnytf 2026-06-26, rprfo 2026-07-06). Skip when ALL stores are down (that's a Google outage or a bad push, not a rotted deployment) and when the symptom is a code bug rather than a transport failure.
---

# mog-exec-repoint

A store's PWA hits its Sheet's `/exec` web-app URL. That single deployment can **rot silently**: the code still executes and GET stays healthy, but POST intermittently fails to *deliver* its response (the `/exec` → `googleusercontent.com/echo` redirect never returns the body), so the PWA shows **"Offline" / "Couldn't load"**. A `--redeploy` of the *same* deploymentId does **not** fix it — the deployment itself is bad. The fix is to **mint a new deployment and repoint the store to it.** Seen on **tnytf (2026-06-26)** and **rprfo (2026-07-06)**; memory `[[reference_exec_deployment_can_rot]]`.

## Step 1 — Diagnose BEFORE cutting anything

Don't reflexively redeploy. Confirm it's a rotted single deployment, not something cheaper:

- **Is it just this one store?** Open 2–3 other stores' PWAs (`sebheh.github.io/mog-mobile/<slug>/`). If they're all down → it's a **global** cause (Google Workspace incident, or a bad `deploy.py` push that broke every target) — this runbook is the wrong tool; check the Google status page and `git log` / redeploy the code fix instead. In both real incidents **only one store** was affected and there was **no declared Google incident**.
- **Signature of a rotted `/exec`:** GET (health ping) returns clean JSON, the code clearly runs (e.g. PIN-lockout counters increment on attempts), but POST returns Google's **HTML error page** instead of JSON, intermittently. rpfr once **self-healed**; rprfo persisted 4+ hrs and **survived a version bump** → the deployment had rotted.
- **A `--redeploy` (same deploymentId) is NOT the fix** and can waste time — it bumps the version of the *same* rotted deployment. You need a *new* deployment.
- **Caveat — don't probe with dummy PINs.** Failed PIN attempts trip the store's **shared 5-minute lockout** (Apps Script has no per-IP signal). Diagnose with the health GET, not by hammering login.

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
