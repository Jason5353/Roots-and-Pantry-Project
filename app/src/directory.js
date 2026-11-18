// Public producer directory: search by postcode district (distance) or browse by county.
// Privacy: we only ever use the first half of a postcode (the district, e.g. TF1). A full postcode
// typed into the search is cut down and the page redirects, so it doesn't stay in the address bar.
import { html, raw } from './util.js';
import { page } from './layout.js';
import { COUNTIES } from './data.js';
import { todayUK } from './producer.js';

export const RADII = [5, 10, 15, 20, 25, 30, 35, 40, 45, 50];
const DEFAULT_MILES = 25;
export const LOCAL_DELIVERY_MILES = 15; // what "local delivery only" counts as

export function parseNear(v) {
  const s = String(v || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (!s) return null;
  if (/^[A-Z]{1,2}[0-9][A-Z0-9]?[0-9][A-Z]{2}$/.test(s)) return { outcode: s.slice(0, -3), full: true };
  if (/^[A-Z]{1,2}[0-9][A-Z0-9]?$/.test(s)) return { outcode: s, full: false };
  return { invalid: true };
}

export function milesBetween(a, b) {
  const rad = (d) => (d * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat), dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 3958.8 * 2 * Math.asin(Math.sqrt(h));
}

export function deliversTo(p, miles) {
  if (p.delivery_reach === 'uk') return true;
  if (p.delivery_reach === 'miles') return miles <= (p.delivery_miles || 0);
  if (p.delivery_reach === 'local') return miles <= LOCAL_DELIVERY_MILES;
  return false;
}

const distanceText = (m) => (m < 1 ? 'under a mile away' : `about ${Math.round(m)} ${Math.round(m) === 1 ? 'mile' : 'miles'} away`);
const short = (s, n = 180) => (s.length > n ? `${s.slice(0, n).replace(/\s+\S*$/, '')}…` : s);

export async function approvedProducers(env) {
  const today = todayUK();
  return env.DB.prepare(
    `SELECT p.slug, p.business_name, p.description, p.county, p.district, p.delivery_reach, p.delivery_miles, p.shop_address, p.market_days, p.website,
       d.lat, d.lng, d.town,
       (SELECT COUNT(*) FROM deals x WHERE x.producer_id = p.id AND x.status = 'active' AND x.starts_on <= ?1 AND x.ends_on >= ?1) AS deals,
       (SELECT COUNT(*) FROM offers o WHERE o.producer_id = p.id AND o.status = 'active' AND o.starts_on <= ?1 AND o.ends_on >= ?1) AS offers,
       (SELECT COUNT(*) FROM offers o WHERE o.producer_id = p.id AND o.status = 'active' AND o.christmas = 1 AND o.starts_on <= ?1 AND o.ends_on >= ?1) AS xmas
     FROM producers p LEFT JOIN postcode_districts d ON d.outcode = p.district
     WHERE p.status = 'approved'`,
  ).bind(today).all().then((r) => r.results);
}

function card(p, { miles = null, headingLevel = 3 } = {}) {
  const tags = [];
  if (p.deals) tags.push(`${p.deals} ${p.deals === 1 ? 'deal' : 'deals'} for families`);
  if (p.offers) tags.push(`${p.offers} ${p.offers === 1 ? 'offer' : 'offers'}`);
  if (p.xmas) tags.push('Christmas orders');
  if (p.delivery_reach === 'uk') tags.push('Delivers UK-wide');
  else if (p.delivery_reach === 'miles') tags.push(`Delivers within ${p.delivery_miles} miles`);
  else if (p.delivery_reach === 'local') tags.push('Local delivery');
  if (p.shop_address) tags.push('Shop');
  if (p.market_days) tags.push('Markets');
  const h = raw(`h${headingLevel}`);
  return html`<li class="pcard">
    <${h} class="pcard-name"><a href="/p/${p.slug}">${p.business_name}</a></${h}>
    <p class="pcard-where">${p.town ? `${p.town}, ` : ''}${p.district || ''} · ${p.county}${miles !== null ? ` · ${distanceText(miles)}` : ''}</p>
    <p class="pcard-desc">${short(p.description)}</p>
    ${tags.length ? html`<ul class="pcard-tags">${tags.map((t) => html`<li>${t}</li>`)}</ul>` : ''}
  </li>`;
}

function searchForms(env, { near = '', miles = DEFAULT_MILES, county = '', error = '' }) {
  return html`<div class="cards finders">
    <form method="get" action="/producers" class="panel finder" novalidate>
      <h2>Near you</h2>
      <div class="field${error ? ' has-error' : ''}">
        <label for="near">Your postcode or postcode district</label>
        <p class="hint" id="near-hint">Like TF1 or TF1 2EB. We only use the first half.</p>
        ${error ? html`<p class="error" id="near-err">${error}</p>` : ''}
        <input type="text" id="near" name="near" value="${near}" maxlength="10" autocomplete="postal-code" aria-describedby="near-hint${error ? ' near-err' : ''}" ${error ? raw('aria-invalid="true"') : ''} />
      </div>
      <div class="field">
        <label for="miles">How far?</label>
        <select id="miles" name="miles">${RADII.map((r) => html`<option value="${r}" ${r === miles ? raw('selected') : ''}>Within ${r} miles</option>`)}</select>
      </div>
      <button class="btn btn-green" type="submit">Find producers</button>
    </form>
    <form method="get" action="/producers" class="panel finder" novalidate>
      <h2>By county</h2>
      <div class="field">
        <label for="county">County</label>
        <select id="county" name="county"><option value="">Choose…</option>${COUNTIES.map((c) => html`<option value="${c}" ${c === county ? raw('selected') : ''}>${c}</option>`)}</select>
      </div>
      <button class="btn btn-ghost" type="submit">Show producers</button>
    </form>
  </div>`;
}

// Christmas page link, shown in November and December only.
const christmasLink = (today = todayUK()) => (['11', '12'].includes(today.slice(5, 7)) ? html`<p class="callout"><b>Christmas:</b> <a href="/producers/christmas">See Christmas orders and gifts from local producers</a>.</p>` : '');

const nominate = (env) => html`<p>Know a great local food or drink producer? <a href="/contact?topic=${encodeURIComponent('Nominate a producer')}">Nominate them</a> and we'll get in touch.</p>`;

function directoryPage(env, user, { title = 'Local producers', status = 200, body }) {
  return page(env, {
    title,
    user,
    status,
    body: html`<div class="dir">
      <h1>Local food producers</h1>
      <p class="sub">Independent farms, bakers, makers and shops with deals for Roots &amp; Pantry families.</p>
      ${christmasLink()}
      ${body}
      <p class="note">Distances are measured between the middle of each postcode district, so they're approximate.</p>
    </div>`,
  });
}

export async function directory(request, env, user, url) {
  const nearRaw = url.searchParams.get('near') || '';
  const milesParam = Number(url.searchParams.get('miles'));
  const miles = RADII.includes(milesParam) ? milesParam : DEFAULT_MILES;
  const county = COUNTIES.includes(url.searchParams.get('county')) ? url.searchParams.get('county') : '';
  const near = parseNear(nearRaw);

  // Cut a full postcode down to its district and redirect, so the full postcode isn't kept.
  if (near?.full) return Response.redirect(new URL(`/producers?near=${near.outcode}&miles=${miles}`, url), 303);

  if (near && !near.invalid) {
    const here = await env.DB.prepare('SELECT outcode, lat, lng, town FROM postcode_districts WHERE outcode = ?').bind(near.outcode).first();
    if (!here) {
      return directoryPage(env, user, { status: 400, body: searchForms(env, { near: near.outcode, miles, error: `We don't recognise ${near.outcode}. Check it, try a district next to yours, or choose your county.` }) });
    }
    const all = (await approvedProducers(env)).filter((p) => p.lat !== null).map((p) => ({ ...p, miles: milesBetween(here, p) }));
    const nearby = all.filter((p) => p.miles <= miles).sort((a, b) => a.miles - b.miles);
    const delivers = all.filter((p) => p.miles > miles && deliversTo(p, p.miles)).sort((a, b) => a.miles - b.miles);
    const place = here.town ? `${here.outcode} (${here.town})` : here.outcode;
    return directoryPage(env, user, {
      title: `Producers near ${here.outcode}`,
      body: html`${searchForms(env, { near: here.outcode, miles })}
        <section aria-labelledby="near-h">
          <h2 id="near-h">${nearby.length} ${nearby.length === 1 ? 'producer' : 'producers'} within ${miles} miles of ${place}</h2>
          <p><a class="btn btn-ghost btn-sm" href="/producers/map?near=${here.outcode}&amp;miles=${miles}">Show on a map</a></p>
          ${nearby.length ? html`<ul class="pcards">${nearby.map((p) => card(p, { miles: p.miles }))}</ul>` : html`<p>None yet.${miles < 50 ? ' Try a bigger distance.' : ''}</p>${nominate(env)}`}
        </section>
        ${delivers.length ? html`<section aria-labelledby="del-h">
          <h2 id="del-h">Further away, but they deliver to you</h2>
          <ul class="pcards">${delivers.map((p) => card(p, { miles: p.miles }))}</ul>
        </section>` : ''}`,
    });
  }

  if (county) {
    const list = (await approvedProducers(env)).filter((p) => p.county === county).sort((a, b) => a.business_name.localeCompare(b.business_name));
    return directoryPage(env, user, {
      title: `Producers in ${county}`,
      body: html`${searchForms(env, { county })}
        <section aria-labelledby="county-h">
          <h2 id="county-h">${list.length} ${list.length === 1 ? 'producer' : 'producers'} in ${county}</h2>
          <p><a class="btn btn-ghost btn-sm" href="/producers/map?county=${encodeURIComponent(county)}">Show on a map</a></p>
          ${list.length ? html`<ul class="pcards">${list.map((p) => card(p))}</ul>` : html`<p>No producers here yet.</p>${nominate(env)}`}
        </section>`,
    });
  }

  const counts = await env.DB.prepare("SELECT county, COUNT(*) AS n FROM producers WHERE status = 'approved' GROUP BY county ORDER BY county").all().then((r) => r.results);
  return directoryPage(env, user, {
    status: near?.invalid ? 400 : 200,
    body: html`${searchForms(env, { near: nearRaw.slice(0, 10), miles, error: near?.invalid ? 'Enter a postcode like TF1 2EB, or a district like TF1' : '' })}
      <section aria-labelledby="where-h">
        <h2 id="where-h">Where we have producers</h2>
        <p><a class="btn btn-ghost btn-sm" href="/producers/map">See them all on a map</a></p>
        ${counts.length ? html`<ul class="countylist">${counts.map((c) => html`<li><a href="/producers?county=${encodeURIComponent(c.county)}">${c.county}</a> (${c.n})</li>`)}</ul>` : html`<p>We're just getting started in Shropshire.</p>`}
        ${nominate(env)}
      </section>`,
  });
}
