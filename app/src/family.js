// Family groups (stage 2, part 1): start a group, invite people by email, accept invites,
// and run the group yourselves (admins, members, leaving, renaming, deleting).
// Switched on by FAMILY_SIGNUP_OPEN = "true" (test only until families open).
import { html, raw, now, randomId, sha256, clean, normEmail, validEmail } from './util.js';
import { page, errorList, field } from './layout.js';
import { sendEmail, rateLimit, audit } from './services.js';
import { COMPANY } from './emailtext.js';

export const familyOpen = (env) => env.FAMILY_SIGNUP_OPEN === 'true';

export const INVITE_DAYS = 14;
export const MAX_GROUPS_PER_PERSON = 5;
export const MAX_PEOPLE_PER_GROUP = 30; // members + invites still waiting
const INVITES_PER_GROUP_PER_DAY = 20;
const NEW_GROUPS_PER_PERSON_PER_DAY = 3;

const DAY = 86400;
const fmtDate = (t) => new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', day: 'numeric', month: 'long' }).format(new Date(t * 1000));
export const bookTitle = (name) => `${name} Family Recipes`;

// "The Hartleys", "hartley family", "Hartley Family Recipes" all become "Hartley".
export function cleanFamilyName(v) {
  let s = clean(v, 60).replace(/\s+/g, ' ');
  s = s.replace(/\s+family(\s+recipes?)?$/i, '').replace(/^the\s+/i, '').trim();
  if (/^[\p{Ll}]/u.test(s)) s = s[0].toUpperCase() + s.slice(1);
  return s;
}
const validFamilyName = (s) => /^\p{L}[\p{L}\p{M}' .-]{0,39}$/u.test(s);
const validPersonName = (s) => s.length >= 1 && s.length <= 30 && /\p{L}/u.test(s);

// ---------- data ----------

export const groupsFor = (env, userId) => env.DB.prepare(
  `SELECT g.id, g.name, m.role, m.display_name,
     (SELECT COUNT(*) FROM family_members x WHERE x.group_id = g.id) AS people
   FROM family_members m JOIN family_groups g ON g.id = m.group_id
   WHERE m.user_id = ? ORDER BY g.name`,
).bind(userId).all().then((r) => r.results);

const membership = (env, groupId, userId) => env.DB.prepare(
  'SELECT g.id, g.name, m.role, m.display_name FROM family_members m JOIN family_groups g ON g.id = m.group_id WHERE m.group_id = ? AND m.user_id = ?',
).bind(groupId, userId).first();

const membersOf = (env, groupId) => env.DB.prepare(
  'SELECT m.user_id, m.display_name, m.role, m.joined_at FROM family_members m WHERE m.group_id = ? ORDER BY m.role, m.display_name COLLATE NOCASE',
).bind(groupId).all().then((r) => r.results);

const pendingInvites = (env, groupId, t = now()) => env.DB.prepare(
  'SELECT id, email, display_name, role, expires_at FROM family_invites WHERE group_id = ? AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > ? ORDER BY created_at',
).bind(groupId, t).all().then((r) => r.results);

// Invites for this person's own email that they can accept straight away (their email is already proven by sign-in).
const invitesForEmail = (env, email, t = now()) => env.DB.prepare(
  `SELECT i.id, i.display_name, g.name AS group_name, i.expires_at,
     (SELECT m.display_name FROM family_members m WHERE m.group_id = i.group_id AND m.user_id = i.invited_by) AS inviter
   FROM family_invites i JOIN family_groups g ON g.id = i.group_id
   WHERE i.email = ? AND i.accepted_at IS NULL AND i.revoked_at IS NULL AND i.expires_at > ?
     AND NOT EXISTS (SELECT 1 FROM family_members m JOIN users u ON u.id = m.user_id WHERE m.group_id = i.group_id AND u.email = i.email)
   ORDER BY i.created_at DESC`,
).bind(email, t).all().then((r) => r.results);

const countAdmins = (members) => members.filter((m) => m.role === 'admin').length;

// ---------- shared bits ----------

function adultTick(checked, error) {
  return html`<div class="field${error ? ' has-error' : ''}">
    ${error ? html`<p class="error" id="adult-err">${error}</p>` : ''}
    <div class="check"><input type="checkbox" id="adult" name="adult" value="yes" ${checked ? raw('checked') : ''} ${error ? raw('aria-invalid="true" aria-describedby="adult-err"') : ''} />
    <label for="adult">I'm 18 or over. (Children get their own simpler sign-in, added by a parent. That's coming soon.)</label></div>
  </div>`;
}

function roleChoice(value = 'member') {
  return html`<fieldset class="field">
    <legend>What can they do?</legend>
    <div class="check"><input type="radio" id="role-member" name="role" value="member" ${value !== 'admin' ? raw('checked') : ''} />
      <label for="role-member"><b>Member</b>: add recipes and edit their own</label></div>
    <div class="check"><input type="radio" id="role-admin" name="role" value="admin" ${value === 'admin' ? raw('checked') : ''} />
      <label for="role-admin"><b>Admin</b>: also invite and remove people, and change the family settings</label></div>
  </fieldset>`;
}

const back = (path, done) => new Response(null, { status: 303, headers: { Location: done ? `${path}?done=${done}` : path, 'Cache-Control': 'no-store' } });

function notice(env, user, title, body, status = 400) {
  return page(env, { title, user, status, body: html`<div class="narrow"><h1>${title}</h1>${body}<p><a class="btn btn-ghost" href="/family">Go to my family</a></p></div>` });
}

// ---------- /family ----------

export async function familyHome(request, env, user, url) {
  const [groups, invites] = await Promise.all([groupsFor(env, user.id), invitesForEmail(env, user.email)]);
  if (groups.length === 1 && !invites.length) return back(`/family/g/${groups[0].id}`, url.searchParams.get('done'));
  if (!groups.length && !invites.length) return back('/family/new');
  const flash = { left: "You've left that family group.", deleted: 'The family group has been deleted.' }[url.searchParams.get('done')];
  return page(env, {
    title: 'My family',
    user,
    body: html`<div class="narrow">
      ${flash ? html`<div class="flash" role="status">${flash}</div>` : ''}
      <h1>My family</h1>
      ${invites.length ? html`<section class="panel" aria-labelledby="inv-h">
        <h2 id="inv-h">Invitations for you</h2>
        <ul class="rows">${invites.map((i) => html`<li>
          <p class="row-title"><b>${bookTitle(i.group_name)}</b></p>
          <p class="row-meta">${i.inviter ? `From ${i.inviter} · ` : ''}open until ${fmtDate(i.expires_at)}</p>
          <a class="btn btn-green btn-sm" href="/family/invites/${i.id}">Look at this invitation<span class="sr-only"> to ${bookTitle(i.group_name)}</span></a>
        </li>`)}</ul>
      </section>` : ''}
      ${groups.length ? html`<section class="panel" aria-labelledby="grp-h">
        <h2 id="grp-h">Your family groups</h2>
        <ul class="rows">${groups.map((g) => html`<li>
          <p class="row-title"><a href="/family/g/${g.id}"><b>${bookTitle(g.name)}</b></a> ${g.role === 'admin' ? html`<span class="tag">Admin</span>` : ''}</p>
          <p class="row-meta">You're ${g.display_name} · ${g.people} ${g.people === 1 ? 'person' : 'people'}</p>
        </li>`)}</ul>
      </section>` : ''}
      ${groups.length < MAX_GROUPS_PER_PERSON ? html`<p><a href="/family/new">Start ${groups.length ? 'another' : 'a'} family group</a></p>` : ''}
    </div>`,
  });
}

// ---------- start a group ----------

export async function getNewGroup(request, env, user, { values = {}, errors = [] } = {}) {
  const err = (f) => errors.find((e) => e.field === f)?.msg;
  const groups = await groupsFor(env, user.id);
  if (groups.length >= MAX_GROUPS_PER_PERSON) {
    return notice(env, user, "You're in the most family groups we allow", html`<p>You can be in up to ${MAX_GROUPS_PER_PERSON}. Leave one first, or <a href="/contact">contact us</a> if you need more.</p>`);
  }
  return page(env, {
    title: 'Start your family recipe book',
    user,
    status: errors.length ? 400 : 200,
    body: html`<div class="narrow">
      <h1>Start your family recipe book</h1>
      <p class="sub">Free forever. Private to the people you invite. You'll be its first admin.</p>
      ${errorList(errors)}
      <form method="post" action="/family/new" novalidate>
        ${field({ id: 'family_name', label: 'Family name', value: values.family_name, autocomplete: 'family-name', max: 60, hint: "Usually your surname, like Hartley. We'll call it Hartley Family Recipes. You can change it later.", error: err('family_name') })}
        ${field({ id: 'display_name', label: 'Your name', value: values.display_name, autocomplete: 'given-name', max: 30, hint: 'How your family will see you, like Dave or Nana Mags.', error: err('display_name') })}
        ${adultTick(values.adult, err('adult'))}
        <p class="note">By starting a family group you agree to our <a href="${env.SITE_URL}/privacy-and-terms/">privacy notice and terms</a>.</p>
        <button class="btn btn-green" type="submit">Start our recipe book</button>
      </form>
    </div>`,
  });
}

export async function postNewGroup(request, env, user, form) {
  const values = { family_name: cleanFamilyName(form.get('family_name')), display_name: clean(form.get('display_name'), 30), adult: form.get('adult') === 'yes' };
  const errors = [];
  if (!values.family_name) errors.push({ field: 'family_name', msg: 'Enter your family name' });
  else if (!validFamilyName(values.family_name)) errors.push({ field: 'family_name', msg: 'Use letters, spaces, hyphens and apostrophes only, up to 40 characters' });
  if (!validPersonName(values.display_name)) errors.push({ field: 'display_name', msg: 'Enter your name, up to 30 characters' });
  if (!values.adult) errors.push({ field: 'adult', msg: 'Tick to confirm you\'re 18 or over' });
  if (errors.length) return getNewGroup(request, env, user, { values, errors });
  if ((await groupsFor(env, user.id)).length >= MAX_GROUPS_PER_PERSON) return getNewGroup(request, env, user);
  if (!(await rateLimit(env, `family:new:${user.id}`, NEW_GROUPS_PER_PERSON_PER_DAY, DAY))) {
    return getNewGroup(request, env, user, { values, errors: [{ field: 'family_name', msg: "You've started a few groups today. Please try again tomorrow." }] });
  }
  const id = randomId();
  const t = now();
  await env.DB.batch([
    env.DB.prepare('INSERT INTO family_groups (id, name, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?)').bind(id, values.family_name, user.id, t, t),
    env.DB.prepare("INSERT INTO family_members (group_id, user_id, display_name, role, adult_confirmed_at, joined_at) VALUES (?, ?, ?, 'admin', ?, ?)").bind(id, user.id, values.display_name, t, t),
  ]);
  await audit(env, user.id, 'family.created', id);
  return back(`/family/g/${id}`, 'started');
}

// ---------- the group page ----------

export async function groupPage(request, env, user, groupId, { url = null, errors = [], values = {}, status = 200 } = {}) {
  const me = await membership(env, groupId, user.id);
  if (!me) return null;
  const [members, invites] = await Promise.all([membersOf(env, groupId), pendingInvites(env, groupId)]);
  const admin = me.role === 'admin';
  const admins = countAdmins(members);
  const err = (f) => errors.find((e) => e.field === f)?.msg;
  const flash = {
    started: 'Your family recipe book is ready. Now invite your family.',
    invited: 'Invitation sent.',
    resent: 'Invitation sent again, with a fresh link.',
    cancelled: 'Invitation cancelled. The link no longer works.',
    joined: "You've joined the family.",
    role: 'Saved.',
    removed: 'They have been removed from the family group.',
    name: 'Your name has been saved.',
    renamed: 'The family name has been saved.',
  }[url?.searchParams.get('done')];
  const full = members.length + invites.length >= MAX_PEOPLE_PER_GROUP;
  const title = bookTitle(me.name);
  const base = `/family/g/${groupId}`;
  return page(env, {
    title,
    user,
    status: errors.length ? 400 : status,
    body: html`<div class="dash">
      ${flash ? html`<div class="flash" role="status">${flash}</div>` : ''}
      <h1>${title}</h1>
      <p class="sub">You're ${me.display_name}${admin ? ', an admin' : ''}.</p>
      <div class="callout"><p>Recipes, the shared shopping list and local deals are coming next. For now, get everyone in.</p></div>
      ${errorList(errors)}

      <section class="panel" aria-labelledby="people-h">
        <h2 id="people-h">People (${members.length})</h2>
        <ul class="rows">${members.map((m) => {
          const self = m.user_id === user.id;
          return html`<li>
            <p class="row-title"><b>${m.display_name}</b>${self ? ' (you)' : ''} ${m.role === 'admin' ? html`<span class="tag">Admin</span>` : ''}</p>
            <p class="row-meta">Joined ${fmtDate(m.joined_at)}</p>
            ${self ? html`<form method="post" action="${base}/me" class="nameform" novalidate>
                <label for="my-name">Your name in this family</label>
                <input id="my-name" name="display_name" type="text" maxlength="30" value="${me.display_name}" autocomplete="given-name" />
                <button class="btn btn-ghost btn-sm" type="submit">Save name</button>
              </form>`
              : admin ? html`<details class="deal-actions"><summary>Change ${m.display_name}<span class="sr-only">'s access</span></summary>
                <form method="post" action="${base}/members/${m.user_id}/role">
                  <input type="hidden" name="role" value="${m.role === 'admin' ? 'member' : 'admin'}" />
                  <button class="btn btn-ghost btn-sm" type="submit">${m.role === 'admin' ? 'Make a member (not admin)' : 'Make an admin'}<span class="sr-only">: ${m.display_name}</span></button>
                </form>
                <form method="post" action="${base}/members/${m.user_id}/remove">
                  <button class="btn btn-ghost btn-sm" type="submit">Remove from family<span class="sr-only">: ${m.display_name}</span></button>
                </form>
              </details>` : ''}
          </li>`;
        })}</ul>

        ${invites.length ? html`<h3>Invited, not joined yet</h3>
        <ul class="rows">${invites.map((i) => html`<li>
          <p class="row-title"><b>${i.display_name}</b> ${i.role === 'admin' ? html`<span class="tag">Admin</span>` : ''}</p>
          <p class="row-meta">${admin ? `${i.email} · ` : ''}link works until ${fmtDate(i.expires_at)}</p>
          ${admin ? html`<div class="deal-actions">
            <form method="post" action="${base}/invites/${i.id}/resend"><button class="btn btn-ghost btn-sm" type="submit">Send again<span class="sr-only"> to ${i.display_name}</span></button></form>
            <form method="post" action="${base}/invites/${i.id}/cancel"><button class="btn btn-ghost btn-sm" type="submit">Cancel invitation<span class="sr-only"> for ${i.display_name}</span></button></form>
          </div>` : ''}
        </li>`)}</ul>` : ''}
      </section>

      ${admin ? html`<section class="panel" aria-labelledby="invite-h">
        <h2 id="invite-h">Invite someone</h2>
        ${full ? html`<p>Your group has ${MAX_PEOPLE_PER_GROUP} people (including invitations). <a href="/contact">Contact us</a> if you need more.</p>` : html`
        <p>They'll get an email with a link. It works for ${INVITE_DAYS} days. They sign in with that email address, so check it's the one they use.</p>
        <form method="post" action="${base}/invite" novalidate>
          ${field({ id: 'invite_name', label: 'Their name', value: values.invite_name, autocomplete: 'off', max: 30, hint: 'How the family will see them. They can change it.', error: err('invite_name') })}
          ${field({ id: 'invite_email', label: 'Their email address', type: 'email', value: values.invite_email, autocomplete: 'off', max: 254, error: err('invite_email') })}
          ${roleChoice(values.role)}
          <p class="note">Only invite adults (18 or over) for now. Child sign-in is coming soon.</p>
          <button class="btn btn-green" type="submit">Send invitation</button>
        </form>`}
      </section>

      <section class="panel" aria-labelledby="settings-h">
        <h2 id="settings-h">Family settings</h2>
        <form method="post" action="${base}/rename" novalidate>
          ${field({ id: 'family_name', label: 'Family name', value: values.family_name ?? me.name, autocomplete: 'off', max: 60, hint: `Shown as "${title}".`, error: err('family_name') })}
          <button class="btn btn-ghost" type="submit">Save family name</button>
        </form>
        <details class="danger-zone">
          <summary>Delete this family group</summary>
          <p>This removes the group for everyone, straight away. It can't be undone.</p>
          <form method="post" action="${base}/delete" novalidate>
            ${err('confirm') ? html`<p class="error" id="confirm-err">${err('confirm')}</p>` : ''}
            <div class="check"><input type="checkbox" id="confirm" name="confirm" value="yes" ${err('confirm') ? raw('aria-invalid="true" aria-describedby="confirm-err"') : ''} />
              <label for="confirm">I understand that ${title} will be deleted${members.length > 1 ? ` for all ${members.length} people in it` : ''}</label></div>
            <button class="btn btn-red" type="submit">Delete family group</button>
          </form>
        </details>
      </section>` : ''}

      <section class="panel" aria-labelledby="leave-h">
        <h2 id="leave-h">Leave this family</h2>
        ${admin && admins === 1 && members.length > 1
          ? html`<p>You're the only admin. Make someone else an admin first, then you can leave.</p>`
          : html`<p>${members.length === 1 ? "You're the only person here, so leaving deletes the group." : "You'll stop seeing this family's recipe book. An admin can invite you back."}</p>
            <form method="post" action="${base}/leave"><button class="btn btn-ghost" type="submit">${members.length === 1 ? 'Leave and delete the group' : 'Leave this family'}</button></form>`}
      </section>
    </div>`,
  });
}

// ---------- invitations ----------

function inviteEmail(origin, { toName, inviter, groupName, email, token }) {
  return {
    subject: `${inviter} invited you to ${bookTitle(groupName)}`,
    text: `Hi ${toName},\n\n${inviter} has invited you to join ${bookTitle(groupName)} on Roots & Pantry, a free, private recipe book for your family.\n\nTo join, open this link within ${INVITE_DAYS} days:\n${origin}/family/join/${token}\n\nYou'll sign in with this email address (${email}) using a code we email you. No password needed.\n\nNot expecting this? You can ignore it. Nothing happens unless you open the link and sign in.\n\nRoots & Pantry\nhello@rootsandpantry.co.uk\n\n${COMPANY}`,
  };
}

async function sendInvite(request, env, { inviteId, toName, email, groupName, inviter }) {
  const token = randomId(24);
  const t = now();
  await env.DB.prepare('UPDATE family_invites SET token_hash = ?, expires_at = ?, created_at = ? WHERE id = ?')
    .bind(await sha256(token), t + INVITE_DAYS * DAY, t, inviteId).run();
  const mail = inviteEmail(new URL(request.url).origin, { toName, inviter, groupName, email, token });
  await sendEmail(env, { to: email, replyTo: env.NOTIFY_EMAIL, subject: mail.subject, text: mail.text, html: true });
}

export async function postInvite(request, env, user, groupId, form) {
  const me = await membership(env, groupId, user.id);
  if (!me) return null;
  if (me.role !== 'admin') return back(`/family/g/${groupId}`);
  const values = { invite_name: clean(form.get('invite_name'), 30), invite_email: normEmail(form.get('invite_email')), role: form.get('role') === 'admin' ? 'admin' : 'member' };
  const errors = [];
  if (!validPersonName(values.invite_name)) errors.push({ field: 'invite_name', msg: 'Enter their name, up to 30 characters' });
  if (!validEmail(values.invite_email)) errors.push({ field: 'invite_email', msg: 'Enter a valid email address, like name@example.co.uk' });
  const t = now();
  if (!errors.length) {
    const [already, waiting, members, invites] = await Promise.all([
      env.DB.prepare('SELECT 1 FROM family_members m JOIN users u ON u.id = m.user_id WHERE m.group_id = ? AND u.email = ?').bind(groupId, values.invite_email).first(),
      env.DB.prepare('SELECT 1 FROM family_invites WHERE group_id = ? AND email = ? AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > ?').bind(groupId, values.invite_email, t).first(),
      membersOf(env, groupId),
      pendingInvites(env, groupId, t),
    ]);
    if (already) errors.push({ field: 'invite_email', msg: "They're already in this family" });
    else if (waiting) errors.push({ field: 'invite_email', msg: "They've already been invited. Use Send again in the list above." });
    else if (members.length + invites.length >= MAX_PEOPLE_PER_GROUP) errors.push({ field: 'invite_email', msg: `A family group can have up to ${MAX_PEOPLE_PER_GROUP} people` });
  }
  if (!errors.length && !(await rateLimit(env, `family:invite:${groupId}`, INVITES_PER_GROUP_PER_DAY, DAY))) {
    errors.push({ field: 'invite_email', msg: "You've sent a lot of invitations today. Please try again tomorrow." });
  }
  if (errors.length) return groupPage(request, env, user, groupId, { errors, values });
  const id = randomId();
  await env.DB.prepare('INSERT INTO family_invites (id, group_id, email, display_name, role, token_hash, invited_by, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .bind(id, groupId, values.invite_email, values.invite_name, values.role, `pending:${id}`, user.id, t, t).run();
  await sendInvite(request, env, { inviteId: id, toName: values.invite_name, email: values.invite_email, groupName: me.name, inviter: me.display_name });
  await audit(env, user.id, 'family.invited', groupId, { invite: id, role: values.role });
  return back(`/family/g/${groupId}`, 'invited');
}

export async function postInviteAction(request, env, user, groupId, inviteId, action) {
  const me = await membership(env, groupId, user.id);
  if (!me) return null;
  if (me.role !== 'admin') return back(`/family/g/${groupId}`);
  const inv = await env.DB.prepare('SELECT * FROM family_invites WHERE id = ? AND group_id = ? AND accepted_at IS NULL AND revoked_at IS NULL').bind(inviteId, groupId).first();
  if (!inv) return back(`/family/g/${groupId}`);
  if (action === 'cancel') {
    await env.DB.prepare('UPDATE family_invites SET revoked_at = ? WHERE id = ?').bind(now(), inviteId).run();
    await audit(env, user.id, 'family.invite_cancelled', groupId, { invite: inviteId });
    return back(`/family/g/${groupId}`, 'cancelled');
  }
  if (!(await rateLimit(env, `family:invite:${groupId}`, INVITES_PER_GROUP_PER_DAY, DAY))) {
    return groupPage(request, env, user, groupId, { errors: [{ field: 'invite_email', msg: "You've sent a lot of invitations today. Please try again tomorrow." }] });
  }
  await sendInvite(request, env, { inviteId, toName: inv.display_name, email: inv.email, groupName: me.name, inviter: me.display_name });
  await audit(env, user.id, 'family.invite_resent', groupId, { invite: inviteId });
  return back(`/family/g/${groupId}`, 'resent');
}

const maskEmail = (e) => {
  const [local, domain] = e.split('@');
  return `${local.slice(0, Math.min(2, local.length))}${'•'.repeat(Math.max(1, Math.min(6, local.length - 2)))}@${domain}`;
};

// The link in the email. Anyone can open it; only the invited email address can accept.
export async function joinLink(request, env, user, token) {
  const inv = await env.DB.prepare(
    `SELECT i.*, g.name AS group_name FROM family_invites i JOIN family_groups g ON g.id = i.group_id WHERE i.token_hash = ?`,
  ).bind(await sha256(token)).first();
  const t = now();
  if (!inv || inv.revoked_at || (!inv.accepted_at && inv.expires_at <= t)) {
    return page(env, { title: "This invitation link doesn't work", user, status: 404, body: html`<div class="narrow"><h1>This invitation link doesn't work</h1><p>It may have expired (links work for ${INVITE_DAYS} days), been cancelled, or been replaced by a newer email. Ask whoever invited you to send it again.</p></div>` });
  }
  if (inv.accepted_at) return user ? back(`/family/g/${inv.group_id}`) : back(`/signin?next=/family`);
  if (!user) {
    return page(env, {
      title: `Join ${bookTitle(inv.group_name)}`,
      body: html`<div class="narrow">
        <h1>You're invited to ${bookTitle(inv.group_name)}</h1>
        <p class="sub">A free, private recipe book for your family on Roots &amp; Pantry.</p>
        <p>To join, sign in with the email address this invitation was sent to (${maskEmail(inv.email)}). We'll email you a 6-digit code. No password needed.</p>
        <p><a class="btn btn-green" href="/signin?next=/family/join/${token}">Sign in to join</a></p>
      </div>`,
    });
  }
  if (normEmail(user.email) !== inv.email) {
    return page(env, {
      title: 'This invitation is for someone else',
      user,
      status: 403,
      body: html`<div class="narrow">
        <h1>This invitation is for a different email address</h1>
        <p>You're signed in as ${user.email}, but this invitation was sent to ${maskEmail(inv.email)}.</p>
        <p>Sign out, then open the link again and sign in with that address. Or ask whoever invited you to send it to ${user.email} instead.</p>
        <form method="post" action="/signout"><button class="btn btn-ghost" type="submit">Sign out</button></form>
      </div>`,
    });
  }
  return back(`/family/invites/${inv.id}`);
}

async function openInviteFor(env, user, inviteId) {
  return env.DB.prepare(
    `SELECT i.*, g.name AS group_name,
       (SELECT m.display_name FROM family_members m WHERE m.group_id = i.group_id AND m.user_id = i.invited_by) AS inviter
     FROM family_invites i JOIN family_groups g ON g.id = i.group_id
     WHERE i.id = ? AND i.email = ? AND i.accepted_at IS NULL AND i.revoked_at IS NULL AND i.expires_at > ?`,
  ).bind(inviteId, normEmail(user.email), now()).first();
}

export async function getAccept(request, env, user, inviteId, { values = null, errors = [] } = {}) {
  const inv = await openInviteFor(env, user, inviteId);
  if (!inv) return null;
  if (await membership(env, inv.group_id, user.id)) return back(`/family/g/${inv.group_id}`);
  const v = values || { display_name: inv.display_name, adult: false };
  const err = (f) => errors.find((e) => e.field === f)?.msg;
  const title = bookTitle(inv.group_name);
  return page(env, {
    title: `Join ${title}`,
    user,
    status: errors.length ? 400 : 200,
    body: html`<div class="narrow">
      <h1>Join ${title}</h1>
      <p class="sub">${inv.inviter ? `${inv.inviter} invited you` : "You've been invited"}${inv.role === 'admin' ? ' as an admin' : ''}.</p>
      ${errorList(errors)}
      <form method="post" action="/family/invites/${inv.id}" novalidate>
        ${field({ id: 'display_name', label: 'Your name in this family', value: v.display_name, autocomplete: 'given-name', max: 30, hint: 'How your family will see you. Change it if you like.', error: err('display_name') })}
        ${adultTick(v.adult, err('adult'))}
        <p class="note">By joining you agree to our <a href="${env.SITE_URL}/privacy-and-terms/">privacy notice and terms</a>.</p>
        <button class="btn btn-green" type="submit">Join the family</button>
      </form>
      <form method="post" action="/family/invites/${inv.id}/decline"><button class="btn btn-ghost btn-sm" type="submit">No thanks</button></form>
    </div>`,
  });
}

export async function postAccept(request, env, user, inviteId, form) {
  const inv = await openInviteFor(env, user, inviteId);
  if (!inv) return null;
  if (await membership(env, inv.group_id, user.id)) return back(`/family/g/${inv.group_id}`);
  const values = { display_name: clean(form.get('display_name'), 30), adult: form.get('adult') === 'yes' };
  const errors = [];
  if (!validPersonName(values.display_name)) errors.push({ field: 'display_name', msg: 'Enter your name, up to 30 characters' });
  if (!values.adult) errors.push({ field: 'adult', msg: 'Tick to confirm you\'re 18 or over' });
  if (!errors.length && (await groupsFor(env, user.id)).length >= MAX_GROUPS_PER_PERSON) {
    errors.push({ field: 'display_name', msg: `You're already in ${MAX_GROUPS_PER_PERSON} family groups. Leave one first.` });
  }
  if (errors.length) return getAccept(request, env, user, inviteId, { values, errors });
  const t = now();
  await env.DB.batch([
    env.DB.prepare('INSERT INTO family_members (group_id, user_id, display_name, role, adult_confirmed_at, joined_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING')
      .bind(inv.group_id, user.id, values.display_name, inv.role === 'admin' ? 'admin' : 'member', t, t),
    env.DB.prepare('UPDATE family_invites SET accepted_at = ? WHERE id = ?').bind(t, inv.id),
  ]);
  await audit(env, user.id, 'family.joined', inv.group_id, { invite: inv.id });
  return back(`/family/g/${inv.group_id}`, 'joined');
}

export async function postDecline(request, env, user, inviteId) {
  const inv = await openInviteFor(env, user, inviteId);
  if (!inv) return null;
  await env.DB.prepare('UPDATE family_invites SET revoked_at = ? WHERE id = ?').bind(now(), inv.id).run();
  await audit(env, user.id, 'family.invite_declined', inv.group_id, { invite: inv.id });
  return back('/family');
}

// ---------- running the group ----------

export async function postMemberAction(request, env, user, groupId, memberId, action, form) {
  const me = await membership(env, groupId, user.id);
  if (!me) return null;
  if (me.role !== 'admin' || memberId === user.id) return back(`/family/g/${groupId}`);
  const target = await membership(env, groupId, memberId);
  if (!target) return back(`/family/g/${groupId}`);
  if (action === 'role') {
    const role = form.get('role') === 'admin' ? 'admin' : 'member';
    await env.DB.prepare('UPDATE family_members SET role = ? WHERE group_id = ? AND user_id = ?').bind(role, groupId, memberId).run();
    await audit(env, user.id, 'family.role', groupId, { member: memberId, role });
    return back(`/family/g/${groupId}`, 'role');
  }
  await env.DB.prepare('DELETE FROM family_members WHERE group_id = ? AND user_id = ?').bind(groupId, memberId).run();
  await audit(env, user.id, 'family.removed', groupId, { member: memberId });
  return back(`/family/g/${groupId}`, 'removed');
}

export async function postMyName(request, env, user, groupId, form) {
  const me = await membership(env, groupId, user.id);
  if (!me) return null;
  const name = clean(form.get('display_name'), 30);
  if (!validPersonName(name)) return groupPage(request, env, user, groupId, { errors: [{ field: 'my-name', msg: 'Enter your name, up to 30 characters' }] });
  await env.DB.prepare('UPDATE family_members SET display_name = ? WHERE group_id = ? AND user_id = ?').bind(name, groupId, user.id).run();
  return back(`/family/g/${groupId}`, 'name');
}

export async function postRename(request, env, user, groupId, form) {
  const me = await membership(env, groupId, user.id);
  if (!me) return null;
  if (me.role !== 'admin') return back(`/family/g/${groupId}`);
  const name = cleanFamilyName(form.get('family_name'));
  if (!name || !validFamilyName(name)) {
    return groupPage(request, env, user, groupId, { values: { family_name: name }, errors: [{ field: 'family_name', msg: 'Use letters, spaces, hyphens and apostrophes only, up to 40 characters' }] });
  }
  await env.DB.prepare('UPDATE family_groups SET name = ?, updated_at = ? WHERE id = ?').bind(name, now(), groupId).run();
  await audit(env, user.id, 'family.renamed', groupId);
  return back(`/family/g/${groupId}`, 'renamed');
}

async function deleteGroup(env, user, groupId) {
  await env.DB.prepare('DELETE FROM family_groups WHERE id = ?').bind(groupId).run(); // members and invites go with it
  await audit(env, user.id, 'family.deleted', groupId);
}

export async function postDeleteGroup(request, env, user, groupId, form) {
  const me = await membership(env, groupId, user.id);
  if (!me) return null;
  if (me.role !== 'admin') return back(`/family/g/${groupId}`);
  if (form.get('confirm') !== 'yes') return groupPage(request, env, user, groupId, { errors: [{ field: 'confirm', msg: 'Tick the box to confirm you want to delete the group' }] });
  await deleteGroup(env, user, groupId);
  return back('/family', 'deleted');
}

export async function postLeave(request, env, user, groupId) {
  const me = await membership(env, groupId, user.id);
  if (!me) return null;
  const members = await membersOf(env, groupId);
  if (members.length === 1) {
    await deleteGroup(env, user, groupId);
    return back('/family', 'deleted');
  }
  if (me.role === 'admin' && countAdmins(members) === 1) {
    return groupPage(request, env, user, groupId, { errors: [{ field: 'leave-h', msg: "You're the only admin. Make someone else an admin first, then you can leave." }] });
  }
  await env.DB.prepare('DELETE FROM family_members WHERE group_id = ? AND user_id = ?').bind(groupId, user.id).run();
  await audit(env, user.id, 'family.left', groupId);
  return back('/family', 'left');
}

// ---------- routing ----------

const ID = '([A-Za-z0-9_-]{10,40})';
export async function routeFamily(request, env, user, url, path, method, form, needUser) {
  if (path === '/family/join' || path.startsWith('/family/join/')) {
    const m = path.match(/^\/family\/join\/([A-Za-z0-9_-]{20,60})$/);
    return m && method === 'GET' ? joinLink(request, env, user, m[1]) : null;
  }
  if (!user) return needUser();
  if (path === '/family' && method === 'GET') return familyHome(request, env, user, url);
  if (path === '/family/new') return method === 'GET' ? getNewGroup(request, env, user) : postNewGroup(request, env, user, form);
  let m;
  if ((m = path.match(new RegExp(`^/family/invites/${ID}(?:/(decline))?$`)))) {
    if (method === 'GET' && !m[2]) return getAccept(request, env, user, m[1]);
    if (method === 'POST' && !m[2]) return postAccept(request, env, user, m[1], form);
    if (method === 'POST' && m[2] === 'decline') return postDecline(request, env, user, m[1]);
    return null;
  }
  if ((m = path.match(new RegExp(`^/family/g/${ID}$`))) && method === 'GET') return groupPage(request, env, user, m[1], { url });
  if (method !== 'POST') return null;
  if ((m = path.match(new RegExp(`^/family/g/${ID}/(invite|me|rename|leave|delete)$`)))) {
    const [, gid, act] = m;
    if (act === 'invite') return postInvite(request, env, user, gid, form);
    if (act === 'me') return postMyName(request, env, user, gid, form);
    if (act === 'rename') return postRename(request, env, user, gid, form);
    if (act === 'leave') return postLeave(request, env, user, gid);
    if (act === 'delete') return postDeleteGroup(request, env, user, gid, form);
  }
  if ((m = path.match(new RegExp(`^/family/g/${ID}/invites/${ID}/(resend|cancel)$`)))) return postInviteAction(request, env, user, m[1], m[2], m[3]);
  if ((m = path.match(new RegExp(`^/family/g/${ID}/members/${ID}/(role|remove)$`)))) return postMemberAction(request, env, user, m[1], m[2], m[3], form);
  return null;
}
