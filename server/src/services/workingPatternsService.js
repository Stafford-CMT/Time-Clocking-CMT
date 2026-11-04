'use strict';

/* Working patterns (Lists -> Working patterns, admins and managers): each pattern has
 * seven days, Monday always with its own times; any other day follows Monday
 * ('same'), has its own times ('own') or is not a working day ('off'). Every
 * change returns the whole, fresh list of patterns. */
const repo = require('../repositories/workingPatternsRepo');
const { getPool, withTransaction } = require('../config/db');
const ApiError = require('../utils/ApiError');
const teamService = require('./teamService');

const HM_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const MODES = ['own', 'same', 'off'];
const DAY_NAMES = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
const minutes = (hm) => Number(hm.slice(0, 2)) * 60 + Number(hm.slice(3, 5));

function cleanName(name) {
  if (typeof name !== 'string' || !name.trim()) throw new ApiError(400, 'Give the pattern a name');
  if (name.trim().length > 60) throw new ApiError(400, 'Keep the name to 60 characters');
  return name.trim();
}

// Seven days, Monday to Sunday, each checked; what is saved is rebuilt from them.
function cleanDays(days) {
  if (!Array.isArray(days) || days.length !== 7) throw new ApiError(400, 'A pattern needs all seven days');
  return DAY_NAMES.map((dayName, index) => {
    const day = days.find((item) => item && item.weekday === index + 1);
    if (!day || !MODES.includes(day.mode)) throw new ApiError(400, `${dayName} is missing`);
    if (index === 0 && day.mode !== 'own') throw new ApiError(400, 'Monday needs its own times');
    if (day.mode !== 'own') return { weekday: index + 1, mode: day.mode, breaks: [] };
    if (!HM_RE.test(day.start || '') || !HM_RE.test(day.end || '')) throw new ApiError(400, `${dayName}: times must be HH:MM`);
    if (minutes(day.end) <= minutes(day.start)) throw new ApiError(400, `${dayName}: work must end after it starts`);
    const breaks = Array.isArray(day.breaks) ? day.breaks : [];
    breaks.forEach((brk) => {
      if (!brk || !HM_RE.test(brk.start || '') || !HM_RE.test(brk.end || '')) throw new ApiError(400, `${dayName}: break times must be HH:MM`);
      if (minutes(brk.end) <= minutes(brk.start)) throw new ApiError(400, `${dayName}: a break must end after it starts`);
    });
    return { weekday: index + 1, mode: 'own', start: day.start, end: day.end, breaks: breaks.map((brk) => ({ start: brk.start, end: brk.end })) };
  });
}

// Two patterns can't share a name (any capitals).
async function run(work) {
  try {
    await withTransaction(work);
  } catch (err) {
    if (err.code === '23505') throw new ApiError(409, 'There is already a pattern with that name');
    throw err;
  }
  return { workingPatterns: await repo.listPatterns(getPool()) };
}

async function mustFind(db, id) {
  const pattern = await repo.findPattern(db, id);
  if (!pattern) throw new ApiError(404, 'That pattern no longer exists');
  return pattern;
}

// A new pattern starts as a copy of `copyFrom` (the one on screen).
function create({ name, copyFrom } = {}) {
  const clean = cleanName(name);
  return run(async (db) => {
    const source = await mustFind(db, copyFrom);
    await repo.createPattern(db, { name: clean, days: source.days });
  });
}

function save(id, { name, days } = {}) {
  const clean = { name: cleanName(name), days: cleanDays(days) };
  return run(async (db) => {
    await mustFind(db, id);
    await repo.savePattern(db, id, clean);
  });
}

function remove(id) {
  return run(async (db) => {
    const pattern = await mustFind(db, id);
    if (pattern.isDefault) throw new ApiError(409, `${pattern.name} is the pattern for new people. Make another pattern the default first.`);
    const people = await repo.countPeople(db, id);
    if (people) throw new ApiError(409, `${people === 1 ? '1 person is' : `${people} people are`} on ${pattern.name}. Move them to another pattern first (Users tab).`);
    await repo.deletePattern(db, id);
  });
}

function makeDefault(id) {
  return run(async (db) => {
    await mustFind(db, id);
    await repo.setDefault(db, id);
  });
}

// '' or null takes the person off any pattern: no working hours, breaks or auto clock-out.
// A manager may only do this for people in their team.
async function assign(actor, userId, patternId) {
  const db = getPool();
  if (actor.userType !== 'admin' && !(await teamService.canSee(db, actor, userId))) throw new ApiError(403, 'That person is not in your team');
  if (patternId) await mustFind(db, patternId);
  const user = await repo.setUserPattern(db, userId, patternId || null);
  if (!user) throw new ApiError(404, 'User not found');
  return { id: user.id, patternId: user.working_pattern_id || '' };
}

module.exports = { create, save, remove, makeDefault, assign };
