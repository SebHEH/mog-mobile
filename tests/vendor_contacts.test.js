'use strict';
// GATE: vendor contacts (supabase/schema_v10.sql) and the Vendors page's two
// calls in template/editor/catalogEdit.js, getVendorsPage and
// commitSaveVendor, which have no Vendors.gs twin. Every save goes through
// the fake Supabase (fake_supabase.js, which mirrors schema v10 and is pinned
// in Postgres by supabase/tests/smoke_v10.sql), and the editor's own copy of
// the tables must equal Supabase's after each one. Checks:
//   - a contact is saved clean: trimmed, empty and unknown keys dropped;
//     too long, a bad cutoff, a repeated name and an unknown vendor refused
//   - one save carries days, cutoff and contact; an unchanged save sends
//     nothing; a contact-only edit is one vendor change, labelled with the
//     fields that changed
//   - the old Manage Vendors save (days and cutoff) keeps the contact
//   - a contact cleared comes off, and the phones' catalog loses
//     vendorContacts with it; a catalog with no contact is exactly as before
//   - a change worked out before someone else saved a contact is a CONFLICT,
//     here and in Supabase; removing a vendor and undoing it brings its
//     contact back
//   - getVendorTableData (Manage Items, the old Manage Vendors) never shows
//     a contact; getVendorsPage's counts are the phone card's (the catalog's
//     itemCounts and backupCounts) on random stores
//   - the phone's vendor card reads vendorContacts
// Each has a planted-defect control.
//
// Run bare: node tests/vendor_contacts.test.js
// A passing run ends with "vendor_contacts: ALL PASS".

const vm = require('vm');
const F = require('./fake_apps_script.js');
const { FakeSupabase, checkCatalogTables, catalogFromTables } = require('./fake_supabase.js');
const { slices } = require('./slice_js.js');

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

function baseTables() {
  return {
    vendors: [{ name: 'Amazon', mults: [1, 0, 0, 0, 0, 0, 0], cutoff: null },
              { name: 'Sysco', mults: [1, 0, 1, 0, 1, 0, 0], cutoff: '10:00' }],
    areas: [{ name: 'Walk-in', ord: 10 }],
    items: [
      { id: 'ITEM-0001', name: 'Lime', primaryVendor: 'Sysco', pack: 'CS', par: 3, active: true, useMult: true, notes: '', sku: '', category: '', eligible: ['Sysco', 'Amazon'], seq: 2 },
      { id: 'ITEM-0002', name: 'Tape', primaryVendor: 'Amazon', pack: 'EA', par: 1, active: true, useMult: false, notes: '', sku: '', category: '', eligible: ['Amazon'], seq: 3 }
    ],
    pickRows: [
      { vendor: 'Sysco', id: 'ITEM-0001', area: 'Walk-in', shelfOrder: 10, seq: 2 },
      { vendor: 'Amazon', id: 'ITEM-0001', area: 'Walk-in', shelfOrder: 20, seq: 3 },
      { vendor: 'Amazon', id: 'ITEM-0002', area: 'Walk-in', shelfOrder: 30, seq: 4 }
    ]
  };
}

// A random store that obeys the database's rules, some vendors with contacts.
function makeTables(rnd) {
  const names = ['Sysco', 'ELPIS', 'Webstaurant', 'Amazon', 'Baldor'].slice(0, 2 + Math.floor(rnd() * 4));
  const vendors = names.map(n => {
    const v = { name: n, mults: [1, 0, 0, 1, 0, 0, 0], cutoff: null };
    if (rnd() < 0.5) v.contact = { phone: '(555) 010-01' + Math.floor(rnd() * 90 + 10), person: pick(rnd, ['Pat', 'Sam', 'Lee']) };
    return v;
  });
  const items = [], pickRows = [];
  const n = 3 + Math.floor(rnd() * 15);
  let seq = 2, rowSeq = 2;
  for (let i = 1; i <= n; i++) {
    const id = 'ITEM-' + String(i).padStart(4, '0');
    const primary = rnd() < 0.1 ? null : pick(rnd, names);
    const eligible = primary ? [primary].concat(names.filter(v => v !== primary && rnd() < 0.3)) : [];
    const active = rnd() < 0.85;
    items.push({ id: id, name: 'Item ' + i, primaryVendor: primary, pack: 'CS', par: 2, active: active, useMult: true,
                 notes: '', sku: '', category: '', eligible: eligible, seq: seq++ });
    for (const v of eligible) if (rnd() < 0.8) pickRows.push({ vendor: v, id: id, area: 'Walk-in', shelfOrder: 10, seq: rowSeq++ });
    if (rnd() < 0.15) pickRows.push({ vendor: pick(rnd, names), id: id, area: null, shelfOrder: null, seq: rowSeq++ });
  }
  const seen = new Set();
  return checkCatalogTables({ vendors, areas: [{ name: 'Walk-in', ord: 10 }], items,
                              pickRows: pickRows.filter(r => { const k = r.vendor + '|' + r.id; return !seen.has(k) && seen.add(k); }) });
}

function makeServer() {
  const sb = new FakeSupabase(Date.UTC(2026, 10, 1, 15));
  sb.provision('zzvend');
  const s = sb.stores.get('zzvend');
  s.pins = { pin: '4321' };
  s.editorDirect = true;
  s.profile = { timeZone: 'America/New_York', location: 'Test', abbr: 'ZZ', concept: 'roll-play' };
  s.tables = checkCatalogTables(baseTables());
  s.version = 1;
  return sb;
}

// An editor: its own copy of the tables, saving the way host.js callTool does.
function editor(CE, sb) {
  const login = sb.handle('mog_editor_login', { p_slug: 'zzvend', p_pin: '4321' });
  const ed = { token: login.data.token, tables: login.data.tables };
  ed.call = (fn, args) => {
    const out = CE.call(ed.tables, fn, args);
    if (!out.ops || !out.ops.length) return { out, r: null };
    const r = sb.handle('mog_editor_apply', { p_token: ed.token, p_label: out.label, p_by: 'Gate', p_ops: out.ops });
    if (r.ok) ed.tables = CE.applyOps(ed.tables, out.ops);
    return { out, r };
  };
  ed.server = () => sb.handle('mog_editor_get', { p_token: ed.token }).data.tables;
  ed.reload = () => { ed.tables = ed.server(); };
  return ed;
}

function problems(text) {
  const out = [];
  const bad = (what, detail) => { if (out.length < 30) out.push(what + (detail ? ': ' + detail : '')); };
  const refused = fn => { try { fn(); return ''; } catch (e) { return e.message; } };
  let CE;
  try { CE = loadCE(text); } catch (e) { return ['catalogEdit.js did not load: ' + e.message]; }
  if (CE.reads.indexOf('getVendorsPage') < 0 || CE.writes.indexOf('commitSaveVendor') < 0) return ['the Vendors page calls are not registered'];

  const sb = makeServer(), s = sb.stores.get('zzvend');
  const ed = editor(CE, sb);
  // The editor's copy keeps a new vendor where it was added; Supabase reads them A to Z.
  const az = t => Object.assign(clone(t), { vendors: clone(t.vendors).sort((x, y) => x.name.localeCompare(y.name)) });
  const inStep = what => { if (!same(az(ed.tables), ed.server())) bad(what + ': the editor\'s copy differs from Supabase', F.deepDiff(az(ed.tables), ed.server())); };
  const vendorOf = (t, name) => t.vendors.find(v => v.name === name);

  // ---- A new vendor with its contact ----
  const add = ed.call('commitSaveVendor', [{ mode: 'add', name: 'Samuel', mults: [0, 1, 0, 0, 1, 0, 0], cutoff: '2:00 PM',
    contact: { person: '  Pat ', phone: '(555) 010-0100', orderEmail: 'orders@example.com', website: '', fax: 'x', account: 5 } }]);
  const want = { phone: '(555) 010-0100', person: 'Pat', orderEmail: 'orders@example.com' };
  if (!add.r || !add.r.ok) bad('add', JSON.stringify(add.r));
  else {
    inStep('add');
    const v = vendorOf(ed.server(), 'Samuel');
    if (!v || !same(v.contact, want)) bad('add: contact stored clean', JSON.stringify(v && v.contact));
    if (!v || v.cutoff !== '14:00' || !same(v.mults, [0, 1, 0, 0, 1, 0, 0])) bad('add: days and cutoff', JSON.stringify(v));
    if (add.out.label !== 'Added vendor "Samuel" with its contact') bad('add: label', add.out.label);
    if (!s.catalog || !same(s.catalog.vendorContacts, { Samuel: want })) bad('add: phones get vendorContacts', JSON.stringify(s.catalog && s.catalog.vendorContacts));
  }

  // ---- What each page reads ----
  const page = CE.call(ed.tables, 'getVendorsPage', []).result;
  const sam = page.find(v => v.name === 'Samuel');
  if (!sam || !same(sam.contact, want) || sam.cutoffTime !== '14:00') bad('getVendorsPage: the contact', JSON.stringify(sam));
  if (!same(page.map(v => v.name), ['Amazon', 'Samuel', 'Sysco'])) bad('getVendorsPage: A to Z', JSON.stringify(page.map(v => v.name)));
  const amz = page.find(v => v.name === 'Amazon');
  if (!amz || amz.itemCount !== 1 || amz.backupCount !== 1 || !same(amz.contact, {})) bad('getVendorsPage: counts and no contact', JSON.stringify(amz));
  if (CE.call(ed.tables, 'getVendorTableData', []).result.some(v => 'contact' in v)) bad('getVendorTableData shows a contact (its shape is pinned)');

  // ---- Unchanged, then a contact-only edit ----
  const keep = { mode: 'edit', name: 'Samuel', mults: [0, 1, 0, 0, 1, 0, 0], cutoff: '14:00', contact: want };
  const none = ed.call('commitSaveVendor', [keep]);
  if (none.out.ops.length) bad('an unchanged save sends a change', JSON.stringify(none.out.ops));
  const edit = ed.call('commitSaveVendor', [Object.assign({}, keep, { contact: Object.assign({}, want, { phone: '(555) 010-0199', email: 'pat@example.com' }) })]);
  if (!edit.r || !edit.r.ok) bad('contact edit', JSON.stringify(edit.r));
  else {
    inStep('contact edit');
    if (edit.out.ops.length !== 1 || edit.out.ops[0].t !== 'vendors') bad('contact edit: one vendor change', JSON.stringify(edit.out.ops));
    if (edit.out.label !== 'Updated vendor "Samuel": contact (phone, email)') bad('contact edit: label', edit.out.label);
  }

  // ---- The old Manage Vendors save keeps the contact ----
  const old = ed.call('commitUpdateVendorMultsAndCutoff', ['Samuel', [1, 1, 0, 0, 1, 0, 0], '15:00']);
  if (!old.r || !old.r.ok) bad('old save', JSON.stringify(old.r));
  else {
    inStep('old save');
    const v = vendorOf(ed.server(), 'Samuel');
    if (!v || !v.contact || v.contact.phone !== '(555) 010-0199') bad('the old Manage Vendors save dropped the contact', JSON.stringify(v));
  }

  // ---- Someone else saves a contact meanwhile ----
  const other = editor(CE, sb);
  const stale = clone(ed.tables);
  const theirs = other.call('commitSaveVendor', [{ mode: 'edit', name: 'Sysco', mults: [1, 0, 1, 0, 1, 0, 0], cutoff: '10:00', contact: { person: 'Lee' } }]);
  if (!theirs.r || !theirs.r.ok) bad('other editor', JSON.stringify(theirs.r));
  const late = CE.call(stale, 'commitUpdateVendorMultsAndCutoff', ['Sysco', [2, 0, 1, 0, 1, 0, 0], '10:00']);
  if (!/CONFLICT/.test(refused(() => CE.applyOps(ed.server(), late.ops)))) bad('a stale change is not a CONFLICT in the editor (applyOps)');
  const lateR = sb.handle('mog_editor_apply', { p_token: ed.token, p_label: late.label, p_by: 'Gate', p_ops: late.ops });
  if (lateR.ok || lateR.error !== 'CONFLICT') bad('a stale change is not a CONFLICT in Supabase', JSON.stringify(lateR));
  if (!vendorOf(ed.server(), 'Sysco').contact) bad('the stale change wiped the other editor\'s contact');
  ed.reload();

  // ---- Remove, and undo ----
  const rm = ed.call('commitRemoveVendor', ['Samuel']);
  if (!rm.r || !rm.r.ok) bad('remove', JSON.stringify(rm.r));
  else {
    const u = sb.handle('mog_editor_undo', { p_token: ed.token, p_change_id: rm.r.data.changeId, p_by: 'Gate' });
    if (!u.ok) bad('undo remove', JSON.stringify(u));
    const v = vendorOf(ed.server(), 'Samuel');
    if (!v || !v.contact || v.contact.email !== 'pat@example.com') bad('undo did not bring the contact back', JSON.stringify(v));
    ed.reload();
  }

  // ---- Cleared ----
  for (const name of ['Samuel', 'Sysco']) {
    const v = vendorOf(ed.tables, name);
    const c = ed.call('commitSaveVendor', [{ mode: 'edit', name: name, mults: v.mults, cutoff: v.cutoff || '',
                                             contact: { person: ' ', phone: '', notes: '' } }]);
    if (!c.r || !c.r.ok) bad('clear ' + name, JSON.stringify(c.r));
  }
  inStep('clear');
  if (ed.server().vendors.some(v => 'contact' in v)) bad('a cleared contact stayed', JSON.stringify(ed.server().vendors));
  if (!s.catalog || 'vendorContacts' in s.catalog) bad('the phones still get vendorContacts with no contact left');
  const V9_KEYS = ['abbr', 'backupCounts', 'concept', 'cutoffs', 'itemCounts', 'items', 'location', 'pickRows', 'schema',
                   'timeZone', 'vendorList', 'vendorMults'];
  if (s.catalog && !same(Object.keys(s.catalog).sort(), V9_KEYS)) bad('a catalog with no contact has different keys from v9', Object.keys(s.catalog).join(','));

  // ---- Refusals ----
  const t = ed.tables;
  if (!/Notes: 500 characters at most/.test(refused(() => CE.call(t, 'commitSaveVendor', [{ mode: 'edit', name: 'Sysco', mults: [1, 0, 0, 0, 0, 0, 0], cutoff: '', contact: { notes: 'x'.repeat(501) } }])))) bad('refusal', 'a 501-character note was taken');
  if (refused(() => CE.call(t, 'commitSaveVendor', [{ mode: 'edit', name: 'Sysco', mults: [1, 0, 0, 0, 0, 0, 0], cutoff: '', contact: { notes: 'x'.repeat(500) } }]))) bad('refusal', 'a 500-character note was refused');
  if (!/Cutoff time format/.test(refused(() => CE.call(t, 'commitSaveVendor', [{ mode: 'edit', name: 'Sysco', mults: [1, 0, 0, 0, 0, 0, 0], cutoff: 'noon' }])))) bad('refusal', 'a bad cutoff was taken');
  if (!/already exists/.test(refused(() => CE.call(t, 'commitSaveVendor', [{ mode: 'add', name: 'sysco', mults: [0, 0, 0, 0, 0, 0, 0], cutoff: '' }])))) bad('refusal', 'a repeated name was taken');
  if (!/not found/.test(refused(() => CE.call(t, 'commitSaveVendor', [{ mode: 'edit', name: 'Nobody', mults: [0, 0, 0, 0, 0, 0, 0], cutoff: '' }])))) bad('refusal', 'an unknown vendor was taken');

  // ---- Random stores: the page's counts are the phone card's; Undo restores ----
  for (let seed = 1; seed <= STORES; seed++) {
    const rnd = rng(seed), rt = makeTables(rnd);
    const cat = catalogFromTables({ tables: rt, profile: {} });
    const pg = CE.call(rt, 'getVendorsPage', []).result;
    for (const v of pg) {
      if (v.itemCount !== (cat.itemCounts[v.name] || 0) || v.backupCount !== (cat.backupCounts[v.name] || 0)) {
        bad('counts differ from the phone card', 'seed ' + seed + ' ' + v.name + ' ' + v.itemCount + '/' + v.backupCount); break;
      }
    }
    if (('vendorContacts' in cat) !== rt.vendors.some(v => v.contact)) bad('vendorContacts present without a contact, or missing', 'seed ' + seed);
    const v = pick(rnd, rt.vendors);
    const c = CE.call(rt, 'commitSaveVendor', [{ mode: 'edit', name: v.name, mults: v.mults, cutoff: v.cutoff || '',
                                                 contact: rnd() < 0.5 ? {} : { person: 'New', website: 'https://example.com' } }]);
    const after = CE.applyOps(rt, c.ops);
    try { checkCatalogTables(clone(after)); } catch (e) { bad('rules', 'seed ' + seed + ': ' + e.message); }
    if (!same(CE.applyOps(after, CE.inverseOps(c.ops)), rt)) bad('undo', 'seed ' + seed);
  }

  for (const p of phoneProblems(SRC('template/index.html'))) bad('phone: ' + p);
  return out;
}

// The phone's vendor card and contact sheet (template/index.html), the real
// functions lifted out with slices(), fed a catalog with vendorContacts.
function phoneProblems(html) {
  const out = [];
  let ctx;
  try {
    ctx = { console, URL, sheet: null,
            state: { lang: 'en' }, direct: { catalog: null },
            t: k => k, getCutoffUrgency: () => 'none', fmt12h: x => x, vendorLiveHtml_: () => '',
            $: () => ({ addEventListener() {} }),
            // index.html's own escapeHtml (an arrow inside the app's closure, which slices() can't lift)
            escapeHtml: s => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
              .replace(/"/g, '&quot;').replace(/'/g, '&#39;') };
    if (html.indexOf(".replace(/\"/g, '&quot;').replace(/'/g, '&#39;');") < 0) return ['index.html\'s escapeHtml changed: update the copy here'];
    ctx.openQeSheet_ = inner => { ctx.sheet = inner; return { querySelector: () => ({ setAttribute() {} }) }; };
    ctx.closeQeSheet_ = () => {};
    vm.createContext(ctx);
    vm.runInContext(
      slices(html, ['vendorContact_', 'contactsSignature_', 'vcPhoneDigits_', 'vcEmailOk_', 'vcWebHref_',
                    'openVendorContact_', 'renderVendorCard']), ctx);
  } catch (e) { return ['the contact code did not load: ' + e.message]; }
  const run = code => vm.runInContext(code, ctx);
  const card = name => run('renderVendorCard(' + JSON.stringify({ name, itemCount: 2, backupCount: 0, cutoffTime: null }) + ', "not_started", "2026-11-01")');

  if (card('Sysco').indexOf('vc-btn') >= 0) out.push('a Contact pill with no catalog');
  const sig0 = run('contactsSignature_()');
  ctx.direct.catalog = { vendorContacts: { 'B&T': { person: 'Pat', phone: '(555) 010-0100', email: 'pat@example.com',
    orderEmail: 'orders@example.com', website: 'example.com/order', orderVia: 'App', account: 'A-1', notes: 'Back door\nafter 2' },
    Odd: { phone: '12', email: 'not an email', website: 'javascript:alert(1)' } } };
  if (run('contactsSignature_()') === sig0) out.push('the contacts signature did not change, so Today would not repaint');
  if (card('Sysco').indexOf('vc-btn') >= 0) out.push('a Contact pill on a vendor with no contact');
  const bt = card('B&T');
  if (bt.indexOf('class="vc-btn" data-contact-vendor="B&amp;T"') < 0) out.push('no Contact pill on a vendor with one: ' + bt.slice(0, 200));
  run('openVendorContact_("B&T")');
  const s = ctx.sheet || '';
  for (const want of ['href="tel:5550100100"', 'href="sms:5550100100"', 'href="mailto:pat@example.com"', 'href="mailto:orders@example.com"',
                      'href="https://example.com/order" target="_blank" rel="noopener"', '>App<', '>A-1<', 'Back door\nafter 2', '<h3>B&amp;T</h3>']) {
    if (s.indexOf(want) < 0) out.push('the contact sheet lacks ' + want);
  }
  ctx.sheet = null;
  run('openVendorContact_("Odd")');
  const o = ctx.sheet || '';
  if (/href="(tel|sms|mailto):/.test(o) || /javascript:/.test(o.replace(/>javascript:alert\(1\)</, '><'))) out.push('a link made from a bad phone, email or website: ' + o);
  if (o.indexOf('javascript:alert(1)') < 0) out.push('a bad website is not shown as text');
  ctx.sheet = null;
  run('openVendorContact_("Sysco")');
  if (ctx.sheet) out.push('a contact sheet opened for a vendor with no contact');
  return out;
}

let failed = 0;
const text = SRC(FILE);
const main = problems(text);
if (main.length) { failed++; console.log('FAIL  ' + main.join('\n      ')); }
else console.log('PASS  vendor contacts: saved clean through Supabase, one save for days/cutoff/contact, old save keeps it, ' +
                 'cleared, CONFLICT, undo, refusals, page counts = phone card on ' + STORES + ' stores');

const CONTROLS = [
  { name: 'a stale contact is not a conflict in the editor',
    find: "    vendors:  ['mults', 'cutoff', 'contact'],", replace: "    vendors:  ['mults', 'cutoff']," },
  { name: 'a contact is stored untrimmed',
    find: "      const v = c[k].trim(), max = k === 'notes' ? 500 : 200;", replace: "      const v = c[k], max = k === 'notes' ? 500 : 200;" },
  { name: 'a cleared contact stays',
    find: '    if (contact) v.contact = contact; else delete v.contact;', replace: '    if (contact) v.contact = contact;' },
  { name: 'contact keys in the wrong order (every save looks like a change)',
    find: '  const CONTACT_ORDER = CONTACT_KEYS.slice().sort(jsonbKeyOrder);', replace: '  const CONTACT_ORDER = CONTACT_KEYS.slice();' },
  { name: 'backups counted from the items\' lists instead of the pick rows',
    find: "      const backups = new Set(t.pickRows.filter(r => r.vendor === v.name && active.has(r.id) &&\n                                                     active.get(r.id).primaryVendor !== v.name).map(r => r.id));",
    replace: "      const backups = new Set(t.items.filter(it => it.active && it.primaryVendor !== v.name && (it.eligible || []).indexOf(v.name) >= 0).map(it => it.id));" }
];
for (const c of CONTROLS) {
  let res;
  try { res = problems(F.plant(text, c.find, c.replace)); }
  catch (e) { failed++; console.log(`FAIL  control "${c.name}" crashed instead of biting: ${e.message}`); continue; }
  if (res.length) console.log(`PASS  control "${c.name}" bites (${res[0].slice(0, 110)})`);
  else { failed++; console.log(`FAIL  control "${c.name}" did NOT bite`); }
}

// The same, planted in the phone (template/index.html).
const phone = SRC('template/index.html');
const PHONE_CONTROLS = [
  { name: 'any website becomes a link',
    find: "    try { const p = new URL(u); return (p.protocol === 'https:' || p.protocol === 'http:') ? p.href : ''; } catch (e) { return ''; }",
    replace: '    return u;' },
  { name: 'every vendor card gets a Contact pill',
    find: '    const contactHtml = vendorContact_(v.name)\n', replace: '    const contactHtml = true\n' },
  { name: 'Today does not repaint when a contact changes',
    find: "    return JSON.stringify((direct.catalog && direct.catalog.vendorContacts) || null);", replace: "    return 'same';" }
];
for (const c of PHONE_CONTROLS) {
  let res;
  try { res = phoneProblems(F.plant(phone, c.find, c.replace)); }
  catch (e) { failed++; console.log(`FAIL  control "${c.name}" crashed instead of biting: ${e.message}`); continue; }
  if (res.length) console.log(`PASS  control "${c.name}" bites (${res[0].slice(0, 110)})`);
  else { failed++; console.log(`FAIL  control "${c.name}" did NOT bite`); }
}

console.log(failed ? `vendor_contacts: ${failed} FAILED` : 'vendor_contacts: ALL PASS');
process.exit(failed ? 1 : 0);
