-- Outreach: separate Facebook and Instagram links, and a postcode.
ALTER TABLE outreach ADD COLUMN facebook TEXT;
ALTER TABLE outreach ADD COLUMN instagram TEXT;
ALTER TABLE outreach ADD COLUMN postcode TEXT;
