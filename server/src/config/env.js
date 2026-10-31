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

const nodeEnv = process.env.NODE_ENV || 'development';

// Local-development sign-in shortcut: when set, /auth/login signs you
// straight in as this email instead of going to Microsoft, so the app can
// run on a dev machine with no Azure app registration. Never allowed in
// production -- that would let anyone reaching the server in without a
// password, so this refuses to start rather than ignore it.
const devLoginEmail = (process.env.DEV_LOGIN_EMAIL || '').trim().toLowerCase();
if (devLoginEmail && nodeEnv === 'production') {
  console.error('FATAL: DEV_LOGIN_EMAIL must not be set when NODE_ENV=production — refusing to start.');
  process.exit(1);
}
// Development only: fill the staff list with made-up people instead of
// reading Entra ID (e.g. before admin consent for User.Read.All is granted).
const directorySample = process.env.DIRECTORY_SAMPLE === 'true';
if (directorySample && nodeEnv === 'production') {
  console.error('FATAL: DIRECTORY_SAMPLE must not be set when NODE_ENV=production — refusing to start.');
  process.exit(1);
}
const azureSetting = (name) => (devLoginEmail ? process.env[name] || '' : required(name));

module.exports = {
  nodeEnv,
  devLoginEmail,
  devLoginName: (process.env.DEV_LOGIN_NAME || '').trim(),
  directorySample,
  directorySyncMinutes: Number(process.env.DIRECTORY_SYNC_MINUTES) || 30,
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
    tenantId: azureSetting('AZURE_TENANT_ID'),
    clientId: azureSetting('AZURE_CLIENT_ID'),
    clientSecret: azureSetting('AZURE_CLIENT_SECRET'),
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
