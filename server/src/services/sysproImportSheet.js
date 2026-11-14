'use strict';

/* The "Syspro import" sheet in every export: the same layout as finance's
 * LABOUR POSTING - IMPORT SHEET.xlsx, ready to paste into Syspro's WIP Labor
 * Import (Use data grid -> paste -> Validate -> Import). Used until Time Slide
 * is trusted, and allowed, to post to Syspro itself (Stafford, 14 Nov 2026).
 *
 * One row per Syspro job and work centre, the hours of every committed day in
 * the export added up, dated the export's "to" date. The job comes from the
 * contract + suffix (rework: contract + RW), exactly as Reports -> Hours by
 * Syspro job. The work centre and operation come from the time block's
 * department (from Microsoft 365, or "Working in"):
 *   Assembly -> ASSY, operation 1;  Design -> DESI, operation 2.
 * Anything that can't go in (Non-contract time, no suffix, no Syspro job or
 * two of them, a department with no work centre yet) is listed on the next
 * sheet, "Not in Syspro import", so no hours go missing without anyone seeing.
 */
const { codeOf, hasSuffix } = require('./sysproJobsService');
const { timeToSeconds } = require('../utils/time');

// Department (as in the Users list, any case) -> Syspro work centre and its operation on every job.
const WORK_CENTRES = {
  assembly: { workCentre: 'ASSY', operation: 1 },
  design: { workCentre: 'DESI', operation: 2 },
};
const REWORK_SUFFIX = 'RW';

const HEADERS = ['Job', 'Operation', 'Work center', 'Work center rate', 'Employee', 'Machine', 'Entry date', 'Run time',
  'Setup time', 'Startup time', 'Teardown time', 'Non-productive code', 'Scrap reason', 'Quantity completed',
  'Quantity scrapped', 'Number of pieces', 'Operation complete', 'Employee rate', 'Work center flag', 'Hierarchy head',
  'Hierarchy section 1', 'Hierarchy section 2', 'Hierarchy section 3', 'Hierarchy section 4', 'Labor reference',
  'Additional labor reference', 'Message'];
const TITLE = 'CLIFFORD MACHINES & TECHNOLOGY - LABOUR POSTING IMPORT SHEET';
const BLUE = 'FF3C82DC';
const hoursOf = (seconds) => Math.round(seconds / 36) / 100;

/* rows: the export's time blocks (clockRepo.findSessionsForExport).
 * jobsByCode: open Syspro jobs per contract+suffix (sysproJobsService.sysproJobsByCode).
 * Returns { lines: [{ job, operation, workCentre, seconds }], skipped: [{ code, department, reason, seconds }] }. */
function buildSysproImport(rows, jobsByCode) {
  const lines = new Map();
  const skipped = new Map();
  const skip = (code, department, reason, seconds) => {
    const key = `${code}|${department}|${reason}`;
    if (!skipped.has(key)) skipped.set(key, { code, department, reason, seconds: 0 });
    skipped.get(key).seconds += seconds;
  };

  for (const row of rows) {
    const seconds = timeToSeconds(row.end_time) - timeToSeconds(row.start_time);
    if (seconds <= 0) continue;
    const department = (row.department || '').trim();
    if (row.system) { skip('Non-contract', department, 'Non-contract time: post it by hand in Labor Posting if it is needed', seconds); continue; }

    const number = (row.number || '').trim();
    const ownSuffix = (row.suffix || '').trim();
    const code = codeOf(number, row.rework_reason ? REWORK_SUFFIX : ownSuffix);
    if (!hasSuffix(code)) { skip(code, department, 'The contract has no suffix, so there is no Syspro job for it', seconds); continue; }
    const jobs = jobsByCode.get(code) || [];
    if (!jobs.length) { skip(code, department, `No open Syspro job for ${code}`, seconds); continue; }
    if (jobs.length > 1) { skip(code, department, `${code} has ${jobs.length} open Syspro jobs (${jobs.map((j) => j.job).join(', ')}): close all but one`, seconds); continue; }
    const centre = WORK_CENTRES[department.toLowerCase()];
    if (!centre) { skip(code, department, department ? `No Syspro work centre for the ${department} department yet` : 'The time has no department', seconds); continue; }

    const key = `${jobs[0].job}|${centre.workCentre}`;
    if (!lines.has(key)) lines.set(key, { job: jobs[0].job, ...centre, seconds: 0 });
    lines.get(key).seconds += seconds;
  }

  return {
    lines: [...lines.values()].sort((a, b) => a.operation - b.operation || a.job.localeCompare(b.job)),
    skipped: [...skipped.values()].sort((a, b) => a.code.localeCompare(b.code, 'en-GB', { numeric: true }) || a.department.localeCompare(b.department)),
  };
}

// Adds "Syspro import" and "Not in Syspro import" to the workbook. entryDate: a Date (UTC midnight).
function addSysproSheets(workbook, { lines, skipped }, entryDate) {
  const sheet = workbook.addWorksheet('Syspro import', { views: [{ state: 'frozen', ySplit: 3 }] });
  sheet.mergeCells(1, 1, 1, HEADERS.length + 1);
  const title = sheet.getCell('A1');
  title.value = TITLE;
  title.font = { name: 'Georgia', family: 1, size: 18, bold: true, color: { argb: BLUE } };
  const header = sheet.getRow(3);
  HEADERS.forEach((text, i) => {
    const cell = header.getCell(i + 2); // column A stays empty, as in finance's sheet
    cell.value = text;
    cell.font = { name: 'Verdana', family: 2, size: 9, bold: true, color: { argb: 'FFFFFFFF' } };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: BLUE } };
  });
  sheet.getColumn(1).width = 3;
  sheet.getColumn(2).width = 12;
  sheet.getColumn(8).width = 11;
  lines.forEach((line, i) => {
    const row = sheet.getRow(4 + i);
    row.getCell(2).value = line.job;
    row.getCell(3).value = line.operation;
    row.getCell(4).value = line.workCentre;
    row.getCell(5).value = 1; // work centre rate
    row.getCell(8).value = entryDate;
    row.getCell(8).numFmt = 'mm-dd-yy'; // Excel's own short date, shown the Windows way (dd/mm/yyyy here)
    row.getCell(9).value = hoursOf(line.seconds);
    [10, 11, 12, 15, 16, 17].forEach((col) => { row.getCell(col).value = 0; }); // setup, startup, teardown, quantities
  });

  const left = workbook.addWorksheet('Not in Syspro import', { views: [{ state: 'frozen', ySplit: 1 }] });
  left.columns = [
    { header: 'Contract', key: 'code', width: 14 },
    { header: 'Department', key: 'department', width: 18 },
    { header: 'Hours', key: 'hours', width: 9, style: { numFmt: '0.00' } },
    { header: 'Why it is not in the Syspro import', key: 'reason', width: 70 },
  ];
  left.getRow(1).font = { bold: true };
  skipped.forEach((s) => left.addRow({ code: s.code, department: s.department || '(none)', hours: hoursOf(s.seconds), reason: s.reason }));
  if (!skipped.length) left.addRow({ reason: 'Nothing: every hour in this export is on the Syspro import sheet.' });
  const sum = (list) => hoursOf(list.reduce((total, x) => total + x.seconds, 0));
  left.addRow({});
  [['In the Syspro import', sum(lines)], ['Not in it (above)', sum(skipped)], ['All hours in this export', sum([...lines, ...skipped])]]
    .forEach(([label, hours]) => { const row = left.addRow({ code: label, hours }); row.font = { bold: true }; });
}

module.exports = { buildSysproImport, addSysproSheets, WORK_CENTRES };
