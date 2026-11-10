'use strict';

const setupRepo = require('../repositories/setupRepo');
const usersRepo = require('../repositories/usersRepo');
const imagesRepo = require('../repositories/imagesRepo');
const teamService = require('./teamService');
const clockService = require('./clockService');
const costCentreService = require('./costCentreService');
const { getPool, withTransaction } = require('../config/db');
const ApiError = require('../utils/ApiError');
const { LIST_CASE, sentenceCase } = require('../utils/textCase');

const NAME_LISTS = {
  machineTypes: 'machine_types',
  suffixDescriptions: 'suffix_descriptions',
  customers: 'customers',
  costCentres: 'cost_centres',
  reworkReasons: 'rework_reasons',
};
const ARRAY_SECTIONS = ['nonWorking', 'contractInfo', ...Object.keys(NAME_LISTS)];
const SECTIONS = ['contracts', 'autoClockOutDelay', ...ARRAY_SECTIONS];
// Company-wide settings only an admin may change (the Cost centre and Rework reasons tabs), and the
// auto clock-out delay (Working patterns tab), which managers may change too.
const ADMIN_SECTIONS = ['costCentres', 'reworkReasons'];
// Lists anyone can add to, but only an admin can remove from.
const ADMIN_REMOVES = { machineTypes: 'machine types', suffixDescriptions: 'suffix descriptions', customers: 'customers' };

/* Refuses a non-admin's save that would remove a machine type, suffix description or customer, or a filled-in contract or
 * suffix from Contract information (a blank row -- no number and no suffix letters, or a suffix with no letter -- can go). */
async function assertNothingRemoved(db, patch) {
  for (const [key, label] of Object.entries(ADMIN_REMOVES)) {
    if (!patch[key]) continue;
    const kept = new Set(patch[key].map((name) => name.toLowerCase()));
    const missing = (await setupRepo.listNames(db, NAME_LISTS[key])).filter((name) => !kept.has(name.toLowerCase()));
    if (missing.length) throw new ApiError(403, `Only an admin can remove ${label} (${missing.join(', ')})`);
  }
  if (!patch.contractInfo) return;
  const filled = await setupRepo.filledContractInfoIds(db);
  const keptContracts = new Set(patch.contractInfo.map((record) => record.id));
  const keptSuffixes = new Set(patch.contractInfo.flatMap((record) => (record.suffixes || []).map((suffix) => suffix.id)));
  if (filled.contracts.some((id) => !keptContracts.has(id))) throw new ApiError(403, 'Only an admin can remove a contract from Contract information');
  if (filled.suffixes.some((id) => !keptSuffixes.has(id))) throw new ApiError(403, 'Only an admin can remove a suffix from Contract information');
}

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
  const teamUserIds = await teamService.visibleUserIds(getPool(), actor); // null = everyone (admin)
  const theme = (await usersRepo.findById(actor.id))?.theme || 'light'; // light or dark: their own choice
  return { ...setup, ...clock, teamUserIds, currentUser: actor, theme };
}

/* Applies only the sections present in `patch` -- the frontend sends just
 * what changed, so one person's edit to (say) the customer list can't
 * overwrite another's newer contract-information change with a stale copy.
 * Tile hidden/order are saved for `actor` only (the demo seed has none).
 */
async function applyPatch(patch, actor) {
  if (!patch || typeof patch !== 'object') throw new ApiError(400, 'Expected a JSON object');
  const unknown = Object.keys(patch).filter((key) => !SECTIONS.includes(key));
  if (unknown.length) throw new ApiError(400, `Unknown setup section(s): ${unknown.join(', ')}`);
  if (actor && actor.userType !== 'admin' && ADMIN_SECTIONS.some((key) => key in patch)) throw new ApiError(403, 'Only an admin can change cost centres or rework reasons');
  if (actor && !['admin', 'manager'].includes(actor.userType) && 'autoClockOutDelay' in patch) throw new ApiError(403, 'Only an admin or a manager can change the auto clock-out delay');
  // Whole minutes after the end of the working day, 0 to 5 hours.
  if ('autoClockOutDelay' in patch && !(Number.isInteger(patch.autoClockOutDelay) && patch.autoClockOutDelay >= 0 && patch.autoClockOutDelay <= 300)) throw new ApiError(400, 'autoClockOutDelay must be 0 to 300 minutes');
  ARRAY_SECTIONS.forEach((key) => {
    if (key in patch && !Array.isArray(patch[key])) throw new ApiError(400, `${key} must be an array`);
  });
  // Links end up in href attributes, so only let through web links.
  (patch.contractInfo || []).forEach((record) => {
    ['oneDriveLink', 'orderConfirmationLink'].forEach((field) => {
      if (record[field] && !/^https?:\/\//i.test(record[field])) throw new ApiError(400, 'Links must start with http:// or https://');
    });
  });

  // Each name list in its own style (capitals, title or sentence case), with names that become the same kept once.
  Object.keys(NAME_LISTS).forEach((key) => {
    if (!patch[key]) return;
    const seen = new Set();
    patch[key] = patch[key].map((name) => LIST_CASE[key](name)).filter((name) => name && !seen.has(name.toLowerCase()) && seen.add(name.toLowerCase()));
  });

  await withTransaction(async (db) => {
    if (actor && actor.userType !== 'admin') await assertNothingRemoved(db, patch);
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
    if ('autoClockOutDelay' in patch) await setupRepo.setAutoClockOutDelay(db, patch.autoClockOutDelay);
    if (patch.contractInfo) {
      await setupRepo.replaceContractInfo(db, patch.contractInfo);
      await setupRepo.syncContractTiles(db);
    }
  });
}

module.exports = { ensureSeeded, getFullState, applyPatch };
