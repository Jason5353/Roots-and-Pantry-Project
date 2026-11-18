-- Offers & specials: a producer's own offers (multibuys, Christmas pre-orders, gift boxes),
-- shown below the Roots & Pantry exclusive deals. Not exclusive, no code. At least 3 days.
CREATE TABLE offers (
  id TEXT PRIMARY KEY,
  producer_id TEXT NOT NULL REFERENCES producers(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,                  -- multibuy | preorder | seasonal
  title TEXT NOT NULL,                 -- e.g. "4 sausages for £12.50"
  price TEXT NOT NULL,                 -- e.g. "£12.50 for 4", "From £45"
  details TEXT,
  ready_text TEXT,                     -- pre-orders: when to collect or when it's delivered
  how TEXT NOT NULL,                   -- online | in_person | both
  order_url TEXT,
  allergens TEXT,
  alcohol INTEGER NOT NULL DEFAULT 0,  -- 1 = adults only
  christmas INTEGER NOT NULL DEFAULT 0,
  starts_on TEXT NOT NULL,             -- YYYY-MM-DD
  ends_on TEXT NOT NULL,               -- YYYY-MM-DD; for pre-orders this is the order-by date
  status TEXT NOT NULL DEFAULT 'active', -- active | paused | ended
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX offers_producer ON offers(producer_id);
CREATE INDEX offers_ends ON offers(ends_on);

-- Exclusive deals can be tagged Christmas too, for the Christmas page.
ALTER TABLE deals ADD COLUMN christmas INTEGER NOT NULL DEFAULT 0;
