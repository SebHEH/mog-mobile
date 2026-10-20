'use strict';
// The narrowest fake of the Apps Script surface MOG's readers touch, so the
// REAL .gs functions can run under Node. Sheets are plain grids; getRange
// honours the exact window asked for and counts every call and cell read.
//
// Code is loaded one function at a time (slice_js.js), never a whole .gs file:
// a whole file would also load every helper it declares, and those would
// silently replace the fakes below. See appsscript-refactor-equivalence 1b.

const vm = require('vm');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { slices, sliceConst } = require('./slice_js.js');

const REPO = path.resolve(__dirname, '..');

// A date in fixture data. It stays a marker until a sheet is read, and is then
// built with the READING context's own Date: each vm context has its own Date,
// and the .gs code tests `instanceof Date`.
function D(ms) { return { __date: ms }; }

function colNum(letters) {
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n;
}

function isEmpty(v) { return v === '' || v === null || v === undefined; }

class FakeRange {
  constructor(sheet, row, col, numRows, numCols) {
    if (!(row >= 1 && col >= 1 && numRows >= 1 && numCols >= 1)) {
      throw new Error('fake getRange: bad window ' + [row, col, numRows, numCols].join(','));
    }
    Object.assign(this, { sheet, row, col, numRows, numCols });
  }
  getValues() {
    if (this.sheet.onRead) this.sheet.onRead();   // a live formula (e.g. a vendor tab's spill)
    const book = this.sheet.book;
    book.reads.calls++;
    book.reads.cells += this.numRows * this.numCols;
    const out = [];
    for (let r = 0; r < this.numRows; r++) {
      const src = this.sheet.rows[this.row - 1 + r] || [];
      const line = [];
      for (let c = 0; c < this.numCols; c++) {
        const v = src[this.col - 1 + c];
        if (isEmpty(v)) line.push('');
        else if (v && typeof v === 'object' && '__date' in v) line.push(new book.CtxDate(v.__date));
        else line.push(v);
      }
      out.push(line);
    }
    return out;
  }
  getValue() { return this.getValues()[0][0]; }
  setValues(vals) {
    if (!Array.isArray(vals) || vals.length !== this.numRows || vals.some(r => !Array.isArray(r) || r.length !== this.numCols)) {
      throw new Error('fake setValues: data is ' + (vals && vals.length) + ' rows, range is ' + this.numRows + 'x' + this.numCols);
    }
    const rows = this.sheet.rows;
    for (let r = 0; r < this.numRows; r++) {
      while (rows.length < this.row + r) rows.push([]);
      const line = rows[this.row - 1 + r] || (rows[this.row - 1 + r] = []);
      for (let c = 0; c < this.numCols; c++) line[this.col - 1 + c] = vals[r][c];
    }
    this.sheet.book.writes.push({ sheet: this.sheet.name, row: this.row, col: this.col, numRows: this.numRows, numCols: this.numCols });
    return this;
  }
  setValue(v) { return this.setValues([[v]]); }
  clearContent() {
    return this.setValues(Array.from({ length: this.numRows }, () => Array(this.numCols).fill('')));
  }
  // Range.deleteCells(ROWS): these cells go, and only THESE columns shift up.
  deleteCells(dim) {
    if (dim !== 'ROWS') throw new Error('fake deleteCells: only ROWS is supported');
    const rows = this.sheet.rows;
    const last = rows.length;
    for (let c = this.col - 1; c < this.col - 1 + this.numCols; c++) {
      for (let r = this.row - 1; r < last; r++) {
        const from = rows[r + this.numRows];
        const line = rows[r] || (rows[r] = []);
        line[c] = from ? from[c] : '';
      }
    }
    this.sheet.book.writes.push({ sheet: this.sheet.name, deleteCells: [this.row, this.col, this.numRows, this.numCols] });
  }
  getDisplayValue() { const v = this.getValue(); return v === null || v === undefined ? '' : String(v); }
  clearDataValidations() { return this; }
  setNumberFormat() { return this; }
  setDataValidation() { return this; }
  getLastRow() { return this.row + this.numRows - 1; }   // the range's own end row, as Range.getLastRow is
  isPartOfMerge() { return false; }                       // merges, protections: layout only, never data
  breakApart() { return this; }
  merge() { return this; }
}

class FakeSheet {
  constructor(book, name, rows) { Object.assign(this, { book, name, rows }); }
  getName() { return this.name; }
  getLastRow() {
    if (this.onRead) this.onRead();   // a spill is already current when the size is asked for
    for (let r = this.rows.length - 1; r >= 0; r--) {
      if ((this.rows[r] || []).some(v => !isEmpty(v))) return r + 1;
    }
    return 0;
  }
  // Sheet.getMaxRows: the grid's height (here: the rows held, or the last one used).
  getMaxRows() { return Math.max(this.rows.length, 1); }
  deleteRows(start, n) {
    this.rows.splice(start - 1, n);
    this.book.writes.push({ sheet: this.name, deleteRows: start, count: n });
  }
  deleteRow(r) { this.deleteRows(r, 1); }
  // Sheet.insertRowAfter: an empty row below r; the rows under it move down.
  insertRowAfter(r) {
    while (this.rows.length < r) this.rows.push([]);
    this.rows.splice(r, 0, []);
    this.book.writes.push({ sheet: this.name, insertRowAfter: r });
  }
  insertRowsAfter(r, n) {
    while (this.rows.length < r) this.rows.push([]);
    this.rows.splice(r, 0, ...Array.from({ length: n }, () => []));
    this.book.writes.push({ sheet: this.name, insertRowAfter: r, count: n });
  }
  getRange(a, b, c, d) {
    if (typeof a === 'string') {
      let m = /^([A-Z]+)(\d+)$/.exec(a);
      if (m) return new FakeRange(this, Number(m[2]), colNum(m[1]), 1, 1);
      m = /^([A-Z]+)(\d+):([A-Z]+)(\d+)$/.exec(a);
      if (m) return new FakeRange(this, Number(m[2]), colNum(m[1]), Number(m[4]) - Number(m[2]) + 1, colNum(m[3]) - colNum(m[1]) + 1);
      m = /^([A-Z]+):([A-Z]+)$/.exec(a);   // whole columns: down to the grid's end, as a sheet's max rows
      if (m) return new FakeRange(this, 1, colNum(m[1]), Math.max(this.rows.length, 1), colNum(m[2]) - colNum(m[1]) + 1);
      throw new Error('fake getRange: unsupported A1 ' + a);
    }
    return new FakeRange(this, a, b, c === undefined ? 1 : c, d === undefined ? 1 : d);
  }
  // A tab copy (Vendors.gs commitAddVendor_ clones VENDOR_TEMPLATE). Visibility
  // and protections are layout, never data, so they're accepted and forgotten.
  copyTo() {
    let name = 'Copy of ' + this.name;
    while (this.book.sheets.has(name)) name += ' 1';
    const copy = new FakeSheet(this.book, name, this.rows.map(r => (Array.isArray(r) ? r.slice() : r)));
    this.book.sheets.set(name, copy);
    return copy;
  }
  setName(name) {
    this.book.sheets.delete(this.name);
    this.name = name;
    this.book.sheets.set(name, this);
    return this;
  }
  showSheet() { return this; }
  hideSheet() { return this; }
  isSheetHidden() { return false; }
  getProtections() { return []; }
  protect() {
    const p = { setDescription: () => p, setUnprotectedRanges: () => p, removeEditors: () => p, getEditors: () => [] };
    return p;
  }
}

// Freezes zero-arg `new Date()` and Date.now() inside a context; every
// argument form is forwarded untouched so an Invalid Date stays invalid.
//
// advancing: "now" moves forward 1 ms per call instead of standing still.
// Code that stamps Date.now() as a cache key (bumpServerMutationTs_) needs
// time to move, or every bump writes the same key and a stale cache entry
// keeps being served, which real Apps Script never does. 1 ms per call never
// changes the date.
function clockShim(fixMs, advancing) {
  const now = advancing ? '(__FIX+(__T++))' : '__FIX';
  return 'var __R=Date,__FIX=' + Number(fixMs) + ',__T=0;' +
    'function __D(){if(!(this instanceof __D))return new __R(' + now + ').toString();' +
    'return arguments.length?Reflect.construct(__R,arguments):new __R(' + now + ');}' +
    '__D.prototype=__R.prototype;__D.now=function(){return ' + now + ';};__D.UTC=__R.UTC;__D.parse=__R.parse;Date=__D;';
}

// Apps Script's Utilities.formatDate, for the patterns MOG uses. Fixture dates
// are UTC, so the time zone argument is ignored (both sides of every
// comparison run through this same formatter).
function formatDate(d, tz, pattern) {
  if (!d || typeof d.getUTCFullYear !== 'function') throw new Error('formatDate: not a Date');
  const p2 = n => String(n).padStart(2, '0');
  const parts = {
    yyyy: d.getUTCFullYear(), MM: p2(d.getUTCMonth() + 1), dd: p2(d.getUTCDate()),
    HH: p2(d.getUTCHours()), mm: p2(d.getUTCMinutes()), ss: p2(d.getUTCSeconds()),
    EEE: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][d.getUTCDay()]
  };
  return pattern.replace(/yyyy|MM|dd|HH|mm|ss|EEE/g, t => parts[t]);
}

// A fresh context over a store spec: { now, sheets: {name: rows}, scriptProps }.
// Each context gets its OWN copy of every grid, so writes in one never leak
// into another built from the same spec. `extra` adds or replaces globals
// (fake UrlFetchApp, ScriptApp, stubs).
function makeContext(spec, extra, opts) {
  const ctx = { console };
  vm.createContext(ctx);
  vm.runInContext(clockShim(spec.now, opts && opts.advancingClock), ctx);

  const reads = { calls: 0, cells: 0 };
  const book = { reads, writes: [], CtxDate: vm.runInContext('Date', ctx), sheets: new Map() };
  for (const name of Object.keys(spec.sheets)) {
    const copy = spec.sheets[name].map(r => (Array.isArray(r) ? r.slice() : r));
    book.sheets.set(name, new FakeSheet(book, name, copy));
  }
  book.addSheet = (name, rows) => book.sheets.set(name, new FakeSheet(book, name, rows));
  const ss = {
    getSheetByName: n => book.sheets.get(n) || null,
    getSpreadsheetTimeZone: () => 'America/New_York',
    getSheets: () => Array.from(book.sheets.values()),
    moveActiveSheet: () => {},   // tab order: layout only
    setActiveSheet: () => {}
  };

  const store = m => ({
    getProperty: k => (m.has(k) ? m.get(k) : null),
    getProperties: () => Object.fromEntries(m),
    setProperty: (k, v) => { m.set(k, String(v)); },
    deleteProperty: k => { m.delete(k); }
  });
  const scriptProps = new Map(Object.entries(spec.scriptProps || {}));
  const docProps = new Map();
  const cacheMap = new Map();
  const cache = {
    get: k => (cacheMap.has(k) ? cacheMap.get(k) : null),
    put: (k, v) => { cacheMap.set(k, v); },
    remove: k => { cacheMap.delete(k); }
  };

  Object.assign(ctx, {
    SpreadsheetApp: { getActiveSpreadsheet: () => ss, Dimension: { ROWS: 'ROWS', COLUMNS: 'COLUMNS' },
                      ProtectionType: { SHEET: 'SHEET', RANGE: 'RANGE' }, flush: () => {} },
    PropertiesService: { getScriptProperties: () => store(scriptProps), getDocumentProperties: () => store(docProps) },
    CacheService: { getDocumentCache: () => cache, getScriptCache: () => cache },
    Utilities: { formatDate },
    Logger: { log: () => {} }
  }, extra || {});
  return { ctx, book, scriptProps, docProps };
}

// Source text by revision (rev null = the working tree), read once per run.
const SRC_CACHE = new Map();
function source(rev, file) {
  const key = (rev || '(worktree)') + ':' + file;
  if (!SRC_CACHE.has(key)) {
    SRC_CACHE.set(key, rev
      ? execFileSync('git', ['show', rev + ':' + file], { cwd: REPO, encoding: 'utf8', maxBuffer: 64 << 20 })
      : fs.readFileSync(path.join(REPO, file), 'utf8'));
  }
  return SRC_CACHE.get(key);
}

// Compile once, run in many contexts. plan: [{ file, consts: [...], fns: [...] }];
// whole: files loaded entire (only pure files with nothing to stub). srcOf(file)
// supplies the text, so a control can plant a defect in a copy first.
function compile(srcOf, plan, whole) {
  let code = '';
  for (const p of plan) for (const c of (p.consts || [])) code += sliceConst(srcOf(p.file), c) + '\n';
  for (const p of plan) if (p.fns && p.fns.length) code += slices(srcOf(p.file), p.fns) + '\n';
  for (const f of (whole || [])) code += srcOf(f) + '\n';
  return new vm.Script(code, { filename: 'mog-under-test.js' });
}

// The readers every order-math path depends on, unchanged by the 2026-10-15
// extraction, sliced from whichever revision is under test.
const CORE_CONSTS = ['SHEET_MASTER', 'SHEET_SETUP', 'SHEET_ORDER_ENTRY', 'EMERGENCY_OVERRIDE_CELL', 'COL',
  'VENDOR_TABLE', 'VENDOR_LIST_COL', 'VENDOR_CUTOFF_COL', 'VENDOR_OVERRIDE_COL', 'VENDOR_TAB', 'PICKDB',
  'SHEET_ORDER_LOG', 'LOG_COL', 'DASH', 'ORDER_ENTRY_DATE_CELL', 'LAST_RESET_DATE_CELL', 'SERVER_MUT_TS_KEY',
  '_SHEET_CACHE_'];
const READERS_PLAN = [
  { file: 'apps-script/Core.gs', consts: CORE_CONSTS, fns: ['getSheet_', 'getActiveOrderDate_', 'getServerMutationTs_'] },
  { file: 'apps-script/PickPath.gs', fns: ['readPickDb_', 'getLastWrittenPickDbRow_'] },
  { file: 'apps-script/Vendors.gs', fns: ['getVendorList', 'getVendorList_compute_', 'normalizeVendorOrThrow_'] },
  { file: 'apps-script/History.gs', fns: ['readLogSlice_'] }
];
const API_FNS = ['api_getVendorItems_', 'api_getDashboard_compute_', 'readMasterItemMeta_', 'readVendorMultipliers_',
  'readEmergencyOverride_', 'readVendorOverrides_', 'readVendorCutoffs_', 'normalizeCutoffForApi_',
  'countBackupItemsByVendor_', 'countActiveItemsByVendor_', 'getTodaysLogByVendor_', 'generateReferenceFromDateStr_'];
const API_CONSTS = ['VENDOR_META', 'PROP_LOCATION', 'PROP_LOCATION_ABBR', 'PROP_CONCEPT'];

// The bulk-prefetch / recap shared read context, built inside a context.
const BUILD_CTX = new vm.Script('(function () { var setup = getSheet_(SHEET_SETUP); var a = getActiveOrderDate_(); return {' +
  ' pickDb: readPickDb_(setup), vendorMults: readVendorMultipliers_(setup), emergencyOverride: readEmergencyOverride_(),' +
  ' vendorOverrides: readVendorOverrides_(setup), dayOfWeek: a.dayOfWeek, masterMeta: readMasterItemMeta_(),' +
  ' cutoffs: readVendorCutoffs_(setup) }; })()');

// Deep comparison that works across vm contexts (prototypes differ there, so
// util.isDeepStrictEqual can't be used). NaN equals NaN; object key ORDER is
// part of the comparison. Returns '' when equal, else the first difference.
function deepDiff(a, b, p) {
  p = p || '';
  if (Object.is(a, b)) return '';
  const kind = v => (Array.isArray(v) ? 'array'
    : v === null ? 'null'
    : (v && typeof v === 'object' && Object.prototype.toString.call(v) === '[object Date]') ? 'date'
    : typeof v);
  const show = v => { let s; try { s = JSON.stringify(v); } catch (e) { s = String(v); } s = s === undefined ? String(v) : s; return s.length > 140 ? s.slice(0, 137) + '...' : s; };
  const ka = kind(a), kb = kind(b);
  if (ka !== kb) return (p || '(root)') + ': ' + show(a) + ' vs ' + show(b);
  if (ka === 'date') return a.getTime() === b.getTime() ? '' : p + ': ' + a + ' vs ' + b;
  if (ka === 'array') {
    if (a.length !== b.length) return p + '.length: ' + a.length + ' vs ' + b.length;
    for (let i = 0; i < a.length; i++) { const d = deepDiff(a[i], b[i], p + '[' + i + ']'); if (d) return d; }
    return '';
  }
  if (ka === 'object') {
    const ak = Object.keys(a), bk = Object.keys(b);
    if (ak.join('\u0000') !== bk.join('\u0000')) return (p || '(root)') + ' keys: [' + ak + '] vs [' + bk + ']';
    for (const k of ak) { const d = deepDiff(a[k], b[k], p + '.' + k); if (d) return d; }
    return '';
  }
  return (p || '(root)') + ': ' + show(a) + ' vs ' + show(b);
}

// Replace exactly one occurrence of `find` (a planted defect for a control).
// Refuses an anchor that is missing or not unique: either would make the
// plant a no-op or plant it twice, and the control would lie.
function plant(text, find, replace) {
  const first = text.indexOf(find);
  if (first < 0) throw new Error('plant: anchor not found: ' + find);
  if (text.indexOf(find, first + 1) >= 0) throw new Error('plant: anchor not unique: ' + find);
  return text.slice(0, first) + replace + text.slice(first + find.length);
}

module.exports = {
  REPO, D, makeContext, source, compile, deepDiff, plant, clockShim,
  READERS_PLAN, API_FNS, API_CONSTS, BUILD_CTX
};
