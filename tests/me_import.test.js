'use strict';
// GATE: Import from MarginEdge (template/editor/meImport.js, and catalogEdit.js
// commitImportItems: the Supabase editor's own call, with no Items.gs twin).
//   - the CSV reader: quotes, "" inside quotes, commas and line breaks inside
//     quotes, CRLF, a byte-order mark, blank lines; the Vendor Items columns;
//     the Purchase Report, a file with a missing column and an empty file are
//     refused with a reason in both languages
//   - what starts ticked: not in the store yet (by name or item code), a
//     restocked category, bought in the file's last 60 days
//   - each product's vendors: the most recent purchase is the primary (then
//     MarginEdge's Order Guide flag, then the file's order); skipped vendors
//     drop out; two MarginEdge vendors given one name merge; a new name that
//     matches a store vendor is that vendor
//   - what keeps the Import button off: blank, too long, repeated or
//     already-there names; a new vendor with no name or a name too long
//   - step 1 adds every ticked new vendor, with items or not, and only those
//   - the write, on random stores and random files: every ticked product
//     becomes one item at the end of the list with the next IDs, no par, no
//     pack and no storage area, its vendors as worked out independently here;
//     new vendors have no delivery days; no existing row changes; the tables
//     keep every database rule; Undo restores them exactly; the same import
//     twice is refused; whatever the screen allows, the write accepts
// Planted-defect controls in both files must each be caught.
//
// Run bare: node tests/me_import.test.js [stores]   (default 300)
// A passing run ends with "me_import: ALL PASS".

const vm = require('vm');
const F = require('./fake_apps_script.js');
const { mulberry32 } = require('./mog_fixture.js');
const { checkCatalogTables } = require('./fake_supabase.js');

const STORES = Number(process.argv[2]) || 300;
const CE_FILE = 'template/editor/catalogEdit.js';
const MI_FILE = 'template/editor/meImport.js';
const SRC = file => F.source(null, file);
const clone = x => JSON.parse(JSON.stringify(x));
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const HEAD = '"Vendor","Vendor Item Name","Product","Category","Item Code","Last Purch Date","Last Purch $","Order Guide"';
const q = v => '"' + String(v).replace(/"/g, '""') + '"';
const csvOf = rows => [HEAD].concat(rows.map(r => r.map(q).join(','))).join('\r\n') + '\r\n';

function load(ceText, miText) {
  const ctx = { console };
  vm.createContext(ctx);
  vm.runInContext(ceText, ctx, { filename: CE_FILE });
  vm.runInContext(miText, ctx, { filename: MI_FILE });
  return { CE: ctx.CatalogEdit, MI: ctx.MeImport };
}

function thrown(fn) {
  try { fn(); } catch (e) { return e; }
  return null;
}

// ---- Fixed cases ----------------------------------------------------------------

function fixedChecks(L, fail) {
  const { CE, MI } = L;
  const expect = (what, got, want) => { if (!same(got, want)) fail(what + ': got ' + JSON.stringify(got) + ', want ' + JSON.stringify(want)); };

  expect('csv', MI.parseCsv('﻿a,"b,c","say ""hi""","two\nlines"\r\n\r\nx,,y\n'),
         [['a', 'b,c', 'say "hi"', 'two\nlines'], ['x', '', 'y']]);

  const text = csvOf([
    ['Sysco', 'Butter 36/1#', 'Butter, Unsalted', 'Dairy', '111', '2026-10-01', '10', 'Yes'],
    ['Chefs Warehouse', 'Unsalted Butter', 'Butter, Unsalted', 'Dairy', '222', '2026-10-05', '9', 'Yes'],
    ['Amazon.com', 'Mop heads, 12 pack', '', 'Cleaning Supplies', '', '2026-09-01', '', 'No'],
    ['Cintas', 'Mat rental', 'Mat rental', 'Linen and Linen Rental', 'X1', '', '', ''],
    ['Webstaurant Store', 'Ice scoop', 'Scoop, Ice', 'Kitchen Utensils and Supplies', 'S1', 'not a date', '5', 'Yes'],
    ['Food Lion', 'Lemons', 'Lemons', 'Produce', '', '2026-07-01', '', ''],
    ['Elpis Wholesale', '16oz cup', 'Cup 16oz', 'Paper and Packaging', 'C16', '2026-10-02', '', 'No'],
    ['Webstaurant Store', 'Cup 16oz 1000ct', 'Cup 16oz', 'Paper and Packaging', 'W16', '2026-10-02', '', 'Yes'],
    ['Webstaurant Store', 'Prep table 30x48', 'Table, Prep', 'Small Equipment/Furniture (<$2,500)', 'T1', '2026-10-03', '300', 'Yes']
  ]);
  const file = MI.readVendorItems(text);
  expect('products', file.products.map(p => p.name), ['Butter, Unsalted', 'Cup 16oz', 'Lemons', 'Mat rental', 'Mop heads, 12 pack', 'Scoop, Ice', 'Table, Prep']);
  expect('vendors', file.vendors, ['Amazon.com', 'Chefs Warehouse', 'Cintas', 'Elpis Wholesale', 'Food Lion', 'Sysco', 'Webstaurant Store']);
  expect('newest', file.newest, '2026-10-05');
  expect('butter sources', file.products[0].sources.map(s => [s.vendor, s.code, s.last, s.orderGuide]),
         [['Sysco', '111', '2026-10-01', true], ['Chefs Warehouse', '222', '2026-10-05', true]]);
  expect('a bad date is no date', file.products[5].sources[0].last, '');

  const refusals = [
    ['the Purchase Report', '"Restaurant","Product","","Category","Report By","Purchased Units"\n"TNY","Eggs","Food","Dairy","Dozen","3"\n', /Purchase Report/],
    ['a missing column', HEAD.replace('"Item Code",', '') + '\n"Sysco","a","b","Dairy","2026-10-01","1","Yes"\n', /no "Item Code" column/],
    ['an empty file', '', /empty/],
    ['a header alone', HEAD + '\n', /No items/]
  ];
  for (const [what, t, re] of refusals) {
    const e = thrown(() => MI.readVendorItems(t));
    if (!e || !re.test(e.message) || !e.es) fail('refuses ' + what + ': ' + (e ? e.message + ' / ' + e.es : 'accepted'));
  }

  const tables = {
    vendors: [{ name: 'SYSCO', mults: [1, 1, 1, 1, 1, 1, 1], cutoff: null }],
    areas: [{ name: 'Walk-in', ord: 10 }],
    items: [
      { id: 'ITEM-0004', name: 'scoop, ice', primaryVendor: 'SYSCO', pack: 'EA', par: 1, active: true, useMult: true, notes: '', sku: '', category: '', eligible: ['SYSCO'], seq: 2 },
      { id: 'ITEM-0009', name: 'Old butter', primaryVendor: 'SYSCO', pack: 'CS', par: 2, active: true, useMult: true, notes: '', sku: '222', category: '', eligible: ['SYSCO'], seq: 5 }
    ],
    pickRows: [{ vendor: 'SYSCO', id: 'ITEM-0004', area: 'Walk-in', shelfOrder: 10, seq: 1 }]
  };
  const st = MI.plan(file, tables);
  expect('since', st.since, '2026-08-06');
  const by = name => st.products.find(p => p.name === name);
  expect('ticked', st.products.filter(p => p.pick).map(p => p.name), ['Cup 16oz', 'Mop heads, 12 pack']);
  expect('in the store', st.products.map(p => p.inStore), ['sku', '', '', '', '', 'name', '']);
  expect('vendor match ignores case', st.vendors.find(v => v.me === 'Sysco').target, 'SYSCO');

  const known = MI.storeVendors(tables);
  const vend = name => st.vendors.find(v => v.me === name);
  expect('vendors ticked: in the store, or selling a ticked product', st.vendors.map(v => v.me + ':' + v.use),
         ['Amazon.com:true', 'Chefs Warehouse:false', 'Cintas:false', 'Elpis Wholesale:true', 'Food Lion:false', 'Sysco:true', 'Webstaurant Store:true']);
  vend('Chefs Warehouse').use = true;
  expect('latest purchase is primary', clone(MI.resolve(st, known, by('Butter, Unsalted'))),
         { primary: 'Chefs Warehouse', eligible: ['Chefs Warehouse', 'SYSCO'], sku: '222' });
  expect('same day: Order Guide first', clone(MI.resolve(st, known, by('Cup 16oz'))),
         { primary: 'Webstaurant Store', eligible: ['Webstaurant Store', 'Elpis Wholesale'], sku: 'W16' });
  vend('Chefs Warehouse').target = 'SYSCO';
  expect('two vendors mapped to one merge', clone(MI.resolve(st, known, by('Butter, Unsalted'))),
         { primary: 'SYSCO', eligible: ['SYSCO'], sku: '222' });
  vend('Chefs Warehouse').target = '';
  vend('Chefs Warehouse').newName = '  sysco ';
  expect('a new name matching a store vendor is that vendor', clone(MI.resolve(st, known, by('Butter, Unsalted'))).eligible, ['SYSCO']);
  vend('Chefs Warehouse').newName = 'Chefs Warehouse';
  vend('Chefs Warehouse').use = false;
  expect('a skipped vendor drops out', clone(MI.resolve(st, known, by('Butter, Unsalted'))), { primary: 'SYSCO', eligible: ['SYSCO'], sku: '111' });
  vend('Sysco').use = false;
  expect('every vendor skipped', MI.resolve(st, known, by('Butter, Unsalted')).primary, null);
  vend('Sysco').use = true;

  // What keeps the Import button off.
  const errs = mut => { const s = clone(st); mut(s); return MI.payloadOf(s, tables).errors.map(e => e.en).join(' | '); };
  const blocks = [
    ['an item already in the store', s => { s.products[5].pick = true; }, /already in the catalog/],
    ['a blank name', s => { s.products[4].name = '  '; }, /has no name/],
    ['a repeated name', s => { s.products[4].name = 'cup 16OZ'; }, /Two items are called/],
    ['a name too long', s => { s.products[4].name = 'x'.repeat(301); }, /longer than 300/],
    ['a new vendor with no name', s => { s.vendors.find(v => v.me === 'Amazon.com').newName = ' '; }, /needs a name/],
    ['a vendor name too long', s => { s.vendors.find(v => v.me === 'Amazon.com').newName = 'v'.repeat(101); }, /longer than 100/]
  ];
  for (const [what, mut, re] of blocks) if (!re.test(errs(mut))) fail('blocks ' + what + ': ' + JSON.stringify(errs(mut)));
  if (errs(() => {})) fail('the starting choices are blocked: ' + errs(() => {}));

  // The write.
  const out = MI.payloadOf(st, tables);
  expect('payload', clone(out.payload), {
    newVendors: ['Amazon.com', 'Elpis Wholesale', 'Webstaurant Store'],
    items: [
      { name: 'Cup 16oz', primaryVendor: 'Webstaurant Store', eligible: ['Webstaurant Store', 'Elpis Wholesale'], sku: 'W16', category: 'Paper and Packaging' },
      { name: 'Mop heads, 12 pack', primaryVendor: 'Amazon.com', eligible: ['Amazon.com'], sku: '', category: 'Cleaning Supplies' }
    ]
  });
  const r = CE.call(tables, 'commitImportItems', [out.payload]);
  expect('result', clone(r.result), { ok: true, vendorsAdded: ['Amazon.com', 'Elpis Wholesale', 'Webstaurant Store'], itemsAdded: 2, skipped: [] });
  expect('label', r.label, 'Imported 2 items from MarginEdge and added 3 vendors (Amazon.com, Elpis Wholesale, Webstaurant Store)');
  const noItems = clone(st);
  noItems.products.forEach(p => { p.pick = false; });
  expect('a ticked vendor is added with no items', clone(MI.payloadOf(noItems, tables).payload),
         { newVendors: ['Amazon.com', 'Elpis Wholesale', 'Webstaurant Store'], items: [] });
  expect('vendors only: the label', CE.call(tables, 'commitImportItems', [{ newVendors: ['Elpis'], items: [] }]).label,
         'Added 1 vendor (Elpis) from MarginEdge');
  const after = CE.applyOps(tables, r.ops);
  expect('new items', clone(after.items.slice(2)), [
    { id: 'ITEM-0010', name: 'Cup 16oz', primaryVendor: 'Webstaurant Store', pack: '', par: null, active: true, useMult: true, notes: '',
      sku: 'W16', category: 'Paper and Packaging', eligible: ['Webstaurant Store', 'Elpis Wholesale'], seq: 6 },
    { id: 'ITEM-0011', name: 'Mop heads, 12 pack', primaryVendor: 'Amazon.com', pack: '', par: null, active: true, useMult: true, notes: '',
      sku: '', category: 'Cleaning Supplies', eligible: ['Amazon.com'], seq: 7 }
  ]);
  expect('new vendor', clone(after.vendors.find(v => v.name === 'Amazon.com')), { name: 'Amazon.com', mults: [0, 0, 0, 0, 0, 0, 0], cutoff: null });

  // The write's own refusals and skips.
  const call = payload => thrown(() => CE.call(tables, 'commitImportItems', [payload]));
  const refused = [
    ['an unknown vendor', { items: [{ name: 'A', primaryVendor: 'Nobody', eligible: [] }] }, /not in SETUP vendor table/],
    ['an unknown backup vendor', { items: [{ name: 'A', primaryVendor: 'SYSCO', eligible: ['Nobody'] }] }, /not in SETUP vendor table/],
    ['a vendor that exists', { newVendors: ['sysco'], items: [] }, /already exists/],
    ['a blank vendor', { newVendors: [' '], items: [] }, /Vendor name is required/],
    ['a blank item', { items: [{ name: ' ', primaryVendor: 'SYSCO' }] }, /Item Name is required/],
    ['an item name too long', { items: [{ name: 'x'.repeat(301), primaryVendor: 'SYSCO' }] }, /longer than 300/]
  ];
  for (const [what, payload, re] of refused) {
    const e = call(payload);
    if (!e || !re.test(e.message)) fail('the write refuses ' + what + ': ' + (e ? e.message : 'accepted'));
  }
  const skip = CE.call(tables, 'commitImportItems', [{ items: [{ name: 'OLD BUTTER', primaryVendor: 'SYSCO' }, { name: 'Tea', primaryVendor: 'sysco' },
                                                              { name: 'tea', primaryVendor: 'SYSCO' }] }]);
  expect('skips', clone(skip.result), { ok: true, vendorsAdded: [], itemsAdded: 1,
    skipped: [{ name: 'OLD BUTTER', reason: 'already in the catalog' }, { name: 'tea', reason: 'already in the catalog' }] });
  expect('vendor names come out canonical', CE.applyOps(tables, skip.ops).items[2].primaryVendor, 'SYSCO');
  const order = CE.call(tables, 'commitImportItems', [{ newVendors: ['Elpis'], items: [
    { name: 'Lime', primaryVendor: 'SYSCO', eligible: ['Elpis'] }, { name: 'Lid', primaryVendor: 'Elpis', eligible: ['sysco', 'elpis'] }] }]);
  expect('the primary is always first in its vendors', CE.applyOps(tables, order.ops).items.slice(2).map(it => it.eligible),
         [['SYSCO', 'Elpis'], ['Elpis', 'SYSCO']]);
  expect('nothing new, nothing written', CE.call(tables, 'commitImportItems', [{ items: [{ name: 'Old Butter', primaryVendor: 'SYSCO' }] }]).ops.length, 0);
}

// ---- Random stores and random files -----------------------------------------------

const POOL = ['Butter, Unsalted', 'Cream Cheese', 'Lemons', 'Cup 16oz', 'Lid 16oz', 'Straws', 'Tapioca Pearls', 'Milk, Oat',
              'Sugar', 'Gloves L', 'Mop Heads', 'Ice Scoop', 'Jasmine Tea', 'Napkins', 'Fries', 'Chicken Thigh'];
const CATS = ['Dairy', 'Produce', 'Paper and Packaging', 'NA Beverages', 'Cleaning Supplies', 'Kitchen Utensils and Supplies',
              'Office Printing and Supplies', 'Linen and Linen Rental', 'Small Equipment/Furniture (<$2,500)', 'Repairs and Maintenance', ''];
const ME_VENDORS = ['Sysco', 'chef center', 'Webstaurant Store', 'Amazon.com', 'Elpis Wholesale', 'Cintas', 'Food Lion', 'B&T Distributors LLC'];

function randomStore(rnd) {
  const pick = a => a[Math.floor(rnd() * a.length)];
  const names = ['Sysco', 'Chef Center', 'Amazon', 'B&T', 'Restaurant Depot'].filter(() => rnd() < 0.6);
  if (!names.length) names.push('Sysco');
  const vendors = names.map(n => ({ name: n, mults: [1, 0, 1, 0, 1, 0, 0], cutoff: rnd() < 0.5 ? '10:00' : null }));
  const areas = [{ name: 'Walk-in', ord: 10 }, { name: 'Dry', ord: 20 }];
  const items = [], pickRows = [];
  let seq = 1 + Math.floor(rnd() * 3);
  const n = Math.floor(rnd() * 12);
  for (let i = 0; i < n; i++) {
    const v = pick(names);
    const id = rnd() < 0.85 ? 'ITEM-' + String(3 * i + 1 + Math.floor(rnd() * 3)).padStart(4, '0') : 'X-' + i;
    const name = rnd() < 0.5 ? pick(POOL) : 'Store thing ' + i;
    items.push({ id: id, name: rnd() < 0.3 ? name.toLowerCase() : name, primaryVendor: v, pack: 'CS', par: 1 + i, active: rnd() < 0.9,
                 useMult: true, notes: '', sku: rnd() < 0.4 ? 'C' + Math.floor(rnd() * 20) : '', category: '', eligible: [v], seq: seq });
    seq += 1 + Math.floor(rnd() * 3);
    if (rnd() < 0.7) pickRows.push({ vendor: v, id: id, area: pick(areas).name, shelfOrder: 10 * (i + 1), seq: i + 1 });
  }
  return checkCatalogTables({ vendors, areas, items, pickRows });
}

function randomFile(rnd) {
  const pick = a => a[Math.floor(rnd() * a.length)];
  const rows = [];
  const products = POOL.filter(() => rnd() < 0.6).concat(['Thing A', 'Thing B', 'thing a'].filter(() => rnd() < 0.5));
  for (const p of products) {
    const k = 1 + Math.floor(rnd() * 3);
    const cat = pick(CATS);
    for (let j = 0; j < k; j++) {
      const day = Math.floor(rnd() * 120);
      const d = new Date(Date.UTC(2026, 9, 17 - day)).toISOString().substring(0, 10);
      rows.push([pick(ME_VENDORS), p + ' (vendor item ' + j + ')', rnd() < 0.1 ? '' : p, cat,
                 rnd() < 0.3 ? 'C' + Math.floor(rnd() * 20) : rnd() < 0.5 ? '' : 'Z' + Math.floor(rnd() * 1000),
                 rnd() < 0.1 ? '' : d, String(Math.round(rnd() * 5000) / 100), rnd() < 0.7 ? 'Yes' : 'No']);
    }
  }
  if (!rows.length) rows.push(['Sysco', 'Salt', 'Salt', 'Produce', '', '2026-10-17', '1', 'Yes']);
  return csvOf(rows);
}

// A product's primary vendor, worked out here apart from meImport.js: a scan
// for the latest purchase (Order Guide breaks a tie, then the file's order).
function expectVendors(st, storeNames, p) {
  const tgt = s => {
    const v = st.vendors.find(x => x.me === s.vendor);
    if (!v.use) return null;
    if (v.target) return v.target;
    const n = v.newName.trim();
    if (!n) return null;
    return storeNames.find(x => x.toLowerCase() === n.toLowerCase()) || n;
  };
  let best = null;
  const all = new Set();
  for (const s of p.sources) {
    const t = tgt(s);
    if (!t) continue;
    all.add(t.toLowerCase());
    if (!best || s.last > best.s.last || (s.last === best.s.last && s.orderGuide && !best.s.orderGuide)) best = { s: s, t: t };
  }
  return best ? { primary: best.t, all: all } : null;
}

function randomChecks(L, stores, fail, stats) {
  const { CE, MI } = L;
  for (let seed = 1; seed <= stores; seed++) {
    const rnd = mulberry32(seed * 7919);
    const pick = a => a[Math.floor(rnd() * a.length)];
    const tables = randomStore(rnd);
    const st = MI.plan(MI.readVendorItems(randomFile(rnd)), tables);
    const storeNames = tables.vendors.map(v => v.name);
    for (const v of st.vendors) {
      const k = rnd();
      if (k < 0.12) v.use = false;
      else if (k < 0.3) v.target = pick(storeNames);
      else if (k < 0.45) { v.target = ''; v.newName = pick(['Merged Vendor', 'merged vendor', storeNames[0].toLowerCase(), ' Padded ', '']); }
    }
    for (const p of st.products) {
      if (rnd() < 0.2) p.pick = !p.pick;
      if (rnd() < 0.06) p.name = pick(['', 'Renamed', 'renamed', '  Spaced  ', 'x'.repeat(301)]);
    }
    const out = MI.payloadOf(st, tables);
    if (out.errors.length) { stats.blocked++; continue; }
    if (!out.payload.items.length && !out.payload.newVendors.length) { stats.empty++; continue; }

    const r = thrown(() => CE.call(tables, 'commitImportItems', [out.payload])) || CE.call(tables, 'commitImportItems', [out.payload]);
    if (r instanceof Error) { fail('seed ' + seed + ': the screen allowed what the write refuses: ' + r.message); continue; }
    stats.imports++;
    stats.items += r.result.itemsAdded;
    stats.vendors += r.result.vendorsAdded.length;
    if (r.result.itemsAdded !== out.payload.items.length || r.result.skipped.length) {
      fail('seed ' + seed + ': ' + r.result.itemsAdded + ' of ' + out.payload.items.length + ' imported, skipped ' + JSON.stringify(r.result.skipped));
    }
    const after = CE.applyOps(tables, r.ops);
    const dbErr = thrown(() => checkCatalogTables(after));
    if (dbErr) { fail('seed ' + seed + ': breaks a database rule: ' + dbErr.message); continue; }

    // No existing row changed.
    for (const t of ['vendors', 'areas', 'items', 'pickRows']) {
      const key = row => (t === 'items' ? row.id : t === 'pickRows' ? row.vendor + '|' + row.id : row.name);
      const now = new Map(after[t].map(x => [key(x), x]));
      for (const old of tables[t]) if (!same(now.get(key(old)), old)) fail('seed ' + seed + ': ' + t + ' ' + key(old) + ' changed');
    }
    if (after.pickRows.length !== tables.pickRows.length) fail('seed ' + seed + ': the import put items on a list');

    // The new vendors: every ticked new one (named, not already in the store,
    // once ignoring case), with no delivery days.
    const expNew = [];
    for (const v of st.vendors) {
      if (!v.use || v.target) continue;
      const n = v.newName.trim();
      if (n && !storeNames.some(x => x.toLowerCase() === n.toLowerCase()) && !expNew.some(x => x.toLowerCase() === n.toLowerCase())) expNew.push(n);
    }
    if (!same(clone(r.result.vendorsAdded), expNew)) fail('seed ' + seed + ': vendors added ' + JSON.stringify(r.result.vendorsAdded) + ', want ' + JSON.stringify(expNew));
    const newV = after.vendors.slice(tables.vendors.length);
    if (!same(newV.map(v => v.name), clone(r.result.vendorsAdded)) || newV.some(v => !same(v.mults, [0, 0, 0, 0, 0, 0, 0]) || v.cutoff !== null)) {
      fail('seed ' + seed + ': new vendors ' + JSON.stringify(newV));
    }

    // The new items: the next IDs, at the end, blank, their vendors as expected.
    let maxN = 0;
    for (const it of tables.items) { const m = /^ITEM-(\d+)$/.exec(it.id); if (m) maxN = Math.max(maxN, Number(m[1])); }
    const maxSeq = Math.max(0, ...tables.items.map(it => it.seq));
    const added = after.items.slice(tables.items.length);
    const ticked = st.products.filter(p => p.pick && expectVendors(st, storeNames, p));
    if (added.length !== ticked.length) fail('seed ' + seed + ': ' + added.length + ' items for ' + ticked.length + ' ticked products');
    added.forEach((it, k) => {
      const p = ticked[k];
      const want = p && expectVendors(st, storeNames, p);
      const where = 'seed ' + seed + ' item ' + it.id + ': ';
      if (it.id !== 'ITEM-' + String(maxN + 1 + k).padStart(4, '0')) fail(where + 'not the next ID');
      if (it.seq !== maxSeq + 1 + k) fail(where + 'seq ' + it.seq + ', not at the end (' + (maxSeq + 1 + k) + ')');
      if (it.par !== null || it.pack !== '' || it.active !== true || it.useMult !== true || it.notes !== '') fail(where + 'not blank: ' + JSON.stringify(it));
      if (!p || it.name !== p.name.trim() || it.category !== p.category) fail(where + 'name/category ' + JSON.stringify([it.name, it.category]));
      if (want && it.primaryVendor.toLowerCase() !== want.primary.toLowerCase()) fail(where + 'primary ' + it.primaryVendor + ', want ' + want.primary);
      if (it.eligible[0] !== it.primaryVendor) fail(where + 'the primary is not first in its vendors');
      if (want && !same([...new Set(it.eligible.map(v => v.toLowerCase()))].sort(), [...want.all].sort())) {
        fail(where + 'vendors ' + JSON.stringify(it.eligible) + ', want ' + JSON.stringify([...want.all]));
      }
    });

    // Undo, and the same import twice.
    if (!same(CE.applyOps(after, CE.inverseOps(r.ops)), tables)) fail('seed ' + seed + ': undo does not restore the tables');
    else stats.undos++;
    const twice = thrown(() => CE.applyOps(after, r.ops));
    if (!twice || !/CONFLICT/.test(twice.message)) fail('seed ' + seed + ': the same import applied twice');
  }
}

function runSuite(ceText, miText, stores) {
  const failures = [];
  const stats = { imports: 0, items: 0, vendors: 0, blocked: 0, empty: 0, undos: 0 };
  let L;
  try { L = load(ceText, miText); } catch (e) { return { failures: ['load: ' + e.message], stats }; }
  const fail = m => failures.push(m);
  try { fixedChecks(L, fail); } catch (e) { fail('fixed checks crashed: ' + e.message); }
  try { randomChecks(L, stores, fail, stats); } catch (e) { fail('random checks crashed: ' + e.message); }
  return { failures, stats };
}

const CONTROLS = [
  { file: 'ce', name: 'a repeated name is imported twice', find: '      taken.add(name.toLowerCase());\n      maxN++;', replace: '      maxN++;' },
  { file: 'ce', name: 'a new vendor orders every day',
    find: 'w.vendors.push({ name: name, mults: [0, 0, 0, 0, 0, 0, 0], cutoff: null });',
    replace: 'w.vendors.push({ name: name, mults: [1, 1, 1, 1, 1, 1, 1], cutoff: null });' },
  { file: 'ce', name: 'new items go to the top of the list', find: '      seq++;\n', replace: '      seq = 1;\n' },
  { file: 'ce', name: 'an imported item gets a par', find: "pack: '', par: null,", replace: "pack: '', par: 0," },
  { file: 'ce', name: 'the primary drops out of the vendors', find: '      const eligible = [primary];', replace: '      const eligible = [];' },
  { file: 'ce', name: 'a quoted comma splits the field', find: "        if (c !== '\"') field += c;",
    replace: "        if (c === ',') { row.push(field); field = ''; } else if (c !== '\"') field += c;" },
  { file: 'mi', name: 'the oldest purchase becomes the primary', find: 'a.s.last > b.s.last ? -1 : 1', replace: 'a.s.last > b.s.last ? 1 : -1' },
  { file: 'mi', name: 'equipment starts ticked', find: '!NOT_STOCK.test(p.category) && ', replace: '' },
  { file: 'mi', name: 'an item already in the store starts ticked', find: 'pick: !inStore && ', replace: 'pick: ' },
  { file: 'mi', name: 'a repeated name passes', find: '      else if (seen.has(low))', replace: '      else if (false)' },
  { file: 'mi', name: 'an unticked vendor is still added', find: '      if (!v.use || v.target) continue;', replace: '      if (v.target) continue;' },
  { file: 'mi', name: 'a skipped vendor still sells', find: '    if (!v || !v.use) return null;', replace: '    if (!v) return null;' },
  { file: 'mi', name: 'a new name matching a store vendor adds a second one', find: '    return known.get(n.toLowerCase()) || n;', replace: '    return n;' }
];

const live = runSuite(SRC(CE_FILE), SRC(MI_FILE), STORES);
const s = live.stats;
console.log(`me_import: ${STORES} stores, ${s.imports} imports (${s.items} items, ${s.vendors} new vendors), ${s.blocked} blocked by the screen, ` +
            `${s.empty} with nothing ticked, ${s.undos} undone`);
let failed = 0;
if (live.failures.length) {
  failed++;
  console.log(`FAIL  ${live.failures.length} failure(s):`);
  for (const f of live.failures.slice(0, 12)) console.log('      ' + f);
} else if (!s.imports || !s.blocked || !s.vendors || !s.undos) {
  failed++;
  console.log('FAIL  a case was never exercised');
} else {
  console.log('PASS  the CSV reads, the starting choices and each item\'s vendors are right, the write adds exactly the ticked items, and Undo restores');
}
// A control's anchor in the file's own line endings.
const planted = (file, c) => {
  const text = SRC(file), nl = text.indexOf('\r\n') >= 0 ? '\r\n' : '\n';
  return F.plant(text, c.find.replace(/\n/g, nl), c.replace.replace(/\n/g, nl));
};
for (const c of CONTROLS) {
  let r;
  try {
    const ce = c.file === 'ce' ? planted(CE_FILE, c) : SRC(CE_FILE);
    const mi = c.file === 'mi' ? planted(MI_FILE, c) : SRC(MI_FILE);
    r = runSuite(ce, mi, Math.min(STORES, 120));
  } catch (e) { failed++; console.log(`FAIL  control "${c.name}" crashed: ${e.message}`); continue; }
  if (r.failures.length) console.log(`PASS  control "${c.name}" bites (${r.failures.length})`);
  else { failed++; console.log(`FAIL  control "${c.name}" did NOT bite`); }
}
console.log(failed ? `me_import: ${failed} FAILED` : 'me_import: ALL PASS');
process.exit(failed ? 1 : 0);
