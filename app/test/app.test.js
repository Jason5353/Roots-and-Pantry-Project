import { describe, it, expect } from 'vitest';
import { env, exports } from 'cloudflare:workers';

const BASE = 'https://test-app.example';
const get = (path, headers = {}) => exports.default.fetch(new Request(BASE + path, { headers, redirect: 'manual' }));
const post = (path, data, headers = {}) => exports.default.fetch(new Request(BASE + path, {
  method: 'POST', redirect: 'manual',
  headers: { 'Content-Type': 'application/x-www-form-urlencoded', Origin: BASE, 'Sec-Fetch-Site': 'same-origin', 'CF-Connecting-IP': '203.0.113.5', ...headers },
  body: new URLSearchParams(data).toString(),
}));
const outbox = (to) => env.DB.prepare('SELECT * FROM dev_outbox WHERE to_email = ? ORDER BY id DESC').bind(to).all().then((r) => r.results);

async function signIn(email) {
  const r1 = await post('/signin', { email, 'cf-turnstile-response': 'dev-pass', next: '/producer' });
  expect(r1.status).toBe(200);
  const code = (await outbox(email))[0].subject.match(/(\d{6})/)[1];
  const r2 = await post('/signin/code', { email, code, next: '/producer' });
  expect(r2.status).toBe(303);
  return r2.headers.get('Set-Cookie').split(';')[0];
}

describe('basics', () => {
  it('serves the home page with strict security headers', async () => {
    const r = await get('/');
    expect(r.status).toBe(200);
    expect(r.headers.get('Content-Security-Policy')).toContain("frame-ancestors 'none'");
    expect(r.headers.get('X-Robots-Tag')).toContain('noindex');
    expect(await r.text()).toContain('List my business');
  });
  it('returns 404 for unknown pages', async () => expect((await get('/nope')).status).toBe(404));
  it('rejects cross-site posts', async () => {
    const r = await post('/contact', { name: 'x' }, { Origin: 'https://evil.example', 'Sec-Fetch-Site': 'cross-site' });
    expect(r.status).toBe(403);
  });
  it('escapes user input in pages', async () => {
    const r = await post('/contact', { name: '<script>alert(1)</script>', email: 'bad', topic: 'Press', message: 'hi' });
    const t = await r.text();
    expect(t).not.toContain('<script>alert(1)</script>');
    expect(t).toContain('&lt;script&gt;');
  });
});

describe('contact form', () => {
  it('shows errors for missing fields', async () => {
    const r = await post('/contact', { name: '', email: 'nope', topic: '', message: '' });
    expect(r.status).toBe(400);
    const t = await r.text();
    expect(t).toContain('Enter your name');
    expect(t).toContain('Enter a valid email');
  });
  it('rejects a failed robot check', async () => {
    const r = await post('/contact', { name: 'Ann', email: 'ann@example.com', topic: 'Press', message: 'Hello there', 'cf-turnstile-response': 'bad' });
    expect(r.status).toBe(400);
  });
  it('saves the message and emails hello@', async () => {
    const r = await post('/contact', { name: 'Ann', email: 'ann@example.com', topic: 'Press', message: 'Hello there', 'cf-turnstile-response': 'dev-pass' });
    expect(r.status).toBe(200);
    expect(await r.text()).toContain('Thanks, your message is on its way');
    const msg = await env.DB.prepare('SELECT * FROM messages WHERE email = ?').bind('ann@example.com').first();
    expect(msg.topic).toBe('Press');
    const mail = (await outbox('hello@rootsandpantry.co.uk'))[0];
    expect(mail.reply_to).toBe('ann@example.com');
  });
});

describe('sign-in with email code', () => {
  it('does not reveal anything and sends a plain code with no links', async () => {
    const r = await post('/signin', { email: 'Bob@Example.com', 'cf-turnstile-response': 'dev-pass' });
    expect(await r.text()).toContain('Check your email');
    const mail = (await outbox('bob@example.com'))[0];
    expect(mail.body).toMatch(/\d{6}/);
    expect(mail.body).not.toMatch(/https?:\/\//);
  });
  it('rejects a wrong code and locks after 5 attempts', async () => {
    await post('/signin', { email: 'cara@example.com', 'cf-turnstile-response': 'dev-pass' });
    for (let i = 0; i < 5; i++) {
      const r = await post('/signin/code', { email: 'cara@example.com', code: '000000' });
      expect(r.status).toBe(400);
    }
    const code = (await outbox('cara@example.com'))[0].subject.match(/(\d{6})/)[1];
    const r = await post('/signin/code', { email: 'cara@example.com', code });
    expect(await r.text()).toContain('expired or been used too many times');
  });
  it('limits code emails to 3 per address per hour', async () => {
    for (let i = 0; i < 5; i++) await post('/signin', { email: 'dan@example.com', 'cf-turnstile-response': 'dev-pass' }, { 'CF-Connecting-IP': `198.51.100.${i}` });
    expect((await outbox('dan@example.com')).length).toBe(3);
  });
  it('signs in, sets a secure cookie, and makes the owner an owner', async () => {
    const r1 = await post('/signin', { email: 'hello@rootsandpantry.co.uk', 'cf-turnstile-response': 'dev-pass' });
    expect(r1.status).toBe(200);
    const code = (await outbox('hello@rootsandpantry.co.uk')).find((m) => m.subject.includes('code')).subject.match(/(\d{6})/)[1];
    const r2 = await post('/signin/code', { email: 'hello@rootsandpantry.co.uk', code });
    const cookie = r2.headers.get('Set-Cookie');
    expect(cookie).toMatch(/^__Host-rp_s=.+; Path=\/; HttpOnly; Secure; SameSite=Lax/);
    const u = await env.DB.prepare('SELECT role FROM users WHERE email = ?').bind('hello@rootsandpantry.co.uk').first();
    expect(u.role).toBe('owner');
  });
});

describe('producer sign-up', () => {
  it('needs sign-in', async () => {
    const r = await get('/producer/join');
    expect(r.status).toBe(303);
    expect(r.headers.get('Location')).toContain('/signin?next=');
  });
  it('validates, saves as pending, and notifies both sides', async () => {
    const cookie = await signIn('farm@example.com');
    let r = await get('/producer', { Cookie: cookie });
    expect(r.headers.get('Location')).toContain('/producer/join');
    r = await post('/producer/join', { business_name: '', postcode: 'nope', facebook: 'https://evil.example/page' }, { Cookie: cookie });
    expect(r.status).toBe(400);
    const errText = await r.text();
    expect(errText).toContain('Enter a full UK postcode');
    expect(errText).toContain('link to your Facebook page');
    r = await post('/producer/join', {
      business_name: 'Wrekin Dairy', contact_name: 'Sue', phone: '01952 123456', description: 'Small family dairy making cheese and butter.',
      website: 'https://example.com', facebook: 'https://www.facebook.com/wrekindairy', postcode: 'tf12eb', county: 'Shropshire', terms: 'yes',
    }, { Cookie: cookie });
    expect(r.status).toBe(303);
    const p = await env.DB.prepare('SELECT * FROM producers WHERE business_name = ?').bind('Wrekin Dairy').first();
    expect(p.status).toBe('pending');
    expect(p.postcode).toBe('TF1 2EB');
    expect(p.facebook).toBe('https://www.facebook.com/wrekindairy');
    expect(p.terms_version).toBe('2026-11-v1');
    expect((await outbox('hello@rootsandpantry.co.uk')).some((m) => m.subject.includes('Wrekin Dairy'))).toBe(true);
    expect((await outbox('farm@example.com')).some((m) => m.subject.includes('Thanks for joining'))).toBe(true);
    r = await get('/producer', { Cookie: cookie });
    expect(await r.text()).toContain('Waiting for approval');
  });
  it('signs out', async () => {
    const cookie = await signIn('eve@example.com');
    const r = await post('/signout', {}, { Cookie: cookie });
    expect(r.headers.get('Set-Cookie')).toContain('Max-Age=0');
    expect((await get('/producer', { Cookie: cookie })).status).toBe(303);
  });
});
