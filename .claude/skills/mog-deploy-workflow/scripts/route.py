#!/usr/bin/env python
"""Deterministic deploy router for the MOG repo.

Given one or more changed file paths (relative to repo root), prints the layer,
the exact deploy command, and whether canary-first applies. This is the single
source of truth for the push-vs-`--redeploy` decision — it guards pitfall #4a
(forgetting `--redeploy` after a MOGApi.gs change, which leaves the PWA's /exec
URL serving stale code).

Usage:
    python .claude/skills/mog-deploy-workflow/scripts/route.py <path> [<path> ...]

Example:
    python route.py apps-script/MOGApi.gs apps-script/ManageVendors.html
    -> recommends `python deploy.py --redeploy` (the strongest action wins)

Pure stdlib, Python 3, zero deps. Matches build.py / deploy.py conventions.
The path-based rules are deterministic; genuinely ambiguous cases (e.g. an
appsscript.json scope change that may or may not touch PWA scopes) print a
VERIFY note rather than guessing — that's where human judgment stays.
"""
import sys
import posixpath

# Action ranking — the strongest action across all changed files wins.
GIT_ONLY, BUILD, PUSH, REDEPLOY = 0, 1, 2, 3
ACTION_NAME = {
    GIT_ONLY: "git push only",
    BUILD: "python build.py  ->  git commit + push",
    PUSH: "python deploy.py            (canary: --target rpr first)",
    REDEPLOY: "python deploy.py --redeploy (canary: --target rpr --redeploy first)",
}


def classify(path):
    """Return (action, layer, reason, verify_note_or_None) for one path."""
    p = path.replace("\\", "/").lstrip("./")
    base = posixpath.basename(p)

    # Apps Script backend
    if p.startswith("apps-script/"):
        if base == "MOGApi.gs":
            return (REDEPLOY, "Apps Script backend (PWA-facing)",
                    "MOGApi.gs is served via /exec (a versioned snapshot); "
                    "push alone won't reach the PWA.", None)
        if base.endswith(".html"):
            return (PUSH, "Apps Script backend (bound sidebar)",
                    "Bound sidebars read HEAD; no web-app version bump needed.", None)
        if base == "appsscript.json":
            return (PUSH, "Apps Script backend (manifest)",
                    "Manifest push.",
                    "If PWA-facing OAuth scopes changed, use --redeploy and "
                    "re-authorize each Sheet.")
        if base.endswith(".gs"):
            return (PUSH, "Apps Script backend (bound sidebar)",
                    "Bound-sidebar .gs logic reads HEAD.",
                    "If you added/edited an api_* function the PWA calls, "
                    "switch to --redeploy.")
        if base == ".clasp-targets.json":
            return (GIT_ONLY, "Deploy infrastructure (config)",
                    "Config only; next deploy.py run picks it up.", None)
        return (PUSH, "Apps Script backend",
                "Default for apps-script/ source.", None)

    # Per-store PWA  /  hub registry
    if p.startswith("template/") or base == "stores.json":
        return (BUILD, "Per-store PWA / hub registry",
                "Regenerate per-store dirs from template + stores.json, then "
                "git push (GitHub Pages auto-deploys).",
                "If the shell changed, bump CACHE_VERSION in template/sw.js first.")

    # Deploy infra tools
    if base in ("build.py", "deploy.py"):
        return (GIT_ONLY, "Deploy infrastructure",
                "Tooling change; test with --dry-run, then git push.", None)

    # Hub / static / docs
    if base in ("index.html", "sw.js", "manifest.json"):
        return (GIT_ONLY, "Hub",
                "Hub change; git push (no build unless stores.json also changed).",
                "If sw.js (hub) shell changed, bump its CACHE_VERSION.")
    if p.startswith("icons/") or p.startswith("docs/"):
        return (GIT_ONLY, "Static assets / docs", "git push.", None)

    return (PUSH, "UNKNOWN",
            "Path didn't match a known rule.",
            "Route manually — confirm the layer before deploying.")


def main(argv):
    paths = argv[1:]
    if not paths:
        print(__doc__)
        return 2

    results = [(path,) + classify(path) for path in paths]
    winner = max(r[1] for r in results)  # strongest action across all files

    print("Changed files:")
    for path, action, layer, reason, verify in results:
        print("  - {}  ->  {} [{}]".format(path, ACTION_NAME[action].split("(")[0].strip(), layer))
        if verify:
            print("      VERIFY: " + verify)

    print("\nDeploy: " + ACTION_NAME[winner])
    reasons = sorted({r[3] for r in results if r[1] == winner})
    for reason in reasons:
        print("Reason: " + reason)
    if winner in (PUSH, REDEPLOY):
        print("Canary-first: yes - smoke-test rpr, then fan out.")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
