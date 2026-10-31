'use strict';

// Clock times are recorded in the SERVER's local time zone -- the server and
// everyone clocking in are on the same site, so this matches the wall clock
// people see. The prototype did the same thing in the browser.
const pad = (n) => String(n).padStart(2, '0');

function localDate(d) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function localTime(d) {
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

// Splits a clocked span at each local midnight so every piece fits one
// time_sessions row (one date, start < end). The prototype recorded an
// overnight session as a single row with end < start, which counted as zero.
function splitByDay(startMs, endMs) {
  const end = new Date(Math.max(endMs, startMs + 1000)); // same 1s minimum as the prototype
  const pieces = [];
  let cursor = new Date(startMs);
  for (;;) {
    const nextMidnight = new Date(cursor.getFullYear(), cursor.getMonth(), cursor.getDate() + 1);
    if (end < nextMidnight) {
      pieces.push({ date: localDate(cursor), start: localTime(cursor), end: localTime(end) });
      return pieces;
    }
    pieces.push({ date: localDate(cursor), start: localTime(cursor), end: '24:00:00' });
    if (end.getTime() === nextMidnight.getTime()) return pieces;
    cursor = nextMidnight;
  }
}

const TIME_RE = /^(([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?|24:00(:00)?)$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function timeToSeconds(value) {
  const [h, m, s] = value.split(':').map(Number);
  return h * 3600 + m * 60 + (s || 0);
}

module.exports = { localDate, localTime, splitByDay, timeToSeconds, TIME_RE, DATE_RE };
