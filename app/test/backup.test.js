import { describe, it, expect } from 'vitest';
import { env, exports } from 'cloudflare:workers';
import { sqlValue, runBackup, nightlyBackup, gunzip, latestBackup, BACKUP_TABLES } from '../src/backup.js';

const BASE = 'https://test-app.example';
let ipN = 0;
const ip = () => `198.51.100.${(ipN++ % 250) + 1}`;
const get = (path, headers = {}) => exports.default.fetch(new Request(BASE + path, { headers, redirect: 'manual' }));
const post = (path, data, headers = {}) => exports.default.fetch(new Request(BASE + path, {
  method: 'POST', redirect: 'manual',
  headers: { 'Content-Type': 'application/x-www-form-urlencoded', Origin: BASE, 'Sec-Fetch-Site': 'same-origin', 'CF-Connecting-IP': ip(), ...headers },
  body: new URLSearchParams(data).toString(),
}));
const outbox = (to) => env.DB.prepare('SELECT * FROM dev_outbox WHERE to_email = ? ORDER BY id DESC').bind(to).all().then((r) => r.results);

async function signIn(email) {
  await post('/signin', { email, 'cf-turnstile-response': 'dev-pass' });
  const code = (await outbox(email))[0].subject.match(/(\d{6})/)[1];
  const r = await post('/signin/code', { email, code });
  return r.headers.get('Set-Cookie').split(';')[0];
}

// Apply a backup the way `wrangler d1 execute --file` would: one statement per line, in one transaction.
async function restore(sql) {
  const lines = sql.split('\n').filter((l) => l.trim() && !l.startsWith('--'));
  await env.DB.batch(lines.map((l) => env.DB.prepare(l)));
}

describe('backups', () => {
  it('writes SQL literals safely', () => {
    expect(sqlValue(null)).toBe('NULL');
    expect(sqlValue(42)).toBe('42');
    expect(sqlValue(1.5)).toBe('1.5');
    expect(sqlValue("O'Brien")).toBe("'O''Brien'");
    expect(sqlValue('a\nb')).toBe("'a' || char(10) || 'b'");
    expect(sqlValue(new Uint8Array([1, 255]))).toBe("X'01ff'");
  });

  it('backs up to R2 and restores exactly, including awkward text', async () => {
    const cookie = await signIn('backup-maker@example.com');
    await post('/producer/join', { business_name: "Pat's \"Best\" Bakery", contact_name: 'Pat', phone: '01952 123456', description: "Line one.\nLine two – it's sourdough; DROP TABLE users;", postcode: 'TF1 2EB', county: 'Shropshire', terms: 'yes' }, { Cookie: cookie });
    const before = await env.DB.prepare('SELECT * FROM producers WHERE business_name LIKE ?').bind('Pat%').first();
    expect(before.description).toContain('\n');

    const r = await runBackup(env);
    expect(r.key).toMatch(/^d1\/\d{4}-\d{2}-\d{2}\.sql\.gz$/);
    const obj = await env.BACKUPS.get(r.key);
    const sql = await gunzip(await obj.arrayBuffer());
    for (const t of BACKUP_TABLES) expect(sql).toContain(`DELETE FROM ${t};`);
    expect(sql).not.toMatch(/login_codes|INSERT INTO sessions|rate_limits/);
    expect(Number(obj.customMetadata.rows)).toBe(r.rows);

    // Damage the data, then restore.
    await env.DB.prepare('UPDATE producers SET business_name = ? WHERE id = ?').bind('Wrong', before.id).run();
    await env.DB.prepare("INSERT INTO messages (id, name, email, topic, body, created_at) VALUES ('m-after', 'X', 'x@example.com', 'other', 'Added after the backup', 1)").run();
    await restore(sql);

    const after = await env.DB.prepare('SELECT * FROM producers WHERE id = ?').bind(before.id).first();
    expect(after).toEqual(before);
    expect(await env.DB.prepare("SELECT id FROM messages WHERE id = 'm-after'").first()).toBeNull();
    const users = await env.DB.prepare('SELECT COUNT(*) AS n FROM users').first();
    expect(users.n).toBeGreaterThan(0);
  });

  it('removes copies older than 30 days', async () => {
    await runBackup(env, new Date('2026-01-01T08:00:00Z'));
    const later = await runBackup(env, new Date(Date.now() + 40 * 86400 * 1000));
    expect(later.removed).toBeGreaterThan(0);
    const keys = (await env.BACKUPS.list({ prefix: 'd1/' })).objects.map((o) => o.key);
    expect(keys).toEqual([later.key]);
  });

  it('emails hello@ when a backup fails, without throwing', async () => {
    const res = await nightlyBackup({ ...env, BACKUPS: undefined });
    expect(res).toBeNull();
    const mail = (await outbox(env.NOTIFY_EMAIL))[0];
    expect(mail.subject).toMatch(/Backup failed/);
  });

  it('shows the last backup on the admin overview', async () => {
    await runBackup(env);
    expect(await latestBackup(env)).not.toBeNull();
    const owner = await signIn('hello@rootsandpantry.co.uk');
    const body = await (await get('/admin', { Cookie: owner })).text();
    expect(body).toMatch(/id="backup-status">Last backup: /);
  });
});

describe('hourly schedule', () => {
  it('runs the backup in the 08:30 UTC run and Facebook posts in the others, matching wrangler.jsonc', async () => {
    const { HOURLY_CRON } = await import('../src/backup.js');
    const worker = (await import('../src/index.js')).default;
    const run = async (iso) => {
      const waits = [];
      await worker.scheduled({ cron: HOURLY_CRON, scheduledTime: Date.parse(iso) }, env, { waitUntil: (p) => waits.push(p) });
      return Promise.all(waits);
    };
    const [backup] = await run('2026-11-19T08:30:00Z');
    expect(backup.key).toMatch(/^d1\//);
    const [fb] = await run('2026-11-19T10:30:00Z');
    expect(fb).toHaveProperty('posted');
  });
});
