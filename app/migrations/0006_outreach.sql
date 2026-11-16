-- Names for admins (shown in the "who's signed in" chip) and the producer outreach tracker.
ALTER TABLE users ADD COLUMN display_name TEXT;

CREATE TABLE outreach (
  id TEXT PRIMARY KEY,
  business_name TEXT NOT NULL,
  contact_name TEXT,
  kind TEXT NOT NULL DEFAULT 'unknown',         -- ltd | llp | sole | partnership | unknown
  company_number TEXT,
  email TEXT,
  phone TEXT,
  website TEXT,
  address TEXT,                                  -- postal address for letters (multi-line)
  town TEXT,
  county TEXT,
  products TEXT,                                 -- what they make, used in the email ("your cheese")
  source TEXT,                                   -- where we found them
  stage TEXT NOT NULL DEFAULT 'todo',            -- todo | contacted | replied | joined | no_reply | not_interested
  contact_count INTEGER NOT NULL DEFAULT 0,      -- 1 = first contact done, 2 = follow-up done
  last_contact_on TEXT,                          -- YYYY-MM-DD
  follow_up_on TEXT,                             -- YYYY-MM-DD
  assigned_to TEXT REFERENCES users(id) ON DELETE SET NULL,
  producer_id TEXT REFERENCES producers(id) ON DELETE SET NULL,
  created_by TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX outreach_stage ON outreach(stage, follow_up_on);
CREATE INDEX outreach_email ON outreach(email);
CREATE INDEX outreach_updated ON outreach(updated_at);

CREATE TABLE outreach_notes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  outreach_id TEXT NOT NULL REFERENCES outreach(id) ON DELETE CASCADE,
  by_user TEXT,
  body TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX outreach_notes_item ON outreach_notes(outreach_id);
