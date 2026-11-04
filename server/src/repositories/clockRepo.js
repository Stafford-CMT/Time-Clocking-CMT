'use strict';

/* Raw SQL for the clocking tables: active_sessions, time_sessions,
 * user_break_state, committed_dates. Every function takes `db` -- the pool,
 * or a transaction client from withTransaction -- so clockService can group
 * several calls into one transaction.
 */
const { timeToSeconds } = require('../utils/time');

const secondsToTime = (s) => [Math.floor(s / 3600), Math.floor((s % 3600) / 60), s % 60].map((n) => String(n).padStart(2, '0')).join(':');

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
  const { rows } = await db.query('SELECT contract_id, started_at, rework_reason FROM active_sessions WHERE user_id = $1', [userId]);
  if (!rows.length) return null;
  return { contractId: rows[0].contract_id, startedAt: new Date(rows[0].started_at).getTime(), reworkReason: rows[0].rework_reason };
}

// reworkReason: null for ordinary time, or the reason this clock is running as rework.
async function setActive(db, userId, contractId, startedAt, reworkReason = null) {
  await db.query('INSERT INTO active_sessions (user_id, contract_id, started_at, rework_reason) VALUES ($1, $2, $3, $4)', [userId, contractId, startedAt, reworkReason]);
}

async function reworkReasonExists(db, name) {
  const { rows } = await db.query('SELECT 1 FROM rework_reasons WHERE name = $1', [name]);
  return rows.length > 0;
}

async function clearActive(db, userId) {
  await db.query('DELETE FROM active_sessions WHERE user_id = $1', [userId]);
}

function toSession(row) {
  return { id: row.id, contractId: row.contract_id, userId: row.user_id, date: row.date, start: row.start_time, end: row.end_time, unlinkedStart: row.unlinked_start, unlinkedEnd: row.unlinked_end, autoStopped: row.auto_stopped, autoNoticed: row.auto_noticed, reworkReason: row.rework_reason };
}

async function insertTimeSession(db, { id, contractId, userId, date, start, end, autoStopped = false, reworkReason = null }) {
  await db.query(
    'INSERT INTO time_sessions (id, contract_id, user_id, date, start_time, end_time, auto_stopped, rework_reason) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)',
    [id, contractId, userId, date, start, end, autoStopped, reworkReason]
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

// End times ('HH:MM:SS') of the day's auto clock-outs nobody has checked yet -- a day with any can't be committed.
async function findUncheckedAutoStops(db, userId, date) {
  const { rows } = await db.query('SELECT end_time FROM time_sessions WHERE user_id = $1 AND date = $2 AND auto_stopped ORDER BY end_time', [userId, date]);
  return rows.map((row) => row.end_time);
}

// Everyone with a clock running or paused for a break: the people the
// server's clock schedule (breaks, auto clock-out) may need to act for.
async function findScheduledClockUsers(db) {
  const { rows } = await db.query('SELECT user_id FROM active_sessions UNION SELECT user_id FROM user_break_state');
  return rows.map((r) => r.user_id);
}

/* A person's day as the clock schedule sees it, or null without working
 * times. clockOut is their own auto clock-out time (never before the end of
 * their working day) or, without one, the end of their working day plus the
 * default delay, capped at midnight; times are 'HH:MM:SS'. */
async function findClockSchedule(db, userId) {
  const { rows } = await db.query(
    `SELECT w.id, w."end", u.auto_clock_out, d.auto_clock_out_delay
       FROM working_times w JOIN users u ON u.id = w.user_id CROSS JOIN default_working_times d
      WHERE w.user_id = $1 AND d.id = 1`,
    [userId]
  );
  if (!rows[0]) return null;
  const { id, end, auto_clock_out: own, auto_clock_out_delay: delay } = rows[0];
  const clockOut = own
    ? Math.max(timeToSeconds(own), timeToSeconds(end))
    : Math.min(timeToSeconds(end) + delay * 60, 24 * 3600);
  const breaks = (await db.query('SELECT start, "end" FROM working_time_breaks WHERE working_time_id = $1 ORDER BY start', [id])).rows;
  return { clockOut: secondsToTime(clockOut), breaks: breaks.map((b) => ({ start: b.start, end: b.end })) };
}

async function deleteTimeSession(db, id) {
  await db.query('DELETE FROM time_sessions WHERE id = $1', [id]);
}

async function findBreakState(db, userId) {
  const { rows } = await db.query('SELECT contract_id, resume_at, rework_reason FROM user_break_state WHERE user_id = $1', [userId]);
  return rows[0] ? { contractId: rows[0].contract_id, resumeAt: new Date(rows[0].resume_at).getTime(), reworkReason: rows[0].rework_reason } : null;
}

async function setBreakState(db, userId, contractId, resumeAt, reworkReason = null) {
  await db.query('INSERT INTO user_break_state (user_id, contract_id, resume_at, rework_reason) VALUES ($1, $2, $3, $4)', [userId, contractId, new Date(resumeAt), reworkReason]);
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
// userIds: whose time blocks and committed days to include (null = everyone).
async function getClockState(db, userId, userIds) {
  const activeRows = (await db.query('SELECT user_id, contract_id, started_at, rework_reason FROM active_sessions')).rows;
  const activeSessions = {};
  activeRows.forEach((r) => {
    activeSessions[r.contract_id] = activeSessions[r.contract_id] || {};
    activeSessions[r.contract_id][r.user_id] = new Date(r.started_at).getTime();
  });

  const scope = userIds === null ? ['', []] : ['WHERE user_id = ANY($1)', [userIds]];
  const sessionRows = (await db.query(`SELECT * FROM time_sessions ${scope[0]} ORDER BY contract_id, date, start_time`, scope[1])).rows;
  const editSessions = {};
  sessionRows.forEach((row) => {
    const { contractId, ...session } = toSession(row);
    (editSessions[contractId] = editSessions[contractId] || []).push(session);
  });

  const committedDates = (await db.query(`SELECT user_id, date FROM committed_dates ${scope[0]} ORDER BY date`, scope[1])).rows
    .map((r) => ({ userId: r.user_id, date: r.date }));

  const own = activeRows.find((r) => r.user_id === userId);
  return { activeSessions, editSessions, committedDates, breakState: await findBreakState(db, userId), activeReworkReason: own?.rework_reason || null };
}

/* Completed time blocks between two dates (inclusive) for Setup -> Data
 * export, with the person and contract details spelled out. userIds null
 * means everyone. Running clocks aren't included until they are stopped. */
async function findSessionsForExport(db, { from, to, userIds = null }) {
  const { rows } = await db.query(
    `SELECT s.user_id, s.date, s.start_time, s.end_time, s.auto_stopped, s.rework_reason,
            u.name AS user_name, u.email, u.cost_centre,
            c.system, c.number, c.suffix, c.suffix_description, c.customer_name, c.machine_type,
            (cd.user_id IS NOT NULL) AS committed
       FROM time_sessions s
       JOIN users u ON u.id = s.user_id
       JOIN contracts c ON c.id = s.contract_id
       LEFT JOIN committed_dates cd ON cd.user_id = s.user_id AND cd.date = s.date
      WHERE s.date BETWEEN $1 AND $2 AND ($3::text[] IS NULL OR s.user_id = ANY($3))
      ORDER BY u.name, s.date, s.start_time`,
    [from, to, userIds]
  );
  return rows;
}

module.exports = {
  lockUser, contractExists, findActive, setActive, clearActive, reworkReasonExists,
  insertTimeSession, findTimeSession, updateTimeSession, deleteTimeSession,
  markAutoNoticed, findUncheckedAutoStops, findScheduledClockUsers, findClockSchedule,
  findBreakState, setBreakState, clearBreakState,
  isCommitted, addCommit, removeCommit, getClockState, findSessionsForExport,
};
