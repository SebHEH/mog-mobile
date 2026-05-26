# MOG — Current Project State

The running snapshot of where this codebase is *right now*. Updated at the end of every session that ships material changes. Future Claude reads this on session start (via `CLAUDE.md` @-import) and uses it to orient before touching anything.

If this doc and `CLAUDE.md` conflict on a specific fact, `CLAUDE.md` wins for structure / invariants; this doc wins for "what's currently in flight."

---

## Pinned focus

**Apps Script modal performance pass — in progress.** Items #1–2 of a 7-item audit have shipped (Order History bootstrap on 2026-05-25; ManageVendors save consolidation on 2026-05-26). Five items remain. Tooling parity caught up this session too: the deploy tool was ported from PowerShell (`deploy.ps1` + `discover-deployments.ps1`, now deleted) to Python (`deploy.py` at repo root, mirrors `build.py`'s placement and style). New `--redeploy` flag handles the MOGApi.gs case (bumps each web-app `/exec` URL after the push). Cross-platform, zero deps, no ExecutionPolicy hassle.

### Next-session candidates (impact-ranked)

1. **`api_getDashboard_` CacheService** (MEDIUM-BIG, audit item #3). `MOGApi.gs` ~lines 345–421 read vendor + item + storage areas sequentially every dashboard hit. Mirror cache pattern from `getManageItemsBootstrap` (mutation-timestamp invalidation via `DocumentProperties`). First real use of `--redeploy` — this change is in MOGApi.
2. **StorageAreas RPC consolidation** (MEDIUM, audit item #4). 6 separate RPCs → 1 `mutateStorageAreas({add, delete})`.
3. **`getSheet_` handle caching / `getVendorTableData` adjacent-range merge / `fetchCurrentArea()` removal** (audit items #5–7). Smaller; bundle if a session has appetite for incremental wins.
4. **Parallelize `deploy.py`** (separate optimization). Push per target in parallel via `concurrent.futures.ThreadPoolExecutor` with a per-target temp `.clasp.json` location. Would drop 30s+ serial wait to ~5s. Nice-to-have, not urgent.
5. **Decommission `Master-Ordering-Guide` GitHub repo** (~2026-05-31, one week after consolidation lands). Delete on GitHub, rename local folder to `.archive`. Low effort, removes a foot-gun.
6. **Service worker `CACHE_VERSION` bump audit.** Both `sw.js` (hub) and `template/sw.js` are at `v5`. Confirm no pending shell changes need a bump.

---

## Standing invariants (carry forward)

Duplicated from `CLAUDE.md` so this doc reads standalone:

1. Never edit generated `<slug>/` dirs — overwritten by `build.py`.
2. Never edit code in the Apps Script editor — overwritten by `deploy.py`.
3. `.gs` files are identical across all 9 deploy targets; per-store config lives in spreadsheet data.
4. Apps Script HTML modals run in Rhino (ES5) — no arrow fn / `let` / `const` / template literals.
5. `template/index.html` placeholders (`__MOG_API_URL__`, `__MOG_THEME__`, `__MOG_APPLE_TOUCH_ICON__`) appear exactly once each; never replace by hand.
6. `STORE_REGISTRY` line in root `index.html` is build-injected; edit `stores.json` instead.
7. Bump `CACHE_VERSION` when shipping shell changes so KMs' phones evict stale caches.
8. Slugs in `stores.json` are immutable once published (bookmark/home-screen breakage).

---

## Deploy targets (apps-script/.clasp-targets.json)

9 targets total. Code is identical across all of them; `appsscript.json` manifest is unified to rpr's (which explicitly declares OAuth scopes).

Each non-template target has two identifiers committed to git: `scriptId` (for `clasp push` — source) and `deploymentId` (for `clasp deploy --deploymentId` — bumping the web-app `/exec` URL the PWA hits). `_template` has no `deploymentId` because it isn't published as a web app.

| Slug | Store | Notes |
|---|---|---|
| `_template` | Master template | Copied to seed new stores. Push keeps it current. No web-app deployment. |
| `rpr` | Roll Play - Rosslyn BOH | Canary target — first to receive new deploys for smoke testing. |
| `rprfo` | Roll Play - Rosslyn FOH | |
| `rpt` | Roll Play - Tysons BOH | |
| `rptfo` | Roll Play - Tysons FOH | Added 2026-05-24. |
| `rpfr` | Roll Play - Founders BOH | |
| `rpfrf` | Roll Play - Founders FOH | Added 2026-05-24. |
| `tnyt` | Teas'n You - Tysons BOH | |
| `tnytf` | Teas'n You - Tysons FOH | |

**Deploy commands from repo root:**

| Goal | Command |
|---|---|
| Push (bound-sidebar-only change) | `python deploy.py` |
| Push + redeploy web-app URL (MOGApi.gs / any `api_*` change) | `python deploy.py --redeploy` |
| Push + redeploy with a tag | `python deploy.py --redeploy --description "<msg>"` |
| Single target | `python deploy.py --target <slug>` (combine with `--redeploy` if needed) |
| Dry run | `python deploy.py --dry-run` (combine with `--redeploy` to preview the redeploy step too) |
| Discover deploymentIds (one-time per fresh checkout if `.clasp-targets.json` has `FILL_ME_IN`) | `python deploy.py --discover` |

**Push vs redeploy — when to use which:**
- *Bound sidebars* (ManageVendors, ManageItems, OrderHistory, etc.) read HEAD inside the Sheet. Push is enough.
- *PWA* hits each Sheet's `/exec` URL, which serves a versioned snapshot. MOGApi.gs changes need `--redeploy` or the PWA stays on old code.
- When unsure: `--redeploy`. Extra cost is ~3s per target.

---

## Live stores (stores.json)

8 entries — the master template isn't published to the PWA hub (it has no deployment URL because it isn't deployed as a web app).

| Slug | URL | Concept | Location |
|---|---|---|---|
| `rpr` | `sebheh.github.io/mog-mobile/rpr/` | Roll Play | Rosslyn BOH |
| `rprfo` | `.../rprfo/` | Roll Play | Rosslyn FOH |
| `rpt` | `.../rpt/` | Roll Play | Tysons BOH |
| `rptfo` | `.../rptfo/` | Roll Play | Tysons FOH |
| `rpfr` | `.../rpfr/` | Roll Play | Founders BOH |
| `rpfrf` | `.../rpfrf/` | Roll Play | Founders FOH |
| `tnyt` | `.../tnyt/` | Teas'n You | Tysons BOH |
| `tnytf` | `.../tnytf/` | Teas'n You | Tysons FOH |

Hub URL: `https://sebheh.github.io/mog-mobile/` — concept picker with auto-redirect on return visits.

---

## Open issues / risks

- **Master-Ordering-Guide repo still exists** at `github.com/SebHEH/Master-Ordering-Guide` and locally at `C:\Users\RAD-SEB\Documents\GitHub\Master-Ordering-Guide\`. Scheduled for deletion ~2026-05-31. Risk: someone (or future-Claude) opens a session from the old dir and edits stale files, splitting the source-of-truth again. Mitigation: when Sebastian opens a Claude Code session, confirm `cwd` is `mog-mobile`, not `Master-Ordering-Guide`.
- **No CI** — the only verification of a deploy is Sebastian opening the live URL. Workable for a 1-operator setup but means PRs from anyone else would have no safety net. Not urgent.
- **`python3` shim hijack on Windows** — the Microsoft Store stub intercepts `python3`. Use `python` or `py` instead. `build.py`'s shebang `#!/usr/bin/env python3` only matters on Unix.
- **PowerShell PATH staleness post-install.** After a `winget install`, in-session shells don't pick up new tools until PATH is refreshed from registry. The convention in `CLAUDE.md` covers this.

---

## Architecture notes worth remembering

- **Two separate `CACHE_VERSION` constants** — one in `sw.js` (hub) and one in `template/sw.js` (per-store). They move independently. Bump only the one whose shell actually changed.
- **`build.py` is idempotent and zero-arg.** Running it without changes is a no-op. `--dry-run` previews without writing.
- **`deploy.py` writes a temporary `apps-script/.clasp.json` per target, runs `clasp push -f` from inside `apps-script/`, then cleans up.** `.clasp.json` is gitignored. Don't try to maintain a permanent one — the deploy script owns that file. Discovery mode (`--discover`) uses the same temp-file pattern.
- **Source push and web-app redeploy are separate phases.** `clasp push` updates the script project (which bound sidebars read from HEAD). `clasp deploy --deploymentId <id>` bumps the version that the `/exec` URL the PWA hits actually serves. `deploy.py --redeploy` does both; the default does just push.
- **`deploy.py` is Python stdlib-only (no `pip install` step), zero-dep, cross-platform.** Replaced the earlier PowerShell pair (`deploy.ps1` + `discover-deployments.ps1`) on 2026-05-26 to match `build.py`'s placement and pattern and to drop the Windows-only ExecutionPolicy requirement.
- **The 6 store-bound HTML modal files (AdminReset, ManageItems, ManageVendors, OrderHistory, ReorderPickPath, StorageAreas, HowToUse) plus the 2 `.gs` files are all `apps-script/` peers.** No subdirectory structure inside `apps-script/`. Clasp's default file picker handles this fine.
- **`apps-script/.clasp-targets.json` is committed to git** with real Script IDs. Script IDs are project identifiers, not secrets — pushing still requires OAuth (`clasp login`) on the user's side. Committing makes the deploy workflow portable to a fresh machine.
- **The `STORE_REGISTRY` build-injection marker** in root `index.html` is the line containing `// __STORE_REGISTRY__ build-injected`. Exactly one such line; `build.py` fails loud otherwise.
- **rpr's `appsscript.json` was chosen as canonical** during 2026-05-24 reconciliation because it explicitly declared OAuth scopes (the other 5 stores had implicit/auto-detected scopes). The canonical manifest is now applied to all 9 targets.

---

## Recent significant changes

Most recent first. Trim entries older than ~5 sessions when this list gets unwieldy.

| Date | Session | Outcome |
|---|---|---|
| 2026-05-26 | ManageVendors save consolidation + Python deploy tool | Audit item #2 shipped: `commitUpdateVendorMultsAndCutoff` server fn + flat one-RPC client (was two chained RPCs with shared row lookup). Deployed to all 9 targets (bound-sidebar-only — no web-app redeploy needed). Tooling overhaul: built the PowerShell `deploy.ps1` + `discover-deployments.ps1` pair with `-Redeploy` support, populated all 8 `deploymentId` fields in `.clasp-targets.json`, migrated TNYTF to a new script project, then ported the whole tool to Python (`deploy.py` at repo root, parallel to `build.py`). Closed the gap where MOGApi.gs changes silently didn't reach the PWA's `/exec` URL — `python deploy.py --redeploy` handles push + version bump in one command. Cross-platform, zero deps. Docs updated: `apps-script/README.md`, `CLAUDE.md`, this file, deploy-workflow + add-store skills. |
| 2026-05-25 | Order History modal RPC consolidation | Apps Script modal perf audit produced 7-item ranked punch-list. Item #1 shipped: `getOrderHistoryBootstrap` server fn + rewired `OrderHistory.html` window.onload → 1 RPC instead of 2 on modal open, 1 fewer `LOG_ORDERS` read. Deployed to all 9 clasp targets. Side-note: Node + clasp + clasp login installed on `sebcn` machine for the first time. |
| 2026-05-24 | Repo consolidation + Claude Code scaffold | Master-Ordering-Guide repo merged into mog-mobile; `apps-script/` folder created; clasp deploy workflow set up; 2 new stores (rpfrf, rptfo) onboarded; CLAUDE.md + docs/ + 3 repo-specific skills written. Commits: `d95080f`, `bb68221`, plus this scaffold commit. |
