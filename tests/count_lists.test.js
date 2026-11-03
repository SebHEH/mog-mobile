'use strict';
// GATE: the phone's count lists (template/index.html shownItems_, 2026-11-03).
// Each item is listed on one vendor only, so counting every vendor counts it
// once: on its main vendor's list, or (no main vendor, or a main vendor whose
// list doesn't have it) on the first of its lists in the store's vendor
// order. A backup row still shows when it was added to that list for today,
// has a count there today, or is kept on this phone for the day (bkKept_).
// On random stores with real stores' drift (rows on a dropped vendor, a main
// vendor's row missing, no main vendor, inactive items still listed), with
// the real OrderMath.gs building each vendor's items:
//   - each vendor lists exactly those items; with no counts or adds, every
//     item is on exactly one list (none on two, none lost)
//   - a counted row and a today-only add always show; a kept row shows that
//     day only
//   - the line under a row names the item's other lists, and its main vendor
//     when that isn't this list
//   - without the catalog (Apps Script): the main vendor's list only, or
//     every list for an item with none
//   - the Today card's number (shownCountFor_) is the count screen's
// Each has a planted-defect control.
//
// Run bare: node tests/count_lists.test.js
// A passing run ends with "count_lists: ALL PASS".

const vm = require('vm');
const F = require('./fake_apps_script.js');
const { slices } = require('./slice_js.js');

const TEMPLATE = 'template/index.html';
const ORDER_MATH = 'apps-script/OrderMath.gs';
const SRC = file => F.source(null, file);
const STORES = 300;
const VENDORS = ['Sysco', 'B&T', 'Amazon', 'Chef Center', "Murray's Chicken", 'Elpis', 'TNY Warehouse'];
const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const CYCLE = '2026-11-03';

function mulberry32(a) {
  return function () {
    a |= 0; a = a + 0x6D2B79F5 | 0;
    let t = Math.imul(a ^ a >>> 15, 1 | a);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

// The real list code, lifted out with slices(), next to the real OrderMath.gs.
// The page's two module-level lets and its Map are plain globals here.
function load(html) {
  const ctx = {
    direct: { catalog: null },
    itemListsCat_: null, itemListsMap_: null, bkKeptByList_: new Map(),
    cycle: CYCLE,
    t: k => k,
    escapeHtml: s => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;')
  };
  ctx.directCycleDate_ = () => ctx.cycle;
  vm.createContext(ctx);
  vm.runInContext(SRC(ORDER_MATH), ctx, { filename: 'orderMath.js' });
  vm.runInContext(slices(html, ['shownItems_', 'itemLists_', 'homeList_', 'bkKept_', 'backupLineFor_', 'shownCountFor_']), ctx);
  return ctx;
}

// A random store as the phone's catalog has it, every vendor delivering
// today. bare: no counts and no adds for today.
function makeStore(seed, bare) {
  const rnd = mulberry32(seed * 7919 + 1);
  const int = (a, b) => a + Math.floor(rnd() * (b - a + 1));
  const pick = a => a[Math.floor(rnd() * a.length)];
  const shuffle = a => { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
  const vendorList = shuffle(VENDORS.slice()).slice(0, int(2, VENDORS.length));
  const items = {}, rows = [];
  const n = int(1, 24);
  for (let i = 0; i < n; i++) {
    const id = 'ITEM-' + String(i + 1).padStart(3, '0');
    const r = rnd();
    let main = r < 0.12 ? null : (r < 0.18 ? 'Dropped Vendor' : pick(vendorList));
    if (main && main !== 'Dropped Vendor' && rnd() < 0.05) main = main.toLowerCase();
    items[id] = { name: 'Item ' + (i + 1), pack: 'EA', par: int(0, 8), useMult: rnd() < 0.8, primaryVendor: main, active: rnd() < 0.9 };
    const on = new Set();
    if (main && rnd() < 0.85) on.add(main === 'Dropped Vendor' ? main : vendorList.find(v => v.toLowerCase() === main.toLowerCase()));
    for (const v of vendorList) if (rnd() < 0.3) on.add(v);
    if (rnd() < 0.08) on.add('Dropped Vendor');
    for (const v of on) rows.push([v, id, items[id].name, 'Area ' + int(1, 3), int(1, 3), int(1, 40)]);
  }
  shuffle(rows);   // pick-row order is never the vendor order
  const mults = {};
  for (const v of vendorList) mults[v] = Object.fromEntries(DAYS.map(d => [d, 1]));
  const counts = [], adds = [];
  if (!bare) {
    for (const r of rows) if (vendorList.includes(r[0]) && rnd() < 0.15) counts.push({ vendor: r[0], id: r[1], onHand: int(0, 9) });
    for (const id of Object.keys(items)) {
      if (!items[id].active || rnd() >= 0.08) continue;
      const v = pick(vendorList);
      if (!rows.some(r => r[0] === v && r[1] === id)) adds.push([v, id]);
    }
  }
  return {
    catalog: { location: 'Test', vendorList, vendorMults: mults, cutoffs: {}, items, pickRows: rows, itemCounts: {}, backupCounts: {} },
    state: { cycleDate: CYCLE, dayOfWeek: 'Tue', emergencyOverride: false, vendorPicks: {}, todaysLog: [], todayEdits: { pars: {}, adds } },
    counts
  };
}

// The rule, written out plainly: an item's lists are the store's vendors whose
// list has it, in vendor order; it shows on its main vendor's when that list
// has it, else on the first of its lists.
function listsOf(snap, id) {
  const has = new Set(snap.catalog.pickRows.filter(r => String(r[1]) === id).map(r => String(r[0]).toLowerCase()));
  return snap.catalog.vendorList.filter(v => has.has(v.toLowerCase()));
}
function homeOf(snap, id) {
  const lists = listsOf(snap, id);
  const main = snap.catalog.items[id].primaryVendor;
  return (main && lists.find(v => v.toLowerCase() === main.toLowerCase())) || lists[0] || null;
}
const same = (a, b) => String(a || '').toLowerCase() === String(b || '').toLowerCase();
const counted = it => it.onHand !== null && it.onHand !== undefined && it.onHand !== '';
const idsOf = list => list.map(i => i.id).join(',');

function problems(html) {
  const out = [];
  const bad = (what, detail) => { if (out.length < 6) out.push(what + (detail ? ' (' + detail + ')' : '')); };
  let ctx;
  try { ctx = load(html); } catch (e) { return ['the list code did not load: ' + e.message]; }
  const listFor = (snap, v) => {
    const items = ctx.vendorItemsFromSnapshot_(ctx.orderInputsFromSnapshot_(snap), v).items;
    return { items, shown: ctx.shownItems_({ vendor: v, items }) };
  };

  for (let seed = 1; seed <= STORES; seed++) {
    // No counts, no adds: every item on exactly one list, and the line under each row.
    const bare = makeStore(seed, true);
    ctx.direct = { catalog: bare.catalog };
    ctx.bkKeptByList_.clear();
    const seen = new Map();
    for (const v of bare.catalog.vendorList) {
      const { items, shown } = listFor(bare, v);
      for (const it of shown) seen.set(it.id, (seen.get(it.id) || []).concat(v));
      const want = idsOf(items.filter(it => same(homeOf(bare, it.id), v)));
      if (idsOf(shown) !== want) bad('a list shows the wrong items', 'seed ' + seed + ', ' + v + ': ' + idsOf(shown) + ' vs ' + want);
      for (const it of items) {
        const main = bare.catalog.items[it.id].primaryVendor || '';
        const others = listsOf(bare, it.id).filter(x => !same(x, v) && !same(x, main));
        const parts = [];
        if (main && !same(main, v)) parts.push('bkMain ' + ctx.escapeHtml(main));
        if (others.length) parts.push('bkBackups ' + others.map(ctx.escapeHtml).join(', '));
        const got = ctx.backupLineFor_(it, v), want2 = parts.join(' &middot; ');
        if (got !== want2) bad('the line under a row is wrong', 'seed ' + seed + ', ' + it.id + ' on ' + v + ': "' + got + '" vs "' + want2 + '"');
      }
    }
    for (const id of Object.keys(bare.catalog.items)) {
      const on = seen.get(id) || [];
      const should = listsOf(bare, id).length ? 1 : 0;
      if (on.length !== should) bad(on.length > should ? 'an item on two lists' : 'an item on no list', 'seed ' + seed + ', ' + id + ': ' + (on.join(' + ') || 'none'));
    }

    // A day with counts and adds: nothing counted or added is hidden; kept rows; the Today card.
    const day = makeStore(seed, false);
    for (const v of day.catalog.vendorList) {
      ctx.direct = { catalog: day.catalog };
      const { items, shown } = listFor(day, v);
      const ids = new Set(shown.map(i => i.id));
      for (const c of day.counts) if (c.vendor === v && !ids.has(c.id)) bad('a counted row is hidden', 'seed ' + seed + ', ' + c.id + ' on ' + v);
      for (const a of day.state.todayEdits.adds) if (a[0] === v && !ids.has(a[1])) bad('a today-only add is hidden', 'seed ' + seed + ', ' + a[1] + ' on ' + v);
      const want = idsOf(items.filter(it => same(homeOf(day, it.id), v) || it.todayOnly || counted(it)));
      if (idsOf(shown) !== want) bad('a list with counts shows the wrong items', 'seed ' + seed + ', ' + v + ': ' + idsOf(shown) + ' vs ' + want);

      const hidden = items.find(it => !ids.has(it.id));
      if (hidden) {
        ctx.bkKept_(v).add(hidden.id);
        if (!ctx.shownItems_({ vendor: v, items }).some(i => i.id === hidden.id)) bad('a kept row is hidden', 'seed ' + seed + ', ' + hidden.id + ' on ' + v);
        ctx.cycle = '2026-11-04';
        if (ctx.shownItems_({ vendor: v, items }).some(i => i.id === hidden.id)) bad('a kept row carried to the next day', 'seed ' + seed + ', ' + hidden.id + ' on ' + v);
        ctx.cycle = CYCLE;
        ctx.bkKeptByList_.clear();
      }

      ctx.direct = { mode: 'direct', snap: day, catalog: day.catalog };
      const n = ctx.shownCountFor_(v);
      if (n !== shown.length) bad("the Today card's number isn't the count screen's", 'seed ' + seed + ', ' + v + ': ' + n + ' vs ' + shown.length);
    }

    // Without the catalog (Apps Script): the main vendor's list, or every list for an item with none.
    ctx.direct = { catalog: null };
    for (const v of day.catalog.vendorList) {
      const { items, shown } = listFor(day, v);
      const want = idsOf(items.filter(it => {
        const main = day.catalog.items[it.id].primaryVendor;
        return !main || same(main, v) || it.todayOnly || counted(it);
      }));
      if (idsOf(shown) !== want) bad('without the catalog, a list shows the wrong items', 'seed ' + seed + ', ' + v + ': ' + idsOf(shown) + ' vs ' + want);
      if (items.some(it => ctx.backupLineFor_(it, v) !== '')) bad('without the catalog, a row names other vendors', 'seed ' + seed);
    }
    ctx.direct = { mode: 'exec', catalog: null };
    if (ctx.shownCountFor_(day.catalog.vendorList[0]) !== null) bad('the Today card counted without a copy of the day', 'seed ' + seed);
  }
  return out;
}

let failed = 0;
const html = SRC(TEMPLATE);
const main = problems(html);
if (main.length) { failed++; console.log('FAIL  ' + main.join('\n      ')); }
else console.log('PASS  count lists on ' + STORES + ' stores: each item on one list, counted and added rows shown, kept rows for the day, ' +
                 'the line naming the other vendors, Apps Script fallback, Today card = count screen');

const CONTROLS = [
  { name: 'a counted backup is hidden',
    find: "      if (it.onHand !== null && it.onHand !== '' && it.onHand !== undefined) return true;\n      const home = homeList_(it);",
    replace: '      const home = homeList_(it);' },
  { name: 'a today-only add is hidden',
    find: '      if (it.todayOnly || kept.has(it.id)) return true;',
    replace: '      if (kept.has(it.id)) return true;' },
  { name: "the old lists: every list but a backup's (an item with no main vendor on all of them)",
    find: '      const home = homeList_(it);\n      return home === null || home.toLowerCase() === here;',
    replace: '      return !it.secondary;' },
  { name: "the main vendor taken even when its list doesn't have the item",
    find: '    if (main && mine.some(v => v.toLowerCase() === main.toLowerCase())) return main;',
    replace: '    if (main) return main;' },
  { name: "the first list taken in pick-row order, not the store's vendor order",
    find: '    if (order.size) for (const l of lists.values()) l.sort((a, b) => order.get(a.toLowerCase()) - order.get(b.toLowerCase()));\n',
    replace: '' },
  { name: 'a dropped vendor counts as a list',
    find: '      if (!v || !id || (order.size && !order.has(v.toLowerCase()))) continue;',
    replace: '      if (!v || !id) continue;' },
  { name: "the line names the list it's on",
    find: '    const others = (lists.get(it.id) || []).filter(v => v.toLowerCase() !== here && v.toLowerCase() !== mainLow);',
    replace: '    const others = (lists.get(it.id) || []).filter(v => v.toLowerCase() !== mainLow);' },
  { name: 'kept rows carry to the next day',
    find: "    const key = (directCycleDate_() || '') + '\\u0001' + String(vendor || '').toLowerCase();",
    replace: "    const key = String(vendor || '').toLowerCase();" },
  { name: "without the catalog, a backup shows on every list it's on",
    find: '    if (!lists) return main || null;',
    replace: '    if (!lists) return null;' },
  { name: 'the Today card counts the hidden rows too',
    find: '      return shownItems_({ vendor: vendor, items: payload.items }).length;',
    replace: '      return payload.items.length;' }
];
for (const c of CONTROLS) {
  let res;
  try { res = problems(F.plant(html, c.find, c.replace)); }
  catch (e) { failed++; console.log(`FAIL  control "${c.name}" crashed instead of biting: ${e.message}`); continue; }
  if (res.length) console.log(`PASS  control "${c.name}" bites (${res[0].slice(0, 120)})`);
  else { failed++; console.log(`FAIL  control "${c.name}" did NOT bite`); }
}

console.log(failed ? `count_lists: ${failed} FAILED` : 'count_lists: ALL PASS');
process.exit(failed ? 1 : 0);
