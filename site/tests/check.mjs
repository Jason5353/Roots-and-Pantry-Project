// Checks the built site (dist/): serves it with the real _headers, then for every page
// runs axe-core (WCAG 2.0/2.1/2.2 A + AA) at desktop and phone widths, and fails on
// CSP violations, console errors, inline styles/scripts, or broken internal links.
// Usage: npm run build && npm test   (needs Chrome; set CHROME_PATH if not /usr/bin/google-chrome)
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import puppeteer from 'puppeteer-core';

const dist = path.resolve('dist');
const axeSource = fs.readFileSync(path.resolve('node_modules/axe-core/axe.min.js'), 'utf8');

// Read the global header block from _headers (the "/*" rule).
function globalHeaders() {
  const lines = fs.readFileSync(path.join(dist, '_headers'), 'utf8').split('\n');
  const out = {};
  let inGlobal = false;
  for (const line of lines) {
    if (!line.startsWith(' ') && line.trim()) { inGlobal = line.trim() === '/*'; continue; }
    if (inGlobal && line.includes(':')) {
      const i = line.indexOf(':');
      out[line.slice(0, i).trim()] = line.slice(i + 1).trim();
    }
  }
  return out;
}
const headers = globalHeaders();
// upgrade-insecure-requests would break plain-http local testing.
headers['Content-Security-Policy'] = headers['Content-Security-Policy'].replace('; upgrade-insecure-requests', '');
const types = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.svg': 'image/svg+xml', '.webp': 'image/webp', '.jpg': 'image/jpeg', '.woff2': 'font/woff2', '.woff': 'font/woff', '.txt': 'text/plain' };

const server = http.createServer((req, res) => {
  let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  let file = path.join(dist, p);
  if (p.endsWith('/')) file = path.join(file, 'index.html');
  if (!fs.existsSync(file)) { res.writeHead(404, { ...headers, 'Content-Type': 'text/html' }); return res.end(fs.readFileSync(path.join(dist, '404.html'))); }
  res.writeHead(200, { ...headers, 'Content-Type': types[path.extname(file)] || 'application/octet-stream' });
  res.end(fs.readFileSync(file));
});
await new Promise((r) => server.listen(4799, r));
const base = 'http://localhost:4799';

const pages = [];
(function walk(dir) {
  for (const f of fs.readdirSync(dir)) {
    const full = path.join(dir, f);
    if (fs.statSync(full).isDirectory()) walk(full);
    else if (f === 'index.html') pages.push('/' + path.relative(dist, dir).split(path.sep).join('/') + (dir === dist ? '' : '/'));
  }
})(dist);
pages.sort();

const browser = await puppeteer.launch({ executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome', args: ['--no-sandbox'] });
let failures = 0;
const linked = new Set();
for (const width of [1280, 375]) {
  for (const url of pages) {
    const page = await browser.newPage();
    await page.setViewport({ width, height: 900 });
    const problems = [];
    page.on('console', (m) => { if (m.type() === 'error') problems.push('console: ' + m.text()); });
    page.on('pageerror', (e) => problems.push('page error: ' + e.message));
    await page.goto(base + url, { waitUntil: 'networkidle0' });
    const html = await page.content();
    if (/<script(?![^>]*type="application\/json")/.test(html)) problems.push('inline or external <script> found');
    if (/ style="/.test(html)) problems.push('inline style attribute found (blocked by CSP)');
    await page.evaluate(axeSource);
    const result = await page.evaluate(() => window.axe.run(document, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'] } }));
    for (const v of result.violations) problems.push(`axe ${v.id} (${v.impact}): ${v.help} — ${v.nodes.length} element(s), e.g. ${v.nodes[0].target.join(' ')}`);
    const hrefs = await page.$$eval('a[href^="/"]', (as) => as.map((a) => a.getAttribute('href')));
    hrefs.forEach((h) => linked.add(h.split('#')[0]));
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1
      ? [...document.querySelectorAll('body *')].filter((e) => e.getBoundingClientRect().right > window.innerWidth + 1).slice(0, 4).map((e) => `${e.tagName.toLowerCase()}.${e.className}`).join(', ') || 'unknown'
      : '');
    if (overflow) problems.push(`page scrolls sideways; too wide: ${overflow}`);
    console.log(`${problems.length ? 'FAIL' : 'ok  '} ${width}px ${url}`);
    problems.forEach((p) => console.log('     - ' + p));
    failures += problems.length;
    await page.close();
  }
}
for (const href of linked) {
  const target = href.endsWith('/') ? path.join(dist, href, 'index.html') : path.join(dist, href);
  if (!fs.existsSync(target)) { console.log(`FAIL broken internal link: ${href}`); failures++; }
}
await browser.close();
server.close();
console.log(failures ? `\n${failures} problem(s) found` : '\nAll checks passed');
process.exit(failures ? 1 : 0);
