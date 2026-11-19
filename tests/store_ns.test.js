'use strict';
// GATE: each store's fixed storage key, `ns` in stores.json (Sheet retirement
// step 5, item 2). Every phone files a store's drafts, unsent counts,
// reviewed flags and caches under 'mog_<ns>_...'. App v0.34.1 and older took
// <ns> from the store's /exec address (the first 12 characters of its
// deployment id; s_<slug> for a store with none). The addresses are gone
// (deployments archived, `deployment` out of stores.json, 2026-11-20), but the
// key must never move, or the phones lose what they hold. So:
//   - for every store in stores.json, the key the app computes now (storeNs_,
//     from the page build.py writes) equals what v0.34.1's deploymentNs_
//     computed from the address stores.json held at v0.34.1 (git history);
//     likewise for a store made in HQ;
//   - build.py's frozen LEGACY_NS holds exactly those keys, one per store
//     that had an address;
//   - every committed <slug>/index.html carries its store's ns (build.py ran);
//   - build.py refuses a store with no ns, an ns other than LEGACY_NS's or
//     s_<slug>, and a `deployment` field (retired).
// Each has a planted-defect control.
//
// Run bare: node tests/store_ns.test.js. A passing run ends with "store_ns: ALL PASS".

const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const { spawnSync } = require('child_process');
const F = require('./fake_apps_script.js');
const { slices } = require('./slice_js.js');

const REPO = F.REPO;
const PY = process.env.PYTHON || 'python';
const OLD = '7535744';   // app v0.34.1: the last namespace taken from the /exec address
const T = 'template/index.html';
const SRC = file => F.source(null, file);

// Each store's /exec address as stores.json held it at v0.34.1.
const OLD_ADDRESS = {};
for (const s of JSON.parse(F.source(OLD, 'stores.json'))) if (s.deployment) OLD_ADDRESS[s.slug] = s.deployment;

// The page's window.MOG_STORE, as build.py wrote it.
function storeProfile(page) {
  const m = /window\.MOG_STORE = (\{.*?\});/.exec(page);
  if (!m) throw new Error('window.MOG_STORE not found in a built page');
  return JSON.parse(m[1]);
}

// v0.34.1's key, from its own code, for a store at this address.
function oldNs(slug, apiUrl) {
  const code = slices(F.source(OLD, T), ['deploymentNs_']);
  const ctx = { state: { apiUrl: apiUrl || '' }, window: { MOG_SUPABASE: { slug } } };
  vm.createContext(ctx);
  vm.runInContext(code, ctx);
  return vm.runInContext('deploymentNs_()', ctx);
}

// Today's key, from the template's code, with the profile a page carries.
function newNs(template, slug, profile) {
  const code = slices(template, ['storeNs_']);
  const ctx = { window: { MOG_SUPABASE: { slug }, MOG_STORE: profile } };
  vm.createContext(ctx);
  vm.runInContext(code, ctx);
  return vm.runInContext('storeNs_()', ctx);
}

// build.py, in one Python run: validate the cases, then build each store's
// page into a temp folder and read back its profile.
function runBuild(buildSrc, stores) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mog-storens-'));
  fs.writeFileSync(path.join(dir, 'build_src.py'), buildSrc);
  const cases = {
    missing: [{ slug: 'zzns1', concept: 'Roll Play', location: 'X BOH', editor: 'supabase' }],
    differs: [{ slug: 'rprfo', concept: 'Roll Play', location: 'Rosslyn FOH', editor: 'supabase', ns: 'AKfycby8-_gX' }],
    hqOther: [{ slug: 'zzns2', concept: 'Roll Play', location: 'X FOH', editor: 'supabase', ns: 'zzns2' }],
    retired: [{ slug: 'zzns3', concept: 'Roll Play', location: 'X BOH', editor: 'supabase', ns: 's_zzns3',
                deployment: 'https://script.google.com/macros/s/AKfycbzzzzzzzzzzQQ/exec' }],
    hqOk:    [{ slug: 'zzns5', concept: 'Roll Play', location: 'X BOH', editor: 'supabase', ns: 's_zzns5' }]
  };
  const code = [
    'import json, sys, io, os, types, contextlib',
    // The source under test (planted or not), run as the repo's build.py so its paths resolve there.
    'build = types.ModuleType("build")',
    'build.__file__ = os.path.join(' + JSON.stringify(REPO) + ', "build.py")',
    'exec(compile(io.open(os.path.join(' + JSON.stringify(dir) + ', "build_src.py"), encoding="utf-8").read(), build.__file__, "exec"), build.__dict__)',
    'cases = json.loads(sys.argv[1]); stores = json.loads(sys.argv[2]); out = {"cases": {}, "built": {}, "legacy": build.LEGACY_NS}',
    'for name, rows in cases.items():',
    '    try:',
    '        with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()): build.validate_stores(rows)',
    '        out["cases"][name] = "accepted"',
    '    except SystemExit:',
    '        out["cases"][name] = "refused"',
    'build.validate_stores(stores)',
    'tpl = io.open(build.TEMPLATE_INDEX, encoding="utf-8").read()',
    'sw = io.open(build.TEMPLATE_SW, encoding="utf-8").read()',
    'om = build.read_order_math(); sb = build.read_supabase_project()',
    'for s in stores + cases["hqOk"]:',
    '    t = os.path.join(sys.argv[3], s["slug"])',
    '    with contextlib.redirect_stdout(io.StringIO()): build.generate_store(s, tpl, sw, False, om, sb, target_dir=t)',
    '    out["built"][s["slug"]] = io.open(os.path.join(t, "index.html"), encoding="utf-8").read()',
    'print("RESULT " + json.dumps(out))'
  ].join('\n');
  const r = spawnSync(PY, ['-B', '-c', code, JSON.stringify(cases), JSON.stringify(stores), path.join(dir, 'out')],
                      { encoding: 'utf8', cwd: REPO, maxBuffer: 256 << 20 });
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { /* the OS cleans tmp */ }
  const line = (r.stdout || '').split('\n').find(l => l.indexOf('RESULT ') === 0);
  if (!line) throw new Error('python: ' + (r.stderr || r.stdout).slice(-600));
  return JSON.parse(line.slice(7));
}

function runSuite(srcOf) {
  const fails = {};
  const fail = (k, m) => { (fails[k] = fails[k] || []).push(m); };
  const stores = JSON.parse(srcOf('stores.json'));
  const template = srcOf(T);
  let b;
  try { b = runBuild(srcOf('build.py'), stores); } catch (e) { fail('build', e.message); return fails; }

  // build.py's refusals.
  const want = { missing: 'refused', differs: 'refused', hqOther: 'refused', retired: 'refused', hqOk: 'accepted' };
  for (const k of Object.keys(want)) if (b.cases[k] !== want[k]) fail('refuse', k + ': ' + b.cases[k] + ' (want ' + want[k] + ')');

  // build.py's frozen keys: exactly the stores that had an address, each the key v0.34.1 used.
  const legacy = b.legacy || {};
  for (const slug of Object.keys(OLD_ADDRESS)) {
    const before = oldNs(slug, OLD_ADDRESS[slug]);
    if (legacy[slug] !== before) fail('legacy', slug + ': LEGACY_NS has ' + legacy[slug] + ', v0.34.1 used ' + before);
  }
  for (const slug of Object.keys(legacy)) if (!OLD_ADDRESS[slug]) fail('legacy', slug + ' is in LEGACY_NS but had no address');
  if (new Set(Object.values(legacy)).size !== Object.keys(legacy).length) fail('legacy', 'two stores share a key in LEGACY_NS');

  // Every store: v0.34.1's key from its old address == today's key from its built page.
  for (const s of stores) {
    const before = oldNs(s.slug, OLD_ADDRESS[s.slug] || '');
    const prof = storeProfile(b.built[s.slug]);
    const now = newNs(template, s.slug, prof);
    if (now !== before) fail('same key', s.slug + ': v0.34.1 used ' + before + ', the new page uses ' + now);
    if (s.ns !== before) fail('same key', s.slug + ': stores.json ns ' + s.ns + ' is not ' + before);
    // The committed page (what GitHub Pages serves) carries it too.
    const committed = path.join(REPO, s.slug, 'index.html');
    if (srcOf === SRC) {
      const page = fs.existsSync(committed) ? fs.readFileSync(committed, 'utf8') : '';
      if (!page) fail('committed', s.slug + '/index.html missing');
      else if (storeProfile(page).ns !== s.ns) fail('committed', s.slug + '/index.html has ns ' + storeProfile(page).ns + ': run python build.py');
    }
  }
  // A store made in HQ: v0.34.1 gave it s_<slug> (no address); so does the new page.
  const hq = b.built.zzns5;
  if (!hq) fail('same key', 'the HQ store was not built');
  else {
    const before = oldNs('zzns5', ''), now = newNs(template, 'zzns5', storeProfile(hq));
    if (before !== 's_zzns5' || now !== before) fail('same key', 'HQ store: v0.34.1 ' + before + ', now ' + now);
  }
  return fails;
}

const CONTROLS = [
  { name: 'the app ignores the page\'s ns', file: T, bites: 'same key',
    find: '    if (st && st.ns) return st.ns;', replace: '' },
  { name: 'build.py leaves ns out of the page', file: 'build.py', bites: 'same key',
    find: "'concept': entry['concept'], 'ns': entry['ns']}", replace: "'concept': entry['concept']}" },
  { name: 'build.py takes an ns other than the frozen one', file: 'build.py', bites: 'refuse',
    find: '        if ns != want:', replace: '        if False:' },
  { name: 'build.py takes a retired deployment', file: 'build.py', bites: 'refuse',
    find: "        if 'deployment' in entry:", replace: '        if False:' },
  { name: 'a frozen key typed wrong in build.py', file: 'build.py', bites: 'legacy',
    find: "'tnyr':  'AKfycbxTnTOX'", replace: "'tnyr':  'AKfycbxTnTOY'", throws: true },
  { name: 'a frozen key for a store that had no address', file: 'build.py', bites: 'legacy',
    find: "'tnyrf': 'AKfycbyGQeDq',", replace: "'tnyrf': 'AKfycbyGQeDq', 'zzns9': 's_zzns9'," },
  { name: 'a store\'s ns typed wrong in stores.json', file: 'stores.json', bites: 'refuse',
    find: '"ns": "AKfycby8-_go"', replace: '"ns": "AKfycby8-_gX"', throws: true }
];

const res = runSuite(SRC);
let failed = 0;
const keys = Object.keys(res);
if (keys.length) {
  failed++;
  console.log('FAIL  ' + keys.map(k => k + ': ' + res[k].slice(0, 3).join(' | ')).join('\n      '));
} else {
  console.log('PASS  every store keeps the key v0.34.1 used (' + JSON.parse(SRC('stores.json')).length +
              ' stores and an HQ store) and LEGACY_NS holds exactly those keys; the built pages carry them; build.py refuses a missing or changed ns and a retired deployment');
}
for (const c of CONTROLS) {
  let r;
  try {
    const planted = F.plant(SRC(c.file), c.find, c.replace);
    r = runSuite(f => (f === c.file ? planted : SRC(f)));
  } catch (e) {
    if (c.throws) { console.log(`PASS  control "${c.name}" bites (build.py refuses: ${e.message.split('\n').slice(-2).join(' ').slice(0, 120)})`); continue; }
    failed++;
    console.log(`FAIL  control "${c.name}" crashed instead of biting: ${e.message}`);
    continue;
  }
  if (r[c.bites] || (c.throws && r.build)) console.log(`PASS  control "${c.name}" bites ("${c.bites}")`);
  else { failed++; console.log(`FAIL  control "${c.name}" did NOT bite "${c.bites}" (${JSON.stringify(r).slice(0, 200)})`); }
}
console.log(failed ? 'store_ns: ' + failed + ' FAILED' : 'store_ns: ALL PASS');
process.exit(failed ? 1 : 0);
