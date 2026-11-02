'use strict';

/* Makes the starting data for the live server from this PC's database,
 * without changing this PC's database. Saves one SQL file,
 * db/live-copy/time-slide-live-copy_<date>.sql, that builds the whole
 * database (schema, migrations record, data) and then removes what the live
 * system must not start with:
 *   - left out of the copy: clocked time, running clocks, break pauses,
 *     committed days, exports, reminders, sign-in sessions;
 *   - deleted at the end of the file: development test accounts, sample
 *     staff, and the placeholder demo tiles (meridian, northline, harbour,
 *     civic).
 * Kept: staff and who is ticked in, roles, cost centres, working times and
 * defaults, lists, real tiles, contract information, Syspro settings.
 *
 *   npm run make-live-copy
 *
 * Restore it on the live server into the new, empty database (see README
 * "Moving the data to the live server"). The file holds staff names and
 * emails: it is gitignored and should only travel to the server.
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { Client } = require('pg');
require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') });

const NO_DATA = ['time_sessions', 'active_sessions', 'user_break_state', 'committed_dates', 'exported_days', 'export_batches', 'commit_reminders', 'user_sessions'];
const DEV_USERS = "microsoft_oid LIKE 'dev-%' OR microsoft_oid LIKE 'sample-%'";
const DEMO_TILES = "NOT system AND id IN ('meridian', 'northline', 'harbour', 'civic')";
const CLEANUP_SQL = `
-- Added by make-live-copy: the live system starts without development test
-- accounts, sample staff or the placeholder demo tiles (their tile settings
-- and working times go with them).
DELETE FROM users WHERE ${DEV_USERS};
DELETE FROM contracts WHERE ${DEMO_TILES};
`;

const connection = {
  host: process.env.DB_HOST,
  port: Number(process.env.DB_PORT) || 5432,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: process.env.DB_SSL_REJECT_UNAUTHORIZED !== 'false' } : false,
};

// pg_dump: on the PATH, or in the usual PostgreSQL install folder.
function pgDumpPath() {
  if (spawnSync('pg_dump', ['--version']).status === 0) return 'pg_dump';
  const base = 'C:\\Program Files\\PostgreSQL';
  const versions = fs.existsSync(base) ? fs.readdirSync(base).sort((a, b) => Number(b) - Number(a)) : [];
  for (const v of versions) {
    const exe = path.join(base, v, 'bin', 'pg_dump.exe');
    if (fs.existsSync(exe)) return exe;
  }
  throw new Error('pg_dump not found -- install the PostgreSQL command-line tools or add their bin folder to PATH');
}

// What the live database will hold once the file is restored (read only).
async function summary() {
  const db = new Client(connection);
  await db.connect();
  try {
    const n = async (sql) => (await db.query(sql)).rows[0].n;
    return {
      'staff from Microsoft': await n(`SELECT COUNT(*)::int n FROM users WHERE NOT (${DEV_USERS})`),
      'ticked into Time Slide': await n(`SELECT COUNT(*)::int n FROM users WHERE included AND NOT (${DEV_USERS})`),
      admins: await n(`SELECT COUNT(*)::int n FROM users WHERE included AND user_type = 'admin' AND NOT (${DEV_USERS})`),
      'working-time rows': await n(`SELECT COUNT(*)::int n FROM working_times w JOIN users u ON u.id = w.user_id WHERE NOT (${DEV_USERS})`),
      tiles: await n(`SELECT COUNT(*)::int n FROM contracts WHERE NOT system AND NOT (${DEMO_TILES})`),
      'cost centres': await n('SELECT COUNT(*)::int n FROM cost_centres'),
      'rework reasons': await n('SELECT COUNT(*)::int n FROM rework_reasons'),
      'migrations applied': await n('SELECT COUNT(*)::int n FROM schema_migrations'),
      'clocked time, commits, exports': 'none',
    };
  } finally {
    await db.end();
  }
}

function main() {
  if (!connection.database) throw new Error('DB_NAME is not set in .env');
  const outDir = path.join(__dirname, '..', 'live-copy');
  fs.mkdirSync(outDir, { recursive: true });
  const outFile = path.join(outDir, `time-slide-live-copy_${new Date().toISOString().slice(0, 10)}.sql`);

  const result = spawnSync(pgDumpPath(), [
    '-h', connection.host, '-p', String(connection.port), '-U', connection.user,
    '--format=plain', '--no-owner', '--no-privileges',
    ...NO_DATA.map((table) => `--exclude-table-data=${table}`),
    '-f', outFile, connection.database,
  ], { env: { ...process.env, PGPASSWORD: connection.password }, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`pg_dump failed: ${(result.stderr || '').trim()}`);
  fs.appendFileSync(outFile, CLEANUP_SQL);
  return outFile;
}

(async () => {
  const outFile = main();
  console.log(`Saved ${outFile}`);
  console.table(await summary());
})().catch((err) => {
  console.error(`make-live-copy failed: ${err.message}`);
  process.exit(1);
});
