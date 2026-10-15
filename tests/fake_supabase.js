'use strict';
// An in-memory stand-in for the mog_sync_* functions in supabase/schema.sql +
// schema_v2.sql, behind a fake UrlFetchApp, so the Apps Script side of the
// sync can run under Node. It mirrors the SQL's RULES (sync-key check, the
// one-transaction cycle close, last-duplicate-wins upserts, what counts as an
// on-hand number); the SQL itself is proven by supabase/tests/smoke*.sql in
// Postgres. If a rule changes in the SQL, change it here in the same commit.

const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const clone = v => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));

// mog.to_onhand: numbers pass, numeric strings parse, anything else is a cleared count.
function toOnHand(v) {
  if (typeof v === 'number') return v;
  if (typeof v === 'string' && /^-?([0-9]+(\.[0-9]*)?|\.[0-9]+)$/.test(v.trim())) return Number(v.trim());
  return null;
}

class FakeSupabase {
  constructor(nowMs) {
    this.nowMs = nowMs;
    this.stores = new Map();
    this.calls = [];     // fn names, in order
    this.down = false;   // true: every request fails like a network error
  }

  // UTC date of "now": the fixtures' dates are UTC and so is the fake formatDate.
  today() { return new Date(this.nowMs).toISOString().slice(0, 10); }

  provision(slug) {
    const key = (slug + 'k'.repeat(64)).slice(0, 64).replace(/[^0-9a-f]/g, 'a');
    this.stores.set(slug, { key, pins: {}, catalog: null, version: null, state: null, counts: new Map(), log: [] });
    return key;
  }

  urlFetchApp() {
    const self = this;
    return {
      fetch(url, opts) {
        if (self.down) throw new Error('Address unavailable: ' + url);
        const fn = url.split('/rest/v1/rpc/')[1];
        const body = self.handle(fn, JSON.parse(opts.payload));
        const text = JSON.stringify(body);
        return { getResponseCode: () => 200, getContentText: () => text };
      }
    };
  }

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

  snapshot(slug, s, have) {
    if (!s.catalog || !s.state) return { ok: false, error: 'STORE_NOT_SYNCED' };
    const st = s.state;
    const today = this.today();
    const counts = Array.from(this.countsFor(s, st.cycleDate).values())
      .sort((a, b) => (a.vendor + '\u0001' + a.id < b.vendor + '\u0001' + b.id ? -1 : 1))
      .map(c => ({ vendor: c.vendor, id: c.id, onHand: c.onHand }));
    return { ok: true, data: {
      slug, authType: 'sync', isManagerMode: false, catalogVersion: s.version,
      catalog: (have != null && have === s.version) ? null : clone(s.catalog),
      state: { cycleDate: st.cycleDate, dayOfWeek: st.dayOfWeek, today, isStale: st.cycleDate < today,
               emergencyOverride: st.emergencyOverride, vendorPicks: clone(st.vendorPicks),
               todaysLog: clone(st.todaysLog), updatedAt: 'fake' },
      counts, serverTime: 'fake' } };
  }

  handle(fn, p) {
    this.calls.push(fn);
    const s = this.stores.get(p.p_slug);
    const ok = data => ({ ok: true, data });
    const err = error => ({ ok: false, error });
    if (!s || s.key !== p.p_key) return err('BAD_SYNC_KEY');

    switch (fn) {
      case 'mog_sync_get_cycle':
        if (!s.state) return err('STORE_NOT_SYNCED');
        return ok({ state: clone(s.state), counts: Array.from(this.countsFor(s, s.state.cycleDate).values()) });

      case 'mog_sync_get_snapshot':
        return this.snapshot(p.p_slug, s, p.p_have_version);

      case 'mog_sync_push_catalog':
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
}

// A fake ScriptApp that records triggers.
function fakeScriptApp() {
  const triggers = [];
  const api = {
    triggers,
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

module.exports = { FakeSupabase, fakeScriptApp, fakeContentService, toOnHand };
