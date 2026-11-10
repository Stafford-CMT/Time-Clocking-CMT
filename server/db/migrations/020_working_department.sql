-- Working in another department. Each time block records the department its
-- time belongs to (Syspro needs it). It is normally the person's own (from
-- Entra ID, users.department); for the odd day helping elsewhere they tap
-- "Working in" on the dashboard and pick another. That choice lasts for the day
-- it was made (working_department_on) and is forgotten overnight.
--
-- Like the rework reason, the department travels with the running clock,
-- through a break pause, onto every block it records, and is kept as text on
-- each block so later Entra changes don't rewrite history.

ALTER TABLE users ADD COLUMN working_department TEXT;
ALTER TABLE users ADD COLUMN working_department_on DATE;

ALTER TABLE active_sessions ADD COLUMN department TEXT;
ALTER TABLE user_break_state ADD COLUMN department TEXT;
ALTER TABLE time_sessions ADD COLUMN department TEXT;

-- Everything recorded so far was for the person's own department.
UPDATE time_sessions s SET department = u.department FROM users u WHERE u.id = s.user_id AND s.department IS NULL;
UPDATE active_sessions a SET department = u.department FROM users u WHERE u.id = a.user_id AND a.department IS NULL;
UPDATE user_break_state b SET department = u.department FROM users u WHERE u.id = b.user_id AND b.department IS NULL;
-- Deleted blocks kept for Undo come back with it too.
UPDATE removed_time_sessions r SET row = r.row || jsonb_build_object('department', u.department)
  FROM users u WHERE u.id = r.user_id AND NOT (r.row ? 'department');
