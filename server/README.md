# Time-Clocking-CMT — Production Server

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
full API test all pass). Not yet tried with a real Azure AD app
registration or deployed to the server. See "Known gaps".

## One-time setup

### 1. Azure AD (Entra ID) app registration

In the Azure Portal → **App registrations** → New registration:
- Add a redirect URI (Web platform): `https://<your-hostname>/auth/callback`
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
and the `AZURE_*` values from step 1. `.env` is gitignored — never commit it.

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

Sign in once via the app's "Sign in with Microsoft" button (this
auto-creates your account as a `user`), then run:

```
npm run promote-admin -- --email=you@cliffeng.com
```

After that, promote/demote anyone else from **Lists → Users** in the app
(admin-only) — no more CLI needed.

## Running

```
npm start
```

Runs on `PORT` (default 4100) over plain HTTP — put Caddy in front for
HTTPS (see below); `express-session`'s `secure` cookie flag only activates
when `NODE_ENV=production`, so local dev over plain `http://localhost`
still works without Caddy.

### Local development without Azure

Set `NODE_ENV=development` and `DEV_LOGIN_EMAIL=you@cliffeng.com` in `.env`
(the `AZURE_*` values can then be blank). "Sign in with Microsoft" then
signs you straight in as that email (add `DEV_LOGIN_NAME=Your Name` to
show a proper name rather than one built from the email). You still need a PostgreSQL database
and `npm run migrate`. The server refuses to start if `DEV_LOGIN_EMAIL` is
set with `NODE_ENV=production`.

## HTTPS (Caddy)

If the target server already runs a shared Caddy instance for other apps
(e.g. CMTDC01, which serves IO Buddy and Gantt), this app does **not** run
its own Caddy process. Instead, add the site block in
`Caddyfile-snippet.txt` into that existing Caddyfile, then reload it —
see that file for the full steps.

## Deployment (PM2)

```
pm2 start ecosystem.config.js
pm2 save
```

This only adds `time-clocking-server` to whatever else PM2 is already
running on this server — it does not touch your other apps' processes.
Updating a running deployment:

| Changed | Steps |
|---|---|
| Frontend files only (`public/`) | Copy the file(s) over; refresh the browser. No restart. |
| Backend (`src/**`) | Copy the file(s) over; `pm2 restart time-clocking-server`. |
| `package.json` changed | `npm ci --omit=dev` on the server first, then restart. |
| Database schema | Add a new numbered file to `db/migrations/`, copy it over, run `npm run migrate`. Never hand-edit the live schema. |
| `ecosystem.config.js` itself changed | `pm2 delete time-clocking-server` then `pm2 start ecosystem.config.js` — a plain restart won't pick up config changes. |

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
| `GET /users` | User list | anyone |
| `PUT /users/:id/user-type` · `/cost-centre` | Change role / cost centre | admin |

## Roles

- **admin** — can review and edit anyone's times (Edit Times shows a user
  picker), edit committed days, unlock commits, and change users' roles and
  cost centres. The "Admin mode" checkbox is a per-browser safety catch only
  admins see; the server checks the role itself.
- **manager** / **user** — clock, edit and commit their own times, and edit
  shared setup data.

New accounts are always created as `user` on first Microsoft sign-in —
nobody is ever auto-admin or auto-manager.

## Known gaps

- **Setup data is shared and unrestricted:** any signed-in user can edit
  lists, contract information, everyone's working times, and the tile
  layout (pinned/hidden/order is the same for everyone). Saves send only
  changed sections, so stale browsers don't wipe other sections, but two
  people editing the same section at once is still last-write-wins.
- **Breaks need the page open:** the browser notices a scheduled break and
  asks the server to pause/resume; with no tab open, the clock runs through
  the break (same as the prototype).
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
