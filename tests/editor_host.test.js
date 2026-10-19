'use strict';
// GATE: the editor's static host (template/editor/host.js), which lets the
// unchanged ManageItems.html run on Supabase. host.js + catalogEdit.js run in
// a fake browser against a fake Supabase whose editor calls mirror
// supabase/schema_v6.sql, written apart from catalogEdit.js
// (fake_supabase.js; the SQL itself is pinned by supabase/tests/smoke_v6.sql):
//   - sign-in: the PIN gate's editorAuth / editorPing, a store whose editor is
//     still in the Sheet, a token from ANOTHER store refused (every store's
//     editor shares one site's storage), the page's item cache marked stale
//   - tool calls through webedit_call: reads answer from the tables, writes
//     reach Supabase with who made them, and the next read shows them
//   - another editor changing the same row: the save reloads and still lands,
//     keeping the other editor's change
//   - many random saves: the editor's own copy of the tables always equals
//     Supabase's, and the phones' catalog follows; Undo through Supabase
//   - a token in the URL goes to the gate's validate-first path
// Planted-defect controls in host.js must each be caught.
//
// Run bare: node tests/editor_host.test.js   A pass ends "editor_host: ALL PASS".

const vm = require('vm');
const F = require('./fake_apps_script.js');
const { FakeSupabase, checkCatalogTables } = require('./fake_supabase.js');
const { mulberry32 } = require('./mog_fixture.js');

const SRC = file => F.source(null, file);
const CE_FILE = 'template/editor/catalogEdit.js';
const HOST_FILE = 'template/editor/host.js';
const SB_URL = 'https://fake.supabase.co';
const clone = x => JSON.parse(JSON.stringify(x));

function baseTables() {
  return {
    vendors: [{ name: 'Amazon', mults: [1, 0, 0, 0, 0, 0, 0], cutoff: null },
              { name: 'Chef Center', mults: [1, 1, 1, 1, 1, 1, 0], cutoff: '10:00' },
              { name: 'Sysco', mults: [1, 0, 1, 0, 1, 0, 0], cutoff: null }],
    areas: [{ name: 'Walk-in', ord: 10 }, { name: 'Dry Storage', ord: 20 }, { name: 'Freezer', ord: 30 }],
    items: [
      { id: 'ITEM-0001', name: 'Lime', primaryVendor: 'Sysco', pack: 'CS', par: 3, active: true, useMult: true, notes: '', sku: '', category: '', eligible: ['Sysco', 'Chef Center'], seq: 2 },
      { id: 'ITEM-0002', name: 'Tape', primaryVendor: 'Amazon', pack: 'EA', par: 1, active: true, useMult: false, notes: 'Keep dry', sku: '', category: '', eligible: ['Amazon'], seq: 3 },
      { id: 'ITEM-0003', name: 'Tofu', primaryVendor: 'Chef Center', pack: 'CS', par: 2, active: true, useMult: true, notes: '', sku: '', category: '', eligible: ['Chef Center'], seq: 4 },
      { id: 'ITEM-0004', name: 'Nori', primaryVendor: 'Sysco', pack: 'BAG', par: 0.5, active: false, useMult: true, notes: '', sku: '', category: '', eligible: ['Sysco'], seq: 5 },
      { id: 'ITEM-0005', name: 'Rice', primaryVendor: null, pack: 'BAG', par: 4, active: true, useMult: true, notes: '', sku: '', category: '', eligible: [], seq: 6 }
    ],
    pickRows: [
      { vendor: 'Sysco', id: 'ITEM-0001', area: 'Walk-in', shelfOrder: 10, seq: 2 },
      { vendor: 'Chef Center', id: 'ITEM-0001', area: 'Walk-in', shelfOrder: 20, seq: 3 },
      { vendor: 'Amazon', id: 'ITEM-0002', area: 'Dry Storage', shelfOrder: 10, seq: 4 },
      { vendor: 'Chef Center', id: 'ITEM-0003', area: 'Freezer', shelfOrder: 10, seq: 5 }
    ]
  };
}

function makeServer() {
  const sb = new FakeSupabase(Date.UTC(2026, 9, 18, 15));
  for (const [slug, direct] of [['zzedit', true], ['zzother', true], ['zzsheet', false]]) {
    sb.provision(slug);
    const s = sb.stores.get(slug);
    s.pins = { pin: '4321' };
    s.editorDirect = direct;
    s.profile = { timeZone: 'America/New_York', location: 'Test ' + slug, abbr: slug.toUpperCase(), concept: 'roll-play' };
    s.tables = checkCatalogTables(baseTables());
    s.version = 1;
    s.catalog = null;
  }
  return sb;
}

// A browser tab with the editor page's two scripts loaded, for one store.
function makeTab(sb, slug, srcOf, opts) {
  const store = new Map((opts && opts.storage) || []);
  const ctx = {
    console, setTimeout, clearTimeout, AbortController, URLSearchParams,
    fetch: sb.fetchFn(),
    localStorage: { getItem: k => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: k => store.delete(k) },
    location: { search: (opts && opts.search) || '', hash: '', href: '', reload() {} },
    document: { body: null, head: null, getElementById: () => null }
  };
  ctx.window = ctx;
  ctx.MOG_SUPABASE = { url: SB_URL, key: 'pub', slug };
  vm.createContext(ctx);
  vm.runInContext(srcOf(CE_FILE), ctx, { filename: CE_FILE });
  vm.runInContext(srcOf(HOST_FILE), ctx, { filename: HOST_FILE });
  const run = (name, ...args) => new Promise((resolve, reject) =>
    ctx.google.script.run.withSuccessHandler(resolve).withFailureHandler(reject)[name](...args));
  const tool = async (token, fn, ...args) => (await run('webedit_call', token, fn, args, { envelope: 1 })).result;
  return { ctx, store, run, tool, H: () => ctx.__MOG_EDITOR_HOST__.state };
}

// What both sides hold, in one shape (Supabase's own ordering).
const norm = t => JSON.stringify(clone(t), (k, v) => (v === undefined ? null : v));
function sameTables(sbTables, hostTables) {
  const sort = t => {
    const c = clone(t);
    c.vendors.sort((a, b) => a.name.localeCompare(b.name));
    c.areas.sort((a, b) => (a.ord - b.ord) || (a.name < b.name ? -1 : 1));
    c.items.sort((a, b) => (a.seq - b.seq) || (a.id < b.id ? -1 : 1));
    c.pickRows.sort((a, b) => (a.seq - b.seq) || (a.vendor < b.vendor ? -1 : a.vendor > b.vendor ? 1 : 0) || (a.id < b.id ? -1 : 1));
    return norm(c);
  };
  return sort(checkCatalogTables(sbTables)) === sort(checkCatalogTables(hostTables));
}

async function runSuite(srcOf) {
  const failures = [];
  const stats = { writes: 0, logged: 0, conflicts: 0, undos: 0, reviews: 0 };
  const fail = (scenario, what) => failures.push('[' + scenario + '] ' + what);
  const sb = makeServer();
  const s = sb.stores.get('zzedit');

  // ---- Sign-in ----
  const tab = makeTab(sb, 'zzedit', srcOf, { storage: [['mog_name_zzedit', 'Maria']] });
  let r = await tab.run('editorAuth', '0000');
  if (r.ok) fail('sign-in', 'a wrong PIN signed in');
  r = await tab.run('editorAuth', '4321');
  if (!r.ok || !r.token) fail('sign-in', 'the right PIN did not sign in: ' + JSON.stringify(r));
  const token = r.token;
  if (JSON.stringify(tab.ctx.VENDOR_LIST) !== '["Amazon","Chef Center","Sysco"]') fail('sign-in', 'VENDOR_LIST is ' + JSON.stringify(tab.ctx.VENDOR_LIST));
  if (!tab.store.get('mog_lastMutationTs')) fail('sign-in', 'the page\'s item cache was not marked stale');
  if (!(await tab.run('editorPing', token)).ok) fail('sign-in', 'its own token does not ping');
  if ((await tab.run('editorPing', 'bogus')).ok) fail('sign-in', 'a bogus token pinged');

  const sheetTab = makeTab(sb, 'zzsheet', srcOf);
  if ((await sheetTab.run('editorAuth', '4321')).ok) fail('sign-in', 'a store whose editor is in the Sheet signed in');

  // A token from another store: the server would serve THAT store, so the page must refuse it.
  const other = makeTab(sb, 'zzother', srcOf);
  const otherTok = (await other.run('editorAuth', '4321')).token;
  const tab2 = makeTab(sb, 'zzedit', srcOf);
  if ((await tab2.run('editorPing', otherTok)).ok) fail('stores', 'zzedit\'s editor accepted zzother\'s token');
  let leaked = null;
  try { leaked = await tab2.tool(otherTok, 'getManageItemsBootstrap'); } catch (e) { leaked = null; }
  if (leaked) fail('stores', 'zzedit\'s editor served data under zzother\'s token');

  // ---- Reads and a write ----
  const boot = await tab.tool(token, 'getManageItemsBootstrap');
  if (!boot || boot.items.length !== 5 || boot.areas.length !== 3) fail('tools', 'bootstrap: ' + JSON.stringify(boot).slice(0, 120));
  const before = s.version;
  const res = await tab.tool(token, 'commitUpsertItem', { mode: 'edit', lookup: 'ITEM-0001', name: 'Lime', vendor: 'Sysco', pack: 'CS', par: 5,
    active: 'true', useMult: 'true', eligibleVendors: ['Sysco', 'Chef Center'], areaName: '' });
  if (!res || !res.ok || res.id !== 'ITEM-0001') fail('tools', 'edit answer: ' + JSON.stringify(res));
  if (s.tables.items.find(i => i.id === 'ITEM-0001').par !== 5) fail('tools', 'the edit did not reach Supabase');
  const entry = (s.changeLog || []).slice(-1)[0];
  if (!entry || entry.by !== 'Maria' || !/^Edited "Lime": par 3 → 5/.test(entry.label)) fail('tools', 'change log: ' + JSON.stringify(entry));
  if (!(s.version > before) || s.catalog.items['ITEM-0001'].par !== 5) fail('tools', 'the phones\' catalog was not rebuilt');
  const after = await tab.tool(token, 'getManageItemsBootstrap');
  if (after.items.find(i => i.id === 'ITEM-0001').par !== 5) fail('tools', 'the next read still shows the old par');
  let refused = '';
  try { await tab.tool('bogus', 'getManageItemsBootstrap'); } catch (e) { refused = e.message; }
  if (refused !== 'SESSION_EXPIRED') fail('tools', 'a bad token answered: ' + refused);
  refused = '';
  try { await tab.tool(token, 'commitSelectiveReset', {}); } catch (e) { refused = e.message; }
  if (!/not allowed/.test(refused)) fail('tools', 'an unlisted call answered: ' + refused);

  // ---- Another editor changed the same row ----
  const other2 = makeTab(sb, 'zzedit', srcOf, { storage: [['mog_name_zzedit', 'Luis']] });
  const tok2 = (await other2.run('editorAuth', '4321')).token;
  await other2.tool(tok2, 'commitUpsertItem', { mode: 'edit', lookup: 'ITEM-0003', name: 'Tofu', vendor: 'Chef Center', pack: 'CS', par: 2,
    active: 'true', useMult: 'true', notes: 'Firm only', areaName: '' });
  let conflictOk = null;
  try {
    conflictOk = await tab.tool(token, 'commitUpsertItem', { mode: 'edit', lookup: 'ITEM-0003', name: 'Tofu', vendor: 'Chef Center', pack: 'CS', par: 6,
      active: 'true', useMult: 'true', areaName: '' });
  } catch (e) { fail('conflict', 'the save failed: ' + e.message); }
  const tofu = s.tables.items.find(i => i.id === 'ITEM-0003');
  if (conflictOk && (tofu.par !== 6 || tofu.notes !== 'Firm only')) fail('conflict', 'after the retry: ' + JSON.stringify(tofu));
  else if (conflictOk) stats.conflicts++;
  if (!sameTables(s.tables, tab.H().tables)) fail('conflict', 'the editor\'s copy differs from Supabase after the retry');

  // ---- Needs review: phones' one-day edits, applied or dismissed (schema v7) ----
  s.quickEdits = [
    { qid: 901, at: 'fake', cycle: '2026-10-18', by: 'Maria', active: true, review: 'open', kind: 'par_today', vendor: 'Amazon', id: 'ITEM-0002', parBefore: 1, parAfter: 4 },
    { qid: 902, at: 'fake', cycle: '2026-10-18', by: 'Luis', active: true, review: 'open', kind: 'add_today', vendor: 'Sysco', id: 'ITEM-0003', parBefore: null, parAfter: null },
    { qid: 903, at: 'fake', cycle: '2026-10-18', by: 'Maria', active: true, review: 'open', kind: 'par_today', vendor: 'Sysco', id: 'ITEM-0001', parBefore: 5, parAfter: 8 }
  ];
  const rtab = makeTab(sb, 'zzedit', srcOf);
  const rtok = (await rtab.run('editorAuth', '4321')).token;
  const host = rtab.ctx.__MOG_EDITOR_HOST__;
  if (rtab.H().reviews.length !== 3) fail('review', 'reviews listed: ' + JSON.stringify(rtab.H().reviews));
  const logged = (s.changeLog || []).length;
  await host.doReview(rtab.H().reviews.find(r => r.id === 901), 'applied');
  if (s.tables.items.find(i => i.id === 'ITEM-0002').par !== 4) fail('review', 'apply did not set the par');
  if (s.quickEdits[0].review !== 'applied') fail('review', 'the applied par still waits for review');
  if (!((s.changeLog || []).length === logged + 1 && /^Applied a phone change: par of "Tape" 1 → 4/.test(s.changeLog[s.changeLog.length - 1].label))) {
    fail('review', 'apply was not logged: ' + JSON.stringify((s.changeLog || []).slice(-1)));
  }
  await rtab.run('editorPing', rtok);   // what the reload after Apply does
  await host.doReview(rtab.H().reviews.find(r => r.id === 902), 'applied');
  const tofuRow = s.tables.pickRows.find(p => p.vendor === 'Sysco' && p.id === 'ITEM-0003');
  if (!tofuRow || tofuRow.area !== 'Freezer') fail('review', 'apply did not put Tofu on the Sysco list in its area: ' + JSON.stringify(tofuRow));
  if (s.tables.items.find(i => i.id === 'ITEM-0003').eligible.indexOf('Sysco') < 0) fail('review', 'Sysco is not an eligible vendor of Tofu');
  await rtab.run('editorPing', rtok);
  const before3 = s.tables.items.find(i => i.id === 'ITEM-0001').par;
  await host.doReview(rtab.H().reviews.find(r => r.id === 903), 'dismissed');
  if (s.quickEdits[2].review !== 'dismissed' || s.tables.items.find(i => i.id === 'ITEM-0001').par !== before3) fail('review', 'dismiss changed the catalog or kept the flag');
  if (rtab.H().reviews.length !== 0) fail('review', 'the panel still lists ' + rtab.H().reviews.length);
  stats.reviews = s.quickEdits.filter(e => e.review !== 'open').length;
  await tab.run('editorPing', token);   // the main tab picks up the applied changes

  // ---- Random saves: the copy never drifts from Supabase ----
  const rnd = mulberry32(4242);
  const pick = list => list[Math.floor(rnd() * list.length)];
  for (let i = 0; i < 120; i++) {
    const t = tab.H().tables;
    const item = pick(t.items);
    const vendors = t.vendors.map(v => v.name);
    const k = rnd();
    let call;
    if (k < 0.3) call = ['commitUpsertItem', { mode: 'edit', lookup: item.id, name: item.name, vendor: item.primaryVendor || pick(vendors), pack: item.pack,
      par: pick([1, 2, 3, 0.5, 6]), active: rnd() < 0.85 ? 'true' : 'false', useMult: 'true',
      eligibleVendors: vendors.filter(() => rnd() < 0.5), areaName: rnd() < 0.5 ? pick(t.areas).name : '' }];
    else if (k < 0.45) call = ['commitUpsertItem', { mode: 'add', name: 'New ' + i, vendor: pick(vendors), pack: 'EA', par: 1, active: 'true', useMult: 'true',
      eligibleVendors: [], areaName: rnd() < 0.7 ? pick(t.areas).name : '' }];
    else if (k < 0.6) call = ['commitSwitchActiveVendor', item.id, pick(item.eligible.length ? item.eligible : vendors)];
    else if (k < 0.75) call = ['commitSetVendorItems', pick(vendors), t.items.filter(() => rnd() < 0.3).map(x => x.id)];
    else if (k < 0.85 && t.items.length > 3) call = ['commitDeleteItem', item.id];
    else call = ['getItemForEdit', item.id];
    try { await tab.tool(token, ...call); } catch (e) { /* the same refusals as Items.gs; catalog_edit checks those */ }
    stats.writes++;
    if (!sameTables(s.tables, tab.H().tables)) { fail('random', 'step ' + i + ' ' + call[0] + ': the editor\'s copy differs from Supabase'); break; }
    if (JSON.stringify(s.catalog) !== JSON.stringify(require('./fake_supabase.js').catalogFromTables(s))) { fail('random', 'the phones\' catalog is behind'); break; }
  }

  stats.logged = (s.changeLog || []).length;

  // ---- Undo through Supabase ----
  const last = s.changeLog[s.changeLog.length - 1];
  const tablesBefore = clone(s.tables);
  const u = sb.handle('mog_editor_undo', { p_token: token, p_change_id: last.id, p_by: 'Maria' });
  if (!u.ok) fail('undo', 'refused: ' + JSON.stringify(u));
  else {
    stats.undos++;
    const redo = sb.handle('mog_editor_undo', { p_token: token, p_change_id: u.data.changeId, p_by: 'Maria' });
    if (!redo.ok || !sameTables(s.tables, tablesBefore)) fail('undo', 'undoing the undo does not give the change back');
  }

  // ---- A token in the URL goes to the validate-first path ----
  const urlTab = makeTab(sb, 'zzedit', srcOf, { search: '?t=' + token });
  const loc = await new Promise(resolve => urlTab.ctx.google.script.url.getLocation(resolve));
  if (loc.parameter.t) fail('url', 'the URL token was handed to the optimistic path');
  if (urlTab.store.get('mog_edit_token') !== token) fail('url', 'the URL token was not kept for the validate-first check');

  return { failures, stats };
}

const CONTROLS = [
  { name: 'a token from another store is accepted', scenario: 'stores',
    find: '    if (!data || !data.store || data.store.slug !== cfg.slug) return false;', replace: '    if (!data) return false;' },
  { name: 'a save someone else beat to the row is not retried', scenario: 'conflict',
    find: "      if (r.error === 'CONFLICT' && pass === 0) { await refresh(); continue; }", replace: '' },
  { name: 'a saved change is not kept in the editor\'s copy', scenario: 'tools',
    find: '        H.tables = CE.applyOps(H.tables, out.ops);', replace: '' },
  { name: 'saves do not say who made them', scenario: 'tools',
    find: "      const r = await rpc('mog_editor_apply', { p_token: H.token, p_label: out.label, p_by: by, p_ops: out.ops });",
    replace: "      const r = await rpc('mog_editor_apply', { p_token: H.token, p_label: out.label, p_by: null, p_ops: out.ops });" },
  { name: 'Apply clears the flag but changes nothing', scenario: 'review',
    find: '        if (plan.ops.length) {', replace: '        if (false) {' },
  { name: 'Apply adds the item to the list but not where it is stored', scenario: 'review',
    find: "    const out = CE.call(H.tables, 'commitSetVendorItems', [r.vendor, onList.concat([r.itemId])]);",
    replace: "    const out = CE.call(H.tables, 'commitSetVendorItems', [r.vendor, onList]);" },
  { name: 'a URL token goes to the optimistic path', scenario: 'url',
    find: '            delete parameter.t;', replace: '' }
];

(async () => {
  let failed = 0;
  const live = await runSuite(SRC);
  const st = live.stats;
  console.log(`editor_host: ${st.writes} random calls, ${st.logged} saves logged, ${st.conflicts} conflict retried, ${st.undos} undone, ${st.reviews} reviews closed`);
  if (live.failures.length) {
    failed++;
    console.log(`FAIL  ${live.failures.length} problem(s):`);
    for (const f of live.failures.slice(0, 10)) console.log('      ' + f);
  } else if (!st.conflicts || !st.undos || st.logged < 40 || st.reviews !== 3) {
    failed++;
    console.log('FAIL  a case was never exercised');
  } else {
    console.log('PASS  the static host signs in, answers, saves, retries and stays equal to Supabase');
  }
  for (const c of CONTROLS) {
    let r;
    try {
      const planted = F.plant(SRC(HOST_FILE), c.find, c.replace);
      r = await runSuite(file => (file === HOST_FILE ? planted : SRC(file)));
    } catch (e) { failed++; console.log(`FAIL  control "${c.name}" crashed: ${e.message}`); continue; }
    const hits = r.failures.filter(f => f.indexOf('[' + c.scenario + ']') === 0).length;
    if (hits) console.log(`PASS  control "${c.name}" bites (${hits} in "${c.scenario}")`);
    else { failed++; console.log(`FAIL  control "${c.name}" did NOT bite "${c.scenario}" (${r.failures.length} other: ${r.failures[0] || '-'})`); }
  }
  console.log(failed ? `editor_host: ${failed} FAILED` : 'editor_host: ALL PASS');
  process.exit(failed ? 1 : 0);
})();
