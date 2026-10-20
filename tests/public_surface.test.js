'use strict';
// GATE: what a page served by the web app can reach on the server (design
// record D18). The web app runs as the OWNER for anonymous visitors
// (appsscript.json: USER_DEPLOYING + ANYONE_ANONYMOUS), and Apps Script lets
// any page it serves call any PUBLIC function through google.script.run;
// private functions (name ends in _) are invisible to it. So:
//   1. every public function in apps-script/*.gs is on the reviewed list
//      below, with its reason; a new public function fails the run;
//   2. the "editor" ones start with requireEditorRun_() (except the one
//      listed as unguarded), and the "ui" ones start by touching the Sheet's UI;
//   3. pages call google.script.run only for the door (webedit_call) and the
//      auth layer (editorAuth, editorPing, commitStoreSetup);
//   4. every dispatcher action maps to a private function that exists, and
//      every action a page sends (MIRPC().x, webedit_call(token, 'x')) is one;
//   5. every Sheet menu item and trigger handler names a function that exists.
// Each check has a planted-defect control.
//
// Run bare: node tests/public_surface.test.js
// A passing run ends with "public_surface: ALL PASS".

const fs = require('fs');
const path = require('path');
const F = require('./fake_apps_script.js');
const { blank, blankAny } = require('./slice_js.js');

const DIR = path.join(F.REPO, 'apps-script');
const GS   = fs.readdirSync(DIR).filter(f => f.endsWith('.gs')).sort();
const HTML = fs.readdirSync(DIR).filter(f => f.endsWith('.html')).sort();

const ENTRY = 'Apps Script entry point', CUSTOM = 'custom Sheet function', UI = 'ui', EDITOR = 'editor';
const PUBLIC = {
  doGet: ENTRY, doPost: ENTRY, onOpen: ENTRY, onEdit: ENTRY,
  TABNAME: CUSTOM, SHEETGID: CUSTOM,
  include: 'template helper: returns the HTML the pages already serve',
  editorAuth: 'auth: the PIN check (shares the lockout with the PWA)',
  editorPing: 'auth: token check',
  commitStoreSetup: 'auth: first-run setup, refuses once a PIN exists',
  webedit_call: 'the door: token check, then the dispatcher allowlist',
  getVendorList: 'read: vendor names, already baked into the pre-PIN editor pages',
  // May be assigned to HOME dashboard drawing buttons; nothing without the Sheet's UI.
  goToOrderEntry: UI, toggleOrderLogVisibility: UI, toggleSetupTabVisibility: UI,
  toggleMasterItemsTabVisibility: UI, showAdminResetSidebar: UI,
  // Run by hand from the Apps Script editor; each starts with requireEditorRun_().
  test_ping: EDITOR, test_getDashboard: EDITOR, test_getVendorItems: EDITOR, test_doPostFlow: EDITOR,
  test_getResetStatus: EDITOR, test_commitReset: EDITOR, test_emailRecap: EDITOR, test_getRecipients: EDITOR,
  test_recapFromLogToSelf: EDITOR, test_recapEmailToSelf: EDITOR, test_supabaseParity: EDITOR,
  purgeInactiveFromPickPath: EDITOR, migrateItemVendorsColumn: EDITOR,
  test_catalogTablesParity: EDITOR, editorBackToSheet: EDITOR,
  authorizeSupabase: 'editor, unguarded: changes nothing, and it is how a missing permission gets fixed'
};
const PAGE_CALLS = new Set(['webedit_call', 'editorAuth', 'editorPing', 'commitStoreSetup']);

// Every top-level function: name -> { file, body (blanked) }.
function declarations(files) {
  const out = new Map();
  for (const [f, text] of files) {
    const b = blank(text);
    const re = /^(?:async\s+)?function\s+(\w+)\s*\(/gm;
    let m;
    while ((m = re.exec(b))) {
      const open = b.indexOf('{', m.index);
      out.set(m[1], { file: f, body: b.slice(open + 1, open + 400) });
    }
  }
  return out;
}

// The method a google.script.run / MIRPC() chain finally calls, skipping
// withSuccessHandler(...) / withFailureHandler(...) / withUserObject(...).
function chainTargets(code, starter) {
  const targets = [];
  let at = code.indexOf(starter);
  while (at >= 0) {
    let i = at + starter.length;
    for (;;) {
      while (/\s/.test(code[i] || '')) i++;
      if (code[i] !== '.') break;
      i++;
      while (/\s/.test(code[i] || '')) i++;
      const m = /^\w+/.exec(code.slice(i));
      if (!m) break;
      i += m[0].length;
      while (/\s/.test(code[i] || '')) i++;
      if (/^with(SuccessHandler|FailureHandler|UserObject)$/.test(m[0]) && code[i] === '(') {
        let depth = 0;
        for (; i < code.length; i++) {
          if (code[i] === '(') depth++;
          else if (code[i] === ')') { depth--; if (depth === 0) { i++; break; } }
        }
        continue;
      }
      targets.push(m[0]);
      break;
    }
    at = code.indexOf(starter, at + 1);
  }
  return targets;
}

function dispatcherMap(editorGs) {
  const b = editorGs;
  const start = b.indexOf('function webeditDispatch_(');
  const end = b.indexOf('\nfunction ', start + 10);
  const body = b.slice(start, end);
  const map = new Map();
  const re = /case\s+'(\w+)'\s*:\s*return\s+(\w+)\s*;/g;
  let m;
  while ((m = re.exec(body))) map.set(m[1], m[2]);
  return map;
}

function problems(gsFiles, htmlFiles) {
  const out = [];
  const decl = declarations(gsFiles);
  const all = new Set(decl.keys());
  // 1 + 2
  for (const [name, d] of decl) {
    if (name.endsWith('_')) continue;
    const why = PUBLIC[name];
    if (!why) { out.push('public function not on the reviewed list: ' + name + ' (' + d.file + ')'); continue; }
    const first = d.body.trim();
    if (why === EDITOR && !/^requireEditorRun_\(\);/.test(first)) out.push(name + ' does not start with requireEditorRun_()');
    if (why === UI && !/^const\s+\w+\s*=\s*SpreadsheetApp\.(getUi|getActiveSpreadsheet)\(\)/.test(first) &&
        !/^SpreadsheetApp\.getUi\(\)/.test(first)) out.push(name + ' does not start by touching the Sheet UI');
  }
  for (const name of Object.keys(PUBLIC)) if (!all.has(name)) out.push('reviewed public function no longer exists: ' + name);
  // 3 + 4
  // Action names are strings, so the dispatcher is read from the raw text.
  const dispatch = dispatcherMap(gsFiles.find(([f]) => f === 'Editor.gs')[1]);
  if (dispatch.size < 20) out.push('dispatcher not found or too small (' + dispatch.size + ' actions)');
  for (const [action, fn] of dispatch) {
    if (!fn.endsWith('_')) out.push('dispatcher action ' + action + ' maps to a PUBLIC function ' + fn);
    if (!all.has(fn)) out.push('dispatcher action ' + action + ' maps to a missing function ' + fn);
  }
  for (const [f, text] of htmlFiles) {
    const code = blankAny(text);
    for (const t of chainTargets(code, 'google.script.run')) {
      if (!PAGE_CALLS.has(t)) out.push(f + ' calls google.script.run.' + t + ' directly (only the door and the auth layer)');
    }
    for (const t of chainTargets(code, 'MIRPC()')) {
      if (!dispatch.has(t)) out.push(f + ' sends MIRPC().' + t + ', which the dispatcher does not know');
    }
    const re = /webedit_call\(\s*[\w.()]+\s*,\s*'(\w+)'/g;
    let m;
    // Action names live in strings, so read them from the raw text.
    while ((m = re.exec(text))) if (!dispatch.has(m[1])) out.push(f + " sends webedit_call(..., '" + m[1] + "'), which the dispatcher does not know");
  }
  // 5
  for (const [f, text] of gsFiles) {
    let m;
    const menu = /\.addItem\(\s*"[^"]*"\s*,\s*"(\w+)"\s*\)/g;
    while ((m = menu.exec(text))) if (!all.has(m[1])) out.push(f + ': menu item names a missing function ' + m[1]);
    const trig = /newTrigger\(\s*'(\w+)'\s*\)/g;
    while ((m = trig.exec(text))) if (!all.has(m[1])) out.push(f + ': trigger handler is missing: ' + m[1]);
  }
  return out;
}

const read = f => fs.readFileSync(path.join(DIR, f), 'utf8');
const gs = GS.map(f => [f, read(f)]);
const html = HTML.map(f => [f, read(f)]);

let failed = 0;
const p = problems(gs, html);
const publicCount = Array.from(declarations(gs).keys()).filter(n => !n.endsWith('_')).length;
if (p.length) { failed++; console.log('FAIL  ' + p.length + ' problem(s):'); for (const x of p.slice(0, 20)) console.log('      ' + x); }
else console.log('PASS  ' + publicCount + ' public functions, all reviewed; pages reach the server only through the door and the auth layer');

// ---- Controls --------------------------------------------------------------
const swap = (list, file, fn) => list.map(([f, t]) => [f, f === file ? fn(t) : t]);
const CONTROLS = [
  ['a new public save function', () => problems(swap(gs, 'Items.gs', t => t + '\nfunction commitEvil(x) { return x; }\n'), html)],
  ['a page calling a save function directly', () => problems(gs, swap(html, 'ManageItems.html',
    t => t.replace('</body>', '<script>google.script.run.withSuccessHandler(function(r){ x(r); }).commitUpsertItem_({});</script></body>')))],
  ['an editor-run function without its guard', () => problems(swap(gs, 'Admin.gs',
    t => t.replace(/(function test_commitReset\s*\(\)\s*\{\s*)requireEditorRun_\(\);/, '$1')), html)],
  ['the dispatcher pointing at a public function', () => problems(swap(gs, 'Editor.gs',
    t => t.replace("case 'getVendorTableData':               return getVendorTableData_;", "case 'getVendorTableData':               return getVendorList;")), html)],
  ['a page sending an action the dispatcher lacks', () => problems(gs, swap(html, 'StorageAreas.html',
    t => t.replace('</body>', '<script>MIRPC().withSuccessHandler(ok).commitNoSuchThing(1);</script></body>')))],
  ['a menu item naming a missing function', () => problems(swap(gs, 'Core.gs',
    t => t.replace('"showManageItemsSidebar_")', '"showManageItemsSidebar")')), html)]
];
for (const [name, run] of CONTROLS) {
  let bit;
  try { bit = run().length > 0; } catch (e) { failed++; console.log(`FAIL  control "${name}" crashed: ${e.message}`); continue; }
  if (bit) console.log(`PASS  control "${name}" bites`);
  else { failed++; console.log(`FAIL  control "${name}" did NOT bite`); }
}

console.log(failed ? `public_surface: ${failed} FAILED` : 'public_surface: ALL PASS');
process.exit(failed ? 1 : 0);
