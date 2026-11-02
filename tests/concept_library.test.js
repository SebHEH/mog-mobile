'use strict';
// GATE: the concept library (supabase/schema_v12.sql, hq/'s Libraries tab):
// catalogEdit.js's cleanLibrary, librarySeed, libraryAdd and libraryLabel,
// and setting a store up from a library through commitHqRollout, run
// against the fake Supabase (fake_supabase.js mirrors v12; the SQL is pinned
// in Postgres by supabase/tests/smoke_v12.sql). Checks:
//   - the list rules: trimmed, backups without the main vendor or repeats,
//     each name once ignoring case, no name / no main vendor refused
//   - starting from a store: its active items with a vendor, in its list
//     order, a name listed twice (one row per vendor) as one item with the
//     other vendors as backups, inactive and vendorless ones left out; no
//     par, no area; on random stores, every such name exactly once
//   - an LTO added to a library: new names at the end, an existing row kept
//   - the label of a save
//   - a store set up from a library: every item, in the library's order,
//     with its vendors, no par and on no count list (Needs setup); Undo
//     empties it again; the database's rules hold
//   - through the fake: each store's side, a library saved whole (cleaned
//     the same way as cleanLibrary), a stale save a CONFLICT, bad lists
//     refused, an LTO and its library in one save, all or none both ways,
//     the v11 call, a library never in a store's tables or phones
// Each has a planted-defect control.
//
// Run bare: node tests/concept_library.test.js
// A passing run ends with "concept_library: ALL PASS".

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
const item = (id, name, vendor, eligible, seq, extra) => Object.assign({ id, name, primaryVendor: vendor, pack: 'CS', par: 2, active: true,
  useMult: true, notes: '', sku: '', category: '', eligible, seq }, extra || {});

// A store like Rosslyn FOH: a name listed twice (one row per vendor), an
// inactive item, an item with no vendor, items out of list order.
function seedStore() {
  return checkCatalogTables({
    vendors: ['Elpis', 'Sysco', 'Transfer', 'Webstaurant'].map(n => ({ name: n, mults: [1, 0, 0, 1, 0, 0, 0], cutoff: null })),
    areas: [{ name: 'Front', ord: 10 }],
    items: [
      item('ITEM-0037', 'Large Bags', 'Webstaurant', ['Webstaurant'], 54),
      item('ITEM-0048', 'Large Bags', 'Elpis', ['Elpis', 'Transfer'], 36, { pack: 'CASE' }),
      item('ITEM-0002', 'Lime', 'Sysco', ['Sysco', 'Webstaurant'], 10, { notes: ' keep cold ', par: 7 }),
      item('ITEM-0003', 'Old Sauce', 'Sysco', ['Sysco'], 11, { active: false }),
      item('ITEM-0004', 'Mystery', null, [], 12),
      item('ITEM-0005', 'large bags ', 'Transfer', ['Transfer'], 60)
    ],
    pickRows: [{ vendor: 'Sysco', id: 'ITEM-0002', area: 'Front', shelfOrder: 10, seq: 2 }]
  });
}

// A random store that obeys the database's rules (as hq_rollout.test.js).
function randomTables(rnd) {
  const names = ['Sysco', 'ELPIS', 'Webstaurant', 'Amazon', 'Baldor'].slice(0, 2 + Math.floor(rnd() * 4));
  const items = [];
  const n = 3 + Math.floor(rnd() * 15);
  for (let i = 1; i <= n; i++) {
    const primary = rnd() < 0.1 ? null : pick(rnd, names);
    const eligible = primary ? [primary].concat(names.filter(v => v !== primary && rnd() < 0.3)) : [];
    const name = rnd() < 0.15 && i > 1 ? 'Item ' + (1 + Math.floor(rnd() * (i - 1))) : 'Item ' + i;
    items.push(item('ITEM-' + String(i).padStart(4, '0'), rnd() < 0.5 ? name : name.toUpperCase(), primary, eligible, 2 + Math.floor(rnd() * 40),
                    { active: rnd() < 0.85, par: rnd() < 0.2 ? null : 2 }));
  }
  return checkCatalogTables({ vendors: names.map(nm => ({ name: nm, mults: [1, 0, 0, 0, 0, 0, 0], cutoff: null })),
                              areas: [{ name: 'Walk-in', ord: 10 }], items, pickRows: [] });
}
const EMPTY = () => checkCatalogTables({ vendors: [], areas: [], items: [], pickRows: [] });

// HQ's "Set up a store" share for a store with none of the vendors yet.
function setupShare(CE, lib, label) {
  const vendors = [];
  for (const it of lib) for (const v of [it.vendor].concat(it.backups)) if (!vendors.some(x => x.name.toLowerCase() === v.toLowerCase())) {
    vendors.push({ name: v, mults: CE.multsFromDays([false, true, false, false, true, false, false]), cutoff: '', contact: {} });
  }
  return { label, vendors, items: lib.map(it => ({ name: it.name, pack: it.pack, notes: it.notes, vendor: it.vendor, backups: it.backups })) };
}

function problems(text) {
  const out = [];
  const bad = (what, detail) => { if (out.length < 30) out.push(what + (detail ? ': ' + detail : '')); };
  const refused = fn => { try { fn(); return ''; } catch (e) { return e.message || String(e); } };
  let CE;
  try { CE = loadCE(text); } catch (e) { return ['catalogEdit.js did not load: ' + e.message]; }
  if (typeof CE.cleanLibrary !== 'function' || typeof CE.librarySeed !== 'function' || typeof CE.libraryAdd !== 'function' ||
      typeof CE.libraryLabel !== 'function') return ['the library functions are not exported'];

  // ---- The list rules ----
  const cleaned = CE.cleanLibrary([{ name: '  Lime ', pack: ' CS ', vendor: ' Sysco', backups: ' B&T , sysco,, b&t , Elpis', notes: ' cold ' },
                                   { name: 'Yuzu', vendor: 'B&T', backups: ['Elpis', 7, '', 'ELPIS'] }]);
  if (!same(cleaned, [{ name: 'Lime', pack: 'CS', vendor: 'Sysco', backups: ['B&T', 'Elpis'], notes: 'cold' },
                      { name: 'Yuzu', pack: '', vendor: 'B&T', backups: ['Elpis'], notes: '' }])) bad('clean', JSON.stringify(cleaned));
  if (!/twice/.test(refused(() => CE.cleanLibrary([{ name: 'Lime', vendor: 'A' }, { name: 'LIME ', vendor: 'B' }])))) bad('a name twice was taken');
  if (!/no main vendor/.test(refused(() => CE.cleanLibrary([{ name: 'Lime', vendor: ' ' }])))) bad('an item with no main vendor was taken');
  if (!/Item 2 has no name/.test(refused(() => CE.cleanLibrary([{ name: 'Lime', vendor: 'A' }, { name: '', vendor: 'A' }])))) bad('an item with no name was taken');
  if (!/300/.test(refused(() => CE.cleanLibrary([{ name: 'x'.repeat(301), vendor: 'A' }])))) bad('a name over 300 characters was taken');
  if (!same(CE.cleanLibrary(cleaned), cleaned)) bad('cleaning twice changes the list');

  // ---- Starting from a store ----
  const st = seedStore();
  const seed = CE.librarySeed(st);
  const want = [{ name: 'Lime', pack: 'CS', vendor: 'Sysco', backups: ['Webstaurant'], notes: 'keep cold' },
                { name: 'Large Bags', pack: 'CASE', vendor: 'Elpis', backups: ['Transfer', 'Webstaurant'], notes: '' }];
  if (!same(seed.items, want)) bad('seed items', JSON.stringify(seed.items));
  if (seed.inactive !== 1 || seed.noVendor !== 1 || !same(seed.merged, ['Large Bags'])) bad('seed counts', JSON.stringify([seed.inactive, seed.noVendor, seed.merged]));
  if (!same(st, seedStore())) bad('the seed changed the store');

  for (let s = 1; s <= STORES; s++) {
    const rnd = rng(s), rt = randomTables(rnd);
    let sd;
    try { sd = CE.librarySeed(rt); } catch (e) { bad('random seed threw', 'seed ' + s + ': ' + e.message); continue; }
    const live = rt.items.filter(it => it.active === true && it.primaryVendor).sort((a, b) => a.seq - b.seq);
    const names = [];
    for (const it of live) if (!names.some(n => n.toLowerCase() === it.name.trim().toLowerCase())) names.push(it.name.trim());
    if (!same(sd.items.map(r => r.name), names)) { bad('random: not every active item with a vendor exactly once, in list order', 'seed ' + s); break; }
    for (const r of sd.items) {
      const rows = live.filter(it => it.name.trim().toLowerCase() === r.name.toLowerCase());
      const vends = [];
      for (const it of rows) for (const v of [it.primaryVendor].concat(it.eligible)) if (!vends.some(x => x.toLowerCase() === v.toLowerCase())) vends.push(v);
      if (r.vendor !== rows[0].primaryVendor || !same([r.vendor].concat(r.backups), vends)) { bad('random: a library item\'s vendors', 'seed ' + s + ' ' + r.name); break; }
      if (Object.keys(r).join() !== 'name,pack,vendor,backups,notes') { bad('random: a library item carries more than its five fields', Object.keys(r).join()); break; }
    }
  }

  // ---- An LTO added to a library; a save's label ----
  const added = CE.libraryAdd(want, [{ name: 'Crab Salad', vendor: 'Happy Supply', backups: ['Sysco'] }, { name: 'lime', vendor: 'Baldor', pack: 'X' }]);
  if (!same(added.items, want.concat([{ name: 'Crab Salad', pack: '', vendor: 'Happy Supply', backups: ['Sysco'], notes: '' }])) ||
      !same(added.added, ['Crab Salad']) || !same(added.kept, ['lime'])) bad('libraryAdd', JSON.stringify(added));
  const edited = [Object.assign({}, want[0], { pack: '4 x 5 LB' }), { name: 'Yuzu Mayo', vendor: 'Sysco', pack: '', backups: [], notes: '' }];
  if (CE.libraryLabel(want, edited) !== 'Saved the library: 1 added, 1 changed, 1 removed') bad('label', CE.libraryLabel(want, edited));
  if (CE.libraryLabel(want, want.slice().reverse()) !== 'Saved the library (new order)') bad('label of a new order', CE.libraryLabel(want, want.slice().reverse()));

  // ---- A store set up from a library ----
  const empty = EMPTY();
  const share = setupShare(CE, seed.items, 'Set up from the Roll Play FOH library');
  let c;
  try { c = CE.call(empty, 'commitHqRollout', [share]); } catch (e) { return out.concat(['setting up an empty store threw: ' + e.message]); }
  const a = CE.applyOps(empty, c.ops);
  try { checkCatalogTables(clone(a)); } catch (e) { bad('rules', e.message); }
  if (!same(a.items.map(it => it.name), seed.items.map(r => r.name))) bad('set up: every library item, in its order', JSON.stringify(a.items.map(it => it.name)));
  for (const r of seed.items) {
    const it = a.items.find(x => x.name === r.name);
    if (!it || it.par !== null || it.primaryVendor !== r.vendor || !same(it.eligible, [r.vendor].concat(r.backups)) || it.pack !== r.pack || it.active !== true) {
      bad('set up: an item\'s vendors, pack, no par', JSON.stringify(it)); break;
    }
  }
  if (a.pickRows.length || a.areas.length) bad('set up: an item is on a count list or an area was made', JSON.stringify(a.pickRows));
  if (!same(a.vendors.map(v => v.name).sort(), ['Elpis', 'Sysco', 'Transfer', 'Webstaurant'])) bad('set up: the vendors', JSON.stringify(a.vendors));
  if (!same(CE.applyOps(a, CE.inverseOps(c.ops)), empty)) bad('set up: Undo did not empty the store');
  if (c.label !== 'HQ "Set up from the Roll Play FOH library": added vendors Sysco, Webstaurant, Elpis, Transfer; added 2 items (Lime, Large Bags)') bad('set up: label', c.label);

  // ---- Through the fake Supabase ----
  const sb = new FakeSupabase(Date.UTC(2026, 10, 1, 15));
  const setup = [['zzrpr', 'Roll Play Rosslyn BOH', seedStore()], ['zznew', 'Roll Play Arlington BOH', EMPTY()], ['zzodd', 'Roll Play Kiosk', seedStore()]];
  for (const [slug, location, tables] of setup) {
    sb.provision(slug);
    Object.assign(sb.stores.get(slug), { pins: { pin: '4321' }, editorDirect: true, profile: { location, abbr: slug, concept: 'roll-play' }, tables, version: 1 });
  }
  const code = sb.hqInvite('Sebastian');
  const tok = sb.handle('mog_hq_claim', { p_name: 'Sebastian', p_code: code, p_passphrase: 'correct horse battery' }).data.token;
  const read = () => sb.handle('mog_hq_data', { p_token: tok }).data;
  let d = read();
  const sides = d.stores.map(x => x.slug + '=' + x.side).sort().join(',');
  if (sides !== 'zznew=BOH,zzodd=null,zzrpr=BOH') bad('data: each store\'s side from its location', sides);
  if (!same(d.libraries, [])) bad('data: libraries before any save', JSON.stringify(d.libraries));

  const apply = (changes, libraries, links) => sb.handle('mog_hq_apply', { p_token: tok, p_changes: changes || [], p_links: links || [], p_libraries: libraries });
  const raw = [{ name: ' Lime ', pack: 'CS', vendor: 'Sysco ', backups: ['sysco', ' Webstaurant'], notes: ' keep cold ' }, want[1],
               { name: 'Yuzu Mayo', vendor: 'Sysco' }];
  let r = apply([], [{ concept: 'roll-play', side: 'BOH', version: 0, label: 'Started from Roll Play Rosslyn BOH (2 items)', seededFrom: 'Roll Play Rosslyn BOH', items: raw }]);
  d = read();
  const lib = d.libraries[0];
  if (!r.ok || !lib || lib.version !== 1 || lib.seededFrom !== 'Roll Play Rosslyn BOH' || lib.updatedBy !== 'HQ · Sebastian') bad('save a library', JSON.stringify(r));
  else if (!same(CE.cleanLibrary(lib.items), CE.cleanLibrary(raw)) || Object.keys(lib.items[0]).join() !== 'name,pack,notes,vendor,backups') {
    bad('the fake cleans a library differently from cleanLibrary, or not in jsonb\'s key order', JSON.stringify(lib.items));
  }
  r = apply([], [{ concept: 'roll-play', side: 'BOH', version: 0, items: [] }]);
  if (r.error !== 'CONFLICT' || read().libraries[0].items.length !== 3) bad('a stale library save', JSON.stringify(r));
  for (const badLib of [{ concept: 'roll-play', side: 'BOH', version: 1, items: [{ name: 'A', vendor: 'S' }, { name: 'a', vendor: 'S' }] },
                        { concept: 'roll-play', side: 'XOH', version: 0, items: [] }, { concept: 'roll-play', side: 'BOH', items: [] }]) {
    r = apply([], [badLib]);
    if (!/^REJECTED: /.test(r.error || '') || read().libraries.length !== 1 || read().libraries[0].version !== 1) bad('a bad list was taken', JSON.stringify(badLib));
  }

  // An LTO and its library in one save; all or none both ways.
  const ltoItems = [{ name: 'Crab Salad', pack: '5 LB', notes: '', vendor: 'Sysco', backups: [] }];
  const rpr = d.stores.find(x => x.slug === 'zzrpr');
  const lto = CE.call(rpr.tables, 'commitHqRollout', [{ label: 'Spring LTO', vendors: [], items: ltoItems }]);
  const plus = CE.libraryAdd(lib.items, ltoItems);
  r = apply([{ slug: 'zzrpr', label: lto.label, ops: lto.ops }], [{ concept: 'roll-play', side: 'BOH', version: 1, label: 'LTO', items: plus.items }]);
  d = read();
  if (!r.ok || !d.stores.find(x => x.slug === 'zzrpr').tables.items.some(it => it.name === 'Crab Salad') ||
      !d.libraries[0].items.some(it => it.name === 'Crab Salad') || d.libraries[0].version !== 2) bad('an LTO and its library in one save', JSON.stringify(r));
  const staleOps = lto.ops;   // worked out before the save above: Crab Salad exists now
  const before = JSON.stringify([sb.stores.get('zzrpr').tables, read().libraries]);
  r = apply([{ slug: 'zzrpr', label: 'again', ops: staleOps }], [{ concept: 'roll-play', side: 'BOH', version: 2, items: [] }]);
  if (r.error !== 'CONFLICT' || JSON.stringify([sb.stores.get('zzrpr').tables, read().libraries]) !== before) bad('a store\'s CONFLICT still wrote the library');
  const odd = d.stores.find(x => x.slug === 'zzodd');
  const oddLto = CE.call(odd.tables, 'commitHqRollout', [{ label: 'Spring LTO', vendors: [], items: ltoItems }]);
  r = apply([{ slug: 'zzodd', label: oddLto.label, ops: oddLto.ops }], [{ concept: 'roll-play', side: 'BOH', version: 1, items: [] }]);
  if (r.error !== 'CONFLICT' || sb.stores.get('zzodd').tables.items.some(it => it.name === 'Crab Salad') || (sb.stores.get('zzodd').changeLog || []).length) {
    bad('a library\'s CONFLICT still wrote a store', JSON.stringify(r));
  }
  r = sb.handle('mog_hq_apply', { p_token: tok, p_changes: [], p_links: [] });
  if (!r.ok || !same(r.data.libraries, [])) bad('the v11 call', JSON.stringify(r));

  // A store set up from the saved library, through the fake.
  d = read();
  const fresh = d.stores.find(x => x.slug === 'zznew');
  const sc = CE.call(fresh.tables, 'commitHqRollout', [setupShare(CE, d.libraries[0].items, 'Set up from the Roll Play BOH library')]);
  r = apply([{ slug: 'zznew', label: sc.label, ops: sc.ops }], null);
  const got = read().stores.find(x => x.slug === 'zznew').tables;
  const az = tb => Object.assign(clone(tb), { vendors: clone(tb.vendors).sort((u, v) => u.name.localeCompare(v.name)) });
  if (!r.ok || !same(az(CE.applyOps(fresh.tables, sc.ops)), got)) bad('set up through the fake: the editor\'s copy differs', JSON.stringify(r));
  if (!same(got.items.map(it => it.name), d.libraries[0].items.map(it => it.name)) || got.items.some(it => it.par !== null) || got.pickRows.length) {
    bad('set up through the fake: items, no par, no count list', JSON.stringify(got.items.map(it => [it.name, it.par])));
  }
  if (!got.items.some(it => it.name === 'Yuzu Mayo')) bad('set up through the fake: the library-only item is missing');
  for (const slug of ['zzrpr', 'zzodd']) {
    const s = sb.stores.get(slug);
    if (JSON.stringify(s.tables).indexOf('Yuzu') >= 0 || JSON.stringify(s.catalog || {}).indexOf('Yuzu') >= 0) bad('a library reached a store it was not rolled out to', slug);
  }
  return out;
}

let failed = 0;
const text = SRC(FILE);
const main = problems(text);
if (main.length) { failed++; console.log('FAIL  ' + main.join('\n      ')); }
else console.log('PASS  concept library: list rules, starting from a store (and ' + STORES + ' random stores), an LTO added, labels, ' +
                 'a store set up from a library, and through the fake: sides, whole saves, CONFLICT, refusals, all or none, the v11 call');

const CONTROLS = [
  { name: 'starting from a store keeps inactive items',
    find: '      if (it.active !== true) { inactive++; continue; }\n', replace: '' },
  { name: 'a name in the library twice',
    find: "      if (seen.has(name.toLowerCase())) throw new Error(what + ' is in the library twice.');\n", replace: '' },
  { name: 'backups keep the main vendor',
    find: '      const backups = [], listed = new Set([vendor.toLowerCase()]);',
    replace: '      const backups = [], listed = new Set();' },
  { name: 'a name listed twice loses its other vendors',
    find: '      if (row) { if (merged.indexOf(row.name) < 0) merged.push(row.name); }',
    replace: '      if (row) { if (merged.indexOf(row.name) < 0) merged.push(row.name); continue; }' },
  { name: 'an LTO replaces a library item it shares a name with',
    find: '      if (have.has(row.name.toLowerCase())) { kept.push(row.name); continue; }',
    replace: '      if (have.has(row.name.toLowerCase())) { list[list.findIndex(x => x.name.toLowerCase() === row.name.toLowerCase())] = row; kept.push(row.name); continue; }' }
];
for (const c of CONTROLS) {
  let res;
  try { res = problems(F.plant(text, c.find, c.replace)); }
  catch (e) { failed++; console.log(`FAIL  control "${c.name}" crashed instead of biting: ${e.message}`); continue; }
  if (res.length) console.log(`PASS  control "${c.name}" bites (${res[0].slice(0, 110)})`);
  else { failed++; console.log(`FAIL  control "${c.name}" did NOT bite`); }
}

console.log(failed ? `concept_library: ${failed} FAILED` : 'concept_library: ALL PASS');
process.exit(failed ? 1 : 0);
