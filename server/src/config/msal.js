'use strict';

const { ConfidentialClientApplication } = require('@azure/msal-node');
const env = require('./env');

const msalConfig = {
  auth: {
    clientId: env.azure.clientId,
    authority: `https://login.microsoftonline.com/${env.azure.tenantId}`,
    clientSecret: env.azure.clientSecret,
  },
};

const msalClient = new ConfidentialClientApplication(msalConfig);

// openid/profile/email give us the id token claims (oid, preferred_username,
// name) we need; no Graph API scope is requested since we don't call Graph.
const SCOPES = ['openid', 'profile', 'email'];

module.exports = { msalClient, SCOPES };
