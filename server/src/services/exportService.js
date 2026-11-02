'use strict';

/* Setup -> Data export.
 * - Overview: everyone's days in a date range (admins) or your own (others):
 *   hours, committed or not, exported or not, changed since export.
 * - Export batches (admins): downloading takes every committed day in the
 *   range that hasn't been exported yet, records it as exported and returns
 *   the spreadsheet. A day is only ever in one live batch; undoing a batch
 *   frees its days. Admins can still edit an exported day -- the overview
 *   then flags it as changed since export.
 * - Commit reminders (admins): emails everyone with uncommitted time before
 *   today in the range.
 * - Preview: the same spreadsheet for any dates without marking anything
 *   (your own times, or anyone's for an admin).
 */
const ExcelJS = require('exceljs');
const clockRepo = require('../repositories/clockRepo');
const exportRepo = require('../repositories/exportRepo');
const mailService = require('./mailService');
const env = require('../config/env');
const { getPool, withTransaction } = require('../config/db');
const ApiError = require('../utils/ApiError');
const { uid } = require('../utils/ids');
const { localDate, timeToSeconds, DATE_RE } = require('../utils/time');

const isAdmin = (actor) => actor.userType === 'admin';
const DAY_SECONDS = 24 * 3600;
const MAX_DAYS = 93;
const dayKey = (userId, date) => `${userId}|${date}`;

function assertAdmin(actor) {
  if (!isAdmin(actor)) throw new ApiError(403, 'Only an admin can do this');
}

// Every date from..to as 'YYYY-MM-DD' (worked in UTC so no day is skipped or repeated at a clock change).
function datesBetween(from, to) {
  const dates = [];
  for (let d = new Date(`${from}T00:00:00Z`); d <= new Date(`${to}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + 1)) dates.push(d.toISOString().slice(0, 10));
  return dates;
}

function assertRange(from, to) {
  if (!DATE_RE.test(String(from)) || !DATE_RE.test(String(to))) throw new ApiError(400, 'from and to must be YYYY-MM-DD');
  if (from > to) throw new ApiError(400, 'The "from" date must be on or before the "to" date');
  if (datesBetween(from, to).length > MAX_DAYS) throw new ApiError(400, `Choose ${MAX_DAYS} days or fewer`);
}

// Contract -> seconds, without empty entries, for comparing a day with its export snapshot.
const sameTotals = (a, b) => {
  const clean = (totals) => Object.entries(totals || {}).filter(([, s]) => s > 0).sort(([x], [y]) => x.localeCompare(y));
  return JSON.stringify(clean(a)) === JSON.stringify(clean(b));
};

/* Each person's days in the range. A day's status is one of:
 * 'uncommitted' (time not committed), 'committed' (not exported yet),
 * 'exported', 'changed' (exported, then edited by an admin) or 'empty'. */
async function buildOverview(db, { from, to, userId }) {
  // One after another: db may be a single transaction client, which can't run queries side by side.
  const scope = { from, to, userId };
  const people = await exportRepo.listPeople(db, scope);
  const totals = await exportRepo.findDayTotals(db, scope);
  const committed = await exportRepo.findCommittedDays(db, scope);
  const exported = await exportRepo.findExportedDays(db, scope);
  const running = await exportRepo.findRunningClocks(db, userId);
  const reminders = await exportRepo.findLastReminders(db, userId);
  const today = localDate(new Date());
  const users = people.map((p) => ({ id: p.id, name: p.name, email: p.email || '', lastReminderAt: null, running: false, days: {} }));
  const byId = new Map(users.map((u) => [u.id, u]));
  const dayOf = (uId, date) => {
    const user = byId.get(uId);
    if (!user) return null;
    user.days[date] = user.days[date] || { seconds: 0, contracts: {}, committed: false, exported: null };
    return user.days[date];
  };
  totals.forEach((r) => { const day = dayOf(r.user_id, r.date); if (day) { day.seconds += r.seconds; day.contracts[r.contract_id] = r.seconds; } });
  committed.forEach((r) => { const day = dayOf(r.user_id, r.date); if (day) day.committed = true; });
  exported.forEach((r) => { const day = dayOf(r.user_id, r.date); if (day) day.exported = { batchId: r.batch_id, at: r.created_at, snapshot: r.snapshot }; });
  running.forEach((r) => { const user = byId.get(r.user_id); if (user) user.running = true; });
  reminders.forEach((r) => { const user = byId.get(r.user_id); if (user) user.lastReminderAt = r.sent_at; });

  users.forEach((user) => {
    Object.entries(user.days).forEach(([date, day]) => {
      if (day.exported) day.status = sameTotals(day.exported.snapshot, day.contracts) ? 'exported' : 'changed';
      else if (day.seconds > 0 && !day.committed) day.status = 'uncommitted';
      else if (day.seconds > 0) day.status = 'committed';
      else day.status = 'empty';
      if (user.running && date === today) day.running = true;
    });
  });
  return { from, to, today, dates: datesBetween(from, to), users };
}

// What the browser gets: no contract ids or snapshots, just each day's state.
function publicOverview(data, actor) {
  return {
    ...data,
    canManage: isAdmin(actor),
    users: data.users.map((user) => ({
      ...user,
      days: Object.fromEntries(Object.entries(user.days).map(([date, day]) => [date, {
        seconds: day.seconds, status: day.status, committed: day.committed, running: !!day.running,
        batchId: day.exported?.batchId || null, exportedAt: day.exported?.at || null,
      }])),
    })),
  };
}

async function overview(actor, { from, to }) {
  assertRange(from, to);
  const db = getPool();
  const data = await buildOverview(db, { from, to, userId: isAdmin(actor) ? null : actor.id });
  const result = publicOverview(data, actor);
  if (isAdmin(actor)) {
    result.batches = (await exportRepo.listBatches(db, { from, to })).map((b) => ({
      id: b.id, createdAt: b.created_at, createdBy: b.created_by_name, from: b.date_from, to: b.date_to,
      days: b.days, undoneAt: b.undone_at, undoneBy: b.undone_by_name,
    }));
    result.emailReady = Boolean(env.mailFrom);
  }
  return result;
}

// Excel stores a date as a day count and a time of day as a fraction of a
// day, so real values (not text) let people sort, filter and sum them.
const excelDate = (date) => { const [y, m, d] = date.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d)); };

function addHeader(sheet) {
  const header = sheet.getRow(1);
  header.font = { bold: true };
  header.alignment = { vertical: 'middle', wrapText: true };
  sheet.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: sheet.columns.length } };
}

// Sheet 1: every time block. Sheet 2: hours per person, day and contract (rework apart, per reason).
async function buildWorkbook(rows) {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'Time Slide';
  const contractCells = (row) => (row.system
    ? { contract: 'Non-contract', suffix: '', suffixDescription: '', customer: '', machineType: '' }
    : { contract: row.number, suffix: row.suffix, suffixDescription: row.suffix_description, customer: row.customer_name, machineType: row.machine_type });
  const personColumns = [
    { header: 'Person', key: 'person', width: 24 },
    { header: 'Email', key: 'email', width: 28 },
    { header: 'Cost centre', key: 'costCentre', width: 16 },
    { header: 'Date', key: 'date', width: 12, style: { numFmt: 'dd/mm/yyyy' } },
    { header: 'Contract', key: 'contract', width: 14 },
    { header: 'Suffix', key: 'suffix', width: 8 },
    { header: 'Suffix description', key: 'suffixDescription', width: 24 },
    { header: 'Customer', key: 'customer', width: 26 },
    { header: 'Machine type', key: 'machineType', width: 18 },
    { header: 'Rework', key: 'rework', width: 9 },
    { header: 'Rework reason', key: 'reworkReason', width: 24 },
  ];

  const blocks = workbook.addWorksheet('Clocked times', { views: [{ state: 'frozen', ySplit: 1 }] });
  blocks.columns = [
    ...personColumns,
    { header: 'Start', key: 'start', width: 9, style: { numFmt: 'hh:mm' } },
    { header: 'End', key: 'end', width: 9, style: { numFmt: '[hh]:mm' } },
    { header: 'Duration', key: 'duration', width: 10, style: { numFmt: '[h]:mm' } },
    { header: 'Hours', key: 'hours', width: 8, style: { numFmt: '0.00' } },
    { header: 'Committed', key: 'committed', width: 11 },
    { header: 'Auto clock-out not checked', key: 'autoStopped', width: 14 },
  ];
  const totals = new Map();
  rows.forEach((row) => {
    const start = timeToSeconds(row.start_time);
    const end = timeToSeconds(row.end_time);
    const person = { person: row.user_name, email: row.email || '', costCentre: row.cost_centre || '', date: excelDate(row.date), ...contractCells(row), rework: row.rework_reason ? 'Yes' : 'No', reworkReason: row.rework_reason || '' };
    blocks.addRow({
      ...person,
      start: start / DAY_SECONDS,
      end: end / DAY_SECONDS,
      duration: (end - start) / DAY_SECONDS,
      hours: Math.round(((end - start) / 3600) * 100) / 100,
      committed: row.committed ? 'Yes' : 'No',
      autoStopped: row.auto_stopped ? 'Yes' : '',
    });
    const key = [row.user_id, row.date, person.contract, person.suffix, person.reworkReason].join('|'); // rework kept apart from ordinary time
    if (!totals.has(key)) totals.set(key, { ...person, seconds: 0 });
    totals.get(key).seconds += end - start;
  });
  addHeader(blocks);

  const days = workbook.addWorksheet('Day totals', { views: [{ state: 'frozen', ySplit: 1 }] });
  days.columns = [
    ...personColumns,
    { header: 'Duration', key: 'duration', width: 10, style: { numFmt: '[h]:mm' } },
    { header: 'Hours', key: 'hours', width: 8, style: { numFmt: '0.00' } },
  ];
  totals.forEach(({ seconds, ...person }) => days.addRow({ ...person, duration: seconds / DAY_SECONDS, hours: Math.round((seconds / 3600) * 100) / 100 }));
  addHeader(days);

  return Buffer.from(await workbook.xlsx.writeBuffer());
}

// Preview: the spreadsheet for any dates, marking nothing as exported.
async function exportTimes(actor, { from, to, userId }) {
  assertRange(from, to);
  const forUser = userId || (isAdmin(actor) ? null : actor.id);
  if (forUser !== actor.id && !isAdmin(actor)) throw new ApiError(403, 'You can only export your own times');
  const rows = await clockRepo.findSessionsForExport(getPool(), { from, to, userId: forUser });
  return { buffer: await buildWorkbook(rows), filename: `time-slide-preview_${from}_to_${to}.xlsx` };
}

// Download = export: every committed, not-yet-exported day with time in the
// range goes into one new batch, all or nothing.
async function createBatch(actor, { from, to }) {
  assertAdmin(actor);
  assertRange(from, to);
  return withTransaction(async (db) => {
    await exportRepo.lockExports(db);
    const scope = { from, to, userId: null };
    const data = await buildOverview(db, scope);
    const ready = [];
    data.users.forEach((user) => Object.entries(user.days).forEach(([date, day]) => {
      if (day.status === 'committed') ready.push({ userId: user.id, date, snapshot: day.contracts });
    }));
    if (!ready.length) throw new ApiError(409, 'There are no committed days waiting to be exported in these dates');

    const keys = new Set(ready.map((d) => dayKey(d.userId, d.date)));
    const rows = (await clockRepo.findSessionsForExport(db, scope)).filter((row) => keys.has(dayKey(row.user_id, row.date)));
    const file = await buildWorkbook(rows);
    const batchId = uid('export');
    await exportRepo.insertBatch(db, { id: batchId, createdBy: actor.id, from, to, file });
    for (const day of ready) await exportRepo.insertExportedDay(db, { ...day, batchId });
    return { buffer: file, filename: `time-slide-export_${from}_to_${to}.xlsx`, days: ready.length };
  });
}

async function batchFile(actor, id) {
  assertAdmin(actor);
  const batch = await exportRepo.findBatch(getPool(), id);
  if (!batch) throw new ApiError(404, 'Export not found');
  return { buffer: batch.file, filename: `time-slide-export_${batch.date_from}_to_${batch.date_to}.xlsx` };
}

async function undoBatch(actor, id) {
  assertAdmin(actor);
  await withTransaction(async (db) => {
    await exportRepo.lockExports(db);
    const batch = await exportRepo.findBatch(db, id);
    if (!batch) throw new ApiError(404, 'Export not found');
    if (batch.undone_at) throw new ApiError(409, 'That export has already been undone');
    await exportRepo.undoBatch(db, id, actor.id);
  });
  return { ok: true };
}

const escHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);
const longDate = (date) => new Date(`${date}T00:00:00Z`).toLocaleDateString('en-GB', { timeZone: 'UTC', weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
const hoursText = (seconds) => `${Math.floor(seconds / 3600)}:${String(Math.floor((seconds % 3600) / 60)).padStart(2, '0')}`;

function reminderHtml(name, days) {
  const link = env.appUrl ? `<p><a href="${escHtml(env.appUrl)}">Open Time Slide</a></p>` : '';
  return `<p>Hello ${escHtml(name.split(' ')[0])},</p>
<p>You have time in Time Slide that hasn't been committed yet:</p>
<ul>${days.map((d) => `<li>${escHtml(longDate(d.date))} &ndash; ${hoursText(d.seconds)} hours</li>`).join('')}</ul>
<p>Please open <strong>Edit or Commit times</strong>, check each day and press <strong>Commit</strong>.</p>${link}
<p>Thank you.</p>`;
}

// Everyone with uncommitted time before today in the range gets one email
// listing those days. Today is left out: it's normal not to have committed yet.
async function sendReminders(actor, { from, to }) {
  assertAdmin(actor);
  assertRange(from, to);
  mailService.assertConfigured();
  const db = getPool();
  const data = await buildOverview(db, { from, to, userId: null });
  const result = { sent: [], failed: [], noEmail: [] };
  for (const user of data.users) {
    const days = Object.entries(user.days)
      .filter(([date, day]) => day.status === 'uncommitted' && date < data.today)
      .map(([date, day]) => ({ date, seconds: day.seconds }))
      .sort((a, b) => a.date.localeCompare(b.date));
    if (!days.length) continue;
    if (!user.email) { result.noEmail.push(user.name); continue; }
    try {
      await mailService.sendMail({ to: user.email, subject: 'Time Slide: please commit your times', html: reminderHtml(user.name, days) });
      await exportRepo.addReminder(db, { id: uid('reminder'), userId: user.id, sentBy: actor.id, dates: days.map((d) => d.date) });
      result.sent.push(user.name);
    } catch (err) {
      if (err instanceof ApiError) throw err; // email not set up, or permission refused: stop, nothing more will work
      console.error(`Commit reminder to ${user.email} failed:`, err);
      result.failed.push(user.name);
    }
  }
  return result;
}

module.exports = { overview, exportTimes, createBatch, batchFile, undoBatch, sendReminders };
