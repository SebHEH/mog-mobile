#!/usr/bin/env python3
"""
build.py — generate per-store PWA directories and (if present) inject the
hub registry into the root index.html.

Reads stores.json at repo root. For each entry:
  - Validates required fields and value formats
  - Creates <slug>/ directory if missing
  - Writes <slug>/index.html = template/index.html with __MOG_API_URL__
    substituted with the entry's deployment URL
  - Writes <slug>/sw.js = verbatim copy of template/sw.js

If root index.html exists with the STORE_REGISTRY marker line, the registry
(concept + location + slug only — no deployment URLs) is injected into it.

Idempotent: re-running with unchanged inputs produces unchanged outputs.
Removing a store from stores.json does NOT auto-delete its directory; that's
a manual `git rm -r <slug>/` step on the operator's side.

Usage:
  python3 build.py            # generate / inject
  python3 build.py --dry-run  # show what would happen, write nothing
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

# Slugs that would collide with our repo structure.
RESERVED_SLUGS = {
    'template', '_build_scripts', 'sw.js', 'manifest.webmanifest',
    'stores.json', 'build.py', 'readme', 'readme.md',
}

SLUG_RE       = re.compile(r'^[a-z0-9-]+$')
DEPLOY_URL_RE = re.compile(r'^https://script\.google\.com/macros/s/[^/]+/exec$')

API_URL_PLACEHOLDER = '__MOG_API_URL__'
REGISTRY_MARKER     = '// __STORE_REGISTRY__ build-injected'


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
            fail(f"{prefix}: invalid slug {slug!r} — must match [a-z0-9-]+")
        if slug.lower() in RESERVED_SLUGS:
            fail(f"{prefix}: slug {slug!r} is reserved (collides with repo file/dir)")
        if slug in slugs_seen:
            fail(f"{prefix}: duplicate slug {slug!r} — slugs must be unique")
        slugs_seen.add(slug)

        if not DEPLOY_URL_RE.match(entry['deployment']):
            fail(f"{prefix}: deployment URL does not match Apps Script pattern\n"
                 f"  expected: https://script.google.com/macros/s/<id>/exec\n"
                 f"  got:      {entry['deployment']!r}")


# ---------------------------------------------------------------------------
# Per-store generation
# ---------------------------------------------------------------------------

def generate_store(entry, template_html, template_sw, dry_run):
    slug         = entry['slug']
    target_dir   = os.path.join(ROOT, slug)
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

    hub_html_new = hub_html.replace(old_line, new_line)
    assert hub_html_new != hub_html, "registry injection produced no change"
    with open(HUB_INDEX, 'w', encoding='utf-8') as f:
        f.write(hub_html_new)
    print(f"  [done]    injected {len(public_registry)} stores into hub registry")


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

def main():
    dry_run = '--dry-run' in sys.argv

    if not os.path.exists(STORES_JSON):
        fail(f"stores.json not found at {STORES_JSON}")
    with open(STORES_JSON, 'r', encoding='utf-8') as f:
        try:
            stores = json.load(f)
        except json.JSONDecodeError as e:
            fail(f"stores.json is invalid JSON: {e}")

    validate_stores(stores)
    print(f"[validate] stores.json: {len(stores)} entries OK")

    if not os.path.exists(TEMPLATE_INDEX):
        fail(f"template/index.html not found at {TEMPLATE_INDEX}")
    if not os.path.exists(TEMPLATE_SW):
        fail(f"template/sw.js not found at {TEMPLATE_SW}")
    with open(TEMPLATE_INDEX, 'r', encoding='utf-8') as f:
        template_html = f.read()
    with open(TEMPLATE_SW, 'r', encoding='utf-8') as f:
        template_sw = f.read()

    print(f"[stores] generating {len(stores)} store directory(ies)"
          + (" — DRY RUN, no writes" if dry_run else ""))
    for entry in stores:
        print(f"  {entry['concept']} — {entry['location']}  ({entry['slug']})")
        generate_store(entry, template_html, template_sw, dry_run)

    print("[hub] registry injection")
    inject_hub_registry(stores, dry_run)

    print("[done]" + (" (dry-run, no files written)" if dry_run else ""))


if __name__ == '__main__':
    main()
