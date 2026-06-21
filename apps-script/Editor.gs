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
    .setTitle('MOG · Editor')
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
    .setTitle('MOG · Manage Items')
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
    case 'commitUpsertItem':        return commitUpsertItem;
    case 'commitSwitchActiveVendor':return commitSwitchActiveVendor;
    case 'commitDeleteItem':        return commitDeleteItem;
    default:                        return null;
  }
}

function webedit_call(token, fnName, args) {
  requireEditorToken_(token);
  const fn = webeditDispatch_(String(fnName || ''));
  if (!fn) throw new Error('Editor action not allowed: ' + fnName);
  return fn.apply(null, args || []);
}
