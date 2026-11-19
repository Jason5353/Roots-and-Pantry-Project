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
    expect(page).toContain('hello@rootsandpantry.co.uk\n\n\n\n\nRoots &amp; Pantry is a trading name');
    expect(page).toContain('<span style="font-size:8pt;color:#56607A">Roots &amp; Pantry is a trading name');
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

  it('keeps website, Facebook, Instagram and postcode separately, and offers Facebook messages only to Ltd/LLP', async () => {
    expect((await post('/admin/outreach/new', { business_name: 'Bad Links', facebook: 'https://example.com/x', postcode: 'nope' }, { Cookie: owner })).status).toBe(400);
    await post('/admin/outreach/new', { business_name: 'Clun Valley Cider', kind: 'ltd', facebook: 'facebook.com/clunvalleycider', instagram: '@clun.cider', website: 'clunvalleycider.example', address: 'Mill Farm\nClun', postcode: 'sy78aa', county: 'Shropshire' }, { Cookie: owner });
    const c = await item('Clun Valley Cider');
    expect(c.facebook).toBe('https://facebook.com/clunvalleycider');
    expect(c.instagram).toBe('https://www.instagram.com/clun.cider/');
    expect(c.website).toBe('https://clunvalleycider.example');
    expect(c.postcode).toBe('SY7 8AA');
    const cp = await (await get(`/admin/outreach/${c.id}`, { Cookie: owner })).text();
    expect(cp).toContain('id="fbtext"');
    expect(cp).toContain('a new free website that helps families in Shropshire');
    expect(cp).toContain('<option value="facebook" selected');
    expect(cp).not.toContain('id="emailtext"');
    expect(await (await get(`/admin/outreach/${c.id}/letter`, { Cookie: owner })).text()).toContain('Clun<br />SY7 8AA');
    await post('/admin/outreach/new', { business_name: 'Clee Hill Eggs', kind: 'sole', facebook: 'https://www.facebook.com/cleehilleggs' }, { Cookie: owner });
    const e = await item('Clee Hill Eggs');
    const ep = await (await get(`/admin/outreach/${e.id}`, { Cookie: owner })).text();
    expect(ep).not.toContain('id="fbtext"');
    expect(ep).toContain('like and share their posts instead');
    await post(`/admin/outreach/${c.id}/contacted`, { method: 'facebook' }, { Cookie: owner });
    expect((await item('Clun Valley Cider')).contact_count).toBe(1);
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
    expect(fp).not.toContain('only follow-up');
    expect(fp).toContain("won't contact you again");
    await post(`/admin/outreach/${o.id}/contacted`, { method: 'email' }, { Cookie: owner });
    x = await item('Corvedale Creamery');
    expect(x.contact_count).toBe(2);
    expect(x.follow_up_on > today()).toBe(true); // another reminder is set
    // No limit: a third and fourth contact are allowed.
    await post(`/admin/outreach/${o.id}/contacted`, { method: 'email' }, { Cookie: owner });
    await post(`/admin/outreach/${o.id}/contacted`, { method: 'letter' }, { Cookie: owner });
    x = await item('Corvedale Creamery');
    expect(x.contact_count).toBe(4);
    expect(await (await get(`/admin/outreach/${o.id}`, { Cookie: owner })).text()).toContain('Follow-up 3');
    // Nothing is closed automatically, however late the reminder is.
    await env.DB.prepare("UPDATE outreach SET follow_up_on = '2000-01-01' WHERE id = ?").bind(o.id).run();
    await outreachDaily(env);
    expect((await item('Corvedale Creamery')).stage).toBe('contacted');
    // "No reply: stop reminders" closes it by hand, and you can still contact them again later.
    await post(`/admin/outreach/${o.id}/stage`, { stage: 'no_reply' }, { Cookie: owner });
    x = await item('Corvedale Creamery');
    expect(x.stage).toBe('no_reply');
    expect(x.follow_up_on).toBeNull();
    await post(`/admin/outreach/${o.id}/contacted`, { method: 'email' }, { Cookie: owner });
    x = await item('Corvedale Creamery');
    expect(x.stage).toBe('contacted');
    expect(x.contact_count).toBe(5);
  });

  it('keeps the old one-reminder promise for people who asked for details before 20 Nov 2026', async () => {
    const o = await item('Corvedale Creamery');
    await env.DB.prepare('UPDATE outreach SET consent_email_at = ?, contact_count = 2 WHERE id = ?').bind(Date.parse('2026-11-18T10:00:00Z') / 1000, o.id).run();
    expect(await (await get(`/admin/outreach/${o.id}`, { Cookie: owner })).text()).toContain("Don't follow up again");
    await env.DB.prepare('UPDATE outreach SET consent_email_at = ? WHERE id = ?').bind(Date.parse('2026-11-21T10:00:00Z') / 1000, o.id).run();
    expect(await (await get(`/admin/outreach/${o.id}`, { Cookie: owner })).text()).not.toContain("Don't follow up again");
  });

  it('removes personal details when someone is not interested, and keeps the email so we never contact them again', async () => {
    const o = await item('Wrekin Valley Butchers');
    await post(`/admin/outreach/${o.id}/note`, { note: 'Met at the market' }, { Cookie: owner });
    expect((await post(`/admin/outreach/${o.id}/stage`, { stage: 'not_interested' }, { Cookie: owner })).status).toBe(400); // must say how
    await post(`/admin/outreach/${o.id}/stage`, { stage: 'not_interested', how: 'Said no thanks at the market' }, { Cookie: owner });
    const x = await item('Wrekin Valley Butchers');
    expect(x.stage).toBe('not_interested');
    expect(x.address).toBeNull();
    expect(x.email).toBe('wv@example.com');
    const notes = await env.DB.prepare('SELECT body FROM outreach_notes WHERE outreach_id = ?').bind(o.id).all();
    expect(notes.results.map((n) => n.body).join()).not.toContain('Met at the market');
    expect((await post('/admin/outreach/new', { business_name: 'WV Meats', email: 'wv@example.com' }, { Cookie: owner })).status).toBe(400);
  });

  it('imports a CSV, skipping duplicates and rows without a name', async () => {
    const csv = 'Business name,Business type,Email,Address,Postcode,Facebook,Town,County,Products\r\n'
      + 'Bramble & Hedge Preserves,Limited,jam@bramble.example,"2 Mill Lane\nMuch Wenlock",tf136aa,https://www.facebook.com/bramblehedge,Much Wenlock,shropshire,jams\r\n'
      + 'Corvedale Creamery,Ltd,,,,,Craven Arms,Shropshire,cheese\r\n'
      + ',Ltd,x@example.com,,,,,,\r\n'
      + 'Ludlow Honey,Sole trader,,,,,Ludlow,Shropshire,honey\r\n';
    const r = await postFile('/admin/outreach/import', csv, { Cookie: owner });
    const t = await r.text();
    expect(t).toContain('Added 2 producers.');
    expect(t).toContain('Skipped 2');
    const b = await item('Bramble & Hedge Preserves');
    expect(b.kind).toBe('ltd');
    expect(b.county).toBe('Shropshire');
    expect(b.address).toBe('2 Mill Lane\nMuch Wenlock');
    expect(b.postcode).toBe('TF13 6AA');
    expect(b.facebook).toBe('https://www.facebook.com/bramblehedge');
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

  it('lets a sole trader ask for details, records permission, and unlocks email for them', async () => {
    expect((await get('/producers/interest')).status).toBe(200);
    // No tick, no record.
    const r0 = await post('/producers/interest', { contact_name: 'Meg', business_name: 'Meg\'s Bakes', email: 'meg@example.com', 'cf-turnstile-response': 'dev-pass' });
    expect(r0.status).toBe(400);
    expect(await item("Meg's Bakes")).toBeNull();
    // Facebook box needs a Facebook page.
    expect((await post('/producers/interest', { contact_name: 'Meg', business_name: "Meg's Bakes", email: 'meg@example.com', consent_email: 'yes', consent_facebook: 'yes', 'cf-turnstile-response': 'dev-pass' })).status).toBe(400);
    const r = await post('/producers/interest', { contact_name: 'Meg Price', business_name: "Meg's Bakes", email: 'Meg@Example.com', town: 'Bridgnorth', county: 'Shropshire', consent_email: 'yes', 'cf-turnstile-response': 'dev-pass' });
    expect(r.status).toBe(200);
    expect(await r.text()).toContain("Thanks, we'll be in touch");
    const m = await item("Meg's Bakes");
    expect(m.consent_email_at).toBeTruthy();
    expect(m.consent_facebook_at).toBeNull();
    expect(m.consent_how).toContain('Yes, email me about joining Roots & Pantry');
    expect(m.stage).toBe('contacted');
    expect(m.contact_count).toBe(1);
    expect((await outbox('meg@example.com'))[0].subject).toBe('How Roots & Pantry works for producers');
    expect((await outbox(OWNER))[0].subject).toBe("[Producer enquiry] Meg's Bakes");
    // Mark her as a sole trader: the follow-up email is still allowed, because she asked.
    await env.DB.prepare("UPDATE outreach SET kind = 'sole', follow_up_on = ? WHERE id = ?").bind(today(), m.id).run();
    const mp = await (await get(`/admin/outreach/${m.id}`, { Cookie: owner })).text();
    expect(mp).toContain('id="emailtext"');
    expect(mp).toContain('They asked us to email them on');
    expect(mp).not.toContain('id="fbtext"');
    // Asking again updates the same record rather than adding a new one.
    await post('/producers/interest', { contact_name: 'Meg Price', business_name: "Meg's Bakes", email: 'meg@example.com', facebook: 'https://www.facebook.com/megsbakes', consent_email: 'yes', consent_facebook: 'yes', 'cf-turnstile-response': 'dev-pass' });
    const again = await env.DB.prepare("SELECT COUNT(*) AS n, MAX(consent_facebook_at) AS fb FROM outreach WHERE email = 'meg@example.com'").first();
    expect(again.n).toBe(1);
    expect(again.fb).toBeTruthy();
    // "Not interested" withdraws the permission but keeps the record of it.
    await post(`/admin/outreach/${m.id}/stage`, { stage: 'not_interested', how: 'Replied stop to our email' }, { Cookie: owner });
    const gone = await item("Meg's Bakes");
    expect(gone.consent_email_at).toBeTruthy();
    expect(gone.consent_withdrawn_at).toBeTruthy();
    const np = await (await get(`/admin/outreach/${m.id}`, { Cookie: owner })).text();
    expect(np).not.toContain('id="emailtext"');
    expect(np).toContain('Permission withdrawn');
    expect(np).toContain('Replied stop to our email');
    expect(np).toContain('Permission given');
    const log = await env.DB.prepare('SELECT event FROM outreach_consent_log WHERE outreach_id = ? ORDER BY id').bind(m.id).all();
    expect(log.results.map((r) => r.event)).toEqual(['given', 'given', 'withdrawn']);
    // Reopening needs a reason and doesn't bring the permission back.
    await env.DB.prepare('UPDATE outreach SET consent_withdrawn_at = consent_withdrawn_at + 5 WHERE id = ?').bind(m.id).run();
    await post(`/admin/outreach/${m.id}/stage`, { stage: 'todo', how: 'Emailed hello@ asking to join after all' }, { Cookie: owner });
    const back = await item("Meg's Bakes");
    expect(back.stage).toBe('todo');
    const bp = await (await get(`/admin/outreach/${m.id}`, { Cookie: owner })).text();
    expect(bp).toContain('Reopened');
    expect(bp).not.toContain('id="emailtext"');
    // Saying yes again on the form restores it.
    await new Promise((r) => setTimeout(r, 1100));
    await env.DB.prepare('UPDATE outreach SET consent_withdrawn_at = ? WHERE id = ?').bind(Math.floor(Date.now() / 1000) - 1, m.id).run();
    await post('/producers/interest', { contact_name: 'Meg Price', business_name: "Meg's Bakes", email: 'meg@example.com', consent_email: 'yes', 'cf-turnstile-response': 'dev-pass' });
    expect(await (await get(`/admin/outreach/${m.id}`, { Cookie: owner })).text()).toContain('id="emailtext"');
    await post(`/admin/outreach/${m.id}/stage`, { stage: 'not_interested', how: 'Changed their mind' }, { Cookie: owner });
  });

  it('deletes a record on request, and old records in the daily clean-up', async () => {
    const h = await item('Ludlow Honey');
    await post(`/admin/outreach/${h.id}/delete`, {}, { Cookie: owner });
    expect(await item('Ludlow Honey')).toBeNull();
    await env.DB.prepare('UPDATE outreach SET updated_at = 1').run();
    await cleanUp(env);
    const left = await env.DB.prepare('SELECT business_name, stage FROM outreach').all();
    expect(left.results.map((x) => x.business_name).sort()).toEqual(["Meg's Bakes", 'Wrekin Valley Butchers']);
  });
});
