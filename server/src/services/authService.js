'use strict';

const { getMsalClient, SCOPES } = require('../config/msal');
const env = require('../config/env');
const usersService = require('./usersService');
const usersRepo = require('../repositories/usersRepo');
const ApiError = require('../utils/ApiError');

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

// DEV_LOGIN_EMAIL only (env.js refuses it in production): one test account
// per role, so a developer can see the app as each. The admin one is the
// DEV_LOGIN_EMAIL account itself; the others are name+role@domain.
const DEV_ROLES = ['admin', 'manager', 'user'];

function devAccounts() {
  if (!env.devLoginEmail) return [];
  const [local, domain] = env.devLoginEmail.split('@');
  const baseName = env.devLoginName || local.split(/[._-]/).map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join(' ');
  return DEV_ROLES.map((role) => (role === 'admin'
    ? { role, email: env.devLoginEmail, name: baseName }
    : { role, email: `${local}+${role}@${domain}`, name: `${baseName} (${role.charAt(0).toUpperCase() + role.slice(1)})` }));
}

// Same find-or-create path as a real sign-in, with a made-up oid standing in
// for Azure's. The role is reset on every sign-in so each account always
// matches its label, even after testing role changes in Lists -> Users.
async function devLogin(role = 'admin') {
  const account = devAccounts().find((item) => item.role === role);
  if (!account) throw new ApiError(400, 'Unknown development account');
  const user = await usersService.findOrCreateFromAzureClaims({ oid: `dev-${account.email}`, email: account.email, name: account.name });
  if (user.userType === role) return user;
  return usersService.toPublicUser(await usersRepo.setUserType(user.id, role));
}

module.exports = { getLoginRedirectUrl, completeLogin, devAccounts, devLogin };
