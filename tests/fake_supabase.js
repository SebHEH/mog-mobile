'use strict';
// An in-memory stand-in for the mog_sync_* functions in supabase/schema.sql +
// schema_v2.sql, behind a fake UrlFetchApp, so the Apps Script side of the
// sync can run under Node. It mirrors the SQL's RULES (sync-key check, the
// one-transaction cycle close, last-duplicate-wins upserts, what counts as an
// on-hand number); the SQL itself is proven by supabase/tests/smoke*.sql in
// Postgres. If a rule changes in the SQL, change it here in the same commit.

const F = require('./fake_apps_script.js');

const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const clone = v => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));

// mog.to_onhand: numbers pass, numeric strings parse, anything else is a cleared count.
function toOnHand(v) {
  if (typeof v === 'number') return v;
  if (typeof v === 'string' && /^-?([0-9]+(\.[0-9]*)?|\.[0-9]+)$/.test(v.trim())) return Number(v.trim());
  return null;
}

// schema_v4.sql's catalog tables: mog.replace_catalog_tables' input checks and
// the table rules (checks, primary keys, case-insensitive unique names,
// foreign keys). Throws the first broken rule; returns clean copies.
const HHMM = /^([01][0-9]|2[0-3]):[0-5][0-9]$/;
function checkCatalogTables(t) {
  const isArr = k => t && Array.isArray(t[k]);
  if (!t || typeof t !== 'object' || !isArr('vendors') || !isArr('areas') || !isArr('items') || !isArr('pickRows')) {
    throw new Error('tables must be an object with vendors, areas, items and pickRows arrays');
  }
  const name = (v, max, what) => {
    if (typeof v !== 'string' || v !== v.trim() || v === '' || v.length > max) throw new Error(what + ' name check: ' + JSON.stringify(v));
    return v;
  };
  const num = (v, what) => {
    if (v === null || v === undefined) return null;
    if (typeof v !== 'number' || !Number.isFinite(v)) throw new Error('invalid input syntax for type numeric: ' + what);
    return v;
  };
  const uniq = (rows, keyOf, what) => {
    const seen = new Set();
    for (const r of rows) { const k = keyOf(r); if (seen.has(k)) throw new Error('duplicate key value violates unique constraint ' + what); seen.add(k); }
  };
  const vendors = t.vendors.map(e => {
    const mults = e.mults === undefined ? [0, 0, 0, 0, 0, 0, 0] : e.mults;
    if (!Array.isArray(mults) || mults.length !== 7 || mults.some(m => num(m, 'mult') === null)) throw new Error('vendors_mults_check');
    const cutoff = (e.cutoff === undefined || e.cutoff === null || e.cutoff === '') ? null : e.cutoff;
    if (cutoff !== null && !HHMM.test(cutoff)) throw new Error('vendors_cutoff_check');
    return { name: name(e.name, 100, 'vendor'), mults: mults.slice(), cutoff };
  });
  uniq(vendors, v => v.name, 'vendors_pkey');
  uniq(vendors, v => v.name.toLowerCase(), 'vendors_name_ci');
  const areas = t.areas.map(e => {
    const ord = num(e.ord, 'ord');
    if (ord === null) throw new Error('null value in column "ord"');
    return { name: name(e.name, 100, 'area'), ord };
  });
  uniq(areas, a => a.name, 'areas_pkey');
  uniq(areas, a => a.name.toLowerCase(), 'areas_name_ci');
  const vendorNames = new Set(vendors.map(v => v.name));
  const areaNames = new Set(areas.map(a => a.name));
  const items = t.items.map((e, i) => {
    const primary = (e.primaryVendor === undefined || e.primaryVendor === null || e.primaryVendor === '') ? null : e.primaryVendor;
    if (primary !== null && !vendorNames.has(primary)) throw new Error('items primary_vendor foreign key: ' + primary);
    const nm = e.name == null ? '' : String(e.name);
    if (nm.length > 300) throw new Error('items_name_check');
    return { id: name(e.id, 100, 'item'), name: nm, primaryVendor: primary, pack: e.pack == null ? '' : String(e.pack),
             par: num(e.par, 'par'), active: e.active == null ? true : e.active === true,
             useMult: e.useMult == null ? true : e.useMult === true, notes: e.notes || '', sku: e.sku || '',
             category: e.category || '', eligible: (e.eligible || []).slice(), seq: e.seq == null ? i + 1 : e.seq };
  });
  uniq(items, it => it.id, 'items_pkey');
  const itemIds = new Set(items.map(it => it.id));
  const pickRows = t.pickRows.map((e, i) => {
    if (!vendorNames.has(e.vendor)) throw new Error('pick_rows vendor foreign key: ' + e.vendor);
    if (!itemIds.has(e.id)) throw new Error('pick_rows item foreign key: ' + e.id);
    const area = (e.area === undefined || e.area === null || e.area === '') ? null : e.area;
    if (area !== null && !areaNames.has(area)) throw new Error('pick_rows area foreign key: ' + area);
    return { vendor: e.vendor, id: e.id, area, shelfOrder: num(e.shelfOrder, 'shelf'), seq: e.seq == null ? i + 1 : e.seq };
  });
  uniq(pickRows, r => r.vendor + '\u0001' + r.id, 'pick_rows_pkey');
  return { vendors, areas, items, pickRows };
}

// mog.catalog_from_tables. vendorList uses localeCompare, which smoke_v4.sql
// pins the database's ICU sort against.
function catalogFromTables(s) {
  const t = s.tables, pr = s.profile;
  const days = DAYS;
  const itemById = new Map(t.items.map(it => [it.id, it]));
  const areaOrd = new Map(t.areas.map(a => [a.name, a.ord]));
  const obj = pairs => { const o = {}; for (const [k, v] of pairs) o[k] = v; return o; };
  const counts = rows => { const m = new Map(); for (const k of rows) m.set(k, (m.get(k) || 0) + 1); return obj(m); };
  return {
    schema: 1,
    timeZone: pr.timeZone || 'America/New_York',
    location: pr.location != null ? pr.location : 'Unknown',
    abbr: pr.abbr || '',
    concept: pr.concept || '',
    vendorList: t.vendors.map(v => v.name).sort((a, b) => a.localeCompare(b)),
    vendorMults: obj(t.vendors.map(v => [v.name, obj(days.map((d, i) => [d, v.mults[i]]))])),
    cutoffs: obj(t.vendors.map(v => [v.name, v.cutoff])),
    items: obj(t.items.map(it => [it.id, { useMult: it.useMult, par: it.par, name: it.name, pack: it.pack,
                                           primaryVendor: it.primaryVendor || '', active: it.active }])),
    pickRows: t.pickRows.slice()
      .sort((a, b) => (a.seq - b.seq) || (a.vendor < b.vendor ? -1 : a.vendor > b.vendor ? 1 : 0) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
      .map(r => [r.vendor, r.id, itemById.get(r.id).name, r.area || '', r.area ? areaOrd.get(r.area) : null, r.shelfOrder]),
    itemCounts: counts(t.items.filter(it => it.active && it.primaryVendor).map(it => it.primaryVendor)),
    backupCounts: counts(t.pickRows.filter(r => { const it = itemById.get(r.id); return it.active && it.primaryVendor !== r.vendor; })
      .map(r => r.vendor))
  };
}

class FakeSupabase {
  constructor(nowMs) {
    this.nowMs = nowMs;
    this.stores = new Map();
    this.calls = [];     // fn names, in order
    this.down = false;   // true: every request fails like a network error
    this.denyFetch = false;   // true: UrlFetchApp throws Apps Script's missing-permission error
    this.failFns = new Set(); // names of mog_* functions whose requests fail like a network error
    this.httpFor = {};        // fn -> HTTP status to answer instead (404 = a schema that isn't installed)
    this.tokenSeq = 0;
  }

  // UTC date of "now": the fixtures' dates are UTC and so is the fake formatDate.
  today() { return new Date(this.nowMs).toISOString().slice(0, 10); }

  provision(slug) {
    const key = (slug + 'k'.repeat(64)).slice(0, 64).replace(/[^0-9a-f]/g, 'a');
    this.stores.set(slug, { key, pins: {}, catalog: null, version: null, state: null, counts: new Map(), log: [],
                            phoneDirect: false, failCount: 0, lockedUntil: 0, sessions: new Map(),
                            editorDirect: false, profile: {}, tables: null });
    return key;
  }

  // The same handler behind the browser's fetch, for the phone's direct mode.
  // Resolves like fetch: { ok, status, text() }.
  fetchFn() {
    const self = this;
    return function (url, opts) {
      return new Promise((resolve, reject) => {
        if (self.down) { reject(new TypeError('Failed to fetch')); return; }
        const fn = url.split('/rest/v1/rpc/')[1];
        if (self.failFns.has(fn)) { reject(new TypeError('Failed to fetch')); return; }
        if (self.httpFor[fn]) { const t = '{"code":"PGRST202"}'; resolve({ ok: false, status: self.httpFor[fn], text: () => Promise.resolve(t) }); return; }
        const body = JSON.stringify(self.handle(fn, JSON.parse(opts.body)));
        resolve({ ok: true, status: 200, text: () => Promise.resolve(body) });
      });
    };
  }

  urlFetchApp() {
    const self = this;
    return {
      fetch(url, opts) {
        if (self.denyFetch) {
          throw new Error('You do not have permission to call UrlFetchApp.fetch. Required permissions: ' +
                          'https://www.googleapis.com/auth/script.external_request');
        }
        const fn = url.split('/rest/v1/rpc/')[1];
        if (self.down || self.failFns.has(fn)) throw new Error('Address unavailable: ' + url);
        if (self.httpFor[fn]) return { getResponseCode: () => self.httpFor[fn], getContentText: () => '{"code":"PGRST202"}' };
        const body = self.handle(fn, JSON.parse(opts.payload));
        const text = JSON.stringify(body);
        return { getResponseCode: () => 200, getContentText: () => text };
      }
    };
  }

  // Reads must not create a cycle's entry (Postgres reads don't insert).
  countsIn(s, cycle) { return s.counts.get(cycle) || new Map(); }

  countsFor(s, cycle) {
    if (!s.counts.has(cycle)) s.counts.set(cycle, new Map());
    return s.counts.get(cycle);
  }

  upsert(s, cycle, defaultVendor, rows) {
    const latest = new Map();
    for (const e of rows) {
      const vendor = String((defaultVendor != null ? defaultVendor : e.vendor) || '').trim();
      const id = String(e.id || '').trim();
      if (!vendor || !id || vendor.length > 100 || id.length > 100) continue;
      latest.set(vendor + '\u0001' + id, { vendor, id, onHand: toOnHand(e.onHand) });
    }
    const m = this.countsFor(s, cycle);
    for (const [k, v] of latest) m.set(k, v);
    return latest.size;
  }

  snapshot(slug, s, have, auth) {
    if (!s.catalog || !s.state) return { ok: false, error: 'STORE_NOT_SYNCED' };
    const st = s.state;
    const today = this.today();
    const counts = Array.from(this.countsIn(s, st.cycleDate).values())
      .sort((a, b) => (a.vendor + '\u0001' + a.id < b.vendor + '\u0001' + b.id ? -1 : 1))
      .map(c => ({ vendor: c.vendor, id: c.id, onHand: c.onHand }));
    return { ok: true, data: {
      slug, authType: auth || 'sync', isManagerMode: auth === 'master', catalogVersion: s.version,
      catalog: (have != null && have === s.version) ? null : clone(s.catalog),
      state: { cycleDate: st.cycleDate, dayOfWeek: st.dayOfWeek, today, isStale: st.cycleDate < today,
               emergencyOverride: st.emergencyOverride, vendorPicks: clone(st.vendorPicks),
               todaysLog: clone(st.todaysLog), updatedAt: 'fake' },
      counts, serverTime: 'fake' } };
  }

  handle(fn, p) {
    this.calls.push(fn);
    if (PHONE_FNS[fn]) return this.handlePhone(fn, p);
    const s = this.stores.get(p.p_slug);
    const ok = data => ({ ok: true, data });
    const err = error => ({ ok: false, error });
    if (!s || s.key !== p.p_key) return err('BAD_SYNC_KEY');

    switch (fn) {
      case 'mog_sync_get_cycle':
        if (!s.state) return err('STORE_NOT_SYNCED');
        return ok({ state: clone(s.state), counts: Array.from(this.countsIn(s, s.state.cycleDate).values()) });

      case 'mog_sync_get_snapshot':
        return this.snapshot(p.p_slug, s, p.p_have_version);

      case 'mog_sync_push_catalog':
        if (s.editorDirect) return err('EDITOR_DIRECT');
        if (p.p_version == null || !p.p_payload || typeof p.p_payload !== 'object') return err('version and an object payload are required');
        if (s.version != null && s.version > p.p_version) return ok({ applied: false, version: p.p_version });
        s.catalog = clone(p.p_payload);
        s.version = p.p_version;
        return ok({ applied: true, version: p.p_version });

      case 'mog_sync_set_pins': {
        const changed = s.pins.pin !== (p.p_pin || null) || s.pins.master !== (p.p_master_pin || null);
        s.pins = { pin: p.p_pin || null, master: p.p_master_pin || null };
        return ok({ changed });
      }

      case 'mog_sync_set_state':
        if (!p.p_cycle_date || DAYS.indexOf(p.p_day_of_week) < 0) return err('cycle date and a Mon..Sun day are required');
        s.state = { cycleDate: p.p_cycle_date, dayOfWeek: p.p_day_of_week, emergencyOverride: !!p.p_emergency_override,
                    vendorPicks: clone(p.p_vendor_picks || {}), todaysLog: clone(p.p_todays_log || []) };
        if (p.p_clear_cycle_counts) s.counts.delete(p.p_cycle_date);
        return ok({ cycleDate: p.p_cycle_date });

      case 'mog_sync_put_counts': {
        if (!Array.isArray(p.p_rows)) return err('a rows array is required');
        const cycle = p.p_cycle_date || (s.state && s.state.cycleDate);
        if (!cycle) return err('STORE_NOT_SYNCED');
        return ok({ saved: this.upsert(s, cycle, null, p.p_rows), cycleDate: cycle });
      }

      case 'mog_sync_close_cycle': {
        if (!p.p_closing || !p.p_new_cycle || p.p_new_cycle < p.p_closing || DAYS.indexOf(p.p_new_dow) < 0) {
          return err('a closing date, a new cycle date on or after it, and a Mon..Sun day are required');
        }
        if (!Array.isArray(p.p_rows)) return err('a rows array is required');
        if (!s.state) return err('STORE_NOT_SYNCED');
        if (s.state.cycleDate !== p.p_closing) return ok({ closed: false, reason: 'CYCLE_MOVED', cycleDate: s.state.cycleDate });
        s.log = s.log.filter(r => r.cycleDate !== p.p_closing);
        let seq = 0, n = 0;
        for (const e of p.p_rows) {
          seq++;
          const vendor = String(e.vendor || '').trim(), id = String(e.id || '').trim(), qty = toOnHand(e.qty);
          if (!vendor || !id || !(qty > 0)) continue;
          s.log.push({ cycleDate: p.p_closing, seq, vendor, id, name: e.name || '', pack: e.pack || '', area: e.area || '',
                       onHandPrev: toOnHand(e.onHandPrev), qty, loggedAt: p.p_logged_at });
          n++;
        }
        s.state = { cycleDate: p.p_new_cycle, dayOfWeek: p.p_new_dow, emergencyOverride: false,
                    vendorPicks: {}, todaysLog: clone(p.p_todays_log || []) };
        if (p.p_new_cycle === p.p_closing) s.counts.delete(p.p_new_cycle);
        return ok({ closed: true, logged: n, closedCycle: p.p_closing, cycleDate: p.p_new_cycle });
      }

      case 'mog_sync_get_log':
        return ok({ date: p.p_date, rows: s.log.filter(r => r.cycleDate === p.p_date).sort((a, b) => a.seq - b.seq)
          .map(r => ({ vendor: r.vendor, id: r.id, name: r.name, pack: r.pack, area: r.area,
                       onHandPrev: r.onHandPrev, qty: r.qty, loggedAt: r.loggedAt })) });

      case 'mog_sync_set_override': {
        if (!s.state) return err('STORE_NOT_SYNCED');
        const on = !!p.p_on;
        s.state.emergencyOverride = on;
        if (!on) s.state.vendorPicks = {};
        return this.snapshot(p.p_slug, s, p.p_have_version);
      }

      case 'mog_sync_set_phone_direct':
        s.phoneDirect = !!p.p_on;
        return ok({ phoneDirect: !!p.p_on });

      case 'mog_sync_seed_catalog': {
        if (s.editorDirect) return err('EDITOR_DIRECT');
        let next;
        try { next = checkCatalogTables(p.p_tables); } catch (e) { return err('SEED_REJECTED: ' + e.message); }
        const pr = (p.p_tables && p.p_tables.profile) || {};
        for (const k of ['timeZone', 'location', 'abbr', 'concept']) if (pr[k] != null) s.profile[k] = String(pr[k]);
        s.tables = next;
        const built = catalogFromTables(s);
        return ok({ seeded: { vendors: next.vendors.length, areas: next.areas.length, items: next.items.length,
                              pickRows: next.pickRows.length },
                    catalog: this.catalogDefect ? this.catalogDefect(built) : built });   // catalogDefect: a test's planted builder bug
      }

      case 'mog_sync_get_status':
        return ok({ phoneDirect: s.phoneDirect, editorDirect: s.editorDirect, hasCycle: !!s.state,
                    tablesSeeded: !!(s.tables && s.tables.vendors.length), catalogVersion: s.version,
                    catalogPushedAt: s.version == null ? null : 'fake', catalog: clone(s.catalog) });

      case 'mog_sync_set_vendor_pick': {
        const vendor = String(p.p_vendor || '').trim();
        if (!vendor || vendor.length > 100) return err('Vendor is required.');
        const m = p.p_mult;
        if (m == null || m < 0 || m > 7) return err('Invalid override multiplier (expected 0-7): ' + (m == null ? 'null' : m));
        if (!s.state) return err('STORE_NOT_SYNCED');
        if (m === 0) delete s.state.vendorPicks[vendor]; else s.state.vendorPicks[vendor] = m;
        return this.snapshot(p.p_slug, s, p.p_have_version);
      }
    }
    return err('fake: unknown function ' + fn);
  }

  // The five PWA functions (schema.sql + schema_v3.sql): a 12-hour session
  // token from the store or master PIN, the phone_direct switch checked before
  // anything else, and the same lockout as checkPin_.
  handlePhone(fn, p) {
    const ok = data => ({ ok: true, data });
    const err = error => ({ ok: false, error });
    if (fn === 'mog_login') {
      const slug = String(p.p_slug || '').trim().toLowerCase();
      const s = this.stores.get(slug);
      if (!s) return err('Unknown store');
      if (!s.phoneDirect) return err('USE_EXEC');
      if (s.lockedUntil) {
        if (s.lockedUntil > this.nowMs) return { ok: false, error: 'Too many attempts', lockout: true, retryAfterMs: s.lockedUntil - this.nowMs };
        s.failCount = 0; s.lockedUntil = 0;
      }
      const pin = String(p.p_pin == null ? '' : p.p_pin);
      const type = (s.pins.pin && pin === s.pins.pin) ? 'store' : (s.pins.master && pin === s.pins.master) ? 'master' : null;
      if (!type) {
        s.failCount++;
        if (s.failCount >= 5) { s.lockedUntil = this.nowMs + 300000; return { ok: false, error: 'Too many attempts', lockout: true, retryAfterMs: 300000 }; }
        return err('Invalid PIN');
      }
      s.failCount = 0;
      const snap = this.snapshot(slug, s, null, type);
      if (!snap.ok) return snap;
      const token = 'tok' + (++this.tokenSeq) + '-' + slug;
      s.sessions.set(token, { authType: type, expires: this.nowMs + 12 * 3600000 });
      return ok(Object.assign(snap.data, { token, expiresAt: 'fake' }));
    }
    let slug = null, sess = null;
    for (const [sl, st] of this.stores) {
      const x = st.sessions.get(p.p_token);
      if (x && x.expires > this.nowMs) { slug = sl; sess = x; break; }
    }
    if (!sess) return err('SESSION_EXPIRED');
    const s = this.stores.get(slug);
    if (!s.phoneDirect) return err('USE_EXEC');
    switch (fn) {
      case 'mog_snapshot':
        return this.snapshot(slug, s, p.p_have_version, sess.authType);
      case 'mog_save_counts': {
        const vendor = String(p.p_vendor || '').trim();
        if (!vendor || vendor.length > 100) return err('Vendor is required.');
        if (!p.p_cycle_date) return err('Cycle date is required.');
        if (!Array.isArray(p.p_items)) return err('items must be an array');
        if (p.p_items.length > 1000) return err('Too many items in one save');
        const n = this.upsert(s, p.p_cycle_date, vendor, p.p_items);
        const cycle = s.state && s.state.cycleDate;
        return ok({ saved: n, vendor, cycleDate: cycle, stale: cycle !== p.p_cycle_date });
      }
      case 'mog_set_override': {
        if (!s.state) return err('STORE_NOT_SYNCED');
        const on = !!p.p_on;
        s.state.emergencyOverride = on;
        if (!on) s.state.vendorPicks = {};
        return this.snapshot(slug, s, p.p_have_version, sess.authType);
      }
      case 'mog_set_vendor_pick': {
        const vendor = String(p.p_vendor || '').trim();
        if (!vendor || vendor.length > 100) return err('Vendor is required.');
        const m = p.p_mult;
        if (m == null || m < 0 || m > 7) return err('Invalid override multiplier (expected 0-7): ' + (m == null ? 'null' : m));
        if (!s.state) return err('STORE_NOT_SYNCED');
        if (m === 0) delete s.state.vendorPicks[vendor]; else s.state.vendorPicks[vendor] = m;
        return this.snapshot(slug, s, p.p_have_version, sess.authType);
      }
    }
    return err('fake: unknown function ' + fn);
  }
}

const PHONE_FNS = { mog_login: 1, mog_snapshot: 1, mog_save_counts: 1, mog_set_override: 1, mog_set_vendor_pick: 1 };

// A fake ScriptApp that records triggers. opts.auth is this person's grant of
// the external-request scope: 'granted' (default), 'required', or 'unavailable'
// (getAuthorizationInfo throws, as it might on an older runtime).
const FAKE_GRANT_URL = 'https://accounts.google.com/o/oauth2/auth?client_id=x&scope="s"<b>';
function fakeScriptApp(opts) {
  const triggers = [];
  const api = {
    triggers,
    auth: (opts && opts.auth) || 'granted',
    AuthMode: { FULL: 'FULL' },
    AuthorizationStatus: { REQUIRED: 'REQUIRED', NOT_REQUIRED: 'NOT_REQUIRED' },
    getAuthorizationInfo: () => {
      if (api.auth === 'unavailable') throw new Error('getAuthorizationInfo is not available');
      return { getAuthorizationStatus: () => (api.auth === 'required' ? 'REQUIRED' : 'NOT_REQUIRED'),
               getAuthorizationUrl: () => (api.auth === 'required' ? FAKE_GRANT_URL : null) };
    },
    requireScopes: () => {},
    getProjectTriggers: () => triggers.slice(),
    deleteTrigger: t => { const i = triggers.indexOf(t); if (i >= 0) triggers.splice(i, 1); },
    newTrigger: handler => {
      const spec = { handler };
      const b = {
        timeBased: () => b, after: ms => { spec.after = ms; return b; }, atHour: h => { spec.atHour = h; return b; },
        nearMinute: m => { spec.nearMinute = m; return b; }, everyDays: d => { spec.everyDays = d; return b; },
        forSpreadsheet: () => b, onOpen: () => b, onEdit: () => b,
        create: () => { const t = { getHandlerFunction: () => handler, spec }; triggers.push(t); return t; }
      };
      return b;
    },
    EventType: { ON_OPEN: 'ON_OPEN', ON_EDIT: 'ON_EDIT' }
  };
  return api;
}

// ContentService for doPost's jsonResponse_.
const fakeContentService = {
  MimeType: { JSON: 'JSON' },
  createTextOutput: text => ({ setMimeType() { return this; }, getContent: () => text })
};

// The step-4 code under test: the slices it needs from each .gs, plus
// OrderMath.gs, Sync.gs and DbApi.gs whole. srcOf(file) supplies the text, so a
// control can plant a defect in a copy first.
const STEP4_PLAN = [
  { file: 'apps-script/Core.gs',
    consts: F.READERS_PLAN[0].consts.concat(['EMERGENCY_OVERRIDE_LASTDATE_PROP', 'MOG_MUTATED_', 'MOG_SKIP_CATALOG_QUEUE_']),
    fns: F.READERS_PLAN[0].fns.concat(['getResetStaleness_', 'bumpServerMutationTs_', 'clearVendorOverrides_']) },
  F.READERS_PLAN[1], F.READERS_PLAN[2],
  { file: 'apps-script/History.gs', fns: ['readLogSlice_', 'makeLogDateFormatter_'] },
  { file: 'apps-script/MOGApi.gs',
    consts: F.API_CONSTS.concat(['PROP_PIN', 'PROP_MASTER_PIN', 'PROP_LAST_RECAP_SENT_DATE', 'PROP_PENDING_RECAP',
      'RECAP_SEND_DELAY_MS', 'PROP_PIN_FAIL_COUNT', 'PROP_PIN_LOCKOUT_UNTIL', 'PIN_MAX_ATTEMPTS', 'PIN_LOCKOUT_MS']),
    fns: F.API_FNS.concat(['readVendorTabRoster_', 'api_getVendorItemsBulk_', 'api_saveOnHand_', 'api_setEmergencyOverride_',
      'api_setVendorOverride_', 'api_getResetStatus_', 'api_getDashboard_', 'api_ping_', 'doPost', 'checkPin_',
      'constantTimeEq_', 'getPinLockoutState_', 'recordPinFailure_', 'recordPinSuccess_', 'jsonResponse_']) },
  { file: 'apps-script/Recap.gs', fns: ['buildRecapSections_', 'api_getRecapData_', 'scheduleRecapSend_', 'dropRecapTriggers_', 'buildRecapFromLog_'] },
  { file: 'apps-script/ResetLog.gs', fns: ['buildOrderCycleSnapshot_', 'ensureLogSheet_', 'deleteLogEntriesForDate_', 'getLogOrderDate_'] },
  { file: 'apps-script/Editor.gs', fns: ['webedit_call'] }
];
function compileStep4(srcOf) {
  return F.compile(srcOf || (f => F.source(null, f)), STEP4_PLAN,
    ['apps-script/OrderMath.gs', 'apps-script/Sync.gs', 'apps-script/DbApi.gs']);
}

module.exports = { FakeSupabase, fakeScriptApp, fakeContentService, toOnHand, compileStep4, FAKE_GRANT_URL,
  checkCatalogTables, catalogFromTables };
