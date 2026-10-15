#!/usr/bin/env python3
"""
editor_link.py -- print the exact "run this in the Apps Script editor" request.

Every time Sebastian is asked to run a function by hand, the request names
the store, the .gs file that defines the function, the function itself, a
direct editor link, and the store's Sheet. This finds the file and the links,
so a request is never a bare function name (global skill:
appsscript-editor-action). Paste its output; don't paraphrase it.

usage:
  python editor_link.py <function> <store-slug> [<store-slug> ...]
  python editor_link.py <function> all        one block per store
  python editor_link.py --list                the store slugs

Refuses (exit 1):
  - a name ending in "_": the editor's Run menu hides those, so the request
    would be impossible (name a public wrapper instead)
  - a name no apps-script/*.gs file declares at top level
  - a name declared in two .gs files (one flat namespace; one silently wins)
  - no store, or an unknown one. MOG is one codebase in ten Sheets, so a
    request without a store makes him guess which one.

Reads apps-script/.clasp-targets.json (the deploy manifest): scriptId per
store, plus that store's Sheet as "sheet": {"title": ..., "id": ...}.
MOG_APPS_DIR overrides the apps-script folder (tests only).
"""
import json
import os
import re
import sys

ROOT = os.path.dirname(os.path.abspath(__file__))
APPS = os.environ.get('MOG_APPS_DIR') or os.path.join(ROOT, 'apps-script')
TARGETS = os.path.join(APPS, '.clasp-targets.json')


def die(msg):
    print('editor_link: ' + msg, file=sys.stderr)
    sys.exit(1)


def load_targets():
    with open(TARGETS, encoding='utf-8') as f:
        return json.load(f)


def files_declaring(fn):
    pattern = re.compile(r'^function\s+' + re.escape(fn) + r'\s*\(', re.M)
    hits = []
    for name in sorted(os.listdir(APPS)):
        if name.endswith('.gs'):
            with open(os.path.join(APPS, name), encoding='utf-8') as f:
                if pattern.search(f.read()):
                    hits.append(name)
    return hits


def block(fn, gs_file, target):
    lines = [
        'Run **`%s`** in **`%s`**, Apps Script project for **%s** (`%s`)'
        % (fn, gs_file, target.get('label', target['slug']), target['slug']),
        '- Editor: https://script.google.com/d/%s/edit -- open `%s`, pick `%s` in the function dropdown, press Run'
        % (target['scriptId'], gs_file, fn),
    ]
    sheet = target.get('sheet')
    if sheet and sheet.get('id'):
        lines.append('- Or from its Sheet, *%s*: https://docs.google.com/spreadsheets/d/%s/edit -- Extensions > Apps Script'
                     % (sheet.get('title', 'the Sheet'), sheet['id']))
    else:
        lines.append('- Sheet: not recorded for this store in apps-script/.clasp-targets.json')
    return '\n'.join(lines)


def main(argv):
    try:
        sys.stdout.reconfigure(encoding='utf-8')
    except AttributeError:
        pass
    targets = load_targets()
    by_slug = {t['slug']: t for t in targets}

    if argv[:1] == ['--list']:
        for t in targets:
            print('%-10s %s' % (t['slug'], t.get('label', '')))
        return 0
    if not argv:
        die(__doc__.strip().split('\n\n')[1].strip())

    fn, slugs = argv[0], argv[1:]
    if fn.endswith('_'):
        die('"%s" ends in "_", so the editor hides it from the Run menu. Name a public wrapper instead.' % fn)
    hits = files_declaring(fn)
    if not hits:
        die('no apps-script/*.gs file declares function %s at top level' % fn)
    if len(hits) > 1:
        die('function %s is declared in %s; one of them silently wins at runtime' % (fn, ' and '.join(hits)))
    if not slugs:
        die('which store? Every store runs this code in its own Sheet. Pass a slug, or "all". Slugs: '
            + ', '.join(by_slug))
    if slugs == ['all']:
        chosen = targets
    else:
        unknown = [s for s in slugs if s not in by_slug]
        if unknown:
            die('unknown store slug(s): %s. Slugs: %s' % (', '.join(unknown), ', '.join(by_slug)))
        chosen = [by_slug[s] for s in slugs]

    print('\n\n'.join(block(fn, hits[0], t) for t in chosen))
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
