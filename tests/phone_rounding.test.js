'use strict';
// GATE: the phone's order quantity (template/index.html computeSuggested +
// orderForTarget_) is the shared order math's own rounding, not a copy.
// computeSuggested recomputes the order live as the KM types a count, from the
// item's targetPar (par x the day's multiplier, built by OrderMath.gs). It has
// to land on exactly what OrderMath.gs computeSuggestedQty_ gives the order log
// and the recap email: always up, never down, and no phantom extra case from
// float noise (par 1.1 x 2 - 1.2 floats to 1.0000000000000002). Checks, on a
// grid of decimal pars, multipliers and counts plus 20,000 random ones:
//   - the phone's quantity equals computeSuggestedQty_ (null there = 0 here
//     when the vendor delivers today; nothing at all when it doesn't)
//   - the phone code has no rounding of its own (no Math.ceil / Math.floor)
// Each has a planted-defect control.
//
// Run bare: node tests/phone_rounding.test.js
// A passing run ends with "phone_rounding: ALL PASS".

const vm = require('vm');
const F = require('./fake_apps_script.js');
const { slices } = require('./slice_js.js');

const TEMPLATE = 'template/index.html';
const ORDER_MATH = 'apps-script/OrderMath.gs';
const SRC = file => F.source(null, file);

function load(html) {
  const ctx = {};
  vm.createContext(ctx);
  vm.runInContext(slices(SRC(ORDER_MATH), ['computeSuggestedQty_']), ctx);
  vm.runInContext(slices(html, ['computeSuggested', 'orderForTarget_']), ctx);
  return ctx;
}

// targetPar as OrderMath.gs's payload builder makes it.
function targetParOf(par, useMult, mult) {
  const eff = useMult ? mult : 1;
  return (!isNaN(par) && mult > 0 && eff > 0) ? par * eff : null;
}

function cases() {
  const out = [];
  const pars = [0.25, 0.28, 0.42, 0.85, 1, 1.1, 1.14, 1.71, 2, 2.5, 3.25, 4.2, 6, 8];
  const counts = [0, 0.25, 0.5, 1, 1.2, 1.5, 2, 2.2, 3, 4.2, 7, 12, 20];
  for (const par of pars) for (let mult = 0; mult <= 7; mult++) for (const useMult of [true, false]) {
    for (const oh of counts) out.push({ par, mult, useMult, oh });
  }
  let seed = 20261020;
  const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
  const dec = (max, places) => Math.round(rnd() * max * Math.pow(10, places)) / Math.pow(10, places);
  for (let i = 0; i < 20000; i++) {
    out.push({ par: dec(12, 2), mult: Math.floor(rnd() * 8), useMult: rnd() < 0.6, oh: dec(30, rnd() < 0.5 ? 0 : 2) });
  }
  return out;
}

function problems(html) {
  const out = [];
  const ctx = load(html);
  const phoneSrc = slices(html, ['computeSuggested', 'orderForTarget_']);
  if (/Math\.(ceil|floor|round)\s*\(/.test(phoneSrc)) out.push('the phone rounds on its own instead of calling computeSuggestedQty_');
  let bad = 0, first = '';
  for (const c of cases()) {
    const target = targetParOf(c.par, c.useMult, c.mult);
    const server = ctx.computeSuggestedQty_(c.par, c.useMult, c.mult, c.oh);
    const want = target == null ? null : (server == null ? 0 : server);
    const got = ctx.computeSuggested({ targetPar: target, onHand: c.oh });
    if (got !== want) {
      bad++;
      if (!first) first = JSON.stringify(c) + ' phone ' + got + ', order log ' + want;
    }
  }
  if (bad) out.push(bad + ' quantities differ from the order log, e.g. ' + first);
  if (ctx.computeSuggested({ targetPar: 3, onHand: '' }) !== null) out.push('a blank count shows an order');
  return out;
}

let failed = 0;
const html = SRC(TEMPLATE);
const main = problems(html);
if (main.length) { failed++; console.log('FAIL  ' + main.join('; ')); }
else console.log('PASS  phone quantity = computeSuggestedQty_ on ' + cases().length + ' cases; no rounding of its own');

const CONTROLS = [
  { name: 'the phone rounds with a bare ceil again (float noise orders an extra case)',
    find: 'const qty = computeSuggestedQty_(Number(target), false, 1, onHand);',
    replace: 'const qty = Math.ceil(Number(target) - onHand);' },
  { name: 'the phone rounds down',
    find: 'const qty = computeSuggestedQty_(Number(target), false, 1, onHand);',
    replace: 'const qty = Math.floor(Number(target) - onHand + 1e-9);' },
  { name: 'the count is ignored',
    find: 'if (item.targetPar != null) return orderForTarget_(item.targetPar, oh);',
    replace: 'if (item.targetPar != null) return orderForTarget_(item.targetPar, 0);' }
];
for (const c of CONTROLS) {
  let res;
  try { res = problems(F.plant(html, c.find, c.replace)); }
  catch (e) { failed++; console.log(`FAIL  control "${c.name}" crashed instead of biting: ${e.message}`); continue; }
  if (res.length) console.log(`PASS  control "${c.name}" bites (${res[0].slice(0, 120)})`);
  else { failed++; console.log(`FAIL  control "${c.name}" did NOT bite`); }
}

console.log(failed ? `phone_rounding: ${failed} FAILED` : 'phone_rounding: ALL PASS');
process.exit(failed ? 1 : 0);
