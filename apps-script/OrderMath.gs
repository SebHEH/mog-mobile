/***********************
 * ORDER MATH — shared by Apps Script and the PWA
 *
 * The ONE copy of the order math and of the two payloads the PWA renders (a
 * vendor's count list and the Today dashboard). Apps Script runs this file
 * as-is; build.py copies it verbatim into the PWA, so the phone computes
 * exactly what the server computes. Design record:
 * docs/MOG_SupabaseMigration.md, section 5.
 *
 * RULES FOR THIS FILE
 *   - Pure functions only: no SpreadsheetApp, Utilities, PropertiesService,
 *     CacheService, Logger, Session or any other Apps Script service, no DOM,
 *     and no constants from another file. Callers pass everything in.
 *     tests/ordermath_purity.test.js fails if that slips.
 *   - Server callers pass what they read from the Sheet; the phone passes
 *     what its Supabase snapshot holds. Same inputs, same output.
 *   - A change here changes the order math everywhere at once. Run
 *     `node tests/run_all.js` before deploying.
 ***********************/


function vendorDayMultiplier_(vendorMults, vendor, dayOfWeek, emergencyOverride, vendorOverrides) {
  // Effective vendor multiplier for `vendor` on `dayOfWeek` — computed in code
  // to replace reading the vendor tab's H2 formula. Mirrors that formula:
  //   H2 = IF(AD2=TRUE, <emergency>, <today's mult from SETUP S:Y>)
  //
  // Normal (override off): today's multiplier from the SETUP S:Y table; 0 means
  // the vendor doesn't deliver today (items then blank, same as H2=0).
  //
  // Emergency Override (AD2 on): a flat 1x doesn't help a vendor that only
  // delivers some days (a 1-day order won't bridge the gap to its next drop).
  //
  // A KM PICK wins first (SETUP!AF via `vendorOverrides`): the auto-bridge
  // below derives coverage from the NORMAL schedule, which is exactly what's
  // abnormal in an emergency (a Fri+Sat vendor ordered Thursday is sized to
  // last one day — but if Saturday's drop is cancelled it must last seven).
  // The PWA's day picker asks "when is this vendor's next delivery after this
  // one?" and stores the frozen day count; that number is authoritative.
  //
  // No pick → "bridge to the next real delivery": scan forward from today
  // (inclusive) for the first day with mult > 0 and use that day's multiplier,
  // so an off-schedule emergency order covers what the next scheduled drop
  // would bring. If today is itself a delivery day, that's today's own mult
  // (override is a no-op for that vendor). An all-zero row (vendor never
  // delivers / misconfigured) falls back to 1 so the KM can still order.
  //
  // The pick is checked INSIDE the override branch on purpose — SETUP!AF is
  // cleared whenever AD2 clears, and the in-Sheet H2 formula nests the same
  // way (vendorTabH2Formula_), so code and sheet stay structurally identical.
  const m = vendorMults.get(vendor);
  if (!m) return 0;
  const DAYS = ['Mon','Tue','Wed','Thu','Fri','Sat','Sun'];
  const start = DAYS.indexOf(dayOfWeek);
  if (start < 0) return Number(m[dayOfWeek]) || 0;   // unknown day label — defensive
  if (!emergencyOverride) return Number(m[DAYS[start]]) || 0;
  const picked = vendorOverrides ? Number(vendorOverrides.get(vendor)) : NaN;
  if (!isNaN(picked) && picked > 0) return picked;
  for (let i = 0; i < 7; i++) {
    const mv = Number(m[DAYS[(start + i) % 7]]) || 0;
    if (mv > 0) return mv;
  }
  return 1;   // never-delivers row: let the KM still order something under override
}


// Suggested order qty for one item — THE single source of the count/order math,
// replacing the vendor-tab column-F formula. Called by api_getVendorItems_ (the
// PWA count screen, the recap email, and — via buildOrderCycleSnapshot_ — the
// order log) and by vendorOnHandSnapshot_ (dashboard "to order" counts), so the
// math lives in one place and can't drift. Faithful replication of the live F
// formula:
//   F = IF(name="" OR H2=0 OR onHand="", "",
//          qty = ROUNDUP(par*(useMult?H2:1) - onHand); qty<=0 ? "" : qty)
// Inputs: par = MASTER_ITEMS!G, useMult = MASTER_ITEMS!M, dayMult = H2 (from
// vendorDayMultiplier_), onHand = vendor-tab col E (null when nothing entered).
// Returns a positive integer, or null for every blank case (vendor not
// delivering today → dayMult 0; no On Hand entered; already at/above par).
function computeSuggestedQty_(par, useMult, dayMult, onHand) {
  if (isNaN(par) || dayMult <= 0 || onHand === null || onHand === undefined) return null;
  const effectiveMult = useMult ? dayMult : 1;
  if (effectiveMult <= 0) return null;
  // ORDERS ALWAYS ROUND UP — never down. A partial unit short is a whole unit
  // ordered, because you can't buy half a case. The only thing corrected here
  // is binary-float noise: `par * effectiveMult - onHand` is float arithmetic,
  // so a shortfall that is EXACTLY 1 in decimal can land at 1.0000000000000002
  // (e.g. par 1.1 x 2 - 1.2) and a bare Math.ceil would order 2 for a phantom
  // 2e-16 of a case.
  //
  // The epsilon is the right tool for that, NOT rounding to N decimals: it
  // cancels noise (a few ULP, ~1e-13 at these magnitudes) while leaving every
  // GENUINE fraction intact, so a real shortfall of 1.0001 still orders 2. A
  // fixed 3dp round would have shaved that to 1 — an under-order, which this
  // system must never do. 1e-9 sits ~1000x above float noise and ~100,000x
  // below the smallest fraction anyone could enter.
  //
  // The PWA's ceilQty_ and ManageItems.html's ppCeil_ use this same expression
  // and MUST stay identical — if they drift, the review screen the KM approves
  // disagrees with the recap email and the order log.
  const qty = Math.ceil((par * effectiveMult - onHand) - 1e-9);
  return qty > 0 ? qty : null;
}


// ---------------------------------------------------------------------------
// The payload builders. Extracted from api_getVendorItems_ and
// api_getDashboard_compute_ / vendorOnHandSnapshot_ (MOGApi.gs) on 2026-10-15
// with their logic unchanged; tests/ordermath_equivalence.test.js proves the
// server output is identical to the pre-extraction code.
// ---------------------------------------------------------------------------

// Pick-path metadata for ONE vendor, keyed by item id. pickDb is SETUP K:P
// exactly as readPickDb_ returns it: [vendor, itemId, itemName, area,
// areaOrder, shelfOrder]. Rows for other vendors (trimmed, exact case) or with
// no id are ignored; a blank or non-numeric order sorts last.
function buildPickInfo_(pickDb, vendor) {
  const pickInfo = new Map();
  for (const r of pickDb) {
    if (String(r[0] || '').trim() !== vendor) continue;
    const id = String(r[1] || '').trim();
    if (!id) continue;
    pickInfo.set(id, {
      area:       String(r[3] || '').trim(),
      areaOrder:  Number(r[4]) || 999,
      shelfOrder: Number(r[5]) || 999999
    });
  }
  return pickInfo;
}


// The count-screen payload for ONE vendor: what the PWA renders, what the
// recap email lists, and (via buildOrderCycleSnapshot_) what the order log
// records.
//
// roster: the vendor's list rows in order, [{ id, onHandRaw }]
//   server: one per vendor-tab data row (readVendorTabRoster_: Item ID col M
//           trimmed, On Hand col E as the raw cell value);
//   phone:  rosterFromPickRows_ over the Supabase snapshot.
// o: { vendor, pickDb, vendorMults, emergencyOverride, vendorOverrides,
//      dayOfWeek, masterMeta, cutoff }; cutoff is already resolved by the caller.
function buildVendorItemsPayload_(roster, o) {
  const vendor            = o.vendor;
  const masterMeta        = o.masterMeta;
  const emergencyOverride = o.emergencyOverride;
  const vendorOverrides   = o.vendorOverrides;
  const pickInfo          = buildPickInfo_(o.pickDb, vendor);
  const dayMult = vendorDayMultiplier_(o.vendorMults, vendor, o.dayOfWeek, emergencyOverride, vendorOverrides);

  const items = [];
  for (const row of roster) {
    const onHandRaw = row.onHandRaw;
    const itemId    = row.id;
    if (!itemId) continue;

    // Name/pack from MASTER_ITEMS (via masterMeta), not the tab's A/B: those
    // columns are XLOOKUP(id, MASTER!A, MASTER!B / MASTER!E) spills, so this
    // is the same text from its canonical source. No MASTER row, or a blank
    // name, skips the row, exactly like the old `A === ""` skip (the tab's
    // XLOOKUP falls back to "" on a missing id).
    const meta = masterMeta.get(itemId);
    if (!meta || !meta.name) continue;
    const itemName = meta.name;
    const pack     = meta.pack;

    // Secondary/backup vendor: this item's PRIMARY is a different vendor
    // (MASTER col C). It's still fully orderable from here; a backup exists
    // precisely so you can order it when the primary isn't delivering today or
    // is out of stock. The flag only drives a "Backup · <primary>" badge in the
    // PWA so the KM knows this isn't the default source. On-Hand is per vendor,
    // so counting it here (and not on the primary) is what routes the order to
    // this vendor; nothing is double-counted unless the same item is
    // deliberately counted on two vendors the same day.
    const isSecondary = !!meta.primaryVendor &&
      meta.primaryVendor.toLowerCase() !== vendor.toLowerCase();

    const onHand = (onHandRaw === '' || onHandRaw === null)
      ? null
      : (isNaN(Number(onHandRaw)) ? null : Number(onHandRaw));

    // targetPar = par (MASTER_ITEMS col G) * day multiplier, honoring the
    // per-item Use Multiplier flag. Surfacing it lets the PWA recompute live
    // suggestions as the user types (computeSuggested).
    //
    // Use Multiplier: items flagged FALSE in MASTER_ITEMS column M skip the
    // day multiplier (effectiveMult = 1): a par already sized for the cycle.
    const parNum  = meta.par;
    const useMult = meta.useMult;
    const effectiveMult = useMult ? dayMult : 1;
    // The dayMult > 0 term mirrors computeSuggestedQty_'s gate exactly: when the
    // vendor isn't delivering (dayMult 0) the server suggests nothing REGARDLESS
    // of useMult, so targetPar has to be null too. Without it, a useMult=false
    // item kept a non-null targetPar and the PWA's computeSuggested, which
    // prefers targetPar over the server's suggestedQty so it can recompute live
    // as the KM types, would show an order quantity the recap email and order
    // log never record.
    const targetPar = (!isNaN(parNum) && dayMult > 0 && effectiveMult > 0)
      ? parNum * effectiveMult
      : null;

    // Suggested order qty via computeSuggestedQty_, the single source of this
    // math across the count, order-log, and dashboard paths.
    const suggested = computeSuggestedQty_(parNum, useMult, dayMult, onHand);

    const pi = pickInfo.get(itemId) || { area: '', areaOrder: 999, shelfOrder: 999999 };

    items.push({
      id:            itemId,
      name:          itemName,
      pack:          pack,
      par:           (!isNaN(parNum) ? parNum : 0),
      targetPar:     targetPar,
      onHand:        onHand,
      suggestedQty:  suggested,
      secondary:     isSecondary,
      primaryVendor: meta.primaryVendor,
      storageArea:   pi.area,
      _areaOrder:    pi.areaOrder,
      _shelfOrder:   pi.shelfOrder
    });
  }

  // Pick-path order, then name. (The vendor tab is already in pick-path order
  // via its SORT/FILTER source formula; this sort is what makes the phone's
  // roster, which comes in pick-row order, land in the same order.)
  items.sort((a, b) => {
    if (a._areaOrder !== b._areaOrder) return a._areaOrder - b._areaOrder;
    if (a._shelfOrder !== b._shelfOrder) return a._shelfOrder - b._shelfOrder;
    return a.name.localeCompare(b.name);
  });
  for (const it of items) { delete it._areaOrder; delete it._shelfOrder; }

  // Override context for the PWA count screen: `emergencyOverride` gates the
  // day-picker card, `overrideMult` (0 = no pick) highlights the chosen chip
  // and drives the "sized to last until <day> xN" note on count + review.
  const pickedMult = (emergencyOverride && vendorOverrides && vendorOverrides.get(vendor) > 0)
    ? Number(vendorOverrides.get(vendor)) : 0;

  return {
    vendor:            vendor,
    cutoffTime:        o.cutoff,
    emergencyOverride: emergencyOverride,
    overrideMult:      pickedMult,
    items:             items
  };
}


// { any, toOrder, enteredCount } for one vendor, for the dashboard card:
//   any          at least one On Hand value entered this cycle
//   toOrder      items whose suggested order qty > 0
//   enteredCount roster rows with a numeric On Hand value
// roster as for buildVendorItemsPayload_; null (no tab / no data rows) counts
// as nothing entered. Note enteredCount counts a numeric On Hand even on a row
// with no item id, exactly as the vendor-tab version did.
function rosterOnHandSnapshot_(roster, dayMult, masterMeta) {
  if (!roster) return { any: false, toOrder: 0, enteredCount: 0 };
  let enteredCount = 0;
  let toOrder = 0;
  for (const row of roster) {
    const onHandRaw = row.onHandRaw;
    const entered   = (onHandRaw !== '' && onHandRaw !== null && !isNaN(Number(onHandRaw)));
    if (entered) enteredCount++;

    const itemId = row.id;
    if (!itemId) continue;
    const meta = masterMeta.get(itemId);
    if (!meta || !meta.name) continue;   // non-roster / blank row, same skip as the count path

    const onHand    = entered ? Number(onHandRaw) : null;
    const suggested = computeSuggestedQty_(meta.par, meta.useMult, dayMult, onHand);
    if (suggested != null && suggested > 0) toOrder++;
  }
  return { any: enteredCount > 0, toOrder: toOrder, enteredCount: enteredCount };
}


// The Today dashboard payload.
// o: { date, dayOfWeek, location, emergencyOverride, vendors (ordered names),
//      vendorMults, vendorOverrides, masterMeta, itemCounts, backupCounts,
//      todaysLog (Map vendor -> { sentAt, reference, itemCount }),
//      cutoffFor(vendor) -> "HH:MM" | null,
//      rosterFor(vendor) -> roster | null }
function buildDashboardPayload_(o) {
  const out = [];
  for (const vendorName of o.vendors) {
    const mults = o.vendorMults.get(vendorName) || {};
    // Skip non-delivery vendors only when override is off. Under override the
    // whole list shows; the per-vendor screen applies next-delivery coverage.
    if (!o.emergencyOverride && (Number(mults[o.dayOfWeek]) || 0) <= 0) continue;

    const itemCount   = o.itemCounts.get(vendorName) || 0;
    const backupCount = o.backupCounts.get(vendorName) || 0;
    const log         = o.todaysLog.get(vendorName);

    let status       = 'not_started';
    let sentAt       = null;
    let reference    = null;
    let toOrderCount = null;
    let enteredCount = 0;

    if (log) {
      status       = 'sent';
      sentAt       = log.sentAt;
      reference    = log.reference;
      toOrderCount = log.itemCount;
      // A sent vendor implicitly has all items "entered": primaries AND
      // backups, matching the count screen's roster (the client denominator
      // is itemCount + backupCount).
      enteredCount = itemCount + backupCount;
    } else {
      const dayMult    = vendorDayMultiplier_(o.vendorMults, vendorName, o.dayOfWeek, o.emergencyOverride, o.vendorOverrides);
      const inProgress = rosterOnHandSnapshot_(o.rosterFor(vendorName), dayMult, o.masterMeta);
      enteredCount = inProgress.enteredCount;
      if (inProgress.any) {
        status       = 'in_progress';
        toOrderCount = inProgress.toOrder;
      }
    }

    out.push({
      name:         vendorName,
      itemCount:    itemCount,
      backupCount:  backupCount,
      cutoffTime:   o.cutoffFor(vendorName),
      status:       status,
      sentAt:       sentAt,
      reference:    reference,
      toOrderCount: toOrderCount,
      enteredCount: enteredCount
    });
  }

  // Sort by cutoff (earliest first; null cutoffs last), then by name.
  out.sort((a, b) => {
    const at = a.cutoffTime || '99:99';
    const bt = b.cutoffTime || '99:99';
    if (at !== bt) return at.localeCompare(bt);
    return a.name.localeCompare(b.name);
  });

  return {
    date:              o.date,
    dayOfWeek:         o.dayOfWeek,
    location:          o.location,
    emergencyOverride: o.emergencyOverride,
    vendors:           out
  };
}


// ---------------------------------------------------------------------------
// Phone side: the server's inputs, rebuilt from a Supabase snapshot.
// Apps Script uses these too, but only in the parity test (Sync.gs).
// ---------------------------------------------------------------------------

// The snapshot carries plain JSON (catalog + state + counts, section 6 of the
// design record); the builders take the same Maps the server's readers return.
// Only JSON-safe values cross the wire, so a non-numeric par arrives as null
// and goes back to NaN here. 0 would change the math (readMasterItemMeta_
// keeps Number('abc') = NaN, which suggests nothing).
function orderInputsFromSnapshot_(snap) {
  const cat   = snap.catalog || {};
  const st    = snap.state || {};
  const toMap = function (obj) {
    return new Map(Object.keys(obj || {}).map(function (k) { return [k, obj[k]]; }));
  };

  const masterMeta = new Map();
  const items = cat.items || {};
  for (const id of Object.keys(items)) {
    const m = items[id];
    masterMeta.set(id, {
      useMult:       m.useMult,
      par:           (m.par === null || m.par === undefined) ? NaN : m.par,
      name:          m.name,
      pack:          m.pack,
      primaryVendor: m.primaryVendor,
      active:        m.active
    });
  }

  // Same rule as readVendorOverrides_: only positive numbers are picks.
  const vendorOverrides = new Map();
  const picks = st.vendorPicks || {};
  for (const v of Object.keys(picks)) {
    const m = Number(picks[v]);
    if (!isNaN(m) && m > 0) vendorOverrides.set(v, m);
  }

  const todaysLog = new Map();
  for (const e of (st.todaysLog || [])) todaysLog.set(e.vendor, e);

  const counts = new Map();
  for (const c of (snap.counts || [])) counts.set(c.vendor + '\u0001' + c.id, c.onHand);

  return {
    dateStr:           st.cycleDate,
    dayOfWeek:         st.dayOfWeek,
    emergencyOverride: st.emergencyOverride === true,
    location:          cat.location,
    vendorList:        cat.vendorList || [],
    vendorMults:       toMap(cat.vendorMults),
    cutoffs:           toMap(cat.cutoffs),
    masterMeta:        masterMeta,
    pickDb:            cat.pickRows || [],
    itemCounts:        toMap(cat.itemCounts),
    backupCounts:      toMap(cat.backupCounts),
    vendorOverrides:   vendorOverrides,
    todaysLog:         todaysLog,
    counts:            counts
  };
}


// The vendor's roster the way the vendor tab's column M spills it: one row per
// pick-path row whose vendor matches the tab (SETUP K = the tab's B1 header),
// and nothing at all when the day multiplier is 0 (H2 = 0 blanks the spill).
// Google Sheets' "=" ignores case but not spaces, hence the lower-case,
// untrimmed compare. Order doesn't matter: the payload builder sorts and the
// dashboard only counts.
// The parity test (Sync.gs, test_supabaseParity) is the authority on whether
// this matches the live formula. Until it passes on a store, treat this rule
// as unverified for that store.
function rosterFromPickRows_(pickDb, vendor, dayMult, counts) {
  if (!(dayMult > 0)) return [];
  const key = String(vendor).toLowerCase();
  const roster = [];
  for (const r of pickDb) {
    const k = (r[0] === null || r[0] === undefined) ? '' : String(r[0]);
    if (k.toLowerCase() !== key) continue;
    const id     = String(r[1] || '').trim();
    const onHand = counts.get(vendor + '\u0001' + id);
    roster.push({ id: id, onHandRaw: (onHand === undefined ? null : onHand) });
  }
  return roster;
}


// One vendor's count-screen payload, from a snapshot (phone).
function vendorItemsFromSnapshot_(inputs, vendor) {
  const dayMult = vendorDayMultiplier_(inputs.vendorMults, vendor, inputs.dayOfWeek,
                                       inputs.emergencyOverride, inputs.vendorOverrides);
  return buildVendorItemsPayload_(
    rosterFromPickRows_(inputs.pickDb, vendor, dayMult, inputs.counts),
    {
      vendor:            vendor,
      pickDb:            inputs.pickDb,
      vendorMults:       inputs.vendorMults,
      emergencyOverride: inputs.emergencyOverride,
      vendorOverrides:   inputs.vendorOverrides,
      dayOfWeek:         inputs.dayOfWeek,
      masterMeta:        inputs.masterMeta,
      cutoff:            inputs.cutoffs.has(vendor) ? inputs.cutoffs.get(vendor) : null
    });
}


// The Today dashboard payload, from a snapshot (phone).
function dashboardFromSnapshot_(inputs) {
  return buildDashboardPayload_({
    date:              inputs.dateStr,
    dayOfWeek:         inputs.dayOfWeek,
    location:          inputs.location,
    emergencyOverride: inputs.emergencyOverride,
    vendors:           inputs.vendorList,
    vendorMults:       inputs.vendorMults,
    vendorOverrides:   inputs.vendorOverrides,
    masterMeta:        inputs.masterMeta,
    itemCounts:        inputs.itemCounts,
    backupCounts:      inputs.backupCounts,
    todaysLog:         inputs.todaysLog,
    cutoffFor: function (v) { return inputs.cutoffs.has(v) ? inputs.cutoffs.get(v) : null; },
    rosterFor: function (v) {
      const dayMult = vendorDayMultiplier_(inputs.vendorMults, v, inputs.dayOfWeek,
                                           inputs.emergencyOverride, inputs.vendorOverrides);
      return rosterFromPickRows_(inputs.pickDb, v, dayMult, inputs.counts);
    }
  });
}


// ---------------------------------------------------------------------------
// Cycle close and recap, from a snapshot (added 2026-10-15, step 4).
// A store that has switched to Supabase closes its cycle and builds its recap
// from these, with the SAME rules the Sheet path uses, so switching changes
// where the data lives, not what gets logged or emailed.
// ---------------------------------------------------------------------------

// The order log for the cycle in `inputs`: every vendor (A-Z), its items with
// a suggested qty > 0, in count-list order. The rule buildOrderCycleSnapshot_
// (ResetLog.gs) applies to the Sheet, including backup vendors.
// Rows: { vendor, id, name, pack, area, onHandPrev, qty } (onHandPrev 0 when
// nothing was entered, as in the Sheet log).
function orderLogRowsFromInputs_(inputs) {
  const rows = [];
  for (const vendor of inputs.vendorList) {
    const result = vendorItemsFromSnapshot_(inputs, vendor);
    for (const it of result.items) {
      if (it.suggestedQty == null || it.suggestedQty <= 0) continue;
      rows.push({
        vendor:     vendor,
        id:         it.id,
        name:       it.name,
        pack:       it.pack,
        area:       it.storageArea,
        onHandPrev: (it.onHand === null ? 0 : it.onHand),
        qty:        it.suggestedQty
      });
    }
  }
  return rows;
}


// The recap's sections (the in-app full order list and the manual email), with
// the rules of buildRecapSections_ (Recap.gs): the requested vendors that
// exist, or every vendor whose EFFECTIVE multiplier is > 0 (Emergency
// Override-aware); a vendor's lines are its items with a suggested qty > 0;
// vendors with no lines are left out.
function recapSectionsFromInputs_(inputs, requestedVendors) {
  let vendorsToCheck;
  if (requestedVendors && requestedVendors.length) {
    const known = new Set(inputs.vendorList);
    vendorsToCheck = requestedVendors.filter(function (v) { return known.has(v); });
  } else {
    vendorsToCheck = inputs.vendorList.filter(function (v) {
      return vendorDayMultiplier_(inputs.vendorMults, v, inputs.dayOfWeek,
                                  inputs.emergencyOverride, inputs.vendorOverrides) > 0;
    });
  }

  const sections = [];
  let totalItems = 0;
  for (const vendor of vendorsToCheck) {
    const result = vendorItemsFromSnapshot_(inputs, vendor);
    const lines = result.items
      .filter(function (it) { return it.suggestedQty != null && it.suggestedQty > 0; })
      .map(function (it) {
        return { name: it.name, pack: it.pack, onHand: it.onHand, qty: it.suggestedQty, area: it.storageArea };
      });
    if (lines.length) {
      sections.push({ vendor: vendor, itemCount: lines.length, lines: lines });
      totalItems += lines.length;
    }
  }
  return { sections: sections, totalItems: totalItems, cycleDate: inputs.dateStr };
}


// Recap sections from logged rows ({ vendor, name, pack, area, onHandPrev,
// qty }, in logged order): the rules of buildRecapFromLog_ (Recap.gs). Rows
// without a vendor or with qty <= 0 are skipped; vendors appear in the log's
// order.
function recapFromLogRows_(rows, orderDate) {
  const byVendor = new Map();
  let totalItems = 0;
  for (const r of rows) {
    if (!r.vendor || !(r.qty > 0)) continue;
    if (!byVendor.has(r.vendor)) byVendor.set(r.vendor, []);
    byVendor.get(r.vendor).push({ name: r.name, pack: r.pack, onHand: r.onHandPrev, qty: r.qty, area: r.area || '' });
    totalItems++;
  }
  const sections = [];
  byVendor.forEach(function (lines, vendor) {
    sections.push({ vendor: vendor, itemCount: lines.length, lines: lines });
  });
  return { sections: sections, totalItems: totalItems, cycleDate: orderDate };
}
