'use strict';

/* Bootstraps the very first admin. Chicken-and-egg per the auth blueprint:
 * promoting/demoting a user is normally admin-only, so nobody can become
 * the first admin through the app itself -- this direct-DB script resolves
 * that once, outside the app. After the first admin exists, use the
 * in-app Users panel instead (PUT /api/users/:id/user-type).
 *
 * The target person must have already signed in at least once via Microsoft
 * (which auto-creates their 'user' row) before this script can find them.
 *
 * Usage:
 *   node db/scripts/promote-admin.js --email=someone@cliffeng.com
 */
const path = require('path');
const { Client } = require('pg');
require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') });

function getArg(name) {
  const i = process.argv.indexOf(`--${name}`);
  if (i !== -1) return process.argv[i + 1];
  const eq = process.argv.find((a) => a.startsWith(`--${name}=`));
  return eq ? eq.split('=').slice(1).join('=') : null;
}

async function main() {
  const email = getArg('email');
  if (!email) {
    console.error('Usage: node db/scripts/promote-admin.js --email=someone@cliffeng.com');
    process.exit(1);
  }

  const client = new Client({
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT) || 5432,
    database: process.env.DB_NAME,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: process.env.DB_SSL_REJECT_UNAUTHORIZED !== 'false' } : false,
  });
  await client.connect();

  try {
    const { rows } = await client.query(
      "UPDATE users SET user_type = 'admin' WHERE email = $1 RETURNING id, email, name",
      [email]
    );
    if (!rows.length) {
      console.error(`No user found with email "${email}". They must sign in via Microsoft at least once first.`);
      process.exitCode = 1;
      return;
    }
    console.log(`Promoted to admin: ${rows[0].name || rows[0].email} (id ${rows[0].id}).`);
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
