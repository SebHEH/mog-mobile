/************************************************************
 * MOG — the concepts a store can be, and each one's colours.
 * Pure: no Apps Script service, so Supabase's nightly close
 * (supabase/functions/close) runs this file too. build.py copies it
 * into supabase/functions/close/shared.mjs, with OrderMath.gs and
 * RecapEmail.gs (docs/MOG_SheetRetirement_Spec.md, R8).
 * Moved here from Dashboard.gs on 2026-11-11, unchanged.
 ************************************************************/

// Per-concept dashboard branding. `accent` is the background fill that
// replaces DASH_COLORS.NAVY on the banner + tiles (chosen dark enough for
// white text); `bannerFont` is applied to the banner text only (tiles keep
// white text for legibility). `accent` is the BAND/BANNER background fill;
// `bannerFont` is the text drawn on it; `ink` is the dark color used wherever a
// dark fill (light text) or dark-text-on-white reading is needed — the tiles,
// the reset strip, and the recap email's vendor headers + "× qty" numbers.
// `ink` defaults to `accent` (correct for dark accents like RP teal / navy), so
// those concepts are unchanged. TNY is gold-forward: a gold band with charcoal
// text, while tiles + email ink stay charcoal so everything stays legible. Same
// palette mirrors the PWA + the KM web editor (which reads accent/bannerFont).
// Static table — identical across all stores; the per-store choice comes from
// the MOG_CONCEPT property (in Supabase, mog.stores.concept). Its keys (minus
// 'default') are the concepts a store can be set to (knownConcepts_), and `name`
// is how the Sheet menus show each one: the same spelling as stores.json and the
// app (tests/concepts.test.js). The order is the Sheet menus' numbering, so 1
// and 2 stay Roll Play and Teas'n You. 'default' is Dashboard.gs's DASH_COLORS
// NAVY and WHITE, written out so this file needs nothing else.
const CONCEPT_THEMES = {
  'roll-play': { name: "Roll Play",  accent: "#2d8c6b", bannerFont: "#ffffff" },                  // RP teal-dark + white
  'teasnyou':  { name: "Teas’n You", accent: "#D4A574", bannerFont: "#1a1a1a", ink: "#1a1a1a" },  // TNY Kintsugi gold band + charcoal ink
  'an':        { name: "ĂN",         accent: "#3C1124", bannerFont: "#ffffff" },                  // ĂN Night Market burgundy (brand-kit primary/header color)
  'leid':      { name: "Lei’d Poke", accent: "#b51579", bannerFont: "#ffffff" },                  // Lei'd dark magenta (white reads on the dark shade)
  'default':   { accent: "#1a1a2e", bannerFont: "#ffffff" }                                       // DASH_COLORS.NAVY + WHITE
};

// The concepts a store can be set to, in the Sheet menus' order.
function knownConcepts_() {
  return Object.keys(CONCEPT_THEMES).filter(function (k) { return k !== 'default'; });
}
function isKnownConcept_(concept) {
  return knownConcepts_().indexOf(String(concept || '')) >= 0;
}

// A concept's theme: { accent, bannerFont, ink }, the default navy when the
// concept is unset or unknown. Dashboard.gs dashTheme_ reads it for the store's
// own MOG_CONCEPT; the nightly close in Supabase for mog.stores.concept.
function conceptTheme_(concept) {
  var key = String(concept || '').trim().toLowerCase();
  var t = (key !== 'default' && Object.prototype.hasOwnProperty.call(CONCEPT_THEMES, key))
    ? CONCEPT_THEMES[key] : CONCEPT_THEMES['default'];
  // `ink` defaults to `accent` so dark-accent concepts (RP/navy) are unchanged.
  return { accent: t.accent, bannerFont: t.bannerFont, ink: t.ink || t.accent };
}
