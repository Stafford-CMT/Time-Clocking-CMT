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

// Committed is final: nobody, admins included, can change or uncommit the day,
// so what goes to Syspro can never differ from what Time Slide holds.
async function assertNotCommitted(db, actor, userId, date) {
  if (await clockRepo.isCommitted(db, userId, date)) throw new ApiError(409, `Times for ${date} are committed and can't be changed`);
}

async function getState(actor) {
  // Catch up the caller's own clock schedule first (breaks, auto clock-out),
  // so nobody is shown a clock still waiting for the next sweep.
  await runClockSchedule(Date.now(), [actor.id]).catch((err) => console.error('Clock schedule failed:', err));
  const db = getPool();
  const clock = await clockRepo.getClockState(db, actor.id, await teamService.visibleUserIds(db, actor)); // a manager sees their team's (changing them stays own-or-admin)
  const departments = await clockRepo.listDepartments(db);
  const { home, working } = await clockRepo.findDepartments(db, actor.id, localDate(new Date()));
  return { ...clock, departments, homeDepartment: home, workingDepartment: working };
}

/* Departments (migration 020): every block records the department its time is
 * for. A person's department for a day is their own (Entra ID) unless they
 * picked another with Working in that day; the pick is forgotten overnight. */
async function departmentFor(db, userId, date) {
  const { home, working } = await clockRepo.findDepartments(db, userId, date);
  return working || home;
}

// A department must be one of the list (people's Entra departments) or the person's own.
async function checkDepartment(db, userId, value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value !== 'string') throw new ApiError(400, 'department must be text');
  const name = value.trim();
  const { home } = await clockRepo.findDepartments(db, userId, '');
  if (name !== home && !(await clockRepo.listDepartments(db)).includes(name)) throw new ApiError(400, `"${name}" is not a department in Time Slide`);
  return name;
}

/* Working in: the caller picks the department their clocking is for today
 * (null or their own department = back to their own). A running clock is split
 * at this moment, so time before the change keeps the old department; a clock
 * paused for a break restarts under the new one. */
async function setWorkingDepartment(actor, value) {
  await withTransaction(async (db) => {
    await clockRepo.lockUser(db, actor.id);
    const name = await checkDepartment(db, actor.id, value);
    const today = localDate(new Date());
    const { home } = await clockRepo.findDepartments(db, actor.id, today);
    const department = name && name !== home ? name : null;
    const now = Date.now();
    await applyClockSchedule(db, actor.id, now);
    await clockRepo.setWorkingDepartment(db, actor.id, department, today);
    const effective = department || home;
    const active = await clockRepo.findActive(db, actor.id);
    if (active && (active.department || null) !== (effective || null) && !(await clockRepo.isCommitted(db, actor.id, today))) {
      await closeActive(db, actor.id, now);
      await clockRepo.setActive(db, actor.id, active.contractId, new Date(now), active.reworkReason, effective);
    }
    if (await clockRepo.findBreakState(db, actor.id)) await clockRepo.setBreakDepartment(db, actor.id, effective);
  });
  return getState(actor);
}

// Edit times: change the department of one finished block (own, or anyone's for an admin), not on a committed day.
async function setSessionDepartment(actor, id, value) {
  await withTransaction(async (db) => {
    const session = await clockRepo.findTimeSession(db, id);
    if (!session) throw new ApiError(404, 'Time block not found');
    assertCanActOn(actor, session.userId);
    await assertNotCommitted(db, actor, session.userId, session.date);
    const name = await checkDepartment(db, session.userId, value);
    if (!name) throw new ApiError(400, 'Choose a department');
    await clockRepo.setSessionDepartment(db, id, name);
  });
  return getState(actor);
}

// Stops the user's running clock, if any, and records it as completed
// session(s). Returns what was running, or null. An automatic stop marks the
// last piece -- the one ending at the clock-out time -- for the person to check.
async function closeActive(db, userId, endMs, { autoStopped = false } = {}) {
  const active = await clockRepo.findActive(db, userId);
  if (!active) return null;
  const pieces = splitByDay(active.startedAt, endMs);
  for (const [index, piece] of pieces.entries()) {
    await clockRepo.insertTimeSession(db, { id: uid('session'), contractId: active.contractId, userId, ...piece, reworkReason: active.reworkReason, department: active.department, autoStopped: autoStopped && index === pieces.length - 1 });
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
  for (let step = 0; step < 20; step += 1) {
    const active = await clockRepo.findActive(db, userId);
    if (!active) {
      const paused = await clockRepo.findBreakState(db, userId);
      if (!paused || paused.resumeAt > now) return;
      await clockRepo.clearBreakState(db, userId);
      if (!(await clockRepo.isCommitted(db, userId, localDate(new Date(paused.resumeAt))))) {
        await clockRepo.setActive(db, userId, paused.contractId, new Date(paused.resumeAt), paused.reworkReason, paused.department);
      }
      continue;
    }
    const schedule = await clockRepo.findClockSchedule(db, userId, localDate(new Date(active.startedAt))); // the day the clock started
    if (!schedule) return;
    const cutoff = autoClockOutAt(active.startedAt, schedule.clockOut);
    const nextBreak = schedule.breaks
      .map((b) => ({ start: atTime(active.startedAt, b.start), end: atTime(active.startedAt, b.end) }))
      .filter((b) => b.end > b.start && b.start > active.startedAt && b.start < cutoff)
      .sort((a, b) => a.start - b.start)[0];
    if (nextBreak && nextBreak.start <= now) {
      const resumes = nextBreak.end < cutoff;
      await closeActive(db, userId, nextBreak.start, { autoStopped: !resumes });
      if (resumes) await clockRepo.setBreakState(db, userId, active.contractId, nextBreak.end, active.reworkReason, active.department);
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
    const today = localDate(new Date());
    await assertNotCommitted(db, actor, actor.id, today);
    const now = Date.now();
    await applyClockSchedule(db, actor.id, now); // a missed break or clock-out is recorded first, at its own time
    const department = await departmentFor(db, actor.id, today);
    const active = await clockRepo.findActive(db, actor.id);
    if (active && active.contractId === contractId && (active.reworkReason || null) === reason && (active.department || null) === (department || null)) return;
    await closeActive(db, actor.id, now);
    await clockRepo.setActive(db, actor.id, contractId, new Date(now), reason, department);
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
// Nothing else may sit in [start, end) on this person's day (other blocks, and today a running clock).
async function assertFree(db, userId, date, start, end) {
  const from = timeToSeconds(start); const to = timeToSeconds(end);
  const clash = (await clockRepo.findDaySessions(db, userId, date)).find((other) => from < timeToSeconds(other.end) && to > timeToSeconds(other.start));
  if (clash) throw new ApiError(409, `That overlaps other time on ${date} (${String(clash.start).slice(0, 5)}–${String(clash.end).slice(0, 5)})`);
  await assertNotOverRunningClock(db, userId, date, end);
}

// A clock still running can't be drawn over: stop it first.
async function assertNotOverRunningClock(db, userId, date, end) {
  const to = timeToSeconds(end);
  const active = await clockRepo.findActive(db, userId);
  if (active && localDate(new Date(active.startedAt)) === date) {
    const started = new Date(active.startedAt); const runFrom = started.getHours() * 3600 + started.getMinutes() * 60 + started.getSeconds();
    if (to > runFrom) throw new ApiError(409, 'That overlaps the clock that is running now');
  }
}

/* Undo of a deletion: puts back exactly the block that was deleted (kept in
 * removed_time_sessions), never one described by the browser, so Undo can't be
 * used to slip in time that was never there. */
async function restoreSession(actor, session) {
  const id = session && typeof session === 'object' ? session.id : null;
  if (typeof id !== 'string' || !id) throw new ApiError(400, 'Expected the removed time block');
  await withTransaction(async (db) => {
    const removed = await clockRepo.findRemoved(db, id);
    if (!removed) throw new ApiError(404, "That time block can't be put back");
    assertCanActOn(actor, removed.userId);
    if (await clockRepo.findTimeSession(db, id)) throw new ApiError(409, 'That time block is already there');
    await assertNotCommitted(db, actor, removed.userId, removed.date);
    await assertFree(db, removed.userId, removed.date, removed.start, removed.end);
    await clockRepo.putBackRemoved(db, id);
  });
  return getState(actor);
}

/* Time entered by hand on Edit times, for a clock someone forgot: their own
 * day (or anyone's for an admin), on today or the 27 days before it (the day
 * strip), never in the future, never over other time, never on a committed day.
 * It is marked with who entered it and when. reworkReason works as the tile's
 * Rework button: a reason from the list, not on Non-contract. */
/* Drawing over clocked time (a clock left running on the wrong contract): every
 * block under [start, end) gives up that time, in the same step as the new block
 * goes in. A block wholly under it is removed (kept for Undo); one the new time
 * sits inside is split in two (the block keeps its start and its id, a new piece
 * takes its end); one it overlaps at an edge is trimmed. `changes` records what
 * was done so the browser can undo it. Rework and hand-entered blocks give up
 * time the same way; a running clock never does. */
async function takeTime(db, actor, userId, date, start, end, changes) {
  await assertNotOverRunningClock(db, userId, date, end);
  const from = timeToSeconds(start); const to = timeToSeconds(end);
  for (const block of await clockRepo.findDaySessions(db, userId, date)) {
    const blockFrom = timeToSeconds(block.start); const blockTo = timeToSeconds(block.end);
    if (from >= blockTo || to <= blockFrom) continue;
    const before = { id: block.id, start: block.start, end: block.end, unlinkedStart: block.unlinkedStart, unlinkedEnd: block.unlinkedEnd };
    if (from <= blockFrom && to >= blockTo) {
      await clockRepo.keepRemoved(db, block.id, actor.id);
      await clockRepo.deleteTimeSession(db, block.id);
      changes.removed.push(block.id);
      continue;
    }
    if (from > blockFrom && to < blockTo) {
      const pieceId = uid('session');
      await clockRepo.insertTimeSession(db, { id: pieceId, contractId: block.contractId, userId, date, start: end, end: block.end, autoStopped: block.autoStopped, reworkReason: block.reworkReason, department: block.department, enteredBy: block.enteredBy, enteredAt: block.enteredAt });
      await clockRepo.updateTimeSession(db, pieceId, { start: end, end: block.end, unlinkedStart: false, unlinkedEnd: block.unlinkedEnd, autoStopped: block.autoStopped });
      await clockRepo.updateTimeSession(db, block.id, { start: block.start, end: start, unlinkedStart: block.unlinkedStart, unlinkedEnd: false, autoStopped: false });
      changes.pieces.push(pieceId);
    } else if (from > blockFrom) {
      await clockRepo.updateTimeSession(db, block.id, { start: block.start, end: start, unlinkedStart: block.unlinkedStart, unlinkedEnd: false, autoStopped: false });
    } else {
      await clockRepo.updateTimeSession(db, block.id, { start: end, end: block.end, unlinkedStart: false, unlinkedEnd: block.unlinkedEnd, autoStopped: block.autoStopped });
    }
    changes.trimmed.push(before);
  }
}

const ADD_DAYS_BACK = 27;
async function addSession(actor, body, { take = false } = {}) {
  const { contractId, userId, date, start, end } = body || {};
  if (typeof contractId !== 'string' || typeof userId !== 'string') throw new ApiError(400, 'Time needs a contract and a person');
  if (!DATE_RE.test(String(date)) || !TIME_RE.test(String(start)) || !TIME_RE.test(String(end))) throw new ApiError(400, 'Time needs a date (YYYY-MM-DD) and HH:MM times');
  if (timeToSeconds(end) <= timeToSeconds(start)) throw new ApiError(400, 'End time must be after start time');
  if (body.reworkReason != null && typeof body.reworkReason !== 'string') throw new ApiError(400, 'reworkReason must be text');
  const reason = body.reworkReason ? body.reworkReason.trim() : null;
  assertCanActOn(actor, userId);
  const now = new Date(); const today = localDate(now);
  const earliest = localDate(new Date(now.getFullYear(), now.getMonth(), now.getDate() - ADD_DAYS_BACK));
  if (date > today) throw new ApiError(400, "Time can't be added to a day that hasn't happened yet");
  if (date < earliest) throw new ApiError(400, `Time can only be added back to ${earliest} (the last 28 days)`);
  if (date === today && timeToSeconds(end) > now.getHours() * 3600 + now.getMinutes() * 60 + now.getSeconds()) throw new ApiError(400, "Time can't go past now");
  const id = uid('session'); const changes = { trimmed: [], removed: [], pieces: [] };
  await withTransaction(async (db) => {
    await clockRepo.lockUser(db, userId);
    if (!(await clockRepo.contractExists(db, contractId))) throw new ApiError(404, 'Contract not found');
    if (await clockRepo.contractIsRetired(db, contractId)) throw new ApiError(400, 'That contract has been removed from Contract information');
    if (reason) {
      if (contractId === 'non-contract') throw new ApiError(400, "Non-contract time can't be rework");
      if (!(await clockRepo.reworkReasonExists(db, reason))) throw new ApiError(400, `"${reason}" is not in the rework reasons list`);
    }
    await assertNotCommitted(db, actor, userId, date);
    // The person's department for that day (their own, or today's Working in); changed afterwards from the block if needed.
    const department = (await checkDepartment(db, userId, body.department)) || (await departmentFor(db, userId, date));
    if (take) await takeTime(db, actor, userId, date, start, end, changes);
    else await assertFree(db, userId, date, start, end);
    await clockRepo.insertTimeSession(db, { id, contractId, userId, date, start, end, reworkReason: reason, department, enteredBy: actor.id, enteredAt: now });
  });
  return { ...(await getState(actor)), addedId: id, changes };
}

async function removeSession(actor, id) {
  await withTransaction(async (db) => {
    const session = await clockRepo.findTimeSession(db, id);
    if (!session) throw new ApiError(404, 'Time block not found');
    assertCanActOn(actor, session.userId);
    await assertNotCommitted(db, actor, session.userId, session.date);
    await clockRepo.keepRemoved(db, id, actor.id); // so Undo can put back exactly this block
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

module.exports = {
  getState, start, stop, updateSessions, restoreSession, addSession, removeSession, commit, markAutoNoticed,
  setWorkingDepartment, setSessionDepartment,
  autoClockOutAt, runClockSchedule, startClockSchedule,
};
