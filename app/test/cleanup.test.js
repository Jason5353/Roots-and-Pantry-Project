import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:workers';
import { cleanUp } from '../src/services.js';

const now = Math.floor(Date.now() / 1000);
const day = 86400;

describe('daily clean-up (privacy notice retention)', () => {
  it('removes expired and old rows, keeps current ones', async () => {
    await env.DB.batch([
      env.DB.prepare("INSERT INTO users (id, email, role, created_at) VALUES ('u-clean', 'clean@example.com', 'producer', ?)").bind(now),
      env.DB.prepare("INSERT INTO login_codes (email, code_hash, expires_at, created_at) VALUES ('old@example.com', 'x', ?, ?)").bind(now - 60, now - 700),
      env.DB.prepare("INSERT INTO login_codes (email, code_hash, expires_at, created_at) VALUES ('new@example.com', 'x', ?, ?)").bind(now + 500, now),
      env.DB.prepare("INSERT INTO sessions (id_hash, user_id, created_at, expires_at, last_auth_at) VALUES ('s-old', 'u-clean', ?, ?, ?)").bind(now - 40 * day, now - day, now - 40 * day),
      env.DB.prepare("INSERT INTO sessions (id_hash, user_id, created_at, expires_at, last_auth_at) VALUES ('s-new', 'u-clean', ?, ?, ?)").bind(now, now + 30 * day, now),
      env.DB.prepare("INSERT INTO rate_limits (key, count, window_start) VALUES ('rl-old', 1, ?), ('rl-new', 1, ?)").bind(now - 2 * day, now - 60),
      env.DB.prepare("INSERT INTO messages (id, name, email, topic, body, created_at) VALUES ('m-old', 'A', 'a@example.com', 'Press', 'hi', ?), ('m-new', 'B', 'b@example.com', 'Press', 'hi', ?)").bind(now - 400 * day, now - 10 * day),
      env.DB.prepare("INSERT INTO audit_log (action, created_at) VALUES ('old.thing', ?), ('new.thing', ?)").bind(now - 800 * day, now - day),
    ]);
    await cleanUp(env);
    const has = async (sql) => (await env.DB.prepare(sql).first()) !== null;
    expect(await has("SELECT 1 FROM login_codes WHERE email = 'old@example.com'")).toBe(false);
    expect(await has("SELECT 1 FROM login_codes WHERE email = 'new@example.com'")).toBe(true);
    expect(await has("SELECT 1 FROM sessions WHERE id_hash = 's-old'")).toBe(false);
    expect(await has("SELECT 1 FROM sessions WHERE id_hash = 's-new'")).toBe(true);
    expect(await has("SELECT 1 FROM rate_limits WHERE key = 'rl-old'")).toBe(false);
    expect(await has("SELECT 1 FROM rate_limits WHERE key = 'rl-new'")).toBe(true);
    expect(await has("SELECT 1 FROM messages WHERE id = 'm-old'")).toBe(false);
    expect(await has("SELECT 1 FROM messages WHERE id = 'm-new'")).toBe(true);
    expect(await has("SELECT 1 FROM audit_log WHERE action = 'old.thing'")).toBe(false);
    expect(await has("SELECT 1 FROM audit_log WHERE action = 'new.thing'")).toBe(true);
  });
});
