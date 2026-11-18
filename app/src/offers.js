// Offers & specials: a producer's own offers (multibuys, Christmas pre-orders, gift boxes and
// seasonal items). Not exclusive and no code, so they sit below the Roots & Pantry exclusive
// deals everywhere. Rules: at least MIN_OFFER_DAYS long, honest prices, no health claims.
// Also the public Christmas page (/producers/christmas).
import { html, raw, now, randomId, clean, validUrl } from './util.js';
import { page, errorList, field } from './layout.js';
import { audit } from './services.js';
import { getProducer, dealState, niceDate, todayUK, addDays, daysBetween, isDate, HEALTH_CLAIMS, offerText, howText } from './producer.js';
import { parseNear, milesBetween, deliversTo, RADII } from './directory.js';
import { queueOffer } from './facebook.js';

export const MIN_OFFER_DAYS = 3;
const MAX_LIVE_OFFERS = 10;
export const OFFER_KINDS = [
  ['multibuy', 'Multibuy or bundle', 'For example "4 sausages for £12.50" or "3 cheeses for £15".'],
  ['preorder', 'Pre-order', 'For example Christmas turkeys, hampers or cakes, ordered by a set date.'],
  ['seasonal', 'Gift box or seasonal special', 'For example a honey gift box, an Easter treat or a barbecue pack.'],
];
export const kindText = Object.fromEntries(OFFER_KINDS.map(([k, l]) => [k, l]));

const listOffers = (env, producerId) => env.DB.prepare('SELECT * FROM offers WHERE producer_id = ? ORDER BY ends_on DESC').bind(producerId).all().then((r) => r.results);
const getOffer = (env, producerId, id) => env.DB.prepare('SELECT * FROM offers WHERE id = ? AND producer_id = ?').bind(id, producerId).first();
// Soonest-ending first, so order-by dates that are close come to the top.
export const liveOffers = async (env, p, today = todayUK()) => (await listOffers(env, p.id)).filter((o) => ['live', 'waiting'].includes(dealState(o, p.status, today)[0])).reverse();
export const offersFor = listOffers;

// "Order by 20 December" for pre-orders, otherwise "Until 20 December".
export const untilText = (o) => (o.kind === 'preorder' ? `Order by ${niceDate(o.ends_on)}` : `Until ${niceDate(o.ends_on)}`);

// ---------- dashboard section ----------
export function offersPanel(offers, producerStatus, today = todayUK()) {
  return html`<section class="panel" aria-labelledby="offers-h">
    <div class="panelhead"><h2 id="offers-h">Your offers and specials</h2><a class="btn btn-ghost" href="/producer/offers/new">Add an offer</a></div>
    <p class="note">Your own offers, like multibuys, gift boxes and Christmas pre-orders. Anyone can use them, so they appear below your exclusive deals. They need to run for at least ${MIN_OFFER_DAYS} days.</p>
    ${offers.length ? html`<ul class="deals">${offers.map((o) => {
      const [state, label] = dealState(o, producerStatus, today);
      return html`<li class="deal">
        <div class="deal-main">
          <p class="deal-title"><b>${o.title}</b> <span class="tag tag-${state}">${label}</span>${o.christmas ? html` <span class="tag tag-xmas">Christmas</span>` : ''}</p>
          <p class="deal-meta">${kindText[o.kind]} · ${o.price} · ${howText[o.how]} · ${niceDate(o.starts_on)} to ${niceDate(o.ends_on)}${o.kind === 'preorder' ? ' (order by)' : ''}${o.alcohol ? ' · Adults only' : ''}</p>
        </div>
        <div class="deal-actions">
          ${state === 'ended' ? '' : html`<a class="btn btn-ghost btn-sm" href="/producer/offers/${o.id}/edit">Edit<span class="sr-only"> ${o.title}</span></a>`}
          ${state === 'live' || state === 'waiting' || state === 'scheduled' ? html`<form method="post" action="/producer/offers/${o.id}/status"><input type="hidden" name="to" value="paused" /><button class="btn btn-ghost btn-sm">Pause<span class="sr-only"> ${o.title}</span></button></form>` : ''}
          ${state === 'paused' ? html`<form method="post" action="/producer/offers/${o.id}/status"><input type="hidden" name="to" value="active" /><button class="btn btn-ghost btn-sm">Resume<span class="sr-only"> ${o.title}</span></button></form>` : ''}
          ${state !== 'ended' ? html`<form method="post" action="/producer/offers/${o.id}/status"><input type="hidden" name="to" value="ended" /><button class="btn btn-ghost btn-sm">End now<span class="sr-only">: ${o.title}</span></button></form>` : ''}
        </div>
      </li>`;
    })}</ul>` : html`<p>No offers yet.</p>`}
  </section>`;
}

// ---------- form ----------
function offerForm(env, user, v, { errors = [], id = null } = {}) {
  const err = (f) => errors.find((e) => e.field === f)?.msg;
  const radio = (name, val, label, hint = '') => html`<div class="radio"><input type="radio" id="${name}-${val}" name="${name}" value="${val}" ${v[name] === val ? raw('checked') : ''} ${hint ? html`aria-describedby="${name}-${val}-hint"` : ''} /><label for="${name}-${val}">${label}</label>${hint ? html`<p class="hint" id="${name}-${val}-hint">${hint}</p>` : ''}</div>`;
  const group = (name, legend, inner) => html`<fieldset class="field${err(name) ? ' has-error' : ''}"><legend>${legend}</legend>${err(name) ? html`<p class="error" id="${name}-err">${err(name)}</p>` : ''}${inner}</fieldset>`;
  return page(env, {
    title: id ? 'Edit offer' : 'Add an offer',
    user,
    status: errors.length ? 400 : 200,
    body: html`<div class="narrow">
      <p><a href="/producer">← Back to my listing</a></p>
      <h1>${id ? 'Edit your offer' : 'Add an offer or special'}</h1>
      <p class="sub">Your own offers, open to everyone. Running for at least ${MIN_OFFER_DAYS} days, with honest prices. Food and drink only, and no health claims.</p>
      <p>Want more attention? An <a href="/producer/deals/new">exclusive deal</a> for Roots &amp; Pantry families (at least 10% off or a free item) is shown first.</p>
      ${errorList(errors)}
      <form method="post" action="${id ? `/producer/offers/${id}/edit` : '/producer/offers/new'}" novalidate>
        ${group('kind', 'What kind of offer is it?', OFFER_KINDS.map(([k, l, h]) => radio('kind', k, l, h)))}
        ${field({ id: 'title', label: 'Headline', value: v.title, hint: 'Short and clear, like "4 sausages for £12.50" or "Order your Christmas turkey".', error: err('title'), max: 80 })}
        ${field({ id: 'price', label: 'Price', value: v.price, hint: 'Like "£12.50 for 4", "£20" or "From £45". If you show a "was" price, it must be one you have actually charged recently.', error: err('price'), max: 40 })}
        ${field({ id: 'details', label: 'Details', value: v.details, required: false, rows: 3, hint: 'What is included, sizes or weights, and any conditions like "while stocks last".', error: err('details'), max: 500 })}
        ${group('how', 'How do people buy it?', html`
          ${radio('how', 'online', 'Online, on my website')}
          ${radio('how', 'in_person', 'In person, at my shop or stall')}
          ${radio('how', 'both', 'Both')}`)}
        ${field({ id: 'order_url', label: 'Web page to order or find out more', type: 'url', value: v.order_url, required: false, hint: 'We use your website if you leave this empty.', error: err('order_url'), max: 300 })}
        <div class="two-dates">
          ${field({ id: 'starts_on', label: 'Starts', type: 'date', value: v.starts_on, error: err('starts_on'), max: 10 })}
          ${field({ id: 'ends_on', label: 'Ends (or the last day to order)', type: 'date', value: v.ends_on, hint: `At least ${MIN_OFFER_DAYS} days after it starts.`, error: err('ends_on'), max: 10 })}
        </div>
        ${field({ id: 'ready_text', label: 'For pre-orders: when is it ready?', value: v.ready_text, required: false, hint: 'For example "Collect 21 to 24 December" or "Delivered the week before Christmas".', error: err('ready_text'), max: 120 })}
        ${field({ id: 'allergens', label: 'Allergens', value: v.allergens, required: false, hint: 'For example: milk, nuts, gluten. People will be told to always check the label too.', error: err('allergens'), max: 200 })}
        <div class="field"><div class="check"><input type="checkbox" id="christmas" name="christmas" value="yes" ${v.christmas ? raw('checked') : ''} /><label for="christmas">Show it on our Christmas page</label></div></div>
        <div class="field"><div class="check"><input type="checkbox" id="alcohol" name="alcohol" value="yes" ${v.alcohol ? raw('checked') : ''} /><label for="alcohol">This includes alcohol (marked adults only)</label></div></div>
        <button class="btn btn-green" type="submit">${id ? 'Save offer' : 'Add offer'}</button>
      </form>
    </div>`,
  });
}

function readOffer(form) {
  return {
    kind: clean(form.get('kind'), 10), title: clean(form.get('title'), 80), price: clean(form.get('price'), 40), details: clean(form.get('details'), 500),
    how: clean(form.get('how'), 10), order_url: clean(form.get('order_url'), 300), starts_on: clean(form.get('starts_on'), 10), ends_on: clean(form.get('ends_on'), 10),
    ready_text: clean(form.get('ready_text'), 120), allergens: clean(form.get('allergens'), 200),
    christmas: form.get('christmas') === 'yes', alcohol: form.get('alcohol') === 'yes',
  };
}

export function validateOffer(v, { today = todayUK(), existingStart = null } = {}) {
  const errors = [];
  if (!OFFER_KINDS.some(([k]) => k === v.kind)) errors.push({ field: 'kind', msg: 'Choose what kind of offer it is' });
  if (v.title.length < 5) errors.push({ field: 'title', msg: 'Enter a short headline for your offer' });
  if (!/\d/.test(v.price)) errors.push({ field: 'price', msg: 'Enter the price, like "£12.50 for 4" or "From £45"' });
  if (!['online', 'in_person', 'both'].includes(v.how)) errors.push({ field: 'how', msg: 'Choose how people buy it' });
  if (!validUrl(v.order_url)) errors.push({ field: 'order_url', msg: 'Enter a full web address starting https://' });
  if (!isDate(v.starts_on)) errors.push({ field: 'starts_on', msg: 'Enter the start date' });
  else if (v.starts_on < today && v.starts_on !== existingStart) errors.push({ field: 'starts_on', msg: 'The start date cannot be in the past' });
  if (!isDate(v.ends_on)) errors.push({ field: 'ends_on', msg: 'Enter the end date' });
  else if (isDate(v.starts_on)) {
    if (daysBetween(v.starts_on, v.ends_on) < MIN_OFFER_DAYS) errors.push({ field: 'ends_on', msg: `Offers must run for at least ${MIN_OFFER_DAYS} days. End it on ${addDays(v.starts_on, MIN_OFFER_DAYS)} or later.` });
    if (daysBetween(v.starts_on, v.ends_on) > 366) errors.push({ field: 'ends_on', msg: 'Offers can run for up to a year.' });
  }
  if (HEALTH_CLAIMS.test(`${v.title} ${v.price} ${v.details} ${v.ready_text}`)) errors.push({ field: 'title', msg: 'Please remove health claims (words like "cures", "detox", "boosts immunity"). Our rules don\'t allow them.' });
  return errors;
}

const needsUrl = (v, p) => !v.order_url && v.how === 'online' && !p.website;

export async function getNewOffer(request, env, user, url) {
  const p = await getProducer(env, user.id);
  if (!p) return Response.redirect(new URL('/producer/join', request.url), 303);
  const t = todayUK();
  const xmas = url.searchParams.get('christmas') === '1';
  // Christmas pre-orders default to ordering by 20 December (if that's far enough away).
  const xmasEnd = `${t.slice(0, 4)}-12-20`;
  const ends = xmas && daysBetween(t, xmasEnd) >= MIN_OFFER_DAYS ? xmasEnd : addDays(t, 14);
  return offerForm(env, user, { kind: xmas ? 'preorder' : 'multibuy', how: p.shop_address || p.market_days ? 'in_person' : 'online', starts_on: t, ends_on: ends, christmas: xmas });
}

export async function postNewOffer(request, env, user, form) {
  const p = await getProducer(env, user.id);
  if (!p) return Response.redirect(new URL('/producer/join', request.url), 303);
  const v = readOffer(form);
  const errors = validateOffer(v);
  if (needsUrl(v, p)) errors.push({ field: 'order_url', msg: 'Add the web page where people can order' });
  const live = await env.DB.prepare("SELECT COUNT(*) AS n FROM offers WHERE producer_id = ? AND status != 'ended' AND ends_on >= ?").bind(p.id, todayUK()).first();
  if (live.n >= MAX_LIVE_OFFERS) errors.push({ field: 'title', msg: `You can have up to ${MAX_LIVE_OFFERS} offers at once. End one first.` });
  if (errors.length) return offerForm(env, user, v, { errors });
  const id = randomId();
  const t = now();
  await env.DB.prepare(
    `INSERT INTO offers (id, producer_id, kind, title, price, details, ready_text, how, order_url, allergens, alcohol, christmas, starts_on, ends_on, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)`,
  ).bind(id, p.id, v.kind, v.title, v.price, v.details || null, v.ready_text || null, v.how, v.order_url || null, v.allergens || null, v.alcohol ? 1 : 0, v.christmas ? 1 : 0, v.starts_on, v.ends_on, t, t).run();
  await audit(env, user.id, 'offer.created', id, { producer: p.id });
  await queueOffer(env, p, { id, starts_on: v.starts_on, alcohol: v.alcohol });
  return Response.redirect(new URL('/producer?done=offer', request.url), 303);
}

export async function getEditOffer(request, env, user, id) {
  const p = await getProducer(env, user.id);
  const o = p && (await getOffer(env, p.id, id));
  if (!o) return null;
  return offerForm(env, user, { ...o, alcohol: !!o.alcohol, christmas: !!o.christmas, details: o.details || '', ready_text: o.ready_text || '', order_url: o.order_url || '', allergens: o.allergens || '' }, { id });
}

export async function postEditOffer(request, env, user, id, form) {
  const p = await getProducer(env, user.id);
  const o = p && (await getOffer(env, p.id, id));
  if (!o) return null;
  if (o.status === 'ended') return Response.redirect(new URL('/producer', request.url), 303);
  const v = readOffer(form);
  const errors = validateOffer(v, { existingStart: o.starts_on });
  if (needsUrl(v, p)) errors.push({ field: 'order_url', msg: 'Add the web page where people can order' });
  if (errors.length) return offerForm(env, user, v, { errors, id });
  await env.DB.prepare(
    `UPDATE offers SET kind = ?, title = ?, price = ?, details = ?, ready_text = ?, how = ?, order_url = ?, allergens = ?, alcohol = ?, christmas = ?, starts_on = ?, ends_on = ?, updated_at = ?
     WHERE id = ? AND producer_id = ?`,
  ).bind(v.kind, v.title, v.price, v.details || null, v.ready_text || null, v.how, v.order_url || null, v.allergens || null, v.alcohol ? 1 : 0, v.christmas ? 1 : 0, v.starts_on, v.ends_on, now(), id, p.id).run();
  await audit(env, user.id, 'offer.edited', id);
  return Response.redirect(new URL('/producer?done=offer', request.url), 303);
}

export async function postOfferStatus(request, env, user, id, form) {
  const p = await getProducer(env, user.id);
  const o = p && (await getOffer(env, p.id, id));
  if (!o) return null;
  const to = form.get('to');
  if (!['paused', 'active', 'ended'].includes(to) || o.status === 'ended') return Response.redirect(new URL('/producer', request.url), 303);
  await env.DB.prepare('UPDATE offers SET status = ?, updated_at = ? WHERE id = ?').bind(to, now(), id).run();
  await audit(env, user.id, `offer.${to}`, id);
  return Response.redirect(new URL(`/producer?done=offer-${to === 'active' ? 'resumed' : to}`, request.url), 303);
}

// ---------- public ----------
export function offerItem(o, p) {
  const link = o.order_url || p.website;
  return html`<li class="offer" id="offer-${o.id}">
    <p class="offer-title"><b>${o.title}</b> <span class="offer-price">${o.price}</span></p>
    <p class="deal-meta">${kindText[o.kind]} · ${howText[o.how]} · ${untilText(o)}${o.alcohol ? ' · Adults only' : ''}</p>
    ${o.details ? html`<p>${o.details}</p>` : ''}
    ${o.ready_text ? html`<p><b>Ready:</b> ${o.ready_text}</p>` : ''}
    ${o.allergens ? html`<p class="deal-meta">Allergens: ${o.allergens}. Always check the label.</p>` : ''}
    ${link && o.how !== 'in_person' ? html`<p><a href="${link}" rel="noopener nofollow">Order or find out more<span class="sr-only">: ${o.title}</span></a></p>` : ''}
  </li>`;
}

export const offersSection = (offers, p) => (offers.length ? html`<section class="panel" aria-labelledby="offers-h">
    <h2 id="offers-h">Offers and specials</h2>
    <ul class="plain offers">${offers.map((o) => offerItem(o, p))}</ul>
  </section>` : '');

// ---------- Christmas page ----------
export async function christmasPage(request, env, user, url) {
  const today = todayUK();
  const nearRaw = url.searchParams.get('near') || '';
  const milesParam = Number(url.searchParams.get('miles'));
  const miles = RADII.includes(milesParam) ? milesParam : 25;
  const near = parseNear(nearRaw);
  if (near?.full) return Response.redirect(new URL(`/producers/christmas?near=${near.outcode}&miles=${miles}`, url), 303);

  const cols = `p.slug, p.business_name, p.website, p.delivery_reach, p.delivery_miles, p.county, p.district, d.lat, d.lng, d.town`;
  const from = (t, a) => `FROM ${t} ${a} JOIN producers p ON p.id = ${a}.producer_id LEFT JOIN postcode_districts d ON d.outcode = p.district
    WHERE p.status = 'approved' AND ${a}.status = 'active' AND ${a}.christmas = 1 AND ${a}.starts_on <= ?1 AND ${a}.ends_on >= ?1`;
  const [offers, deals] = await Promise.all([
    env.DB.prepare(`SELECT o.*, ${cols} ${from('offers', 'o')}`).bind(today).all().then((r) => r.results),
    env.DB.prepare(`SELECT x.*, ${cols} ${from('deals', 'x')}`).bind(today).all().then((r) => r.results),
  ]);

  let here = null;
  let error = '';
  if (near && !near.invalid) {
    here = await env.DB.prepare('SELECT outcode, lat, lng, town FROM postcode_districts WHERE outcode = ?').bind(near.outcode).first();
    if (!here) error = `We don't recognise ${near.outcode}. Check it, or try a district next to yours.`;
  } else if (near?.invalid) error = 'Enter a postcode like TF1 2EB, or a district like TF1';

  let items = [...deals.map((x) => ({ ...x, isDeal: true })), ...offers];
  if (here) {
    items = items.filter((i) => i.lat !== null).map((i) => ({ ...i, miles: milesBetween(here, i) }))
      .filter((i) => i.miles <= miles || deliversTo(i, i.miles));
  }
  items.sort((a, b) => (a.isDeal === b.isDeal ? 0 : a.isDeal ? -1 : 1) || a.ends_on.localeCompare(b.ends_on) || a.business_name.localeCompare(b.business_name));

  const where = (i) => html`<a href="/p/${i.slug}">${i.business_name}</a>, ${i.town ? `${i.town}, ` : ''}${i.district || ''}${i.miles !== undefined ? ` · about ${Math.max(1, Math.round(i.miles))} miles${i.miles > miles ? ', delivers to you' : ''}` : ''}`;
  return page(env, {
    title: 'Christmas from local producers',
    user,
    og: { title: 'Christmas from local producers | Roots & Pantry', description: 'Turkeys, hampers, cakes and gifts from independent farms, bakers and makers. Search by postcode and order before the order-by dates.', path: '/producers/christmas', image: 'christmas' },
    status: error ? 400 : 200,
    body: html`<div class="dir">
      <h1>Christmas from local producers</h1>
      <p class="sub">Turkeys, hampers, cakes and gifts from independent farms, bakers and makers near you. Order soon: the earliest order-by dates are first.</p>
      <form method="get" action="/producers/christmas" class="panel finder" novalidate>
        <div class="field${error ? ' has-error' : ''}">
          <label for="near">Your postcode or postcode district</label>
          <p class="hint" id="near-hint">Like TF1 or TF1 2EB. We only use the first half.</p>
          ${error ? html`<p class="error" id="near-err">${error}</p>` : ''}
          <input type="text" id="near" name="near" value="${here ? here.outcode : nearRaw.slice(0, 10)}" maxlength="10" autocomplete="postal-code" aria-describedby="near-hint${error ? ' near-err' : ''}" ${error ? raw('aria-invalid="true"') : ''} />
        </div>
        <div class="field">
          <label for="miles">How far?</label>
          <select id="miles" name="miles">${RADII.map((r) => html`<option value="${r}" ${r === miles ? raw('selected') : ''}>Within ${r} miles</option>`)}</select>
        </div>
        <button class="btn btn-green" type="submit">Show Christmas offers</button>
        ${here ? html` <a class="btn btn-ghost" href="/producers/christmas">Show everywhere</a>` : ''}
      </form>
      <section aria-labelledby="xmas-h">
        <h2 id="xmas-h">${items.length ? `${items.length} Christmas ${items.length === 1 ? 'offer' : 'offers'}${here ? ` near ${here.outcode}` : ''}` : 'No Christmas offers here yet'}</h2>
        ${items.length ? html`<ul class="plain offers xmas">${items.map((i) => (i.isDeal
          ? html`<li class="offer offer-deal">
              <p class="offer-title"><span class="tag tag-live">Roots &amp; Pantry exclusive</span> <b>${i.title}</b> <span class="offer-price">${offerText(i)}</span></p>
              <p class="deal-meta">${where(i)} · ${howText[i.how]} · Until ${niceDate(i.ends_on)}${i.alcohol ? ' · Adults only' : ''}</p>
              <p class="deal-meta">Families see how to claim it in the Roots &amp; Pantry app.</p>
            </li>`
          : html`<li class="offer">
              <p class="offer-title"><b>${i.title}</b> <span class="offer-price">${i.price}</span></p>
              <p class="deal-meta">${where(i)} · ${kindText[i.kind]} · ${untilText(i)}${i.alcohol ? ' · Adults only' : ''}</p>
              ${i.details ? html`<p>${i.details}</p>` : ''}
              ${i.ready_text ? html`<p><b>Ready:</b> ${i.ready_text}</p>` : ''}
              ${(i.order_url || i.website) && i.how !== 'in_person' ? html`<p><a href="${i.order_url || i.website}" rel="noopener nofollow">Order or find out more<span class="sr-only">: ${i.title}, ${i.business_name}</span></a></p>` : ''}
            </li>`))}</ul>` : html`<p>Producers are adding their Christmas orders now. Please check back soon, or <a href="/producers">browse all local producers</a>.</p>`}
      </section>
      <p class="note">Are you a local food or drink producer? <a href="${env.SITE_URL}/for-producers/">List your Christmas orders free</a>.</p>
    </div>`,
  });
}
