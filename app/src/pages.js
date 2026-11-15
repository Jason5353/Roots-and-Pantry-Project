// Home, contact form and producer sign-up.
import { html, now, randomId, clean, normEmail, validEmail, validUrl, normPostcode, sha256 } from './util.js';
import { page, turnstileWidget, errorList, field, select } from './layout.js';
import { verifyTurnstile, sendEmail, rateLimit, audit } from './services.js';
import { getProducer, makeSlug } from './producer.js';

export const TERMS_VERSION = '2026-11-v1'; // approved by Jason 15 Nov 2026; full text site/src/pages/producer-terms.astro

export { COUNTIES } from './data.js';
import { COUNTIES } from './data.js';

const TOPICS = ['General question', 'Listing my business', 'Nominate a producer', 'Press', 'Report a problem', 'Accessibility', 'Something else'];

export function home(env, user) {
  return page(env, {
    title: 'Welcome',
    user,
    body: html`<div class="narrow">
      <h1>Welcome to Roots &amp; Pantry</h1>
      <div class="cards">
        <section class="panel">
          <h2>Local food producers</h2>
          <p>List your business and a deal for free. Families near you will see it beside matching recipes.</p>
          <a class="btn btn-green" href="${user ? '/producer' : '/signin?next=/producer'}">${user ? 'Go to my listing' : 'List my business'}</a>
        </section>
        <section class="panel">
          <h2>Families</h2>
          <p>Family sign-up opens soon. In the meantime, try the demo.</p>
          <a class="btn btn-ghost" href="https://roots-and-pantry-demo.pages.dev/">Try the demo</a>
        </section>
      </div>
      <p class="note">Questions? <a href="/contact">Contact us</a>.</p>
    </div>`,
  });
}

// ---------- contact ----------

function contactForm(env, user, { values = {}, errors = [], sent = false } = {}) {
  const err = (f) => errors.find((e) => e.field === f)?.msg;
  if (sent) {
    return page(env, { title: 'Message sent', user, body: html`<div class="narrow"><h1>Thanks, your message is on its way</h1><p class="sub">We aim to reply within 5 working days.</p><p><a class="btn btn-ghost" href="${env.SITE_URL}">Back to Roots &amp; Pantry</a></p></div>` });
  }
  return page(env, {
    title: 'Contact us',
    user,
    turnstile: true,
    status: errors.length ? 400 : 200,
    body: html`<div class="narrow">
      <h1>Contact us</h1>
      <p class="sub">Questions, producer enquiries, press or problems. A real person reads every message, and we aim to reply within 5 working days.</p>
      ${errorList(errors)}
      <form method="post" action="/contact" novalidate>
        ${field({ id: 'name', label: 'Your name', value: values.name, autocomplete: 'name', error: err('name'), max: 100 })}
        ${field({ id: 'email', label: 'Your email address', type: 'email', value: values.email, autocomplete: 'email', hint: "We'll only use it to reply.", error: err('email'), max: 254 })}
        ${select({ id: 'topic', label: 'What is it about?', options: TOPICS, value: values.topic, error: err('topic') })}
        ${field({ id: 'message', label: 'Your message', value: values.message, rows: 7, max: 4000, error: err('message') })}
        <div class="hp" aria-hidden="true"><label for="website">Leave this empty</label><input id="website" name="website" tabindex="-1" autocomplete="off" /></div>
        ${turnstileWidget(env)}
        <button class="btn btn-red" type="submit">Send message</button>
      </form>
      <p class="note">Prefer email? Write to <b>hello@rootsandpantry.co.uk</b>. See how we handle your details in our <a href="${env.SITE_URL}/privacy-and-terms/">privacy notice</a>.</p>
    </div>`,
  });
}

export const getContact = (request, env, user, url) => contactForm(env, user, { values: { topic: TOPICS.includes(url.searchParams.get('topic')) ? url.searchParams.get('topic') : '' } });

export async function postContact(request, env, user, form) {
  const values = {
    name: clean(form.get('name'), 100),
    email: normEmail(form.get('email')),
    topic: clean(form.get('topic'), 60),
    message: clean(form.get('message'), 4000),
  };
  if (form.get('website')) return contactForm(env, user, { sent: true }); // honeypot: pretend success
  const errors = [];
  if (!values.name) errors.push({ field: 'name', msg: 'Enter your name' });
  if (!validEmail(values.email)) errors.push({ field: 'email', msg: 'Enter a valid email address, like name@example.co.uk' });
  if (!TOPICS.includes(values.topic)) errors.push({ field: 'topic', msg: 'Choose what your message is about' });
  if (values.message.length < 5) errors.push({ field: 'message', msg: 'Enter your message' });
  if (errors.length) return contactForm(env, user, { values, errors });
  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  if (!(await verifyTurnstile(env, form.get('cf-turnstile-response'), ip))) {
    return contactForm(env, user, { values, errors: [{ field: 'message', msg: "We couldn't confirm you're not a robot. Please try again." }] });
  }
  if (!(await rateLimit(env, `contact:ip:${await sha256(ip)}`, 5, 3600))) {
    return contactForm(env, user, { values, errors: [{ field: 'message', msg: 'Too many messages from here in the last hour. Please try later or email us.' }] });
  }
  const id = randomId();
  await env.DB.prepare('INSERT INTO messages (id, name, email, topic, body, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .bind(id, values.name, values.email, values.topic, values.message, now()).run();
  await sendEmail(env, {
    to: env.NOTIFY_EMAIL,
    replyTo: values.email,
    subject: `[Contact] ${values.topic}: ${values.name}`,
    text: `New message from the Roots & Pantry contact form.\n\nName: ${values.name}\nEmail: ${values.email}\nTopic: ${values.topic}\n\n${values.message}\n\n(Reply to this email to answer them. Message ID ${id})`,
  });
  return contactForm(env, user, { sent: true });
}

// ---------- producers ----------

function joinForm(env, user, { values = {}, errors = [] } = {}) {
  const err = (f) => errors.find((e) => e.field === f)?.msg;
  return page(env, {
    title: 'List your business',
    user,
    status: errors.length ? 400 : 200,
    body: html`<div class="narrow">
      <h1>List your business</h1>
      <p class="sub">Free, forever. We check every listing by hand before it goes live, usually within a few days.</p>
      ${errorList(errors)}
      <form method="post" action="/producer/join" novalidate>
        ${field({ id: 'business_name', label: 'Business name', value: values.business_name, autocomplete: 'organization', error: err('business_name'), max: 100 })}
        ${field({ id: 'contact_name', label: 'Your name', value: values.contact_name, autocomplete: 'name', error: err('contact_name'), max: 100 })}
        ${field({ id: 'phone', label: 'Phone number', type: 'tel', value: values.phone, autocomplete: 'tel', hint: 'Only for us to contact you. Never shown publicly.', error: err('phone'), max: 30 })}
        ${field({ id: 'description', label: 'What do you make or sell?', value: values.description, rows: 4, max: 600, hint: 'A few sentences. This will appear on your public listing.', error: err('description') })}
        ${field({ id: 'website', label: 'Website', type: 'url', value: values.website, required: false, autocomplete: 'url', hint: 'Starting https://', error: err('website'), max: 300 })}
        ${field({ id: 'facebook', label: 'Facebook page', type: 'url', value: values.facebook, required: false, hint: 'The full link, like https://www.facebook.com/yourbusiness', error: err('facebook'), max: 300 })}
        ${field({ id: 'postcode', label: 'Business postcode', value: values.postcode, autocomplete: 'postal-code', hint: 'Used to show your deals to families nearby. Market stalls: use your usual market.', error: err('postcode'), max: 10 })}
        ${select({ id: 'county', label: 'County', options: COUNTIES, value: values.county, error: err('county') })}
        ${field({ id: 'hygiene_link', label: 'Food hygiene rating link', type: 'url', value: values.hygiene_link, required: false, hint: 'From ratings.food.gov.uk, if you have one.', error: err('hygiene_link'), max: 300 })}
        <div class="field${err('terms') ? ' has-error' : ''}">
          ${err('terms') ? html`<p class="error" id="terms-err">${err('terms')}</p>` : ''}
          <div class="check"><input type="checkbox" id="terms" name="terms" value="yes" ${values.terms ? html`checked` : ''} ${err('terms') ? html`aria-invalid="true" aria-describedby="terms-err"` : ''} />
          <label for="terms">I'm 18 or over, I can act for this business, and I agree to the <a href="${env.SITE_URL}/producer-terms/" target="_blank" rel="noopener">producer terms<span class="sr-only"> (opens in a new tab)</span></a>: food and drink only; deals of at least 10% off or a free item for at least 14 days; codes that work; honest offers; no health claims.</label></div>
        </div>
        <button class="btn btn-green" type="submit">Send for approval</button>
      </form>
    </div>`,
  });
}

export async function getJoin(request, env, user) {
  if (await getProducer(env, user.id)) return Response.redirect(new URL('/producer', request.url), 303);
  if (env.PRODUCER_SIGNUP_OPEN !== 'true') return page(env, { title: 'Opening soon', user, body: html`<div class="narrow"><h1>Producer sign-up opens soon</h1><p>Email hello@rootsandpantry.co.uk to register your interest.</p></div>` });
  return joinForm(env, user);
}

export async function postJoin(request, env, user, form) {
  if (await getProducer(env, user.id)) return Response.redirect(new URL('/producer', request.url), 303);
  if (env.PRODUCER_SIGNUP_OPEN !== 'true') return getJoin(request, env, user);
  const v = {
    business_name: clean(form.get('business_name'), 100),
    contact_name: clean(form.get('contact_name'), 100),
    phone: clean(form.get('phone'), 30),
    description: clean(form.get('description'), 600),
    website: clean(form.get('website'), 300),
    facebook: clean(form.get('facebook'), 300),
    postcode: clean(form.get('postcode'), 10),
    county: clean(form.get('county'), 60),
    hygiene_link: clean(form.get('hygiene_link'), 300),
    terms: form.get('terms') === 'yes',
  };
  const errors = [];
  if (!v.business_name) errors.push({ field: 'business_name', msg: 'Enter your business name' });
  if (!v.contact_name) errors.push({ field: 'contact_name', msg: 'Enter your name' });
  if (!/^[0-9+()\s-]{10,30}$/.test(v.phone)) errors.push({ field: 'phone', msg: 'Enter a phone number, like 01952 123456' });
  if (v.description.length < 20) errors.push({ field: 'description', msg: 'Tell families a little about what you make or sell (at least 20 characters)' });
  if (!validUrl(v.website)) errors.push({ field: 'website', msg: 'Enter a full web address starting https://' });
  if (v.facebook && !(validUrl(v.facebook) && /^(www\.|m\.)?(facebook|fb)\.com$/i.test(new URL(v.facebook).hostname))) errors.push({ field: 'facebook', msg: 'Enter the full link to your Facebook page, starting https://www.facebook.com/' });
  const pc = normPostcode(v.postcode);
  if (!pc) errors.push({ field: 'postcode', msg: 'Enter a full UK postcode, like TF1 2EB' });
  if (!COUNTIES.includes(v.county)) errors.push({ field: 'county', msg: 'Choose your county' });
  if (!validUrl(v.hygiene_link)) errors.push({ field: 'hygiene_link', msg: 'Enter a full web address starting https://' });
  if (!v.terms) errors.push({ field: 'terms', msg: 'Tick the box to confirm you are 18 or over and agree to the producer terms' });
  if (errors.length) return joinForm(env, user, { values: v, errors });

  const t = now();
  const id = randomId();
  const slug = await makeSlug(env, v.business_name, id);
  await env.DB.prepare(
    `INSERT INTO producers (id, user_id, slug, business_name, contact_name, phone, website, facebook, postcode, district, county, description, hygiene_link, status, terms_version, terms_accepted_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?)`,
  ).bind(id, user.id, slug, v.business_name, v.contact_name, v.phone, v.website || null, v.facebook || null, pc, pc.split(' ')[0], v.county, v.description, v.hygiene_link || null, TERMS_VERSION, t, t, t).run();
  await audit(env, user.id, 'producer.created', id, { business: v.business_name, county: v.county });
  await sendEmail(env, {
    to: env.NOTIFY_EMAIL,
    replyTo: user.email,
    subject: `[New producer] ${v.business_name} (${v.county})`,
    text: `A new producer has signed up and is waiting for approval.\n\nBusiness: ${v.business_name}\nContact: ${v.contact_name}\nEmail: ${user.email}\nPhone: ${v.phone}\nPostcode: ${pc}, ${v.county}\nWebsite: ${v.website || 'none'}\nFacebook: ${v.facebook || 'none'}\nHygiene rating: ${v.hygiene_link || 'none'}\n\n${v.description}\n\nReview it in the admin dashboard: ${new URL(request.url).origin}/admin/producers/${id}`,
  });
  await sendEmail(env, {
    to: user.email,
    subject: 'Thanks for joining Roots & Pantry',
    text: `Hi ${v.contact_name},\n\nThanks for listing ${v.business_name} on Roots & Pantry. We check every listing by hand and will email you when it's live, usually within a few days.\n\nAny questions, just reply to this email.\n\nJason\nRoots & Pantry`,
  });
  return Response.redirect(new URL('/producer', request.url), 303);
}
