'use strict';

const setupRepo = require('../repositories/setupRepo');
const imagesRepo = require('../repositories/imagesRepo');
const clockService = require('./clockService');
const costCentreService = require('./costCentreService');
const { getPool, withTransaction } = require('../config/db');
const ApiError = require('../utils/ApiError');

const NAME_LISTS = {
  machineTypes: 'machine_types',
  suffixDescriptions: 'suffix_descriptions',
  customers: 'customers',
  costCentres: 'cost_centres',
  reworkReasons: 'rework_reasons',
};
const ARRAY_SECTIONS = ['nonWorking', 'contractInfo', 'workingTimes', ...Object.keys(NAME_LISTS)];
const SECTIONS = ['contracts', 'defaultWorkingTimes', ...ARRAY_SECTIONS];
// Company-wide settings only an admin may change (the Users, Cost centre and Rework reasons tabs).
const ADMIN_SECTIONS = ['defaultWorkingTimes', 'costCentres', 'reworkReasons'];

// Placeholder tiles for a brand-new, empty database only (dev/test
// convenience) -- delete them in the app once real contracts are entered.
function demoSeedPatch() {
  return {
    contracts: {
      upsert: [
        { id: 'meridian', customerName: 'Meridian House', number: 'CNT-1048', suffix: 'A-01' },
        { id: 'northline', customerName: 'Northline Depot', number: 'CNT-0917', suffix: 'B-04' },
        { id: 'harbour', customerName: 'Harbour Exchange', number: 'CNT-1182', suffix: 'C-02' },
        { id: 'civic', customerName: 'Civic Centre Refurb', number: 'CNT-0974', suffix: 'A-03' },
      ],
      order: ['meridian', 'northline', 'harbour', 'civic'],
    },
    machineTypes: ['Excavator', 'Dumper truck', 'Roller', 'Crane'],
  };
}

async function ensureSeeded() {
  await withTransaction((db) => setupRepo.syncContractTiles(db)); // tiles for suffixes saved before tiles followed Contract information
  const { rows } = await getPool().query('SELECT COUNT(*)::int AS n FROM contracts WHERE NOT system');
  if (rows[0].n === 0) {
    await applyPatch(demoSeedPatch());
    console.log('Seeded a fresh database with placeholder demo contracts (no real data existed yet).');
  }
}

// Everything the frontend needs on load: shared setup (with the caller's own
// tile layout), the caller's clock state, and who the caller is.
async function getFullState(actor) {
  const setup = await setupRepo.getSetup(getPool(), actor.id);
  const clock = await clockService.getState(actor);
  return { ...setup, ...clock, currentUser: actor };
}

/* Working times are saved as the whole list, but anyone other than an admin
 * may only change their own row: everyone else's rows are kept exactly as
 * they are in the database, and no row can be added or removed. */
function ownRowOnly(current, submitted, userId) {
  const mine = submitted.find((entry) => entry && entry.userId === userId);
  return current.map((entry) => (entry.userId === userId && mine ? { ...mine, id: entry.id, userId } : entry));
}

/* Applies only the sections present in `patch` -- the frontend sends just
 * what changed, so one person's edit to (say) the customer list can't
 * overwrite another's newer working-times change with a stale copy.
 * Tile hidden/pinned/order are saved for `actor` only (the demo seed has none).
 */
async function applyPatch(patch, actor) {
  if (!patch || typeof patch !== 'object') throw new ApiError(400, 'Expected a JSON object');
  const unknown = Object.keys(patch).filter((key) => !SECTIONS.includes(key));
  if (unknown.length) throw new ApiError(400, `Unknown setup section(s): ${unknown.join(', ')}`);
  if (actor && actor.userType !== 'admin' && ADMIN_SECTIONS.some((key) => key in patch)) throw new ApiError(403, 'Only an admin can change default working times, cost centres or rework reasons');
  ARRAY_SECTIONS.forEach((key) => {
    if (key in patch && !Array.isArray(patch[key])) throw new ApiError(400, `${key} must be an array`);
  });
  // Links end up in href attributes, so only let through web links.
  (patch.contractInfo || []).forEach((record) => {
    ['oneDriveLink', 'orderConfirmationLink'].forEach((field) => {
      if (record[field] && !/^https?:\/\//i.test(record[field])) throw new ApiError(400, 'Links must start with http:// or https://');
    });
  });

  await withTransaction(async (db) => {
    if (patch.contracts) {
      for (const contract of patch.contracts.upsert || []) {
        if (!contract.id) throw new ApiError(400, 'Every contract needs an id');
        if (contract.imageId && !(await imagesRepo.exists(db, contract.imageId))) throw new ApiError(400, 'That picture is no longer in the library');
        await setupRepo.upsertContract(db, contract);
        if (actor) await setupRepo.setTileSettings(db, actor.id, contract);
      }
      if (actor && Array.isArray(patch.contracts.order)) await setupRepo.setTileOrder(db, actor.id, patch.contracts.order);
    }
    if (patch.costCentres) {
      const kept = new Set(patch.costCentres);
      await costCentreService.assertUnused(db, (await setupRepo.listCostCentres(db)).filter((name) => !kept.has(name)));
    }
    for (const [key, table] of Object.entries(NAME_LISTS)) {
      if (patch[key]) await setupRepo.replaceNameList(db, table, patch[key]);
    }
    if (patch.nonWorking) await setupRepo.replaceNonWorking(db, patch.nonWorking);
    if (patch.defaultWorkingTimes) await setupRepo.replaceDefaultWorkingTimes(db, patch.defaultWorkingTimes);
    if (patch.contractInfo) {
      await setupRepo.replaceContractInfo(db, patch.contractInfo);
      await setupRepo.syncContractTiles(db);
    }
    if (patch.workingTimes) {
      const entries = actor && actor.userType !== 'admin' ? ownRowOnly(await setupRepo.listWorkingTimes(db), patch.workingTimes, actor.id) : patch.workingTimes;
      await setupRepo.replaceWorkingTimes(db, entries);
    }
  });
}

module.exports = { ensureSeeded, getFullState, applyPatch };
