#!/usr/bin/env python
"""Generate a schema_vN.sql from earlier versions' definitions (mog-supabase-schema).

A long function redefined in a new version is copied from the schema file that
last defined it and changed by asserted one-match replacements, never retyped:
nothing else in the function can drift. Every version from v10 to v22 wrote this
by hand as a scratch gen_vN.py; this is that code, once.

Use it from a short generator in the scratchpad:

    import sys
    sys.path.insert(0, r'<repo>/.claude/skills/mog-supabase-schema/scripts')
    from sqlgen import read, fn, rep, lockdown, write

    v21 = read('schema_v21.sql')
    held = fn(v21, 'mog.wh_held_from_log')               # with the comment lines above it
    held = rep(held, 'and mog.wh_place_carries(p.id, h.id)',
                     'and mog.wh_place_carries(p.id, h.id) and p.active', count=3)
    write('schema_v22.sql', HEADER + held + lockdown(['public.mog_wh_send(text, jsonb)']))

Then run `node supabase/tests/run_pglite.mjs` and plant defects with plant.py.

Rules it holds:
  * fn() takes exactly one definition (a name defined twice in one file is an
    error) and the `--` lines directly above it, so a changed comment can be
    replaced too (v21: a comment replacement failed when fn() left it out);
  * rep() counts first: the old text must occur exactly `count` times;
  * read()/write() are LF, UTF-8, and resolve names inside supabase/.

Pure stdlib, Python 3.
"""
import io
import os

SUPA = os.path.normpath(os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..', '..', '..', 'supabase'))


def read(name):
    """A file under supabase/ (e.g. 'schema_v21.sql'), with LF line endings."""
    with io.open(os.path.join(SUPA, name), encoding='utf-8', newline='') as f:
        return f.read().replace('\r\n', '\n')


def fn(src, name):
    """`create or replace function <name>(` ... `$$;`, plus the `--` lines right above it."""
    key = 'create or replace function ' + name + '('
    n = src.count(key)
    if n != 1:
        raise ValueError('%s is defined %d times here (want exactly 1)' % (name, n))
    start = src.index(key)
    lines = src[:start].split('\n')[:-1]
    keep = []
    while lines and lines[-1].startswith('--'):
        keep.insert(0, lines.pop())
    head = '\n'.join(keep) + ('\n' if keep else '')
    body = src.index('as $$', start)
    end = src.index('\n$$;', body) + len('\n$$;')
    return head + src[start:end] + '\n'


def rep(s, old, new, count=1):
    """Replace `old` with `new`, which must occur exactly `count` times."""
    n = s.count(old)
    if n != count:
        raise ValueError('expected %d of %r, found %d' % (count, old[:80], n))
    return s.replace(old, new)


def lockdown(entry_points):
    """The closing privileges block: lock every internal, open exactly these public functions."""
    arr = ',\n    '.join("'%s'" % e for e in entry_points)
    return ("\n-- ---------------------------------------------------------------------\n"
            "-- Privileges: lock the internals; open exactly the entry points below.\n"
            "-- ---------------------------------------------------------------------\n\n"
            "revoke all on all tables    in schema mog from public, anon, authenticated;\n"
            "revoke all on all functions in schema mog from public, anon, authenticated;\n\n"
            "do $$\ndeclare\n  f text;\nbegin\n  foreach f in array array[\n    " + arr + "\n  ] loop\n"
            "    execute format('revoke all on function %s from public, anon, authenticated', f);\n"
            "    execute format('grant execute on function %s to anon, authenticated', f);\n"
            "  end loop;\nend;\n$$;\n\nnotify pgrst, 'reload schema';\n")


def write(name, text):
    """Write a file under supabase/ with LF endings; prints its line count."""
    path = os.path.join(SUPA, name)
    with io.open(path, 'w', encoding='utf-8', newline='\n') as f:
        f.write(text)
    print('wrote supabase/%s (%d lines)' % (name, len(text.splitlines())))
    return path
