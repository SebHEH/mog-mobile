'use strict';
// GATE: renaming a vendor at a store (supabase/schema_v15.sql, the Vendors
// page): catalogEdit.js's commitSaveVendor with a new name, run against the
// fake Supabase (fake_supabase.js mirrors v15; the SQL is pinned in
// Postgres by supabase/tests/smoke_v15.sql). Checks:
//   - the save is one rename step (plus the vendor's own edit, if any): the
//     vendor, its items' main vendor and vendor lists and its pick rows take
//     the new name, in place; the change log says "Renamed vendor ..."
//   - applyOps gives the save's own tables, and Undo gives the store back
//     exactly
//   - a change of capitals is a rename; a name another vendor has (ignoring
//     case) and a name over 100 characters are refused; a save without a new
//     name is no rename
//   - on random stores: only that vendor's name changes, and Undo is exact
//   - through the fake: the store's counts, "just today" edits, override day
//     picks, presence and HQ's remembered name follow; a count already under
//     the new name keeps its place; Undo renames it all back; a taken name is
//     a CONFLICT that changes nothing
// Each has a planted-defect control.
//
// Run bare: node tests/vendor_rename.test.js
// A passing run ends with "vendor_rename: ALL PASS".

const vm = require('vm');
const F = require('./fake_apps_script.js');
const { FakeSupabase, checkCatalogTables } = require('./fake_supabase.js');

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

function storeTables() {
  return checkCatalogTables({
    vendors: [{ name: 'B&T', mults: [0, 2, 0, 3, 0, 0, 2], cutoff: '16:00', contact: { person: 'Pat' } },
              { name: 'ELPIS', mults: [0, 5, 0, 0, 0, 0, 2], cutoff: null },
              { name: 'Sysco', mults: [1, 1, 1, 1, 1, 0, 0], cutoff: '10:00' }],
    areas: [{ name: 'Walk-in', ord: 10 }, { name: 'Dry Storage', ord: 20 }],
    items: [
      { id: 'ITEM-0001', name: 'Lime', primaryVendor: 'B&T', pack: 'CS', par: 3, active: true, useMult: true, notes: '', sku: '', category: '', eligible: ['B&T', 'Sysco'], seq: 2 },
      { id: 'ITEM-0002', name: 'Napkins', primaryVendor: 'ELPIS', pack: 'CS', par: 1, active: true, useMult: false, notes: '', sku: '', category: '', eligible: ['ELPIS'], seq: 3 },
      { id: 'ITEM-0003', name: 'Rice', primaryVendor: 'Sysco', pack: 'BAG', par: 2, active: true, useMult: true, notes: '', sku: '', category: '', eligible: ['Sysco', 'B&T'], seq: 4 }
    ],
    pickRows: [
      { vendor: 'B&T', id: 'ITEM-0001', area: 'Walk-in', shelfOrder: 10, seq: 2 },
      { vendor: 'Sysco', id: 'ITEM-0001', area: 'Walk-in', shelfOrder: 10, seq: 3 },
      { vendor: 'ELPIS', id: 'ITEM-0002', area: 'Dry Storage', shelfOrder: 10, seq: 4 },
      { vendor: 'Sysco', id: 'ITEM-0003', area: 'Dry Storage', shelfOrder: 20, seq: 5 },
      { vendor: 'B&T', id: 'ITEM-0003', area: 'Dry Storage', shelfOrder: 30, seq: 6 }
    ]
  });
}
function randomTables(rnd) {
  const names = ['Sysco', 'ELPIS', 'B&T', 'Amazon', 'Baldor'].slice(0, 2 + Math.floor(rnd() * 4));
  const items = [], pickRows = [];
  let seq = 2, rowSeq = 2;
  for (let i = 1, n = 3 + Math.floor(rnd() * 15); i <= n; i++) {
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
// The Vendors page's save for a vendor as it stands, with a new name.
const saveOf = (t, name, newName, extra) => {
  const v = t.vendors.find(x => x.name === name);
  return Object.assign({ mode: 'edit', name, newName, mults: v.mults, cutoff: v.cutoff || '', contact: v.contact || {} }, extra || {});
};

// A check that throws (a save or Undo refused where it should work) is a
// problem too, reported with what it was doing.
function problems(text) {
  const out = [];
  try { return checks(text, out); } catch (e) { return out.concat(['threw: ' + (e.message || String(e))]); }
}
function checks(text, out) {
  const bad = (what, detail) => { if (out.length < 30) out.push(what + (detail ? ': ' + detail : '')); };
  const refused = fn => { try { fn(); return ''; } catch (e) { return e.message || String(e); } };
  let CE;
  try { CE = loadCE(text); } catch (e) { return ['catalogEdit.js did not load: ' + e.message]; }
  const work = (tb, fn, args) => { const c = CE.call(tb, fn, args); return { c, a: CE.applyOps(tb, c.ops) }; };

  // ---- One rename ----
  const t = storeTables();
  let r;
  try { r = work(t, 'commitSaveVendor', [saveOf(t, 'B&T', 'B&T Distribution')]); } catch (e) { return ['the rename threw: ' + e.message]; }
  if (!same(r.c.ops, [{ rename: 'vendors', from: 'B&T', to: 'B&T Distribution' }])) bad('the save is one rename step', JSON.stringify(r.c.ops).slice(0, 200));
  if (r.c.label !== 'Renamed vendor "B&T" to "B&T Distribution"') bad('the change log label', r.c.label);
  if (r.c.result.name !== 'B&T Distribution' || r.c.result.renamedFrom !== 'B&T') bad('the result names both', JSON.stringify(r.c.result));
  const a = r.a, item = id => a.items.find(x => x.id === id);
  if (a.vendors.some(v => v.name === 'B&T') || !same(a.vendors.find(v => v.name === 'B&T Distribution'), Object.assign(clone(t.vendors[0]), { name: 'B&T Distribution' }))) {
    bad('the vendor takes the new name and keeps its days, cutoff and contact', JSON.stringify(a.vendors));
  }
  if (item('ITEM-0001').primaryVendor !== 'B&T Distribution' || !same(item('ITEM-0001').eligible, ['B&T Distribution', 'Sysco']) ||
      !same(item('ITEM-0003').eligible, ['Sysco', 'B&T Distribution'])) bad('its items\' main vendor and vendor lists follow, in place', JSON.stringify(a.items.map(x => [x.id, x.primaryVendor, x.eligible])));
  if (a.pickRows.filter(p => p.vendor === 'B&T Distribution').length !== 2 || a.pickRows.some(p => p.vendor === 'B&T') ||
      !same(a.pickRows.map(p => p.id + p.area + p.shelfOrder + p.seq), t.pickRows.map(p => p.id + p.area + p.shelfOrder + p.seq))) bad('its pick rows follow, with their areas and order');
  try { checkCatalogTables(clone(a)); } catch (e) { bad('the renamed tables break a rule', e.message); }
  if (!same(CE.applyOps(a, CE.inverseOps(r.c.ops)), t)) bad('Undo gives the store back exactly');
  if (!same(CE.call(a, 'getVendorsPage', []).result.map(v => v.name), ['B&T Distribution', 'ELPIS', 'Sysco'])) bad('the Vendors page reads the new name');

  // A rename and the days in one save.
  const both = work(t, 'commitSaveVendor', [saveOf(t, 'B&T', 'B&T Distribution', { mults: [0, 2, 0, 0, 0, 0, 5] })]);
  if (both.c.ops[0].rename !== 'vendors' || both.c.ops.length !== 2 || both.c.ops[1].t !== 'vendors' || both.c.ops[1].key !== 'B&T Distribution') bad('rename and days: the rename first, then the vendor\'s row', JSON.stringify(both.c.ops).slice(0, 200));
  if (!/^Renamed vendor "B&T" to "B&T Distribution"; day multipliers/.test(both.c.label)) bad('rename and days: the label', both.c.label);
  if (!same(CE.applyOps(both.a, CE.inverseOps(both.c.ops)), t)) bad('rename and days: Undo');

  // Capitals only, no new name, refusals.
  const caps = work(t, 'commitSaveVendor', [saveOf(t, 'ELPIS', 'Elpis')]);
  if (!same(caps.c.ops, [{ rename: 'vendors', from: 'ELPIS', to: 'Elpis' }]) || caps.a.items.find(x => x.id === 'ITEM-0002').primaryVendor !== 'Elpis') bad('a change of capitals is a rename', JSON.stringify(caps.c.ops));
  const none = CE.call(t, 'commitSaveVendor', [saveOf(t, 'Sysco', 'Sysco')]);
  if (none.ops.length || 'renamedFrom' in none.result) bad('the same name is no rename', JSON.stringify(none.ops));
  if (!/already a vendor here/.test(refused(() => CE.call(t, 'commitSaveVendor', [saveOf(t, 'Sysco', 'elpis')])))) bad('a name another vendor has (ignoring case) was taken');
  if (!/longer than 100/.test(refused(() => CE.call(t, 'commitSaveVendor', [saveOf(t, 'Sysco', 'S'.repeat(101))])))) bad('a name over 100 characters was taken');
  if (!/CONFLICT/.test(refused(() => CE.applyOps(t, [{ rename: 'vendors', from: 'Sysco', to: 'b&t' }])))) bad('applyOps took a rename onto a taken name');
  if (!/CONFLICT/.test(refused(() => CE.applyOps(t, [{ rename: 'vendors', from: 'Nobody', to: 'X' }])))) bad('applyOps took a rename of a vendor that is not there');

  // ---- Random stores: only that vendor's name changes ----
  for (let seed = 1; seed <= STORES; seed++) {
    const rnd = rng(seed), rt = randomTables(rnd);
    const from = pick(rnd, rt.vendors).name, to = rnd() < 0.2 ? from.toLowerCase() === from ? from.toUpperCase() : from.toLowerCase() : from + ' Co ' + seed;
    if (to === from) continue;
    let rc;
    try { rc = work(rt, 'commitSaveVendor', [saveOf(rt, from, to)]); } catch (e) { bad('random rename threw', 'seed ' + seed + ': ' + e.message); continue; }
    const swap = x => (x === from ? to : x);
    const want = clone(rt);
    for (const v of want.vendors) v.name = swap(v.name);
    for (const it of want.items) { it.primaryVendor = it.primaryVendor === null ? null : swap(it.primaryVendor); it.eligible = it.eligible.map(swap); }
    for (const p of want.pickRows) p.vendor = swap(p.vendor);
    if (!same(rc.a, want)) { bad('random rename: more than the name changed', 'seed ' + seed); break; }
    if (!same(CE.applyOps(rc.a, CE.inverseOps(rc.c.ops)), rt)) { bad('random rename: Undo', 'seed ' + seed); break; }
  }

  // ---- Through the fake Supabase ----
  const sb = new FakeSupabase(Date.UTC(2026, 10, 2, 18));
  sb.provision('zzr');
  Object.assign(sb.stores.get('zzr'), { pins: { pin: '4321' }, editorDirect: true, version: 1,
    profile: { location: 'Test zzr BOH', abbr: 'zzr', concept: 'roll-play' }, tables: storeTables() });
  const s = sb.stores.get('zzr'), cycle = '2026-11-02';
  s.state = { cycleDate: cycle, dayOfWeek: 'Mon', emergencyOverride: true, vendorPicks: { 'B&T': 3, Sysco: 2 }, todaysLog: [] };
  sb.upsert(s, cycle, null, [{ vendor: 'B&T', id: 'ITEM-0001', onHand: 2 }, { vendor: 'B&T', id: 'ITEM-0003', onHand: 1 },
                             { vendor: 'B&T Distribution', id: 'ITEM-0003', onHand: 5 }, { vendor: 'Sysco', id: 'ITEM-0001', onHand: 4 }], 'Maria');
  s.quickEdits = [{ qid: 1, cycle, kind: 'add_today', vendor: 'B&T', id: 'ITEM-0003', active: true, review: 'open' }];
  s.presence.set('zzdevice01', { name: 'Maria', vendor: 'B&T', seenAt: sb.nowMs });
  sb.hqState().links.push({ slug: 'zzr', hqName: 'B&T Distribution', vendor: 'B&T' });
  const count = (v, id) => { const row = sb.countsIn(s, cycle).get(v + '\u0001' + id); return row ? row.onHand : null; };
  const ed = sb.handle('mog_editor_login', { p_slug: 'zzr', p_pin: '4321' });
  const tables0 = clone(ed.data.tables);
  const call = CE.call(ed.data.tables, 'commitSaveVendor', [saveOf(ed.data.tables, 'B&T', 'B&T Distribution')]);
  const res = sb.handle('mog_editor_apply', { p_token: ed.data.token, p_label: call.label, p_by: 'Maria', p_ops: call.ops });
  if (!res.ok) return out.concat(['fake rename: ' + JSON.stringify(res)]);
  if (!same(sb.handle('mog_editor_get', { p_token: ed.data.token }).data.tables, CE.applyOps(tables0, call.ops))) bad('fake: the store reads what the editor saved');
  if (count('B&T Distribution', 'ITEM-0001') !== 2 || count('B&T Distribution', 'ITEM-0003') !== 5 || count('B&T', 'ITEM-0003') !== 1 ||
      count('B&T', 'ITEM-0001') !== null || count('Sysco', 'ITEM-0001') !== 4) bad('fake: today\'s counts move; one already under the new name keeps its place', JSON.stringify(Array.from(sb.countsIn(s, cycle).keys())));
  if (s.quickEdits[0].vendor !== 'B&T Distribution' || !same(s.state.vendorPicks, { Sysco: 2, 'B&T Distribution': 3 }) ||
      s.presence.get('zzdevice01').vendor !== 'B&T Distribution') bad('fake: the "just today" edit, the day pick and presence follow', JSON.stringify(s.state.vendorPicks));
  if (sb.hqLinks().find(l => l.slug === 'zzr').vendor !== 'B&T Distribution') bad('fake: HQ\'s remembered name follows');
  const taken = sb.handle('mog_editor_apply', { p_token: ed.data.token, p_label: 'x', p_by: null, p_ops: [{ rename: 'vendors', from: 'Sysco', to: 'elpis' }] });
  if (taken.error !== 'CONFLICT' || !s.tables.vendors.some(v => v.name === 'Sysco')) bad('fake: a taken name was not a CONFLICT', JSON.stringify(taken));
  const un = sb.handle('mog_editor_undo', { p_token: ed.data.token, p_change_id: res.data.changeId, p_by: 'Maria' });
  if (!un.ok || !same(s.tables, tables0)) bad('fake: Undo gives the tables back', JSON.stringify(un));
  if (count('B&T', 'ITEM-0001') !== 2 || count('B&T', 'ITEM-0003') !== 1 || count('B&T Distribution', 'ITEM-0003') !== 5 ||
      s.quickEdits[0].vendor !== 'B&T' || !same(s.state.vendorPicks, { Sysco: 2, 'B&T': 3 }) ||
      sb.hqLinks().find(l => l.slug === 'zzr').vendor !== 'B&T') bad('fake: Undo renames the counts, edits, picks and HQ\'s name back');
  return out;
}

let failed = 0;
const text = F.source(null, FILE);
const main = problems(text);
if (main.length) { failed++; console.log('FAIL  ' + main.join('\n      ')); }
else console.log('PASS  vendor rename: one rename step, items, lists and pick rows follow in place, the label, Undo exact, capitals, refusals, ' +
                 STORES + ' random stores where only the name changes, and through the fake Supabase (counts, edits, day picks, presence, HQ\'s name)');

const CONTROLS = [
  { name: 'the items\' vendor lists keep the old name',
    find: "      if ((it.eligible || []).indexOf(from) >= 0) it.eligible = it.eligible.map(x => (x === from ? to : x));\n    }\n    for (const r of t.pickRows) if (r.vendor === from) r.vendor = to;",
    replace: "    }\n    for (const r of t.pickRows) if (r.vendor === from) r.vendor = to;" },
  { name: 'the rename is a delete and an add',
    find: "      if (renames) renames.push({ rename: 'vendors', from: renamedFrom, to: to });",
    replace: "      renames;" },
  { name: 'a name another vendor has is taken',
    find: "      if (taken) throw new Error('\"' + s_(taken.name) + '\" is already a vendor here. Pick another name: two vendors can\\'t be merged by renaming one.');",
    replace: "      taken;" },
  { name: 'applyOps renames an area\'s rows for a vendor',
    find: "        (kind === 'vendors' ? renameVendor : renameArea)(t, op.from, op.to);",
    replace: "        renameArea(t, op.from, op.to);" },
  { name: 'diff treats a vendor rename as an area one',
    find: "    for (const r of renames) (r.rename === 'vendors' ? renameVendor : renameArea)(b, r.from, r.to);",
    replace: "    for (const r of renames) renameArea(b, r.from, r.to);" }
];
for (const c of CONTROLS) {
  let res;
  try { res = problems(F.plant(text, c.find, c.replace)); }
  catch (e) { failed++; console.log(`FAIL  control "${c.name}" crashed instead of biting: ${e.message}`); continue; }
  if (res.length) console.log(`PASS  control "${c.name}" bites (${res[0].slice(0, 110)})`);
  else { failed++; console.log(`FAIL  control "${c.name}" did NOT bite`); }
}

console.log(failed ? `vendor_rename: ${failed} FAILED` : 'vendor_rename: ALL PASS');
process.exit(failed ? 1 : 0);
