'use strict';

const { getPool } = require('../config/db');
const { uid } = require('../utils/ids');

async function findByOid(oid) {
  const { rows } = await getPool().query('SELECT * FROM users WHERE microsoft_oid = $1', [oid]);
  return rows[0] || null;
}

async function findByEmail(email) {
  const { rows } = await getPool().query('SELECT * FROM users WHERE lower(email) = lower($1)', [email]);
  return rows[0] || null;
}

async function setOid(id, oid) {
  const { rows } = await getPool().query('UPDATE users SET microsoft_oid = $2 WHERE id = $1 RETURNING *', [id, oid]);
  return rows[0];
}

async function findById(id) {
  const { rows } = await getPool().query('SELECT * FROM users WHERE id = $1', [id]);
  return rows[0] || null;
}

async function create({ microsoftOid, email, name, userType, included = false }) {
  const { rows } = await getPool().query(
    `INSERT INTO users (id, microsoft_oid, email, name, user_type, included, last_login_at)
     VALUES ($1, $2, $3, $4, $5, $6, now())
     RETURNING *`,
    [uid('user'), microsoftOid, email || null, name || '', userType || 'user', included]
  );
  return rows[0];
}

// Called on every sign-in: keeps name/email in step with Microsoft 365
// (a blank value from Azure leaves the stored one alone).
async function recordSignIn(id, { email, name }) {
  const { rows } = await getPool().query(
    `UPDATE users SET last_login_at = now(),
       email = COALESCE($2, email),
       name = COALESCE($3, name)
     WHERE id = $1
     RETURNING *`,
    [id, email || null, name || null]
  );
  return rows[0];
}

// Only the people ticked into Time Slide -- everything outside Lists -> Users.
async function listAll() {
  const { rows } = await getPool().query(
    'SELECT id, email, name, user_type, cost_centre, is_active, created_at, last_login_at FROM users WHERE included ORDER BY created_at'
  );
  return rows;
}

// Everyone, ticked or not, for the admin's Lists -> Users.
async function listDirectory() {
  const { rows } = await getPool().query('SELECT * FROM users ORDER BY lower(name)');
  return rows;
}

async function setIncluded(id, included) {
  const { rows } = await getPool().query('UPDATE users SET included = $2 WHERE id = $1 RETURNING *', [id, included]);
  return rows[0] || null;
}

// One person from Entra ID: refresh their row (Microsoft's name wins) or add
// them unticked. syncStartedAt marks them as still in the directory.
async function saveDirectoryPerson(person, syncStartedAt) {
  const values = [person.oid, person.email || null, person.name || null, person.jobTitle || null, person.department || null, person.officeLocation || null, person.accountEnabled !== false, syncStartedAt];
  const { rows } = await getPool().query(
    `UPDATE users SET email = COALESCE($2, email), name = COALESCE($3, name), job_title = $4, department = $5,
       office_location = $6, account_enabled = $7, in_directory = true, synced_at = $8
     WHERE microsoft_oid = $1
     RETURNING *`,
    values
  );
  if (rows[0]) return rows[0];
  const inserted = await getPool().query(
    `INSERT INTO users (id, microsoft_oid, email, name, job_title, department, office_location, account_enabled, in_directory, synced_at)
     VALUES ($9, $1, $2, COALESCE($3, ''), $4, $5, $6, $7, true, $8)
     RETURNING *`,
    [...values, uid('user')]
  );
  return inserted.rows[0];
}

// Anyone the sync that started at syncStartedAt didn't see has left Entra ID.
async function markMissingFromDirectory(syncStartedAt) {
  await getPool().query('UPDATE users SET in_directory = false WHERE in_directory AND (synced_at IS NULL OR synced_at < $1)', [syncStartedAt]);
}

async function deleteSampleStaff() {
  await getPool().query("DELETE FROM users WHERE microsoft_oid LIKE 'sample-%'");
}

async function setUserType(id, userType) {
  const { rows } = await getPool().query('UPDATE users SET user_type = $1 WHERE id = $2 RETURNING *', [userType, id]);
  return rows[0] || null;
}

async function setCostCentre(id, costCentre) {
  const { rows } = await getPool().query('UPDATE users SET cost_centre = $1 WHERE id = $2 RETURNING *', [costCentre || null, id]);
  return rows[0] || null;
}

async function countActiveAdmins() {
  const { rows } = await getPool().query(
    "SELECT COUNT(*)::int AS n FROM users WHERE user_type = 'admin' AND is_active = true AND included"
  );
  return rows[0].n;
}

module.exports = {
  findByOid, findByEmail, setOid, findById, create, recordSignIn, listAll, listDirectory, setIncluded,
  saveDirectoryPerson, markMissingFromDirectory, deleteSampleStaff, setUserType, setCostCentre, countActiveAdmins,
};
