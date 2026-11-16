'use strict';

/* Syspro work centre per department (migration 022). A department with no row
 * is not sent to Syspro. Keys are the department name trimmed, in lower case. */

const keyOf = (department) => String(department || '').trim().toLowerCase();

// Map: department key -> 'ASSY' | 'DESI'.
async function map(db) {
  const { rows } = await db.query('SELECT department_key, work_centre FROM syspro_work_centres');
  return new Map(rows.map((r) => [r.department_key, r.work_centre]));
}

/* Every department worth showing in Configuration: those of the people in Time
 * Slide, any with a work centre, and any on a time block (so an old name that
 * still has hours to export is not hidden). One row per key, with the name as
 * people have it, how many people in Time Slide have it, and its work centre. */
async function list(db) {
  const { rows } = await db.query(`
    WITH names AS (
      SELECT btrim(department) AS name FROM users WHERE included AND department IS NOT NULL AND btrim(department) <> ''
      UNION ALL SELECT department FROM syspro_work_centres
      UNION ALL SELECT DISTINCT btrim(department) FROM time_sessions WHERE department IS NOT NULL AND btrim(department) <> ''
    ),
    keyed AS (SELECT lower(name) AS key, min(name) AS name FROM names GROUP BY lower(name))
    SELECT k.key, COALESCE(w.department, k.name) AS name, w.work_centre,
           (SELECT count(*)::int FROM users u WHERE u.included AND lower(btrim(u.department)) = k.key) AS people,
           w.updated_at, ub.name AS updated_by
    FROM keyed k
    LEFT JOIN syspro_work_centres w ON w.department_key = k.key
    LEFT JOIN users ub ON ub.id = w.updated_by
    ORDER BY lower(COALESCE(w.department, k.name))`);
  return rows.map((r) => ({ key: r.key, name: r.name, workCentre: r.work_centre || null, people: r.people, updatedAt: r.updated_at || null, updatedBy: r.updated_by || null }));
}

// workCentre null removes the row: the department is not sent to Syspro.
async function set(db, department, workCentre, actorId) {
  const key = keyOf(department);
  if (!workCentre) {
    await db.query('DELETE FROM syspro_work_centres WHERE department_key = $1', [key]);
    return;
  }
  await db.query(
    `INSERT INTO syspro_work_centres (department_key, department, work_centre, updated_by) VALUES ($1, $2, $3, $4)
     ON CONFLICT (department_key) DO UPDATE SET department = EXCLUDED.department, work_centre = EXCLUDED.work_centre, updated_at = now(), updated_by = EXCLUDED.updated_by`,
    [key, String(department).trim(), workCentre, actorId]
  );
}

module.exports = { keyOf, map, list, set };
