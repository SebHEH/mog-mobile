/***********************
 * SUPABASE SYNC — the Sheet's side of the count-path migration
 *
 * Design record: docs/MOG_SupabaseMigration.md. So far everything here only
 * READS; nothing talks to Supabase yet.
 *   - buildCatalogPayload_(): the catalog block (design record, section 6)
 *     that Apps Script will push to Supabase after every edit.
 *   - test_supabaseParity(): editor-run. Feeds that catalog, plus this
 *     cycle's counts as the database would hold them, through the PWA's code
 *     path (OrderMath.gs) and compares the result with this server's own
 *     answer for every vendor and for the dashboard. A store has to pass
 *     before it switches to Supabase.
 ***********************/


// The catalog block for this store. Built from the same readers the API uses,
// so the phone sees exactly what the server sees. Fresh reads only, never the
// CacheService-wrapped ones: a push runs right after an edit, and several
// editors bump the mutation ts at their START, so a cached read could hand
// back the pre-edit list (the commitAddVendor trap, audit 07-29).
function buildCatalogPayload_() {
  const ss    = SpreadsheetApp.getActiveSpreadsheet();
  const setup = getSheet_(SHEET_SETUP);
  const props = PropertiesService.getScriptProperties();

  const vendorList = getVendorList_compute_();
  const multMap    = readVendorMultipliers_(setup);
  const cutoffMap  = readVendorCutoffs_(setup);
  const masterMeta = readMasterItemMeta_();

  const toObj = function (map) {
    const o = {};
    map.forEach(function (val, key) { o[key] = val; });
    return o;
  };

  // Resolved exactly as api_getVendorItems_ and the dashboard resolve one.
  const cutoffs = {};
  for (const v of vendorList) {
    cutoffs[v] = cutoffMap.get(v) || (VENDOR_META[v] || {}).cutoffTime || null;
  }

  // readMasterItemMeta_ verbatim, except a non-numeric par travels as null:
  // JSON has no NaN, and the phone turns null back into NaN
  // (orderInputsFromSnapshot_). Sending 0 would change the math.
  const items = {};
  masterMeta.forEach(function (m, id) {
    items[id] = {
      useMult:       m.useMult,
      par:           isNaN(m.par) ? null : m.par,
      name:          m.name,
      pack:          m.pack,
      primaryVendor: m.primaryVendor,
      active:        m.active
    };
  });

  return {
    schema:       1,
    timeZone:     ss.getSpreadsheetTimeZone(),
    location:     props.getProperty(PROP_LOCATION) || 'Unknown',
    abbr:         props.getProperty(PROP_LOCATION_ABBR) || '',
    concept:      props.getProperty(PROP_CONCEPT) || '',
    vendorList:   vendorList,
    vendorMults:  toObj(multMap),
    cutoffs:      cutoffs,
    items:        items,
    pickRows:     readPickDb_(setup).map(catalogPickRow_),
    itemCounts:   toObj(countActiveItemsByVendor_()),
    backupCounts: toObj(countBackupItemsByVendor_(masterMeta))
  };
}


// One SETUP K:P row made JSON-safe WITHOUT changing what the readers see.
// The builders read columns 0-3 with String() and columns 4-5 (area order,
// shelf order) with Number(). A Date typed into one of those cells would turn
// into an ISO string in JSON, which both String() and Number() read
// differently than the server's Date. So convert it up front to exactly what
// the server would see: String(date) for text columns, its time value for
// number columns.
function catalogPickRow_(r) {
  return r.map(function (v, i) {
    if (!(v instanceof Date)) return v;
    return i >= 4 ? v.getTime() : String(v);
  });
}


// Editor-run. Read-only: changes nothing in the Sheet or anywhere else.
// Run it from the Apps Script editor (Run > test_supabaseParity) and read the
// log. RESULT: PASS means the phone, fed this store's catalog and counts,
// shows exactly what /exec shows today.
function test_supabaseParity() {
  const report = supabaseParityReport_();
  const lines = [];
  lines.push('Supabase parity: ' + report.store + ', cycle ' + report.cycleDate +
             ' (' + report.dayOfWeek + '), Emergency Override ' + (report.emergencyOverride ? 'ON' : 'off'));
  for (const v of report.vendors) {
    lines.push((v.match ? '  MATCH  ' : '  DIFF   ') + v.vendor +
               (v.match ? ' (' + v.items + ' items' + (v.delivering ? '' : ', not delivering today') + ')' : ': ' + v.diff));
  }
  lines.push((report.dashboard.match ? '  MATCH  ' : '  DIFF   ') + 'dashboard' +
             (report.dashboard.match ? '' : ': ' + report.dashboard.diff));
  if (report.notDelivering) {
    lines.push('NOTE: ' + report.notDelivering + ' vendor(s) are not delivering today, so their item lists are empty ' +
               'on both sides. Their lists can only be compared on a delivery day (or with Emergency Override on).');
  }
  lines.push('RESULT: ' + (report.ok ? 'PASS' : 'FAIL') + ' (' + report.matched + '/' + report.vendors.length +
             ' vendors' + (report.dashboard.match ? ' + dashboard' : ', dashboard differs') + ')');
  Logger.log(lines.join('\n'));
  return report;
}


function supabaseParityReport_() {
  const ss      = SpreadsheetApp.getActiveSpreadsheet();
  const setup   = getSheet_(SHEET_SETUP);
  const active  = getActiveOrderDate_();
  const catalog = buildCatalogPayload_();
  const emergencyOverride = readEmergencyOverride_();
  const vendorOverrides   = readVendorOverrides_(setup);

  // This cycle's counts exactly as the database would hold them: one per
  // vendor-tab row that has an item id and a numeric On Hand (mog.to_onhand
  // stores blanks and junk as a cleared count, so those carry nothing).
  const counts = [];
  for (const v of catalog.vendorList) {
    const sh = ss.getSheetByName(v);
    const roster = sh ? readVendorTabRoster_(sh) : null;
    if (!roster) continue;
    for (const row of roster) {
      const raw = row.onHandRaw;
      if (!row.id || raw === '' || raw === null || isNaN(Number(raw))) continue;
      counts.push({ vendor: v, id: row.id, onHand: Number(raw) });
    }
  }

  const picks = {};
  vendorOverrides.forEach(function (m, v) { picks[v] = m; });

  // Exactly what survives the trip to the phone.
  const snap = JSON.parse(JSON.stringify({
    catalog: catalog,
    state: {
      cycleDate:         active.dateStr,
      dayOfWeek:         active.dayOfWeek,
      emergencyOverride: emergencyOverride,
      vendorPicks:       picks,
      todaysLog:         Array.from(getTodaysLogByVendor_(active.dateStr).values())
    },
    counts: counts
  }));
  const inputs = orderInputsFromSnapshot_(snap);

  // The server side, with one shared read context (the bulk-prefetch shape).
  const ctx = {
    pickDb:            readPickDb_(setup),
    vendorMults:       readVendorMultipliers_(setup),
    emergencyOverride: emergencyOverride,
    vendorOverrides:   vendorOverrides,
    dayOfWeek:         active.dayOfWeek,
    masterMeta:        readMasterItemMeta_(),
    cutoffs:           readVendorCutoffs_(setup)
  };

  const report = {
    store: catalog.location, cycleDate: active.dateStr, dayOfWeek: active.dayOfWeek,
    emergencyOverride: emergencyOverride, vendors: [], dashboard: null,
    matched: 0, notDelivering: 0, ok: true
  };
  for (const v of catalog.vendorList) {
    const delivering = vendorDayMultiplier_(inputs.vendorMults, v, inputs.dayOfWeek,
                                            inputs.emergencyOverride, inputs.vendorOverrides) > 0;
    if (!delivering) report.notDelivering++;
    let server = null;
    let diff   = '';
    try {
      server = api_getVendorItems_({ vendor: v }, ctx);
    } catch (e) {
      diff = 'server threw: ' + e.message;
    }
    const phone = vendorItemsFromSnapshot_(inputs, v);
    if (!diff) diff = syncDiff_(server, phone);
    report.vendors.push({
      vendor: v, delivering: delivering, match: !diff, diff: diff || null,
      items: server && server.items ? server.items.length : 0
    });
    if (diff) report.ok = false; else report.matched++;
  }

  const dDiff = syncDiff_(api_getDashboard_compute_(), dashboardFromSnapshot_(inputs));
  report.dashboard = { match: !dDiff, diff: dDiff || null };
  if (dDiff) report.ok = false;
  return report;
}


// First place two payloads differ, or '' when they match. Both sides go
// through a JSON round trip first, because that's how the PWA receives either
// one. A list-length difference names the entries only one side has.
function syncDiff_(server, phone) {
  const a = JSON.parse(JSON.stringify(server === undefined ? null : server));
  const b = JSON.parse(JSON.stringify(phone === undefined ? null : phone));
  return syncDiffAt_(a, b, '');
}

function syncDiffAt_(a, b, path) {
  const kind = function (v) { return Array.isArray(v) ? 'array' : (v === null ? 'null' : typeof v); };
  const show = function (v) {
    const s = JSON.stringify(v);
    return s.length > 120 ? s.slice(0, 117) + '...' : s;
  };
  if (a === b) return '';
  if (kind(a) !== kind(b) || (kind(a) !== 'array' && kind(a) !== 'object')) {
    return (path || '(root)') + ': server ' + show(a) + ' vs phone ' + show(b);
  }
  if (kind(a) === 'array') {
    if (a.length !== b.length) {
      const label = function (e) { return e && (e.id || e.name) ? String(e.id || e.name) : JSON.stringify(e); };
      const la = a.map(label), lb = b.map(label);
      const onlyA = la.filter(function (x) { return lb.indexOf(x) < 0; });
      const onlyB = lb.filter(function (x) { return la.indexOf(x) < 0; });
      return path + '.length: server ' + a.length + ' vs phone ' + b.length +
        (onlyA.length ? ' (server only: ' + onlyA.slice(0, 5).join(', ') + ')' : '') +
        (onlyB.length ? ' (phone only: ' + onlyB.slice(0, 5).join(', ') + ')' : '');
    }
    for (let i = 0; i < a.length; i++) {
      const d = syncDiffAt_(a[i], b[i], path + '[' + i + ']');
      if (d) return d;
    }
    return '';
  }
  const keys = Object.keys(a);
  for (const k of Object.keys(b)) if (keys.indexOf(k) < 0) keys.push(k);
  for (const k of keys) {
    if (!(k in a)) return path + '.' + k + ': only the phone has it';
    if (!(k in b)) return path + '.' + k + ': only the server has it';
    const d = syncDiffAt_(a[k], b[k], path + '.' + k);
    if (d) return d;
  }
  return '';
}
