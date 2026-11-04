'use strict';

/* Raw SQL for working patterns (Lists -> Working patterns): named weekly
 * patterns, a day each (weekday 1 = Monday ... 7 = Sunday), and the breaks
 * of each day. A day is 'own' (its own times), 'same' (follows Monday) or
 * 'off' (not a working day). Each person is on one pattern
 * (users.working_pattern_id), or none: no working hours at all.
 */
const { uid } = require('../utils/ids');

const hm = (value) => (value ? value.slice(0, 5) : ''); // pg TIME 'HH:MM:SS' -> 'HH:MM'

async function listPatterns(db) {
  const patterns = (await db.query('SELECT id, name, is_default FROM working_patterns ORDER BY sort_order, lower(name)')).rows;
  const days = (await db.query('SELECT pattern_id, weekday, mode, start, "end" FROM working_pattern_days ORDER BY weekday')).rows;
  const breaks = (await db.query('SELECT id, pattern_id, weekday, start, "end" FROM working_pattern_breaks ORDER BY sort_order, start')).rows;
  return patterns.map((p) => ({
    id: p.id,
    name: p.name,
    isDefault: p.is_default,
    days: days.filter((d) => d.pattern_id === p.id).map((d) => ({
      weekday: d.weekday,
      mode: d.mode,
      start: hm(d.start),
      end: hm(d.end),
      breaks: breaks.filter((b) => b.pattern_id === p.id && b.weekday === d.weekday).map((b) => ({ id: b.id, start: hm(b.start), end: hm(b.end) })),
    })),
  }));
}

async function findPattern(db, id) {
  return (await listPatterns(db)).find((p) => p.id === id) || null;
}

// Replaces a pattern's name and all seven days (already checked by the service).
async function savePattern(db, id, { name, days }) {
  await db.query('UPDATE working_patterns SET name = $2 WHERE id = $1', [id, name]);
  await db.query('DELETE FROM working_pattern_days WHERE pattern_id = $1', [id]); // cascades its breaks
  for (const day of days) {
    const own = day.mode === 'own';
    await db.query('INSERT INTO working_pattern_days (pattern_id, weekday, mode, start, "end") VALUES ($1,$2,$3,$4,$5)',
      [id, day.weekday, day.mode, own ? day.start : null, own ? day.end : null]);
    if (!own) continue;
    for (const [index, brk] of day.breaks.entries()) {
      await db.query('INSERT INTO working_pattern_breaks (id, pattern_id, weekday, start, "end", sort_order) VALUES ($1,$2,$3,$4,$5,$6)',
        [uid('break'), id, day.weekday, brk.start, brk.end, index]);
    }
  }
}

// A new pattern, last in the list, starting as a copy of `days`.
async function createPattern(db, { name, days }) {
  const id = uid('pattern');
  await db.query('INSERT INTO working_patterns (id, name, sort_order) VALUES ($1, $2, (SELECT COALESCE(max(sort_order), -1) + 1 FROM working_patterns))', [id, name]);
  await savePattern(db, id, { name, days });
  return id;
}

async function deletePattern(db, id) {
  await db.query('DELETE FROM working_patterns WHERE id = $1', [id]);
}

async function setDefault(db, id) {
  await db.query('UPDATE working_patterns SET is_default = false WHERE is_default AND id <> $1', [id]);
  await db.query('UPDATE working_patterns SET is_default = true WHERE id = $1', [id]);
}

async function countPeople(db, id) {
  return (await db.query('SELECT count(*)::int AS n FROM users WHERE working_pattern_id = $1 AND included', [id])).rows[0].n;
}

async function setUserPattern(db, userId, patternId) {
  const { rows } = await db.query('UPDATE users SET working_pattern_id = $2 WHERE id = $1 RETURNING id, working_pattern_id', [userId, patternId]);
  return rows[0] || null;
}

// Someone just ticked into Time Slide goes on the default pattern, unless
// they are already on one. Returns the pattern's name, or null.
async function assignDefault(db, userId) {
  const { rows } = await db.query(
    `UPDATE users u SET working_pattern_id = p.id FROM working_patterns p
      WHERE u.id = $1 AND u.working_pattern_id IS NULL AND p.is_default RETURNING p.name`,
    [userId]
  );
  return rows[0]?.name ?? null;
}

/* A person's working day on `date` ('YYYY-MM-DD'), or null with no pattern:
 * { off, start, end, breaks, clockEnd } (times 'HH:MM:SS'). A 'same' day uses
 * Monday's times. A day off has no hours or breaks; clockEnd (what the auto
 * clock-out counts from) is then Monday's end, so a forgotten clock at the
 * weekend still stops. */
async function dayFor(db, userId, date) {
  const { rows } = await db.query(
    `SELECT d.mode, d.start, d."end", m.start AS mon_start, m."end" AS mon_end, d.pattern_id, extract(isodow FROM $2::date)::int AS weekday
       FROM users u
       JOIN working_pattern_days d ON d.pattern_id = u.working_pattern_id AND d.weekday = extract(isodow FROM $2::date)
       JOIN working_pattern_days m ON m.pattern_id = u.working_pattern_id AND m.weekday = 1
      WHERE u.id = $1`,
    [userId, date]
  );
  const day = rows[0];
  if (!day) return null;
  if (day.mode === 'off') return { off: true, start: null, end: null, breaks: [], clockEnd: day.mon_end };
  const weekday = day.mode === 'same' ? 1 : day.weekday;
  const breaks = (await db.query('SELECT start, "end" FROM working_pattern_breaks WHERE pattern_id = $1 AND weekday = $2 ORDER BY start', [day.pattern_id, weekday])).rows;
  const start = day.mode === 'same' ? day.mon_start : day.start;
  const end = day.mode === 'same' ? day.mon_end : day.end;
  return { off: false, start, end, breaks, clockEnd: end };
}

// The latest end of any working day in this person's pattern ('HH:MM:SS'), or null.
async function latestEnd(db, userId) {
  const { rows } = await db.query(
    `SELECT max(d."end") AS end FROM users u JOIN working_pattern_days d ON d.pattern_id = u.working_pattern_id AND d.mode = 'own' WHERE u.id = $1`,
    [userId]
  );
  return rows[0]?.end ?? null;
}

module.exports = {
  listPatterns, findPattern, savePattern, createPattern, deletePattern, setDefault, countPeople,
  setUserPattern, assignDefault, dayFor, latestEnd,
};
