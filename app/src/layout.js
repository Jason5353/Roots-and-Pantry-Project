// Page shell and security headers for every HTML response.
import { html, raw } from './util.js';

export function securityHeaders(extra = {}) {
  return {
    'Content-Security-Policy': [
      "default-src 'self'",
      "script-src 'self' https://challenges.cloudflare.com",
      "worker-src 'self'",
      "frame-src https://challenges.cloudflare.com",
      "style-src 'self'",
      "img-src 'self' data:",
      "font-src 'self'",
      "connect-src 'self' https://challenges.cloudflare.com",
      "form-action 'self'",
      "frame-ancestors 'none'",
      "base-uri 'none'",
      "object-src 'none'",
      'upgrade-insecure-requests',
    ].join('; '),
    'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=(), browsing-topics=()',
    'Cross-Origin-Opener-Policy': 'same-origin',
    'X-Robots-Tag': 'noindex, nofollow',
    'Cache-Control': 'no-store',
    ...extra,
  };
}

// Link previews for Facebook and other sites (Open Graph). Plain meta tags: no Facebook code on our pages.
export function ogTags(env, { title, description = '', path = '/', image = 'producer' }) {
  const base = env.APP_URL || '';
  const desc = String(description).replace(/\s+/g, ' ').trim();
  return html`<meta property="og:type" content="website" />
  <meta property="og:site_name" content="Roots &amp; Pantry" />
  <meta property="og:locale" content="en_GB" />
  <meta property="og:title" content="${title}" />
  ${desc ? html`<meta property="og:description" content="${desc.length > 200 ? `${desc.slice(0, 197)}…` : desc}" /><meta name="description" content="${desc.length > 200 ? `${desc.slice(0, 197)}…` : desc}" />` : ''}
  <meta property="og:url" content="${base}${path}" />
  <meta property="og:image" content="${base}/og/${image}.png" />
  <meta property="og:image:width" content="1200" />
  <meta property="og:image:height" content="630" />
  <meta property="og:image:alt" content="${image === 'christmas' ? 'Roots & Pantry: Christmas from local producers' : 'Roots & Pantry: independent local food producers and their offers'}" />`;
}

export function page(env, { title, user, body, head = '', turnstile = false, status = 200, headers = {}, bodyClass = '', topbar = '', og = null }) {
  const label = env.ENV_LABEL ? html`<aside class="envbar" aria-label="Test copy">${env.ENV_LABEL} copy · data here is for testing only</aside>` : '';
  const doc = html`<!doctype html>
<html lang="en-GB">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <meta name="robots" content="noindex, nofollow" />
  <title>${title ? `${title} | ` : ''}Roots &amp; Pantry</title>
  <link rel="stylesheet" href="/app.css" />
  <link rel="icon" href="/favicon.svg" type="image/svg+xml" />
  ${og ? ogTags(env, og) : ''}
  ${head}
  ${turnstile ? raw('<script src="https://challenges.cloudflare.com/turnstile/v0/api.js" async defer></script>') : ''}
</head>
<body${bodyClass ? html` class="${bodyClass}"` : ''}>
  <a class="skip" href="#main">Skip to main content</a>
  ${label}
  <header class="site">
    <div class="wrap">
      <a href="${env.SITE_URL}" class="logo"><span class="mark" aria-hidden="true">R&amp;P</span><span class="word">Roots <span class="amp">&amp;</span> Pantry</span></a>
      <nav class="main" aria-label="Account">
        <a href="/producers">Producers</a>
        <a href="/contact">Contact</a>
        ${user
          ? html`${user.role === 'owner' || user.role === 'moderator' ? html`<a href="/admin">Admin</a>` : ''}${env.FAMILY_SIGNUP_OPEN === 'true' ? html`<a href="/family">My family</a>` : ''}${user.is_producer || env.FAMILY_SIGNUP_OPEN !== 'true' ? html`<a href="/producer">My listing</a>` : ''}<form method="post" action="/signout" class="inline"><button class="linkbtn" type="submit">Sign out</button></form>`
          : html`<a href="/signin">Sign in</a>`}
      </nav>
    </div>
  </header>
  ${topbar}
  <main id="main" tabindex="-1" class="wrap">
    ${body}
  </main>
  <footer class="site">
    <div class="wrap">
      <p>Roots &amp; Pantry is a trading name of BMS Cyber Defence Ltd, company number 14975379. <a href="${env.SITE_URL}/privacy-and-terms/">Privacy &amp; terms</a> · <a href="${env.SITE_URL}/accessibility/">Accessibility</a> · <a href="https://www.facebook.com/profile.php?id=61596356653557" rel="noopener">Facebook</a></p>
    </div>
  </footer>
</body>
</html>`;
  return new Response(doc.toString(), { status, headers: securityHeaders({ 'Content-Type': 'text/html; charset=utf-8', ...headers }) });
}

export const turnstileWidget = (env) => html`<div class="cf-turnstile" data-sitekey="${env.TURNSTILE_SITE_KEY}" data-theme="light"></div>
<noscript><p class="error">Please turn on JavaScript for this form. It's only used for our anti-spam check. Or email hello@rootsandpantry.co.uk.</p></noscript>`;

export function errorList(errors) {
  if (!errors || !errors.length) return '';
  return html`<div class="errors" role="alert" tabindex="-1" id="errors"><h2>Please check the form</h2><ul>${errors.map((e) => html`<li><a href="#${e.field}">${e.msg}</a></li>`)}</ul></div>`;
}

// Text input with label, hint and inline error, wired up for screen readers.
export function field({ id, label, value = '', type = 'text', hint = '', error = '', required = true, autocomplete = '', max = 200, rows = 0, inputmode = '' }) {
  const describedBy = [hint ? `${id}-hint` : '', error ? `${id}-err` : ''].filter(Boolean).join(' ');
  const common = html`id="${id}" name="${id}" ${required ? raw('required') : ''} ${describedBy ? html`aria-describedby="${describedBy}"` : ''} ${error ? raw('aria-invalid="true"') : ''}`;
  const control = rows
    ? html`<textarea ${common} rows="${rows}" maxlength="${max}">${value}</textarea>`
    : html`<input ${common} type="${type}" value="${value}" maxlength="${max}" ${autocomplete ? html`autocomplete="${autocomplete}"` : ''} ${inputmode ? html`inputmode="${inputmode}"` : ''} />`;
  return html`<div class="field${error ? ' has-error' : ''}">
    <label for="${id}">${label}${required ? '' : raw(' <span class="opt">(optional)</span>')}</label>
    ${hint ? html`<p class="hint" id="${id}-hint">${hint}</p>` : ''}
    ${error ? html`<p class="error" id="${id}-err">${error}</p>` : ''}
    ${control}
  </div>`;
}

export function select({ id, label, options, value = '', error = '' }) {
  return html`<div class="field${error ? ' has-error' : ''}">
    <label for="${id}">${label}</label>
    ${error ? html`<p class="error" id="${id}-err">${error}</p>` : ''}
    <select id="${id}" name="${id}" required ${error ? raw(`aria-invalid="true" aria-describedby="${id}-err"`) : ''}>
      <option value="">Choose…</option>
      ${options.map((o) => html`<option value="${o}" ${o === value ? raw('selected') : ''}>${o}</option>`)}
    </select>
  </div>`;
}
