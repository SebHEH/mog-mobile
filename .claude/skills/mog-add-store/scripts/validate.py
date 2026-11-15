#!/usr/bin/env python
"""Deterministic checks for the mog-add-store runbook (stores made in HQ, schema v26).

Each check replaces eyeballing a value or a file. A wrong-shape value sends
you down the wrong troubleshooting branch, so these fail loud and say why.

Usage (from the repo root):
    python .claude/skills/mog-add-store/scripts/validate.py slug <slug>
    python .claude/skills/mog-add-store/scripts/validate.py concept "<Concept>"
    python .claude/skills/mog-add-store/scripts/validate.py entry '<the store's row as JSON>'
    python .claude/skills/mog-add-store/scripts/validate.py wired <slug> [--published]

  slug      a web address not used in stores.json and not a repo file or
            folder, in Supabase's shape (2-20 lowercase letters or digits).
            HQ's New store checks the same before it saves; this is for
            answering "is <slug> free?" before Sebastian types it.
  concept   the exact stores.json concept string: a CONCEPT_TO_THEME key in
            build.py (else the app is unthemed), a hub CONCEPT_VISUALS key
            (else a generic icon), and a Concepts.gs CONCEPT_THEMES key (else
            the nightly recap has no band colour).
  entry     the store's mog.stores row, as the Supabase connector returns it
            ({"slug", "location", "concept", "address", "is_test"}), turned
            into its stores.json entry, printed for pasting: the concept's
            stores.json spelling, the location without the concept and
            "(TEST)", "editor": "supabase", no /exec address, and
            "test": true for a test store.
  wired     the store's stores.json entry and its built pages agree: a
            known concept, "<Site> BOH|FOH", the app editor, its folder and
            editor built, and the hub listing it (a test store: not listed).
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

STORES_FILE = os.path.join(ROOT, 'stores.json')
BUILD_FILE  = os.path.join(ROOT, 'build.py')
HUB_FILE    = os.path.join(ROOT, 'index.html')

# Supabase is the strictest consumer of a slug: mog.stores and
# mog.store_create (schema v26) refuse anything else.
SLUG_RE = re.compile(r'^[a-z0-9]{2,20}$')
EXEC_URL_RE = re.compile(r'^https://script\.google\.com/macros/s/([^/]+)/exec$')


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


def recap_concepts():
    """Concepts.gs CONCEPT_THEMES' keys ('default' aside): the recap's band colours."""
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


def stores_list():
    data = load_json(STORES_FILE)
    return data if isinstance(data, list) else data.get('stores', [])


def concept_string(key):
    """The stores.json spelling of a theme key (the first in build.py: ĂN before AN)."""
    for name, theme in concept_to_theme().items():
        if theme == key:
            return name
    return None


# ---- checks: each returns a list of problems ([] = OK) plus lines to print ----

def check_slug(slug):
    problems = []
    if not SLUG_RE.match(slug):
        problems.append('the web address must be 2-20 lowercase letters or digits, no hyphens or capitals '
                        '(Supabase refuses anything else)')
    if any(s.get('slug') == slug for s in stores_list()):
        problems.append('stores.json already has "' + slug + '" (slugs are immutable once published; pick a new one)')
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
                            '). A new concept needs build.py, a template theme block, the hub, HQ and the SQL first.')
        return problems, notes
    theme = themes[concept]
    notes.append('app theme: ' + theme)
    hub = hub_concepts()
    if hub is not None and concept not in hub:
        notes.append('NOTE: the hub has no CONCEPT_VISUALS entry spelled ' + repr(concept) +
                     ', so its concept tile shows a generic icon')
    if theme not in recap_concepts():
        problems.append('Concepts.gs CONCEPT_THEMES has no "' + theme + '", so the nightly recap has no band '
                        'colour for it. Add it there (with its name) first.')
    used = sorted({s['concept'] for s in stores_list() if straight(s.get('concept', '')) == straight(concept)})
    if used and concept not in used:
        problems.append('stores.json already spells this concept ' + ' or '.join(repr(u) for u in used) +
                        '; use that exact string')
    return problems, notes


def check_entry(text):
    """The stores.json entry for a store made in HQ, from its mog.stores row."""
    problems, notes = [], []
    try:
        row = json.loads(text)
    except ValueError:
        return ['not JSON: paste the row the connector returned, e.g. {"slug": "rpballston", ...}'], []
    if isinstance(row, list):
        row = row[0] if len(row) == 1 else {}
    slug = str(row.get('slug', ''))
    problems += check_slug(slug)[0]
    concept = concept_string(row.get('concept'))
    if not concept:
        problems.append('concept ' + repr(row.get('concept')) + ' has no stores.json spelling in build.py CONCEPT_TO_THEME')
    loc = str(row.get('location', ''))
    test = row.get('is_test') is True or str(row.get('is_test')).lower() == 'true'
    if test:
        loc = re.sub(r'\s*\(TEST\)\s*$', '', loc)
    if concept and straight(loc).lower().startswith(straight(concept).lower() + ' '):
        loc = loc[len(concept) + 1:]
    if not re.match(r'^.*\S\s+(BOH|FOH)$', loc):
        problems.append('location ' + repr(row.get('location')) + ' does not end "<Site> BOH" or "<Site> FOH"')
    if problems:
        return problems, notes
    entry = {'slug': slug, 'concept': concept, 'location': loc}
    if str(row.get('address') or '').strip():
        entry['address'] = str(row['address']).strip()
    entry['editor'] = 'supabase'
    if test:
        entry['test'] = True
    notes.append(json.dumps(entry, ensure_ascii=False, indent=2))
    notes.append('Add it to stores.json ' + ('at the end (a test store: built, never on the hub).' if test
                 else 'next to its concept\'s stores, then bump CACHE_VERSION in the root sw.js (the hub list changes).'))
    return problems, notes


def check_wired(slug, published):
    problems, notes = [], []
    store = next((s for s in stores_list() if s.get('slug') == slug), None)
    if not store:
        (problems if published else notes).append('stores.json: no entry yet' + ('' if published else ' (added at publish time)'))
        return problems, notes
    themes = concept_to_theme()
    if store.get('concept') not in themes:
        problems.append('stores.json: concept ' + repr(store.get('concept')) + ' is not a build.py CONCEPT_TO_THEME key')
    if not re.match(r'^.*\S\s+(BOH|FOH)$', str(store.get('location', ''))):
        problems.append('stores.json: location should be "<Site> BOH" or "<Site> FOH" (the hub splits it into site and area)')
    if store.get('editor') != 'supabase':
        problems.append('stores.json: "editor": "supabase" missing')
    if 'deployment' in store and not EXEC_URL_RE.match(str(store['deployment'])):
        problems.append('stores.json: deployment is not an /exec URL (a store made in HQ has none: leave the field out)')
    if not str(store.get('address', '')).strip():
        notes.append('NOTE: stores.json has no address (Copy order for email leaves it out)')
    built = [os.path.join(slug, 'index.html'), os.path.join(slug, 'sw.js'), os.path.join(slug, 'editor', 'index.html')]
    missing = [p for p in built if not os.path.exists(os.path.join(ROOT, p))]
    if missing:
        problems.append('not built yet: ' + ', '.join(missing) + ' (run python build.py)')
    reg = re.search(r'^.*// __STORE_REGISTRY__ build-injected.*$', read(HUB_FILE), re.M)
    listed = bool(reg) and ('"slug": "' + slug + '"') in reg.group(0)
    if store.get('test') is True and listed:
        problems.append('index.html: the hub lists a test store (run python build.py)')
    if store.get('test') is not True and not listed:
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
    checks = {'slug': check_slug, 'concept': check_concept, 'entry': check_entry}
    if len(args) == 2 and args[0] in checks:
        problems, notes = checks[args[0]](args[1].strip())
    elif len(args) == 2 and args[0] == 'wired':
        problems, notes = check_wired(args[1].strip(), published)
    else:
        print('usage: validate.py {slug|concept|entry} <value>')
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
