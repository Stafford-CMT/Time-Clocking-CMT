'use strict';

const session = require('express-session');
const pgSession = require('connect-pg-simple')(session);
const env = require('./env');
const { getPool } = require('./db');

// Postgres-backed (not express-session's default in-memory store) --
// MemoryStore silently logs everyone out on every PM2 restart/redeploy
// (routine on this shared server) and isn't meant for long-running
// production use anyway. createTableIfMissing means no separate migration
// needed for the session table itself.
module.exports = session({
  store: new pgSession({ pool: getPool(), tableName: 'user_sessions', createTableIfMissing: true }),
  secret: env.sessionSecret,
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    secure: env.nodeEnv === 'production', // requires real HTTPS in front (Caddy) — see Caddyfile
    sameSite: 'lax',
    maxAge: env.sessionMaxAgeMs,
  },
});
