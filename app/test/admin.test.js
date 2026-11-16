import { describe, it, expect, beforeAll } from 'vitest';
import { env, exports } from 'cloudflare:workers';

const BASE = 'https://test-app.example';
let ipN = 0;
const ip = () => `192.0.2.${(ipN++ % 250) + 1}`;
const get = (path, headers = {}) => exports.default.fetch(new Request(BASE + path, { headers, redirect: 'manual' }));
const post = (path, data, headers = {}) => exports.default.fetch(new Request(BASE + path, {
  method: 'POST', redirect: 'manual',
  headers: { 'Content-Type': 'application/x-www-form-urlencoded', Origin: BASE, 'Sec-Fetch-Site': 'same-origin', 'CF-Connecting-IP': ip(), ...headers },
  body: new URLSearchParams(data).toString(),
}));
const outbox = (to) => env.DB.prepare('SELECT * FROM dev_outbox WHERE to_email = ? ORDER BY id DESC').bind(to).all().then((r) => r.results);
const OWNER = 'hello@rootsandpantry.co.uk';

async function signIn(email) {
  await post('/signin', { email, 'cf-turnstile-response': 'dev-pass' });
  const code = (await outbox(email))[0].subject.match(/(\d{6})/)[1];
  const r = await post('/signin/code', { email, code });
  return { cookie: r.headers.get('Set-Cookie').split(';')[0], location: r.headers.get('Location') };
}

async function newProducer(email, name) {
  const { cookie } = await signIn(email);
  await post('/producer/join', { business_name: name, contact_name: 'Pat', phone: '01952 123456', description: 'Small family bakery making sourdough.', postcode: 'TF1 2EB', county: 'Shropshire', terms: 'yes' }, { Cookie: cookie });
  const p = await env.DB.prepare('SELECT * FROM producers WHERE business_name = ?').bind(name).first();
  return { cookie, p };
}

let owner;
beforeAll(async () => {
  const s = await signIn(OWNER);
  owner = s.cookie;
  expect(s.location).toBe('/admin');
});

describe('admin access', () => {
  it('hides admin from producers and signed-out visitors', async () => {
    const { cookie } = await newProducer('bread@example.com', 'Wrekin Bakery');
    expect((await get('/admin', { Cookie: cookie })).status).toBe(404);
    expect((await get('/admin/producers', { Cookie: cookie })).status).toBe(404);
    expect((await get('/admin')).status).toBe(303);
  });

  it('shows the overview to the owner', async () => {
    const r = await get('/admin', { Cookie: owner });
    expect(r.status).toBe(200);
    const t = await r.text();
    expect(t).toContain('producers with a live deal');
    expect(t).toContain('Wrekin Bakery');
  });

  it('lets an admin carry on within 30 minutes of activity', async () => {
    const { cookie } = await signIn(OWNER);
    await env.DB.prepare('UPDATE sessions SET last_auth_at = ? WHERE id_hash = (SELECT id_hash FROM sessions ORDER BY created_at DESC LIMIT 1)').bind(Math.floor(Date.now() / 1000) - 25 * 60).run();
    expect((await get('/admin/producers', { Cookie: cookie })).status).toBe(200);
  });

  it('asks for a fresh code after 30 minutes idle', async () => {
    const { cookie } = await signIn(OWNER);
    await env.DB.prepare('UPDATE sessions SET last_auth_at = ?').bind(Math.floor(Date.now() / 1000) - 31 * 60).run();
    let r = await get('/admin/producers', { Cookie: cookie });
    expect(r.status).toBe(303);
    expect(r.headers.get('Location')).toBe(`${BASE}/admin/confirm?next=%2Fadmin%2Fproducers`);
    r = await post('/admin/producers/xxxxxxxxxxxx/status', { to: 'approved' }, { Cookie: cookie });
    expect(r.headers.get('Location')).toContain('/admin/confirm');
    r = await post('/admin/confirm/send', { next: '/admin/producers' }, { Cookie: cookie });
    expect(r.status).toBe(200);
    const mail = (await outbox(OWNER))[0];
    expect(mail.subject).toMatch(/admin code: \d{6}/);
    expect(mail.body).not.toMatch(/https?:\/\//);
    r = await post('/admin/confirm', { next: '/admin/producers', code: '000000' === mail.subject.slice(-6) ? '111111' : '000000' }, { Cookie: cookie });
    expect(r.status).toBe(400);
    r = await post('/admin/confirm', { next: '//evil.example', code: mail.subject.slice(-6) }, { Cookie: cookie });
    expect(r.headers.get('Location')).toBe(`${BASE}/admin`);
    expect((await get('/admin/producers', { Cookie: cookie })).status).toBe(200);
    owner = cookie;
  });
});

describe('producer review', () => {
  it('approves a producer, which makes the public page live and emails them', async () => {
    const { p } = await newProducer('cheese2@example.com', 'Hill Top Cheese');
    let pub = await get(`/p/${p.slug}`);
    expect(pub.status).toBe(200);
    let t = await pub.text();
    expect(t).toContain('Hill Top Cheese is joining Roots &amp; Pantry');
    expect(t).not.toContain('01952');
    const r = await post(`/admin/producers/${p.id}/status`, { to: 'approved' }, { Cookie: owner });
    expect(r.status).toBe(303);
    expect((await env.DB.prepare('SELECT status FROM producers WHERE id = ?').bind(p.id).first()).status).toBe('approved');
    expect((await outbox('cheese2@example.com'))[0].subject).toBe('Your Roots & Pantry listing is live');
    expect((await get(`/p/${p.slug}`)).status).toBe(200);
  });

  it('needs a reason to suspend, then hides the listing and tells the producer why', async () => {
    const { cookie, p } = await newProducer('honey@example.com', 'Bee Happy Honey');
    await post(`/admin/producers/${p.id}/status`, { to: 'approved' }, { Cookie: owner });
    let r = await post(`/admin/producers/${p.id}/status`, { to: 'suspended', 'reason-suspended': '' }, { Cookie: owner });
    expect(r.status).toBe(400);
    r = await post(`/admin/producers/${p.id}/status`, { to: 'suspended', 'reason-suspended': 'Your code ROOTS10 does not work on your website.' }, { Cookie: owner });
    expect(r.status).toBe(303);
    const pub = await get(`/p/${p.slug}`);
    expect(pub.status).toBe(200);
    const pt = await pub.text();
    expect(pt).toContain('Bee Happy Honey is paused for now');
    expect(pt).not.toContain('ROOTS10');
    const own = await (await get(`/p/${p.slug}`, { Cookie: cookie })).text();
    expect(own).toContain('Your listing is paused');
    const mail = (await outbox('honey@example.com'))[0];
    expect(mail.subject).toBe('Your Roots & Pantry listing is paused');
    expect(mail.body).toContain('ROOTS10 does not work');
    expect(await (await get('/producer', { Cookie: cookie })).text()).toContain('ROOTS10 does not work');
    await post(`/admin/producers/${p.id}/status`, { to: 'approved' }, { Cookie: owner });
    expect((await outbox('honey@example.com'))[0].subject).toBe('Your Roots & Pantry listing is live again');
  });

  it('tells visitors a rejected or unknown producer is not listed', async () => {
    const { p } = await newProducer('nope@example.com', 'Not Food Ltd');
    await post(`/admin/producers/${p.id}/status`, { to: 'rejected', 'reason-rejected': 'We only list food and drink businesses.' }, { Cookie: owner });
    const r = await get(`/p/${p.slug}`);
    expect(r.status).toBe(404);
    const t = await r.text();
    expect(t).toContain('This producer isn&#39;t listed');
    expect(t).not.toContain('Not Food Ltd');
    expect((await get('/p/no-such-producer')).status).toBe(404);
  });

  it('ignores status changes that skip a step', async () => {
    const { p } = await newProducer('jam@example.com', 'Jam Jar');
    await post(`/admin/producers/${p.id}/status`, { to: 'suspended', 'reason-suspended': 'Testing a skipped step here.' }, { Cookie: owner });
    expect((await env.DB.prepare('SELECT status FROM producers WHERE id = ?').bind(p.id).first()).status).toBe('pending');
  });

  it('ends a deal with a reason', async () => {
    const { cookie, p } = await newProducer('pies@example.com', 'Pie Shop');
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/London' }).format(new Date());
    const end = new Date(Date.now() + 40 * 86400000).toISOString().slice(0, 10);
    await post('/producer/deals/new', { title: 'Free pie with any order', kind: 'free_item', free_item: 'pork pie with any order', products: 'pie', how: 'in_person', redemption: 'mention', starts_on: today, ends_on: end }, { Cookie: cookie });
    const d = await env.DB.prepare('SELECT id FROM deals WHERE producer_id = ?').bind(p.id).first();
    expect((await post(`/admin/deals/${d.id}/end`, { [`end-${d.id}`]: 'short' }, { Cookie: owner })).status).toBe(400);
    await post(`/admin/deals/${d.id}/end`, { [`end-${d.id}`]: 'Non-food items are not allowed in deals.' }, { Cookie: owner });
    expect((await env.DB.prepare('SELECT status FROM deals WHERE id = ?').bind(d.id).first()).status).toBe('ended');
    expect((await outbox('pies@example.com'))[0].body).toContain('Non-food items');
  });
});

describe('messages and team', () => {
  it('lists contact messages and marks them answered', async () => {
    await post('/contact', { name: 'Ann', email: 'ann@example.com', topic: 'Press', message: 'Can we interview you?', 'cf-turnstile-response': 'dev-pass' });
    const m = await env.DB.prepare("SELECT id FROM messages WHERE email = 'ann@example.com'").first();
    expect(await (await get('/admin/messages', { Cookie: owner })).text()).toContain('Can we interview you?');
    await post(`/admin/messages/${m.id}/status`, { to: 'answered' }, { Cookie: owner });
    expect((await env.DB.prepare('SELECT status FROM messages WHERE id = ?').bind(m.id).first()).status).toBe('answered');
  });

  it('lets the owner add a moderator, who cannot see team or audit pages', async () => {
    expect((await post('/admin/team/add', { email: 'Mod@Example.com' }, { Cookie: owner })).status).toBe(400); // name needed
    await post('/admin/team/add', { email: 'Mod@Example.com', display_name: 'Jasmine' }, { Cookie: owner });
    const u = await env.DB.prepare("SELECT role, display_name FROM users WHERE email = 'mod@example.com'").first();
    expect(u.role).toBe('moderator');
    expect(u.display_name).toBe('Jasmine');
    const { cookie, location } = await signIn('mod@example.com');
    expect(location).toBe('/admin');
    const bar = await (await get('/admin', { Cookie: cookie })).text();
    expect(bar).toContain('Admin area');
    expect(bar).toContain('Signed in as </span>Jasmine<small>Moderator</small>');
    expect((await get('/admin/producers', { Cookie: cookie })).status).toBe(200);
    expect((await get('/admin/team', { Cookie: cookie })).status).toBe(404);
    expect((await get('/admin/audit', { Cookie: cookie })).status).toBe(404);
    expect((await post('/admin/team/add', { email: 'x@example.com' }, { Cookie: cookie })).status).toBe(404);
    const audit = await (await get('/admin/audit', { Cookie: owner })).text();
    expect(audit).toContain('team.moderator_added');
    const id = (await env.DB.prepare("SELECT id FROM users WHERE email = 'mod@example.com'").first()).id;
    await post('/admin/team/remove', { id }, { Cookie: owner });
    expect((await get('/admin', { Cookie: cookie })).status).toBe(303);
  });
});
