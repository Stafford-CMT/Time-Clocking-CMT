'use strict';

/* Email from Time Slide (commit reminders), sent through Microsoft Graph as
 * the MAIL_FROM mailbox. Needs the app registration's Microsoft Graph
 * application permission Mail.Send with admin consent -- IT can limit it to
 * that one mailbox with an application access policy.
 */
const { getMsalClient } = require('../config/msal');
const env = require('../config/env');
const ApiError = require('../utils/ApiError');

function assertConfigured() {
  if (!env.mailFrom) throw new ApiError(503, 'Email is not set up yet: MAIL_FROM (the mailbox Time Slide sends from) is missing from the server settings');
  if (!env.azure.clientId || !env.azure.clientSecret) throw new ApiError(503, 'Email needs the Azure app registration settings (AZURE_*) on the server');
}

async function sendMail({ to, subject, html }) {
  assertConfigured();
  const { accessToken } = await getMsalClient().acquireTokenByClientCredential({ scopes: ['https://graph.microsoft.com/.default'] });
  const response = await fetch(`https://graph.microsoft.com/v1.0/users/${encodeURIComponent(env.mailFrom)}/sendMail`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      message: { subject, body: { contentType: 'HTML', content: html }, toRecipients: [{ emailAddress: { address: to } }] },
      saveToSentItems: true,
    }),
  });
  if (response.status === 401 || response.status === 403) {
    throw new ApiError(503, 'Microsoft refused to send email: admin consent for Mail.Send has not been granted yet');
  }
  if (!response.ok) throw new Error(`Microsoft Graph returned ${response.status}`);
}

module.exports = { assertConfigured, sendMail };
