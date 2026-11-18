// Automatic posts to the Roots & Pantry Facebook page when a producer goes live or adds an offer.
// Things are queued, held for HOLD_SECONDS so an admin can cancel them, then posted by the hourly
// cron (index.js). The post text is written at posting time from the current data, so edits made
// during the hold are used, and anything paused, ended or no longer live is skipped.
//
// Never posted: exclusive deals (families can't claim them until the family app opens), anything
// with alcohol (alcohol is for adults only, and a Facebook page is public), codes, phone numbers.
// Posting needs FB_AUTOPOST = "on", FB_PAGE_ID and the FB_PAGE_TOKEN secret. Otherwise rows are
// marked "dry_run" with the text that would have gone out. Setup: docs/facebook.md.
import { html, now, randomId } from './util.js';
import { sendEmail, audit } from './services.js';
import { todayUK } from './producer.js';
import { kindText, untilText } from './offers.js';

export const FB_GRAPH = 'https://graph.facebook.com/v27.0';
export const HOLD_SECONDS = 60 * 60;
const MAX_PER_RUN = 5;

export const fbReady = (env) => env.FB_AUTOPOST === 'on' && !!env.FB_PAGE_ID && !!env.FB_PAGE_TOKEN;
const fbOffReason = (env) => (env.FB_AUTOPOST !== 'on' ? (env.ENV_LABEL ? 'this is the test copy, so nothing goes to Facebook' : 'FB_AUTOPOST is not "on"') : !env.FB_PAGE_ID ? 'no Facebook page ID is set' : 'the page token (FB_PAGE_TOKEN) is not set up yet');

async function queue(env, { kind, itemId, producerId, after }) {
  const t = now();
  await env.DB.prepare(`INSERT OR IGNORE INTO fb_posts (id, kind, item_id, producer_id, status, post_after, created_at, updated_at)
    VALUES (?, ?, ?, ?, 'queued', ?, ?, ?)`).bind(randomId(), kind, itemId, producerId, Math.max(after, t + HOLD_SECONDS), t, t).run();
}

// A producer's first approval (not a reinstatement after a suspension).
export const queueProducer = (env, p) => queue(env, { kind: 'producer', itemId: p.id, producerId: p.id, after: now() });

// A new offer from an approved producer. If it starts later, post on its start date (09:00 UTC).
export async function queueOffer(env, p, o) {
  if (p.status !== 'approved' || o.alcohol) return;
  const start = Math.floor(Date.parse(`${o.starts_on}T09:00:00Z`) / 1000);
  await queue(env, { kind: 'offer', itemId: o.id, producerId: p.id, after: Math.max(now(), start) });
}

const where = (p) => [p.town, p.county].filter(Boolean).join(', ');
const liveOffer = (o, today) => o.status === 'active' && o.starts_on <= today && o.ends_on >= today;

// What to post, or { skip: reason }.
export async function buildPost(env, row, today = todayUK()) {
  const p = await env.DB.prepare('SELECT p.*, d.town FROM producers p LEFT JOIN postcode_districts d ON d.outcode = p.district WHERE p.id = ?').bind(row.producer_id).first();
  if (!p) return { skip: 'Producer no longer exists' };
  if (p.status !== 'approved') return { skip: 'Producer is not live' };
  const page = `${env.APP_URL}/p/${p.slug}`;
  if (row.kind === 'producer') {
    const offers = (await env.DB.prepare('SELECT * FROM offers WHERE producer_id = ? AND alcohol = 0 ORDER BY ends_on').bind(p.id).all()).results.filter((o) => liveOffer(o, today));
    const desc = p.description.length > 300 ? `${p.description.slice(0, 297).replace(/\s+\S*$/, '')}…` : p.description;
    const on = offers.length ? `\n\nOn now: ${offers.slice(0, 3).map((o) => `${o.title} (${o.price})`).join('; ')}.` : '';
    return {
      message: `🌱 New on Roots & Pantry: ${p.business_name}${where(p) ? `, ${where(p)}` : ''}.\n\n${desc}${on}\n\nSee where to find them${offers.length ? ' and their offers' : ''} 👇`,
      link: page,
    };
  }
  const o = await env.DB.prepare('SELECT * FROM offers WHERE id = ?').bind(row.item_id).first();
  if (!o) return { skip: 'Offer no longer exists' };
  if (o.alcohol) return { skip: 'Includes alcohol (adults only), so not posted' };
  if (!liveOffer(o, today)) return { skip: o.status === 'active' ? 'Offer is not running today' : `Offer is ${o.status}` };
  const lines = [
    `${o.christmas ? '🎄' : '🧺'} ${o.christmas ? 'Christmas' : 'New'} from ${p.business_name}${p.town ? ` in ${p.town}` : ''}: ${o.title}, ${o.price}.`,
    o.details ? `\n${o.details}` : '',
    `\n${untilText(o)}.${o.ready_text ? ` ${o.ready_text}.` : ''}`,
    `\n\nDetails and how to order 👇`,
  ];
  return { message: lines.join('').replace(/\.\./g, '.'), link: `${page}#offer-${o.id}` };
}

// POST /{page-id}/feed. Returns the new post id. Errors never include the token.
export async function postToPage(env, { message, link }, fetchImpl = fetch) {
  const body = new URLSearchParams({ message, link, access_token: env.FB_PAGE_TOKEN });
  let r;
  try {
    r = await fetchImpl(`${FB_GRAPH}/${encodeURIComponent(env.FB_PAGE_ID)}/feed`, { method: 'POST', body });
  } catch (e) {
    throw new Error(`Could not reach Facebook (${String(e && e.message ? e.message : e).slice(0, 120)})`);
  }
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.id) throw new Error(`Facebook said: ${j.error?.message ? String(j.error.message).slice(0, 300) : `HTTP ${r.status}`}`);
  return j.id;
}

// Post what's due. onlyId posts one row now (Admin "Post now"). Never throws.
export async function processFacebookQueue(env, { onlyId = null, fetchImpl = fetch, today = todayUK() } = {}) {
  const rows = onlyId
    ? (await env.DB.prepare("SELECT * FROM fb_posts WHERE id = ? AND status IN ('queued', 'dry_run', 'failed')").bind(onlyId).all()).results
    : (await env.DB.prepare("SELECT * FROM fb_posts WHERE status = 'queued' AND post_after <= ? ORDER BY post_after LIMIT ?").bind(now(), MAX_PER_RUN).all()).results;
  const done = { posted: 0, skipped: 0, dry_run: 0, failed: 0 };
  const failures = [];
  for (const row of rows) {
    const set = (status, extra = {}) => env.DB.prepare('UPDATE fb_posts SET status = ?, message = ?, link = ?, fb_post_id = ?, note = ?, updated_at = ? WHERE id = ?')
      .bind(status, extra.message ?? row.message ?? null, extra.link ?? row.link ?? null, extra.fb_post_id ?? null, extra.note ?? null, now(), row.id).run();
    try {
      const post = await buildPost(env, row, today);
      if (post.skip) { await set('skipped', { note: post.skip }); done.skipped++; continue; }
      if (!fbReady(env)) { await set('dry_run', { ...post, note: fbOffReason(env) }); done.dry_run++; continue; }
      const id = await postToPage(env, post, fetchImpl);
      await set('posted', { ...post, fb_post_id: id });
      done.posted++;
    } catch (e) {
      const note = String(e && e.message ? e.message : e).slice(0, 400);
      await set('failed', { note });
      failures.push(note);
      done.failed++;
    }
  }
  if (failures.length && !onlyId) {
    await sendEmail(env, {
      to: env.NOTIFY_EMAIL,
      subject: `Facebook post failed${env.ENV_LABEL ? ` (${env.ENV_LABEL})` : ''}`,
      text: `${failures.length === 1 ? 'An automatic Facebook post' : `${failures.length} automatic Facebook posts`} didn't go out.\n\n${failures.map((f) => `- ${f}`).join('\n')}\n\nYou can try again from Admin > Facebook: ${env.APP_URL}/admin/facebook\n\nIf it says the token is invalid or has expired, make a new page token (docs/facebook.md) and update FB_PAGE_TOKEN in Cloudflare.`,
    }).catch(() => {});
  }
  return done;
}

// ---------- admin page ----------
const STATUS_TEXT = { queued: 'Waiting', posted: 'Posted', cancelled: 'Cancelled', skipped: 'Skipped', failed: 'Failed', dry_run: 'Not posted' };
const STATUS_TAG = { queued: 'scheduled', posted: 'live', cancelled: 'ended', skipped: 'ended', failed: 'soon', dry_run: 'paused' };
const fmt = (ts) => new Date(ts * 1000).toLocaleString('en-GB', { timeZone: 'Europe/London', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

export async function facebookAdmin(request, env, user, url, { adminPage, done = '' } = {}) {
  const rows = (await env.DB.prepare(`SELECT f.*, p.business_name, p.slug, o.title AS offer_title FROM fb_posts f
    JOIN producers p ON p.id = f.producer_id LEFT JOIN offers o ON o.id = f.item_id AND f.kind = 'offer'
    ORDER BY f.created_at DESC LIMIT 50`).all()).results;
  const ready = fbReady(env);
  // Show the draft text for posts still waiting, so it can be read before it goes out.
  for (const r of rows) if (r.status === 'queued') { const b = await buildPost(env, r); r.message = b.skip ? null : b.message; r.link = b.skip ? null : b.link; r.note = b.skip ? `Will be skipped: ${b.skip}` : null; }
  const t = now();
  const flash = { now: 'Done. See the result below.', cancelled: 'Cancelled. It won\'t be posted.' }[done];
  return adminPage(env, user, {
    title: 'Facebook', section: 'facebook',
    body: html`<h1>Facebook posts</h1>
      ${flash ? html`<div class="flash" role="status">${flash}</div>` : ''}
      <p class="${ready ? 'note' : 'pecr pecr-no'}">${ready
        ? html`Automatic posting is <b>on</b>. New producers and new offers are posted to the Roots &amp; Pantry page about an hour after they go live. You can cancel them here before then.`
        : html`Automatic posting is <b>off</b>: ${fbOffReason(env)}. New producers and offers are still listed below with the text that would have been posted.`}</p>
      <p class="note">Never posted automatically: exclusive deals (families can't claim them until the family app opens) and anything with alcohol.</p>
      ${rows.length ? html`<ul class="deals">${rows.map((r) => html`<li class="deal">
        <div class="deal-main">
          <p class="deal-title"><b>${r.kind === 'producer' ? `New producer: ${r.business_name}` : `Offer: ${r.offer_title || '(deleted)'}, ${r.business_name}`}</b> <span class="tag tag-${STATUS_TAG[r.status]}">${STATUS_TEXT[r.status]}</span></p>
          <p class="deal-meta">${r.status === 'queued' ? (r.post_after <= t ? 'Due: goes out at the next half past the hour' : `Posts after ${fmt(r.post_after)}`) : `Updated ${fmt(r.updated_at)}`}${r.note ? ` · ${r.note}` : ''}</p>
          ${r.message ? html`<p class="fbtext">${r.message}</p>` : ''}
          ${r.link ? html`<p class="fblink"><span class="deal-meta">Link in the post:</span> <span class="fburl">${r.link}</span></p>
            <p class="btns"><a class="btn btn-ghost btn-sm" href="${r.link}" target="_blank" rel="noopener">Open link<span class="sr-only"> for ${r.kind === 'producer' ? r.business_name : r.offer_title} (opens in a new tab)</span></a>${r.fb_post_id ? html` <a class="btn btn-ghost btn-sm" href="https://www.facebook.com/${r.fb_post_id}" target="_blank" rel="noopener">See the post on Facebook<span class="sr-only"> (opens in a new tab)</span></a>` : ''}</p>`
          : html`<p><a href="/p/${r.slug}">Producer page</a></p>`}
        </div>
        <div class="deal-actions">
          ${['queued', 'dry_run', 'failed'].includes(r.status) ? html`<form method="post" action="/admin/facebook/${r.id}/now"><button class="btn btn-green btn-sm">${r.status === 'queued' ? 'Post now' : 'Try posting again'}</button></form>` : ''}
          ${r.status === 'queued' ? html`<form method="post" action="/admin/facebook/${r.id}/cancel"><button class="btn btn-ghost btn-sm">Cancel</button></form>` : ''}
        </div>
      </li>`)}</ul>` : html`<p>Nothing yet. Posts appear here when a producer is approved or an approved producer adds an offer.</p>`}`,
  });
}

export async function postFacebookNow(request, env, user, id) {
  const row = await env.DB.prepare('SELECT id FROM fb_posts WHERE id = ?').bind(id).first();
  if (!row) return null;
  await processFacebookQueue(env, { onlyId: id });
  await audit(env, user.id, 'facebook.post_now', id);
  return Response.redirect(new URL('/admin/facebook?done=now', request.url), 303);
}

export async function postFacebookCancel(request, env, user, id) {
  const r = await env.DB.prepare("UPDATE fb_posts SET status = 'cancelled', note = ?, updated_at = ? WHERE id = ? AND status = 'queued'")
    .bind(`Cancelled by ${user.display_name || user.email}`, now(), id).run();
  if (!r.meta.changes) return null;
  await audit(env, user.id, 'facebook.cancelled', id);
  return Response.redirect(new URL('/admin/facebook?done=cancelled', request.url), 303);
}
