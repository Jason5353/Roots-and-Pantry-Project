// Roots & Pantry app Worker: routing, CSRF checks and error handling.
import { html } from './util.js';
import { page } from './layout.js';
import { loadUser, getSignin, postSignin, postCode, postSignout } from './auth.js';
import { home, getContact, postContact, producerHome, getJoin, postJoin } from './pages.js';

const MAX_BODY = 32 * 1024;

// Reject cross-site form posts (CSRF). Browsers send Sec-Fetch-Site and/or Origin on POST.
function sameOrigin(request, url) {
  const site = request.headers.get('Sec-Fetch-Site');
  if (site && site !== 'same-origin' && site !== 'none') return false;
  const origin = request.headers.get('Origin');
  if (origin && origin !== url.origin) return false;
  return Boolean(site || origin);
}

function notFound(env, user) {
  return page(env, { title: 'Not found', user, status: 404, body: html`<div class="narrow"><h1>We can't find that page</h1><p><a href="/">Go to the start</a></p></div>` });
}

async function handle(request, env, ctx) {
  const url = new URL(request.url);
  if (env.DEV === 'true' && url.hostname.endsWith('rootsandpantry.co.uk')) {
    return new Response('Misconfigured: DEV mode is not allowed here', { status: 500 });
  }
  const user = await loadUser(request, env);
  const path = url.pathname.replace(/\/+$/, '') || '/';
  const method = request.method;

  let form = null;
  if (method === 'POST') {
    if (!sameOrigin(request, url)) return new Response('Forbidden', { status: 403 });
    const len = Number(request.headers.get('Content-Length') || 0);
    if (len > MAX_BODY) return new Response('Too large', { status: 413 });
    const type = request.headers.get('Content-Type') || '';
    if (!type.startsWith('application/x-www-form-urlencoded') && !type.startsWith('multipart/form-data')) return new Response('Unsupported', { status: 415 });
    form = await request.formData();
  } else if (method !== 'GET' && method !== 'HEAD') {
    return new Response('Method not allowed', { status: 405, headers: { Allow: 'GET, POST' } });
  }

  const needUser = () => Response.redirect(new URL(`/signin?next=${encodeURIComponent(path)}`, url), 303);

  switch (`${method === 'HEAD' ? 'GET' : method} ${path}`) {
    case 'GET /': return home(env, user);
    case 'GET /contact': return getContact(request, env, user, url);
    case 'POST /contact': return postContact(request, env, user, form);
    case 'GET /signin': return user ? Response.redirect(new URL('/producer', url), 303) : getSignin(request, env, url);
    case 'POST /signin': return postSignin(request, env, form);
    case 'POST /signin/code': return postCode(request, env, form);
    case 'POST /signout': return postSignout(request, env, user);
    case 'GET /producer': return user ? producerHome(request, env, user) : needUser();
    case 'GET /producer/join': return user ? getJoin(request, env, user) : needUser();
    case 'POST /producer/join': return user ? postJoin(request, env, user, form) : needUser();
    case 'GET /healthz': return new Response('ok', { headers: { 'Cache-Control': 'no-store' } });
    default: return notFound(env, user);
  }
}

export default {
  async fetch(request, env, ctx) {
    try {
      return await handle(request, env, ctx);
    } catch (e) {
      console.error('unhandled', e && e.stack ? e.stack : e);
      return page(env, { title: 'Something went wrong', status: 500, body: html`<div class="narrow"><h1>Sorry, something went wrong</h1><p>Please try again in a minute. If it keeps happening, email hello@rootsandpantry.co.uk.</p></div>` });
    }
  },
};
