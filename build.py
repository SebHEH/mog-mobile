#!/usr/bin/env python3
"""
build.py — generate per-store PWA directories and (if present) inject the
hub registry into the root index.html.

Reads stores.json at repo root. For each entry:
  - Validates required fields and value formats
  - Creates <slug>/ directory if missing
  - Writes <slug>/index.html = template/index.html with __MOG_API_URL__
    substituted with the entry's deployment URL, the Supabase config
    (URL + publishable key from apps-script/Sync.gs, plus the slug), and
    apps-script/OrderMath.gs copied in verbatim at its marker
  - Writes <slug>/sw.js = verbatim copy of template/sw.js

If root index.html exists with the STORE_REGISTRY marker line, the registry
(concept + location + slug only — no deployment URLs) is injected into it.

Idempotent: re-running with unchanged inputs produces unchanged outputs.
Removing a store from stores.json does NOT auto-delete its directory; that's
a manual `git rm -r <slug>/` step on the operator's side.

Usage:
  python3 build.py            # generate / inject
  python3 build.py --dry-run  # show what would happen, write nothing
  python3 build.py --preview rprfotest --like rprfo
                              # the editor for a Supabase test store, under
                              # _preview/ (git-ignored); builds nothing else
"""

import json
import os
import re
import sys

ROOT = os.path.dirname(os.path.abspath(__file__))
STORES_JSON    = os.path.join(ROOT, 'stores.json')
TEMPLATE_DIR   = os.path.join(ROOT, 'template')
TEMPLATE_INDEX = os.path.join(TEMPLATE_DIR, 'index.html')
TEMPLATE_SW    = os.path.join(TEMPLATE_DIR, 'sw.js')
HUB_INDEX      = os.path.join(ROOT, 'index.html')
ORDER_MATH     = os.path.join(ROOT, 'apps-script', 'OrderMath.gs')
SYNC_GS        = os.path.join(ROOT, 'apps-script', 'Sync.gs')
APPS_SCRIPT    = os.path.join(ROOT, 'apps-script')
DASHBOARD_GS   = os.path.join(APPS_SCRIPT, 'Dashboard.gs')
EDITOR_SRC     = os.path.join(TEMPLATE_DIR, 'editor')
PREVIEW_DIR    = os.path.join(ROOT, '_preview')   # git-ignored: test stores, never published

# The editor on Supabase (docs/MOG_OneApp_Spec.md Phases 2 and 4): each
# published page is an Apps Script page rendered as-is, its scriptlets filled
# in here, plus the files that answer its server calls from Supabase. A page
# is file: (Apps Script page, title, the name host.js knows it by). Published
# under <slug>/editor/ for a store whose stores.json entry says
# "editor": "supabase" (every store since 2026-10-19, docs/MOG_OneApp_Spec.md
# U11: the app shows its Manage section only once Supabase says the store's
# editor has moved, schema v8's switch), and for a test store by --preview.
EDITOR_PAGES  = {'index.html':    ('EditorHome', 'Editor', 'home'),
                 'items.html':    ('ManageItems', 'Manage Items', 'items'),
                 'vendors.html':  ('ManageVendors', 'Manage Vendors', 'vendors'),
                 'areas.html':    ('StorageAreas', 'Storage Areas', 'areas'),
                 'pickpath.html': ('ReorderPickPath', 'Shelf to Sheet', 'pickpath'),
                 'history.html':  ('OrderHistory', 'Order History', 'history'),
                 'healthcheck.html': ('HealthCheck', 'Store Health Check', 'healthcheck'),
                 # Pages only the app's editor has (no Apps Script twin) come
                 # from template/editor/ ('editor:<name>').
                 'changes.html':  ('editor:Changes', 'Changes', 'changes'),
                 'overview.html': ('editor:Overview', 'Overview', 'overview')}
# Scriptlets the static pages start empty; host.js fills them from Supabase
# after sign-in, before each page's start-up function reads them.
EDITOR_EMPTY  = {'vendorListJson': '[]', 'vendorTableJson': '[]', 'areaListJson': '[]', 'pickDataJson': '{}'}
EDITOR_ASSETS = ('catalogEdit.js', 'meImport.js', 'host.js')
SCRIPTLET_RE  = re.compile(r'<\?!=\s*(.*?)\s*\?>', re.S)

# Slugs that would collide with our repo structure.
RESERVED_SLUGS = {
    'template', '_build_scripts', 'sw.js', 'manifest.webmanifest',
    'stores.json', 'build.py', 'readme', 'readme.md',
}

# Supabase's rule (mog.stores, mog.provision_store, the Move this store to
# Supabase prompt): a slug it refuses could be built and published but never
# connect.
SLUG_RE       = re.compile(r'^[a-z0-9]{2,20}$')
DEPLOY_URL_RE = re.compile(r'^https://script\.google\.com/macros/s/[^/]+/exec$')

API_URL_PLACEHOLDER = '__MOG_API_URL__'
THEME_PLACEHOLDER   = '__MOG_THEME__'
ICON_PLACEHOLDER    = '__MOG_APPLE_TOUCH_ICON__'
SUPABASE_PLACEHOLDER   = '/*__MOG_SUPABASE__*/null'
ORDER_MATH_PLACEHOLDER = '/* __MOG_ORDER_MATH__ build-injected */'
STORE_PLACEHOLDER      = '/*__MOG_STORE__*/null'
REGISTRY_MARKER     = '// __STORE_REGISTRY__ build-injected'

# Maps the human-readable concept name (from stores.json) to a CSS theme
# slug. The template has a [data-theme="..."] selector block for each.
# A concept not listed here stops the build (validate_stores): a near miss,
# like a straight apostrophe in Teas’n You, would otherwise build that store
# unthemed without a word. The names are the app's own (template/index.html
# CONCEPT_NAMES_), also used by the hub's CONCEPT_VISUALS, the setup wizard
# and Dashboard.gs CONCEPT_THEMES; tests/concepts.test.js keeps them equal.
CONCEPT_TO_THEME = {
    "Roll Play":  "roll-play",
    "Lei’d Poke": "leid",      # curly U+2019, like Teas’n You
    "Teas’n You": "teasnyou",  # curly U+2019 — must match stores.json + hub CONCEPT_VISUALS
    "ĂN":         "an",        # precomposed U+0102
    "AN":         "an",        # alternate ASCII spelling
}

# Maps concept name to the apple-touch-icon <link> tag substituted into
# the template's head. Concepts without a vectorized logo get '' (empty
# string), which leaves no apple-touch-icon link in the rendered HTML —
# iOS then falls back to its default home-screen icon (page screenshot).
# To add an icon for a new concept later, drop the PNGs into icons/ and
# add an entry here. No template change needed.
CONCEPT_TO_APPLE_TOUCH_ICON = {
    "Roll Play": '<link rel="apple-touch-icon" href="../icons/rp-180.png">',
}


def fail(msg):
    print(f"[error] {msg}", file=sys.stderr)
    sys.exit(1)


# ---------------------------------------------------------------------------
# Validation
# ---------------------------------------------------------------------------

def validate_stores(stores):
    """Strict validation. Fail fast on any malformed entry."""
    if not isinstance(stores, list):
        fail("stores.json must be a JSON array")
    if not stores:
        fail("stores.json is empty — at least one store entry required")

    required_fields = ('slug', 'concept', 'location', 'deployment')
    slugs_seen = set()

    for idx, entry in enumerate(stores):
        prefix = f"stores.json[{idx}]"
        if not isinstance(entry, dict):
            fail(f"{prefix}: expected object, got {type(entry).__name__}")

        for field in required_fields:
            if field not in entry:
                fail(f"{prefix}: missing required field '{field}'")
            if not isinstance(entry[field], str) or not entry[field].strip():
                fail(f"{prefix}: field '{field}' must be a non-empty string")

        slug = entry['slug']
        if not SLUG_RE.match(slug):
            fail(f"{prefix}: invalid slug {slug!r} — must be 2-20 lowercase letters or digits "
                 f"(no hyphens: Supabase refuses them)")
        if slug.lower() in RESERVED_SLUGS:
            fail(f"{prefix}: slug {slug!r} is reserved (collides with repo file/dir)")
        if slug in slugs_seen:
            fail(f"{prefix}: duplicate slug {slug!r} — slugs must be unique")
        slugs_seen.add(slug)

        if entry['concept'] not in CONCEPT_TO_THEME:
            fail(f"{prefix}: unknown concept {entry['concept']!r} — use one of "
                 f"{', '.join(repr(k) for k in CONCEPT_TO_THEME)} exactly (apostrophes included), "
                 f"or add it to CONCEPT_TO_THEME first")

        # Optional: the street address vendors deliver to (the Copy order email).
        if 'address' in entry and (not isinstance(entry['address'], str) or not entry['address'].strip()):
            fail(f"{prefix}: field 'address' must be a non-empty string when present")
        # Optional: "supabase" once the store's editor moved to the app (schema
        # v8's switch). Its editor is then published under <slug>/editor/.
        if 'editor' in entry and entry['editor'] != 'supabase':
            fail(f"{prefix}: field 'editor' must be 'supabase' when present")

        if not DEPLOY_URL_RE.match(entry['deployment']):
            fail(f"{prefix}: deployment URL does not match Apps Script pattern\n"
                 f"  expected: https://script.google.com/macros/s/<id>/exec\n"
                 f"  got:      {entry['deployment']!r}")


# ---------------------------------------------------------------------------
# Per-store generation
# ---------------------------------------------------------------------------

# ---------------------------------------------------------------------------
# Shared inputs: the order math and the Supabase project (step 5)
# ---------------------------------------------------------------------------

def read_order_math():
    """apps-script/OrderMath.gs, verbatim. The phone runs the same file as
    the server (design record D5); tests/ordermath_purity.test.js proves it
    needs nothing but plain JavaScript."""
    if not os.path.exists(ORDER_MATH):
        fail(f"apps-script/OrderMath.gs not found at {ORDER_MATH}")
    with open(ORDER_MATH, 'r', encoding='utf-8') as f:
        text = f.read()
    if '</script' in text.lower():
        fail("apps-script/OrderMath.gs contains '</script', which would end the page's <script> block")
    return text


def read_supabase_project():
    """The project URL and publishable key, from Sync.gs (one copy for the
    server and the phone). Both are public by design."""
    with open(SYNC_GS, 'r', encoding='utf-8') as f:
        text = f.read()
    url = re.search(r"^const SUPABASE_URL\s*=\s*'(https://[a-z0-9]+\.supabase\.co)';", text, re.M)
    key = re.search(r"^const SUPABASE_PUBLISHABLE_KEY\s*=\s*'(sb_publishable_[A-Za-z0-9_\-]+)';", text, re.M)
    if not url or not key:
        fail("apps-script/Sync.gs: SUPABASE_URL / SUPABASE_PUBLISHABLE_KEY not found in the expected form")
    return url.group(1), key.group(1)


# ---------------------------------------------------------------------------
# The editor's static pages (Phase 2)
# ---------------------------------------------------------------------------

def read_concept_themes():
    """CONCEPT_THEMES from Dashboard.gs: the accent the Sheet dashboard and
    the /exec editor already use, so the static editor can't drift from
    them. {concept: {accent, bannerFont, ink}}, with 'default'."""
    with open(DASHBOARD_GS, 'r', encoding='utf-8') as f:
        text = f.read()
    colors_m = re.search(r'^const DASH_COLORS = \{(.*?)^\};', text, re.M | re.S)
    themes_m = re.search(r'^const CONCEPT_THEMES = \{(.*?)^\};', text, re.M | re.S)
    if not colors_m or not themes_m:
        fail("apps-script/Dashboard.gs: DASH_COLORS / CONCEPT_THEMES not found in the expected form")
    colors = dict(re.findall(r'^\s*([A-Z_]+):\s*"([^"]+)"', colors_m.group(1), re.M))
    themes = {}
    for m in re.finditer(r"'([a-z-]+)':\s*\{([^}]*)\}", themes_m.group(1)):
        fields = {}
        for k, v in re.findall(r'(\w+):\s*("[^"]*"|DASH_COLORS\.\w+)', m.group(2)):
            if v.startswith('"'):
                fields[k] = v.strip('"')
            elif v.split('.')[1] in colors:
                fields[k] = colors[v.split('.')[1]]
            else:
                fail(f"apps-script/Dashboard.gs: CONCEPT_THEMES['{m.group(1)}'] uses unknown color {v}")
        if 'accent' not in fields or 'bannerFont' not in fields:
            fail(f"apps-script/Dashboard.gs: CONCEPT_THEMES['{m.group(1)}'] needs accent and bannerFont")
        themes[m.group(1)] = {'accent': fields['accent'], 'bannerFont': fields['bannerFont'],
                              'ink': fields.get('ink', fields['accent'])}
    if 'default' not in themes:
        fail("apps-script/Dashboard.gs: CONCEPT_THEMES has no 'default'")
    return themes


def js_json(obj):
    """JSON that is safe inside a <script> block."""
    return json.dumps(obj, ensure_ascii=False).replace('</', '<\\/')


def render_editor_page(page, title, name, boot, sb_cfg):
    """apps-script/<page>.html as a static page. Its scriptlets are filled in
    the way the /exec editor fills them (include() inserts a file as-is); the
    data ones (EDITOR_EMPTY) start empty because host.js fills them from
    Supabase before the page starts. Any other scriptlet fails the build.
    'editor:<name>' is template/editor/<name>.html, a page only the app's
    editor has; its includes still come from apps-script/."""
    if page.startswith('editor:'):
        page = page[len('editor:'):]
        path = os.path.join(EDITOR_SRC, page + '.html')
    else:
        path = os.path.join(APPS_SCRIPT, page + '.html')
    src = os.path.relpath(path, ROOT).replace(os.sep, '/')
    with open(path, 'r', encoding='utf-8') as f:
        text = f.read()

    def fill(m):
        expr = m.group(1).strip().rstrip(';').strip()
        inc = re.fullmatch(r"include\('([A-Za-z]+)'\)", expr)
        if inc:
            inc_path = os.path.join(APPS_SCRIPT, inc.group(1) + '.html')
            if not os.path.exists(inc_path):
                fail(f"{src} includes {inc.group(1)}, which doesn't exist")
            with open(inc_path, 'r', encoding='utf-8') as f:
                return f.read()
        if expr in EDITOR_EMPTY:
            return EDITOR_EMPTY[expr]
        if expr == 'webBootJson':
            return js_json(boot)
        fail(f"{src}: no static value for the scriptlet <?!= {expr} ?>")

    if text.count('<?') != len(SCRIPTLET_RE.findall(text)):
        fail(f"{src} has a scriptlet form the static build doesn't handle (only <?!= ... ?>)")
    # host.js goes first in <head>, before the page's own scripts: the PIN
    # gate calls google.script.run as soon as the page parses. (The page's
    # own <head>, not one an included file mentions.)
    if text.count('<head>') != 1:
        fail(f"{src}: expected exactly one <head>")
    # The charset and viewport come from HtmlService's response on /exec
    # (addMetaTag); a static page has to say them itself.
    head = ('<head>\n    <meta charset="utf-8">'
            '\n    <meta name="viewport" content="width=device-width, initial-scale=1.0">'
            '\n    <title>' + title + ' · ' + boot['store'] + '</title>'
            '\n    <script>window.MOG_SUPABASE = ' + js_json(sb_cfg) + '; window.MOG_EDITOR_PAGE = ' + js_json(name) + ';</script>'
            '\n    <script src="orderMath.js"></script>'
            '\n    <script src="catalogEdit.js"></script>'
            '\n    <script src="meImport.js"></script>'
            '\n    <script src="host.js"></script>')
    text = text.replace('<head>', head, 1)
    return SCRIPTLET_RE.sub(fill, text)   # included files are inserted as-is, never re-read


def generate_editor(target_dir, entry, slug, location, supabase, themes, dry_run):
    """<target_dir>/editor/: every editor page plus the files it loads."""
    concept = CONCEPT_TO_THEME.get(entry['concept'], '')
    boot = {'web': True, 'store': location, 'abbr': slug.upper(), 'base': 'index.html',
            'theme': themes.get(concept, themes['default']), 'concept': concept}
    sb_cfg = {'url': supabase[0], 'key': supabase[1], 'slug': slug}
    out_dir = os.path.join(target_dir, 'editor')
    files = {}
    for name, (page, title, key) in EDITOR_PAGES.items():
        files[name] = render_editor_page(page, title, key, boot, sb_cfg)
    for name in EDITOR_ASSETS:
        with open(os.path.join(EDITOR_SRC, name), 'r', encoding='utf-8') as f:
            files[name] = f.read()
    # The order math the phone runs, verbatim: Order History's rows and the
    # Par Review flags (docs/MOG_OneApp_Spec.md T1).
    with open(ORDER_MATH, 'r', encoding='utf-8') as f:
        files['orderMath.js'] = f.read()
    rel = os.path.relpath(out_dir, ROOT).replace(os.sep, '/')
    for name, body in files.items():
        if dry_run:
            print(f"  [dry-run] write {rel}/{name} ({len(body):,} bytes)")
            continue
        os.makedirs(out_dir, exist_ok=True)
        with open(os.path.join(out_dir, name), 'w', encoding='utf-8') as f:
            f.write(body)
        print(f"  [done]    write {rel}/{name} ({len(body):,} bytes)")


def generate_store(entry, template_html, template_sw, dry_run, order_math, supabase, target_dir=None):
    slug         = entry['slug']
    target_dir   = target_dir or os.path.join(ROOT, slug)
    target_index = os.path.join(target_dir, 'index.html')
    target_sw    = os.path.join(target_dir, 'sw.js')

    # Substitute deployment URL. The placeholder count check defends against
    # template corruption (someone manually edited the placeholder out, or
    # an earlier build accidentally substituted it).
    count = template_html.count(API_URL_PLACEHOLDER)
    if count != 1:
        fail(f"template/index.html: expected exactly 1 {API_URL_PLACEHOLDER!r}, "
             f"found {count}. Template may be corrupted.")
    rendered_html = template_html.replace(API_URL_PLACEHOLDER, entry['deployment'])

    # Theme substitution. Concept-derived; validate_stores already refused an
    # unknown concept ('default' is a no-op in the template's theme CSS).
    theme = CONCEPT_TO_THEME.get(entry['concept'], 'default')
    theme_count = rendered_html.count(THEME_PLACEHOLDER)
    if theme_count != 1:
        fail(f"template/index.html: expected exactly 1 {THEME_PLACEHOLDER!r}, "
             f"found {theme_count}. Template may be corrupted.")
    rendered_html = rendered_html.replace(THEME_PLACEHOLDER, theme)

    # Apple-touch-icon substitution. Concepts with a logo get the full
    # <link> tag; concepts without get an empty string (no icon link in
    # the rendered HTML, iOS uses its screenshot fallback). Strict count
    # check defends against template corruption the same way the theme
    # substitution does.
    icon_link = CONCEPT_TO_APPLE_TOUCH_ICON.get(entry['concept'], '')
    icon_count = rendered_html.count(ICON_PLACEHOLDER)
    if icon_count != 1:
        fail(f"template/index.html: expected exactly 1 {ICON_PLACEHOLDER!r}, "
             f"found {icon_count}. Template may be corrupted.")
    rendered_html = rendered_html.replace(ICON_PLACEHOLDER, icon_link)

    # Supabase config for direct mode. Supabase itself decides per store
    # whether phones use it (mog.stores.phone_direct); this only says where.
    sb_count = rendered_html.count(SUPABASE_PLACEHOLDER)
    if sb_count != 1:
        fail(f"template/index.html: expected exactly 1 {SUPABASE_PLACEHOLDER!r}, "
             f"found {sb_count}. Template may be corrupted.")
    sb_json = json.dumps({'url': supabase[0], 'key': supabase[1], 'slug': slug})
    rendered_html = rendered_html.replace(SUPABASE_PLACEHOLDER, sb_json)

    # Store profile for the page itself: the street address vendors deliver
    # to (Copy order for email; optional in stores.json), and the store's
    # place and concept, which the computer sign-in shows before anyone has
    # signed in (docs/MOG_OneApp_Spec.md U5).
    st_count = rendered_html.count(STORE_PLACEHOLDER)
    if st_count != 1:
        fail(f"template/index.html: expected exactly 1 {STORE_PLACEHOLDER!r}, "
             f"found {st_count}. Template may be corrupted.")
    st_json = json.dumps({'address': entry.get('address', '').strip(), 'location': entry['location'],
                          'concept': entry['concept']}, ensure_ascii=False)
    rendered_html = rendered_html.replace(STORE_PLACEHOLDER, st_json)

    # The shared order math, verbatim.
    om_count = rendered_html.count(ORDER_MATH_PLACEHOLDER)
    if om_count != 1:
        fail(f"template/index.html: expected exactly 1 {ORDER_MATH_PLACEHOLDER!r}, "
             f"found {om_count}. Template may be corrupted.")
    rendered_html = rendered_html.replace(ORDER_MATH_PLACEHOLDER, order_math)

    actions = []
    if not os.path.isdir(target_dir):
        actions.append(f"mkdir {slug}/")
    actions.append(f"write {slug}/index.html ({len(rendered_html):,} bytes)")
    actions.append(f"write {slug}/sw.js     ({len(template_sw):,} bytes)")

    if dry_run:
        for a in actions:
            print(f"  [dry-run] {a}")
        return

    os.makedirs(target_dir, exist_ok=True)
    with open(target_index, 'w', encoding='utf-8') as f:
        f.write(rendered_html)
    with open(target_sw, 'w', encoding='utf-8') as f:
        f.write(template_sw)
    for a in actions:
        print(f"  [done]    {a}")


# ---------------------------------------------------------------------------
# Hub registry injection
# ---------------------------------------------------------------------------

def inject_hub_registry(stores, dry_run):
    """
    If root index.html exists and contains the STORE_REGISTRY marker line,
    replace that line with the build-injected version. Hub registry contains
    concept/location/slug only — deployment URLs are NOT exposed to the
    hub's client-side code.
    """
    if not os.path.exists(HUB_INDEX):
        print("[hub] root index.html not found — skipping registry injection")
        return

    with open(HUB_INDEX, 'r', encoding='utf-8') as f:
        hub_html = f.read()

    public_registry = [
        {'slug': e['slug'], 'concept': e['concept'], 'location': e['location']}
        for e in stores
    ]
    registry_json = json.dumps(public_registry, ensure_ascii=False)

    # The marker line in the hub HTML looks like:
    #   const STORE_REGISTRY = [...];  // __STORE_REGISTRY__ build-injected
    # Find any line containing the marker, replace its content with the
    # newly-rendered registry. Strict count check: exactly one marker.
    marker_lines = [ln for ln in hub_html.split('\n') if REGISTRY_MARKER in ln]
    if not marker_lines:
        fail(f"hub index.html exists but contains no '{REGISTRY_MARKER}' line.\n"
             f"  Add `const STORE_REGISTRY = [];  {REGISTRY_MARKER}` to the hub.")
    if len(marker_lines) > 1:
        fail(f"hub index.html contains multiple '{REGISTRY_MARKER}' lines.\n"
             f"  Only one marker is allowed.")

    old_line = marker_lines[0]
    # Preserve the marker line's leading whitespace so the indent matches.
    leading_ws = old_line[:len(old_line) - len(old_line.lstrip())]
    new_line = f"{leading_ws}const STORE_REGISTRY = {registry_json};  {REGISTRY_MARKER}"

    if dry_run:
        print(f"  [dry-run] inject hub registry: {len(public_registry)} stores")
        print(f"  [dry-run]   old: {old_line.strip()[:80]}{'...' if len(old_line.strip()) > 80 else ''}")
        print(f"  [dry-run]   new: {new_line.strip()[:80]}{'...' if len(new_line.strip()) > 80 else ''}")
        return

    if new_line == old_line:
        # Registry already current (e.g. stores.json unchanged since the
        # last build). Nothing to inject — a benign no-op, not an error.
        # Keeps build.py idempotent so a template-only rebuild doesn't
        # crash after the store dirs are written.
        print(f"  [skip]    hub registry already current ({len(public_registry)} stores)")
        return

    hub_html_new = hub_html.replace(old_line, new_line)
    with open(HUB_INDEX, 'w', encoding='utf-8') as f:
        f.write(hub_html_new)
    print(f"  [done]    injected {len(public_registry)} stores into hub registry")


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

def arg_after(flag):
    if flag not in sys.argv:
        return None
    i = sys.argv.index(flag)
    if i + 1 >= len(sys.argv) or sys.argv[i + 1].startswith('--'):
        fail(f"{flag} needs a value")
    return sys.argv[i + 1]


# The preview app's /exec address leads nowhere on purpose: a test store has
# no Sheet, and the store it copies (--like) is a real one, so anything that
# falls back to /exec (history, the reset) must fail, never reach its Sheet.
PREVIEW_EXEC = 'https://script.google.com/macros/s/PREVIEW-HAS-NO-EXEC/exec'


def build_preview(stores, slug, like, dry_run):
    """A test store's app and editor (e.g. rprfotest, D21) under
    _preview/<slug>/, which git ignores: nothing here is ever published. It
    borrows the look of the real store it was copied from (--like); Supabase
    decides what the test store holds, that its editor is on, and (after
    mog.prepare_test_store) that its phones are."""
    if not SLUG_RE.match(slug):
        fail(f"--preview: invalid slug {slug!r}")
    entry = next((e for e in stores if e['slug'] == like), None)
    if not entry:
        fail(f"--like {like!r} is not a store in stores.json")
    if any(e['slug'] == slug for e in stores):
        fail(f"--preview {slug!r} is a real store; previews are for test stores only")
    supabase = read_supabase_project()
    themes = read_concept_themes()
    print(f"[preview] {slug}, looking like {like}" + (" (DRY RUN, no writes)" if dry_run else ""))
    target = os.path.join(PREVIEW_DIR, slug)
    with open(TEMPLATE_INDEX, 'r', encoding='utf-8') as f:
        template_html = f.read()
    with open(TEMPLATE_SW, 'r', encoding='utf-8') as f:
        template_sw = f.read()
    app_entry = dict(entry, slug=slug, location=entry['location'] + ' (TEST)', deployment=PREVIEW_EXEC)
    generate_store(app_entry, template_html, template_sw, dry_run, read_order_math(), supabase, target_dir=target)
    generate_editor(target, entry, slug, entry['location'] + ' (TEST)', supabase, themes, dry_run)
    print(f"[done] serve the repo root and open /_preview/{slug}/ (the app) or /_preview/{slug}/editor/ (the editor)")


def main():
    dry_run = '--dry-run' in sys.argv
    preview = arg_after('--preview')

    if not os.path.exists(STORES_JSON):
        fail(f"stores.json not found at {STORES_JSON}")
    with open(STORES_JSON, 'r', encoding='utf-8') as f:
        try:
            stores = json.load(f)
        except json.JSONDecodeError as e:
            fail(f"stores.json is invalid JSON: {e}")

    validate_stores(stores)
    print(f"[validate] stores.json: {len(stores)} entries OK")

    if preview:
        like = arg_after('--like')
        if not like:
            fail('--preview needs --like <store it was copied from>')
        build_preview(stores, preview, like, dry_run)
        return

    if not os.path.exists(TEMPLATE_INDEX):
        fail(f"template/index.html not found at {TEMPLATE_INDEX}")
    if not os.path.exists(TEMPLATE_SW):
        fail(f"template/sw.js not found at {TEMPLATE_SW}")
    with open(TEMPLATE_INDEX, 'r', encoding='utf-8') as f:
        template_html = f.read()
    with open(TEMPLATE_SW, 'r', encoding='utf-8') as f:
        template_sw = f.read()

    order_math = read_order_math()
    supabase   = read_supabase_project()
    themes     = read_concept_themes()

    print(f"[stores] generating {len(stores)} store directory(ies)"
          + (" — DRY RUN, no writes" if dry_run else ""))
    for entry in stores:
        print(f"  {entry['concept']} — {entry['location']}  ({entry['slug']})")
        generate_store(entry, template_html, template_sw, dry_run, order_math, supabase)
        if entry.get('editor') == 'supabase':
            generate_editor(os.path.join(ROOT, entry['slug']), entry, entry['slug'], entry['location'], supabase, themes, dry_run)

    print("[hub] registry injection")
    inject_hub_registry(stores, dry_run)

    print("[done]" + (" (dry-run, no files written)" if dry_run else ""))


if __name__ == '__main__':
    main()
