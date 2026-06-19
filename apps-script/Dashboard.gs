/************************************************************
 * MOG — HOME dashboard builder + per-concept theming.
 * Split out of OrderGuideScript.gs (god-object split).
 * All .gs files share one global scope; global constants
 * live in Core.gs. Functions here reference them at call time.
 ************************************************************/














/***********************
 * 14) HOME DASHBOARD
 ***********************/




// ── COLORS ───────────────────────────────────────────────────────────────
// Match the Order Guide sidebars: dark navy + mint accents. Beige used
// for the date strip and section headers (matching Prep Sheets Manager).
const DASH_COLORS = {
  NAVY:        "#1a1a2e",
  NAVY_DEEP:   "#0f0f1f",  // section headers
  MINT:        "#7eb8a4",
  MINT_DIM:    "#4a8775",
  WHITE:       "#ffffff",
  TEXT_MUTED:  "rgba(255,255,255,0.55)",
  BEIGE:       "#faf6ed",
  BEIGE_DARK:  "#ede5d0",
  GREEN_OK:    "#1a6b2e",
  RED_STALE:   "#b91c1c",  // bright warning red — reads at a glance
  GRAY_BORDER: "#888888"
};


// Per-concept dashboard branding. `accent` is the background fill that
// replaces DASH_COLORS.NAVY on the banner + tiles (chosen dark enough for
// white text); `bannerFont` is applied to the banner text only (tiles keep
// white text for legibility). Colors mirror the PWA's concept themes so the
// Sheet dashboard matches what KMs see in the app. Static table — identical
// across all stores; the per-store choice comes from the MOG_CONCEPT property.
const CONCEPT_THEMES = {
  'roll-play': { accent: "#2d8c6b", bannerFont: "#ffffff" },  // RP teal-dark + white
  'teasnyou':  { accent: "#1a1a1a", bannerFont: "#D4A574" },  // TNY charcoal + Kintsugi gold
  'default':   { accent: DASH_COLORS.NAVY, bannerFont: DASH_COLORS.WHITE }
};

// Resolves this store's dashboard theme from the MOG_CONCEPT script property
// (set via setupMobileApi / Set Store Concept). Falls back to the default
// navy when unset or unrecognized, so a store with no concept configured
// renders exactly as before. Memoized for the life of one execution.
var _dashThemeCache = null;
function dashTheme_() {
  if (_dashThemeCache) return _dashThemeCache;
  var concept = String(
    PropertiesService.getScriptProperties().getProperty(PROP_CONCEPT) || ""
  ).trim().toLowerCase();
  _dashThemeCache = CONCEPT_THEMES[concept] || CONCEPT_THEMES['default'];
  return _dashThemeCache;
}




// ── PUBLIC ENTRY POINT ───────────────────────────────────────────────────
// Wipes ORDER_ENTRY and rebuilds the HOME dashboard from scratch. Confirm
// dialog up front because this is destructive (existing formulas, formats,
// merges, validations on ORDER_ENTRY rows 1-50 are all replaced). Drawings
// are preserved by Apps Script's clear() so the legacy Reset On Hand
// button drawing survives — user can delete it manually after rebuild.
function buildHomeDashboard() {
  const ui = SpreadsheetApp.getUi();
  const confirm = ui.alert(
    "Rebuild Home Dashboard?",
    "This rewrites the ORDER_ENTRY tab to the new tile-based dashboard.\n\n" +
    "  • Existing values, formats, merges, and validations on rows 1–50 will be replaced.\n" +
    "  • Vendor tabs and other sheets are not touched.\n" +
    "  • Reversible via File → Version History if needed.\n\n" +
    "Continue?",
    ui.ButtonSet.YES_NO
  );
  if (confirm !== ui.Button.YES) return;




  const sh = getSheet_(SHEET_ORDER_ENTRY);




  // === COMPUTE DYNAMIC LAYOUT ===
  // Vendor tile section grows to fit the master vendor list (SETUP!Z).
  // Always shows tiles in groups of 5 per row, minimum 2 rows (10 slots),
  // even if the master list is shorter — keeps layout balanced on small
  // setups. Empty tile slots stay white via conditional formatting and
  // visually disappear into the sheet background.
  const TILES_PER_ROW    = 4;
  const MIN_VENDOR_ROWS  = 2;
  const ROWS_PER_TILE    = 2;   // top row = bold+underlined name, bottom row = plain count
  const vendorCount      = countMasterVendors_();
  const vendorRows       = Math.max(MIN_VENDOR_ROWS, Math.ceil(vendorCount / TILES_PER_ROW));
  const sheetVendorRows  = vendorRows * ROWS_PER_TILE;

  // Section row positions. No spacer between date strip and Reset.
  // Single 8px spacer between each step.
  // Vendor box ends with a thin beige_dark "closing band" row (matching
  // the section header) to give the box a clear bottom edge inside its
  // border, before the 8px spacer to Manage.
  const layout = {
    // STEP 1 — Reset (rows 3–5)
    resetHeaderRow:    3,
    resetStatusRow:    4,
    resetCheckboxRow:  5,
    // 8px spacer at row 6
    // STEP 2 — Vendors
    vendorHeaderRow:   7,
    vendorFirstRow:    8,
    vendorLastRow:     8 + sheetVendorRows - 1,
    vendorClosingRow:  8 + sheetVendorRows,    // beige_dark band, inside the box
    // 8px spacer at vendorClosingRow + 1
    // STEP 3 — Manage
    manageHeaderRow:   8 + sheetVendorRows + 2,
    manageTilesRow:    8 + sheetVendorRows + 3,
    manageCheckboxRow: 8 + sheetVendorRows + 4
  };
  const totalRows = layout.manageCheckboxRow;




  // Preserve the last reset date (AE9) across the rebuild. A rebuild is a
  // layout operation, not a reset, so it must not change the ordering-cycle
  // state. The clear range below wipes AE9, so capture it now and restore it
  // after the layout is rebuilt. Without this the banner goes red on every
  // rebuild AND the daily-reset open trigger would treat the rebuild as a
  // new day and auto-fire a reset + recap email on the next open.
  const preservedResetDate = sh.getRange(DASH.RESET_DATE).getValue();

  // Strip protections (so subsequent writes don't fail) and break any
  // existing merges in the dashboard area before clearing. Use a generous
  // 50-row clear range so we always wipe any prior larger layout.
  sh.getProtections(SpreadsheetApp.ProtectionType.SHEET).forEach(p => p.remove());
  sh.getProtections(SpreadsheetApp.ProtectionType.RANGE).forEach(p => p.remove());
  const clearRange = sh.getRange(1, 1, Math.max(50, totalRows + 5), 35);
  clearRange.breakApart();
  clearRange.clearContent();
  clearRange.clearFormat();
  clearRange.clearDataValidations();
  clearRange.clearNote();
  sh.clearConditionalFormatRules();




  // Column widths: 30 visible cols × 36px = 1080px wide. AE (col 31) is
  // the hidden data backing column.
  for (let c = 1; c <= 30; c++) sh.setColumnWidth(c, 36);
  sh.setColumnWidth(31, 100);
  sh.hideColumns(31);




  // === ROW HEIGHTS ===
  // Layout (no spacer between date strip and Reset; thin 8px spacers
  // between sections, with a double-spacer gap before Manage so it
  // reads as a clear break from the vendor section):
  //   1 banner                      50
  //   2 date strip                  30
  //   STEP 1 — Reset
  //   3 reset section header        40
  //   4 reset status strip          32
  //   5 reset checkbox row          32
  //   6 spacer                       8
  //   STEP 2 — Vendors
  //   7 vendor section header       40
  //   8..vendorLastRow              30/25 (alternating: name/count)
  //   spacer                         8
  //   spacer                         8
  //   STEP 3 — Manage
  //   manage header                 40
  //   manage tiles                  60
  //   manage checkboxes             35
  sh.setRowHeight(1, 50);
  sh.setRowHeight(2, 30);
  sh.setRowHeight(layout.resetHeaderRow, 40);
  sh.setRowHeight(layout.resetStatusRow, 32);
  sh.setRowHeight(layout.resetCheckboxRow, 32);
  sh.setRowHeight(layout.resetCheckboxRow + 1, 8);   // spacer
  sh.setRowHeight(layout.vendorHeaderRow, 40);
  for (let r = layout.vendorFirstRow; r <= layout.vendorLastRow; r++) {
    // Within each tile pair: top row is name (taller, 30px), bottom row
    // is count (shorter, 25px). Pair sums to ~55px.
    const isTopRow = ((r - layout.vendorFirstRow) % 2 === 0);
    sh.setRowHeight(r, isTopRow ? 30 : 25);
  }
  sh.setRowHeight(layout.vendorClosingRow, 25);     // closing beige band, sized like a count row
  sh.setRowHeight(layout.vendorClosingRow + 1, 8);  // spacer between vendor and manage
  sh.setRowHeight(layout.manageHeaderRow, 40);
  sh.setRowHeight(layout.manageTilesRow, 60);
  sh.setRowHeight(layout.manageCheckboxRow, 35);




  // Hide gridlines for cleaner tile appearance.
  sh.setHiddenGridlines(true);




  // === SECTION BORDERS ===
  // Each step is a clearly bounded box — full perimeter border in a dark
  // color. Spacer rows between steps stay borderless so the boxes float
  // on the sheet background with visible breathing room between them.
  const borderColor = "#444444";
  const step1Range = sh.getRange(
    "A" + layout.resetHeaderRow + ":AD" + layout.resetCheckboxRow
  );
  const step2Range = sh.getRange(
    "A" + layout.vendorHeaderRow + ":AD" + layout.vendorClosingRow
  );
  const step3Range = sh.getRange(
    "A" + layout.manageHeaderRow + ":AD" + layout.manageCheckboxRow
  );
  [step1Range, step2Range, step3Range].forEach(rng => {
    rng.setBorder(
      true, true, true, true, false, false,  // top, left, bottom, right, vert, horiz
      borderColor, SpreadsheetApp.BorderStyle.SOLID_MEDIUM
    );
  });




  // === HIDDEN DATA BACKING (column AE) ===
  sh.getRange(DASH.DATE_FORMULA).setFormula("=TODAY()").setNumberFormat("yyyy-mm-dd");

  // AE3 = day-of-week of TODAY (Mon/Tue/...). Vendor tab H2 formulas use
  // this for their multiplier column lookup.
  //
  // IMPORTANT design note: the multiplier columns in SETUP (S:Y) represent
  // the day the ORDER IS PLACED, not the delivery day. So if today is Wed
  // and Wed's column has a 1, that means "order this item on Wed" (which
  // implicitly is for whatever delivery cycle that vendor runs on).
  //
  // Order day comes from the LAST RESET DATE (AE9), not today (AE2). This
  // keeps the active ordering cycle locked to whatever day was last reset
  // until the user resets again. Without this, midnight rollover would
  // silently switch every vendor's multipliers to the new day before
  // yesterday's order was actually placed and logged. Falls back to today
  // when AE9 is blank (fresh setup, never reset yet).
  // IMPORTANT design note: the multiplier columns in SETUP (S:Y) represent
  // the day the ORDER IS PLACED, not the delivery day. So if today is Wed
  // and Wed's column has a 1, that means "order this item on Wed" (which
  // implicitly is for whatever delivery cycle that vendor runs on).
  //
  // Order day comes from the LAST RESET DATE (AE9), not today (AE2). This
  // keeps the active ordering cycle locked to whatever day was last reset
  // until the user resets again. Without this, midnight rollover would
  // silently switch every vendor's multipliers to the new day before
  // yesterday's order was actually placed and logged. Falls back to today
  // when AE9 is blank (fresh setup, never reset yet).
  sh.getRange(DASH.ORDER_DAY).setFormula(
    '=TEXT(IF(' + DASH.RESET_DATE + '="", ' + DASH.DATE_FORMULA + ', ' + DASH.RESET_DATE + '), "ddd")'
  );

  // AE9 (RESET_DATE) starts blank; resetOnHandAllVendors writes to it.
  // Used only by the Reset On Hand status strip's conditional formatting.
  sh.getRange(DASH.RESET_DATE).setNumberFormat("yyyy-mm-dd");

  // Restore the pre-rebuild reset date so the banner keeps its true color
  // (green if already reset today) and the daily-reset open trigger doesn't
  // see a rebuild as a new day. Only restore a real date — a blank/invalid
  // value means "never reset," which should correctly stay blank (red).
  if (preservedResetDate instanceof Date && !isNaN(preservedResetDate.getTime())) {
    sh.getRange(DASH.RESET_DATE).setValue(preservedResetDate);
  }




  // === BUILD SECTIONS ===
  // Order matches the daily workflow: reset first, then enter on-hand counts
  // by visiting today's vendors, then admin functions if needed.
  buildHomeBanner_(sh);
  buildHomeDateStrip_(sh);
  buildHomeResetTile_(sh, layout);
  buildHomeVendorTiles_(sh, layout);
  buildHomeQuickActions_(sh, layout);
  buildHomeConditionalFormatting_(sh, layout);




  // === PERSIST DYNAMIC LAYOUT POSITIONS ===
  // The dashboard's edit dispatcher (handleDashboardEdit_) needs to know
  // which row holds the manage-section checkboxes — that row depends on
  // the dynamic vendor count. Save it now so dispatching works after
  // build completes.
  PropertiesService.getDocumentProperties()
    .setProperty(DASH.MANAGE_ROW_PROP, String(layout.manageCheckboxRow));




  // === SYNC VENDOR TABS ===
  // The legacy vendor-tab H2 formula referenced ORDER_ENTRY!$B$4 (override)
  // and ORDER_ENTRY!$D$2 (day) — both addresses are now swallowed by merged
  // ranges in the new layout. Rewrite every vendor tab's H2 to point at the
  // new authoritative cells (AD2 for override, AE3 for today's day-of-week).
  const vendorSync = updateVendorTabHeader2Formulas_();




  // === INSTALL EDIT TRIGGER ===
  // Quick-action checkboxes need to open sidebars, which simple onEdit
  // triggers cannot do. An installable trigger handles them with full auth.
  // First call may surface an authorization prompt.
  let triggerStatus = "already installed";
  try {
    const result = ensureDashboardEditTrigger_();
    triggerStatus = result.created ? "installed (you may need to authorize)" : "already installed";
  } catch (err) {
    triggerStatus = "FAILED — " + err.message + " (try running buildHomeDashboard from the script editor once to grant permissions)";
  }




  // === INSTALL DAILY-RESET OPEN TRIGGER ===
  // Auto-runs the reset (log + recap email + clear) the first time the
  // Sheet is opened on a new day. Must be installable so it can send email.
  // First call may surface an authorization prompt.
  let resetTriggerStatus = "already installed";
  try {
    const result = ensureDailyResetTrigger_();
    resetTriggerStatus = result.created ? "installed (you may need to authorize)" : "already installed";
  } catch (err) {
    resetTriggerStatus = "FAILED — " + err.message + " (try running buildHomeDashboard from the script editor once to grant permissions)";
  }




  ui.alert(
    "Dashboard built ✓",
    "The HOME dashboard is ready on the ORDER_ENTRY tab.\n\n" +
    "Vendor tabs synced:\n" +
    "  • " + vendorSync.updated + " vendor tab(s) updated to read the new override and delivery-day cells.\n" +
    (vendorSync.skipped > 0 ? "  • " + vendorSync.skipped + " vendor name(s) had no matching tab — skipped.\n" : "") +
    (vendorSync.errors.length > 0 ? "  • Errors: " + vendorSync.errors.join("; ") + "\n" : "") +
    "\nDashboard edit trigger: " + triggerStatus + "\n" +
    "Daily-reset open trigger: " + resetTriggerStatus + "\n" +
    "\nWhat to do next:\n" +
    "  • If you have an old Reset On Hand button drawing, you can delete it — the new Reset tile replaces it.\n" +
    "  • Tap any Quick Action checkbox to open that sidebar.\n" +
    "  • Tap the Reset On Hand checkbox to clear vendor on-hand counts (with confirm).\n" +
    "  • Toggle Emergency Override to set every vendor to 1× and show all vendors regardless of delivery schedule.",
    ui.ButtonSet.OK
  );
}




// ── ROW 1: BANNER ────────────────────────────────────────────────────────
function buildHomeBanner_(sh) {
  // Store name comes from the per-store MOG_LOCATION_NAME property (set via
  // setupMobileApi), uppercased. Falls back to a neutral title if unset so a
  // freshly-copied store never stamps the wrong name. Colors come from the
  // concept theme (default navy when no concept is configured).
  const location = String(
    PropertiesService.getScriptProperties().getProperty(PROP_LOCATION) || ""
  ).trim();
  const title = location ? "ORDERING GUIDE  ·  " + location.toUpperCase() : "ORDERING GUIDE";
  const theme = dashTheme_();
  const banner = sh.getRange("A1:AD1");
  banner.merge()
    .setValue(title)
    .setBackground(theme.accent)
    .setFontColor(theme.bannerFont)
    .setFontFamily("Arial")
    .setFontSize(15)
    .setFontWeight("bold")
    .setHorizontalAlignment("center")
    .setVerticalAlignment("middle");
}




// ── ROW 2: DATE STRIP ────────────────────────────────────────────────────
function buildHomeDateStrip_(sh) {
  // Strip background spans the full row.
  sh.getRange("A2:AD2").setBackground(DASH_COLORS.BEIGE);

  const labelStyle = { color: "#555", size: 10, weight: "normal", align: "right" };
  const valueStyle = { color: DASH_COLORS.NAVY, size: 12, weight: "bold", align: "left" };

  // Today's date (left). The "ddd" prefix already includes the day name,
  // so no separate Day/Día field is needed.
  applyHomeStripCell_(sh, "A2:F2",  "📅  Date / Fecha:",            labelStyle);
  applyHomeStripCell_(sh, "G2:O2",  '=TEXT(AE2, "dddd, mmm d, yyyy")', valueStyle, true);

  // Emergency override (right) — visible checkbox styled as a warning-only
  // control (bold red label + yellow-cream bg) so it doesn't look like a
  // normal toggle. Auto-clears when reset fires (see resetOnHandAllVendors)
  // and on first-open of a new day (see resetEmergencyOverrideOnOpen_).
  const warnLabelStyle = { color: "#a02020", size: 10, weight: "bold", align: "right" };
  applyHomeStripCell_(sh, "P2:AC2", "⚠  EMERGENCY OVERRIDE  /  Anulación:", warnLabelStyle);
  sh.getRange("P2:AC2").setBackground("#fff4d6");

  sh.getRange("AD2")
    .insertCheckboxes()
    .setValue(false)
    .setBackground("#fff4d6")
    .setHorizontalAlignment("center")
    .setVerticalAlignment("middle");
}

function applyHomeStripCell_(sh, range, valueOrFormula, style, isFormula) {
  const r = sh.getRange(range).merge()
    .setBackground(DASH_COLORS.BEIGE)
    .setFontFamily("Arial")
    .setFontColor(style.color)
    .setFontSize(style.size)
    .setFontWeight(style.weight)
    .setHorizontalAlignment(style.align)
    .setVerticalAlignment("middle");
  if (isFormula) r.setFormula(valueOrFormula);
  else r.setValue(valueOrFormula);
}




// ── MANAGE SECTION (header + tiles + checkboxes, dynamic rows) ───────────
// Position depends on how many vendor tile rows precede us. Header gets
// the ③ step badge. Tile columns are static (A:E, F:J, K:O, P:T, U:Y,
// Z:AD); checkbox cells are at column letters from QUICK_ACTION_COLUMNS.
function buildHomeQuickActions_(sh, layout) {
  const headerRow   = layout.manageHeaderRow;
  const tilesRow    = layout.manageTilesRow;
  const checkboxRow = layout.manageCheckboxRow;

  // Section header.
  buildSectionHeader_(sh, "A" + headerRow + ":AD" + headerRow,
    "③  MANAGE  —  Tap a box to open a tool",
    "ADMINISTRAR  —  Marca para abrir una herramienta");

  // Six tiles (5 cols each × 6 = 30 cols).
  const tileSpec = [
    { range: "A"+tilesRow+":E"+tilesRow,   en: "Manage Items",      es: "Artículos"        },
    { range: "F"+tilesRow+":J"+tilesRow,   en: "Manage Vendors",    es: "Proveedores"      },
    { range: "K"+tilesRow+":O"+tilesRow,   en: "Manage Pick Path",  es: "Ruta de Picking"  },
    { range: "P"+tilesRow+":T"+tilesRow,   en: "Storage Areas",     es: "Áreas"            },
    { range: "U"+tilesRow+":Y"+tilesRow,   en: "Order History",     es: "Historial"        },
    { range: "Z"+tilesRow+":AD"+tilesRow,  en: "How To Use",        es: "Cómo Usar"        }
  ];
  tileSpec.forEach(t => buildHomeTile_(sh, t.range, t.en, t.es, dashTheme_().accent));

  // Six checkbox cells matching tile widths. Each merged range contains a
  // single checkbox at its top-left cell. Top-left col letters match
  // DASH.QUICK_ACTION_COLUMNS, which is what the dispatch handler reads.
  const checkboxRanges = [
    "A"+checkboxRow+":E"+checkboxRow,
    "F"+checkboxRow+":J"+checkboxRow,
    "K"+checkboxRow+":O"+checkboxRow,
    "P"+checkboxRow+":T"+checkboxRow,
    "U"+checkboxRow+":Y"+checkboxRow,
    "Z"+checkboxRow+":AD"+checkboxRow
  ];
  checkboxRanges.forEach(r => {
    sh.getRange(r).merge()
      .setBackground(DASH_COLORS.BEIGE)
      .setHorizontalAlignment("center")
      .setVerticalAlignment("middle")
      .insertCheckboxes()
      .setValue(false);
  });
}




// ── Section header: beige-dark band with stacked bilingual rich text ─────
// Renders a section divider with EN line on top (navy, bold, 12pt) and
// ES line below (mint dim, italic, 10pt). Used for QUICK ACTIONS, RESET
// ON HAND, and TODAY'S VENDORS section dividers.
function buildSectionHeader_(sh, range, enText, esText) {
  sh.getRange(range).merge()
    .setBackground(DASH_COLORS.BEIGE_DARK)
    .setHorizontalAlignment("center")
    .setVerticalAlignment("middle")
    .setWrap(true);

  const text    = enText + "\n" + esText;
  const enEnd   = enText.length;
  const esStart = enEnd + 1;
  const esEnd   = esStart + esText.length;

  const enStyle = SpreadsheetApp.newTextStyle()
    .setForegroundColor(DASH_COLORS.NAVY)
    .setFontFamily("Arial")
    .setFontSize(12)
    .setBold(true)
    .build();
  const esStyle = SpreadsheetApp.newTextStyle()
    .setForegroundColor(DASH_COLORS.MINT_DIM)
    .setFontFamily("Arial")
    .setFontSize(10)
    .setBold(false)
    .setItalic(true)
    .build();

  const richText = SpreadsheetApp.newRichTextValue()
    .setText(text)
    .setTextStyle(0, enEnd, enStyle)
    .setTextStyle(esStart, esEnd, esStyle)
    .build();

  const topLeft = range.split(":")[0];
  sh.getRange(topLeft).setRichTextValue(richText);
}




// ── Single quick-action tile ─────────────────────────────────────────────
// Renders a tile with two stacked text styles in one merged cell:
//   line 1 — English label, white, 12pt bold
//   line 2 — Spanish label, mint, 10pt regular
// Achieved via Apps Script rich-text builder. Static text only — formula-
// driven tiles (Reset, vendors) use uniform styling instead since rich text
// doesn't apply to formula results.
function buildHomeTile_(sh, range, enText, esText, bgColor) {
  const merged = sh.getRange(range).merge()
    .setBackground(bgColor)
    .setFontFamily("Arial")
    .setHorizontalAlignment("center")
    .setVerticalAlignment("middle")
    .setWrap(true);

  const text    = enText + "\n" + esText;
  const enEnd   = enText.length;
  const esStart = enEnd + 1;            // skip the newline
  const esEnd   = esStart + esText.length;

  const enStyle = SpreadsheetApp.newTextStyle()
    .setForegroundColor(DASH_COLORS.WHITE)
    .setFontFamily("Arial")
    .setFontSize(12)
    .setBold(true)
    .build();
  const esStyle = SpreadsheetApp.newTextStyle()
    .setForegroundColor(DASH_COLORS.MINT)
    .setFontFamily("Arial")
    .setFontSize(10)
    .setBold(false)
    .build();

  const richText = SpreadsheetApp.newRichTextValue()
    .setText(text)
    .setTextStyle(0, enEnd, enStyle)
    .setTextStyle(esStart, esEnd, esStyle)
    .build();

  // Rich text writes to the top-left cell of the merged range.
  const topLeft = range.split(":")[0];
  sh.getRange(topLeft).setRichTextValue(richText);
}




// ── STEP 1: RESET ON HAND ────────────────────────────────────────────────
// Three rows: section header → status strip → checkbox row.
// (The redundant "Reset On Hand · Reiniciar En Stock" title tile was
// dropped — the header above and status strip below already carry the
// section's identity.)
function buildHomeResetTile_(sh, layout) {
  const headerRow   = layout.resetHeaderRow;
  const statusRow   = layout.resetStatusRow;
  const checkboxRow = layout.resetCheckboxRow;

  // Row N — section header with step ① badge.
  buildSectionHeader_(sh, "A" + headerRow + ":AD" + headerRow,
    "①  RESET ON HAND  —  Start here every day",
    "REINICIAR EN STOCK  —  Empieza aquí cada día");

  // Row N+1 — status strip. Conditional formatting flips this green when
  // today's reset is logged, red when empty or stale. INT(AE9) strips
  // any time component from the stored date.
  sh.getRange("A" + statusRow + ":AD" + statusRow).merge()
    .setFormula(
      '=IF(' + DASH.RESET_DATE + '="", ' +
        '"⚠  NOT RESET YET  —  Tap the box below to begin  ·  No reiniciado — Marca para empezar", ' +
        'IF(INT(' + DASH.RESET_DATE + ')=TODAY(), ' +
          '"✓  Reset complete:  " & TEXT(' + DASH.RESET_DATE + ', "ddd, mmm d, yyyy") & "  ·  Reinicio completo para hoy", ' +
          '"⚠  STALE  —  Last reset:  " & TEXT(' + DASH.RESET_DATE + ', "ddd, mmm d") & "  —  Reset for today\'s order  ·  Reinicia para hoy"' +
        ')' +
      ')'
    )
    .setBackground(dashTheme_().accent)
    .setFontColor(DASH_COLORS.WHITE)
    .setFontFamily("Arial")
    .setFontSize(11)
    .setFontWeight("bold")
    .setHorizontalAlignment("center")
    .setVerticalAlignment("middle");

  // Row N+2 — checkbox row with arrow labels framing the single-column
  // checkbox at O{checkboxRow} (DASH.RESET_CHECKBOX is a static "O7" in
  // the config; with the row pinned to checkboxRow, the dispatch handler
  // reads the same address).
  sh.getRange("A" + checkboxRow + ":N" + checkboxRow).merge()
    .setValue("Tap to confirm reset  →")
    .setBackground(DASH_COLORS.BEIGE)
    .setFontColor(DASH_COLORS.MINT_DIM)
    .setFontFamily("Arial")
    .setFontSize(11)
    .setFontWeight("bold")
    .setHorizontalAlignment("right")
    .setVerticalAlignment("middle");

  sh.getRange(DASH.RESET_CHECKBOX)
    .insertCheckboxes()
    .setValue(false)
    .setBackground(DASH_COLORS.BEIGE)
    .setHorizontalAlignment("center")
    .setVerticalAlignment("middle");

  sh.getRange("P" + checkboxRow + ":AD" + checkboxRow).merge()
    .setValue("←  Marca para confirmar")
    .setBackground(DASH_COLORS.BEIGE)
    .setFontColor(DASH_COLORS.MINT_DIM)
    .setFontFamily("Arial")
    .setFontSize(11)
    .setFontWeight("bold")
    .setHorizontalAlignment("left")
    .setVerticalAlignment("middle");
}




// ── VENDOR SECTION (header + dynamic-count tile rows) ────────────────────
// Header row, then `vendorRowCount` rows of 5 tiles each. Tile count scales
// with the master vendor list — minimum 10 slots (2 rows), grows in groups
// of 5 as more vendors are registered. Empty slots stay white via CF.
function buildHomeVendorTiles_(sh, layout) {
  const headerRow    = layout.vendorHeaderRow;
  const firstRow     = layout.vendorFirstRow;
  const lastRow      = layout.vendorLastRow;
  const headerRange  = "A" + headerRow + ":AD" + headerRow;

  // Section header. Day name already shows in the date strip above, so we
  // don't repeat it here. Two short bilingual lines.
  sh.getRange(headerRange).merge()
    .setFormula(
      '=IF(' + DASH.EMERGENCY_OVERRIDE + '=TRUE, ' +
        '"②  ALL VENDORS  —  Emergency Override active" & CHAR(10) & "TODOS LOS PROVEEDORES  —  Anulación activa", ' +
        '"②  TODAY\'S VENDORS  —  Tap a tile to enter on-hand counts" & CHAR(10) & ' +
        '"PROVEEDORES DE HOY  —  Toca una tarjeta para ingresar conteos")'
    )
    .setBackground(DASH_COLORS.BEIGE_DARK)
    .setFontColor(DASH_COLORS.NAVY)
    .setFontFamily("Arial")
    .setFontSize(11)
    .setFontWeight("bold")
    .setHorizontalAlignment("center")
    .setVerticalAlignment("middle")
    .setWrap(true);

  // Hidden FILTER spill — drives the tiles below. If override is on, show
  // all non-empty vendors from SETUP!Z; otherwise filter by today's
  // multiplier column.
  sh.getRange(DASH.VENDOR_FILTER_START).setFormula(
    '=IFERROR(' +
      'IF(' + DASH.EMERGENCY_OVERRIDE + '=TRUE, ' +
        'FILTER(SETUP!Z2:Z, SETUP!Z2:Z<>""), ' +
        'FILTER(SETUP!R2:R, ' +
          'INDEX(SETUP!S2:Y,, MATCH(' + DASH.ORDER_DAY + ', SETUP!S1:Y1, 0)) > 0)' +
      '), "")'
  );

  // Tile spec: 4 tiles per row, each spanning 7 columns (B:H, I:O, P:V,
  // W:AC), with 1-column visual margins at A and AD. Each tile occupies
  // TWO sheet rows (top = name, bottom = count) so we can style each
  // line independently.
  const tileSpans = [["B","H"], ["I","O"], ["P","V"], ["W","AC"]];

  // Start aeRow at the row of VENDOR_FILTER_START (AE100), since that's
  // where the spill output begins. Each tile in layout order reads one
  // sequential AE row — first tile = AE100, second = AE101, etc.
  const filterStartRow = parseInt(DASH.VENDOR_FILTER_START.replace(/[A-Z]/g, ""), 10);
  let aeRow = filterStartRow;
  // Iterate tile-pairs (each pair = 2 sheet rows). step = 2.
  for (let r = firstRow; r <= lastRow; r += 2) {
    const nameRow  = r;
    const countRow = r + 1;

    // Margin cells on both rows of the pair — match section header band.
    sh.getRange("A" + nameRow).setBackground(DASH_COLORS.BEIGE_DARK);
    sh.getRange("AD" + nameRow).setBackground(DASH_COLORS.BEIGE_DARK);
    sh.getRange("A" + countRow).setBackground(DASH_COLORS.BEIGE_DARK);
    sh.getRange("AD" + countRow).setBackground(DASH_COLORS.BEIGE_DARK);

    tileSpans.forEach(span => {
      const nameRange  = span[0] + nameRow  + ":" + span[1] + nameRow;
      const countRange = span[0] + countRow + ":" + span[1] + countRow;
      const sourceCell = "AE" + aeRow;
      buildVendorTilePair_(sh, nameRange, countRange, sourceCell);
      aeRow++;
    });
  }

  // Closing band — a beige_dark row inside the vendor box's bottom border.
  // Gives the section a clean visual close before the spacer to Manage.
  sh.getRange("A" + layout.vendorClosingRow + ":AD" + layout.vendorClosingRow)
    .setBackground(DASH_COLORS.BEIGE_DARK);
}




// ── Single vendor tile: 2 cells stacked (name on top, count below) ───────
// Top cell:
//   HYPERLINK formula → vendor name. Bold weight + auto-underlined as a
//   link. Clicking jumps to the vendor's tab.
// Bottom cell:
//   Plain formula → "X / Y entered" where X = COUNT of column E (numeric
//   on-hand entries; treats 0 as entered) and Y = COUNT of column D (Par
//   column — only true item rows have a numeric par). Plain weight, no
//   underline, not clickable (informational).
//
// Both cells start with white background. Conditional formatting in
// buildHomeConditionalFormatting_ flips bg to navy when there's a vendor
// in the slot. Empty slots stay white and disappear into the sheet bg.
function buildVendorTilePair_(sh, nameRange, countRange, sourceCell) {
  // Top cell: vendor name as a bold, underlined hyperlink to its tab.
  // Default bg is WHITE — empty tiles blend into the white tile field.
  // CF flips it to navy when populated.
  const nameFormula =
    '=IF(' + sourceCell + '="", "", ' +
      'HYPERLINK("#gid=" & SHEETGID(' + sourceCell + '), ' + sourceCell + ')' +
    ')';
  sh.getRange(nameRange).merge()
    .setFormula(nameFormula)
    .setBackground(DASH_COLORS.WHITE)
    .setFontColor(DASH_COLORS.WHITE)
    .setFontFamily("Arial")
    .setFontSize(12)
    .setFontWeight("bold")
    .setHorizontalAlignment("center")
    .setVerticalAlignment("middle");

  // Bottom cell: plain "X / Y entered" count. Same default bg as the name.
  const countFormula =
    '=IF(' + sourceCell + '="", "", ' +
      'IFERROR(COUNT(INDIRECT("\'" & ' + sourceCell + ' & "\'!E3:E1000")), 0) & ' +
      '" / " & ' +
      'IFERROR(COUNT(INDIRECT("\'" & ' + sourceCell + ' & "\'!D3:D1000")), 0) & ' +
      '" entered"' +
    ')';
  sh.getRange(countRange).merge()
    .setFormula(countFormula)
    .setBackground(DASH_COLORS.WHITE)
    .setFontColor(DASH_COLORS.WHITE)
    .setFontFamily("Arial")
    .setFontSize(11)
    .setFontWeight("normal")
    .setFontLine("none")
    .setHorizontalAlignment("center")
    .setVerticalAlignment("middle");
}




// ── Conditional formatting ───────────────────────────────────────────────
// Two independent CF zones:
//
// 1) Reset STATUS STRIP (row 6, inside the step-1 section):
//      GREEN  — last reset = today (ready to order)
//      RED    — last reset is empty OR < today (NOT ready: must reset first)
//    Rule order matters: green is checked first, so today's match wins.
//    INT(AE9) strips any time component (resetOnHand writes via new Date()
//    which can include hours/minutes; raw equality vs TODAY() would fail).
//
// 2) Vendor tile zone (layout.vendorFirstRow..vendorLastRow):
//      NAVY   — cell has a vendor (formula resolved to non-empty string)
//      WHITE  — cell empty (default fill); blends into sheet background
//    This is what makes empty vendor slots disappear instead of showing
//    as a navy band when fewer vendors fire today than the layout reserves.
function buildHomeConditionalFormatting_(sh, layout) {
  const statusRange = sh.getRange(
    "A" + layout.resetStatusRow + ":AD" + layout.resetStatusRow
  );
  const vendorRange = sh.getRange(
    "B" + layout.vendorFirstRow + ":AC" + layout.vendorLastRow
  );

  const greenRule = SpreadsheetApp.newConditionalFormatRule()
    .whenFormulaSatisfied('=INT($AE$9)=TODAY()')
    .setBackground(DASH_COLORS.GREEN_OK)
    .setFontColor(DASH_COLORS.WHITE)
    .setRanges([statusRange])
    .build();

  const redRule = SpreadsheetApp.newConditionalFormatRule()
    .whenFormulaSatisfied('=OR($AE$9="", INT($AE$9)<>TODAY())')
    .setBackground(DASH_COLORS.RED_STALE)
    .setFontColor(DASH_COLORS.WHITE)
    .setRanges([statusRange])
    .build();

  // Vendor tile fill — navy when populated. The "Cell is not empty"
  // condition fires when the merged tile's formula resolves to non-empty
  // text (i.e. there's a vendor in this slot). Cells whose source AE row
  // is empty stay at the default BEIGE_DARK background, blending into
  // the section header band so empty tile-pairs disappear into the frame.
  const vendorPopulatedRule = SpreadsheetApp.newConditionalFormatRule()
    .whenCellNotEmpty()
    .setBackground(dashTheme_().accent)
    .setFontColor(DASH_COLORS.WHITE)
    .setRanges([vendorRange])
    .build();

  const rules = sh.getConditionalFormatRules();
  rules.push(greenRule, redRule, vendorPopulatedRule);
  sh.setConditionalFormatRules(rules);
}
