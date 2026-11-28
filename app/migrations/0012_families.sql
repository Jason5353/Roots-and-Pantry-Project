-- Stage 2, part 1: family groups, members and invites.
-- A person (users row) can belong to several groups. Each group is run by its own admins.
CREATE TABLE family_groups (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,                 -- surname/family name, shown as "<name> Family Recipes"
  created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE family_members (
  group_id TEXT NOT NULL REFERENCES family_groups(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  display_name TEXT NOT NULL,         -- how the family sees them ("Nana Mags")
  role TEXT NOT NULL DEFAULT 'member', -- admin | member  (children come later)
  adult_confirmed_at INTEGER NOT NULL, -- they ticked "I'm 18 or over"
  joined_at INTEGER NOT NULL,
  PRIMARY KEY (group_id, user_id)
);
CREATE INDEX family_members_user ON family_members(user_id);

CREATE TABLE family_invites (
  id TEXT PRIMARY KEY,
  group_id TEXT NOT NULL REFERENCES family_groups(id) ON DELETE CASCADE,
  email TEXT NOT NULL,
  display_name TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'member',
  token_hash TEXT NOT NULL UNIQUE,    -- sha256 of the link token; the token itself is never stored
  invited_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  accepted_at INTEGER,
  revoked_at INTEGER
);
CREATE INDEX family_invites_group ON family_invites(group_id);
CREATE INDEX family_invites_email ON family_invites(email);
