// Roots & Pantry app Worker: routing, CSRF checks and error handling.
import { html } from './util.js';
import { page } from './layout.js';
import { loadUser, getSignin, postSignin, postCode, postSignout, isAdmin } from './auth.js';
import { adminGate, getConfirm, postConfirmSend, postConfirm, overview, producerList, producerDetail, postProducerStatus, postEndDeal, messageList, messageDetail, postMessageStatus, team, postTeamAdd, postTeamRemove, auditLog } from './admin.js';
import { directory } from './directory.js';
import { cleanUp } from './services.js';
import { tiles, emptyGlyphs, mapData, mapPage } from './map.js';
import { home, getContact, postContact, getJoin, postJoin } from './pages.js';
import { dashboard, getEdit, postEdit, getNewDeal, postNewDeal, getEditDeal, postEditDeal, postDealStatus, postRenew, publicPage, promote, printSheet, sendExpiryReminders } from './producer.js';

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
  // Never serve the real app over plain HTTP: send visitors to the https:// address.
  if (url.protocol === 'http:' && url.hostname.endsWith('rootsandpantry.co.uk')) {
    url.protocol = 'https:';
    return Response.redirect(url.toString(), 301);
  }
  if (env.DEV === 'true' && url.hostname.endsWith('rootsandpantry.co.uk')) {
    return new Response('Misconfigured: DEV mode is not allowed here', { status: 500 });
  }
  // Sign-in codes are hashed with CODE_PEPPER: never run with a missing or weak one.
  if (!env.CODE_PEPPER || env.CODE_PEPPER.length < 32) {
    return new Response('Misconfigured: set the CODE_PEPPER secret (32+ characters)', { status: 503 });
  }
  // Map tiles: many small requests, no session needed, so skip the database.
  if (url.pathname === '/tiles/uk.pmtiles' && (request.method === 'GET' || request.method === 'HEAD')) return tiles(request, env, ctx);
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

  if (path === '/admin' || path.startsWith('/admin/')) {
    if (!user) return needUser();
    const gate = await adminGate(request, env, user, path);
    if (gate === 'notfound') return notFound(env, user);
    if (gate) return gate;
    return (await routeAdmin(request, env, user, url, path, method === 'HEAD' ? 'GET' : method, form)) || notFound(env, user);
  }

  switch (`${method === 'HEAD' ? 'GET' : method} ${path}`) {
    case 'GET /': return home(env, user);
    case 'GET /contact': return getContact(request, env, user, url);
    case 'POST /contact': return postContact(request, env, user, form);
    case 'GET /signin': return user ? Response.redirect(new URL(isAdmin(user) ? '/admin' : '/producer', url), 303) : getSignin(request, env, url);
    case 'POST /signin': return postSignin(request, env, form);
    case 'POST /signin/code': return postCode(request, env, form);
    case 'POST /signout': return postSignout(request, env, user);
    case 'GET /producer': return user ? dashboard(request, env, user, url) : needUser();
    case 'GET /producer/edit': return user ? getEdit(request, env, user) : needUser();
    case 'POST /producer/edit': return user ? postEdit(request, env, user, form) : needUser();
    case 'GET /producer/deals/new': return user ? getNewDeal(request, env, user) : needUser();
    case 'POST /producer/deals/new': return user ? postNewDeal(request, env, user, form) : needUser();
    case 'GET /producer/promote': return user ? promote(request, env, user) : needUser();
    case 'GET /producer/promote/poster': return user ? printSheet(request, env, user, 'poster') : needUser();
    case 'GET /producer/promote/postcard': return user ? printSheet(request, env, user, 'postcard') : needUser();
    case 'GET /producer/join': return user ? getJoin(request, env, user) : needUser();
    case 'POST /producer/join': return user ? postJoin(request, env, user, form) : needUser();
    case 'GET /producers': return directory(request, env, user, url);
    case 'GET /producers/map': return mapPage(request, env, user, url);
    case 'GET /producers/map.json': return mapData(request, env, url);
    case 'GET /healthz': return new Response('ok', { headers: { 'Cache-Control': 'no-store' } });
  }

  // Routes with an id in the path.
  const m = path.match(/^\/producer\/deals\/([A-Za-z0-9_-]{10,40})\/(edit|status|renew)$/);
  if (m) {
    if (!user) return needUser();
    const [, id, action] = m;
    let res = null;
    if (method === 'GET' && action === 'edit') res = await getEditDeal(request, env, user, id);
    if (method === 'POST' && action === 'edit') res = await postEditDeal(request, env, user, id, form);
    if (method === 'POST' && action === 'status') res = await postDealStatus(request, env, user, id, form);
    if (method === 'POST' && action === 'renew') res = await postRenew(request, env, user, id);
    return res || notFound(env, user);
  }
  if (method !== 'POST' && /^\/map\/fonts\/[^/]+\/\d+-\d+\.pbf$/.test(decodeURIComponent(path))) return emptyGlyphs();
  const pm = path.match(/^\/p\/([a-z0-9-]{1,60})$/);
  if (pm && method !== 'POST') return (await publicPage(request, env, user, pm[1])) || notFound(env, user);
  return notFound(env, user);
}

async function routeAdmin(request, env, user, url, path, method, form) {
  const owner = user.role === 'owner';
  switch (`${method} ${path}`) {
    case 'GET /admin': return overview(request, env, user);
    case 'GET /admin/confirm': return getConfirm(request, env, user, url);
    case 'POST /admin/confirm/send': return postConfirmSend(request, env, user, form);
    case 'POST /admin/confirm': return postConfirm(request, env, user, form);
    case 'GET /admin/producers': return producerList(request, env, user, url);
    case 'GET /admin/messages': return messageList(request, env, user, url);
    case 'GET /admin/team': return owner ? team(request, env, user) : null;
    case 'POST /admin/team/add': return owner ? postTeamAdd(request, env, user, form) : null;
    case 'POST /admin/team/remove': return owner ? postTeamRemove(request, env, user, form) : null;
    case 'GET /admin/audit': return owner ? auditLog(request, env, user, url) : null;
  }
  const id = '([A-Za-z0-9_-]{10,40})';
  let m;
  if ((m = path.match(new RegExp(`^/admin/producers/${id}$`))) && method === 'GET') return producerDetail(request, env, user, m[1]);
  if ((m = path.match(new RegExp(`^/admin/producers/${id}/status$`))) && method === 'POST') return postProducerStatus(request, env, user, m[1], form);
  if ((m = path.match(new RegExp(`^/admin/deals/${id}/end$`))) && method === 'POST') return postEndDeal(request, env, user, m[1], form);
  if ((m = path.match(new RegExp(`^/admin/messages/${id}$`))) && method === 'GET') return messageDetail(request, env, user, m[1]);
  if ((m = path.match(new RegExp(`^/admin/messages/${id}/status$`))) && method === 'POST') return postMessageStatus(request, env, user, m[1], form);
  return null;
}

export default {
  async scheduled(controller, env, ctx) {
    ctx.waitUntil(sendExpiryReminders(env).then((n) => console.log(`expiry reminders sent: ${n}`)));
    ctx.waitUntil(cleanUp(env).then((n) => console.log(`clean-up removed ${n} rows`)));
  },
  async fetch(request, env, ctx) {
    try {
      return await handle(request, env, ctx);
    } catch (e) {
      console.error('unhandled', e && e.stack ? e.stack : e);
      return page(env, { title: 'Something went wrong', status: 500, body: html`<div class="narrow"><h1>Sorry, something went wrong</h1><p>Please try again in a minute. If it keeps happening, email hello@rootsandpantry.co.uk.</p></div>` });
    }
  },
};
