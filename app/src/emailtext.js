// Shared email wording: the company line, and an HTML version of a plain-text email with that line in small text.
export const COMPANY = 'Roots & Pantry is a trading name of BMS Cyber Defence Ltd, registered in England and Wales, company number 14975379.';

const escHtml = (t) => String(t).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
// HTML copy of an email (for pasting into Zoho, and for emails the app sends): same text, company line in 8pt.
export function emailHtml(text) {
  const i = text.lastIndexOf(COMPANY);
  const main = i >= 0 ? text.slice(0, i) : text;
  const toHtml = (t) => escHtml(t).replace(/\n/g, '<br>');
  return `<div style="font-family:Arial,sans-serif;font-size:11pt">${toHtml(main)}${i >= 0 ? `<span style="font-size:8pt;color:#56607A">${escHtml(COMPANY)}</span>` : ''}</div>`;
}

