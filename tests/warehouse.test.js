'use strict';
// GATE: Happy Supply, the warehouse (supabase/schema_v13.sql, hq/'s Happy
// Supply pages in template/hq/warehouse.js), run against the fake Supabase
// (fake_supabase.js mirrors v13; the SQL itself is pinned in Postgres by
// supabase/tests/smoke_v13.sql, which CI runs in PGlite). Checks:
//   - the page's sums: the average after a delivery is the database's sum
//     (pinned values, the same as smoke_v13's, and 2000 random ones against
//     the fake), over every location and what's in transit; a store's price
//     per case; what's owned and its value
//   - the page's payloads, sent to the fake: a count carries only the
//     products given a number, each with its reason; a receipt answers every
//     line of the order; the average the page shows before a receipt is the
//     one the receipt makes
//   - a transfer: the page flags exactly the lines the database refuses
//     (more than the location holds), on random stock; a refused one writes
//     nothing
//   - roles: a warehouse sign-in can't read or change a store's catalog, an
//     hq one can't reach the warehouse, roles survive a new invite
//   - numbering (PO-0001 on), a CONFLICT on a stale order, a count with a
//     difference and no reason refused
// Each page check has a planted-defect control.
//
// Run bare: node tests/warehouse.test.js
// A passing run ends with "warehouse: ALL PASS".

const vm = require('vm');
const F = require('./fake_apps_script.js');
const { FakeSupabase, whAvgAfter } = require('./fake_supabase.js');

const FILE = 'template/hq/warehouse.js';
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

function loadLogic(text) {
  const ctx = {};
  vm.createContext(ctx);
  vm.runInContext(text, ctx, { filename: FILE });
  return ctx.HQWarehouse.logic;
}
function rng(seed) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
}

// A fake with stores, Dan (warehouse), Hana (hq) and Sam (both), and a
// warehouse of two locations, a supplier and two products.
function world() {
  const sb = new FakeSupabase(Date.parse('2026-11-02T15:00:00Z'));
  sb.provision('zzrpr');
  Object.assign(sb.stores.get('zzrpr'), { editorDirect: true, profile: { location: 'Roll Play Rosslyn BOH', concept: 'roll-play' },
    tables: { vendors: [], areas: [], items: [], pickRows: [] }, version: 1 });
  const claim = (name, roles) => sb.handle('mog_hq_claim', { p_name: name, p_code: sb.hqInvite(name, roles), p_passphrase: 'correct horse battery' }).data;
  const dan = claim('Dan', ['warehouse']), hana = claim('Hana'), sam = claim('Sam', ['warehouse', 'hq']);
  const call = (fn, p, tok) => sb.handle(fn, Object.assign({ p_token: tok || dan.token }, p));
  const id = r => { if (!r.ok) throw new Error(JSON.stringify(r)); return r.data.done.id; };
  const A = id(call('mog_wh_save', { p_kind: 'location', p_row: { name: 'Berliner' } }));
  const B = id(call('mog_wh_save', { p_kind: 'location', p_row: { name: 'Tysons freezer' } }));
  const S = id(call('mog_wh_save', { p_kind: 'supplier', p_row: { name: 'Ruby Seas' } }));
  const shrimp = id(call('mog_wh_save', { p_kind: 'product', p_row: { name: 'Shrimp 16/20', pack: '10 LB case', par: 12, handlingFee: 6 } }));
  const crab = id(call('mog_wh_save', { p_kind: 'product', p_row: { name: 'King crab 9/12', pack: '20 LB case', par: 10, handlingFee: 25 } }));
  return { sb, dan, hana, sam, call, A, B, S, shrimp, crab };
}
const prod = (data, id) => data.products.find(p => p.id === id);

function problems(text) {
  const out = [];
  const bad = (what, detail) => out.push(what + (detail ? ' :: ' + String(detail).slice(0, 300) : ''));
  let L;
  try { L = loadLogic(text); } catch (e) { return ['warehouse.js does not load: ' + e.message]; }

  // ---- The sums ----
  const pinned = [[11, 78.5, 10, 76, 77.3095], [0, 0, 4, 148, 148], [6, 145, 0, 999, 145], [6, 145, 3, 148, 146], [21, 77.3095, 2.5, 80.01, 77.5968]];
  for (const [o, a, c, k, want] of pinned) {
    if (L.avgAfter(o, a, c, k) !== want) bad('average after: (' + [o, a, c, k].join(', ') + ') should be ' + want, L.avgAfter(o, a, c, k));
    if (whAvgAfter(o, a, c, k) !== want) bad('the fake\'s average after: (' + [o, a, c, k].join(', ') + ') should be ' + want, whAvgAfter(o, a, c, k));
  }
  const rnd = rng(13);
  for (let i = 0; i < 2000; i++) {
    const o = Math.round(rnd() * 5000) / 100, a = Math.round(rnd() * 50000) / 100, c = Math.round(rnd() * 3000) / 100, k = Math.round(rnd() * 50000) / 100;
    if (L.avgAfter(o, a, c, k) !== whAvgAfter(o, a, c, k)) { bad('average after differs from the database\'s on random values', [o, a, c, k].join(', ')); break; }
  }
  if (L.storePrice(312, 25, 0) !== 337 || L.storePrice(77.3095, 6, 5) !== 87.47 || L.storePrice(145, 12, 0) !== 157) {
    bad('a store\'s price per case is (average + fee) x (1 + markup)', [L.storePrice(312, 25, 0), L.storePrice(77.3095, 6, 5), L.storePrice(145, 12, 0)].join(' '));
  }
  const p1 = { stock: { 1: 9, 2: 0.5 }, inTransit: 2, avgCost: 78.5 }, p2 = { stock: {}, inTransit: 0, avgCost: 312 };
  if (L.owned(p1) !== 11.5 || L.owned(p2) !== 0 || L.value([p1, p2]) !== 902.75) bad('owned is every location plus in transit; its value at the average', [L.owned(p1), L.value([p1, p2])].join(' '));
  if (L.num('$1,204.00') !== 1204 || L.num(' ') !== null || !isNaN(L.num('abc')) || L.cs(1) !== '1 case' || L.cs(2.5) !== '2.5 cases') bad('typed amounts and case counts read as people type them');

  // ---- Through the fake ----
  const w = world(), { sb, dan, hana, sam, call, A, B, S, shrimp, crab } = w;

  // Roles
  if (!same(dan.roles, ['warehouse']) || !same(hana.roles, ['hq']) || !same(sam.roles, ['hq', 'warehouse'])) bad('signing in returns the roles', JSON.stringify([dan.roles, hana.roles, sam.roles]));
  if (call('mog_hq_data', {}).error !== 'SESSION_EXPIRED' || call('mog_hq_apply', { p_changes: [], p_links: [] }).error !== 'SESSION_EXPIRED') bad('a warehouse sign-in can\'t read or change a store\'s catalog');
  if (call('mog_wh_data', {}, hana.token).error !== 'NOT_ALLOWED' || call('mog_wh_count', { p_count: {} }, hana.token).error !== 'NOT_ALLOWED') bad('an hq sign-in can\'t reach the warehouse');
  if (!call('mog_wh_data', {}, sam.token).ok || !call('mog_hq_data', {}, sam.token).ok) bad('both roles reach both');
  if (call('mog_wh_data', {}, 'bogus').error !== 'SESSION_EXPIRED') bad('a bogus token is SESSION_EXPIRED');

  // A first delivery, a transfer in transit, then a delivery whose preview
  // the page works out from what it holds.
  let r = call('mog_wh_po_save', { p_po: { supplierId: S, locationId: A, lines: [{ productId: shrimp, cases: 11, cost: 78.5 }] } });
  if (!r.ok || r.data.done.number !== 'PO-0001') bad('the first order is PO-0001', JSON.stringify(r));
  const po1 = r.data.pos.find(p => p.id === r.data.done.id);
  r = call('mog_wh_po_receive', { p_receipt: L.receivePayload(po1, { 1: { cases: '11', cost: '$78.50' } }) });
  if (!r.ok || prod(r.data, shrimp).avgCost !== 78.5 || L.stockAt(prod(r.data, shrimp), A) !== 11) bad('the first delivery sets the average and the stock', JSON.stringify(r).slice(0, 300));
  r = call('mog_wh_transfer_send', { p_transfer: { fromId: A, toId: B, lines: [{ productId: shrimp, cases: 2 }] } });
  if (!r.ok || prod(r.data, shrimp).inTransit !== 2 || L.owned(prod(r.data, shrimp)) !== 11) bad('a transfer shows in transit; owned is the same', JSON.stringify(r).slice(0, 300));
  r = call('mog_wh_po_save', { p_po: { supplierId: S, locationId: A, lines: [{ productId: shrimp, cases: 10, cost: 76 }, { productId: crab, cases: 4 }] } });
  if (r.data.done.number !== 'PO-0002') bad('numbers follow on', r.data.done.number);
  const po2 = r.data.pos.find(p => p.id === r.data.done.id), before = prod(r.data, shrimp);
  const preview = L.avgAfter(L.owned(before), before.avgCost, 10, 76);
  if (call('mog_wh_po_receive', { p_receipt: Object.assign(L.receivePayload(po2, { 1: { cases: '10', cost: '76' } }), { version: 0 }) }).error !== 'CONFLICT') bad('a receipt on a stale order is a CONFLICT');
  r = call('mog_wh_po_receive', { p_receipt: L.receivePayload(po2, { 1: { cases: '10', cost: '76' } }) });
  if (!r.ok) bad('a receipt with a line left blank (none came) is taken', JSON.stringify(r));
  else {
    if (prod(r.data, shrimp).avgCost !== preview || preview !== 77.3095) bad('the average the page shows before a receipt is the one it makes', preview + ' vs ' + prod(r.data, shrimp).avgCost);
    const ln = r.data.pos.find(p => p.id === po2.id).lines;
    if (ln[1].casesReceived !== 0 || ln[1].costReceived !== null || prod(r.data, crab).avgCost !== 0) bad('a line none came of is kept as 0 and moves nothing', JSON.stringify(ln));
  }

  // A count, through the page's payload.
  let d = call('mog_wh_data', {}).data;
  const rows = { [shrimp]: { counted: '17', reason: '  2 cases thawed ' }, [crab]: { counted: '', reason: '' } };
  const cp = L.countPayload(A, rows);
  if (cp.lines.length !== 1 || cp.lines[0].productId !== shrimp || cp.lines[0].cases !== 17 || cp.lines[0].reason !== '2 cases thawed') bad('a count carries only the products given a number, with the reason', JSON.stringify(cp));
  r = call('mog_wh_count', { p_count: L.countPayload(A, { [shrimp]: { counted: '17', reason: '' } }) });
  if (!/^REJECTED: Shrimp 16\/20 differs from the record \(17 counted, 19 on record\): say why$/.test(r.error || '')) bad('a difference with no reason is refused', JSON.stringify(r));
  r = call('mog_wh_count', { p_count: cp });
  if (!r.ok || r.data.done.changed !== 1 || L.stockAt(prod(r.data, shrimp), A) !== 17) bad('a count with its reason is saved', JSON.stringify(r).slice(0, 300));
  const hist = call('mog_wh_history', { p_product_id: shrimp }).data.moves;
  if (!same(hist.map(m => m.kind), ['count', 'received', 'transfer_out', 'received']) || hist[0].reason !== '2 cases thawed' || hist[0].by !== 'Dan') {
    bad('the history keeps every change, newest first, with who and why', JSON.stringify(hist.map(m => [m.kind, m.reason, m.by])));
  }

  // A transfer: the page flags exactly what the database refuses; all of
  // what a location holds can go, a cent more can't.
  d = call('mog_wh_data', {}).data;
  const all = L.stockAt(prod(d, shrimp), A);
  if (L.transferProblems(d.products, A, [{ productId: shrimp, cases: String(all) }]).length) bad('a transfer of exactly what a location holds is flagged', all);
  if (!L.transferProblems(d.products, A, [{ productId: shrimp, cases: String(all + 0.01) }]).length) bad('a transfer of more than a location holds is not flagged', all + 0.01);
  r = call('mog_wh_transfer_send', { p_transfer: { fromId: A, toId: B, lines: [{ productId: shrimp, cases: all }] } });
  if (!r.ok || L.stockAt(prod(r.data, shrimp), A) !== 0) bad('a transfer of everything at a location is sent', JSON.stringify(r).slice(0, 200));
  else call('mog_wh_transfer_receive', { p_id: r.data.done.id });
  const rnd2 = rng(7);
  for (let i = 0; i < 300; i++) {
    d = call('mog_wh_data', {}).data;
    const from = rnd2() < 0.5 ? A : B, to = from === A ? B : A;
    const lines = [{ productId: shrimp, cases: String(Math.round(rnd2() * 2400) / 100) }];
    if (rnd2() < 0.5) lines.push({ productId: crab, cases: String(Math.round(rnd2() * 300) / 100 + 0.01) });
    const flagged = L.transferProblems(d.products, from, lines).length > 0;
    const sent = call('mog_wh_transfer_send', { p_transfer: { fromId: from, toId: to, lines: lines.map(l => ({ productId: l.productId, cases: L.num(l.cases) })) } });
    const refused = !sent.ok && / has [0-9.]+ cases? of /.test(sent.error || '');
    if (!sent.ok && !refused) { bad('a transfer was refused for another reason', JSON.stringify(sent)); break; }
    if (flagged !== refused) { bad('the page\'s transfer check and the database disagree', JSON.stringify({ from, lines, stock: d.products.map(p => p.stock), sent: sent.error })); break; }
    if (refused && !same(call('mog_wh_data', {}).data, d)) { bad('a refused transfer wrote something'); break; }
    if (sent.ok) {
      const t = sent.data.transfers.find(x => x.id === sent.data.done.id);
      call('mog_wh_transfer_receive', { p_id: t.id });
    }
  }
  return out;
}

let failed = 0;
const text = F.source(null, FILE);
const main = problems(text);
if (main.length) { failed++; console.log('FAIL  ' + main.join('\n      ')); }
else console.log('PASS  warehouse: the average after a delivery (pinned and 2000 random against the database\'s), store prices, owned and value; ' +
                 'counts, receipts and transfers through the fake from the page\'s own payloads (300 random transfers); roles; numbering; CONFLICT');

const CONTROLS = [
  { name: 'owned leaves out what is in transit',
    find: '  function owned(p) { let n = Number(p.inTransit || 0);', replace: '  function owned(p) { let n = 0;' },
  { name: 'the average kept to the cent',
    find: '    return round((owned * avg + cases * cost) / (owned + cases), 4);', replace: '    return round((owned * avg + cases * cost) / (owned + cases), 2);' },
  { name: 'a count drops its reason',
    find: "      lines.push({ productId: Number(id), cases: n, reason: String(r.reason || '').trim() });",
    replace: "      lines.push({ productId: Number(id), cases: n, reason: '' });" },
  { name: 'a receipt leaves out a line none came of',
    find: '    return { id: po.id, version: po.version, lines: po.lines.map(l => {',
    replace: '    return { id: po.id, version: po.version, lines: po.lines.filter(l => num((rows[l.ord] || {}).cases)).map(l => {' },
  { name: 'a transfer of exactly what is there is flagged',
    find: '      if (p && want[l.productId] > have + 1e-9) out.push', replace: '      if (p && want[l.productId] >= have) out.push' },
  { name: 'the store price leaves out the markup',
    find: '  function storePrice(avg, fee, markupPct) { return round((Number(avg) + Number(fee)) * (1 + Number(markupPct || 0) / 100), 2); }',
    replace: '  function storePrice(avg, fee, markupPct) { return round(Number(avg) + Number(fee), 2); }' }
];
for (const c of CONTROLS) {
  let res;
  try { res = problems(F.plant(text, c.find, c.replace)); }
  catch (e) { failed++; console.log(`FAIL  control "${c.name}" crashed instead of biting: ${e.message}`); continue; }
  if (res.length) console.log(`PASS  control "${c.name}" bites (${res[0].slice(0, 110)})`);
  else { failed++; console.log(`FAIL  control "${c.name}" did NOT bite`); }
}

console.log(failed ? `warehouse: ${failed} FAILED` : 'warehouse: ALL PASS');
process.exit(failed ? 1 : 0);
