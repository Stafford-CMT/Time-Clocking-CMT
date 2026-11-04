'use strict';

/* Clocking rules. Every action is written to the database the moment it
 * happens, timed by the server's clock, and only ever touches the acting
 * user's own rows -- unless they are an admin editing someone else's times.
 * Each action returns the fresh clock state for the caller to re-render.
 */
const clockRepo = require('../repositories/clockRepo');
const { getPool, withTransaction } = require('../config/db');
const ApiError = require('../utils/ApiError');
const teamService = require('./teamService');
const { uid } = require('../utils/ids');
const { localDate, splitByDay, timeToSeconds, TIME_RE, DATE_RE } = require('../utils/time');

const isAdmin = (actor) => actor.userType === 'admin';

function assertCanActOn(actor, userId) {
  if (actor.id !== userId && !isAdmin(actor)) throw new ApiError(403, 'You can only change your own times');
}

// Committed means locked for everyone, admins too: an admin uncommits the day first (Edit times -> Uncommit).
async function assertNotCommitted(db, actor, userId, date) {
  if (await clockRepo.isCommitted(db, userId, date)) {
    throw new ApiError(409, isAdmin(actor) ? `Times for ${date} are committed — uncommit the day in Edit times first` : `Times for ${date} are committed — only an admin can uncommit them`);
  }
}

async function getState(actor) {
  // Catch up the caller's own clock schedule first (breaks, auto clock-out),
  // so nobody is shown a clock still waiting for the next sweep.
  await runClockSchedule(Date.now(), [actor.id]).catch((err) => console.error('Clock schedule failed:', err));
  const db = getPool();
  return clockRepo.getClockState(db, actor.id, await teamService.visibleUserIds(db, actor)); // a manager sees their team's (changing them stays own-or-admin)
}

// Stops the user's running clock, if any, and records it as completed
// session(s). Returns what was running, or null. An automatic stop marks the
// last piece -- the one ending at the clock-out time -- for the person to check.
async function closeActive(db, userId, endMs, { autoStopped = false } = {}) {
  const active = await clockRepo.findActive(db, userId);
  if (!active) return null;
  const pieces = splitByDay(active.startedAt, endMs);
  for (const [index, piece] of pieces.entries()) {
    await clockRepo.insertTimeSession(db, { id: uid('session'), contractId: active.contractId, userId, ...piece, reworkReason: active.reworkReason, autoStopped: autoStopped && index === pieces.length - 1 });
  }
  await clockRepo.clearActive(db, userId);
  return active;
}

// The moment `time` ('HH:MM:SS') falls on the local day containing dayMs.
function atTime(dayMs, time) {
  const day = new Date(dayMs);
  return new Date(day.getFullYear(), day.getMonth(), day.getDate(), 0, 0, timeToSeconds(time)).getTime();
}

/* Auto clock-out: a running clock stops at its owner's clock-out time
 * (clockOut, 'HH:MM:SS') on the day it was started. A clock started after
 * that time -- someone staying late on purpose -- runs to the end of that
 * day instead. */
function autoClockOutAt(startedAt, clockOut) {
  const cutoff = atTime(startedAt, clockOut);
  const started = new Date(startedAt);
  return startedAt < cutoff ? cutoff : new Date(started.getFullYear(), started.getMonth(), started.getDate() + 1).getTime();
}

/* The clock schedule, run by the server so nobody needs a page open:
 * - Breaks: a clock that was already running when one of the person's breaks
 *   starts is paused at the break start and restarted at the break end.
 *   Starting a clock during a break (working through it) is left alone. A
 *   break that ends at or after the clock-out time ends the clock instead,
 *   marked like an auto clock-out.
 * - Auto clock-out, as above, marked for the person to check.
 * Every step is recorded at its scheduled moment, however late the server
 * gets to it (a sweep every 30 seconds, every state load, and before every
 * start/stop). Steps are applied in time order until nothing more is due. */
async function applyClockSchedule(db, userId, now) {
  const schedule = await clockRepo.findClockSchedule(db, userId);
  for (let step = 0; step < 20; step += 1) {
    const active = await clockRepo.findActive(db, userId);
    if (!active) {
      const paused = await clockRepo.findBreakState(db, userId);
      if (!paused || paused.resumeAt > now) return;
      await clockRepo.clearBreakState(db, userId);
      if (!(await clockRepo.isCommitted(db, userId, localDate(new Date(paused.resumeAt))))) {
        await clockRepo.setActive(db, userId, paused.contractId, new Date(paused.resumeAt), paused.reworkReason);
      }
      continue;
    }
    if (!schedule) return;
    const cutoff = autoClockOutAt(active.startedAt, schedule.clockOut);
    const nextBreak = schedule.breaks
      .map((b) => ({ start: atTime(active.startedAt, b.start), end: atTime(active.startedAt, b.end) }))
      .filter((b) => b.end > b.start && b.start > active.startedAt && b.start < cutoff)
      .sort((a, b) => a.start - b.start)[0];
    if (nextBreak && nextBreak.start <= now) {
      const resumes = nextBreak.end < cutoff;
      await closeActive(db, userId, nextBreak.start, { autoStopped: !resumes });
      if (resumes) await clockRepo.setBreakState(db, userId, active.contractId, nextBreak.end, active.reworkReason);
      continue;
    }
    if (cutoff <= now) {
      await closeActive(db, userId, cutoff, { autoStopped: true });
      await clockRepo.clearBreakState(db, userId);
    }
    return;
  }
}

async function runClockSchedule(now = Date.now(), userIds = null) {
  for (const userId of userIds || (await clockRepo.findScheduledClockUsers(getPool()))) {
    await withTransaction(async (db) => {
      await clockRepo.lockUser(db, userId);
      await applyClockSchedule(db, userId, now);
    });
  }
}

function startClockSchedule() {
  const sweep = () => runClockSchedule().catch((err) => console.error('Clock schedule failed:', err));
  sweep();
  setInterval(sweep, 30 * 1000).unref();
}

// Starting one contract stops whatever else this user had running, exactly
// like the prototype's toggleClock. A manual start also cancels any pending
// break resume, so the break can't later restart a second clock.
// reworkReason (optional, from Lists -> Rework reasons) starts it as rework:
// every block it records carries the reason. Only for this one start -- the
// next start is ordinary time unless the tile's Rework button is used again.
async function start(actor, contractId, reworkReason = null) {
  if (reworkReason != null && typeof reworkReason !== 'string') throw new ApiError(400, 'reworkReason must be text');
  const reason = reworkReason ? reworkReason.trim() : null;
  await withTransaction(async (db) => {
    await clockRepo.lockUser(db, actor.id);
    if (!(await clockRepo.contractExists(db, contractId))) throw new ApiError(404, 'Contract not found');
    if (reason) {
      if (contractId === 'non-contract') throw new ApiError(400, "Non-contract time can't be rework");
      if (!(await clockRepo.reworkReasonExists(db, reason))) throw new ApiError(400, `"${reason}" is not in the rework reasons list`);
    }
    await assertNotCommitted(db, actor, actor.id, localDate(new Date()));
    const now = Date.now();
    await applyClockSchedule(db, actor.id, now); // a missed break or clock-out is recorded first, at its own time
    const active = await clockRepo.findActive(db, actor.id);
    if (active && active.contractId === contractId && (active.reworkReason || null) === reason) return;
    await closeActive(db, actor.id, now);
    await clockRepo.setActive(db, actor.id, contractId, new Date(now), reason);
    await clockRepo.clearBreakState(db, actor.id);
  });
  return getState(actor);
}

async function stop(actor, contractId) {
  await withTransaction(async (db) => {
    await clockRepo.lockUser(db, actor.id);
    const now = Date.now();
    await applyClockSchedule(db, actor.id, now); // a missed break or clock-out is recorded first, at its own time
    const active = await clockRepo.findActive(db, actor.id);
    if (active && active.contractId === contractId) await closeActive(db, actor.id, now);
    // Stopping during a break also cancels the restart at the end of it.
    const paused = await clockRepo.findBreakState(db, actor.id);
    if (paused && paused.contractId === contractId) await clockRepo.clearBreakState(db, actor.id);
  });
  return getState(actor);
}

// Edit Times drags change a session and, when linked, its neighbour in one
// go -- so this takes a batch and applies it all or nothing.
async function updateSessions(actor, changes) {
  if (!Array.isArray(changes) || !changes.length) throw new ApiError(400, 'changes must be a non-empty array');
  await withTransaction(async (db) => {
    for (const change of changes) {
      const session = await clockRepo.findTimeSession(db, change.id);
      if (!session) throw new ApiError(404, 'Time block not found');
      assertCanActOn(actor, session.userId);
      await assertNotCommitted(db, actor, session.userId, session.date);
      const startTime = change.start ?? session.start;
      const endTime = change.end ?? session.end;
      if (!TIME_RE.test(startTime) || !TIME_RE.test(endTime)) throw new ApiError(400, 'Times must be HH:MM or HH:MM:SS');
      if (timeToSeconds(endTime) <= timeToSeconds(startTime)) throw new ApiError(400, 'End time must be after start time');
      for (const flag of ['unlinkedStart', 'unlinkedEnd']) {
        if (change[flag] !== undefined && typeof change[flag] !== 'boolean') throw new ApiError(400, `${flag} must be true or false`);
      }
      if (change.autoStopped !== undefined && change.autoStopped !== false) throw new ApiError(400, 'autoStopped can only be cleared');
      // Moving the end of an auto-stopped block, or keeping it (autoStopped:
      // false), means its owner has checked it.
      const endMoved = timeToSeconds(endTime) !== timeToSeconds(session.end);
      await clockRepo.updateTimeSession(db, session.id, {
        start: startTime,
        end: endTime,
        unlinkedStart: change.unlinkedStart ?? session.unlinkedStart,
        unlinkedEnd: change.unlinkedEnd ?? session.unlinkedEnd,
        autoStopped: session.autoStopped && !endMoved && change.autoStopped !== false,
      });
    }
  });
  return getState(actor);
}

// Undo of a removed block in Edit Times: puts it back exactly as it was.
async function restoreSession(actor, session) {
  if (!session || typeof session !== 'object') throw new ApiError(400, 'Expected the removed time block');
  const { id, contractId, userId, date, start, end } = session;
  if (typeof id !== 'string' || !id || typeof userId !== 'string') throw new ApiError(400, 'Time block needs an id and a user');
  if (!DATE_RE.test(String(date)) || !TIME_RE.test(String(start)) || !TIME_RE.test(String(end))) throw new ApiError(400, 'Time block needs a date (YYYY-MM-DD) and HH:MM times');
  if (timeToSeconds(end) <= timeToSeconds(start)) throw new ApiError(400, 'End time must be after start time');
  assertCanActOn(actor, userId);
  await withTransaction(async (db) => {
    if (!(await clockRepo.contractExists(db, contractId))) throw new ApiError(404, 'Contract not found');
    if (await clockRepo.findTimeSession(db, id)) throw new ApiError(409, 'That time block is already there');
    await assertNotCommitted(db, actor, userId, date);
    await clockRepo.insertTimeSession(db, { id, contractId, userId, date, start, end, reworkReason: typeof session.reworkReason === 'string' && session.reworkReason ? session.reworkReason : null });
    await clockRepo.updateTimeSession(db, id, { start, end, unlinkedStart: session.unlinkedStart === true, unlinkedEnd: session.unlinkedEnd === true, autoStopped: false });
  });
  return getState(actor);
}

async function removeSession(actor, id) {
  await withTransaction(async (db) => {
    const session = await clockRepo.findTimeSession(db, id);
    if (!session) throw new ApiError(404, 'Time block not found');
    assertCanActOn(actor, session.userId);
    await assertNotCommitted(db, actor, session.userId, session.date);
    await clockRepo.deleteTimeSession(db, id);
  });
  return getState(actor);
}

async function commit(actor, userId, date) {
  assertCanActOn(actor, userId);
  if (!DATE_RE.test(date)) throw new ApiError(400, 'date must be YYYY-MM-DD');
  const db = getPool();
  // A running clock will add time to every day from the one it started on, so
  // only those days are blocked -- a committed day can never gain time later.
  const active = await clockRepo.findActive(db, userId);
  if (active && localDate(new Date(active.startedAt)) <= date) throw new ApiError(409, 'Stop the running clock before committing');
  // An auto clock-out ends at the clock-out time, not when the person stopped: it must be corrected or
  // confirmed (Edit times) first, so a day is never committed with a time nobody looked at. Admins too.
  const unchecked = await clockRepo.findUncheckedAutoStops(db, userId, date);
  if (unchecked.length) {
    const times = [...new Set(unchecked.map((t) => t.slice(0, 5)))].join(' and ');
    throw new ApiError(409, `Check the auto clock-out at ${times} first: drag the end of the time to when work stopped, or click its clock badge to keep it`);
  }
  await clockRepo.addCommit(db, userId, date);
  return getState(actor);
}

// The dashboard's "stopped automatically" message was seen (own sessions only).
async function markAutoNoticed(actor, ids) {
  if (!Array.isArray(ids) || !ids.every((id) => typeof id === 'string')) throw new ApiError(400, 'ids must be an array of session ids');
  await clockRepo.markAutoNoticed(getPool(), actor.id, ids);
  return getState(actor);
}

async function uncommit(actor, userId, date) {
  if (!isAdmin(actor)) throw new ApiError(403, 'Only an admin can unlock committed times');
  await clockRepo.removeCommit(getPool(), userId, date);
  return getState(actor);
}

module.exports = {
  getState, start, stop, updateSessions, restoreSession, removeSession, commit, uncommit, markAutoNoticed,
  autoClockOutAt, runClockSchedule, startClockSchedule,
};
