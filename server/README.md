# Time Slide — Production Server

Express + PostgreSQL backend that also serves the frontend (`public/`), with
per-user sign-in via Microsoft/Entra ID (Azure AD) SSO. Three roles:
**admin**, **manager**, **user** — see "Roles" below.

Built following the same process as the Design Plan Gantt board
(`../Design Plan/Gantt-App-Production/server`) — see
`../Login Security and Deployment Blueprint.pdf` and
`../Windows App Deployment Runbook.md` for the general pattern this project
follows (Express + Postgres, `express-session`, PM2, Caddy). Like the Gantt
board, this deviates from the base blueprint by using Azure AD SSO instead
of bcrypt/password auth.

## Status

The frontend is wired to this API: everyone signs in as themselves, and
every clock start/stop, break pause/resume, time-block edit and day commit
is written to the database the moment it happens, timed by the server.
Runs against a local PostgreSQL 16 (migrations, sign-in sessions and the
full API test all pass). Sign-in and sign-out with the real Azure AD app
registration work at `http://localhost:4100` (tested 2026-11-02), and the
staff sync reads Entra ID. Live at https://timeslide.cliffeng.com since
2026-11-03 (see "Deployment (live server)"). See "Known gaps".

## One-time setup

### 1. Azure AD (Entra ID) app registration

In the Azure Portal → **App registrations** → New registration (name it
**Time Slide**; the live address is `timeslide.cliffeng.com`):
- Add redirect URIs (Web platform): `https://timeslide.cliffeng.com/auth/callback`,
  plus `http://localhost:4100/auth/callback` for local development
- Also add the sign-in pages, `https://timeslide.cliffeng.com/login.html` and
  `http://localhost:4100/login.html`, as Web redirect URIs. Sign out also signs
  the person out of Microsoft (deliberately, for shared PCs), and Microsoft only
  sends them back to the app if that address is registered; otherwise it stops
  on its own "You signed out" page.
- Under **Certificates & secrets**, create a new client secret
- Note the **Application (client) ID**, **Directory (tenant) ID**, and the
  client secret value — these go into `.env` below

This app uses its **own** app registration, separate from the Gantt board's.

### 2. PostgreSQL

On your Postgres server, create a dedicated database and login for this app
(never share credentials or a database between apps):

```sql
CREATE USER time_clocking_app WITH PASSWORD '...';
CREATE DATABASE time_clocking OWNER time_clocking_app;
```
(`CREATE DATABASE` can't run in the same statement/transaction as
`CREATE USER` — run them separately.)

### 3. Configure `.env`

Copy `.env.example` to `.env` and fill in real values: `DB_*`, a freshly
generated `SESSION_SECRET` (`node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"`),
a `SETTINGS_ENCRYPTION_KEY` (`node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`,
used to encrypt the Syspro passwords — keep a copy somewhere safe), and the
`AZURE_*` values from step 1. `.env` is gitignored — never commit it.

`ALLOWED_EMAIL_DOMAINS=cliffeng.com` is a server-side gate on top of Azure AD
itself — even though the app registration is single-tenant, this also
blocks any guest/B2B account inside the tenant that isn't `@cliffeng.com`.
Leave it blank to allow anyone Azure AD itself lets through.

### 4. Install dependencies and run migrations

```
npm install
npm run migrate
```

This creates the schema (`db/migrations/*.sql`) and tracks applied
migrations in `schema_migrations`. On first run against an empty database,
starting the server also seeds four placeholder demo contracts (see
`setupService.ensureSeeded`) — hide them in the app once real contracts are
entered.

### 5. Bootstrap the first admin

Try signing in once via the app's "Sign in with Microsoft" button. You will
be refused ("not added to Time Slide yet"), but that records you. Or wait for
the first staff sync (see "Staff from Microsoft" below). Then run:

```
npm run promote-admin -- --email=you@cliffeng.com
```

This makes you an admin and ticks you into Time Slide. After that, add
people and promote/demote them from **Lists → Users** in the app
(admin-only) — no more CLI needed.

## Staff from Microsoft

Staff are read from Entra ID through Microsoft Graph when the server starts,
every 30 minutes (`DIRECTORY_SYNC_MINUTES`), and when an admin clicks
**Sync now** in **Lists → Users**. This needs the app registration's
Microsoft Graph **application** permission `User.Read.All`, with admin
consent; until then the Users tab says it is waiting for consent and people
appear there when they first try to sign in.

- Everyone in the tenant (not guests) gets a row, **unticked**. An admin
  ticks who is in Time Slide. Only ticked people can sign in or appear in
  the app's user lists; unticking someone signs them out on their next click.
- Name, email, job title, department and office come from Microsoft on each
  sync. People who leave Entra ID are flagged, not deleted, so their times stay.
- Admins can't untick themselves, and must change another admin's user type
  before unticking them.
- Finance grouping is the **Cost centre** set per person in the same table;
  Microsoft's department is shown beside it.
- For development before consent is granted, `DIRECTORY_SAMPLE=true` fills
  the list with a dozen made-up people marked "Sample" instead of reading
  Microsoft (refused in production). The first real sync removes them.

## Syspro connection (Setup → Configuration)

Admins only — the menu item is hidden from everyone else and the API refuses
them. Two sections, fill in whichever your Syspro set-up uses:

- **Syspro e.net (web services)** — address (e.g.
  `http://syspro-server:20000/SYSPROWCFService/Rest`), operator, operator
  password, company ID, company password. Used to post committed times into
  Syspro. **Test connection** logs on to e.net with the saved details and
  straight off again.
- **Syspro SQL Server (read only)** — server, port, company database, SQL
  login and password, and the encryption switches. For read-only lookups; give
  it a SQL login that can only read. There is no test button for this yet — it
  comes with the code that reads Syspro.

Passwords are encrypted (AES-256-GCM, `SETTINGS_ENCRYPTION_KEY`) before they
are stored, and never sent back to the browser — the page only shows whether
each is saved. Leaving a password box blank keeps the saved one. If the key
is lost or changed, the passwords must be typed in again. Prefer an `https://`
e.net address: Syspro's Logon call carries the passwords in the address.

## Running

```
npm start
```

Runs on `PORT` over plain HTTP: 4004 on the live server, 4100 on a development PC (the default) — put Caddy in front for
HTTPS (see below); `express-session`'s `secure` cookie flag only activates
when `NODE_ENV=production`, so local dev over plain `http://localhost`
still works without Caddy.

### Local development without Azure

Set `NODE_ENV=development` and `DEV_LOGIN_EMAIL=you@cliffeng.com` in `.env`
(the `AZURE_*` values can then be blank). "Sign in with Microsoft" then
signs you straight in as that email (add `DEV_LOGIN_NAME=Your Name` to
show a proper name rather than one built from the email). The sign-in page
then offers three test accounts — admin (that email), manager and user
(`name+manager@…`, `name+user@…`) — so you can see the app as each role;
sign out to switch. Each account's role is reset every time you sign in as
it. You still need a PostgreSQL database
and `npm run migrate`. The server refuses to start if `DEV_LOGIN_EMAIL` is
set with `NODE_ENV=production`.

## HTTPS (Caddy)

If the target server already runs a shared Caddy instance for other apps
(e.g. CMTDC01, which serves IO Buddy and Gantt), this app does **not** run
its own Caddy process. Instead, add the site block in
`Caddyfile-snippet.txt` into that existing Caddyfile, then reload it —
see that file for the full steps.

## Moving the data to the live server

The live server starts with this PC's set-up (staff and who is ticked in,
roles, cost centres, working times, lists, real tiles, contract information)
but no clocked time. On this PC, on the day:

```
npm run make-live-copy
```

This saves `db/live-copy/time-slide-live-copy_<date>.sql` and lists what it
holds; this PC's database is not changed. The file leaves out clocked time,
commits, exports and sign-in sessions, and ends by deleting the development
test accounts and the placeholder demo tiles. It holds staff names and
emails: it is gitignored -- copy it straight to the server, nowhere else.

On the server, **before the app is ever started** (an empty database makes
the app add placeholder tiles, and the restore then clashes with them):

1. Create the empty database and its login (One-time setup, step 2).
2. Load the file, all or nothing:
   ```
   psql -h localhost -U time_clocking_app -d time_clocking -v ON_ERROR_STOP=1 --single-transaction -f time-slide-live-copy_<date>.sql
   ```
3. `npm run migrate` -- should report every migration as already applied.
4. Start it (see Deployment (PM2)), sign in and check, then delete the .sql
   file from the server.

The Syspro passwords in Configuration are encrypted with
`SETTINGS_ENCRYPTION_KEY`: if any are saved on this PC, the live `.env`
needs the same key. None were saved on 2026-11-02, so the live server can
have its own key and the passwords are entered there.

## Deployment (live server)

Live since 2026-11-03 at **https://timeslide.cliffeng.com** on CMTDC01 (hostname
CMT-DC), set up the same way as IO Buddy, Gantt, MecHub and Training Matrix:

- Code: `C:\TIME SLIDE\server`. Its `.env` holds the live settings and is
  never copied anywhere.
- Runs as the Windows service **`TimeSlideApp`** through NSSM
  (`C:\nssm\nssm.exe`), as LocalService, starting automatically, restarting
  if it stops, with `NODE_ENV=production`. This server does **not** use PM2
  (`ecosystem.config.js` is only for a PM2 setup elsewhere).
- Logs: `C:\TIME SLIDE\server\logs\service-out.log` and `service-error.log`.
- Port 4004, behind the shared Caddy (service `Caddy`), whose Caddyfile is
  `C:\IO BUDDY\IO Buddy - Eplan database import export\server\Caddyfile`. The
  Time Slide block is at its end; Caddy gets the certificate from Let's
  Encrypt by itself.
- Database `time_clocking` (login `time_clocking_app`) on the server's
  PostgreSQL 18.

Useful commands on the server (PowerShell as administrator):

```
Restart-Service TimeSlideApp
Get-Service TimeSlideApp
Get-Content "C:\TIME SLIDE\server\logs\service-out.log" -Tail 30
Get-Content "C:\TIME SLIDE\server\logs\service-error.log" -Tail 30
```

### Updating the live server

1. Commit and push to GitHub, then on this PC, in `server/`:
   `npm run make-update`. It saves `deploy-kit/update-<date_time>/` (gitignored):
   the whole app as one zip (never `node_modules`, any `.env` or live-copy
   data, with a `VERSION.txt` naming the commit), the server script and
   `HOW-TO-UPDATE.txt`.
2. Copy that folder to the server as `C:\TIME SLIDE\update` and run, in
   PowerShell as administrator:
   ```
   powershell -ExecutionPolicy Bypass -File "C:\TIME SLIDE\update\update-timeslide.ps1"
   ```
   `deploy/update-timeslide.ps1` stops unless it is on CMT-DC; backs the app up
   to `C:\TIME SLIDE\backups\<date_time>` (without `node_modules` and logs);
   copies the new files in, never the server's `.env` or logs; runs `npm ci`
   only if `package-lock.json` changed; runs `npm run migrate`; restarts
   `TimeSlideApp` and waits for the start-up log line and a 200 from
   `/login.html`. Any failure puts the backup back and restarts. It ends with
   `[OK]` or `[FAILED]`. Note: a migration that ran is not undone by the
   automatic restore -- write migrations so the previous version still runs.

Doing it by hand instead (copy files over Remote Desktop; never copy
`node_modules` or a development `.env`):

| Changed | Steps |
|---|---|
| Frontend files only (`public/`) | Copy the file(s) over; refresh the browser. No restart. |
| Backend (`src/**`) | Copy the file(s) over; `Restart-Service TimeSlideApp`. |
| `package.json` changed | `npm ci --omit=dev` in `C:\TIME SLIDE\server` first, then restart. |
| Database schema | Copy the new numbered file in `db/migrations/` over, run `npm run migrate`, then restart. Never hand-edit the live schema. |
| Caddy block | Edit the Caddyfile, run `C:\Caddy\caddy.exe validate --config Caddyfile` in its folder, then `C:\Caddy\caddy.exe reload --config Caddyfile` (the other sites stay up). |

How the service was created (same settings as `GanttApp`):

```
C:\nssm\nssm.exe install TimeSlideApp "C:\Program Files\nodejs\node.exe"
C:\nssm\nssm.exe set TimeSlideApp AppParameters src\index.js
C:\nssm\nssm.exe set TimeSlideApp AppDirectory "C:\TIME SLIDE\server"
C:\nssm\nssm.exe set TimeSlideApp AppExit Default Restart
C:\nssm\nssm.exe set TimeSlideApp AppEnvironmentExtra :NODE_ENV=production
C:\nssm\nssm.exe set TimeSlideApp AppStdout "C:\TIME SLIDE\server\logs\service-out.log"
C:\nssm\nssm.exe set TimeSlideApp AppStderr "C:\TIME SLIDE\server\logs\service-error.log"
C:\nssm\nssm.exe set TimeSlideApp ObjectName "NT Authority\LocalService"
C:\nssm\nssm.exe set TimeSlideApp Start SERVICE_AUTO_START
```

LocalService has read access to `C:\TIME SLIDE\server` and modify access to
its `logs` folder (`icacls ... /grant "NT AUTHORITY\LOCAL SERVICE:..."`).

## API

All under `/api`, all need a signed-in session. Clock actions always act as
the signed-in user; each returns the refreshed clock state.

| Endpoint | What it does | Who |
|---|---|---|
| `GET /state` | Setup data + your clock state + who you are | anyone |
| `PATCH /setup` | Saves only the setup sections sent (lists, contract info, working times, tiles). Never deletes contracts. | anyone |
| `POST /clock/:contractId/start` · `/stop` | Start/stop your clock. Starting one contract stops any other you had running. | own clock |
| `POST /clock/break/pause` · `/resume` | Called by the browser when your scheduled break starts/ends | own clock |
| `PATCH /sessions` · `DELETE /sessions/:id` | Edit Times changes, as a batch so a block and its linked neighbour change together | own times; admin: anyone's |
| `POST /commits/:userId/:date` | Lock a day's times | own day; admin: anyone's |
| `DELETE /commits/:userId/:date` | Unlock a day | admin |
| `GET /users` | People in Time Slide | anyone |
| `GET /directory` · `POST /directory/sync` | All staff from Microsoft, ticked or not, and the sync status · sync now | admin |
| `PUT /users/:id/included` | Tick someone into Time Slide, or out of it | admin |
| `PUT /users/:id/user-type` · `/cost-centre` | Change role / cost centre | admin |
| `GET /export/overview?from=&to=` | Setup → Data export grid: each person's days with hours and status (not committed / committed / exported / changed since export), plus the exports covering those dates | own row; everyone for admin |
| `GET /export/times?from=&to=&userId=` | Preview spreadsheet (.xlsx) — marks nothing as exported (no `userId` = everyone, admins only) | own times; anyone's for admin |
| `POST /export/batches` | Export: every committed, not-yet-exported day in `{from, to}` becomes one batch and is returned as .xlsx; a day is never in two live batches | admin |
| `GET /export/batches/:id/file` · `DELETE /export/batches/:id` | Download an export again exactly as it was · undo it so its days can be exported again | admin |
| `POST /export/reminders` | Email everyone with uncommitted days before today in `{from, to}` (needs `MAIL_FROM` and Graph `Mail.Send`) | admin |
| `GET /config/syspro` · `PUT /config/syspro` | Syspro connection details (passwords only as "set" flags) · save them | admin |
| `POST /config/syspro/test-enet` | Log on to Syspro e.net with the saved details and off again | admin |

## Roles

- **admin** — can review and edit anyone's times (Edit Times shows a user
  picker), edit committed days, unlock commits, and change users' roles and
  cost centres, and set up the Syspro connection. The "Admin mode" checkbox is a per-browser safety catch only
  admins see; the server checks the role itself.
- **manager** / **user** — clock, edit and commit their own times, and edit
  shared setup data.

New people (from the staff sync or a first sign-in) are always `user` and
unticked — nobody is ever auto-admin, auto-manager or let in automatically.

## Known gaps

- **Most setup data is shared:** any signed-in user can edit the machine
  type, suffix description and customer lists and contract information.
  Users, Cost centre, Rework reasons and Default working times are
  admin-only; tile layout (pinned/hidden/order) is per person. Saves send
  only changed sections, so stale browsers don't wipe other sections, but
  two people editing the same section at once is still last-write-wins.
- **Commit reminder emails need IT:** the mailbox `timeslide@cliffeng.com`
  exists; set `MAIL_FROM=timeslide@cliffeng.com` in the live `.env` and
  `pm2 restart time-clocking-server`. Microsoft Graph `Mail.Send` (with
  admin consent, preferably limited to that one mailbox) is still needed.
  Until then the Email reminders button explains what is missing and sends
  nothing.
- `state.nonWorking` has a table (`non_working`) and is round-tripped, but
  nothing in the current frontend renders or edits it — this is the
  root README's still-planned "Non-working time table" feature.

## Shared data and HTML

Names, links and images are shared between everyone, so the frontend must
never put them into HTML as-is. In `public/app.js`, every stored value that
goes into a template goes through `esc()`; links only render if they start
with `http(s)://` (`safeUrl`), and tile images only if they are uploaded
`data:image/` URLs (`safeImage`). The server also refuses any other kind of
link or image in `PATCH /setup`. Keep to this when adding new screens.

## Project layout

```
src/
  app.js, index.js        Express app + startup
  config/                 env, db pool + withTransaction, session, MSAL (Azure AD)
  middleware/              requireAuth, requireRole
  routes/                  auth.routes.js, api.routes.js
  controllers/ / services/ / repositories/
                           Controller -> Service -> Repository, one direction
                           only. Repositories are the only place with raw SQL.
                           setup* = shared setup data, clock* = clocking.
db/
  migrations/              numbered .sql files, tracked in schema_migrations
  scripts/                 migrate.js, promote-admin.js
public/
  index.html, app.js, styles.css   the app (served only to signed-in users)
  login.html                        sign-in page
```
