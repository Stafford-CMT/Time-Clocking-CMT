'use strict';

/* Raw SQL for the shared setup tables: contracts, non_working,
 * machine_types, suffix_descriptions, customers, cost_centres,
 * default_working_times(+breaks), contract_info(+suffixes),
 * working_times(+breaks). Clocking tables live in clockRepo.
 *
 * `users` is read here for the frontend's convenience but never written --
 * accounts come from Azure AD sign-in, role/cost-centre changes go through
 * /api/users.
 */
const usersRepo = require('./usersRepo');

function timeToHm(value) {
  // pg returns TIME columns as 'HH:MM:SS' -- the setup screens use HH:MM.
  return value ? value.slice(0, 5) : value;
}

async function getSetup(db) {
  const contracts = (await db.query('SELECT * FROM contracts ORDER BY sort_order')).rows.map((c) => ({
    id: c.id,
    customerName: c.customer_name,
    number: c.number,
    suffix: c.suffix,
    suffixDescription: c.suffix_description,
    machineType: c.machine_type,
    image: c.image,
    pinned: c.pinned,
    hidden: c.hidden,
  }));
  const order = contracts.map((c) => c.id);

  const nonWorking = (await db.query('SELECT id, date, category, start_time, end_time FROM non_working ORDER BY date')).rows
    .map((r) => ({ id: r.id, date: r.date, category: r.category, start: timeToHm(r.start_time), end: timeToHm(r.end_time) }));

  const machineTypes = (await db.query('SELECT name FROM machine_types ORDER BY sort_order')).rows.map((r) => r.name);
  const suffixDescriptions = (await db.query('SELECT name FROM suffix_descriptions ORDER BY sort_order')).rows.map((r) => r.name);
  const customers = (await db.query('SELECT name FROM customers ORDER BY sort_order')).rows.map((r) => r.name);
  const costCentres = (await db.query('SELECT name FROM cost_centres ORDER BY sort_order')).rows.map((r) => r.name);

  const defaultRow = (await db.query('SELECT start, "end" FROM default_working_times WHERE id = 1')).rows[0];
  const defaultBreaks = (await db.query('SELECT start, "end" FROM default_working_time_breaks ORDER BY sort_order')).rows;
  const defaultWorkingTimes = {
    start: timeToHm(defaultRow.start),
    end: timeToHm(defaultRow.end),
    breaks: defaultBreaks.map((b) => ({ start: timeToHm(b.start), end: timeToHm(b.end) })),
  };

  const infoSuffixRows = (await db.query('SELECT * FROM contract_info_suffixes ORDER BY sort_order')).rows;
  const suffixesByInfo = {};
  infoSuffixRows.forEach((s) => {
    suffixesByInfo[s.contract_info_id] = suffixesByInfo[s.contract_info_id] || [];
    suffixesByInfo[s.contract_info_id].push({ id: s.id, letter: s.letter, description: s.description });
  });
  const contractInfo = (await db.query('SELECT * FROM contract_info ORDER BY sort_order')).rows.map((r) => ({
    id: r.id,
    number: r.number,
    machineType: r.machine_type,
    customerName: r.customer_name,
    oneDriveLink: r.one_drive_link,
    orderConfirmationLink: r.order_confirmation_link,
    expanded: r.expanded,
    suffixes: suffixesByInfo[r.id] || [],
  }));

  const wtBreakRows = (await db.query('SELECT * FROM working_time_breaks ORDER BY sort_order')).rows;
  const breaksByWt = {};
  wtBreakRows.forEach((b) => {
    breaksByWt[b.working_time_id] = breaksByWt[b.working_time_id] || [];
    breaksByWt[b.working_time_id].push({ id: b.id, type: b.type, start: timeToHm(b.start), end: timeToHm(b.end) });
  });
  const workingTimes = (await db.query('SELECT * FROM working_times')).rows.map((wt) => ({
    id: wt.id,
    userId: wt.user_id,
    start: timeToHm(wt.start),
    end: timeToHm(wt.end),
    breaks: breaksByWt[wt.id] || [],
  }));

  const users = (await usersRepo.listAll()).map((u) => ({
    id: u.id,
    name: u.name,
    email: u.email || '',
    userType: u.user_type,
    costCentre: u.cost_centre || '',
  }));

  return {
    contracts, order, nonWorking, machineTypes, suffixDescriptions, customers, costCentres,
    defaultWorkingTimes, contractInfo, workingTimes, users,
  };
}

/* Contracts are upserted, never deleted: deleting one cascades away every
 * clocked session against it, and the frontend only ever hides tiles. So a
 * browser holding a stale contract list can't destroy anyone's time.
 * `image` is only overwritten when the key is present, so pin/hide/reorder
 * saves don't have to re-upload every tile's picture.
 */
async function upsertContract(db, c) {
  const params = [c.id, c.customerName || '', c.number || '', c.suffix || '', c.suffixDescription || '', c.machineType || '', !!c.pinned, !!c.hidden];
  const hasImage = Object.prototype.hasOwnProperty.call(c, 'image');
  if (hasImage) params.push(c.image || null);
  await db.query(
    `INSERT INTO contracts (id, customer_name, number, suffix, suffix_description, machine_type, pinned, hidden${hasImage ? ', image' : ''})
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8${hasImage ? ',$9' : ''})
     ON CONFLICT (id) DO UPDATE SET customer_name = EXCLUDED.customer_name, number = EXCLUDED.number, suffix = EXCLUDED.suffix,
       suffix_description = EXCLUDED.suffix_description, machine_type = EXCLUDED.machine_type,
       pinned = EXCLUDED.pinned, hidden = EXCLUDED.hidden${hasImage ? ', image = EXCLUDED.image' : ''}`,
    params
  );
}

async function setContractOrder(db, order) {
  for (let i = 0; i < order.length; i += 1) {
    await db.query('UPDATE contracts SET sort_order = $1 WHERE id = $2', [i, order[i]]);
  }
}

async function replaceNameList(db, table, names) {
  await db.query(`DELETE FROM ${table}`);
  let i = 0;
  for (const name of names) {
    await db.query(`INSERT INTO ${table} (name, sort_order) VALUES ($1,$2) ON CONFLICT (name) DO NOTHING`, [name, i]);
    i += 1;
  }
}

async function replaceNonWorking(db, entries) {
  await db.query('DELETE FROM non_working');
  for (const entry of entries) {
    await db.query(
      'INSERT INTO non_working (id, date, category, start_time, end_time) VALUES ($1,$2,$3,$4,$5)',
      [entry.id, entry.date, entry.category || '', entry.start, entry.end]
    );
  }
}

async function replaceDefaultWorkingTimes(db, value) {
  await db.query('UPDATE default_working_times SET start = $1, "end" = $2 WHERE id = 1', [value.start, value.end]);
  await db.query('DELETE FROM default_working_time_breaks');
  let breakIdx = 0;
  for (const b of value.breaks || []) {
    await db.query('INSERT INTO default_working_time_breaks (sort_order, start, "end") VALUES ($1,$2,$3)', [breakIdx, b.start, b.end]);
    breakIdx += 1;
  }
}

async function replaceContractInfo(db, records) {
  await db.query('DELETE FROM contract_info'); // cascades contract_info_suffixes
  let infoIndex = 0;
  for (const record of records) {
    await db.query(
      `INSERT INTO contract_info (id, number, machine_type, customer_name, one_drive_link, order_confirmation_link, expanded, sort_order)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [record.id, record.number || '', record.machineType || '', record.customerName || '', record.oneDriveLink || '', record.orderConfirmationLink || '', !!record.expanded, infoIndex]
    );
    infoIndex += 1;
    let suffixIndex = 0;
    for (const suffix of record.suffixes || []) {
      await db.query(
        'INSERT INTO contract_info_suffixes (id, contract_info_id, letter, description, sort_order) VALUES ($1,$2,$3,$4,$5)',
        [suffix.id, record.id, suffix.letter || '', suffix.description || '', suffixIndex]
      );
      suffixIndex += 1;
    }
  }
}

async function replaceWorkingTimes(db, entries) {
  await db.query('DELETE FROM working_times'); // cascades working_time_breaks
  for (const entry of entries) {
    const user = await usersRepo.findById(entry.userId);
    if (!user) continue; // working-time rows only make sense for a real, signed-in user
    await db.query('INSERT INTO working_times (id, user_id, start, "end") VALUES ($1,$2,$3,$4)', [entry.id, entry.userId, entry.start, entry.end]);
    let breakIndex = 0;
    for (const brk of entry.breaks || []) {
      await db.query(
        'INSERT INTO working_time_breaks (id, working_time_id, type, start, "end", sort_order) VALUES ($1,$2,$3,$4,$5,$6)',
        [brk.id, entry.id, brk.type || 'Break', brk.start, brk.end, breakIndex]
      );
      breakIndex += 1;
    }
  }
}

module.exports = {
  getSetup, upsertContract, setContractOrder, replaceNameList, replaceNonWorking,
  replaceDefaultWorkingTimes, replaceContractInfo, replaceWorkingTimes,
};
