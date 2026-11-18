# Backups and restoring

There are two kinds of backup, and they cover different problems.

| | What | Kept | Use it for |
|---|---|---|---|
| **D1 Time Travel** | Built into Cloudflare D1, automatic | 7 days (free plan), 30 days (paid) | "Something went wrong in the last few days – put the whole database back to how it was at 9am Tuesday." |
| **Nightly copies** | `app/src/backup.js`, run by the 08:30 UTC run of the hourly cron (after the 08:00 clean-up) | 30 days | Getting back a single record, a deleted database, or anything older than Time Travel covers. |

## Nightly copies

- **Where:** R2 buckets `rp-backups` (live) and `rp-backups-test` (test), both EU jurisdiction, binding `BACKUPS`. One file a day: `d1/YYYY-MM-DD.sql.gz`.
- **Tables included:** users, producers, deals, offers, fb_posts, messages, audit_log, outreach, outreach_notes, outreach_consent_log.
- **Not included:** sign-in codes, sessions, rate limits (short-lived and sensitive), dev_outbox, postcode_districts (rebuilt by migration 0005).
- **Format:** plain SQL, gzipped, one statement per line. It starts with `DELETE FROM` for each table, then `INSERT`s, so running it **replaces** those tables completely.
- **Kept:** 30 days, then deleted by the same job. This matches the privacy notice ("Database backups") – change both together.
- **If it fails:** hello@ gets a "Backup failed" email, and the admin overview turns yellow when the newest copy is more than 36 hours old.

## Restoring

Do this from a computer with the repo, in the `app` folder, signed in with `npx wrangler login` (Roots and Pantry Site account).

### A. Recent mistake: use Time Travel (whole database)

```
npx wrangler d1 time-travel info rp-app
npx wrangler d1 time-travel restore rp-app --timestamp=2026-11-18T09:00:00Z
```

The restore command prints a bookmark you can use to undo it.

### B. From a nightly copy

1. Download it: Cloudflare → R2 → `rp-backups` → `d1/` → the date you want → Download. Or:
   `npx wrangler r2 object get rp-backups/d1/2026-11-18.sql.gz --jurisdiction eu --remote --file backup.sql.gz`
2. Unzip it: `gunzip backup.sql.gz` (gives `backup.sql`). Open it in a text editor if you only need one record – it's readable.
3. To put the whole thing back:
   `npx wrangler d1 execute rp-app --remote --file backup.sql`
   This replaces all the tables listed above with the copy. Everything added since that night is lost, so copy out anything new first.
4. If the database itself was deleted: create a new D1 database called `rp-app` (EU jurisdiction), put its ID in `wrangler.jsonc`, run `npx wrangler d1 migrations apply DB --remote`, then step 3.

Delete `backup.sql` and `backup.sql.gz` from your computer when you're done – they contain personal data.

Never restore a live backup into the test database: test must not hold real people's details.
