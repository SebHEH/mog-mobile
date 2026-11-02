'use strict';
// GATE: LTOs (supabase/schema_v14.sql, hq/): catalogEdit.js's commitHqRollout
// with an LTO, commitHqLto (end, rollback, standard), ltoStoreState and the
// item's lto in getAllItemsForView, run against the fake Supabase
// (fake_supabase.js mirrors v14; the SQL is pinned in Postgres by
// supabase/tests/smoke_v14.sql). Checks:
//   - sending: new items carry the LTO; an item the store already had gains
//     only the vendors (no link), and that is recorded with its id
//   - a KM's own save keeps the link; a row read without it is a CONFLICT
//   - where it stands at a store: set up, needs setup, inactive
//   - end: only the LTO's items made inactive, par kept; Undo exact
//   - rollback: the LTO's items deleted (set up or not), the backups it added
//     taken off, a vendor it added removed only when no item names it; the
//     store back exactly as before it was sent
//   - standard: only the link goes
//   - an item number reused by the store's own new item never joins the LTO
//   - the Items page's rows: lto only when the item has one
//   - the Items page's "new from LTOs" group (ltoWaiting): running LTOs only,
//     newest first, items still missing a par or a storage area
//   - on random stores: nothing outside the LTO changes
//   - through the fake: send to two stores (one record, a change each, the
//     stores read their LTO), a KM sets one up, roll back, the store undoes
//     the roll back; another concept refused; a stale version a CONFLICT
// Each has a planted-defect control.
//
// Run bare: node tests/lto.test.js
// A passing run ends with "lto: ALL PASS".

const vm = require('vm');
const F = require('./fake_apps_script.js');
const { FakeSupabase, checkCatalogTables } = require('./fake_supabase.js');

const SRC = file => F.source(null, file);
const FILE = 'template/editor/catalogEdit.js';
const clone = x => JSON.parse(JSON.stringify(x));
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const STORES = Number(process.argv[2]) || 200;
const L1 = 'lto_test0001fallpho', L2 = 'lto_test0002basil';

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

function storeTables(v) {
  return checkCatalogTables({
    vendors: v.map(n => ({ name: n, mults: [1, 0, 0, 1, 0, 0, 0], cutoff: null })),
    areas: [{ name: 'Walk-in', ord: 10 }, { name: 'Dry Storage', ord: 20 }],
    items: [
      { id: 'ITEM-0007', name: 'Lime', primaryVendor: v[0], pack: 'CS', par: 3, active: true, useMult: true, notes: '', sku: '', category: '', eligible: [v[0]], seq: 2 },
      { id: 'ITEM-0012', name: 'Mango Puree', primaryVendor: v[0], pack: 'CS', par: 2, active: true, useMult: true, notes: '', sku: '', category: '', eligible: [v[0]], seq: 5 },
      { id: 'ITEM-0013', name: 'Old Sauce', primaryVendor: v[0], pack: 'EA', par: 1, active: false, useMult: true, notes: '', sku: '', category: '', eligible: [v[0]], seq: 6 },
      { id: 'X-1', name: 'Gloves', primaryVendor: v[1], pack: 'BOX', par: 2, active: true, useMult: false, notes: '', sku: '', category: '', eligible: [v[1], v[0]], seq: 7 }
    ],
    pickRows: [
      { vendor: v[0], id: 'ITEM-0007', area: 'Walk-in', shelfOrder: 10, seq: 2 },
      { vendor: v[0], id: 'ITEM-0012', area: 'Walk-in', shelfOrder: 20, seq: 3 },
      { vendor: v[1], id: 'X-1', area: 'Dry Storage', shelfOrder: 10, seq: 4 },
      { vendor: v[0], id: 'X-1', area: 'Dry Storage', shelfOrder: 20, seq: 5 }
    ]
  });
}
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

const SEND = {
  label: 'Fall Chicken Pho', lto: L1,
  vendors: [{ name: 'Happy Supply', mults: [0, 3, 0, 0, 4, 0, 0], cutoff: '' }],
  items: [
    { name: 'Chicken Breast', pack: 'CASE (40LBs)', notes: '', vendor: 'Happy Supply', backups: ['Sysco'] },
    { name: 'Pho Spice', pack: 'BAG', notes: '', vendor: 'B&T Distributions', backups: [] },
    { name: 'mango puree', pack: '', notes: '', vendor: 'Happy Supply', backups: [] }
  ]
};

function problems(text) {
  const out = [];
  const bad = (what, detail) => { if (out.length < 30) out.push(what + (detail ? ': ' + detail : '')); };
  const refused = fn => { try { fn(); return ''; } catch (e) { return e.message || String(e); } };
  const rules = (tb, what) => { try { checkCatalogTables(clone(tb)); } catch (e) { bad(what + ' rules', e.message); } };
  let CE;
  try { CE = loadCE(text); } catch (e) { return ['catalogEdit.js did not load: ' + e.message]; }
  if (CE.writes.indexOf('commitHqLto') < 0 || typeof CE.ltoStoreState !== 'function') return ['the LTO calls are not registered'];
  const run = (tb, fn, args) => { const c = CE.call(tb, fn, args); return { c, a: CE.applyOps(tb, c.ops) }; };
  const itemOf = (tb, nm) => tb.items.find(x => x.name.toLowerCase() === nm.toLowerCase());

  // ---- Sending ----
  const t = storeTables(['Sysco', 'B&T Distributions']);
  let s0;
  try { s0 = run(t, 'commitHqRollout', [SEND]); } catch (e) { return out.concat(['send threw: ' + e.message]); }
  const sent = s0.a;
  rules(sent, 'send');
  const chicken = itemOf(sent, 'Chicken Breast'), spice = itemOf(sent, 'Pho Spice'), mango = itemOf(sent, 'Mango Puree');
  if (!chicken || chicken.lto !== L1 || chicken.id !== 'ITEM-0014' || !spice || spice.lto !== L1) bad('new items carry the LTO', JSON.stringify([chicken, spice]));
  if ('lto' in mango || sent.items.some(it => it !== chicken && it !== spice && 'lto' in it)) bad('an item the store already had was linked', JSON.stringify(mango));
  if (!same(s0.c.result.backupsAdded, [{ id: 'ITEM-0012', name: 'Mango Puree', vendors: ['Happy Supply'] }])) bad('backups recorded with the item id', JSON.stringify(s0.c.result.backupsAdded));
  if (!same(s0.c.result.vendorsAdded, ['Happy Supply'])) bad('vendors recorded', JSON.stringify(s0.c.result.vendorsAdded));
  const record = { vendorsAdded: s0.c.result.vendorsAdded, backupsAdded: s0.c.result.backupsAdded };

  // ---- A KM sets the chicken up; its own save keeps the link ----
  let km;
  try {
    km = run(sent, 'commitUpsertItem', [{ mode: 'edit', lookup: chicken.id, name: 'Chicken Breast', vendor: 'Happy Supply', pack: 'CASE (40LBs)',
                                          par: 4, useMult: true, active: true, areaName: 'Walk-in' }]);
  } catch (e) { return out.concat(['the KM\'s save threw: ' + e.message]); }
  const setUp = km.a;
  if (itemOf(setUp, 'Chicken Breast').lto !== L1 || itemOf(setUp, 'Chicken Breast').par !== 4) bad('a KM\'s save dropped the link', JSON.stringify(itemOf(setUp, 'Chicken Breast')));
  const row = clone(itemOf(setUp, 'Chicken Breast'));
  const unlinked = Object.assign({}, row); delete unlinked.lto;
  if (!/CONFLICT/.test(refused(() => CE.applyOps(setUp, [{ t: 'items', key: row.id, before: unlinked, after: Object.assign({}, unlinked, { par: 5 }) }])))) {
    bad('a row read without its LTO was taken (the link is not compared)');
  }

  // ---- Where it stands ----
  const st = CE.ltoStoreState(setUp, L1);
  if (!same(st.items.map(x => x.name + ':' + x.state), ['Chicken Breast:ready', 'Pho Spice:setup']) || st.ready !== 1 || st.setup !== 1 ||
      st.items[0].area !== 'Walk-in' || st.items[0].par !== 4) bad('ltoStoreState', JSON.stringify(st));
  const parOnly = run(setUp, 'commitUpsertItem', [{ mode: 'edit', lookup: spice.id, name: 'Pho Spice', vendor: 'B&T Distributions', pack: 'BAG',
                                                     par: 2, useMult: true, active: true }]).a;
  if (CE.ltoStoreState(parOnly, L1).items[1].state !== 'setup') bad('ltoStoreState: a par with no storage area is not set up', JSON.stringify(CE.ltoStoreState(parOnly, L1)));

  // ---- End ----
  const e1 = run(setUp, 'commitHqLto', [{ action: 'end', lto: L1, name: 'Fall Chicken Pho' }]);
  rules(e1.a, 'end');
  if (itemOf(e1.a, 'Chicken Breast').active || itemOf(e1.a, 'Pho Spice').active || itemOf(e1.a, 'Chicken Breast').par !== 4) bad('end: the LTO\'s items inactive, par kept');
  if (e1.a.pickRows.some(r => r.id === chicken.id)) bad('end: an inactive item stayed on a count list');
  for (const nm of ['Lime', 'Mango Puree', 'Old Sauce', 'Gloves']) {
    const rows = tb => JSON.stringify(tb.pickRows.filter(r => r.id === itemOf(tb, nm).id));
    if (!same(itemOf(e1.a, nm), itemOf(setUp, nm)) || rows(e1.a) !== rows(setUp)) bad('end touched the store\'s own item', nm);
  }
  if (e1.c.label !== 'HQ ended LTO "Fall Chicken Pho": made 2 items inactive (Chicken Breast, Pho Spice)') bad('end label', e1.c.label);
  if (!same(CE.applyOps(e1.a, CE.inverseOps(e1.c.ops)), setUp)) bad('end: undo did not restore the store');
  if (CE.ltoStoreState(e1.a, L1).inactive !== 2) bad('ltoStoreState after end', JSON.stringify(CE.ltoStoreState(e1.a, L1)));

  // ---- Roll back: the store as before it was sent ----
  const r1 = run(setUp, 'commitHqLto', [Object.assign({ action: 'rollback', lto: L1, name: 'Fall Chicken Pho' }, record)]);
  rules(r1.a, 'rollback');
  if (!same(r1.a, t)) bad('rollback: the store is not as it was before the LTO', JSON.stringify(r1.a).slice(0, 200));
  if (r1.c.label !== 'HQ rolled back LTO "Fall Chicken Pho": deleted 2 items (Chicken Breast, Pho Spice); Mango Puree no longer from Happy Supply; removed vendor Happy Supply') bad('rollback label', r1.c.label);
  if (!same(CE.applyOps(r1.a, CE.inverseOps(r1.c.ops)), setUp)) bad('rollback: undo did not restore the store');
  // A KM gave one of the store's own items the LTO's new vendor: it stays.
  const used = run(setUp, 'commitSetItemsVendor', [['ITEM-0007'], 'Happy Supply', true]).a;
  const r2 = run(used, 'commitHqLto', [Object.assign({ action: 'rollback', lto: L1, name: 'Fall Chicken Pho' }, record)]);
  if (!r2.a.vendors.some(v => v.name === 'Happy Supply') || !itemOf(r2.a, 'Lime').eligible.includes('Happy Supply')) bad('rollback removed a vendor the store uses');

  // ---- Standard: only the link goes ----
  const d1 = run(setUp, 'commitHqLto', [{ action: 'standard', lto: L1, name: 'Fall Chicken Pho' }]);
  const unlink = tb => Object.assign(clone(tb), { items: tb.items.map(it => { const c = clone(it); delete c.lto; return c; }) });
  if (!same(d1.a, unlink(setUp)) || d1.a.items.some(it => 'lto' in it)) bad('standard changed more than the link');
  if (d1.c.label !== 'HQ made LTO "Fall Chicken Pho" standard: 2 items (Chicken Breast, Pho Spice)') bad('standard label', d1.c.label);

  // ---- A reused item number never joins the LTO ----
  const gone = run(setUp, 'commitDeleteItem', [spice.id]).a;
  const gone2 = run(gone, 'commitDeleteItem', [chicken.id]).a;
  const napkins = run(gone2, 'commitUpsertItem', [{ mode: 'add', name: 'Napkins', vendor: 'Sysco', pack: 'CS', par: 2, useMult: true, active: true }]);
  const nap = itemOf(napkins.a, 'Napkins');
  if (nap.id !== chicken.id || 'lto' in nap) bad('the store\'s new item (same number) carries the LTO', JSON.stringify(nap));
  const e2 = run(napkins.a, 'commitHqLto', [{ action: 'end', lto: L1, name: 'Fall Chicken Pho' }]);
  if (!itemOf(e2.a, 'Napkins').active || e2.c.ops.length) bad('end reached the store\'s own item with a reused number');

  // ---- The Items page's rows ----
  const view = CE.call(Object.assign(clone(setUp), { ltos: [{ id: L1, name: 'Fall Chicken Pho', sentAt: '2026-11-02T18:36:00Z', status: 'running' }] }),
                       'getAllItemsForView', []).result;
  const vc = view.find(x => x.name === 'Chicken Breast'), vl = view.find(x => x.name === 'Lime');
  if (!vc.lto || vc.lto.id !== L1 || vc.lto.name !== 'Fall Chicken Pho' || vc.lto.status !== 'running') bad('Items row: the LTO', JSON.stringify(vc));
  if (Object.keys(vl).join() !== 'id,name,vendor,eligibleVendors,pack,par,active,useMult,hasArea,storageArea') bad('Items row without an LTO changed shape', Object.keys(vl).join());

  // ---- The Items page's "new from LTOs" group (ltoWaiting) ----
  if (typeof CE.ltoWaiting !== 'function') bad('ltoWaiting is not exported');
  else {
    const fromView = CE.ltoWaiting(view);
    if (!same(fromView.map(g => g.id + ':' + g.items.map(x => x.name).join(',')), [L1 + ':Pho Spice'])) bad('ltoWaiting from the Items rows', JSON.stringify(fromView));
    const lt = (id, status, sentAt) => ({ id, name: id, status, sentAt });
    const older = lt(L1, 'running', '2026-11-02T18:36:00Z'), newer = lt(L2, 'running', '2026-11-03T15:00:00Z');
    const rows = [
      { id: 'A', name: 'Pho Spice', active: true, par: '', hasArea: false, lto: older },
      { id: 'B', name: 'Chicken Breast', active: true, par: 4, hasArea: true, lto: older },
      { id: 'C', name: 'Basil', active: true, par: 2, hasArea: false, lto: newer },
      { id: 'D', name: 'Anise', active: true, par: '', hasArea: true, lto: newer },
      { id: 'E', name: 'Old Leaf', active: false, par: '', hasArea: false, lto: newer },
      { id: 'F', name: 'Mint', active: true, par: '', hasArea: false, lto: lt('lto_ended', 'ended', '2026-11-04T10:00:00Z') },
      { id: 'G', name: 'Lime', active: true, par: '', hasArea: false }
    ];
    const got = CE.ltoWaiting(rows).map(g => g.id + ':' + g.items.map(x => x.id).join(','));
    if (!same(got, [L2 + ':D,C', L1 + ':A'])) bad('ltoWaiting: running LTOs, newest first, items missing a par or an area, A to Z', JSON.stringify(got));
    if (CE.ltoWaiting([rows[1], rows[6]]).length) bad('ltoWaiting listed an LTO with nothing to set up');
  }

  // ---- Refusals ----
  if (!/Which LTO/.test(refused(() => CE.call(setUp, 'commitHqLto', [{ action: 'end' }])))) bad('an end with no LTO was taken');
  if (!/ended, rolled back or made standard/.test(refused(() => CE.call(setUp, 'commitHqLto', [{ action: 'pause', lto: L1 }])))) bad('an unknown action was taken');

  // ---- Random stores: nothing outside the LTO changes ----
  for (let seed = 1; seed <= STORES; seed++) {
    const rnd = rng(seed), rt = randomTables(rnd);
    const vend = rt.vendors.map(v => v.name);
    const want = [];
    for (let i = 0, n = 1 + Math.floor(rnd() * 4); i < n; i++) {
      const existing = rnd() < 0.4 ? pick(rnd, rt.items) : null;
      want.push({ name: existing ? existing.name : 'LTO ' + seed + '-' + i, pack: 'CS', notes: '', vendor: pick(rnd, vend), backups: vend.filter(() => rnd() < 0.3) });
    }
    const extra = rnd() < 0.5 ? [{ name: 'Brand New ' + seed, mults: [1, 0, 0, 0, 0, 0, 0], cutoff: '' }] : [];
    if (extra.length && rnd() < 0.7) want.push({ name: 'From new ' + seed, pack: '', notes: '', vendor: extra[0].name, backups: [] });
    let sc;
    try { sc = run(rt, 'commitHqRollout', [{ label: 'R' + seed, lto: L2, vendors: extra, items: want }]); } catch (e) { bad('random send threw', 'seed ' + seed + ': ' + e.message); continue; }
    let base = sc.a;
    const linked = base.items.filter(it => it.lto === L2);
    if (linked.length && rnd() < 0.4) base = run(base, 'commitDeleteItem', [pick(rnd, linked).id]).a;
    if (rnd() < 0.5) base = run(base, 'commitUpsertItem', [{ mode: 'add', name: 'Own ' + seed, vendor: vend[0], pack: 'CS', par: 1, useMult: true, active: true }]).a;
    const act = pick(rnd, ['end', 'rollback', 'standard']);
    let rc;
    try { rc = run(base, 'commitHqLto', [{ action: act, lto: L2, name: 'R', vendorsAdded: sc.c.result.vendorsAdded, backupsAdded: sc.c.result.backupsAdded }]); }
    catch (e) { bad('random ' + act + ' threw', 'seed ' + seed + ': ' + e.message); continue; }
    rules(rc.a, 'random ' + act + ' seed ' + seed);
    const backed = new Set(sc.c.result.backupsAdded.map(b => b.id));
    for (const it of base.items.filter(x => x.lto !== L2)) {
      const now = rc.a.items.find(x => x.id === it.id);
      const rows = tb => JSON.stringify(tb.pickRows.filter(r => r.id === it.id));
      if (act === 'rollback' && backed.has(it.id)) {
        if (!now || now.primaryVendor !== it.primaryVendor || now.par !== it.par || now.active !== it.active) { bad('random rollback: the store\'s own item lost more than the LTO\'s backups', 'seed ' + seed + ' ' + it.id); break; }
      } else if (!same(now, it) || rows(rc.a) !== rows(base)) { bad('random ' + act + ': an item outside the LTO changed', 'seed ' + seed + ' ' + it.id); break; }
    }
    if (act === 'rollback' && rc.a.items.some(it => it.lto === L2)) bad('random rollback left an LTO item', 'seed ' + seed);
    if (act === 'end' && rc.a.items.some(it => it.lto === L2 && it.active)) bad('random end left an LTO item active', 'seed ' + seed);
    if (act === 'rollback') {
      for (const v of sc.c.result.vendorsAdded) {
        const usedNow = rc.a.items.some(it => it.primaryVendor === v || it.eligible.includes(v));
        if (usedNow !== rc.a.vendors.some(x => x.name === v)) { bad('random rollback: a vendor it added kept or removed wrongly', 'seed ' + seed + ' ' + v); break; }
      }
    }
    if (!same(CE.applyOps(rc.a, CE.inverseOps(rc.c.ops)), base)) bad('random undo', 'seed ' + seed + ' ' + act);
  }

  // ---- Through the fake Supabase ----
  const sb = new FakeSupabase(Date.UTC(2026, 10, 2, 18));
  for (const [slug, concept] of [['zza', 'roll-play'], ['zzb', 'roll-play'], ['zzx', 'teasnyou']]) {
    sb.provision(slug);
    Object.assign(sb.stores.get(slug), { pins: { pin: '4321' }, editorDirect: true, version: 1,
      profile: { location: 'Test ' + slug + ' BOH', abbr: slug, concept }, tables: storeTables(['Sysco', 'B&T Distributions']) });
  }
  const code = sb.hqInvite('Sebastian');
  const tok = sb.handle('mog_hq_claim', { p_name: 'Sebastian', p_code: code, p_passphrase: 'correct horse battery' }).data.token;
  const data0 = sb.handle('mog_hq_data', { p_token: tok }).data;
  if (data0.ltos.length || data0.stores.some(x => x.tables && 'ltos' in x.tables)) bad('fake: an LTO before any was sent');
  const plan = data0.stores.filter(x => x.slug !== 'zzx').map(x => ({ slug: x.slug, call: CE.call(x.tables, 'commitHqRollout', [SEND]) }));
  const sendLto = { action: 'send', id: L1, concept: 'roll-play', name: 'Fall Chicken Pho', items: SEND.items,
                    stores: plan.map(x => ({ slug: x.slug, vendorsAdded: x.call.result.vendorsAdded, backupsAdded: x.call.result.backupsAdded })) };
  const other = sb.handle('mog_hq_apply', { p_token: tok, p_changes: [], p_links: [], p_libraries: null,
                                           p_lto: Object.assign({}, sendLto, { stores: [{ slug: 'zzx' }] }) });
  if (!/^REJECTED: zzx isn't a roll-play store/.test(other.error || '') || sb.hqState().ltos.size) bad('fake: a store of another concept was taken', JSON.stringify(other));
  const res = sb.handle('mog_hq_apply', { p_token: tok, p_changes: plan.map(x => ({ slug: x.slug, label: x.call.label, ops: x.call.ops })),
                                         p_links: [], p_libraries: null, p_lto: sendLto });
  if (!res.ok || !same(res.data.lto, { id: L1, status: 'running', version: 1 })) return out.concat(['fake send: ' + JSON.stringify(res)]);
  const data1 = sb.handle('mog_hq_data', { p_token: tok }).data;
  const rec = data1.ltos[0];
  if (!rec || rec.name !== 'Fall Chicken Pho' || rec.stores.length !== 2 ||
      !rec.stores.every(x => x.changeId === res.data.changes.find(c => c.slug === x.slug).changeId)) bad('fake: the record and its changes', JSON.stringify(rec));
  const za = data1.stores.find(x => x.slug === 'zza').tables;
  if (!za.ltos || za.ltos[0].name !== 'Fall Chicken Pho' || !itemOf(za, 'Chicken Breast') || itemOf(za, 'Chicken Breast').lto !== L1) bad('fake: the store reads its LTO', JSON.stringify(za.ltos));
  // A KM at zza sets the chicken up, in the store's own editor.
  const ed = sb.handle('mog_editor_login', { p_slug: 'zza', p_pin: '4321' });
  const kmc = CE.call(ed.data.tables, 'commitUpsertItem', [{ mode: 'edit', lookup: itemOf(za, 'Chicken Breast').id, name: 'Chicken Breast',
    vendor: 'Happy Supply', pack: 'CASE (40LBs)', par: 4, useMult: true, active: true, areaName: 'Walk-in' }]);
  if (!sb.handle('mog_editor_apply', { p_token: ed.data.token, p_label: kmc.label, p_by: 'KM', p_ops: kmc.ops }).ok) bad('fake: the KM\'s save');
  const data2 = sb.handle('mog_hq_data', { p_token: tok }).data;
  if (CE.ltoStoreState(data2.stores.find(x => x.slug === 'zza').tables, L1).ready !== 1) bad('fake: HQ sees the KM\'s setup');
  const stale = sb.handle('mog_hq_apply', { p_token: tok, p_changes: [], p_links: [], p_libraries: null, p_lto: { action: 'end', id: L1, version: 0 } });
  if (stale.error !== 'CONFLICT') bad('fake: a stale version was taken', JSON.stringify(stale));
  const back = data2.ltos[0].stores.map(x => {
    const tb = data2.stores.find(y => y.slug === x.slug).tables;
    return { slug: x.slug, call: CE.call(tb, 'commitHqLto', [{ action: 'rollback', lto: L1, name: 'Fall Chicken Pho', vendorsAdded: x.vendorsAdded, backupsAdded: x.backupsAdded }]) };
  });
  const rb = sb.handle('mog_hq_apply', { p_token: tok, p_changes: back.map(x => ({ slug: x.slug, label: x.call.label, ops: x.call.ops })),
                                        p_links: [], p_libraries: null, p_lto: { action: 'rollback', id: L1, version: 1 } });
  if (!rb.ok || rb.data.lto.status !== 'rolledback') bad('fake rollback', JSON.stringify(rb));
  const strip = tb => { const c = clone(tb); delete c.ltos; return c; };
  for (const slug of ['zza', 'zzb']) {
    if (!same(strip(sb.handle('mog_hq_data', { p_token: tok }).data.stores.find(x => x.slug === slug).tables), sb.handle('mog_hq_data', { p_token: tok }).data.stores.find(x => x.slug === 'zzx').tables)) {
      bad('fake: a rolled-back store is not as before', slug);
    }
  }
  const ed2 = sb.handle('mog_editor_login', { p_slug: 'zza', p_pin: '4321' });
  const rbChange = sb.stores.get('zza').changeLog.find(l => /^HQ rolled back/.test(l.label));
  const un = sb.handle('mog_editor_undo', { p_token: ed2.data.token, p_change_id: rbChange.id, p_by: 'GM' });
  const back4 = itemOf(sb.stores.get('zza').tables, 'Chicken Breast');
  if (!un.ok || !back4 || back4.lto !== L1 || back4.par !== 4) bad('fake: the store\'s Undo of the rollback', JSON.stringify([un, back4]));
  return out;
}

let failed = 0;
const text = SRC(FILE);
const main = problems(text);
if (main.length) { failed++; console.log('FAIL  ' + main.join('\n      ')); }
else console.log('PASS  LTOs: send (new items linked, the store\'s own not), a KM\'s save keeps the link, where it stands, end, rollback (as before it was sent), standard, ' +
                 'a reused item number, the Items rows, ' + STORES + ' random stores untouched outside the LTO, and through the fake Supabase');

const CONTROLS = [
  { name: 'the store\'s own items are linked too',
    find: '    if (lto) for (const it of w.items) if (!had.has(it)) it.lto = lto;',
    replace: '    if (lto) for (const it of w.items) it.lto = lto;' },
  { name: 'the link is not compared',
    find: "    items:    ['name', 'primaryVendor', 'pack', 'par', 'active', 'useMult', 'notes', 'sku', 'category', 'eligible', 'lto'],",
    replace: "    items:    ['name', 'primaryVendor', 'pack', 'par', 'active', 'useMult', 'notes', 'sku', 'category', 'eligible']," },
  { name: 'rollback leaves the backups it added',
    find: '        if (setItemsVendor(w, [s_(it.id)], v, false).changed) took.push(s_(v));',
    replace: '        took.length;' },
  { name: 'rollback removes a vendor the store still uses',
    find: '      if (!used) { removeVendor(w, vend.name); vendorsRemoved.push(vend.name); }',
    replace: '      { removeVendor(w, vend.name); vendorsRemoved.push(vend.name); }' },
  { name: 'standard keeps the link',
    find: '      for (const it of mine) delete it.lto;',
    replace: '      for (const it of mine) it.lto = it.lto;' },
  { name: 'an item with no storage area counts as set up',
    find: "      const ready = it.par !== null && it.par !== undefined && it.par !== '' && areaOf.has(s_(it.id));",
    replace: "      const ready = it.par !== null && it.par !== undefined && it.par !== '';" },
  { name: 'an ended LTO\'s items are pinned',
    find: "      if (!l || l.status !== 'running' || r.active !== true || (r.par !== '' && r.hasArea)) continue;",
    replace: "      if (!l || r.active !== true || (r.par !== '' && r.hasArea)) continue;" },
  { name: 'an item with a par but no storage area leaves the pinned group',
    find: "      if (!l || l.status !== 'running' || r.active !== true || (r.par !== '' && r.hasArea)) continue;",
    replace: "      if (!l || l.status !== 'running' || r.active !== true || (r.par !== '' || r.hasArea)) continue;" },
  { name: 'the oldest LTO comes first',
    find: '    return out.sort((a, b) => (a.sentAt < b.sentAt ? 1 : a.sentAt > b.sentAt ? -1 : a.name.localeCompare(b.name)));',
    replace: '    return out.sort((a, b) => (a.sentAt < b.sentAt ? -1 : a.sentAt > b.sentAt ? 1 : a.name.localeCompare(b.name)));' },
  { name: 'every Items row gets an lto',
    find: '      if (s_(it.lto)) {\n        const l = ltos.get(s_(it.lto)) || {};',
    replace: '      if (true) {\n        const l = ltos.get(s_(it.lto)) || {};' }
];
for (const c of CONTROLS) {
  let res;
  try { res = problems(F.plant(text, c.find, c.replace)); }
  catch (e) { failed++; console.log(`FAIL  control "${c.name}" crashed instead of biting: ${e.message}`); continue; }
  if (res.length) console.log(`PASS  control "${c.name}" bites (${res[0].slice(0, 110)})`);
  else { failed++; console.log(`FAIL  control "${c.name}" did NOT bite`); }
}

console.log(failed ? `lto: ${failed} FAILED` : 'lto: ALL PASS');
process.exit(failed ? 1 : 0);
