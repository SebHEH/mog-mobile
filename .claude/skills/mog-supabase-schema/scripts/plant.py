#!/usr/bin/env python
"""Plant defects in a scratch copy of supabase/ and check the smoke file catches each one.

Every schema version from v14 to v22 wrote this by hand (plant_vN as .sh, .py and
.js). The skill's rules for a plant (mog-supabase-schema, ship order step 1):
  * it counts as CAUGHT only when the planted schema file still ran AND a smoke
    row naming the rule says FAIL; an error running the file is a broken plant,
    not a catch;
  * every failing row is printed, so a plant that fails everything after it
    (a throw, not the rule) is visible and gets re-planted.

Usage:
    python .claude/skills/mog-supabase-schema/scripts/plant.py plants.json [--work DIR]

plants.json (strings exactly as they are in the file; `count` = how many times
`old` occurs, every one replaced):
    {
      "smoke": "smoke_v22.sql",
      "plants": [
        {"name": "the close ignores an inactive item",
         "file": "schema_v22.sql",
         "old": "and p.active and h.active", "new": "and h.active", "count": 3,
         "row": "inactive: the close records no delivery"}
      ]
    }

`file` is under supabase/ (a schema file, or tests/... for a smoke file). `row`
is a substring of the smoke row(s) that must FAIL. The scratch copy gets the
repo's node_modules beside it (a junction on Windows, a symlink elsewhere);
run `npm ci` once first. Exit 0 = every plant CAUGHT.

Pure stdlib, Python 3; needs node.
"""
import argparse
import io
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile

REPO = os.path.normpath(os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..', '..', '..'))


def link_modules(work):
    src, dst = os.path.join(REPO, 'node_modules'), os.path.join(work, 'node_modules')
    if os.path.exists(dst):
        return
    if not os.path.isdir(os.path.join(src, '@electric-sql', 'pglite')):
        sys.exit('No node_modules/@electric-sql/pglite in the repo: run `npm ci` first.')
    if os.name == 'nt':
        subprocess.check_call(['cmd', '/c', 'mklink', '/J', dst, src], stdout=subprocess.DEVNULL)
    else:
        os.symlink(src, dst)


def run_smoke(work, smoke):
    env = dict(os.environ, SHOW='1')
    p = subprocess.run(['node', os.path.join(work, 'supabase', 'tests', 'run_pglite.mjs'), smoke],
                       cwd=work, capture_output=True, text=True, encoding='utf-8', errors='replace', env=env)
    return p.stdout + p.stderr


def main():
    ap = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    ap.add_argument('spec', help='plants.json')
    ap.add_argument('--work', help='scratch directory (default: a new temp dir, removed after)')
    a = ap.parse_args()
    with io.open(a.spec, encoding='utf-8') as f:
        spec = json.load(f)
    smoke, plants = spec['smoke'], spec['plants']
    work = a.work or tempfile.mkdtemp(prefix='mog-plant-')
    os.makedirs(work, exist_ok=True)
    if os.path.exists(os.path.join(work, 'supabase')):
        shutil.rmtree(os.path.join(work, 'supabase'))
    shutil.copytree(os.path.join(REPO, 'supabase'), os.path.join(work, 'supabase'))
    link_modules(work)

    # The unplanted copy must pass first, or nothing below means anything.
    base = run_smoke(work, smoke)
    if 'ALL PASS' not in base:
        print(base[-2000:])
        sys.exit('The smoke file fails before any plant: fix that first.')

    missed = 0
    for pl in plants:
        path = os.path.join(work, 'supabase', pl['file'].replace('/', os.sep))
        with io.open(path, encoding='utf-8', newline='') as f:
            orig = f.read()
        text = orig.replace('\r\n', '\n')
        n = text.count(pl['old'])
        if n != pl.get('count', 1):
            missed += 1
            print('BAD     %s: `old` occurs %d times in %s (count says %d)' % (pl['name'], n, pl['file'], pl.get('count', 1)))
            continue
        with io.open(path, 'w', encoding='utf-8', newline='\n') as f:
            f.write(text.replace(pl['old'], pl['new']))
        out = run_smoke(work, smoke)
        with io.open(path, 'w', encoding='utf-8', newline='') as f:
            f.write(orig)
        fails = []
        for l in out.splitlines():   # the runner's FAIL row lines, not its per-file summary
            l = l.strip()
            if l.startswith('FAIL') and not re.match(r'FAIL\s+\S+\.sql', l) and l not in fails:
                fails.append(l)
        ran = ('ok    ' + os.path.basename(pl['file'])) in out if pl['file'].startswith('schema') else True
        hit = ran and any(pl['row'] in f for f in fails)
        missed += 0 if hit else 1
        print(('CAUGHT  ' if hit else 'MISSED  ') + pl['name'] + ('' if ran else '  (%s did not run: a broken plant, not a catch)' % pl['file']))
        for f in fails:
            print('          ' + f[:150])
    if not a.work:
        shutil.rmtree(work, ignore_errors=True)
    print('ALL CAUGHT' if not missed else '%d NOT CAUGHT' % missed)
    sys.exit(1 if missed else 0)


if __name__ == '__main__':
    main()
