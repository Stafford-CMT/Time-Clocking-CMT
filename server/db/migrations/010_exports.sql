-- Setup -> Data export: which person-days have been exported, so a day is
-- never exported twice. Each download makes a batch of committed days that
-- weren't exported yet. Undoing a batch (admin) frees its days to go again.

CREATE TABLE export_batches (
  id          TEXT PRIMARY KEY,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by  TEXT REFERENCES users(id) ON DELETE SET NULL,
  date_from   DATE NOT NULL,
  date_to     DATE NOT NULL,
  undone_at   TIMESTAMPTZ,
  undone_by   TEXT REFERENCES users(id) ON DELETE SET NULL,
  file        BYTEA NOT NULL -- the spreadsheet as downloaded, so it can be downloaded again exactly
);

-- One row per exported person-day. `snapshot` is what went out:
-- {"<contract id>": seconds, ...}, compared with the live times to flag a day
-- an admin has changed since. Rows of an undone batch are deleted, so the
-- primary key is what stops a day being exported twice.
CREATE TABLE exported_days (
  user_id   TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  date      DATE NOT NULL,
  batch_id  TEXT NOT NULL REFERENCES export_batches(id) ON DELETE CASCADE,
  snapshot  JSONB NOT NULL,
  CONSTRAINT exported_days_pkey PRIMARY KEY (user_id, date)
);
CREATE INDEX idx_exported_days_batch ON exported_days(batch_id);

-- When each person was last sent a "please commit your times" email.
CREATE TABLE commit_reminders (
  id        TEXT PRIMARY KEY,
  user_id   TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  sent_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  sent_by   TEXT REFERENCES users(id) ON DELETE SET NULL,
  dates     DATE[] NOT NULL
);
CREATE INDEX idx_commit_reminders_user ON commit_reminders(user_id, sent_at);
