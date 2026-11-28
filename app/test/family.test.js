import { describe, it, expect } from 'vitest';
import { env, exports } from 'cloudflare:workers';
import { cleanFamilyName } from '../src/family.js';
import { cleanUp } from '../src/services.js';

const BASE = 'https://test-app.example';
const get = (path, cookie = '') => exports.default.fetch(new Request(BASE + path, { headers: cookie ? { Cookie: cookie } : {}, redirect: 'manual' }));
let ip = 0; // a fresh address per request, so the sign-in limit (10 per IP per hour) never bites
const post = (path, data, cookie = '') => exports.default.fetch(new Request(BASE + path, {
  method: 'POST', redirect: 'manual',
  headers: { 'Content-Type': 'application/x-www-form-urlencoded', Origin: BASE, 'Sec-Fetch-Site': 'same-origin', 'CF-Connecting-IP': `198.51.100.${(ip++ % 250) + 1}`, ...(cookie ? { Cookie: cookie } : {}) },
  body: new URLSearchParams(data).toString(),
}));
const outbox = (to) => env.DB.prepare('SELECT * FROM dev_outbox WHERE to_email = ? ORDER BY id DESC').bind(to).all().then((r) => r.results);

async function signIn(email, next = '/producer') {
  await post('/signin', { email, 'cf-turnstile-response': 'dev-pass', next });
  const code = (await outbox(email)).find((m) => /code: \d{6}/.test(m.subject)).subject.match(/(\d{6})/)[1];
  const r = await post('/signin/code', { email, code, next });
  expect(r.status).toBe(303);
  return { cookie: r.headers.get('Set-Cookie').split(';')[0], location: r.headers.get('Location') };
}

async function startGroup(email, family = 'Hartley', name = 'Dave') {
  const { cookie } = await signIn(email);
  const r = await post('/family/new', { family_name: family, display_name: name, adult: 'yes' }, cookie);
  expect(r.status).toBe(303);
  const gid = r.headers.get('Location').match(/\/family\/g\/([^?]+)/)[1];
  return { cookie, gid };
}

async function invite(cookie, gid, email, name, role = 'member') {
  const r = await post(`/family/g/${gid}/invite`, { invite_name: name, invite_email: email, role }, cookie);
  expect(r.status).toBe(303);
  const mail = (await outbox(email.toLowerCase()))[0];
  return { mail, token: mail.body.match(/\/family\/join\/([A-Za-z0-9_-]+)/)[1] };
}

async function join(email, token, name) {
  const { cookie } = await signIn(email, `/family/join/${token}`);
  const r1 = await get(`/family/join/${token}`, cookie);
  expect(r1.status).toBe(303);
  const acceptPath = r1.headers.get('Location');
  expect(acceptPath).toMatch(/^\/family\/invites\//);
  const r2 = await post(acceptPath, { display_name: name, adult: 'yes' }, cookie);
  expect(r2.status).toBe(303);
  return cookie;
}

describe('family names', () => {
  it('tidies what people type', () => {
    expect(cleanFamilyName('the hartleys')).toBe('Hartleys');
    expect(cleanFamilyName('Hartley family recipes')).toBe('Hartley');
    expect(cleanFamilyName('  O\'Brien   Family ')).toBe("O'Brien");
  });
});

describe('starting a family group', () => {
  it('sends signed-out people to sign in, then to start a group', async () => {
    const r = await get('/family');
    expect(r.status).toBe(303);
    expect(r.headers.get('Location')).toContain('/signin?next=%2Ffamily');
    const { cookie } = await signIn('newfam@example.com');
    const r2 = await get('/family', cookie);
    expect(r2.headers.get('Location')).toBe('/family/new');
    expect(await (await get('/family/new', cookie)).text()).toContain('Start your family recipe book');
  });
  it('checks the form', async () => {
    const { cookie } = await signIn('check@example.com');
    const r = await post('/family/new', { family_name: '<b>', display_name: '', adult: '' }, cookie);
    expect(r.status).toBe(400);
    const t = await r.text();
    expect(t).toContain('Use letters, spaces');
    expect(t).toContain('Enter your name');
    expect(t).toContain("18 or over");
  });
  it('creates the group with the starter as admin', async () => {
    const { cookie, gid } = await startGroup('dave@example.com');
    const t = await (await get(`/family/g/${gid}?done=started`, cookie)).text();
    expect(t).toContain('Hartley Family Recipes');
    expect(t).toContain('an admin');
    expect(t).toContain('Invite someone');
    // Signing in again with no particular page lands on the family, not the producer pages.
    const again = await signIn('dave@example.com');
    expect(again.location).toBe('/family');
  });
  it('keeps other people out', async () => {
    const { gid } = await startGroup('private@example.com', 'Private');
    const { cookie } = await signIn('nosy@example.com');
    expect((await get(`/family/g/${gid}`, cookie)).status).toBe(404);
    expect((await post(`/family/g/${gid}/invite`, { invite_name: 'X', invite_email: 'x@example.com' }, cookie)).status).toBe(404);
    expect((await post(`/family/g/${gid}/delete`, { confirm: 'yes' }, cookie)).status).toBe(404);
  });
});

describe('invitations', () => {
  it('emails a link; only the invited address can accept', async () => {
    const { cookie, gid } = await startGroup('priya-admin@example.com', 'Shah', 'Raj');
    const { mail, token } = await invite(cookie, gid, 'Priya@Example.com', 'Priya');
    expect(mail.subject).toBe('Raj invited you to Shah Family Recipes');
    expect(mail.body).toContain('priya@example.com');
    // The token is never stored, only its hash.
    const row = await env.DB.prepare('SELECT token_hash FROM family_invites WHERE email = ?').bind('priya@example.com').first();
    expect(row.token_hash).not.toContain(token);

    const anon = await (await get(`/family/join/${token}`)).text();
    expect(anon).toContain('Shah Family Recipes');
    expect(anon).toContain('pr•••@example.com');
    expect(anon).not.toContain('priya@example.com');

    const wrong = await signIn('someone-else@example.com');
    const r = await get(`/family/join/${token}`, wrong.cookie);
    expect(r.status).toBe(403);

    const priya = await join('priya@example.com', token, 'Priya');
    const t = await (await get(`/family/g/${gid}`, priya)).text();
    expect(t).toContain('Priya</b> (you)');
    expect(t).not.toContain('Invite someone'); // members can't invite
    expect((await post(`/family/g/${gid}/invite`, { invite_name: 'Z', invite_email: 'z@example.com' }, priya)).status).toBe(303);
    expect(await outbox('z@example.com')).toHaveLength(0);
  });
  it('refuses duplicates, and cancelled or replaced links stop working', async () => {
    const { cookie, gid } = await startGroup('dup@example.com', 'Dupe', 'Ann');
    const first = await invite(cookie, gid, 'kid@example.com', 'Sam');
    const r = await post(`/family/g/${gid}/invite`, { invite_name: 'Sam', invite_email: 'kid@example.com' }, cookie);
    expect(r.status).toBe(400);
    expect(await r.text()).toContain('already been invited');
    const inv = await env.DB.prepare('SELECT id FROM family_invites WHERE email = ?').bind('kid@example.com').first();
    await post(`/family/g/${gid}/invites/${inv.id}/resend`, {}, cookie);
    const second = (await outbox('kid@example.com'))[0].body.match(/\/family\/join\/([A-Za-z0-9_-]+)/)[1];
    expect(second).not.toBe(first.token);
    expect((await get(`/family/join/${first.token}`)).status).toBe(404);
    await post(`/family/g/${gid}/invites/${inv.id}/cancel`, {}, cookie);
    expect((await get(`/family/join/${second}`)).status).toBe(404);
  });
  it('shows waiting invitations on /family after a normal sign-in', async () => {
    const { cookie, gid } = await startGroup('nan-admin@example.com', 'Evans', 'Gwen');
    await invite(cookie, gid, 'nan@example.com', 'Nan', 'admin');
    const nan = await signIn('nan@example.com');
    const t = await (await get('/family', nan.cookie)).text();
    expect(t).toContain('Invitations for you');
    expect(t).toContain('Evans Family Recipes');
    const id = t.match(/\/family\/invites\/([A-Za-z0-9_-]+)/)[1];
    const r = await post(`/family/invites/${id}`, { display_name: 'Nan', adult: '' }, nan.cookie);
    expect(r.status).toBe(400);
    await post(`/family/invites/${id}`, { display_name: 'Nan', adult: 'yes' }, nan.cookie);
    const m = await env.DB.prepare('SELECT role FROM family_members WHERE group_id = ? AND display_name = ?').bind(gid, 'Nan').first();
    expect(m.role).toBe('admin');
  });
});

describe('running the group', () => {
  it('admins change roles and remove people; the last admin cannot leave', async () => {
    const { cookie, gid } = await startGroup('boss@example.com', 'Jones', 'Mo');
    const { token } = await invite(cookie, gid, 'tom@example.com', 'Tom');
    const tom = await join('tom@example.com', token, 'Tom');
    const tomId = (await env.DB.prepare('SELECT id FROM users WHERE email = ?').bind('tom@example.com').first()).id;

    const leave = await post(`/family/g/${gid}/leave`, {}, cookie);
    expect(leave.status).toBe(400);
    expect(await leave.text()).toContain("only admin");

    await post(`/family/g/${gid}/members/${tomId}/role`, { role: 'admin' }, cookie);
    expect((await env.DB.prepare('SELECT role FROM family_members WHERE user_id = ?').bind(tomId).first()).role).toBe('admin');
    expect((await post(`/family/g/${gid}/leave`, {}, cookie)).headers.get('Location')).toBe('/family?done=left');

    // Tom (now the only one left) removes nobody, renames, then leaving deletes the group.
    await post(`/family/g/${gid}/rename`, { family_name: 'the joneses' }, tom);
    expect((await env.DB.prepare('SELECT name FROM family_groups WHERE id = ?').bind(gid).first()).name).toBe('Joneses');
    await post(`/family/g/${gid}/leave`, {}, tom);
    expect(await env.DB.prepare('SELECT 1 FROM family_groups WHERE id = ?').bind(gid).first()).toBeNull();
  });
  it('removing someone takes away their access', async () => {
    const { cookie, gid } = await startGroup('rm@example.com', 'Reed', 'Al');
    const { token } = await invite(cookie, gid, 'gone@example.com', 'Bo');
    const bo = await join('gone@example.com', token, 'Bo');
    const boId = (await env.DB.prepare('SELECT id FROM users WHERE email = ?').bind('gone@example.com').first()).id;
    await post(`/family/g/${gid}/members/${boId}/remove`, {}, cookie);
    expect((await get(`/family/g/${gid}`, bo)).status).toBe(404);
  });
  it('deleting needs the tick, then removes members and invites', async () => {
    const { cookie, gid } = await startGroup('del@example.com', 'Gone', 'Cy');
    await invite(cookie, gid, 'never@example.com', 'Di');
    expect((await post(`/family/g/${gid}/delete`, {}, cookie)).status).toBe(400);
    expect((await post(`/family/g/${gid}/delete`, { confirm: 'yes' }, cookie)).headers.get('Location')).toBe('/family?done=deleted');
    expect(await env.DB.prepare('SELECT 1 FROM family_invites WHERE group_id = ?').bind(gid).first()).toBeNull();
    expect(await env.DB.prepare('SELECT 1 FROM family_members WHERE group_id = ?').bind(gid).first()).toBeNull();
  });
  it('clean-up deletes old used invitations', async () => {
    const t = Math.floor(Date.now() / 1000);
    const gid = 'grp-cleanup-000001';
    await env.DB.prepare("INSERT INTO family_groups (id, name, created_at, updated_at) VALUES (?, 'Old', ?, ?)").bind(gid, t, t).run();
    await env.DB.prepare("INSERT INTO family_invites (id, group_id, email, display_name, token_hash, created_at, expires_at) VALUES ('inv-old-0000001', ?, 'o@example.com', 'O', 'h1', ?, ?)").bind(gid, t - 60 * 86400, t - 40 * 86400).run();
    await env.DB.prepare("INSERT INTO family_invites (id, group_id, email, display_name, token_hash, created_at, expires_at) VALUES ('inv-new-0000001', ?, 'n@example.com', 'N', 'h2', ?, ?)").bind(gid, t, t + 86400).run();
    await cleanUp(env);
    const left = await env.DB.prepare('SELECT id FROM family_invites WHERE group_id = ?').bind(gid).all();
    expect(left.results.map((r) => r.id)).toEqual(['inv-new-0000001']);
  });
});
