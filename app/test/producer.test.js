import { describe, it, expect } from 'vitest';
import { env, exports } from 'cloudflare:workers';
import { validateDeal, sendExpiryReminders, todayUK } from '../src/producer.js';

const BASE = 'https://test-app.example';
const get = (path, headers = {}) => exports.default.fetch(new Request(BASE + path, { headers, redirect: 'manual' }));
const post = (path, data, headers = {}) => exports.default.fetch(new Request(BASE + path, {
  method: 'POST', redirect: 'manual',
  headers: { 'Content-Type': 'application/x-www-form-urlencoded', Origin: BASE, 'Sec-Fetch-Site': 'same-origin', 'CF-Connecting-IP': '203.0.113.9', ...headers },
  body: new URLSearchParams(data).toString(),
}));
const outbox = (to) => env.DB.prepare('SELECT * FROM dev_outbox WHERE to_email = ? ORDER BY id DESC').bind(to).all().then((r) => r.results);
const addDays = (ymd, n) => { const d = new Date(`${ymd}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const today = todayUK();

async function producer(email, name = 'Test Farm') {
  await post('/signin', { email, 'cf-turnstile-response': 'dev-pass' }, { 'CF-Connecting-IP': `198.51.100.${Math.floor(Math.random() * 200)}` });
  const code = (await outbox(email))[0].subject.match(/(\d{6})/)[1];
  const r = await post('/signin/code', { email, code });
  const cookie = r.headers.get('Set-Cookie').split(';')[0];
  await post('/producer/join', { business_name: name, contact_name: 'Sam', phone: '01952 123456', description: 'We make lovely cheese on our family farm.', postcode: 'TF1 2EB', county: 'Shropshire', terms: 'yes', website: 'https://example.com' }, { Cookie: cookie });
  return cookie;
}
const goodDeal = (o = {}) => ({ title: '10% off all our cheeses', kind: 'percent', percent: '10', products: 'cheddar, brie', how: 'both', redemption: 'code', code: 'roots10', starts_on: today, ends_on: addDays(today, 30), ...o });

describe('deal rules', () => {
  const base = { title: 'Ten percent off cheese', kind: 'percent', percent: '10', free_item: '', products: 'cheddar', how: 'online', redemption: 'code', code: 'ROOTS10', online_url: '', starts_on: today, ends_on: addDays(today, 14), small_print: '' };
  it('accepts exactly 10% for exactly 14 days', () => expect(validateDeal(base).errors).toEqual([]));
  it('rejects under 10%', () => expect(validateDeal({ ...base, percent: '9' }).errors[0].field).toBe('percent'));
  it('rejects under 14 days', () => expect(validateDeal({ ...base, ends_on: addDays(today, 13) }).errors[0].field).toBe('ends_on'));
  it('rejects health claims', () => expect(validateDeal({ ...base, title: 'Honey that boosts immunity' }).errors.some((e) => e.msg.includes('health claims'))).toBe(true));
  it('needs a code for online deals', () => expect(validateDeal({ ...base, redemption: 'mention' }).errors[0].field).toBe('redemption'));
  it('accepts a free item claimed by mentioning us in person', () => expect(validateDeal({ ...base, kind: 'free_item', percent: '', free_item: 'jar of chutney', how: 'in_person', redemption: 'mention', code: '' }).errors).toEqual([]));
  it('rejects start dates in the past', () => expect(validateDeal({ ...base, starts_on: addDays(today, -1), ends_on: addDays(today, 20) }).errors[0].field).toBe('starts_on'));
});

describe('producer dashboard', () => {
  it('adds, pauses, resumes, renews and ends a deal', async () => {
    const cookie = await producer('cheese@example.com', 'Wrekin Cheese');
    let r = await post('/producer/deals/new', goodDeal(), { Cookie: cookie });
    expect(r.status).toBe(303);
    const d = await env.DB.prepare('SELECT * FROM deals WHERE title = ?').bind('10% off all our cheeses').first();
    expect(d.code).toBe('ROOTS10');
    r = await get('/producer', { Cookie: cookie });
    const t = await r.text();
    expect(t).toContain('Goes live when your listing is approved');
    await post(`/producer/deals/${d.id}/status`, { to: 'paused' }, { Cookie: cookie });
    expect((await env.DB.prepare('SELECT status FROM deals WHERE id = ?').bind(d.id).first()).status).toBe('paused');
    await post(`/producer/deals/${d.id}/status`, { to: 'active' }, { Cookie: cookie });
    await post(`/producer/deals/${d.id}/renew`, {}, { Cookie: cookie });
    expect((await env.DB.prepare('SELECT ends_on FROM deals WHERE id = ?').bind(d.id).first()).ends_on).toBe(addDays(addDays(today, 30), 30));
    await post(`/producer/deals/${d.id}/status`, { to: 'ended' }, { Cookie: cookie });
    expect((await env.DB.prepare('SELECT status FROM deals WHERE id = ?').bind(d.id).first()).status).toBe('ended');
  });
  it('shows errors for a bad deal', async () => {
    const cookie = await producer('bad@example.com', 'Bad Deals Ltd');
    const r = await post('/producer/deals/new', goodDeal({ percent: '5', ends_on: addDays(today, 5) }), { Cookie: cookie });
    expect(r.status).toBe(400);
    const t = await r.text();
    expect(t).toContain('at least 10');
    expect(t).toContain('at least 14 days');
  });
  it("stops one producer touching another's deal", async () => {
    const a = await producer('a@example.com', 'Farm A');
    const b = await producer('b@example.com', 'Farm B');
    await post('/producer/deals/new', goodDeal({ title: 'Farm A special offer' }), { Cookie: a });
    const d = await env.DB.prepare('SELECT id FROM deals WHERE title = ?').bind('Farm A special offer').first();
    expect((await get(`/producer/deals/${d.id}/edit`, { Cookie: b })).status).toBe(404);
    expect((await post(`/producer/deals/${d.id}/status`, { to: 'ended' }, { Cookie: b })).status).toBe(404);
    expect((await env.DB.prepare('SELECT status FROM deals WHERE id = ?').bind(d.id).first()).status).toBe('active');
  });
  it('edits the listing, with optional market days and delivery', async () => {
    const cookie = await producer('edit@example.com', 'Edit Farm');
    const r = await post('/producer/edit', { business_name: 'Edit Farm Shop', contact_name: 'Sam', phone: '01952 123456', description: 'We make lovely cheese on our family farm.', postcode: 'TF1 2EB', county: 'Shropshire', delivery_reach: 'miles', delivery_miles: '15', market_days: 'Wellington Market, Thursdays' }, { Cookie: cookie });
    expect(r.status).toBe(303);
    const p = await env.DB.prepare('SELECT * FROM producers WHERE business_name = ?').bind('Edit Farm Shop').first();
    expect(p.delivery_miles).toBe(15);
    expect(p.slug).toBe('edit-farm-shop');
  });
});

describe('public page and promote kit', () => {
  it('is private until approved, then public without codes', async () => {
    const cookie = await producer('public@example.com', 'Public Bakery');
    await post('/producer/deals/new', goodDeal({ title: 'Free loaf with any order', kind: 'free_item', percent: '', free_item: 'loaf', code: 'SECRET99' }), { Cookie: cookie });
    expect((await get('/p/public-bakery')).status).toBe(404);
    const preview = await (await get('/p/public-bakery', { Cookie: cookie })).text();
    expect(preview).toContain('Preview');
    await env.DB.prepare("UPDATE producers SET status = 'approved' WHERE slug = 'public-bakery'").run();
    const r = await get('/p/public-bakery');
    expect(r.status).toBe(200);
    const t = await r.text();
    expect(t).toContain('Free loaf with any order');
    expect(t).not.toContain('SECRET99');
    expect(t).not.toContain('01952');
  });
  it('makes a QR code, poster and Facebook post', async () => {
    const cookie = await producer('promo@example.com', 'Promo Dairy');
    const kit = await (await get('/producer/promote', { Cookie: cookie })).text();
    expect(kit).toContain('<svg');
    expect(kit).toContain('/p/promo-dairy');
    const poster = await get('/producer/promote/poster', { Cookie: cookie });
    expect(poster.headers.get('Content-Security-Policy')).toContain("default-src 'self'");
    expect(await poster.text()).toContain('Scan to see our deal');
  });
});

describe('expiry reminders', () => {
  it('emails once, 7 days before a deal ends', async () => {
    const cookie = await producer('remind@example.com', 'Remind Farm');
    await post('/producer/deals/new', goodDeal({ title: 'Ending soon deal', starts_on: today, ends_on: addDays(today, 14) }), { Cookie: cookie });
    await env.DB.prepare("UPDATE deals SET starts_on = ?, ends_on = ? WHERE title = 'Ending soon deal'").bind(addDays(today, -10), addDays(today, 6)).run();
    expect(await sendExpiryReminders(env)).toBeGreaterThanOrEqual(1);
    expect((await outbox('remind@example.com')).some((m) => m.subject.includes('ends on'))).toBe(true);
    const before = (await outbox('remind@example.com')).length;
    await sendExpiryReminders(env);
    expect((await outbox('remind@example.com')).length).toBe(before);
  });
});
