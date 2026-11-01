'use strict';

/* Raw SQL for the clocking tables: active_sessions, time_sessions,
 * user_break_state, committed_dates. Every function takes `db` -- the pool,
 * or a transaction client from withTransaction -- so clockService can group
 * several calls into one transaction.
 */

// Serialises clock actions for one user (e.g. a double-clicked Start). Locks
// the users row because it always exists, unlike the active_sessions row
// that is about to be inserted or deleted.
async function lockUser(db, userId) {
  await db.query('SELECT id FROM users WHERE id = $1 FOR UPDATE', [userId]);
}

async function contractExists(db, contractId) {
  const { rows } = await db.query('SELECT id FROM contracts WHERE id = $1', [contractId]);
  return rows.length > 0;
}

async function findActive(db, userId) {
  const { rows } = await db.query('SELECT contract_id, started_at FROM active_sessions WHERE user_id = $1', [userId]);
  if (!rows.length) return null;
  return { contractId: rows[0].contract_id, startedAt: new Date(rows[0].started_at).getTime() };
}

async function setActive(db, userId, contractId, startedAt) {
  await db.query('INSERT INTO active_sessions (user_id, contract_id, started_at) VALUES ($1, $2, $3)', [userId, contractId, startedAt]);
}

async function clearActive(db, userId) {
  await db.query('DELETE FROM active_sessions WHERE user_id = $1', [userId]);
}

function toSession(row) {
  return { id: row.id, contractId: row.contract_id, userId: row.user_id, date: row.date, start: row.start_time, end: row.end_time, unlinkedStart: row.unlinked_start, unlinkedEnd: row.unlinked_end, autoStopped: row.auto_stopped, autoNoticed: row.auto_noticed };
}

async function insertTimeSession(db, { id, contractId, userId, date, start, end, autoStopped = false }) {
  await db.query(
    'INSERT INTO time_sessions (id, contract_id, user_id, date, start_time, end_time, auto_stopped) VALUES ($1, $2, $3, $4, $5, $6, $7)',
    [id, contractId, userId, date, start, end, autoStopped]
  );
}

async function findTimeSession(db, id) {
  const { rows } = await db.query('SELECT * FROM time_sessions WHERE id = $1', [id]);
  return rows[0] ? toSession(rows[0]) : null;
}

async function updateTimeSession(db, id, { start, end, unlinkedStart, unlinkedEnd, autoStopped }) {
  await db.query(
    'UPDATE time_sessions SET start_time = $2, end_time = $3, unlinked_start = $4, unlinked_end = $5, auto_stopped = $6 WHERE id = $1',
    [id, start, end, unlinkedStart, unlinkedEnd, autoStopped]
  );
}

// The dashboard's "stopped automatically" message has been seen.
async function markAutoNoticed(db, userId, ids) {
  await db.query('UPDATE time_sessions SET auto_noticed = true WHERE user_id = $1 AND id = ANY($2)', [userId, ids]);
}

// Committing a day counts as checking its auto clock-outs.
async function clearAutoStopped(db, userId, date) {
  await db.query('UPDATE time_sessions SET auto_stopped = false WHERE user_id = $1 AND date = $2', [userId, date]);
}

// Everyone with a clock running or paused for a break: the people the
// server's clock schedule (breaks, auto clock-out) may need to act for.
async function findScheduledClockUsers(db) {
  const { rows } = await db.query('SELECT user_id FROM active_sessions UNION SELECT user_id FROM user_break_state');
  return rows.map((r) => r.user_id);
}

/* A person's day as the clock schedule sees it, or null without working
 * times: clockOut is the later of users.auto_clock_out and the end of their
 * working day (GREATEST skips a NULL auto_clock_out); times are 'HH:MM:SS'. */
async function findClockSchedule(db, userId) {
  const { rows } = await db.query(
    `SELECT w.id, GREATEST(u.auto_clock_out, w."end") AS clock_out
       FROM working_times w JOIN users u ON u.id = w.user_id
      WHERE w.user_id = $1`,
    [userId]
  );
  if (!rows[0]) return null;
  const breaks = (await db.query('SELECT start, "end" FROM working_time_breaks WHERE working_time_id = $1 ORDER BY start', [rows[0].id])).rows;
  return { clockOut: rows[0].clock_out, breaks: breaks.map((b) => ({ start: b.start, end: b.end })) };
}

async function deleteTimeSession(db, id) {
  await db.query('DELETE FROM time_sessions WHERE id = $1', [id]);
}

async function findBreakState(db, userId) {
  const { rows } = await db.query('SELECT contract_id, resume_at FROM user_break_state WHERE user_id = $1', [userId]);
  return rows[0] ? { contractId: rows[0].contract_id, resumeAt: new Date(rows[0].resume_at).getTime() } : null;
}

async function setBreakState(db, userId, contractId, resumeAt) {
  await db.query('INSERT INTO user_break_state (user_id, contract_id, resume_at) VALUES ($1, $2, $3)', [userId, contractId, new Date(resumeAt)]);
}

async function clearBreakState(db, userId) {
  await db.query('DELETE FROM user_break_state WHERE user_id = $1', [userId]);
}

async function isCommitted(db, userId, date) {
  const { rows } = await db.query('SELECT 1 FROM committed_dates WHERE user_id = $1 AND date = $2', [userId, date]);
  return rows.length > 0;
}

async function addCommit(db, userId, date) {
  await db.query('INSERT INTO committed_dates (user_id, date) VALUES ($1, $2) ON CONFLICT DO NOTHING', [userId, date]);
}

async function removeCommit(db, userId, date) {
  await db.query('DELETE FROM committed_dates WHERE user_id = $1 AND date = $2', [userId, date]);
}

/* The clocking half of GET /api/state. Running clocks are visible for
 * everyone (the dashboard's "active contracts" count uses them); completed
 * sessions and commits only for the viewer, unless they are an admin, who
 * can review and unlock anyone's times.
 */
async function getClockState(db, userId, allUsers) {
  const activeRows = (await db.query('SELECT user_id, contract_id, started_at FROM active_sessions')).rows;
  const activeSessions = {};
  activeRows.forEach((r) => {
    activeSessions[r.contract_id] = activeSessions[r.contract_id] || {};
    activeSessions[r.contract_id][r.user_id] = new Date(r.started_at).getTime();
  });

  const scope = allUsers ? ['', []] : ['WHERE user_id = $1', [userId]];
  const sessionRows = (await db.query(`SELECT * FROM time_sessions ${scope[0]} ORDER BY contract_id, date, start_time`, scope[1])).rows;
  const editSessions = {};
  sessionRows.forEach((row) => {
    const { contractId, ...session } = toSession(row);
    (editSessions[contractId] = editSessions[contractId] || []).push(session);
  });

  const committedDates = (await db.query(`SELECT user_id, date FROM committed_dates ${scope[0]} ORDER BY date`, scope[1])).rows
    .map((r) => ({ userId: r.user_id, date: r.date }));

  return { activeSessions, editSessions, committedDates, breakState: await findBreakState(db, userId) };
}

module.exports = {
  lockUser, contractExists, findActive, setActive, clearActive,
  insertTimeSession, findTimeSession, updateTimeSession, deleteTimeSession,
  markAutoNoticed, clearAutoStopped, findScheduledClockUsers, findClockSchedule,
  findBreakState, setBreakState, clearBreakState,
  isCommitted, addCommit, removeCommit, getClockState,
};
