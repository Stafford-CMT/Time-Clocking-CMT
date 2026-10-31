'use strict';

/* Staff come from Microsoft Entra ID. Every DIRECTORY_SYNC_MINUTES (and when
 * an admin clicks "Sync now") this reads the tenant's members through
 * Microsoft Graph and refreshes the users table: new people are added
 * unticked, everyone's name/department/job title is refreshed, and anyone
 * no longer in Entra ID is flagged (their times are kept). Ticking someone
 * into Time Slide is done by an admin in Lists -> Users.
 *
 * Needs the app registration's Microsoft Graph application permission
 * User.Read.All with admin consent. Until then the sync reports
 * "waiting-consent" and the app carries on with whoever has signed in.
 */
const { getMsalClient } = require('../config/msal');
const env = require('../config/env');
const usersRepo = require('../repositories/usersRepo');

const GRAPH_USERS = 'https://graph.microsoft.com/v1.0/users?$select=id,displayName,mail,userPrincipalName,jobTitle,department,officeLocation,accountEnabled,userType&$top=999';

// DIRECTORY_SAMPLE=true (development only): made-up staff, clearly marked.
const SAMPLE_STAFF = [
  ['Alex Turner', 'Design Engineer', 'Design - Mechanical'],
  ['Priya Shah', 'Electrical Design Engineer', 'Design - Electrical'],
  ['Tom Fletcher', 'Machine Builder', 'Assembly'],
  ['Grace Owusu', 'Machine Builder', 'Assembly'],
  ['Dan Price', 'CNC Machinist', 'Production'],
  ['Megan Hale', 'Production Planner', 'Production'],
  ['Sam Rourke', 'Service Engineer', 'Service'],
  ['Lucy Brennan', 'Accounts Assistant', 'Finance'],
  ['Mark Ellis', 'Quality Inspector', 'Quality'],
  ['Ruth Kaur', 'Stores Controller', 'Stores'],
  ['Jamie Cole', 'Sales Engineer', 'Sales'],
  ['Meeting Room 2', '', ''],
].map(([name, jobTitle, department], index) => ({
  oid: `sample-${index + 1}`,
  name: `${name} (sample)`,
  email: `${name.toLowerCase().replace(/[^a-z0-9]+/g, '.')}@example.com`,
  jobTitle,
  department,
  officeLocation: department ? 'Clifford (sample)' : '',
  accountEnabled: index !== 9,
}));

let status = { state: 'not-run', message: 'Not synced yet', lastAttemptAt: null, lastSuccessAt: null, people: 0, sample: env.directorySample };

async function fetchFromGraph() {
  const { accessToken } = await getMsalClient().acquireTokenByClientCredential({ scopes: ['https://graph.microsoft.com/.default'] });
  const people = [];
  let url = GRAPH_USERS;
  while (url) {
    const response = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
    if (response.status === 401 || response.status === 403) {
      const err = new Error('Microsoft refused to list staff: admin consent for User.Read.All has not been granted yet');
      err.waitingConsent = true;
      throw err;
    }
    if (!response.ok) throw new Error(`Microsoft Graph returned ${response.status}`);
    const page = await response.json();
    page.value
      .filter((person) => person.userType === 'Member') // leave out guest accounts
      .forEach((person) => people.push({
        oid: person.id,
        name: person.displayName,
        email: person.mail || person.userPrincipalName,
        jobTitle: person.jobTitle,
        department: person.department,
        officeLocation: person.officeLocation,
        accountEnabled: person.accountEnabled,
      }));
    url = page['@odata.nextLink'];
  }
  return people;
}

async function savePeople(people, { markMissing }) {
  const syncStartedAt = new Date();
  let saved = 0;
  for (const person of people) {
    try {
      // Someone first signed in through the development sign-in: claim that row.
      if (!(await usersRepo.findByOid(person.oid)) && person.email) {
        const devAccount = await usersRepo.findByEmail(person.email);
        if (devAccount && String(devAccount.microsoft_oid).startsWith('dev-')) await usersRepo.setOid(devAccount.id, person.oid);
      }
      await usersRepo.saveDirectoryPerson(person, syncStartedAt);
      saved += 1;
    } catch (err) {
      console.warn(`Staff sync skipped ${person.email || person.oid}: ${err.message}`);
    }
  }
  if (markMissing) await usersRepo.markMissingFromDirectory(syncStartedAt);
  return saved;
}

async function sync() {
  const lastAttemptAt = new Date();
  try {
    let people;
    if (env.directorySample) {
      people = SAMPLE_STAFF;
    } else {
      if (!env.azure.clientSecret) throw new Error('Microsoft sign-in is not configured on this server');
      people = await fetchFromGraph();
      await usersRepo.deleteSampleStaff();
    }
    // Sample staff stand alongside real accounts; never flag real ones as having left.
    const saved = await savePeople(people, { markMissing: !env.directorySample });
    status = { state: 'ok', message: `${saved} people`, lastAttemptAt, lastSuccessAt: lastAttemptAt, people: saved, sample: env.directorySample };
  } catch (err) {
    console.warn('Staff sync failed:', err.message);
    status = { ...status, state: err.waitingConsent ? 'waiting-consent' : 'error', message: err.message, lastAttemptAt, sample: env.directorySample };
  }
  return status;
}

function getStatus() {
  return status;
}

function startSchedule() {
  sync();
  setInterval(sync, env.directorySyncMinutes * 60 * 1000).unref();
}

module.exports = { sync, getStatus, startSchedule };
