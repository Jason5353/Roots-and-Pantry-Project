// Producer dashboard: listing, deals, public listing page, promote kit, expiry reminders.
import qrcode from 'qrcode-generator';
import { html, raw, now, randomId, clean, validUrl, normPostcode } from './util.js';
import { page, errorList, field, select, securityHeaders } from './layout.js';
import { sendEmail, audit } from './services.js';
import { COUNTIES } from './data.js';

export const MIN_PERCENT = 10;
export const MIN_DAYS = 14;
const MAX_LIVE_DEALS = 10;
const HEALTH_CLAIMS = /\b(cures?|cured|heal(s|ing)?|immun\w*|detox\w*|boosts?|prevents?|superfoods?|medicinal|anti-?ageing|anti-?inflammatory)\b/i;

// ---------- dates (UK local) ----------
export const todayUK = (d = new Date()) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/London' }).format(d);
const addDays = (ymd, n) => { const d = new Date(`${ymd}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
export const daysBetween = (a, b) => Math.round((Date.parse(`${b}T12:00:00Z`) - Date.parse(`${a}T12:00:00Z`)) / 86400000);
const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(`${s}T12:00:00Z`));
export const niceDate = (ymd) => new Date(`${ymd}T12:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });

// ---------- data ----------
export async function getProducer(env, userId) {
  const p = await env.DB.prepare('SELECT * FROM producers WHERE user_id = ?').bind(userId).first();
  if (p && !p.slug) {
    p.slug = await makeSlug(env, p.business_name, p.id);
    await env.DB.prepare('UPDATE producers SET slug = ? WHERE id = ?').bind(p.slug, p.id).run();
  }
  return p;
}

export async function makeSlug(env, name, id) {
  const base = String(name).toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 50) || 'producer';
  const taken = await env.DB.prepare('SELECT id FROM producers WHERE slug = ? AND id != ?').bind(base, id).first();
  return taken ? `${base}-${id.slice(0, 5).toLowerCase().replace(/[^a-z0-9]/g, 'x')}` : base;
}

const listDeals = (env, producerId) => env.DB.prepare('SELECT * FROM deals WHERE producer_id = ? ORDER BY ends_on DESC').bind(producerId).all().then((r) => r.results);
const getDeal = (env, producerId, id) => env.DB.prepare('SELECT * FROM deals WHERE id = ? AND producer_id = ?').bind(id, producerId).first();

export function dealState(deal, producerStatus, today = todayUK()) {
  if (deal.status === 'ended') return ['ended', 'Ended'];
  if (deal.ends_on < today) return ['expired', 'Expired'];
  if (deal.status === 'paused') return ['paused', 'Paused'];
  if (deal.starts_on > today) return ['scheduled', `Starts ${niceDate(deal.starts_on)}`];
  if (producerStatus !== 'approved') return ['waiting', 'Goes live when your listing is approved'];
  return ['live', 'Live'];
}

export const offerText = (d) => (d.kind === 'percent' ? `${d.percent}% off` : `Free ${d.free_item}`);
export const howText = { online: 'Online', in_person: 'In person', both: 'Online and in person' };

// ---------- dashboard ----------
export async function dashboard(request, env, user, url) {
  const p = await getProducer(env, user.id);
  if (!p) return Response.redirect(new URL('/producer/join', request.url), 303);
  const deals = await listDeals(env, p.id);
  const today = todayUK();
  const statusText = {
    pending: ['Waiting for approval', "We check every listing by hand and will email you when it goes live. You can add your deals now; they'll go live with your listing."],
    approved: ['Live', 'Your listing is live. Families near you can see your deals.'],
    rejected: ['Not approved', "We couldn't approve this listing. We've emailed you the reason. Reply to that email if you'd like to talk."],
    suspended: ['Suspended', "Your listing is paused. We've emailed you the reason. Reply to that email to appeal."],
  }[p.status] || ['Unknown', ''];
  const flash = { saved: 'Your listing has been saved.', deal: 'Your deal has been saved.', renewed: 'Your deal has been renewed for 30 days.', paused: 'Your deal is paused.', resumed: 'Your deal is running again.', ended: 'Your deal has ended.' }[url.searchParams.get('done')];
  return page(env, {
    title: 'My listing',
    user,
    body: html`<div class="dash">
      ${flash ? html`<div class="flash" role="status">${flash}</div>` : ''}
      <h1>${p.business_name}</h1>
      <p class="status status-${p.status}"><b>Status:</b> ${statusText[0]}</p>
      <p>${statusText[1]}</p>
      ${p.status_reason && (p.status === 'rejected' || p.status === 'suspended') ? html`<p><b>Reason:</b> ${p.status_reason}</p>` : ''}

      <section class="panel" aria-labelledby="deals-h">
        <div class="panelhead"><h2 id="deals-h">Your deals</h2><a class="btn btn-green" href="/producer/deals/new">Add a deal</a></div>
        ${deals.length ? html`<ul class="deals">${deals.map((d) => {
          const [state, label] = dealState(d, p.status, today);
          const endingSoon = state === 'live' && daysBetween(today, d.ends_on) <= 7;
          return html`<li class="deal">
            <div class="deal-main">
              <p class="deal-title"><b>${d.title}</b> <span class="tag tag-${state}">${label}</span>${endingSoon ? html` <span class="tag tag-soon">Ends soon</span>` : ''}</p>
              <p class="deal-meta">${offerText(d)} · ${howText[d.how]} · ${d.redemption === 'code' ? `Code ${d.code}` : 'Mention Roots & Pantry'} · ${niceDate(d.starts_on)} to ${niceDate(d.ends_on)}${d.alcohol ? ' · Adults only' : ''}</p>
            </div>
            <div class="deal-actions">
              ${state === 'ended' ? '' : html`<a class="btn btn-ghost btn-sm" href="/producer/deals/${d.id}/edit">Edit<span class="sr-only"> ${d.title}</span></a>`}
              ${state === 'expired' || state === 'ended' || endingSoon ? html`<form method="post" action="/producer/deals/${d.id}/renew"><button class="btn btn-green btn-sm">Renew for 30 days<span class="sr-only">: ${d.title}</span></button></form>` : ''}
              ${state === 'live' || state === 'waiting' || state === 'scheduled' ? html`<form method="post" action="/producer/deals/${d.id}/status"><input type="hidden" name="to" value="paused" /><button class="btn btn-ghost btn-sm">Pause<span class="sr-only"> ${d.title}</span></button></form>` : ''}
              ${state === 'paused' ? html`<form method="post" action="/producer/deals/${d.id}/status"><input type="hidden" name="to" value="active" /><button class="btn btn-ghost btn-sm">Resume<span class="sr-only"> ${d.title}</span></button></form>` : ''}
              ${state !== 'ended' ? html`<form method="post" action="/producer/deals/${d.id}/status"><input type="hidden" name="to" value="ended" /><button class="btn btn-ghost btn-sm">End now<span class="sr-only">: ${d.title}</span></button></form>` : ''}
            </div>
          </li>`;
        })}</ul>` : html`<p>No deals yet. Add one: at least ${MIN_PERCENT}% off or a free item, running for at least ${MIN_DAYS} days.</p>`}
      </section>

      <div class="cards">
        <section class="panel">
          <h2>Your listing</h2>
          <dl class="details">
            <dt>Contact</dt><dd>${p.contact_name}, ${user.email}, ${p.phone}</dd>
            <dt>Location</dt><dd>${p.postcode}, ${p.county}</dd>
            ${p.shop_address ? html`<dt>Shop</dt><dd>${p.shop_address}</dd>` : ''}
            ${p.market_days ? html`<dt>Markets</dt><dd>${p.market_days}</dd>` : ''}
            <dt>Website</dt><dd>${p.website || 'None'}</dd>
            <dt>Facebook</dt><dd>${p.facebook || 'None'}</dd>
          </dl>
          <p class="btns"><a class="btn btn-ghost" href="/producer/edit">Edit listing</a> <a class="btn btn-ghost" href="/p/${p.slug}">${p.status === 'approved' ? 'View public page' : 'Preview public page'}</a></p>
        </section>
        <section class="panel">
          <h2>Promote your listing</h2>
          <p>Print a poster or postcard with your own QR code, or share a ready-made Facebook post.</p>
          <p><a class="btn btn-ghost" href="/producer/promote">Open the promote kit</a></p>
        </section>
      </div>
    </div>`,
  });
}

// ---------- edit listing ----------
const REACH = [['none', "I don't deliver"], ['local', 'Local delivery only'], ['miles', 'Within a set number of miles'], ['uk', 'UK-wide delivery']];

function listingForm(env, user, v, errors = []) {
  const err = (f) => errors.find((e) => e.field === f)?.msg;
  return page(env, {
    title: 'Edit listing',
    user,
    status: errors.length ? 400 : 200,
    body: html`<div class="narrow">
      <p><a href="/producer">← Back to my listing</a></p>
      <h1>Edit your listing</h1>
      ${errorList(errors)}
      <form method="post" action="/producer/edit" novalidate>
        ${field({ id: 'business_name', label: 'Business name', value: v.business_name, error: err('business_name'), max: 100 })}
        ${field({ id: 'contact_name', label: 'Your name', value: v.contact_name, error: err('contact_name'), max: 100 })}
        ${field({ id: 'phone', label: 'Phone number', type: 'tel', value: v.phone, hint: 'Only for us. Never shown publicly.', error: err('phone'), max: 30 })}
        ${field({ id: 'description', label: 'What do you make or sell?', value: v.description, rows: 4, max: 600, hint: 'Shown on your public page.', error: err('description') })}
        ${field({ id: 'website', label: 'Website', type: 'url', value: v.website, required: false, hint: 'Starting https://', error: err('website'), max: 300 })}
        ${field({ id: 'facebook', label: 'Facebook page', type: 'url', value: v.facebook, required: false, hint: 'Like https://www.facebook.com/yourbusiness', error: err('facebook'), max: 300 })}
        ${field({ id: 'shop_address', label: 'Shop or farm shop address', value: v.shop_address, required: false, hint: 'Shown publicly so families can visit. Leave empty if you have no shop.', error: err('shop_address'), max: 200 })}
        ${field({ id: 'market_days', label: 'Markets and opening times', value: v.market_days, required: false, rows: 3, hint: 'For example: Wellington Market, Thursdays 9am to 2pm.', error: err('market_days'), max: 400 })}
        ${field({ id: 'postcode', label: 'Business postcode', value: v.postcode, hint: 'Used to show your deals to families nearby. Only the first half is shown publicly.', error: err('postcode'), max: 10 })}
        ${select({ id: 'county', label: 'County', options: COUNTIES, value: v.county, error: err('county') })}
        <fieldset class="field${err('delivery_reach') ? ' has-error' : ''}">
          <legend>Do you deliver?</legend>
          ${err('delivery_reach') ? html`<p class="error">${err('delivery_reach')}</p>` : ''}
          ${REACH.map(([val, label]) => html`<div class="radio"><input type="radio" id="reach-${val}" name="delivery_reach" value="${val}" ${v.delivery_reach === val ? raw('checked') : ''} /><label for="reach-${val}">${label}</label></div>`)}
        </fieldset>
        ${field({ id: 'delivery_miles', label: 'How many miles?', value: v.delivery_miles ?? '', required: false, inputmode: 'numeric', hint: 'Only if you chose "within a set number of miles".', error: err('delivery_miles'), max: 4 })}
        ${field({ id: 'hygiene_link', label: 'Food hygiene rating link', type: 'url', value: v.hygiene_link, required: false, hint: 'From ratings.food.gov.uk, if you have one.', error: err('hygiene_link'), max: 300 })}
        <button class="btn btn-green" type="submit">Save listing</button>
      </form>
    </div>`,
  });
}

export async function getEdit(request, env, user) {
  const p = await getProducer(env, user.id);
  if (!p) return Response.redirect(new URL('/producer/join', request.url), 303);
  return listingForm(env, user, p);
}

const isFacebook = (u) => { try { return /^(www\.|m\.)?(facebook|fb)\.com$/i.test(new URL(u).hostname); } catch { return false; } };

export async function postEdit(request, env, user, form) {
  const p = await getProducer(env, user.id);
  if (!p) return Response.redirect(new URL('/producer/join', request.url), 303);
  const v = {
    business_name: clean(form.get('business_name'), 100), contact_name: clean(form.get('contact_name'), 100), phone: clean(form.get('phone'), 30),
    description: clean(form.get('description'), 600), website: clean(form.get('website'), 300), facebook: clean(form.get('facebook'), 300),
    shop_address: clean(form.get('shop_address'), 200), market_days: clean(form.get('market_days'), 400), postcode: clean(form.get('postcode'), 10),
    county: clean(form.get('county'), 60), delivery_reach: clean(form.get('delivery_reach'), 10), delivery_miles: clean(form.get('delivery_miles'), 4),
    hygiene_link: clean(form.get('hygiene_link'), 300),
  };
  const errors = [];
  if (!v.business_name) errors.push({ field: 'business_name', msg: 'Enter your business name' });
  if (!v.contact_name) errors.push({ field: 'contact_name', msg: 'Enter your name' });
  if (!/^[0-9+()\s-]{10,30}$/.test(v.phone)) errors.push({ field: 'phone', msg: 'Enter a phone number, like 01952 123456' });
  if (v.description.length < 20) errors.push({ field: 'description', msg: 'Tell families a little about what you make or sell (at least 20 characters)' });
  if (!validUrl(v.website)) errors.push({ field: 'website', msg: 'Enter a full web address starting https://' });
  if (v.facebook && !isFacebook(v.facebook)) errors.push({ field: 'facebook', msg: 'Enter the full link to your Facebook page, starting https://www.facebook.com/' });
  const pc = normPostcode(v.postcode);
  if (!pc) errors.push({ field: 'postcode', msg: 'Enter a full UK postcode, like TF1 2EB' });
  if (!COUNTIES.includes(v.county)) errors.push({ field: 'county', msg: 'Choose your county' });
  if (!REACH.some(([k]) => k === v.delivery_reach)) errors.push({ field: 'delivery_reach', msg: 'Choose whether you deliver' });
  let miles = null;
  if (v.delivery_reach === 'miles') {
    miles = Number(v.delivery_miles);
    if (!Number.isInteger(miles) || miles < 1 || miles > 500) errors.push({ field: 'delivery_miles', msg: 'Enter a number of miles between 1 and 500' });
  }
  if (!validUrl(v.hygiene_link)) errors.push({ field: 'hygiene_link', msg: 'Enter a full web address starting https://' });
  if (errors.length) return listingForm(env, user, v, errors);
  const slug = v.business_name !== p.business_name ? await makeSlug(env, v.business_name, p.id) : p.slug;
  await env.DB.prepare(
    `UPDATE producers SET business_name = ?, contact_name = ?, phone = ?, description = ?, website = ?, facebook = ?, shop_address = ?, market_days = ?,
     postcode = ?, district = ?, county = ?, delivery_reach = ?, delivery_miles = ?, hygiene_link = ?, slug = ?, updated_at = ? WHERE id = ?`,
  ).bind(v.business_name, v.contact_name, v.phone, v.description, v.website || null, v.facebook || null, v.shop_address || null, v.market_days || null,
    pc, pc.split(' ')[0], v.county, v.delivery_reach, miles, v.hygiene_link || null, slug, now(), p.id).run();
  await audit(env, user.id, 'producer.edited', p.id);
  return Response.redirect(new URL('/producer?done=saved', request.url), 303);
}

// ---------- deals ----------
function dealForm(env, user, p, v, { errors = [], id = null } = {}) {
  const err = (f) => errors.find((e) => e.field === f)?.msg;
  const radio = (name, val, label, hint = '') => html`<div class="radio"><input type="radio" id="${name}-${val}" name="${name}" value="${val}" ${v[name] === val ? raw('checked') : ''} ${hint ? html`aria-describedby="${name}-${val}-hint"` : ''} /><label for="${name}-${val}">${label}</label>${hint ? html`<p class="hint" id="${name}-${val}-hint">${hint}</p>` : ''}</div>`;
  const group = (name, legend, inner) => html`<fieldset class="field${err(name) ? ' has-error' : ''}"><legend>${legend}</legend>${err(name) ? html`<p class="error" id="${name}-err">${err(name)}</p>` : ''}${inner}</fieldset>`;
  return page(env, {
    title: id ? 'Edit deal' : 'Add a deal',
    user,
    status: errors.length ? 400 : 200,
    body: html`<div class="narrow">
      <p><a href="/producer">← Back to my listing</a></p>
      <h1>${id ? 'Edit your deal' : 'Add a deal'}</h1>
      <p class="sub">At least ${MIN_PERCENT}% off or a free item, running for at least ${MIN_DAYS} days. Food and drink only, and no health claims.</p>
      ${errorList(errors)}
      <form method="post" action="${id ? `/producer/deals/${id}/edit` : '/producer/deals/new'}" novalidate>
        ${field({ id: 'title', label: 'Deal headline', value: v.title, hint: 'Short and clear, like "10% off all our cheeses" or "Free jar of chutney with any hamper".', error: err('title'), max: 80 })}
        ${group('kind', 'What is the offer?', html`
          ${radio('kind', 'percent', 'A percentage off')}
          ${radio('kind', 'free_item', 'A free item')}`)}
        ${field({ id: 'percent', label: 'Percentage off', value: v.percent ?? '', required: false, inputmode: 'numeric', hint: `If you chose a percentage: ${MIN_PERCENT} or more.`, error: err('percent'), max: 3 })}
        ${field({ id: 'free_item', label: 'Free item', value: v.free_item, required: false, hint: 'If you chose a free item: what do they get, and when? For example "loaf of bread with any order over £20".', error: err('free_item'), max: 120 })}
        ${field({ id: 'products', label: 'Which products does it cover?', value: v.products, hint: 'List the foods, separated by commas, like "cheddar, brie, butter". We use these words to show your deal next to matching recipe ingredients.', error: err('products'), max: 300 })}
        ${group('how', 'Where can families use it?', html`
          ${radio('how', 'online', 'Online, on my website')}
          ${radio('how', 'in_person', 'In person, at my shop or stall')}
          ${radio('how', 'both', 'Both')}`)}
        ${group('redemption', 'How do families claim it?', html`
          ${radio('redemption', 'code', 'With a discount code', 'Online they type it in; in person they show it on their phone.')}
          ${radio('redemption', 'mention', 'They just mention Roots & Pantry', 'No code needed. Best for market stalls.')}`)}
        ${field({ id: 'code', label: 'Discount code', value: v.code, required: false, hint: 'If you chose a code: 3 to 20 letters or numbers, like ROOTS10.', error: err('code'), max: 20 })}
        ${field({ id: 'online_url', label: 'Where to use it online', type: 'url', value: v.online_url, required: false, hint: 'If it works online: the page families should go to. We use your website if you leave this empty.', error: err('online_url'), max: 300 })}
        <div class="two-dates">
          ${field({ id: 'starts_on', label: 'Starts', type: 'date', value: v.starts_on, error: err('starts_on'), max: 10 })}
          ${field({ id: 'ends_on', label: 'Ends', type: 'date', value: v.ends_on, hint: `At least ${MIN_DAYS} days after it starts.`, error: err('ends_on'), max: 10 })}
        </div>
        ${field({ id: 'allergens', label: 'Allergens in these products', value: v.allergens, required: false, hint: 'For example: milk, nuts, gluten. Families will be told to always check the label too.', error: err('allergens'), max: 200 })}
        ${field({ id: 'small_print', label: 'Small print', value: v.small_print, required: false, rows: 2, hint: 'Any conditions, like "one per customer" or "not with other offers".', error: err('small_print'), max: 300 })}
        <div class="field"><div class="check"><input type="checkbox" id="alcohol" name="alcohol" value="yes" ${v.alcohol ? raw('checked') : ''} /><label for="alcohol">This deal includes alcohol (only adults will see it)</label></div></div>
        <button class="btn btn-green" type="submit">${id ? 'Save deal' : 'Add deal'}</button>
      </form>
    </div>`,
  });
}

function readDeal(form) {
  return {
    title: clean(form.get('title'), 80), kind: clean(form.get('kind'), 10), percent: clean(form.get('percent'), 3), free_item: clean(form.get('free_item'), 120),
    products: clean(form.get('products'), 300), how: clean(form.get('how'), 10), redemption: clean(form.get('redemption'), 10),
    code: clean(form.get('code'), 20).toUpperCase(), online_url: clean(form.get('online_url'), 300), starts_on: clean(form.get('starts_on'), 10),
    ends_on: clean(form.get('ends_on'), 10), allergens: clean(form.get('allergens'), 200), small_print: clean(form.get('small_print'), 300), alcohol: form.get('alcohol') === 'yes',
  };
}

export function validateDeal(v, { today = todayUK(), existingStart = null } = {}) {
  const errors = [];
  if (v.title.length < 5) errors.push({ field: 'title', msg: 'Enter a short headline for your deal' });
  if (!['percent', 'free_item'].includes(v.kind)) errors.push({ field: 'kind', msg: 'Choose a percentage off or a free item' });
  let percent = null;
  if (v.kind === 'percent') {
    percent = Number(v.percent);
    if (!Number.isInteger(percent) || percent < MIN_PERCENT || percent > 100) errors.push({ field: 'percent', msg: `Enter a percentage of at least ${MIN_PERCENT}` });
  }
  if (v.kind === 'free_item' && v.free_item.length < 3) errors.push({ field: 'free_item', msg: 'Say what the free item is' });
  const products = v.products.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  if (!products.length) errors.push({ field: 'products', msg: 'List at least one product, like "cheddar"' });
  if (products.length > 20) errors.push({ field: 'products', msg: 'List no more than 20 products' });
  if (!['online', 'in_person', 'both'].includes(v.how)) errors.push({ field: 'how', msg: 'Choose where families can use it' });
  if (!['code', 'mention'].includes(v.redemption)) errors.push({ field: 'redemption', msg: 'Choose how families claim it' });
  if (v.redemption === 'mention' && v.how === 'online') errors.push({ field: 'redemption', msg: 'Online deals need a discount code' });
  if (v.redemption === 'code' && !/^[A-Z0-9]{3,20}$/.test(v.code)) errors.push({ field: 'code', msg: 'Enter a code of 3 to 20 letters or numbers, with no spaces' });
  if (!validUrl(v.online_url)) errors.push({ field: 'online_url', msg: 'Enter a full web address starting https://' });
  if (!isDate(v.starts_on)) errors.push({ field: 'starts_on', msg: 'Enter the start date' });
  else if (v.starts_on < today && v.starts_on !== existingStart) errors.push({ field: 'starts_on', msg: 'The start date cannot be in the past' });
  if (!isDate(v.ends_on)) errors.push({ field: 'ends_on', msg: 'Enter the end date' });
  else if (isDate(v.starts_on)) {
    if (daysBetween(v.starts_on, v.ends_on) < MIN_DAYS) errors.push({ field: 'ends_on', msg: `Deals must run for at least ${MIN_DAYS} days. End it on ${addDays(v.starts_on, MIN_DAYS)} or later.` });
    if (daysBetween(v.starts_on, v.ends_on) > 366) errors.push({ field: 'ends_on', msg: 'Deals can run for up to a year. You can renew it after that.' });
  }
  const claimText = `${v.title} ${v.free_item} ${v.small_print}`;
  if (HEALTH_CLAIMS.test(claimText)) errors.push({ field: 'title', msg: 'Please remove health claims (words like "cures", "detox", "boosts immunity"). Our rules don\'t allow them.' });
  return { errors, percent, products: products.join(', ') };
}

export async function getNewDeal(request, env, user) {
  const p = await getProducer(env, user.id);
  if (!p) return Response.redirect(new URL('/producer/join', request.url), 303);
  const t = todayUK();
  return dealForm(env, user, p, { kind: 'percent', how: p.website ? 'online' : 'in_person', redemption: 'code', starts_on: t, ends_on: addDays(t, 30) });
}

export async function postNewDeal(request, env, user, form) {
  const p = await getProducer(env, user.id);
  if (!p) return Response.redirect(new URL('/producer/join', request.url), 303);
  const v = readDeal(form);
  const { errors, percent, products } = validateDeal(v);
  if (!v.online_url && (v.how === 'online' || v.how === 'both') && !p.website) errors.push({ field: 'online_url', msg: 'Add the web address where families use the code' });
  const live = await env.DB.prepare("SELECT COUNT(*) AS n FROM deals WHERE producer_id = ? AND status != 'ended' AND ends_on >= ?").bind(p.id, todayUK()).first();
  if (live.n >= MAX_LIVE_DEALS) errors.push({ field: 'title', msg: `You can have up to ${MAX_LIVE_DEALS} deals at once. End one first.` });
  if (errors.length) return dealForm(env, user, p, v, { errors });
  const id = randomId();
  const t = now();
  await env.DB.prepare(
    `INSERT INTO deals (id, producer_id, title, kind, percent, free_item, products, how, redemption, code, online_url, small_print, allergens, alcohol, starts_on, ends_on, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)`,
  ).bind(id, p.id, v.title, v.kind, percent, v.kind === 'free_item' ? v.free_item : null, products, v.how, v.redemption, v.redemption === 'code' ? v.code : null,
    v.online_url || null, v.small_print || null, v.allergens || null, v.alcohol ? 1 : 0, v.starts_on, v.ends_on, t, t).run();
  await audit(env, user.id, 'deal.created', id, { producer: p.id });
  return Response.redirect(new URL('/producer?done=deal', request.url), 303);
}

export async function getEditDeal(request, env, user, id) {
  const p = await getProducer(env, user.id);
  const d = p && (await getDeal(env, p.id, id));
  if (!d) return null;
  return dealForm(env, user, p, { ...d, alcohol: !!d.alcohol, code: d.code || '' }, { id });
}

export async function postEditDeal(request, env, user, id, form) {
  const p = await getProducer(env, user.id);
  const d = p && (await getDeal(env, p.id, id));
  if (!d) return null;
  if (d.status === 'ended') return Response.redirect(new URL('/producer', request.url), 303);
  const v = readDeal(form);
  const { errors, percent, products } = validateDeal(v, { existingStart: d.starts_on });
  if (!v.online_url && (v.how === 'online' || v.how === 'both') && !p.website) errors.push({ field: 'online_url', msg: 'Add the web address where families use the code' });
  if (errors.length) return dealForm(env, user, p, v, { errors, id });
  await env.DB.prepare(
    `UPDATE deals SET title = ?, kind = ?, percent = ?, free_item = ?, products = ?, how = ?, redemption = ?, code = ?, online_url = ?, small_print = ?, allergens = ?,
     alcohol = ?, starts_on = ?, ends_on = ?, updated_at = ? WHERE id = ? AND producer_id = ?`,
  ).bind(v.title, v.kind, percent, v.kind === 'free_item' ? v.free_item : null, products, v.how, v.redemption, v.redemption === 'code' ? v.code : null,
    v.online_url || null, v.small_print || null, v.allergens || null, v.alcohol ? 1 : 0, v.starts_on, v.ends_on, now(), id, p.id).run();
  await audit(env, user.id, 'deal.edited', id);
  return Response.redirect(new URL('/producer?done=deal', request.url), 303);
}

export async function postDealStatus(request, env, user, id, form) {
  const p = await getProducer(env, user.id);
  const d = p && (await getDeal(env, p.id, id));
  if (!d) return null;
  const to = form.get('to');
  if (!['paused', 'active', 'ended'].includes(to) || d.status === 'ended') return Response.redirect(new URL('/producer', request.url), 303);
  await env.DB.prepare('UPDATE deals SET status = ?, updated_at = ? WHERE id = ?').bind(to, now(), id).run();
  await audit(env, user.id, `deal.${to}`, id);
  return Response.redirect(new URL(`/producer?done=${to === 'active' ? 'resumed' : to}`, request.url), 303);
}

export async function postRenew(request, env, user, id) {
  const p = await getProducer(env, user.id);
  const d = p && (await getDeal(env, p.id, id));
  if (!d) return null;
  const t = todayUK();
  const start = d.ends_on >= t && d.status !== 'ended' ? d.starts_on : t;
  const from = d.ends_on >= t && d.status !== 'ended' ? d.ends_on : t;
  await env.DB.prepare("UPDATE deals SET status = 'active', starts_on = ?, ends_on = ?, reminder_sent_on = NULL, updated_at = ? WHERE id = ?")
    .bind(start, addDays(from, 30), now(), id).run();
  await audit(env, user.id, 'deal.renewed', id);
  return Response.redirect(new URL('/producer?done=renewed', request.url), 303);
}

// ---------- public listing page ----------
// What visitors see when a listing isn't public. Never shows a rejection or suspension reason.
const PREVIEW_NOTE = {
  pending: (own) => `${own ? 'Only you' : 'Only you and the producer'} can see this page until the listing is approved. Visitors see a message saying it's being checked.`,
  suspended: (own) => `${own ? 'Your listing is paused' : 'This listing is suspended'}, so visitors see a message saying it's paused, not this page.`,
  rejected: (own) => `${own ? "Your listing wasn't approved" : 'This listing was not approved'}, so visitors are told it isn't listed.`,
  withdrawn: (own) => `${own ? 'You have taken your listing off' : 'The producer has taken this listing off'} Roots & Pantry, so visitors are told it has left.`,
};

function visitorPage(env, user, { title, heading, text, status }) {
  return page(env, {
    title,
    user,
    status,
    body: html`<div class="narrow">
      <h1>${heading}</h1>
      ${text.map((t) => html`<p>${t}</p>`)}
      <section class="panel" aria-labelledby="next-h">
        <h2 id="next-h">About Roots &amp; Pantry</h2>
        <p>A free family recipe app that shows families deals from independent local food producers.</p>
        <p class="btns"><a class="btn btn-ghost" href="${env.SITE_URL}">Find out more</a> <a class="btn btn-ghost" href="${env.SITE_URL}/for-producers/">List your business</a></p>
      </section>
    </div>`,
  });
}

function notListedPage(env, user) {
  return visitorPage(env, user, {
    title: 'Not listed', status: 404,
    heading: "This producer isn't listed on Roots & Pantry",
    text: ['They may have left, or the link may be wrong. Check the address, or ask the producer for their latest link.'],
  });
}

function statusPage(env, user, p) {
  if (p.status === 'pending') {
    return visitorPage(env, user, {
      title: p.business_name, status: 200,
      heading: `${p.business_name} is joining Roots & Pantry`,
      text: ["We're checking this listing. We check every producer by hand, usually within a few days.", 'Their page and deals will appear here once it is approved. Please check back soon.'],
    });
  }
  if (p.status === 'suspended') {
    return visitorPage(env, user, {
      title: p.business_name, status: 200,
      heading: `${p.business_name} is paused for now`,
      text: ["This producer's page and deals aren't available at the moment.", 'Please check back later.'],
    });
  }
  if (p.status === 'withdrawn') {
    return visitorPage(env, user, {
      title: p.business_name, status: 410,
      heading: `${p.business_name} has left Roots & Pantry`,
      text: ['Their deals are no longer available here. You can still visit or contact them directly.'],
    });
  }
  return notListedPage(env, user); // rejected: treat as never listed
}

export async function publicPage(request, env, user, slug) {
  const p = await env.DB.prepare('SELECT * FROM producers WHERE slug = ?').bind(slug).first();
  if (!p) return notListedPage(env, user);
  const isOwner = user && user.id === p.user_id;
  const isAdmin = user && (user.role === 'owner' || user.role === 'moderator');
  if (p.status !== 'approved' && !isOwner && !isAdmin) return statusPage(env, user, p);
  const today = todayUK();
  const deals = (await listDeals(env, p.id)).filter((d) => ['live', 'waiting'].includes(dealState(d, p.status, today)[0]));
  const district = (p.postcode || '').split(' ')[0];
  return page(env, {
    title: p.business_name,
    user,
    body: html`<div class="narrow">
      ${p.status !== 'approved' ? html`<div class="callout" role="note"><p><b>${isOwner ? 'Preview' : 'Admin view'}.</b> ${PREVIEW_NOTE[p.status]?.(isOwner) || ''}</p></div>` : ''}
      <p class="eyebrow">${district}, ${p.county}</p>
      <h1>${p.business_name}</h1>
      <p class="sub">${p.description}</p>
      ${deals.length ? html`<section class="panel deal-public" aria-labelledby="deals-h"><h2 id="deals-h">Exclusive deals for Roots &amp; Pantry families</h2><ul class="plain">${deals.map((d) => html`<li><b>${d.title}</b><br />${offerText(d)} · ${howText[d.how]}${d.alcohol ? ' · Adults only' : ''} · Until ${niceDate(d.ends_on)}</li>`)}</ul><p class="note">Families see how to claim each deal in the Roots &amp; Pantry app.</p></section>` : ''}
      <section class="panel" aria-labelledby="where-h">
        <h2 id="where-h">Where to find us</h2>
        <dl class="details">
          ${p.shop_address ? html`<dt>Shop</dt><dd>${p.shop_address}</dd>` : ''}
          ${p.market_days ? html`<dt>Markets</dt><dd>${p.market_days}</dd>` : ''}
          ${p.website ? html`<dt>Website</dt><dd><a href="${p.website}" rel="noopener nofollow">${p.website.replace(/^https?:\/\//, '')}</a></dd>` : ''}
          ${p.facebook ? html`<dt>Facebook</dt><dd><a href="${p.facebook}" rel="noopener nofollow">Our Facebook page</a></dd>` : ''}
          ${p.delivery_reach !== 'none' ? html`<dt>Delivery</dt><dd>${p.delivery_reach === 'uk' ? 'UK-wide' : p.delivery_reach === 'miles' ? `Within ${p.delivery_miles} miles` : 'Local delivery'}</dd>` : ''}
          ${p.hygiene_link ? html`<dt>Food hygiene</dt><dd><a href="${p.hygiene_link}" rel="noopener nofollow">See our rating</a></dd>` : ''}
        </dl>
      </section>
      <p class="note">Roots &amp; Pantry is a free family recipe app that shows families deals from independent local producers. <a href="${env.SITE_URL}">Find out more</a>.</p>
    </div>`,
  });
}

// ---------- promote kit ----------
export function qrSvg(text, { size = 240, label = 'QR code' } = {}) {
  const qr = qrcode(0, 'M');
  qr.addData(text);
  qr.make();
  const n = qr.getModuleCount();
  const m = 4; // quiet zone in modules
  let d = '';
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (qr.isDark(r, c)) d += `M${c + m} ${r + m}h1v1h-1z`;
  return raw(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${n + m * 2} ${n + m * 2}" width="${size}" height="${size}" role="img" aria-label="${label.replace(/"/g, '&quot;')}" shape-rendering="crispEdges"><rect width="100%" height="100%" fill="#fff"/><path d="${d}" fill="#1E2A4A"/></svg>`);
}

const publicUrl = (request, p) => new URL(`/p/${p.slug}`, request.url).toString();

async function bestDeal(env, p) {
  const deals = (await listDeals(env, p.id)).filter((d) => ['live', 'waiting', 'scheduled'].includes(dealState(d, p.status)[0]));
  return deals[0] || null;
}

export async function promote(request, env, user) {
  const p = await getProducer(env, user.id);
  if (!p) return Response.redirect(new URL('/producer/join', request.url), 303);
  const url = publicUrl(request, p);
  const deal = await bestDeal(env, p);
  const post = `🌱 We're on Roots & Pantry! 🌱\n\n${p.business_name} has an exclusive deal for families using Roots & Pantry, the free family recipe app that backs independent local food producers.\n\n${deal ? `👉 ${deal.title}\n\n` : ''}Find us here: ${url}\n\n#ShopLocal #${p.county.replace(/\s+/g, '')} #RootsAndPantry`;
  return page(env, {
    title: 'Promote kit',
    user,
    body: html`<div class="narrow">
      <p><a href="/producer">← Back to my listing</a></p>
      <h1>Promote kit</h1>
      ${p.status !== 'approved' ? html`<div class="callout"><p>Your listing isn't live yet. You can print these now, but the QR code only works for families once we've approved your listing.</p></div>` : ''}
      <section class="panel">
        <h2>Your QR code</h2>
        <p>It opens your Roots &amp; Pantry page: <b>${url.replace(/^https:\/\//, '')}</b></p>
        <div class="qr">${qrSvg(url, { label: `QR code for ${p.business_name} on Roots & Pantry` })}</div>
      </section>
      <section class="panel">
        <h2>Print a poster or postcard</h2>
        <p>Opens a print-ready page. Print it at home, or choose "Save as PDF" to send to a printer like VistaPrint.</p>
        <p class="btns"><a class="btn btn-green" href="/producer/promote/poster">A4 poster</a> <a class="btn btn-ghost" href="/producer/promote/postcard">A6 postcard</a></p>
      </section>
      <section class="panel">
        <h2>Facebook post</h2>
        <p>Copy this and paste it into a new post on your Facebook page. Add a photo of your products to go with it.</p>
        <label for="fbpost" class="label-strong">Your post</label>
        <textarea id="fbpost" rows="10" readonly>${post}</textarea>
        <p><button type="button" class="btn btn-ghost" data-copy="fbpost">Copy text</button> <span class="note" data-copied hidden role="status">Copied</span></p>
      </section>
    </div>
    <script src="/copy.js" defer></script>`,
  });
}

export async function printSheet(request, env, user, kind) {
  const p = await getProducer(env, user.id);
  if (!p) return Response.redirect(new URL('/producer/join', request.url), 303);
  const url = publicUrl(request, p);
  const deal = await bestDeal(env, p);
  const isPoster = kind === 'poster';
  const doc = html`<!doctype html>
<html lang="en-GB"><head><meta charset="utf-8" /><meta name="viewport" content="width=device-width, initial-scale=1" /><meta name="robots" content="noindex" />
<title>${p.business_name} ${isPoster ? 'poster' : 'postcard'} | Roots &amp; Pantry</title><link rel="stylesheet" href="/app.css" /><link rel="stylesheet" href="/print.css" /><link rel="stylesheet" href="${isPoster ? '/page-a4.css' : '/page-a6.css'}" /></head>
<body class="print-page ${isPoster ? 'poster' : 'postcard'}">
  <div class="print-tools"><a href="/producer/promote">← Back</a> <button type="button" class="btn btn-red" data-print>Print or save as PDF</button></div>
  <main class="sheet">
    <div class="sheet-brand"><span class="mark" aria-hidden="true">R&amp;P</span> Roots <span class="amp">&amp;</span> Pantry</div>
    <p class="sheet-kicker">Find our exclusive deal on</p>
    <h1 class="sheet-title">Roots &amp; Pantry</h1>
    <p class="sheet-business">${p.business_name}</p>
    ${deal ? html`<p class="sheet-deal">${deal.title}</p>` : html`<p class="sheet-deal">Exclusive deals for local families</p>`}
    <div class="sheet-qr">${qrSvg(url, { size: isPoster ? 380 : 190, label: `QR code for ${p.business_name} on Roots & Pantry` })}</div>
    <p class="sheet-scan">Scan to see our deal</p>
    <p class="sheet-url">${url.replace(/^https:\/\//, '')}</p>
    <p class="sheet-foot">The free family recipe app that backs independent local food producers.</p>
  </main>
  <script src="/print.js" defer></script>
</body></html>`;
  return new Response(doc.toString(), { headers: securityHeaders({ 'Content-Type': 'text/html; charset=utf-8' }) });
}

// ---------- daily job: 7-day expiry reminders ----------
export async function sendExpiryReminders(env, today = todayUK()) {
  const soon = addDays(today, 7);
  const { results } = await env.DB.prepare(
    `SELECT d.id, d.title, d.ends_on, p.business_name, p.contact_name, u.email FROM deals d
     JOIN producers p ON p.id = d.producer_id JOIN users u ON u.id = p.user_id
     WHERE d.status = 'active' AND d.ends_on >= ? AND d.ends_on <= ? AND (d.reminder_sent_on IS NULL OR d.reminder_sent_on != d.ends_on)
     AND p.status IN ('approved', 'pending')`,
  ).bind(today, soon).all();
  let sent = 0;
  for (const r of results) {
    const ok = await sendEmail(env, {
      to: r.email,
      subject: `Your Roots & Pantry deal ends on ${niceDate(r.ends_on)}`,
      text: `Hi ${r.contact_name},\n\nYour deal "${r.title}" for ${r.business_name} ends on ${niceDate(r.ends_on)}.\n\nTo keep it running, sign in to Roots & Pantry, go to My listing and choose "Renew for 30 days". If you'd like it to end, you don't need to do anything.\n\nThanks for supporting local families.\n\nJason\nRoots & Pantry`,
    });
    if (ok) {
      await env.DB.prepare('UPDATE deals SET reminder_sent_on = ends_on WHERE id = ?').bind(r.id).run();
      sent++;
    }
  }
  return sent;
}
