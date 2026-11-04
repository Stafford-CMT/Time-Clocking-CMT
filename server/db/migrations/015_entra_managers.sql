-- Managers see their team's times (view only). Who is in a team comes from
-- Entra ID: each person's manager, read by the staff sync. A Manager (set by
-- an admin in Lists -> Users) sees everyone below them in that chain.
-- NULL = no manager set in Entra, or not synced yet.

ALTER TABLE users ADD COLUMN manager_oid TEXT;
CREATE INDEX idx_users_manager_oid ON users(manager_oid);
