'use strict';
// GATE: the store concepts (Roll Play, Teas’n You, ĂN, Lei’d Poke) agree
// everywhere a store's concept is named, and every way of setting one accepts
// all of them (2026-10-19: the wizard offered ĂN and Lei'd but the server
// refused them, and Lei'd was spelled three ways).
//
// The list is Dashboard.gs CONCEPT_THEMES (knownConcepts_), each with its
// display `name`. Checked against it:
//   - the setup wizard (Setup.html): its concept list, display names and accents
//   - the app (template/index.html): CONCEPT_NAMES_ and a [data-theme] block each
//   - build.py CONCEPT_TO_THEME: the display name maps to the theme; every
//     value is a known theme (aliases like "AN" allowed)
//   - the hub (index.html) CONCEPT_VISUALS: a key spelled like the display name
//   - EditorShell.html mgeShortLoc_: the prefix it strips is the display name
//   - stores.json: every store's concept is a build.py key
//   - commitStoreSetup (the wizard's save), Setup / Re-run Setup and Set Store
//     Concept (the Sheet menus): each concept is saved; 'default', unknown
//     names and out-of-range numbers are refused; blank clears
// Each check has a planted-defect control.
//
// Run bare: node tests/concepts.test.js
// A passing run ends with "concepts: ALL PASS".

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const F = require('./fake_apps_script.js');

const DIR = path.join(F.REPO, 'apps-script');
const GS = fs.readdirSync(DIR).filter(f => f.endsWith('.gs')).sort();
const plain = file => F.source(null, file);
const straightLower = s => String(s).toLowerCase().replace(/’/g, "'");

// A JS object or array literal that follows `head` in `text`, evaluated as JS
// (so escapes and comments behave as in the page).
function jsLiteral(text, head, file) {
  const at = text.indexOf(head);
  if (at < 0) throw new Error(file + ': "' + head + '" not found');
  const open = at + head.length;
  const close = text[open] === '[' ? ']' : '}';
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if (text[i] === text[open]) depth++;
    else if (text[i] === close && --depth === 0) return vm.runInNewContext('(' + text.slice(open, i + 1) + ')');
  }
  throw new Error(file + ': "' + head + '" never closes');
}

// build.py's CONCEPT_TO_THEME: "Name": "theme" pairs, comments dropped.
function buildConcepts(text) {
  const m = /^CONCEPT_TO_THEME = \{([\s\S]*?)^\}/m.exec(text);
  if (!m) throw new Error('build.py: CONCEPT_TO_THEME not found');
  const out = {};
  for (const line of m[1].split('\n')) {
    const p = /^\s*"([^"]+)":\s*"([^"]+)"/.exec(line.replace(/#.*$/, ''));
    if (p) out[p[1]] = p[2];
  }
  return out;
}

function fakeUi(answers, log) {
  const Button = { OK: 'OK', CANCEL: 'CANCEL', YES: 'YES', NO: 'NO' };
  return {
    Button,
    ButtonSet: { OK: 'OK', OK_CANCEL: 'OK_CANCEL', YES_NO: 'YES_NO' },
    prompt: (title, text) => {
      log.push(String(text));
      const a = answers.length ? answers.shift() : null;
      return { getSelectedButton: () => (a === null ? Button.CANCEL : Button.OK), getResponseText: () => (a === null ? '' : a) };
    },
    alert: function () {
      log.push('ALERT ' + Array.from(arguments).filter(x => typeof x === 'string').join(' '));
      return Button.OK;
    }
  };
}

// One fresh store: the whole Apps Script codebase in a fake context.
function makeSide(script, scriptProps, uiAnswers) {
  const side = F.makeContext({ now: Date.UTC(2026, 9, 19, 15), sheets: {}, scriptProps: scriptProps || {} });
  side.ctx.Utilities.getUuid = () => 'tok-' + Math.random().toString(36).slice(2);
  side.log = [];
  side.ctx.SpreadsheetApp.getUi = () => fakeUi((uiAnswers || []).slice(), side.log);
  script.runInContext(side.ctx);
  return side;
}

function run(srcOf) {
  const problems = [];
  const bad = s => problems.push(s);
  const script = new vm.Script(GS.map(f => srcOf('apps-script/' + f)).join('\n'), { filename: 'all-gs.js' });

  // The list, from the server.
  const probe = makeSide(script);
  const known = Array.from(vm.runInContext('knownConcepts_()', probe.ctx));
  const themes = vm.runInContext('CONCEPT_THEMES', probe.ctx);
  const name = {};
  for (const c of known) {
    if (!themes[c].name) bad('Dashboard.gs: CONCEPT_THEMES[\'' + c + '\'] has no name');
    name[c] = themes[c].name;
  }
  if (known.indexOf('default') >= 0) bad('knownConcepts_ includes default');
  if (known.length < 4) bad('knownConcepts_ lists ' + known.length + ' concepts: ' + known.join(', '));

  // The setup wizard.
  const setup = srcOf('apps-script/Setup.html');
  const order = jsLiteral(setup, 'var CONCEPT_ORDER = ', 'Setup.html');
  const setupName = jsLiteral(setup, 'var CONCEPT_NAME = ', 'Setup.html');
  const setupTheme = jsLiteral(setup, 'var CONCEPT_THEME = ', 'Setup.html');
  if (order.slice().sort().join() !== known.slice().sort().join()) {
    bad('Setup.html offers ' + order.join(', ') + ' but the server knows ' + known.join(', '));
  }
  for (const c of known) {
    if (setupName[c] !== name[c]) bad('Setup.html names ' + c + ' "' + setupName[c] + '", the server "' + name[c] + '"');
    if (!setupTheme[c] || String(setupTheme[c].accent).toLowerCase() !== String(themes[c].accent).toLowerCase()) {
      bad('Setup.html accent for ' + c + ' differs from Dashboard.gs');
    }
  }

  // The app.
  const app = srcOf('template/index.html');
  const appName = jsLiteral(app, 'const CONCEPT_NAMES_ = ', 'template/index.html');
  for (const c of known) {
    if (appName[c] !== name[c]) bad('template/index.html CONCEPT_NAMES_ names ' + c + ' "' + appName[c] + '", the server "' + name[c] + '"');
    if (app.indexOf('[data-theme="' + c + '"] {') < 0) bad('template/index.html has no [data-theme="' + c + '"] block');
  }

  // build.py.
  const build = buildConcepts(srcOf('build.py'));
  for (const c of known) {
    if (build[name[c]] !== c) bad('build.py CONCEPT_TO_THEME has no "' + name[c] + '" -> "' + c + '"');
  }
  for (const k of Object.keys(build)) {
    if (known.indexOf(build[k]) < 0) bad('build.py maps "' + k + '" to unknown theme "' + build[k] + '"');
  }

  // The hub.
  const hub = jsLiteral(srcOf('index.html'), 'const CONCEPT_VISUALS = ', 'index.html');
  for (const c of known) if (!hub[name[c]]) bad('index.html CONCEPT_VISUALS has no "' + name[c] + '"');

  // The editor band's location shortener.
  const shell = srcOf('apps-script/EditorShell.html');
  const fnAt = shell.indexOf('function mgeShortLoc_(');
  const prefix = jsLiteral(shell.slice(fnAt), 'var names = ', 'EditorShell.html');
  for (const c of known) {
    if (prefix[c] !== straightLower(name[c])) {
      bad('EditorShell.html mgeShortLoc_ strips "' + prefix[c] + '" for ' + c + ', not "' + straightLower(name[c]) + '"');
    }
  }

  // stores.json.
  const stores = JSON.parse(srcOf('stores.json'));
  for (const s of stores) if (!build[s.concept]) bad('stores.json ' + s.slug + ': concept "' + s.concept + '" is not a build.py key');

  // The wizard's save.
  const wizard = (concept) => {
    const side = makeSide(script);
    side.ctx.__p = { pin: '4321', location: 'Test Store BOH', abbr: 'TSBOH', concept: concept };
    const res = vm.runInContext('commitStoreSetup(__p)', side.ctx);
    return { res, concept: side.scriptProps.get('MOG_CONCEPT'), pin: side.scriptProps.get('MOG_API_PIN') };
  };
  for (const c of known) {
    const w = wizard(c);
    if (!w.res.ok || w.concept !== c) bad('commitStoreSetup with ' + c + ': ' + JSON.stringify(w.res) + ', MOG_CONCEPT ' + w.concept);
  }
  for (const c of ['default', 'nope']) {
    const w = wizard(c);
    if (w.res.ok || w.res.error !== 'concept' || w.pin) bad('commitStoreSetup accepted concept "' + c + '"');
  }
  const blank = wizard('');
  if (!blank.res.ok || blank.concept !== undefined) bad('commitStoreSetup with no concept: ' + JSON.stringify(blank.res));

  // The Sheet menus.
  const menuLine = (c, i) => (i + 1) + ' = ' + name[c];
  known.forEach((c, i) => {
    const side = makeSide(script, { MOG_CONCEPT: 'roll-play' }, [String(i + 1)]);
    vm.runInContext('setStoreConcept_()', side.ctx);
    if (side.scriptProps.get('MOG_CONCEPT') !== c) bad('Set Store Concept ' + (i + 1) + ' saved ' + side.scriptProps.get('MOG_CONCEPT') + ', not ' + c);
    if (side.log[0].indexOf(menuLine(c, i)) < 0) bad('Set Store Concept prompt lacks "' + menuLine(c, i) + '"');

    const full = makeSide(script, {}, ['4321', 'Test Store BOH', 'TSB', String(i + 1), '', '']);
    vm.runInContext('setupMobileApi_()', full.ctx);
    if (full.scriptProps.get('MOG_CONCEPT') !== c) bad('Setup / Re-run Setup ' + (i + 1) + ' saved ' + full.scriptProps.get('MOG_CONCEPT') + ', not ' + c);
    if (full.log[3].indexOf(menuLine(c, i)) < 0) bad('Setup / Re-run Setup prompt lacks "' + menuLine(c, i) + '"');
  });
  for (const wrong of ['0', String(known.length + 1), 'an', '2.5']) {
    const side = makeSide(script, { MOG_CONCEPT: 'roll-play' }, [wrong]);
    vm.runInContext('setStoreConcept_()', side.ctx);
    if (side.scriptProps.get('MOG_CONCEPT') !== 'roll-play') bad('Set Store Concept took "' + wrong + '"');
  }
  const cleared = makeSide(script, { MOG_CONCEPT: 'leid' }, ['']);
  vm.runInContext('setStoreConcept_()', cleared.ctx);
  if (cleared.scriptProps.get('MOG_CONCEPT') !== undefined) bad('Set Store Concept blank did not clear the concept');

  return problems;
}

// ---------------------------------------------------------------------------
let failed = 0;
const main = run(plain);
if (main.length) {
  failed++;
  console.log('FAIL  ' + main.length + ' problem(s):');
  for (const p of main) console.log('      ' + p);
} else {
  console.log('PASS  every file names the four concepts alike, and the wizard and both Sheet menus save each one');
}

const CONTROLS = [
  { name: 'the wizard back to two concepts', file: 'apps-script/Editor.gs',
    find: "const concept   = isKnownConcept_(conceptIn) ? conceptIn : '';",
    replace: "const concept   = conceptIn === 'roll-play' || conceptIn === 'teasnyou' ? conceptIn : '';" },
  { name: 'a menu number off by one', file: 'apps-script/Admin.gs',
    find: '? list[n - 1] : null;', replace: '? list[n] || null : null;' },
  { name: 'Lei\'d back to "Lei\'d" in build.py', file: 'build.py',
    find: '"Lei’d Poke": "leid",', replace: '"Lei\'d":      "leid",' },
  { name: 'the hub with a straight apostrophe', file: 'index.html',
    find: "'Lei’d Poke':      { icon: 'fish' },", replace: "'Lei\\'d Poke':     { icon: 'fish' }," },
  { name: 'the wizard spelling Lei\'d straight', file: 'apps-script/Setup.html',
    find: "'leid': 'Lei’d Poke' };", replace: "'leid': 'Lei\\'d Poke' };" },
  { name: 'the app naming ĂN without its breve', file: 'template/index.html',
    find: "'an': 'ĂN', 'leid': 'Lei’d Poke' };", replace: "'an': 'AN', 'leid': 'Lei’d Poke' };" },
  { name: 'the editor band stripping "an" for ĂN', file: 'apps-script/EditorShell.html',
    find: "'an': 'ăn',", replace: "'an': 'an'," },
  { name: 'a concept dropped from the server list', file: 'apps-script/Dashboard.gs',
    find: "  'leid':      { name: \"Lei’d Poke\",", replace: "  'leidx':     { name: \"Lei’d Poke\"," },
  { name: 'a store with a straight-apostrophe concept', file: 'stores.json', first: true,
    find: '"concept": "Teas’n You",', replace: '"concept": "Teas\'n You",' }
];
for (const c of CONTROLS) {
  const planted = f => (c.first ? (plain(f).indexOf(c.find) < 0 ? F.plant(plain(f), c.find, c.replace)
                                                                 : plain(f).replace(c.find, c.replace))
                                : F.plant(plain(f), c.find, c.replace));
  const srcOf = f => (f === c.file ? planted(f) : plain(f));
  let caught;
  try { caught = run(srcOf).length > 0; } catch (e) { caught = !/plant:/.test(e.message); if (!caught) throw e; }
  if (!caught) { failed++; console.log('FAIL  control not caught: ' + c.name); }
}
if (!failed) console.log('PASS  all ' + CONTROLS.length + ' planted defects caught');

console.log(failed ? 'concepts: FAILED' : 'concepts: ALL PASS');
process.exit(failed ? 1 : 0);
