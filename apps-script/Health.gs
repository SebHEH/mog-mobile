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
  const add = (id, label, status, detail, fix) =>
    checks.push({ id: id, label: label, status: status, detail: detail || '', fix: fix || '' });

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
        'Run 📱 Mobile API → Setup / Re-run Setup to re-establish it.');
    } else if (canonicalH2 && String(tmpl.getRange('H2').getFormula()).trim() !== canonicalH2) {
      add('template', 'Vendor template', 'fail',
        "VENDOR_TEMPLATE's H2 multiplier formula is stale — new vendors would be born un-orderable.",
        'Run 📱 Mobile API → Sync Vendor Multiplier Formulas.');
    } else {
      add('template', 'Vendor template', 'pass', 'VENDOR_TEMPLATE present with a current H2 formula.');
    }
  } catch (e) { add('template', 'Vendor template', 'fail', 'Check errored: ' + e.message); }

  // ── 4) Per-vendor tabs: present + H2 canonical + item-id (M) formula ────
  try {
    const vendors = getVendorList();
    const missingTab = [], staleH2 = [], noItemFormula = [];
    vendors.forEach(v => {
      const sh = ss.getSheetByName(v);
      if (!sh) { missingTab.push(v); return; }
      if (canonicalH2 && String(sh.getRange('H2').getFormula()).trim() !== canonicalH2) staleH2.push(v);
      const mF = String(sh.getRange(VENDOR_TAB.DATA_START_ROW, 13).getFormula()).trim();   // M = col 13
      if (!mF) noItemFormula.push(v);
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
        'Run 📱 Mobile API → Sync Vendor Multiplier Formulas.');
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
        'Run 📱 Mobile API → Migrate Item Vendors (if present), or Setup.');
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
        'Run Purge Inactive From Pick Path (editor-run) to clean orphan/inactive rows.');
    } else {
      add('pickdb', 'Pick path consistency', 'pass', 'Pick path matches MASTER.' + infoTail);
    }
  } catch (e) { add('pickdb', 'Pick path consistency', 'warn', 'Check errored: ' + e.message); }

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


// Sheet launcher — opens the dual-host HealthCheck modal as a Sheet dialog.
// (The web editor renders the same HealthCheck.html via doGet?page=health;
// Phase B.) webBootJson web:false keeps the web bits inert in the dialog.
function showStoreHealthCheck() {
  const tmpl = HtmlService.createTemplateFromFile('HealthCheck');
  tmpl.webBootJson = JSON.stringify({ web: false });
  SpreadsheetApp.getUi().showModalDialog(
    tmpl.evaluate().setWidth(MODAL_SM_W).setHeight(MODAL_SM_H),
    'Store Health Check'
  );
}
