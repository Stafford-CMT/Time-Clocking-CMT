'use strict';

const usersRepo = require('../repositories/usersRepo');
const ApiError = require('../utils/ApiError');
const env = require('../config/env');

function toPublicUser(row) {
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    userType: row.user_type,
    costCentre: row.cost_centre || '',
    isActive: row.is_active,
  };
}

// Every first-time Microsoft sign-in lands here. New accounts are always
// created as 'user' -- nobody is ever auto-admin/auto-manager. The very
// first admin is set once via db/scripts/promote-admin.js (direct DB
// access); after that, an existing admin can promote/demote anyone via
// setUserType below.
async function findOrCreateFromAzureClaims({ oid, email, name }) {
  if (!oid) throw new ApiError(400, 'Azure AD did not return an object id (oid) claim');
  if (env.allowedEmailDomains.length) {
    const domain = String(email || '').split('@')[1]?.toLowerCase();
    if (!domain || !env.allowedEmailDomains.includes(domain)) {
      throw new ApiError(403, 'Sign-in is not permitted for this email domain');
    }
  }
  let user = await usersRepo.findByOid(oid);
  if (!user) {
    user = await usersRepo.create({ microsoftOid: oid, email, name, userType: 'user' });
  } else {
    await usersRepo.touchLastLogin(user.id);
  }
  if (!user.is_active) throw new ApiError(403, 'This account has been deactivated');
  return toPublicUser(user);
}

async function listUsers() {
  return (await usersRepo.listAll()).map(toPublicUser);
}

// actorId is whoever is MAKING this change (the logged-in admin), never
// client-supplied -- used only to block self-service role changes, which
// the frontend already disables but a direct API call could otherwise
// bypass entirely.
async function setUserType(id, userType, actorId) {
  if (!['admin', 'manager', 'user'].includes(userType)) throw new ApiError(400, "userType must be 'admin', 'manager' or 'user'");
  if (id === actorId) throw new ApiError(400, 'You cannot change your own role');
  const target = await usersRepo.findById(id);
  if (!target) throw new ApiError(404, 'User not found');
  if (target.user_type === 'admin' && userType !== 'admin' && (await usersRepo.countActiveAdmins()) <= 1) {
    throw new ApiError(400, 'Cannot demote the last remaining admin');
  }
  const user = await usersRepo.setUserType(id, userType);
  return toPublicUser(user);
}

async function setCostCentre(id, costCentre) {
  if (costCentre != null && typeof costCentre !== 'string') throw new ApiError(400, 'costCentre must be a string');
  const user = await usersRepo.setCostCentre(id, costCentre);
  if (!user) throw new ApiError(404, 'User not found');
  return toPublicUser(user);
}

module.exports = { findOrCreateFromAzureClaims, listUsers, setUserType, setCostCentre, toPublicUser };
