import { describe, it, expect, beforeAll } from 'vitest';
import { env, exports } from 'cloudflare:workers';

const BASE = 'https://test-app.example';
let n = 0;
const get = (path, headers = {}) => exports.default.fetch(new Request(BASE + path, { headers, redirect: 'manual' }));
const post = (path, data, headers = {}) => exports.default.fetch(new Request(BASE + path, {
  method: 'POST', redirect: 'manual',
  headers: { 'Content-Type': 'application/x-www-form-urlencoded', Origin: BASE, 'Sec-Fetch-Site': 'same-origin', 'CF-Connecting-IP': `198.19.0.${++n}`, ...headers },
  body: new URLSearchParams(data).toString(),
}));
const outbox = (to) => env.DB.prepare('SELECT * FROM dev_outbox WHERE to_email = ? ORDER BY id DESC').bind(to).all().then((r) => r.results);

async function producer(email, name, postcode, county, status) {
  await post('/signin', { email, 'cf-turnstile-response': 'dev-pass' });
  const code = (await outbox(email))[0].subject.match(/(\d{6})/)[1];
  const cookie = (await post('/signin/code', { email, code })).headers.get('Set-Cookie').split(';')[0];
  await post('/producer/join', { business_name: name, contact_name: 'Sam', phone: '01952 123456', description: `${name} makes good food for local families.`, postcode, county, terms: 'yes' }, { Cookie: cookie });
  await env.DB.prepare('UPDATE producers SET status = ? WHERE business_name = ?').bind(status, name).run();
}

beforeAll(async () => {
  await env.TILES.put('uk.pmtiles', new Uint8Array(1000).map((_, i) => i % 256));
  await producer('m1@map.example', 'Map Bakery', 'TF1 2EB', 'Shropshire', 'approved');
  await producer('m2@map.example', 'Map Dairy', 'TF1 3AA', 'Shropshire', 'approved');
  await producer('m3@map.example', 'Hidden Farm', 'TF2 6AA', 'Shropshire', 'pending');
});

describe('map tiles', () => {
  it('serves byte ranges of the map file', async () => {
    const r = await get('/tiles/uk.pmtiles', { Range: 'bytes=10-19' });
    expect(r.status).toBe(206);
    expect(r.headers.get('Content-Range')).toBe('bytes 10-19/1000');
    expect([...new Uint8Array(await r.arrayBuffer())]).toEqual([10, 11, 12, 13, 14, 15, 16, 17, 18, 19]);
  });
  it('refuses requests without a sensible range', async () => {
    expect((await get('/tiles/uk.pmtiles')).status).toBe(416);
    expect((await get('/tiles/uk.pmtiles', { Range: 'bytes=0-99999999' })).status).toBe(416);
    expect((await get('/tiles/uk.pmtiles', { Range: 'bytes=-500' })).status).toBe(416);
  });
  it('returns an empty glyph file for scripts we do not ship', async () => {
    const r = await get('/map/fonts/Noto%20Sans%20Regular/19968-20223.pbf');
    expect(r.status).toBe(200);
    expect((await r.arrayBuffer()).byteLength).toBe(0);
  });
});

describe('map page and pins', () => {
  it('groups approved producers by postcode district', async () => {
    const d = await (await get('/producers/map.json?county=Shropshire')).json();
    expect(d.groups).toHaveLength(1);
    expect(d.groups[0].district).toBe('TF1');
    expect(d.groups[0].producers.map((p) => p.name).sort()).toEqual(['Map Bakery', 'Map Dairy']);
    expect(JSON.stringify(d)).not.toContain('Hidden Farm');
    expect(JSON.stringify(d)).not.toContain('01952');
  });
  it('filters by distance and gives the centre', async () => {
    const d = await (await get('/producers/map.json?near=TF1&miles=10')).json();
    expect(d.centre.outcode).toBe('TF1');
    expect(d.miles).toBe(10);
    expect(d.groups[0].producers[0].miles).toBe(0);
  });
  it('serves the map page with a link back to the list', async () => {
    const r = await get('/producers/map?near=TF1&miles=10');
    expect(r.status).toBe(200);
    const t = await r.text();
    expect(t).toContain('data-src="/producers/map.json?near=TF1&amp;miles=10"');
    expect(t).toContain('Back to the list');
    expect(r.headers.get('Content-Security-Policy')).toContain("worker-src 'self'");
  });
});
