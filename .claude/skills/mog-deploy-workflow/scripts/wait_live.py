#!/usr/bin/env python
"""Wait until GitHub Pages serves a push, then until CI's `gates` run on it finishes.

Every push from 10-29 on wrote this by hand (live_vN.sh). The rules it holds
(docs/MOG_ProjectNotes.md, "Checking a Pages push is live"):
  * a marker must exist only in the new build: it must be in the file at HEAD
    and NOT in the same file at --base (default HEAD~1), or the check refuses,
    because a marker the old file also has reports "live" early (10-20:
    `it-panel` matched the old page's `edit-panel`);
  * every URL is fetched with a cache-busting query, every store at once;
  * CI is read from the runs API without a token, matching the run named
    `gates` (the Pages deploy run is in the same list).

Usage (from the repo root, after `git push`):
    python .claude/skills/mog-deploy-workflow/scripts/wait_live.py \\
        --marker "hq/warehouse.js=routesStopped" \\
        --marker "{store}/sw.js=CACHE_VERSION = 'v75'"

A path with {store} expands to all 10 stores in stores.json. --base REV checks
"not in the old file" against REV instead of HEAD~1 (use it when the marker
landed a few commits back). --timeout is in minutes (default 10). Exit 0 =
live everywhere and gates passed; 1 = gates failed; 2 = timed out or refused.

Pure stdlib, Python 3.
"""
import argparse
import json
import os
import random
import subprocess
import sys
import time
import urllib.request

REPO = os.path.normpath(os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..', '..', '..'))
SITE = 'https://sebheh.github.io/mog-mobile/'
RUNS = 'https://api.github.com/repos/SebHEH/mog-mobile/actions/runs?head_sha='


def git(*args):
    return subprocess.run(['git', '-C', REPO] + list(args), capture_output=True, text=True, encoding='utf-8', errors='replace')


def fetch(url):
    try:
        req = urllib.request.Request(url, headers={'User-Agent': 'mog-wait-live', 'Cache-Control': 'no-cache'})
        with urllib.request.urlopen(req, timeout=20) as r:
            return r.read().decode('utf-8', 'replace')
    except Exception:
        return ''


def main():
    ap = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    ap.add_argument('--marker', action='append', required=True, help='PATH=TEXT (PATH may contain {store})')
    ap.add_argument('--base', default='HEAD~1', help='the old build to check the marker is NOT in (default HEAD~1)')
    ap.add_argument('--timeout', type=float, default=10, help='minutes (default 10)')
    a = ap.parse_args()

    with open(os.path.join(REPO, 'stores.json'), encoding='utf-8') as f:
        stores = [s['slug'] for s in json.load(f)]
    checks = []   # (path, text)
    for m in a.marker:
        if '=' not in m:
            sys.exit('A marker is PATH=TEXT: ' + m)
        path, text = m.split('=', 1)
        for p in ([path.replace('{store}', s) for s in stores] if '{store}' in path else [path]):
            checks.append((p, text))

    # The marker has to be new: in HEAD, not in --base.
    refused = []
    for p, text in checks:
        now, old = git('show', 'HEAD:' + p), git('show', a.base + ':' + p)
        if now.returncode != 0 or text not in now.stdout:
            refused.append('%s: not in the committed file at HEAD' % p)
        elif old.returncode == 0 and text in old.stdout:
            refused.append('%s: already in %s, so it would read as live before the push lands' % (p, a.base))
    if refused:
        print('REFUSED, pick a marker only the new build has:\n  ' + '\n  '.join(refused))
        sys.exit(2)

    sha = git('rev-parse', 'HEAD').stdout.strip()
    deadline = time.time() + a.timeout * 60
    waiting = list(checks)
    tries = 0
    while waiting and time.time() < deadline:
        tries += 1
        waiting = [(p, t) for p, t in waiting if t not in fetch(SITE + p + '?x=%d' % random.randrange(10 ** 9))]
        if waiting:
            print('try %d: %d of %d not live yet (%s)' % (tries, len(waiting), len(checks), ', '.join(sorted({p.split('/')[0] for p, _ in waiting}))))
            sys.stdout.flush()
            time.sleep(15)
    if waiting:
        print('TIMED OUT: still old: ' + ', '.join(p for p, _ in waiting))
        sys.exit(2)
    print('PAGES LIVE: %d files serve the new build (try %d)' % (len(checks), tries))

    while time.time() < deadline + 10 * 60:
        runs = json.loads(fetch(RUNS + sha) or '{}').get('workflow_runs', [])
        gates = [r for r in runs if r.get('name') == 'gates']
        if gates and gates[0].get('status') == 'completed':
            ok = gates[0].get('conclusion') == 'success'
            print('CI gates: %s  %s' % (gates[0].get('conclusion'), gates[0].get('html_url', '')))
            sys.exit(0 if ok else 1)
        time.sleep(20)
    print('TIMED OUT waiting for the gates run on %s' % sha[:7])
    sys.exit(2)


if __name__ == '__main__':
    main()
