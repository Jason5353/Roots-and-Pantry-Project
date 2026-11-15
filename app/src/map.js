// Map: serves the UK map file from R2 in byte ranges (with edge caching to stay inside R2's free reads),
// the map page and the producer pins (grouped by postcode district: we never show an exact address).
import { html, raw } from './util.js';
import { page } from './layout.js';
import { COUNTIES } from './data.js';
import { parseNear, milesBetween, deliversTo, RADII, approvedProducers } from './directory.js';

export const TILES_KEY = 'uk.pmtiles';
const MAX_RANGE = 32 * 1024 * 1024;
const EDGE_CACHE_SECONDS = 30 * 86400;
let etagMemo = { value: null, at: 0 };

// The file's ETag goes into the cache key, so a refreshed map file never mixes with old cached pieces.
async function currentEtag(env) {
  if (etagMemo.value && Date.now() - etagMemo.at < 10 * 60 * 1000) return etagMemo.value;
  const head = await env.TILES.head(TILES_KEY);
  etagMemo = { value: head ? head.httpEtag : null, at: Date.now() };
  return etagMemo.value;
}

export async function tiles(request, env, ctx) {
  if (!env.TILES) return new Response('Map not set up', { status: 404 });
  const m = /^bytes=(\d+)-(\d+)$/.exec(request.headers.get('Range') || '');
  if (!m) return new Response('Send a byte range', { status: 416 });
  const start = Number(m[1]), end = Number(m[2]);
  if (end < start || end - start + 1 > MAX_RANGE) return new Response('Range too large', { status: 416 });
  const etag = await currentEtag(env);
  if (!etag) return new Response('Map file missing', { status: 404 });

  const cache = caches.default;
  const cacheKey = new Request(`${new URL(request.url).origin}/__tiles/${encodeURIComponent(etag)}/${start}-${end}`);
  const hit = await cache.match(cacheKey);
  if (hit) {
    const headers = new Headers(hit.headers);
    headers.set('Cache-Control', 'public, max-age=86400');
    headers.set('X-Tile-Cache', 'hit');
    return new Response(hit.body, { status: 206, headers });
  }
  const obj = await env.TILES.get(TILES_KEY, { range: { offset: start, length: end - start + 1 } });
  if (!obj) return new Response('Map file missing', { status: 404 });
  const body = await obj.arrayBuffer();
  const headers = {
    'Content-Type': 'application/octet-stream',
    'Content-Range': `bytes ${start}-${start + body.byteLength - 1}/${obj.size}`,
    ETag: obj.httpEtag,
    'Accept-Ranges': 'bytes',
    'X-Content-Type-Options': 'nosniff',
  };
  ctx.waitUntil(cache.put(cacheKey, new Response(body.slice(0), { status: 200, headers: { ...headers, 'Cache-Control': `public, max-age=${EDGE_CACHE_SECONDS}` } })).catch(() => {}));
  return new Response(body, { status: 206, headers: { ...headers, 'Cache-Control': 'public, max-age=86400', 'X-Tile-Cache': 'miss' } });
}

// Glyph ranges we don't ship (non-Latin scripts) get an empty, valid glyph file instead of a 404.
export const emptyGlyphs = () => new Response(new Uint8Array(0), { headers: { 'Content-Type': 'application/x-protobuf', 'Cache-Control': 'public, max-age=2592000' } });

function readFilters(url) {
  const near = parseNear(url.searchParams.get('near'));
  const milesParam = Number(url.searchParams.get('miles'));
  return {
    outcode: near && !near.invalid ? near.outcode : '',
    miles: RADII.includes(milesParam) ? milesParam : 25,
    county: COUNTIES.includes(url.searchParams.get('county')) ? url.searchParams.get('county') : '',
  };
}

const qs = (f) => (f.outcode ? `?near=${encodeURIComponent(f.outcode)}&miles=${f.miles}` : f.county ? `?county=${encodeURIComponent(f.county)}` : '');

export async function mapData(request, env, url) {
  const f = readFilters(url);
  let list = (await approvedProducers(env)).filter((p) => p.lat !== null);
  let centre = null;
  if (f.outcode) {
    centre = await env.DB.prepare('SELECT outcode, lat, lng, town FROM postcode_districts WHERE outcode = ?').bind(f.outcode).first();
    if (centre) list = list.map((p) => ({ ...p, miles: milesBetween(centre, p) })).filter((p) => p.miles <= f.miles || deliversTo(p, p.miles));
  } else if (f.county) list = list.filter((p) => p.county === f.county);
  const groups = new Map();
  for (const p of list) {
    if (!groups.has(p.district)) groups.set(p.district, { district: p.district, town: p.town, lat: p.lat, lng: p.lng, producers: [] });
    groups.get(p.district).producers.push({ name: p.business_name, slug: p.slug, deals: p.deals, miles: p.miles === undefined ? null : Math.round(p.miles) });
  }
  return new Response(JSON.stringify({ centre: centre && { outcode: centre.outcode, lat: centre.lat, lng: centre.lng }, miles: f.outcode ? f.miles : null, groups: [...groups.values()] }), {
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'X-Robots-Tag': 'noindex' },
  });
}

export function mapPage(request, env, user, url) {
  const f = readFilters(url);
  const what = f.outcode ? `within ${f.miles} miles of ${f.outcode}` : f.county ? `in ${f.county}` : 'across the UK';
  return page(env, {
    title: 'Map of producers',
    user,
    head: raw(`<link rel="stylesheet" href="/map/vendor/maplibre-gl.css" />
  <script src="/map/vendor/pmtiles.js" defer></script>
  <script src="/map/vendor/basemaps.js" defer></script>
  <script type="module" src="/map/app-map.js"></script>`),
    body: html`<div class="dir">
      <p><a href="/producers${qs(f)}">← Back to the list</a></p>
      <h1>Map of producers</h1>
      <p class="sub">Producers ${what}. Each pin shows a postcode area, not an exact address.</p>
      <p class="note">Prefer a list? <a href="/producers${qs(f)}">The same producers are listed here</a>, with distances.</p>
      <div class="mapwrap">
        <div id="map" class="map" role="region" aria-label="Map of producers ${what}" data-src="/producers/map.json${qs(f)}"></div>
        <p class="map-status" id="map-status" role="status">Loading the map…</p>
        <noscript><p class="map-status">The map needs JavaScript. <a href="/producers${qs(f)}">Use the list instead.</a></p></noscript>
      </div>
      <p class="note">Map data © <a href="https://www.openstreetmap.org/copyright">OpenStreetMap contributors</a>. Map served by Roots &amp; Pantry, so no tracking by map companies.</p>
    </div>`,
  });
}
