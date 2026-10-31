'use strict';

const { getPool } = require('../config/db');
const { uid } = require('../utils/ids');

async function findByOid(oid) {
  const { rows } = await getPool().query('SELECT * FROM users WHERE microsoft_oid = $1', [oid]);
  return rows[0] || null;
}

async function findById(id) {
  const { rows } = await getPool().query('SELECT * FROM users WHERE id = $1', [id]);
  return rows[0] || null;
}

async function create({ microsoftOid, email, name, userType }) {
  const { rows } = await getPool().query(
    `INSERT INTO users (id, microsoft_oid, email, name, user_type, last_login_at)
     VALUES ($1, $2, $3, $4, $5, now())
     RETURNING *`,
    [uid('user'), microsoftOid, email || null, name || '', userType || 'user']
  );
  return rows[0];
}

async function touchLastLogin(id) {
  await getPool().query('UPDATE users SET last_login_at = now() WHERE id = $1', [id]);
}

async function listAll() {
  const { rows } = await getPool().query(
    'SELECT id, email, name, user_type, cost_centre, is_active, created_at, last_login_at FROM users ORDER BY created_at'
  );
  return rows;
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
    "SELECT COUNT(*)::int AS n FROM users WHERE user_type = 'admin' AND is_active = true"
  );
  return rows[0].n;
}

module.exports = { findByOid, findById, create, touchLastLogin, listAll, setUserType, setCostCentre, countActiveAdmins };
