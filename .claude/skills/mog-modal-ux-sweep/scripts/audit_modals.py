#!/usr/bin/env python
"""Deterministic drift detector for the MOG save-capable modals.

The mog-modal-ux-sweep skill exists because the save-capable modals drift
apart between sessions. "Which modals are missing the canonical Saved-beat
feedback?" is a fixed grep, not a judgment call — this reports it in <1s so
the sweep starts from a known state instead of a manual eyeball pass.

Checks each save-capable modal for the canonical signatures:
  - `@keyframes saveFlash`        : the green-flash animation
  - `.status.ok::before`          : the "checkmark" prefix
  - `google.script.host.close()`  : a close affordance exists (markup varies:
    footer button, top-X div, etc. — this is the reliable cross-modal signal)

MOG fork note: modals live in apps-script/ (not repo root, unlike the generic
global copy which scans cwd). With no args this AUTO-DISCOVERS every
save-capable modal in apps-script/ — a new modal (e.g. RecalibrateVendor.html)
is covered automatically, with no hardcoded list to go stale. A modal counts
as save-capable when it carries a `.status`/saveFlash marker AND a
`google.script.run` call, so the read-only modals (OrderHistory,
VendorCadenceAudit, HowToUse) don't false-flag for "missing" save feedback.
Pass explicit *.html names (resolved under apps-script/) to check specific
files as-is — including read-only ones.

Usage:
    python .claude/skills/mog-modal-ux-sweep/scripts/audit_modals.py
    python .claude/skills/mog-modal-ux-sweep/scripts/audit_modals.py ManageItems.html

Exit 0 if every checked modal has every signature; exit 1 if any drift is found
(so it can gate a sweep); exit 2 on bad args. Pure stdlib, Python 3, zero deps.
The *placement* of any missing block stays a judgment call for the sweep itself
— this only detects presence/absence. Add a new signature to SIGNATURES below.
"""
import sys
from pathlib import Path

# Repo root: scripts -> mog-modal-ux-sweep -> skills -> .claude -> root
REPO_ROOT = Path(__file__).resolve().parents[4]
APPS = REPO_ROOT / "apps-script"

# label -> substring(s); a check passes if ANY of its substrings is present.
SIGNATURES = [
    ("save-flash", ["@keyframes saveFlash"]),
    ("ok-checkmark", [".status.ok::before"]),
    ("close-affordance", ["google.script.host.close()"]),
]

# Heuristic for auto-discovery: a modal is "save-capable" (and thus subject to
# the Saved-beat sweep) if it has a status element AND talks to the server.
SAVE_CAPABLE_MARKERS = ['class="status"', "class='status'", ".status.ok", "saveFlash"]
SERVER_CALL_MARKER = "google.script.run"


def looks_save_capable(text):
    has_status = any(m in text for m in SAVE_CAPABLE_MARKERS)
    return has_status and SERVER_CALL_MARKER in text


def collect_targets(args):
    """Return (list_of_paths, error_or_None)."""
    if not APPS.is_dir():
        return [], "apps-script/ not found at " + str(APPS)

    explicit = [a for a in args if a != "--all"]
    if explicit:
        # Named files: check exactly those, resolved under apps-script/ unless
        # an absolute path was given.
        return [(Path(a) if Path(a).is_absolute() else APPS / a) for a in explicit], None

    # Default (and --all): auto-discover save-capable modals in apps-script/.
    targets = []
    for p in sorted(APPS.glob("*.html")):
        try:
            text = p.read_text(encoding="utf-8", errors="replace")
        except OSError:
            continue
        if looks_save_capable(text):
            targets.append(p)
    if not targets:
        return [], "no save-capable *.html modals found in " + str(APPS)
    return targets, None


def main(argv):
    targets, err = collect_targets(argv)
    if err:
        print("ERROR: " + err)
        return 2

    drift = False
    width = max(len(p.name) for p in targets)

    for path in targets:
        if not path.is_file():
            print("{:<{w}}  MISSING FILE".format(path.name, w=width))
            drift = True
            continue

        text = path.read_text(encoding="utf-8", errors="replace")
        marks = []
        for label, needles in SIGNATURES:
            present = any(n in text for n in needles)
            marks.append(label if present else "NO:" + label)
            if not present:
                drift = True
        print("{:<{w}}  {}".format(path.name, "  ".join(marks), w=width))

    print("")
    if drift:
        print("DRIFT FOUND - modals above with NO:<sig> need the sweep applied.")
        return 1
    print("All save-capable modals are consistent.")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
