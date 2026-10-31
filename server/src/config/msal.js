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
// name) we need. The staff sync (directoryService) reads Graph with the app's
// own permission instead, so sign-in never asks for more than this.
const SCOPES = ['openid', 'profile', 'email'];

module.exports = { getMsalClient, SCOPES };
