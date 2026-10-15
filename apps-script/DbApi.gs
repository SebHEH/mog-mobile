/***********************
 * DB API — /exec's count path for a store that counts in Supabase
 *
 * When a store has switched (Sync.gs: Switch counting to Supabase), doPost
 * sends the count-path actions here instead of to the Sheet handlers. Each one
 * reads or writes Supabase and builds its answer with the same OrderMath.gs
 * builders the PWA runs, returning EXACTLY the shape the Sheet handler
 * returns. A phone on an older app version keeps working, sees the same counts
 * as a phone on the new one, and nothing touches the Sheet.
 *
 * Design record: docs/MOG_SupabaseMigration.md (section 4, D9).
 * Not here, because they already branch on their own: getRecapData /
 * emailRecap (buildRecapSections_ in Recap.gs) and the recap email
 * (buildRecapFromLog_). History and recipients stay on the Sheet handlers
 * until step 6.
 ***********************/

// The actions this file answers for a switched store. doPost checks this
// before reading any config, so other actions pay nothing.
const DB_API_ACTIONS = {
  getResetStatus: true, commitReset: true, getDashboard: true, getVendorItems: true,
  getVendorItemsBulk: true, saveOnHand: true, setEmergencyOverride: true, setVendorOverride: true
};
const DB_BULK_VENDOR_LIMIT = 30;   // same ceiling as api_getVendorItemsBulk_

// Returns the action's data, or undefined when it isn't a count-path action.
function dbApiDispatch_(action, payload) {
  if (!DB_API_ACTIONS[action]) return undefined;
  payload = payload || {};
  switch (action) {
    case 'getResetStatus': {
      const st = supabaseSnapshot_().state;
      return { today: st.today, lastReset: st.cycleDate, isStale: st.isStale };
    }
    case 'commitReset':
      return closeCycleInDb_();
    case 'getDashboard':
      return dashboardFromSnapshot_(dbInputs_());
    case 'getVendorItems': {
      const inputs = dbInputs_();
      return vendorItemsFromSnapshot_(inputs, dbVendor_(inputs, payload.vendor));
    }
    case 'getVendorItemsBulk':
      return dbVendorItemsBulk_(payload);
    case 'saveOnHand':
      return dbSaveOnHand_(payload);
    case 'setEmergencyOverride':
      return dbSetEmergencyOverride_(payload);
    case 'setVendorOverride':
      return dbSetVendorOverride_(payload);
  }
  return undefined;
}

function dbInputs_() {
  return orderInputsFromSnapshot_(supabaseSnapshot_());
}

// normalizeVendorOrThrow_'s rules and messages, against the catalog's vendor
// list instead of the Sheet.
function dbVendor_(inputs, raw) {
  const input = String(raw || '').trim();
  if (!input) throw new Error('Vendor is required.');
  const key = input.toLowerCase();
  for (const v of inputs.vendorList) if (v.toLowerCase() === key) return v;
  throw new Error('Vendor "' + input + '" is not in SETUP vendor table (column R).');
}

// api_getVendorItemsBulk_'s contract: exact-match names only, a ceiling on how
// many, and per-vendor failures reported rather than fatal.
function dbVendorItemsBulk_(payload) {
  const inputs = dbInputs_();
  const known  = new Set(inputs.vendorList);
  let list = ((payload && payload.vendors) || []).filter(function (v) { return known.has(v); });
  const skipped = list.slice(DB_BULK_VENDOR_LIMIT);
  list = list.slice(0, DB_BULK_VENDOR_LIMIT);
  const vendors = {};
  const failed  = [];
  for (const v of list) {
    try { vendors[v] = vendorItemsFromSnapshot_(inputs, v); }
    catch (e) { failed.push(v); }
  }
  return { vendors: vendors, failed: failed.concat(skipped) };
}

// One write, no snapshot read: the save is the hot path. The vendor name is
// taken as sent (the app sends the dashboard's canonical name); the counts
// land in Supabase's CURRENT cycle.
function dbSaveOnHand_(payload) {
  const vendor = String(payload.vendor || '').trim();
  if (!vendor) throw new Error('Vendor is required.');
  const items = Array.isArray(payload.items) ? payload.items : [];
  if (!items.length) return { saved: 0, vendor: vendor };
  const rows = items.map(function (it) {
    const v = (it.onHand === null || it.onHand === '' || it.onHand === undefined) ? null : Number(it.onHand);
    return { vendor: vendor, id: String(it.id || '').trim(), onHand: (v === null || isNaN(v)) ? null : v };
  });
  const data = supabaseSync_('mog_sync_put_counts', { p_cycle_date: null, p_rows: rows });
  return { saved: data.saved, vendor: vendor };
}

// api_setEmergencyOverride_'s contract: the flag plus the fresh dashboard,
// which comes back with the write (one round trip).
function dbSetEmergencyOverride_(payload) {
  const on = !!(payload && payload.on);
  const snap = supabaseSync_('mog_sync_set_override', { p_on: on });
  _SB_SNAPSHOT_ = snap;
  let dashboard = null;
  try { dashboard = dashboardFromSnapshot_(orderInputsFromSnapshot_(snap)); } catch (e) { dashboard = null; }
  return { emergencyOverride: on, dashboard: dashboard };
}

// api_setVendorOverride_'s contract: validate, record the pick (0 clears),
// return the vendor's fresh items with the write.
function dbSetVendorOverride_(payload) {
  const vendor = dbVendor_(dbInputs_(), payload.vendor);
  const mult = Math.floor(Number(payload && payload.mult));
  if (isNaN(mult) || mult < 0 || mult > 7) {
    throw new Error('Invalid override multiplier (expected 0-7): ' + (payload && payload.mult));
  }
  const snap = supabaseSync_('mog_sync_set_vendor_pick', { p_vendor: vendor, p_mult: mult });
  _SB_SNAPSHOT_ = snap;
  let itemsPayload = null;
  try { itemsPayload = vendorItemsFromSnapshot_(orderInputsFromSnapshot_(snap), vendor); } catch (e) { itemsPayload = null; }
  return { vendor: vendor, overrideMult: mult, itemsPayload: itemsPayload };
}
