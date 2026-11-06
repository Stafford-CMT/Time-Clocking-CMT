-- Time entered by hand on Edit times (a forgotten clock, added afterwards) is
-- marked with who entered it and when; NULL = recorded by the clock.
ALTER TABLE time_sessions ADD COLUMN entered_by TEXT REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE time_sessions ADD COLUMN entered_at TIMESTAMPTZ;

-- A deleted time block, kept so Undo can put back exactly what was deleted
-- (and nothing else): undo restores from here, never from what the browser sends.
CREATE TABLE removed_time_sessions (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL,
  row        JSONB NOT NULL,
  removed_by TEXT,
  removed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
