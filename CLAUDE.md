# Roots & Pantry – context for Claude

Free family recipe app with deals from independent local food producers. Run by Jason Lewis
(GitHub `Jason5353`, repo `Jason5353/Roots-and-Pantry-Project`), a trading name of BMS Cyber Defence Ltd (company 14975379).
Full decisions: the claude.ai project doc "Public app – decisions and plan".

## Layout
- `site/` – public marketing site, `rootsandpantry.co.uk`. Astro 7, static, **no JavaScript**, no cookies.
- `app/` – (coming) the real app, `app.rootsandpantry.co.uk`: Cloudflare Workers + D1 + R2 (EU jurisdiction).
- Demo (separate repo `Jason5353/Roots-and-Pantry-demo`): https://roots-and-pantry-demo.pages.dev

## Hosting
- Cloudflare account **"Roots and Pantry Site"** (separate from BMS and the Lewis family site; never touch those).
- Pages project **`roots-and-pantry-project`** for `site/`: root directory `site`, build `npm run build`, output `dist`, `NODE_VERSION=22`. `main` = production (https://roots-and-pantry-project.pages.dev), `test` = preview (https://test.roots-and-pantry-project.pages.dev). Custom domain not attached until launch.
- Domains: `rootsandpantry.co.uk` (main), `rootsandpantry.uk` (redirect to .co.uk, never sends email).
- Email: `hello@rootsandpantry.co.uk` only → Cloudflare Email Routing → admin@bmscyberdefence.co.uk. App email via Brevo (EU). Brevo always adds an open pixel + List-Unsubscribe header; sign-in code emails must be plain text with no links.

## Stage
Stage 1 (now): public site + producer sign-up/dashboard + admin. Family app opens in stage 2.
`site/src/data/site.js` holds shared facts and the `familyOpen` / `producerSignupOpen` switches.

## Working rules
- **Test first.** Work on `test`, Jason checks the preview URL, then merge to `main`.
- `cd site && npm run build && npm test` before every push. `npm test` runs axe-core (WCAG 2.2 AA) at desktop and phone widths, checks the CSP (no inline scripts or `style=` attributes), sideways scrolling and internal links. Needs Chrome (`CHROME_PATH`).
- **WCAG 2.2 AA is a hard requirement.** Yolk (#FFC93C) never for text on white. Visible focus, 44px tap targets, reduced-motion respected, captions on videos.
- **Strict CSP** in `site/public/_headers`: no inline styles/scripts, no third-party fonts or embeds (fonts are self-hosted via @fontsource). Only exception: Cloudflare Web Analytics beacon.
- **noindex until launch.** Pages emit `<meta name="robots" content="noindex">` unless the Cloudflare variable `PUBLIC_INDEX=yes` is set (production only, on launch day). `*.pages.dev` always sends `X-Robots-Tag: noindex`.
- Postal address and phone appear **only** on `/privacy-and-terms/`. Everywhere else: hello@ only.
- Plain UK English, short pages, specifics over adjectives. No secrets in the repo; never ask Jason to paste secrets in chat.
- Jason prefers direct, concise, step-by-step instructions for anything he clicks in Cloudflare or GitHub.
