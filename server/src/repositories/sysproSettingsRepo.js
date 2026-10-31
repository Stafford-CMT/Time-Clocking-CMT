'use strict';

/* The single syspro_settings row (Setup -> Configuration). Passwords arrive
 * here already encrypted -- see sysproService. */
const { getPool } = require('../config/db');

async function get() {
  const { rows } = await getPool().query(
    'SELECT s.*, u.name AS updated_by_name FROM syspro_settings s LEFT JOIN users u ON u.id = s.updated_by WHERE s.id = 1'
  );
  return rows[0] || null;
}

// `changes` maps column names to new values; only those columns are written.
async function save(changes, actorId) {
  const columns = Object.keys(changes);
  const sets = columns.map((column, index) => `${column} = $${index + 1}`);
  await getPool().query(
    `UPDATE syspro_settings SET ${[...sets, `updated_at = now()`, `updated_by = $${columns.length + 1}`].join(', ')} WHERE id = 1`,
    [...columns.map((column) => changes[column]), actorId]
  );
  return get();
}

module.exports = { get, save };
