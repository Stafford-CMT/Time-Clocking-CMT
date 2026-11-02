-- Rework: a tile's clock can be started as rework, with a reason picked from
-- Lists -> Rework reasons (admins keep the list, like cost centres). The
-- reason travels with the running clock, through a break pause, onto every
-- time block it records. NULL = ordinary time. The reason is kept as text
-- on each block, so deleting it from the list later doesn't change history.

CREATE TABLE rework_reasons (
  name       TEXT PRIMARY KEY,
  sort_order INTEGER NOT NULL DEFAULT 0
);

ALTER TABLE active_sessions ADD COLUMN rework_reason TEXT;
ALTER TABLE user_break_state ADD COLUMN rework_reason TEXT;
ALTER TABLE time_sessions ADD COLUMN rework_reason TEXT;
