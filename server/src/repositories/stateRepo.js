'use strict';

/* The ONLY module that runs raw SQL against the app-data tables (contracts,
 * active_sessions, time_sessions, non_working, machine_types,
 * suffix_descriptions, customers, cost_centres, default_working_times(+breaks),
 * contract_info(+suffixes), committed_dates, app_settings, working_times
 * (+breaks), break_state). Mirrors the shape of the browser prototype's
 * single localStorage `state` object one field at a time.
 *
 * Deliberately NOT included here: `users`. Identity now comes from Azure AD
 * sign-in (see authService/usersRepo), not from typing a new row into this
 * blob, so getFullState() reads the users table read-only for the frontend's
 * convenience but replaceFullState() never writes it -- user creation/role
 * changes go through their own endpoints (POST /auth/callback, PUT
 * /api/users/:id) instead.
 */
const { getPool } = require('../config/db');
const usersRepo = require('./usersRepo');

function timeToHm(value) {
  // pg returns TIME columns as 'HH:MM:SS' -- the frontend's schedule fields
  // (start/end on contracts info etc.) only ever used HH:MM.
  return value ? value.slice(0, 5) : value;
}

async function getFullState() {
  const pool = getPool();

  const activeSessionsRows = (await pool.query('SELECT user_id, contract_id, started_at FROM active_sessions')).rows;
  const activeByContract = {};
  activeSessionsRows.forEach((r) => {
    activeByContract[r.contract_id] = activeByContract[r.contract_id] || {};
    activeByContract[r.contract_id][r.user_id] = new Date(r.started_at).getTime();
  });

  const contracts = (await pool.query('SELECT * FROM contracts ORDER BY sort_order')).rows.map((c) => ({
    id: c.id,
    customerName: c.customer_name,
    number: c.number,
    suffix: c.suffix,
    suffixDescription: c.suffix_description,
    machineType: c.machine_type,
    image: c.image,
    activeSessions: activeByContract[c.id] || {},
    pinned: c.pinned,
    hidden: c.hidden,
  }));
  const order = contracts.map((c) => c.id);

  const nonWorking = (await pool.query('SELECT id, date, category, start_time, end_time FROM non_working ORDER BY date')).rows
    .map((r) => ({ id: r.id, date: r.date, category: r.category, start: timeToHm(r.start_time), end: timeToHm(r.end_time) }));

  const machineTypes = (await pool.query('SELECT name FROM machine_types ORDER BY sort_order')).rows.map((r) => r.name);
  const suffixDescriptions = (await pool.query('SELECT name FROM suffix_descriptions ORDER BY sort_order')).rows.map((r) => r.name);
  const customers = (await pool.query('SELECT name FROM customers ORDER BY sort_order')).rows.map((r) => r.name);
  const costCentres = (await pool.query('SELECT name FROM cost_centres ORDER BY sort_order')).rows.map((r) => r.name);

  const defaultRow = (await pool.query('SELECT start, "end" FROM default_working_times WHERE id = 1')).rows[0];
  const defaultBreaks = (await pool.query('SELECT start, "end" FROM default_working_time_breaks ORDER BY sort_order')).rows;
  const defaultWorkingTimes = {
    start: timeToHm(defaultRow.start),
    end: timeToHm(defaultRow.end),
    breaks: defaultBreaks.map((b) => ({ start: timeToHm(b.start), end: timeToHm(b.end) })),
  };

  const infoSuffixRows = (await pool.query('SELECT * FROM contract_info_suffixes ORDER BY sort_order')).rows;
  const suffixesByInfo = {};
  infoSuffixRows.forEach((s) => {
    suffixesByInfo[s.contract_info_id] = suffixesByInfo[s.contract_info_id] || [];
    suffixesByInfo[s.contract_info_id].push({ id: s.id, letter: s.letter, description: s.description });
  });
  const contractInfo = (await pool.query('SELECT * FROM contract_info ORDER BY sort_order')).rows.map((r) => ({
    id: r.id,
    number: r.number,
    machineType: r.machine_type,
    customerName: r.customer_name,
    oneDriveLink: r.one_drive_link,
    orderConfirmationLink: r.order_confirmation_link,
    expanded: r.expanded,
    suffixes: suffixesByInfo[r.id] || [],
  }));

  const committedDates = (await pool.query('SELECT date FROM committed_dates ORDER BY date')).rows.map((r) => r.date);

  const adminMode = (await pool.query('SELECT admin_mode FROM app_settings WHERE id = 1')).rows[0].admin_mode;

  const wtBreakRows = (await pool.query('SELECT * FROM working_time_breaks ORDER BY sort_order')).rows;
  const breaksByWt = {};
  wtBreakRows.forEach((b) => {
    breaksByWt[b.working_time_id] = breaksByWt[b.working_time_id] || [];
    breaksByWt[b.working_time_id].push({ id: b.id, type: b.type, start: timeToHm(b.start), end: timeToHm(b.end) });
  });
  const workingTimes = (await pool.query('SELECT * FROM working_times')).rows.map((wt) => ({
    id: wt.id,
    userId: wt.user_id,
    start: timeToHm(wt.start),
    end: timeToHm(wt.end),
    breaks: breaksByWt[wt.id] || [],
  }));

  const breakStateRow = (await pool.query('SELECT contract_id, user_id FROM break_state WHERE id = 1')).rows[0];
  const breakState = breakStateRow && breakStateRow.contract_id
    ? { contractId: breakStateRow.contract_id, userId: breakStateRow.user_id }
    : null;

  const sessionRows = (await pool.query('SELECT * FROM time_sessions ORDER BY contract_id, date, start_time')).rows;
  const editSessions = {};
  sessionRows.forEach((s) => {
    editSessions[s.contract_id] = editSessions[s.contract_id] || [];
    editSessions[s.contract_id].push({
      id: s.id,
      userId: s.user_id,
      date: s.date,
      start: s.start_time.length === 8 ? s.start_time : `${s.start_time}:00`,
      end: s.end_time.length === 8 ? s.end_time : `${s.end_time}:00`,
      unlinked: s.unlinked,
    });
  });

  const users = (await usersRepo.listAll()).map((u) => ({
    id: u.id,
    name: u.name,
    email: u.email || '',
    userType: u.user_type,
    costCentre: u.cost_centre || '',
  }));

  return {
    contracts, order, nonWorking, machineTypes, suffixDescriptions, customers, costCentres,
    defaultWorkingTimes, contractInfo, committedDates, adminMode, workingTimes, breakState,
    editSessions, users,
  };
}

/* Full-replace transaction -- matches the prototype's own save behaviour
 * exactly (the frontend only calls saveState() at discrete edit points, not
 * per animation frame, so a delete-and-reinsert per table is simple and
 * cheap enough at this data volume). `users` is deliberately ignored -- see
 * this file's header comment.
 */
async function replaceFullState(state) {
  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Deleting contracts cascades away active_sessions and time_sessions;
    // deleting contract_info cascades away contract_info_suffixes; deleting
    // working_times cascades away working_time_breaks.
    await client.query('DELETE FROM contracts');
    await client.query('DELETE FROM non_working');
    await client.query('DELETE FROM machine_types');
    await client.query('DELETE FROM suffix_descriptions');
    await client.query('DELETE FROM customers');
    await client.query('DELETE FROM cost_centres');
    await client.query('DELETE FROM contract_info');
    await client.query('DELETE FROM committed_dates');
    await client.query('DELETE FROM working_times');

    const order = Array.isArray(state.order) && state.order.length ? state.order : (state.contracts || []).map((c) => c.id);
    const contractsById = new Map((state.contracts || []).map((c) => [c.id, c]));
    for (let i = 0; i < order.length; i += 1) {
      const c = contractsById.get(order[i]);
      if (!c) continue;
      await client.query(
        `INSERT INTO contracts (id, customer_name, number, suffix, suffix_description, machine_type, image, pinned, hidden, sort_order)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [c.id, c.customerName || '', c.number || '', c.suffix || '', c.suffixDescription || '', c.machineType || '', c.image || null, !!c.pinned, !!c.hidden, i]
      );
      for (const [userId, startedAt] of Object.entries(c.activeSessions || {})) {
        await client.query(
          `INSERT INTO active_sessions (user_id, contract_id, started_at) VALUES ($1,$2,$3)
           ON CONFLICT (user_id) DO UPDATE SET contract_id = EXCLUDED.contract_id, started_at = EXCLUDED.started_at`,
          [userId, c.id, new Date(startedAt)]
        );
      }
    }

    for (const [contractId, sessions] of Object.entries(state.editSessions || {})) {
      if (!contractsById.has(contractId)) continue;
      for (const s of sessions) {
        await client.query(
          `INSERT INTO time_sessions (id, contract_id, user_id, date, start_time, end_time, unlinked)
           VALUES ($1,$2,$3,$4,$5,$6,$7)`,
          [s.id, contractId, s.userId, s.date, s.start, s.end, !!s.unlinked]
        );
      }
    }

    for (const entry of state.nonWorking || []) {
      await client.query(
        `INSERT INTO non_working (id, date, category, start_time, end_time) VALUES ($1,$2,$3,$4,$5)`,
        [entry.id, entry.date, entry.category || '', entry.start, entry.end]
      );
    }

    const nameLists = [
      ['machine_types', state.machineTypes],
      ['suffix_descriptions', state.suffixDescriptions],
      ['customers', state.customers],
      ['cost_centres', state.costCentres],
    ];
    for (const [table, names] of nameLists) {
      let i = 0;
      for (const name of names || []) {
        await client.query(`INSERT INTO ${table} (name, sort_order) VALUES ($1,$2) ON CONFLICT (name) DO NOTHING`, [name, i]);
        i += 1;
      }
    }

    if (state.defaultWorkingTimes) {
      await client.query('UPDATE default_working_times SET start = $1, "end" = $2 WHERE id = 1', [state.defaultWorkingTimes.start, state.defaultWorkingTimes.end]);
      await client.query('DELETE FROM default_working_time_breaks');
      let breakIdx = 0;
      for (const b of state.defaultWorkingTimes.breaks || []) {
        await client.query('INSERT INTO default_working_time_breaks (sort_order, start, "end") VALUES ($1,$2,$3)', [breakIdx, b.start, b.end]);
        breakIdx += 1;
      }
    }

    let infoIndex = 0;
    for (const record of state.contractInfo || []) {
      await client.query(
        `INSERT INTO contract_info (id, number, machine_type, customer_name, one_drive_link, order_confirmation_link, expanded, sort_order)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [record.id, record.number || '', record.machineType || '', record.customerName || '', record.oneDriveLink || '', record.orderConfirmationLink || '', !!record.expanded, infoIndex]
      );
      infoIndex += 1;
      let suffixIndex = 0;
      for (const suffix of record.suffixes || []) {
        await client.query(
          `INSERT INTO contract_info_suffixes (id, contract_info_id, letter, description, sort_order) VALUES ($1,$2,$3,$4,$5)`,
          [suffix.id, record.id, suffix.letter || '', suffix.description || '', suffixIndex]
        );
        suffixIndex += 1;
      }
    }

    for (const date of state.committedDates || []) {
      await client.query('INSERT INTO committed_dates (date) VALUES ($1) ON CONFLICT DO NOTHING', [date]);
    }

    await client.query('UPDATE app_settings SET admin_mode = $1 WHERE id = 1', [!!state.adminMode]);

    for (const entry of state.workingTimes || []) {
      const user = await usersRepo.findById(entry.userId);
      if (!user) continue; // working-time rows only make sense for a real, signed-in user
      await client.query(
        `INSERT INTO working_times (id, user_id, start, "end") VALUES ($1,$2,$3,$4)`,
        [entry.id, entry.userId, entry.start, entry.end]
      );
      let breakIndex = 0;
      for (const brk of entry.breaks || []) {
        await client.query(
          `INSERT INTO working_time_breaks (id, working_time_id, type, start, "end", sort_order) VALUES ($1,$2,$3,$4,$5,$6)`,
          [brk.id, entry.id, brk.type || 'Break', brk.start, brk.end, breakIndex]
        );
        breakIndex += 1;
      }
    }

    if (state.breakState && state.breakState.contractId) {
      await client.query('UPDATE break_state SET contract_id = $1, user_id = $2 WHERE id = 1', [state.breakState.contractId, state.breakState.userId]);
    } else {
      await client.query('UPDATE break_state SET contract_id = NULL, user_id = NULL WHERE id = 1');
    }

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { getFullState, replaceFullState };
