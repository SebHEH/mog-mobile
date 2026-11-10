'use strict';
// GATE: the phone's count lists (template/index.html listSplit_, 2026-11-03,
// 2026-11-10). Each item is listed on one vendor only, so counting every
// vendor counts it once: on its main vendor's list, or (no main vendor, or a
// main vendor whose list doesn't have it) on the first of its lists in the
// store's vendor order. When that list isn't ordered today, every list of it
// that is ordered today shows it, and whichever counts it keeps it: an item
// counted on another list ordered today (this phone's unsaved counts too)
// moves to the bottom of this one, read-only, under "Counted on X's list
// today" (X the first such list in vendor order), its main vendor's list
// included. A backup row still shows when it was added to that list for
// today, has a count there today, or is kept on this phone for the day
// (bkKept_). On random stores with real stores' drift (rows on a dropped
// vendor, a main vendor's row missing, no main vendor, inactive items still
// listed, vendors not ordered today), with the real OrderMath.gs building
// each vendor's items:
//   - every vendor ordered today: with no counts or adds, every item is on
//     exactly one list (none on two, none lost)
//   - some vendors not ordered today: an item whose list isn't ordered today
//     shows on every list of it that is; none is lost
//   - with counts, drafts and adds: each list's rows and its bottom section
//     are exactly the rule's, a counted row always shows, nothing is in both
//   - a kept row shows that day only, unless it's counted on another list
//   - the line under a row names the item's other lists, and its main vendor
//     when that isn't this list
//   - without this phone's copy of the day (Apps Script): the main vendor's
//     list only, or every list for an item with none; no bottom section
//   - the Today card's number (shownCountFor_) is the count screen's
//   - the bottom section: one header per list, the count shown, no count box
//   - Emergency Override: every vendor is ordered today
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
const TODAY = 'Tue';

function mulberry32(a) {
  return function () {
    a |= 0; a = a + 0x6D2B79F5 | 0;
    let t = Math.imul(a ^ a >>> 15, 1 | a);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

// The real list code, lifted out with slices(), next to the real OrderMath.gs.
// The page's module-level lets and its Map are plain globals here; this
// phone's unsaved counts (loadDraft) come from ctx.drafts.
function load(html) {
  const ctx = {
    direct: { catalog: null },
    itemListsCat_: null, itemListsMap_: null, bkKeptByList_: new Map(),
    drafts: new Map(),
    cycle: CYCLE,
    t: k => (k === 'elseCounted' ? "Counted on {v}'s list today" : k),
    escapeHtml: s => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;')
  };
  ctx.directCycleDate_ = () => ctx.cycle;
  ctx.loadDraft = (dateStr, vendor) => ctx.drafts.get(dateStr + '|' + vendor) || {};
  vm.createContext(ctx);
  vm.runInContext(SRC(ORDER_MATH), ctx, { filename: 'orderMath.js' });
  vm.runInContext(slices(html, ['shownItems_', 'listSplit_', 'listDay_', 'elsewhereHtml_', 'elseSig_', 'fmtQty_',
                                'itemLists_', 'homeList_', 'bkKept_', 'backupLineFor_', 'shownCountFor_']), ctx);
  return ctx;
}

// A random store as the phone's catalog has it. bare: no counts, no drafts,
// no adds. offRate: the chance each vendor isn't ordered today (one always is).
function makeStore(seed, bare, offRate) {
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
  const keepOn = pick(vendorList);
  for (const v of vendorList) {
    mults[v] = Object.fromEntries(DAYS.map(d => [d, 1]));
    if (v !== keepOn && rnd() < (offRate || 0)) mults[v][TODAY] = 0;
  }
  const counts = [], adds = [], drafts = {};
  if (!bare) {
    for (const r of rows) if (vendorList.includes(r[0]) && rnd() < 0.15) counts.push({ vendor: r[0], id: r[1], onHand: int(0, 9) });
    // A count left on a list that no longer has the item (moved off it today).
    for (const id of Object.keys(items)) {
      const v = pick(vendorList);
      if (rnd() < 0.15 && !rows.some(r => r[0] === v && r[1] === id)) counts.push({ vendor: v, id, onHand: int(0, 9) });
    }
    for (const id of Object.keys(items)) {
      if (!items[id].active || rnd() >= 0.08) continue;
      const v = pick(vendorList);
      if (!rows.some(r => r[0] === v && r[1] === id)) adds.push([v, id]);
    }
    for (const v of vendorList) {
      if (rnd() >= 0.2) continue;
      const d = {};
      for (const r of rows) if (r[0] === v && rnd() < 0.3) d[r[1]] = rnd() < 0.25 ? null : int(0, 9);
      drafts[v] = d;
    }
  }
  return {
    catalog: { location: 'Test', vendorList, vendorMults: mults, cutoffs: {}, items, pickRows: rows, itemCounts: {}, backupCounts: {} },
    state: { cycleDate: CYCLE, dayOfWeek: TODAY, emergencyOverride: false, vendorPicks: {}, todaysLog: [], todayEdits: { pars: {}, adds } },
    counts,
    drafts
  };
}

// The rule, written out plainly: an item's lists are the store's vendors whose
// list has it, in vendor order; its home is its main vendor's when that list
// has it, else the first of its lists.
function listsOf(snap, id) {
  const has = new Set(snap.catalog.pickRows.filter(r => String(r[1]) === id).map(r => String(r[0]).toLowerCase()));
  return snap.catalog.vendorList.filter(v => has.has(v.toLowerCase()));
}
function homeOf(snap, id) {
  const lists = listsOf(snap, id);
  const main = snap.catalog.items[id].primaryVendor;
  return (main && lists.find(v => v.toLowerCase() === main.toLowerCase())) || lists[0] || main || null;
}
const same = (a, b) => String(a || '').toLowerCase() === String(b || '').toLowerCase();
const blank = v => v === null || v === undefined || v === '';
const counted = it => !blank(it.onHand);
const idsOf = list => list.map(i => i.id).join(',');
function orderedToday(snap, v) {
  if (snap.state.emergencyOverride) return snap.catalog.vendorList.some(x => same(x, v));
  const name = snap.catalog.vendorList.find(x => same(x, v));
  return !!name && Number(snap.catalog.vendorMults[name][TODAY]) > 0;
}
// The first list other than v, ordered today, that has the item (today's
// adds included) and has it counted: this phone's draft for that list over
// the saved count.
function hasItem(snap, u, id) {
  return snap.catalog.pickRows.some(r => same(r[0], u) && String(r[1]) === id) ||
    snap.state.todayEdits.adds.some(a => same(a[0], u) && a[1] === id && snap.catalog.items[id] && snap.catalog.items[id].active === true);
}
function countedOnOf(snap, id, v) {
  for (const u of snap.catalog.vendorList) {
    if (same(u, v) || !orderedToday(snap, u) || !hasItem(snap, u, id)) continue;
    const d = (snap.drafts || {})[u] || {};
    let val;
    if (Object.prototype.hasOwnProperty.call(d, id)) val = d[id];
    else { const c = snap.counts.find(x => same(x.vendor, u) && x.id === id); val = c ? c.onHand : null; }
    if (!blank(val)) return { vendor: u, onHand: val };
  }
  return null;
}
function expectSplit(snap, v, items, kept) {
  const shown = [], elsewhere = [];
  for (const it of items) {
    if (counted(it)) { shown.push(it); continue; }
    const home = homeOf(snap, it.id);
    const belongs = it.todayOnly || (kept && kept.has(it.id)) || home === null || same(home, v) || !orderedToday(snap, home);
    if (!belongs) continue;
    const other = countedOnOf(snap, it.id, v);
    if (other) elsewhere.push({ id: it.id, vendor: other.vendor, onHand: other.onHand });
    else shown.push(it);
  }
  return { shown, elsewhere };
}
const elseOf = list => list.map(e => (e.id || e.item.id) + '@' + e.vendor + '=' + e.onHand).join(',');

function problems(html) {
  const out = [];
  const bad = (what, detail) => { if (out.length < 6) out.push(what + (detail ? ' (' + detail + ')' : '')); };
  let ctx;
  try { ctx = load(html); } catch (e) { return ['the list code did not load: ' + e.message]; }
  // This phone holds the day (Supabase), or doesn't (Apps Script: no catalog).
  const use = (snap, withDay) => {
    ctx.direct = withDay ? { mode: 'direct', snap: snap, catalog: snap.catalog } : { mode: 'exec', catalog: null };
    ctx.drafts = new Map(Object.keys((withDay && snap.drafts) || {}).map(v => [CYCLE + '|' + v, snap.drafts[v]]));
  };
  const listFor = (snap, v) => {
    const items = ctx.vendorItemsFromSnapshot_(ctx.orderInputsFromSnapshot_(snap), v).items;
    const split = ctx.listSplit_({ vendor: v, items });
    return { items, shown: split.shown, elsewhere: split.elsewhere };
  };

  for (let seed = 1; seed <= STORES; seed++) {
    // Every vendor ordered today, no counts, no adds: every item on exactly
    // one list, and the line under each row.
    const bare = makeStore(seed, true, 0);
    use(bare, true);
    ctx.bkKeptByList_.clear();
    const seen = new Map();
    for (const v of bare.catalog.vendorList) {
      const { items, shown, elsewhere } = listFor(bare, v);
      for (const it of shown) seen.set(it.id, (seen.get(it.id) || []).concat(v));
      const want = idsOf(items.filter(it => same(homeOf(bare, it.id), v)));
      if (idsOf(shown) !== want) bad('a list shows the wrong items', 'seed ' + seed + ', ' + v + ': ' + idsOf(shown) + ' vs ' + want);
      if (elsewhere.length) bad('a bottom section with nothing counted', 'seed ' + seed + ', ' + v);
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

    // Some vendors not ordered today: an item whose list isn't ordered today
    // is on every list of it that is.
    const off = makeStore(seed, true, 0.4);
    use(off, true);
    const seenOff = new Map();
    for (const v of off.catalog.vendorList) {
      const { items, shown } = listFor(off, v);
      if (!orderedToday(off, v) && items.length) bad('a list not ordered today has rows', 'seed ' + seed + ', ' + v);
      for (const it of shown) seenOff.set(it.id, (seenOff.get(it.id) || []).concat(v));
      const want = idsOf(items.filter(it => { const h = homeOf(off, it.id); return same(h, v) || !orderedToday(off, h); }));
      if (idsOf(shown) !== want) bad("a list ignores which vendors are ordered today", 'seed ' + seed + ', ' + v + ': ' + idsOf(shown) + ' vs ' + want);
    }
    for (const id of Object.keys(off.catalog.items)) {
      const today = listsOf(off, id).filter(v => orderedToday(off, v));
      if (!today.length) continue;
      const on = seenOff.get(id) || [];
      const home = homeOf(off, id);
      const should = orderedToday(off, home) ? 1 : today.length;
      if (on.length !== should) bad(on.length < should ? 'an item lost when its main vendor is off today' : 'an item on two lists',
        'seed ' + seed + ', ' + id + ' (home ' + home + '): ' + (on.join(' + ') || 'none') + ', expected ' + should);
    }

    // A day with counts, drafts and adds, some vendors off: each list's rows
    // and its bottom section; kept rows; the Today card.
    const day = makeStore(seed, false, 0.4);
    for (const v of day.catalog.vendorList) {
      use(day, true);
      const { items, shown, elsewhere } = listFor(day, v);
      const ids = new Set(shown.map(i => i.id));
      for (const c of day.counts) if (same(c.vendor, v) && !ids.has(c.id) && items.some(i => i.id === c.id)) bad('a counted row is hidden', 'seed ' + seed + ', ' + c.id + ' on ' + v);
      for (const e of elsewhere) if (ids.has(e.item.id)) bad('a row both on the list and at the bottom', 'seed ' + seed + ', ' + e.item.id + ' on ' + v);
      const want = expectSplit(day, v, items, null);
      if (idsOf(shown) !== idsOf(want.shown)) bad('a list with counts shows the wrong items', 'seed ' + seed + ', ' + v + ': ' + idsOf(shown) + ' vs ' + idsOf(want.shown));
      if (elseOf(elsewhere) !== elseOf(want.elsewhere)) bad('the bottom section is wrong', 'seed ' + seed + ', ' + v + ': ' + elseOf(elsewhere) + ' vs ' + elseOf(want.elsewhere));

      const onScreen = new Set([...ids, ...elsewhere.map(e => e.item.id)]);
      const hiddenFree = items.find(it => !onScreen.has(it.id) && !countedOnOf(day, it.id, v));
      if (hiddenFree) {
        ctx.bkKept_(v).add(hiddenFree.id);
        if (!ctx.shownItems_({ vendor: v, items }).some(i => i.id === hiddenFree.id)) bad('a kept row is hidden', 'seed ' + seed + ', ' + hiddenFree.id + ' on ' + v);
        ctx.cycle = '2026-11-04';
        if (ctx.shownItems_({ vendor: v, items }).some(i => i.id === hiddenFree.id)) bad('a kept row carried to the next day', 'seed ' + seed + ', ' + hiddenFree.id + ' on ' + v);
        ctx.cycle = CYCLE;
        ctx.bkKeptByList_.clear();
      }
      const hiddenElse = items.find(it => !onScreen.has(it.id) && countedOnOf(day, it.id, v));
      if (hiddenElse) {
        ctx.bkKept_(v).add(hiddenElse.id);
        const s = ctx.listSplit_({ vendor: v, items });
        if (s.shown.some(i => i.id === hiddenElse.id) || !s.elsewhere.some(e => e.item.id === hiddenElse.id))
          bad('a kept row counted on another list is countable here', 'seed ' + seed + ', ' + hiddenElse.id + ' on ' + v);
        ctx.bkKeptByList_.clear();
      }

      const n = ctx.shownCountFor_(v);
      if (orderedToday(day, v) && n !== shown.length) bad("the Today card's number isn't the count screen's", 'seed ' + seed + ', ' + v + ': ' + n + ' vs ' + shown.length);
    }

    // Without this phone's copy of the day (Apps Script): the main vendor's
    // list, or every list for an item with none; nothing at the bottom.
    use(day, false);
    for (const v of day.catalog.vendorList) {
      const { items, shown, elsewhere } = listFor(day, v);
      const want = idsOf(items.filter(it => {
        const main = day.catalog.items[it.id].primaryVendor;
        return !main || same(main, v) || it.todayOnly || counted(it);
      }));
      if (idsOf(shown) !== want) bad('without the catalog, a list shows the wrong items', 'seed ' + seed + ', ' + v + ': ' + idsOf(shown) + ' vs ' + want);
      if (elsewhere.length) bad('without the catalog, a bottom section', 'seed ' + seed + ', ' + v);
      if (items.some(it => ctx.backupLineFor_(it, v) !== '')) bad('without the catalog, a row names other vendors', 'seed ' + seed);
    }
    if (ctx.shownCountFor_(day.catalog.vendorList[0]) !== null) bad('the Today card counted without a copy of the day', 'seed ' + seed);
  }

  for (const p of scenario(ctx, use, listFor)) bad(p);
  return out;
}

// Sebastian's case, by hand (2026-11-10): Baby bok choy's main vendor, Chef
// Center, isn't ordered on Tuesdays; B&T, Capital and Sysco list it and are.
function scenario(ctx, use, listFor) {
  const out = [];
  const mults = on => Object.fromEntries(DAYS.map(d => [d, on || d !== TODAY ? 1 : 0]));
  const snap = {
    catalog: {
      location: 'Test', vendorList: ['Chef Center', 'B&T', 'Capital', 'Sysco'], cutoffs: {}, itemCounts: {}, backupCounts: {},
      vendorMults: { 'Chef Center': mults(false), 'B&T': mults(true), Capital: mults(true), Sysco: mults(true) },
      items: {
        BOK: { name: 'Baby bok choy', pack: 'CS', par: 2, useMult: true, primaryVendor: 'Chef Center', active: true },
        SPR: { name: 'Bean sprout', pack: 'CS', par: 1, useMult: true, primaryVendor: 'Chef Center', active: true },
        RICE: { name: 'Rice', pack: 'BAG', par: 3, useMult: true, primaryVendor: 'Sysco', active: true }
      },
      pickRows: [
        ['Chef Center', 'BOK', 'Baby bok choy', 'Walk-in', 1, 1], ['B&T', 'BOK', 'Baby bok choy', 'Walk-in', 1, 1],
        ['Capital', 'BOK', 'Baby bok choy', 'Walk-in', 1, 1], ['Sysco', 'BOK', 'Baby bok choy', 'Walk-in', 1, 1],
        ['Chef Center', 'SPR', 'Bean sprout', 'Walk-in', 1, 2], ['B&T', 'SPR', 'Bean sprout', 'Walk-in', 1, 2],
        ['Sysco', 'RICE', 'Rice', 'Dry', 2, 1], ['Capital', 'RICE', 'Rice', 'Dry', 2, 1]
      ]
    },
    state: { cycleDate: CYCLE, dayOfWeek: TODAY, emergencyOverride: false, vendorPicks: {}, todaysLog: [], todayEdits: { pars: {}, adds: [] } },
    counts: [],
    drafts: {}
  };
  const view = v => { use(snap, true); return listFor(snap, v); };
  const has = (l, id) => l.shown.some(i => i.id === id);
  const at = (l, id) => l.elsewhere.find(e => e.item.id === id);

  let l = view('B&T');
  if (!has(l, 'BOK') || !has(l, 'SPR')) out.push("scenario: Chef Center's items missing on B&T when Chef Center isn't ordered today");
  if (!has(view('Capital'), 'BOK') || !has(view('Sysco'), 'BOK')) out.push('scenario: bok choy missing on another backup ordered today');
  if (has(view('Capital'), 'RICE')) out.push("scenario: rice on Capital while its main vendor, Sysco, is ordered today");

  snap.counts = [{ vendor: 'B&T', id: 'BOK', onHand: 4 }, { vendor: 'Capital', id: 'BOK', onHand: 6 }];
  l = view('Sysco');
  const e = at(l, 'BOK');
  if (has(l, 'BOK') || !e) out.push('scenario: bok choy counted on B&T and Capital is still countable on Sysco');
  else if (e.vendor !== 'B&T' || e.onHand !== 4) out.push('scenario: the bottom names ' + e.vendor + ' (' + e.onHand + '), not the first counted list in vendor order, B&T (4)');
  if (!has(view('B&T'), 'BOK') || !has(view('Capital'), 'BOK')) out.push('scenario: a list that counted bok choy lost it');
  const sigBefore = ctx.elseSig_(l.elsewhere);

  // B&T's count cleared on this phone, not saved yet: Capital's count names it now.
  snap.drafts = { 'B&T': { BOK: null } };
  l = view('Sysco');
  if (!at(l, 'BOK') || at(l, 'BOK').vendor !== 'Capital') out.push("scenario: this phone's cleared count on B&T ignored");
  if (ctx.elseSig_(l.elsewhere) === sigBefore) out.push('scenario: the bottom section changed, its signature did not (no live redraw)');
  snap.drafts = { 'B&T': { SPR: 2 } };
  snap.counts = [];
  if (has(view('Sysco'), 'SPR')) out.push('scenario: bean sprout on Sysco, which does not list it');
  l = view('B&T');
  if (!has(l, 'SPR')) out.push("scenario: B&T's own unsaved count must not move its row");
  snap.drafts = {};

  // Counted on a backup while the main vendor is ordered: the main's list moves it down.
  snap.counts = [{ vendor: 'Capital', id: 'RICE', onHand: 5 }];
  l = view('Sysco');
  if (has(l, 'RICE') || !at(l, 'RICE') || at(l, 'RICE').vendor !== 'Capital') out.push("scenario: rice counted on Capital is still countable on its main vendor's list");
  // Counted on the main vendor: the backups don't list it at all.
  snap.counts = [{ vendor: 'Sysco', id: 'RICE', onHand: 5 }];
  l = view('Capital');
  if (has(l, 'RICE') || at(l, 'RICE')) out.push("scenario: rice counted on Sysco shows on Capital, a backup it doesn't need");
  // A count on a vendor not ordered today moves nothing; nor does one left on
  // a list that doesn't have the item (Capital has no bean sprout).
  snap.counts = [{ vendor: 'Chef Center', id: 'BOK', onHand: 3 }, { vendor: 'Capital', id: 'SPR', onHand: 3 }];
  l = view('B&T');
  if (!has(l, 'BOK')) out.push("scenario: a count on Chef Center, not ordered today, took bok choy off B&T");
  if (!has(l, 'SPR')) out.push("scenario: a count left on Capital, which doesn't list bean sprout, took it off B&T");

  // The bottom section as drawn: one header per list, the count, no count box.
  snap.counts = [{ vendor: 'B&T', id: 'BOK', onHand: 4 }, { vendor: 'B&T', id: 'SPR', onHand: 1.5 }, { vendor: 'Sysco', id: 'RICE', onHand: 2 }];
  snap.catalog.pickRows.push(['Capital', 'SPR', 'Bean sprout', 'Walk-in', 1, 2]);
  snap.catalog = Object.assign({}, snap.catalog);   // a new catalog: itemLists_ reads it again
  l = view('Capital');
  const html = ctx.elsewhereHtml_(l.elsewhere);
  if (/<input/i.test(html)) out.push('scenario: a row at the bottom has a count box');
  if ((html.match(/else-header/g) || []).length !== 1) out.push('scenario: the bottom section has ' + (html.match(/else-header/g) || []).length + ' headers for one list');
  if (html.indexOf('Counted on B&amp;T&#39;s list today') < 0) out.push('scenario: the bottom header does not name B&T: ' + html.slice(0, 160));
  if (html.indexOf('>4<') < 0 || html.indexOf('>1.5<') < 0) out.push("scenario: the bottom rows don't show B&T's counts");
  if (ctx.elsewhereHtml_([]) !== '') out.push('scenario: an empty bottom section draws something');

  // Emergency Override: every vendor is ordered today, so Chef Center keeps its items.
  snap.counts = [];
  snap.state = Object.assign({}, snap.state, { emergencyOverride: true });
  if (has(view('B&T'), 'BOK') || !has(view('Chef Center'), 'BOK')) out.push('scenario: under Emergency Override bok choy left its main vendor');
  return out;
}

let failed = 0;
const html = SRC(TEMPLATE);
const main = problems(html);
if (main.length) { failed++; console.log('FAIL  ' + main.join('\n      ')); }
else console.log('PASS  count lists on ' + STORES + ' stores: each item on one list, a main vendor off today shows on its backups, ' +
                 'whichever list counts it keeps it (the rest read-only at the bottom), drafts, kept rows for the day, the line naming ' +
                 'the other vendors, Apps Script fallback, Today card = count screen, Emergency Override');

const CONTROLS = [
  { name: 'a counted backup is hidden',
    find: "      if (it.onHand !== null && it.onHand !== '' && it.onHand !== undefined) { shown.push(it); continue; }\n",
    replace: '' },
  { name: 'a today-only add is hidden',
    find: '      const belongs = it.todayOnly || kept.has(it.id) ||',
    replace: '      const belongs = kept.has(it.id) ||' },
  { name: "a main vendor off today hides its items everywhere (the 2026-11-10 report)",
    find: '        (day !== null && !day.ordered(home));',
    replace: '        false;' },
  { name: 'a count on another list is ignored',
    find: '      const other = day !== null ? day.countedOn.get(it.id) : undefined;',
    replace: '      const other = undefined;' },
  { name: 'a count on a list not ordered today moves the item',
    find: '      if (low === here || !ordered.get(low)) continue;\n      const prev',
    replace: '      if (low === here) continue;\n      const prev' },
  { name: "a count on a list that doesn't have the item moves it",
    find: "      if (onHand === null || onHand === undefined || onHand === '' || !listed.has(k)) continue;",
    replace: "      if (onHand === null || onHand === undefined || onHand === '') continue;" },
  { name: "this phone's unsaved counts are ignored",
    find: "      for (const id of Object.keys(draft)) val.set(low + '\\u0001' + id, draft[id]);\n",
    replace: '' },
  { name: 'the bottom names the last counted list, not the first in vendor order',
    find: '      if (!prev || order.get(low) < order.get(prev.vendor.toLowerCase()))',
    replace: '      if (true)' },
  { name: 'Emergency Override ignored',
    find: '                                            inputs.emergencyOverride, inputs.vendorOverrides) > 0);',
    replace: '                                            false, inputs.vendorOverrides) > 0);' },
  { name: 'the bottom rows can be counted',
    find: "          '<span class=\"else-count\">' + escapeHtml(fmtQty_(e.onHand)) + '</span>' +",
    replace: "          '<input class=\"step-val\" value=\"' + escapeHtml(fmtQty_(e.onHand)) + '\">' +" },
  { name: 'a header for every row at the bottom',
    find: '    for (const e of elsewhere) byList.set(e.vendor, (byList.get(e.vendor) || []).concat(e));',
    replace: '    elsewhere.forEach((e, i) => byList.set(e.vendor + i, [e]));' },
  { name: 'a move to the bottom never redraws a live screen',
    find: "    return elsewhere.map(e => e.item.id + '\\u0002' + e.vendor + '\\u0002' + e.onHand).join('\\u0001');",
    replace: "    return elsewhere.map(e => e.item.id).join('\\u0001');" },
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
