'use strict';

/* Raw SQL for Setup -> Data export: the per-day overview, export batches
 * (export_batches, exported_days) and commit reminders. Every function takes
 * `db` -- the pool, or a transaction client from withTransaction. userIds
 * (a list of user ids) null means everyone in Time Slide.
 */

// Only one export batch is made at a time, so two admins clicking Download
// together can't both pick up the same days.
async function lockExports(db) {
  await db.query("SELECT pg_advisory_xact_lock(hashtext('time-slide-export'))");
}

// Everyone in Time Slide, plus anyone since taken out who still has time in the range.
async function listPeople(db, { from, to, userIds = null }) {
  const { rows } = await db.query(
    `SELECT id, name, email FROM users
      WHERE (included OR id IN (SELECT user_id FROM time_sessions WHERE date BETWEEN $1 AND $2))
        AND ($3::text[] IS NULL OR id = ANY($3))
      ORDER BY name`,
    [from, to, userIds]
  );
  return rows;
}

// Seconds per person, day and contract: the overview's hours and what an
// exported day's snapshot is compared against.
async function findDayTotals(db, { from, to, userIds = null }) {
  const { rows } = await db.query(
    `SELECT user_id, date, contract_id, SUM(EXTRACT(EPOCH FROM end_time - start_time))::int AS seconds
       FROM time_sessions
      WHERE date BETWEEN $1 AND $2 AND ($3::text[] IS NULL OR user_id = ANY($3))
      GROUP BY user_id, date, contract_id`,
    [from, to, userIds]
  );
  return rows;
}

async function findCommittedDays(db, { from, to, userIds = null }) {
  const { rows } = await db.query(
    'SELECT user_id, date FROM committed_dates WHERE date BETWEEN $1 AND $2 AND ($3::text[] IS NULL OR user_id = ANY($3))',
    [from, to, userIds]
  );
  return rows;
}

async function findExportedDays(db, { from, to, userIds = null }) {
  const { rows } = await db.query(
    `SELECT e.user_id, e.date, e.batch_id, e.snapshot, b.created_at
       FROM exported_days e JOIN export_batches b ON b.id = e.batch_id
      WHERE e.date BETWEEN $1 AND $2 AND ($3::text[] IS NULL OR e.user_id = ANY($3))`,
    [from, to, userIds]
  );
  return rows;
}

async function findRunningClocks(db, userIds = null) {
  const { rows } = await db.query('SELECT user_id, started_at FROM active_sessions WHERE $1::text[] IS NULL OR user_id = ANY($1)', [userIds]);
  return rows;
}

async function findLastReminders(db, userIds = null) {
  const { rows } = await db.query(
    'SELECT user_id, MAX(sent_at) AS sent_at FROM commit_reminders WHERE $1::text[] IS NULL OR user_id = ANY($1) GROUP BY user_id',
    [userIds]
  );
  return rows;
}

async function addReminder(db, { id, userId, sentBy, dates }) {
  await db.query('INSERT INTO commit_reminders (id, user_id, sent_by, dates) VALUES ($1, $2, $3, $4)', [id, userId, sentBy, dates]);
}

// Batches that cover any day of the range, newest first (without the file).
async function listBatches(db, { from, to }) {
  const { rows } = await db.query(
    `SELECT b.id, b.created_at, b.date_from, b.date_to, b.undone_at, c.name AS created_by_name, u.name AS undone_by_name,
            (SELECT COUNT(*)::int FROM exported_days e WHERE e.batch_id = b.id) AS days
       FROM export_batches b
       LEFT JOIN users c ON c.id = b.created_by
       LEFT JOIN users u ON u.id = b.undone_by
      WHERE b.date_from <= $2 AND b.date_to >= $1
      ORDER BY b.created_at DESC`,
    [from, to]
  );
  return rows;
}

async function insertBatch(db, { id, createdBy, from, to, file }) {
  await db.query('INSERT INTO export_batches (id, created_by, date_from, date_to, file) VALUES ($1, $2, $3, $4, $5)', [id, createdBy, from, to, file]);
}

async function insertExportedDay(db, { userId, date, batchId, snapshot }) {
  await db.query('INSERT INTO exported_days (user_id, date, batch_id, snapshot) VALUES ($1, $2, $3, $4)', [userId, date, batchId, snapshot]);
}

async function findBatch(db, id) {
  const { rows } = await db.query('SELECT id, date_from, date_to, undone_at, file FROM export_batches WHERE id = $1', [id]);
  return rows[0] || null;
}

async function undoBatch(db, id, undoneBy) {
  await db.query('DELETE FROM exported_days WHERE batch_id = $1', [id]);
  await db.query('UPDATE export_batches SET undone_at = now(), undone_by = $2 WHERE id = $1', [id, undoneBy]);
}

module.exports = {
  lockExports, listPeople, findDayTotals, findCommittedDays, findExportedDays, findRunningClocks,
  findLastReminders, addReminder, listBatches, insertBatch, insertExportedDay, findBatch, undoBatch,
};
