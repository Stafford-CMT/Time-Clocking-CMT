'use strict';

const stateRepo = require('../repositories/stateRepo');
const { getPool } = require('../config/db');

// Seed data for a brand-new, empty database only (dev/test convenience).
// No `users`, `workingTimes` or `editSessions` here -- those need a real
// signed-in user's id (from Azure AD), which doesn't exist yet on a fresh
// database, so they're left empty until the first real sign-in.
function demoSeedState() {
  return {
    contracts: [
      { id: 'meridian', customerName: 'Meridian House', number: 'CNT-1048', suffix: 'A-01', suffixDescription: '', machineType: '', image: null, activeSessions: {}, pinned: false, hidden: false },
      { id: 'northline', customerName: 'Northline Depot', number: 'CNT-0917', suffix: 'B-04', suffixDescription: '', machineType: '', image: null, activeSessions: {}, pinned: true, hidden: false },
      { id: 'harbour', customerName: 'Harbour Exchange', number: 'CNT-1182', suffix: 'C-02', suffixDescription: '', machineType: '', image: null, activeSessions: {}, pinned: false, hidden: false },
      { id: 'civic', customerName: 'Civic Centre Refurb', number: 'CNT-0974', suffix: 'A-03', suffixDescription: '', machineType: '', image: null, activeSessions: {}, pinned: false, hidden: false },
    ],
    order: ['meridian', 'northline', 'harbour', 'civic'],
    nonWorking: [],
    machineTypes: ['Excavator', 'Dumper truck', 'Roller', 'Crane'],
    suffixDescriptions: [],
    customers: [],
    costCentres: [],
    defaultWorkingTimes: { start: '07:00', end: '16:00', breaks: [{ start: '09:00', end: '09:15' }, { start: '12:30', end: '13:05' }] },
    contractInfo: [],
    committedDates: [],
    adminMode: false,
    workingTimes: [],
    breakState: null,
    editSessions: {},
  };
}

async function ensureSeeded() {
  const { rows } = await getPool().query('SELECT COUNT(*)::int AS n FROM contracts');
  if (rows[0].n === 0) {
    await stateRepo.replaceFullState(demoSeedState());
    console.log('Seeded a fresh database with placeholder demo data (no real data existed yet).');
  }
}

async function getFullState() {
  return stateRepo.getFullState();
}

async function replaceFullState(newState) {
  return stateRepo.replaceFullState(newState || {});
}

module.exports = { ensureSeeded, getFullState, replaceFullState };
