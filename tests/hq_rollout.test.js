'use strict';
// GATE: HQ control (supabase/schema_v11.sql, hq/): catalogEdit.js's
// commitHqRollout and matchVendor, run against the fake Supabase
// (fake_supabase.js mirrors v11; the SQL is pinned in Postgres by
// supabase/tests/smoke_v11.sql). Checks:
//   - matchVendor finds a store's name for HQ's vendor ("B&T" is "B&T
//     Distributions") and leaves a vendor a store doesn't have unmatched
//   - one store's share: a new vendor with its days and contact; new items
//     with no par and no storage area (Needs setup, on no count list), the
//     next item numbers, pack and notes kept; an item the store already has
//     keeps its main vendor, par and area and gains only the vendors it
//     didn't list (on their count lists in its area); inactive and listed
//     ones skipped; an unknown vendor refused; Undo exact; the database's
//     rules hold; the label
//   - on random stores: items the rollout doesn't name never change
//   - HQ sign-in: the invite, too-short passphrase, the lockout (that
//     person's only, a store's PIN untouched)
//   - one save across stores: each store's tables equal the editor's copy,
//     one change each by "HQ · <name>", the phones' catalogs follow, vendor
//     names remembered; a CONFLICT at one store or a Sheet store writes
//     nothing anywhere; the store undoes HQ's change itself
// Each has a planted-defect control.
//
// Run bare: node tests/hq_rollout.test.js
// A passing run ends with "hq_rollout: ALL PASS".

const vm = require('vm');
const F = require('./fake_apps_script.js');
const { FakeSupabase, checkCatalogTables } = require('./fake_supabase.js');

const SRC = file => F.source(null, file);
const FILE = 'template/editor/catalogEdit.js';
const clone = x => JSON.parse(JSON.stringify(x));
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const STORES = Number(process.argv[2]) || 200;

function loadCE(text) {
  const ctx = { console };
  vm.createContext(ctx);
  vm.runInContext(text, ctx, { filename: FILE });
  return ctx.CatalogEdit;
}
function rng(seed) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
}
const pick = (rnd, arr) => arr[Math.floor(rnd() * arr.length)];

function storeTables(vendorNames) {
  return checkCatalogTables({
    vendors: vendorNames.map(n => ({ name: n, mults: [1, 0, 0, 1, 0, 0, 0], cutoff: null })),
    areas: [{ name: 'Walk-in', ord: 10 }, { name: 'Dry Storage', ord: 20 }],
    items: [
      { id: 'ITEM-0007', name: 'Lime', primaryVendor: vendorNames[0], pack: 'CS', par: 3, active: true, useMult: true, notes: '', sku: '', category: '', eligible: [vendorNames[0]], seq: 2 },
      { id: 'ITEM-0012', name: 'Mango Puree', primaryVendor: vendorNames[0], pack: 'CS', par: 2, active: true, useMult: true, notes: 'keep cold', sku: '', category: '', eligible: [vendorNames[0]], seq: 5 },
      { id: 'ITEM-0013', name: 'Old Sauce', primaryVendor: vendorNames[0], pack: 'EA', par: 1, active: false, useMult: true, notes: '', sku: '', category: '', eligible: [vendorNames[0]], seq: 6 },
      { id: 'X-1', name: 'Gloves', primaryVendor: vendorNames[1], pack: 'BOX', par: 2, active: true, useMult: false, notes: '', sku: '', category: '', eligible: [vendorNames[1], vendorNames[0]], seq: 7 }
    ],
    pickRows: [
      { vendor: vendorNames[0], id: 'ITEM-0007', area: 'Walk-in', shelfOrder: 10, seq: 2 },
      { vendor: vendorNames[0], id: 'ITEM-0012', area: 'Walk-in', shelfOrder: 20, seq: 3 },
      { vendor: vendorNames[1], id: 'X-1', area: 'Dry Storage', shelfOrder: 10, seq: 4 },
      { vendor: vendorNames[0], id: 'X-1', area: 'Dry Storage', shelfOrder: 20, seq: 5 }
    ]
  });
}

// A random store that obeys the database's rules (as items_bulk.test.js).
function randomTables(rnd) {
  const names = ['Sysco', 'ELPIS', 'Webstaurant', 'Amazon', 'Baldor'].slice(0, 2 + Math.floor(rnd() * 4));
  const items = [], pickRows = [];
  let seq = 2, rowSeq = 2;
  const n = 3 + Math.floor(rnd() * 15);
  for (let i = 1; i <= n; i++) {
    const id = 'ITEM-' + String(i).padStart(4, '0');
    const primary = rnd() < 0.1 ? null : pick(rnd, names);
    const eligible = primary ? [primary].concat(names.filter(v => v !== primary && rnd() < 0.3)) : [];
    const active = rnd() < 0.85;
    items.push({ id, name: 'Item ' + i, primaryVendor: primary, pack: 'CS', par: rnd() < 0.2 ? null : 2, active, useMult: true,
                 notes: '', sku: '', category: '', eligible, seq: seq++ });
    if (!active || !primary) continue;
    const area = pick(rnd, ['Walk-in', 'Dry Storage']);
    for (const v of eligible) if (v === primary || rnd() < 0.6) pickRows.push({ vendor: v, id, area, shelfOrder: 10, seq: rowSeq++ });
  }
  return checkCatalogTables({ vendors: names.map(nm => ({ name: nm, mults: [1, 0, 0, 0, 0, 0, 0], cutoff: null })),
                              areas: [{ name: 'Walk-in', ord: 10 }, { name: 'Dry Storage', ord: 20 }], items, pickRows });
}

function problems(text) {
  const out = [];
  const bad = (what, detail) => { if (out.length < 30) out.push(what + (detail ? ': ' + detail : '')); };
  const refused = fn => { try { fn(); return ''; } catch (e) { return e.message || String(e); } };
  let CE;
  try { CE = loadCE(text); } catch (e) { return ['catalogEdit.js did not load: ' + e.message]; }
  if (CE.writes.indexOf('commitHqRollout') < 0 || typeof CE.matchVendor !== 'function') return ['HQ calls are not registered'];

  // ---- matchVendor ----
  const names = ['Sysco', 'B&T Distributions', 'Chefs Warehouse', 'SamuelSon', 'Webstaurant Store', 'Chef Center',
                 'Amazon.com', 'Happy Endings Hospitality - Internal Transfers', 'Capital'];
  const MATCH = [['sysco', 'Sysco', 'same'], ['B&T', 'B&T Distributions', 'close'], ['Chef Warehouse', 'Chefs Warehouse', 'close'],
                 ['Samuel and Sons', 'SamuelSon', 'close'], ['Webstaurant', 'Webstaurant Store', 'close'], ['Amazon', 'Amazon.com', 'close'],
                 ['Capital Seaboard', 'Capital', 'close'], ['Happy Supply', null], ['IGF', null], ['Chef Centre', 'Chef Center', 'close']];
  for (const [w, name, how] of MATCH) {
    const m = CE.matchVendor(names, w);
    if (name === null ? m !== null : !(m && m.name === name && m.how === how)) bad('matchVendor ' + w, JSON.stringify(m));
  }

  // ---- One store's share ----
  const t = storeTables(['Sysco', 'B&T Distributions']);
  const p = {
    label: 'Spring LTO',
    vendors: [{ name: 'Happy Supply', mults: [0, 3, 0, 0, 4, 0, 0], cutoff: '15:00', contact: { person: ' Pat ' } }],
    items: [
      { name: 'Crab Salad', pack: '5 LB', notes: 'Spring LTO', vendor: 'Happy Supply', backups: ['sysco'] },
      { name: 'Yuzu Mayo', pack: '', notes: '', vendor: 'B&T Distributions', backups: [] },
      { name: 'mango puree', pack: 'X', notes: 'X', vendor: 'Happy Supply', backups: ['B&T Distributions'] },
      { name: 'Lime', vendor: 'Sysco', backups: [] },
      { name: 'Old Sauce', vendor: 'Happy Supply', backups: [] },
      { name: 'Crab salad', vendor: 'Sysco', backups: [] }
    ]
  };
  let c;
  try { c = CE.call(t, 'commitHqRollout', [p]); } catch (e) { return out.concat(['commitHqRollout threw: ' + e.message]); }
  const a = CE.applyOps(t, c.ops);
  try { checkCatalogTables(clone(a)); } catch (e) { bad('rules', e.message); }
  const itemOf = (tb, nm) => tb.items.find(x => x.name.toLowerCase() === nm.toLowerCase());
  const hs = a.vendors.find(v => v.name === 'Happy Supply');
  if (!hs || !same(hs.mults, [0, 3, 0, 0, 4, 0, 0]) || hs.cutoff !== '15:00' || !hs.contact || hs.contact.person !== 'Pat') bad('vendor added with its days and contact', JSON.stringify(hs));
  const crab = itemOf(a, 'Crab Salad'), yuzu = itemOf(a, 'Yuzu Mayo');
  if (!crab || crab.id !== 'ITEM-0014' || crab.par !== null || crab.pack !== '5 LB' || crab.notes !== 'Spring LTO' ||
      crab.primaryVendor !== 'Happy Supply' || !same(crab.eligible, ['Happy Supply', 'Sysco']) || crab.active !== true) bad('new item', JSON.stringify(crab));
  if (!yuzu || yuzu.id !== 'ITEM-0015' || yuzu.seq !== Math.max(...t.items.map(x => x.seq)) + 2) bad('new item numbers and order', JSON.stringify(yuzu));
  if (a.pickRows.some(r => r.id === (crab || {}).id || r.id === (yuzu || {}).id)) bad('a new item is on a count list before the store gives it an area');
  const mango = itemOf(a, 'Mango Puree'), mango0 = itemOf(t, 'Mango Puree');
  if (mango.primaryVendor !== 'Sysco' || mango.par !== 2 || mango.pack !== 'CS' || mango.notes !== 'keep cold' || mango.name !== 'Mango Puree') bad('an existing item kept its own fields', JSON.stringify(mango));
  if (!same(mango.eligible.slice().sort(), ['B&T Distributions', 'Happy Supply', 'Sysco'])) bad('an existing item gains the new vendors', JSON.stringify(mango.eligible));
  for (const v of ['Happy Supply', 'B&T Distributions']) {
    const r = a.pickRows.find(x => x.id === mango0.id && x.vendor === v);
    if (!r || r.area !== 'Walk-in') bad('the existing item is on ' + v + '\'s count list in its area', JSON.stringify(r));
  }
  if (!same(itemOf(a, 'Lime'), itemOf(t, 'Lime')) || !same(itemOf(a, 'Old Sauce'), itemOf(t, 'Old Sauce'))) bad('a listed or inactive item changed');
  const sk = c.result.skipped.map(x => x.name + ':' + x.reason).sort().join(', ');
  if (sk !== 'Crab salad:already in the catalog, Lime:already here, Old Sauce:inactive here') bad('skipped', sk);
  if (!same(c.result.itemsAdded, ['Crab Salad', 'Yuzu Mayo']) || !same(c.result.vendorsAdded, ['Happy Supply'])) bad('result', JSON.stringify(c.result));
  if (c.label !== 'HQ "Spring LTO": added vendor Happy Supply; added 2 items (Crab Salad, Yuzu Mayo); Mango Puree also from Happy Supply, B&T Distributions') bad('label', c.label);
  if (!same(CE.applyOps(a, CE.inverseOps(c.ops)), t)) bad('undo did not restore the store');
  const untouched = ['ITEM-0007', 'ITEM-0013', 'X-1'];
  for (const id of untouched) {
    const rows = tb => JSON.stringify(tb.pickRows.filter(r => r.id === id));
    if (!same(a.items.find(x => x.id === id), t.items.find(x => x.id === id)) || rows(a) !== rows(t)) bad('touched ' + id);
  }
  if (!/Happy Supply|not a recognised/i.test(refused(() => CE.call(t, 'commitHqRollout', [{ items: [{ name: 'Z', vendor: 'Happy Supply' }] }])))) bad('refusal', 'an unknown vendor was taken');
  if (!/already exists/.test(refused(() => CE.call(t, 'commitHqRollout', [{ vendors: [{ name: 'SYSCO', mults: [0, 0, 0, 0, 0, 0, 0], cutoff: '' }] }])))) bad('refusal', 'a vendor the store has was added again');

  // ---- Random stores: only what the rollout names changes ----
  for (let seed = 1; seed <= STORES; seed++) {
    const rnd = rng(seed), rt = randomTables(rnd);
    const vend = rt.vendors.map(v => v.name);
    const want = [];
    const nItems = 1 + Math.floor(rnd() * 4);
    for (let i = 0; i < nItems; i++) {
      const existing = rnd() < 0.5 ? pick(rnd, rt.items) : null;
      want.push({ name: existing ? existing.name : 'LTO ' + seed + '-' + i, pack: 'CS', notes: '', vendor: pick(rnd, vend),
                  backups: vend.filter(() => rnd() < 0.3) });
    }
    let rc;
    try { rc = CE.call(rt, 'commitHqRollout', [{ label: 'r', items: want }]); } catch (e) { bad('random rollout threw', 'seed ' + seed + ': ' + e.message); continue; }
    const ra = CE.applyOps(rt, rc.ops);
    try { checkCatalogTables(clone(ra)); } catch (e) { bad('rules', 'seed ' + seed + ': ' + e.message); }
    const named = new Set(want.map(x => x.name.toLowerCase()));
    for (const it of rt.items) {
      const now = ra.items.find(x => x.id === it.id);
      const rows = tb => JSON.stringify(tb.pickRows.filter(r => r.id === it.id && r.vendor === it.primaryVendor));
      if (!named.has(it.name.toLowerCase())) {
        const all = tb => JSON.stringify(tb.pickRows.filter(r => r.id === it.id));
        if (!same(now, it) || all(ra) !== all(rt)) { bad('random: an item the rollout doesn\'t name changed', 'seed ' + seed + ' ' + it.id); break; }
      } else if (now.primaryVendor !== it.primaryVendor || now.par !== it.par || now.active !== it.active || rows(ra) !== rows(rt)) {
        bad('random: an existing item lost its main vendor, par or area', 'seed ' + seed + ' ' + it.id); break;
      }
    }
    for (const it of ra.items) if (!rt.items.some(x => x.id === it.id) && (it.par !== null || ra.pickRows.some(r => r.id === it.id))) bad('random: a new item has a par or a count list', 'seed ' + seed);
    if (!same(CE.applyOps(ra, CE.inverseOps(rc.ops)), rt)) bad('random undo', 'seed ' + seed);
  }

  // ---- HQ through the fake Supabase ----
  const sb = new FakeSupabase(Date.UTC(2026, 10, 1, 15));
  const setup = [['zzrpr', ['Sysco', 'B&T Distributions'], true], ['zzrpfr', ['Sysco', 'B&T'], true], ['zzsheet', ['Sysco', 'B&T'], false]];
  for (const [slug, vends, direct] of setup) {
    sb.provision(slug);
    const s = sb.stores.get(slug);
    Object.assign(s, { pins: { pin: '4321' }, editorDirect: direct, profile: { location: 'Test ' + slug, abbr: slug, concept: 'roll-play' },
                       tables: storeTables(vends), version: 1 });
  }
  const code = sb.hqInvite('Sebastian');
  if (sb.handle('mog_hq_login', { p_name: 'Sebastian', p_passphrase: 'correct horse battery' }).ok) bad('login before the invite is used');
  if (sb.handle('mog_hq_claim', { p_name: 'sebastian', p_code: code, p_passphrase: 'short' }).error !== 'PASSPHRASE_TOO_SHORT') bad('a short passphrase was taken');
  const claim = sb.handle('mog_hq_claim', { p_name: 'sebastian', p_code: code.toLowerCase(), p_passphrase: 'correct horse battery' });
  if (!claim.ok || claim.data.name !== 'Sebastian') bad('claim', JSON.stringify(claim));
  if (sb.handle('mog_hq_claim', { p_name: 'Sebastian', p_code: code, p_passphrase: 'correct horse battery' }).ok) bad('an invite worked twice');
  let r;
  for (let i = 0; i < 5; i++) r = sb.handle('mog_hq_login', { p_name: 'Sebastian', p_passphrase: 'wrong ' + i });
  if (!r.lockout) bad('five wrong passphrases did not lock', JSON.stringify(r));
  if (!sb.handle('mog_hq_login', { p_name: 'Sebastian', p_passphrase: 'correct horse battery' }).lockout) bad('the right passphrase got through a lockout');
  if (sb.stores.get('zzrpr').failCount || sb.stores.get('zzrpr').lockedUntil) bad('HQ\'s lockout touched a store\'s PIN');
  sb.nowMs += 16 * 60000;
  const login = sb.handle('mog_hq_login', { p_name: 'Sebastian', p_passphrase: 'correct horse battery' });
  if (!login.ok) return out.concat(['login after the lockout: ' + JSON.stringify(login)]);
  const tok = login.data.token;
  if (sb.handle('mog_hq_data', { p_token: 'bogus' }).error !== 'SESSION_EXPIRED') bad('a bogus token read the stores');

  const data = sb.handle('mog_hq_data', { p_token: tok }).data;
  const shareOf = (slug, vendorName) => ({ label: 'Spring LTO', vendors: [],
    items: [{ name: 'Crab Salad', pack: '5 LB', notes: '', vendor: vendorName, backups: [] }] });
  const plan = [];
  for (const st of data.stores.filter(x => x.editorDirect)) {
    const vNames = st.tables.vendors.map(v => v.name);
    const m = CE.matchVendor(vNames, 'B&T');
    if (!m) { bad('no match for B&T at ' + st.slug); continue; }
    const call = CE.call(st.tables, 'commitHqRollout', [shareOf(st.slug, m.name)]);
    plan.push({ slug: st.slug, tables: st.tables, call, link: { slug: st.slug, hqName: 'B&T', vendor: m.name } });
  }
  const res = sb.handle('mog_hq_apply', { p_token: tok, p_changes: plan.map(x => ({ slug: x.slug, label: x.call.label, ops: x.call.ops })),
                                         p_links: plan.map(x => x.link) });
  if (!res.ok || res.data.changes.length !== 2) bad('apply', JSON.stringify(res));
  for (const x of plan) {
    const s = sb.stores.get(x.slug);
    const az = tb => Object.assign(clone(tb), { vendors: clone(tb.vendors).sort((u, v) => u.name.localeCompare(v.name)) });
    if (!same(az(CE.applyOps(x.tables, x.call.ops)), sb.handle('mog_hq_data', { p_token: tok }).data.stores.find(y => y.slug === x.slug).tables)) bad('the editor\'s copy differs from Supabase', x.slug);
    const log = s.changeLog[s.changeLog.length - 1];
    if (log.by !== 'HQ · Sebastian' || log.label !== 'HQ "Spring LTO": added 1 item (Crab Salad)') bad('logged change', JSON.stringify(log));
    if (!s.catalog || !Object.values(s.catalog.items).some(it => it.name === 'Crab Salad')) bad('the phones\' catalog did not follow', x.slug);
  }
  const after = sb.handle('mog_hq_data', { p_token: tok }).data;
  if (!same(after.links.map(l => l.slug + '=' + l.vendor), ['zzrpfr=B&T', 'zzrpr=B&T Distributions'])) bad('links', JSON.stringify(after.links));
  if (after.recent.length !== 2 || after.recent.some(x => x.by !== 'HQ · Sebastian')) bad('recent', JSON.stringify(after.recent));

  // All or none: one store's copy is stale.
  const fresh = after.stores.find(x => x.slug === 'zzrpr').tables;
  const stale = after.stores.find(x => x.slug === 'zzrpfr').tables;
  const other = sb.handle('mog_editor_login', { p_slug: 'zzrpfr', p_pin: '4321' });
  const sysco = other.data.tables.vendors.find(v => v.name === 'Sysco');
  sb.handle('mog_editor_apply', { p_token: other.data.token, p_label: 'x', p_by: 'KM', p_ops: [{ t: 'vendors', key: 'Sysco', before: sysco,
    after: Object.assign({}, sysco, { mults: [2, 2, 2, 2, 2, 0, 0] }) }] });
  const both = [{ slug: 'zzrpr', tables: fresh }, { slug: 'zzrpfr', tables: stale }].map(x => {
    const cc = CE.call(x.tables, 'commitHqRollout', [{ label: 'Second', vendors: [{ name: 'Happy Supply', mults: [0, 1, 0, 0, 0, 0, 0], cutoff: '' }], items: [] }]);
    // The stale store's share also changes Sysco's days, worked out from the old copy.
    const s2 = x.tables.vendors.find(v => v.name === 'Sysco');
    const ops = x.slug === 'zzrpfr' ? cc.ops.concat([{ t: 'vendors', key: 'Sysco', before: s2, after: Object.assign({}, s2, { cutoff: '09:00' }) }]) : cc.ops;
    return { slug: x.slug, label: cc.label, ops };
  });
  const before2 = JSON.stringify([sb.stores.get('zzrpr').tables, sb.stores.get('zzrpfr').tables, (sb.stores.get('zzrpr').changeLog || []).length]);
  const conflict = sb.handle('mog_hq_apply', { p_token: tok, p_changes: both, p_links: [{ slug: 'zzrpr', hqName: 'Happy Supply', vendor: 'Happy Supply' }] });
  if (conflict.error !== 'CONFLICT' || !/^zzrpfr /.test(conflict.detail || '')) bad('a stale store is not a CONFLICT', JSON.stringify(conflict));
  if (JSON.stringify([sb.stores.get('zzrpr').tables, sb.stores.get('zzrpfr').tables, (sb.stores.get('zzrpr').changeLog || []).length]) !== before2) bad('a CONFLICT at one store still wrote the other');
  if (sb.handle('mog_hq_data', { p_token: tok }).data.links.length !== 2) bad('a refused save still wrote a link');
  const sheet = sb.handle('mog_hq_apply', { p_token: tok, p_changes: [{ slug: 'zzsheet', label: 'x', ops: both[0].ops }], p_links: [] });
  if (!/^REJECTED: zzsheet/.test(sheet.error || '')) bad('a Sheet store was written', JSON.stringify(sheet));

  // The store undoes HQ's change itself.
  const own = sb.handle('mog_editor_login', { p_slug: 'zzrpr', p_pin: '4321' });
  const hqChange = (sb.stores.get('zzrpr').changeLog || []).find(l => l.by === 'HQ · Sebastian');
  if (!hqChange) return out.concat(['no HQ change at zzrpr to undo']);
  const undo = sb.handle('mog_editor_undo', { p_token: own.data.token, p_change_id: hqChange.id, p_by: 'GM' });
  if (!undo.ok || sb.stores.get('zzrpr').tables.items.some(it => it.name === 'Crab Salad')) bad('the store could not undo HQ\'s change', JSON.stringify(undo));
  return out;
}

let failed = 0;
const text = SRC(FILE);
const main = problems(text);
if (main.length) { failed++; console.log('FAIL  ' + main.join('\n      ')); }
else console.log('PASS  HQ: vendor matching, one store\'s share (new items, backups on existing ones, skips, Undo, rules), ' + STORES +
                 ' random stores untouched outside the rollout, sign-in and lockout, one save across stores or none, the store\'s own Undo');

const CONTROLS = [
  { name: 'an existing item\'s main vendor is replaced',
    find: '        const res = setItemsVendor(w, [have.id], v, true);',
    replace: '        have.primaryVendor = v; have.eligible = [v].concat(have.eligible); const res = { changed: 1, skipped: [] };' },
  { name: 'new items arrive with a par of 0',
    find: "      w.items.push({ id: 'ITEM-' + String(maxN).padStart(4, '0'), name: name, primaryVendor: primary, pack: s_(row.pack), par: null,",
    replace: "      w.items.push({ id: 'ITEM-' + String(maxN).padStart(4, '0'), name: name, primaryVendor: primary, pack: s_(row.pack), par: 0," },
  { name: 'an inactive item gets the new vendor',
    find: "      if (have.active !== true) { skipped.push({ name: s_(have.name), reason: 'inactive here' }); continue; }\n", replace: '' },
  { name: 'company words count when matching ("B&T" misses "B&T Distributions")',
    find: "  const VENDOR_NOISE = ['and', 'the', 'inc', 'co', 'llc', 'ltd', 'corp', 'company',\n                        'distribution', 'distributions', 'distributor', 'distributors'];",
    replace: '  const VENDOR_NOISE = [];' },
  { name: 'pack and notes dropped from new items',
    find: '        fresh.push({ name: name, primaryVendor: main, eligible: backups, pack: row.pack, notes: row.notes });',
    replace: '        fresh.push({ name: name, primaryVendor: main, eligible: backups });' }
];
for (const c of CONTROLS) {
  let res;
  try { res = problems(F.plant(text, c.find, c.replace)); }
  catch (e) { failed++; console.log(`FAIL  control "${c.name}" crashed instead of biting: ${e.message}`); continue; }
  if (res.length) console.log(`PASS  control "${c.name}" bites (${res[0].slice(0, 110)})`);
  else { failed++; console.log(`FAIL  control "${c.name}" did NOT bite`); }
}

console.log(failed ? `hq_rollout: ${failed} FAILED` : 'hq_rollout: ALL PASS');
process.exit(failed ? 1 : 0);
