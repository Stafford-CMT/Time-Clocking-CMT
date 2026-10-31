-- Time-Clocking-CMT initial schema.
-- snake_case, unquoted (Postgres folds unquoted identifiers to lowercase
-- already) -- there's no legacy schema to match here, so this just follows
-- ordinary Postgres convention rather than the base blueprint's PascalCase.
-- Mirrors the shape of the browser prototype's single localStorage `state`
-- blob one table at a time; see server/README.md for the mapping.

-- Per-user accounts. Identity comes from Azure AD (Entra ID) SSO --
-- microsoft_oid is the stable Azure AD object id (the ID token's 'oid'
-- claim), which never changes even if the user's email/UPN is later
-- renamed. A row is only ever created at first sign-in (see authService),
-- always as role='user' -- nobody is ever auto-admin.
CREATE TABLE users (
  id             TEXT PRIMARY KEY,
  microsoft_oid  TEXT UNIQUE NOT NULL,
  email          TEXT UNIQUE,
  name           TEXT NOT NULL,
  user_type      TEXT NOT NULL DEFAULT 'user' CHECK (user_type IN ('admin', 'manager', 'user')),
  cost_centre    TEXT,
  is_active      BOOLEAN NOT NULL DEFAULT true,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_login_at  TIMESTAMPTZ
);

CREATE TABLE contracts (
  id                  TEXT PRIMARY KEY,
  customer_name       TEXT NOT NULL DEFAULT '',
  number              TEXT NOT NULL DEFAULT '',
  suffix              TEXT NOT NULL DEFAULT '',
  suffix_description  TEXT NOT NULL DEFAULT '',
  machine_type        TEXT NOT NULL DEFAULT '',
  image               TEXT, -- data: URL, same as the localStorage prototype; fine at this data volume
  pinned              BOOLEAN NOT NULL DEFAULT false,
  hidden              BOOLEAN NOT NULL DEFAULT false,
  sort_order          INTEGER NOT NULL DEFAULT 0 -- replaces the old state.order array
);

-- A user can only ever have one contract clock running at a time (toggleClock
-- stops whatever else was running for that user before starting a new one),
-- so user_id alone is enough as the primary key -- no contract_id needed in it.
CREATE TABLE active_sessions (
  user_id     TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  contract_id TEXT NOT NULL REFERENCES contracts(id) ON DELETE CASCADE,
  started_at  TIMESTAMPTZ NOT NULL
);

-- Completed/committed clock sessions -- the Edit Times timeline. Ported 1:1
-- from state.editSessions[contractId][]; `unlinked` is the drag-without-
-- affecting-neighbours flag from the EXPERIMENTAL long-press feature in app.js.
CREATE TABLE time_sessions (
  id          TEXT PRIMARY KEY,
  contract_id TEXT NOT NULL REFERENCES contracts(id) ON DELETE CASCADE,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  date        DATE NOT NULL,
  start_time  TIME NOT NULL,
  end_time    TIME NOT NULL,
  unlinked    BOOLEAN NOT NULL DEFAULT false
);
CREATE INDEX idx_time_sessions_contract ON time_sessions(contract_id);
CREATE INDEX idx_time_sessions_user_date ON time_sessions(user_id, date);

-- Non-working-time entries (leave, etc). Kept for parity with the prototype's
-- state.nonWorking, even though the current UI doesn't render it yet (see
-- README's "Known gaps ported as-is" note) -- the README's planned "Non-working
-- time table" feature is what this is for.
CREATE TABLE non_working (
  id         TEXT PRIMARY KEY,
  date       DATE NOT NULL,
  category   TEXT NOT NULL DEFAULT '',
  start_time TIME NOT NULL,
  end_time   TIME NOT NULL
);

CREATE TABLE machine_types (
  name       TEXT PRIMARY KEY,
  sort_order INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE suffix_descriptions (
  name       TEXT PRIMARY KEY,
  sort_order INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE customers (
  name       TEXT PRIMARY KEY,
  sort_order INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE cost_centres (
  name       TEXT PRIMARY KEY,
  sort_order INTEGER NOT NULL DEFAULT 0
);

-- Singleton row (id is always 1) -- the "Default working times" panel.
CREATE TABLE default_working_times (
  id    INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  start TIME NOT NULL DEFAULT '07:00',
  "end" TIME NOT NULL DEFAULT '16:00'
);
-- Always exactly two rows (sort_order 0 and 1), matching the frontend's
-- fixed two-break-slot UI (#default-wt-break1-*, #default-wt-break2-*).
CREATE TABLE default_working_time_breaks (
  sort_order INTEGER PRIMARY KEY,
  start      TIME NOT NULL,
  "end"      TIME NOT NULL
);

-- Per-user working-time schedule (the Working Times calendar).
CREATE TABLE working_times (
  id      TEXT PRIMARY KEY,
  user_id TEXT NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  start   TIME NOT NULL,
  "end"   TIME NOT NULL
);
CREATE TABLE working_time_breaks (
  id              TEXT PRIMARY KEY,
  working_time_id TEXT NOT NULL REFERENCES working_times(id) ON DELETE CASCADE,
  type            TEXT NOT NULL DEFAULT 'Break',
  start           TIME NOT NULL,
  "end"           TIME NOT NULL,
  sort_order      INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_working_time_breaks_wt ON working_time_breaks(working_time_id);

-- Contract Information setup table + its expandable suffix sub-rows.
CREATE TABLE contract_info (
  id                       TEXT PRIMARY KEY,
  number                   TEXT NOT NULL DEFAULT '',
  machine_type             TEXT NOT NULL DEFAULT '',
  customer_name            TEXT NOT NULL DEFAULT '',
  one_drive_link           TEXT NOT NULL DEFAULT '',
  order_confirmation_link  TEXT NOT NULL DEFAULT '',
  expanded                 BOOLEAN NOT NULL DEFAULT false,
  sort_order               INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE contract_info_suffixes (
  id               TEXT PRIMARY KEY,
  contract_info_id TEXT NOT NULL REFERENCES contract_info(id) ON DELETE CASCADE,
  letter           TEXT NOT NULL DEFAULT '',
  description      TEXT NOT NULL DEFAULT '',
  sort_order       INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_contract_info_suffixes_parent ON contract_info_suffixes(contract_info_id);

-- Dates whose clocked times are locked from further editing.
CREATE TABLE committed_dates (
  date DATE PRIMARY KEY
);

-- Singleton row -- the "Admin mode" unlock toggle used to edit committed
-- dates. Kept as its own manual toggle (not derived from users.user_type)
-- to preserve the prototype's existing behaviour exactly; revisit once
-- real roles are wired into the frontend (see README's "Known gaps" note).
CREATE TABLE app_settings (
  id         INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  admin_mode BOOLEAN NOT NULL DEFAULT false
);
INSERT INTO app_settings (id, admin_mode) VALUES (1, false);

-- Singleton row -- state.breakState: which contract/user's clock is
-- currently auto-paused for a scheduled break (see handleBreakState in
-- app.js). NULL columns = no one is currently paused for a break.
CREATE TABLE break_state (
  id          INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  contract_id TEXT REFERENCES contracts(id) ON DELETE SET NULL,
  user_id     TEXT REFERENCES users(id) ON DELETE SET NULL
);
INSERT INTO break_state (id, contract_id, user_id) VALUES (1, NULL, NULL);
INSERT INTO default_working_times (id, start, "end") VALUES (1, '07:00', '16:00');
INSERT INTO default_working_time_breaks (sort_order, start, "end") VALUES
  (0, '09:00', '09:15'),
  (1, '12:30', '13:05');
