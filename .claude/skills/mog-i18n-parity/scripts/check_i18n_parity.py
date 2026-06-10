#!/usr/bin/env python3
"""MOG EN/ES parity check — thin wrapper over the canonical checker.

The old version of this file was a full fork of
~/.claude/skills/i18n-parity-checker/scripts/check_i18n_parity.py whose ONLY
intentional divergence was the `--all` glob target (MOG's modals live in
apps-script/*.html, not the repo root). Per the checker-script-sync skill's
"push toward fewer copies" rule, the fork is now a wrapper: `--all` is expanded
HERE to apps-script/*.html and everything else — all parsing logic, modes,
output, exit codes — is the canonical script's. Parser fixes land in the
canonical copy, never here.

Usage (unchanged):
    python scripts/check_i18n_parity.py <modal.html> [<modal2.html> ...]
    python scripts/check_i18n_parity.py --all        # every apps-script/*.html

Exit codes (canonical's): 0 parity, 1 mismatch, 2 bad args / file not found.
"""

import glob
import os
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, "..", "..", "..", ".."))
CANON = os.path.join(os.path.expanduser("~"), ".claude", "skills",
                     "i18n-parity-checker", "scripts", "check_i18n_parity.py")


def main(argv):
    if not os.path.exists(CANON):
        sys.exit("canonical checker not found: " + CANON +
                 "\nSync global skills first (Claude-SKills repo: sync-skills.ps1).")
    args = argv[1:]
    if "--all" in args:
        files = sorted(glob.glob(os.path.join(ROOT, "apps-script", "*.html")))
        if not files:
            print("--all matched no files under apps-script/")
            return 2
        args = [a for a in args if a != "--all"] + files
    return subprocess.call([sys.executable, CANON] + args, cwd=ROOT)


if __name__ == "__main__":
    sys.exit(main(sys.argv))
