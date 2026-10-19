'use strict';
// The phone, for the gates: the real template code (api(), the save queue and
// the DIRECT CLIENT block) plus OrderMath.gs in its own context, talking to a
// fake Supabase and, for /exec, to an Apps Script side. The same harness
// tests/pwa_direct.test.js builds inline.

const vm = require('vm');
const { slices } = require('./slice_js.js');

const SB_URL = 'https://fake.supabase.co';
const EXEC_URL = 'https://script.google.com/macros/s/FAKE/exec';
const PRELUDE = [
  'var API_TIMEOUT_MS = 30000; var offlineState = false; var drainPromise_ = null;',
  "var OFFLINE_SLOTS = { QUEUE: 'save_queue' }; function nsKey_(s) { return 'mog_t_' + s; }",
  'function setOffline_() { offlineState = true; } function setOnline_() { offlineState = false; }',
  'function refreshBanner_() {} function showToast() {} function t(k) { return k; } function setDashboardFetchedAt_() {}'
].join('\n');
const PHONE_FNS = ['api', 'apiOnce_', 'isNetworkError_', 'readSaveQueue_', 'writeSaveQueue_', 'enqueueSave_',
  'drainSaveQueue_', 'drainSaveQueueRun_'];

function phoneScript(srcOf) {
  const html = srcOf('template/index.html');
  const a = html.indexOf('// >>> DIRECT CLIENT'), b = html.indexOf('// <<< DIRECT CLIENT');
  if (a < 0 || b < a) throw new Error('DIRECT CLIENT markers missing from template/index.html');
  return new vm.Script(srcOf('apps-script/OrderMath.gs') + '\n' + PRELUDE + '\n' + html.slice(a, b) + '\n' +
                       slices(html, PHONE_FNS) + '\n', { filename: 'phone-under-test.js' });
}

// execPost(body) -> the /exec answer text. opts: { slug, pin, storage: Map }.
function makePhone(script, sb, execPost, opts) {
  const calls = { exec: [], sb: [] };
  const sbFetch = sb.fetchFn();
  const store = (opts && opts.storage) || new Map();
  const ctx = {
    console, AbortController, setTimeout, clearTimeout,
    window: { MOG_SUPABASE: { url: SB_URL, key: 'pub', slug: opts.slug } },
    state: { apiUrl: EXEC_URL, pin: opts.pin, cache: {} },
    localStorage: { getItem: k => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: k => store.delete(k) },
    fetch: (url, o) => {
      if (url.indexOf(SB_URL) === 0) { calls.sb.push(url.split('/rpc/')[1]); return sbFetch(url, o); }
      calls.exec.push(JSON.parse(o.body).action);
      const out = execPost(o.body);
      return Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve(out) });
    }
  };
  vm.createContext(ctx);
  script.runInContext(ctx);
  return {
    ctx, calls, store,
    run: code => vm.runInContext(code, ctx),
    answer: async (action, payload) => {
      try { return { ok: true, data: await vm.runInContext('api', ctx)(action, payload) }; }
      catch (e) { return { ok: false, error: e.message }; }
    }
  };
}

module.exports = { phoneScript, makePhone, SB_URL };
