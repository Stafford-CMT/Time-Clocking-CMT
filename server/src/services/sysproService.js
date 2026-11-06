'use strict';

const net = require('net');

/* Setup -> Configuration: the details Time Slide needs to reach Syspro.
 *  - e.net Solutions (Syspro's web services) for posting into Syspro.
 *  - The Syspro SQL Server database for read-only lookups.
 * Admin only (see api.routes.js). Passwords are encrypted before they reach
 * the database and never leave the server: the browser only learns whether
 * each one is set.
 */
const sysproSettingsRepo = require('../repositories/sysproSettingsRepo');
const { encrypt, decrypt } = require('../utils/secrets');
const ApiError = require('../utils/ApiError');

const TEXT_FIELDS = {
  enetUrl: 'enet_url',
  enetOperator: 'enet_operator',
  enetCompanyId: 'enet_company_id',
  sqlServer: 'sql_server',
  sqlDatabase: 'sql_database',
  sqlUser: 'sql_user',
};
const PASSWORD_FIELDS = {
  enetOperatorPassword: 'enet_operator_password',
  enetCompanyPassword: 'enet_company_password',
  sqlPassword: 'sql_password',
};
const FLAG_FIELDS = {
  sqlEncrypt: 'sql_encrypt',
  sqlTrustServerCertificate: 'sql_trust_server_certificate',
};

function toPublic(row) {
  const settings = { sqlPort: row.sql_port };
  for (const [field, column] of Object.entries(TEXT_FIELDS)) settings[field] = row[column];
  for (const [field, column] of Object.entries(FLAG_FIELDS)) settings[field] = row[column];
  for (const [field, column] of Object.entries(PASSWORD_FIELDS)) settings[`${field}Set`] = Boolean(row[column]);
  settings.updatedAt = row.updated_at;
  settings.updatedBy = row.updated_by_name || null;
  return settings;
}

async function getSettings() {
  return toPublic(await sysproSettingsRepo.get());
}

// Fields left out of `body` are kept. A password is replaced by a non-empty
// string and removed by null; an empty string keeps the saved one, so the
// form can leave password boxes blank.
async function saveSettings(body, actorId) {
  if (!body || typeof body !== 'object') throw new ApiError(400, 'Settings are missing');
  const changes = {};
  for (const [field, column] of Object.entries(TEXT_FIELDS)) {
    if (body[field] === undefined) continue;
    if (typeof body[field] !== 'string' || body[field].length > 500) throw new ApiError(400, `${field} must be text`);
    changes[column] = body[field].trim();
  }
  if (changes.enet_url) {
    let url;
    try { url = new URL(changes.enet_url); } catch { url = null; }
    // http(s):// is e.net's REST address; net.tcp:// its WCF address (only checked for an answer: see testEnet).
    if (!url || !['http:', 'https:', 'net.tcp:'].includes(url.protocol)) throw new ApiError(400, 'The e.net address must start with http://, https:// or net.tcp://');
    changes.enet_url = changes.enet_url.replace(/\/+$/, '');
  }
  if (body.sqlPort !== undefined) {
    const port = Number(body.sqlPort);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new ApiError(400, 'The SQL port must be a number from 1 to 65535');
    changes.sql_port = port;
  }
  for (const [field, column] of Object.entries(FLAG_FIELDS)) {
    if (body[field] === undefined) continue;
    if (typeof body[field] !== 'boolean') throw new ApiError(400, `${field} must be true or false`);
    changes[column] = body[field];
  }
  for (const [field, column] of Object.entries(PASSWORD_FIELDS)) {
    const value = body[field];
    if (value === undefined || value === '') continue;
    if (value === null) { changes[column] = null; continue; }
    if (typeof value !== 'string' || value.length > 500) throw new ApiError(400, `${field} must be text`);
    changes[column] = encrypt(value);
  }
  if (!Object.keys(changes).length) return getSettings();
  return toPublic(await sysproSettingsRepo.save(changes, actorId));
}

// Logs on to e.net with the saved details and straight off again. Syspro's
// REST Logon answers with a session id on success and with message text
// (still HTTP 200) when the details are wrong.
/* A net.tcp:// address is e.net's WCF (.NET binary) endpoint, which Node can't
 * speak: the test only checks something answers on that host and port, and says
 * that logging on and posting need e.net's REST (http) address. */
function reachNetTcp(address, timeoutMs) {
  const url = new URL(address); const host = url.hostname; const port = Number(url.port) || 808; // 808: the net.tcp default
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    const done = (result) => { socket.destroy(); resolve(result); };
    socket.setTimeout(timeoutMs, () => done({ ok: false, message: `No answer from ${host}:${port} within ${timeoutMs / 1000} seconds.` }));
    socket.once('connect', () => done({ ok: true, message: `The Syspro e.net service is answering at ${host}:${port} (net.tcp). Time Slide can't log on over net.tcp, though: to read from Syspro or post times it needs e.net's REST address (http://…/SYSPROWCFService/Rest) from your Syspro administrator.` }));
    socket.once('error', (err) => done({ ok: false, message: `Could not reach ${host}:${port} (${err.code || err.message}).` }));
  });
}

async function testEnet({ fetchImpl = fetch, timeoutMs = 10000 } = {}) {
  const row = await sysproSettingsRepo.get();
  if (row.enet_url && row.enet_url.startsWith('net.tcp:')) return reachNetTcp(row.enet_url, timeoutMs);
  const missing = [];
  if (!row.enet_url) missing.push('e.net address');
  if (!row.enet_operator) missing.push('operator');
  if (!row.enet_company_id) missing.push('company ID');
  if (missing.length) return { ok: false, message: `Fill in the ${missing.join(', ')} and save first.` };

  const params = new URLSearchParams({
    Operator: row.enet_operator,
    OperatorPassword: row.enet_operator_password ? decrypt(row.enet_operator_password) : '',
    CompanyId: row.enet_company_id,
    CompanyPassword: row.enet_company_password ? decrypt(row.enet_company_password) : '',
  });
  let response;
  let text;
  try {
    response = await fetchImpl(`${row.enet_url}/Logon?${params}`, { signal: AbortSignal.timeout(timeoutMs) });
    text = (await response.text()).trim().replace(/^"|"$/g, '').trim();
  } catch (err) {
    const reason = err.name === 'TimeoutError' ? `no answer within ${timeoutMs / 1000} seconds` : err.cause?.code || err.message;
    return { ok: false, message: `Could not reach ${row.enet_url} (${reason}).` };
  }
  if (!response.ok) return { ok: false, message: `Syspro answered with HTTP ${response.status}. Check the e.net address.` };
  if (!/^[0-9A-Fa-f-]{20,}$/.test(text)) return { ok: false, message: `Syspro refused the logon: ${text.slice(0, 300) || 'no reason given'}` };
  try {
    await fetchImpl(`${row.enet_url}/Logoff?${new URLSearchParams({ UserId: text })}`, { signal: AbortSignal.timeout(timeoutMs) });
  } catch { /* the logon worked; Syspro times idle sessions out anyway */ }
  return { ok: true, message: 'Logged on to Syspro and off again.' };
}

module.exports = { getSettings, saveSettings, testEnet };
