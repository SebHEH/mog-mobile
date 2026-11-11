'use strict';
// GATE: finishing Manage (2026-11-11; mockup "Manage Items and Vendors
// redesign", boards 7-10). Storage areas and Shelf to Sheet are app-only
// pages (template/editor/Areas.html, ShelfToSheet.html) that save with the
// same catalogEdit.js calls as before (commitStorageAreasDraft,
// commitReorderPickPath, still gated against PickPath.gs in catalog_edit),
// and the Health check is part of the Overview: each warning its own row.
// Checks:
//   - areas: getAreasPage counts each area's active items, its vendors'
//     lists, and the items with no other area (what a delete strands)
//   - shelf: getShelfPage is pickPathForSidebar with packs and LTO names,
//     plus every vendor A to Z with its list size and its items not on it
//   - report: getStoreHealthReport's rows carry count, names, copies,
//     minutes and cycleDate for the Overview's own words
//   - rows: healthRows keeps only the checks that aren't OK, store checks
//     first (close, PIN, phones), each with its link or fix; the setup card
//     takes vendors' days, items' areas and pars; the OK store checks
//     come back for the line under the rows
//   - drafts: the two pages' draft rules (sliced from the pages, as they
//     ship): what each Save sends, a deleted or new area, a name already
//     taken, a move up, down, across areas and off the list; each draft
//     saved through catalogEdit.js reads back as drawn
//   - wiring: build.py publishes the two pages from template/editor/ and no
//     Health check page; no store folder still has one; the app has no
//     Health check entry, sends #healthcheck to the Overview and passes a
//     link's filter (only its own keys) to the page; host.js does the same;
//     Items opens on a link's filter; the Overview uses healthRows
// Each has a planted-defect control.
//
// Run bare: node tests/manage_pages.test.js
// A passing run ends with "manage_pages: ALL PASS".

const vm = require('vm');
const fs = require('fs');
const path = require('path');
const F = require('./fake_apps_script.js');
const { slices, sliceConst } = require('./slice_js.js');

const SRC = file => F.source(null, file);
const ROOT = path.join(__dirname, '..');
const CE_FILE = 'template/editor/catalogEdit.js';
const AREAS = 'template/editor/Areas.html';
const SHELF = 'template/editor/ShelfToSheet.html';
const OVERVIEW = 'template/editor/Overview.html';
const ITEMS = 'template/editor/Items.html';
const HOST = 'template/editor/host.js';
const APP = 'template/index.html';
const BUILD = 'build.py';
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const clone = x => JSON.parse(JSON.stringify(x));

function tables() {
  const it = (id, name, vendor, pack, extra) => Object.assign({ id: id, name: name, primaryVendor: vendor, pack: pack, par: 1, active: true, useMult: true,
    notes: '', sku: '', category: '', eligible: vendor ? [vendor] : [], seq: Number(id.slice(-2)) }, extra || {});
  return {
    vendors: [{ name: 'Sysco', mults: [1, 0, 0, 0, 0, 0, 0], cutoff: null },
              { name: 'Amazon', mults: [1, 0, 0, 0, 0, 0, 0], cutoff: null },
              { name: 'Organic Butcher', mults: [0, 1, 0, 0, 0, 0, 0], cutoff: '10:00' }],
    areas: [{ name: 'Walk-in', ord: 10 }, { name: 'Dry Storage', ord: 20 }, { name: 'Freezer', ord: 30 }, { name: 'Expo', ord: 40 }],
    items: [
      it('ITEM-0001', 'Lime', 'Sysco', 'CS', { eligible: ['Sysco', 'Amazon'] }),
      it('ITEM-0002', 'Tape', 'Amazon', 'EA'),
      it('ITEM-0003', 'Brisket', 'Organic Butcher', 'CASE (65LBs)'),
      it('ITEM-0004', 'Oxtail', 'Organic Butcher', 'LBs'),
      it('ITEM-0005', 'Chicken breast', 'Organic Butcher', 'CASE (40 LBs)', { lto: 'LTO-1', par: null }),
      it('ITEM-0006', 'Nori', 'Sysco', 'BAG', { active: false }),
      it('ITEM-0007', 'Ice', 'Sysco', 'BAG')
    ],
    pickRows: [
      { vendor: 'Sysco', id: 'ITEM-0001', area: 'Walk-in', shelfOrder: 10, seq: 1 },
      { vendor: 'Amazon', id: 'ITEM-0001', area: 'Dry Storage', shelfOrder: 10, seq: 2 },
      { vendor: 'Amazon', id: 'ITEM-0002', area: 'Dry Storage', shelfOrder: 20, seq: 3 },
      { vendor: 'Organic Butcher', id: 'ITEM-0003', area: 'Walk-in', shelfOrder: 20, seq: 4 },
      { vendor: 'Organic Butcher', id: 'ITEM-0004', area: 'Walk-in', shelfOrder: 10, seq: 5 },
      { vendor: 'Sysco', id: 'ITEM-0006', area: 'Freezer', shelfOrder: 10, seq: 6 },
      { vendor: 'Sysco', id: 'ITEM-0007', area: 'Freezer', shelfOrder: 20, seq: 7 }
    ],
    ltos: [{ id: 'LTO-1', name: 'Fall Chicken Pho', sentAt: '2026-11-02T17:41:00Z', status: 'running' }]
  };
}

function loadCE(text) {
  const ctx = { console };
  vm.createContext(ctx);
  vm.runInContext(text, ctx, { filename: CE_FILE });
  return ctx.CatalogEdit;
}
// Functions sliced out of a page, run in their own context with T().
function pageFns(text, names, extra) {
  const ctx = { console, URLSearchParams };
  vm.createContext(ctx);
  vm.runInContext('function T(en, es) { return en; }\n' + (extra || '') + '\n' + slices(text, names), ctx);
  return ctx;
}

function problems(srcOf) {
  const out = [];
  const fail = (sc, what) => out.push('[' + sc + ']: ' + what);
  const CE = loadCE(srcOf(CE_FILE));
  const read = (t, fn, ...args) => CE.call(t, fn, args).result;

  // ---- areas ----
  {
    const page = read(tables(), 'getAreasPage');
    const want = [{ name: 'Walk-in', order: 10, items: 3, vendors: 2, onlyHere: 2 },     // Lime also in Dry Storage
                  { name: 'Dry Storage', order: 20, items: 2, vendors: 1, onlyHere: 1 },
                  { name: 'Freezer', order: 30, items: 1, vendors: 1, onlyHere: 1 },       // Nori is inactive
                  { name: 'Expo', order: 40, items: 0, vendors: 0, onlyHere: 0 }];
    if (!same(page, want)) fail('areas', 'getAreasPage ' + JSON.stringify(page));
  }

  // ---- shelf ----
  {
    const t = tables();
    const page = read(t, 'getShelfPage', 'organic butcher');
    if (page.vendors.map(v => v.name).join() !== 'Amazon,Organic Butcher,Sysco') fail('shelf', 'vendors not A to Z: ' + page.vendors.map(v => v.name).join());
    for (const v of page.vendors) {
      const p = read(t, 'getPickPathForSidebar', v.name);
      const on = p.groups.reduce((n, g) => n + g.items.length, 0);
      if (v.onList !== on || v.notYet !== p.unassigned.length) fail('shelf', v.name + ' counts ' + JSON.stringify(v) + ', the list has ' + on + ' and ' + p.unassigned.length + ' not yet');
    }
    const p = read(t, 'getPickPathForSidebar', 'Organic Butcher');
    if (!page.path || page.path.vendor !== 'Organic Butcher') fail('shelf', 'path for ' + JSON.stringify(page.path && page.path.vendor));
    else {
      const strip = g => ({ area: g.area, areaOrder: g.areaOrder, items: g.items.map(x => ({ id: x.id, name: x.name })) });
      if (!same(page.path.groups.map(strip), p.groups)) fail('shelf', 'groups differ from pickPathForSidebar');
      if (!same(page.path.unassigned.map(x => ({ id: x.id, name: x.name })), p.unassigned)) fail('shelf', 'not yet differs from pickPathForSidebar');
      const walk = page.path.groups.find(g => g.area === 'Walk-in');
      if (!walk || walk.items.map(x => x.name + '/' + x.pack).join() !== 'Oxtail/LBs,Brisket/CASE (65LBs)') fail('shelf', 'Walk-in ' + JSON.stringify(walk));
      const chicken = page.path.unassigned[0] || {};
      if (chicken.name !== 'Chicken breast' || chicken.pack !== 'CASE (40 LBs)' || chicken.lto !== 'Fall Chicken Pho') fail('shelf', 'not yet ' + JSON.stringify(page.path.unassigned));
    }
    if (read(t, 'getShelfPage', '').path !== null) fail('shelf', 'no vendor asked for still read a list');
    let threw = false;
    try { read(t, 'getShelfPage', 'Nobody'); } catch (e) { threw = true; }
    if (!threw) fail('shelf', 'a vendor that isn\'t listed was read');
  }

  // ---- report ----
  const GOOD = { phoneDirect: true, localNow: '2026-11-11 09:24', cycleDate: '2026-11-11', lockedForMs: 0 };
  const report = (t, st) => read(t, 'getStoreHealthReport', st || GOOD, 'Rosslyn BOH');
  const row = (rep, id) => rep.checks.find(c => c.id === id) || {};
  {
    const t = tables();
    t.vendors[2].mults = [0, 0, 0, 0, 0, 0, 0];
    t.items.push({ id: 'ITEM-0008', name: 'LIME', primaryVendor: null, pack: 'CS', par: 2, active: true, useMult: true, notes: '', sku: '', category: '', eligible: [], seq: 8 });
    const rep = report(t, Object.assign({}, GOOD, { lockedForMs: 150000 }));
    const got = id => { const r = row(rep, id); return { count: r.count, names: r.names }; };
    if (!same(got('vendors_days'), { count: 1, names: ['Organic Butcher'] })) fail('report', 'vendors_days ' + JSON.stringify(got('vendors_days')));
    if (!same(got('items_area'), { count: 2, names: ['LIME', 'Chicken breast'] })) fail('report', 'items_area ' + JSON.stringify(got('items_area')));
    if (!same(got('items_par'), { count: 1, names: ['Chicken breast'] })) fail('report', 'items_par ' + JSON.stringify(got('items_par')));
    if (!same(got('items_primary'), { count: 1, names: ['LIME'] })) fail('report', 'items_primary ' + JSON.stringify(got('items_primary')));
    if (!same(got('backups_placed'), { count: 0, names: [] })) fail('report', 'backups_placed ' + JSON.stringify(got('backups_placed')));
    const names = row(rep, 'item_names');
    if (names.count !== 1 || !same(names.names, ['Lime']) || !same(names.copies, [2])) fail('report', 'item_names ' + JSON.stringify(names));
    if (row(rep, 'lockout').minutes !== 3) fail('report', 'lockout minutes ' + row(rep, 'lockout').minutes);
    if (row(rep, 'nightly').cycleDate !== '2026-11-11') fail('report', 'nightly cycleDate ' + row(rep, 'nightly').cycleDate);
    const t2 = tables(); t2.items[1].eligible = ['Amazon', 'Sysco'];
    if (!same(row(report(t2), 'backups_placed').names, ['Tape (Sysco)'])) fail('report', 'backups names ' + JSON.stringify(row(report(t2), 'backups_placed').names));
  }

  // ---- rows ----
  {
    const t = tables();
    t.vendors[2].mults = [0, 0, 0, 0, 0, 0, 0];
    t.vendors[0].mults = [0, 0, 0, 0, 0, 0, 0];
    t.items.push({ id: 'ITEM-0008', name: 'LIME', primaryVendor: null, pack: 'CS', par: 2, active: true, useMult: true, notes: '', sku: '', category: '', eligible: [], seq: 8 });
    t.items[1].eligible = ['Amazon', 'Sysco'];
    const st = Object.assign({}, GOOD, { lockedForMs: 60000, phoneDirect: false, cycleDate: '2026-11-10', localNow: '2026-11-11 09:24' });
    const rep = report(t, st);
    const all = CE.healthRows(rep, false);
    const ids = all.rows.map(r => r.id).join();
    if (ids !== 'nightly,lockout,phones,vendors_days,items_area,items_par,items_primary,backups_placed,item_names') fail('rows', 'rows ' + ids);
    if (all.storeOk.length) fail('rows', 'storeOk with every store check failing: ' + all.storeOk.join());
    const by = id => all.rows.find(r => r.id === id) || {};
    if (by('nightly').tone !== 'bad' || by('lockout').tone !== 'warn') fail('rows', 'tones ' + by('nightly').tone + '/' + by('lockout').tone);
    if (by('lockout').fix !== 'clear_lockout' || by('backups_placed').fix !== 'place_backups' || by('items_area').fix) fail('rows', 'fixes');
    if (!same(by('vendors_days').link, { page: 'vendors' })) fail('rows', 'two vendors link ' + JSON.stringify(by('vendors_days').link));
    if (!same(by('items_area').link, { page: 'items', area: '__none' })) fail('rows', 'items_area link ' + JSON.stringify(by('items_area').link));
    if (!same(by('items_par').link, { page: 'items', view: 'setup' }) || !same(by('items_primary').link, { page: 'items', view: 'setup' })) fail('rows', 'setup links');
    if (!same(by('item_names').link, { page: 'items', q: 'Lime' })) fail('rows', 'item_names link ' + JSON.stringify(by('item_names').link));
    if (by('backups_placed').link || by('lockout').link) fail('rows', 'a fix row also links');
    if (by('lockout').minutes !== 1 || by('nightly').cycleDate !== '2026-11-10' || by('item_names').copies[0] !== 2) fail('rows', 'the words\' numbers');
    if (by('items_area').count !== 2 || by('items_area').kind !== 'catalog' || by('phones').kind !== 'store') fail('rows', 'count or kind');
    const setup = CE.healthRows(rep, true).rows.map(r => r.id).join();
    if (setup !== 'nightly,lockout,phones,items_primary,backups_placed,item_names') fail('rows', 'with the setup card: ' + setup);
    const one = tables(); one.vendors[2].mults = [0, 0, 0, 0, 0, 0, 0];
    const single = CE.healthRows(report(one), false);
    if (!same(single.rows.map(r => r.id), ['vendors_days', 'items_area', 'items_par'])) fail('rows', 'a store with three gaps: ' + single.rows.map(r => r.id).join());
    if (!same((single.rows[0] || {}).link, { page: 'vendors', open: 'Organic Butcher' })) fail('rows', 'one vendor link ' + JSON.stringify((single.rows[0] || {}).link));
    if (single.storeOk.join() !== 'nightly,lockout,phones') fail('rows', 'storeOk ' + single.storeOk.join());
    const healthy = tables(); healthy.items[4].par = 2;
    healthy.pickRows.push({ vendor: 'Organic Butcher', id: 'ITEM-0005', area: 'Walk-in', shelfOrder: 30, seq: 9 });
    const quiet = CE.healthRows(report(healthy), false);
    if (quiet.rows.length) fail('rows', 'a healthy store has rows ' + quiet.rows.map(r => r.id).join());
  }

  // ---- drafts: Storage areas ----
  {
    const A = pageFns(srcOf(AREAS), ['arKept', 'arSnapshot', 'arPayload', 'arNameProblem', 'arSummary', 'arMove']);
    const loaded = read(tables(), 'getAreasPage').map(a => ({ name: a.name, origName: a.name, items: a.items, vendors: a.vendors, onlyHere: a.onlyHere, deleted: false }));
    const rows = clone(loaded);
    rows[1].name = 'Dry storage shelf';                       // renamed
    rows[3].deleted = true;                                    // Expo deleted
    rows.push({ name: 'Ice machine', origName: null, items: 0, vendors: 0, onlyHere: 0, deleted: false });
    if (!A.arMove(rows, 2, -1)) fail('drafts', 'Freezer did not move up');
    if (A.arMove(rows, 0, -1)) fail('drafts', 'the first area moved up');
    const payload = A.arPayload(rows);
    const want = [{ name: 'Walk-in', origName: 'Walk-in' }, { name: 'Freezer', origName: 'Freezer' },
                  { name: 'Dry storage shelf', origName: 'Dry Storage' }, { name: 'Ice machine', origName: null }];
    if (!same(payload, want)) fail('drafts', 'areas payload ' + JSON.stringify(payload));
    const sum = A.arSummary(rows, loaded);
    if (!same(sum, { renamed: 1, added: 1, deleted: 1, reordered: true })) fail('drafts', 'areas summary ' + JSON.stringify(sum));
    if (!same(A.arSummary(clone(loaded), loaded), { renamed: 0, added: 0, deleted: 0, reordered: false })) fail('drafts', 'an untouched draft has changes');
    if (!A.arNameProblem(rows, 'walk-in', -1)) fail('drafts', 'a name already taken (another case) was allowed');
    if (A.arNameProblem(rows, 'Expo', -1)) fail('drafts', 'a deleted area\'s name was refused');
    if (A.arNameProblem(rows, 'Walk-in', 0)) fail('drafts', 'an area\'s own name was refused');
    if (!A.arNameProblem(rows, '   ', -1)) fail('drafts', 'a blank name was allowed');
    const moved = clone(rows); moved.splice(2, 0, { name: 'X', origName: 'X', deleted: true });
    A.arMove(moved, 1, 1);
    if (moved.map(r => r.name).join() !== 'Walk-in,Dry storage shelf,X,Freezer,Expo,Ice machine') fail('drafts', 'down past a deleted area: ' + moved.map(r => r.name).join());
    // Saved through catalogEdit.js, it reads back as drawn.
    try {
      const saved = CE.applyOps(tables(), CE.call(tables(), 'commitStorageAreasDraft', [payload]).ops);
      const back = read(saved, 'getAreasPage').map(a => a.name + ':' + a.items).join();
      if (back !== 'Walk-in:3,Freezer:1,Dry storage shelf:2,Ice machine:0') fail('drafts', 'areas after the save ' + back);
    } catch (e) { fail('drafts', 'the areas draft was refused: ' + e.message); }
  }

  // ---- drafts: Shelf to Sheet ----
  {
    const S = pageFns(srcOf(SHELF), ['shDraft', 'shList', 'shMove', 'shPayload', 'shPlaces', 'shSnapshot', 'shMoved']);
    const t = tables();
    const path = read(t, 'getShelfPage', 'Organic Butcher').path;
    const D = S.shDraft(path);
    if (D.groups.map(g => g.area).join() !== 'Walk-in,Dry Storage,Freezer,Expo') fail('drafts', 'shelf areas out of order: ' + D.groups.map(g => g.area).join());
    const base = S.shSnapshot(D);
    const names = () => D.groups.map(g => g.area + '=' + g.items.map(x => x.name).join('+')).join(' ') + ' off=' + D.notYet.map(x => x.name).join('+');
    if (S.shMove(D, { g: 0, i: 0 }, { g: 0, i: 1 })) fail('drafts', 'a move to its own place changed the list');
    if (!S.shMove(D, { g: 0, i: 0 }, { g: 0, i: 2 })) fail('drafts', 'down one did nothing');                 // Oxtail below Brisket
    if (names() !== 'Walk-in=Brisket+Oxtail Dry Storage= Freezer= Expo= off=Chicken breast') fail('drafts', 'after down: ' + names());
    S.shMove(D, { g: -1, i: 0 }, { g: 0, i: 0 });                                                          // the chicken dragged to the top
    S.shMove(D, { g: 0, i: 2 }, { g: 2, i: null });                                                        // Oxtail to the freezer
    if (names() !== 'Walk-in=Chicken breast+Brisket Dry Storage= Freezer=Oxtail Expo= off=') fail('drafts', 'after across: ' + names());
    if (S.shMoved(D, base) !== 2) fail('drafts', 'moved count ' + S.shMoved(D, base));     // Brisket is back where it was
    const payload = S.shPayload(D);
    if (payload.map(x => x.name + '@' + x.area).join() !== 'Chicken breast@Walk-in,Brisket@Walk-in,Oxtail@Freezer') fail('drafts', 'shelf payload ' + JSON.stringify(payload));
    const saved = CE.applyOps(t, CE.call(t, 'commitReorderPickPath', ['Organic Butcher', payload]).ops);
    const again = S.shDraft(read(saved, 'getShelfPage', 'Organic Butcher').path);
    if (S.shSnapshot(again) !== S.shSnapshot(D)) fail('drafts', 'the saved list reads back differently');
    // Down one in a longer area; an area used before an empty one comes in the store's order.
    const three = { notYet: [], groups: [{ area: 'A', items: [{ id: 'a', name: 'a' }, { id: 'b', name: 'b' }, { id: 'c', name: 'c' }] }] };
    S.shMove(three, { g: 0, i: 0 }, { g: 0, i: 2 });
    if (three.groups[0].items.map(x => x.id).join() !== 'b,a,c') fail('drafts', 'down one in three: ' + three.groups[0].items.map(x => x.id).join());
    S.shMove(three, { g: 0, i: 2 }, { g: 0, i: 0 });
    if (three.groups[0].items.map(x => x.id).join() !== 'c,b,a') fail('drafts', 'to the top: ' + three.groups[0].items.map(x => x.id).join());
    const amazon = S.shDraft(read(t, 'getShelfPage', 'Amazon').path);
    if (amazon.groups.map(g => g.area).join() !== 'Walk-in,Dry Storage,Freezer,Expo') fail('drafts', 'Amazon\'s areas out of order: ' + amazon.groups.map(g => g.area).join());
    S.shMove(again, { g: 0, i: 1 }, { g: -1, i: null });                                                  // Brisket off the list
    const off = CE.applyOps(saved, CE.call(saved, 'commitReorderPickPath', ['Organic Butcher', S.shPayload(again)]).ops);
    const back = read(off, 'getShelfPage', 'Organic Butcher').path;
    if (back.unassigned.map(x => x.name).join() !== 'Brisket') fail('drafts', 'an item taken off is not back in not yet: ' + JSON.stringify(back.unassigned));
  }

  // ---- wiring ----
  {
    const build = srcOf(BUILD);
    if (!/'areas\.html':\s*\('editor:Areas',/.test(build)) fail('wiring', 'build.py does not publish areas.html from template/editor/Areas.html');
    if (!/'pickpath\.html':\s*\('editor:ShelfToSheet',/.test(build)) fail('wiring', 'build.py does not publish pickpath.html from ShelfToSheet.html');
    if (/'healthcheck\.html'\s*:/.test(build)) fail('wiring', 'build.py still publishes a Health check page');
    let stores = [];
    try { stores = JSON.parse(fs.readFileSync(path.join(ROOT, 'stores.json'), 'utf8')); } catch (e) { fail('wiring', 'stores.json: ' + e.message); }
    // Each published store agrees with itself: a page with no Health check
    // entry publishes no Health check page (build.py never deletes one), and
    // one still on the old build (a canary's fan-out pending) keeps its page.
    for (const s of stores) {
      const page = path.join(ROOT, s.slug, 'index.html');
      if (!fs.existsSync(page)) continue;
      const linked = /data-manage="healthcheck"/.test(fs.readFileSync(page, 'utf8'));
      const published = fs.existsSync(path.join(ROOT, s.slug, 'editor', 'healthcheck.html'));
      if (!linked && published) fail('wiring', s.slug + ' still publishes a Health check page nothing links');
      if (linked && !published) fail('wiring', s.slug + '\'s sidebar links a Health check page it no longer has');
    }

    const app = srcOf(APP);
    if (/data-manage="healthcheck"/.test(app)) fail('wiring', 'the app\'s sidebar still has the Health check');
    const mpText = /const MANAGE_PAGES_ = (\{[^}]*\});/.exec(app);
    const pages = pageFns(app, ['managePageFor_', 'manageQuery_'], 'var MANAGE_PAGES_ = ' + (mpText ? mpText[1] : '{}') + ';');
    const mp = vm.runInContext('MANAGE_PAGES_', pages);
    if (mp.healthcheck || Object.keys(mp).join() !== 'overview,items,vendors,areas,pickpath,history,changes') fail('wiring', 'Manage pages ' + Object.keys(mp).join());
    if (pages.managePageFor_('healthcheck') !== 'overview' || pages.managePageFor_('items') !== 'items') fail('wiring', '#healthcheck does not open the Overview');
    if (pages.manageQuery_('area=__none&t=abc&embed=0&q=Lime') !== '&area=__none&q=Lime') fail('wiring', 'the app passed on ' + pages.manageQuery_('area=__none&t=abc&embed=0&q=Lime'));
    if (pages.manageQuery_('') !== '' || pages.manageQuery_(null) !== '') fail('wiring', 'no filter still added a query');
    if (!/openManage_\(page, query\)/.test(app) || !/const src = 'editor\/' \+ MANAGE_PAGES_\[page\] \+ '\?embed=1' \+ extra;/.test(app)) fail('wiring', 'the app does not pass the filter to the frame');

    const host = srcOf(HOST);
    if (/healthcheck: 'healthcheck\.html'/.test(host)) fail('wiring', 'host.js still has the Health check page');
    const lp = /const LINK_PARAMS = (\[[^\]]*\]);/.exec(host);
    if (!lp) fail('wiring', 'host.js has no LINK_PARAMS');
    else {
      const h = pageFns(host, ['linkQuery'], 'var LINK_PARAMS = ' + lp[1] + ';');
      const q = h.linkQuery(new URLSearchParams('page=items&view=setup&t=abc&vendor=Sysco'));
      if (q !== 'view=setup&vendor=Sysco') fail('wiring', 'host.js passed on ' + q);
    }
    if (!/SHELL\.open\(want === 'editor' \? 'overview' : want, linkQuery\(params\)\)/.test(host)) fail('wiring', 'host.js does not send a link\'s filter to the app');

    const items = srcOf(ITEMS);
    const I = pageFns(items, ['filterFromLink'], sliceConst(items, 'VIEWS') + "\nvar S = { view: 'active', area: '', q: '' };");
    I.filterFromLink('?view=setup&area=__none&q=Lime');
    if (vm.runInContext('S.view + "|" + S.area + "|" + S.q', I) !== 'setup|__none|Lime') fail('wiring', 'Items opened on ' + vm.runInContext('JSON.stringify(S)', I));
    I.filterFromLink('?view=nonsense');
    if (vm.runInContext('S.view', I) !== 'setup') fail('wiring', 'Items took a view it doesn\'t have');
    if (!/filterFromLink\(location\.search\)/.test(items)) fail('wiring', 'Items never reads the link');

    const ov = srcOf(OVERVIEW);
    if (/ovPage\('healthcheck'\)/.test(ov)) fail('wiring', 'the Overview still links the Health check page');
    if (!/CatalogEdit\.healthRows\(OV\.health, setupShowing\)/.test(ov)) fail('wiring', 'the Overview does not build its rows with healthRows');
    for (const [file, call] of [[AREAS, "call('commitStorageAreasDraft', payload)"], [AREAS, "call('getAreasPage')"],
                                [SHELF, "call('commitReorderPickPath', vendor, payload)"], [SHELF, "call('getShelfPage', name)"]]) {
      if (srcOf(file).indexOf(call) < 0) fail('wiring', file + ' does not ' + call);
    }
  }
  return out;
}

let failed = 0;
const main = problems(SRC);
if (main.length) {
  failed++;
  console.log(`FAIL  ${main.length} problem(s):`);
  for (const p of main.slice(0, 20)) console.log('      ' + p);
} else {
  console.log('PASS  areas, shelf, the report\'s numbers, the Overview\'s rows, both drafts saved and read back, the wiring');
}

const CONTROLS = [
  { name: 'an area counts inactive items', scenario: 'areas', file: CE_FILE,
    find: "    const active = new Set(t.items.filter(it => it.active === true && s_(it.id)).map(it => s_(it.id)));",
    replace: "    const active = new Set(t.items.filter(it => s_(it.id)).map(it => s_(it.id)));" },
  { name: 'an item with another area counted as stranded', scenario: 'areas', file: CE_FILE,
    find: '               onlyHere: ids.filter(id => areasOf.get(id).size === 1).length };',
    replace: '               onlyHere: ids.length };' },
  { name: 'the vendor column counts the wrong list', scenario: 'shelf', file: CE_FILE,
    find: '      return { name: name, onList: p.groups.reduce((n, g) => n + g.items.length, 0), notYet: p.unassigned.length };',
    replace: '      return { name: name, onList: p.groups.length, notYet: p.unassigned.length };' },
  { name: 'a row loses its pack', scenario: 'shelf', file: CE_FILE,
    find: "      return { id: x.id, name: x.name, pack: s_(it.pack), lto: (it.lto && ltoName.get(s_(it.lto))) || '' };",
    replace: "      return { id: x.id, name: x.name, pack: '', lto: (it.lto && ltoName.get(s_(it.lto))) || '' };" },
  { name: 'the report\'s names left out', scenario: 'report', file: CE_FILE,
    find: '    const listed = names => ({ count: names.length, names: names });', replace: '    const listed = names => ({ count: names.length, names: [] });' },
  { name: 'the lockout\'s minutes left out', scenario: 'report', file: CE_FILE,
    find: "{ minutes: Math.max(mins, 0) });", replace: "{ minutes: 0 });" },
  { name: 'a passing check becomes a row', scenario: 'rows', file: CE_FILE,
    find: "      if (c.status === 'pass') { if (store) storeOk.push(c.id); continue; }", replace: "      if (c.status === 'pass') { if (store) storeOk.push(c.id); }" },
  { name: 'the setup card does not take its rows', scenario: 'rows', file: CE_FILE,
    find: '      if (setupOpen && SETUP_COVERS.indexOf(c.id) >= 0) continue;', replace: '' },
  { name: 'no area opens the whole Items list', scenario: 'rows', file: CE_FILE,
    find: "      else if (c.id === 'items_area') link = { page: 'items', area: '__none' };", replace: "      else if (c.id === 'items_area') link = { page: 'items' };" },
  { name: 'store checks not put first', scenario: 'rows', file: CE_FILE,
    find: '    rows.sort((a, b) => (rank(a.id) - rank(b.id)) || (order.get(a) - order.get(b)));', replace: '' },
  { name: 'a deleted area is still sent', scenario: 'drafts', file: AREAS,
    find: '    function arKept(rows) { return rows.filter(function (r) { return !r.deleted; }); }',
    replace: '    function arKept(rows) { return rows.slice(); }' },
  { name: 'a new area sent as a rename', scenario: 'drafts', file: AREAS,
    find: '      return arKept(rows).map(function (r) { return { name: r.name.trim(), origName: r.origName || null }; });',
    replace: '      return arKept(rows).map(function (r) { return { name: r.name.trim(), origName: r.origName || r.name }; });' },
  { name: 'a name taken in another case allowed', scenario: 'drafts', file: AREAS,
    find: "        if (rows[i].name.trim().toLowerCase() === n.toLowerCase()) return", replace: "        if (rows[i].name.trim() === n) return" },
  { name: 'a move down in the same area lands one too far', scenario: 'drafts', file: SHELF,
    find: '        if (at > from.i) at--;', replace: '' },
  { name: 'Shelf to Sheet sends areas out of order', scenario: 'drafts', file: SHELF,
    find: '      var groups = (path.groups || []).slice().sort(function (a, b) { return a.areaOrder - b.areaOrder; });',
    replace: '      var groups = (path.groups || []).slice();' },
  { name: 'build.py still publishes the old Storage Areas page', scenario: 'wiring', file: BUILD,
    find: "                 'areas.html':    ('editor:Areas', 'Storage areas', 'areas'),",
    replace: "                 'areas.html':    ('StorageAreas', 'Storage Areas', 'areas')," },
  { name: '#healthcheck opens nothing', scenario: 'wiring', file: APP,
    find: "  function managePageFor_(page) { return page === 'healthcheck' ? 'overview' : page; }",
    replace: '  function managePageFor_(page) { return page; }' },
  { name: 'the app passes any query to the page', scenario: 'wiring', file: APP,
    find: "    for (const k of ['view', 'area', 'q', 'open', 'vendor']) { const v = params.get(k); if (v) out.set(k, v); }",
    replace: '    params.forEach(function (v, k) { if (v) out.set(k, v); });' },
  { name: 'host.js drops the link\'s filter', scenario: 'wiring', file: HOST,
    find: "      SHELL.open(want === 'editor' ? 'overview' : want, linkQuery(params));", replace: "      SHELL.open(want === 'editor' ? 'overview' : want);" },
  { name: 'Items takes any view', scenario: 'wiring', file: ITEMS,
    find: '      if (view && VIEWS.indexOf(view) >= 0) S.view = view;', replace: '      if (view) S.view = view;' }
];
for (const c of CONTROLS) {
  let res;
  try { res = problems(f => (f === c.file ? F.plant(SRC(f), c.find, c.replace) : SRC(f))); } catch (e) {
    failed++; console.log(`FAIL  control "${c.name}" crashed instead of biting: ${e.message}`); continue;
  }
  const hits = res.filter(p => p.startsWith('[' + c.scenario + ']')).length;
  if (hits) console.log(`PASS  control "${c.name}" bites (${hits} in "${c.scenario}")`);
  else { failed++; console.log(`FAIL  control "${c.name}" did NOT bite "${c.scenario}"`); }
}
console.log(failed ? 'manage_pages: ' + failed + ' FAILED' : 'manage_pages: ALL PASS');
process.exit(failed ? 1 : 0);
