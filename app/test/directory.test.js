import { describe, it, expect, beforeAll } from 'vitest';
import { env, exports } from 'cloudflare:workers';
import { parseNear, milesBetween, deliversTo } from '../src/directory.js';

const BASE = 'https://test-app.example';
let n = 0;
const get = (path) => exports.default.fetch(new Request(BASE + path, { redirect: 'manual' }));
const post = (path, data, headers = {}) => exports.default.fetch(new Request(BASE + path, {
  method: 'POST', redirect: 'manual',
  headers: { 'Content-Type': 'application/x-www-form-urlencoded', Origin: BASE, 'Sec-Fetch-Site': 'same-origin', 'CF-Connecting-IP': `198.18.0.${++n}`, ...headers },
  body: new URLSearchParams(data).toString(),
}));
const outbox = (to) => env.DB.prepare('SELECT * FROM dev_outbox WHERE to_email = ? ORDER BY id DESC').bind(to).all().then((r) => r.results);

async function producer(email, name, postcode, county, extra = {}, status = 'approved') {
  await post('/signin', { email, 'cf-turnstile-response': 'dev-pass' });
  const code = (await outbox(email))[0].subject.match(/(\d{6})/)[1];
  const cookie = (await post('/signin/code', { email, code })).headers.get('Set-Cookie').split(';')[0];
  await post('/producer/join', { business_name: name, contact_name: 'Sam', phone: '01952 123456', description: `${name} makes good food for local families.`, postcode, county, terms: 'yes' }, { Cookie: cookie });
  const sets = Object.keys(extra).map((k) => `${k} = ?`).join(', ');
  await env.DB.prepare(`UPDATE producers SET status = ?${sets ? `, ${sets}` : ''} WHERE business_name = ?`).bind(status, ...Object.values(extra), name).run();
}

beforeAll(async () => {
  await producer('a@dir.example', 'Wellington Bakery', 'TF1 2EB', 'Shropshire');
  await producer('b@dir.example', 'Shrewsbury Cheese', 'SY1 1AA', 'Shropshire');
  await producer('c@dir.example', 'Edinburgh Tea', 'EH1 1AA', 'Scotland', { delivery_reach: 'uk' });
  await producer('d@dir.example', 'Leeds Pies', 'LS1 1AA', 'West Yorkshire', { delivery_reach: 'miles', delivery_miles: 50 });
  await producer('e@dir.example', 'Secret Pending Farm', 'TF2 6AA', 'Shropshire', {}, 'pending');
});

describe('directory helpers', () => {
  it('reads districts and full postcodes', () => {
    expect(parseNear('tf1 2eb')).toEqual({ outcode: 'TF1', full: true });
    expect(parseNear(' tf1 ')).toEqual({ outcode: 'TF1', full: false });
    expect(parseNear('EC1A')).toEqual({ outcode: 'EC1A', full: false });
    expect(parseNear('hello')).toEqual({ invalid: true });
    expect(parseNear('')).toBe(null);
  });
  it('measures miles', () => {
    const m = milesBetween({ lat: 52.70246, lng: -2.50323 }, { lat: 52.7228, lng: -2.74039 }); // TF1 to SY1
    expect(m).toBeGreaterThan(9);
    expect(m).toBeLessThan(12);
  });
  it('knows who delivers where', () => {
    expect(deliversTo({ delivery_reach: 'uk' }, 400)).toBe(true);
    expect(deliversTo({ delivery_reach: 'miles', delivery_miles: 50 }, 60)).toBe(false);
    expect(deliversTo({ delivery_reach: 'local' }, 10)).toBe(true);
    expect(deliversTo({ delivery_reach: 'none' }, 1)).toBe(false);
  });
});

describe('directory page', () => {
  it('has the postcode district table loaded', async () => {
    expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM postcode_districts').first()).n).toBeGreaterThan(2800);
    expect((await env.DB.prepare("SELECT district FROM producers WHERE business_name = 'Wellington Bakery'").first()).district).toBe('TF1');
  });

  it('cuts a full postcode down to its district', async () => {
    const r = await get('/producers?near=TF1+2EB&miles=10');
    expect(r.status).toBe(303);
    expect(r.headers.get('Location')).toBe(`${BASE}/producers?near=TF1&miles=10`);
  });

  it('lists nearby producers by distance, plus those who deliver', async () => {
    let t = await (await get('/producers?near=TF1&miles=10')).text();
    expect(t).toContain('1 producer within 10 miles of TF1');
    expect(t).toContain('Wellington Bakery');
    expect(t).not.toContain('Shrewsbury Cheese');
    expect(t).toContain('Further away, but they deliver to you');
    expect(t).toContain('Edinburgh Tea');
    expect(t).not.toContain('Leeds Pies');
    expect(t).not.toContain('Secret Pending Farm');
    t = await (await get('/producers?near=TF1&miles=25')).text();
    expect(t.indexOf('Wellington Bakery')).toBeLessThan(t.indexOf('Shrewsbury Cheese'));
  });

  it('offers 5-mile steps and always links to the map', async () => {
    let t = await (await get('/producers?near=TF1&miles=5')).text();
    expect(t).toContain('within 5 miles of TF1');
    expect(t).toContain('<option value="35" >Within 35 miles</option>');
    t = await (await get('/producers?near=ZE1&miles=5')).text();
    expect(t).toContain('0 producers within 5 miles');
    expect(t).toContain('/producers/map?near=ZE1&amp;miles=5');
    expect(await (await get('/producers')).text()).toContain('See them all on a map');
  });

  it('browses by county, approved producers only', async () => {
    const t = await (await get('/producers?county=Shropshire')).text();
    expect(t).toContain('2 producers in Shropshire');
    expect(t).not.toContain('Secret Pending Farm');
  });

  it('explains unknown or invalid postcodes', async () => {
    const r = await get('/producers?near=ZZ99');
    expect(r.status).toBe(400);
    expect(await r.text()).toContain('We don&#39;t recognise ZZ99');
    expect((await get('/producers?near=hello')).status).toBe(400);
  });

  it('shows counties with producers on the landing page', async () => {
    const t = await (await get('/producers')).text();
    expect(t).toContain('Shropshire</a> (2)');
    expect(t).not.toContain('Secret Pending Farm');
  });
});
