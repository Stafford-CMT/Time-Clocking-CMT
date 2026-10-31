'use strict';

const { msalClient, SCOPES } = require('../config/msal');
const env = require('../config/env');
const usersService = require('./usersService');

async function getLoginRedirectUrl() {
  return msalClient.getAuthCodeUrl({
    scopes: SCOPES,
    redirectUri: env.azure.redirectUri,
  });
}

// Exchanges the authorization code for tokens, reads the ID token claims,
// and finds-or-creates the matching users row. Returns the same shape
// req.session.user is set to.
async function completeLogin(code) {
  const result = await msalClient.acquireTokenByCode({
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

module.exports = { getLoginRedirectUrl, completeLogin };
