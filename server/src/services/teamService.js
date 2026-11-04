'use strict';

/* Whose times someone may see. An admin sees everyone; a manager sees
 * themself and everyone below them in Entra ID's reporting chain (direct
 * reports, their reports, and so on); anyone else sees only themself.
 * Seeing is all a manager gets: changing times stays own-or-admin
 * (clockService). */
const usersRepo = require('../repositories/usersRepo');

// null = everyone.
async function visibleUserIds(db, actor) {
  if (actor.userType === 'admin') return null;
  if (actor.userType === 'manager') return usersRepo.teamUserIds(db, actor.id);
  return [actor.id];
}

async function canSee(db, actor, userId) {
  const ids = await visibleUserIds(db, actor);
  return ids === null || ids.includes(userId);
}

module.exports = { visibleUserIds, canSee };
