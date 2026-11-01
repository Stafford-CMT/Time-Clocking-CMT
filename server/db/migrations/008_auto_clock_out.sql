-- Auto clock-out: the server stops a person's running clock at this time of
-- day. NULL means at the end of their working day (working_times."end"), and
-- a time earlier than that end is never used -- whichever is later wins.
ALTER TABLE users ADD COLUMN auto_clock_out TIME;

-- A session the server ended at someone's auto clock-out time. auto_stopped
-- stays true until they check it (change its end, keep it, or commit the
-- day); auto_noticed records that they have seen the dashboard message.
ALTER TABLE time_sessions ADD COLUMN auto_stopped BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE time_sessions ADD COLUMN auto_noticed BOOLEAN NOT NULL DEFAULT false;
