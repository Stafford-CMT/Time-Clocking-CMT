'use strict';

/* Raw SQL for the shared setup tables: contracts, non_working,
 * machine_types, suffix_descriptions, customers, cost_centres,
 * contract_info(+suffixes), and the auto clock-out delay (in
 * default_working_times). Working patterns live in workingPatternsRepo,
 * clocking tables in clockRepo.
 *
 * `users` is read here for the frontend's convenience and only written by a
 * cost centre rename (renameCostCentre) --
 * accounts come from Azure AD sign-in, role/cost-centre changes go through
 * /api/users.
 */
const usersRepo = require('./usersRepo');
const workingPatternsRepo = require('./workingPatternsRepo');
const { uid } = require('../utils/ids');
const ApiError = require('../utils/ApiError');

function timeToHm(value) {
  // pg returns TIME columns as 'HH:MM:SS' -- the setup screens use HH:MM.
  return value ? value.slice(0, 5) : value;
}

// Tiles are shared; hidden, pinned and order are the caller's own. A tile the
// caller has no settings row for (one someone else added) is hidden for them.
async function getSetup(db, userId) {
  const contracts = (await db.query(
    `SELECT c.id, c.customer_name, c.number, c.suffix, c.suffix_description, c.machine_type, c.image_id, c.system,
       c.contract_info_suffix_id, c.retired, s.hidden AS my_hidden, s.pinned AS my_pinned FROM contracts c
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
    imageId: c.image_id, // the picture is fetched from /api/images/:id, not sent here
    pinned: c.my_pinned ?? false,
    hidden: c.system ? false : c.my_hidden ?? true,
    system: c.system, // the built-in Non-contract clock: never a tile
    linked: c.contract_info_suffix_id !== null, // made from a Contract information suffix: only its image is edited on the tile
    retired: c.retired, // its suffix was removed but time is clocked on it: on no dashboard, its time still counts
  }));
  const order = contracts.filter((c) => !c.system && !c.retired).map((c) => c.id);

  const nonWorking = (await db.query('SELECT id, date, category, start_time, end_time FROM non_working ORDER BY date')).rows
    .map((r) => ({ id: r.id, date: r.date, category: r.category, start: timeToHm(r.start_time), end: timeToHm(r.end_time) }));

  const machineTypes = (await db.query('SELECT name FROM machine_types ORDER BY lower(name), name')).rows.map((r) => r.name);
  const suffixDescriptions = (await db.query('SELECT name FROM suffix_descriptions ORDER BY lower(name), name')).rows.map((r) => r.name);
  const customers = (await db.query('SELECT name FROM customers ORDER BY lower(name), name')).rows.map((r) => r.name);
  const costCentres = await listCostCentres(db); // A-Z
  const reworkReasons = (await db.query('SELECT name FROM rework_reasons ORDER BY lower(name), name')).rows.map((x) => x.name);

  // Minutes after the end of the working day that a forgotten clock stops (everyone without their own time).
  const autoClockOutDelay = (await db.query('SELECT auto_clock_out_delay FROM default_working_times WHERE id = 1')).rows[0].auto_clock_out_delay;

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

  const workingPatterns = await workingPatternsRepo.listPatterns(db);

  const users = (await usersRepo.listAll()).map((u) => ({
    id: u.id,
    name: u.name,
    email: u.email || '',
    userType: u.user_type,
    costCentre: u.cost_centre || '',
    autoClockOut: u.auto_clock_out ? timeToHm(u.auto_clock_out) : '', // '' = at the end of their working day
    patternId: u.working_pattern_id || '', // '' = no working pattern
  }));

  return {
    contracts, order, nonWorking, machineTypes, suffixDescriptions, customers, costCentres, reworkReasons,
    autoClockOutDelay, contractInfo, workingPatterns, users,
  };
}

/* Contracts are upserted, never deleted: deleting one cascades away every
 * clocked session against it, and the frontend only ever hides tiles. So a
 * browser holding a stale contract list can't destroy anyone's time.
 * `imageId` (a picture in the library) is only overwritten when the key is
 * present. A new contract goes to
 * the end of the shared creation order. A tile made from Contract
 * information keeps the details syncContractTiles gave it; only its image
 * is taken from here.
 */
async function upsertContract(db, c) {
  const params = [c.id, c.customerName || '', c.number || '', c.suffix || '', c.suffixDescription || '', c.machineType || ''];
  const hasImage = Object.prototype.hasOwnProperty.call(c, 'imageId');
  if (hasImage) params.push(c.imageId || null);
  await db.query(
    `INSERT INTO contracts (id, customer_name, number, suffix, suffix_description, machine_type, sort_order${hasImage ? ', image_id' : ''})
     VALUES ($1,$2,$3,$4,$5,$6,(SELECT COALESCE(MAX(sort_order) + 1, 0) FROM contracts)${hasImage ? ',$7' : ''})
     ON CONFLICT (id) DO UPDATE SET
       customer_name = CASE WHEN contracts.contract_info_suffix_id IS NULL THEN EXCLUDED.customer_name ELSE contracts.customer_name END,
       number = CASE WHEN contracts.contract_info_suffix_id IS NULL THEN EXCLUDED.number ELSE contracts.number END,
       suffix = CASE WHEN contracts.contract_info_suffix_id IS NULL THEN EXCLUDED.suffix ELSE contracts.suffix END,
       suffix_description = CASE WHEN contracts.contract_info_suffix_id IS NULL THEN EXCLUDED.suffix_description ELSE contracts.suffix_description END,
       machine_type = CASE WHEN contracts.contract_info_suffix_id IS NULL THEN EXCLUDED.machine_type ELSE contracts.machine_type END${hasImage ? ', image_id = EXCLUDED.image_id' : ''}
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

/* Cost centres are keyed by name, and users.cost_centre holds that name as
 * text (no foreign key). So a rename changes both in one transaction, and a
 * cost centre anyone still has is never deleted. */
async function listCostCentres(db) {
  return (await db.query('SELECT name FROM cost_centres ORDER BY lower(name), name')).rows.map((r) => r.name);
}

async function costCentreUsage(db, names) {
  const { rows } = await db.query('SELECT cost_centre AS name, COUNT(*)::int AS people FROM users WHERE cost_centre = ANY($1) GROUP BY cost_centre', [names]);
  return rows;
}

async function renameCostCentre(db, from, to) {
  await db.query('UPDATE cost_centres SET name = $2 WHERE name = $1', [from, to]);
  const { rowCount } = await db.query('UPDATE users SET cost_centre = $2 WHERE cost_centre = $1', [from, to]);
  return rowCount;
}

async function deleteCostCentre(db, name) {
  await db.query('DELETE FROM cost_centres WHERE name = $1', [name]);
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

async function setAutoClockOutDelay(db, minutes) {
  await db.query('UPDATE default_working_times SET auto_clock_out_delay = $1 WHERE id = 1', [minutes]);
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

/* Tiles follow Contract information (see migration 013): each suffix row
 * with a letter, on a contract with a number, has one tile showing its
 * contract's customer, number and machine type and its own letter and
 * description. A new tile is on no one's dashboard until they add it from
 * + Add tile. When a suffix row (or its contract) is removed, its tile is
 * deleted, or retired if time was clocked on it -- the time is kept. A tile
 * whose clock is running or paused for a break can't go: that is refused,
 * so the whole save is undone. Runs after every Contract information save,
 * and at start-up for suffixes that existed before tiles were linked.
 */
async function syncContractTiles(db) {
  const live = `FROM contract_info_suffixes s JOIN contract_info i ON i.id = s.contract_info_id`;
  await db.query(
    `UPDATE contracts c SET customer_name = i.customer_name, number = i.number, suffix = s.letter,
       suffix_description = s.description, machine_type = i.machine_type, retired = false
     ${live} WHERE c.contract_info_suffix_id = s.id`
  );
  await db.query(
    `INSERT INTO contracts (id, customer_name, number, suffix, suffix_description, machine_type, contract_info_suffix_id, sort_order)
     SELECT 'tile-' || s.id, i.customer_name, i.number, s.letter, s.description, i.machine_type, s.id,
       (SELECT COALESCE(MAX(sort_order), -1) FROM contracts) + row_number() OVER (ORDER BY i.sort_order, s.sort_order)
     ${live}
     WHERE trim(i.number) <> '' AND trim(s.letter) <> ''
       AND NOT EXISTS (SELECT 1 FROM contracts c WHERE c.contract_info_suffix_id = s.id)
     ON CONFLICT (id) DO NOTHING`
  );
  const gone = (await db.query(
    `SELECT c.id, c.number, c.suffix,
       EXISTS (SELECT 1 FROM active_sessions a WHERE a.contract_id = c.id)
         OR EXISTS (SELECT 1 FROM user_break_state b WHERE b.contract_id = c.id) AS clock_on,
       EXISTS (SELECT 1 FROM time_sessions t WHERE t.contract_id = c.id) AS has_time
     FROM contracts c
     WHERE c.contract_info_suffix_id IS NOT NULL AND NOT c.retired
       AND NOT EXISTS (SELECT 1 FROM contract_info_suffixes s WHERE s.id = c.contract_info_suffix_id)`
  )).rows;
  const running = gone.filter((c) => c.clock_on);
  if (running.length) {
    const names = running.map((c) => `${c.number}${c.suffix ? ` ${c.suffix}` : ''}`).join(', ');
    throw new ApiError(409, `A clock is running on ${names}. Stop it before removing ${running.length === 1 ? 'that suffix' : 'those suffixes'}.`);
  }
  const retire = gone.filter((c) => c.has_time).map((c) => c.id);
  const remove = gone.filter((c) => !c.has_time).map((c) => c.id);
  if (retire.length) await db.query('UPDATE contracts SET retired = true WHERE id = ANY($1)', [retire]);
  if (remove.length) await db.query('DELETE FROM contracts WHERE id = ANY($1)', [remove]); // no time on them, so nothing else is lost
}

module.exports = {
  getSetup, upsertContract, setTileSettings, setTileOrder, replaceNameList, replaceNonWorking,
  setAutoClockOutDelay, replaceContractInfo, syncContractTiles,
  listCostCentres, costCentreUsage, renameCostCentre, deleteCostCentre,
};
