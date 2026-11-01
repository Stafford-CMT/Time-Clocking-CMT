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
const { uid } = require('../utils/ids');

function timeToHm(value) {
  // pg returns TIME columns as 'HH:MM:SS' -- the setup screens use HH:MM.
  return value ? value.slice(0, 5) : value;
}

// Tiles are shared; hidden, pinned and order are the caller's own. A tile the
// caller has no settings row for (one someone else added) is hidden for them.
async function getSetup(db, userId) {
  const contracts = (await db.query(
    `SELECT c.*, s.hidden AS my_hidden, s.pinned AS my_pinned FROM contracts c
     LEFT JOIN user_tile_settings s ON s.contract_id = c.id AND s.user_id = $1
     ORDER BY s.sort_order NULLS LAST, c.sort_order`,
    [userId]
  )).rows.map((c) => ({
    id: c.id,
    customerName: c.customer_name,
    number: c.number,
    suffix: c.suffix,
    suffixDescription: c.suffix_description,
    machineType: c.machine_type,
    image: c.image,
    pinned: c.my_pinned ?? false,
    hidden: c.system ? false : c.my_hidden ?? true,
    system: c.system, // the built-in Non-contract clock: never a tile
  }));
  const order = contracts.filter((c) => !c.system).map((c) => c.id);

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

  const workingTimes = await listWorkingTimes(db);

  const users = (await usersRepo.listAll()).map((u) => ({
    id: u.id,
    name: u.name,
    email: u.email || '',
    userType: u.user_type,
    costCentre: u.cost_centre || '',
    autoClockOut: u.auto_clock_out ? timeToHm(u.auto_clock_out) : '', // '' = at the end of their working day
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
 * saves don't have to re-upload every tile's picture. A new contract goes to
 * the end of the shared creation order.
 */
async function upsertContract(db, c) {
  const params = [c.id, c.customerName || '', c.number || '', c.suffix || '', c.suffixDescription || '', c.machineType || ''];
  const hasImage = Object.prototype.hasOwnProperty.call(c, 'image');
  if (hasImage) params.push(c.image || null);
  await db.query(
    `INSERT INTO contracts (id, customer_name, number, suffix, suffix_description, machine_type, sort_order${hasImage ? ', image' : ''})
     VALUES ($1,$2,$3,$4,$5,$6,(SELECT COALESCE(MAX(sort_order) + 1, 0) FROM contracts)${hasImage ? ',$7' : ''})
     ON CONFLICT (id) DO UPDATE SET customer_name = EXCLUDED.customer_name, number = EXCLUDED.number, suffix = EXCLUDED.suffix,
       suffix_description = EXCLUDED.suffix_description, machine_type = EXCLUDED.machine_type${hasImage ? ', image = EXCLUDED.image' : ''}
     WHERE NOT contracts.system`,
    params
  );
}

// The rest of a user's tile settings; a tile new to them goes to the end of
// their order.
async function setTileSettings(db, userId, c) {
  await db.query(
    `INSERT INTO user_tile_settings (user_id, contract_id, hidden, pinned, sort_order)
     SELECT $1::text, id, $3, $4, (SELECT COALESCE(MAX(sort_order) + 1, 0) FROM user_tile_settings WHERE user_id = $1::text)
     FROM contracts WHERE id = $2 AND NOT system
     ON CONFLICT (user_id, contract_id) DO UPDATE SET hidden = EXCLUDED.hidden, pinned = EXCLUDED.pinned`,
    [userId, c.id, !!c.hidden, !!c.pinned]
  );
}

// Tiles in the order that the user has never chosen stay hidden for them.
async function setTileOrder(db, userId, order) {
  for (let i = 0; i < order.length; i += 1) {
    await db.query(
      `INSERT INTO user_tile_settings (user_id, contract_id, hidden, sort_order)
       SELECT $1::text, id, true, $3 FROM contracts WHERE id = $2 AND NOT system
       ON CONFLICT (user_id, contract_id) DO UPDATE SET sort_order = EXCLUDED.sort_order`,
      [userId, order[i], i]
    );
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

async function listWorkingTimes(db) {
  const wtBreakRows = (await db.query('SELECT * FROM working_time_breaks ORDER BY sort_order')).rows;
  const breaksByWt = {};
  wtBreakRows.forEach((b) => {
    breaksByWt[b.working_time_id] = breaksByWt[b.working_time_id] || [];
    breaksByWt[b.working_time_id].push({ id: b.id, type: b.type, start: timeToHm(b.start), end: timeToHm(b.end) });
  });
  return (await db.query('SELECT * FROM working_times')).rows.map((wt) => ({
    id: wt.id,
    userId: wt.user_id,
    start: timeToHm(wt.start),
    end: timeToHm(wt.end),
    breaks: breaksByWt[wt.id] || [],
  }));
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

// Someone just ticked into Time Slide starts with a copy of the default
// working times, unless they already have a row. Returns whether one was added.
async function addDefaultWorkingTimes(db, userId) {
  if ((await db.query('SELECT 1 FROM working_times WHERE user_id = $1', [userId])).rows.length) return false;
  const defaults = (await db.query('SELECT start, "end" FROM default_working_times WHERE id = 1')).rows[0];
  if (!defaults) return false;
  const breaks = (await db.query('SELECT start, "end" FROM default_working_time_breaks ORDER BY sort_order')).rows;
  const workingTimeId = uid('wt');
  await db.query('INSERT INTO working_times (id, user_id, start, "end") VALUES ($1,$2,$3,$4)', [workingTimeId, userId, defaults.start, defaults.end]);
  for (const [index, brk] of breaks.entries()) {
    await db.query(
      'INSERT INTO working_time_breaks (id, working_time_id, type, start, "end", sort_order) VALUES ($1,$2,$3,$4,$5,$6)',
      [uid('break'), workingTimeId, 'Break', brk.start, brk.end, index]
    );
  }
  return true;
}

module.exports = {
  getSetup, upsertContract, setTileSettings, setTileOrder, replaceNameList, replaceNonWorking,
  replaceDefaultWorkingTimes, replaceContractInfo, listWorkingTimes, replaceWorkingTimes, addDefaultWorkingTimes,
};
