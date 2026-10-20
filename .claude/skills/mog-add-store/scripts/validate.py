#!/usr/bin/env python
"""Deterministic checks for the mog-add-store runbook.

Each check replaces eyeballing a value or a file. A wrong-shape value sends
you down the wrong troubleshooting branch, so these fail loud and say why.

Usage (from the repo root):
    python .claude/skills/mog-add-store/scripts/validate.py slug <slug>
    python .claude/skills/mog-add-store/scripts/validate.py concept "<Concept>"
    python .claude/skills/mog-add-store/scripts/validate.py scriptid <value>
    python .claude/skills/mog-add-store/scripts/validate.py sheetid <id or Sheet URL>
    python .claude/skills/mog-add-store/scripts/validate.py exec-url <value>
    python .claude/skills/mog-add-store/scripts/validate.py wired <slug> [--published]

  slug      a new store's slug: Supabase's shape (2-20 lowercase letters or
            digits, no hyphens: mog.stores and the Move prompt refuse them),
            not used in stores.json, .clasp-targets.json or
            provision_stores.sql, and not a repo file or folder.
  concept   the exact stores.json concept string: a CONCEPT_TO_THEME key in
            build.py (else the app is unthemed), a hub CONCEPT_VISUALS key
            (else a generic icon), and a Dashboard.gs CONCEPT_THEMES key (else
            the setup wizard and the Sheet menus refuse it).
  scriptid  an Apps Script project ID (not a deployment ID or a Sheet ID).
  sheetid   a Google Sheet ID; a pasted Sheet URL is accepted and the ID printed.
  exec-url  the web app's /exec URL; prints the deploymentId inside it.
  wired     the store's entries agree across .clasp-targets.json,
            supabase/provision_stores.sql and (once added) stores.json, the
            built <slug>/ and <slug>/editor/ pages, and the hub registry.
            --published makes the stores.json and build parts required.

Exit 0 + "OK" when everything checks out; exit 1 + one line per problem;
exit 2 on bad usage. Pure stdlib, Python 3. MOG_REPO overrides the repo root
(tests only).
"""
import importlib.util
import json
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.environ.get('MOG_REPO') or os.path.abspath(os.path.join(HERE, '..', '..', '..', '..'))

TARGETS_FILE   = os.path.join(ROOT, 'apps-script', '.clasp-targets.json')
STORES_FILE    = os.path.join(ROOT, 'stores.json')
PROVISION_FILE = os.path.join(ROOT, 'supabase', 'provision_stores.sql')
BUILD_FILE     = os.path.join(ROOT, 'build.py')
HUB_FILE       = os.path.join(ROOT, 'index.html')

# Supabase is the strictest consumer of a slug: mog.stores' check constraint,
# mog.provision_store and the Move this store to Supabase prompt all use it.
SLUG_RE      = re.compile(r'^[a-z0-9]{2,20}$')
# Apps Script project IDs: "1" + ~56 base64url chars (57 on every store).
SCRIPT_ID_RE = re.compile(r'^1[A-Za-z0-9_-]{50,70}$')
# Web-app deployment IDs: "AKfycb" + base64url, 72-74 chars on every store.
DEPLOY_ID_RE = re.compile(r'^AKfycb[A-Za-z0-9_-]{50,90}$')
# Google Sheet IDs: 44 base64url chars on every store.
SHEET_ID_RE  = re.compile(r'^[A-Za-z0-9_-]{40,50}$')
SHEET_URL_RE = re.compile(r'^https://docs\.google\.com/spreadsheets/d/([A-Za-z0-9_-]+)')
EXEC_URL_RE  = re.compile(r'^https://script\.google\.com/macros/s/([^/]+)/exec$')
# provision_stores.sql rows: ( n, 'slug', 'Store name', 'Sheet title'),
PROVISION_ROW_RE = re.compile(r"\(\s*\d+,\s*'([a-z0-9]+)',\s*'((?:[^']|'')*)',\s*'((?:[^']|'')*)'\)")


def load_json(path):
    with open(path, encoding='utf-8') as f:
        return json.load(f)


def read(path):
    with open(path, encoding='utf-8') as f:
        return f.read()


def straight(s):
    """Curly apostrophes to straight, for comparing names across files."""
    return str(s).replace('‘', "'").replace('’', "'")


_BUILD = []


def build_module():
    if not _BUILD:
        spec = importlib.util.spec_from_file_location('mog_build', BUILD_FILE)
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)   # build.py only runs main() under __main__
        _BUILD.append(mod)
    return _BUILD[0]


def concept_to_theme():
    return build_module().CONCEPT_TO_THEME


def server_concepts():
    """The concepts a store can be set to: Dashboard.gs CONCEPT_THEMES' keys,
    'default' aside. The wizard and both Sheet menus accept exactly these
    (Editor.gs commitStoreSetup, Admin.gs; tests/concepts.test.js)."""
    return [k for k in build_module().read_concept_themes() if k != 'default']


def hub_concepts():
    """The keys of index.html's CONCEPT_VISUALS, with JS escapes undone."""
    text = read(HUB_FILE)
    m = re.search(r'const CONCEPT_VISUALS = \{(.*?)\n\s*\};', text, re.S)
    if not m:
        return None
    keys = []
    for k in re.findall(r"^\s*'((?:[^'\\]|\\.)*)'\s*:", m.group(1), re.M):
        k = re.sub(r'\\u([0-9a-fA-F]{4})', lambda x: chr(int(x.group(1), 16)), k)
        keys.append(k.replace("\\'", "'"))
    return keys


def provision_rows():
    rows = {}
    sql = re.sub(r'--[^\n]*', '', read(PROVISION_FILE))   # a commented-out row is not a row
    for m in PROVISION_ROW_RE.finditer(sql):
        rows[m.group(1)] = {'store': m.group(2).replace("''", "'"), 'sheet': m.group(3).replace("''", "'")}
    return rows


def stores_list():
    data = load_json(STORES_FILE)
    return data if isinstance(data, list) else data.get('stores', [])


# ---- checks: each returns a list of problems ([] = OK) plus lines to print ----

def check_slug(slug):
    problems = []
    if not SLUG_RE.match(slug):
        problems.append('slug must be 2-20 lowercase letters or digits, no hyphens or capitals '
                        '(Supabase refuses anything else: mog.stores, provision_store, the Move prompt)')
    if any(s.get('slug') == slug for s in stores_list()):
        problems.append('stores.json already has "' + slug + '" (slugs are immutable once published; pick a new one)')
    if any(t.get('slug') == slug for t in load_json(TARGETS_FILE)):
        problems.append('apps-script/.clasp-targets.json already has "' + slug + '"')
    if slug in provision_rows():
        problems.append('supabase/provision_stores.sql already has "' + slug + '"')
    if os.path.exists(os.path.join(ROOT, slug)):
        problems.append('a repo file or folder is already called "' + slug + '" (build.py writes <slug>/ at the root)')
    return problems, []


def check_concept(concept):
    problems, notes = [], []
    themes = concept_to_theme()
    if concept not in themes:
        typed = straight(concept).lower()
        near = [k for k in themes if straight(k).lower() == typed or (typed and straight(k).lower().startswith(typed))]
        if near:
            problems.append('not a build.py CONCEPT_TO_THEME key as typed; build.py spells it ' +
                            ' or '.join(repr(k) for k in near) + ' (apostrophes must match exactly)')
        else:
            problems.append('not in build.py CONCEPT_TO_THEME (' + ', '.join(repr(k) for k in themes) +
                            '). A new concept needs build.py, a template theme block and the hub first.')
        return problems, notes
    theme = themes[concept]
    notes.append('app theme: ' + theme)
    hub = hub_concepts()
    if hub is not None and concept not in hub:
        notes.append('NOTE: the hub has no CONCEPT_VISUALS entry spelled ' + repr(concept) +
                     ', so its concept tile shows a generic icon')
    if theme in server_concepts():   # build.py's theme slugs are the server's concept values
        notes.append('setup wizard: can save this concept')
    else:
        problems.append('Dashboard.gs CONCEPT_THEMES has no "' + theme + '", so the setup wizard and the Sheet '
                        'menus refuse it. Add it there (with its name) before onboarding.')
    used = sorted({s['concept'] for s in stores_list() if straight(s.get('concept', '')) == straight(concept)})
    if used and concept not in used:
        problems.append('stores.json already spells this concept ' + ' or '.join(repr(u) for u in used) +
                        '; use that exact string')
    return problems, notes


def check_scriptid(value):
    if SCRIPT_ID_RE.match(value):
        return [], []
    if value.startswith('AKfycb'):
        return ['that is a deployment ID (wrong field). The Script ID is under Project Settings (gear icon) '
                'in the Apps Script editor.'], []
    if SHEET_ID_RE.match(value):
        return ['that looks like a Sheet ID (44 characters; a Script ID has about 57). The Script ID is under '
                'Project Settings (gear icon) in the Apps Script editor.'], []
    return ['not a Script ID: copy it from Project Settings (gear icon) in the Apps Script editor.'], []


def check_sheetid(value):
    m = SHEET_URL_RE.match(value)
    sid = m.group(1) if m else value
    if SHEET_ID_RE.match(sid):
        return [], ['sheet id: ' + sid]
    if SCRIPT_ID_RE.match(sid):
        return ['that is a Script ID (about 57 characters). The Sheet ID is the part of the Sheet\'s address '
                'between /d/ and /edit.'], []
    return ['not a Sheet ID: paste the Sheet\'s address (docs.google.com/spreadsheets/d/<id>/edit) or the '
            '<id> part.'], []


def check_exec_url(value):
    m = EXEC_URL_RE.match(value)
    if not m:
        return ['not a web-app /exec URL. If it ends in /edit or /dev you copied the wrong field: use the '
                '"Web app" URL shown when Deploy finishes.'], []
    if not DEPLOY_ID_RE.match(m.group(1)):
        return ['the part between /s/ and /exec is not a deployment ID (it should start with AKfycb).'], []
    return [], ['deploymentId: ' + m.group(1)]


def check_wired(slug, published):
    problems, notes = [], []
    target = next((t for t in load_json(TARGETS_FILE) if t.get('slug') == slug), None)
    if not target:
        problems.append('.clasp-targets.json: no entry for "' + slug + '"')
    else:
        if not SCRIPT_ID_RE.match(str(target.get('scriptId', ''))):
            problems.append('.clasp-targets.json: scriptId is not a Script ID')
        if not DEPLOY_ID_RE.match(str(target.get('deploymentId', ''))):
            problems.append('.clasp-targets.json: deploymentId missing or not AKfycb... '
                            '(deploy.py --redeploy refuses to run for ANY store while one is missing)')
        sheet = target.get('sheet') or {}
        if not str(sheet.get('title', '')).strip():
            problems.append('.clasp-targets.json: sheet.title missing (tests/supabase_move.test.js reads it)')
        if not SHEET_ID_RE.match(str(sheet.get('id', ''))):
            problems.append('.clasp-targets.json: sheet.id missing or not a Sheet ID (editor_link.py links it)')
        if not str(target.get('label', '')).strip():
            problems.append('.clasp-targets.json: label missing')

    row = provision_rows().get(slug)
    if not row:
        problems.append('supabase/provision_stores.sql: no row for "' + slug + '" (its connect code comes from it)')
    elif target and row['sheet'] != (target.get('sheet') or {}).get('title'):
        problems.append('provision_stores.sql: Sheet "' + row['sheet'] + '" vs .clasp-targets.json "' +
                        str((target.get('sheet') or {}).get('title')) + '" (must be identical)')

    store = next((s for s in stores_list() if s.get('slug') == slug), None)
    if not store:
        (problems if published else notes).append('stores.json: no entry yet' + ('' if published else ' (added at publish time)'))
    else:
        themes = concept_to_theme()
        if store.get('concept') not in themes:
            problems.append('stores.json: concept ' + repr(store.get('concept')) + ' is not a build.py CONCEPT_TO_THEME key')
        if not re.match(r'^.*\S\s+(BOH|FOH)$', str(store.get('location', ''))):
            problems.append('stores.json: location should be "<Site> BOH" or "<Site> FOH" (the hub splits it into site and area)')
        if store.get('editor') != 'supabase':
            problems.append('stores.json: "editor": "supabase" missing (every store has it since 2026-10-19, U11)')
        m = EXEC_URL_RE.match(str(store.get('deployment', '')))
        if not m:
            problems.append('stores.json: deployment is not an /exec URL')
        elif target and m.group(1) != target.get('deploymentId'):
            problems.append('stores.json: deployment URL\'s ID differs from .clasp-targets.json deploymentId')
        if not str(store.get('address', '')).strip():
            notes.append('NOTE: stores.json has no address (Copy order for email leaves it out)')
        if row and straight(row['store']) != straight(store.get('concept', '') + ' ' + store.get('location', '')):
            problems.append('provision_stores.sql: store name "' + row['store'] + '" must be "' +
                            store.get('concept', '') + ' ' + store.get('location', '') + '" (concept + location)')
        built = [os.path.join(slug, 'index.html'), os.path.join(slug, 'sw.js'), os.path.join(slug, 'editor', 'index.html')]
        missing = [p for p in built if not os.path.exists(os.path.join(ROOT, p))]
        if missing:
            problems.append('not built yet: ' + ', '.join(missing) + ' (run python build.py)')
        reg = re.search(r'^.*// __STORE_REGISTRY__ build-injected.*$', read(HUB_FILE), re.M)
        if not reg or ('"slug": "' + slug + '"') not in reg.group(0):
            problems.append('index.html: the hub registry has no "' + slug + '" (run python build.py)')
    return problems, notes


def main(argv):
    try:
        sys.stdout.reconfigure(encoding='utf-8')
    except AttributeError:
        pass
    args = argv[1:]
    published = '--published' in args
    args = [a for a in args if a != '--published']
    checks = {'slug': check_slug, 'concept': check_concept, 'scriptid': check_scriptid,
              'sheetid': check_sheetid, 'exec-url': check_exec_url}
    if len(args) == 2 and args[0] in checks:
        problems, notes = checks[args[0]](args[1].strip())
    elif len(args) == 2 and args[0] == 'wired':
        problems, notes = check_wired(args[1].strip(), published)
    else:
        print('usage: validate.py {slug|concept|scriptid|sheetid|exec-url} <value>')
        print('       validate.py wired <slug> [--published]')
        return 2

    for n in notes:
        print(n)
    if problems:
        for p in problems:
            print('INVALID (' + args[0] + '): ' + p)
        return 1
    print('OK')
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv))
