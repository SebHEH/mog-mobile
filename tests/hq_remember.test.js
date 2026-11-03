'use strict';
// GATE: HQ remembers a device (template/hq/index.html readKept, keep,
// keepToken, keepRoles, remember, signedIn, resume, signOut; schema v18,
// 2026-11-03): the page's real code against the fake Supabase
// (fake_supabase.js mirrors v18; the SQL is pinned in Postgres by
// supabase/tests/smoke_v18.sql), the browser's two storages as plain maps,
// closing the browser as a new sessionStorage. Checks:
//   - the box: on the sign-in form, unticked, and what the form passes
//   - unticked: kept for this browser only, nothing more asked of the
//     server (12 hours there); closing the browser asks to sign in again
//   - ticked: kept in localStorage, 30 days on the server; closing the
//     browser keeps it; each open starts the 30 days again, so a device
//     opened monthly is still signed in two months on, and one left 31 days
//     isn't
//   - sign out: both storages emptied, the sign-in ended on the server, the
//     next open asks to sign in
//   - a server without v18 (both calls answer 404): signing in and out still
//     work, the sign-in stays at 12 hours
//   - the fake: a warehouse-only person is remembered and still reads no
//     store; a sign-in that's over can't be brought back; a new invite ends
//     a remembered one
// Each has a planted-defect control.
//
// Run bare: node tests/hq_remember.test.js
// A passing run ends with "hq_remember: ALL PASS".

const vm = require('vm');
const F = require('./fake_apps_script.js');
const { slices } = require('./slice_js.js');
const { FakeSupabase } = require('./fake_supabase.js');

const PAGE = 'template/hq/index.html';
const DAY = 86400000;
const PASS = 'correct horse battery';
const FNS = ['readKept', 'keep', 'keepToken', 'keepRoles', 'remember', 'signedIn', 'resume', 'signOut'];

function storage() {
  const m = new Map();
  return { getItem: k => (m.has(k) ? m.get(k) : null), setItem: (k, v) => { m.set(k, String(v)); }, removeItem: k => { m.delete(k); }, keys: () => Array.from(m.keys()) };
}
const flush = () => new Promise(r => setImmediate(r));

// One open of the HQ page in a browser: its own S, the two storages given,
// load() as the page's first read (mog_hq_data, else the sign-in screen).
function open(html, sb, local, session, v17) {
  const ctx = { S: { token: null, roles: null, remember: false, data: null }, localStorage: local, sessionStorage: session,
                WH: null, screen: null, calls: [] };
  ctx.showSignin = msg => { ctx.screen = 'signin: ' + msg; };
  ctx.rpc = async (fn, params) => {
    ctx.calls.push(fn);
    if (v17 && (fn === 'mog_hq_remember' || fn === 'mog_hq_signout')) throw new Error('Supabase answered 404: no such function');
    return sb.handle(fn, params);
  };
  ctx.load = async () => {
    const r = sb.handle('mog_hq_data', { p_token: ctx.S.token });
    if (!r.ok) { ctx.keepToken(null); ctx.showSignin('Your sign-in ran out. Sign in again.'); return false; }
    ctx.screen = 'app: ' + r.data.name;
    return true;
  };
  vm.createContext(ctx);
  vm.runInContext(slices(html, FNS), ctx, { filename: PAGE });
  ctx.readKept();
  return ctx;
}

async function problems(html) {
  const out = [];
  const bad = (what, detail) => out.push(what + (detail ? ': ' + detail : ''));

  // ---- The form ----
  if (!/<input type="checkbox" id="si-remember">Remember this device for 30 days<\/label>/.test(html)) bad('the box is missing or ticked by default');
  if (html.indexOf("await signedIn(r.data, $('si-remember').checked);") < 0) bad('the form doesn\'t pass the box to signedIn');
  if (html.indexOf("$('signout').onclick = signOut;") < 0) bad('Sign out doesn\'t call signOut');
  if (!/\n\s*resume\(\);\r?\n\s*\}\)\(\);/.test(html)) bad('the page doesn\'t start with resume()');

  const sb = new FakeSupabase(Date.UTC(2026, 10, 3, 15));
  const code = sb.hqInvite('Sebastian', ['hq', 'warehouse']);
  if (!sb.handle('mog_hq_claim', { p_name: 'Sebastian', p_code: code, p_passphrase: PASS }).ok) return ['setup: claim failed'];
  const login = () => sb.handle('mog_hq_login', { p_name: 'Sebastian', p_passphrase: PASS }).data;
  const until = tok => { const s = sb.hqState().sessions.get(tok); return s ? s.expires - sb.nowMs : null; };
  const reads = tok => !!sb.handle('mog_hq_data', { p_token: tok }).ok;

  // ---- Unticked ----
  {
    const local = storage(), session = storage();
    const p = open(html, sb, local, session);
    const d = login();
    await p.signedIn(d, false);
    if (p.screen !== 'app: Sebastian') bad('unticked: not signed in', p.screen);
    if (session.getItem('mog_hq_token') !== d.token || local.keys().length) bad('unticked: not kept for this browser only', 'local ' + local.keys());
    if (p.calls.indexOf('mog_hq_remember') >= 0) bad('unticked: asked the server to remember');
    if (until(d.token) !== 12 * 3600000) bad('unticked: not 12 hours on the server', String(until(d.token)));
    const again = open(html, sb, local, storage());
    again.resume();
    if (again.S.token || again.screen !== 'signin: ') bad('unticked: closing the browser kept the sign-in', again.screen);
  }

  // ---- Ticked, opened monthly ----
  let kept;
  {
    const local = storage(), session = storage();
    const p = open(html, sb, local, session);
    const d = login();
    await p.signedIn(d, true);
    if (local.getItem('mog_hq_token') !== d.token || JSON.parse(local.getItem('mog_hq_roles') || 'null') + '' !== 'hq,warehouse' || session.keys().length)
      bad('ticked: not kept in localStorage', 'session ' + session.keys());
    if (until(d.token) !== 30 * DAY) bad('ticked: not 30 days on the server', String(until(d.token)));
    for (let month = 1; month <= 2; month++) {
      sb.nowMs += 29 * DAY;
      const q = open(html, sb, local, storage());
      q.resume();
      await flush();
      if (!q.S.remember || q.screen !== 'app: Sebastian') { bad('ticked: closing the browser lost it (month ' + month + ')', q.screen); break; }
      if (until(d.token) !== 30 * DAY) { bad('ticked: an open didn\'t start the 30 days again (month ' + month + ')', String(until(d.token) / DAY)); break; }
    }
    kept = { local, token: d.token };
  }
  {
    const local = storage();
    const p = open(html, sb, local, storage());
    const d = login();
    await p.signedIn(d, true);
    sb.nowMs += 31 * DAY;
    const q = open(html, sb, local, storage());
    q.resume();
    await flush();
    if (q.screen === 'app: Sebastian' || local.getItem('mog_hq_token')) bad('ticked: still signed in after 31 days unused', q.screen);
  }

  // ---- Sign out ----
  {
    const q = open(html, sb, kept.local, storage());
    q.signOut();
    await flush();
    if (q.S.token || q.S.remember || kept.local.keys().length) bad('sign out: the device still keeps it', kept.local.keys().join(','));
    if (q.screen !== 'signin: Signed out.') bad('sign out: no sign-in screen', q.screen);
    if (reads(kept.token) || until(kept.token) !== null) bad('sign out: the sign-in still works on the server');
    const r = open(html, sb, kept.local, storage());
    r.resume();
    if (r.screen !== 'signin: ') bad('sign out: the next open didn\'t ask to sign in', r.screen);
  }

  // ---- A server without v18 ----
  {
    const local = storage();
    const p = open(html, sb, local, storage(), true);
    const d = login();
    try { await p.signedIn(d, true); } catch (e) { bad('v17: signing in threw', e.message); }
    if (p.screen !== 'app: Sebastian' || local.getItem('mog_hq_token') !== d.token) bad('v17: not signed in', p.screen);
    if (until(d.token) !== 12 * 3600000) bad('v17: the sign-in isn\'t its 12 hours', String(until(d.token)));
    try { p.signOut(); await flush(); } catch (e) { bad('v17: sign out threw', e.message); }
    if (p.S.token || local.keys().length || p.screen !== 'signin: Signed out.') bad('v17: sign out left the device signed in');
  }

  // ---- The fake's rules (smoke_v18 holds the SQL to the same) ----
  {
    const w = sb.handle('mog_hq_claim', { p_name: 'Dan', p_code: sb.hqInvite('Dan', ['warehouse']), p_passphrase: PASS }).data;
    const r = sb.handle('mog_hq_remember', { p_token: w.token });
    if (!r.ok || until(w.token) !== 30 * DAY) bad('fake: a warehouse-only person isn\'t remembered', JSON.stringify(r));
    if (reads(w.token) || !sb.handle('mog_wh_data', { p_token: w.token }).ok) bad('fake: remembering changed what the warehouse role reads');
    sb.hqInvite('Dan');
    if (until(w.token) !== null || sb.handle('mog_hq_remember', { p_token: w.token }).ok) bad('fake: a new invite didn\'t end a remembered sign-in');
    const d = login();
    sb.nowMs += 13 * 3600000;
    if (sb.handle('mog_hq_remember', { p_token: d.token }).ok) bad('fake: a sign-in that was over came back');
    if (sb.handle('mog_hq_remember', { p_token: 'bogus' }).error !== 'SESSION_EXPIRED' || sb.handle('mog_hq_signout', { p_token: 'bogus' }).error !== 'SESSION_EXPIRED')
      bad('fake: a bad token wasn\'t refused');
  }
  return out;
}

(async () => {
  const html = F.source(null, PAGE);
  let failed = 0;
  const base = await problems(html);
  if (base.length) { failed++; console.log('FAIL  remember this device:\n      ' + base.join('\n      ')); }
  else console.log('PASS  remember this device: the box, unticked for this browser only, ticked for 30 days from each open, sign out ' +
                   'ending it on the server, a server without v18, the fake\'s rules');

  const CONTROLS = [
    { name: 'the box ticked by default',
      find: '<input type="checkbox" id="si-remember">', replace: '<input type="checkbox" id="si-remember" checked>' },
    { name: 'the form ignores the box',
      find: "await signedIn(r.data, $('si-remember').checked);", replace: 'await signedIn(r.data, true);' },
    { name: 'a remembered sign-in kept in sessionStorage',
      find: '        if (v != null) (S.remember ? localStorage : sessionStorage).setItem(key, v);',
      replace: '        if (v != null) sessionStorage.setItem(key, v);' },
    { name: 'an unticked sign-in kept in localStorage',
      find: '        if (v != null) (S.remember ? localStorage : sessionStorage).setItem(key, v);',
      replace: '        if (v != null) localStorage.setItem(key, v);' },
    { name: 'a new open reads only sessionStorage',
      find: "        S.remember = !!localStorage.getItem('mog_hq_token');", replace: '        S.remember = false;' },
    { name: 'signing in with the box never asks for 30 days',
      find: '      keepRoles(d.roles);\n      await remember();\n', replace: '      keepRoles(d.roles);\n' },
    { name: 'an open doesn\'t start the 30 days again',
      find: '      if (S.token) { remember(); load()', replace: '      if (S.token) { load()' },
    { name: 'sign out leaves the sign-in on the server',
      find: "      if (t) rpc('mog_hq_signout', { p_token: t }).catch(() => { /* a server without v18: it runs out by itself */ });\n",
      replace: '' },
    { name: 'sign out leaves localStorage',
      find: '        localStorage.removeItem(key); sessionStorage.removeItem(key);', replace: '        sessionStorage.removeItem(key);' },
    { name: 'a server without v18 breaks signing in',
      find: "      try { await rpc('mog_hq_remember', { p_token: S.token }); } catch (e) { /* the next open asks again */ }",
      replace: "      await rpc('mog_hq_remember', { p_token: S.token });" }
  ];
  for (const c of CONTROLS) {
    let res;
    try { res = await problems(F.plant(html, c.find, c.replace)); }
    catch (e) { failed++; console.log(`FAIL  control "${c.name}" crashed instead of biting: ${e.message}`); continue; }
    if (res.length) console.log(`PASS  control "${c.name}" bites (${res[0].slice(0, 120)})`);
    else { failed++; console.log(`FAIL  control "${c.name}" did NOT bite`); }
  }

  console.log(failed ? `hq_remember: ${failed} FAILED` : 'hq_remember: ALL PASS');
  process.exit(failed ? 1 : 0);
})();
