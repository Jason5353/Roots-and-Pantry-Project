-- Step 4: admin review of producers.
ALTER TABLE producers ADD COLUMN status_reason TEXT;   -- shown to the producer when rejected or suspended
ALTER TABLE producers ADD COLUMN reviewed_at INTEGER;
ALTER TABLE producers ADD COLUMN reviewed_by TEXT;     -- users.id of the admin
CREATE INDEX producers_status ON producers(status);
CREATE INDEX messages_status ON messages(status);
CREATE INDEX audit_target ON audit_log(target);
CREATE INDEX audit_created ON audit_log(created_at);
