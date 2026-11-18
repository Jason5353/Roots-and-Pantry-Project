import { describe, it, expect } from 'vitest';
import { env, exports } from 'cloudflare:workers';
import { todayUK, addDays } from '../src/producer.js';
import { validateOffer } from '../src/offers.js';

const BASE = 'https://test-app.example';
let ipN = 0;
const get = (path, headers = {}) => exports.default.fetch(new Request(BASE + path, { headers, redirect: 'manual' }));
const post = (path, data, headers = {}) => exports.default.fetch(new Request(BASE + path, {
  method: 'POST', redirect: 'manual',
  headers: { 'Content-Type': 'application/x-www-form-urlencoded', Origin: BASE, 'Sec-Fetch-Site': 'same-origin', 'CF-Connecting-IP': `203.0.113.${(ipN++ % 200) + 20}`, ...headers },
  body: new URLSearchParams(data).toString(),
}));
const outbox = (to) => env.DB.prepare('SELECT * FROM dev_outbox WHERE to_email = ? ORDER BY id DESC').bind(to).all().then((r) => r.results);
const today = todayUK();

async function signIn(email) {
  await post('/signin', { email, 'cf-turnstile-response': 'dev-pass' });
  const code = (await outbox(email))[0].subject.match(/(\d{6})/)[1];
  const r = await post('/signin/code', { email, code });
  return r.headers.get('Set-Cookie').split(';')[0];
}
async function producer(email, name, postcode = 'TF1 2EB') {
  const cookie = await signIn(email);
  await post('/producer/join', { business_name: name, contact_name: 'Sam', phone: '01952 123456', description: 'Family farm shop with our own meat.', postcode, county: 'Shropshire', terms: 'yes' }, { Cookie: cookie });
  const p = await env.DB.prepare('SELECT * FROM producers WHERE business_name = ?').bind(name).first();
  return { cookie, p };
}
const approve = (id) => env.DB.prepare("UPDATE producers SET status = 'approved' WHERE id = ?").bind(id).run();
const goodOffer = (o = {}) => ({ kind: 'multibuy', title: '4 sausages for £12.50', price: '£12.50 for 4', how: 'in_person', starts_on: today, ends_on: addDays(today, 7), ...o });

describe('offer rules', () => {
  const base = { kind: 'multibuy', title: '4 sausages for £12.50', price: '£12.50', details: '', how: 'in_person', order_url: '', starts_on: today, ends_on: addDays(today, 3), ready_text: '', allergens: '' };
  it('accepts exactly 3 days', () => expect(validateOffer(base)).toEqual([]));
  it('rejects under 3 days', () => expect(validateOffer({ ...base, ends_on: addDays(today, 2) })[0].field).toBe('ends_on'));
  it('needs a price with a number', () => expect(validateOffer({ ...base, price: 'cheap' })[0].field).toBe('price'));
  it('only allows the three kinds', () => expect(validateOffer({ ...base, kind: 'flash_sale' })[0].field).toBe('kind'));
  it('rejects health claims', () => expect(validateOffer({ ...base, details: 'Honey that boosts immunity' }).some((e) => e.msg.includes('health claims'))).toBe(true));
});

describe('offers and specials', () => {
  it('lets a producer add, pause and end an offer, shown below exclusive deals on the public page', async () => {
    const { cookie, p } = await producer('maynard@example.com', 'Maynard Test Farm');
    let r = await post('/producer/offers/new', goodOffer({ details: 'Pork and leek, while stocks last.' }), { Cookie: cookie });
    expect(r.status).toBe(303);
    const o = await env.DB.prepare('SELECT * FROM offers WHERE producer_id = ?').bind(p.id).first();
    expect(o.kind).toBe('multibuy');
    expect(await (await get('/producer', { Cookie: cookie })).text()).toContain('4 sausages for £12.50');

    await approve(p.id);
    await post('/producer/deals/new', { title: '10% off all our bacon', kind: 'percent', percent: '10', products: 'bacon', how: 'in_person', redemption: 'mention', starts_on: today, ends_on: addDays(today, 20) }, { Cookie: cookie });
    let page = await (await get(`/p/${p.slug}`)).text();
    expect(page).toContain('Offers and specials');
    expect(page.indexOf('Exclusive deals')).toBeLessThan(page.indexOf('Offers and specials'));
    expect(page).toContain('Pork and leek, while stocks last.');

    await post(`/producer/offers/${o.id}/status`, { to: 'paused' }, { Cookie: cookie });
    page = await (await get(`/p/${p.slug}`)).text();
    expect(page).not.toContain('4 sausages for £12.50');
    await post(`/producer/offers/${o.id}/status`, { to: 'ended' }, { Cookie: cookie });
    expect((await env.DB.prepare('SELECT status FROM offers WHERE id = ?').bind(o.id).first()).status).toBe('ended');
  });

  it('shows form errors for a too-short offer', async () => {
    const { cookie } = await producer('short@example.com', 'Short Offer Farm');
    const r = await post('/producer/offers/new', goodOffer({ ends_on: addDays(today, 1) }), { Cookie: cookie });
    expect(r.status).toBe(400);
    expect(await r.text()).toContain('at least 3 days');
  });

  it("won't let one producer edit another's offer", async () => {
    const a = await producer('a-offer@example.com', 'Offer Farm A');
    const b = await producer('b-offer@example.com', 'Offer Farm B');
    await post('/producer/offers/new', goodOffer(), { Cookie: a.cookie });
    const o = await env.DB.prepare('SELECT id FROM offers WHERE producer_id = ?').bind(a.p.id).first();
    expect((await get(`/producer/offers/${o.id}/edit`, { Cookie: b.cookie })).status).toBe(404);
    expect((await post(`/producer/offers/${o.id}/status`, { to: 'ended' }, { Cookie: b.cookie })).status).toBe(404);
  });

  it('lets an admin end an offer with a reason, which is emailed', async () => {
    const { cookie, p } = await producer('ended-offer@example.com', 'Ended Offer Farm');
    await post('/producer/offers/new', goodOffer({ title: 'Gift box of honey' , kind: 'seasonal', price: '£20' }), { Cookie: cookie });
    const o = await env.DB.prepare('SELECT id FROM offers WHERE producer_id = ?').bind(p.id).first();
    const owner = await signIn('hello@rootsandpantry.co.uk');
    let r = await post(`/admin/offers/${o.id}/end`, { [`end-${o.id}`]: 'short' }, { Cookie: owner });
    expect(r.status).toBe(400);
    expect((await env.DB.prepare('SELECT status FROM offers WHERE id = ?').bind(o.id).first()).status).toBe('active');
    r = await post(`/admin/offers/${o.id}/end`, { [`end-${o.id}`]: 'The price on your website is different.' }, { Cookie: owner });
    expect(r.status).toBe(303);
    expect((await env.DB.prepare('SELECT status FROM offers WHERE id = ?').bind(o.id).first()).status).toBe('ended');
    expect((await outbox('ended-offer@example.com'))[0].subject).toMatch(/ended one of your Roots & Pantry offers/);
  });
});

describe('Christmas page', () => {
  it('lists live Christmas offers and exclusive deals from approved producers only, soonest order-by first', async () => {
    const live = await producer('xmas@example.com', 'Turkey Farm');
    await approve(live.p.id);
    await post('/producer/offers/new', goodOffer({ kind: 'preorder', title: 'Free-range bronze turkeys', price: 'From £60', christmas: 'yes', ends_on: addDays(today, 20), ready_text: 'Collect 22 to 24 December' }), { Cookie: live.cookie });
    await post('/producer/offers/new', goodOffer({ kind: 'seasonal', title: 'Christmas pudding', price: '£12', christmas: 'yes', ends_on: addDays(today, 10) }), { Cookie: live.cookie });
    await post('/producer/offers/new', goodOffer({ title: 'Not a Christmas thing', price: '£5' }), { Cookie: live.cookie });
    await post('/producer/deals/new', { title: '10% off Christmas hampers', kind: 'percent', percent: '10', products: 'hamper', how: 'in_person', redemption: 'mention', starts_on: today, ends_on: addDays(today, 30), christmas: 'yes' }, { Cookie: live.cookie });
    const pending = await producer('xmas-pending@example.com', 'Pending Turkey Farm');
    await post('/producer/offers/new', goodOffer({ kind: 'preorder', title: 'Secret pending turkeys', price: '£50', christmas: 'yes' }), { Cookie: pending.cookie });

    const t = await (await get('/producers/christmas')).text();
    expect(t).toContain('Christmas from local producers');
    expect(t).toContain('Free-range bronze turkeys');
    expect(t).toContain('Order by');
    expect(t).toContain('Collect 22 to 24 December');
    expect(t).toContain('10% off Christmas hampers');
    expect(t).not.toContain('Not a Christmas thing');
    expect(t).not.toContain('Secret pending turkeys');
    expect(t.indexOf('10% off Christmas hampers')).toBeLessThan(t.indexOf('Christmas pudding'));
    expect(t.indexOf('Christmas pudding')).toBeLessThan(t.indexOf('Free-range bronze turkeys'));
  });

  it('filters by postcode district and cuts a full postcode down', async () => {
    let r = await get('/producers/christmas?near=TF1%202EB&miles=10');
    expect(r.status).toBe(303);
    expect(r.headers.get('Location')).toContain('near=TF1&miles=10');
    r = await get('/producers/christmas?near=ZZ9&miles=10');
    expect(r.status).toBe(400);
    const far = await (await get('/producers/christmas?near=TR1&miles=10')).text();
    expect(far).not.toContain('Free-range bronze turkeys');
  });
});
