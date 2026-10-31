'use strict';

const { Pool, types } = require('pg');
const env = require('./env');

// DATE columns come back as plain 'YYYY-MM-DD' strings. pg's default parses
// them to a JS Date at LOCAL midnight, and toISOString() on that gives the
// previous day on any server ahead of UTC -- every load/save round trip
// would then shift sessions and committed dates back a day.
types.setTypeParser(types.builtins.DATE, (value) => value);

let pool;
function getPool() {
  if (!pool) {
    pool = new Pool({
      host: env.db.host,
      port: env.db.port,
      database: env.db.name,
      user: env.db.user,
      password: env.db.password,
      ssl: env.db.ssl ? { rejectUnauthorized: env.db.sslRejectUnauthorized } : false,
    });
  }
  return pool;
}

module.exports = { getPool };
