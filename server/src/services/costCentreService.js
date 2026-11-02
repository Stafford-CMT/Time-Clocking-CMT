'use strict';

/* Lists -> Cost centre (admins). A cost centre's name is its key and people
 * hold it as text, so renaming updates everyone who has it in the same
 * transaction, and one that anybody still has can't be deleted. */
const setupRepo = require('../repositories/setupRepo');
const { withTransaction } = require('../config/db');
const ApiError = require('../utils/ApiError');

const peopleText = (n) => `${n} ${n === 1 ? 'person has' : 'people have'}`;

// Throws if any of `names` is still someone's cost centre (also guards PATCH /api/setup).
async function assertUnused(db, names) {
  const used = await setupRepo.costCentreUsage(db, names);
  if (used.length) {
    const [first] = used;
    throw new ApiError(409, `${peopleText(first.people)} "${first.name}" as their cost centre — change theirs in Lists → Users before deleting it`);
  }
}

async function rename(from, to) {
  const name = typeof to === 'string' ? to.trim() : '';
  if (!name) throw new ApiError(400, 'Enter a name for the cost centre');
  if (name.length > 100) throw new ApiError(400, 'Cost centre names are 100 characters at most');
  return withTransaction(async (db) => {
    const names = await setupRepo.listCostCentres(db);
    if (!names.includes(from)) throw new ApiError(404, `"${from}" is not in the cost centre list`);
    if (names.some((existing) => existing !== from && existing.toLowerCase() === name.toLowerCase())) throw new ApiError(409, `"${name}" is already in the list`);
    const people = name === from ? 0 : await setupRepo.renameCostCentre(db, from, name);
    return { costCentres: await setupRepo.listCostCentres(db), people };
  });
}

async function remove(name) {
  return withTransaction(async (db) => {
    await assertUnused(db, [name]);
    await setupRepo.deleteCostCentre(db, name);
    return { costCentres: await setupRepo.listCostCentres(db) };
  });
}

module.exports = { rename, remove, assertUnused };
