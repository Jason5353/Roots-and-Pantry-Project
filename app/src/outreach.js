// Producer outreach: a small CRM in the admin area for finding and inviting producers.
// PECR: only Ltd companies and LLPs can be emailed without asking first. Sole traders and
// partnerships get a letter, a visit or a call instead, so the email tools only appear for Ltd/LLP.
import { html, raw, now, randomId, clean, normEmail, validEmail, validUrl, normPostcode, sha256 } from './util.js';
import { page, errorList, field, securityHeaders, turnstileWidget } from './layout.js';
import { sendEmail, audit, verifyTurnstile, rateLimit } from './services.js';
import { adminPage } from './admin.js';
import { todayUK, niceDate, qrSvg } from './producer.js';
import { COUNTIES } from './data.js';
import { COMPANY, emailHtml } from './emailtext.js';

export { emailHtml };

export const KINDS = { ltd: 'Ltd company', llp: 'LLP', sole: 'Sole trader', partnership: 'Partnership', unknown: 'Not checked yet' };
const KIND_SHORT = { ltd: 'Ltd', llp: 'LLP', sole: 'Sole trader', partnership: 'Partnership', unknown: 'Type not checked' };
export const STAGES = { todo: 'To contact', contacted: 'Contacted', replied: 'Replied', joined: 'Joined', no_reply: 'No reply', not_interested: 'Not interested' };
const METHODS = { email: 'Email', letter: 'Letter', visit: 'Visit or market chat', phone: 'Phone call', facebook: 'Facebook message' };
const MAX_IMPORT_ROWS = 500;
const FOLLOW_UP_DAYS = { email: 7, other: 14 };
const NO_REPLY_DAYS = 14; // after the follow-up, wait this long before marking "No reply"
const FOOTER_GAP = '\n\n\n\n\n'; // 4 blank lines before the company line
const POSTAL = ['Roots & Pantry', '254 Holyhead Road', 'Wellington', 'Telford', 'TF1 2EB'];

// Ltd companies and LLPs can be emailed without asking first. Anyone else only once they've said yes
// (recorded in consent_*), for example on the "tell me more" form.
const corporate = (o) => o.kind === 'ltd' || o.kind === 'llp';
// Permission counts only if it was given after any withdrawal. Nothing is wiped: the history stays in outreach_consent_log.
const live = (at, o) => !!at && (!o.consent_withdrawn_at || at > o.consent_withdrawn_at);
const emailOk = (o) => live(o.consent_email_at, o);
const facebookOk = (o) => live(o.consent_facebook_at, o);
export const canEmail = (o) => o.stage !== 'not_interested' && (corporate(o) || emailOk(o)) && !!o.email;
// Social media direct messages count as electronic mail under PECR, so the same rule applies.
const canMessage = (o) => o.stage !== 'not_interested' && (corporate(o) || facebookOk(o));
const logConsent = (env, id, event, channel, detail, userId) => env.DB.prepare('INSERT INTO outreach_consent_log (outreach_id, event, channel, detail, by_user, created_at) VALUES (?, ?, ?, ?, ?, ?)')
  .bind(id, event, channel, detail, userId, now());
const CONSENT_EVENT = { given: 'Permission given', withdrawn: 'Permission withdrawn', reopened: 'Reopened' };
const consentDate = (ts) => new Date(ts * 1000).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Europe/London' });
const okLine = (o, channel) => {
  const at = channel === 'email' ? o.consent_email_at : o.consent_facebook_at;
  if (!corporate(o) && live(at, o)) return `✓ They asked us to ${channel === 'email' ? 'email' : 'message'} them on ${consentDate(at)} (${o.consent_how || 'recorded'}).`;
  return `✓ ${KINDS[o.kind]}${o.company_number ? ` (Companies House ${o.company_number})` : ''}, so a business ${channel === 'email' ? 'email' : 'message'} is allowed.${channel === 'facebook' ? ' Facebook messages follow the same rule as email.' : ''}`;
};
const methodAllowed = (o, m) => (m === 'email' ? canEmail(o) : m === 'facebook' ? canMessage(o) : true);
const isDue = (o, today) => o.stage === 'contacted' && o.contact_count === 1 && o.follow_up_on && o.follow_up_on <= today;
const addDays = (ymd, n) => new Date(Date.parse(`${ymd}T12:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
const shortDate = (ymd) => new Date(`${ymd}T12:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' });
const fmtTime = (ts) => new Date(ts * 1000).toLocaleString('en-GB', { timeZone: 'Europe/London', day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
const redirect = (request, to) => Response.redirect(new URL(to, request.url), 303);
const shortLink = (u) => u.replace(/^https?:\/\/(www\.)?/, '').replace(/\/$/, '');
const firstName = (n) => (n || '').trim().split(/\s+/)[0] || '';
const hostOf = (u) => { try { return new URL(u).hostname.replace(/^www\./, '').toLowerCase(); } catch { return ''; } };
const appUrl = (request, env) => env.APP_URL || new URL(request.url).origin;

// Columns written from the add/edit form and the CSV import.
const FIELDS = ['business_name', 'contact_name', 'kind', 'company_number', 'email', 'phone', 'website', 'facebook', 'instagram', 'address', 'postcode', 'town', 'county', 'products', 'source'];
const fieldValues = (v) => FIELDS.map((f) => (f === 'business_name' || f === 'kind' ? v[f] : v[f] || null));
const insertItem = (env, id, v, userId, t) => env.DB.prepare(`INSERT INTO outreach (id, ${FIELDS.join(', ')}, assigned_to, created_by, created_at, updated_at)
  VALUES (?, ${FIELDS.map(() => '?').join(', ')}, (SELECT id FROM users WHERE id = ?), ?, ?, ?)`).bind(id, ...fieldValues(v), v.assigned_to || '', userId, t, t);

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

${signOff(user)}${FOOTER_GAP}${COMPANY}`,
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

${signOff(user)}${FOOTER_GAP}${COMPANY}`,
  };
}

// Shorter text for a Facebook message, sent by hand from the Roots & Pantry page (Ltd/LLP only).
export function facebookFor(o, which, { user, request, env }) {
  const hi = `Hi ${firstName(o.contact_name) || 'there'},`;
  const join = `${appUrl(request, env)}/producer/join`;
  if (which === 'follow_up') {
    return `${hi} just a quick follow-up to my message${o.last_contact_on ? ` of ${niceDate(o.last_contact_on)}` : ''} about a free listing for ${o.business_name} on Roots & Pantry. Families find you by postcode and you can set your own exclusive deals for them. Joining takes about 5 minutes: ${join}\n\nThis is the only follow-up I'll send. If it's not for you, just reply "no thanks".`;
  }
  return `${hi} ${intro(user)} a new free website that helps families${o.county ? ` in ${o.county}` : ''} find independent local food producers like ${o.business_name}.\n\nBeing listed is free. Families find you by postcode, and you can set your own exclusive deals for them.${productLine(o)}\n\nJoining takes about 5 minutes: ${join}\n\nIf it's not for you, just reply "no thanks" and I won't message again.`;
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
      if (canMessage(o) && o.facebook) return html`<a class="btn btn-ghost btn-sm" href="/admin/outreach/${o.id}#next">${follow ? 'Follow-up message' : 'Facebook message'}<span class="sr-only"> for ${o.business_name}</span></a>`;
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
    facebook: clean(form.get('facebook'), 300),
    instagram: clean(form.get('instagram'), 300),
    postcode: clean(form.get('postcode'), 10),
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
  if (v.facebook && !/^https?:\/\//i.test(v.facebook)) v.facebook = `https://${v.facebook}`;
  if (v.facebook && !(validUrl(v.facebook) && /(^|\.)(facebook\.com|fb\.com)$/.test(hostOf(v.facebook)))) errors.push({ field: 'facebook', msg: 'Enter a Facebook link like https://www.facebook.com/theirpage' });
  if (/^@?[A-Za-z0-9._]{1,30}$/.test(v.instagram)) v.instagram = `https://www.instagram.com/${v.instagram.replace(/^@/, '')}/`;
  else if (v.instagram && !/^https?:\/\//i.test(v.instagram)) v.instagram = `https://${v.instagram}`;
  if (v.instagram && !(validUrl(v.instagram) && hostOf(v.instagram) === 'instagram.com')) errors.push({ field: 'instagram', msg: 'Enter an Instagram name like @theirname, or a link' });
  if (v.postcode) {
    const pc = normPostcode(v.postcode);
    if (pc) v.postcode = pc; else errors.push({ field: 'postcode', msg: 'Enter a full UK postcode, like SY7 9AA' });
  }
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
        ${field({ id: 'website', label: 'Website', type: 'url', value: v.website, required: false, max: 300, error: err('website') })}
        ${field({ id: 'facebook', label: 'Facebook page', type: 'url', value: v.facebook, required: false, max: 300, hint: 'The full link, like https://www.facebook.com/theirpage', error: err('facebook') })}
        ${field({ id: 'instagram', label: 'Instagram', value: v.instagram, required: false, max: 300, hint: 'Their @name or a link.', error: err('instagram') })}
        ${field({ id: 'address', label: 'Postal address', value: v.address, required: false, max: 300, rows: 3, hint: 'For letters. One line per part of the address, without the postcode.' })}
        ${field({ id: 'postcode', label: 'Postcode', value: v.postcode, required: false, max: 10, autocomplete: 'off', error: err('postcode') })}
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
    insertItem(env, id, v, user.id, t),
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
  await env.DB.prepare(`UPDATE outreach SET ${FIELDS.map((f) => `${f} = ?`).join(', ')}, assigned_to = (SELECT id FROM users WHERE id = ?), updated_at = ? WHERE id = ?`)
    .bind(...fieldValues(v), v.assigned_to || '', now(), id).run();
  await audit(env, user.id, 'outreach.edited', id);
  return redirect(request, `/admin/outreach/${id}`);
}

// ---------- one record ----------
export async function outreachItem(request, env, user, id, { errors = [], note = '' } = {}) {
  const o = await getItem(env, id);
  if (!o) return null;
  const today = todayUK();
  const history = await env.DB.prepare('SELECT c.*, u.display_name, u.email FROM outreach_consent_log c LEFT JOIN users u ON u.id = c.by_user WHERE c.outreach_id = ? ORDER BY c.id DESC').bind(id).all().then((r) => r.results);
  const notes = await env.DB.prepare('SELECT n.*, u.display_name, u.email FROM outreach_notes n LEFT JOIN users u ON u.id = n.by_user WHERE n.outreach_id = ? ORDER BY n.id DESC LIMIT 100').bind(id).all().then((r) => r.results);
  const open = o.stage === 'todo' || o.stage === 'contacted';
  const errFor = (f) => errors.find((e) => e.field === f)?.msg;
  const howInput = (fid) => html`${errFor(fid) ? html`<p class="error" id="${fid}-err">${errFor(fid)}</p>` : ''}<input id="${fid}" name="how" type="text" maxlength="200" required ${errFor(fid) ? raw(`aria-invalid="true" aria-describedby="${fid}-err"`) : ''} />`;
  const which = o.contact_count === 0 ? 'first' : o.contact_count === 1 ? 'follow_up' : null;
  const nextPanel = () => {
    if (o.stage === 'not_interested') return html`<section class="panel" id="next"><h2>Don't contact</h2>
      <p>They said they're not interested${o.consent_withdrawn_at ? ` on ${consentDate(o.consent_withdrawn_at)}` : ''}. Don't email, message or write to them. Their permission history is kept below.</p>
      <details class="alt" ${errFor('reopen-how') ? raw('open') : ''}><summary>They got back in touch</summary>
        <form method="post" action="/admin/outreach/${o.id}/stage"><input type="hidden" name="stage" value="todo" />
          <label for="reopen-how">How did they get in touch?</label>
          ${howInput('reopen-how')}
          <p class="hint">For example, "emailed hello@ on 3 March asking to join". Reopening doesn't give permission to email a sole trader again: they need to say yes again, for example on the website form.</p>
          <button class="btn btn-ghost btn-sm" type="submit">Reopen</button></form></details></section>`;
    if (!open || !which) return '';
    const heading = which === 'first' ? 'First contact' : isDue(o, today) ? 'Follow-up' : `Follow-up (due ${niceDate(o.follow_up_on)})`;
    const markForm = html`<form method="post" action="/admin/outreach/${o.id}/contacted" class="markform">
      <label for="method">How did you get in touch?</label>
      <select id="method" name="method">${Object.entries(METHODS).filter(([k]) => methodAllowed(o, k)).map(([k, label]) => html`<option value="${k}" ${(canEmail(o) ? k === 'email' : canMessage(o) && o.facebook ? k === 'facebook' : k === 'letter') ? raw('selected') : ''}>${label}</option>`)}</select>
      <button class="btn btn-ghost" type="submit">Mark ${which === 'first' ? 'first contact' : 'follow-up'} as done</button>
    </form>`;
    const fbTool = () => html`<p><b>To:</b> <a href="${o.facebook}" rel="noopener noreferrer">${shortLink(o.facebook)}</a></p>
        <label for="fbtext" class="sr-only">Facebook message text</label>
        <textarea id="fbtext" class="emailbox" rows="14" readonly>${facebookFor(o, which, { user, request, env })}</textarea>
        <div class="btns"><button type="button" class="btn btn-green" data-copy="fbtext">Copy message</button><a class="btn btn-ghost" href="${o.facebook}" rel="noopener noreferrer">Open their Facebook page</a><span data-copied hidden role="status">Copied</span></div>
        <p class="hint">On their page, choose Message. Make sure you're acting as the Roots &amp; Pantry page, not your own profile. Paste, send, then mark it as done below.</p>`;
    let tool;
    if (canEmail(o)) {
      const e = emailFor(o, which, { user, request, env });
      tool = html`<p class="pecr">${okLine(o, 'email')}${which === 'follow_up' ? ' This is the one follow-up. After it, the email tools go away.' : ''}</p>
        <p><b>To:</b> ${o.email}<br /><b>Subject:</b> ${e.subject}</p>
        <label for="emailtext" class="sr-only">Email text</label>
        <textarea id="emailtext" class="emailbox" rows="26" readonly>${e.body}</textarea>
        <template id="emailtext-html">${raw(emailHtml(e.body))}</template>
        <div class="btns"><button type="button" class="btn btn-green" data-copy="emailtext">Copy email text</button><a class="btn btn-ghost" href="${mailto(o, e)}">Open in email</a><span data-copied hidden role="status">Copied</span></div>
        <p class="hint">Paste into Zoho Mail and send from hello@ (the company line pastes in small text). Then mark it as done below, so the follow-up date is set.</p>
        ${o.facebook ? html`<details class="alt"><summary>Or send a Facebook message instead</summary>${fbTool()}</details>` : ''}`;
    } else if (canMessage(o) && o.facebook) {
      tool = html`<p class="pecr">${okLine(o, 'facebook')}${which === 'follow_up' ? ' This is the one follow-up.' : ''}</p>${fbTool()}`;
    } else {
      const why = o.kind === 'unknown'
        ? 'Check Companies House first. If they are a Ltd company or LLP, set the business type and add their email to send an email.'
        : corporate(o) || emailOk(o) ? 'Add their email address or Facebook page to send a message.' : `${KINDS[o.kind]}s can't be emailed or sent a Facebook message without asking first. Send a letter, visit their stall or call. On Facebook, like and share their posts instead, so they come to you.`;
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
      ${errorList(errors.filter((e) => e.field !== 'note'))}
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
            ${o.stage !== 'not_interested' ? html`<details class="danger" ${errFor('no-how') ? raw('open') : ''}><summary>Not interested, don't contact again</summary>
              <form method="post" action="/admin/outreach/${o.id}/stage"><input type="hidden" name="stage" value="not_interested" />
                <label for="no-how">How did they say no?</label>
                ${howInput('no-how')}
                <p class="hint">For example, "replied 'no thanks' to our email". This withdraws any permission and records when and how. We remove their contact name, phone, address and notes, and keep the business name, email, website, social links and permission history so they're never contacted again.</p>
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
              <dt>Website</dt><dd>${o.website ? html`<a href="${o.website}" rel="noopener noreferrer">${shortLink(o.website)}</a>` : '–'}</dd>
              <dt>Facebook</dt><dd>${o.facebook ? html`<a href="${o.facebook}" rel="noopener noreferrer">${shortLink(o.facebook)}</a>` : '–'}</dd>
              <dt>Instagram</dt><dd>${o.instagram ? html`<a href="${o.instagram}" rel="noopener noreferrer">${shortLink(o.instagram)}</a>` : '–'}</dd>
              <dt>Address</dt><dd class="pre">${[o.address, o.postcode].filter(Boolean).join('\n') || '–'}</dd>
              <dt>Found</dt><dd>${o.source || '–'}</dd>
              <dt>Permission</dt><dd>${corporate(o) ? 'Not needed (business email to a company)' : o.stage === 'not_interested' ? 'Withdrawn' : [emailOk(o) && `email (${consentDate(o.consent_email_at)})`, facebookOk(o) && `Facebook (${consentDate(o.consent_facebook_at)})`].filter(Boolean).join(', ') || 'None'}</dd>
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
          ${history.length ? html`<section class="panel" aria-labelledby="ph-h"><h2 id="ph-h">Permission history</h2>
            <p class="hint">Kept as a record, even if they say no.</p>
            <ul class="timeline">${history.map((h) => html`<li><span class="when">${fmtTime(h.created_at)} · ${h.by_user ? h.display_name || h.email : 'They did this on the website'}</span><b>${CONSENT_EVENT[h.event]}</b>${h.channel && h.channel !== 'all' ? ` (${h.channel.replace('+', ' and ')})` : ''}${h.detail ? html`<br /><span class="pre">${h.detail}</span>` : ''}</li>`)}</ul>
          </section>` : ''}
          <details class="danger"><summary>Delete this record</summary>
            <form method="post" action="/admin/outreach/${o.id}/delete"><p>Only use this if they formally ask us to delete their details, or it was added by mistake. It also deletes the permission history, and can't be undone. If they just don't want to hear from us, use "Not interested" instead.</p>
              <button class="btn btn-red btn-sm" type="submit">Delete ${o.business_name}</button></form></details>
        </div>
      </div>`,
  });
}

export async function postContacted(request, env, user, id, form) {
  const o = await getItem(env, id);
  if (!o) return null;
  const method = METHODS[form.get('method')] ? String(form.get('method')) : 'letter';
  if (!methodAllowed(o, method)) return redirect(request, `/admin/outreach/${id}`);
  if (!(o.stage === 'todo' || o.stage === 'contacted') || o.contact_count >= 2) return redirect(request, `/admin/outreach/${id}`);
  const today = todayUK();
  const count = o.contact_count + 1;
  const follow = count === 1 ? addDays(today, method === 'email' || method === 'facebook' ? FOLLOW_UP_DAYS.email : FOLLOW_UP_DAYS.other) : addDays(today, NO_REPLY_DAYS);
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
  if (!['todo', 'replied', 'joined', 'not_interested'].includes(to)) return redirect(request, `/admin/outreach/${id}`);
  if (o.stage === 'not_interested' && to !== 'todo') return redirect(request, `/admin/outreach/${id}`);
  const how = clean(form.get('how'), 200);
  const t = now();
  if ((to === 'not_interested' || o.stage === 'not_interested') && !how) {
    return outreachItem(request, env, user, id, { errors: [{ field: to === 'not_interested' ? 'no-how' : 'reopen-how', msg: 'Say how they told you' }] });
  }
  if (o.stage === 'not_interested') {
    await env.DB.batch([
      env.DB.prepare("UPDATE outreach SET stage = 'todo', contact_count = 0, follow_up_on = NULL, updated_at = ? WHERE id = ?").bind(t, id),
      logConsent(env, id, 'reopened', null, how, user.id),
      addNote(env, id, user.id, `Reopened: ${how}`),
    ]);
  } else if (to === 'not_interested') {
    await env.DB.batch([
      env.DB.prepare('DELETE FROM outreach_notes WHERE outreach_id = ?').bind(id),
      logConsent(env, id, 'withdrawn', 'all', how, user.id),
      env.DB.prepare("UPDATE outreach SET stage = 'not_interested', consent_withdrawn_at = ?, contact_name = NULL, phone = NULL, address = NULL, postcode = NULL, products = NULL, source = NULL, follow_up_on = NULL, assigned_to = NULL, updated_at = ? WHERE id = ?").bind(t, t, id),
      addNote(env, id, user.id, `Not interested: ${how}. Their personal details were removed; the permission history is kept.`),
    ]);
  } else {
    await env.DB.batch([
      env.DB.prepare(`UPDATE outreach SET stage = ?, ${to === 'todo' ? 'contact_count = 0, follow_up_on = NULL,' : 'follow_up_on = NULL,'} updated_at = ? WHERE id = ?`).bind(to, t, id),
      addNote(env, id, user.id, `Stage: ${STAGES[to]}`),
    ]);
  }
  await audit(env, user.id, 'outreach.stage', id, { to, ...(how && { how }) });
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
    <p class="lt-to">${o.contact_name ? html`${o.contact_name}<br />` : ''}${o.business_name}<br />${[...o.address.split('\n'), o.postcode].filter(Boolean).map((l, i) => html`${i ? raw('<br />') : ''}${l}`)}</p>
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
  website: ['website', 'web', 'url'],
  facebook: ['facebook', 'facebook page'],
  instagram: ['instagram', 'insta'],
  postcode: ['postcode', 'post code', 'postal code'],
  address: ['address', 'postal address'],
  town: ['town', 'city', 'village'],
  county: ['county'],
  products: ['products', 'what they make', 'makes', 'product'],
  source: ['source', 'found at', 'found', 'where found'],
  notes: ['notes', 'note', 'comments'],
};
const kindFrom = (s) => { const t = String(s || '').toLowerCase(); return /llp/.test(t) ? 'llp' : /\b(ltd|limited|plc)\b/.test(t) ? 'ltd' : /sole/.test(t) ? 'sole' : /partner/.test(t) ? 'partnership' : 'unknown'; };
export const CSV_TEMPLATE = 'Business name,Contact name,Business type,Company number,Email,Phone,Website,Facebook,Instagram,Address,Postcode,Town,County,Products,Found at,Notes\r\nCorvedale Creamery,Sarah,Ltd,09876543,hello@corvedalecreamery.example,,https://corvedalecreamery.example,https://www.facebook.com/corvedalecreamery,@corvedalecreamery,"Unit 2, Station Road\nCraven Arms",SY7 9AA,Craven Arms,Shropshire,Wenlock Edge cheddar,Ludlow Food Festival,Interested when we spoke\r\n';

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
    stmts.push(insertItem(env, id, v, user.id, t));
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
export async function markJoined(env, { producerId, email, website, facebook, businessName }) {
  const host = hostOf(website);
  const fb = facebook ? shortLink(facebook).toLowerCase() : '';
  const mail = normEmail(email);
  const rows = await env.DB.prepare(`SELECT id, email, business_name, website, facebook FROM outreach WHERE stage NOT IN ('joined', 'not_interested')
    AND (email = ? OR lower(business_name) = lower(?) ${host ? 'OR website LIKE ?' : ''} ${fb ? 'OR lower(facebook) LIKE ?' : ''}) LIMIT 10`)
    .bind(...[mail, businessName, ...(host ? [`%${host}%`] : []), ...(fb ? [`%${fb}%`] : [])]).all().then((r) => r.results);
  const hits = rows.filter((r) => r.email === mail || r.business_name.toLowerCase() === businessName.toLowerCase() || (host && hostOf(r.website) === host) || (fb && r.facebook && shortLink(r.facebook).toLowerCase() === fb));
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

// ---------- public "tell me more" form ----------
// Lets sole traders and partnerships (and anyone else) ask us to email them about joining.
// The ticked box is their permission; we keep the date and the wording as evidence.
const CONSENT_EMAIL = 'Yes, email me about joining Roots & Pantry';
const CONSENT_FB = 'You can also send me a Facebook message about it';
export const INTEREST_SOURCE = 'Website form';

function interestForm(env, user, { values = {}, errors = [], sent = false } = {}) {
  const err = (f) => errors.find((e) => e.field === f)?.msg;
  if (sent) {
    return page(env, { title: 'Thanks', user, body: html`<div class="narrow"><h1>Thanks, we'll be in touch</h1>
      <p class="sub">We've emailed you how Roots &amp; Pantry works and how to join. If it isn't there in a few minutes, check your junk folder.</p>
      <p>Ready now? <a href="/signin?next=/producer/join">List your business</a>. It takes about 5 minutes.</p>
      <p><a class="btn btn-ghost" href="${env.SITE_URL}/for-producers/">Back to For producers</a></p></div>` });
  }
  const check = (id, label, hint, required) => html`<div class="field${err(id) ? ' has-error' : ''}">
    ${err(id) ? html`<p class="error" id="${id}-err">${err(id)}</p>` : ''}
    <div class="check"><input type="checkbox" id="${id}" name="${id}" value="yes" ${values[id] ? raw('checked') : ''} ${err(id) ? raw(`aria-invalid="true" aria-describedby="${id}-err ${id}-hint"`) : raw(`aria-describedby="${id}-hint"`)} />
      <label for="${id}">${label}${required ? '' : raw(' <span class="opt">(optional)</span>')}</label></div>
    <p class="hint" id="${id}-hint">${hint}</p></div>`;
  return page(env, {
    title: 'Tell me more',
    user,
    turnstile: true,
    status: errors.length ? 400 : 200,
    body: html`<div class="narrow">
      <h1>Not ready to join yet?</h1>
      <p class="sub">Leave your details and we'll email you how Roots &amp; Pantry works and how to join. No obligation, and it's free to be listed.</p>
      ${errorList(errors)}
      <form method="post" action="/producers/interest" novalidate>
        ${field({ id: 'contact_name', label: 'Your name', value: values.contact_name, autocomplete: 'name', max: 80, error: err('contact_name') })}
        ${field({ id: 'business_name', label: 'Business name', value: values.business_name, autocomplete: 'organization', max: 120, error: err('business_name') })}
        ${field({ id: 'email', label: 'Email address', type: 'email', value: values.email, autocomplete: 'email', max: 254, error: err('email') })}
        ${field({ id: 'town', label: 'Town', value: values.town, required: false, autocomplete: 'address-level2', max: 60 })}
        <div class="field"><label for="county">County <span class="opt">(optional)</span></label>
          <select id="county" name="county"><option value="">Choose…</option>${COUNTIES.map((c) => html`<option ${c === values.county ? raw('selected') : ''}>${c}</option>`)}</select></div>
        ${field({ id: 'products', label: 'What you make or sell', value: values.products, required: false, max: 80 })}
        ${field({ id: 'facebook', label: 'Facebook page', type: 'url', value: values.facebook, required: false, max: 300, hint: 'The full link, like https://www.facebook.com/yourbusiness', error: err('facebook') })}
        ${check('consent_email', CONSENT_EMAIL, "We'll send you how it works now, and at most one reminder. Reply \"stop\" at any time and we won't email you again.", true)}
        ${check('consent_facebook', CONSENT_FB, 'Only if you gave your Facebook page above. Same rules: one message and at most one reminder.', false)}
        <div class="hp" aria-hidden="true"><label for="website">Leave this empty</label><input id="website" name="website" tabindex="-1" autocomplete="off" /></div>
        ${turnstileWidget(env)}
        <button class="btn btn-green" type="submit">Send me the details</button>
      </form>
      <p class="note">See how we handle your details in our <a href="${env.SITE_URL}/privacy-and-terms/">privacy notice</a>.</p>
    </div>`,
  });
}

export const getInterest = (request, env, user) => interestForm(env, user);

export async function postInterest(request, env, user, form) {
  if (form.get('website')) return interestForm(env, user, { sent: true }); // honeypot
  const { v } = readForm(form);
  const values = { ...v, consent_email: form.get('consent_email') === 'yes', consent_facebook: form.get('consent_facebook') === 'yes' };
  const errors = [];
  if (!v.contact_name) errors.push({ field: 'contact_name', msg: 'Enter your name' });
  if (!v.business_name) errors.push({ field: 'business_name', msg: 'Enter your business name' });
  if (!validEmail(v.email)) errors.push({ field: 'email', msg: 'Enter a valid email address, like name@example.co.uk' });
  if (v.facebook && !(validUrl(v.facebook) && /(^|\.)(facebook\.com|fb\.com)$/.test(hostOf(v.facebook)))) errors.push({ field: 'facebook', msg: 'Enter the full link to your Facebook page, starting https://www.facebook.com/' });
  if (!values.consent_email) errors.push({ field: 'consent_email', msg: 'Tick the box so we can email you the details' });
  if (values.consent_facebook && !v.facebook) errors.push({ field: 'facebook', msg: 'Add your Facebook page, or untick the Facebook box' });
  if (errors.length) return interestForm(env, user, { values, errors });
  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  if (!(await verifyTurnstile(env, form.get('cf-turnstile-response'), ip))) {
    return interestForm(env, user, { values, errors: [{ field: 'consent_email', msg: "We couldn't confirm you're not a robot. Please try again." }] });
  }
  if (!(await rateLimit(env, `interest:ip:${await sha256(ip)}`, 5, 3600))) {
    return interestForm(env, user, { values, errors: [{ field: 'consent_email', msg: 'Too many requests from here in the last hour. Please try later or email hello@rootsandpantry.co.uk.' }] });
  }
  const t = now();
  const today = todayUK();
  const how = `${INTEREST_SOURCE}: "${CONSENT_EMAIL}"${values.consent_facebook ? ` and "${CONSENT_FB}"` : ''}`;
  const follow = addDays(today, FOLLOW_UP_DAYS.email);
  const existing = await env.DB.prepare('SELECT id, stage, business_name FROM outreach WHERE email = ? LIMIT 1').bind(v.email).first();
  let id = existing?.id;
  const named = existing && existing.business_name.toLowerCase() !== v.business_name.toLowerCase() ? ` (they called their business "${v.business_name}" on the form)` : '';
  const note = `Asked for details on the website${named} and gave permission to email${values.consent_facebook ? ' and message on Facebook' : ''}. We emailed them how it works automatically.`;
  if (existing) {
    const joined = existing.stage === 'joined';
    await env.DB.batch([
      env.DB.prepare(`UPDATE outreach SET consent_email_at = ?, consent_facebook_at = ?, consent_how = ?,
          contact_name = coalesce(contact_name, ?), facebook = coalesce(facebook, ?), town = coalesce(town, ?), county = coalesce(county, ?), products = coalesce(products, ?),
          ${joined ? '' : "stage = 'contacted', contact_count = 1, last_contact_on = ?, follow_up_on = ?,"} updated_at = ? WHERE id = ?`)
        .bind(t, values.consent_facebook ? t : null, how, v.contact_name, v.facebook || null, v.town || null, v.county || null, v.products || null, ...(joined ? [] : [today, follow]), t, id),
      addNote(env, id, null, note),
    ]);
  } else {
    id = randomId();
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO outreach (id, business_name, contact_name, kind, email, facebook, town, county, products, source, stage, contact_count, last_contact_on, follow_up_on,
          consent_email_at, consent_facebook_at, consent_how, created_at, updated_at)
        VALUES (?, ?, ?, 'unknown', ?, ?, ?, ?, ?, ?, 'contacted', 1, ?, ?, ?, ?, ?, ?, ?)`)
        .bind(id, v.business_name, v.contact_name, v.email, v.facebook || null, v.town || null, v.county || null, v.products || null, INTEREST_SOURCE, today, follow, t, values.consent_facebook ? t : null, how, t, t),
      addNote(env, id, null, note),
    ]);
  }
  await logConsent(env, id, 'given', values.consent_facebook ? 'email+facebook' : 'email', how, null).run();
  await audit(env, null, 'outreach.interest', id, { business: v.business_name });
  const join = `${appUrl(request, env)}/producer/join`;
  await sendEmail(env, {
    to: v.email,
    replyTo: env.NOTIFY_EMAIL,
    subject: 'How Roots & Pantry works for producers',
    html: true,
    text: `Hi ${firstName(v.contact_name)},

Thanks for asking about Roots & Pantry. Here's how it works.

Roots & Pantry is a free website that helps local families find and buy from independent food producers like ${v.business_name}. Families find you by postcode, and you can set your own exclusive deals for them (at least 10% off, or a free item), so new customers come to you.

Being listed is free. Joining takes about 5 minutes: ${join}
More about how it works for producers: ${env.SITE_URL}/for-producers/

Any questions, just reply to this email. We'll send you at most one reminder. If you'd rather we didn't, reply "stop" and we won't email you again.

Jason
Roots & Pantry · hello@rootsandpantry.co.uk${FOOTER_GAP}${COMPANY}`,
  });
  await sendEmail(env, {
    to: env.NOTIFY_EMAIL,
    replyTo: v.email,
    subject: `[Producer enquiry] ${v.business_name}`,
    text: `${v.contact_name} from ${v.business_name}${v.town ? ` (${v.town})` : ''} asked for details on the website and was sent the how-it-works email.\n\nOutreach record: ${env.APP_URL}/admin/outreach/${id}\n\nRoots & Pantry`,
  });
  return interestForm(env, user, { sent: true });
}
