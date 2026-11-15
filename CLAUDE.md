# Roots & Pantry – context for Claude

Free family recipe app with deals from independent local food producers. Run by Jason Lewis
(GitHub `Jason5353`, repo `Jason5353/Roots-and-Pantry-Project`), a trading name of BMS Cyber Defence Ltd (company 14975379).
Full decisions: the claude.ai project doc "Public app – decisions and plan".

## Layout
- `site/` – public marketing site, `rootsandpantry.co.uk`. Astro 7, static, **no JavaScript**, no cookies.
- `app/` – the real app, a Cloudflare Worker (plain JS, server-rendered HTML, no framework). `app.rootsandpantry.co.uk` (Worker `rp-app`, branch `main`, D1 `rp-app`) and `test-app.rootsandpantry.co.uk` (Worker `rp-app-test`, branch `test`, D1 `rp-app-test`, yellow TEST banner). D1 databases are EU jurisdiction. Config in `app/wrangler.jsonc`; schema in `app/migrations/`.
  - Built so far: contact form (`/contact`, saved to D1 + emailed to hello@ with reply-to), email-code sign-in (`/signin`, 6-digit code, HMAC-hashed, 10 min, 5 attempts, 3 codes/email/hour, 10/IP/hour, `__Host-rp_s` session cookie 30 days), producer sign-up (`/producer/join`, pending until approved; website and Facebook page both optional) and status page (`/producer`). OWNER_EMAIL (hello@) gets role `owner` on first sign-in.
  - Producer dashboard (step 3, `app/src/producer.js`): `/producer` (deals list with state live/waiting/scheduled/paused/expired/ended), `/producer/edit` (listing: shop address, market days, delivery reach), `/producer/deals/new` and `/producer/deals/:id/edit|status|renew` (rules enforced in `validateDeal`: ≥10% or free item, ≥14 days, max 366 days, online deals need a code, health-claim word check, max 10 live deals), `/producer/promote` (QR code + A4 poster + A6 postcard print pages + Facebook post text), public page `/p/:slug` (full page for approved producers, never shows codes or phone; visitors see a status message instead when pending ("is joining"), suspended ("paused for now", no reason shown) or withdrawn (410, "has left" – keep a tombstone row when listing deletion is built); rejected and unknown slugs get a 404 "isn't listed" with no name; the producer and admins see the full page with a preview note). Deals table in `migrations/0003_deals.sql`. Daily cron 08:00 UTC emails a reminder once when a deal ends within 7 days. Print sizes use separate `page-a4.css` / `page-a6.css` (Chrome ignores named @page and the `A6` keyword).
  - Admin (step 4, `app/src/admin.js`, `/admin`): roles `owner` (hello@) and `moderator`; non-admins get 404. Fresh email code needed after 15 min without admin activity (`/admin/confirm`, sliding window on `sessions.last_auth_at`). Overview (success measures + to-do), producers (approve / reject / suspend / reinstate, reason required and emailed, shown on the producer's dashboard; end a deal with reason), contact messages (new / answered / closed; reply from the hello@ inbox), owner-only team (add/remove moderators) and audit log. Migration `0004_admin.sql`.
  - Directory (step 5, `app/src/directory.js`, `/producers`, public): search by postcode district + 5 to 50 miles in 5-mile steps (a full postcode is cut to its district and redirected, so it isn't kept), "further away, but they deliver to you" (UK-wide, within X miles, or local = 15 miles), browse by county; approved producers only. District centres in table `postcode_districts` from `app/data/postcode-districts.csv` (CC0, Gibbs/uk-postcodes, 2017; `scripts/make-districts.mjs` → `migrations/0005_districts.sql`); `producers.district` set on join/edit. Site nav + footer link "Find producers" to it.
  - Map (step 5b, `app/src/map.js` + `app/public/map/app-map.js`): `/producers/map` (same filters; pins per postcode district, never exact addresses; list page is the accessible alternative), pins from `/producers/map.json`. Self-hosted MapLibre 6 (ES module, worker-src 'self'), PMTiles and Protomaps basemaps copied to `public/map/vendor/` by `npm run build`; Latin-only Noto glyphs + sprites committed in `public/map/` (missing glyph ranges get an empty file). Map file `uk.pmtiles` (OSM, ODbL – attribution on the page) lives in R2 bucket `rp-tiles` (EU, binding `TILES`), made and uploaded by `.github/workflows/map-tiles.yml` (manual run; secrets R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY / R2_ENDPOINT; refuses files over 4 GB). `/tiles/uk.pmtiles` serves byte ranges before any session/DB work, cached at the edge for 30 days keyed by the file's ETag (keeps R2 reads inside the free tier). Public producer page has "Get directions" (Google Maps) when a shop address is given.
  - Secrets (dashboard only): `TURNSTILE_SECRET`, `BREVO_API_KEY`, `CODE_PEPPER`. `DEV=true` (tests only) skips Turnstile and writes emails to `dev_outbox`; the Worker refuses to run with DEV on a rootsandpantry.co.uk host.
  - `cd app && npm test` (vitest + @cloudflare/vitest-plugin, 54 tests). All POSTs need same-origin Origin/Sec-Fetch-Site (CSRF).
- Demo (separate repo `Jason5353/Roots-and-Pantry-demo`): https://roots-and-pantry-demo.pages.dev

## Hosting
- Cloudflare account **"Roots and Pantry Site"** (separate from BMS and the Lewis family site; never touch those).
- Pages project **`roots-and-pantry-project`** for `site/`: root directory `site`, build `npm run build`, output `dist`, `NODE_VERSION=22`. `main` = production (https://roots-and-pantry-project.pages.dev), `test` = preview (https://test.roots-and-pantry-project.pages.dev). Custom domain not attached until launch.
- Domains: `rootsandpantry.co.uk` (main), `rootsandpantry.uk` (redirect to .co.uk, never sends email).
- Email: `hello@rootsandpantry.co.uk` only → Cloudflare Email Routing → admin@bmscyberdefence.co.uk. App email via Brevo (EU). Brevo always adds an open pixel + List-Unsubscribe header; sign-in code emails must be plain text with no links.

## Stage
Stage 1 (now): public site + producer sign-up/dashboard + admin. Family app opens in stage 2.
`site/src/data/site.js` holds shared facts, the app URL (`PUBLIC_APP_URL`, set to the test app in Pages preview) and the `familyOpen` / `producerSignupOpen` switches. Site links for producers and contact go to the app.

## Producer rules (terms version `2026-11-draft-2`)
Food and drink only; deals at least 10% off or a free item, running at least **14 days**; codes must work; honest offers; no health claims; alcohol shown to 18+ only. Non-food sellers → sponsored spots. Voluntary £5 Revolut tip on /for-producers/.

## Working rules
- **Test first.** Work on `test`, Jason checks the preview URL, then merge to `main`.
- `cd site && npm run build && npm test` before every push. `npm test` runs axe-core (WCAG 2.2 AA) at desktop and phone widths, checks the CSP (no inline scripts or `style=` attributes), sideways scrolling and internal links. Needs Chrome (`CHROME_PATH`).
- **WCAG 2.2 AA is a hard requirement.** Yolk (#FFC93C) never for text on white. Visible focus, 44px tap targets, reduced-motion respected, captions on videos.
- **Strict CSP** in `site/public/_headers`: no inline styles/scripts, no third-party fonts or embeds (fonts are self-hosted via @fontsource). Only exception: Cloudflare Web Analytics beacon.
- **noindex until launch.** Pages emit `<meta name="robots" content="noindex">` unless the Cloudflare variable `PUBLIC_INDEX=yes` is set (production only, on launch day). `*.pages.dev` always sends `X-Robots-Tag: noindex`.
- Postal address and phone appear **only** on `/privacy-and-terms/`. Everywhere else: hello@ only.
- Plain UK English, short pages, specifics over adjectives. No secrets in the repo; never ask Jason to paste secrets in chat.
- Jason prefers direct, concise, step-by-step instructions for anything he clicks in Cloudflare or GitHub.
