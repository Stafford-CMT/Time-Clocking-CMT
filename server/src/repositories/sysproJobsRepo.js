'use strict';

/* Raw SQL for Setup -> Syspro jobs. Every function takes `db` -- the pool, or a
 * transaction client from withTransaction. Read only.
 */

// Contract time (never Non-contract) in a date range, added up per contract
// number, suffix, rework reason ('' = ordinary time), and committed or not. Stopped time blocks only.
async function contractTime(db, { from, to }) {
  const { rows } = await db.query(
    `SELECT c.number, c.suffix,
            MAX(c.suffix_description) AS suffix_description, MAX(c.customer_name) AS customer_name,
            COALESCE(s.rework_reason, '') AS rework_reason,
            cd.user_id IS NOT NULL AS committed,
            SUM(EXTRACT(EPOCH FROM s.end_time - s.start_time))::int AS seconds
       FROM time_sessions s
       JOIN contracts c ON c.id = s.contract_id AND NOT c.system
       LEFT JOIN committed_dates cd ON cd.user_id = s.user_id AND cd.date = s.date
      WHERE s.date BETWEEN $1 AND $2
      GROUP BY c.number, c.suffix, 5, 6
      HAVING SUM(EXTRACT(EPOCH FROM s.end_time - s.start_time)) > 0`,
    [from, to]
  );
  return rows;
}

// Every contract tile's number and suffix, to say whether a Syspro job has a tile.
async function tileCodes(db) {
  const { rows } = await db.query('SELECT DISTINCT number, suffix FROM contracts WHERE NOT system');
  return rows;
}

module.exports = { contractTime, tileCodes };
