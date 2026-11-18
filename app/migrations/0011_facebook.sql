-- Automatic posts to the Roots & Pantry Facebook page: a producer going live, or a new offer.
-- Each thing is queued once, held for an hour (so an admin can cancel it), then posted by the
-- hourly cron. The text is written when it is posted, so edits made during the hold are used.
CREATE TABLE fb_posts (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,                   -- producer | offer
  item_id TEXT NOT NULL,                -- producers.id or offers.id
  producer_id TEXT NOT NULL REFERENCES producers(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'queued', -- queued | posted | cancelled | skipped | failed | dry_run
  post_after INTEGER NOT NULL,          -- unix time
  message TEXT,                         -- what was (or would have been) posted
  link TEXT,
  fb_post_id TEXT,
  note TEXT,                            -- why skipped or failed, or who cancelled it
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX fb_posts_item ON fb_posts(kind, item_id);
CREATE INDEX fb_posts_due ON fb_posts(status, post_after);
