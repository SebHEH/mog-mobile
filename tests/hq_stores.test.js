'use strict';
// GATE: HQ → Stores (template/hq/stores.js; schema v26, Sheet retirement
// step 4). The page's real code against the fake Supabase (fake_supabase.js
// mirrors v26; the SQL itself is pinned in Postgres by
// supabase/tests/smoke_v26.sql), with the page's boxes as plain objects.
// Checks:
//   - parity: the page's concept names and reserved web addresses are
//     schema_v26.sql's (mog.concept_name, mog.store_create)
//   - the form: the name it shows is the name the store gets, for every
//     concept, side and test tick; the web address and store code it
//     suggests pass the SQL's rules, follow the site, the concept and the
//     side, and stop following once typed over; Create waits for every box
//     and for the two PINs to agree
//   - Create: one save makes the store (phones, Manage, nightly close on;
//     today's cycle; the GM recipient; test stores off the hub list), the
//     page says what's next ("Publish <slug>"), its PIN signs in; a refusal
//     is shown in plain words and saves nothing; a sign-in that ran out
//     goes back to the sign-in screen
//   - Change PIN: the two boxes must agree; the new PIN works, the old one
//     doesn't, the store's sign-ins end, the row says who set it
//   - the manager PIN: set once for every store, then a new store has it
//     too; it can't be a store's PIN; a Sheet's PIN push is refused
//     (PINS_IN_HQ) once Supabase closes the store
//   - the page before v26 (no managerPin in HQ's data) says so and offers
//     nothing
//   - build.py: a store with no /exec address builds with an empty one and
//     needs "editor": "supabase"; "test": true is built but left off the hub
// Each has a planted-defect control.
//
// Run bare: node tests/hq_stores.test.js
// A passing run ends with "hq_stores: ALL PASS".

const vm = require('vm');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const F = require('./fake_apps_script.js');
const { FakeSupabase } = require('./fake_supabase.js');

const REPO = F.REPO;
const SRC = fs.readFileSync(path.join(REPO, 'template/hq/stores.js'), 'utf8');
const SQL = fs.readFileSync(path.join(REPO, 'supabase/schema_v26.sql'), 'utf8');
const PY = process.env.PYTHON || 'python';
const NOW = Date.parse('2026-11-16T15:00:00Z');
const CONCEPTS = { 'roll-play': 'Roll Play', teasnyou: 'Teas’n You', an: 'ĂN', leid: 'Lei’d Poke' };
const esc = s => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
const flush = () => new Promise(r => setImmediate(r));

function loadModule(src) {
  const ctx = { console, Date, Intl };
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(src, ctx, { filename: 'stores.js' });
  return ctx.HQStores;
}

// The SQL's rules, read out of schema_v26.sql.
function sqlNames() {
  const body = SQL.slice(SQL.indexOf('create or replace function mog.concept_name'));
  const out = {};
  const re = /when '([a-z-]+)'\s+then '((?:[^']|'')*)'/g;
  let m;
  const end = body.indexOf('$$;');
  while ((m = re.exec(body.slice(0, end)))) out[m[1]] = m[2].replace(/''/g, "'");
  return out;
}
function sqlReserved() {
  const m = /if v_slug in \(([^)]*)\) then/.exec(SQL);
  return m ? m[1].split(',').map(s => s.trim().replace(/^'|'$/g, '')) : [];
}

// A fake Supabase with an HQ person signed in and two stores the Sheet way.
function world() {
  const sb = new FakeSupabase(NOW);
  const H = sb.hqState();
  H.users.set('Sebastian', { pass: 'correct horse battery', invite: null, inviteExpires: 0, fail: 0, lockedUntil: 0, roles: ['hq', 'warehouse'] });
  H.users.set('Dan', { pass: 'correct horse battery', invite: null, inviteExpires: 0, fail: 0, lockedUntil: 0, roles: ['warehouse'] });
  for (const [slug, loc, concept, pin, side] of [['rpr', 'Roll Play Rosslyn BOH', 'roll-play', '1111', 'BOH'], ['tnyt', 'Teas\'n You Tysons BOH', 'teasnyou', '2222', 'BOH']]) {
    sb.provision(slug);
    const s = sb.stores.get(slug);
    Object.assign(s, { profile: { timeZone: 'America/New_York', location: loc, abbr: slug.toUpperCase(), concept }, side,
      phoneDirect: true, editorDirect: true, closeDirect: true, pins: { pin, master: '9' + pin },
      tables: { vendors: [], areas: [], items: [], pickRows: [] }, recipients: [],
      state: { cycleDate: '2026-11-16', dayOfWeek: 'Mon', emergencyOverride: false, vendorPicks: {}, todaysLog: [] } });
    sb.editorPublish(s);
  }
  const tok = sb.handle('mog_hq_login', { p_name: 'Sebastian', p_passphrase: 'correct horse battery' }).data.token;
  const wtok = sb.handle('mog_hq_login', { p_name: 'Dan', p_passphrase: 'correct horse battery' }).data.token;
  return { sb, tok, wtok };
}

// The page: stores.js with index.html's helpers, the boxes as plain objects.
function page(HQS, sb, tok, opts) {
  const els = {};
  const $ = id => els[id] || (els[id] = { id, value: '', textContent: '', innerHTML: '', hidden: false, disabled: false, className: '', checked: false });
  const S = { token: tok, data: null, view: 'stores' };
  const P = { els, $, S, signedOut: null, calls: [] };
  const conceptName = k => CONCEPTS[k] || k;
  const plain = s => String(s || '').replace(/[’‘]/g, "'");
  const hq = {
    S, $, esc, CHEV: '', plural: (n, w) => n + ' ' + w + (n === 1 ? '' : 's'),
    rpc: async (fn, params) => { P.calls.push(fn); return JSON.parse(JSON.stringify(sb.handle(fn, JSON.parse(JSON.stringify(params))))); },
    storeBy: slug => S.data.stores.find(s => s.slug === slug),
    storeName: s => (s.location || s.slug) + (s.isTest && !/\(TEST\)\s*$/.test(s.location || '') ? ' (TEST)' : ''),
    shortName: s => { let n = String(s.location || s.slug); const cn = plain(conceptName(s.concept)); if (plain(n).toLowerCase().indexOf(cn.toLowerCase() + ' ') === 0) n = n.slice(cn.length + 1); return n; },
    conceptName, markHtml: () => '',
    load: async () => {
      const r = sb.handle('mog_hq_data', { p_token: S.token });
      if (!r.ok) return false;
      S.data = JSON.parse(JSON.stringify(r.data));
      if (opts && opts.preV26) delete S.data.managerPin;
      P.ST.render(S.view);
      return true;
    },
    go: v => { S.view = v; P.ST.render(v); },
    signedOut: msg => { P.signedOut = msg; S.data = null; }
  };
  P.ST = HQS.create(hq);
  P.load = hq.load;
  P.go = hq.go;
  P.btn = attrs => ({ hasAttribute: a => Object.prototype.hasOwnProperty.call(attrs, a), getAttribute: a => (a in attrs ? attrs[a] : null) });
  P.type = (k, v) => { const t = $('ns-' + k); t.value = v; t.getAttribute = a => (a === 'data-ns' ? k : null); P.ST.input(t); };
  P.click = async attrs => { P.ST.click(P.btn(attrs)); for (let i = 0; i < 5; i++) await flush(); };
  return P;
}

async function checks(HQS, label) {
  const fails = {};
  const fail = (k, m) => { (fails[k] = fails[k] || []).push(m); };

  // ---- Parity with the SQL ----
  const names = sqlNames();
  if (JSON.stringify(Object.keys(names).sort()) !== JSON.stringify(Object.keys(HQS.NAMES).sort())) fail('parity', 'concepts ' + Object.keys(names) + ' vs ' + Object.keys(HQS.NAMES));
  for (const k of Object.keys(names)) if (HQS.NAMES[k] !== names[k]) fail('parity', k + ': "' + HQS.NAMES[k] + '" vs the SQL\'s "' + names[k] + '"');
  if (JSON.stringify(sqlReserved()) !== JSON.stringify(HQS.RESERVED)) fail('parity', 'reserved ' + HQS.RESERVED + ' vs ' + sqlReserved());
  if (!sqlReserved().length || Object.keys(names).length !== 4) fail('parity', 'could not read the SQL\'s rules');

  // ---- The form's suggestions and name ----
  const sites = ['Ballston', 'HQ Test', 'Union Market 2', 'St. Elmo\'s', 'A very long site name here', 'Ño Sé'];
  for (const concept of HQS.ORDER) for (const side of ['BOH', 'FOH']) for (const isTest of [false, true]) for (const site of sites) {
    const f = Object.assign(HQS.blank(), { concept, side, site, isTest });
    f.slug = HQS.suggestSlug(f); f.abbr = HQS.suggestAbbr(f);
    if (!/^[a-z0-9]{2,20}$/.test(f.slug) || HQS.RESERVED.indexOf(f.slug) >= 0) fail('suggest', 'slug ' + f.slug + ' for ' + site);
    if (!/^[A-Z0-9]{2,10}$/.test(f.abbr)) fail('suggest', 'code ' + f.abbr + ' for ' + site);
    if ((side === 'FOH') !== /f$/.test(f.slug) || (side === 'FOH') !== /F$/.test(f.abbr)) fail('suggest', side + ' not in ' + f.slug + ' / ' + f.abbr);
    const want = names[concept] + ' ' + site.trim().replace(/\s+/g, ' ') + ' ' + side + (isTest ? ' (TEST)' : '');
    if (HQS.locationOf(f) !== want) fail('name', HQS.locationOf(f) + ' vs ' + want);
  }
  if (HQS.suggestSlug(HQS.blank()) !== '' || HQS.suggestAbbr(HQS.blank()) !== '') fail('suggest', 'a suggestion before any site');

  // ---- New store, through the page ----
  // A step that throws (a store the page never made) is a failure too; the
  // failures found before it stand.
  try {
    const { sb, tok } = world();
    const P = page(HQS, sb, tok);
    await P.load();
    P.S.view = 'newstore'; P.ST.render('newstore');
    if (!/Which concept/.test(P.els['v-newstore'].innerHTML) || !/an-mark\.svg/.test(P.els['v-newstore'].innerHTML)) fail('form', 'no concept tiles');
    P.type('site', 'Ballston');
    if (P.ST.K.form.slug !== 'rpballston' || P.ST.K.form.abbr !== 'RPBALB' || P.els['ns-name'].textContent !== 'Roll Play Ballston BOH') {
      fail('form', 'typing the site: ' + P.ST.K.form.slug + ' ' + P.ST.K.form.abbr + ' ' + P.els['ns-name'].textContent);
    }
    await P.click({ 'data-st-concept': 'teasnyou' });
    await P.click({ 'data-st-side': 'FOH' });
    if (P.ST.K.form.slug !== 'tnyballstonf' || !/#D1AA5D/.test(P.els['v-newstore'].innerHTML) || !/tny-mark\.svg/.test(P.els['v-newstore'].innerHTML)) {
      fail('form', 'concept and side: ' + P.ST.K.form.slug + ', the Teas\'n You colours ' + /#D1AA5D/.test(P.els['v-newstore'].innerHTML));
    }
    P.type('slug', 'tnyballf');
    P.type('site', 'Ballston Quarter');
    if (P.ST.K.form.slug !== 'tnyballf' || P.ST.K.form.abbr !== 'TNYBALF') fail('form', 'a typed web address moved: ' + P.ST.K.form.slug);
    P.type('pin', '48151'); P.type('pin2', '48152');
    if (!P.els['ns-create'].disabled || !/differ/.test(P.els['st-ns-status'].textContent)) fail('form', 'Create open with two PINs differing');
    P.type('pin2', '48151');
    if (P.els['ns-create'].disabled) fail('form', 'Create still closed: ' + P.els['st-ns-status'].textContent);
    P.type('gmEmail', 'gm.ballston@example.com');

    // A refusal: the address another store has.
    P.type('slug', 'rpr');
    await P.click({ 'data-st-create': '1' });
    if (sb.stores.size !== 2 || P.els['st-ns-status'].textContent !== 'The web address rpr is taken.') fail('create', 'refusal: ' + P.els['st-ns-status'].textContent);
    P.type('slug', 'tnyballf');
    await P.click({ 'data-st-create': '1' });
    const s = sb.stores.get('tnyballf');
    if (!s || !s.phoneDirect || !s.editorDirect || !s.closeDirect || s.isTest || s.profile.location !== 'Teas\'n You Ballston Quarter FOH'
        || s.state.cycleDate !== '2026-11-16' || !s.catalog || (s.recipients || []).length !== 1 || s.createdBy !== 'Sebastian') {
      fail('create', 'the store: ' + JSON.stringify(s && { loc: s.profile.location, close: s.closeDirect, by: s.createdBy, r: s.recipients }));
    }
    if (P.S.view !== 'stores' || !/Publish tnyballf/.test(P.els['v-stores'].innerHTML) || !/is created/.test(P.els['v-stores'].innerHTML)
        || !/shows on the hub/.test(P.els['v-stores'].innerHTML)) fail('create', 'the page after: ' + P.S.view);
    if (P.ST.K.form.pin || P.ST.K.form.site) fail('create', 'the form kept the PIN');
    const login = sb.handle('mog_login', { p_slug: 'tnyballf', p_pin: '48151' });
    if (!login.ok || login.data.authType !== 'store') fail('create', 'its PIN: ' + JSON.stringify(login).slice(0, 120));

    // A test store, and what the hub would list.
    P.go('newstore');
    P.type('site', 'HQ Test'); P.type('pin', '5150'); P.type('pin2', '5150');
    P.ST.change({ id: 'ns-test', checked: true });
    await P.click({ 'data-st-create': '1' });
    const t = sb.stores.get('rphqtest');
    if (!t || !t.isTest || t.profile.location !== 'Roll Play HQ Test BOH (TEST)' || !/not added to the hub/.test(P.els['v-stores'].innerHTML)) {
      fail('create', 'test store: ' + JSON.stringify(t && t.profile));
    }

    // ---- Change PIN ----
    await P.click({ 'data-st-pin': 'tnyballf' });
    if (!/Change the store PIN at Teas'n You Ballston Quarter FOH/.test(P.els['v-stores'].innerHTML.replace(/&#39;/g, '\''))) fail('pin', 'no panel');
    P.$('st-pin1').value = '77777'; P.$('st-pin2').value = '77778';
    await P.click({ 'data-st-pin-save': '1' });
    if (sb.stores.get('tnyballf').pins.pin !== '48151' || !/differ/.test(P.ST.K.msg.pin && P.ST.K.msg.pin.text)) fail('pin', 'saved with two PINs differing');
    P.$('st-pin2').value = '77777';
    await P.click({ 'data-st-pin-save': '1' });
    const st = sb.stores.get('tnyballf');
    if (st.pins.pin !== '77777' || st.sessions.size !== 0 || sb.handle('mog_login', { p_slug: 'tnyballf', p_pin: '48151' }).ok
        || !/1 sign-in ended/.test(P.els['v-stores'].innerHTML) || !/Set here/.test(P.els['v-stores'].innerHTML)) {
      fail('pin', 'after: ' + st.pins.pin + ', sessions ' + st.sessions.size);
    }

    // ---- The manager PIN ----
    await P.click({ 'data-st-mp-open': '1' });
    P.$('st-mp1').value = '1111'; P.$('st-mp2').value = '1111';
    await P.click({ 'data-st-mp-save': '1' });
    if (!/store PIN at Roll Play Rosslyn BOH/.test(P.ST.K.msg.mp && P.ST.K.msg.mp.text) || sb.hq.managerPin) fail('manager', 'a store\'s PIN taken: ' + JSON.stringify(P.ST.K.msg.mp));
    P.$('st-mp1').value = '864209'; P.$('st-mp2').value = '864209';
    await P.click({ 'data-st-mp-save': '1' });
    const every = Array.from(sb.stores.values()).every(x => x.pins.master === '864209');
    if (!every || !/One PIN for all 4 stores/.test(P.els['v-stores'].innerHTML)) fail('manager', 'not at every store');
    P.go('newstore');
    P.type('site', 'Navy Yard'); P.type('pin', '864209'); P.type('pin2', '864209');
    await P.click({ 'data-st-create': '1' });
    if (sb.stores.has('rpnavyyard') || !/manager PIN/.test(P.els['st-ns-status'].textContent)) fail('manager', 'a store PIN equal to it: ' + P.els['st-ns-status'].textContent);
    P.type('pin', '2468'); P.type('pin2', '2468');
    await P.click({ 'data-st-create': '1' });
    const nv = sb.stores.get('rpnavyyard');
    if (!nv || nv.pins.master !== '864209' || sb.handle('mog_login', { p_slug: 'rpnavyyard', p_pin: '864209' }).data.authType !== 'master') fail('manager', 'a new store lacks it');
    const pushed = sb.handle('mog_sync_set_pins', { p_slug: 'rpr', p_key: sb.stores.get('rpr').key, p_pin: '3333', p_master_pin: '' });
    if (pushed.error !== 'PINS_IN_HQ' || sb.stores.get('rpr').pins.pin !== '1111') fail('manager', 'a Sheet\'s push at a store Supabase closes: ' + JSON.stringify(pushed));
    sb.stores.get('rpr').closeDirect = false;
    sb.handle('mog_sync_set_pins', { p_slug: 'rpr', p_key: sb.stores.get('rpr').key, p_pin: '3333', p_master_pin: '' });
    if (sb.stores.get('rpr').pins.master !== '864209') fail('manager', 'a Sheet\'s push cleared the one manager PIN');

    // ---- A sign-in that ran out ----
    sb.hq.sessions.clear();
    P.go('newstore');
    P.type('site', 'Clarendon'); P.type('pin', '1357'); P.type('pin2', '1357');
    await P.click({ 'data-st-create': '1' });
    if (P.signedOut == null || sb.stores.has('rpclarendon')) fail('create', 'a sign-in that ran out: ' + P.signedOut);
  } catch (e) { fail('threw', String(e && e.stack || e).split('\n').slice(0, 2).join(' ')); }

  // ---- Before v26 ----
  {
    const { sb, tok } = world();
    const P = page(HQS, sb, tok, { preV26: true });
    await P.load();
    if (!/needs schema v26/.test(P.els['v-stores'].innerHTML) || /New store<\/button>/.test(P.els['v-stores'].innerHTML)) fail('pre-v26', 'offers a page the server lacks');
  }
  // A warehouse-only person (the fake as the SQL).
  {
    const { sb, wtok } = world();
    if (sb.handle('mog_hq_stores', { p_token: wtok, p_action: 'create', p_row: {} }).error !== 'SESSION_EXPIRED') fail('create', 'a warehouse-only person may create');
  }
  return fails;
}

// ---- build.py: a store with no /exec, and a test store ----
function buildChecks(plant) {
  const fails = {};
  const fail = (k, m) => { (fails[k] = fails[k] || []).push(m); };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mog-hqstores-'));
  const hub = path.join(dir, 'hub.html');
  fs.writeFileSync(hub, '<script>\n  const STORE_REGISTRY = [];  // __STORE_REGISTRY__ build-injected\n</script>\n');
  const code = [
    'import json, sys, io',
    'sys.path.insert(0, ' + JSON.stringify(REPO) + ')',
    'import build',
    'stores = json.loads(sys.argv[1])',
    'out = {}',
    'try:',
    '    build.validate_stores([dict(slug="nodeploy", concept="Roll Play", location="X BOH", ns="s_nodeploy")])',
    '    out["noEditor"] = "accepted"',
    'except SystemExit:',
    '    out["noEditor"] = "refused"',
    'build.validate_stores(stores)',
    'tpl = io.open(build.TEMPLATE_INDEX, encoding="utf-8").read()',
    'sw = io.open(build.TEMPLATE_SW, encoding="utf-8").read()',
    'build.generate_store(stores[0], tpl, sw, False, build.read_order_math(), build.read_supabase_project(), target_dir=sys.argv[2])',
    'page = io.open(sys.argv[2] + "/index.html", encoding="utf-8").read()',
    'out["api"] = page.split("window.MOG_API_URL = ")[1].split(";")[0]',
    'build.HUB_INDEX = sys.argv[3]',
    'build.inject_hub_registry(stores, False)',
    'out["hub"] = io.open(sys.argv[3], encoding="utf-8").read()',
    'print("RESULT " + json.dumps(out))'
  ].join('\n');
  const stores = [
    { slug: 'zzhq26', concept: 'Roll Play', location: 'Navy Yard FOH', editor: 'supabase', ns: 's_zzhq26' },
    { slug: 'zzhq26t', concept: 'Roll Play', location: 'HQ Test FOH', editor: 'supabase', test: true, ns: 's_zzhq26t' },
    { slug: 'rpr', concept: 'Roll Play', location: 'Rosslyn BOH', deployment: 'https://script.google.com/macros/s/AKfycbx_abc123/exec', editor: 'supabase', ns: 'AKfycbx_abc1' }
  ];
  const r = spawnSync(PY, ['-B', '-c', plant ? plant(code) : code, JSON.stringify(stores), path.join(dir, 'out'), hub], { encoding: 'utf8', cwd: REPO });
  const line = (r.stdout || '').split('\n').find(l => l.indexOf('RESULT ') === 0);
  if (!line) { fail('build', 'python: ' + (r.stderr || r.stdout).slice(-400)); return fails; }
  const out = JSON.parse(line.slice(7));
  if (out.noEditor !== 'refused') fail('build', 'a store with no /exec and no app editor was accepted');
  if (out.api !== "''") fail('build', 'its /exec address: ' + out.api);
  if (!/"zzhq26"/.test(out.hub) || /"zzhq26t"/.test(out.hub) || !/"rpr"/.test(out.hub)) fail('build', 'the hub list: ' + out.hub.slice(0, 200));
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { /* the OS cleans tmp */ }
  return fails;
}

const PLANTS = [
  { name: 'the page calls Teas\'n You with a curly apostrophe', where: 'page', bites: 'parity',
    old: "teasnyou: 'Teas\\'n You'", neu: "teasnyou: 'Teas\\u2019n You'" },
  { name: 'a reserved address missing from the page', where: 'page', bites: 'parity',
    old: "'brand', 'assets', 'editor', 'preview'];", neu: "'brand', 'assets', 'editor'];" },
  { name: 'the suggestion drops the f for FOH', where: 'page', bites: 'suggest',
    old: "tail = f.side === 'FOH' ? 'f' : ''", neu: "tail = ''" },
  { name: 'the name shown leaves out (TEST)', where: 'page', bites: 'name',
    old: "(f.isTest ? ' (TEST)' : '')", neu: "''" },
  { name: 'a typed web address is overwritten', where: 'page', bites: 'form',
    old: "if (k === 'slug') K.form.slugTouched = t.value.trim() !== '';", neu: '' },
  { name: 'Create opens with the two PINs differing', where: 'page', bites: 'form',
    old: "if (f.pin !== f.pin2) return 'The two store PINs differ.';", neu: '' },
  { name: 'Create drops the test tick', where: 'page', bites: 'create',
    old: 'isTest: !!f.isTest };', neu: 'isTest: false };' },
  { name: 'Change PIN saves with the boxes differing', where: 'page', bites: 'pin',
    old: "if (a !== b) { say('pin', 'The two PINs differ.', true); return; }", neu: '' },
  { name: 'the page offers New store before v26', where: 'page', bites: 'pre-v26',
    old: "const ready = () => !!data() && Object.prototype.hasOwnProperty.call(data(), 'managerPin');", neu: 'const ready = () => !!data();' },
  { name: 'a sign-in that ran out stays on the page', where: 'page', bites: 'create',
    old: "if (!r.ok && r.error === 'SESSION_EXPIRED') { hq.signedOut('Your sign-in ran out. Sign in again.'); return null; }", neu: '' },
  { name: 'the hub lists a test store', where: 'build', bites: 'build',
    py: code => code.replace('import build', 'import build\n_inj = build.inject_hub_registry\ndef _all(stores, d):\n    return _inj([dict(e, test=False) if e.get("test") else e for e in stores], d)\nbuild.inject_hub_registry = _all') },
  { name: 'build.py takes a store with neither /exec nor the app editor', where: 'build', bites: 'build',
    py: code => code.replace('import build', 'import build\n_v = build.validate_stores\nbuild.validate_stores = lambda s: _v([dict(e, editor="supabase") for e in s])') }
];

(async function main() {
  let failed = 0;
  const report = (label, fails) => {
    const keys = Object.keys(fails);
    if (!keys.length) { console.log('PASS  ' + label); return; }
    failed++;
    console.log('FAIL  ' + label);
    for (const k of keys) for (const m of fails[k].slice(0, 4)) console.log('      [' + k + '] ' + m);
  };
  const clean = await checks(loadModule(SRC), 'clean');
  report('page and fake: parity with schema_v26.sql, the form, Create, Change PIN, the manager PIN, before v26', clean);
  report('build.py: no /exec address, a test store off the hub', buildChecks(null));
  for (const p of PLANTS) {
    let fails;
    if (p.where === 'page') {
      if (SRC.split(p.old).length !== 2) { failed++; console.log('FAIL  control "' + p.name + '": its text is not in stores.js once'); continue; }
      fails = await checks(loadModule(SRC.replace(p.old, p.neu)), p.name);
    } else fails = buildChecks(p.py);
    if (fails[p.bites]) console.log('PASS  control "' + p.name + '" bites (' + fails[p.bites].length + ' in "' + p.bites + '")');
    else { failed++; console.log('FAIL  control "' + p.name + '" did NOT bite "' + p.bites + '" (' + Object.keys(fails).join(', ') + ')'); }
  }
  console.log(failed ? 'hq_stores: ' + failed + ' FAILED' : 'hq_stores: ALL PASS');
  process.exit(failed ? 1 : 0);
})();
