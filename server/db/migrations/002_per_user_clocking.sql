-- Clocking state becomes per user now that several people share one database.

-- Break auto-pause: was a single global row, so only one person at a time
-- could be paused for a break.
DROP TABLE break_state;
CREATE TABLE user_break_state (
  user_id     TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  contract_id TEXT NOT NULL REFERENCES contracts(id) ON DELETE CASCADE
);

-- Committing a day now locks one user's times, not everyone's. Existing
-- global commits can't be attributed to a user, so they are dropped.
DROP TABLE committed_dates;
CREATE TABLE committed_dates (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  date    DATE NOT NULL,
  CONSTRAINT committed_dates_user_date_pkey PRIMARY KEY (user_id, date)
);

-- The shared "Admin mode" flag let any signed-in user unlock everyone's
-- committed days. The server now checks users.user_type = 'admin' instead;
-- the checkbox is a per-browser safety catch that only admins see.
DROP TABLE app_settings;
