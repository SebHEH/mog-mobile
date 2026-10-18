'use strict';
// GATE: live counting's rules on the phone (docs/MOG_OneApp_Spec.md, Phase 1),
// run from the real template code:
//   - other people's counts fill in on items this device hasn't touched; an
//     item with unsaved typing, or the input being typed in, keeps its value;
//     a count someone cleared clears here too; equal numbers are no change
//   - after a save, only what was sent and is unchanged stops being unsaved:
//     a count typed while the save was in flight stays unsaved
//   - who has a vendor open: names for that vendor only, "Someone" for a
//     skipped name, no repeats
// Each has a planted-defect control.
//
// Run bare: node tests/live_counting.test.js
// A passing run ends with "live_counting: ALL PASS".

const vm = require('vm');
const F = require('./fake_apps_script.js');
const { slices } = require('./slice_js.js');

const TEMPLATE = 'template/index.html';
const FNS = ['liveMergeCounts_', 'clearSentDirty_', 'livePeopleOn_'];

function load(html) {
  const ctx = { t: k => (k === 'someone' ? 'Someone' : k) };
  vm.createContext(ctx);
  vm.runInContext(slices(html, FNS), ctx);
  return ctx;
}

const clone = v => JSON.parse(JSON.stringify(v));

function problems(html) {
  const out = [];
  const c = load(html);

  // ---- liveMergeCounts_ ----
  const items = [
    { id: 'A', onHand: null },   // untouched, someone counted 3
    { id: 'B', onHand: 2 },      // typed here, unsaved: keeps 2
    { id: 'C', onHand: 1 },      // being typed in right now: keeps 1
    { id: 'D', onHand: '4' },    // same number as the server's: no change
    { id: 'E', onHand: 5 },      // someone cleared it
    { id: 'F', onHand: 7 },      // not in the fresh list: untouched
    { id: 'G', onHand: '' }      // blank both sides: no change
  ];
  const fresh = [
    { id: 'A', onHand: 3 }, { id: 'B', onHand: 9 }, { id: 'C', onHand: 8 },
    { id: 'D', onHand: 4 }, { id: 'E', onHand: null }, { id: 'G', onHand: null }
  ];
  const work = clone(items);
  const changed = c.liveMergeCounts_(work, fresh, { B: 2 }, 'C');
  if (JSON.stringify(changed) !== '["A","E"]') out.push('merge changed ' + JSON.stringify(changed) + ', expected A and E');
  const got = Object.fromEntries(work.map(i => [i.id, i.onHand]));
  const want = { A: 3, B: 2, C: 1, D: '4', E: null, F: 7, G: '' };
  if (JSON.stringify(got) !== JSON.stringify(want)) out.push('merge result ' + JSON.stringify(got));
  if (c.liveMergeCounts_(clone(items), [], {}, null).length) out.push('an empty fresh list changed something');
  const z = [{ id: 'Z', onHand: 0 }];
  if (c.liveMergeCounts_(z, [{ id: 'Z', onHand: 0 }], {}, null).length || z[0].onHand !== 0) out.push('a zero count read as blank');

  // ---- clearSentDirty_ ----
  const sent = { A: 3, B: null, C: 1 };
  const dirtyAfter = { A: 3, B: null, C: 2, D: 5 };   // C typed again, D typed during the save
  const left = c.clearSentDirty_(dirtyAfter, sent);
  if (JSON.stringify(left) !== '{"C":2,"D":5}') out.push('after a save, still unsaved: ' + JSON.stringify(left));
  if (JSON.stringify(c.clearSentDirty_({}, sent)) !== '{}') out.push('an empty dirty list grew');
  if (JSON.stringify(c.clearSentDirty_({ A: 0 }, { A: null })) !== '{"A":0}') out.push('0 and blank treated as the same count');

  // ---- livePeopleOn_ ----
  const presence = [
    { name: 'Maria', vendor: 'Chef Center' }, { name: null, vendor: 'Chef Center' },
    { name: 'Luis', vendor: 'Sysco' }, { name: 'Maria', vendor: 'Chef Center' }, { name: 'Ana', vendor: null }
  ];
  const on = c.livePeopleOn_(presence, 'Chef Center');
  if (JSON.stringify(on) !== '["Maria","Someone"]') out.push('on Chef Center: ' + JSON.stringify(on));
  if (c.livePeopleOn_(presence, 'Amazon').length || c.livePeopleOn_(null, 'Sysco').length) out.push('people shown on a vendor nobody has open');
  return out;
}

let failed = 0;
const html = F.source(null, TEMPLATE);
const main = problems(html);
if (main.length) { failed++; console.log('FAIL  ' + main.join('; ')); }
else console.log('PASS  live counts fill untouched items only; unsaved typing survives a save; who is on a vendor');

const CONTROLS = [
  { name: 'live counts overwrite unsaved typing',
    find: "if (it.id === focusedId || Object.prototype.hasOwnProperty.call(dirty || {}, it.id)) continue;",
    replace: "if (it.id === focusedId) continue;" },
  { name: 'live counts overwrite the input being typed in',
    find: "if (it.id === focusedId || Object.prototype.hasOwnProperty.call(dirty || {}, it.id)) continue;",
    replace: "if (Object.prototype.hasOwnProperty.call(dirty || {}, it.id)) continue;" },
  { name: 'a save clears counts typed while it was in flight',
    find: "if (Object.prototype.hasOwnProperty.call(sent, id) && dirty[id] === sent[id]) continue;",
    replace: "if (Object.prototype.hasOwnProperty.call(sent, id) || true) continue;" },
  { name: 'a skipped name shown blank',
    find: "const n = p.name || t('someone');", replace: "const n = p.name || '';" },
  { name: 'the same person listed twice', find: "if (out.indexOf(n) < 0) out.push(n);", replace: "out.push(n);" }
];
for (const ctl of CONTROLS) {
  let res;
  try { res = problems(F.plant(html, ctl.find, ctl.replace)); }
  catch (e) { failed++; console.log(`FAIL  control "${ctl.name}" crashed instead of biting: ${e.message}`); continue; }
  if (res.length) console.log(`PASS  control "${ctl.name}" bites (${res[0]})`);
  else { failed++; console.log(`FAIL  control "${ctl.name}" did NOT bite`); }
}

console.log(failed ? `live_counting: ${failed} FAILED` : 'live_counting: ALL PASS');
process.exit(failed ? 1 : 0);
