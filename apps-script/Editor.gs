/************************************************************
 * MOG — KM Editor web app (doGet?page=editor).
 *
 * Delivers the EXISTING Manage Items modal (ManageItems.html) as a
 * computer-only, PIN-gated web app — the same file serves both the
 * in-Sheet dialog and the web page, so feature/behavior parity is by
 * construction (there is no second copy to drift). The web-only bits in
 * ManageItems.html are gated on a MOG_WEB flag injected here; in the
 * Sheet (showManageItemsSidebar_) that flag is false and the modal
 * behaves exactly as it always has.
 *
 * SECURITY — read this. The web app is ANYONE_ANONYMOUS + executeAs
 * USER_DEPLOYING (appsscript.json), so ANY google.script.run call from
 * the served page runs as the OWNER and is reachable by anyone with the
 * /exec URL. A UI-only PIN would be cosmetic. So the web page routes
 * every server call through ONE token-guarded dispatcher, webedit_call,
 * which (1) verifies a server-minted session token and (2) only allows
 * an explicit allowlist of editor functions. Every function it reaches is
 * PRIVATE (ends in _): a public function would be callable from the served
 * page directly, skipping the token (D18). The Sheet dialogs go through the
 * same dispatcher with a token their menu mints.
 *
 * All .gs files share one global scope; constants live in Core.gs and
 * the PIN/lockout helpers live in MOGApi.gs.
 ************************************************************/


// Editor session tokens live in the shared script cache. The token (a UUID)
// is the secret; the cached value records which PIN tier minted it. TTL is
// refreshed on every guarded call (sliding) so an active editing session
// doesn't expire mid-edit, while an idle tab eventually does.
const EDITOR_TOK_PREFIX  = 'edtok_';
const EDITOR_TOK_TTL_SEC = 3600;   // 1 hour, sliding
const SHEET_TOK_TTL_SEC  = 21600;  // a Sheet dialog's token: 6 hours (CacheService's max), sliding


/***********************
 * WEB-APP RENDER
 ***********************/

// This deployment's /exec URL — used to build same-tab (target=_top) links
// between the home dashboard and the editor pages.
function getWebAppUrl_() {
  try { return ScriptApp.getService().getUrl() || ''; } catch (e) { return ''; }
}

// Browser-tab title: "<store name + location> · Master Ordering Guide".
function editorTabTitle_() {
  const store = PropertiesService.getScriptProperties().getProperty(PROP_LOCATION) || 'Store';
  return store + ' · Master Ordering Guide';
}

// Common web context injected into every editor page: branding + store name
// (for the PIN gate) + the base URL (for inter-page links). The session token
// is minted client-side after the PIN and shared across pages via localStorage.
function editorWebBoot_(extra) {
  const props = PropertiesService.getScriptProperties();
  const boot  = {
    web:     true,
    store:   props.getProperty(PROP_LOCATION) || 'Store',
    abbr:    props.getProperty(PROP_LOCATION_ABBR) || '',
    base:    getWebAppUrl_(),
    theme:   dashTheme_(),
    concept: String(props.getProperty(PROP_CONCEPT) || '').trim().toLowerCase()  // a Dashboard.gs CONCEPT_THEMES key, or ''
  };
  if (extra) { for (const k in extra) boot[k] = extra[k]; }
  return JSON.stringify(boot);
}

// ?page=editor — the home dashboard: a card launcher (MVS/MPS-style). Manage
// Items is live; the other cards are placeholders until built.
function renderEditorHome_() {
  const tmpl = HtmlService.createTemplateFromFile('EditorHome');
  tmpl.webBootJson = editorWebBoot_();
  return tmpl.evaluate()
    .setTitle(editorTabTitle_())
    .addMetaTag('viewport', 'width=device-width, initial-scale=1.0')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

// ?page=setup — the first-run store-setup wizard. doGet routes any editor page
// here while MOG_API_PIN is unset (you can't gate on a PIN that doesn't exist
// yet). Identity-only: the form writes the same PropertiesService keys as
// setupMobileApi_ (Admin.gs), minus the master PIN (an owner-menu concern).
function renderStoreSetupWeb_() {
  const tmpl = HtmlService.createTemplateFromFile('Setup');
  tmpl.webBootJson = editorWebBoot_({ setup: true });
  return tmpl.evaluate()
    .setTitle('Store Setup · Master Ordering Guide')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1.0')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

// ?page=items — the EXISTING Manage Items modal served as a web page. Same
// template the Sheet dialog uses, with MOG_WEB=true so the gate + token shim
// engage. Parity is by construction (one file, two hosts).
function renderManageItemsWeb_() {
  const tmpl = HtmlService.createTemplateFromFile('ManageItems');
  tmpl.vendorListJson = JSON.stringify(getVendorList());
  tmpl.webBootJson    = editorWebBoot_();
  return tmpl.evaluate()
    .setTitle(editorTabTitle_())
    .addMetaTag('viewport', 'width=device-width, initial-scale=1.0')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

// ?page=areas — the EXISTING Storage Areas modal served as a web page.
function renderStorageAreasWeb_() {
  const tmpl = HtmlService.createTemplateFromFile('StorageAreas');
  tmpl.areaListJson = JSON.stringify(getStorageAreaList_());
  tmpl.webBootJson  = editorWebBoot_();
  return tmpl.evaluate()
    .setTitle(editorTabTitle_())
    .addMetaTag('viewport', 'width=device-width, initial-scale=1.0')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

// ?page=pickpath — the EXISTING Reorder Pick Path modal served as a web page.
// Mirrors showReorderPickPathSidebar_'s vendor selection + pick-data preload.
function renderReorderPickPathWeb_() {
  const tmpl    = HtmlService.createTemplateFromFile('ReorderPickPath');
  const vendors = getVendorList();
  if (vendors.length) {
    const setup    = getSheet_(SHEET_SETUP);
    const b2Vendor = String(setup.getRange(SETUP_VENDOR_CELL).getDisplayValue()).trim();
    const vendor   = (b2Vendor && vendors.indexOf(b2Vendor) !== -1) ? b2Vendor : vendors[0];
    tmpl.pickDataJson   = JSON.stringify(getPickPathForSidebar_(vendor));
    tmpl.vendorListJson = JSON.stringify(vendors);
  } else {
    tmpl.pickDataJson   = JSON.stringify({});
    tmpl.vendorListJson = JSON.stringify([]);
  }
  tmpl.webBootJson = editorWebBoot_();
  return tmpl.evaluate()
    .setTitle(editorTabTitle_())
    .addMetaTag('viewport', 'width=device-width, initial-scale=1.0')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

// ?page=history — the EXISTING Order History modal served as a web page (read-only).
function renderOrderHistoryWeb_() {
  const tmpl = HtmlService.createTemplateFromFile('OrderHistory');
  tmpl.webBootJson = editorWebBoot_();
  return tmpl.evaluate()
    .setTitle(editorTabTitle_())
    .addMetaTag('viewport', 'width=device-width, initial-scale=1.0')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

// ?page=vendors — the EXISTING Manage Vendors modal served as a web page.
// Same dual-host treatment as Manage Items; injects the same template vars
// the Sheet dialog uses plus the web boot context.
function renderManageVendorsWeb_() {
  const tmpl = HtmlService.createTemplateFromFile('ManageVendors');
  tmpl.vendorListJson  = JSON.stringify(getVendorList());
  tmpl.vendorTableJson = JSON.stringify(getVendorTableData_());
  tmpl.webBootJson     = editorWebBoot_();
  return tmpl.evaluate()
    .setTitle(editorTabTitle_())
    .addMetaTag('viewport', 'width=device-width, initial-scale=1.0')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

// ?page=healthcheck — the Store Health Check served as a web page. Same
// HealthCheck.html the Sheet dialog uses, with MOG_WEB=true so the gate +
// token shim engage. Read-only (report is computed by getStoreHealthReport_).
function renderStoreHealthWeb_() {
  const tmpl = HtmlService.createTemplateFromFile('HealthCheck');
  tmpl.webBootJson = editorWebBoot_();
  return tmpl.evaluate()
    .setTitle(editorTabTitle_())
    .addMetaTag('viewport', 'width=device-width, initial-scale=1.0')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

// A catalog tool's page on a store whose catalog is edited in the app
// (Sync.gs editorInApp_): a link there instead of the tool. No data, so no PIN.
function renderEditorMovedWeb_() {
  const url = appEditorUrl_();
  const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
  const html = '<div style="font:16px/1.5 Inter,Arial,sans-serif;max-width:520px;margin:12vh auto;padding:0 20px;color:#222">' +
    '<h2 style="margin:0 0 10px">The editor is in the app now</h2>' +
    '<p>This store\'s items, vendors, storage areas and lists are edited in the ordering app, on a computer.</p>' +
    '<p><a href="' + esc(url) + '" target="_top" style="font-weight:700">Open the editor</a></p>' +
    '<p style="color:#666;font-size:14px">El editor ahora está en la app. <a href="' + esc(url) + '" target="_top">Abrir el editor</a></p></div>';
  return HtmlService.createHtmlOutput(html)
    .setTitle(editorTabTitle_())
    .addMetaTag('viewport', 'width=device-width, initial-scale=1.0')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}


/***********************
 * EDITOR AUTH (token-backed PIN gate)
 ***********************/

// Client-callable (no trailing underscore). Validates the PIN against this
// store's PIN using the EXISTING doPost machinery — same constant-time
// compare (checkPin_) and same brute-force lockout (MOGApi.gs) — so the
// editor and the PWA share one lockout gate. On success mints a session
// token. Returns:
//   { ok:true,  token, tier }                 — authenticated
//   { ok:false, lockout:true, retryAfterMs }  — locked out
//   { ok:false, error:'Invalid PIN' }         — wrong PIN
function editorAuth(pin) {
  const submitted = String(pin || '');

  const lockout = getPinLockoutState_();
  if (lockout.locked) {
    return { ok: false, lockout: true, retryAfterMs: lockout.retryAfterMs };
  }

  const tier = checkPin_(submitted);   // 'store' | 'master' | null
  if (!tier) {
    const after = recordPinFailure_();
    if (after.locked) {
      return { ok: false, lockout: true, retryAfterMs: after.retryAfterMs };
    }
    return { ok: false, error: 'Invalid PIN' };
  }
  recordPinSuccess_();

  const token = Utilities.getUuid();
  putEditorToken_(token, tier);
  return { ok: true, token: token, tier: tier };
}

// Stores / refreshes a token in the shared script cache (sliding TTL).
function putEditorToken_(token, tier) {
  try {
    CacheService.getScriptCache().put(
      EDITOR_TOK_PREFIX + token,
      String(tier || 'store'),
      tier === 'sheet' ? SHEET_TOK_TTL_SEC : EDITOR_TOK_TTL_SEC
    );
  } catch (e) {
    // Non-fatal at mint time; the next guarded call would just reprompt.
  }
}

// Guard for the dispatcher. Throws SESSION_EXPIRED (the client catches it and
// reprompts for the PIN) when the token is missing, unknown, or expired.
// Refreshes the TTL on success so an active session keeps sliding forward.
function requireEditorToken_(token) {
  const t = String(token || '');
  if (!t) throw new Error('SESSION_EXPIRED');
  let tier = null;
  try {
    tier = CacheService.getScriptCache().get(EDITOR_TOK_PREFIX + t);
  } catch (e) {
    tier = null;
  }
  if (!tier) throw new Error('SESSION_EXPIRED');
  putEditorToken_(t, tier);   // sliding refresh
  return tier;
}

// Lightweight token check for the gate's validate-first flow. Client-callable
// (no trailing underscore, like editorAuth) so the web page can call it via
// plain google.script.run; it is part of the AUTH layer, so it deliberately
// does NOT route through the webedit_call allowlist. Returns {ok} — a token
// flushed by a redeploy (CacheService is volatile across versions) or an
// expired one resolves to {ok:false}, so the gate sends the user to the PIN
// instead of letting a stale session run a tool and brick on the first call.
// Refreshes the TTL on success (via requireEditorToken_) so an active session
// keeps sliding forward just like a real call.
function editorPing(token) {
  try {
    requireEditorToken_(token);
    return { ok: true };
  } catch (e) {
    return { ok: false };
  }
}


/***********************
 * FIRST-RUN STORE SETUP (token-less, one-shot)
 *
 * Client-callable (no trailing underscore) so the setup wizard can reach it
 * via plain google.script.run. It deliberately does NOT route through the
 * webedit_call token dispatcher: on a fresh store there is no PIN yet, so no
 * session token can exist (chicken-and-egg). Its safety is a HARD ONE-SHOT
 * GUARD instead — it runs only while MOG_API_PIN is unset and refuses the
 * moment a PIN exists, so a configured store's /exec can never be re-claimed
 * through it. Writes the SAME identity props as setupMobileApi_ (Admin.gs),
 * minus the master PIN (owner-menu only). The /exec URL is unpublished until
 * setup completes (it enters stores.json afterward), so the open window is an
 * unguessable, self-closing one. On success it mints a session token so the
 * just-configured owner lands on the home dashboard without re-typing the PIN.
 ***********************/
function commitStoreSetup(payload) {
  const props = PropertiesService.getScriptProperties();

  // One-shot: refuse once this store is configured.
  if (props.getProperty(PROP_PIN)) {
    return { ok: false, error: 'alreadyConfigured' };
  }

  const p         = payload || {};
  const pin       = String(p.pin || '').trim();
  const location  = String(p.location || '').trim();
  const abbr      = String(p.abbr || '').trim().toUpperCase();
  const gmEmail   = String(p.gmEmail || '').trim();
  const conceptIn = String(p.concept || '').trim().toLowerCase();
  const concept   = isKnownConcept_(conceptIn) ? conceptIn : '';   // Dashboard.gs CONCEPT_THEMES

  // Server-side validation — mirrors setupMobileApi_'s rules. The `error` field
  // name lets the client focus the offending input.
  // abbr is auto-built by the wizard (CONCEPT + first 2 city letters + full
  // BOH/FOH, e.g. TNYROBOH). Cap is 10 (longest real case TNY/LEI + 2 + BOH = 8).
  if (!/^\d{4,8}$/.test(pin))      return { ok: false, error: 'pin',      message: 'PIN must be 4–8 digits.' };
  if (!location)                   return { ok: false, error: 'location', message: 'Location name is required.' };
  if (!/^[A-Z]{2,10}$/.test(abbr)) return { ok: false, error: 'abbr',     message: 'Store code must be 2–10 letters.' };
  if (conceptIn && !concept)      return { ok: false, error: 'concept',  message: 'Choose a concept, or none.' };
  if (gmEmail && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(gmEmail))
                                  return { ok: false, error: 'gmEmail',  message: 'Enter a valid email, or leave blank.' };

  props.setProperty(PROP_PIN, pin);
  props.setProperty(PROP_LOCATION, location);
  props.setProperty(PROP_LOCATION_ABBR, abbr);
  props.setProperty(PROP_GM_EMAIL, gmEmail);     // setupMobileApi_ sets this even when blank
  if (concept) props.setProperty(PROP_CONCEPT, concept);
  else         props.deleteProperty(PROP_CONCEPT);
  // PROP_MASTER_PIN intentionally untouched — owner sets it via the menu.
  pushPinsQuietly_();   // a store connected to Supabase gets the new PIN there too

  const token = Utilities.getUuid();
  putEditorToken_(token, 'store');
  return { ok: true, token: token };
}


/***********************
 * EDITOR DISPATCHER (single token-guarded entry point)
 *
 * Every page this script serves (the web editor AND the Sheet dialogs) calls
 * the server through webedit_call(token, action, args). The switch below is
 * the allowlist: the action names are what the pages send, and each maps to
 * a PRIVATE function (name ends in _). Private functions are invisible to
 * google.script.run, so the token check here is the only way in.
 *
 * Why it matters (D18, 2026-10-16): the web app runs as the owner for
 * anonymous visitors (appsscript.json), and Apps Script lets any page it
 * serves call any PUBLIC function. tests/public_surface.test.js keeps every
 * function private except the reviewed entry points.
 *
 * Token tiers: 'store' / 'master' come from the PIN (editorAuth); 'sheet' is
 * minted by a Sheet menu when it opens a dialog (mintSheetToken_), for a
 * person who already has the Sheet open. Sheet-only actions (Admin Reset,
 * Recalibrate Vendor Pars) need a 'sheet' token.
 ***********************/

// Maps an allowlisted action to its function, or null. No globalThis lookups,
// so an unknown or mistyped name can never resolve to an owner-side function.
function webeditDispatch_(name, tier) {
  switch (name) {
    // Manage Items
    case 'getManageItemsBootstrap':          return getManageItemsBootstrap_;
    case 'getStorageAreaList':               return getStorageAreaList_;
    case 'getItemForEdit':                   return getItemForEdit_;
    case 'getUnassignedActiveItems':         return getUnassignedActiveItems_;
    case 'commitUpsertItem':                 return commitUpsertItem_;
    case 'commitSwitchActiveVendor':         return commitSwitchActiveVendor_;
    case 'commitSetVendorItems':             return commitSetVendorItems_;
    case 'commitDeleteItem':                 return commitDeleteItem_;
    // Store Health Check
    case 'getStoreHealthReport':             return getStoreHealthReport_;
    case 'runHealthFix':                     return runHealthFix_;
    // Manage Vendors
    case 'getVendorTableData':               return getVendorTableData_;
    case 'commitUpdateVendorMultsAndCutoff': return commitUpdateVendorMultsAndCutoff_;
    case 'commitAddVendor':                  return commitAddVendor_;
    case 'commitImportVendor':               return commitImportVendor_;
    case 'commitRemoveVendor':               return commitRemoveVendor_;
    // Order History (read-only)
    case 'getOrderHistoryBootstrap':         return getOrderHistoryBootstrap_;
    case 'getOrderHistory':                  return getOrderHistory_;
    // Storage Areas + Shelf to Sheet (getStorageAreaList listed above)
    case 'commitStorageAreasDraft':          return commitStorageAreasDraft_;
    case 'getPickPathForSidebar':            return getPickPathForSidebar_;
    case 'commitReorderPickPath':            return commitReorderPickPath_;
    // Supabase catalog sync: the page's background push after a save (Sync.gs)
    case 'pushCatalogNow':                   return pushCatalogFromPage_;
  }
  if (tier !== 'sheet') return null;
  switch (name) {
    // Sheet-only dialogs (opened from the Sheet's menu, never on the web)
    case 'commitSelectiveReset':             return commitSelectiveReset_;
    case 'getVendorRecalibrationBootstrap':  return getVendorRecalibrationBootstrap_;
    case 'commitVendorRecalibration':        return commitVendorRecalibration_;
  }
  return null;
}

// The dispatcher's catalog writes: refused once the store edits its catalog in
// the app (Sync.gs editorInApp_), since an edit here would never reach it.
const CATALOG_WRITE_ACTIONS_ = {
  commitUpsertItem: 1, commitSwitchActiveVendor: 1, commitSetVendorItems: 1, commitDeleteItem: 1,
  commitUpdateVendorMultsAndCutoff: 1, commitAddVendor: 1, commitImportVendor: 1, commitRemoveVendor: 1,
  commitStorageAreasDraft: 1, commitReorderPickPath: 1, commitVendorRecalibration: 1
};

function webedit_call(token, fnName, args, opts) {
  const tier = requireEditorToken_(token);
  const fn = webeditDispatch_(String(fnName || ''), tier);
  if (!fn) throw new Error('Editor action not allowed: ' + fnName);
  if (CATALOG_WRITE_ACTIONS_[fnName] && editorInApp_()) throw new Error(editorMovedMessage_());
  // Supabase catalog sync (Sync.gs): a call that changed something says so in
  // an envelope, and the page fires the push as its OWN background request,
  // so the save never waits on Supabase. bumpServerMutationTs_ sets
  // MOG_MUTATED_; MOG_SKIP_CATALOG_QUEUE_ stops it from also queuing a
  // timer-based push for the same edit. mgeRpc_ (EditorShell) unwraps it.
  // The envelope is OPT-IN (opts.envelope): a page loaded before this
  // deploy still expects the plain result, and gets it.
  MOG_SKIP_CATALOG_QUEUE_ = true;
  MOG_MUTATED_ = false;
  const result = fn.apply(null, args || []);
  if (!(opts && opts.envelope)) return result;
  return {
    __mogEnvelope: 1,
    result:        result,
    pushCatalog:   MOG_MUTATED_ && fnName !== 'pushCatalogNow' && supabaseConfig_().connected
  };
}

// A dialog's session, minted by the Sheet menu that opens it. Whoever runs a
// Sheet menu already has the Sheet open, so no PIN: the dialog gets a token
// for the same dispatcher the web editor uses (6 hours, sliding).
function mintSheetToken_() {
  const token = Utilities.getUuid();
  putEditorToken_(token, 'sheet');
  return token;
}

// The boot JSON a Sheet dialog's template gets: web bits off, plus its token.
function sheetBootJson_() {
  return JSON.stringify({ web: false, token: mintSheetToken_() });
}

// First line of every PUBLIC function meant to be run by hand from the Apps
// Script editor (test_*, one-off maintenance). Public functions are callable
// from any page this web app serves, where the script runs as the owner for
// an anonymous visitor; there Google can't name the person (active user
// blank, or someone other than the owner). Run from the editor, the active
// user is the person running it.
function requireEditorRun_() {
  let active = '', effective = '';
  try { active = Session.getActiveUser().getEmail() || ''; } catch (e) { active = ''; }
  try { effective = Session.getEffectiveUser().getEmail() || ''; } catch (e) { effective = ''; }
  if (!active || active !== effective) {
    throw new Error('Run this from the Apps Script editor. If you already are, Google hasn\'t shared your ' +
      'email with this script yet: run authorizeSupabase (Sync.gs) once and allow every permission.');
  }
}
