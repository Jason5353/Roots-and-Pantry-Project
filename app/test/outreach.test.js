import { describe, it, expect, beforeAll } from 'vitest';
import { env, exports } from 'cloudflare:workers';
import { parseCsv, outreachDaily } from '../src/outreach.js';
import { cleanUp } from '../src/services.js';

const BASE = 'https://test-app.example';
let ipN = 0;
const ip = () => `198.51.100.${(ipN++ % 250) + 1}`;
const get = (path, headers = {}) => exports.default.fetch(new Request(BASE + path, { headers, redirect: 'manual' }));
const post = (path, data, headers = {}) => exports.default.fetch(new Request(BASE + path, {
  method: 'POST', redirect: 'manual',
  headers: { 'Content-Type': 'application/x-www-form-urlencoded', Origin: BASE, 'Sec-Fetch-Site': 'same-origin', 'CF-Connecting-IP': ip(), ...headers },
  body: new URLSearchParams(data).toString(),
}));
const postFile = (path, csv, headers = {}) => {
  const fd = new FormData();
  fd.append('file', new File([csv], 'list.csv', { type: 'text/csv' }));
  return exports.default.fetch(new Request(BASE + path, { method: 'POST', redirect: 'manual', headers: { Origin: BASE, 'Sec-Fetch-Site': 'same-origin', ...headers }, body: fd }));
};
const outbox = (to) => env.DB.prepare('SELECT * FROM dev_outbox WHERE to_email = ? ORDER BY id DESC').bind(to).all().then((r) => r.results);
const OWNER = 'hello@rootsandpantry.co.uk';
const item = (name) => env.DB.prepare('SELECT * FROM outreach WHERE business_name = ?').bind(name).first();
const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/London' }).format(new Date());

async function signIn(email) {
  await post('/signin', { email, 'cf-turnstile-response': 'dev-pass' });
  const code = (await outbox(email))[0].subject.match(/(\d{6})/)[1];
  const r = await post('/signin/code', { email, code });
  return r.headers.get('Set-Cookie').split(';')[0];
}

let owner;
beforeAll(async () => {
  owner = await signIn(OWNER);
  await env.DB.prepare("UPDATE users SET display_name = 'Jason' WHERE email = ?").bind(OWNER).run();
});

describe('outreach', () => {
  it('is admin only', async () => {
    const cookie = await signIn('someone@example.com');
    expect((await get('/admin/outreach', { Cookie: cookie })).status).toBe(404);
    expect((await get('/admin/outreach')).status).toBe(303);
  });

  it('shows who is signed in on admin pages', async () => {
    const t = await (await get('/admin/outreach', { Cookie: owner })).text();
    expect(t).toContain('Admin area');
    expect(t).toContain('Signed in as </span>Jason<small>Owner</small>');
    expect(t).toContain('href="/admin/outreach" aria-current="page"');
  });

  it('adds a producer, refuses duplicates, and offers email only to a Ltd company', async () => {
    expect((await post('/admin/outreach/new', { business_name: '' }, { Cookie: owner })).status).toBe(400);
    const r = await post('/admin/outreach/new', { business_name: 'Corvedale Creamery', contact_name: 'Sarah Jones', kind: 'ltd', company_number: '09876543', email: 'Sarah@Corvedale.example', town: 'Craven Arms', county: 'Shropshire', products: 'Wenlock Edge cheddar' }, { Cookie: owner });
    expect(r.status).toBe(303);
    const o = await item('Corvedale Creamery');
    expect(o.email).toBe('sarah@corvedale.example');
    expect(o.stage).toBe('todo');
    expect((await post('/admin/outreach/new', { business_name: 'Other name', email: 'sarah@corvedale.example' }, { Cookie: owner })).status).toBe(400);
    const page = await (await get(`/admin/outreach/${o.id}`, { Cookie: owner })).text();
    expect(page).toContain('Hi Sarah,');
    expect(page).toContain("I&#39;m Jason and I run Roots &amp; Pantry");
    expect(page).toContain('your Wenlock Edge cheddar');
    expect(page).toContain('company number 14975379');
    expect(page).toContain('mailto:sarah%40corvedale.example');

    await post('/admin/outreach/new', { business_name: 'Wrekin Valley Butchers', kind: 'sole', email: 'wv@example.com', address: '1 High St\nWellington\nTF1 1AA' }, { Cookie: owner });
    const sole = await item('Wrekin Valley Butchers');
    const sp = await (await get(`/admin/outreach/${sole.id}`, { Cookie: owner })).text();
    expect(sp).not.toContain('id="emailtext"');
    expect(sp).not.toContain('<option value="email"');
    expect(sp).toContain(`/admin/outreach/${sole.id}/letter`);
    // Even a forged "email" mark is refused for a sole trader.
    await post(`/admin/outreach/${sole.id}/contacted`, { method: 'email' }, { Cookie: owner });
    await post(`/admin/outreach/${sole.id}/contacted`, { method: 'facebook' }, { Cookie: owner });
    expect((await item('Wrekin Valley Butchers')).contact_count).toBe(0);
    expect(sp).not.toContain('<option value="facebook"');
    const letter = await (await get(`/admin/outreach/${sole.id}/letter`, { Cookie: owner })).text();
    expect(letter).toContain('Dear Wrekin Valley Butchers,');
    expect(letter).toContain('Registered office');
  });

  it('moves through first contact, follow-up and no reply', async () => {
    const o = await item('Corvedale Creamery');
    await post(`/admin/outreach/${o.id}/contacted`, { method: 'email' }, { Cookie: owner });
    let x = await item('Corvedale Creamery');
    expect(x.stage).toBe('contacted');
    expect(x.contact_count).toBe(1);
    expect(x.follow_up_on > today()).toBe(true);
    // Make the follow-up due today: it shows on the due tab and the daily email goes out.
    await env.DB.prepare('UPDATE outreach SET follow_up_on = ? WHERE id = ?').bind(today(), o.id).run();
    expect(await (await get('/admin/outreach?tab=due', { Cookie: owner })).text()).toContain('Corvedale Creamery');
    expect(await outreachDaily(env)).toBe(1);
    expect((await outbox(OWNER))[0].subject).toContain('1 producer follow-up due today');
    const fp = await (await get(`/admin/outreach/${o.id}`, { Cookie: owner })).text();
    expect(fp).toContain('Re: Free listing for Corvedale Creamery');
    expect(fp).toContain('This is the only follow-up');
    await post(`/admin/outreach/${o.id}/contacted`, { method: 'email' }, { Cookie: owner });
    x = await item('Corvedale Creamery');
    expect(x.contact_count).toBe(2);
    // A third contact isn't allowed.
    await post(`/admin/outreach/${o.id}/contacted`, { method: 'email' }, { Cookie: owner });
    expect((await item('Corvedale Creamery')).contact_count).toBe(2);
    await env.DB.prepare("UPDATE outreach SET follow_up_on = '2000-01-01' WHERE id = ?").bind(o.id).run();
    await outreachDaily(env);
    expect((await item('Corvedale Creamery')).stage).toBe('no_reply');
  });

  it('removes personal details when someone is not interested, and keeps the email so we never contact them again', async () => {
    const o = await item('Wrekin Valley Butchers');
    await post(`/admin/outreach/${o.id}/note`, { note: 'Met at the market' }, { Cookie: owner });
    await post(`/admin/outreach/${o.id}/stage`, { stage: 'not_interested' }, { Cookie: owner });
    const x = await item('Wrekin Valley Butchers');
    expect(x.stage).toBe('not_interested');
    expect(x.address).toBeNull();
    expect(x.email).toBe('wv@example.com');
    const notes = await env.DB.prepare('SELECT body FROM outreach_notes WHERE outreach_id = ?').bind(o.id).all();
    expect(notes.results.map((n) => n.body).join()).not.toContain('Met at the market');
    expect((await post('/admin/outreach/new', { business_name: 'WV Meats', email: 'wv@example.com' }, { Cookie: owner })).status).toBe(400);
  });

  it('imports a CSV, skipping duplicates and rows without a name', async () => {
    const csv = 'Business name,Business type,Email,Address,Town,County,Products\r\n'
      + 'Bramble & Hedge Preserves,Limited,jam@bramble.example,"2 Mill Lane\nMuch Wenlock",Much Wenlock,shropshire,jams\r\n'
      + 'Corvedale Creamery,Ltd,,,Craven Arms,Shropshire,cheese\r\n'
      + ',Ltd,x@example.com,,,,\r\n'
      + 'Ludlow Honey,Sole trader,,,Ludlow,Shropshire,honey\r\n';
    const r = await postFile('/admin/outreach/import', csv, { Cookie: owner });
    const t = await r.text();
    expect(t).toContain('Added 2 producers.');
    expect(t).toContain('Skipped 2');
    const b = await item('Bramble & Hedge Preserves');
    expect(b.kind).toBe('ltd');
    expect(b.county).toBe('Shropshire');
    expect(b.address).toBe('2 Mill Lane\nMuch Wenlock');
    expect((await item('Ludlow Honey')).kind).toBe('sole');
    expect((await get('/admin/outreach/template.csv', { Cookie: owner })).headers.get('Content-Type')).toContain('text/csv');
  });

  it('parses quoted CSV fields', () => {
    expect(parseCsv('a,"b, c","say ""hi"""\n1,2,3')).toEqual([['a', 'b, c', 'say "hi"'], ['1', '2', '3']]);
  });

  it('marks a record as joined when that producer signs up', async () => {
    const cookie = await signIn('jam@bramble.example');
    await post('/producer/join', { business_name: 'Bramble and Hedge', contact_name: 'Pat', phone: '01952 123456', description: 'Small-batch jams and chutneys.', postcode: 'TF13 6AA', county: 'Shropshire', terms: 'yes' }, { Cookie: cookie });
    const b = await item('Bramble & Hedge Preserves');
    expect(b.stage).toBe('joined');
    expect(b.producer_id).toBeTruthy();
  });

  it('deletes a record on request, and old records in the daily clean-up', async () => {
    const h = await item('Ludlow Honey');
    await post(`/admin/outreach/${h.id}/delete`, {}, { Cookie: owner });
    expect(await item('Ludlow Honey')).toBeNull();
    await env.DB.prepare('UPDATE outreach SET updated_at = 1').run();
    await cleanUp(env);
    const left = await env.DB.prepare('SELECT business_name, stage FROM outreach').all();
    expect(left.results).toEqual([{ business_name: 'Wrekin Valley Butchers', stage: 'not_interested' }]);
  });
});
