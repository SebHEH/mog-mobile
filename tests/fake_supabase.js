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
                            editorDirect: false, profile: {}, tables: null,
                            presence: new Map(), people: new Map() });
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

  // by: who saved (mog_save_counts2); undefined keeps the stored one, as
  // mog.upsert_counts leaves counted_by alone.
  upsert(s, cycle, defaultVendor, rows, by) {
    const latest = new Map();
    for (const e of rows) {
      const vendor = String((defaultVendor != null ? defaultVendor : e.vendor) || '').trim();
      const id = String(e.id || '').trim();
      if (!vendor || !id || vendor.length > 100 || id.length > 100) continue;
      latest.set(vendor + '\u0001' + id, { vendor, id, onHand: toOnHand(e.onHand) });
    }
    const m = this.countsFor(s, cycle);
    for (const [k, v] of latest) {
      const prev = m.get(k);
      v.updatedAt = this.nowMs;
      v.countedBy = by !== undefined ? by : (prev ? prev.countedBy : null);
      m.set(k, v);
    }
    return latest.size;
  }

  // mog.touch_presence + mog.live_json (schema_v5.sql).
  touch(s, device, name, vendor) {
    if (!/^[A-Za-z0-9_-]{8,64}$/.test(String(device || ''))) return;
    const nm = String(name == null ? '' : name).trim().slice(0, 40) || null;
    const vd = String(vendor == null ? '' : vendor).trim().slice(0, 100) || null;
    s.presence.set(device, { name: nm, vendor: vd, seenAt: this.nowMs });
    if (nm) {
      const k = nm.toLowerCase();
      const had = s.people.get(k);
      s.people.set(k, { name: had ? had.name : nm, lastUsed: this.nowMs });
    }
  }
  live(s, device) {
    const presence = Array.from(s.presence.entries())
      .filter(([d, p]) => d !== (device || '') && p.seenAt > this.nowMs - 90000)
      .sort((a, b) => b[1].seenAt - a[1].seenAt)
      .map(([, p]) => ({ name: p.name, vendor: p.vendor, secondsAgo: Math.floor((this.nowMs - p.seenAt) / 1000) }));
    const lower = x => x.toLowerCase();
    const people = Array.from(s.people.values()).filter(p => p.lastUsed > this.nowMs - 30 * 86400000)
      .map(p => p.name).sort((a, b) => (lower(a) < lower(b) ? -1 : lower(a) > lower(b) ? 1 : 0));
    const latest = new Map();
    for (const c of this.countsIn(s, s.state ? s.state.cycleDate : null).values()) {
      if (c.countedBy == null) continue;
      const had = latest.get(c.vendor);
      if (!had || c.updatedAt > had.updatedAt) latest.set(c.vendor, c);
    }
    const activity = Array.from(latest.values()).sort((a, b) => (a.vendor < b.vendor ? -1 : 1))
      .map(c => ({ vendor: c.vendor, by: c.countedBy, secondsAgo: Math.floor((this.nowMs - c.updatedAt) / 1000) }));
    return { presence, people, activity };
  }

  snapshot(slug, s, have, auth) {
    if (!s.catalog || !s.state) return { ok: false, error: 'STORE_NOT_SYNCED' };
    const st = s.state;
    const today = this.today();
    const counts = Array.from(this.countsIn(s, st.cycleDate).values())
      .sort((a, b) => (a.vendor + '\u0001' + a.id < b.vendor + '\u0001' + b.id ? -1 : 1))
      .map(c => ({ vendor: c.vendor, id: c.id, onHand: c.onHand }));
    return { ok: true, data: {
      slug, authType: auth || 'sync', isManagerMode: auth === 'master', editorDirect: !!s.editorDirect,
      catalogVersion: s.version,
      catalog: (have != null && have === s.version) ? null : clone(s.catalog),
      state: { cycleDate: st.cycleDate, dayOfWeek: st.dayOfWeek, today, isStale: st.cycleDate < today,
               emergencyOverride: st.emergencyOverride, vendorPicks: clone(st.vendorPicks),
               todaysLog: clone(st.todaysLog), todayEdits: this.todayEdits(s, st.cycleDate), updatedAt: 'fake' },
      counts, serverTime: 'fake' } };
  }

  // mog.today_edits_json (schema_v7.sql): this cycle's active today pars
  // (the latest per item) and adds (in the order made).
  todayEdits(s, cycle) {
    const pars = {}, adds = [];
    for (const e of (s.quickEdits || [])) {
      if (e.cycle !== cycle || !e.active) continue;
      if (e.kind === 'par_today') pars[e.id] = e.parAfter;
      else adds.push([e.vendor, e.id]);
    }
    return { pars, adds };
  }

  handle(fn, p) {
    this.calls.push(fn);
    if (PHONE_FNS[fn]) return this.handlePhone(fn, p);
    if (EDITOR_FNS[fn]) return this.handleEditor(fn, p);
    const s = this.stores.get(p.p_slug);
    const ok = data => ({ ok: true, data });
    const err = error => ({ ok: false, error });
    if (!s || s.key !== p.p_key) return err('BAD_SYNC_KEY');

    switch (fn) {
      case 'mog_sync_get_cycle':
        if (!s.state) return err('STORE_NOT_SYNCED');
        return ok({ state: clone(s.state), counts: Array.from(this.countsIn(s, s.state.cycleDate).values())
          .map(c => ({ vendor: c.vendor, id: c.id, onHand: c.onHand })) });

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
      case 'mog_snapshot2': {
        const snap = this.snapshot(slug, s, p.p_have_version, sess.authType);
        if (!snap.ok) return snap;
        if (p.p_device != null) this.touch(s, p.p_device, p.p_name, p.p_vendor);
        return ok(Object.assign(snap.data, this.live(s, p.p_device)));
      }
      case 'mog_save_counts':
      case 'mog_save_counts2': {
        const vendor = String(p.p_vendor || '').trim();
        if (!vendor || vendor.length > 100) return err('Vendor is required.');
        if (!p.p_cycle_date) return err('Cycle date is required.');
        if (!Array.isArray(p.p_items)) return err('items must be an array');
        if (p.p_items.length > 1000) return err('Too many items in one save');
        const by = fn === 'mog_save_counts2' ? (String(p.p_by == null ? '' : p.p_by).trim().slice(0, 40) || null) : undefined;
        const n = this.upsert(s, p.p_cycle_date, vendor, p.p_items, by);
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
      // schema_v7.sql: "just today" edits, and "from now on" on a store whose
      // catalog Supabase owns.
      case 'mog_quick_edit': {
        if (!s.state || !s.catalog) return err('STORE_NOT_SYNCED');
        if (!p.p_cycle_date || p.p_cycle_date !== s.state.cycleDate) return err('STALE_CYCLE');
        const id = String(p.p_item_id || '').trim();
        const item = id && s.catalog.items ? s.catalog.items[id] : null;
        if (!item) return err('Unknown item');
        const qe = s.quickEdits = s.quickEdits || [];
        const cyc = s.state.cycleDate;
        const by = String(p.p_by == null ? '' : p.p_by).trim().slice(0, 40) || null;
        const takeBack = e => { e.active = false; if (e.review === 'open') e.review = 'reverted'; };
        const add = e => qe.push(Object.assign({ qid: (this.qeSeq = (this.qeSeq || 0) + 1), at: new Date(this.nowMs).toISOString(),
                                                cycle: cyc, by, active: true, review: 'open', parBefore: null, parAfter: null }, e));
        if (p.p_kind === 'par_today' || p.p_kind === 'par_today_clear') {
          if (p.p_kind === 'par_today' && (p.p_par == null || p.p_par < 0 || p.p_par > 100000)) return err('Par must be a number from 0 up.');
          qe.filter(e => e.cycle === cyc && e.kind === 'par_today' && e.id === id && e.active).forEach(takeBack);
          const normal = typeof item.par === 'number' ? item.par : null;
          if (p.p_kind === 'par_today' && p.p_par !== normal) {
            add({ kind: 'par_today', vendor: String(p.p_vendor || '').trim() || null, id, parBefore: normal, parAfter: p.p_par });
          }
        } else if (p.p_kind === 'add_today' || p.p_kind === 'add_today_remove') {
          const vendor = (s.catalog.vendorList || []).find(v => v === String(p.p_vendor || '').trim());
          if (!vendor) return err('Vendor is not listed');
          if (p.p_kind === 'add_today_remove') {
            qe.filter(e => e.cycle === cyc && e.kind === 'add_today' && e.vendor === vendor && e.id === id && e.active).forEach(takeBack);
          } else {
            if (item.active !== true) return err('That item is inactive.');
            const listed = (s.catalog.pickRows || []).some(r => String(r[0] == null ? '' : r[0]).toLowerCase() === vendor.toLowerCase() && String(r[1] || '').trim() === id) ||
              qe.some(e => e.cycle === cyc && e.kind === 'add_today' && e.vendor === vendor && e.id === id && e.active);
            if (listed) return err('Already on this list');
            add({ kind: 'add_today', vendor, id });
          }
        } else {
          return err('Unknown kind');
        }
        return this.snapshot(slug, s, p.p_have_version, sess.authType);
      }
      case 'mog_set_par': {
        if (!s.editorDirect) return err('EDITOR_NOT_DIRECT');
        if (p.p_par == null || p.p_par < 0 || p.p_par > 100000) return err('Par must be a number from 0 up.');
        const id = String(p.p_item_id || '').trim();
        const it = s.tables ? s.tables.items.find(i => i.id === id) : null;
        if (!it) return err('Unknown item');
        const before = it.par === undefined ? null : it.par;
        if (before !== (p.p_par_before === undefined ? null : p.p_par_before)) return Object.assign(err('CONFLICT'), { detail: 'items ' + id + ' has changed' });
        if (before !== p.p_par) {
          const b = clone(it);
          it.par = p.p_par;
          this.editorLog(s, p.p_by, 'Changed the par of "' + it.name + '" on a phone: ' + (before === null ? '(blank)' : before) + ' → ' + p.p_par,
                         [{ t: 'items', before: b, after: clone(it) }], null);
        }
        (s.quickEdits || []).filter(e => s.state && e.cycle === s.state.cycleDate && e.kind === 'par_today' && e.id === id && e.active)
          .forEach(e => { e.active = false; if (e.review === 'open') e.review = 'reverted'; });
        this.editorPublish(s);
        return this.snapshot(slug, s, p.p_have_version, sess.authType);
      }
    }
    return err('fake: unknown function ' + fn);
  }
}

const PHONE_FNS = { mog_login: 1, mog_snapshot: 1, mog_save_counts: 1, mog_set_override: 1, mog_set_vendor_pick: 1,
                    mog_snapshot2: 1, mog_save_counts2: 1, mog_quick_edit: 1, mog_set_par: 1 };

// ---- The editor's calls (schema_v6.sql) -------------------------------------
// Written apart from template/editor/catalogEdit.js on purpose, so the host
// test checks one against the other.
const EDITOR_FNS = { mog_editor_login: 1, mog_editor_get: 1, mog_editor_apply: 1, mog_editor_undo: 1, mog_editor_review: 1 };
const EDITOR_FIELDS = {
  items: ['name', 'primaryVendor', 'pack', 'par', 'active', 'useMult', 'notes', 'sku', 'category', 'eligible'],
  pickRows: ['area', 'shelfOrder'], vendors: ['mults', 'cutoff'], areas: ['ord']
};
const editorIdent = (t, r) => (t === 'items' ? r.id : t === 'pickRows' ? r.vendor + ' / ' + r.id : r.name);
function editorSame(t, cur, want) {
  const v = x => JSON.stringify(x === undefined || x === null || x === '' ? null : x);
  return EDITOR_FIELDS[t].every(f => v(cur[f]) === v(want[f]));
}
// mog.editor_apply_ops: the tables after ops, or an Error (CONFLICT: ..., or
// what the database would refuse: links, unique names, unlisted vendors).
function editorApplyOps(tables, ops) {
  const t = clone(tables);
  for (const op of ops) {
    if (!op || typeof op !== 'object') throw new Error('BAD_OP');
    if ('shift' in op) {
      if (op.shift !== 'items' || typeof op.from !== 'number') throw new Error('BAD_OP');
      for (const it of t.items) if (it.seq >= op.from) it.seq += 1;
      continue;
    }
    const b = op.before || null, a = op.after || null, row = a || b;
    if (!row || !EDITOR_FIELDS[op.t]) throw new Error('BAD_OP: ' + JSON.stringify(op).slice(0, 100));
    if (a && b && editorIdent(op.t, a) !== editorIdent(op.t, b)) throw new Error('BAD_OP: before and after are different rows');
    const list = t[op.t];
    const i = list.findIndex(r => editorIdent(op.t, r) === editorIdent(op.t, row));
    if (!b && i >= 0) throw new Error('CONFLICT: ' + op.t + ' ' + editorIdent(op.t, row) + ' is already there');
    if (b && (i < 0 || !editorSame(op.t, list[i], b))) throw new Error('CONFLICT: ' + op.t + ' ' + editorIdent(op.t, row) + ' has changed');
    if (op.t === 'items' && a) {
      const bad = (a.eligible || []).find(x => !t.vendors.some(v => v.name === x));
      if (bad) throw new Error('Vendor "' + bad + '" is not listed');
    }
    if (!a) {
      list.splice(i, 1);
      if (op.t === 'items') t.pickRows = t.pickRows.filter(r => r.id !== b.id);           // on delete cascade
      if (op.t === 'areas') t.pickRows = t.pickRows.filter(r => r.area !== b.name);
      if (op.t === 'vendors') {
        t.pickRows = t.pickRows.filter(r => r.vendor !== b.name);
        for (const it of t.items) if (it.primaryVendor === b.name) it.primaryVendor = null;  // D23
      }
    } else if (i < 0) {
      const seqs = list.map(r => r.seq || 0);
      list.push(Object.assign({}, clone(a), { seq: a.seq != null ? a.seq : Math.max(0, ...seqs) + 1 }));
    } else {
      const keep = op.t === 'items' ? list[i].seq : (a.seq != null ? a.seq : list[i].seq);
      list[i] = Object.assign({}, clone(a), op.t === 'items' || op.t === 'pickRows' ? { seq: keep } : {});
    }
  }
  return checkCatalogTables(t);
}
function editorTablesJson(t) {
  const c = clone(t);
  c.vendors.sort((x, y) => x.name.localeCompare(y.name));
  c.areas.sort((x, y) => (x.ord - y.ord) || (x.name < y.name ? -1 : 1));
  c.items.sort((x, y) => (x.seq - y.seq) || (x.id < y.id ? -1 : 1));
  c.pickRows.sort((x, y) => (x.seq - y.seq) || (x.vendor < y.vendor ? -1 : x.vendor > y.vendor ? 1 : 0) || (x.id < y.id ? -1 : 1));
  return c;
}

FakeSupabase.prototype.editorData = function (slug, s) {
  return { store: { slug, location: s.profile.location || null, abbr: s.profile.abbr || null, concept: s.profile.concept || null },
           tables: editorTablesJson(s.tables),
           changes: (s.changeLog || []).slice(-100).reverse().map(l => ({ id: l.id, at: l.at, by: l.by, label: l.label,
                                                                          undoes: l.undoes, undoneBy: l.undoneBy })),
           reviews: (s.quickEdits || []).filter(e => e.review === 'open').slice(-200).reverse()
             .map(e => ({ id: e.qid, at: e.at, by: e.by, cycleDate: e.cycle, kind: e.kind, vendor: e.vendor, itemId: e.id,
                          parBefore: e.parBefore, parAfter: e.parAfter })),
           catalogVersion: s.version };
};
FakeSupabase.prototype.editorPublish = function (s) {
  s.version = Math.max(this.nowMs, (s.version || 0) + 1);
  s.catalog = catalogFromTables(s);
  return s.version;
};
FakeSupabase.prototype.editorLog = function (s, by, label, ops, undoes) {
  s.changeLog = s.changeLog || [];
  this.changeSeq = (this.changeSeq || 0) + 1;
  const entry = { id: this.changeSeq, at: new Date(this.nowMs).toISOString(), by: String(by == null ? '' : by).trim().slice(0, 40) || null,
                  label, ops: clone(ops), undoes: undoes || null, undoneBy: null };
  s.changeLog.push(entry);
  return entry;
};
FakeSupabase.prototype.handleEditor = function (fn, p) {
  const ok = data => ({ ok: true, data });
  const err = (error, extra) => Object.assign({ ok: false, error }, extra || {});
  if (fn === 'mog_editor_login') {
    const slug = String(p.p_slug || '').trim().toLowerCase();
    const s = this.stores.get(slug);
    if (!s) return err('Unknown store');
    if (!s.editorDirect) return err('EDITOR_NOT_DIRECT');
    if (s.lockedUntil) {
      if (s.lockedUntil > this.nowMs) return err('Too many attempts', { lockout: true, retryAfterMs: s.lockedUntil - this.nowMs });
      s.failCount = 0; s.lockedUntil = 0;
    }
    const pin = String(p.p_pin == null ? '' : p.p_pin);
    const type = (s.pins.pin && pin === s.pins.pin) ? 'store' : (s.pins.master && pin === s.pins.master) ? 'master' : null;
    if (!type) {
      s.failCount++;
      if (s.failCount >= 5) { s.lockedUntil = this.nowMs + 300000; return err('Too many attempts', { lockout: true, retryAfterMs: 300000 }); }
      return err('Invalid PIN');
    }
    s.failCount = 0;
    const token = 'etok' + (++this.tokenSeq) + '-' + slug;
    s.sessions.set(token, { authType: type, expires: this.nowMs + 12 * 3600000 });
    return ok(Object.assign(this.editorData(slug, s), { token, expiresAt: 'fake' }));
  }
  let slug = null;
  for (const [sl, st] of this.stores) {
    const x = st.sessions.get(p.p_token);
    if (x && x.expires > this.nowMs) { slug = sl; break; }
  }
  if (!slug) return err('SESSION_EXPIRED');
  const s = this.stores.get(slug);
  if (!s.editorDirect) return err('EDITOR_NOT_DIRECT');
  if (fn === 'mog_editor_get') return ok(this.editorData(slug, s));
  if (fn === 'mog_editor_review') {
    if (p.p_status !== 'applied' && p.p_status !== 'dismissed') return err('Status must be applied or dismissed');
    const e = (s.quickEdits || []).find(x => x.qid === Number(p.p_id) && x.review === 'open');
    if (!e) return err('Not waiting for review');
    e.review = p.p_status;
    return ok({ id: e.qid, review: e.review });
  }

  const tryApply = ops => {
    try { s.tables = editorApplyOps(s.tables, ops); return null; } catch (e) {
      const m = String(e.message);
      return m.indexOf('CONFLICT: ') === 0 ? err('CONFLICT', { detail: m.slice(10) }) : err('REJECTED: ' + m);
    }
  };
  if (fn === 'mog_editor_apply') {
    const ops = p.p_ops;
    if (!Array.isArray(ops)) return err('ops must be an array');
    if (ops.length > 5000) return err('Too many changes at once');
    if (!ops.length) return ok({ changeId: null, catalogVersion: s.version });
    const bad = tryApply(ops);
    if (bad) return bad;
    const entry = this.editorLog(s, p.p_by, String(p.p_label || '').trim().slice(0, 300) || 'Catalog change', ops, null);
    return ok({ changeId: entry.id, catalogVersion: this.editorPublish(s) });
  }
  // mog_editor_undo
  const c = (s.changeLog || []).find(l => l.id === Number(p.p_change_id));
  if (!c) return err('Unknown change');
  if (c.undoneBy) return err('ALREADY_UNDONE');
  const inv = c.ops.filter(op => !('shift' in op)).reverse().map(op => ({ t: op.t, before: op.after, after: op.before }));
  const bad = tryApply(inv);
  if (bad) {
    if (bad.error === 'CONFLICT') {
      const idOf = op => op.t + ' ' + editorIdent(op.t, op.after || op.before);
      const mine = new Set(c.ops.filter(op => !('shift' in op)).map(idOf));
      const later = s.changeLog.filter(l => l.id > c.id && !l.undoneBy && l.ops.some(op => !('shift' in op) && mine.has(idOf(op)))).pop();
      bad.laterChange = later ? { id: later.id, label: later.label, by: later.by, at: later.at } : null;
    }
    return bad;
  }
  const entry = this.editorLog(s, p.p_by, ('Undo: ' + c.label).slice(0, 300), inv, c.id);
  c.undoneBy = entry.id;
  if (c.undoes) { const orig = s.changeLog.find(l => l.id === c.undoes); if (orig) orig.undoneBy = null; }
  return ok({ changeId: entry.id, catalogVersion: this.editorPublish(s) });
};

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
