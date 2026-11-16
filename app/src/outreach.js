// Producer outreach: a small CRM in the admin area for finding and inviting producers.
// PECR: only Ltd companies and LLPs can be emailed without asking first. Sole traders and
// partnerships get a letter, a visit or a call instead, so the email tools only appear for Ltd/LLP.
import { html, raw, now, randomId, clean, normEmail, validEmail, validUrl } from './util.js';
import { errorList, field, securityHeaders } from './layout.js';
import { sendEmail, audit } from './services.js';
import { adminPage } from './admin.js';
import { todayUK, niceDate, qrSvg } from './producer.js';
import { COUNTIES } from './data.js';

export const KINDS = { ltd: 'Ltd company', llp: 'LLP', sole: 'Sole trader', partnership: 'Partnership', unknown: 'Not checked yet' };
const KIND_SHORT = { ltd: 'Ltd', llp: 'LLP', sole: 'Sole trader', partnership: 'Partnership', unknown: 'Type not checked' };
export const STAGES = { todo: 'To contact', contacted: 'Contacted', replied: 'Replied', joined: 'Joined', no_reply: 'No reply', not_interested: 'Not interested' };
const METHODS = { email: 'Email', letter: 'Letter', visit: 'Visit or market chat', phone: 'Phone call', facebook: 'Facebook message' };
const MAX_IMPORT_ROWS = 500;
const FOLLOW_UP_DAYS = { email: 7, other: 14 };
const NO_REPLY_DAYS = 14; // after the follow-up, wait this long before marking "No reply"
const COMPANY = 'Roots & Pantry is a trading name of BMS Cyber Defence Ltd, registered in England and Wales, company number 14975379.';
const POSTAL = ['Roots & Pantry', '254 Holyhead Road', 'Wellington', 'Telford', 'TF1 2EB'];

export const canEmail = (o) => (o.kind === 'ltd' || o.kind === 'llp') && !!o.email;
const isDue = (o, today) => o.stage === 'contacted' && o.contact_count === 1 && o.follow_up_on && o.follow_up_on <= today;
const addDays = (ymd, n) => new Date(Date.parse(`${ymd}T12:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
const shortDate = (ymd) => new Date(`${ymd}T12:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' });
const fmtTime = (ts) => new Date(ts * 1000).toLocaleString('en-GB', { timeZone: 'Europe/London', day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
const redirect = (request, to) => Response.redirect(new URL(to, request.url), 303);
const firstName = (n) => (n || '').trim().split(/\s+/)[0] || '';
const hostOf = (u) => { try { return new URL(u).hostname.replace(/^www\./, '').toLowerCase(); } catch { return ''; } };
const appUrl = (request, env) => env.APP_URL || new URL(request.url).origin;

const getItem = (env, id) => env.DB.prepare('SELECT o.*, u.display_name AS assigned_name, u.email AS assigned_email FROM outreach o LEFT JOIN users u ON u.id = o.assigned_to WHERE o.id = ?').bind(id).first();
const admins = (env) => env.DB.prepare("SELECT id, email, display_name FROM users WHERE role IN ('owner', 'moderator') ORDER BY display_name, email").all().then((r) => r.results);
const addNote = (env, id, userId, body) => env.DB.prepare('INSERT INTO outreach_notes (outreach_id, by_user, body, created_at) VALUES (?, ?, ?, ?)').bind(id, userId, body, now());
const touch = (env, id) => env.DB.prepare('UPDATE outreach SET updated_at = ? WHERE id = ?').bind(now(), id);

function stageTag(o, today) {
  if (isDue(o, today)) return html`<span class="tag tag-o-due">Follow-up due${o.follow_up_on === today ? ' today' : ''}</span>`;
  return html`<span class="tag tag-o-${o.stage}">${STAGES[o.stage]}</span>`;
}

// ---------- email and letter text ----------
function intro(user) {
  const name = user.display_name;
  if (!name) return "I'm getting in touch from Roots & Pantry,";
  return user.role === 'owner' ? `I'm ${name} and I run Roots & Pantry,` : `I'm ${name} from Roots & Pantry,`;
}
const signOff = (user) => `${user.display_name || 'The Roots & Pantry team'}\nRoots & Pantry · hello@rootsandpantry.co.uk`;
const productLine = (o) => (o.products ? ` I think your ${o.products} would go down really well with local families.` : '');

export function emailFor(o, which, { user, request, env }) {
  const hi = `Hi ${firstName(o.contact_name) || 'there'},`;
  const join = `${appUrl(request, env)}/producer/join`;
  const subject = `Free listing for ${o.business_name} on Roots & Pantry`;
  if (which === 'follow_up') {
    return {
      subject: `Re: ${subject}`,
      body: `${hi}

Just a quick follow-up to my email${o.last_contact_on ? ` of ${niceDate(o.last_contact_on)}` : ''}. Roots & Pantry is a free website that helps local families find independent food producers like ${o.business_name}. You can set your own exclusive deals for them, and being listed costs nothing.

Joining takes about 5 minutes: ${join}

This is the only follow-up I'll send. If it's not for you, just reply "no thanks".

${signOff(user)}
${COMPANY}`,
    };
  }
  return {
    subject,
    body: `${hi}

${intro(user)} a new free website that helps families${o.county ? ` in ${o.county}` : ''} find and buy from independent local food producers like ${o.business_name}.

Being listed is free. Families find you by postcode, and you can set your own exclusive deals for them (at least 10% off, or a free item), so new customers come to you.${productLine(o)}

Joining takes about 5 minutes: ${join}
How it works for producers: ${env.SITE_URL}/for-producers/

Happy to answer any questions, just reply to this email. If you'd rather not hear from us again, reply "no thanks" and I won't contact you again.

${signOff(user)}
${COMPANY}`,
  };
}

const mailto = (o, e) => `mailto:${encodeURIComponent(o.email)}?subject=${encodeURIComponent(e.subject)}&body=${encodeURIComponent(e.body)}`;

// ---------- list ----------
const TABS = [['due', 'Follow-up due'], ['todo', 'To contact'], ['contacted', 'Contacted'], ['replied', 'Replied'], ['joined', 'Joined'], ['no_reply', 'No reply'], ['not_interested', 'Not interested'], ['all', 'All']];

export async function outreachList(request, env, user, url) {
  const today = todayUK();
  const tab = TABS.some(([k]) => k === url.searchParams.get('tab')) ? url.searchParams.get('tab') : 'due';
  const county = COUNTIES.includes(url.searchParams.get('county')) ? url.searchParams.get('county') : '';
  const kind = KINDS[url.searchParams.get('kind')] ? url.searchParams.get('kind') : '';
  const q = clean(url.searchParams.get('q'), 60);
  const where = [];
  const bind = [];
  if (tab === 'due') { where.push("o.stage = 'contacted' AND o.contact_count = 1 AND o.follow_up_on <= ?"); bind.push(today); }
  else if (tab !== 'all') { where.push('o.stage = ?'); bind.push(tab); }
  if (county) { where.push('o.county = ?'); bind.push(county); }
  if (kind) { where.push('o.kind = ?'); bind.push(kind); }
  if (q) { where.push("(o.business_name LIKE ? ESCAPE '\\' OR o.town LIKE ? ESCAPE '\\')"); const like = `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`; bind.push(like, like); }
  const [rows, counts, total] = await Promise.all([
    env.DB.prepare(`SELECT o.*, u.display_name AS assigned_name FROM outreach o LEFT JOIN users u ON u.id = o.assigned_to
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY o.follow_up_on IS NULL, o.follow_up_on, o.business_name COLLATE NOCASE LIMIT 200`).bind(...bind).all().then((r) => r.results),
    env.DB.prepare(`SELECT
        SUM(stage = 'todo') AS todo, SUM(stage = 'contacted') AS contacted, SUM(stage = 'joined') AS joined,
        SUM(stage = 'contacted' AND contact_count = 1 AND follow_up_on <= ?) AS due FROM outreach`).bind(today).first(),
    env.DB.prepare('SELECT COUNT(*) AS n FROM outreach').first(),
  ]);
  const keep = (extra) => { const p = new URLSearchParams({ tab, ...(county && { county }), ...(kind && { kind }), ...(q && { q }), ...extra }); return `/admin/outreach?${p}`; };
  const stat = (n, label, t) => html`<li class="stat"><a href="/admin/outreach?tab=${t}"><span class="n">${n || 0}</span><span class="l">${label}</span></a></li>`;
  const action = (o) => {
    if (o.stage === 'todo' || isDue(o, today)) {
      const follow = isDue(o, today);
      if (canEmail(o)) return html`<a class="btn btn-ghost btn-sm" href="/admin/outreach/${o.id}#next">${follow ? 'Follow-up email' : 'First email'}<span class="sr-only"> for ${o.business_name}</span></a>`;
      if (o.address) return html`<a class="btn btn-ghost btn-sm" href="/admin/outreach/${o.id}/letter">Print letter<span class="sr-only"> for ${o.business_name}</span></a>`;
    }
    return html`<a class="btn btn-ghost btn-sm" href="/admin/outreach/${o.id}">Open<span class="sr-only"> ${o.business_name}</span></a>`;
  };
  const lastBit = (o) => (o.last_contact_on ? `last contact ${shortDate(o.last_contact_on)}` : 'not contacted yet');
  return adminPage(env, user, {
    title: 'Outreach',
    section: 'outreach',
    body: html`<h1>Outreach</h1>
      <p class="sub">Producers we'd like to invite. Only Ltd companies and LLPs can be emailed without asking first. Everyone else gets a letter, a visit or a call.</p>
      <ul class="stats">
        ${stat(counts.todo, 'to contact', 'todo')}
        ${stat(counts.contacted, 'contacted', 'contacted')}
        ${stat(counts.due, counts.due === 1 ? 'follow-up due' : 'follow-ups due', 'due')}
        ${stat(counts.joined, 'joined', 'joined')}
      </ul>
      <nav class="tabs" aria-label="Filter by stage">${TABS.map(([k, label]) => html`<a href="${keep({ tab: k })}" ${k === tab ? raw('aria-current="page"') : ''}>${label}</a>`)}</nav>
      <form method="get" action="/admin/outreach" class="toolbar" role="search" aria-label="Filter outreach">
        <input type="hidden" name="tab" value="${tab}" />
        <label class="sr-only" for="f-county">County</label>
        <select id="f-county" name="county"><option value="">All counties</option>${COUNTIES.map((c) => html`<option ${c === county ? raw('selected') : ''}>${c}</option>`)}</select>
        <label class="sr-only" for="f-kind">Business type</label>
        <select id="f-kind" name="kind"><option value="">All business types</option>${Object.entries(KINDS).map(([k, v]) => html`<option value="${k}" ${k === kind ? raw('selected') : ''}>${v}</option>`)}</select>
        <label class="sr-only" for="f-q">Search by name or town</label>
        <input id="f-q" name="q" type="search" value="${q}" placeholder="Search by name or town" maxlength="60" />
        <button class="btn btn-ghost btn-sm" type="submit">Filter</button>
        <span class="toolbar-end"><a class="btn btn-ghost btn-sm" href="/admin/outreach/import">Import CSV</a> <a class="btn btn-green btn-sm" href="/admin/outreach/new">+ Add producer</a></span>
      </form>
      ${rows.length ? html`<ul class="rows">${rows.map((o) => html`<li><div class="rowgrid"><div>
          <p class="row-title"><a href="/admin/outreach/${o.id}">${o.business_name}</a> <span class="kind">${KIND_SHORT[o.kind]}</span> ${stageTag(o, today)}</p>
          <p class="row-meta">${[o.town && o.county ? `${o.town}, ${o.county}` : o.town || o.county, o.products, lastBit(o), o.source && `found: ${o.source}`, o.assigned_name && `with ${o.assigned_name}`].filter(Boolean).join(' · ')}</p>
        </div><div class="btns">${action(o)}</div></div></li>`)}</ul>`
        : html`<p class="empty">${total.n ? 'Nothing here.' : 'No producers yet. Add one, or import a list.'}</p>`}
      <p class="note">Showing ${rows.length} of ${total.n}. Records are deleted 12 months after they were last updated, except "not interested", which we keep so we never contact them again.</p>`,
  });
}

// ---------- add / edit ----------
function readForm(form) {
  const v = {
    business_name: clean(form.get('business_name'), 120),
    contact_name: clean(form.get('contact_name'), 80),
    kind: KINDS[form.get('kind')] ? String(form.get('kind')) : 'unknown',
    company_number: clean(form.get('company_number'), 10).toUpperCase().replace(/\s/g, ''),
    email: normEmail(form.get('email')),
    phone: clean(form.get('phone'), 30),
    website: clean(form.get('website'), 300),
    address: clean(form.get('address'), 300).replace(/\r/g, ''),
    town: clean(form.get('town'), 60),
    county: COUNTIES.includes(form.get('county')) ? String(form.get('county')) : '',
    products: clean(form.get('products'), 80),
    source: clean(form.get('source'), 120),
    assigned_to: clean(form.get('assigned_to'), 40),
  };
  const errors = [];
  if (!v.business_name) errors.push({ field: 'business_name', msg: 'Enter the business name' });
  if (v.email && !validEmail(v.email)) errors.push({ field: 'email', msg: 'Enter a valid email address, or leave it blank' });
  if (v.website && !/^https?:\/\//i.test(v.website)) v.website = `https://${v.website}`;
  if (!validUrl(v.website)) errors.push({ field: 'website', msg: 'Enter a web address like https://example.co.uk' });
  if (v.company_number && !/^[A-Z0-9]{6,8}$/.test(v.company_number)) errors.push({ field: 'company_number', msg: 'A company number is 8 characters, like 09876543 or SC123456' });
  return { v, errors };
}

async function itemForm(request, env, user, { item = null, values = {}, errors = [] } = {}) {
  const v = { ...(item || {}), ...values };
  const team = await admins(env);
  const err = (f) => errors.find((e) => e.field === f)?.msg;
  const action = item ? `/admin/outreach/${item.id}/edit` : '/admin/outreach/new';
  return adminPage(env, user, {
    title: item ? `Edit ${item.business_name}` : 'Add a producer',
    section: 'outreach',
    status: errors.length ? 400 : 200,
    back: item ? [`/admin/outreach/${item.id}`, item.business_name] : ['/admin/outreach', 'Outreach'],
    body: html`<h1>${item ? `Edit ${item.business_name}` : 'Add a producer'}</h1>
      ${errorList(errors)}
      <form method="post" action="${action}" novalidate class="panel">
        ${field({ id: 'business_name', label: 'Business name', value: v.business_name, max: 120, error: err('business_name') })}
        ${field({ id: 'contact_name', label: 'Contact name', value: v.contact_name, required: false, max: 80, hint: 'Used for "Hi Sarah" in emails and letters.' })}
        <fieldset class="field">
          <legend>Business type</legend>
          <p class="hint">Check on Companies House. Only Ltd companies and LLPs can be emailed without asking first.</p>
          ${Object.entries(KINDS).map(([k, label]) => html`<div class="radio"><input type="radio" id="kind-${k}" name="kind" value="${k}" ${(v.kind || 'unknown') === k ? raw('checked') : ''} /><label for="kind-${k}">${label}</label></div>`)}
        </fieldset>
        ${field({ id: 'company_number', label: 'Companies House number', value: v.company_number, required: false, max: 10, error: err('company_number') })}
        ${field({ id: 'email', label: 'Email address', type: 'email', value: v.email, required: false, max: 254, autocomplete: 'off', error: err('email') })}
        ${field({ id: 'phone', label: 'Phone', type: 'tel', value: v.phone, required: false, max: 30, autocomplete: 'off' })}
        ${field({ id: 'website', label: 'Website or Facebook page', type: 'url', value: v.website, required: false, max: 300, error: err('website') })}
        ${field({ id: 'address', label: 'Postal address', value: v.address, required: false, max: 300, rows: 3, hint: 'For letters. One line per part of the address.' })}
        ${field({ id: 'town', label: 'Town', value: v.town, required: false, max: 60 })}
        <div class="field"><label for="county">County <span class="opt">(optional)</span></label>
          <select id="county" name="county"><option value="">Choose…</option>${COUNTIES.map((c) => html`<option ${c === v.county ? raw('selected') : ''}>${c}</option>`)}</select></div>
        ${field({ id: 'products', label: 'What they make', value: v.products, required: false, max: 80, hint: 'Written into the email, like "your Wenlock Edge cheddar".' })}
        ${field({ id: 'source', label: 'Where you found them', value: v.source, required: false, max: 120, hint: 'For example, Ludlow market or their website.' })}
        <div class="field"><label for="assigned_to">Who's handling this <span class="opt">(optional)</span></label>
          <select id="assigned_to" name="assigned_to"><option value="">Anyone</option>${team.map((t) => html`<option value="${t.id}" ${t.id === v.assigned_to ? raw('selected') : ''}>${t.display_name || t.email}</option>`)}</select></div>
        <button class="btn btn-green" type="submit">${item ? 'Save changes' : 'Add producer'}</button>
      </form>`,
  });
}

export const getNewItem = (request, env, user) => itemForm(request, env, user);

async function findDuplicate(env, v, exceptId = '') {
  return env.DB.prepare(`SELECT id, business_name FROM outreach WHERE id != ?
    AND ((? != '' AND email = ?) OR (lower(business_name) = lower(?) AND lower(coalesce(town, '')) = lower(?))) LIMIT 1`)
    .bind(exceptId, v.email, v.email, v.business_name, v.town).first();
}

export async function postNewItem(request, env, user, form) {
  const { v, errors } = readForm(form);
  if (!errors.length) {
    const dup = await findDuplicate(env, v);
    if (dup) errors.push({ field: 'business_name', msg: `${dup.business_name} is already on the list` });
  }
  if (errors.length) return itemForm(request, env, user, { values: v, errors });
  const id = randomId();
  const t = now();
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO outreach (id, business_name, contact_name, kind, company_number, email, phone, website, address, town, county, products, source, assigned_to, created_by, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, (SELECT id FROM users WHERE id = ?), ?, ?, ?)`)
      .bind(id, v.business_name, v.contact_name || null, v.kind, v.company_number || null, v.email || null, v.phone || null, v.website || null, v.address || null, v.town || null, v.county || null, v.products || null, v.source || null, v.assigned_to, user.id, t, t),
    addNote(env, id, user.id, 'Added'),
  ]);
  await audit(env, user.id, 'outreach.added', id, { business: v.business_name });
  return redirect(request, `/admin/outreach/${id}`);
}

export async function getEditItem(request, env, user, id) {
  const item = await getItem(env, id);
  return item ? itemForm(request, env, user, { item }) : null;
}

export async function postEditItem(request, env, user, id, form) {
  const item = await getItem(env, id);
  if (!item) return null;
  const { v, errors } = readForm(form);
  if (!errors.length) {
    const dup = await findDuplicate(env, v, id);
    if (dup) errors.push({ field: 'business_name', msg: `${dup.business_name} is already on the list` });
  }
  if (errors.length) return itemForm(request, env, user, { item, values: v, errors });
  await env.DB.prepare(`UPDATE outreach SET business_name = ?, contact_name = ?, kind = ?, company_number = ?, email = ?, phone = ?, website = ?, address = ?, town = ?, county = ?, products = ?, source = ?,
      assigned_to = (SELECT id FROM users WHERE id = ?), updated_at = ? WHERE id = ?`)
    .bind(v.business_name, v.contact_name || null, v.kind, v.company_number || null, v.email || null, v.phone || null, v.website || null, v.address || null, v.town || null, v.county || null, v.products || null, v.source || null, v.assigned_to, now(), id).run();
  await audit(env, user.id, 'outreach.edited', id);
  return redirect(request, `/admin/outreach/${id}`);
}

// ---------- one record ----------
export async function outreachItem(request, env, user, id, { errors = [], note = '' } = {}) {
  const o = await getItem(env, id);
  if (!o) return null;
  const today = todayUK();
  const notes = await env.DB.prepare('SELECT n.*, u.display_name, u.email FROM outreach_notes n LEFT JOIN users u ON u.id = n.by_user WHERE n.outreach_id = ? ORDER BY n.id DESC LIMIT 100').bind(id).all().then((r) => r.results);
  const open = o.stage === 'todo' || o.stage === 'contacted';
  const which = o.contact_count === 0 ? 'first' : o.contact_count === 1 ? 'follow_up' : null;
  const nextPanel = () => {
    if (o.stage === 'not_interested') return html`<section class="panel" id="next"><h2>Don't contact</h2><p>They asked not to be contacted. We keep the business name and email only so they're never contacted again.</p></section>`;
    if (!open || !which) return '';
    const heading = which === 'first' ? 'First contact' : isDue(o, today) ? 'Follow-up' : `Follow-up (due ${niceDate(o.follow_up_on)})`;
    const markForm = html`<form method="post" action="/admin/outreach/${o.id}/contacted" class="markform">
      <label for="method">How did you get in touch?</label>
      <select id="method" name="method">${Object.entries(METHODS).filter(([k]) => k !== 'email' || canEmail(o)).map(([k, label]) => html`<option value="${k}" ${(canEmail(o) ? k === 'email' : k === 'letter') ? raw('selected') : ''}>${label}</option>`)}</select>
      <button class="btn btn-ghost" type="submit">Mark ${which === 'first' ? 'first contact' : 'follow-up'} as done</button>
    </form>`;
    let tool;
    if (canEmail(o)) {
      const e = emailFor(o, which, { user, request, env });
      tool = html`<p class="pecr">✓ ${KINDS[o.kind]}${o.company_number ? ` (Companies House ${o.company_number})` : ''}, so a business email is allowed.${which === 'follow_up' ? ' This is the one follow-up. After it, the email tools go away.' : ''}</p>
        <p><b>To:</b> ${o.email}<br /><b>Subject:</b> ${e.subject}</p>
        <label for="emailtext" class="sr-only">Email text</label>
        <textarea id="emailtext" class="emailbox" rows="22" readonly>${e.body}</textarea>
        <div class="btns"><button type="button" class="btn btn-green" data-copy="emailtext">Copy email text</button><a class="btn btn-ghost" href="${mailto(o, e)}">Open in email</a><span data-copied hidden role="status">Copied</span></div>
        <p class="hint">Paste into Zoho Mail and send from hello@. Then mark it as done below, so the follow-up date is set.</p>`;
    } else {
      const why = o.kind === 'unknown'
        ? 'Check Companies House first. If they are a Ltd company or LLP, set the business type and add their email to send an email.'
        : o.kind === 'ltd' || o.kind === 'llp' ? 'Add their email address to send an email.' : `${KINDS[o.kind]}s can't be emailed without asking first. Send a letter, visit their stall or call.`;
      tool = html`<p class="pecr pecr-no">${why}</p>
        ${o.address ? html`<div class="btns"><a class="btn btn-green" href="/admin/outreach/${o.id}/letter">Print ${which === 'first' ? 'letter' : 'follow-up letter'}</a></div>` : html`<p>Add a postal address to print a letter.</p>`}`;
    }
    return html`<section class="panel" id="next" aria-labelledby="next-h"><h2 id="next-h">${heading}</h2>${tool}${markForm}</section>`;
  };
  const stageBtn = (to, label, cls = 'btn-ghost') => html`<form method="post" action="/admin/outreach/${o.id}/stage" class="inline"><input type="hidden" name="stage" value="${to}" /><button class="btn ${cls} btn-sm" type="submit">${label}</button></form>`;
  const where = [o.town, o.county].filter(Boolean).join(', ');
  return adminPage(env, user, {
    title: o.business_name,
    section: 'outreach',
    status: errors.length ? 400 : 200,
    back: ['/admin/outreach', 'Outreach'],
    head: raw('<script src="/copy.js" defer></script>'),
    body: html`<h1>${o.business_name} ${stageTag(o, today)}</h1>
      <p class="sub">${[where, o.products].filter(Boolean).join(' · ') || 'No location yet'}</p>
      ${o.producer_id ? html`<p class="callout">They've joined. <a href="/admin/producers/${o.producer_id}">See their listing</a>.</p>` : ''}
      <div class="two">
        <div>
          ${nextPanel()}
          <section class="panel" aria-labelledby="stage-h"><h2 id="stage-h">Stage</h2>
            <p>Now: <b>${STAGES[o.stage]}</b>${o.contact_count ? ` · ${o.contact_count === 1 ? 'first contact done' : 'follow-up done'}` : ''}${o.last_contact_on ? ` · last contact ${niceDate(o.last_contact_on)}` : ''}</p>
            <div class="btns">
              ${o.stage !== 'replied' && o.stage !== 'not_interested' ? stageBtn('replied', 'They replied') : ''}
              ${o.stage !== 'joined' && o.stage !== 'not_interested' ? stageBtn('joined', 'They joined') : ''}
              ${o.stage !== 'todo' && o.stage !== 'not_interested' ? stageBtn('todo', 'Back to "to contact"') : ''}
            </div>
            ${o.stage !== 'not_interested' ? html`<details class="danger"><summary>Not interested, don't contact again</summary>
              <form method="post" action="/admin/outreach/${o.id}/stage"><input type="hidden" name="stage" value="not_interested" />
                <p>This removes their contact name, phone, address and notes. We keep the business name, email and website so they're never contacted again.</p>
                <button class="btn btn-red btn-sm" type="submit">Mark as not interested</button></form></details>` : ''}
          </section>
        </div>
        <div>
          <section class="panel" aria-labelledby="det-h"><div class="panelhead"><h2 id="det-h">Details</h2><a class="btn btn-ghost btn-sm" href="/admin/outreach/${o.id}/edit">Edit<span class="sr-only"> details</span></a></div>
            <dl class="details">
              <dt>Type</dt><dd>${KINDS[o.kind]}${o.company_number ? html` · <a href="https://find-and-update.company-information.service.gov.uk/company/${o.company_number}" rel="noopener noreferrer">${o.company_number}</a>` : ''}</dd>
              <dt>Contact</dt><dd>${o.contact_name || '–'}</dd>
              <dt>Email</dt><dd>${o.email || '–'}</dd>
              <dt>Phone</dt><dd>${o.phone || '–'}</dd>
              <dt>Website</dt><dd>${o.website ? html`<a href="${o.website}" rel="noopener noreferrer">${o.website.replace(/^https?:\/\/(www\.)?/, '').replace(/\/$/, '')}</a>` : '–'}</dd>
              <dt>Address</dt><dd class="pre">${o.address || '–'}</dd>
              <dt>Found</dt><dd>${o.source || '–'}</dd>
              <dt>Handled by</dt><dd>${o.assigned_name || o.assigned_email || 'Anyone'}</dd>
            </dl>
          </section>
          <section class="panel" aria-labelledby="tl-h"><h2 id="tl-h">Timeline</h2>
            <form method="post" action="/admin/outreach/${o.id}/note" novalidate>
              ${field({ id: 'note', label: 'Add a note', value: note, required: false, rows: 2, max: 1000, error: errors.find((e) => e.field === 'note')?.msg })}
              <button class="btn btn-green btn-sm" type="submit">Add note</button>
            </form>
            <ul class="timeline">${notes.map((n) => html`<li><span class="when">${fmtTime(n.created_at)} · ${n.display_name || n.email || 'Import'}</span><span class="pre">${n.body}</span></li>`)}</ul>
          </section>
          <details class="danger"><summary>Delete this record</summary>
            <form method="post" action="/admin/outreach/${o.id}/delete"><p>Use this if they ask us to delete their details, or it was added by mistake. It can't be undone.</p>
              <button class="btn btn-red btn-sm" type="submit">Delete ${o.business_name}</button></form></details>
        </div>
      </div>`,
  });
}

export async function postContacted(request, env, user, id, form) {
  const o = await getItem(env, id);
  if (!o) return null;
  const method = METHODS[form.get('method')] ? String(form.get('method')) : 'letter';
  if (method === 'email' && !canEmail(o)) return redirect(request, `/admin/outreach/${id}`);
  if (!(o.stage === 'todo' || o.stage === 'contacted') || o.contact_count >= 2) return redirect(request, `/admin/outreach/${id}`);
  const today = todayUK();
  const count = o.contact_count + 1;
  const follow = count === 1 ? addDays(today, method === 'email' ? FOLLOW_UP_DAYS.email : FOLLOW_UP_DAYS.other) : addDays(today, NO_REPLY_DAYS);
  const what = { email: 'email sent', letter: 'letter sent', visit: 'visit or market chat', phone: 'phone call', facebook: 'Facebook message sent' }[method];
  await env.DB.batch([
    env.DB.prepare("UPDATE outreach SET stage = 'contacted', contact_count = ?, last_contact_on = ?, follow_up_on = ?, updated_at = ? WHERE id = ?").bind(count, today, follow, now(), id),
    addNote(env, id, user.id, `${count === 1 ? 'First contact' : 'Follow-up'}: ${what}`),
  ]);
  await audit(env, user.id, 'outreach.contacted', id, { method, count });
  return redirect(request, `/admin/outreach/${id}`);
}

export async function postStage(request, env, user, id, form) {
  const o = await getItem(env, id);
  if (!o) return null;
  const to = String(form.get('stage') || '');
  if (!['todo', 'replied', 'joined', 'not_interested'].includes(to) || o.stage === 'not_interested') return redirect(request, `/admin/outreach/${id}`);
  const t = now();
  if (to === 'not_interested') {
    await env.DB.batch([
      env.DB.prepare('DELETE FROM outreach_notes WHERE outreach_id = ?').bind(id),
      env.DB.prepare("UPDATE outreach SET stage = 'not_interested', contact_name = NULL, phone = NULL, address = NULL, products = NULL, source = NULL, follow_up_on = NULL, assigned_to = NULL, updated_at = ? WHERE id = ?").bind(t, id),
      addNote(env, id, user.id, "Not interested. Asked not to be contacted, so their personal details were removed."),
    ]);
  } else {
    await env.DB.batch([
      env.DB.prepare(`UPDATE outreach SET stage = ?, ${to === 'todo' ? 'contact_count = 0, follow_up_on = NULL,' : 'follow_up_on = NULL,'} updated_at = ? WHERE id = ?`).bind(to, t, id),
      addNote(env, id, user.id, `Stage: ${STAGES[to]}`),
    ]);
  }
  await audit(env, user.id, 'outreach.stage', id, { to });
  return redirect(request, `/admin/outreach/${id}`);
}

export async function postNote(request, env, user, id, form) {
  const o = await getItem(env, id);
  if (!o) return null;
  const body = clean(form.get('note'), 1000).replace(/\r/g, '');
  if (!body) return outreachItem(request, env, user, id, { errors: [{ field: 'note', msg: 'Type a note first' }] });
  await env.DB.batch([addNote(env, id, user.id, body), touch(env, id)]);
  return redirect(request, `/admin/outreach/${id}#tl-h`);
}

export async function postDelete(request, env, user, id) {
  const o = await getItem(env, id);
  if (!o) return null;
  await env.DB.prepare('DELETE FROM outreach WHERE id = ?').bind(id).run();
  await audit(env, user.id, 'outreach.deleted', id, { business: o.business_name });
  return redirect(request, '/admin/outreach?tab=all');
}

// ---------- letter (printable A4) ----------
export async function letter(request, env, user, id) {
  const o = await getItem(env, id);
  if (!o || !o.address) return null;
  const follow = o.contact_count === 1;
  const join = `${appUrl(request, env)}/producer/join`;
  const from = user.display_name || 'The Roots & Pantry team';
  const doc = html`<!doctype html>
<html lang="en-GB"><head><meta charset="utf-8" /><meta name="viewport" content="width=device-width, initial-scale=1" /><meta name="robots" content="noindex" />
<title>Letter to ${o.business_name} | Roots &amp; Pantry</title><link rel="stylesheet" href="/app.css" /><link rel="stylesheet" href="/print.css" /><link rel="stylesheet" href="/page-a4.css" /></head>
<body class="print-page letterpage">
  <div class="print-tools"><a href="/admin/outreach/${o.id}">← Back to ${o.business_name}</a> <button type="button" class="btn btn-red" data-print>Print or save as PDF</button></div>
  <main class="sheet letter">
    <header class="lt-head">
      <div class="sh-brand"><span class="sh-mark" aria-hidden="true">R&amp;P</span><span>Roots <span class="sh-amp">&amp;</span> Pantry</span></div>
      <p class="lt-from">${POSTAL.map((l) => html`${l}<br />`)}hello@rootsandpantry.co.uk</p>
    </header>
    <p class="lt-to">${o.contact_name ? html`${o.contact_name}<br />` : ''}${o.business_name}<br />${o.address.split('\n').map((l, i) => html`${i ? raw('<br />') : ''}${l}`)}</p>
    <p class="lt-date">${niceDate(todayUK())}</p>
    <p>Dear ${firstName(o.contact_name) || o.business_name},</p>
    ${follow
      ? html`<p>I wrote to you on ${niceDate(o.last_contact_on)} about Roots &amp; Pantry, a free website that helps local families find independent food producers like ${o.business_name}. I'm following up once in case my letter got buried.</p>`
      : html`<p>${intro(user)} a new free website that helps families${o.county ? ` in ${o.county}` : ''} find and buy from independent local food producers like ${o.business_name}.</p>`}
    <p>Being listed is free. Families find you by postcode, and you can set your own exclusive deals for them (at least 10% off, or a free item), so new customers come to you.${productLine(o)}</p>
    <div class="lt-join">
      <div class="sh-qr">${qrSvg(join, { size: 130, label: 'QR code for joining Roots & Pantry' })}</div>
      <p>Joining takes about 5 minutes. Scan the code, or go to<br /><b>${join.replace(/^https:\/\//, '')}</b></p>
    </div>
    <p>If you have any questions, email me at hello@rootsandpantry.co.uk. If it's not for you, there's no need to reply${follow ? ', and I won\'t write again' : ''}.</p>
    <p>Best wishes,</p>
    <p class="lt-sign">${from}<br />Roots &amp; Pantry</p>
    <footer class="lt-foot">${COMPANY} Registered office: ${POSTAL.slice(1).join(', ')}.</footer>
  </main>
  <script src="/print.js" defer></script>
</body></html>`;
  return new Response(doc.toString(), { headers: securityHeaders({ 'Content-Type': 'text/html; charset=utf-8' }) });
}

// ---------- CSV import ----------
// Small RFC 4180 parser: quoted fields, doubled quotes, commas and newlines inside quotes.
export function parseCsv(text) {
  const rows = [];
  let row = [];
  let f = '';
  let q = false;
  const s = String(text).replace(/^﻿/, '');
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) {
      if (c === '"' && s[i + 1] === '"') { f += '"'; i++; } else if (c === '"') q = false; else f += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(f); f = ''; }
    else if (c === '\n' || c === '\r') { if (c === '\r' && s[i + 1] === '\n') i++; row.push(f); rows.push(row); row = []; f = ''; }
    else f += c;
  }
  if (f !== '' || row.length) { row.push(f); rows.push(row); }
  return rows.filter((r) => r.some((x) => x.trim() !== ''));
}

const COLUMNS = {
  business_name: ['business name', 'business', 'name', 'business_name', 'company', 'company name'],
  contact_name: ['contact name', 'contact', 'contact_name', 'owner'],
  kind: ['business type', 'type', 'kind'],
  company_number: ['company number', 'company_number', 'companies house', 'companies house number', 'crn'],
  email: ['email', 'email address', 'e-mail'],
  phone: ['phone', 'telephone', 'phone number', 'tel'],
  website: ['website', 'web', 'url', 'facebook', 'website or facebook'],
  address: ['address', 'postal address'],
  town: ['town', 'city', 'village'],
  county: ['county'],
  products: ['products', 'what they make', 'makes', 'product'],
  source: ['source', 'found at', 'found', 'where found'],
  notes: ['notes', 'note', 'comments'],
};
const kindFrom = (s) => { const t = String(s || '').toLowerCase(); return /llp/.test(t) ? 'llp' : /\b(ltd|limited|plc)\b/.test(t) ? 'ltd' : /sole/.test(t) ? 'sole' : /partner/.test(t) ? 'partnership' : 'unknown'; };
export const CSV_TEMPLATE = 'Business name,Contact name,Business type,Company number,Email,Phone,Website,Address,Town,County,Products,Found at,Notes\r\nCorvedale Creamery,Sarah,Ltd,09876543,hello@corvedalecreamery.example,,https://corvedalecreamery.example,"Unit 2, Station Road\nCraven Arms\nSY7 9AA",Craven Arms,Shropshire,Wenlock Edge cheddar,Ludlow Food Festival,Interested when we spoke\r\n';

export const csvTemplate = () => new Response(CSV_TEMPLATE, { headers: securityHeaders({ 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="outreach-template.csv"' }) });

function importPage(env, user, { result = null, errors = [] } = {}) {
  return adminPage(env, user, {
    title: 'Import producers',
    section: 'outreach',
    status: errors.length ? 400 : 200,
    back: ['/admin/outreach', 'Outreach'],
    body: html`<h1>Import producers</h1>
      ${result ? html`<div class="flash" role="status"><p><b>Added ${result.added} ${result.added === 1 ? 'producer' : 'producers'}.</b>${result.skipped.length ? ` Skipped ${result.skipped.length}:` : ''}</p>
        ${result.skipped.length ? html`<ul>${result.skipped.slice(0, 50).map((s) => html`<li>Row ${s.row}: ${s.why}</li>`)}</ul>` : ''}
        <p><a href="/admin/outreach?tab=todo">See the "to contact" list</a></p></div>` : ''}
      ${errorList(errors)}
      <p class="sub">Upload a CSV file (save as CSV from Excel or Google Sheets). The first row must be the column names. Only "Business name" is required. Up to ${MAX_IMPORT_ROWS} rows at a time, and producers already on the list are skipped.</p>
      <p><a href="/admin/outreach/template.csv" download>Download the template</a> to see the columns.</p>
      <form method="post" action="/admin/outreach/import" enctype="multipart/form-data" class="panel" novalidate>
        <div class="field${errors.length ? ' has-error' : ''}"><label for="file">CSV file</label>
          ${errors.length ? html`<p class="error" id="file-err">${errors[0].msg}</p>` : ''}
          <input type="file" id="file" name="file" accept=".csv,text/csv" ${errors.length ? raw('aria-invalid="true" aria-describedby="file-err"') : ''} /></div>
        <button class="btn btn-green" type="submit">Import</button>
      </form>`,
  });
}

export const getImport = (request, env, user) => importPage(env, user);

export async function postImport(request, env, user, form) {
  const file = form.get('file');
  const bad = (msg) => importPage(env, user, { errors: [{ field: 'file', msg }] });
  if (!file || typeof file === 'string' || !file.size) return bad('Choose a CSV file');
  const rows = parseCsv(await file.text());
  if (rows.length < 2) return bad("That file has no rows under the column names");
  const head = rows[0].map((h) => h.trim().toLowerCase());
  const col = Object.fromEntries(Object.entries(COLUMNS).map(([k, names]) => [k, head.findIndex((h) => names.includes(h))]));
  if (col.business_name < 0) return bad('Add a "Business name" column');
  if (rows.length - 1 > MAX_IMPORT_ROWS) return bad(`That's ${rows.length - 1} rows. Import up to ${MAX_IMPORT_ROWS} at a time.`);
  const existing = await env.DB.prepare("SELECT lower(coalesce(email, '')) AS e, lower(business_name) || '|' || lower(coalesce(town, '')) AS k FROM outreach").all().then((r) => r.results);
  const seenE = new Set(existing.map((x) => x.e).filter(Boolean));
  const seenK = new Set(existing.map((x) => x.k));
  const skipped = [];
  const stmts = [];
  const t = now();
  let added = 0;
  rows.slice(1).forEach((r, i) => {
    const get = (k) => (col[k] >= 0 ? r[col[k]] ?? '' : '');
    const fd = new Map(Object.keys(COLUMNS).map((k) => [k, get(k)]));
    fd.set('kind', kindFrom(get('kind')));
    if (!COUNTIES.includes(fd.get('county'))) fd.set('county', COUNTIES.find((c) => c.toLowerCase() === String(fd.get('county')).trim().toLowerCase()) || '');
    const { v, errors } = readForm({ get: (k) => fd.get(k) ?? '' });
    const rowNo = i + 2;
    if (errors.length) { skipped.push({ row: rowNo, why: errors.map((e) => e.msg).join('; ') }); return; }
    const k = `${v.business_name.toLowerCase()}|${v.town.toLowerCase()}`;
    if ((v.email && seenE.has(v.email)) || seenK.has(k)) { skipped.push({ row: rowNo, why: `${v.business_name} is already on the list` }); return; }
    if (v.email) seenE.add(v.email);
    seenK.add(k);
    const id = randomId();
    stmts.push(env.DB.prepare(`INSERT INTO outreach (id, business_name, contact_name, kind, company_number, email, phone, website, address, town, county, products, source, created_by, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(id, v.business_name, v.contact_name || null, v.kind, v.company_number || null, v.email || null, v.phone || null, v.website || null, v.address || null, v.town || null, v.county || null, v.products || null, v.source || null, user.id, t, t));
    const note = clean(get('notes'), 1000);
    stmts.push(addNote(env, id, user.id, note ? `Imported from CSV. ${note}` : 'Imported from CSV'));
    added++;
  });
  // D1 batches run in one round trip each; keep them modest.
  for (let i = 0; i < stmts.length; i += 100) await env.DB.batch(stmts.slice(i, i + 100));
  await audit(env, user.id, 'outreach.imported', null, { added, skipped: skipped.length });
  return importPage(env, user, { result: { added, skipped } });
}

// ---------- hooks ----------
// When a producer signs up, tick off the matching outreach record (same email, website or name).
export async function markJoined(env, { producerId, email, website, businessName }) {
  const host = hostOf(website);
  const mail = normEmail(email);
  const rows = await env.DB.prepare(`SELECT id, email, business_name, website FROM outreach WHERE stage NOT IN ('joined', 'not_interested')
    AND (email = ? OR lower(business_name) = lower(?) ${host ? 'OR website LIKE ?' : ''}) LIMIT 10`)
    .bind(...[mail, businessName, ...(host ? [`%${host}%`] : [])]).all().then((r) => r.results);
  const hits = rows.filter((r) => r.email === mail || r.business_name.toLowerCase() === businessName.toLowerCase() || (host && hostOf(r.website) === host));
  for (const r of hits) {
    await env.DB.batch([
      env.DB.prepare("UPDATE outreach SET stage = 'joined', producer_id = ?, follow_up_on = NULL, updated_at = ? WHERE id = ?").bind(producerId, now(), r.id),
      addNote(env, r.id, null, 'Joined Roots & Pantry (matched automatically when they signed up)'),
    ]);
  }
  return hits.length;
}

// Daily: mark records "no reply" once the follow-up wait is over, and email the team when follow-ups fall due today.
export async function outreachDaily(env, today = todayUK()) {
  await env.DB.prepare("UPDATE outreach SET stage = 'no_reply', follow_up_on = NULL, updated_at = ? WHERE stage = 'contacted' AND contact_count >= 2 AND follow_up_on < ?").bind(now(), today).run();
  const due = await env.DB.prepare("SELECT business_name FROM outreach WHERE stage = 'contacted' AND contact_count = 1 AND follow_up_on = ? ORDER BY business_name LIMIT 50").bind(today).all().then((r) => r.results);
  if (!due.length) return 0;
  await sendEmail(env, {
    to: env.NOTIFY_EMAIL,
    subject: `Roots & Pantry: ${due.length} producer ${due.length === 1 ? 'follow-up' : 'follow-ups'} due today`,
    text: `Follow-ups due today:\n\n${due.map((d) => `- ${d.business_name}`).join('\n')}\n\nOpen the list: ${env.APP_URL}/admin/outreach?tab=due\n\nRoots & Pantry`,
  });
  return due.length;
}
