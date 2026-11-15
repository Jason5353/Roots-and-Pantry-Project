-- Step 3: richer listings and deals.
ALTER TABLE producers ADD COLUMN slug TEXT;
ALTER TABLE producers ADD COLUMN shop_address TEXT;          -- shop or farm shop address (optional)
ALTER TABLE producers ADD COLUMN market_days TEXT;           -- e.g. "Wellington Market, Thursdays 9am-2pm" (optional)
ALTER TABLE producers ADD COLUMN delivery_reach TEXT NOT NULL DEFAULT 'none'; -- none | local | miles | uk
ALTER TABLE producers ADD COLUMN delivery_miles INTEGER;
CREATE UNIQUE INDEX producers_slug ON producers(slug);

CREATE TABLE deals (
  id TEXT PRIMARY KEY,
  producer_id TEXT NOT NULL REFERENCES producers(id) ON DELETE CASCADE,
  title TEXT NOT NULL,                 -- e.g. "10% off all our cheeses"
  kind TEXT NOT NULL,                  -- percent | free_item
  percent INTEGER,                     -- 10-100 when kind = percent
  free_item TEXT,                      -- when kind = free_item
  products TEXT NOT NULL,              -- comma-separated product words, matched to recipe ingredients
  how TEXT NOT NULL,                   -- online | in_person | both
  redemption TEXT NOT NULL,            -- code | mention
  code TEXT,                           -- when redemption = code
  online_url TEXT,                     -- where to use it online
  small_print TEXT,
  allergens TEXT,
  alcohol INTEGER NOT NULL DEFAULT 0,  -- 1 = shown to adults (18+) only
  starts_on TEXT NOT NULL,             -- YYYY-MM-DD
  ends_on TEXT NOT NULL,               -- YYYY-MM-DD, at least 14 days after starts_on
  status TEXT NOT NULL DEFAULT 'active', -- active | paused | ended
  reminder_sent_on TEXT,               -- ends_on value the 7-day reminder was sent for
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX deals_producer ON deals(producer_id);
CREATE INDEX deals_ends ON deals(ends_on);
