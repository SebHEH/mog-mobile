'use strict';
// Seeded, randomized MOG stores for the order-math gates. Each one is built to
// hit the cases that break rewrites: blank-but-present cells, numeric strings,
// junk, duplicates, case variants, missing and empty tabs, a date typed where
// a number belongs, Emergency Override on and off. A failure names its seed.

const { D } = require('./fake_apps_script.js');

const VENDOR_POOL = ['Sysco', "Murray's Chicken", 'B&T', 'Chef Center', 'Amazon', 'Webstaurant',
  'TNY Warehouse', 'Restaurant Depot'];
const ITEM_IDS = Array.from({ length: 25 }, (_, i) => 'ITEM-' + String(i + 1).padStart(3, '0'));
const DAY_MS = 86400000;

function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function set(rows, r1, c1, v) {
  while (rows.length < r1) rows.push([]);
  rows[r1 - 1][c1 - 1] = v;
}

// opts.realistic: what a healthy live store looks like (no case-variant or
// blank vendor-list rows, every vendor has a tab). opts.tabs === false: leave
// the vendor tabs out (the phone-parity gate builds them from the pick path).
function makeStore(seed, opts) {
  opts = opts || {};
  const r = mulberry32(seed);
  const pick = arr => arr[Math.floor(r() * arr.length)];
  const chance = p => r() < p;
  const int = (lo, hi) => lo + Math.floor(r() * (hi - lo + 1));
  const shuffle = arr => {
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
    return a;
  };
  const coverage = {};
  const mark = k => { coverage[k] = (coverage[k] || 0) + 1; };

  // "today": a day in October 2026, so every weekday turns up across seeds.
  const today = Date.UTC(2026, 9, 1 + int(0, 27));
  const now = today + int(8, 20) * 3600000;
  const ymd = ms => new Date(ms).toISOString().slice(0, 10);

  // ---- SETUP: vendor table (R, S:Y, Z, AA, AF) and pick path DB (K:P) ----
  const vendors = shuffle(VENDOR_POOL).slice(0, int(0, 6));
  const zRows = vendors.slice();
  if (!opts.realistic) {
    if (vendors.length && chance(0.2)) { zRows.splice(int(0, zRows.length), 0, pick(vendors)); mark('duplicate vendor-list row'); }
    if (vendors.length && chance(0.15)) { zRows.splice(int(0, zRows.length), 0, pick(vendors).toUpperCase()); mark('case-variant vendor-list row'); }
    if (chance(0.2)) { zRows.splice(int(0, zRows.length), 0, ''); mark('blank vendor-list row'); }
  }
  const MULTS = [0, 0, 0, 1, 1, 1, 2, 3, 1.5, '2', '', 'x', 4];
  const CUTOFFS = ['', '', '10:00', '17:00', '9:05', '12:30 pm', '8:00 AM', 'junk', D(Date.UTC(1899, 11, 30, 10, 30))];
  const PICKS = ['', '', '', '', 0, 3, '2', 'x', 9, -1, 1];

  const setup = [];
  ['', '', '', '', '', '', '', 'Storage Area', 'Area Order', '', 'Vendor', 'Item ID', 'Item Name', 'Storage Area',
    'Area Order', 'Shelf Order', '', 'Vendor', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun', 'VENDOR LIST', '']
    .forEach((h, i) => set(setup, 1, i + 1, h));
  zRows.forEach((v, i) => {
    const row = i + 2;
    set(setup, row, 18, v);
    for (let d = 0; d < 7; d++) set(setup, row, 19 + d, pick(MULTS));
    set(setup, row, 26, v);
    const cutoff = pick(CUTOFFS);
    set(setup, row, 27, cutoff);
    if (cutoff) mark('vendor with a cutoff');
    const pk = pick(PICKS);
    set(setup, row, 32, pk);
    if (pk !== '' && Number(pk) > 0) mark('per-vendor day pick');
  });

  // ---- MASTER_ITEMS ----
  const PARS = [1, 2, 3, 0.33, 1.1, 2.2, 4.2, 0.5, 0, '', 'abc', '3', 1.75, 10, 1.2];
  const master = [['Item ID', 'Item Name', 'Vendor', 'Vendor SKU', 'Pack / Unit', 'Category', 'Base Par Qty',
    'Base Par Unit', 'On Hand', 'Target Par Today', 'Suggested Order Qty', 'Active', 'Use Multiplier', 'Notes',
    'Eligible Vendors']];
  const seenIds = new Set();
  for (let i = 0, n = int(0, 30); i < n; i++) {
    const id = chance(0.05) ? '' : pick(ITEM_IDS);
    if (id && seenIds.has(id)) mark('duplicate item id in MASTER_ITEMS');
    if (id) seenIds.add(id);
    const name = chance(0.08) ? '' : (chance(0.1) ? '  Item ' + id + ' ' : 'Item ' + id);
    let primary = vendors.length ? pick(vendors) : '';
    if (chance(0.1)) primary = primary.toLowerCase();
    if (chance(0.05)) primary = 'Old Vendor';
    if (chance(0.05)) primary = '';
    const par = pick(PARS);
    if (par === 'abc') mark('non-numeric par');
    master.push([id, name, primary, '', pick(['CS', 'PACK (3)', 'EA', '']), '', par, '', '', '', '',
      pick([true, true, true, false, 'TRUE']), pick([true, true, true, false, 'FALSE', 'false', '', 1, 'TRUE']), '', primary]);
  }
  const masterIds = master.slice(1).map(row => row[0]).filter(Boolean);

  const AREAS = ['Walk-in', 'Dry Storage', 'Freezer', '', '  Entrance Shelf '];
  const AREA_ORDERS = [10, 20, 30, '', 'x', 5.5, D(today), true, 10, 20];
  const SHELF_ORDERS = [10, 20, 30, 40, '', 15, 'y', 10];
  for (let i = 0, n = int(0, 40); i < n; i++) {
    let v = vendors.length ? pick(vendors) : 'Ghost';
    if (chance(0.08)) { v = v.toUpperCase(); mark('case-variant pick-path vendor'); }
    if (chance(0.05)) { v = v + ' '; mark('trailing-space pick-path vendor'); }
    if (chance(0.03)) v = 'Unknown Vendor';
    let id;
    if (masterIds.length && chance(0.9)) id = pick(masterIds);
    else id = chance(0.5) ? 'ITEM-099' : '';
    if (chance(0.05) && id) { id = ' ' + id + ' '; mark('padded item id in pick path'); }
    const areaOrder = pick(AREA_ORDERS);
    if (areaOrder && areaOrder.__date) mark('date typed into area order');
    const row = i + 2;
    set(setup, row, 11, v);
    set(setup, row, 12, id);
    set(setup, row, 13, 'name');
    set(setup, row, 14, pick(AREAS));
    set(setup, row, 15, areaOrder);
    set(setup, row, 16, pick(SHELF_ORDERS));
  }

  // ---- ORDER_ENTRY: override (AD2), today (AE2), last reset (AE9) ----
  const orderEntry = [];
  const override = pick([false, false, false, true, 'TRUE']);
  if (override === true) mark('Emergency Override on');
  set(orderEntry, 2, 30, override);
  set(orderEntry, 2, 31, D(today));
  const ae9 = pick([D(today), D(today), D(today - DAY_MS), '', 'junk']);
  set(orderEntry, 9, 31, ae9);
  const activeMs = (ae9 && ae9.__date) ? ae9.__date : today;

  // ---- LOG_ORDERS ----
  const log = [['Timestamp', 'Order Date', 'Vendor', 'Item ID', 'Item Name', 'On Hand (Prev)', 'Qty Ordered']];
  for (let i = 0, n = int(0, 8); i < n; i++) {
    const v = vendors.length ? pick(vendors) : 'Ghost';
    const dateCell = pick([D(activeMs), ymd(activeMs), D(activeMs - DAY_MS), ymd(activeMs) + ' 07:00']);
    if (dateCell === ymd(activeMs) || (dateCell.__date === activeMs)) mark('order logged this cycle');
    log.push([pick([D(activeMs + int(6, 20) * 3600000), ymd(activeMs) + ' 09:15:00']), dateCell, v,
      pick(ITEM_IDS), 'name', int(0, 5), int(1, 4)]);
  }

  const sheets = { MASTER_ITEMS: master, SETUP: setup, ORDER_ENTRY: orderEntry, LOG_ORDERS: log };

  // ---- Vendor tabs: arbitrary rosters (the old/new gate reads them as-is) ----
  if (opts.tabs !== false) {
    const ON_HAND = [3, 0, 1.5, '', '', '', 'abc', '2', -1, 7, 0.25, 4.2];
    for (const v of vendors) {
      if (!opts.realistic && chance(0.1)) { mark('vendor with no tab'); continue; }
      const tab = [['Store', v], ['Item', 'Pack', 'SKU', 'Par', 'On Hand', 'Order', '', 'Multiplier']];
      if (!opts.realistic && chance(0.1)) { mark('tab with no data rows'); sheets[v] = tab; continue; }
      for (let i = 0, n = int(0, 12); i < n; i++) {
        let id = (masterIds.length && chance(0.85)) ? pick(masterIds) : pick(['', 'ITEM-099', ' ITEM-003 ']);
        const onHand = pick(ON_HAND);
        if (onHand === 'abc') mark('junk On Hand');
        const row = [];
        row[0] = 'name'; row[4] = onHand; row[12] = id;
        tab.push(row);
      }
      sheets[v] = tab;
    }
  }

  const scriptProps = {};
  if (chance(0.9)) scriptProps.MOG_LOCATION_NAME = 'Test Store ' + seed;
  if (chance(0.9)) scriptProps.MOG_LOCATION_ABBR = 'TS' + (seed % 100);
  if (chance(0.8)) scriptProps.MOG_CONCEPT = pick(['roll-play', 'teasnyou']);

  return { seed, now, sheets, scriptProps, vendors, coverage, pickRnd: r };
}

module.exports = { makeStore, mulberry32, ITEM_IDS };
