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

// schema_v10.sql mog.vendor_contact_clean: the eight keys, text only, trimmed
// (mog.js_trim is JS trim), empty ones left out, too long throws. Keys come
// out in jsonb's stored order (shorter first, then bytewise), so a contact
// read back from the fake looks like one read back from Postgres.
const CONTACT_KEYS = ['person', 'phone', 'email', 'orderVia', 'orderEmail', 'website', 'account', 'notes'];
const jsonbKeyOrder = (a, b) => (a.length - b.length) || (a < b ? -1 : a > b ? 1 : 0);
function vendorContactClean(p) {
  const out = {};
  if (!p || typeof p !== 'object' || Array.isArray(p)) return out;
  for (const k of CONTACT_KEYS.slice().sort(jsonbKeyOrder)) {
    if (typeof p[k] !== 'string') continue;
    const v = p[k].trim(), max = k === 'notes' ? 500 : 200;
    if (v.length > max) throw new Error('Contact ' + k + ' is longer than ' + max + ' characters');
    if (v) out[k] = v;
  }
  return out;
}

// schema_v4.sql's catalog tables: mog.replace_catalog_tables' input checks and
// the table rules (checks, primary keys, case-insensitive unique names,
// foreign keys). Throws the first broken rule; returns clean copies. A
// vendor keeps its contact (v10) only when it has one, as mog.tables_json
// reads it.
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
    const v = { name: name(e.name, 100, 'vendor'), mults: mults.slice(), cutoff };
    const contact = vendorContactClean(e.contact);
    if (Object.keys(contact).length) v.contact = contact;
    return v;
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
    const it = { id: name(e.id, 100, 'item'), name: nm, primaryVendor: primary, pack: e.pack == null ? '' : String(e.pack),
                 par: num(e.par, 'par'), active: e.active == null ? true : e.active === true,
                 useMult: e.useMult == null ? true : e.useMult === true, notes: e.notes || '', sku: e.sku || '',
                 category: e.category || '', eligible: (e.eligible || []).slice(), seq: e.seq == null ? i + 1 : e.seq };
    if (e.lto != null && e.lto !== '') {   // v14: the LTO that made it, only when it has one (as mog.item_row_json)
      if (typeof e.lto !== 'string') throw new Error('items lto: ' + JSON.stringify(e.lto));
      it.lto = e.lto;
    }
    return it;
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
  const withContact = t.vendors.filter(v => v.contact && Object.keys(v.contact).length);   // v10: only when one has it
  return Object.assign({
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
  }, withContact.length ? { vendorContacts: obj(withContact.map(v => [v.name, clone(v.contact)])) } : {});
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

  // mog.person_now (schema_v9.sql): what a name stands for now.
  personNow(s, name) {
    const v = String(name == null ? '' : name).trim().slice(0, 40);
    if (!v) return { name: null, status: 'new' };
    const sp = s.people.get(v.toLowerCase());
    if (!sp) return { name: v, status: 'new' };
    if (sp.renamedTo) return { name: sp.renamedTo, status: 'renamed' };
    if (sp.removedAt) return { name: null, status: 'removed' };
    return { name: sp.name, status: 'ok' };
  }
  // mog.touch_presence + mog.live_json (schema_v5.sql; People's names, v9).
  touch(s, device, name, vendor) {
    if (!/^[A-Za-z0-9_-]{8,64}$/.test(String(device || ''))) return;
    const nm = this.personNow(s, name).name;
    const vd = String(vendor == null ? '' : vendor).trim().slice(0, 100) || null;
    s.presence.set(device, { name: nm, vendor: vd, seenAt: this.nowMs });
    if (nm) {
      const k = nm.toLowerCase();
      const had = s.people.get(k);
      if (!had) s.people.set(k, { name: nm, lastUsed: this.nowMs, removedAt: null, renamedTo: null });
      else if (!had.removedAt && !had.renamedTo) had.lastUsed = this.nowMs;
    }
  }
  peopleList(s) {
    const lower = x => x.toLowerCase();
    return Array.from(s.people.values()).filter(p => !p.removedAt && !p.renamedTo)
      .sort((a, b) => (lower(a.name) < lower(b.name) ? -1 : lower(a.name) > lower(b.name) ? 1 : 0))
      .map(p => ({ name: p.name, lastUsed: new Date(p.lastUsed).toISOString(), inPicker: p.lastUsed > this.nowMs - 30 * 86400000 }));
  }
  live(s, device) {
    const presence = Array.from(s.presence.entries())
      .filter(([d, p]) => d !== (device || '') && p.seenAt > this.nowMs - 90000)
      .sort((a, b) => b[1].seenAt - a[1].seenAt)
      .map(([, p]) => ({ name: p.name, vendor: p.vendor, secondsAgo: Math.floor((this.nowMs - p.seenAt) / 1000) }));
    const lower = x => x.toLowerCase();
    const people = Array.from(s.people.values()).filter(p => !p.removedAt && !p.renamedTo && p.lastUsed > this.nowMs - 30 * 86400000)
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
    if (HQ_FNS[fn]) return this.handleHq(fn, p);
    if (WH_FNS[fn]) return this.handleWh(fn, p);
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
        for (const v of next.vendors) delete v.contact;   // replace_catalog_tables names its columns: no contact
        for (const it of next.items) delete it.lto;       // nor an item's LTO (v14)
        const pr = (p.p_tables && p.p_tables.profile) || {};
        for (const k of ['timeZone', 'location', 'abbr', 'concept']) if (pr[k] != null) s.profile[k] = String(pr[k]);
        s.tables = next;
        const built = catalogFromTables(s);
        return ok({ seeded: { vendors: next.vendors.length, areas: next.areas.length, items: next.items.length,
                              pickRows: next.pickRows.length },
                    catalog: this.catalogDefect ? this.catalogDefect(built) : built });   // catalogDefect: a test's planted builder bug
      }

      // schema_v9.sql: the Sheet's LOG_ORDERS copied in, dates the log lacks only.
      case 'mog_sync_backfill_log': {
        if (!Array.isArray(p.p_rows)) return err('a rows array is required');
        if (p.p_rows.length > 20000) return err('Too many rows in one call');
        const rows = p.p_rows.filter(e => e && /^\d{4}-\d{2}-\d{2}$/.test(String(e.date || '')) &&
          (String(e.vendor || '').trim() || String(e.name || '').trim()));
        const have = new Set(s.log.map(r => r.cycleDate));
        const dates = Array.from(new Set(rows.map(r => r.date)));
        const fresh = rows.filter(r => !have.has(r.date));
        const seq = new Map();
        for (const e of fresh) {
          seq.set(e.date, (seq.get(e.date) || 0) + 1);
          const qty = toOnHand(e.qty);
          s.log.push({ cycleDate: e.date, seq: seq.get(e.date), vendor: String(e.vendor || '').trim(), id: String(e.id || '').trim(),
                       name: String(e.name || '').trim(), pack: String(e.pack || '').trim(), area: '',
                       onHandPrev: toOnHand(e.onHandPrev), qty: qty === null ? 0 : qty,
                       loggedAt: e.at || (e.date + 'T00:00:00Z') });
        }
        return ok({ inserted: fresh.length, dates: dates.filter(d => !have.has(d)).length,
                    skippedDates: dates.filter(d => have.has(d)).length });
      }

      // schema_v9.sql: recipients (T2).
      case 'mog_sync_get_recipients':
        return ok({ recipients: clone(s.recipients || []), seeded: !!s.recipientsSeeded });
      case 'mog_sync_seed_recipients': {
        if (!Array.isArray(p.p_recipients)) return err('recipients must be an array');
        if (s.recipientsSeeded) return ok({ seeded: false, already: true });
        const jt = x => (x === null || x === undefined ? '' : String(x)).replace(/^\s+|\s+$/g, '');
        const list = [], seen = new Set();
        for (const e of p.p_recipients) {
          const name = jt(e && e.name).slice(0, 200), email = jt(e && e.email).slice(0, 320);
          if (!name && !email) continue;
          if (email && seen.has(email.toLowerCase())) continue;
          if (email) seen.add(email.toLowerCase());
          list.push({ name, email, active: e.active === true, gm: e.gm === true });
        }
        s.recipients = list;
        s.recipientsSeeded = true;
        return ok({ seeded: true, count: list.length });
      }

      // schema_v8.sql: the store's editor moves to Supabase. Starting empty
      // clears the catalog tables and takes back phones' one-day edits; a copy
      // needs seeded tables. A second call changes nothing.
      case 'mog_sync_switch_editor': {
        if (s.editorDirect) return ok({ alreadySwitched: true, catalogVersion: s.version });
        if (p.p_start_empty) {
          s.tables = { vendors: [], areas: [], items: [], pickRows: [] };
          for (const e of s.quickEdits || []) { e.active = false; if (e.review === 'open') e.review = 'dismissed'; }
        } else if (!(s.tables && (s.tables.vendors.length || s.tables.items.length))) {
          return err('NOT_SEEDED');
        }
        s.editorDirect = true;
        return ok({ alreadySwitched: false, startedEmpty: !!p.p_start_empty, catalogVersion: this.editorPublish(s) });
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
        const now = this.personNow(s, p.p_name);
        if (p.p_device != null) this.touch(s, p.p_device, p.p_name, p.p_vendor);
        return ok(Object.assign(snap.data, this.live(s, p.p_device),
          { nameNow: now.status === 'renamed' ? now.name : null, nameGone: now.status === 'removed' }));
      }
      // schema_v9.sql: People (T3).
      case 'mog_people_list':
        return ok({ people: this.peopleList(s) });
      case 'mog_people_rename': {
        const to = String(p.p_to == null ? '' : p.p_to).trim();
        if (!to || to.length > 40) return err('A name is 1 to 40 characters.');
        const from = String(p.p_from == null ? '' : p.p_from).trim().toLowerCase();
        const f = s.people.get(from);
        if (!f || f.removedAt || f.renamedTo) return err('NOT_FOUND');
        let name = to;
        if (to.toLowerCase() === f.name.toLowerCase()) {
          f.name = to;
        } else {
          const t = s.people.get(to.toLowerCase());
          if (t) {
            if (t.removedAt || t.renamedTo) t.name = to;
            t.removedAt = null; t.renamedTo = null; t.lastUsed = Math.max(t.lastUsed, f.lastUsed);
            name = t.name;
          } else {
            s.people.set(to.toLowerCase(), { name: to, lastUsed: f.lastUsed, removedAt: null, renamedTo: null });
          }
          for (const x of s.people.values()) {
            if (x === f || (x.renamedTo && x.renamedTo.toLowerCase() === f.name.toLowerCase())) x.renamedTo = name;
          }
        }
        for (const pr of s.presence.values()) if (pr.name && pr.name.toLowerCase() === f.name.toLowerCase() && pr.name !== name) pr.name = name;
        return ok({ name, people: this.peopleList(s) });
      }
      case 'mog_people_remove': {
        const nm = String(p.p_name == null ? '' : p.p_name).trim().toLowerCase();
        const f = s.people.get(nm);
        if (!f || f.removedAt || f.renamedTo) return err('NOT_FOUND');
        for (const x of s.people.values()) {
          if (x === f || (x.renamedTo && x.renamedTo.toLowerCase() === nm)) { x.removedAt = this.nowMs; x.renamedTo = null; }
        }
        for (const pr of s.presence.values()) if (pr.name && pr.name.toLowerCase() === nm) pr.name = null;
        return ok({ people: this.peopleList(s) });
      }
      case 'mog_people_join': {
        const nm = String(p.p_name == null ? '' : p.p_name).trim();
        if (!nm || nm.length > 40) return err('A name is 1 to 40 characters.');
        const sp = s.people.get(nm.toLowerCase());
        if (sp && sp.renamedTo) {
          const t = s.people.get(sp.renamedTo.toLowerCase());
          if (t) t.lastUsed = this.nowMs;
          return ok({ name: sp.renamedTo });
        }
        if (sp) { sp.removedAt = null; sp.lastUsed = this.nowMs; return ok({ name: sp.name }); }
        s.people.set(nm.toLowerCase(), { name: nm, lastUsed: this.nowMs, removedAt: null, renamedTo: null });
        return ok({ name: nm });
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
                    mog_snapshot2: 1, mog_save_counts2: 1, mog_quick_edit: 1, mog_set_par: 1,
                    mog_people_list: 1, mog_people_rename: 1, mog_people_remove: 1, mog_people_join: 1 };

// ---- The editor's calls (schema_v6.sql) -------------------------------------
// Written apart from template/editor/catalogEdit.js on purpose, so the host
// test checks one against the other.
const EDITOR_FNS = { mog_editor_login: 1, mog_editor_get: 1, mog_editor_apply: 1, mog_editor_undo: 1, mog_editor_review: 1,
                     mog_history: 1, mog_recipients_get: 1, mog_recipients_save: 1, mog_editor_status: 1,
                     mog_editor_clear_lockout: 1 };

// mog.recipients_check (schema_v9.sql), written from the SQL (the recipients
// gate checks it against Recap.gs api_saveRecipients_): { ok, list } or
// { ok: false, error }.
function recipientsCheck(stored, list, gmEdit) {
  const bad = error => ({ ok: false, error });
  if (!Array.isArray(list)) return bad('recipients must be an array');
  if (list.length > 200) return bad('Too many recipients');
  const text = x => (x === null || x === undefined ? '' : typeof x === 'string' ? x : JSON.stringify(x));
  const jt = x => text(x).replace(/^\s+|\s+$/g, '');
  if (!gmEdit) {
    for (const g of stored.filter(r => r.gm)) {
      let m = null;
      for (const e of list) if (jt(e && e.email) !== '' && jt(e.email).toLowerCase() === g.email.toLowerCase()) m = e;
      if (!m) return bad('Cannot remove GM recipient "' + g.name + '". The GM row is changed on a computer.');
      if (jt(m.name) !== g.name || m.active !== g.active || m.gm !== true) {
        return bad('Cannot modify GM recipient "' + g.name + '". The GM row is changed on a computer.');
      }
    }
  }
  const out = [], seen = new Set();
  for (const e of list) {
    const name = jt(e && e.name), email = jt(e && e.email);
    if (!name && !email) continue;
    if (!name) return bad('Recipient is missing a name.');
    if (!email) return bad('Recipient "' + name + '" is missing an email.');
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return bad('Recipient "' + name + '" has an invalid email: ' + email);
    if (seen.has(email.toLowerCase())) return bad('Duplicate email: ' + email);
    if (name.length > 200 || email.length > 320) return bad('Recipient "' + name.slice(0, 40) + '" is too long.');
    seen.add(email.toLowerCase());
    const gm = gmEdit ? e.gm === true : stored.some(r => r.gm && r.email.toLowerCase() === email.toLowerCase());
    out.push({ name, email, active: e.active === true, gm });
  }
  return { ok: true, list: out };
}
const EDITOR_FIELDS = {
  items: ['name', 'primaryVendor', 'pack', 'par', 'active', 'useMult', 'notes', 'sku', 'category', 'eligible', 'lto'],
  pickRows: ['area', 'shelfOrder'], vendors: ['mults', 'cutoff', 'contact'], areas: ['ord']
};
const editorIdent = (t, r) => (t === 'items' ? r.id : t === 'pickRows' ? r.vendor + ' / ' + r.id : r.name);
// v10: a contact is compared clean, and an empty one is the same as none.
function editorSame(t, cur, want) {
  const v = (x, f) => {
    if (f === 'contact') { x = vendorContactClean(x); if (!Object.keys(x).length) x = null; }
    return JSON.stringify(x === undefined || x === null || x === '' ? null : x);
  };
  return EDITOR_FIELDS[t].every(f => v(cur[f], f) === v(want[f], f));
}
// mog.editor_apply_ops: the tables after ops, or an Error (CONFLICT: ..., or
// what the database would refuse: links, unique names, unlisted vendors, and
// (v14) an item naming an LTO that doesn't exist, when ltoIds is given).
function editorApplyOps(tables, ops, ltoIds) {
  const out = editorApplyOps1(tables, ops);
  if (ltoIds) for (const it of out.items) if (it.lto && !ltoIds.has(it.lto)) throw new Error('items lto foreign key: ' + it.lto);
  return out;
}
function editorApplyOps1(tables, ops) {
  const t = clone(tables);
  for (const op of ops) {
    if (!op || typeof op !== 'object') throw new Error('BAD_OP');
    if ('shift' in op) {
      if (op.shift !== 'items' || typeof op.from !== 'number') throw new Error('BAD_OP');
      for (const it of t.items) if (it.seq >= op.from) it.seq += 1;
      continue;
    }
    if ('rename' in op) {   // schema v8: update mog.areas set name; pick_rows follow (on update cascade)
      if (op.rename !== 'areas' || typeof op.from !== 'string' || typeof op.to !== 'string') throw new Error('BAD_OP');
      if (!t.areas.some(a => a.name === op.from)) throw new Error('CONFLICT: areas ' + op.from + ' has changed');
      if (t.areas.some(a => a.name !== op.from && a.name.toLowerCase() === op.to.toLowerCase())) throw new Error('CONFLICT: areas ' + op.to + ' is already there');
      for (const a of t.areas) if (a.name === op.from) a.name = op.to;
      for (const r of t.pickRows) if (r.area === op.from) r.area = op.to;
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
// mog.tables_json; ltos (v14) are the LTOs sent to the store, added only when
// there is one, keys in jsonb's order.
function editorTablesJson(t, ltos) {
  const c = clone(t);
  c.vendors.sort((x, y) => x.name.localeCompare(y.name));
  c.areas.sort((x, y) => (x.ord - y.ord) || (x.name < y.name ? -1 : 1));
  c.items.sort((x, y) => (x.seq - y.seq) || (x.id < y.id ? -1 : 1));
  c.pickRows.sort((x, y) => (x.seq - y.seq) || (x.vendor < y.vendor ? -1 : x.vendor > y.vendor ? 1 : 0) || (x.id < y.id ? -1 : 1));
  if (ltos && ltos.length) c.ltos = ltos;
  return c;
}
// A store's LTOs as mog.tables_json lists them: sent order, then id.
FakeSupabase.prototype.ltosFor = function (slug) {
  const H = this.hqState();
  return H.ltoStores.filter(r => r.slug === slug)
    .sort((a, b) => (a.sentAt < b.sentAt ? -1 : a.sentAt > b.sentAt ? 1 : 0) || (a.ltoId < b.ltoId ? -1 : 1))
    .map(r => { const l = H.ltos.get(r.ltoId); return { id: l.id, name: l.name, sentAt: r.sentAt, status: l.status }; });
};

FakeSupabase.prototype.editorData = function (slug, s) {
  return { store: { slug, location: s.profile.location || null, abbr: s.profile.abbr || null, concept: s.profile.concept || null },
           tables: editorTablesJson(s.tables, this.ltosFor(slug)),
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
// ---- HQ control (schema_v11.sql, v12) ---------------------------------------
// People with their own lockout (5 wrong, 15 minutes), a one-use invite that
// becomes a passphrase, 12-hour tokens, the remembered vendor names (gone
// with their vendor: the SQL's on delete cascade, applied here on read), and
// one save across stores that writes every store or none. v12: each store's
// side (from its location, as mog.store_side_fill), and the concept libraries
// saved whole in that same save (mog.library_put: cleaned, versioned, logged).
// v13: each person's roles (hq, warehouse); the catalog calls answer only the
// hq role (mog.hq_session), and signing in returns the roles.
const HQ_FNS = { mog_hq_claim: 1, mog_hq_login: 1, mog_hq_data: 1, mog_hq_apply: 1 };
FakeSupabase.prototype.hqState = function () {
  if (!this.hq) this.hq = { users: new Map(), sessions: new Map(), links: [], tokenSeq: 0, libraries: new Map(), libraryLog: [],
                            ltos: new Map(), ltoStores: [] };
  return this.hq;
};
// mog.lto_before over copies (v14): the LTO's checks, before any store
// changes; send creates it. Throws REJECTED: / CONFLICT: as the SQL raises
// them. changes are mog_hq_apply's p_changes.
function ltoBefore(ltos, ltoStores, stores, by, lto, changes, nowIso) {
  if (lto == null) return;
  const act = lto.action, id = lto.id;
  if (['send', 'more', 'end', 'rollback', 'standard'].indexOf(act) < 0) throw new Error('REJECTED: an LTO\'s action is send, more, end, rollback or standard');
  if (typeof id !== 'string' || !/^lto_[a-z0-9]{8,40}$/.test(id)) throw new Error('REJECTED: no LTO called ' + (id == null ? '(none)' : id));
  const slugs = Array.from(new Set(changes.filter(c => !Array.isArray(c.ops) || c.ops.length).map(c => c.slug)));
  let sent = [];
  if (act === 'send' || act === 'more') {
    if (!Array.isArray(lto.stores) || !lto.stores.length || lto.stores.length > 50) throw new Error('REJECTED: an LTO goes to 1 to 50 stores');
    sent = lto.stores.map(x => x && x.slug);
    const stray = slugs.find(x => sent.indexOf(x) < 0);
    if (stray) throw new Error('REJECTED: a change at ' + stray + ', which the LTO isn\'t going to');
  }
  let concept;
  if (act === 'send') {
    concept = lto.concept;
    const nm = String(lto.name == null ? '' : lto.name).trim();
    if (typeof concept !== 'string' || !/^[a-z0-9-]{1,30}$/.test(concept)) throw new Error('REJECTED: no concept called ' + (concept == null ? '(none)' : concept));
    if (!nm || nm.length > 80) throw new Error('REJECTED: an LTO needs a name of at most 80 characters');
    if (!Array.isArray(lto.items) || lto.items.length > 200) throw new Error('REJECTED: an LTO\'s items are a list of at most 200');
    if (ltos.has(id)) throw new Error('REJECTED: that LTO was already sent');
    ltos.set(id, { id, concept, name: nm, items: clone(lto.items), status: 'running', version: 1, createdAt: nowIso, createdBy: by,
                   statusAt: null, statusBy: null });
  } else {
    const row = ltos.get(id);
    if (!row) throw new Error('REJECTED: no LTO called ' + id);
    if (row.status !== 'running') {
      throw new Error('REJECTED: LTO "' + row.name + '" is ' + ({ ended: 'ended', rolledback: 'rolled back' }[row.status] || 'standard') + ' already');
    }
    if (typeof lto.version !== 'number' || row.version !== lto.version) {
      throw new Error('CONFLICT: LTO "' + row.name + '" was changed since HQ loaded it (by ' + (row.statusBy || row.createdBy) + ')');
    }
    concept = row.concept;
    const has = x => ltoStores.some(r => r.ltoId === id && r.slug === x);
    if (act === 'more') {
      const again = sent.find(has);
      if (again) throw new Error('REJECTED: LTO "' + row.name + '" already went to ' + again);
    } else {
      const never = slugs.find(x => !has(x));
      if (never) throw new Error('REJECTED: LTO "' + row.name + '" never went to ' + never);
    }
  }
  if (act === 'send' || act === 'more') {
    const other = sent.find(x => { const s = stores.get(x); return !s || s.profile.concept !== concept; });
    if (other !== undefined) throw new Error('REJECTED: ' + (other || '(no store)') + ' isn\'t a ' + concept + ' store');
  }
}
// mog.lto_after over copies (v14): the stores it went to, or its new status.
function ltoAfter(ltos, ltoStores, by, lto, out, nowIso) {
  if (lto == null) return null;
  const row = ltos.get(lto.id);
  if (lto.action === 'send' || lto.action === 'more') {
    for (const x of lto.stores) {
      if (!x || typeof x !== 'object' || Array.isArray(x) || !Array.isArray(x.vendorsAdded || []) || !Array.isArray(x.backupsAdded || [])
          || (x.backupsAdded || []).length > 2000) {
        throw new Error('REJECTED: each store of an LTO is { slug, vendorsAdded, backupsAdded }');
      }
      if (ltoStores.some(r => r.ltoId === row.id && r.slug === x.slug)) throw new Error('REJECTED: duplicate key value violates unique constraint "lto_stores_pkey"');
      const o = out.find(c => c.slug === x.slug);
      ltoStores.push({ ltoId: row.id, slug: x.slug, sentAt: nowIso, sentBy: by, changeId: o ? o.changeId : null,
                       vendorsAdded: (x.vendorsAdded || []).filter(v => typeof v === 'string'), backupsAdded: clone(x.backupsAdded || []) });
    }
    if (lto.action === 'more') row.version++;
  } else {
    row.status = { end: 'ended', rollback: 'rolledback' }[lto.action] || 'standard';
    row.statusAt = nowIso; row.statusBy = by; row.version++;
  }
  return { id: row.id, status: row.status, version: row.version };
}
// mog.side_from_location
function sideFromLocation(loc) {
  const s = String(loc == null ? '' : loc);
  return /(^|[^A-Za-z0-9_])FOH($|[^A-Za-z0-9_])/i.test(s) ? 'FOH' : /(^|[^A-Za-z0-9_])BOH($|[^A-Za-z0-9_])/i.test(s) ? 'BOH' : null;
}
// mog.library_put over a copy of the libraries: the new library, or throws
// CONFLICT: / REJECTED: as the SQL raises them.
function libraryPut(libs, log, by, lib, nowIso) {
  const jsTrim = v => String(v == null ? '' : v).trim();
  if (!lib || typeof lib !== 'object' || Array.isArray(lib)) throw new Error('REJECTED: a library must be an object');
  const concept = lib.concept, side = lib.side;
  if (typeof concept !== 'string' || !/^[a-z0-9-]{1,30}$/.test(concept)) throw new Error('REJECTED: no concept called ' + (concept == null ? '(none)' : concept));
  if (side !== 'BOH' && side !== 'FOH') throw new Error('REJECTED: a library\'s side is BOH or FOH');
  if (typeof lib.version !== 'number') throw new Error('REJECTED: the library\'s version is missing');
  if (!Array.isArray(lib.items) || lib.items.length > 2000) throw new Error('REJECTED: a library\'s items are a list of at most 2000');
  const key = concept + '|' + side;
  const cur = libs.get(key) || { concept, side, version: 0, seededFrom: null, updatedAt: null, updatedBy: null, items: [] };
  if (cur.version !== lib.version) throw new Error('CONFLICT: the ' + concept + ' ' + side + ' library was saved since HQ loaded it (by ' + (cur.updatedBy || 'someone') + ')');
  const items = [], names = new Set();
  lib.items.forEach((it, i) => {
    if (!it || typeof it !== 'object' || Array.isArray(it)) throw new Error('REJECTED: item ' + (i + 1) + ' isn\'t an item');
    const name = jsTrim(it.name);
    const what = name ? '"' + name.slice(0, 60) + '"' : 'Item ' + (i + 1);
    if (!name) throw new Error('REJECTED: Item ' + (i + 1) + ' has no name');
    if (name.length > 300) throw new Error('REJECTED: ' + what + ' is longer than 300 characters');
    if (names.has(name.toLowerCase())) throw new Error('REJECTED: ' + what + ' is in the library twice');
    names.add(name.toLowerCase());
    const vendor = jsTrim(it.vendor);
    if (!vendor) throw new Error('REJECTED: ' + what + ' has no main vendor');
    if (vendor.length > 100) throw new Error('REJECTED: ' + what + '\'s main vendor is longer than 100 characters');
    const backups = [];
    for (const b of (Array.isArray(it.backups) ? it.backups : [])) {
      const v = typeof b === 'string' ? jsTrim(b) : '';
      if (!v || v.toLowerCase() === vendor.toLowerCase() || backups.some(x => x.toLowerCase() === v.toLowerCase())) continue;
      if (v.length > 100) throw new Error('REJECTED: ' + what + '\'s backup vendor is longer than 100 characters');
      backups.push(v);
    }
    if (backups.length > 20) throw new Error('REJECTED: ' + what + ' has more than 20 backup vendors');
    const pack = jsTrim(it.pack), notes = jsTrim(it.notes);
    if (pack.length > 300 || notes.length > 1000) throw new Error('REJECTED: ' + what + '\'s pack or notes are too long');
    items.push({ name, pack, vendor, backups, notes });
  });
  const next = { concept, side, version: cur.version + 1, updatedAt: nowIso, updatedBy: by, items,
                 seededFrom: Object.prototype.hasOwnProperty.call(lib, 'seededFrom') ? (jsTrim(lib.seededFrom).slice(0, 100) || null) : cur.seededFrom };
  libs.set(key, next);
  log.push({ concept, side, at: nowIso, by, label: jsTrim(lib.label).slice(0, 300) || 'Saved the library', version: next.version, itemsBefore: clone(cur.items) });
  return { concept, side, version: next.version };
}
// mog.hq_invite: the code, as the SQL Editor shows it. Roles given (v13's
// two-argument form) replace the person's; left out, an existing person
// keeps theirs and a new one gets hq.
FakeSupabase.prototype.hqInvite = function (name, roles) {
  const H = this.hqState();
  const have = Array.from(H.users.keys()).find(n => n.toLowerCase() === String(name).trim().toLowerCase()) || String(name).trim();
  const code = 'C0DE' + (++H.tokenSeq);
  const keep = H.users.has(have) ? H.users.get(have).roles : ['hq'];
  H.users.set(have, { pass: null, invite: code, inviteExpires: this.nowMs + 24 * 3600000, fail: 0, lockedUntil: 0,
                      roles: roles ? hqRolesClean(roles) : keep });
  for (const [t, x] of H.sessions) if (x.name === have) H.sessions.delete(t);
  return code;
};
// mog.hq_set_roles
FakeSupabase.prototype.hqSetRoles = function (name, roles) {
  const H = this.hqState();
  const have = Array.from(H.users.keys()).find(n => n.toLowerCase() === String(name).trim().toLowerCase());
  if (have) H.users.get(have).roles = hqRolesClean(roles);
  return !!have;
};
// mog.hq_roles_clean: hq, warehouse or both, sorted.
function hqRolesClean(roles) {
  const v = Array.from(new Set((roles || []).map(r => String(r == null ? '' : r).trim().toLowerCase()).filter(Boolean))).sort();
  if (!v.length || v.some(r => r !== 'hq' && r !== 'warehouse')) throw new Error("Roles are hq, warehouse or both, for example '{warehouse}'.");
  return v;
}
FakeSupabase.prototype.hqLinks = function () {
  const H = this.hqState();
  H.links = H.links.filter(l => { const s = this.stores.get(l.slug); return s && s.tables && s.tables.vendors.some(v => v.name === l.vendor); });
  return H.links;
};
FakeSupabase.prototype.handleHq = function (fn, p) {
  const H = this.hqState();
  const ok = data => ({ ok: true, data });
  const err = (error, extra) => Object.assign({ ok: false, error }, extra || {});
  const now = this.nowMs;
  const userFor = name => {
    const key = Array.from(H.users.keys()).find(n => n.toLowerCase() === String(name == null ? '' : name).trim().toLowerCase());
    if (!key) return null;
    const u = H.users.get(key);
    if (u.lockedUntil && u.lockedUntil <= now) { u.fail = 0; u.lockedUntil = 0; }
    return { key, u };
  };
  const fail = (u, msg) => {
    u.fail++;
    if (u.fail >= 5) { u.lockedUntil = now + 900000; return err('Too many attempts', { lockout: true, retryAfterMs: 900000 }); }
    return err(msg);
  };
  const session = key => {
    H.users.get(key).fail = 0; H.users.get(key).lockedUntil = 0;
    const token = 'hqtok' + (++H.tokenSeq);
    H.sessions.set(token, { name: key, expires: now + 12 * 3600000 });
    return ok({ token, name: key, expiresAt: 'fake', roles: clone(H.users.get(key).roles) });
  };
  const locked = u => err('Too many attempts', { lockout: true, retryAfterMs: u.lockedUntil - now });

  if (fn === 'mog_hq_claim') {
    const f = userFor(p.p_name);
    if (!f || !f.u.invite || f.u.inviteExpires < now) return err('This invite isn\'t valid any more. Ask for a new one.');
    if (f.u.lockedUntil) return locked(f.u);
    if (String(p.p_code == null ? '' : p.p_code).trim().toUpperCase() !== f.u.invite) return fail(f.u, 'Wrong name or code');
    if (String(p.p_passphrase == null ? '' : p.p_passphrase).length < 12) return err('PASSPHRASE_TOO_SHORT');
    f.u.pass = String(p.p_passphrase); f.u.invite = null; f.u.inviteExpires = 0;
    return session(f.key);
  }
  if (fn === 'mog_hq_login') {
    const f = userFor(p.p_name);
    if (!f || f.u.pass === null) return err('Wrong name or passphrase');
    if (f.u.lockedUntil) return locked(f.u);
    if (String(p.p_passphrase == null ? '' : p.p_passphrase) !== f.u.pass) return fail(f.u, 'Wrong name or passphrase');
    return session(f.key);
  }
  const sess = H.sessions.get(p.p_token);
  if (!sess || sess.expires <= now || !H.users.has(sess.name)) return err('SESSION_EXPIRED');
  if (H.users.get(sess.name).roles.indexOf('hq') < 0) return err('SESSION_EXPIRED');
  const name = sess.name;

  if (fn === 'mog_hq_data') {
    const stores = Array.from(this.stores.entries()).map(([slug, s]) => ({
      slug, location: s.profile.location || null, abbr: s.profile.abbr || null, concept: s.profile.concept || '',
      isTest: !!s.isTest, editorDirect: !!s.editorDirect, side: s.side != null ? s.side : sideFromLocation(s.profile.location),
      tables: s.editorDirect ? editorTablesJson(s.tables, this.ltosFor(slug)) : null }))
      .sort((a, b) => (a.concept < b.concept ? -1 : a.concept > b.concept ? 1 : 0) || (a.isTest - b.isTest) ||
                      String(a.location).localeCompare(String(b.location)) || (a.slug < b.slug ? -1 : 1));
    const recent = [];
    for (const [slug, s] of this.stores) for (const l of (s.changeLog || [])) {
      if (String(l.by || '').indexOf('HQ · ') === 0) recent.push({ id: l.id, slug, at: l.at, by: l.by, label: l.label, undoneBy: l.undoneBy });
    }
    recent.sort((a, b) => b.id - a.id);
    // Each item's keys in jsonb's order (shorter first, then bytewise), as the SQL sends them.
    const libraries = Array.from(H.libraries.values()).map(l => Object.assign(clone(l), {
      items: l.items.map(it => ({ name: it.name, pack: it.pack, notes: it.notes, vendor: it.vendor, backups: clone(it.backups) })) }))
      .sort((a, b) => (a.concept < b.concept ? -1 : a.concept > b.concept ? 1 : 0) || (a.side < b.side ? -1 : 1));
    // v14: every LTO with the stores it went to, newest first.
    const ltos = Array.from(H.ltos.values()).sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0) || (a.id < b.id ? -1 : 1))
      .map(l => Object.assign(clone(l), { stores: H.ltoStores.filter(r => r.ltoId === l.id)
        .sort((a, b) => (a.sentAt < b.sentAt ? -1 : a.sentAt > b.sentAt ? 1 : 0) || (a.slug < b.slug ? -1 : 1))
        .map(r => ({ slug: r.slug, sentAt: r.sentAt, sentBy: r.sentBy, changeId: r.changeId,
                     vendorsAdded: clone(r.vendorsAdded), backupsAdded: clone(r.backupsAdded) })) }));
    return ok({ name, stores, links: clone(this.hqLinks()).sort((a, b) => (a.hqName < b.hqName ? -1 : a.hqName > b.hqName ? 1 : 0) || (a.slug < b.slug ? -1 : 1)),
                libraries, ltos, recent: recent.slice(0, 50) });
  }

  // mog_hq_apply: work every store out first, write only when all of them took.
  // p_libraries absent is the three-argument (v11) call; p_lto (v14) the LTO.
  const changes = p.p_changes, links = p.p_links == null ? [] : p.p_links;
  const libList = p.p_libraries == null ? [] : p.p_libraries;
  const lto = p.p_lto == null ? null : p.p_lto;
  if (!Array.isArray(changes) || changes.length > 50) return err('changes must be an array of at most 50 stores');
  if (!Array.isArray(links) || links.length > 1000) return err('links must be an array');
  if (!Array.isArray(libList) || libList.length > 20) return err('libraries must be an array of at most 20');
  if (lto !== null && (typeof lto !== 'object' || Array.isArray(lto))) return err('lto must be an object');
  const by = ('HQ · ' + name).slice(0, 40);
  const nowIso = new Date(now).toISOString();
  const ltosNext = new Map(Array.from(H.ltos.entries()).map(([k, v]) => [k, clone(v)]));
  const ltoStoresNext = clone(H.ltoStores);
  const failed = e => {
    const m = String(e.message);
    return m.indexOf('CONFLICT: ') === 0 ? err('CONFLICT', { detail: m.slice(10) }) : err(m.indexOf('REJECTED: ') === 0 ? m : 'REJECTED: ' + m);
  };
  try { ltoBefore(ltosNext, ltoStoresNext, this.stores, by, lto, changes, nowIso); } catch (e) { return failed(e); }
  const ltoIds = new Set(ltosNext.keys());
  const next = new Map();
  for (const ch of changes.slice().sort((a, b) => (String(a.slug) < String(b.slug) ? -1 : 1))) {
    const s = this.stores.get(ch.slug);
    if (!s || !s.editorDirect) return err('REJECTED: ' + (ch.slug || '(no store)') + ' isn\'t on the app\'s editor');
    if (!Array.isArray(ch.ops)) return err('REJECTED: ' + ch.slug + ' ops must be an array');
    if (!ch.ops.length) continue;
    if (ch.ops.length > 5000) return err('REJECTED: too many changes at once for ' + ch.slug);
    try { next.set(ch.slug, { s, ch, tables: editorApplyOps(s.tables, ch.ops, ltoIds) }); } catch (e) {
      const m = String(e.message);
      return m.indexOf('CONFLICT: ') === 0 ? err('CONFLICT', { detail: ch.slug + ' ' + m.slice(10) }) : err('REJECTED: ' + ch.slug + ' ' + m);
    }
  }
  const tablesOf = slug => (next.has(slug) ? next.get(slug).tables : (this.stores.get(slug) || {}).tables);
  for (const l of links) {
    if (l.vendor == null || l.vendor === '') continue;
    const t = tablesOf(l.slug);
    if (!t || !t.vendors.some(v => v.name === l.vendor)) return err('REJECTED: links foreign key: ' + l.slug + ' ' + l.vendor);
    const hq = String(l.hqName == null ? '' : l.hqName).trim();
    if (!hq || hq.length > 100) return err('REJECTED: hq_vendor_links_hq_name_check');
  }
  const libsNext = new Map(Array.from(H.libraries.entries()).map(([k, v]) => [k, clone(v)]));
  const logNext = [], libsOut = [];
  for (const lib of libList) {
    try { libsOut.push(libraryPut(libsNext, logNext, by, lib, new Date(now).toISOString())); } catch (e) {
      const m = String(e.message);
      return m.indexOf('CONFLICT: ') === 0 ? err('CONFLICT', { detail: m.slice(10) }) : err(m.indexOf('REJECTED: ') === 0 ? m : 'REJECTED: ' + m);
    }
  }
  // The change ids editorLog gives below (one counter, stores in this order),
  // so the LTO's record names them before anything is written, as the
  // SQL's one transaction does.
  let seq = this.changeSeq || 0;
  const outIds = Array.from(next.keys()).map(slug => ({ slug, changeId: ++seq }));
  let ltoOut;
  try { ltoOut = ltoAfter(ltosNext, ltoStoresNext, by, lto, outIds, nowIso); } catch (e) { return failed(e); }
  H.libraries = libsNext;
  H.libraryLog = H.libraryLog.concat(logNext);
  H.ltos = ltosNext;
  H.ltoStores = ltoStoresNext;
  const out = [];
  for (const [slug, x] of next) {
    x.s.tables = x.tables;
    const entry = this.editorLog(x.s, by, String(x.ch.label || '').trim().slice(0, 300) || 'HQ change', x.ch.ops, null);
    out.push({ slug, changeId: entry.id, catalogVersion: this.editorPublish(x.s) });
  }
  for (const l of links) {
    const hq = String(l.hqName == null ? '' : l.hqName).trim();
    H.links = H.links.filter(k => !(k.slug === l.slug && k.hqName.toLowerCase() === hq.toLowerCase()));
    if (l.vendor) H.links.push({ slug: l.slug, hqName: hq, vendor: l.vendor });
  }
  return ok({ by, changes: out, libraries: libsOut, lto: ltoOut });
};

// ---- The warehouse, Happy Supply W1 (schema_v13.sql) -----------------------
// Locations, suppliers, products, each product's cases per location (never
// below 0), every move kept, vendor orders in (PO-0001), transfers (TR-0001,
// in transit until received), counts (a difference needs a reason). Each
// write works on a copy and keeps it only when it took, as the SQL's
// transaction does; the refusals say what the SQL says. The calls take an HQ
// token with the warehouse role (SESSION_EXPIRED / NOT_ALLOWED otherwise).
const WH_FNS = { mog_wh_data: 1, mog_wh_history: 1, mog_wh_save: 1, mog_wh_po_save: 1, mog_wh_po_cancel: 1,
                 mog_wh_po_receive: 1, mog_wh_transfer_send: 1, mog_wh_transfer_receive: 1, mog_wh_count: 1 };
const whRej = m => new Error('REJECTED: ' + m);
const whRound = (v, d) => { const f = Math.pow(10, d); const r = Math.round(Math.abs(v) * f) / f; return v < 0 ? -r : r; };
const whIsObj = v => !!v && typeof v === 'object' && !Array.isArray(v);
function whNum(v, what) { if (typeof v !== 'number' || !isFinite(v)) throw whRej(what + ' needs a number'); return v; }
function whCases(v, what, zero) {
  const n = whRound(whNum(v, what), 2);
  if (n < 0 || (n === 0 && !zero)) throw whRej(what + ' needs ' + (zero ? '0 or more' : 'more than 0') + ' cases');
  if (n > 100000) throw whRej(what + ' is more than 100,000 cases');
  return n;
}
function whMoney(v, what) {
  const n = whRound(whNum(v, what), 2);
  if (n < 0 || n > 1000000) throw whRej(what + ' needs an amount from $0 to $1,000,000');
  return n;
}
function whId(v, what) { if (typeof v !== 'number' || !Number.isInteger(v)) throw whRej(what + ' is missing'); return v; }
function whName(v, what, max) {
  const s = typeof v === 'string' ? v.trim() : '';
  if (!s) throw whRej(what + ' needs a name');
  if (s.length > max) throw whRej('"' + s.slice(0, 40) + '" is longer than ' + max + ' characters');
  return s;
}
function whText(v, what, max) {
  const s = typeof v === 'string' ? v.trim() : '';
  if (s.length > max) throw whRej(what + ' is longer than ' + max + ' characters');
  return s;
}
function whBool(v, what, dflt) {
  if (v == null) return dflt;
  if (typeof v !== 'boolean') throw whRej(what + ' is yes or no');
  return v;
}
function whLines(v, what, max) {
  if (!Array.isArray(v) || !v.length) throw whRej(what + ' needs at least one product');
  if (v.length > max) throw whRej(what + ' has more than ' + max + ' lines');
  if (v.some(x => !whIsObj(x))) throw whRej(what + ' has a line that isn\'t a line');
  return v;
}
const whCs = n => String(Number(n)) + (Number(n) === 1 ? ' case' : ' cases');
// mog.wh_avg_after
function whAvgAfter(owned, avg, cases, cost) {
  if (cases <= 0) return avg;
  if (owned <= 0) return whRound(cost, 4);
  return whRound((owned * avg + cases * cost) / (owned + cases), 4);
}
function whInTransit(W, product) {
  let n = 0;
  for (const t of W.transfers) if (t.status === 'in_transit') for (const l of t.lines) if (l.productId === product) n += l.cases;
  return whRound(n, 2);
}
function whOwned(W, product) {
  let n = 0;
  for (const k of Object.keys(W.stock)) if (Number(k.split('|')[0]) === product) n += W.stock[k];
  return whRound(n + whInTransit(W, product), 2);
}
function whProduct(W, id) { return W.products.find(p => p.id === id) || null; }
function whLocation(W, id) { return W.locations.find(l => l.id === id) || null; }
function whLockProducts(W, ids) {
  if (ids.some(id => !whProduct(W, id))) throw whRej('a product here isn\'t in the warehouse any more');
}
// mog.wh_move
function whMove(W, by, product, location, cases, kind, ref, cost, reason, now) {
  const key = product + '|' + location;
  const have = W.stock[key] || 0;
  const after = whRound(have + cases, 2);
  const p = whProduct(W, product);
  if (after < 0) throw whRej(whLocation(W, location).name + ' has ' + whCs(have) + ' of ' + p.name);
  if (kind === 'received') p.avgCost = whAvgAfter(whOwned(W, product), p.avgCost, cases, cost);
  W.stock[key] = after;
  W.moves.push({ id: ++W.seq.move, at: now, by, productId: product, locationId: location, cases, kind, ref: ref || null,
                 unitCost: cost == null ? null : cost, reason: reason || null, casesAfter: after, avgAfter: p.avgCost });
}
function whNextNumber(list, prefix) {
  const n = list.reduce((m, x) => Math.max(m, Number(x.number.slice(3))), 0) + 1;
  const s = String(n);
  return prefix + '-' + (s.length >= 4 ? s : ('000' + s).slice(-4));
}
function whPoJson(W, p) {
  return { id: p.id, number: p.number, supplierId: p.supplierId, supplier: W.suppliers.find(s => s.id === p.supplierId).name,
    locationId: p.locationId, location: whLocation(W, p.locationId).name, status: p.status, note: p.note,
    createdAt: p.createdAt, createdBy: p.createdBy, closedAt: p.closedAt, closedBy: p.closedBy, version: p.version,
    lines: p.lines.map(l => { const pr = whProduct(W, l.productId);
      return { ord: l.ord, productId: l.productId, product: pr.name, pack: pr.pack, cases: l.cases, cost: l.cost,
               casesReceived: l.casesReceived, costReceived: l.costReceived }; }) };
}
function whTransferJson(W, t) {
  return { id: t.id, number: t.number, fromId: t.fromId, from: whLocation(W, t.fromId).name, toId: t.toId, to: whLocation(W, t.toId).name,
    status: t.status, note: t.note, sentAt: t.sentAt, sentBy: t.sentBy, closedAt: t.closedAt, closedBy: t.closedBy,
    lines: t.lines.map(l => ({ ord: l.ord, productId: l.productId, product: whProduct(W, l.productId).name, cases: l.cases })) };
}
const byLower = f => (a, b) => (f(a).toLowerCase() < f(b).toLowerCase() ? -1 : f(a).toLowerCase() > f(b).toLowerCase() ? 1 : 0);
FakeSupabase.prototype.whState = function () {
  const H = this.hqState();
  if (!H.wh) H.wh = { locations: [], suppliers: [], products: [], stock: {}, moves: [], pos: [], transfers: [],
                      settings: { markupPct: 0, deliveryFee: 0, version: 1, updatedAt: null, updatedBy: null },
                      seq: { loc: 0, sup: 0, prod: 0, move: 0, po: 0, tr: 0 } };
  return H.wh;
};
// mog.wh_state
FakeSupabase.prototype.whData = function (name) {
  const W = this.whState(), H = this.hqState();
  const lastClosed = (list, open) => list.filter(x => x.status === open).concat(list.filter(x => x.status !== open).sort((a, b) => b.id - a.id).slice(0, 30))
    .sort((a, b) => b.id - a.id);
  return {
    name, roles: clone(H.users.get(name).roles), settings: clone(W.settings),
    locations: W.locations.slice().sort((a, b) => (a.ord - b.ord) || byLower(x => x.name)(a, b)).map(l => clone(l)),
    suppliers: W.suppliers.slice().sort(byLower(x => x.name)).map(s => clone(s)),
    products: W.products.slice().sort(byLower(x => x.name)).map(p => {
      const stock = {};
      for (const k of Object.keys(W.stock)) if (Number(k.split('|')[0]) === p.id && W.stock[k] !== 0) stock[k.split('|')[1]] = W.stock[k];
      const last = W.moves.filter(m => m.productId === p.id && m.kind === 'received').pop();
      return Object.assign(clone(p), { stock, inTransit: whInTransit(W, p.id), lastReceipt: last ? { ref: last.ref, at: last.at } : null });
    }),
    pos: lastClosed(W.pos, 'ordered').map(p => whPoJson(W, p)),
    transfers: lastClosed(W.transfers, 'in_transit').map(t => whTransferJson(W, t)),
    stores: Array.from(this.stores.entries()).map(([slug, s]) => ({ slug, location: s.profile.location || null, concept: s.profile.concept || '',
      side: s.side != null ? s.side : sideFromLocation(s.profile.location), isTest: !!s.isTest }))
      .sort((a, b) => (a.concept < b.concept ? -1 : a.concept > b.concept ? 1 : 0) || (a.isTest - b.isTest) ||
                      String(a.location).localeCompare(String(b.location)) || (a.slug < b.slug ? -1 : 1))
  };
};

// mog.wh_do_save
function whDoSave(W, by, kind, row, now, slugs) {
  if (!whIsObj(row)) throw whRej('nothing to save');
  const id = row.id == null ? null : whId(row.id, 'The id');
  if (kind === 'product') {
    const name = whName(row.name, 'The product', 120);
    const pack = whText(row.pack, 'The pack', 60);
    const par = whCases(row.par, 'The par', true);
    const fee = whMoney(row.handlingFee, 'The handling fee');
    const active = whBool(row.active, 'Active', true);
    if (row.stores != null && !Array.isArray(row.stores)) throw whRej('the stores are a list');
    const stores = Array.from(new Set((row.stores || []).map(x => (typeof x === 'string' ? x : JSON.stringify(x))))).sort();
    const unknown = stores.find(x => !slugs.has(x));
    if (unknown !== undefined) throw whRej('no store called ' + unknown);
    if (W.products.some(p => p.name.toLowerCase() === name.toLowerCase() && p.id !== id)) throw whRej('there\'s already a product called "' + name + '"');
    if (id == null) {
      const p = { id: ++W.seq.prod, name, pack, par, avgCost: 0, handlingFee: fee, stores, active, version: 1, updatedAt: now, updatedBy: by };
      W.products.push(p);
      return { kind: 'product', id: p.id, name };
    }
    const p = whProduct(W, id);
    if (!p) throw whRej('that product isn\'t in the warehouse any more');
    if (p.version !== whNum(row.version, 'The version')) throw new Error('CONFLICT: ' + name + ' was changed since you opened it (by ' + (p.updatedBy || 'someone') + ')');
    Object.assign(p, { name, pack, par, handlingFee: fee, stores, active, version: p.version + 1, updatedAt: now, updatedBy: by });
    return { kind: 'product', id, name };
  }
  if (kind === 'location' || kind === 'supplier') {
    const name = whName(row.name, kind === 'location' ? 'The location' : 'The supplier', 60);
    const active = whBool(row.active, 'Active', true);
    const list = kind === 'location' ? W.locations : W.suppliers;
    if (list.some(x => x.name.toLowerCase() === name.toLowerCase() && x.id !== id)) throw whRej('there\'s already a ' + kind + ' called "' + name + '"');
    if (kind === 'location') {
      const ord = row.ord == null ? null : whRound(whNum(row.ord, 'The order'), 0);
      if (id == null) {
        const l = { id: ++W.seq.loc, name, ord: ord == null ? W.locations.reduce((m, x) => Math.max(m, x.ord), 0) + 10 : ord, active };
        W.locations.push(l);
        return { kind, id: l.id, name };
      }
      const l = whLocation(W, id);
      if (!l) throw whRej('that location isn\'t in the warehouse any more');
      if (!active) {
        let held = 0;
        for (const k of Object.keys(W.stock)) if (Number(k.split('|')[1]) === id) held += W.stock[k];
        if (held > 0) throw whRej(name + ' still holds ' + whCs(whRound(held, 2)) + ': move it or count it to 0 first');
      }
      Object.assign(l, { name, ord: ord == null ? l.ord : ord, active });
      return { kind, id, name };
    }
    if (id == null) { const s = { id: ++W.seq.sup, name, active }; W.suppliers.push(s); return { kind, id: s.id, name }; }
    const s = W.suppliers.find(x => x.id === id);
    if (!s) throw whRej('that supplier isn\'t in the warehouse any more');
    Object.assign(s, { name, active });
    return { kind, id, name };
  }
  if (kind === 'settings') {
    const pct = whRound(whNum(row.markupPct, 'The markup'), 2);
    if (pct < 0 || pct > 100) throw whRej('the markup is from 0 to 100%');
    const fee = whMoney(row.deliveryFee, 'The delivery fee');
    if (W.settings.version !== whNum(row.version, 'The version')) throw new Error('CONFLICT: the settings were changed since you opened them (by ' + (W.settings.updatedBy || 'someone') + ')');
    Object.assign(W.settings, { markupPct: pct, deliveryFee: fee, version: W.settings.version + 1, updatedAt: now, updatedBy: by });
    return { kind: 'settings' };
  }
  throw whRej('nothing called ' + (kind == null ? '(none)' : kind) + ' to save');
}
// mog.wh_do_po_save
function whDoPoSave(W, by, po, now) {
  if (!whIsObj(po)) throw whRej('nothing to save');
  let id = po.id == null ? null : whId(po.id, 'The order');
  const supplierId = whId(po.supplierId, 'The supplier');
  const locationId = whId(po.locationId, 'Where it goes');
  const note = whText(po.note, 'The note', 300);
  const lines = whLines(po.lines, 'A vendor order', 100);
  if (!W.suppliers.some(s => s.id === supplierId && s.active)) throw whRej('pick a supplier from the list');
  if (!W.locations.some(l => l.id === locationId && l.active)) throw whRej('pick where it goes from the list');
  let rec;
  if (id == null) {
    rec = { id: ++W.seq.po, number: whNextNumber(W.pos, 'PO'), supplierId, locationId, status: 'ordered', note,
            createdAt: now, createdBy: by, closedAt: null, closedBy: null, version: 1, lines: [] };
    W.pos.push(rec);
    id = rec.id;
  } else {
    rec = W.pos.find(p => p.id === id);
    if (!rec) throw whRej('that order isn\'t there any more');
    if (rec.status !== 'ordered') throw whRej(rec.number + ' was already ' + rec.status);
    if (rec.version !== whNum(po.version, 'The version')) throw new Error('CONFLICT: ' + rec.number + ' was changed since you opened it');
    Object.assign(rec, { supplierId, locationId, note, version: rec.version + 1, lines: [] });
  }
  const seen = new Set();
  lines.forEach((x, i) => {
    const n = i + 1;
    const product = whId(x.productId, 'Line ' + n + '\'s product');
    const p = W.products.find(q => q.id === product && q.active);
    if (!p) throw whRej('line ' + n + ' needs a product from the list');
    if (seen.has(product)) throw whRej(p.name + ' is on the order twice');
    seen.add(product);
    rec.lines.push({ ord: n, productId: product, cases: whCases(x.cases, p.name, false),
                     cost: x.cost == null ? null : whMoney(x.cost, 'The cost of ' + p.name), casesReceived: null, costReceived: null });
  });
  return { kind: 'po', id, number: rec.number };
}
function whDoPoCancel(W, by, id, version, now) {
  const rec = W.pos.find(p => p.id === id);
  if (!rec) throw whRej('that order isn\'t there any more');
  if (rec.status !== 'ordered') throw whRej(rec.number + ' was already ' + rec.status);
  if (rec.version !== version) throw new Error('CONFLICT: ' + rec.number + ' was changed since you opened it');
  Object.assign(rec, { status: 'cancelled', closedAt: now, closedBy: by, version: rec.version + 1 });
  return { kind: 'po', id, number: rec.number };
}
function whDoPoReceive(W, by, r, now) {
  if (!whIsObj(r)) throw whRej('nothing to receive');
  const id = whId(r.id, 'The order');
  const lines = whLines(r.lines, 'What came in', 100);
  const rec = W.pos.find(p => p.id === id);
  if (!rec) throw whRej('that order isn\'t there any more');
  if (rec.status !== 'ordered') throw whRej(rec.number + ' was already ' + rec.status);
  if (rec.version !== whNum(r.version, 'The version')) throw new Error('CONFLICT: ' + rec.number + ' was changed since you opened it');
  whLockProducts(W, rec.lines.map(l => l.productId));
  let got = 0;
  for (const ln of rec.lines.slice().sort((a, b) => a.ord - b.ord)) {
    const name = whProduct(W, ln.productId).name;
    const x = lines.find(y => typeof y.ord === 'number' && y.ord === ln.ord);
    if (!x) throw whRej('say what came in of ' + name);
    const cases = whCases(x.cases, name, true);
    let cost = null;
    if (cases > 0) {
      cost = whMoney(x.cost, 'The cost of ' + name);
      whMove(W, by, ln.productId, rec.locationId, cases, 'received', rec.number, cost, null, now);
      got++;
    }
    ln.casesReceived = cases; ln.costReceived = cost;
  }
  if (!got) throw whRej('nothing came in on ' + rec.number + ': cancel it instead');
  Object.assign(rec, { status: 'received', closedAt: now, closedBy: by, version: rec.version + 1 });
  return { kind: 'po', id, number: rec.number, lines: got };
}
function whDoTransferSend(W, by, t, now) {
  if (!whIsObj(t)) throw whRej('nothing to send');
  const fromId = whId(t.fromId, 'Where it comes from');
  const toId = whId(t.toId, 'Where it goes');
  const note = whText(t.note, 'The note', 300);
  const lines = whLines(t.lines, 'A transfer', 100);
  if (fromId === toId) throw whRej('a transfer goes to another location');
  if (!W.locations.some(l => l.id === fromId && l.active) || !W.locations.some(l => l.id === toId && l.active)) throw whRej('pick both locations from the list');
  whLockProducts(W, lines.map(y => whId(y.productId, 'A line\'s product')));
  const rec = { id: ++W.seq.tr, number: whNextNumber(W.transfers, 'TR'), fromId, toId, status: 'in_transit', note,
                sentAt: now, sentBy: by, closedAt: null, closedBy: null, lines: [] };
  W.transfers.push(rec);
  const seen = new Set();
  lines.forEach((x, i) => {
    const product = whId(x.productId, 'Line ' + (i + 1) + '\'s product');
    const name = whProduct(W, product).name;
    if (seen.has(product)) throw whRej(name + ' is on the transfer twice');
    seen.add(product);
    const cases = whCases(x.cases, name, false);
    rec.lines.push({ ord: i + 1, productId: product, cases });
    whMove(W, by, product, fromId, -cases, 'transfer_out', rec.number, null, null, now);
  });
  return { kind: 'transfer', id: rec.id, number: rec.number };
}
function whDoTransferReceive(W, by, id, now) {
  const rec = W.transfers.find(t => t.id === id);
  if (!rec) throw whRej('that transfer isn\'t there any more');
  if (rec.status !== 'in_transit') throw whRej(rec.number + ' was already received');
  whLockProducts(W, rec.lines.map(l => l.productId));
  for (const l of rec.lines) whMove(W, by, l.productId, rec.toId, l.cases, 'transfer_in', rec.number, null, null, now);
  Object.assign(rec, { status: 'received', closedAt: now, closedBy: by });
  return { kind: 'transfer', id, number: rec.number };
}
function whDoCount(W, by, c, now) {
  if (!whIsObj(c)) throw whRej('nothing to count');
  const locationId = whId(c.locationId, 'The location');
  const loc = whLocation(W, locationId);
  if (!loc) throw whRej('pick a location from the list');
  const lines = whLines(c.lines, 'A count', 500);
  whLockProducts(W, lines.map(y => whId(y.productId, 'A line\'s product')));
  const seen = new Set();
  let changed = 0;
  lines.forEach((x, i) => {
    const product = whId(x.productId, 'Line ' + (i + 1) + '\'s product');
    const name = whProduct(W, product).name;
    if (seen.has(product)) throw whRej(name + ' is in the count twice');
    seen.add(product);
    const cases = whCases(x.cases, name, true);
    const have = W.stock[product + '|' + locationId] || 0;
    if (cases === have) return;
    const reason = whText(x.reason, 'The reason for ' + name, 200);
    if (!reason) throw whRej(name + ' differs from the record (' + Number(cases) + ' counted, ' + Number(have) + ' on record): say why');
    whMove(W, by, product, locationId, whRound(cases - have, 2), 'count', null, null, reason, now);
    changed++;
  });
  return { kind: 'count', location: loc.name, changed };
}

FakeSupabase.prototype.handleWh = function (fn, p) {
  const H = this.hqState();
  const sess = H.sessions.get(p.p_token);
  if (!sess || sess.expires <= this.nowMs || !H.users.has(sess.name)) return { ok: false, error: 'SESSION_EXPIRED' };
  const name = sess.name;
  if (H.users.get(name).roles.indexOf('warehouse') < 0) return { ok: false, error: 'NOT_ALLOWED' };
  const W = this.whState();
  const now = new Date(this.nowMs).toISOString();
  if (fn === 'mog_wh_data') return { ok: true, data: this.whData(name) };
  if (fn === 'mog_wh_history') {
    const moves = W.moves.filter(m => (p.p_product_id == null || m.productId === p.p_product_id) &&
                                      (p.p_location_id == null || m.locationId === p.p_location_id) &&
                                      (p.p_before_id == null || m.id < p.p_before_id))
      .sort((a, b) => b.id - a.id).slice(0, 200)
      .map(m => Object.assign(clone(m), { product: whProduct(W, m.productId).name, location: whLocation(W, m.locationId).name }));
    return { ok: true, data: { moves } };
  }
  const next = clone(W);
  let done;
  try {
    if (fn === 'mog_wh_save') done = whDoSave(next, name, p.p_kind, p.p_row, now, new Set(this.stores.keys()));
    if (fn === 'mog_wh_po_save') done = whDoPoSave(next, name, p.p_po, now);
    if (fn === 'mog_wh_po_cancel') done = whDoPoCancel(next, name, p.p_id, p.p_version, now);
    if (fn === 'mog_wh_po_receive') done = whDoPoReceive(next, name, p.p_receipt, now);
    if (fn === 'mog_wh_transfer_send') done = whDoTransferSend(next, name, p.p_transfer, now);
    if (fn === 'mog_wh_transfer_receive') done = whDoTransferReceive(next, name, p.p_id, now);
    if (fn === 'mog_wh_count') done = whDoCount(next, name, p.p_count, now);
  } catch (e) {
    const m = String(e.message);
    if (m.indexOf('CONFLICT: ') === 0) return { ok: false, error: 'CONFLICT', detail: m.slice(10) };
    return { ok: false, error: m.indexOf('REJECTED: ') === 0 ? m : 'REJECTED: ' + m };
  }
  H.wh = next;
  return { ok: true, data: Object.assign(this.whData(name), { done }) };
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
  // schema_v9.sql: the order log (T1), recipients (T2), the Health status (T4).
  if (fn === 'mog_history') {
    const from = p.p_from || null, to = p.p_to || null;
    const utc = ms => new Date(ms).toISOString().replace('T', ' ').slice(0, 16);
    const inRange = s.log.map((r, i) => [r, i])
      .filter(([r]) => (!from || r.cycleDate >= from) && (!to || r.cycleDate <= to))
      .sort((a, b) => (a[0].cycleDate < b[0].cycleDate ? -1 : a[0].cycleDate > b[0].cycleDate ? 1 : 0) || (a[0].seq - b[0].seq) || (a[1] - b[1]))
      .map(x => x[0]);
    const kept = inRange.slice(-50000);
    return ok({
      today: this.today(), timeZone: 'America/New_York', abbr: s.profile.abbr || null,
      vendors: Array.from(new Set(s.log.map(r => r.vendor).filter(Boolean))),
      rows: kept.map(r => ({ date: r.cycleDate, at: utc(r.loggedAt ? Date.parse(r.loggedAt) : this.nowMs), vendor: r.vendor,
                             id: r.id, name: r.name, pack: r.pack, area: r.area, onHandPrev: r.onHandPrev, qty: r.qty })),
      truncated: inRange.length > 50000 });
  }
  if (fn === 'mog_recipients_get') return ok({ recipients: clone(s.recipients || []) });
  if (fn === 'mog_recipients_save') {
    const chk = recipientsCheck(s.recipients || [], p.p_recipients, !!p.p_gm_edit);
    if (!chk.ok) return chk;
    s.recipients = chk.list;
    s.recipientsSeeded = true;
    return ok({ recipients: clone(chk.list) });
  }
  if (fn === 'mog_editor_status') {
    const last = s.log.reduce((m, r) => (m === null || r.cycleDate > m ? r.cycleDate : m), null);
    return ok({ phoneDirect: !!s.phoneDirect, timeZone: 'America/New_York',
                localNow: new Date(this.nowMs).toISOString().replace('T', ' ').slice(0, 16),
                cycleDate: s.state ? s.state.cycleDate : null, cycleUpdatedAt: null,
                lockedForMs: s.lockedUntil > this.nowMs ? s.lockedUntil - this.nowMs : 0,
                failCount: s.failCount, lastOrderDate: last });
  }
  if (fn === 'mog_editor_clear_lockout') {
    s.failCount = 0; s.lockedUntil = 0;
    return ok({ cleared: true });
  }
  if (fn === 'mog_editor_review') {
    if (p.p_status !== 'applied' && p.p_status !== 'dismissed') return err('Status must be applied or dismissed');
    const e = (s.quickEdits || []).find(x => x.qid === Number(p.p_id) && x.review === 'open');
    if (!e) return err('Not waiting for review');
    e.review = p.p_status;
    return ok({ id: e.qid, review: e.review });
  }

  const tryApply = ops => {
    try { s.tables = editorApplyOps(s.tables, ops, new Set(this.hqState().ltos.keys())); return null; } catch (e) {
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
  const inv = c.ops.filter(op => !('shift' in op)).reverse()
    .map(op => ('rename' in op ? { rename: op.rename, from: op.to, to: op.from } : { t: op.t, before: op.after, after: op.before }));
  const bad = tryApply(inv);
  if (bad) {
    if (bad.error === 'CONFLICT') {
      const rowOp = op => !('shift' in op) && !('rename' in op);
      const idOf = op => op.t + ' ' + editorIdent(op.t, op.after || op.before);
      const mine = new Set(c.ops.filter(rowOp).map(idOf));
      const later = s.changeLog.filter(l => l.id > c.id && !l.undoneBy && l.ops.some(op => rowOp(op) && mine.has(idOf(op)))).pop();
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
  { file: 'apps-script/Editor.gs', consts: ['CATALOG_WRITE_ACTIONS_'], fns: ['webedit_call'] }
];
function compileStep4(srcOf) {
  return F.compile(srcOf || (f => F.source(null, f)), STEP4_PLAN,
    ['apps-script/OrderMath.gs', 'apps-script/Sync.gs', 'apps-script/DbApi.gs']);
}

module.exports = { FakeSupabase, fakeScriptApp, fakeContentService, toOnHand, compileStep4, FAKE_GRANT_URL,
  checkCatalogTables, catalogFromTables, recipientsCheck, whAvgAfter };
