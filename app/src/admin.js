// Admin dashboard: owner + moderators. Producer review, deals, messages, team, audit log.
// Every /admin request needs a recent email code: after 15 minutes without admin activity we ask again.
import { html, raw, now, randomId, clean, normEmail, validEmail, sha256 } from './util.js';
import { page, errorList, field } from './layout.js';
import { sendEmail, rateLimit, audit } from './services.js';
import { issueCode, checkCode, isAdmin, CODE_MINUTES_VALID } from './auth.js';
import { dealState, offerText, howText, niceDate, todayUK } from './producer.js';

export const ADMIN_IDLE_SECONDS = 15 * 60;
const PAGE_SIZE = 100;

const fmtTime = (ts) => new Date(ts * 1000).toLocaleString('en-GB', { timeZone: 'Europe/London', day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
const STATUS_LABEL = { pending: 'Waiting for approval', approved: 'Live', rejected: 'Not approved', suspended: 'Suspended' };
const MSG_LABEL = { new: 'New', answered: 'Answered', closed: 'Closed' };
const redirect = (request, to) => Response.redirect(new URL(to, request.url), 303);

function adminPage(env, user, { title, body, status = 200, back = null }) {
  const owner = user.role === 'owner';
  return page(env, {
    title: `${title} · Admin`,
    user,
    status,
    body: html`<div class="admin">
      <nav class="adminnav" aria-label="Admin">
        <a href="/admin">Overview</a>
        <a href="/admin/producers">Producers</a>
        <a href="/admin/messages">Messages</a>
        ${owner ? html`<a href="/admin/team">Team</a><a href="/admin/audit">Audit log</a>` : ''}
      </nav>
      ${back ? html`<p><a href="${back[0]}">← ${back[1]}</a></p>` : ''}
      ${body}
    </div>`,
  });
}

// ---------- access ----------
// Returns a Response to send instead (sign in / confirm), or null if the admin may continue.
export async function adminGate(request, env, user, path) {
  if (!isAdmin(user)) return 'notfound';
  if (path.startsWith('/admin/confirm')) return null;
  if (now() - user.last_auth_at > ADMIN_IDLE_SECONDS) {
    const next = request.method === 'GET' ? path : '/admin';
    return redirect(request, `/admin/confirm?next=${encodeURIComponent(next)}`);
  }
  // Sliding window: activity keeps the admin session fresh.
  await env.DB.prepare('UPDATE sessions SET last_auth_at = ? WHERE id_hash = ?').bind(now(), user.id_hash).run();
  return null;
}

const safeAdminNext = (n) => (typeof n === 'string' && /^\/admin[a-z0-9/_?=&-]*$/i.test(n) ? n : '/admin');

function confirmPage(env, user, { next, sent = false, errors = [] }) {
  return page(env, {
    title: "Confirm it's you",
    user,
    status: errors.length ? 400 : 200,
    body: html`<div class="narrow">
      <h1>Confirm it's you</h1>
      <p class="sub">For safety, admin pages ask for a fresh code from your email after 15 minutes without admin activity.</p>
      ${errorList(errors)}
      ${sent
        ? html`<p>We've emailed a 6-digit code to <b>${user.email}</b>. It works for ${CODE_MINUTES_VALID} minutes.</p>
          <form method="post" action="/admin/confirm" novalidate>
            <input type="hidden" name="next" value="${next}" />
            ${field({ id: 'code', label: 'Your 6-digit code', autocomplete: 'one-time-code', inputmode: 'numeric', max: 6, error: errors.find((e) => e.field === 'code')?.msg })}
            <button class="btn btn-green" type="submit">Continue</button>
          </form>
          <form method="post" action="/admin/confirm/send"><input type="hidden" name="next" value="${next}" /><button class="btn btn-ghost btn-sm" type="submit">Send a new code</button></form>`
        : html`<form method="post" action="/admin/confirm/send"><input type="hidden" name="next" value="${next}" /><button class="btn btn-green" type="submit">Email me a code</button></form>`}
    </div>`,
  });
}

export const getConfirm = (request, env, user, url) => confirmPage(env, user, { next: safeAdminNext(url.searchParams.get('next')) });

export async function postConfirmSend(request, env, user, form) {
  const next = safeAdminNext(form.get('next'));
  if (!(await rateLimit(env, `reauth:${await sha256(user.id)}`, 5, 3600))) {
    return confirmPage(env, user, { next, errors: [{ field: 'code', msg: "You've asked for a lot of codes. Please wait an hour, or use the last code we sent." }], sent: true });
  }
  const code = await issueCode(env, user.email);
  await sendEmail(env, {
    to: user.email,
    subject: `Your Roots & Pantry admin code: ${code}`,
    text: `Your Roots & Pantry admin code is: ${code}\n\nIt works for ${CODE_MINUTES_VALID} minutes. Type it into the admin page.\n\nIf you didn't ask for this, someone may be using your session. Sign out everywhere by emailing hello@rootsandpantry.co.uk.\n\nRoots & Pantry`,
  });
  await audit(env, user.id, 'admin.code_sent', user.id);
  return confirmPage(env, user, { next, sent: true });
}

export async function postConfirm(request, env, user, form) {
  const next = safeAdminNext(form.get('next'));
  const code = String(form.get('code') || '').replace(/\D/g, '');
  const bad = (msg) => confirmPage(env, user, { next, sent: true, errors: [{ field: 'code', msg }] });
  if (code.length !== 6) return bad('Enter the 6 digits from the email.');
  const result = await checkCode(env, user.email, code);
  if (result === 'expired') return bad('That code has expired or been used too many times. Send a new one.');
  if (result === 'wrong') { await audit(env, user.id, 'admin.code_wrong', user.id); return bad("That code doesn't match. Check the latest email."); }
  await env.DB.prepare('UPDATE sessions SET last_auth_at = ? WHERE id_hash = ?').bind(now(), user.id_hash).run();
  await audit(env, user.id, 'admin.confirmed', user.id);
  return redirect(request, next);
}

// ---------- overview ----------
export async function overview(request, env, user) {
  const today = todayUK();
  const q = (sql, ...b) => env.DB.prepare(sql).bind(...b).first();
  const [byStatus, withLive, liveDeals, endingSoon, newMsgs] = await Promise.all([
    env.DB.prepare('SELECT status, COUNT(*) AS n FROM producers GROUP BY status').all().then((r) => Object.fromEntries(r.results.map((x) => [x.status, x.n]))),
    q(`SELECT COUNT(DISTINCT p.id) AS n FROM producers p JOIN deals d ON d.producer_id = p.id
       WHERE p.status = 'approved' AND d.status = 'active' AND d.starts_on <= ? AND d.ends_on >= ?`, today, today),
    q(`SELECT COUNT(*) AS n FROM deals d JOIN producers p ON p.id = d.producer_id
       WHERE p.status = 'approved' AND d.status = 'active' AND d.starts_on <= ? AND d.ends_on >= ?`, today, today),
    q(`SELECT COUNT(*) AS n FROM deals d JOIN producers p ON p.id = d.producer_id
       WHERE p.status = 'approved' AND d.status = 'active' AND d.ends_on >= ? AND d.ends_on <= date(?, '+7 days')`, today, today),
    q("SELECT COUNT(*) AS n FROM messages WHERE status = 'new'"),
  ]);
  const pending = await env.DB.prepare("SELECT p.id, p.business_name, p.county, p.created_at FROM producers p WHERE p.status = 'pending' ORDER BY p.created_at LIMIT 20").all().then((r) => r.results);
  const stat = (n, label, href) => html`<li class="stat"><a href="${href}"><span class="n">${n}</span><span class="l">${label}</span></a></li>`;
  return adminPage(env, user, {
    title: 'Overview',
    body: html`<h1>Admin</h1>
      <p class="sub">Signed in as ${user.email} (${user.role}).</p>
      <h2>Success measures</h2>
      <ul class="stats">
        ${stat(withLive.n, 'producers with a live deal', '/admin/producers?status=approved')}
        ${stat(liveDeals.n, 'live deals', '/admin/producers?status=approved')}
        ${stat(endingSoon.n, 'deals ending in the next 7 days', '/admin/producers?status=approved')}
      </ul>
      <p class="note">Active family groups will show here once families open (stage 2).</p>
      <h2>To do</h2>
      <ul class="stats">
        ${stat(byStatus.pending || 0, 'producers waiting for approval', '/admin/producers?status=pending')}
        ${stat(newMsgs.n, 'new messages', '/admin/messages')}
      </ul>
      <p class="note">All producers: ${byStatus.approved || 0} live, ${byStatus.pending || 0} waiting, ${byStatus.suspended || 0} suspended, ${byStatus.rejected || 0} not approved.</p>
      ${pending.length ? html`<section class="panel" aria-labelledby="pend-h"><h2 id="pend-h">Waiting for approval</h2><ul class="plain">${pending.map((p) => html`<li><a href="/admin/producers/${p.id}">${p.business_name}</a>, ${p.county} · signed up ${fmtTime(p.created_at)}</li>`)}</ul></section>` : ''}`,
  });
}

// ---------- producers ----------
export async function producerList(request, env, user, url) {
  const status = ['pending', 'approved', 'suspended', 'rejected'].includes(url.searchParams.get('status')) ? url.searchParams.get('status') : 'all';
  const today = todayUK();
  const rows = await env.DB.prepare(
    `SELECT p.id, p.business_name, p.county, p.postcode, p.status, p.created_at,
       (SELECT COUNT(*) FROM deals d WHERE d.producer_id = p.id AND d.status = 'active' AND d.starts_on <= ?1 AND d.ends_on >= ?1) AS live
     FROM producers p ${status === 'all' ? '' : 'WHERE p.status = ?2'}
     ORDER BY CASE p.status WHEN 'pending' THEN 0 ELSE 1 END, p.business_name COLLATE NOCASE LIMIT ${PAGE_SIZE}`,
  ).bind(...(status === 'all' ? [today] : [today, status])).all().then((r) => r.results);
  const tab = (key, label) => html`<a href="/admin/producers${key === 'all' ? '' : `?status=${key}`}" ${status === key ? raw('aria-current="page"') : ''}>${label}</a>`;
  return adminPage(env, user, {
    title: 'Producers',
    body: html`<h1>Producers</h1>
      <nav class="tabs" aria-label="Filter producers">${tab('all', 'All')}${tab('pending', 'Waiting')}${tab('approved', 'Live')}${tab('suspended', 'Suspended')}${tab('rejected', 'Not approved')}</nav>
      ${rows.length ? html`<ul class="rows">${rows.map((p) => html`<li>
          <p class="row-title"><a href="/admin/producers/${p.id}">${p.business_name}</a> <span class="tag tag-p-${p.status}">${STATUS_LABEL[p.status]}</span></p>
          <p class="row-meta">${p.county} · ${p.postcode} · ${p.live} live ${p.live === 1 ? 'deal' : 'deals'} · signed up ${fmtTime(p.created_at)}</p>
        </li>`)}</ul>` : html`<p>No producers here.</p>`}`,
  });
}

const getProducerById = (env, id) => env.DB.prepare('SELECT p.*, u.email FROM producers p JOIN users u ON u.id = p.user_id WHERE p.id = ?').bind(id).first();

async function historyFor(env, targets) {
  const marks = targets.map(() => '?').join(',');
  return env.DB.prepare(
    `SELECT a.*, u.email AS actor_email FROM audit_log a LEFT JOIN users u ON u.id = a.actor_id WHERE a.target IN (${marks}) ORDER BY a.id DESC LIMIT 50`,
  ).bind(...targets).all().then((r) => r.results);
}

function detailText(detail) {
  if (!detail) return '';
  try {
    const d = JSON.parse(detail);
    return Object.entries(d).map(([k, v]) => `${k}: ${v}`).join(', ');
  } catch { return ''; }
}

export async function producerDetail(request, env, user, id, { errors = [], values = {} } = {}) {
  const p = await getProducerById(env, id);
  if (!p) return null;
  const deals = await env.DB.prepare('SELECT * FROM deals WHERE producer_id = ? ORDER BY ends_on DESC').bind(p.id).all().then((r) => r.results);
  const history = await historyFor(env, [p.id, p.user_id, ...deals.map((d) => d.id)]);
  const today = todayUK();
  const err = (f) => errors.find((e) => e.field === f)?.msg;
  const reasonForm = (to, label, btnClass, hint) => html`<form method="post" action="/admin/producers/${p.id}/status" novalidate class="reasonform">
      <input type="hidden" name="to" value="${to}" />
      ${field({ id: `reason-${to}`, label: `Reason (sent to the producer)`, rows: 3, max: 600, hint, value: values[`reason-${to}`] || '', error: err(`reason-${to}`) })}
      <button class="btn ${btnClass}" type="submit">${label}</button>
    </form>`;
  const approve = (label) => html`<form method="post" action="/admin/producers/${p.id}/status"><input type="hidden" name="to" value="approved" /><button class="btn btn-green" type="submit">${label}</button></form>`;
  return adminPage(env, user, {
    title: p.business_name,
    status: errors.length ? 400 : 200,
    back: ['/admin/producers', 'All producers'],
    body: html`${new URL(request.url).searchParams.get('done') ? html`<div class="flash" role="status">Done. The producer has been emailed.</div>` : ''}
      <h1>${p.business_name}</h1>
      <p class="status status-${p.status}"><b>Status:</b> ${STATUS_LABEL[p.status]}</p>
      ${p.status_reason ? html`<p><b>Reason given:</b> ${p.status_reason}</p>` : ''}
      ${p.reviewed_at ? html`<p class="note">Last reviewed ${fmtTime(p.reviewed_at)}.</p>` : ''}
      ${errorList(errors)}

      <section class="panel" aria-labelledby="act-h">
        <h2 id="act-h">Decision</h2>
        ${p.status === 'pending' ? html`<p>Check it's a real food or drink business in the UK: look at the website or Facebook page, and the hygiene rating if given.</p>
          <div class="cards">${approve('Approve and email them')}${reasonForm('rejected', 'Reject and email them', 'btn-red', 'For example: "We only list food and drink businesses."')}</div>` : ''}
        ${p.status === 'approved' ? html`<p>Suspending hides the listing and all its deals straight away.</p>${reasonForm('suspended', 'Suspend and email them', 'btn-red', 'For example: "Your code ROOTS10 isn\'t working on your website."')}` : ''}
        ${p.status === 'suspended' || p.status === 'rejected' ? html`<p>Approving makes the listing and its current deals public again.</p>${approve(p.status === 'suspended' ? 'Reinstate and email them' : 'Approve and email them')}` : ''}
      </section>

      <section class="panel" aria-labelledby="info-h">
        <h2 id="info-h">Details</h2>
        <dl class="details">
          <dt>Contact</dt><dd>${p.contact_name}</dd>
          <dt>Email</dt><dd>${p.email}</dd>
          <dt>Phone</dt><dd>${p.phone}</dd>
          <dt>Postcode</dt><dd>${p.postcode}, ${p.county}</dd>
          <dt>Website</dt><dd>${p.website ? html`<a href="${p.website}" rel="noopener noreferrer" target="_blank">${p.website}<span class="sr-only"> (opens in a new tab)</span></a>` : 'None'}</dd>
          <dt>Facebook</dt><dd>${p.facebook ? html`<a href="${p.facebook}" rel="noopener noreferrer" target="_blank">${p.facebook}<span class="sr-only"> (opens in a new tab)</span></a>` : 'None'}</dd>
          <dt>Hygiene</dt><dd>${p.hygiene_link ? html`<a href="${p.hygiene_link}" rel="noopener noreferrer" target="_blank">${p.hygiene_link}<span class="sr-only"> (opens in a new tab)</span></a>` : 'None'}</dd>
          <dt>Shop</dt><dd>${p.shop_address || 'None'}</dd>
          <dt>Markets</dt><dd>${p.market_days || 'None'}</dd>
          <dt>Delivery</dt><dd>${{ none: 'No delivery', local: 'Local only', miles: `Within ${p.delivery_miles} miles`, uk: 'UK-wide' }[p.delivery_reach] || 'Not set'}</dd>
          <dt>Terms</dt><dd>Version ${p.terms_version}, agreed ${fmtTime(p.terms_accepted_at)}</dd>
          <dt>Public page</dt><dd><a href="/p/${p.slug}">/p/${p.slug}</a></dd>
        </dl>
        <h3>Description</h3>
        <p class="pre">${p.description}</p>
      </section>

      <section class="panel" aria-labelledby="deals-h">
        <h2 id="deals-h">Deals</h2>
        ${deals.length ? html`<ul class="deals">${deals.map((d) => {
          const [state, label] = dealState(d, p.status, today);
          return html`<li class="deal">
            <div class="deal-main">
              <p class="deal-title"><b>${d.title}</b> <span class="tag tag-${state}">${state === 'waiting' ? 'Waiting for listing approval' : label}</span></p>
              <p class="deal-meta">${offerText(d)} · ${howText[d.how]} · ${d.redemption === 'code' ? `Code ${d.code}` : 'Mention Roots & Pantry'} · ${niceDate(d.starts_on)} to ${niceDate(d.ends_on)}${d.alcohol ? ' · Adults only' : ''}</p>
              <p class="deal-meta">Products: ${d.products}${d.allergens ? ` · Allergens: ${d.allergens}` : ''}${d.online_url ? ` · Online at ${d.online_url}` : ''}</p>
              ${d.small_print ? html`<p class="deal-meta">Small print: ${d.small_print}</p>` : ''}
            </div>
            ${state !== 'ended' ? html`<details class="deal-actions"><summary>End this deal<span class="sr-only">: ${d.title}</span></summary>
              <form method="post" action="/admin/deals/${d.id}/end" novalidate>
                ${field({ id: `end-${d.id}`, label: 'Reason (sent to the producer)', rows: 2, max: 600, value: values[`end-${d.id}`] || '', error: err(`end-${d.id}`) })}
                <button class="btn btn-red btn-sm" type="submit">End deal and email them</button>
              </form></details>` : ''}
          </li>`;
        })}</ul>` : html`<p>No deals yet.</p>`}
      </section>

      <section class="panel" aria-labelledby="hist-h">
        <h2 id="hist-h">History</h2>
        ${history.length ? html`<ul class="plain">${history.map((a) => html`<li>${fmtTime(a.created_at)} · <b>${a.action}</b> by ${a.actor_email || 'system'}${a.detail ? ` · ${detailText(a.detail)}` : ''}</li>`)}</ul>` : html`<p>Nothing yet.</p>`}
      </section>`,
  });
}

const EMAILS = {
  approved: (p, origin, wasSuspended) => ({
    subject: wasSuspended ? 'Your Roots & Pantry listing is live again' : 'Your Roots & Pantry listing is live',
    text: `Hi ${p.contact_name},\n\n${wasSuspended ? `${p.business_name} is live again on Roots & Pantry.` : `Good news: ${p.business_name} is now live on Roots & Pantry.`} Families can see your listing and your current deals.\n\nManage your listing and deals: ${origin}/producer\nYour public page: ${origin}/p/${p.slug}\n\nTip: the promote kit in your dashboard has a poster, a postcard and a ready-made Facebook post.\n\nAny questions, just reply to this email.\n\nJason\nRoots & Pantry`,
  }),
  rejected: (p, origin, _w, reason) => ({
    subject: 'About your Roots & Pantry listing',
    text: `Hi ${p.contact_name},\n\nThanks for signing up ${p.business_name}. I'm sorry, but we can't approve the listing at the moment.\n\nThe reason: ${reason}\n\nIf you think we've got this wrong, or you can change something, just reply to this email.\n\nJason\nRoots & Pantry`,
  }),
  suspended: (p, origin, _w, reason) => ({
    subject: 'Your Roots & Pantry listing is paused',
    text: `Hi ${p.contact_name},\n\nWe've paused the listing for ${p.business_name}, so families can't see it or its deals for now.\n\nThe reason: ${reason}\n\nTo appeal, or once it's sorted, just reply to this email and we'll look again.\n\nJason\nRoots & Pantry`,
  }),
};

export async function postProducerStatus(request, env, user, id, form) {
  const p = await getProducerById(env, id);
  if (!p) return null;
  const to = String(form.get('to') || '');
  const allowed = { pending: ['approved', 'rejected'], approved: ['suspended'], suspended: ['approved'], rejected: ['approved'] }[p.status] || [];
  if (!allowed.includes(to)) return redirect(request, `/admin/producers/${p.id}`);
  const reason = clean(form.get(`reason-${to}`), 600);
  if (to !== 'approved' && reason.length < 10) {
    return producerDetail(request, env, user, id, { errors: [{ field: `reason-${to}`, msg: 'Give the producer a reason (at least 10 characters). It goes in the email.' }], values: { [`reason-${to}`]: reason } });
  }
  const t = now();
  const res = await env.DB.prepare('UPDATE producers SET status = ?, status_reason = ?, reviewed_at = ?, reviewed_by = ?, updated_at = ? WHERE id = ? AND status = ?')
    .bind(to, to === 'approved' ? null : reason, t, user.id, t, p.id, p.status).run();
  if (!res.meta.changes) return redirect(request, `/admin/producers/${p.id}`); // someone else changed it first
  await audit(env, user.id, `producer.${to}`, p.id, to === 'approved' ? { from: p.status } : { from: p.status, reason });
  const mail = EMAILS[to](p, new URL(request.url).origin, p.status === 'suspended', reason);
  await sendEmail(env, { to: p.email, replyTo: env.NOTIFY_EMAIL, ...mail });
  return redirect(request, `/admin/producers/${p.id}?done=1`);
}

export async function postEndDeal(request, env, user, dealId, form) {
  const d = await env.DB.prepare('SELECT * FROM deals WHERE id = ?').bind(dealId).first();
  if (!d) return null;
  const p = await getProducerById(env, d.producer_id);
  const reason = clean(form.get(`end-${d.id}`), 600);
  if (reason.length < 10) {
    return producerDetail(request, env, user, p.id, { errors: [{ field: `end-${d.id}`, msg: 'Give the producer a reason (at least 10 characters). It goes in the email.' }], values: { [`end-${d.id}`]: reason } });
  }
  if (d.status !== 'ended') {
    await env.DB.prepare("UPDATE deals SET status = 'ended', updated_at = ? WHERE id = ?").bind(now(), d.id).run();
    await audit(env, user.id, 'deal.ended_by_admin', d.id, { producer: p.id, reason });
    await sendEmail(env, {
      to: p.email,
      replyTo: env.NOTIFY_EMAIL,
      subject: 'We have ended one of your Roots & Pantry deals',
      text: `Hi ${p.contact_name},\n\nWe've ended your deal "${d.title}", so families can no longer see it.\n\nThe reason: ${reason}\n\nYou can add a new deal from your dashboard at any time: ${new URL(request.url).origin}/producer\n\nAny questions, just reply to this email.\n\nJason\nRoots & Pantry`,
    });
  }
  return redirect(request, `/admin/producers/${p.id}?done=1`);
}

// ---------- messages ----------
export async function messageList(request, env, user, url) {
  const status = ['new', 'answered', 'closed'].includes(url.searchParams.get('status')) ? url.searchParams.get('status') : 'new';
  const rows = await env.DB.prepare(`SELECT id, name, email, topic, substr(body, 1, 140) AS preview, status, created_at FROM messages WHERE status = ? ORDER BY created_at DESC LIMIT ${PAGE_SIZE}`)
    .bind(status).all().then((r) => r.results);
  const tab = (key) => html`<a href="/admin/messages?status=${key}" ${status === key ? raw('aria-current="page"') : ''}>${MSG_LABEL[key]}</a>`;
  return adminPage(env, user, {
    title: 'Messages',
    body: html`<h1>Messages</h1>
      <p class="sub">From the contact form. Each one was also emailed to hello@, so reply from your inbox.</p>
      <nav class="tabs" aria-label="Filter messages">${tab('new')}${tab('answered')}${tab('closed')}</nav>
      ${rows.length ? html`<ul class="rows">${rows.map((m) => html`<li>
          <p class="row-title"><a href="/admin/messages/${m.id}">${m.topic}: ${m.name}</a></p>
          <p class="row-meta">${m.email} · ${fmtTime(m.created_at)}</p>
          <p class="row-meta">${m.preview}${m.preview.length >= 140 ? '…' : ''}</p>
        </li>`)}</ul>` : html`<p>No ${MSG_LABEL[status].toLowerCase()} messages.</p>`}`,
  });
}

export async function messageDetail(request, env, user, id) {
  const m = await env.DB.prepare('SELECT * FROM messages WHERE id = ?').bind(id).first();
  if (!m) return null;
  const btn = (to, label) => html`<form method="post" action="/admin/messages/${m.id}/status"><input type="hidden" name="to" value="${to}" /><button class="btn btn-ghost btn-sm" type="submit">${label}</button></form>`;
  return adminPage(env, user, {
    title: 'Message',
    back: ['/admin/messages', 'Messages'],
    body: html`<h1>${m.topic}</h1>
      <p class="status"><b>Status:</b> ${MSG_LABEL[m.status]}</p>
      <dl class="details">
        <dt>From</dt><dd>${m.name}</dd>
        <dt>Email</dt><dd>${m.email}</dd>
        <dt>Sent</dt><dd>${fmtTime(m.created_at)}</dd>
      </dl>
      <div class="panel msgbody"><p class="pre">${m.body}</p></div>
      <p class="note">Reply from your hello@ inbox: the copy we emailed you has this person as the reply-to address.</p>
      <div class="btns">
        ${m.status !== 'answered' ? btn('answered', 'Mark as answered') : ''}
        ${m.status !== 'closed' ? btn('closed', 'Close') : ''}
        ${m.status !== 'new' ? btn('new', 'Mark as new') : ''}
      </div>`,
  });
}

export async function postMessageStatus(request, env, user, id, form) {
  const to = String(form.get('to') || '');
  if (!MSG_LABEL[to]) return null;
  const res = await env.DB.prepare('UPDATE messages SET status = ? WHERE id = ?').bind(to, id).run();
  if (!res.meta.changes) return null;
  await audit(env, user.id, `message.${to}`, id);
  return redirect(request, to === 'new' ? `/admin/messages/${id}` : '/admin/messages');
}

// ---------- team (owner only) ----------
export async function team(request, env, user, { errors = [], email = '' } = {}) {
  const people = await env.DB.prepare("SELECT id, email, role, last_login_at FROM users WHERE role IN ('owner', 'moderator') ORDER BY role DESC, email").all().then((r) => r.results);
  return adminPage(env, user, {
    title: 'Team',
    status: errors.length ? 400 : 200,
    body: html`<h1>Team</h1>
      <p class="sub">Moderators can approve, reject and suspend producers, end deals and handle messages. They can't see this page or the audit log.</p>
      <ul class="rows">${people.map((u) => html`<li>
        <p class="row-title"><b>${u.email}</b> <span class="tag">${u.role === 'owner' ? 'Owner' : 'Moderator'}</span></p>
        <p class="row-meta">${u.last_login_at ? `Last signed in ${fmtTime(u.last_login_at)}` : 'Not signed in yet'}</p>
        ${u.role === 'moderator' ? html`<form method="post" action="/admin/team/remove"><input type="hidden" name="id" value="${u.id}" /><button class="btn btn-ghost btn-sm" type="submit">Remove moderator<span class="sr-only"> ${u.email}</span></button></form>` : ''}
      </li>`)}</ul>
      <section class="panel" aria-labelledby="add-h">
        <h2 id="add-h">Add a moderator</h2>
        ${errorList(errors)}
        <form method="post" action="/admin/team/add" novalidate>
          ${field({ id: 'email', label: 'Their email address', type: 'email', value: email, autocomplete: 'off', max: 254, hint: 'They sign in at this app with a code sent to this address.', error: errors[0]?.msg })}
          <button class="btn btn-green" type="submit">Add moderator</button>
        </form>
      </section>`,
  });
}

export async function postTeamAdd(request, env, user, form) {
  const email = normEmail(form.get('email'));
  if (!validEmail(email)) return team(request, env, user, { email, errors: [{ field: 'email', msg: 'Enter a valid email address' }] });
  const existing = await env.DB.prepare('SELECT id, role FROM users WHERE email = ?').bind(email).first();
  if (existing?.role === 'owner') return team(request, env, user, { email, errors: [{ field: 'email', msg: "That's the owner account" }] });
  let id = existing?.id;
  if (existing) await env.DB.prepare("UPDATE users SET role = 'moderator' WHERE id = ?").bind(id).run();
  else {
    id = randomId();
    await env.DB.prepare("INSERT INTO users (id, email, role, created_at) VALUES (?, ?, 'moderator', ?)").bind(id, email, now()).run();
  }
  await audit(env, user.id, 'team.moderator_added', id, { email });
  await sendEmail(env, {
    to: email,
    replyTo: env.NOTIFY_EMAIL,
    subject: "You're now a Roots & Pantry moderator",
    text: `Hi,\n\n${user.email} has made you a moderator on Roots & Pantry. You can review new producers, handle messages and remove deals that break the rules.\n\nTo start, sign in with this email address at ${new URL(request.url).origin}/signin\n\nIf you weren't expecting this, reply to this email.\n\nRoots & Pantry`,
  });
  return redirect(request, '/admin/team');
}

export async function postTeamRemove(request, env, user, form) {
  const id = String(form.get('id') || '');
  const u = await env.DB.prepare("SELECT id, email FROM users WHERE id = ? AND role = 'moderator'").bind(id).first();
  if (!u) return redirect(request, '/admin/team');
  const hasListing = await env.DB.prepare('SELECT 1 FROM producers WHERE user_id = ?').bind(u.id).first();
  await env.DB.prepare("UPDATE users SET role = 'producer' WHERE id = ?").bind(u.id).run();
  if (!hasListing) await env.DB.prepare('DELETE FROM sessions WHERE user_id = ?').bind(u.id).run();
  else await env.DB.prepare('UPDATE sessions SET last_auth_at = 0 WHERE user_id = ?').bind(u.id).run();
  await audit(env, user.id, 'team.moderator_removed', u.id, { email: u.email });
  return redirect(request, '/admin/team');
}

// ---------- audit log (owner only) ----------
export async function auditLog(request, env, user, url) {
  const before = Number(url.searchParams.get('before')) || 0;
  const rows = await env.DB.prepare(
    `SELECT a.*, u.email AS actor_email FROM audit_log a LEFT JOIN users u ON u.id = a.actor_id ${before ? 'WHERE a.id < ?' : ''} ORDER BY a.id DESC LIMIT ${PAGE_SIZE}`,
  ).bind(...(before ? [before] : [])).all().then((r) => r.results);
  return adminPage(env, user, {
    title: 'Audit log',
    body: html`<h1>Audit log</h1>
      <p class="sub">Every sign-in, listing change and admin action, newest first.</p>
      <ul class="rows audit">${rows.map((a) => html`<li><p class="row-meta"><b>${a.action}</b> · ${fmtTime(a.created_at)} · by ${a.actor_email || 'system'}${a.target ? ` · on ${a.target}` : ''}${a.detail ? ` · ${detailText(a.detail)}` : ''}</p></li>`)}</ul>
      ${rows.length === PAGE_SIZE ? html`<p><a class="btn btn-ghost" href="/admin/audit?before=${rows[rows.length - 1].id}">Older entries</a></p>` : ''}`,
  });
}

