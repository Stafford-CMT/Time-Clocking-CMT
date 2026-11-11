'use strict';

/* Raw SQL for Reports. Every function takes `db` -- the pool, or a
 * transaction client from withTransaction. Read only.
 */

// Contract time (never Non-contract) in a date range, added up per contract
// (number + suffix), department, person and rework reason, committed or not.
// Stopped time blocks only: a running clock counts once it stops.
async function contractHours(db, { from, to }) {
  const { rows } = await db.query(
    `SELECT c.number, c.suffix, c.suffix_description, c.customer_name, c.machine_type,
            COALESCE(NULLIF(s.department, ''), 'No department') AS department,
            u.id AS user_id, u.name AS person,
            COALESCE(s.rework_reason, '') AS rework_reason,
            SUM(EXTRACT(EPOCH FROM s.end_time - s.start_time))::int AS seconds,
            COUNT(*)::int AS blocks,
            to_char(MIN(s.date), 'YYYY-MM-DD') AS first_date,
            to_char(MAX(s.date), 'YYYY-MM-DD') AS last_date
       FROM time_sessions s
       JOIN contracts c ON c.id = s.contract_id AND NOT c.system
       JOIN users u ON u.id = s.user_id
      WHERE s.date BETWEEN $1 AND $2
      GROUP BY c.number, c.suffix, c.suffix_description, c.customer_name, c.machine_type, 6, u.id, u.name, 9
      HAVING SUM(EXTRACT(EPOCH FROM s.end_time - s.start_time)) > 0`,
    [from, to]
  );
  return rows;
}

module.exports = { contractHours };
