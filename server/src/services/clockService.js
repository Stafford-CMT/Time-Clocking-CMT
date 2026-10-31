'use strict';

/* Clocking rules. Every action is written to the database the moment it
 * happens, timed by the server's clock, and only ever touches the acting
 * user's own rows -- unless they are an admin editing someone else's times.
 * Each action returns the fresh clock state for the caller to re-render.
 */
const clockRepo = require('../repositories/clockRepo');
const { getPool, withTransaction } = require('../config/db');
const ApiError = require('../utils/ApiError');
const { uid } = require('../utils/ids');
const { localDate, splitByDay, timeToSeconds, TIME_RE, DATE_RE } = require('../utils/time');

const isAdmin = (actor) => actor.userType === 'admin';

function assertCanActOn(actor, userId) {
  if (actor.id !== userId && !isAdmin(actor)) throw new ApiError(403, 'You can only change your own times');
}

async function assertNotCommitted(db, actor, userId, date) {
  if (!isAdmin(actor) && (await clockRepo.isCommitted(db, userId, date))) {
    throw new ApiError(409, `Times for ${date} are committed — only an admin can change them`);
  }
}

function getState(actor) {
  return clockRepo.getClockState(getPool(), actor.id, isAdmin(actor));
}

// Stops the user's running clock, if any, and records it as completed
// session(s). Returns what was running, or null.
async function closeActive(db, userId, endMs) {
  const active = await clockRepo.findActive(db, userId);
  if (!active) return null;
  for (const piece of splitByDay(active.startedAt, endMs)) {
    await clockRepo.insertTimeSession(db, { id: uid('session'), contractId: active.contractId, userId, ...piece });
  }
  await clockRepo.clearActive(db, userId);
  return active;
}

// Starting one contract stops whatever else this user had running, exactly
// like the prototype's toggleClock. A manual start also cancels any pending
// break resume, so the break can't later restart a second clock.
async function start(actor, contractId) {
  await withTransaction(async (db) => {
    await clockRepo.lockUser(db, actor.id);
    if (!(await clockRepo.contractExists(db, contractId))) throw new ApiError(404, 'Contract not found');
    await assertNotCommitted(db, actor, actor.id, localDate(new Date()));
    const active = await clockRepo.findActive(db, actor.id);
    if (active && active.contractId === contractId) return;
    const now = Date.now();
    await closeActive(db, actor.id, now);
    await clockRepo.setActive(db, actor.id, contractId, new Date(now));
    await clockRepo.clearBreakState(db, actor.id);
  });
  return getState(actor);
}

async function stop(actor, contractId) {
  await withTransaction(async (db) => {
    await clockRepo.lockUser(db, actor.id);
    const active = await clockRepo.findActive(db, actor.id);
    if (active && active.contractId === contractId) await closeActive(db, actor.id, Date.now());
    await clockRepo.clearBreakState(db, actor.id);
  });
  return getState(actor);
}

// Called by the browser when the user's scheduled break begins/ends.
async function pauseForBreak(actor) {
  await withTransaction(async (db) => {
    await clockRepo.lockUser(db, actor.id);
    if (await clockRepo.findBreakState(db, actor.id)) return;
    const paused = await closeActive(db, actor.id, Date.now());
    if (paused) await clockRepo.setBreakState(db, actor.id, paused.contractId);
  });
  return getState(actor);
}

async function resumeAfterBreak(actor) {
  await withTransaction(async (db) => {
    await clockRepo.lockUser(db, actor.id);
    const breakState = await clockRepo.findBreakState(db, actor.id);
    if (!breakState) return;
    await clockRepo.clearBreakState(db, actor.id);
    const committed = await clockRepo.isCommitted(db, actor.id, localDate(new Date()));
    if (!committed && !(await clockRepo.findActive(db, actor.id))) {
      await clockRepo.setActive(db, actor.id, breakState.contractId, new Date());
    }
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
      await clockRepo.updateTimeSession(db, session.id, {
        start: startTime,
        end: endTime,
        unlinkedStart: change.unlinkedStart ?? session.unlinkedStart,
        unlinkedEnd: change.unlinkedEnd ?? session.unlinkedEnd,
      });
    }
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
  await clockRepo.addCommit(db, userId, date);
  return getState(actor);
}

async function uncommit(actor, userId, date) {
  if (!isAdmin(actor)) throw new ApiError(403, 'Only an admin can unlock committed times');
  await clockRepo.removeCommit(getPool(), userId, date);
  return getState(actor);
}

module.exports = { getState, start, stop, pauseForBreak, resumeAfterBreak, updateSessions, removeSession, commit, uncommit };
