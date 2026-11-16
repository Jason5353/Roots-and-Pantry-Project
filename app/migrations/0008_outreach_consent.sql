-- Outreach: record permission from sole traders and partnerships (e.g. the "tell me more" form).
ALTER TABLE outreach ADD COLUMN consent_email_at INTEGER;     -- when they agreed to email about joining
ALTER TABLE outreach ADD COLUMN consent_facebook_at INTEGER;  -- when they agreed to a Facebook message
ALTER TABLE outreach ADD COLUMN consent_how TEXT;             -- how they agreed, with the wording shown
