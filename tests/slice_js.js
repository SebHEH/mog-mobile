// slice_js.js - take ONE function (or one top-level constant) out of shipped Apps Script source,
// matched on code, never on prose. The slicer appsscript-refactor-equivalence section 1b calls for.
//
// Vendor this file next to your harnesses (a committed harness must not require() a path outside
// the repo), then:
//
//   const { slice, slices, sliceConst } = require('./slice_js.js');
//   const src = fs.readFileSync(path.join(REPO, 'Code.gs'), 'utf8');
//   const code = slices(src, ['parseRow_', 'keyOf_']) + '\n' + sliceConst(src, 'COLS');
//   vm.runInContext(code, ctx);             // only these declarations; your stubs stay live
//
// Why not count braces on the raw text: a `{` inside a string, comment or regex of the target, plus
// a `}` in one of a LATER function, returns an overlong slice that still compiles; its extra
// declarations then shadow your stubs without a word. An uncompensated brace throws or truncates,
// which is at least loud. Here every brace is counted on blank(src), where the inside of every
// comment, string, template literal and regex literal is spaces.
//
// Self-test: node slice_js_selftest.js (prints "slice_js_selftest: ALL PASS (N checks)").
// Not handled: a regex literal right after `)` or `]` (read as division), and code that is not
// JavaScript inside a <script> block (a JSON or template <script type>). Both throw or fail to
// compile rather than slicing wrong in every case seen.
'use strict';

const REGEX_AFTER_WORD = { 'return': 1, 'typeof': 1, 'case': 1, 'do': 1, 'else': 1, 'in': 1, 'of': 1,
  'new': 1, 'delete': 1, 'void': 1, 'throw': 1, 'instanceof': 1, 'yield': 1, 'await': 1 };

// The same text with the INSIDE of every comment, string, template literal (holes included) and regex
// literal replaced by spaces. Same length, same newlines: an index into it is an index into src.
function blank(src) {
  const out = src.split('');
  const n = src.length;
  const wipe = (a, b) => { for (let k = a; k < b; k++) if (out[k] !== '\n' && out[k] !== '\r') out[k] = ' '; };

  function skipString(at) {
    const q = src[at];
    let j = at + 1;
    while (j < n && src[j] !== q) {
      if (src[j] === '\\') j++;
      else if (src[j] === '\n') break;                     // unterminated: stop at the line end
      j++;
    }
    return Math.min(j + 1, n);
  }

  // Past the closing `/` and flags, or -1 when this is a division after all (no close on the line).
  function skipRegex(at) {
    let j = at + 1, klass = false;
    while (j < n) {
      const c = src[j];
      if (c === '\\') { j += 2; continue; }
      if (c === '\n') return -1;
      if (c === '[') klass = true;
      else if (c === ']') klass = false;
      else if (c === '/' && !klass) break;
      j++;
    }
    if (j >= n) return -1;
    j++;
    while (j < n && /[a-z]/i.test(src[j])) j++;
    return j;
  }

  // Past the closing backtick. A ${ } hole is CODE, so it is scanned by code() - a regex, string or
  // nested template inside it cannot end the template early - and then blanked with the rest.
  function skipTemplate(at) {
    let j = at + 1;
    while (j < n) {
      const c = src[j];
      if (c === '\\') { j += 2; continue; }
      if (c === '`') return j + 1;
      if (c === '$' && src[j + 1] === '{') { j = code(j + 2, true) + 1; continue; }
      j++;
    }
    return n;
  }

  // Scan code from i. In a template hole, return the index of the `}` that closes the hole.
  function code(i, inHole) {
    let prev = '', depth = 0;               // prev: 'value' | 'word:<kw>' | 'punct' | '' (start)
    while (i < n) {
      const c = src[i], nx = src[i + 1];
      if (c === '/' && nx === '*') {
        const e = src.indexOf('*/', i + 2), end = e === -1 ? n : e + 2;
        wipe(i, end); i = end; continue;
      }
      if (c === '/' && nx === '/') {
        const e = src.indexOf('\n', i), end = e === -1 ? n : e;
        wipe(i, end); i = end; continue;
      }
      if (c === '\'' || c === '"') {
        const end = skipString(i);
        wipe(i + 1, end - 1); i = end; prev = 'value'; continue;
      }
      if (c === '`') {
        const end = skipTemplate(i);
        wipe(i + 1, end - 1); i = end; prev = 'value'; continue;
      }
      if (c === '/') {
        // After a value (a name, a number, `)` or `]`) a slash divides; otherwise it opens a regex.
        const regexHere = prev === '' || prev === 'punct' || (prev.indexOf('word:') === 0 && REGEX_AFTER_WORD[prev.slice(5)]);
        if (regexHere) {
          const end = skipRegex(i);
          if (end !== -1) { wipe(i + 1, end); i = end; prev = 'value'; continue; }
        }
        prev = 'punct'; i++; continue;
      }
      if (/[A-Za-z_$]/.test(c)) {
        let j = i + 1;
        while (j < n && /[\w$]/.test(src[j])) j++;
        const w = src.slice(i, j);
        prev = REGEX_AFTER_WORD[w] ? 'word:' + w : 'value';
        i = j; continue;
      }
      if (/[0-9]/.test(c)) {
        let j = i + 1;
        while (j < n && /[\w.]/.test(src[j])) j++;
        prev = 'value'; i = j; continue;
      }
      if (inHole) {
        if (c === '{') depth++;
        else if (c === '}') { if (depth === 0) return i; depth--; }
      }
      if (c === ')' || c === ']') { prev = 'value'; i++; continue; }
      if (!/\s/.test(c)) prev = 'punct';
      i++;
    }
    return n;
  }

  code(0, false);
  return out.join('');
}

// blank() for a file that may be an HtmlService partial: markup outside <script> blocks becomes
// spaces (newlines kept) and each block is blanked as JavaScript, so an apostrophe or a `//` URL in
// the markup cannot open a string or a comment that runs into the code. A file is a partial when a
// <script> TAG starts a line; a .gs that only MENTIONS one in a comment is still code.
function blankAny(src) {
  if (!/^[ \t]*<script[\s>]/im.test(src)) return blank(src);
  const out = src.replace(/[^\n\r]/g, ' ').split('');
  const re = /(<script[^>]*>)([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(src)) !== null) {
    const at = m.index + m[1].length, body = blank(m[2]);
    for (let k = 0; k < body.length; k++) out[at + k] = body[k];
  }
  return out.join('');
}

const escRe_ = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Index just past the bracket that closes the one at `at` ( ( [ or { ), matched on blanked text.
function matchClose_(blanked, at) {
  const open = blanked[at], close = open === '(' ? ')' : open === '[' ? ']' : '}';
  let d = 0;
  for (let j = at; j < blanked.length; j++) {
    if (blanked[j] === open) d++;
    else if (blanked[j] === close) { d--; if (d === 0) return j + 1; }
  }
  return -1;
}

// Start offsets of every `[async] function NAME(` - the exact name, never a longer one that starts
// with it, and not `obj.NAME = function`.
function declsOf_(blanked, name) {
  const re = new RegExp('(^|[^\\w$.])((?:async\\s+)?function(?:\\s*\\*\\s*|\\s+)' + escRe_(name) + '\\s*\\()', 'g');
  const at = [];
  let m;
  while ((m = re.exec(blanked)) !== null) at.push(m.index + m[1].length);
  return at;
}

function hasFunction(src, name) { return declsOf_(blankAny(src), name).length > 0; }

// Exactly one declaration of NAME, or it throws: none, two (the later one would win at runtime, so
// slicing the first is a guess), or unbalanced brackets. Never returns undefined, because
// vm.runInContext(undefined) does not throw and the harness would run on without the function.
function slice(src, name) {
  const b = blankAny(src);
  const at = declsOf_(b, name);
  if (!at.length) throw new Error('slice: no declaration of function ' + name);
  if (at.length > 1) throw new Error('slice: function ' + name + ' is declared ' + at.length + ' times; slice the file it belongs to');
  const start = at[0];
  const paren = b.indexOf('(', start);
  const afterParams = matchClose_(b, paren);
  if (afterParams === -1) throw new Error('slice: unbalanced parameter list in ' + name);
  const brace = b.indexOf('{', afterParams);
  const end = brace === -1 ? -1 : matchClose_(b, brace);
  if (end === -1) throw new Error('slice: unbalanced braces in ' + name);
  return src.slice(start, end);
}

function slices(src, names) { return names.map(n => slice(src, n)).join('\n'); }

// A TOP-LEVEL `const|let|var NAME = <initializer>;` as source text ending in `;`. Slice lookup tables
// from the source instead of hand-copying them into the sandbox, where the copy goes stale with the
// next entry. Only depth-0 declarations count, so a local of the same name never matches.
function sliceConst(src, name) {
  const b = blankAny(src);
  const depth = new Int32Array(b.length + 1);
  for (let j = 0, d = 0; j < b.length; j++) {
    depth[j] = d;
    const c = b[j];
    if (c === '{' || c === '(' || c === '[') d++;
    else if (c === '}' || c === ')' || c === ']') d--;
  }
  const re = new RegExp('(^|[^\\w$.])(const|let|var)\\s+' + escRe_(name) + '\\s*=', 'g');
  const hits = [];
  let m;
  while ((m = re.exec(b)) !== null) {
    const s = m.index + m[1].length;
    if (depth[s] === 0) hits.push({ start: s, eq: m.index + m[0].length });
  }
  if (!hits.length) throw new Error('sliceConst: no top-level declaration of ' + name);
  if (hits.length > 1) throw new Error('sliceConst: ' + name + ' is declared ' + hits.length + ' times at top level');
  const h = hits[0];
  let j = h.eq;
  while (j < b.length && /\s/.test(b[j])) j++;
  let end;
  if (b[j] === '{' || b[j] === '[') {
    end = matchClose_(b, j);
    if (end === -1) throw new Error('sliceConst: unbalanced initializer for ' + name);
  } else {
    end = j;
    let d = 0;
    while (end < b.length) {
      const c = b[end];
      if (c === '(' || c === '[' || c === '{') d++;
      else if (c === ')' || c === ']' || c === '}') d--;
      else if (c === ';' && d === 0) break;
      end++;
    }
  }
  let text = src.slice(h.start, end).replace(/\s+$/, '');
  if (!text.endsWith(';')) text += ';';
  return text;
}

module.exports = { blank, blankAny, slice, slices, sliceConst, hasFunction };
