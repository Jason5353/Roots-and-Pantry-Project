// Outbound services: Turnstile, Brevo email, rate limits, audit log.
import { now } from './util.js';

const isDev = (env) => env.DEV === 'true';

export async function verifyTurnstile(env, token, ip) {
  if (isDev(env)) return token === 'dev-pass';
  if (!token) return false;
  const body = new FormData();
  body.append('secret', env.TURNSTILE_SECRET);
  body.append('response', token);
  if (ip) body.append('remoteip', ip);
  try {
    const r = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', { method: 'POST', body });
    const j = await r.json();
    return j.success === true;
  } catch {
    return false;
  }
}

// Plain-text email only (no HTML, no links needed). Returns true if accepted by Brevo.
export async function sendEmail(env, { to, subject, text, replyTo }) {
  if (isDev(env)) {
    await env.DB.prepare('INSERT INTO dev_outbox (to_email, subject, body, reply_to, created_at) VALUES (?, ?, ?, ?, ?)')
      .bind(to, subject, text, replyTo || null, now()).run();
    return true;
  }
  const payload = {
    sender: { name: env.APP_NAME, email: env.FROM_EMAIL },
    to: [{ email: to }],
    subject,
    textContent: text,
  };
  if (replyTo) payload.replyTo = { email: replyTo };
  try {
    const r = await fetch('https://api.brevo.com/v3/smtp/email', {
      method: 'POST',
      headers: { 'api-key': env.BREVO_API_KEY, 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!r.ok) console.error('brevo send failed', r.status, await r.text());
    return r.ok;
  } catch (e) {
    console.error('brevo send error', e);
    return false;
  }
}

// Fixed-window rate limit stored in D1. Returns true if this attempt is allowed.
export async function rateLimit(env, key, limit, windowSeconds) {
  const t = now();
  const row = await env.DB.prepare('SELECT count, window_start FROM rate_limits WHERE key = ?').bind(key).first();
  if (!row || t - row.window_start >= windowSeconds) {
    await env.DB.prepare('INSERT INTO rate_limits (key, count, window_start) VALUES (?, 1, ?) ON CONFLICT(key) DO UPDATE SET count = 1, window_start = excluded.window_start')
      .bind(key, t).run();
    return true;
  }
  if (row.count >= limit) return false;
  await env.DB.prepare('UPDATE rate_limits SET count = count + 1 WHERE key = ?').bind(key).run();
  return true;
}

export async function audit(env, actorId, action, target, detail) {
  await env.DB.prepare('INSERT INTO audit_log (actor_id, action, target, detail, created_at) VALUES (?, ?, ?, ?, ?)')
    .bind(actorId || null, action, target || null, detail ? JSON.stringify(detail) : null, now()).run();
}

// Daily clean-up, matching the retention periods in the privacy notice (site/src/pages/privacy-and-terms.astro).
export async function cleanUp(env) {
  const t = now();
  const day = 86400;
  const r = await env.DB.batch([
    env.DB.prepare('DELETE FROM login_codes WHERE expires_at < ?').bind(t),
    env.DB.prepare('DELETE FROM sessions WHERE expires_at < ?').bind(t),
    env.DB.prepare('DELETE FROM rate_limits WHERE window_start < ?').bind(t - day),
    env.DB.prepare('DELETE FROM messages WHERE created_at < ?').bind(t - 365 * day),
    env.DB.prepare('DELETE FROM audit_log WHERE created_at < ?').bind(t - 730 * day),
    env.DB.prepare('DELETE FROM dev_outbox WHERE created_at < ?').bind(t - 7 * day),
    // Outreach: delete 12 months after the last update. "Not interested" stays so we never contact them again.
    env.DB.prepare("DELETE FROM outreach WHERE stage != 'not_interested' AND updated_at < ?").bind(t - 365 * day),
  ]);
  return r.reduce((n, x) => n + (x.meta?.changes || 0), 0);
}
