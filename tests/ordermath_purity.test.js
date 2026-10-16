'use strict';
// GATE: apps-script/OrderMath.gs can run anywhere, because the PWA runs it
// verbatim. Checks:
//   1. it loads and runs in a BARE context (no Apps Script, no DOM);
//   2. its code never names an Apps Script service, a browser global, or a
//      constant from another .gs file (comments and strings don't count);
//   3. it declares only functions at top level (no state, no constants);
//   4. the two functions moved out of MOGApi.gs are byte-identical to the
//      pre-extraction text at c0b6dfb (moved, not edited);
//   5. no function name is declared in two apps-script/*.gs files (one flat
//      namespace: a duplicate silently replaces the other).
// Each check has a planted-defect control.
//
// Run bare: node tests/ordermath_purity.test.js
// A passing run ends with "ordermath_purity: ALL PASS".

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const F = require('./fake_apps_script.js');
const { blank, slice } = require('./slice_js.js');

const FILE = 'apps-script/OrderMath.gs';
const BASE = 'c0b6dfb';
const MOVED = ['vendorDayMultiplier_', 'computeSuggestedQty_'];
const EXPECTED = ['vendorDayMultiplier_', 'computeSuggestedQty_', 'buildPickInfo_', 'buildVendorItemsPayload_',
  'rosterOnHandSnapshot_', 'buildDashboardPayload_', 'orderInputsFromSnapshot_', 'rosterFromPickRows_',
  'vendorItemsFromSnapshot_', 'dashboardFromSnapshot_', 'orderLogRowsFromInputs_', 'recapSectionsFromInputs_',
  'recapFromLogRows_', 'resetStatusFromSnapshot_', 'vendorNameFromInputs_', 'vendorItemsBulkFromInputs_',
  'recapDataFromInputs_', 'countRowsFromSave_', 'vendorPickFromPayload_', 'overrideAnswerFromSnapshot_',
  'vendorPickAnswerFromSnapshot_'];
const FORBIDDEN = ['SpreadsheetApp', 'Utilities', 'PropertiesService', 'CacheService', 'Logger', 'Session',
  'MailApp', 'GmailApp', 'ScriptApp', 'LockService', 'UrlFetchApp', 'HtmlService', 'DriveApp', 'ContentService',
  'document', 'window', 'localStorage', 'sessionStorage', 'fetch', 'getSheet_', 'VENDOR_META', 'VENDOR_TAB',
  'PICKDB', 'COL', 'DASH', 'LOG_COL'];

let failed = 0;
const ok = (cond, name, detail) => {
  if (cond) console.log('PASS  ' + name);
  else { failed++; console.log('FAIL  ' + name + (detail ? ': ' + detail : '')); }
};

// 1. Bare context: everything defined, and a small snapshot renders.
function bareRun(text) {
  const ctx = {};
  vm.createContext(ctx);
  vm.runInContext(text, ctx);
  const missing = EXPECTED.filter(n => typeof ctx[n] !== 'function');
  if (missing.length) throw new Error('not defined: ' + missing.join(', '));
  const snap = {
    catalog: {
      location: 'Bare', vendorList: ['Amazon'], vendorMults: { Amazon: { Mon: 1, Tue: 1, Wed: 1, Thu: 1, Fri: 1, Sat: 1, Sun: 1 } },
      cutoffs: { Amazon: '10:00' }, itemCounts: { Amazon: 1 }, backupCounts: {},
      items: { 'ITEM-1': { useMult: true, par: 2.2, name: 'Tape', pack: 'CS', primaryVendor: 'Amazon', active: true } },
      pickRows: [['Amazon', 'ITEM-1', 'Tape', 'Shelf', 10, 10]]
    },
    state: { cycleDate: '2026-10-15', dayOfWeek: 'Thu', emergencyOverride: false, vendorPicks: {}, todaysLog: [] },
    counts: [{ vendor: 'Amazon', id: 'ITEM-1', onHand: 1.2 }]
  };
  const inputs = ctx.orderInputsFromSnapshot_(JSON.parse(JSON.stringify(snap)));
  const items = ctx.vendorItemsFromSnapshot_(inputs, 'Amazon');
  const dash = ctx.dashboardFromSnapshot_(inputs);
  return { items, dash };
}

function forbiddenHits(text) {
  const code = blank(text);
  return FORBIDDEN.filter(w => new RegExp('(^|[^\\w$.])' + w.replace(/\$/g, '\\$') + '(?![\\w$])').test(code));
}

// Top-level statements that aren't function declarations.
function topLevelNonFunctions(text) {
  const code = blank(text);
  const bad = [];
  let depth = 0;
  for (const line of code.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (depth === 0 && trimmed && !/^(function\s|\}|\)|;)/.test(trimmed)) bad.push(trimmed.slice(0, 60));
    for (const ch of line) { if (ch === '{') depth++; else if (ch === '}') depth--; }
  }
  return bad;
}

function duplicateDeclarations(files) {
  const seen = new Map();
  const dups = [];
  for (const [name, text] of files) {
    const re = /^function\s+([A-Za-z_$][\w$]*)/gm;
    let m;
    const code = blank(text);
    while ((m = re.exec(code))) {
      if (seen.has(m[1])) dups.push(m[1] + ' (' + seen.get(m[1]) + ' and ' + name + ')');
      else seen.set(m[1], name);
    }
  }
  return dups;
}

const text = F.source(null, FILE);

// 1
try {
  const r = bareRun(text);
  ok(r.items.items.length === 1 && r.items.items[0].suggestedQty === 1 && r.dash.vendors.length === 1,
    'loads and renders a snapshot in a bare context (2.2 par - 1.2 on hand orders exactly 1)',
    JSON.stringify(r.items.items[0]));
} catch (e) { ok(false, 'loads and renders a snapshot in a bare context', e.message); }

// 2
ok(forbiddenHits(text).length === 0, 'names no Apps Script service, browser global, or outside constant',
  forbiddenHits(text).join(', '));
// 3
ok(topLevelNonFunctions(text).length === 0, 'declares only functions at top level',
  topLevelNonFunctions(text).join(' | '));
// 4. Line endings are normalized first: with core.autocrlf the committed blob
// is LF while the working copy is CRLF, and that's a checkout detail, not an edit.
const lf = s => s.replace(/\r\n/g, '\n');
for (const n of MOVED) {
  const before = lf(slice(F.source(BASE, 'apps-script/MOGApi.gs'), n));
  const now = lf(slice(text, n));
  ok(before === now, n + ' is byte-identical to its pre-extraction text (line endings normalized)');
}
// 5
const dir = path.join(F.REPO, 'apps-script');
const gsFiles = fs.readdirSync(dir).filter(f => f.endsWith('.gs')).map(f => [f, fs.readFileSync(path.join(dir, f), 'utf8')]);
const dups = duplicateDeclarations(gsFiles);
ok(dups.length === 0, 'no function is declared in two .gs files (' + gsFiles.length + ' files)', dups.join(', '));

// ---- Controls --------------------------------------------------------------
const control = (name, bites) => {
  let bit;
  try { bit = bites(); } catch (e) { failed++; console.log(`FAIL  control "${name}" crashed: ${e.message}`); return; }
  if (bit) console.log(`PASS  control "${name}" bites`);
  else { failed++; console.log(`FAIL  control "${name}" did NOT bite`); }
};
control('a Logger call slips in', () =>
  forbiddenHits(F.plant(text, 'function buildPickInfo_(pickDb, vendor) {', 'function buildPickInfo_(pickDb, vendor) {\n  Logger.log(1);')).includes('Logger'));
control('a Logger mention inside a comment is NOT flagged', () =>
  forbiddenHits(F.plant(text, 'function buildPickInfo_(pickDb, vendor) {', '// Logger.log here would be wrong\nfunction buildPickInfo_(pickDb, vendor) {')).length === 0);
control('a top-level constant slips in', () =>
  topLevelNonFunctions(F.plant(text, 'function buildPickInfo_(pickDb, vendor) {', 'const X = 1;\nfunction buildPickInfo_(pickDb, vendor) {')).length > 0);
control('a moved function gets edited', () =>
  lf(slice(F.plant(text, 'return qty > 0 ? qty : null;', 'return qty > 0 ? qty : 0;'), 'computeSuggestedQty_')) !==
  lf(slice(F.source(BASE, 'apps-script/MOGApi.gs'), 'computeSuggestedQty_')));
control('a second file redeclares computeSuggestedQty_', () =>
  duplicateDeclarations(gsFiles.concat([['Extra.gs', 'function computeSuggestedQty_() {}\n']])).length > 0);
control('the bare-context run catches a missing builder', () => {
  try { bareRun(F.plant(text, 'function dashboardFromSnapshot_(inputs) {', 'function dashboardFromSnapshotX_(inputs) {')); return false; }
  catch (e) { return /not defined: dashboardFromSnapshot_/.test(e.message); }
});

console.log(failed ? `ordermath_purity: ${failed} FAILED` : 'ordermath_purity: ALL PASS');
process.exit(failed ? 1 : 0);
