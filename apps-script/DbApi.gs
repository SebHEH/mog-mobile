/***********************
 * DB API — /exec's count path for a store that counts in Supabase
 *
 * When a store has switched (Sync.gs: Move this store to Supabase), doPost
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

// Returns the action's data, or undefined when it isn't a count-path action.
// The rules and shapes are OrderMath.gs's, shared with the phone's direct mode.
function dbApiDispatch_(action, payload) {
  if (!DB_API_ACTIONS[action]) return undefined;
  payload = payload || {};
  switch (action) {
    case 'getResetStatus':
      return resetStatusFromSnapshot_(supabaseSnapshot_());
    case 'commitReset':
      return closeCycleInDb_();
    case 'getDashboard':
      return dashboardFromSnapshot_(dbInputs_());
    case 'getVendorItems': {
      const inputs = dbInputs_();
      return vendorItemsFromSnapshot_(inputs, vendorNameFromInputs_(inputs, payload.vendor));
    }
    case 'getVendorItemsBulk':
      return vendorItemsBulkFromInputs_(dbInputs_(), payload);
    case 'saveOnHand':
      return dbSaveOnHand_(payload);
    case 'setEmergencyOverride': {
      const on = !!payload.on;
      _SB_SNAPSHOT_ = supabaseSync_('mog_sync_set_override', { p_on: on });
      return overrideAnswerFromSnapshot_(_SB_SNAPSHOT_, on);
    }
    case 'setVendorOverride': {
      const pick = vendorPickFromPayload_(dbInputs_(), payload);
      _SB_SNAPSHOT_ = supabaseSync_('mog_sync_set_vendor_pick', { p_vendor: pick.vendor, p_mult: pick.mult });
      return vendorPickAnswerFromSnapshot_(_SB_SNAPSHOT_, pick.vendor, pick.mult);
    }
  }
  return undefined;
}

function dbInputs_() {
  return orderInputsFromSnapshot_(supabaseSnapshot_());
}

// One write, no snapshot read: the save is the hot path. The counts land in
// Supabase's CURRENT cycle (the phone's direct mode sends its own cycle date).
function dbSaveOnHand_(payload) {
  const save = countRowsFromSave_(payload);
  if (!save.rows.length) return { saved: 0, vendor: save.vendor };
  const data = supabaseSync_('mog_sync_put_counts', { p_cycle_date: null, p_rows: save.rows });
  return { saved: data.saved, vendor: save.vendor };
}
