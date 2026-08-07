/***********************
 * RECAP + RECIPIENTS
 *
 * Daily recap email (build + send) and the server-side recipients list
 * (SETUP columns AB-AE). Extracted verbatim from MOGApi.gs on 2026-07-24
 * (audit item #24, pure code-motion). All .gs files share one flat global
 * scope, so callers in MOGApi.gs / ResetLog.gs resolve unchanged.
 ***********************/

function api_emailRecap_(payload) {
  // Builds and emails an end-of-day recap to every active recipient
  // configured in SETUP columns AB-AE. Recipients are server-side so a
  // single email goes to the same people regardless of which device or
  // which user triggers the send.
  //
  // This is purely a convenience email. It does NOT write to LOG_ORDERS —
  // that happens only when reset runs (the next morning) and snapshots the
  // current On Hand state into the log. The recap is just so the KMs and
  // GMs have a clean copy of the suggested order to actually place.
  //
  // Optional payload:
  //   force   (bool) — if true, send even when the current cycle already
  //                    had a successful recap. Used by manual sends. Auto-
  //                    triggered sends (bulk-mark, pre-reset) omit this so
  //                    they cleanly dedupe across the PWA + sheet-reset paths.
  //   vendors (array) — vendor names to include. Omit for all active-day
  //                     vendors with suggestions.
  //
  // Returns:
  //   { cycleDate, vendorCount, itemCount, sentCount, failedCount,
  //     failed: [{name, email, error}], alreadySent, vendors }
  //
  // Throws when there are zero configured recipients or zero items to
  // recap. Auto-send callers should catch and treat these as "no-op".
  ensureRecipientsHeader_();
  migrateGmEmailToRecipients_();

  const props = PropertiesService.getScriptProperties();
  const force = !!(payload && payload.force);
  const active = getActiveOrderDate_();
  const currentCycleDate = active.dateStr;
  const lastSent = props.getProperty(PROP_LAST_RECAP_SENT_DATE) || '';

  // Auto-send dedupe: if this cycle was already emailed, return a
  // structured no-op so the caller can show "already sent" state
  // without surfacing an error. Manual sends bypass via force.
  if (!force && lastSent === currentCycleDate) {
    return {
      cycleDate:    currentCycleDate,
      vendorCount:  0,
      itemCount:    0,
      sentCount:    0,
      failedCount:  0,
      failed:       [],
      alreadySent:  true,
      vendors:      []
    };
  }

  const recipients = readRecipients_().filter(r => r.active && r.email);
  if (!recipients.length) {
    throw new Error('No recipients configured. Add at least one in Settings → Recipients.');
  }

  const { sections, totalItems, cycleDate } = buildRecapSections_(
    payload && Array.isArray(payload.vendors) ? payload.vendors : null
  );
  if (!sections.length) {
    throw new Error('Nothing to recap — no vendors have items to order.');
  }

  // Send one email per recipient. Individual sends mean:
  //   - Per-address bounce isolation (one bad email doesn't kill the rest)
  //   - No shared distribution list visible in headers
  //   - Future per-recipient customization is straightforward
  const failed = [];
  for (const r of recipients) {
    try {
      sendRecapEmail_(r.email, sections, cycleDate, totalItems);
    } catch (err) {
      Logger.log('Recap send failed for ' + r.email + ': ' + (err.stack || err));
      failed.push({
        name:  r.name,
        email: r.email,
        error: String(err.message || err)
      });
    }
  }

  // Set the dedupe flag if at least one recipient received the email.
  // Total-failure case (every send threw): leave the flag alone so the
  // next legitimate attempt isn't gated by a failed cycle.
  if (failed.length < recipients.length) {
    props.setProperty(PROP_LAST_RECAP_SENT_DATE, cycleDate);
  }

  return {
    cycleDate:    cycleDate,
    vendorCount:  sections.length,
    itemCount:    totalItems,
    sentCount:    recipients.length - failed.length,
    failedCount:  failed.length,
    failed:       failed,
    alreadySent:  false,
    vendors:      sections.map(s => ({ vendor: s.vendor, itemCount: s.lines.length }))
  };
}

function api_getRecapData_(payload) {
  // Returns the same structured data emailRecap builds, but never sends
  // an email and never throws on empty. Used by the PWA's in-app
  // "View full order list" view.
  //
  // Returns:
  //   {
  //     cycleDate,
  //     vendorCount,
  //     itemCount,
  //     sections: [{ vendor, itemCount, lines: [{ name, pack, onHand, qty, area }] }]
  //   }
  // Empty cycles return an empty sections array instead of an error so the
  // PWA can render an empty state cleanly.
  const { sections, totalItems, cycleDate } = buildRecapSections_(
    payload && Array.isArray(payload.vendors) ? payload.vendors : null
  );
  return {
    cycleDate:   cycleDate,
    vendorCount: sections.length,
    itemCount:   totalItems,
    sections:    sections
  };
}

function buildRecapSections_(requestedVendors) {
  // Shared logic between emailRecap and getRecapData. Reads current state
  // and produces the {sections, totalItems, cycleDate} bundle.
  const setup       = getSheet_(SHEET_SETUP);
  const allVendors  = getVendorList();
  const vendorMults = readVendorMultipliers_(setup);
  const active      = getActiveOrderDate_();
  const dayOfWeek   = active.dayOfWeek;
  const cycleDate   = active.dateStr;
  // Read BEFORE the vendor filter below — the filter needs it (see why there).
  const emergencyOverride = readEmergencyOverride_();
  const vendorOverrides   = readVendorOverrides_(setup);

  let vendorsToCheck;
  if (requestedVendors && requestedVendors.length) {
    const known = new Set(allVendors);
    vendorsToCheck = requestedVendors.filter(v => known.has(v));
  } else {
    // Filter on the EFFECTIVE multiplier, not the raw today-column value.
    //
    // This used to read `vendorMults.get(v)[dayOfWeek] > 0` directly, which
    // ignores Emergency Override — while the quantities computed below (and
    // the order log written by the reset) both go through vendorDayMultiplier_,
    // which under Override bridges to the vendor's next scheduled delivery. So
    // with Override on, a vendor that doesn't deliver today was counted by the
    // KM, priced by the PWA, and written to history — but silently dropped from
    // the recap email AND from the in-app "full order list" that share this
    // filter. Override is exactly when someone is ordering off-schedule, so it
    // was the worst case to lose a vendor in.
    //
    // With Override off, vendorDayMultiplier_ returns today's raw multiplier,
    // so normal operation is byte-identical to the old filter.
    vendorsToCheck = allVendors.filter(v =>
      vendorDayMultiplier_(vendorMults, v, dayOfWeek, emergencyOverride, vendorOverrides) > 0
    );
  }

  // Shared read context — built ONCE and passed into api_getVendorItems_ so
  // the pick DB / MASTER / multiplier / override / cutoff reads don't repeat
  // per vendor (they used to: ~5 redundant range reads × N vendors per
  // recap). Must be all-or-nothing per the ctx contract on that function.
  const recapCtx = {
    pickDb:            readPickDb_(setup),
    vendorMults:       vendorMults,
    emergencyOverride: emergencyOverride,
    vendorOverrides:   vendorOverrides,
    dayOfWeek:         dayOfWeek,
    masterMeta:        readMasterItemMeta_(),
    cutoffs:           readVendorCutoffs_(setup)
  };

  const sections = [];
  let totalItems = 0;
  for (const vendor of vendorsToCheck) {
    const result = api_getVendorItems_({ vendor: vendor }, recapCtx);
    const lines = result.items
      .filter(it => it.suggestedQty != null && it.suggestedQty > 0)
      .map(it => ({
        name:   it.name,
        pack:   it.pack,
        onHand: it.onHand,
        qty:    it.suggestedQty,
        area:   it.storageArea
      }));
    if (lines.length) {
      sections.push({ vendor: vendor, itemCount: lines.length, lines: lines });
      totalItems += lines.length;
    }
  }

  return { sections: sections, totalItems: totalItems, cycleDate: cycleDate };
}




// ── Async recap send ──────────────────────────────────────────────────────
// Rebuilds a cycle's recap sections from LOG_ORDERS instead of from live
// on-hand. This is what lets the recap be sent AFTER the reset has cleared
// on-hand — and it's a STRONGER guarantee than the old live rebuild: the email
// is now derived FROM the order log, so the email and history cannot disagree
// by construction rather than by two computations happening to match.
//
// Everything the email needs is in the log or joinable to it:
//   name, onHand, qty — logged directly by buildOrderCycleSnapshot_
//   pack              — joined from MASTER_ITEMS by buildHistoryRows_ (itemPack)
//   area              — joined from the pick DB here (the log doesn't store it)
//
// Order is preserved: rows were appended in getVendorList() order and, within a
// vendor, pick-path order; buildHistoryRows_'s date sort is stable and every row
// here shares one date, so sections come out in the same order the old live
// builder produced.
function buildRecapFromLog_(orderDate) {
  const rows = getOrderHistory({ vendorFilter: 'ALL', dateFrom: orderDate, dateTo: orderDate });

  // vendor|itemId -> storage area. Not stored in the log, so joined from the
  // pick DB. Cosmetic grouping in the email, so a read failure must never sink
  // the send — fall back to blank areas.
  const areaByKey = new Map();
  try {
    for (const r of readPickDb_(getSheet_(SHEET_SETUP))) {
      const vendor = String(r[0] || '').trim();
      const id     = String(r[1] || '').trim();
      if (vendor && id) areaByKey.set(vendor + '|' + id, String(r[3] || '').trim());
    }
  } catch (e) {
    Logger.log('buildRecapFromLog_ pick-DB read failed (areas will be blank): ' + (e.stack || e));
  }

  const byVendor = new Map();   // insertion-ordered, so vendor order is the log's
  let totalItems = 0;
  for (const r of rows) {
    if (!r.vendor || !(r.qtyOrdered > 0)) continue;
    if (!byVendor.has(r.vendor)) byVendor.set(r.vendor, []);
    byVendor.get(r.vendor).push({
      name:   r.itemName,
      pack:   r.itemPack,
      onHand: r.onHandPrev,
      qty:    r.qtyOrdered,
      area:   areaByKey.get(r.vendor + '|' + r.itemId) || ''
    });
    totalItems++;
  }

  const sections = [];
  byVendor.forEach(function (lines, vendor) {
    sections.push({ vendor: vendor, itemCount: lines.length, lines: lines });
  });
  return { sections: sections, totalItems: totalItems, cycleDate: orderDate };
}


// Hands the recap send off to a one-shot time-based trigger so a reset returns
// immediately instead of blocking the KM on one Gmail round-trip per recipient.
// Clears any earlier sendPendingRecap_ trigger first — Apps Script caps triggers
// per script, so they must never accumulate.
function scheduleRecapSend_(cycleDate) {
  dropRecapTriggers_();
  PropertiesService.getScriptProperties().setProperty(
    PROP_PENDING_RECAP,
    JSON.stringify({ cycleDate: cycleDate, attempts: 0 })
  );
  ScriptApp.newTrigger('sendPendingRecap_').timeBased().after(RECAP_SEND_DELAY_MS).create();
  return { scheduled: true, cycleDate: cycleDate };
}


function dropRecapTriggers_() {
  // Safe to call from inside sendPendingRecap_ itself — deleting the trigger
  // that is currently executing is allowed.
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'sendPendingRecap_') {
      try { ScriptApp.deleteTrigger(t); } catch (e) { /* already gone */ }
    }
  });
}


// Trigger handler: sends the pending cycle's recap, rebuilt from LOG_ORDERS
// (on-hand is already cleared by the time this runs — that's the whole point).
//
// The bounded retry is REQUIRED, not a bonus. Going async removed the KM's
// immediate feedback, so without it a silent Gmail failure would strand a cycle
// with no email and nobody aware. Still at most one DELIVERED email per cycle:
// PROP_LAST_RECAP_SENT_DATE gates that, and it's checked before every attempt.
//
// Never throws — a trigger error surfaces nowhere useful, so everything is
// logged for triage instead.
function sendPendingRecap_() {
  const props = PropertiesService.getScriptProperties();
  let pending = null;
  try { pending = JSON.parse(props.getProperty(PROP_PENDING_RECAP) || 'null'); }
  catch (e) { pending = null; }

  const finish = function () {
    dropRecapTriggers_();
    props.deleteProperty(PROP_PENDING_RECAP);
  };

  // Nothing pending, or a stale trigger left over — clean up and stop.
  if (!pending || !pending.cycleDate) { finish(); return; }

  // Already delivered for this cycle by some other path (a manual send, or the
  // synchronous fallback in commitLogAndReset when trigger creation failed).
  if ((props.getProperty(PROP_LAST_RECAP_SENT_DATE) || '') === pending.cycleDate) {
    finish();
    return;
  }

  let sent = 0, failed = 0, nothingToDo = false;
  try {
    const recipients = readRecipients_().filter(function (r) { return r.active && r.email; });
    const recap      = buildRecapFromLog_(pending.cycleDate);
    if (!recipients.length || !recap.sections.length) {
      // No recipients configured, or nothing was ordered this cycle. Neither is
      // a transient failure, so don't burn retries on it.
      nothingToDo = true;
    } else {
      for (const r of recipients) {
        try {
          sendRecapEmail_(r.email, recap.sections, recap.cycleDate, recap.totalItems);
          sent++;
        } catch (e) {
          failed++;
          Logger.log('sendPendingRecap_ send failed for ' + r.email + ': ' + (e.stack || e));
        }
      }
    }
  } catch (e) {
    Logger.log('sendPendingRecap_ error: ' + (e.stack || e));
  }

  if (sent > 0) props.setProperty(PROP_LAST_RECAP_SENT_DATE, pending.cycleDate);

  const attempts = (Number(pending.attempts) || 0) + 1;
  if (sent > 0 || nothingToDo || attempts >= RECAP_SEND_MAX_TRIES) {
    if (!sent && !nothingToDo) {
      Logger.log('sendPendingRecap_ giving up on ' + pending.cycleDate +
                 ' after ' + attempts + ' attempt(s), ' + failed + ' failure(s).');
    }
    finish();
    return;
  }

  // Transient failure — keep the pending record, bump the counter, re-arm.
  props.setProperty(PROP_PENDING_RECAP,
    JSON.stringify({ cycleDate: pending.cycleDate, attempts: attempts }));
  dropRecapTriggers_();
  ScriptApp.newTrigger('sendPendingRecap_').timeBased().after(RECAP_SEND_DELAY_MS).create();
}


function sendRecapEmail_(recipient, sections, cycleDate, totalItems) {
  const props    = PropertiesService.getScriptProperties();
  const location = props.getProperty(PROP_LOCATION) || '';
  const subject  = '[' + location + '] Daily order recap — ' + cycleDate +
                   ' (' + sections.length + ' vendors, ' + totalItems + ' items)';

  // Plain text — copy/paste-friendly, easy to scan from a phone. Mirrors the HTML:
  // "suggested" framing + the "Item × qty (pack)" line order, On Hand trailing.
  let body = 'SUGGESTED DAILY ORDER\n=====================\n\n';
  body += 'Suggested amounts based on today\'s On Hand — review before placing each order.\n\n';
  body += 'Location: ' + location + '\n';
  body += 'Date:     ' + cycleDate + '\n';
  body += 'Vendors:  ' + sections.length + '\n';
  body += 'Items:    ' + totalItems + '\n\n';

  for (const sec of sections) {
    body += '-- ' + sec.vendor.toUpperCase() + ' --\n';
    for (const line of sec.lines) {
      const onHand = (line.onHand === null || line.onHand === '') ? '—' : line.onHand;
      body += '  ' + line.name + ' × ' + line.qty + (line.pack ? ' (' + line.pack + ')' : '');
      body += '   [on hand: ' + onHand + ']\n';
    }
    body += '\n';
  }

  // HTML — brand-aligned recap. Email clients strip <style>/:root/var(), so all
  // colors are inlined as LITERAL hexes. The header band + accents are themed
  // PER STORE CONCEPT via dashTheme_() (MOG_CONCEPT property — same palette as the
  // Sheet dashboard, so email and dashboard stay coordinated):
  //   roll-play → teal-dark #2d8c6b + white · teasnyou → charcoal #1a1a1a + gold
  //   #D4A574 · unset/unknown → navy #1a1a2e + white (matches the modal --brand).
  // dashTheme_() lives in Dashboard.gs but shares global scope at runtime.
  const theme    = (typeof dashTheme_ === 'function')
                     ? dashTheme_()
                     : { accent: '#1a1a2e', bannerFont: '#ffffff' };
  const bandBg   = theme.accent;        // header band background (concept color)
  const bandText = theme.bannerFont;    // band title (white, or TNY charcoal)
  // Sub-line tone that reads on the band: light gray on a dark band, muted dark
  // on a light (e.g. TNY gold) band — picked from the band's luminance.
  let _bandHex = String(bandBg).replace('#', '');
  if (_bandHex.length === 3) _bandHex = _bandHex[0]+_bandHex[0]+_bandHex[1]+_bandHex[1]+_bandHex[2]+_bandHex[2];
  const bandLum  = parseInt(_bandHex.substr(0,2),16)*0.299 + parseInt(_bandHex.substr(2,2),16)*0.587 + parseInt(_bandHex.substr(4,2),16)*0.114;
  const bandSub  = (bandLum > 150) ? '#6b5f43'
                 : (String(bandText).toLowerCase() === '#ffffff') ? '#dcdce6' : '#cfcfcf';
  const headInk  = theme.ink;           // vendor headers + the "× qty" number (dark — reads on white)

  let html = '<div style="font-family:-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif;max-width:640px;margin:0 auto;color:#1f2937">';

  // Header band (store + date + counts) — concept-themed. Single-cell table for
  // client safety (Gmail/iOS render a table-cell background more reliably than a div).
  html += '<table role="presentation" style="width:100%;border-collapse:collapse;margin:0 0 14px">';
  html += '<tr><td style="background:' + bandBg + ';padding:18px 20px;border-radius:8px">';
  html += '<div style="color:' + bandText + ';font-size:22px;font-weight:700;line-height:1.2">' + escapeHtml_(location) + '</div>';
  html += '<div style="color:' + bandText + ';font-size:15px;font-weight:600;margin-top:4px">Suggested daily order</div>';
  html += '<div style="color:' + bandSub + ';font-size:12px;margin-top:6px">' + cycleDate + ' &middot; ' + sections.length + ' vendors &middot; ' + totalItems + ' items</div>';
  html += '</td></tr></table>';

  // Clarity caption — these are SUGGESTED amounts, not a placed order.
  html += '<p style="color:#444;font-size:13px;margin:0 0 18px;line-height:1.45">';
  html += 'Suggested order amounts based on today’s On Hand counts. ';
  html += 'Review each before placing the order through the vendor’s normal channel.';
  html += '</p>';

  for (const sec of sections) {
    html += '<h3 style="color:' + headInk + ';margin:20px 0 6px;font-size:16px;border-bottom:2px solid ' + headInk + ';padding-bottom:6px">' + escapeHtml_(sec.vendor) + '</h3>';
    html += '<table style="width:100%;border-collapse:collapse;font-size:14px">';
    html += '<tr style="background:#f4f5f7">';
    html += '<th style="padding:7px 8px;text-align:left;font-size:11px;letter-spacing:.04em;text-transform:uppercase;color:#888">Suggested order</th>';
    html += '<th style="padding:7px 8px;text-align:right;font-size:11px;letter-spacing:.04em;text-transform:uppercase;color:#aab0b6">On hand</th>';
    html += '</tr>';
    for (const line of sec.lines) {
      const onHand = (line.onHand === null || line.onHand === '') ? '—' : line.onHand;
      // One readable line: "Item Name × 3 (Pack)" — name in body ink, the × qty
      // bold in the concept accent (the action number), pack muted in parens.
      html += '<tr>';
      html += '<td style="padding:9px 8px;border-bottom:1px solid #eef0f2;line-height:1.4">';
      html += '<span style="color:#1f2937">' + escapeHtml_(line.name) + '</span>';
      html += '<strong style="color:' + headInk + ';white-space:nowrap;font-size:15px">&nbsp;&times; ' + line.qty + '</strong>';
      if (line.pack) {
        html += '<span style="color:#9aa0a6;font-size:13px">&nbsp;(' + escapeHtml_(line.pack) + ')</span>';
      }
      html += '</td>';
      html += '<td style="padding:9px 8px;border-bottom:1px solid #eef0f2;text-align:right;color:#aab0b6;font-size:12px;white-space:nowrap">' + onHand + '</td>';
      html += '</tr>';
    }
    html += '</table>';
  }

  html += '<p style="color:#888;font-size:12px;margin-top:22px;border-top:1px solid #e5e7eb;padding-top:12px">';
  html += 'This is a recap of suggested orders. Place each vendor\'s order through their normal channel ';
  html += '(portal, app, phone, email). Order History will populate when reset runs tomorrow.';
  html += '</p>';
  html += '</div>';

  // No CC anymore — each recipient gets their own individual email.
  // The recipient list is configured in SETUP AB-AE and read by
  // api_emailRecap_, which calls this helper once per active recipient.
  MailApp.sendEmail({
    to:       recipient,
    subject:  subject,
    body:     body,
    htmlBody: html,
    name:     'Master Ordering Guide'
  });
}


// Editor-run only (NOT menu-wired): sends the current cycle's recap to whoever
// runs it — Session.getActiveUser() — bypassing the configured recipient list,
// the once-per-day dedupe flag, and the On-Hand clear. Use it to preview the
// email design without emailing the real recipients. Throws a clear message if
// there's nothing to recap (no vendor has items to order right now).
// Editor-only companion to test_recapEmailToSelf, for the ASYNC path: rebuilds a
// cycle's recap from LOG_ORDERS (exactly what sendPendingRecap_ does) and emails
// it ONLY to whoever runs this. Verifies buildRecapFromLog_ against real store
// data without touching the recipient list, the dedupe flag, or on-hand.
//
// Works AFTER a reset has cleared on-hand — that's the point, and it's why this
// exists alongside test_recapEmailToSelf, which needs live counts. Defaults to
// the most recent logged cycle so it can be Run straight from the editor with no
// arguments; pass 'yyyy-MM-dd' to target a specific one. Not menu-wired.
function test_recapFromLogToSelf(orderDate) {
  const me = Session.getActiveUser().getEmail();
  if (!me) throw new Error('Could not resolve your email from Session.getActiveUser().');

  let date = String(orderDate || '').trim();
  if (!date) {
    // Most recent logged cycle. getOrderHistory sorts date-desc, so row 0 wins.
    const all = getOrderHistory({ vendorFilter: 'ALL' }, { needPack: false });
    if (!all.length) throw new Error('LOG_ORDERS is empty — nothing to rebuild.');
    date = all[0].orderDate;
  }

  const recap = buildRecapFromLog_(date);
  if (!recap.sections.length) {
    throw new Error('No logged rows for ' + date + ' — nothing to rebuild. ' +
                    'Check Order History for a date that has orders.');
  }
  sendRecapEmail_(me, recap.sections, recap.cycleDate, recap.totalItems);
  Logger.log('Log-derived recap for ' + date + ' sent to ' + me + ' — ' +
             recap.sections.length + ' vendors, ' + recap.totalItems + ' items.');
  return { cycleDate: date, vendorCount: recap.sections.length,
           itemCount: recap.totalItems, sentTo: me };
}


function test_recapEmailToSelf() {
  const me = Session.getActiveUser().getEmail();
  if (!me) throw new Error('Could not resolve your email from Session.getActiveUser().');
  const recap = buildRecapSections_(null);
  if (!recap.sections.length) {
    throw new Error('Nothing to recap — no vendor has items to order right now. ' +
                    'Enter some On Hand counts first, then re-run.');
  }
  sendRecapEmail_(me, recap.sections, recap.cycleDate, recap.totalItems);
  Logger.log('Test recap sent to ' + me + ' — ' + recap.sections.length +
             ' vendors, ' + recap.totalItems + ' items (' + recap.cycleDate + ').');
}


function escapeHtml_(s) {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}


/***********************
 * 4b) RECIPIENTS — server-side email list in SETUP columns AB-AE
 *
 * Layout (one row per recipient, rows 2+):
 *   AB: Name          (string)
 *   AC: Email         (string)
 *   AD: Active        (TRUE/FALSE — whether they receive recaps)
 *   AE: GM            (TRUE/FALSE — when TRUE, the row is read-only from
 *                      the PWA. KMs can see the row but cannot edit,
 *                      toggle, or remove it. Setting GM=TRUE requires
 *                      editing the spreadsheet directly.)
 *
 * GM lock is enforced server-side in api_saveRecipients_: incoming
 * payloads are checked against the on-sheet GM rows, and any save that
 * would mutate or remove a GM row is rejected. New rows are coerced to
 * GM=FALSE regardless of what the client sends.
 ***********************/

function readRecipients_() {
  // Returns [{name, email, active, gm}] from SETUP AB-AE, rows 2+.
  //
  // Uses backward value-scan in column AB to find the last non-empty
  // row instead of getLastRow(), which can over-report due to formatting
  // or empty cells with data validation. Same pattern as readVendorMultipliers_.
  const setup = getSheet_(SHEET_SETUP);
  const maxRows = setup.getMaxRows();
  if (maxRows < RECIPIENTS_START_ROW) return [];

  const scanRows = maxRows - RECIPIENTS_START_ROW + 1;
  const nameCol = setup.getRange(RECIPIENTS_START_ROW, RECIPIENTS_START_COL, scanRows, 1).getValues();
  let lastIdx = -1;
  for (let i = nameCol.length - 1; i >= 0; i--) {
    if (String(nameCol[i][0] || '').trim()) { lastIdx = i; break; }
  }
  if (lastIdx < 0) return [];

  const numRows = lastIdx + 1;
  const values = setup
    .getRange(RECIPIENTS_START_ROW, RECIPIENTS_START_COL, numRows, RECIPIENTS_NUM_COLS)
    .getValues();
  const out = [];
  for (let i = 0; i < numRows; i++) {
    const name  = String(values[i][0] || '').trim();
    const email = String(values[i][1] || '').trim();
    // Skip blank rows in the middle — same as how readVendorMultipliers_
    // silently drops empty rows. Caller doesn't need to see structural gaps.
    if (!name && !email) continue;
    out.push({
      name:   name,
      email:  email,
      active: values[i][2] === true,
      gm:     values[i][3] === true
    });
  }
  return out;
}


function writeRecipients_(recipients) {
  // Atomic clear-then-write of the recipients block. Caller is
  // responsible for GM-preservation and coercing new rows to gm=false —
  // this helper just writes the array it receives.
  const setup = getSheet_(SHEET_SETUP);
  const maxRows = setup.getMaxRows();

  // Clear the entire AB-AE block from row 2 down. Keeps the sheet from
  // accumulating stale rows if the new list is shorter than the old one.
  if (maxRows >= RECIPIENTS_START_ROW) {
    setup
      .getRange(RECIPIENTS_START_ROW, RECIPIENTS_START_COL,
                maxRows - RECIPIENTS_START_ROW + 1, RECIPIENTS_NUM_COLS)
      .clearContent();
  }

  if (!recipients.length) return;
  const rows = recipients.map(r => [
    String(r.name || '').trim(),
    String(r.email || '').trim(),
    r.active === true,
    r.gm === true
  ]);
  setup
    .getRange(RECIPIENTS_START_ROW, RECIPIENTS_START_COL, rows.length, RECIPIENTS_NUM_COLS)
    .setValues(rows);
}


function ensureRecipientsHeader_() {
  // Idempotent: writes the AB-AE header row if absent. Called lazily at
  // the top of every recipient-related action so existing stores don't
  // need to re-run setupMobileApi to pick up the header.
  const setup = getSheet_(SHEET_SETUP);
  const headerVals = setup
    .getRange(RECIPIENTS_HEADER_ROW, RECIPIENTS_START_COL, 1, RECIPIENTS_NUM_COLS)
    .getValues()[0];
  if (headerVals.every(v => !String(v || '').trim())) {
    setup
      .getRange(RECIPIENTS_HEADER_ROW, RECIPIENTS_START_COL, 1, RECIPIENTS_NUM_COLS)
      .setValues([['Recipient Name', 'Recipient Email', 'Active', 'GM']]);
  }
}


function migrateGmEmailToRecipients_() {
  // One-time migration: if PROP_GM_EMAIL is set AND the recipients list
  // is empty, seed the legacy GM address as recipient #1 with
  // GM=TRUE, Active=TRUE. After seeding, future reads return the
  // recipient row and this branch is no-op'd (length > 0).
  //
  // PROP_GM_EMAIL is preserved (not deleted) so any code that still
  // reads it during a transition window stays safe. Future cleanup
  // can drop the property entirely.
  const props = PropertiesService.getScriptProperties();
  const gmEmail = (props.getProperty(PROP_GM_EMAIL) || '').trim();
  if (!gmEmail) return;
  const existing = readRecipients_();
  if (existing.length) return;
  writeRecipients_([{
    name:   'GM',
    email:  gmEmail,
    active: true,
    gm:     true
  }]);
}


function api_getRecipients_() {
  // Returns the full recipients list as { recipients: [...] }. Includes
  // both active and inactive entries so the PWA can render the toggle
  // state correctly. GM rows are flagged for the client to render with
  // a lock icon and no edit controls.
  ensureRecipientsHeader_();
  migrateGmEmailToRecipients_();
  return { recipients: readRecipients_() };
}


function api_saveRecipients_(payload) {
  // Writes the full recipients list to SETUP AB-AE atomically.
  //
  // Server-side GM-lock enforcement:
  //   1. Read current state from the sheet.
  //   2. For every existing GM row, find a match in the incoming payload
  //      by case-insensitive email. Reject the save if:
  //         - The GM row is missing entirely (KM tried to delete it)
  //         - The name or active flag differs from the sheet (mutation)
  //         - The incoming gm flag is anything but TRUE (demotion attempt)
  //   3. For every new (non-GM-matching) row, force gm=false regardless
  //      of what the client sent. There's no path to promote-via-PWA.
  //
  // Email shape validated per non-empty row; duplicates rejected with a
  // clear error. Blank rows silently dropped.
  ensureRecipientsHeader_();
  const incoming = (payload && Array.isArray(payload.recipients)) ? payload.recipients : [];

  const existing = readRecipients_();
  const existingGms = existing.filter(r => r.gm);
  const incomingByEmail = new Map();
  for (const r of incoming) {
    const key = String(r.email || '').trim().toLowerCase();
    if (key) incomingByEmail.set(key, r);
  }

  for (const gm of existingGms) {
    const key = gm.email.toLowerCase();
    const match = incomingByEmail.get(key);
    if (!match) {
      throw new Error('Cannot remove GM recipient "' + gm.name +
        '". GM rows are managed in the spreadsheet only.');
    }
    if (String(match.name || '').trim() !== gm.name ||
        match.active !== gm.active ||
        match.gm !== true) {
      throw new Error('Cannot modify GM recipient "' + gm.name +
        '". GM rows are managed in the spreadsheet only.');
    }
  }

  // Build sanitized list. Preserve existing GMs (already validated above)
  // and force gm=false on everything else. Validate non-empty rows.
  const sanitized = [];
  const seenEmails = new Set();
  for (const r of incoming) {
    const name  = String(r.name || '').trim();
    const email = String(r.email || '').trim();
    if (!name && !email) continue;
    if (!name)  throw new Error('Recipient is missing a name.');
    if (!email) throw new Error('Recipient "' + name + '" is missing an email.');
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      throw new Error('Recipient "' + name + '" has an invalid email: ' + email);
    }
    const key = email.toLowerCase();
    if (seenEmails.has(key)) {
      throw new Error('Duplicate email: ' + email);
    }
    seenEmails.add(key);

    // GM flag: TRUE only if this email is an existing GM on the sheet.
    // Client-side gm=true on a new row is ignored — no promotion path.
    const existingMatch = existing.find(e => e.email.toLowerCase() === key);
    const gmFlag = !!(existingMatch && existingMatch.gm);

    sanitized.push({
      name:   name,
      email:  email,
      active: r.active === true,
      gm:     gmFlag
    });
  }

  writeRecipients_(sanitized);
  return { recipients: sanitized };
}


