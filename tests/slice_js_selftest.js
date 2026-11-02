// slice_js_selftest.js - each trap slice_js.js exists to close, as a fixture a raw-text slicer gets
// WRONG, plus planted defects that prove each check can still fail.
//   node slice_js_selftest.js   -> "slice_js_selftest: ALL PASS (35 checks, 9 controls)", exit 0
// A CONTROL plants one defect in slice_js.js's own source (an exact find -> replace) and requires
// at least one check to fail on the planted copy. A control that cannot bite means no check covers
// that behaviour any more; a control whose anchor is gone fails too. Re-anchor it after a
// refactor; never delete it to go green.
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

// In LF: the controls' anchors are, and a Windows checkout may give the file CRLF.
const SRC = fs.readFileSync(path.join(__dirname, 'slice_js.js'), 'utf8').replace(/\r\n/g, '\n');
const load = src => { const m = { exports: {} }; new Function('module', 'exports', src)(m, m.exports); return m.exports; };
const throws = fn => { try { fn(); return false; } catch (e) { return true; } };
const compiles = s => { try { new vm.Script(s); return true; } catch (e) { return false; } };

// The raw-text slicer the skill shipped before slice_js.js, kept only to prove each fixture separates.
function rawSlice(src, name) {
  const re = new RegExp('(^|[^\\w$])function\\s+' + name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*\\(', 'm');
  const m = re.exec(src);
  if (!m) throw new Error('no declaration');
  const at = m.index + m[1].length;
  let d = 0;
  for (let i = src.indexOf('{', at); i < src.length; i++) {
    if (src[i] === '{') d++;
    else if (src[i] === '}') { d--; if (d === 0) return src.slice(at, i + 1); }
  }
  throw new Error('unbalanced');
}

// Every check, against module k. Each check is a thunk: one that THROWS is that check's FAIL,
// never a crash of the run. Returns [{ section, label, pass, err }].
function checks(k) {
  const out = [];
  let section = '';
  const sec = s => { section = s; };
  const ok = (label, check) => {
    let pass, err = '';
    try { pass = !!check(); } catch (e) { pass = false; err = ' (threw: ' + e.message + ')'; }
    out.push({ section, label, pass, err });
  };

  sec('blank(): strings, comments, regexes and templates cannot be read as code');
  {
    const src = "var s = '{'; // don't {\nvar r = /['{]/g; var t = `a ${ {x: '}'}.x } b`; var q = a / b / c;\nfunction f(){ return 1; }";
    const b = k.blank(src);
    ok('same length, same newlines', () => b.length === src.length && b.split('\n').length === src.split('\n').length);
    ok('a brace inside a string is blanked', () => b.slice(0, 12).indexOf('{') === -1);
    ok('a line comment is blanked, apostrophe and brace included', () => b.split('\n')[0].indexOf('don') === -1 && b.split('\n')[0].indexOf('{') === -1);
    ok('a regex literal is blanked', () => b.indexOf("['{]") === -1);
    ok('a template literal, ${} hole included, is blanked', () => b.indexOf('x:') === -1);
    ok('a division is still code', () => /var q = a \/ b \/ c;/.test(b));
    ok('the function after all of it is intact', () => b.indexOf('function f(){ return 1; }') !== -1);
  }

  sec('slice(): the silent case, and the loud ones');
  {
    // THE silent case: a `{` in a string of the target, compensated by a `}` in a string of a LATER
    // function. Raw counting returns a+b, it compiles, and b's declaration shadows any stub of b.
    const silent = 'function a(){ var s = "{"; return s; }\nfunction b(){ return "}"; }\nfunction c(){}';
    ok('the raw slicer returns an overlong slice here (the fixture separates)', () => /function b/.test(rawSlice(silent, 'a')));
    ok('...and that overlong slice COMPILES, which is what makes it silent', () => compiles(rawSlice(silent, 'a')));
    ok('slice returns exactly a', () => k.slice(silent, 'a') === 'function a(){ var s = "{"; return s; }');

    // Uncompensated, the raw slicer throws: loud, so this fixture alone does not show the trap.
    const uncompensated = 'function a(){ var s = "{"; return s; }\nfunction b(){}';
    ok('uncompensated: the raw slicer throws (loud; this fixture alone proves nothing)', () => throws(() => rawSlice(uncompensated, 'a')));
    ok('uncompensated: slice returns exactly a', () => k.slice(uncompensated, 'a') === 'function a(){ var s = "{"; return s; }');

    const commentPair = 'function a(){ // if (x) {\n  return 1; }\nfunction b(){ /* } */ return 2; }';
    ok('a commented { and a later commented } do not merge two functions', () => k.slice(commentPair, 'a') === 'function a(){ // if (x) {\n  return 1; }');

    const closeInString = 'function c(){ return "}"; }\nvar after = 1;';
    ok('a } in a string does not truncate the slice', () => k.slice(closeInString, 'c') === 'function c(){ return "}"; }');

    const regex = "function esc(s){ return String(s).replace(/[{}']/g, ''); }\nfunction next(){}";
    ok('braces and a quote inside a regex are not counted', () => k.slice(regex, 'esc') === "function esc(s){ return String(s).replace(/[{}']/g, ''); }");

    const regexInHole = "function card(t){\n  return `<b onclick=\"go('${esc(t.name).replace(/'/g, \"\\\\'\")}')\">x</b>`;\n}\nfunction after(){ return 1; }";
    ok('a regex with a quote INSIDE a template ${} hole does not desync the scan',
      () => k.slice(regexInHole, 'card').endsWith('`;\n}') && k.slice(regexInHole, 'after') === 'function after(){ return 1; }');

    const nested = 'function n(){ return `a ${ `b ${ "}" } c` } d`; }\nfunction m(){}';
    ok('a nested template inside a hole, with a } in a string, stays one template', () => k.slice(nested, 'n') === 'function n(){ return `a ${ `b ${ "}" } c` } d`; }');

    // An object literal's `}` must not close the hole: closed early, the nested template's opening
    // backtick would end the OUTER one and its `}` would close the function.
    const braceInHole = 'function h(){ return `a ${ {k: 1}.k + `}` } b`; }\nfunction h2(){ return 2; }';
    ok('a {} inside a hole does not close the hole early', () => k.slice(braceInHole, 'h') === 'function h(){ return `a ${ {k: 1}.k + `}` } b`; }');

    const prefix = 'function foo_v2(){ return 2; }\nfunction foo(){ return 1; }';
    ok('slice takes the exact name, not a longer one that starts with it', () => k.slice(prefix, 'foo') === 'function foo(){ return 1; }');
    ok('a missing function throws', () => throws(() => k.slice('function x(){}', 'y')));
    ok('a function declared twice throws instead of guessing', () => throws(() => k.slice('function x(){}\nfunction x(){ return 1; }', 'x')));
    ok('a method assignment is not a declaration', () => throws(() => k.slice('obj.foo = function(){};', 'foo')));
    ok('a call of a name that merely starts with "function" is not a declaration of it',
      () => k.slice('functionfoo();\nfunction foo(){ return 1; }', 'foo') === 'function foo(){ return 1; }');
    ok('default parameters with braces are skipped', () => k.slice('function g(a = {x: 1}){ return a; }', 'g') === 'function g(a = {x: 1}){ return a; }');
    ok('an async function keeps its async', () => k.slice('async function h(){ await 1; }', 'h') === 'async function h(){ await 1; }');

    const html = "<p>Don't miss it: https://example.com</p>\n<script>\n  function z(){ return '</p>'; }\n</script>";
    ok('an HtmlService partial: markup apostrophes and URLs cannot open a string or comment', () => k.slice(html, 'z') === "function z(){ return '</p>'; }");
    // A lone backtick in page text would open a template literal that swallows the whole script.
    const htmlTick = '<p>Press the ` key to toggle.</p>\n<script>\n  function y(){ return 1; }\n</script>\n<p>More ` text</p>';
    ok('an HtmlService partial: a backtick in page text cannot open a template over the script', () => k.slice(htmlTick, 'y') === 'function y(){ return 1; }');
    const gsMentionsScript = '// never put a scriptlet in a <script> block\nfunction doGet(e){ return 1; }';
    ok('a .gs that only MENTIONS <script> is still code', () => k.slice(gsMentionsScript, 'doGet') === 'function doGet(e){ return 1; }');
    ok('hasFunction answers without throwing', () => k.hasFunction(prefix, 'foo') && !k.hasFunction(prefix, 'nope'));
    ok('slices joins several, in order', () => k.slices(prefix, ['foo', 'foo_v2']) === 'function foo(){ return 1; }\nfunction foo_v2(){ return 2; }');
  }

  sec('sliceConst(): top-level tables, bracket-matched');
  {
    const src = "function f(){ const X = 1; }\nconst X = { a: '}', b: { c: [1, 2] } };\nconst N = 5;\nvar V = [ '[', ']' ];";
    ok('a top-level object with braces in its strings; the local X inside f is ignored', () => k.sliceConst(src, 'X') === "const X = { a: '}', b: { c: [1, 2] } };");
    ok('a primitive runs to its semicolon', () => k.sliceConst(src, 'N') === 'const N = 5;');
    ok('a var array works the same', () => k.sliceConst(src, 'V') === "var V = [ '[', ']' ];");
    ok('a missing constant throws', () => throws(() => k.sliceConst(src, 'Q')));
    ok('a constant declared twice at top level throws', () => throws(() => k.sliceConst('var K = 1;\nvar K = 2;', 'K')));
  }
  return out;
}

const CONTROLS = [
  ["hole scanned by kit loop (no regex)", "if (c === '$' && src[j + 1] === '{') { j = code(j + 2, true) + 1; continue; }", "if (c === '$' && src[j + 1] === '{') {\n        j += 2;\n        let dd = 1;\n        while (j < n && dd > 0) {\n          const d = src[j];\n          if (d === '\\'' || d === '\"') { j = skipString(j); continue; }\n          if (d === '`') { j = skipTemplate(j); continue; }\n          if (d === '{') dd++;\n          else if (d === '}') dd--;\n          j++;\n        }\n        continue;\n      }"],
  ["blank() does nothing (raw counting)", "  code(0, false);\n  return out.join('');", "  return src;"],
  ["async dropped from the anchor", "((?:async\\\\s+)?function", "(function"],
  ["generator alternative too loose", "function(?:\\\\s*\\\\*\\\\s*|\\\\s+)", "function\\\\s*\\\\*?\\\\s*"],
  ["duplicate declaration not refused", "  if (at.length > 1) throw new Error('slice: function ' + name + ' is declared ' + at.length + ' times; slice the file it belongs to');\n", ""],
  ["markup not blanked in partials", "  if (!/^[ \\t]*<script[\\s>]/im.test(src)) return blank(src);", "  return blank(src);"],
  [".gs mentioning <script> treated as markup", "  if (!/^[ \\t]*<script[\\s>]/im.test(src)) return blank(src);", "  if (!/<script/i.test(src)) return blank(src);"],
  ["sliceConst ignores depth", "    if (depth[s] === 0) hits.push", "    if (true) hits.push"],
  ["brace depth not tracked inside a hole", "        if (c === '{') depth++;\n", "        if (false) depth++;\n"]
];

let failed = 0;
let section = null;
const results = checks(load(SRC));
for (const r of results) {
  if (r.section !== section) { section = r.section; console.log('\n' + section); }
  if (!r.pass) failed++;
  console.log((r.pass ? 'PASS  ' : 'FAIL  ') + r.label + r.err);
}

console.log('\nCONTROLS (each must make at least one check fail)');
for (const [label, find, repl] of CONTROLS) {
  const n = SRC.split(find).length - 1;
  if (n !== 1) { failed++; console.log('FAIL  control "' + label + '": anchor found ' + n + ' times (re-anchor it; never delete a control)'); continue; }
  let planted;
  try { planted = load(SRC.replace(find, () => repl)); }
  catch (e) { failed++; console.log('FAIL  control "' + label + '": the planted source crashed (' + e.message + '); a crash is not a bite'); continue; }
  const bit = checks(planted).filter(r => !r.pass).map(r => r.label);
  if (bit.length) console.log('PASS  control "' + label + '" bites: ' + bit.join(' | ').slice(0, 160));
  else { failed++; console.log('FAIL  control "' + label + '" did not bite: no check separates it'); }
}

const tail = results.length + ' checks, ' + CONTROLS.length + ' controls';
console.log('\nslice_js_selftest: ' + (failed ? failed + ' FAILED (' + tail + ')' : 'ALL PASS (' + tail + ')'));
process.exitCode = failed ? 1 : 0;
