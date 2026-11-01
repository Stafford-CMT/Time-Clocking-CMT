-- Breaks are now paused and resumed by the server at the scheduled times,
-- not by an open browser. resume_at is when the paused clock restarts (the
-- end of the break). Anything paused the old way resumes at the next sweep.
ALTER TABLE user_break_state ADD COLUMN resume_at TIMESTAMPTZ;
UPDATE user_break_state SET resume_at = now();
ALTER TABLE user_break_state ALTER COLUMN resume_at SET NOT NULL;
