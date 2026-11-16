// Email one-time-code sign-in and sessions.
import { html, now, randomId, randomCode, sha256, hmac, safeEqual, getCookie, normEmail, validEmail } from './util.js';
import { page, turnstileWidget, errorList, field } from './layout.js';
import { verifyTurnstile, sendEmail, rateLimit, audit } from './services.js';

const COOKIE = '__Host-rp_s';
const SESSION_DAYS = 30;
const CODE_MINUTES = 10;
const MAX_ATTEMPTS = 5;

export async function loadUser(request, env) {
  const token = getCookie(request, COOKIE);
  if (!token || token.length > 100) return null;
  const row = await env.DB.prepare(
    'SELECT u.id, u.email, u.role, u.display_name, s.last_auth_at, s.id_hash FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.id_hash = ? AND s.expires_at > ?',
  ).bind(await sha256(token), now()).first();
  return row || null;
}

function sessionCookie(token, maxAge) {
  return `${COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;
}

const codeHash = (env, email, code) => hmac(env.CODE_PEPPER, `${email}:${code}`);

// Store a fresh 6-digit code for this email (replaces any earlier one) and return it.
export async function issueCode(env, email) {
  const code = randomCode();
  const t = now();
  await env.DB.prepare(
    'INSERT INTO login_codes (email, code_hash, expires_at, attempts, created_at) VALUES (?, ?, ?, 0, ?) ON CONFLICT(email) DO UPDATE SET code_hash = excluded.code_hash, expires_at = excluded.expires_at, attempts = 0, created_at = excluded.created_at',
  ).bind(email, await codeHash(env, email, code), t + CODE_MINUTES * 60, t).run();
  return code;
}

// Returns 'ok' (code used up), 'expired' or 'wrong'.
export async function checkCode(env, email, code) {
  const row = await env.DB.prepare('SELECT code_hash, expires_at, attempts FROM login_codes WHERE email = ?').bind(email).first();
  if (!row || row.expires_at < now() || row.attempts >= MAX_ATTEMPTS) return 'expired';
  await env.DB.prepare('UPDATE login_codes SET attempts = attempts + 1 WHERE email = ?').bind(email).run();
  if (!safeEqual(row.code_hash, await codeHash(env, email, code))) return 'wrong';
  await env.DB.prepare('DELETE FROM login_codes WHERE email = ?').bind(email).run();
  return 'ok';
}

export const isAdmin = (user) => !!user && (user.role === 'owner' || user.role === 'moderator');
export const CODE_MINUTES_VALID = CODE_MINUTES;

function signinForm(env, { email = '', errors = [], next = '/producer' } = {}) {
  return page(env, {
    title: 'Sign in',
    turnstile: true,
    status: errors.length ? 400 : 200,
    body: html`<div class="narrow">
      <h1>Sign in</h1>
      <p class="sub">We'll email you a 6-digit code. No password needed.</p>
      ${errorList(errors)}
      <form method="post" action="/signin" novalidate>
        <input type="hidden" name="next" value="${next}" />
        ${field({ id: 'email', label: 'Email address', type: 'email', value: email, autocomplete: 'email', error: errors.find((e) => e.field === 'email')?.msg, max: 254 })}
        ${turnstileWidget(env)}
        <button class="btn btn-red" type="submit">Email me a code</button>
      </form>
      <p class="note">New producer? Sign in with your email first, then you can add your business.</p>
    </div>`,
  });
}

function codeForm(env, { email, errors = [], next = '/producer' }) {
  return page(env, {
    title: 'Enter your code',
    status: errors.length ? 400 : 200,
    body: html`<div class="narrow">
      <h1>Check your email</h1>
      <p class="sub">If <b>${email}</b> is a valid address, we've sent it a 6-digit code. It works for ${CODE_MINUTES} minutes.</p>
      ${errorList(errors)}
      <form method="post" action="/signin/code" novalidate>
        <input type="hidden" name="email" value="${email}" />
        <input type="hidden" name="next" value="${next}" />
        ${field({ id: 'code', label: 'Your 6-digit code', value: '', autocomplete: 'one-time-code', inputmode: 'numeric', max: 6, error: errors.find((e) => e.field === 'code')?.msg })}
        <button class="btn btn-red" type="submit">Sign in</button>
      </form>
      <div class="callout"><p><b>No email?</b> Check your spam folder and wait a minute. Still nothing? <a href="/signin">Try again</a>, or email hello@rootsandpantry.co.uk and we'll help.</p></div>
    </div>`,
  });
}

const safeNext = (n) => (typeof n === 'string' && /^\/[a-z0-9/_-]*$/i.test(n) && !n.startsWith('//') ? n : '/producer');

export async function getSignin(request, env, url) {
  return signinForm(env, { next: safeNext(url.searchParams.get('next')) });
}

export async function postSignin(request, env, form) {
  const email = normEmail(form.get('email'));
  const next = safeNext(form.get('next'));
  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  if (!validEmail(email)) return signinForm(env, { email, next, errors: [{ field: 'email', msg: 'Enter a valid email address, like name@example.co.uk' }] });
  if (!(await verifyTurnstile(env, form.get('cf-turnstile-response'), ip))) {
    return signinForm(env, { email, next, errors: [{ field: 'email', msg: "We couldn't confirm you're not a robot. Please try again." }] });
  }
  const okEmail = await rateLimit(env, `code:email:${await sha256(email)}`, 3, 3600);
  const okIp = await rateLimit(env, `code:ip:${await sha256(ip)}`, 10, 3600);
  if (okEmail && okIp) {
    const code = await issueCode(env, email);
    await sendEmail(env, {
      to: email,
      subject: `Your Roots & Pantry code: ${code}`,
      text: `Your Roots & Pantry sign-in code is: ${code}\n\nIt works for ${CODE_MINUTES} minutes. Type it into the page you came from.\n\nIf you didn't ask for this, you can ignore this email. Nobody can sign in without the code.\n\nRoots & Pantry\nhello@rootsandpantry.co.uk`,
    });
  }
  // Same response whether or not we sent, so the page never reveals who has an account or hit a limit.
  return codeForm(env, { email, next });
}

export async function postCode(request, env, form) {
  const email = normEmail(form.get('email'));
  const next = safeNext(form.get('next'));
  const code = String(form.get('code') || '').replace(/\D/g, '');
  const bad = (msg) => codeForm(env, { email, next, errors: [{ field: 'code', msg }] });
  if (!validEmail(email)) return Response.redirect(new URL('/signin', request.url), 303);
  if (code.length !== 6) return bad('Enter the 6 digits from the email.');
  const result = await checkCode(env, email, code);
  if (result === 'expired') return bad('That code has expired or been used too many times. Please ask for a new one.');
  if (result === 'wrong') return bad("That code doesn't match. Check the latest email and try again.");

  const t = now();
  let user = await env.DB.prepare('SELECT id, role FROM users WHERE email = ?').bind(email).first();
  if (!user) {
    const role = email === normEmail(env.OWNER_EMAIL) ? 'owner' : 'producer';
    user = { id: randomId(), role };
    await env.DB.prepare('INSERT INTO users (id, email, role, created_at, last_login_at) VALUES (?, ?, ?, ?, ?)').bind(user.id, email, role, t, t).run();
    await audit(env, user.id, 'user.created', user.id, { role });
  } else {
    await env.DB.prepare('UPDATE users SET last_login_at = ? WHERE id = ?').bind(t, user.id).run();
  }
  const token = randomId(32);
  await env.DB.prepare('INSERT INTO sessions (id_hash, user_id, created_at, expires_at, last_auth_at) VALUES (?, ?, ?, ?, ?)')
    .bind(await sha256(token), user.id, t, t + SESSION_DAYS * 86400, t).run();
  await audit(env, user.id, 'signin', user.id);
  return new Response(null, { status: 303, headers: { Location: next === '/producer' && isAdmin(user) ? '/admin' : next, 'Set-Cookie': sessionCookie(token, SESSION_DAYS * 86400), 'Cache-Control': 'no-store' } });
}

export async function postSignout(request, env, user) {
  if (user) await env.DB.prepare('DELETE FROM sessions WHERE id_hash = ?').bind(user.id_hash).run();
  return new Response(null, { status: 303, headers: { Location: '/', 'Set-Cookie': sessionCookie('', 0), 'Cache-Control': 'no-store' } });
}
