/************************************************************
 * MOG — KM Editor web app (doGet?page=editor).
 *
 * Delivers the EXISTING Manage Items modal (ManageItems.html) as a
 * computer-only, PIN-gated web app — the same file serves both the
 * in-Sheet dialog and the web page, so feature/behavior parity is by
 * construction (there is no second copy to drift). The web-only bits in
 * ManageItems.html are gated on a MOG_WEB flag injected here; in the
 * Sheet (showManageItemsSidebar) that flag is false and the modal
 * behaves exactly as it always has.
 *
 * SECURITY — read this. The web app is ANYONE_ANONYMOUS + executeAs
 * USER_DEPLOYING (appsscript.json), so ANY google.script.run call from
 * the served page runs as the OWNER and is reachable by anyone with the
 * /exec URL. A UI-only PIN would be cosmetic. So the web page routes
 * every server call through ONE token-guarded dispatcher, webedit_call,
 * which (1) verifies a server-minted session token and (2) only allows
 * an explicit allowlist of editor functions. The bare CRUD in Items.gs
 * stays reachable only from inside the authenticated Sheet.
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
    concept: String(props.getProperty(PROP_CONCEPT) || '').trim().toLowerCase()  // 'roll-play' | 'teasnyou' | …
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
// setupMobileApi (MOGApi.gs), minus the master PIN (an owner-menu concern).
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
  tmpl.areaListJson = JSON.stringify(getStorageAreaList());
  tmpl.webBootJson  = editorWebBoot_();
  return tmpl.evaluate()
    .setTitle(editorTabTitle_())
    .addMetaTag('viewport', 'width=device-width, initial-scale=1.0')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

// ?page=pickpath — the EXISTING Reorder Pick Path modal served as a web page.
// Mirrors showReorderPickPathSidebar's vendor selection + pick-data preload.
function renderReorderPickPathWeb_() {
  const tmpl    = HtmlService.createTemplateFromFile('ReorderPickPath');
  const vendors = getVendorList();
  if (vendors.length) {
    const setup    = getSheet_(SHEET_SETUP);
    const b2Vendor = String(setup.getRange(SETUP_VENDOR_CELL).getDisplayValue()).trim();
    const vendor   = (b2Vendor && vendors.indexOf(b2Vendor) !== -1) ? b2Vendor : vendors[0];
    tmpl.pickDataJson   = JSON.stringify(getPickPathForSidebar(vendor));
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
  tmpl.vendorTableJson = JSON.stringify(getVendorTableData());
  tmpl.webBootJson     = editorWebBoot_();
  return tmpl.evaluate()
    .setTitle(editorTabTitle_())
    .addMetaTag('viewport', 'width=device-width, initial-scale=1.0')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

// ?page=healthcheck — the Store Health Check served as a web page. Same
// HealthCheck.html the Sheet dialog uses, with MOG_WEB=true so the gate +
// token shim engage. Read-only (report is computed by getStoreHealthReport).
function renderStoreHealthWeb_() {
  const tmpl = HtmlService.createTemplateFromFile('HealthCheck');
  tmpl.webBootJson = editorWebBoot_();
  return tmpl.evaluate()
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
      EDITOR_TOK_TTL_SEC
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
 * through it. Writes the SAME identity props as setupMobileApi (MOGApi.gs),
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
  const concept   = conceptIn === 'roll-play' ? 'roll-play'
                  : conceptIn === 'teasnyou'  ? 'teasnyou'
                  : '';

  // Server-side validation — mirrors setupMobileApi's rules. The `error` field
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
  props.setProperty(PROP_GM_EMAIL, gmEmail);     // setupMobileApi sets this even when blank
  if (concept) props.setProperty(PROP_CONCEPT, concept);
  else         props.deleteProperty(PROP_CONCEPT);
  // PROP_MASTER_PIN intentionally untouched — owner sets it via the menu.

  const token = Utilities.getUuid();
  putEditorToken_(token, 'store');
  return { ok: true, token: token };
}


/***********************
 * EDITOR DISPATCHER (single token-guarded entry point)
 *
 * The web page calls webedit_call(token, fnName, args) for EVERY server
 * call. The switch is the allowlist: only these functions are reachable
 * from the web, and only with a valid token. Each delegates to the
 * EXISTING bare function in Items.gs / PickPath.gs — no logic duplicated.
 ***********************/

// Maps an allowlisted name to the actual function. Returns null for anything
// not on the list (the switch IS the security allowlist — no globalThis
// lookups, so an unknown/typo name can never resolve to an owner-side fn).
function webeditDispatch_(name) {
  switch (name) {
    case 'getManageItemsBootstrap': return getManageItemsBootstrap;
    case 'getStorageAreaList':      return getStorageAreaList;
    case 'getItemForEdit':          return getItemForEdit;
    case 'getUnassignedActiveItems':return getUnassignedActiveItems;
    case 'getStoreHealthReport':    return getStoreHealthReport;
    case 'runHealthFix':            return runHealthFix;
    case 'commitUpsertItem':        return commitUpsertItem;
    case 'commitSwitchActiveVendor':return commitSwitchActiveVendor;
    case 'commitSetVendorItems':    return commitSetVendorItems;
    case 'commitDeleteItem':        return commitDeleteItem;
    // Manage Vendors
    case 'getVendorTableData':              return getVendorTableData;
    case 'commitUpdateVendorMultsAndCutoff':return commitUpdateVendorMultsAndCutoff;
    case 'commitAddVendor':                 return commitAddVendor;
    case 'commitImportVendor':              return commitImportVendor;
    case 'commitRemoveVendor':              return commitRemoveVendor;
    // Order History (read-only)
    case 'getOrderHistoryBootstrap':        return getOrderHistoryBootstrap;
    case 'getOrderHistory':                 return getOrderHistory;
    // Storage Areas + Reorder Pick Path (getStorageAreaList already listed above)
    case 'commitStorageAreasDraft':         return commitStorageAreasDraft;
    case 'getPickPathForSidebar':           return getPickPathForSidebar;
    case 'commitReorderPickPath':           return commitReorderPickPath;
    default:                        return null;
  }
}

function webedit_call(token, fnName, args) {
  requireEditorToken_(token);
  const fn = webeditDispatch_(String(fnName || ''));
  if (!fn) throw new Error('Editor action not allowed: ' + fnName);
  return fn.apply(null, args || []);
}
