'use strict';

const { Pool } = require('pg');
const env = require('./env');

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
