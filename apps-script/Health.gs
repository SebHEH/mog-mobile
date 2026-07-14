/************************************************************
 * MOG — Store Health Check (read-only diagnostic).
 *
 * One roll-up of structural + config integrity for a store: the
 * anti-fragility + new-store onboarding safety net. Aggregates checks that
 * previously lived in scattered tools (config status, vendor-tab structure,
 * H2 multiplier formula, item schema, pick-DB consistency) into a single
 * pass/warn/fail report, and names the existing one-click fix per failure.
 *
 * READ-ONLY — never writes to the sheet or properties.
 *
 * getStoreHealthReport() is client-callable (Sheet via google.script.run,
 * web editor via webedit_call) and returns a host-agnostic structured report
 * that HealthCheck.html renders. Status per check is 'pass' | 'warn' | 'fail'.
 ************************************************************/

function getStoreHealthReport() {
  const ss     = SpreadsheetApp.getActiveSpreadsheet();
  const props  = PropertiesService.getScriptProperties();
  const checks = [];
  // fixId (optional) names a web-actionable repair that runHealthFix() can run;
  // destructive=true makes the web client confirm before running it.
  const add = (id, label, status, detail, fix, fixId, destructive) =>
    checks.push({ id: id, label: label, status: status, detail: detail || '',
                  fix: fix || '', fixId: fixId || '', destructive: !!destructive });

  // ── 1) Store identity / config ──────────────────────────────────────────
  try {
    const pin      = String(props.getProperty(PROP_PIN)      || '').trim();
    const location = String(props.getProperty(PROP_LOCATION) || '').trim();
    if (!pin) {
      add('config_pin', 'Store identity', 'fail',
        "No store PIN is set — the mobile app and web editor can't authenticate.",
        'Run 📱 Mobile API → Setup / Re-run Setup.');
    } else if (!location) {
      add('config_pin', 'Store identity', 'warn',
        'PIN is set but the location name is blank (dashboards and emails show a generic name).',
        'Run 📱 Mobile API → Setup / Re-run Setup.');
    } else {
      add('config_pin', 'Store identity', 'pass', 'PIN set; location: ' + location + '.');
    }
  } catch (e) { add('config_pin', 'Store identity', 'fail', 'Check errored: ' + e.message); }

  // ── 2) Concept theme ────────────────────────────────────────────────────
  try {
    const concept = String(props.getProperty(PROP_CONCEPT) || '').trim();
    if (concept) {
      add('config_concept', 'Concept theme', 'pass', 'Concept: ' + concept + '.');
    } else {
      add('config_concept', 'Concept theme', 'warn',
        'No concept set — the dashboard and editor fall back to the default navy theme.',
        'Run 📱 Mobile API → Set Store Concept.');
    }
  } catch (e) { add('config_concept', 'Concept theme', 'warn', 'Check errored: ' + e.message); }

  // Canonical multiplier formula (used by the template + per-vendor checks).
  const canonicalH2 = (function () {
    try { return String(vendorTabH2Formula_() || '').trim(); } catch (e) { return null; }
  })();

  // ── 3) VENDOR_TEMPLATE present + H2 canonical ───────────────────────────
  try {
    const tmpl = ss.getSheetByName('VENDOR_TEMPLATE');
    if (!tmpl) {
      add('template', 'Vendor template', 'fail',
        'VENDOR_TEMPLATE is missing — adding a vendor would fall back to a fragile copy.',
        'Rebuilds VENDOR_TEMPLATE from a healthy vendor tab.',
        'reestablish_template');
    } else if (canonicalH2 && String(tmpl.getRange('H2').getFormula()).trim() !== canonicalH2) {
      add('template', 'Vendor template', 'fail',
        "VENDOR_TEMPLATE's H2 multiplier formula is stale — new vendors would be born un-orderable.",
        "Rewrites every vendor tab's multiplier formula (and the template's) to the current one.",
        'sync_h2');
    } else {
      add('template', 'Vendor template', 'pass', 'VENDOR_TEMPLATE present with a current H2 formula.');
    }
  } catch (e) { add('template', 'Vendor template', 'fail', 'Check errored: ' + e.message); }

  // ── 4) Per-vendor tabs: present + H2 canonical + item-id (M) formula ────
  try {
    const vendors = getVendorList();
    const missingTab = [], staleH2 = [], noItemFormula = [], badHeader = [];
    vendors.forEach(v => {
      const sh = ss.getSheetByName(v);
      if (!sh) { missingTab.push(v); return; }
      if (canonicalH2 && String(sh.getRange('H2').getFormula()).trim() !== canonicalH2) staleH2.push(v);
      const mF = String(sh.getRange(VENDOR_TAB.DATA_START_ROW, 13).getFormula()).trim();   // M = col 13
      if (!mF) noItemFormula.push(v);
      // B1 (the header) must equal the vendor name: it drives both the H2
      // multiplier match and the M-spine FILTER, so a wrong B1 (e.g. a clone
      // that kept "VENDOR TEMPLATE") shows a count but an empty list.
      if (String(sh.getRange('B1').getValue()).trim() !== String(v).trim()) badHeader.push(v);
    });

    if (missingTab.length) {
      add('vendor_tabs', 'Vendor tabs', 'fail',
        missingTab.length + ' vendor(s) in the list have no order tab: ' + missingTab.join(', ') + '.',
        'Re-add the vendor (Manage Vendors), or run Setup.');
    } else {
      add('vendor_tabs', 'Vendor tabs', 'pass', vendors.length + ' vendor tab(s) present.');
    }

    if (staleH2.length) {
      add('vendor_h2', 'Vendor multiplier formulas', 'fail',
        staleH2.length + ' tab(s) have a stale H2 multiplier formula: ' + staleH2.join(', ') + '.',
        "Rewrites every vendor tab's multiplier formula (and the template's) to the current one.",
        'sync_h2');
    } else if (canonicalH2) {
      add('vendor_h2', 'Vendor multiplier formulas', 'pass', 'All vendor tabs use the current H2 formula.');
    } else {
      add('vendor_h2', 'Vendor multiplier formulas', 'warn',
        'Could not derive the canonical H2 formula to compare against.');
    }

    if (noItemFormula.length) {
      add('vendor_items', 'Vendor item formulas', 'fail',
        noItemFormula.length + " tab(s) are missing the column-M item formula (their items won't appear): " +
        noItemFormula.join(', ') + '.',
        'Re-establish the tab from VENDOR_TEMPLATE (Setup).');
    } else if (vendors.length) {
      add('vendor_items', 'Vendor item formulas', 'pass', 'All vendor tabs resolve their item list.');
    }

    if (badHeader.length) {
      add('vendor_headers', 'Vendor tab headers', 'fail',
        badHeader.length + " tab(s) have a B1 header that doesn't match the vendor name, so the tab shows an " +
        "item count but an empty list: " + badHeader.join(', ') + '.',
        "Sets each of those tabs' B1 header to its vendor name so the items spill in.",
        'fix_vendor_headers');
    } else if (vendors.length) {
      add('vendor_headers', 'Vendor tab headers', 'pass', 'Every vendor tab header (B1) matches its vendor.');
    }
  } catch (e) { add('vendor_tabs', 'Vendor tabs', 'fail', 'Check errored: ' + e.message); }

  // ── 5) MASTER schema: Eligible Vendors (col O) header ───────────────────
  try {
    const sh      = getSheet_(SHEET_MASTER);
    const oHeader = String(sh.getRange(1, COL.ELIGIBLE_VENDORS).getValue() || '').trim();
    if (oHeader.toLowerCase() === 'eligible vendors') {
      add('schema_eligible', 'Item schema', 'pass', 'MASTER_ITEMS column O ("Eligible Vendors") is in place.');
    } else {
      add('schema_eligible', 'Item schema', 'warn',
        'MASTER_ITEMS column O header is "' + oHeader + '" (expected "Eligible Vendors"). ' +
        'Reads self-heal, but the column should be seeded.',
        "Seeds the Eligible Vendors column from each item's active vendor.",
        'migrate_vendors');
    }
  } catch (e) { add('schema_eligible', 'Item schema', 'warn', 'Check errored: ' + e.message); }

  // ── 6) Pick DB ↔ MASTER consistency ─────────────────────────────────────
  try {
    const setup   = getSheet_(SHEET_SETUP);
    const master  = getSheet_(SHEET_MASTER);
    const db       = readPickDb_(setup);
    const lastRow  = master.getLastRow();
    const masterById = new Map();
    if (lastRow >= 2) {
      master.getRange(2, 1, lastRow - 1, COL.ACTIVE).getValues().forEach(r => {
        const id = String(r[COL.ID - 1] || '').trim();
        if (id) masterById.set(id, { active: r[COL.ACTIVE - 1] === true });
      });
    }

    let orphans = 0, inactiveInDb = 0;
    const seenInDb = new Set();
    db.forEach(r => {
      const id = String(r[1] || '').trim();
      if (!id) return;
      seenInDb.add(id);
      const m = masterById.get(id);
      if (!m) orphans++;
      else if (!m.active) inactiveInDb++;
    });
    let unassignedActive = 0;
    masterById.forEach((m, id) => { if (m.active && !seenInDb.has(id)) unassignedActive++; });

    const infoTail = unassignedActive
      ? ' (' + unassignedActive + ' active item(s) have no storage area yet — expected for not-yet-placed items.)'
      : '';
    if (orphans || inactiveInDb) {
      add('pickdb', 'Pick path consistency', 'warn',
        (orphans ? orphans + ' pick-path row(s) reference items no longer in MASTER. ' : '') +
        (inactiveInDb ? inactiveInDb + ' inactive item(s) are still in the pick path. ' : '') + infoTail,
        'Removes orphan/inactive rows from the pick path and rebuilds the vendor tabs.',
        'purge_pickpath', true);
    } else {
      add('pickdb', 'Pick path consistency', 'pass', 'Pick path matches MASTER.' + infoTail);
    }
  } catch (e) { add('pickdb', 'Pick path consistency', 'warn', 'Check errored: ' + e.message); }

  // ── 7) Backup vendor placement (eligible list ↔ pick-path rows) ─────────
  // An item's eligible vendors (MASTER col O) should each have a pick-path
  // row so the item shows on that vendor's tab. Dry-run of the backfill
  // counts what's missing without writing.
  try {
    const r = syncEligibleVendorsToPickPath_core_(true);
    if (r.added) {
      add('backups_placed', 'Backup vendor placement', 'warn',
        r.added + ' eligible placement(s) across ' + r.itemsAffected +
        ' item(s) are not on their vendor tab(s) yet: ' +
        Object.keys(r.byVendor).sort().map(v => v + ' (' + r.byVendor[v] + ')').join(', ') + '.',
        "Places every eligible vendor's items onto its tab. Adds rows only — nothing is removed.",
        'place_backups');
    } else {
      add('backups_placed', 'Backup vendor placement', 'pass',
        'Every eligible vendor is on its tab.');
    }
  } catch (e) { add('backups_placed', 'Backup vendor placement', 'warn', 'Check errored: ' + e.message); }

  // ── 8) PIN lockout ───────────────────────────────────────────────────────
  // Read the raw property (not getPinLockoutState_, which self-heals by
  // deleting expired keys — this report must stay write-free).
  try {
    const until     = parseInt(props.getProperty(PROP_PIN_LOCKOUT_UNTIL) || '0', 10);
    const remaining = until - Date.now();
    if (remaining > 0) {
      add('pin_lockout', 'PIN lockout', 'warn',
        'PIN entry is locked for ~' + Math.ceil(remaining / 60000) +
        ' more minute(s) after repeated failed attempts. It self-clears, or fix now.',
        'Clears the failure counter so the next PIN attempt works immediately.',
        'clear_lockout');
    } else {
      add('pin_lockout', 'PIN lockout', 'pass', 'No active PIN lockout.');
    }
  } catch (e) { add('pin_lockout', 'PIN lockout', 'warn', 'Check errored: ' + e.message); }

  // ── Summary ──────────────────────────────────────────────────────────────
  const summary = { pass: 0, warn: 0, fail: 0 };
  checks.forEach(c => { if (summary[c.status] != null) summary[c.status]++; });

  const tz = ss.getSpreadsheetTimeZone();
  return {
    generatedAt: Utilities.formatDate(new Date(), tz, 'MMM d, yyyy h:mm a'),
    store:       String(props.getProperty(PROP_LOCATION) || '').trim() || 'Not configured',
    summary:     summary,
    checks:      checks
  };
}


// Web-actionable repairs for the health check. ONE client-callable entry point
// (routed through webedit_call, so the web editor can run it PIN-gated) that
// runs a specific fix headlessly and returns { ok, message }. Reuses the same
// UI-free cores the Sheet menu fixers use — no SpreadsheetApp.getUi() (which
// throws in a web-app context). The fixId values match getStoreHealthReport's
// per-check fixId.
function runHealthFix(fixId) {
  const id = String(fixId || '');
  switch (id) {
    case 'sync_h2': {
      const r = updateVendorTabHeader2Formulas_();
      const errs = (r.errors || []);
      return {
        ok: errs.length === 0,
        message: 'Synced the multiplier formula on ' + r.updated + ' vendor tab(s)' +
                 (r.templateUpdated ? ' and the template' : '') +
                 (errs.length ? '. Errors: ' + errs.join('; ') : '.')
      };
    }
    case 'reestablish_template': {
      const r = reestablishVendorTemplate_();
      return {
        ok: true,
        message: r.created
          ? 'Re-established VENDOR_TEMPLATE from "' + r.source + '".'
          : 'VENDOR_TEMPLATE was already present — nothing to do.'
      };
    }
    case 'purge_pickpath': {
      const r = purgeInactiveFromPickPath_core_();
      return {
        ok: true,
        message: r.removed
          ? 'Removed ' + r.removed + ' orphan/inactive row(s) from the pick path.'
          : 'Pick path was already clean — nothing to remove.'
      };
    }
    case 'migrate_vendors': {
      const r = migrateItemVendorsColumn_core_();
      return {
        ok: true,
        message: r.hadRows
          ? 'Seeded the Eligible Vendors column (' + r.changed + ' row(s) updated).'
          : 'Header set; there were no item rows to seed.'
      };
    }
    case 'place_backups': {
      const r = syncEligibleVendorsToPickPath_core_();
      return {
        ok: true,
        message: r.added
          ? 'Placed ' + r.added + ' item–vendor row(s) onto vendor tabs (' +
            r.itemsAffected + ' item(s)). Secondaries are fully orderable.'
          : 'Every eligible vendor already has a pick-path row — nothing to add.'
      };
    }
    case 'clear_lockout': {
      const r = clearPinLockout_core_();
      return {
        ok: true,
        message: r.cleared
          ? 'PIN lockout cleared — the next attempt starts a fresh counter.'
          : 'No lockout was active.'
      };
    }
    case 'fix_vendor_headers': {
      const r = fixVendorHeaders_core_();
      return {
        ok: true,
        message: r.fixed
          ? 'Repaired the B1 header on ' + r.fixed + ' vendor tab(s): ' + r.names.join(', ') +
            '. Their items should now appear.'
          : 'All vendor tab headers already match — nothing to fix.'
      };
    }
    default:
      throw new Error('Unknown fix: ' + id);
  }
}


// Sheet launcher — opens the dual-host HealthCheck modal as a Sheet dialog.
// (The web editor renders the same HealthCheck.html via doGet?page=healthcheck.)
// webBootJson web:false keeps the web bits inert in the dialog.
function showStoreHealthCheck() {
  const tmpl = HtmlService.createTemplateFromFile('HealthCheck');
  tmpl.webBootJson = JSON.stringify({ web: false });
  SpreadsheetApp.getUi().showModalDialog(
    tmpl.evaluate().setWidth(MODAL_SM_W).setHeight(MODAL_SM_H),
    'Store Health Check'
  );
}
