'use strict';
// GATE: the review screen's "Copy order for email" (template/index.html,
// buildOrderEmail_), run from the real template code. Checks:
//   - every line is "qty × pack" (just the qty when there's no pack), in the
//     count list's order, and only the lines it's given
//   - names and the store are HTML-escaped in the table, raw in the text copy
//   - the date is the DELIVERY day: the cycle date plus one (orders go in
//     the day before, Sunday for Monday), with no time-zone shift
//   - "Deliver to <store> - <address>": the store without BOH/FOH, the
//     address from stores.json; no address leaves just the store
//   - the theme's colours reach the table; the labels are English
//   - the plain-text copy has one line per item; the subject names the
//     vendor, store and date (for a future one-click send)
// Each has a planted-defect control.
//
// Run bare: node tests/order_copy.test.js
// A passing run ends with "order_copy: ALL PASS".

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const F = require('./fake_apps_script.js');
const { slices } = require('./slice_js.js');

const TEMPLATE = 'template/index.html';
const SRC = file => F.source(null, file);

function load(html) {
  const ctx = { console };
  vm.createContext(ctx);
  // escapeHtml is a const inside the app's closure (not top level), so take
  // its statement as written: from its declaration to the first ';' that
  // ends a line (the '&amp;' entities inside it have semicolons too).
  const at = html.indexOf('const escapeHtml = ');
  if (at < 0) throw new Error('escapeHtml not found in the template');
  const end = html.slice(at).search(/;[ \t]*\r?\n/);
  const esc = html.slice(at, at + end + 1).replace('const ', 'var ');
  vm.runInContext([esc, slices(html, ['buildOrderEmail_', 'storeNameForVendor_'])].join(';'), ctx);
  return ctx;
}

function problems(html) {
  const out = [];
  const ctx = load(html);
  const lines = [
    { name: 'SWEET CHILI SAUCE', qty: 2, pack: 'CASE (3)' },
    { name: 'Fish Sauce "3 Crabs" <big> & co', qty: 1, pack: '' },
    { name: 'Rice Paper', qty: 1.5, pack: 'CASE (44)' }
  ];
  const colors = { band: '#2d8c6b', ink: '#ffffff', tint: '#dcf5ea' };
  const store = ctx.storeNameForVendor_('Roll Play Tysons BOH');
  if (store !== 'Roll Play Tysons') out.push('store name keeps its station: ' + store);
  if (ctx.storeNameForVendor_("Teas'n You Tysons foh") !== "Teas'n You Tysons" || ctx.storeNameForVendor_('Lei’d Poke') !== 'Lei’d Poke') {
    out.push('BOH/FOH not stripped (or something else was)');
  }
  const m = ctx.buildOrderEmail_({ vendor: 'Chef Center', store: store + ' & Co', address: '8150 Leesburg Pike, Tysons, VA 22182',
                                   dateStr: '2026-10-18', lines: lines, colors: colors });

  const text = m.text.split('\n');
  if (text[0] !== 'Chef Center order - Delivery Monday, Oct 19') out.push('text title: ' + text[0]);
  if (text[1] !== 'Deliver to Roll Play Tysons & Co - 8150 Leesburg Pike, Tysons, VA 22182') out.push('text deliver line: ' + text[1]);
  const want = ['SWEET CHILI SAUCE: 2 × CASE (3)', 'Fish Sauce "3 Crabs" <big> & co: 1', 'Rice Paper: 1.5 × CASE (44)'];
  if (JSON.stringify(text.slice(3)) !== JSON.stringify(want)) out.push('text lines: ' + JSON.stringify(text.slice(3)));
  if (m.subject !== 'Chef Center order - Roll Play Tysons & Co - Delivery Monday, Oct 19') out.push('subject: ' + m.subject);

  const rows = m.html.match(/<tr>/g) || [];
  if (rows.length !== 3 + lines.length) out.push('table has ' + rows.length + ' rows, expected ' + (3 + lines.length));
  if (!m.html.includes('Fish Sauce &quot;3 Crabs&quot; &lt;big&gt; &amp; co')) out.push('item name not escaped');
  if (!m.html.includes('Deliver to <b>Roll Play Tysons &amp; Co</b> - 8150 Leesburg Pike, Tysons, VA 22182')) out.push('deliver line missing or store not escaped');
  if (/<big>/.test(m.html)) out.push('raw markup from an item name reached the table');
  if (!/>Delivery Monday, Oct 19</.test(m.html)) out.push('delivery day missing from the table');
  const ny = ctx.buildOrderEmail_({ vendor: 'Sysco', store: 'X', address: '', dateStr: '2026-12-31', lines: [] });
  const nyTitle = ny.text.slice(0, ny.text.indexOf(String.fromCharCode(10)));
  if (nyTitle !== 'Sysco order - Delivery Friday, Jan 1') out.push('delivery across the new year: ' + nyTitle);
  const order = ['>2 × CASE (3)<', '>1<', '>1.5 × CASE (44)<'].map(s => m.html.indexOf(s));
  if (order.some(i => i < 0) || order[0] > order[1] || order[1] > order[2]) out.push('order cells missing or out of order: ' + order);
  if (!m.html.includes('background:#2d8c6b;color:#ffffff') || !m.html.includes('background:#dcf5ea')) out.push('theme colours not used');
  if (!/>Chef Center order</.test(m.html) || !/>Item</.test(m.html) || !/>Order</.test(m.html)) out.push('English labels missing');
  if (/<script|on\w+=/i.test(m.html)) out.push('script or event handler in the table');

  const noAddr = ctx.buildOrderEmail_({ vendor: 'Sysco', store: 'Roll Play Rosslyn', address: '', dateStr: '2026-10-18',
                                        lines: [{ name: 'A', qty: 3, pack: '' }] });
  if (noAddr.text.split('\n')[1] !== 'Deliver to Roll Play Rosslyn') out.push('no address: ' + noAddr.text.split('\n')[1]);
  const bare = ctx.buildOrderEmail_({ vendor: 'Sysco', store: '', address: '', dateStr: '', lines: [{ name: 'A', qty: 3, pack: '' }] });
  if (bare.text.split('\n')[1] !== '' || (bare.html.match(/<tr>/g) || []).length !== 3) out.push('no store should drop the deliver row');
  return out;
}

let failed = 0;
const html = SRC(TEMPLATE);
const main = problems(html);
if (main.length) { failed++; console.log('FAIL  ' + main.join('; ')); }
else console.log('PASS  qty x pack lines in order, escaped table, delivery day (cycle date + 1), theme colours, English labels, plain-text copy');

const CONTROLS = [
  { name: 'item names not escaped', find: "'<tr><td style=\"' + cell + '\">' + escapeHtml(l.name) + '</td>'",
    replace: "'<tr><td style=\"' + cell + '\">' + l.name + '</td>'" },
  { name: 'pack dropped from the order cell', find: "const qtyText = l => l.qty + (l.pack ? ' × ' + l.pack : '');",
    replace: "const qtyText = l => String(l.qty);" },
  { name: 'date read through UTC (shifts a day west of Greenwich)', find: "new Date(Number(p[0]), Number(p[1]) - 1, Number(p[2]) + 1)",
    replace: "new Date(Date.UTC(Number(p[0]), Number(p[1]) - 1, Number(p[2]) + 1) - 86400000)" },
  { name: 'the order date shown instead of the delivery day', find: "Number(p[2]) + 1)", replace: "Number(p[2]))" },
  { name: 'theme band ignored', find: "const band = c.band || '#04342c'", replace: "const band = '#04342c'" },
  { name: 'the station kept in the store name', find: ".replace(/\\s+(BOH|FOH)$/i, '')", replace: "" },
  { name: 'the address dropped from the table', find: "(o.address ? ' - ' + escapeHtml(o.address) : '')", replace: "''" }
];
for (const c of CONTROLS) {
  let res;
  try { res = problems(F.plant(html, c.find, c.replace)); }
  catch (e) { failed++; console.log(`FAIL  control "${c.name}" crashed instead of biting: ${e.message}`); continue; }
  if (res.length) console.log(`PASS  control "${c.name}" bites (${res[0]})`);
  else { failed++; console.log(`FAIL  control "${c.name}" did NOT bite`); }
}

console.log(failed ? `order_copy: ${failed} FAILED` : 'order_copy: ALL PASS');
process.exit(failed ? 1 : 0);
