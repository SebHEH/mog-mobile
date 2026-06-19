---
name: mog-apps-script-caching
user-invocable: false
description: Recipe for adding `CacheService` + mutation-timestamp invalidation to an `api_*` function in `apps-script/MOGApi.gs`. Use whenever a frequently-called PWA-facing read function is being added or refactored, when a dashboard / list / aggregation endpoint feels slow on repeat hits, when Sebastian asks "should this be cached", "cache this", "add caching to api_X", or when the modal performance audit calls for cache wrapping (e.g. `api_getDashboard_`, `getManageItemsBootstrap`). ALSO trigger when adding a new `api_*` read endpoint that aggregates more than one sheet or scans MASTER_ITEMS / LOG_ORDERS — those are exactly the shape that benefits. Skip for write paths (they bump, they don't cache), for one-off admin endpoints, and for reads that depend on inputs that aren't easily key-able (e.g. random-sampling).
---

# mog-apps-script-caching

The cache pattern crystallized across `getManageItemsBootstrap` and `api_getDashboard_` (audit item #3, shipped 2026-05-27). Reuse exactly — don't invent a new shape.

> This is pattern A (mutation-timestamp-in-key) in the global `appsscript-caching` skill's
> taxonomy, which owns the architecture decision (A vs MVS's two-tier pattern B) and the shared
> rules. This specializer pins MOG's infrastructure: `getServerMutationTs_` /
> `bumpServerMutationTs_`, the 300s TTL convention, and the MOGApi.gs `--redeploy` routing.

## The pattern

```javascript
function api_foo_(input) {
  var ts = getServerMutationTs_();
  var key = 'api_foo_v1:' + ts + ':' + JSON.stringify(input || {});
  var cache = CacheService.getDocumentCache();
  try {
    var hit = cache.get(key);
    if (hit) return JSON.parse(hit);
  } catch (e) { /* fail-safe — compute on cache error */ }

  var result = api_foo_compute_(input);

  try {
    cache.put(key, JSON.stringify(result), 300);  // 300s TTL
  } catch (e) { /* fail-safe — return result even if put fails */ }

  return result;
}

function api_foo_compute_(input) {
  // the actual sheet reads + aggregation
}
```

## The non-obvious decisions (don't re-litigate)

1. **Always reuse `getServerMutationTs_()`** — don't introduce a per-feature timestamp. The 2026-05-27 architectural decision: separate ts would have needed bumps at 11+ callsites (every write fn), reuse needs zero new bumps. Trade-off accepted: an admin storage-area edit also invalidates the dashboard cache, but those edits are rare and recompute is cheap. The reused-ts pattern is the project convention.

2. **Bumps already exist for free.** `bumpServerMutationTs_()` (defined in `Core.gs`) is called from every write fn across the bound-script `.gs` files (`Vendors.gs`/`Items.gs`/`PickPath.gs`/`ResetLog.gs` — add/delete/rename vendors, items, areas, pick paths, order saves, on-hand writes). If your new cached read depends on data that any of those writes can change, you get invalidation for free. If it depends on data that *no* write fn touches, the read probably doesn't need caching.

3. **Split the function in two.** `api_foo_` is the cache wrapper. `api_foo_compute_` is the work. This keeps the cache layer trivially auditable and lets the compute fn be called directly when debugging in the editor (which bypasses cache).

4. **TTL is 300s.** Both existing cached endpoints use 300s. Don't tune per-endpoint without a reason — the mutation-ts invalidation handles correctness; the TTL is just an upper bound on staleness if `getServerMutationTs_` somehow stops being bumped.

5. **Cache key must include `ts` + inputs.** Without `ts`, mutations don't invalidate. Without inputs, different callers collide. `JSON.stringify(input || {})` handles the both-undefined and missing-input cases without throwing.

6. **Fail-safe both reads and writes.** Wrap `cache.get` and `cache.put` in try/catch — `CacheService` can throw on quota or transient failures. Return the computed result regardless. The cache is a perf optimization, not a correctness layer.

## When you ADD a write fn

If the new write affects data read by a cached endpoint, add `bumpServerMutationTs_();` to its end (after the write succeeds, before the return). Pattern matches every existing write fn across the bound-script `.gs` files. Skipping the bump is the bug that makes cached reads serve stale data — it's the most likely correctness failure of this pattern.

## Deploy

Skill-specific routing fact: cache wraps **always** live in `apps-script/MOGApi.gs`, so they **always** need `--redeploy` (the `/exec` URL serves a versioned snapshot; push alone leaves the PWA on old code). For the exact command + canary discipline, defer to `mog-deploy-workflow` — run its router: `python .claude/skills/mog-deploy-workflow/scripts/route.py apps-script/MOGApi.gs`.

## Anti-patterns

- **Per-feature timestamp.** Inflates bump callsites, no real correctness benefit. Reuse `getServerMutationTs_`.
- **Caching write paths.** Writes don't get cached — they bump. If you're tempted to cache a write, you're confused about what the function does.
- **Caching one-shot admin endpoints** (`api_resetSheet_`, `api_seedFromTemplate_`, etc.). Called once per blue moon; cache hit rate is zero; not worth the code.
- **TTL tuning per endpoint.** 300s is the convention. Diverging hides the actual invalidation pattern behind a number.
- **Caching reads with non-key-able inputs** (e.g. "give me a random sample"). The cache key would be wrong by definition.
- **Inlining the compute logic into the cache wrapper.** Hard to debug, hard to bypass cache when investigating. Split into `api_foo_` (wrapper) + `api_foo_compute_` (work).

## Canonical examples to read before writing

- `apps-script/MOGApi.gs` → `getManageItemsBootstrap` (the original pattern; reads → vendor + item + area data).
- `apps-script/MOGApi.gs` → `api_getDashboard_` + `api_getDashboard_compute_` (the split-fn shape; also see `countActiveItemsByVendor_` for loop-hoisting alongside caching).
- `apps-script/Core.gs` → `getServerMutationTs_` and `bumpServerMutationTs_` (the timestamp source of truth; lines ~228–246).

## Composition with other skills

- [[architectural-walkthrough]] runs first if you're introducing a *new* cached endpoint (not just wrapping an existing read).
- [[mog-deploy-workflow]] confirms `--redeploy` is needed (it is — MOGApi.gs change).
- [[mog-rpc-consolidation]] is the natural pair if the cached endpoint is also a multi-RPC consolidation (`getManageItemsBootstrap` is both).
