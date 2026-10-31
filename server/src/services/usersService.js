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
//
// Only people an admin has ticked into Time Slide (users.included) get in.
// Anyone else is still recorded, unticked, so they show up in Lists -> Users
// as having tried to sign in. autoInclude is for the development sign-in.
async function findOrCreateFromAzureClaims({ oid, email, name }, { autoInclude = false } = {}) {
  if (!oid) throw new ApiError(400, 'Azure AD did not return an object id (oid) claim');
  if (env.allowedEmailDomains.length) {
    const domain = String(email || '').split('@')[1]?.toLowerCase();
    if (!domain || !env.allowedEmailDomains.includes(domain)) {
      throw new ApiError(403, 'Sign-in is not permitted for this email domain');
    }
  }
  let user = await usersRepo.findByOid(oid);
  // An account made by the development sign-in has a made-up "dev-" oid;
  // the first real Microsoft sign-in with the same email takes it over,
  // keeping its role and times.
  if (!user && email && !oid.startsWith('dev-')) {
    const devAccount = await usersRepo.findByEmail(email);
    if (devAccount && String(devAccount.microsoft_oid).startsWith('dev-')) user = await usersRepo.setOid(devAccount.id, oid);
  }
  if (!user) {
    user = await usersRepo.create({ microsoftOid: oid, email, name, userType: 'user', included: autoInclude });
  } else {
    user = await usersRepo.recordSignIn(user.id, { email, name });
    if (autoInclude && !user.included) user = await usersRepo.setIncluded(user.id, true);
  }
  if (!user.is_active) throw new ApiError(403, 'This account has been deactivated');
  if (!user.included) {
    const err = new ApiError(403, 'Not added to Time Slide yet');
    err.reason = 'not-added';
    throw err;
  }
  return toPublicUser(user);
}

async function listUsers() {
  return (await usersRepo.listAll()).map(toPublicUser);
}

function toDirectoryEntry(row) {
  return {
    ...toPublicUser(row),
    included: row.included,
    inDirectory: row.in_directory,
    accountEnabled: row.account_enabled,
    jobTitle: row.job_title || '',
    department: row.department || '',
    officeLocation: row.office_location || '',
    lastLoginAt: row.last_login_at,
    syncedAt: row.synced_at,
    sample: String(row.microsoft_oid).startsWith('sample-'),
  };
}

// Everyone from Entra ID plus anyone who has tried to sign in -- admin only.
async function listDirectory() {
  return (await usersRepo.listDirectory()).map(toDirectoryEntry);
}

async function setIncluded(id, included, actorId) {
  if (typeof included !== 'boolean') throw new ApiError(400, 'included must be true or false');
  const target = await usersRepo.findById(id);
  if (!target) throw new ApiError(404, 'User not found');
  if (!included && id === actorId) throw new ApiError(400, 'You cannot remove yourself from Time Slide');
  if (!included && target.user_type === 'admin') throw new ApiError(400, 'Change their user type from Admin before removing them');
  return toDirectoryEntry(await usersRepo.setIncluded(id, included));
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
  if (!target.included) throw new ApiError(400, 'Add them to Time Slide first');
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

module.exports = { findOrCreateFromAzureClaims, listUsers, listDirectory, setIncluded, setUserType, setCostCentre, toPublicUser };
