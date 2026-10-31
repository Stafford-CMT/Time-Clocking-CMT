'use strict';

const { ConfidentialClientApplication } = require('@azure/msal-node');
const env = require('./env');

// Created on first use rather than at require time, so a dev machine using
// DEV_LOGIN_EMAIL (no Azure settings at all) never constructs it.
let msalClient;
function getMsalClient() {
  if (!msalClient) {
    msalClient = new ConfidentialClientApplication({
      auth: {
        clientId: env.azure.clientId,
        authority: `https://login.microsoftonline.com/${env.azure.tenantId}`,
        clientSecret: env.azure.clientSecret,
      },
    });
  }
  return msalClient;
}

// openid/profile/email give us the id token claims (oid, preferred_username,
// name) we need; no Graph API scope is requested since we don't call Graph.
const SCOPES = ['openid', 'profile', 'email'];

module.exports = { getMsalClient, SCOPES };
