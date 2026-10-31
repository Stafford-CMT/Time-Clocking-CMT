'use strict';

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') });

// Fails CLOSED, not open: a blank SESSION_SECRET would let express-session
// sign cookies with an empty key (session cookies become forgeable -- a
// full auth bypass, not just a broken feature), so this refuses to start
// rather than warn-and-continue. Applies to every required() value for the
// same reason -- better a clear crash at boot than a silently half-broken
// security-relevant config running in production.
function required(name) {
  const v = process.env[name];
  if (!v) {
    console.error(`FATAL: ${name} is not set in .env — refusing to start.`);
    process.exit(1);
  }
  return v;
}

module.exports = {
  nodeEnv: process.env.NODE_ENV || 'development',
  port: Number(process.env.PORT) || 4100,

  db: {
    host: process.env.DB_HOST || 'localhost',
    port: Number(process.env.DB_PORT) || 5432,
    name: process.env.DB_NAME || 'time_clocking',
    user: process.env.DB_USER || '',
    password: process.env.DB_PASSWORD || '',
    ssl: process.env.DB_SSL === 'true',
    // Only relevant when DB_SSL=true. Defaults to real certificate
    // validation (secure); DB_SSL_REJECT_UNAUTHORIZED=false is an explicit,
    // deliberate opt-out (e.g. a provider's self-signed cert), not a silent
    // default.
    sslRejectUnauthorized: process.env.DB_SSL_REJECT_UNAUTHORIZED !== 'false',
  },

  sessionSecret: required('SESSION_SECRET'),
  sessionMaxAgeMs: Number(process.env.SESSION_MAX_AGE_MS) || 7 * 24 * 60 * 60 * 1000,

  azure: {
    tenantId: required('AZURE_TENANT_ID'),
    clientId: required('AZURE_CLIENT_ID'),
    clientSecret: required('AZURE_CLIENT_SECRET'),
    redirectUri: process.env.AZURE_REDIRECT_URI || '',
    postLogoutRedirectUri: process.env.POST_LOGOUT_REDIRECT_URI || '',
  },

  // Extra server-side gate on top of Azure AD itself -- catches any guest/B2B
  // account inside the tenant that isn't on an allowed domain. Empty list
  // means "no restriction" (anyone Azure AD lets through is accepted).
  allowedEmailDomains: (process.env.ALLOWED_EMAIL_DOMAINS || '')
    .split(',')
    .map((d) => d.trim().toLowerCase())
    .filter(Boolean),
};
