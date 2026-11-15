// HQ → Stores (schema v26, Sheet retirement step 4; docs/MOG_SheetRetirement_Spec.md
// R5, R6). Approved mockup: the "HQ Stores mockup" canvas
// (https://claude.ai/artifact/665XFnU7VfRaKXntyXLtxu), with Sebastian's two
// changes of 2026-11-15: one manager PIN for every store, set only here; and
// the New store form takes the picked concept's colours and logo.
//
//   Stores     every store: items, recap recipients, where its PIN was set,
//              who closes its nights; Change PIN per store; the one manager
//              PIN for every store at once
//   New store  one form, one save (mog_hq_stores 'create'): the store is made
//              in Supabase with phones, Manage and the nightly close on,
//              today's cycle and no items; then Claude puts it on the web
//              (stores.json, build.py)
//
// The rules live in the SQL (mog.store_create, mog.store_set_pin,
// mog.manager_pin_set); the page only suggests a web address and a store
// code, shows the name the store will get, and checks the two PIN boxes
// agree. index.html hands create() the helpers it shares, as ltos.js gets them.
(function (root) {
  'use strict';

  // Each concept's colours on the form: line (borders), solid (filled, with
  // ink on it, 4.5:1 or better) and tint (light grounds). The brand kit's.
  const BRAND = {
    'roll-play': { line: '#2D8C6B', solid: '#1F6B51', ink: '#ffffff', tint: '#E4F7F0' },
    teasnyou:    { line: '#D1AA5D', solid: '#D1AA5D', ink: '#2D2F2D', tint: '#F8F1E5' },
    an:          { line: '#3C1124', solid: '#3C1124', ink: '#ffffff', tint: '#F7F2EB' },
    leid:        { line: '#B51579', solid: '#B51579', ink: '#ffffff', tint: '#E0F6F2' }
  };
  const LOGO = { 'roll-play': 'rp-mark.svg', teasnyou: 'tny-mark.svg', an: 'an-mark.svg', leid: 'leid-mark.svg' };
  const ORDER = ['roll-play', 'teasnyou', 'an', 'leid'];
  // The name each store's location starts with: mog.concept_name, word for
  // word (straight apostrophes, as the stores' rows have them).
  const NAMES = { 'roll-play': 'Roll Play', teasnyou: 'Teas\'n You', an: 'ĂN', leid: 'Lei\'d Poke' };
  const PREFIX = { 'roll-play': 'rp', teasnyou: 'tny', an: 'an', leid: 'leid' };
  // mog.store_create's reserved web addresses: folders the site has at its root.
  const RESERVED = ['hq', 'docs', 'icons', 'supabase', 'template', 'tests', 'scripts', 'brand', 'assets', 'editor', 'preview'];
  const TZ = [['America/New_York', 'Eastern (New York)'], ['America/Chicago', 'Central (Chicago)'], ['America/Denver', 'Mountain (Denver)'],
              ['America/Phoenix', 'Arizona (Phoenix)'], ['America/Los_Angeles', 'Pacific (Los Angeles)']];
  const LOCK = '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 13a2 2 0 0 1 2 -2h10a2 2 0 0 1 2 2v6a2 2 0 0 1 -2 2h-10a2 2 0 0 1 -2 -2v-6z"/><path d="M11 16a1 1 0 1 0 2 0a1 1 0 0 0 -2 0"/><path d="M8 11v-4a4 4 0 1 1 8 0v4"/></svg>';
  const OK = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#1a6b48" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12l5 5l10 -10"/></svg>';

  // ---- Pure helpers (the gate runs them as they are) ----
  const alnum = s => String(s == null ? '' : s).replace(/[^A-Za-z0-9]/g, '');
  const site = s => String(s == null ? '' : s).trim().replace(/\s+/g, ' ');
  // "Roll Play Ballston FOH", plus " (TEST)" for a test store: the name the
  // SQL gives it.
  function locationOf(f) {
    return [NAMES[f.concept] || '', site(f.site), f.side].filter(Boolean).join(' ') + (f.isTest ? ' (TEST)' : '');
  }
  // A web address to start from: the concept, the site, "f" for FOH; 20 at most.
  // Nothing until a site is typed.
  function suggestSlug(f) {
    const p = PREFIX[f.concept] || '', tail = f.side === 'FOH' ? 'f' : '', s = alnum(f.site).toLowerCase();
    return s ? p + s.slice(0, 20 - p.length - tail.length) + tail : '';
  }
  // A store code to start from: RP + the site's first three letters + B or F.
  function suggestAbbr(f) {
    const s = alnum(f.site).toUpperCase();
    return s ? ((PREFIX[f.concept] || '').toUpperCase() + s.slice(0, 3) + (f.side === 'FOH' ? 'F' : 'B')).slice(0, 10) : '';
  }
  // What the save sends (mog_hq_stores 'create').
  function createRow(f) {
    return { concept: f.concept, side: f.side, site: site(f.site), slug: String(f.slug || '').trim().toLowerCase(),
             abbr: String(f.abbr || '').trim().toUpperCase(), timeZone: f.timeZone, address: String(f.address || '').trim(),
             pin: String(f.pin || ''), gmEmail: String(f.gmEmail || '').trim(), isTest: !!f.isTest };
  }
  // What stops the Create button: an empty box, or the two PINs differing.
  function missing(f) {
    if (!BRAND[f.concept]) return 'Pick the concept.';
    if (site(f.site).length < 2) return 'Type the site.';
    if (!String(f.slug || '').trim()) return 'Type the web address.';
    if (!String(f.abbr || '').trim()) return 'Type the store code.';
    if (!/^[0-9]{4,8}$/.test(String(f.pin || ''))) return 'Type a store PIN of 4 to 8 digits.';
    if (f.pin !== f.pin2) return 'The two store PINs differ.';
    return '';
  }
  const blank = () => ({ concept: 'roll-play', side: 'BOH', site: '', slug: '', abbr: '', timeZone: 'America/New_York',
                         address: '', pin: '', pin2: '', gmEmail: '', isTest: false, slugTouched: false, abbrTouched: false });

  function create(hq) {
    const { $, esc } = hq;
    const K = { form: blank(), created: null, pinFor: null, mpOpen: false, busy: false, msg: {} };
    const data = () => hq.S.data;
    const ready = () => !!data() && Object.prototype.hasOwnProperty.call(data(), 'managerPin');
    const when = iso => { const d = new Date(iso); return isNaN(d) ? '' : d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }); };
    const items = st => (st.tables && Array.isArray(st.tables.items) ? st.tables.items.length : null);
    const status = (key, text, bad) => '<div class="status' + (bad ? ' bad' : '') + '" id="st-' + key + '-status" role="status">' + esc(text || '') + '</div>';
    const say = (key, text, bad) => { K.msg[key] = { text, bad }; const el = $('st-' + key + '-status'); if (el) { el.textContent = text; el.className = 'status' + (bad ? ' bad' : ''); } };
    const msgOf = key => K.msg[key] || { text: '', bad: false };

    // ---- The Stores page ----
    function pinTag(st) {
      if (st.pinSetAt) return '<span class="tag ok">Set here ' + esc(when(st.pinSetAt)) + (st.pinSetBy ? ' · ' + esc(st.pinSetBy) : '') + '</span>';
      return st.hasPin ? '<span class="tag">From its Sheet</span>' : '<span class="tag warn">None</span>';
    }
    function closeTag(st) {
      return st.closeDirect ? '<span class="tag ok">Supabase, 12:00 AM</span>' : '<span class="tag warn">' + (st.isTest ? 'Off' : 'Its Sheet, 3:30 AM') + '</span>';
    }
    function rowHtml(st) {
      const n = items(st);
      const made = st.createdBy ? ' · made in HQ ' + when(st.createdAt) + ' by ' + st.createdBy : '';
      return '<tr' + (K.pinFor === st.slug ? ' class="sel"' : '') + '>' +
        '<td><span class="n">' + esc(st.isTest ? hq.storeName(st) : hq.shortName(st)) + '</span>' +
        '<span class="s">' + esc((st.abbr ? st.abbr + ' · ' : '') + '/' + st.slug + '/' + made) + '</span></td>' +
        '<td class="num">' + (n == null ? '–' : n) + '</td><td class="num">' + (st.recipients == null ? '–' : st.recipients) + '</td>' +
        '<td>' + pinTag(st) + '</td><td>' + closeTag(st) + '</td>' +
        '<td style="text-align:right"><button type="button" class="btn small" data-st-pin="' + esc(st.slug) + '" aria-expanded="' +
        (K.pinFor === st.slug) + '">Change PIN</button></td></tr>';
    }
    function pinPanel(st) {
      const m = msgOf('pin');
      return '<div class="confirm" role="group" aria-labelledby="st-pin-h" style="margin-top:14px">' +
        '<div class="confirm-title" id="st-pin-h">Change the store PIN at ' + esc(hq.storeName(st)) + '</div>' +
        '<div class="grid2"><label class="field">New store PIN<input id="st-pin1" type="password" inputmode="numeric" maxlength="8" autocomplete="new-password"></label>' +
        '<label class="field">New store PIN again<input id="st-pin2" type="password" inputmode="numeric" maxlength="8" autocomplete="new-password"></label></div>' +
        '<p class="help" style="margin:0">The manager PIN isn\'t changed here: it\'s one code for every store, set on this page\'s Manager PIN card.</p>' +
        '<div class="warnbox">Saving signs out every phone and computer at this store. KMs sign in again with the new PIN.</div>' +
        status('pin', m.text, m.bad) +
        '<div class="actions" style="justify-content:flex-end"><button type="button" class="btn" data-st-pin-cancel="1">Cancel</button>' +
        '<button type="button" class="btn primary" data-st-pin-save="1"' + (K.busy ? ' disabled' : '') + '>Save PIN</button></div></div>';
    }
    function tableHtml(list) {
      return '<div class="scroll" style="margin-top:14px"><table><thead><tr><th>Store</th><th class="num">Items</th><th class="num">Recap to</th>' +
        '<th>Store PIN</th><th>Nightly close</th><th><span class="sr">Actions</span></th></tr></thead><tbody>' +
        list.map(rowHtml).join('') + '</tbody></table></div>' +
        (list.some(st => st.slug === K.pinFor) ? pinPanel(list.find(st => st.slug === K.pinFor)) : '');
    }
    function managerCard() {
      const mp = data().managerPin, real = data().stores.filter(st => !st.isTest).length, all = data().stores.length;
      const m = msgOf('mp');
      const tag = !mp ? '<span class="tag warn">Not one PIN yet: each Sheet set its own</span>'
        : mp.everyStore ? '<span class="tag ok">One PIN for all ' + all + ' stores · set ' + esc(when(mp.setAt)) + ' by ' + esc(mp.setBy) + '</span>'
        : '<span class="tag warn">Not at every store: set it again</span>';
      const form = !K.mpOpen ? '' :
        '<div class="confirm" role="group" aria-labelledby="st-mp-h" style="margin-top:16px;flex:1 1 100%">' +
        '<div class="confirm-title" id="st-mp-h">' + (mp ? 'Change' : 'Set') + ' the manager PIN for every store</div>' +
        '<div class="grid2"><label class="field">Manager PIN<input id="st-mp1" type="password" inputmode="numeric" maxlength="8" autocomplete="new-password"></label>' +
        '<label class="field">Manager PIN again<input id="st-mp2" type="password" inputmode="numeric" maxlength="8" autocomplete="new-password"></label></div>' +
        '<p class="help" style="margin:0">4 to 8 digits, different from every store\'s own PIN. All ' + all + ' stores (' + real + ' and the test ones) get it at once.</p>' +
        '<div class="warnbox">Saving signs out manager mode everywhere. Managers sign in again from the hub with the new PIN.</div>' +
        status('mp', m.text, m.bad) +
        '<div class="actions" style="justify-content:flex-end"><button type="button" class="btn" data-st-mp-cancel="1">Cancel</button>' +
        '<button type="button" class="btn primary" data-st-mp-save="1"' + (K.busy ? ' disabled' : '') + '>Save the manager PIN</button></div></div>';
      return '<section class="card" aria-labelledby="st-mph" style="display:flex;flex-wrap:wrap;align-items:center;gap:16px">' +
        '<span style="color:var(--ink)">' + LOCK + '</span>' +
        '<div style="flex:1 1 420px;min-width:0"><h2 id="st-mph">Manager PIN</h2>' +
        '<p class="help" style="margin-top:4px">One code for every store in every concept: the hub\'s manager mode. Set here only, for every store at once; a new store gets it automatically.</p></div>' +
        tag + (K.mpOpen ? '' : '<button type="button" class="btn primary" data-st-mp-open="1">' + (mp ? 'Change the manager PIN' : 'Set the manager PIN') + '</button>') +
        form + '</section>';
    }
    function createdCard() {
      const c = K.created;
      if (!c) return '';
      const li = t => '<li>' + OK + esc(t) + '</li>';
      return '<section class="card focus" aria-labelledby="st-cr-h">' +
        '<div class="okhead"><span class="okdot"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12l5 5l10 -10"/></svg></span>' +
        '<h2 id="st-cr-h">' + esc(c.location) + ' is created</h2>' +
        '<button type="button" class="linkbtn" data-st-created-close="1" style="margin-left:auto">Close</button></div>' +
        '<ul class="clist">' + li('Phones count in Supabase') + li('Manage on a computer') + li('Closes each night from 12:00 AM, its own time') +
        li('Today\'s cycle open: ' + c.dayOfWeek + ' ' + c.cycleDate.slice(5)) +
        li('Store PIN set' + (c.managerPin ? '; the manager PIN on it too' : '; no manager PIN until it\'s set on this page')) +
        li(c.recipients ? 'Recap to 1 person (the GM)' : 'No recap recipient yet: the store\'s Settings → Recipients') + '</ul>' +
        '<div class="next">' +
        '<div class="nrow"><b>1</b><span class="t"><b>Put it on the web.</b> Tell Claude <b>"Publish ' + esc(c.slug) + '"</b>. Its page goes up at /' + esc(c.slug) +
        '/ in about 2 minutes.' + (c.isTest ? ' A test store is not added to the hub.' : ' It shows on the hub with its concept\'s stores.') + '</span></div>' +
        '<div class="nrow"><b>2</b><span class="t"><b>Give it items.</b> From a library (Libraries → Set up stores from it), or sign in to the store on a computer and follow its Overview checklist.</span>' +
        '<button type="button" class="btn small" data-nav="libraries">Open Libraries</button></div></div></section>';
    }
    function renderStores() {
      const head = '<div class="page-head"><div><h1 id="st-h">Stores</h1>' +
        '<p>Every store, its PIN and its nightly close. A new store is made here, all in Supabase: no Sheet, no Apps Script.</p></div>' +
        (ready() ? '<div class="actions"><button type="button" class="btn primary big" data-nav="newstore">New store</button></div>' : '') + '</div>';
      if (!ready()) {
        $('v-stores').innerHTML = head + '<section class="card"><p class="help" style="margin:0">This page needs schema v26 in Supabase. Until it runs, a store\'s PIN is set in its Sheet.</p></section>';
        return;
      }
      const all = data().stores, real = all.filter(st => !st.isTest), tests = all.filter(st => st.isTest);
      const keys = ORDER.concat(Array.from(new Set(real.map(st => st.concept))).filter(k => ORDER.indexOf(k) < 0));
      const groups = keys.map(k => [k, real.filter(st => st.concept === k)]).filter(g => g[1].length);
      const stat = (k, v, m) => '<div class="stat"><div class="k">' + k + '</div><div class="v">' + v + '</div><div class="m">' + m + '</div></div>';
      $('v-stores').innerHTML = head +
        '<div class="stats">' +
        stat('STORES', real.length, tests.length ? 'and ' + hq.plural(tests.length, 'test store') : 'no test stores') +
        stat('NIGHTLY CLOSE', real.filter(st => st.closeDirect).length + ' of ' + real.length, 'by Supabase, from 12:00 AM') +
        stat('PINS SET HERE', real.filter(st => st.pinSetAt).length + ' of ' + real.length, 'the rest came from each Sheet') + '</div>' +
        (msgOf('list').text ? status('list', msgOf('list').text, msgOf('list').bad) : '') +
        createdCard() + managerCard() +
        groups.map(g => '<section class="card" aria-label="' + esc(hq.conceptName(g[0])) + '"><div class="card-head">' +
          '<div class="concept"><span class="mark">' + hq.markHtml(g[0]) + '</span><h2>' + esc(hq.conceptName(g[0])) + '</h2></div>' +
          '<span class="muted" style="font-size:13px">' + hq.plural(g[1].length, 'store') + '</span></div>' + tableHtml(g[1]) + '</section>').join('') +
        (tests.length ? '<section class="card" aria-label="Test stores"><div class="card-head"><h2>Test stores</h2>' +
          '<span class="muted" style="font-size:13px">Not on the hub. No one orders from them.</span></div>' + tableHtml(tests) +
          '<p class="help">Store PINs are never shown here, only set. Changing a store\'s PIN signs out every phone at that store.</p></section>' : '');
    }

    // ---- New store ----
    function brandOf() { return BRAND[K.form.concept] || BRAND['roll-play']; }
    function renderNew() {
      if (!ready()) { hq.go('stores'); return; }
      const f = K.form, b = brandOf();
      const top = 'border-top:4px solid ' + b.line;
      const step = n => '<span class="step" style="background:' + b.solid + ';color:' + b.ink + '">' + n + '</span>';
      const tz = TZ.some(t => t[0] === f.timeZone) ? TZ : TZ.concat([[f.timeZone, f.timeZone]]);
      const side = v => '<button type="button" data-st-side="' + v + '" aria-pressed="' + (f.side === v) + '"' +
        (f.side === v ? ' style="box-shadow:inset 0 -3px 0 ' + b.line + ',0 1px 2px rgba(0,0,0,0.12)"' : '') + '>' + v + '</button>';
      const m = msgOf('ns');
      $('v-newstore').innerHTML =
        '<nav class="crumb" aria-label="Breadcrumb"><button type="button" data-nav="stores">Stores</button> › New store</nav>' +
        '<div class="page-head"><div><h1 id="ns-h">New store</h1>' +
        '<p>One form, one save. The store is made in Supabase with phones, Manage and the nightly close on, today\'s cycle and no items yet. Then Claude puts it on the web.</p></div></div>' +
        '<section class="card" aria-labelledby="ns-0" style="' + top + '"><div class="step-title">' + step(1) + '<h2 id="ns-0">Which concept</h2></div>' +
        '<div class="ctiles" role="group" aria-label="Concept">' + ORDER.map(k => {
          const on = k === f.concept, kb = BRAND[k];
          return '<button type="button" class="ctile" data-st-concept="' + k + '" aria-pressed="' + on + '"' +
            (on ? ' style="border:3px solid ' + kb.line + ';background:' + kb.tint + ';padding:14px 10px;font-weight:700"' : '') + '>' +
            '<img src="' + LOGO[k] + '" alt=""><span>' + esc(hq.conceptName(k)) + '</span></button>';
        }).join('') + '</div></section>' +
        '<div class="band" style="background:' + b.tint + ';border:2px solid ' + b.line + '"><img src="' + LOGO[f.concept] + '" alt="' + esc(hq.conceptName(f.concept)) + '">' +
        '<div><div class="bt">New ' + esc(hq.conceptName(f.concept)) + ' store</div><div class="bs muted">Everything below is for ' + esc(hq.conceptName(f.concept)) +
        ': its colours on the order guide, its recap and its libraries.</div></div></div>' +
        '<section class="card" aria-labelledby="ns-1" style="' + top + '"><div class="step-title">' + step(2) + '<h2 id="ns-1">The store</h2></div>' +
        '<div class="grid2" style="margin-top:16px">' +
        '<div class="field"><span id="ns-side-l">Side</span><div class="seg" role="group" aria-labelledby="ns-side-l" style="align-self:flex-start">' + side('BOH') + side('FOH') + '</div></div>' +
        '<label class="field">Time zone<span class="select"><select id="ns-tz">' + tz.map(t => '<option value="' + esc(t[0]) + '"' + (t[0] === f.timeZone ? ' selected' : '') + '>' + esc(t[1]) + '</option>').join('') +
        '</select>' + hq.CHEV + '</span></label>' +
        '<label class="field">Site<input id="ns-site" data-ns="site" maxlength="40" placeholder="The place, like Ballston" value="' + esc(f.site) + '"></label>' +
        '<label class="field">Delivery address <span class="muted" style="font-weight:400">Optional. Goes on each vendor\'s Copy order for email.</span>' +
        '<input id="ns-address" data-ns="address" maxlength="200" placeholder="Street, city, state, ZIP" value="' + esc(f.address) + '"></label>' +
        '<label class="check wide"><input type="checkbox" id="ns-test"' + (f.isTest ? ' checked' : '') + '><span><b>Test store.</b> <span class="muted">Built but not on the hub; LTOs and libraries leave it out. Its name gets "(TEST)".</span></span></label>' +
        '</div><div class="namebox" style="background:' + b.tint + '"><span class="muted">Its name everywhere:</span><b id="ns-name">' + esc(locationOf(f)) + '</b>' +
        '<span class="tag warn" id="ns-testtag"' + (f.isTest ? '' : ' hidden') + '>Test store</span></div></section>' +
        '<section class="card" aria-labelledby="ns-2" style="' + top + '"><div class="step-title">' + step(3) + '<h2 id="ns-2">Its address and code</h2></div>' +
        '<div class="grid2" style="margin-top:16px">' +
        '<label class="field">Web address<input id="ns-slug" data-ns="slug" maxlength="20" autocomplete="off" spellcheck="false" value="' + esc(f.slug) + '">' +
        '<span class="help" style="margin:0">sebheh.github.io/mog-mobile/<b id="ns-slug-echo">' + esc(f.slug) + '</b>/ · Permanent once published: phones bookmark it. 2 to 20 lowercase letters or digits.</span></label>' +
        '<label class="field">Store code<input id="ns-abbr" data-ns="abbr" maxlength="10" autocomplete="off" spellcheck="false" value="' + esc(f.abbr) + '">' +
        '<span class="help" style="margin:0">Shown in HQ and in the recap. Filled in from the concept, site and side.</span></label></div></section>' +
        '<section class="card" aria-labelledby="ns-3" style="' + top + '"><div class="step-title">' + step(4) + '<h2 id="ns-3">Store PIN</h2></div>' +
        '<div class="grid2" style="margin-top:16px">' +
        '<label class="field">Store PIN<input id="ns-pin" data-ns="pin" type="password" inputmode="numeric" maxlength="8" autocomplete="new-password" value="' + esc(f.pin) + '">' +
        '<span class="help" style="margin:0">4 to 8 digits. KMs sign in with it on phones and computers.</span></label>' +
        '<label class="field">Store PIN again<input id="ns-pin2" data-ns="pin2" type="password" inputmode="numeric" maxlength="8" autocomplete="new-password" value="' + esc(f.pin2) + '"></label></div>' +
        '<div class="lockline">' + LOCK + '<span><b>Manager PIN:</b> ' + (data().managerPin
          ? 'the one manager PIN every store shares goes on this store too. It\'s changed only on the Stores page, for every store at once.'
          : 'none goes on this store yet: set the one manager PIN on the Stores page, and every store gets it.') + '</span></div></section>' +
        '<section class="card" aria-labelledby="ns-4" style="' + top + '"><div class="step-title">' + step(5) + '<h2 id="ns-4">Nightly recap</h2></div>' +
        '<div class="grid2" style="margin-top:16px"><label class="field">GM email <span class="muted" style="font-weight:400">Optional.</span>' +
        '<input id="ns-email" data-ns="gmEmail" type="email" maxlength="120" placeholder="name@hehfood.com" value="' + esc(f.gmEmail) + '">' +
        '<span class="help" style="margin:0">The first person on the recap after each night\'s close. More people: the store\'s Settings → Recipients.</span></label></div></section>' +
        '<div class="bar" style="border-top:3px solid ' + b.line + '"><div class="bar-in"><div><div class="bar-title" id="ns-bar-title">Create ' + esc(locationOf(f)) + '</div>' +
        '<div class="status' + (m.bad ? ' bad' : '') + '" id="st-ns-status" role="status">' + esc(m.text || missing(f) || 'All in one save, or nothing.') + '</div></div>' +
        '<div class="actions"><button type="button" class="btn" data-nav="stores">Cancel</button>' +
        '<button type="button" class="btn big" id="ns-create" data-st-create="1" style="background:' + b.solid + ';border-color:' + b.solid + ';color:' + b.ink + '"' +
        (missing(f) || K.busy ? ' disabled' : '') + '>Create store</button></div></div></div>';
    }
    // A keystroke updates only what depends on it, so the box keeps focus.
    function derived() {
      const f = K.form;
      if (!f.slugTouched) { f.slug = suggestSlug(f); const el = $('ns-slug'); if (el) el.value = f.slug; }
      if (!f.abbrTouched) { f.abbr = suggestAbbr(f); const el = $('ns-abbr'); if (el) el.value = f.abbr; }
      const set = (id, v) => { const el = $(id); if (el) el.textContent = v; };
      set('ns-name', locationOf(f)); set('ns-bar-title', 'Create ' + locationOf(f)); set('ns-slug-echo', String(f.slug || '').trim().toLowerCase());
      const tag = $('ns-testtag'); if (tag) tag.hidden = !f.isTest;
      K.msg.ns = null;
      const st = $('st-ns-status'); if (st) { st.textContent = missing(f) || 'All in one save, or nothing.'; st.className = 'status'; }
      const btn = $('ns-create'); if (btn) btn.disabled = !!missing(f) || K.busy;
    }

    // ---- Saves ----
    async function send(action, row, key) {
      K.busy = true;
      try {
        const r = await hq.rpc('mog_hq_stores', { p_token: hq.S.token, p_action: action, p_row: row });
        if (!r.ok && r.error === 'SESSION_EXPIRED') { hq.signedOut('Your sign-in ran out. Sign in again.'); return null; }
        if (!r.ok) { say(key, String(r.error || 'Not saved.').replace(/^REJECTED: /, '').replace(/^./, c => c.toUpperCase()) + '.', true); return null; }
        return r.data;
      } catch (err) { say(key, err.message, true); return null; }
      finally { K.busy = false; }
    }
    async function saveNew() {
      const f = K.form;
      if (missing(f) || K.busy) return;
      const btn = $('ns-create'); if (btn) btn.disabled = true;
      say('ns', 'Creating the store…', false);
      const d = await send('create', createRow(f), 'ns');
      if (!d) { derivedButton(); return; }
      K.created = d; K.form = blank(); K.msg = {}; K.pinFor = null;
      hq.S.view = 'stores';
      await hq.load();
      root.scrollTo && root.scrollTo(0, 0);
    }
    function derivedButton() { const btn = $('ns-create'); if (btn) btn.disabled = !!missing(K.form) || K.busy; }
    async function savePin() {
      const st = hq.storeBy(K.pinFor), a = ($('st-pin1') || {}).value || '', b = ($('st-pin2') || {}).value || '';
      if (!st || K.busy) return;
      if (!/^[0-9]{4,8}$/.test(a)) { say('pin', 'Type a store PIN of 4 to 8 digits.', true); return; }
      if (a !== b) { say('pin', 'The two PINs differ.', true); return; }
      say('pin', 'Saving…', false);
      const d = await send('pin', { slug: st.slug, pin: a }, 'pin');
      if (!d) return;
      K.pinFor = null; K.msg = { list: { text: 'New PIN saved at ' + hq.storeName(st) + '. ' + hq.plural(d.signedOut, 'sign-in') + ' ended there.', bad: false } };
      await hq.load();
    }
    async function saveManager() {
      const a = ($('st-mp1') || {}).value || '', b = ($('st-mp2') || {}).value || '';
      if (K.busy) return;
      if (!/^[0-9]{4,8}$/.test(a)) { say('mp', 'Type a manager PIN of 4 to 8 digits.', true); return; }
      if (a !== b) { say('mp', 'The two PINs differ.', true); return; }
      say('mp', 'Saving at every store…', false);
      const d = await send('managerPin', { pin: a }, 'mp');
      if (!d) return;
      K.mpOpen = false; K.msg = { list: { text: 'Manager PIN saved at all ' + d.stores + ' stores. ' + hq.plural(d.signedOut, 'manager-mode sign-in') + ' ended.', bad: false } };
      await hq.load();
    }

    // ---- Events (index.html passes each one here first) ----
    function click(t) {
      if (t.hasAttribute('data-st-concept')) { K.form.concept = t.getAttribute('data-st-concept'); derivedSilent(); renderNew(); return true; }
      if (t.hasAttribute('data-st-side')) { K.form.side = t.getAttribute('data-st-side'); derivedSilent(); renderNew(); return true; }
      if (t.hasAttribute('data-st-create')) { saveNew(); return true; }
      if (t.hasAttribute('data-st-pin')) { const s = t.getAttribute('data-st-pin'); K.pinFor = K.pinFor === s ? null : s; K.msg.pin = null; K.mpOpen = false; renderStores(); const el = $('st-pin1'); if (el && el.focus) el.focus(); return true; }
      if (t.hasAttribute('data-st-pin-cancel')) { K.pinFor = null; renderStores(); return true; }
      if (t.hasAttribute('data-st-pin-save')) { savePin(); return true; }
      if (t.hasAttribute('data-st-mp-open')) { K.mpOpen = true; K.pinFor = null; K.msg.mp = null; renderStores(); const el = $('st-mp1'); if (el && el.focus) el.focus(); return true; }
      if (t.hasAttribute('data-st-mp-cancel')) { K.mpOpen = false; renderStores(); return true; }
      if (t.hasAttribute('data-st-mp-save')) { saveManager(); return true; }
      if (t.hasAttribute('data-st-created-close')) { K.created = null; renderStores(); return true; }
      return false;
    }
    // A new concept or side moves the suggestions, as typing does.
    function derivedSilent() {
      const f = K.form;
      if (!f.slugTouched) f.slug = suggestSlug(f);
      if (!f.abbrTouched) f.abbr = suggestAbbr(f);
      K.msg.ns = null;
    }
    function input(t) {
      const k = t.getAttribute('data-ns');
      if (!k) return false;
      K.form[k] = t.value;
      if (k === 'slug') K.form.slugTouched = t.value.trim() !== '';
      if (k === 'abbr') K.form.abbrTouched = t.value.trim() !== '';
      derived();
      return true;
    }
    function change(t) {
      if (t.id === 'ns-tz') { K.form.timeZone = t.value; return true; }
      if (t.id === 'ns-test') { K.form.isTest = !!t.checked; derived(); return true; }
      return false;
    }
    function render(view) {
      if (view === 'stores') renderStores();
      if (view === 'newstore') renderNew();
    }
    return { views: ['stores', 'newstore'], render, click, input, change, K };
  }

  root.HQStores = { create, locationOf, suggestSlug, suggestAbbr, createRow, missing, blank, NAMES, RESERVED, BRAND, ORDER };
})(typeof window !== 'undefined' ? window : globalThis);
