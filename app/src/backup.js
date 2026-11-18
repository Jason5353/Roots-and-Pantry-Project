// Nightly backup: the tables worth keeping, written as plain SQL, gzipped into an EU R2 bucket
// (binding BACKUPS). Kept for BACKUP_DAYS, then deleted (privacy notice says 30 days).
// Restore steps: docs/backups.md.
//
// Left out on purpose: login_codes, sessions, rate_limits (short-lived, security-sensitive),
// dev_outbox (tests only), postcode_districts (rebuilt by migration 0005).
import { sendEmail } from './services.js';

// Parents before children, so inserts satisfy the foreign keys. Deletes run in reverse.
export const BACKUP_TABLES = ['users', 'producers', 'deals', 'offers', 'messages', 'audit_log', 'outreach', 'outreach_notes', 'outreach_consent_log'];
export const BACKUP_DAYS = 30;
export const BACKUP_CRON = '30 8 * * *'; // must match wrangler.jsonc (both environments)
const PREFIX = 'd1/';
const PAGE = 500;

// One SQL literal. Newlines become char(10) so every statement stays on one line.
export function sqlValue(v) {
  if (v === null || v === undefined) return 'NULL';
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : 'NULL';
  if (typeof v === 'bigint') return v.toString();
  if (typeof v === 'boolean') return v ? '1' : '0';
  if (v instanceof ArrayBuffer || ArrayBuffer.isView(v)) {
    const b = v instanceof ArrayBuffer ? new Uint8Array(v) : new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
    return `X'${[...b].map((x) => x.toString(16).padStart(2, '0')).join('')}'`;
  }
  const s = String(v).replace(/'/g, "''").replace(/\r/g, "' || char(13) || '").replace(/\n/g, "' || char(10) || '");
  return `'${s}'`;
}

export async function dumpSql(env, label = '') {
  const out = [
    `-- Roots & Pantry database backup${label ? ` (${label})` : ''}, made ${new Date().toISOString()}`,
    '-- Replaces the rows in these tables. Restore steps: docs/backups.md',
    'PRAGMA defer_foreign_keys = ON;',
  ];
  for (const t of [...BACKUP_TABLES].reverse()) out.push(`DELETE FROM ${t};`);
  let rows = 0;
  for (const t of BACKUP_TABLES) {
    const cols = (await env.DB.prepare('SELECT name FROM pragma_table_info(?) ORDER BY cid').bind(t).all()).results.map((c) => c.name);
    if (!cols.length) throw new Error(`table ${t} not found`);
    const colList = cols.map((c) => `"${c}"`).join(', ');
    for (let offset = 0; ; offset += PAGE) {
      const { results } = await env.DB.prepare(`SELECT ${colList} FROM ${t} ORDER BY rowid LIMIT ? OFFSET ?`).bind(PAGE, offset).all();
      for (const r of results) out.push(`INSERT INTO ${t} (${colList}) VALUES (${cols.map((c) => sqlValue(r[c])).join(', ')});`);
      rows += results.length;
      if (results.length < PAGE) break;
    }
  }
  return { sql: out.join('\n') + '\n', rows };
}

export async function gzip(text) {
  const stream = new Blob([text]).stream().pipeThrough(new CompressionStream('gzip'));
  return new Response(stream).arrayBuffer();
}

export async function gunzip(buf) {
  const stream = new Blob([buf]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new Response(stream).text();
}

// Run the backup and drop old copies. Returns { key, rows, bytes, removed }.
export async function runBackup(env, when = new Date()) {
  if (!env.BACKUPS) throw new Error('BACKUPS bucket not bound');
  const { sql, rows } = await dumpSql(env, env.ENV_LABEL || 'live');
  const body = await gzip(sql);
  const key = `${PREFIX}${when.toISOString().slice(0, 10)}.sql.gz`;
  await env.BACKUPS.put(key, body, {
    httpMetadata: { contentType: 'application/sql', contentEncoding: 'gzip' },
    customMetadata: { rows: String(rows), tables: BACKUP_TABLES.join(',') },
  });
  const cutoff = when.getTime() - BACKUP_DAYS * 86400 * 1000;
  let removed = 0;
  let cursor;
  do {
    const list = await env.BACKUPS.list({ prefix: PREFIX, cursor });
    const old = list.objects.filter((o) => o.key !== key && o.uploaded.getTime() < cutoff).map((o) => o.key);
    if (old.length) { await env.BACKUPS.delete(old); removed += old.length; }
    cursor = list.truncated ? list.cursor : undefined;
  } while (cursor);
  return { key, rows, bytes: body.byteLength, removed };
}

// For the cron: never throws; emails hello@ if the backup fails.
export async function nightlyBackup(env) {
  try {
    const r = await runBackup(env);
    console.log(`backup ${r.key}: ${r.rows} rows, ${r.bytes} bytes, ${r.removed} old copies removed`);
    return r;
  } catch (e) {
    console.error('backup failed', e && e.stack ? e.stack : e);
    try {
      await sendEmail(env, {
        to: env.NOTIFY_EMAIL,
        subject: `Backup failed${env.ENV_LABEL ? ` (${env.ENV_LABEL})` : ''}`,
        text: `Last night's database backup did not work.\n\nError: ${String(e && e.message ? e.message : e).slice(0, 500)}\n\nThe app itself is unaffected. Check Workers → ${env.ENV_LABEL ? 'rp-app-test' : 'rp-app'} → Logs in Cloudflare, and see docs/backups.md.`,
      });
    } catch (e2) { console.error('backup failure email failed', e2); }
    return null;
  }
}

// Newest backup, for the admin overview. null if none.
export async function latestBackup(env) {
  if (!env.BACKUPS) return null;
  let newest = null;
  let cursor;
  do {
    const list = await env.BACKUPS.list({ prefix: PREFIX, cursor, include: ['customMetadata'] });
    for (const o of list.objects) if (!newest || o.uploaded > newest.uploaded) newest = o;
    cursor = list.truncated ? list.cursor : undefined;
  } while (cursor);
  return newest && { key: newest.key, uploaded: newest.uploaded, bytes: newest.size, rows: Number(newest.customMetadata?.rows || 0) };
}
