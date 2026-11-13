'use strict';

/* Setup -> Syspro jobs (admins only, read only): which Syspro job each Time
 * Slide contract/suffix's hours belong to.
 *
 * Syspro side: open WipMaster jobs (Complete <> 'Y') whose JobDescription
 * equals their StockCode. WipMaster is Syspro's job table; MrpJobMaster was
 * tried first but is a planning copy that stopped updating (Stafford, 13 Nov).
 * The StockCode is the contract number with its suffix joined on (4663A); a
 * code ending in a digit is a bare contract number (4663, D0135) and is
 * ignored. Rework has its own job per contract: <number>RW (4663RW).
 *
 * Time Slide side: contract time in the chosen dates, Non-contract left out.
 * Ordinary time goes to number + suffix; rework time (any suffix) to number + RW.
 *
 * A code with two or more Syspro jobs is flagged and is not ready to send
 * (Stafford, 13 Nov 2026) until Syspro is tidied so only one is left.
 */
const sysproService = require('./sysproService');
const sysproJobsRepo = require('../repositories/sysproJobsRepo');
const { getPool } = require('../config/db');
const ApiError = require('../utils/ApiError');
const { DATE_RE } = require('../utils/time');

const REWORK_SUFFIX = 'RW';
const codeOf = (number, suffix) => `${number || ''}${suffix || ''}`.replace(/\s+/g, '').toUpperCase();
const hasSuffix = (code) => /\D$/.test(code);

// Syspro jobs by code: { '4663A': [{ job, ... }], ... }, suffixed codes only.
async function sysproJobsByCode() {
  const pool = await sysproService.getSqlPool();
  const result = await pool.request().query(`
    SELECT RTRIM(Job) AS job, RTRIM(StockCode) AS code, RTRIM(CustomerName) AS customer,
           Complete AS complete, JobStartDate AS started
      FROM WipMaster
     WHERE JobDescription = StockCode AND RTRIM(StockCode) <> '' AND Complete <> 'Y'`);
  const byCode = new Map();
  for (const row of result.recordset) {
    const code = codeOf(row.code);
    if (!hasSuffix(code)) continue;
    if (!byCode.has(code)) byCode.set(code, []);
    byCode.get(code).push({
      job: row.job,
      customer: row.customer || '',
      complete: row.complete === 'Y',
      started: row.started instanceof Date && !Number.isNaN(row.started.getTime()) ? row.started.toISOString().slice(0, 10) : null,
    });
  }
  for (const jobs of byCode.values()) jobs.sort((a, b) => a.job.localeCompare(b.job));
  return byCode;
}

async function jobHours({ from, to }) {
  if (!DATE_RE.test(String(from)) || !DATE_RE.test(String(to))) throw new ApiError(400, 'from and to must be YYYY-MM-DD');
  if (from > to) throw new ApiError(400, 'The "from" date must be on or before the "to" date');

  const [byCode, timeRows, tiles] = await Promise.all([
    sysproJobsByCode(),
    sysproJobsRepo.contractTime(getPool(), { from, to }),
    sysproJobsRepo.tileCodes(getPool()),
  ]);

  // Time Slide hours per code.
  const rows = new Map();
  for (const t of timeRows) {
    const rework = Boolean(t.rework_reason);
    const number = (t.number || '').trim();
    const ownSuffix = (t.suffix || '').trim().toUpperCase();
    const suffix = rework ? REWORK_SUFFIX : ownSuffix;
    const code = codeOf(number, suffix);
    if (!rows.has(code)) {
      rows.set(code, {
        code, number, suffix, rework,
        description: rework ? 'Rework' : (t.suffix_description || ''),
        customer: t.customer_name || '',
        committedSeconds: 0, uncommittedSeconds: 0,
        ...(rework ? { parts: new Map() } : {}),
      });
    }
    const row = rows.get(code);
    if (t.committed) row.committedSeconds += t.seconds; else row.uncommittedSeconds += t.seconds;
    if (!row.description && t.suffix_description) row.description = t.suffix_description;
    // A rework row also keeps where its time came from: each suffix and rework reason.
    if (rework) {
      const key = `${ownSuffix}\n${t.rework_reason}`;
      if (!row.parts.has(key)) row.parts.set(key, { code: codeOf(number, ownSuffix), reason: t.rework_reason, committedSeconds: 0, uncommittedSeconds: 0 });
      const part = row.parts.get(key);
      if (t.committed) part.committedSeconds += t.seconds; else part.uncommittedSeconds += t.seconds;
    }
  }

  const timeCodes = new Set(rows.keys());
  const result = [...rows.values()].map((row) => {
    const jobs = byCode.get(row.code) || [];
    let status;
    if (!row.suffix) status = 'no-suffix';
    else if (!jobs.length) status = 'no-job';
    else if (jobs.length > 1) status = 'two-jobs';
    else status = 'matched';
    const parts = row.parts && [...row.parts.values()].sort((a, b) => a.code.localeCompare(b.code, 'en-GB', { numeric: true }) || a.reason.localeCompare(b.reason));
    return { ...row, ...(parts ? { parts } : {}), jobs: jobs.map((j) => j.job), status };
  }).sort((a, b) => a.code.localeCompare(b.code, 'en-GB', { numeric: true }));

  // Syspro jobs with no Time Slide time in these dates; says whether a tile exists for them.
  const tileSet = new Set(tiles.map((t) => codeOf(t.number, t.suffix)));
  const contractNumbers = new Set(tiles.map((t) => codeOf(t.number)));
  const idle = [];
  for (const [code, jobs] of byCode) {
    if (timeCodes.has(code)) continue;
    const isRework = code.endsWith(REWORK_SUFFIX) && contractNumbers.has(code.slice(0, -REWORK_SUFFIX.length));
    for (const job of jobs) idle.push({ code, job: job.job, customer: job.customer, started: job.started, twoJobs: jobs.length > 1, inTimeSlide: tileSet.has(code) || isRework });
  }
  idle.sort((a, b) => a.code.localeCompare(b.code, 'en-GB', { numeric: true }) || a.job.localeCompare(b.job));

  return { from, to, rows: result, idle, sysproCodes: byCode.size };
}

module.exports = { jobHours, codeOf, hasSuffix };
