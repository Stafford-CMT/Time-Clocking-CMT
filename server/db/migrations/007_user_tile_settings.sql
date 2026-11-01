-- Hidden, pinned and tile order are now per user on top of the shared tile
-- list. A tile with no row for a user is hidden for them (new tiles show only
-- for whoever added them); contracts.sort_order stays as the creation order
-- that unordered tiles fall back to. Everyone starts with today's shared
-- layout so no one's dashboard changes.
CREATE TABLE user_tile_settings (
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  contract_id TEXT NOT NULL REFERENCES contracts(id) ON DELETE CASCADE,
  hidden      BOOLEAN NOT NULL DEFAULT false,
  pinned      BOOLEAN NOT NULL DEFAULT false,
  sort_order  INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, contract_id)
);
INSERT INTO user_tile_settings (user_id, contract_id, hidden, pinned, sort_order)
  SELECT u.id, c.id, c.hidden, c.pinned, c.sort_order FROM users u CROSS JOIN contracts c WHERE NOT c.system;
ALTER TABLE contracts DROP COLUMN pinned;
ALTER TABLE contracts DROP COLUMN hidden;
