'use strict';

const { getMsalClient, SCOPES } = require('../config/msal');
const env = require('../config/env');
const usersService = require('./usersService');

async function getLoginRedirectUrl() {
  return getMsalClient().getAuthCodeUrl({
    scopes: SCOPES,
    redirectUri: env.azure.redirectUri,
  });
}

// Exchanges the authorization code for tokens, reads the ID token claims,
// and finds-or-creates the matching users row. Returns the same shape
// req.session.user is set to.
async function completeLogin(code) {
  const result = await getMsalClient().acquireTokenByCode({
    code,
    scopes: SCOPES,
    redirectUri: env.azure.redirectUri,
  });
  const claims = result.idTokenClaims || {};
  return usersService.findOrCreateFromAzureClaims({
    oid: claims.oid,
    email: claims.preferred_username || claims.email || null,
    name: claims.name || null,
  });
}

// DEV_LOGIN_EMAIL only (env.js refuses it in production): same find-or-create
// path as a real sign-in, with a made-up oid standing in for Azure's.
async function devLogin() {
  const email = env.devLoginEmail;
  const name = email.split('@')[0].split(/[._-]/).map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join(' ');
  return usersService.findOrCreateFromAzureClaims({ oid: `dev-${email}`, email, name });
}

module.exports = { getLoginRedirectUrl, completeLogin, devLogin };
