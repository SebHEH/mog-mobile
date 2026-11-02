#!/usr/bin/env python3
"""MOG handoff fact-gather — thin wrapper over the canonical script.

This script was born here and was promoted to the global session-handoff skill
on 2026-06-10 (genericized: it auto-discovers the project prefix from docs/, so
the MOG-specific version became redundant). This wrapper keeps the documented
invocation path working and delegates everything to the canonical copy.

Canonical: ~/.claude/skills/session-handoff/scripts/handoff_facts.py
(synced from the Claude-SKills repo — logic fixes land THERE, never here.)

Note for MOG: on a same-day collision the canonical prints both legal moves;
MOG's convention is UPDATE-IN-PLACE (append a '## Later session' block) — never
a second file for the same date, never a future date.
"""
import os
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, "..", "..", "..", ".."))
CANON = os.path.join(os.path.expanduser("~"), ".claude", "skills",
                     "session-handoff", "scripts", "handoff_facts.py")

if not os.path.exists(CANON):
    sys.exit("canonical handoff_facts not found: " + CANON +
             "\nSync global skills first (Claude-SKills repo: sync-skills.ps1).")

sys.exit(subprocess.call([sys.executable, CANON] + sys.argv[1:], cwd=ROOT))
