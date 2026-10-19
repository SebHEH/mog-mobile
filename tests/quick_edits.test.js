'use strict';
// GATE: "just today" phone edits in the order math (docs/MOG_OneApp_Spec.md
// Phase 3, schema v7). The snapshot's state.todayEdits is applied in
// orderInputsFromSnapshot_ (apps-script/OrderMath.gs), which the phone, /exec
// on a moved store, the nightly order log and the recap all go through. On
// randomized stores (catalogs built by Sync.gs's own buildCatalogPayload_):
//   - a today par behaves EXACTLY as if the catalog par were that number, and
//     a today add exactly as if the item were on that vendor's list in its
//     usual storage area: every count screen, the Today cards, the order log
//     and the recap match a catalog edited that way (minus the two flags)
//   - normalPar sits on exactly the rows with a today par (the catalog's par),
//     todayOnly on exactly the added rows
//   - unknown, inactive and already-listed items are never added; a bad par
//     changes nothing
//   - with no edits (field absent, empty, or empty lists) every answer is
//     byte-identical to before
// Planted-defect controls in OrderMath.gs must each be caught.
//
// Run bare: node tests/quick_edits.test.js [stores]   (default 200)
// A passing run ends with "quick_edits: ALL PASS".

const F = require('./fake_apps_script.js');
const { makeStore, mulberry32 } = require('./mog_fixture.js');

const STORES = Number(process.argv[2]) || 200;
const SRC = file => F.source(null, file);
const OM = 'apps-script/OrderMath.gs';
const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const clone = x => JSON.parse(JSON.stringify(x));

function compile(srcOf) {
  return F.compile(srcOf, F.READERS_PLAN.concat([
    { file: 'apps-script/MOGApi.gs', consts: F.API_CONSTS, fns: F.API_FNS.concat(['readVendorTabRoster_']) },
    { file: 'apps-script/Sync.gs', fns: ['buildCatalogPayload_', 'catalogPickRow_'] }
  ]), [OM]);
}

// The independent statement of the rules: edit the catalog itself.
function editCatalog(cat, edits) {
  const c = clone(cat);
  const flags = { normalPar: new Map(), todayOnly: new Set() };
  for (const id of Object.keys(edits.pars || {})) {
    const p = edits.pars[id];
    if (!c.items[id] || p === null || p === undefined || p === '' || !isFinite(Number(p))) continue;
    flags.normalPar.set(id, c.items[id].par);
    c.items[id].par = Number(p);
  }
  for (const [vendor, id] of edits.adds || []) {
    const it = c.items[id];
    if (!vendor || !it || it.active !== true) continue;
    if (c.pickRows.some(r => String(r[0] == null ? '' : r[0]).toLowerCase() === vendor.toLowerCase() && String(r[1] || '').trim() === id)) continue;
    const home = c.pickRows.find(r => String(r[1] || '').trim() === id && String(r[3] || '').trim());
    c.pickRows.push([vendor, id, it.name, home ? home[3] : '', home ? home[4] : null, home ? home[5] : null]);
    flags.todayOnly.add(vendor + '\u0001' + id);
    if (it.primaryVendor !== vendor) c.backupCounts[vendor] = (c.backupCounts[vendor] || 0) + 1;
  }
  return { cat: c, flags };
}

// Everything a reader can get from one snapshot.
function answers(ctx, snap) {
  const inputs = ctx.orderInputsFromSnapshot_(clone(snap));
  const out = { vendors: {} };
  for (const v of inputs.vendorList) out.vendors[v] = ctx.vendorItemsFromSnapshot_(inputs, v);
  out.dashboard = ctx.dashboardFromSnapshot_(inputs);
  out.log = ctx.orderLogRowsFromInputs_(inputs);
  out.recap = ctx.recapSectionsFromInputs_(inputs, null);
  return JSON.parse(JSON.stringify(out));
}
const stripFlags = a => {
  const c = clone(a);
  for (const v of Object.keys(c.vendors)) for (const it of c.vendors[v].items) { delete it.normalPar; delete it.todayOnly; }
  return JSON.stringify(c);
};

function runSuite(srcOf, stores) {
  const script = compile(srcOf);
  const failures = [];
  const stats = { stores: 0, pars: 0, adds: 0, ignored: 0, logRows: 0 };
  const fail = (seed, what) => failures.push('seed ' + seed + ': ' + what);

  for (let seed = 1; seed <= stores && failures.length < 20; seed++) {
    try {
      const rnd = mulberry32(seed * 3301);
      const pick = list => list[Math.floor(rnd() * list.length)];
      const spec = makeStore(seed, { realistic: true, tabs: false });
      const side = F.makeContext(spec);
      script.runInContext(side.ctx);
      const ctx = side.ctx;
      const cat = clone(ctx.buildCatalogPayload_());
      if (!cat.vendorList.length) continue;
      stats.stores++;

      const ids = Object.keys(cat.items);
      const counts = [];
      for (const r of cat.pickRows) {
        if (rnd() < 0.5) counts.push({ vendor: String(r[0] || '').trim(), id: String(r[1] || '').trim(), onHand: pick([0, 1, 2.5, null, 3, 0.5, 6]) });
      }
      const picks = {};
      for (const v of cat.vendorList) if (rnd() < 0.2) picks[v] = pick([1, 2, 3, 0]);
      const state = { cycleDate: '2026-10-18', dayOfWeek: pick(DAYS), emergencyOverride: rnd() < 0.3, vendorPicks: picks, todaysLog: [] };

      // No edits: every form gives exactly today's answers.
      const base = answers(ctx, { catalog: cat, state, counts });
      for (const empty of [{}, { pars: {}, adds: [] }, { pars: null, adds: null }]) {
        if (JSON.stringify(answers(ctx, { catalog: cat, state: Object.assign({}, state, { todayEdits: empty }), counts })) !== JSON.stringify(base)) {
          fail(seed, 'no edits (' + JSON.stringify(empty) + ') changed an answer');
        }
      }

      // Random edits, valid and not.
      const edits = { pars: {}, adds: [] };
      for (const id of ids) if (rnd() < 0.25) edits.pars[id] = pick([0, 1, 2, 3.5, 5, 0.33, 10, 'x', null, '']);
      if (rnd() < 0.2) edits.pars['ITEM-NOPE'] = 4;
      for (let i = 0, n = Math.floor(rnd() * 6); i < n && ids.length; i++) {
        edits.adds.push([pick(cat.vendorList), rnd() < 0.9 ? pick(ids) : 'ITEM-NOPE']);
      }
      if (cat.pickRows.length && rnd() < 0.5) {   // one already on its list
        const r = pick(cat.pickRows);
        edits.adds.push([String(r[0] || '').trim(), String(r[1] || '').trim()]);
      }
      const want = editCatalog(cat, edits);
      stats.pars += want.flags.normalPar.size;
      stats.adds += want.flags.todayOnly.size;
      stats.ignored += Object.keys(edits.pars).length - want.flags.normalPar.size + edits.adds.length - want.flags.todayOnly.size;

      const got = answers(ctx, { catalog: cat, state: Object.assign({}, state, { todayEdits: edits }), counts });
      const exp = answers(ctx, { catalog: want.cat, state, counts });
      stats.logRows += got.log.length;
      if (stripFlags(got) !== JSON.stringify(exp)) {
        const parts = ['vendors', 'dashboard', 'log', 'recap'].filter(k => JSON.stringify(stripFlags({ vendors: {}, [k]: got[k] }) !== JSON.stringify({ vendors: {}, [k]: exp[k] })));
        fail(seed, 'the edits differ from the same catalog edited by hand (' + parts.join(', ') + ')');
        continue;
      }

      // The two flags, on exactly the right rows.
      for (const v of Object.keys(got.vendors)) {
        for (const it of got.vendors[v].items) {
          const np = want.flags.normalPar.has(it.id);
          if (np !== ('normalPar' in it)) { fail(seed, v + ' ' + it.id + ': normalPar ' + (np ? 'missing' : 'where no today par')); break; }
          if (np) {
            const orig = want.flags.normalPar.get(it.id);
            if (it.normalPar !== (orig === null || orig === undefined ? null : orig)) fail(seed, it.id + ': normalPar ' + it.normalPar + ', catalog par ' + orig);
          }
          const added = want.flags.todayOnly.has(v + '\u0001' + it.id);
          if (added !== (it.todayOnly === true)) { fail(seed, v + ' ' + it.id + ': todayOnly ' + (added ? 'missing' : 'on a row not added today')); break; }
        }
      }
    } catch (e) { fail(seed, 'crashed: ' + e.stack); }
  }
  return { failures, stats };
}

const CONTROLS = [
  { name: 'a today par is ignored',
    find: '    masterMeta.set(id, Object.assign({}, m, { par: Number(p), normalPar: m.par }));',
    replace: '    masterMeta.set(id, Object.assign({}, m, { normalPar: m.par }));' },
  { name: 'an added item lands outside its storage area',
    find: "      pickDb.push([vendor, id, m.name, home ? home[3] : '', home ? home[4] : null, home ? home[5] : null]);",
    replace: "      pickDb.push([vendor, id, m.name, '', null, null]);" },
  { name: 'the Today card total leaves out a today add',
    find: '      if (m.primaryVendor !== vendor) backupCounts.set(vendor, (backupCounts.get(vendor) || 0) + 1);', replace: '' },
  { name: 'an inactive item can be added',
    find: '      if (!vendor || !m || m.active !== true) continue;', replace: '      if (!vendor || !m) continue;' },
  { name: 'an item already on the list is added again',
    find: '      if (listed) continue;', replace: '' },
  { name: 'the normal par is not shown',
    find: '    if (meta.normalPar !== undefined) item.normalPar = !isNaN(meta.normalPar) ? meta.normalPar : null;', replace: '' },
  { name: 'an added row is not marked today-only',
    find: "    if (o.todayAdds && o.todayAdds.has(vendor + '\\u0001' + itemId)) item.todayOnly = true;", replace: '' }
];

const live = runSuite(SRC, STORES);
const s = live.stats;
console.log(`quick_edits: ${s.stores} stores, ${s.pars} today pars, ${s.adds} today adds, ${s.ignored} bad edits ignored, ${s.logRows} order-log rows compared`);
let failed = 0;
if (live.failures.length) {
  failed++;
  console.log(`FAIL  ${live.failures.length} problem(s):`);
  for (const f of live.failures.slice(0, 10)) console.log('      ' + f);
} else if (!s.pars || !s.adds || !s.ignored || !s.logRows) {
  failed++;
  console.log('FAIL  a case was never exercised');
} else {
  console.log('PASS  today pars and adds behave exactly like the same catalog edit, everywhere the order math reaches');
}
for (const c of CONTROLS) {
  let r;
  try {
    r = runSuite(file => (file === OM ? F.plant(SRC(OM), c.find, c.replace) : SRC(file)), Math.min(STORES, 80));
  } catch (e) { failed++; console.log(`FAIL  control "${c.name}" crashed: ${e.message}`); continue; }
  if (r.failures.length) console.log(`PASS  control "${c.name}" bites (${r.failures.length})`);
  else { failed++; console.log(`FAIL  control "${c.name}" did NOT bite`); }
}
console.log(failed ? `quick_edits: ${failed} FAILED` : 'quick_edits: ALL PASS');
process.exit(failed ? 1 : 0);
