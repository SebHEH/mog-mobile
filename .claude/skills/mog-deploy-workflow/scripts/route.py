#!/usr/bin/env python
"""Deterministic deploy router for the MOG repo.

Given one or more changed file paths (relative to repo root), prints each
file's layer and every action the set needs: a build and push, a redeploy of
the Edge Function `close`, the mail relay, SQL first. Actions are listed, not
ranked: a change can need a build AND an Edge Function deploy.

Since Sheet retirement step 5 (2026-11-20) no store's Apps Script is deployed:
the stores' /exec deployments are archived and apps-script/ is only a source
for build.py (OrderMath.gs in every store page, Sync.gs's Supabase config, the
editor pages, the close function's shared.mjs) and for the gates. The only
Apps Script deploy left is the mail relay (`python deploy.py --relay`).

Usage:
    python .claude/skills/mog-deploy-workflow/scripts/route.py <path> [<path> ...]

Example:
    python route.py apps-script/OrderMath.gs template/index.html
    -> python build.py + push (canary rprfo first), then redeploy `close`

Pure stdlib, Python 3, zero deps. Ambiguous cases print a VERIFY note rather
than guessing.
"""
import sys
import posixpath

# Single source of truth for the canary store. The canary is a ROLE (the store
# we smoke-test first before fanning out), not a fixed identity: it moved from
# rpr to rprfo on 2026-05-27 (rprfo is the least dangerous store; rpr's pars may
# not be true 1-day pars). Every skill that names the canary derives it from
# here (or from this script's output), never hardcodes it again.
CANARY = "rprfo"

# The .gs files build.py copies into supabase/functions/close/shared.mjs: a
# change to one also changes what the nightly close runs.
CLOSE_SOURCES = ("OrderMath.gs", "Concepts.gs", "RecapEmail.gs")

GIT, BUILD, EDGE, RELAY, SQL = "git", "build", "edge", "relay", "sql"
ACTIONS = {
    SQL: "FIRST: run the SQL through the Supabase connector or the SQL Editor on the maintainer's go, "
         "then its smoke file and check_api.sh (skill mog-supabase-schema). The database ships before the code.",
    BUILD: "python build.py  ->  commit + push (GitHub Pages deploys); an app change goes to the canary %s first, "
           "then fans out; wait_live.py checks it." % CANARY,
    EDGE: "Redeploy the Edge Function `close` through the Supabase connector's deploy_edge_function "
          "(index.ts, core.mjs and the generated shared.mjs as committed; verify_jwt false) after build.py.",
    RELAY: "python deploy.py --relay  (push mail-relay/ and redeploy its one deployment).",
    GIT: "git push only.",
}
ORDER = (SQL, BUILD, EDGE, RELAY, GIT)


def classify(path):
    """Return (actions, layer, verify_note_or_None) for one path."""
    p = path.replace("\\", "/").lstrip("./")
    base = posixpath.basename(p)

    if p.startswith("apps-script/"):
        if base in CLOSE_SOURCES:
            return ({BUILD, EDGE}, "Shared source (store pages and the nightly close)",
                    "OrderMath.gs runs on every phone and in the close: run node tests/run_all.js first."
                    if base == "OrderMath.gs" else None)
        return ({BUILD}, "Build source (apps-script/ is no longer deployed)",
                "build.py reads only some apps-script/ files (Sync.gs's config, the editor pages and their "
                "includes); a change elsewhere ships nowhere, so check it is still used before editing.")

    if p.startswith("mail-relay/"):
        return ({RELAY}, "Mail relay (Apps Script)", None)

    if p.startswith("supabase/functions/"):
        if base == "shared.mjs":
            return ({EDGE}, "Edge Function `close` (generated)",
                    "shared.mjs is written by build.py from apps-script/: edit the .gs source, never this file.")
        return ({EDGE}, "Edge Function `close`", None)

    if p.startswith("supabase/"):
        if base.startswith("schema") and base.endswith(".sql"):
            return ({SQL}, "Supabase schema", None)
        if p.startswith("supabase/tests/"):
            return ({GIT}, "Supabase tests",
                    "Run in the SQL Editor or the connector (smoke) or by bash (check_api.sh); "
                    "a probe never sends a PIN to a real store (lockout counter).")
        return ({GIT}, "Supabase (one-off SQL)",
                "Run by a maintainer only when a runbook says so.")

    if p.startswith("template/") or base == "stores.json":
        return ({BUILD}, "Per-store PWA / HQ / hub registry",
                "If the store shell changed, bump CACHE_VERSION in template/sw.js first.")

    if base in ("build.py", "deploy.py"):
        return ({GIT}, "Deploy infrastructure",
                "Tooling change; try it with --dry-run. A build.py change that alters its output also needs "
                "python build.py and the canary.")

    if base in ("index.html", "sw.js", "manifest.json") and "/" not in p:
        return ({GIT}, "Hub",
                "If the hub shell changed, bump its CACHE_VERSION in sw.js.")
    if p.startswith("icons/") or p.startswith("docs/"):
        return ({GIT}, "Static assets / docs", None)
    if p.startswith("tests/"):
        return ({GIT}, "Gates", "node tests/run_all.js; nothing deploys.")
    if p.startswith(".claude/"):
        return ({GIT}, "Skills", None)

    return ({GIT}, "UNKNOWN", "Path didn't match a known rule: confirm the layer before shipping.")


def main(argv):
    paths = argv[1:]
    if not paths:
        print(__doc__)
        return 2

    needed = set()
    print("Changed files:")
    for path in paths:
        actions, layer, verify = classify(path)
        needed |= actions
        print("  - {}  ->  {} [{}]".format(path, ", ".join(a for a in ORDER if a in actions), layer))
        if verify:
            print("      VERIFY: " + verify)
    if len(needed) > 1:
        needed.discard(GIT)  # every other action ends in a push anyway

    print("\nDo, in this order:")
    for i, a in enumerate((a for a in ORDER if a in needed), 1):
        print("  %d. %s" % (i, ACTIONS[a]))
    print("\nCanary-first: " + ("yes - %s, then fan out." % CANARY if BUILD in needed else "no store build involved."))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
