/***********************
 * ADMIN + TESTS
 *
 * Run-once-per-location setup/config functions and the editor-run test
 * functions. Extracted verbatim from MOGApi.gs on 2026-07-24 (audit item
 * #24, pure code-motion). All .gs files share one flat global scope.
 ***********************/

/***********************
 * 5) ADMIN — RUN ONCE PER LOCATION
 ***********************/

function setupMobileApi() {
  const ui = SpreadsheetApp.getUi();
  const props = PropertiesService.getScriptProperties();

  const pinResp = ui.prompt(
    'Mobile API Setup — 1 of 6',
    'Enter a 4–8 digit PIN for this location.\n\n' +
    'KMs and managers will use this PIN to access the mobile app for this location only.',
    ui.ButtonSet.OK_CANCEL);
  if (pinResp.getSelectedButton() !== ui.Button.OK) return;
  const pin = pinResp.getResponseText().trim();
  if (!/^\d{4,8}$/.test(pin)) { ui.alert('PIN must be 4–8 digits.'); return; }

  const locResp = ui.prompt(
    'Mobile API Setup — 2 of 6',
    'Enter the location name (shown in the app).\n\nExample: Roll Play Rosslyn',
    ui.ButtonSet.OK_CANCEL);
  if (locResp.getSelectedButton() !== ui.Button.OK) return;
  const location = locResp.getResponseText().trim();
  if (!location) { ui.alert('Location name is required.'); return; }

  const abbrResp = ui.prompt(
    'Mobile API Setup — 3 of 6',
    'Enter a 2–5 letter abbreviation (used in order references).\n\nExample: RPR for Roll Play Rosslyn',
    ui.ButtonSet.OK_CANCEL);
  if (abbrResp.getSelectedButton() !== ui.Button.OK) return;
  const abbr = abbrResp.getResponseText().trim().toUpperCase();
  if (!/^[A-Z]{2,5}$/.test(abbr)) { ui.alert('Abbreviation must be 2–5 letters.'); return; }

  const conceptResp = ui.prompt(
    'Mobile API Setup — 4 of 6',
    'Enter this store\'s concept for home-dashboard branding:\n\n' +
    '  1 = Roll Play\n' +
    '  2 = Teas\'n You\n\n' +
    'Leave blank to skip (dashboard stays the default navy).',
    ui.ButtonSet.OK_CANCEL);
  if (conceptResp.getSelectedButton() !== ui.Button.OK) return;
  const conceptInput = conceptResp.getResponseText().trim();
  const concept = conceptInput === '1' ? 'roll-play'
                : conceptInput === '2' ? 'teasnyou'
                : '';
  if (conceptInput && !concept) { ui.alert('Enter 1, 2, or leave blank.'); return; }

  const gmResp = ui.prompt(
    'Mobile API Setup — 5 of 6',
    'Enter the GM email — seeded as the first locked recipient on the daily order email list.\n\n' +
    'You can add more recipients later via the app (Settings → Recipients) or directly in SETUP columns AB-AE.\n\n' +
    'Leave blank to skip.',
    ui.ButtonSet.OK_CANCEL);
  if (gmResp.getSelectedButton() !== ui.Button.OK) return;
  const gmEmail = gmResp.getResponseText().trim();

  const masterResp = ui.prompt(
    'Mobile API Setup — 6 of 6',
    'Optional: enter the multi-unit manager master PIN (4–8 digits).\n\n' +
    'Managers who know this code can access this location through the\n' +
    'hub in "manager mode" without typing the store PIN.\n\n' +
    'Leave blank to skip — only this location\'s store PIN will work.',
    ui.ButtonSet.OK_CANCEL);
  if (masterResp.getSelectedButton() !== ui.Button.OK) return;
  const masterPin = masterResp.getResponseText().trim();
  if (masterPin && !/^\d{4,8}$/.test(masterPin)) {
    ui.alert('Master PIN must be 4–8 digits, or blank.'); return;
  }

  props.setProperty(PROP_PIN, pin);
  props.setProperty(PROP_LOCATION, location);
  props.setProperty(PROP_LOCATION_ABBR, abbr);
  props.setProperty(PROP_GM_EMAIL, gmEmail);
  if (concept) props.setProperty(PROP_CONCEPT, concept);
  else         props.deleteProperty(PROP_CONCEPT);
  if (masterPin) props.setProperty(PROP_MASTER_PIN, masterPin);
  else           props.deleteProperty(PROP_MASTER_PIN);

  ui.alert(
    'Setup complete',
    'PIN:          ' + pin + '\n' +
    'Master PIN:   ' + (masterPin ? '****' + masterPin.slice(-1) : '(none)') + '\n' +
    'Location:     ' + location + ' (' + abbr + ')\n' +
    'Concept:      ' + (concept || '(none — default navy)') + '\n' +
    'GM email:     ' + (gmEmail || '(none)') + '\n\n' +
    'NEXT STEPS:\n' +
    '1. Add vendor cutoff times via Ordering Guide menu →\n' +
    '   Manage Vendors (Add tab or View All inline editor).\n' +
    '2. Deploy:\n' +
    '   • First deploy:  Deploy → New deployment ("Web app",\n' +
    '                    Execute as: Me, Who has access: Anyone).\n' +
    '   • Re-deploys:    Deploy → Manage deployments → edit ✏️ →\n' +
    '                    Version: New version. This keeps the URL\n' +
    '                    stable so KMs\' offline drafts and caches\n' +
    '                    keep working.\n' +
    '3. Copy the deployment URL into the mobile app config\n' +
    '   (stores.json + run build.py).\n' +
    '4. Test: visit the URL in a browser — should return JSON.\n\n' +
    'EMAIL RECIPIENTS:\n' +
    'The GM email above is seeded as a locked recipient on first run.\n' +
    'Add more recipients via Settings → Recipients in the app, or by\n' +
    'editing SETUP columns AB-AE directly. GM rows (column AE = TRUE)\n' +
    'are read-only from the app and can only be changed in the sheet.\n\n' +
    'TO UPDATE INDIVIDUAL FIELDS LATER:\n' +
    '• GM email →   Ordering Guide → Mobile API → Set GM Email\n' +
    '• Master PIN → Ordering Guide → Mobile API → Set Master PIN\n' +
    '• Concept →    Ordering Guide → Mobile API → Set Store Concept\n' +
    '• Full re-run → Ordering Guide → Mobile API → Setup',
    ui.ButtonSet.OK
  );
}


function setMasterPin() {
  // Set or rotate the multi-unit manager master PIN without re-running
  // the full setup wizard. Master PIN is OPTIONAL — clearing it (entering
  // blank) leaves only the location's store PIN active.
  const ui = SpreadsheetApp.getUi();
  const props = PropertiesService.getScriptProperties();
  const current = props.getProperty(PROP_MASTER_PIN);

  const resp = ui.prompt(
    'Set Master PIN',
    'Enter the multi-unit manager master PIN (4–8 digits).\n\n' +
    'Current: ' + (current ? '****' + current.slice(-1) : '(none)') + '\n\n' +
    'This code lets managers access this location through the hub\n' +
    'in "manager mode" without the location\'s store PIN.\n\n' +
    'Leave blank to remove the master PIN.',
    ui.ButtonSet.OK_CANCEL);
  if (resp.getSelectedButton() !== ui.Button.OK) return;
  const masterPin = resp.getResponseText().trim();
  if (masterPin && !/^\d{4,8}$/.test(masterPin)) {
    ui.alert('Master PIN must be 4–8 digits, or blank.'); return;
  }
  if (masterPin) {
    props.setProperty(PROP_MASTER_PIN, masterPin);
    ui.alert('Master PIN set: ****' + masterPin.slice(-1));
  } else {
    props.deleteProperty(PROP_MASTER_PIN);
    ui.alert('Master PIN removed.');
  }
}


function setStoreConcept() {
  // Set or clear this store's concept for home-dashboard branding without
  // re-running the full setup wizard. The dashboard reads PROP_CONCEPT on
  // rebuild (buildHomeDashboard → dashTheme_); unset → default navy palette.
  const ui = SpreadsheetApp.getUi();
  const props = PropertiesService.getScriptProperties();
  const current = props.getProperty(PROP_CONCEPT) || '(none — default navy)';

  const resp = ui.prompt(
    'Set Store Concept',
    'Current: ' + current + '\n\n' +
    'Enter this store\'s concept for home-dashboard branding:\n\n' +
    '  1 = Roll Play\n' +
    '  2 = Teas\'n You\n\n' +
    'Leave blank to clear (dashboard reverts to the default navy).',
    ui.ButtonSet.OK_CANCEL);
  if (resp.getSelectedButton() !== ui.Button.OK) return;
  const input = resp.getResponseText().trim();
  const concept = input === '1' ? 'roll-play'
                : input === '2' ? 'teasnyou'
                : '';
  if (input && !concept) { ui.alert('Enter 1, 2, or leave blank.'); return; }

  if (concept) props.setProperty(PROP_CONCEPT, concept);
  else         props.deleteProperty(PROP_CONCEPT);
  ui.alert(
    'Store concept ' + (concept ? 'set to "' + concept + '"' : 'cleared') + '.\n\n' +
    'Run Ordering Guide → 🏠 Rebuild Home Dashboard to apply the branding.');
}


function setGmEmail() {
  // Set or update the GM email. Maintains both:
  //   1. PROP_GM_EMAIL (legacy property — kept for any code that still reads it)
  //   2. The locked GM row in SETUP recipients (column AE = TRUE)
  //
  // Behavior:
  //   - Empty input + no existing GM row    → no-op
  //   - Empty input + existing GM row(s)    → remove all GM-flagged rows
  //   - Non-empty input + no existing GM row → add new GM row (Active=TRUE)
  //   - Non-empty input + existing GM row(s) → replace the first GM row's
  //     email; preserve name and active state. Other GM rows untouched.
  //
  // GM rows are visible-but-locked from the PWA, so this admin entry
  // point is the supported way to rotate the GM email without editing
  // SETUP directly.
  const ui = SpreadsheetApp.getUi();
  const props = PropertiesService.getScriptProperties();
  const current = props.getProperty(PROP_GM_EMAIL);

  const resp = ui.prompt(
    'Set GM Email',
    'Enter the GM email — locked recipient on the daily order email list.\n\n' +
    'Current: ' + (current || '(none)') + '\n\n' +
    'Leave blank to remove the GM recipient row entirely.',
    ui.ButtonSet.OK_CANCEL);
  if (resp.getSelectedButton() !== ui.Button.OK) return;
  const gmEmail = resp.getResponseText().trim();

  // Shape check only — we look for an @ with non-empty local and
  // domain halves and at least one dot in the domain. Google rejects
  // truly malformed addresses at send time anyway, so we don't bother
  // with full RFC validation here.
  if (gmEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(gmEmail)) {
    ui.alert('Email must contain @ and a domain, or be blank.'); return;
  }

  // Ensure header row exists before reading/writing the recipients block.
  ensureRecipientsHeader_();
  const recipients = readRecipients_();
  let gmIdx = recipients.findIndex(r => r.gm);

  if (!gmEmail) {
    // Clear path: drop the property and remove every GM row.
    props.deleteProperty(PROP_GM_EMAIL);
    const remaining = recipients.filter(r => !r.gm);
    writeRecipients_(remaining);
    ui.alert('GM email removed.');
    return;
  }

  // Set path: update property and the GM row in recipients.
  props.setProperty(PROP_GM_EMAIL, gmEmail);
  if (gmIdx < 0) {
    // No GM row exists yet — add one as a locked recipient.
    recipients.push({ name: 'GM', email: gmEmail, active: true, gm: true });
  } else {
    // Update the first GM row's email; preserve everything else.
    recipients[gmIdx] = {
      name:   recipients[gmIdx].name || 'GM',
      email:  gmEmail,
      active: recipients[gmIdx].active,
      gm:     true
    };
  }
  writeRecipients_(recipients);
  ui.alert('GM email set: ' + gmEmail);
}


function showMobileApiStatus() {
  const props = PropertiesService.getScriptProperties();
  const ui = SpreadsheetApp.getUi();
  // Read recipients count for the status dialog. Read errors fall back to
  // a question mark so a missing SETUP sheet doesn't break the status view.
  let recipientLine;
  try {
    ensureRecipientsHeader_();
    migrateGmEmailToRecipients_();
    const recs = readRecipients_();
    const active = recs.filter(r => r.active && r.email).length;
    const gms = recs.filter(r => r.gm).length;
    recipientLine = recs.length + ' total · ' + active + ' active · ' + gms + ' GM';
  } catch (e) {
    recipientLine = '(error reading: ' + (e.message || e) + ')';
  }
  ui.alert(
    'Mobile API Status',
    'Version:      ' + API_VERSION + '\n' +
    'Location:     ' + (props.getProperty(PROP_LOCATION) || '(not set)') + '\n' +
    'Abbreviation: ' + (props.getProperty(PROP_LOCATION_ABBR) || '(not set)') + '\n' +
    'PIN:          ' + (props.getProperty(PROP_PIN) ? '****' + props.getProperty(PROP_PIN).slice(-1) : '(not set)') + '\n' +
    'Master PIN:   ' + (props.getProperty(PROP_MASTER_PIN) ? '****' + props.getProperty(PROP_MASTER_PIN).slice(-1) : '(none)') + '\n' +
    'GM email:     ' + (props.getProperty(PROP_GM_EMAIL) || '(none)') + '\n' +
    'Recipients:   ' + recipientLine + '\n' +
    'Last sent:    ' + (props.getProperty(PROP_LAST_RECAP_SENT_DATE) || '(never)') + '\n\n' +
    'PIN failures: ' + (props.getProperty(PROP_PIN_FAIL_COUNT) || '0') + ' / ' + PIN_MAX_ATTEMPTS + '\n' +
    'Lockout:      ' + (function() {
      const until = parseInt(props.getProperty(PROP_PIN_LOCKOUT_UNTIL) || '0', 10);
      if (!until) return '(none)';
      const remaining = until - Date.now();
      if (remaining <= 0) return '(expired — clears on next request)';
      const mins = Math.ceil(remaining / 60000);
      return 'LOCKED for ~' + mins + ' more minute(s)';
    })() + '\n\n' +
    'Vendor meta entries: ' + Object.keys(VENDOR_META).length,
    ui.ButtonSet.OK
  );
}


// UI-free core — shared by the Sheet menu wrapper (below) and the web
// health-check fix (runHealthFix 'clear_lockout'). Returns { cleared }.
function clearPinLockout_core_() {
  const props = PropertiesService.getScriptProperties();
  const had = !!(props.getProperty(PROP_PIN_FAIL_COUNT) ||
                 props.getProperty(PROP_PIN_LOCKOUT_UNTIL));
  if (had) {
    props.deleteProperty(PROP_PIN_FAIL_COUNT);
    props.deleteProperty(PROP_PIN_LOCKOUT_UNTIL);
  }
  return { cleared: had };
}

function clearPinLockout() {
  // Manual unlock — for when a legitimate manager gets locked out and
  // can't wait 5 minutes, or when testing. Wired into the Mobile API
  // menu in Core.gs.
  const ui = SpreadsheetApp.getUi();
  const r  = clearPinLockout_core_();
  ui.alert(r.cleared
    ? 'PIN lockout cleared. Next attempt starts a fresh counter.'
    : 'No lockout active. Failure counter is already clear.');
}


function clearMobileApiConfig() {
  const ui = SpreadsheetApp.getUi();
  const resp = ui.alert('Clear Mobile API Config',
    'This UN-CONFIGURES this store — it removes the PIN, master PIN, location, ' +
    'store code, concept, GM email, and recap-sent state, so the first-run setup ' +
    'wizard runs again. Handy for reusing the test template.\n\n' +
    'Items, vendors, storage areas, and order history are NOT touched, and the ' +
    'recipients block in SETUP remains (edit it in the sheet if needed).\n\n' +
    'Do NOT run this on a live store. Continue?',
    ui.ButtonSet.YES_NO);
  if (resp !== ui.Button.YES) return;
  const props = PropertiesService.getScriptProperties();
  props.deleteProperty(PROP_PIN);
  props.deleteProperty(PROP_MASTER_PIN);
  props.deleteProperty(PROP_LOCATION);
  props.deleteProperty(PROP_LOCATION_ABBR);
  props.deleteProperty(PROP_GM_EMAIL);
  props.deleteProperty(PROP_CONCEPT);            // so the re-themed wizard starts neutral
  props.deleteProperty(PROP_LAST_RECAP_SENT_DATE);
  // Also wipe the rate-limit state — fresh deployment should never
  // start with a stale lockout window from a previous tenant of the
  // script properties.
  props.deleteProperty(PROP_PIN_FAIL_COUNT);
  props.deleteProperty(PROP_PIN_LOCKOUT_UNTIL);
  ui.alert('Cleared',
    'This store is now unconfigured. Open its /exec URL to run the first-run ' +
    'setup wizard (or use Setup / Re-run Setup from this menu).');
}


/***********************
 * 6) TEST FUNCTIONS — run these from the script editor to verify the API
 *
 * To use:
 *   1. Pick a test function from the dropdown at the top of the editor
 *   2. Click Run
 *   3. View the output: View → Logs (or Cmd/Ctrl+Enter)
 *
 * These call the action handlers directly (not through doPost), which lets
 * you test logic without dealing with HTTP, PINs, or curl.
 ***********************/

function test_ping() {
  const result = api_ping_();
  Logger.log('--- test_ping ---');
  Logger.log(JSON.stringify(result, null, 2));
}


function test_getDashboard() {
  Logger.log('--- test_getDashboard ---');
  try {
    const result = api_getDashboard_();
    Logger.log('Date: ' + result.date + ' (' + result.dayOfWeek + ')');
    Logger.log('Location: ' + result.location);
    Logger.log('Vendors today: ' + result.vendors.length);
    Logger.log('');
    for (const v of result.vendors) {
      Logger.log(
        '  ' + v.name +
        ' — ' + v.itemCount + ' items' +
        ' — cutoff: ' + (v.cutoffTime || 'none') +
        ' — status: ' + v.status +
        (v.toOrderCount != null ? ' (' + v.toOrderCount + ' to order)' : '') +
        (v.sentAt ? ' at ' + v.sentAt : '')
      );
    }
    Logger.log('');
    Logger.log('Full JSON:');
    Logger.log(JSON.stringify(result, null, 2));
  } catch (err) {
    Logger.log('ERROR: ' + (err.stack || err));
  }
}


function test_getVendorItems() {
  // Edit this to a real vendor name from your sheet
  const TEST_VENDOR = 'Sysco';

  Logger.log('--- test_getVendorItems for "' + TEST_VENDOR + '" ---');
  try {
    const result = api_getVendorItems_({ vendor: TEST_VENDOR });
    Logger.log('Vendor: ' + result.vendor);
    Logger.log('Cutoff: ' + (result.cutoffTime || 'none'));
    Logger.log('Items: ' + result.items.length);
    Logger.log('');
    for (const it of result.items) {
      Logger.log(
        '  [' + it.storageArea + '] ' + it.name +
        ' (' + it.pack + ') — par ' + it.par +
        ' — on hand: ' + (it.onHand === null ? 'blank' : it.onHand) +
        ' — suggested: ' + (it.suggestedQty === null ? '—' : it.suggestedQty)
      );
    }
  } catch (err) {
    Logger.log('ERROR: ' + (err.stack || err));
  }
}


function test_doPostFlow() {
  // Simulates an actual HTTP POST end-to-end, including PIN check.
  // Useful to confirm the dispatch + auth layer works before testing from
  // the mobile app.
  Logger.log('--- test_doPostFlow ---');

  const pin = PropertiesService.getScriptProperties().getProperty(PROP_PIN);
  if (!pin) {
    Logger.log('No PIN set. Run setupMobileApi() first.');
    return;
  }

  // Test ping
  const fakeEvent1 = {
    postData: { contents: JSON.stringify({ pin: pin, action: 'ping' }) }
  };
  const resp1 = doPost(fakeEvent1);
  Logger.log('ping response: ' + resp1.getContent());

  // Test wrong PIN
  const fakeEvent2 = {
    postData: { contents: JSON.stringify({ pin: '0000', action: 'ping' }) }
  };
  const resp2 = doPost(fakeEvent2);
  Logger.log('bad PIN response: ' + resp2.getContent());

  // Test getDashboard
  const fakeEvent3 = {
    postData: { contents: JSON.stringify({ pin: pin, action: 'getDashboard' }) }
  };
  const resp3 = doPost(fakeEvent3);
  Logger.log('getDashboard response (first 500 chars): ' + resp3.getContent().substring(0, 500));
}



function test_getResetStatus() {
  Logger.log('--- test_getResetStatus ---');
  try {
    const r = api_getResetStatus_();
    Logger.log('today:      ' + r.today);
    Logger.log('lastReset:  ' + (r.lastReset || '(never)'));
    Logger.log('isStale:    ' + r.isStale);
  } catch (err) {
    Logger.log('ERROR: ' + (err.stack || err));
  }
}


function test_commitReset() {
  // ⚠ DESTRUCTIVE on a fresh state — this runs the same logic as the
  // "Reset On Hand" button on the spreadsheet. Snapshots current On Hand
  // values to LOG_ORDERS (if not already logged for today), clears all
  // On Hand columns, and stamps AE9 with today's date.
  //
  // Safe to run on the test sheet copy. Do not run on production data
  // unless you actually want to perform a reset.
  Logger.log('--- test_commitReset ---');
  try {
    const r = api_commitReset_();
    Logger.log('logged:        ' + r.logged);
    Logger.log('rowsLogged:    ' + r.rowsLogged);
    Logger.log('orderDate:     ' + r.orderDate);
    Logger.log('resetDate:     ' + r.resetDate);
    if (r.skippedReason) Logger.log('skippedReason: ' + r.skippedReason);
  } catch (err) {
    Logger.log('ERROR: ' + (err.stack || err));
  }
}


function test_emailRecap() {
  // ⚠ This actually sends an email — to every active recipient configured
  // in SETUP AB-AE. Make sure the recipients list is set up before running.
  // Doesn't write to LOG_ORDERS — recap is read-only / send-only.
  //
  // Passes force=true so this test path always sends, even if today's
  // cycle was already emailed via another path.
  Logger.log('--- test_emailRecap ---');
  try {
    const r = api_emailRecap_({ force: true });
    Logger.log('cycleDate:   ' + r.cycleDate);
    Logger.log('sentCount:   ' + r.sentCount);
    Logger.log('failedCount: ' + r.failedCount);
    Logger.log('vendorCount: ' + r.vendorCount);
    Logger.log('itemCount:   ' + r.itemCount);
    for (const v of r.vendors) {
      Logger.log('  ' + v.vendor + ' — ' + v.itemCount + ' items');
    }
    if (r.failedCount) {
      Logger.log('FAILURES:');
      for (const f of r.failed) {
        Logger.log('  ' + f.email + ' — ' + f.error);
      }
    }
  } catch (err) {
    Logger.log('ERROR: ' + (err.stack || err));
  }
}


function test_getRecipients() {
  // Read-only verification of the recipients list. Useful for confirming
  // the AB-AE layout is intact and the GM seed migration ran correctly.
  Logger.log('--- test_getRecipients ---');
  try {
    const r = api_getRecipients_();
    Logger.log('count: ' + r.recipients.length);
    for (const rec of r.recipients) {
      Logger.log('  ' + (rec.gm ? '[GM] ' : '     ') +
                 (rec.active ? '✓ ' : '  ') +
                 rec.name + ' <' + rec.email + '>');
    }
  } catch (err) {
    Logger.log('ERROR: ' + (err.stack || err));
  }
}