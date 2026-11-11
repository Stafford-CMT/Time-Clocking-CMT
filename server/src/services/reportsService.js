'use strict';

/* Reports. Everyone signed in sees every report, with everyone's time in it
 * (Stafford's decision, 11 Nov 2026): they show where the hours on a contract
 * went, which only makes sense whole.
 */
const reportsRepo = require('../repositories/reportsRepo');
const { getPool } = require('../config/db');
const ApiError = require('../utils/ApiError');
const { DATE_RE } = require('../utils/time');

// Contract Ball: hours per contract, suffix, department, person and rework reason.
async function contractHours(actor, { from, to }) {
  if (!DATE_RE.test(String(from)) || !DATE_RE.test(String(to))) throw new ApiError(400, 'from and to must be YYYY-MM-DD');
  if (from > to) throw new ApiError(400, 'The "from" date must be on or before the "to" date');
  const rows = await reportsRepo.contractHours(getPool(), { from, to });
  return {
    from, to,
    rows: rows.map((row) => ({
      number: row.number || '', suffix: row.suffix || '', suffixDescription: row.suffix_description || '',
      customer: row.customer_name || '', machineType: row.machine_type || '',
      department: row.department, userId: row.user_id, person: row.person, reworkReason: row.rework_reason,
      hours: row.seconds / 3600, blocks: row.blocks, firstDate: row.first_date, lastDate: row.last_date,
    })),
  };
}

module.exports = { contractHours };
