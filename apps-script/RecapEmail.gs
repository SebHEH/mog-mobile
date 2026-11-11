/************************************************************
 * MOG — the daily recap email's subject, plain text and HTML.
 * Pure: no Apps Script service. Apps Script's sendRecapEmail_ (Recap.gs)
 * and Supabase's nightly close (supabase/functions/close) both build the
 * email here, so it looks the same whoever sends it. build.py copies this
 * file into supabase/functions/close/shared.mjs with OrderMath.gs and
 * Concepts.gs (docs/MOG_SheetRetirement_Spec.md, R8).
 * Moved out of Recap.gs sendRecapEmail_ on 2026-11-11, unchanged; gated by
 * tests/night_close.test.js against the old sendRecapEmail_.
 ************************************************************/

// location: the store's name for the subject and band. theme: { accent,
// bannerFont, ink } (Concepts.gs conceptTheme_). sections, cycleDate,
// totalItems: as buildRecapFromLog_ / recapFromLogRows_ return them.
// Returns { subject, text, html }.
function recapEmailContent_(location, theme, sections, cycleDate, totalItems) {
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
  // The caller passes the theme: dashTheme_() in Apps Script, conceptTheme_() in Supabase.
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


  return { subject: subject, text: body, html: html };
}


function escapeHtml_(s) {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
