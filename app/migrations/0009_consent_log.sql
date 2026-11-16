-- Permission history for outreach: given / withdrawn / reopened, kept for audits.
ALTER TABLE outreach ADD COLUMN consent_withdrawn_at INTEGER;
CREATE TABLE outreach_consent_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  outreach_id TEXT NOT NULL REFERENCES outreach(id) ON DELETE CASCADE,
  event TEXT NOT NULL,          -- given | withdrawn | reopened
  channel TEXT,                 -- email | facebook | email+facebook | all
  detail TEXT,                  -- wording they agreed to, or how they said no
  by_user TEXT,                 -- admin who recorded it (null = the producer, on the website form)
  created_at INTEGER NOT NULL
);
CREATE INDEX outreach_consent_log_item ON outreach_consent_log(outreach_id);
