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
 * getStoreHealthReport_() is client-callable (Sheet via google.script.run,
 * web editor via webedit_call) and returns a host-agnostic structured report
 * that HealthCheck.html renders. Status per check is 'pass' | 'warn' | 'fail'.
 ************************************************************/

function getStoreHealthReport_() {
  const ss     = SpreadsheetApp.getActiveSpreadsheet();
  const props  = PropertiesService.getScriptProperties();
  const checks = [];
  // fixId (optional) names a web-actionable repair that runHealthFix_() can run;
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

  // ── 7a) Pick rows in storage areas missing from the list ─────────────────
  // Supabase's catalog tables refuse these, so test_catalogTablesParity fails
  // on them (step 6).
  try {
    const d = findPickAreaDrift_(getSheet_(SHEET_SETUP));
    if (d.missing.length || d.respell.length) {
      const parts = [];
      if (d.missing.length) {
        parts.push('Pick rows use storage areas that are not on the Storage Areas list: ' +
          d.missing.map(m => '"' + m.name + '" (' + m.rows + ' row' + (m.rows === 1 ? '' : 's') + ')').join(', ') +
          '. Phones still show these names, but the areas can\'t be reordered or chosen in the editor.');
      }
      if (d.respell.length) {
        parts.push('Pick rows spell a listed area differently: ' +
          d.respell.map(m => '"' + m.from + '" for "' + m.to + '" (' + m.rows + ')').join(', ') + '.');
      }
      add('pick_areas', 'Storage areas on pick rows', 'warn', parts.join(' '),
        'Adds the missing areas to the end of the Storage Areas list and fixes the spellings. Nothing is removed.',
        'restore_areas');
    } else {
      add('pick_areas', 'Storage areas on pick rows', 'pass', 'Every pick row\'s storage area is on the Storage Areas list.');
    }
  } catch (e) { add('pick_areas', 'Storage areas on pick rows', 'warn', 'Check errored: ' + e.message); }

  // ── 7b) Repeated Item IDs ────────────────────────────────────────────────
  try {
    const plan = planRepeatedItemIds_();
    if (plan.length) {
      add('repeated_ids', 'Repeated Item IDs', 'fail',
        plan.length + ' Item ID(s) are on more than one MASTER_ITEMS row. Phones read the last row but Manage ' +
        'Items edits the first, so edits to these items never reach phones. Planned: ' +
        describeRepeatedIdPlan_(plan).join(' | '),
        'Deletes the extra copies of an item listed twice, and gives a different item sharing an ID its own ' +
        'new ID. Phones keep showing what they show today.',
        'fix_repeated_ids', true);
    } else {
      add('repeated_ids', 'Repeated Item IDs', 'pass', 'Every Item ID is on one MASTER_ITEMS row.');
    }
  } catch (e) { add('repeated_ids', 'Repeated Item IDs', 'warn', 'Check errored: ' + e.message); }

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

  // ── 9) Supabase (migration steps 4-5) ────────────────────────────────────
  // One status read from Supabase (mog_sync_get_status, schema v4) plus this
  // script's triggers. Reads only: nothing here writes to Supabase either.
  try {
    const cfg = supabaseConfig_();
    if (!cfg.connected) {
      add('sb_moved', 'Moved to Supabase', 'warn',
        'Not connected to Supabase: this store counts in the Sheet and every phone screen goes through /exec (~2s each).',
        'Run 📱 Mobile API → Move this store to Supabase.');
    } else {
      if (cfg.switched) {
        add('sb_moved', 'Moved to Supabase', 'pass',
          'Counts, the cycle and the order log live in Supabase (store "' + cfg.slug + '").');
      } else {
        add('sb_moved', 'Moved to Supabase', 'warn',
          'Connected as "' + cfg.slug + '", but counting is back on the Sheet (Switch back to the Sheet was run).',
          'Run 📱 Mobile API → Move this store to Supabase; it switches again without a code.');
      }

      // Triggers belong to a Google account; the web editor runs as the store's owner.
      const nightly = ScriptApp.getProjectTriggers()
        .some(function (t) { return t.getHandlerFunction() === 'nightlyMaintenance_'; });
      if (nightly) {
        add('sb_nightly', 'Nightly 3:30 AM run', 'pass', 'The 3:30 AM cycle close is installed.');
      } else {
        add('sb_nightly', 'Nightly 3:30 AM run', cfg.switched ? 'fail' : 'warn',
          'No 3:30 AM run is installed for the Google account running this check, so cycles close on the ' +
          'first app open instead (14-31s).',
          'Installs the 3:30 AM run under the account that runs the fix (the web editor runs as the store\'s owner).',
          'install_nightly');
      }

      let status = null;
      try {
        status = supabaseSync_('mog_sync_get_status', {});
      } catch (e) {
        add('sb_status', 'Supabase status', 'fail', 'Could not read this store\'s status from Supabase: ' + e.message,
          /HTTP 404/.test(e.message) ? 'Run supabase/schema_v4.sql in the Supabase SQL Editor.'
                                     : 'Check this store\'s connection to Supabase and run the check again.');
      }
      if (status) {
        const direct = status.phoneDirect === true;
        if (cfg.switched && direct) {
          add('sb_phones', 'Phones direct', 'pass', 'Phones read and save straight to Supabase.');
        } else if (cfg.switched) {
          add('sb_phones', 'Phones direct', 'warn',
            'Phones still go through /exec (~2s per screen): their switch in Supabase is off. That is right only ' +
            'if they were turned off on purpose.',
            'Run supabase/phones_direct.sql in the Supabase SQL Editor.');
        } else if (direct) {
          add('sb_phones', 'Phones direct', 'fail',
            'Phones save counts straight to Supabase while this store counts in the Sheet, so their counts never ' +
            'reach it.',
            'In the Supabase SQL Editor: update mog.stores set phone_direct = false where slug = \'' + cfg.slug + '\';');
        } else {
          add('sb_phones', 'Phones direct', 'pass', 'Phones use /exec, matching this store counting in the Sheet.');
        }

        if (status.editorDirect && editorInApp_()) {
          add('sb_catalog', 'Catalog in sync', 'pass',
            'Supabase owns this store\'s catalog: it is edited in the app. This Sheet keeps the catalog it had and ' +
            'is not updated.');
        } else if (status.editorDirect) {
          add('sb_catalog', 'Catalog in sync', 'warn',
            'Supabase owns this store\'s catalog (it is edited in the app), but this Sheet doesn\'t know: its ' +
            'catalog tools still accept edits that never reach the app.',
            'Marks this Sheet so its catalog tools point to the app.', 'mark_editor_in_app');
        } else if (!status.catalog) {
          add('sb_catalog', 'Catalog in sync', 'fail', 'Supabase holds no catalog for this store, so phones can\'t load it.',
            'Pushes this Sheet\'s catalog to Supabase now.', 'push_catalog');
        } else {
          const d = syncDiff_(buildCatalogPayload_(), status.catalog, ['Sheet', 'Supabase']);
          if (!d) {
            add('sb_catalog', 'Catalog in sync', 'pass', 'Phones see the same catalog as this Sheet.');
          } else {
            add('sb_catalog', 'Catalog in sync', 'warn',
              'Phones see a different catalog from this Sheet (first difference: ' + d + '). An edit normally ' +
              'reaches Supabase within a minute.',
              'Pushes this Sheet\'s catalog to Supabase now.', 'push_catalog');
          }
        }
      }
    }
  } catch (e) { add('sb_moved', 'Moved to Supabase', 'warn', 'Check errored: ' + e.message); }

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
// throws in a web-app context). The fixId values match getStoreHealthReport_'s
// per-check fixId.
function runHealthFix_(fixId) {
  const id = String(fixId || '');
  // A store that edits its catalog in the app (Sync.gs editorInApp_): the
  // repairs that change or push the Sheet's catalog would never reach it.
  const CATALOG_FIXES = ['purge_pickpath', 'migrate_vendors', 'place_backups', 'restore_areas', 'fix_repeated_ids', 'push_catalog'];
  if (CATALOG_FIXES.indexOf(id) >= 0 && editorInApp_()) return { ok: false, message: editorMovedMessage_() };
  switch (id) {
    case 'mark_editor_in_app': {
      // Only once Supabase really owns the catalog (schema v8's switch).
      if (!supabaseSync_('mog_sync_get_status', {}).editorDirect) {
        return { ok: false, message: 'Supabase doesn\'t own this store\'s catalog yet. Use 📱 Mobile API → Move the editor to the app.' };
      }
      PropertiesService.getScriptProperties().setProperty(PROP_EDITOR, 'supabase');
      return { ok: true, message: 'This Sheet now points its catalog tools to the app.' };
    }
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
    case 'restore_areas': {
      const r = restorePickAreas_core_();
      const bits = [];
      if (r.added.length) bits.push('added ' + r.added.map(n => '"' + n + '"').join(', ') + ' to the Storage Areas list');
      if (r.respelled) bits.push('fixed the area spelling on ' + r.respelled + ' pick row(s)');
      return {
        ok: true,
        message: bits.length ? 'Done: ' + bits.join('; ') + '.' : 'Every pick row\'s area was already listed — nothing to do.'
      };
    }
    case 'fix_repeated_ids': {
      const r = fixRepeatedItemIds_core_();
      return {
        ok: true,
        message: (r.deleted || r.reIded)
          ? 'Deleted ' + r.deleted + ' extra row(s) and gave ' + r.reIded + ' item(s) a new ID. ' + r.lines.join(' | ')
          : 'Every Item ID was already on one row — nothing to do.'
      };
    }
    case 'push_catalog': {
      if (!supabaseConfig_().connected) return { ok: false, message: 'This store is not connected to Supabase.' };
      const r = pushCatalogNow_();
      return {
        ok: true,
        message: r.applied
          ? 'Pushed this Sheet\'s catalog to Supabase (' + Math.round(r.bytes / 1024) + ' KB).'
          : 'Supabase already holds a newer catalog — nothing changed.'
      };
    }
    case 'install_nightly': {
      const r = ensureNightlyTrigger_();
      return {
        ok: true,
        message: r.created ? 'Installed the 3:30 AM run.' : 'The 3:30 AM run was already installed — nothing to do.'
      };
    }
    default:
      throw new Error('Unknown fix: ' + id);
  }
}


// Sheet launcher — opens the dual-host HealthCheck modal as a Sheet dialog.
// (The web editor renders the same HealthCheck.html via doGet?page=healthcheck.)
// webBootJson web:false keeps the web bits inert in the dialog.
function showStoreHealthCheck_() {
  const tmpl = HtmlService.createTemplateFromFile('HealthCheck');
  tmpl.webBootJson = sheetBootJson_();   // in-Sheet dialog: web bits off, plus its token for webedit_call
  SpreadsheetApp.getUi().showModalDialog(
    tmpl.evaluate().setWidth(MODAL_SM_W).setHeight(MODAL_SM_H),
    'Store Health Check'
  );
}
