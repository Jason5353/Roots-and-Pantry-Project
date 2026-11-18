import { describe, it, expect } from 'vitest';
import { env, exports } from 'cloudflare:workers';
import { todayUK, addDays } from '../src/producer.js';
import { processFacebookQueue, buildPost, FB_GRAPH } from '../src/facebook.js';

const BASE = 'https://test-app.example';
let ipN = 0;
const get = (path, headers = {}) => exports.default.fetch(new Request(BASE + path, { headers, redirect: 'manual' }));
const post = (path, data, headers = {}) => exports.default.fetch(new Request(BASE + path, {
  method: 'POST', redirect: 'manual',
  headers: { 'Content-Type': 'application/x-www-form-urlencoded', Origin: BASE, 'Sec-Fetch-Site': 'same-origin', 'CF-Connecting-IP': `198.18.0.${(ipN++ % 200) + 20}`, ...headers },
  body: new URLSearchParams(data).toString(),
}));
const outbox = (to) => env.DB.prepare('SELECT * FROM dev_outbox WHERE to_email = ? ORDER BY id DESC').bind(to).all().then((r) => r.results);
const today = todayUK();
const q = (sql, ...b) => env.DB.prepare(sql).bind(...b);

async function signIn(email) {
  await post('/signin', { email, 'cf-turnstile-response': 'dev-pass' });
  const code = (await outbox(email))[0].subject.match(/(\d{6})/)[1];
  const r = await post('/signin/code', { email, code });
  return r.headers.get('Set-Cookie').split(';')[0];
}
let owner;
const ownerCookie = async () => (owner ||= await signIn('hello@rootsandpantry.co.uk'));
async function producer(email, name) {
  const cookie = await signIn(email);
  await post('/producer/join', { business_name: name, contact_name: 'Sam', phone: '01952 123456', description: 'Family farm shop with our own sausages and bacon.', postcode: 'TF1 2EB', county: 'Shropshire', terms: 'yes' }, { Cookie: cookie });
  const p = await q('SELECT * FROM producers WHERE business_name = ?', name).first();
  return { cookie, p };
}
const approve = async (p) => post(`/admin/producers/${p.id}/status`, { to: 'approved' }, { Cookie: await ownerCookie() });
const offer = (o = {}) => ({ kind: 'multibuy', title: '4 sausages for £12.50', price: '£12.50 for 4', how: 'in_person', starts_on: today, ends_on: addDays(today, 7), ...o });
const due = (id) => q('UPDATE fb_posts SET post_after = 0 WHERE id = ?', id).run();
const live = { ...env, FB_AUTOPOST: 'on', FB_PAGE_TOKEN: 'secret-token-123' };
function fakeFacebook(reply = { id: '123_456' }, status = 200) {
  const calls = [];
  const fetchImpl = async (url, init) => { calls.push({ url, body: new URLSearchParams(init.body.toString()) }); return new Response(JSON.stringify(reply), { status }); };
  return { calls, fetchImpl };
}

describe('Facebook auto-posting', () => {
  it('queues a welcome post on first approval, held for an hour, and posts it with a link to the producer page', async () => {
    const { cookie, p } = await producer('fb-farm@example.com', 'FB Test Farm');
    await post('/producer/offers/new', offer(), { Cookie: cookie }); // before approval: not queued on its own
    await approve(p);
    const rows = (await q('SELECT * FROM fb_posts WHERE producer_id = ?', p.id).all()).results;
    expect(rows.map((r) => r.kind)).toEqual(['producer']);
    expect(rows[0].post_after).toBeGreaterThan(Date.now() / 1000 + 3500);

    await due(rows[0].id);
    const fb = fakeFacebook();
    const d = await processFacebookQueue(live, { fetchImpl: fb.fetchImpl });
    expect(d.posted).toBe(1);
    expect(fb.calls[0].url).toBe(`${FB_GRAPH}/${env.FB_PAGE_ID}/feed`);
    expect(fb.calls[0].body.get('link')).toBe(`${env.APP_URL}/p/${p.slug}`);
    expect(fb.calls[0].body.get('message')).toContain('New on Roots & Pantry: FB Test Farm');
    expect(fb.calls[0].body.get('message')).toContain('On now: 4 sausages for £12.50');
    expect(fb.calls[0].body.get('message')).not.toContain('01952');
    const after = await q('SELECT * FROM fb_posts WHERE id = ?', rows[0].id).first();
    expect(after.status).toBe('posted');
    expect(after.fb_post_id).toBe('123_456');
  });

  it("doesn't post again when a suspended producer is reinstated", async () => {
    const { p } = await producer('fb-reinstate@example.com', 'FB Reinstate Farm');
    await approve(p);
    await post(`/admin/producers/${p.id}/status`, { to: 'suspended', 'reason-suspended': 'Checking your code works.' }, { Cookie: await ownerCookie() });
    await approve(p);
    expect((await q('SELECT COUNT(*) AS n FROM fb_posts WHERE producer_id = ?', p.id).first()).n).toBe(1);
  });

  it('posts a new offer from a live producer with a link straight to the offer, but never alcohol', async () => {
    const { cookie, p } = await producer('fb-offers@example.com', 'FB Offers Farm');
    await approve(p);
    await post('/producer/offers/new', offer({ kind: 'preorder', title: 'Bronze turkeys', price: 'From £60', christmas: 'yes', ends_on: addDays(today, 20), ready_text: 'Collect 22 to 24 December' }), { Cookie: cookie });
    await post('/producer/offers/new', offer({ kind: 'seasonal', title: 'Mulled cider box', price: '£18', alcohol: 'yes' }), { Cookie: cookie });
    const rows = (await q("SELECT * FROM fb_posts WHERE producer_id = ? AND kind = 'offer'", p.id).all()).results;
    expect(rows.length).toBe(1);
    const o = await q('SELECT * FROM offers WHERE title = ?', 'Bronze turkeys').first();
    const built = await buildPost(env, rows[0]);
    expect(built.link).toBe(`${env.APP_URL}/p/${p.slug}#offer-${o.id}`);
    expect(built.message).toContain('Christmas from FB Offers Farm');
    expect(built.message).toContain('Order by');
    expect(built.message).toContain('Collect 22 to 24 December');
    // The public page has the anchor the link points at.
    expect(await (await get(`/p/${p.slug}`)).text()).toContain(`id="offer-${o.id}"`);
  });

  it('skips an offer that was paused during the hold, and records a dry run on test', async () => {
    const { cookie, p } = await producer('fb-pause@example.com', 'FB Pause Farm');
    await approve(p);
    await post('/producer/offers/new', offer({ title: 'Paused soon' }), { Cookie: cookie });
    await post('/producer/offers/new', offer({ title: 'Still running' }), { Cookie: cookie });
    const paused = await q('SELECT id FROM offers WHERE title = ?', 'Paused soon').first();
    await post(`/producer/offers/${paused.id}/status`, { to: 'paused' }, { Cookie: cookie });
    await q("UPDATE fb_posts SET post_after = 0 WHERE producer_id = ? AND kind = 'offer'", p.id).run();
    await processFacebookQueue(env); // test env: FB_AUTOPOST is off
    const byTitle = async (t) => q('SELECT f.* FROM fb_posts f JOIN offers o ON o.id = f.item_id WHERE o.title = ?', t).first();
    expect((await byTitle('Paused soon')).status).toBe('skipped');
    const dry = await byTitle('Still running');
    expect(dry.status).toBe('dry_run');
    expect(dry.message).toContain('Still running');
  });

  it('marks a failure without leaking the token, and emails hello@', async () => {
    const { p } = await producer('fb-fail@example.com', 'FB Fail Farm');
    await approve(p);
    const row = await q('SELECT id FROM fb_posts WHERE producer_id = ?', p.id).first();
    await due(row.id);
    const fb = fakeFacebook({ error: { message: 'Error validating access token: Session has expired' } }, 400);
    const d = await processFacebookQueue(live, { fetchImpl: fb.fetchImpl });
    expect(d.failed).toBe(1);
    const after = await q('SELECT * FROM fb_posts WHERE id = ?', row.id).first();
    expect(after.status).toBe('failed');
    expect(after.note).toContain('Session has expired');
    expect(after.note).not.toContain('secret-token-123');
    const mail = (await outbox(env.NOTIFY_EMAIL))[0];
    expect(mail.subject).toMatch(/Facebook post failed/);
    expect(mail.body).not.toContain('secret-token-123');
  });

  it('lets an admin see the queue, cancel a post, and post one now', async () => {
    const { p } = await producer('fb-admin@example.com', 'FB Admin Farm');
    await approve(p);
    const row = await q('SELECT id FROM fb_posts WHERE producer_id = ?', p.id).first();
    const cookie = await ownerCookie();
    let page = await (await get('/admin/facebook', { Cookie: cookie })).text();
    expect(page).toContain('New producer: FB Admin Farm');
    expect(page).toContain('Automatic posting is <b>off</b>');
    expect((await post(`/admin/facebook/${row.id}/cancel`, {}, { Cookie: cookie })).status).toBe(303);
    expect((await q('SELECT status, note FROM fb_posts WHERE id = ?', row.id).first()).status).toBe('cancelled');
    expect((await post(`/admin/facebook/${row.id}/cancel`, {}, { Cookie: cookie })).status).toBe(404);

    const { p: p2 } = await producer('fb-admin2@example.com', 'FB Admin Farm Two');
    await approve(p2);
    const row2 = await q('SELECT id FROM fb_posts WHERE producer_id = ?', p2.id).first();
    expect((await post(`/admin/facebook/${row2.id}/now`, {}, { Cookie: cookie })).status).toBe(303);
    expect((await q('SELECT status FROM fb_posts WHERE id = ?', row2.id).first()).status).toBe('dry_run');
  });

  it('hides the Facebook page from non-admins', async () => {
    const { cookie } = await producer('fb-nosy@example.com', 'FB Nosy Farm');
    expect((await get('/admin/facebook', { Cookie: cookie })).status).toBe(404);
  });
});

describe('link previews', () => {
  it('gives approved producer pages and the Christmas page Open Graph tags, but not pending pages', async () => {
    const { p } = await producer('og-farm@example.com', 'OG Farm');
    let t = await (await get(`/p/${p.slug}`)).text();
    expect(t).not.toContain('og:title');
    await approve(p);
    t = await (await get(`/p/${p.slug}`)).text();
    expect(t).toContain('<meta property="og:title" content="OG Farm on Roots &amp; Pantry" />');
    expect(t).toContain(`<meta property="og:url" content="${env.APP_URL}/p/${p.slug}" />`);
    expect(t).toContain(`${env.APP_URL}/og/producer.png`);
    t = await (await get('/producers/christmas')).text();
    expect(t).toContain(`${env.APP_URL}/og/christmas.png`);
    const img = await env.ASSETS.fetch(new Request(`${BASE}/og/producer.png`));
    expect(img.status).toBe(200);
    expect(img.headers.get('Content-Type')).toContain('image/png');
  });
});
