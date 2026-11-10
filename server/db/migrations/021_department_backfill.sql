-- On 10 Nov 2026 the first try at deploying 020 applied it, but the app failed
-- to restart and the previous version was put back. That version doesn't know
-- about departments, so anything it clocked until the next deploy has none.
-- Those blocks were for the person's own department: fill it in, as 020 did.
-- Safe to run more than once; a block that already has a department keeps it.

UPDATE time_sessions s SET department = u.department FROM users u WHERE u.id = s.user_id AND s.department IS NULL;
UPDATE active_sessions a SET department = u.department FROM users u WHERE u.id = a.user_id AND a.department IS NULL;
UPDATE user_break_state b SET department = u.department FROM users u WHERE u.id = b.user_id AND b.department IS NULL;
UPDATE removed_time_sessions r SET row = r.row || jsonb_build_object('department', u.department)
  FROM users u WHERE u.id = r.user_id AND (r.row ->> 'department') IS NULL;
