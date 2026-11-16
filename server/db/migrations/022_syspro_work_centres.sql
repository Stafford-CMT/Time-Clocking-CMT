-- Syspro work centre per department (Setup -> Configuration, admins). The
-- export's "Syspro import" sheet sends a time block's hours to the work centre
-- of the block's department: ASSY (operation 1) or DESI (operation 2), the only
-- two Syspro has. A department with no row here is not sent to Syspro; its
-- hours are listed on the "Not in Syspro import" sheet instead.
-- Departments come from Microsoft 365 (users.department) and are matched in
-- any case, so department_key is the name trimmed and in lower case.

CREATE TABLE syspro_work_centres (
  department_key TEXT PRIMARY KEY CHECK (department_key = lower(btrim(department_key)) AND department_key <> ''),
  department     TEXT NOT NULL,      -- the name as shown
  work_centre    TEXT NOT NULL CHECK (work_centre IN ('ASSY', 'DESI')),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by     TEXT REFERENCES users(id) ON DELETE SET NULL
);

-- Stafford, 16 Nov 2026: the design departments go to DESI, Assembly to ASSY.
-- (Until now only "Design" and "Assembly" were sent.)
INSERT INTO syspro_work_centres (department_key, department, work_centre) VALUES
  ('assembly', 'Assembly', 'ASSY'),
  ('design', 'Design', 'DESI'),
  ('electrical', 'Electrical', 'DESI'),
  ('mechatronics', 'Mechatronics', 'DESI');
