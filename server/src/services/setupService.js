'use strict';

const setupRepo = require('../repositories/setupRepo');
const clockService = require('./clockService');
const { getPool, withTransaction } = require('../config/db');
const ApiError = require('../utils/ApiError');

const NAME_LISTS = {
  machineTypes: 'machine_types',
  suffixDescriptions: 'suffix_descriptions',
  customers: 'customers',
  costCentres: 'cost_centres',
};
const ARRAY_SECTIONS = ['nonWorking', 'contractInfo', 'workingTimes', ...Object.keys(NAME_LISTS)];
const SECTIONS = ['contracts', 'defaultWorkingTimes', ...ARRAY_SECTIONS];

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

/* Applies only the sections present in `patch` -- the frontend sends just
 * what changed, so one person's edit to (say) the customer list can't
 * overwrite another's newer working-times change with a stale copy.
 * Tile hidden/pinned/order are saved for `actor` only (the demo seed has none).
 */
async function applyPatch(patch, actor) {
  if (!patch || typeof patch !== 'object') throw new ApiError(400, 'Expected a JSON object');
  const unknown = Object.keys(patch).filter((key) => !SECTIONS.includes(key));
  if (unknown.length) throw new ApiError(400, `Unknown setup section(s): ${unknown.join(', ')}`);
  ARRAY_SECTIONS.forEach((key) => {
    if (key in patch && !Array.isArray(patch[key])) throw new ApiError(400, `${key} must be an array`);
  });
  // Images and links end up in src/href attributes, so only let through the
  // kinds the app itself produces (uploaded images, web links).
  (patch.contracts?.upsert || []).forEach((contract) => {
    if (contract.image && !/^data:image\//i.test(contract.image)) throw new ApiError(400, 'Tile image must be an uploaded image');
  });
  (patch.contractInfo || []).forEach((record) => {
    ['oneDriveLink', 'orderConfirmationLink'].forEach((field) => {
      if (record[field] && !/^https?:\/\//i.test(record[field])) throw new ApiError(400, 'Links must start with http:// or https://');
    });
  });

  await withTransaction(async (db) => {
    if (patch.contracts) {
      for (const contract of patch.contracts.upsert || []) {
        if (!contract.id) throw new ApiError(400, 'Every contract needs an id');
        await setupRepo.upsertContract(db, contract);
        if (actor) await setupRepo.setTileSettings(db, actor.id, contract);
      }
      if (actor && Array.isArray(patch.contracts.order)) await setupRepo.setTileOrder(db, actor.id, patch.contracts.order);
    }
    for (const [key, table] of Object.entries(NAME_LISTS)) {
      if (patch[key]) await setupRepo.replaceNameList(db, table, patch[key]);
    }
    if (patch.nonWorking) await setupRepo.replaceNonWorking(db, patch.nonWorking);
    if (patch.defaultWorkingTimes) await setupRepo.replaceDefaultWorkingTimes(db, patch.defaultWorkingTimes);
    if (patch.contractInfo) await setupRepo.replaceContractInfo(db, patch.contractInfo);
    if (patch.workingTimes) await setupRepo.replaceWorkingTimes(db, patch.workingTimes);
  });
}

module.exports = { ensureSeeded, getFullState, applyPatch };
