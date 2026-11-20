'use strict';
// GATE: Today after a Manage page (app v0.35.2; found in the TEST store trial
// 2026-11-19: on a computer, a vendor added in Manage stayed off Today until a
// reload, because Today rendered its cached list). The app's own code
// (openManage_, afterManage_, loadToday), sliced from template/index.html and
// run with stubs. Checks:
//   - with no Manage visit, Today renders its cached list and fetches nothing
//     (the fast path stays);
//   - after a Manage page opens, the next Today load fetches the list again
//     instead of rendering the cache, and drops the vendors' cached items;
//   - only the next one: the load after that uses the cache again.
// Each has a planted-defect control.
//
// Run bare: node tests/manage_today.test.js. A passing run ends with "manage_today: ALL PASS".

const vm = require('vm');
const F = require('./fake_apps_script.js');
const { slices } = require('./slice_js.js');

const T = 'template/index.html';
const SRC = file => F.source(null, file);

function app(template) {
  const calls = { api: [], rendered: [], loading: 0 };
  const ctx = {
    console, calls,
    state: { cache: { dashboard: null, vendorItems: {} }, manageVisited: false, managePage: null,
             currentView: 'today', currentTab: 'today', lang: 'en' },
    direct: { token: 'tok' },
    localStorage: { setItem() {}, getItem() { return null; } },
    document: { querySelectorAll: () => [] },
    MANAGE_PAGES_: { items: 'items.html', overview: 'overview.html' },
    $: () => ({ getAttribute: () => null, setAttribute() {}, contentWindow: null }),
    editorAvailable_: () => true,
    leaveAppScreen_: async () => true,
    manageQuery_: () => '',
    stopCutoffTick_() {}, markManage_() {}, showView(v) { ctx.state.currentView = v; },
    renderToday(d) { calls.rendered.push(d); },
    renderLoading() { calls.loading++; },
    prefetchTodaysVendors_() {},
    dashboardCacheIsStale_: () => false,
    maybeBackgroundRefreshDashboard_() {},
    // The fetch never answers: the gate only needs to see that it was asked.
    api(fn) { calls.api.push(fn); return new Promise(() => {}); }
  };
  vm.createContext(ctx);
  vm.runInContext(slices(template, ['afterManage_', 'loadToday', 'openManage_']), ctx);
  return ctx;
}

// Never await loadToday itself: a fetch never answers, so a load that fetches
// would hang the gate (and Node would exit 0 with nothing printed). Start it,
// then let its first steps run.
async function load(a) { a.loadToday(); await new Promise(r => setImmediate(r)); }

async function problems(template) {
  const out = [];
  const fail = (k, m) => out.push('[' + k + '] ' + m);
  const OLD = { date: '2026-11-19', vendors: [] };

  // No Manage visit: the cache is used, nothing fetched.
  let a = app(template);
  a.state.cache.dashboard = OLD;
  a.state.cache.vendorItems = { 'Test Vendor': { items: [] } };
  await load(a);
  if (a.calls.api.length || a.calls.rendered[0] !== OLD) fail('cache', 'Today without a Manage visit fetched ' + JSON.stringify(a.calls.api));
  if (!a.state.cache.vendorItems['Test Vendor']) fail('cache', 'the vendors\' items were dropped without a Manage visit');

  // A Manage page, then Today: fetched again, items dropped.
  a = app(template);
  a.state.cache.dashboard = OLD;
  a.state.cache.vendorItems = { 'Test Vendor': { items: [] } };
  await a.openManage_('items');
  a.state.currentView = 'today';
  await load(a);
  if (a.calls.api.indexOf('getDashboard') < 0) fail('after', 'Today after Manage did not fetch the list (rendered the cache)');
  if (a.calls.rendered.indexOf(OLD) >= 0) fail('after', 'Today after Manage rendered the old list');
  if (a.state.cache.vendorItems['Test Vendor']) fail('items', 'the vendors\' cached items survived a Manage visit');

  // Only once: the next load uses the cache again.
  a.calls.api.length = 0;
  a.state.cache.dashboard = OLD;
  await load(a);
  if (a.calls.api.length) fail('once', 'the Today load after that fetched again: ' + JSON.stringify(a.calls.api));
  return out;
}

const CONTROLS = [
  { name: 'opening a Manage page leaves no mark', bites: 'after',
    find: '    state.manageVisited = true;\n', replace: '' },
  { name: 'Today ignores the mark', bites: 'after',
    find: 'if (!preloaded && state.cache.dashboard && !afterManage) {', replace: 'if (!preloaded && state.cache.dashboard) {' },
  { name: 'the vendors\' items kept', bites: 'items',
    find: '    state.cache.vendorItems = {};\n    return true;', replace: '    return true;' },
  { name: 'the mark never cleared', bites: 'once',
    find: '    if (!state.manageVisited) return false;\n    state.manageVisited = false;\n', replace: '    if (!state.manageVisited) return false;\n' }
];

(async function main() {
  let failed = 0;
  const tpl = SRC(T).replace(/\r\n/g, '\n');
  const res = await problems(tpl);
  if (res.length) { failed++; console.log('FAIL  ' + res.join('\n      ')); }
  else console.log('PASS  Today uses its cache until a Manage page opens; the next load fetches the list and drops the vendors\' items, once');
  for (const c of CONTROLS) {
    let r;
    try { r = await problems(F.plant(tpl, c.find, c.replace)); }
    catch (e) { failed++; console.log(`FAIL  control "${c.name}" crashed instead of biting: ${e.message}`); continue; }
    if (r.some(p => p.indexOf('[' + c.bites + ']') === 0)) console.log(`PASS  control "${c.name}" bites ("${c.bites}")`);
    else { failed++; console.log(`FAIL  control "${c.name}" did NOT bite "${c.bites}" (${JSON.stringify(r).slice(0, 200)})`); }
  }
  console.log(failed ? 'manage_today: ' + failed + ' FAILED' : 'manage_today: ALL PASS');
  process.exit(failed ? 1 : 0);
})();
