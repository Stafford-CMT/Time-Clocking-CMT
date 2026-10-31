# Time-Clocking-CMT — Production Server

Express + PostgreSQL backend, with per-user sign-in via Microsoft/Entra ID
(Azure AD) SSO. Three roles carried over from the browser prototype's
`userType` field: **admin**, **manager**, **user**. Every authenticated user
can currently read/write the full app state — same as the prototype's
free "act as any user" dropdown had no real access control. `requireRole`
is wired up and ready (see `src/middleware/requireRole.js`) for whenever
real per-role restrictions are wanted.

Built following the same process as the Design Plan Gantt board
(`../Design Plan/Gantt-App-Production/server`) — see
`../Login Security and Deployment Blueprint.pdf` and
`../Windows App Deployment Runbook.md` for the general pattern this project
follows (Express + Postgres, `express-session`, PM2, Caddy). Like the Gantt
board, this deviates from the base blueprint by using Azure AD SSO instead
of bcrypt/password auth.

## Status: backend built, not yet wired to the frontend

This `server/` folder is a complete, self-contained backend (schema,
migrations, Express app, Azure AD login flow) but the existing prototype
frontend (`../index.html`, `../app.js`, `../styles.css` at the repo root)
still reads/writes `localStorage` directly — it has **not** been rewired to
call this API yet. That's a separate, larger change (async state loading,
a real login page instead of the "act as any user" dropdown, moving the
frontend files under `public/` so this server can serve them) and deserves
its own review before touching the working prototype. See "Known gaps"
below.

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

This creates the schema (`db/migrations/001_initial_schema.sql`) and tracks
applied migrations in `schema_migrations`. On first run against an empty
database, starting the server also seeds a small set of placeholder demo
contracts (see `stateService.ensureSeeded`) — delete them from the app once
real contracts are entered.

### 5. Bootstrap the first admin

Sign in once via the app's "Sign in with Microsoft" button (this
auto-creates your account as a `user`), then run:

```
npm run promote-admin -- --email=you@cliffeng.com
```

After that, promote/demote anyone else via `PUT /api/users/:id/user-type`
(admin-only) — no more CLI needed. (No in-app Users panel wired up to this
endpoint yet — see "Known gaps".)

## Running

```
npm start
```

Runs on `PORT` (default 4100) over plain HTTP — put Caddy in front for
HTTPS (see below); `express-session`'s `secure` cookie flag only activates
when `NODE_ENV=production`, so local dev over plain `http://localhost`
still works without Caddy.

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
| Frontend files only (once served from `public/`) | Copy the file(s) over; refresh the browser. No restart. |
| Backend (`src/**`) | Copy the file(s) over; `pm2 restart time-clocking-server`. |
| `package.json` changed | `npm ci --omit=dev` on the server first, then restart. |
| Database schema | Add a new numbered file to `db/migrations/`, copy it over, run `npm run migrate`. Never hand-edit the live schema. |
| `ecosystem.config.js` itself changed | `pm2 delete time-clocking-server` then `pm2 start ecosystem.config.js` — a plain restart won't pick up config changes. |

## Roles

- **admin** — intended for full read/write plus user management (the
  management endpoint exists; nothing in the frontend calls it yet)
- **manager** / **user** — currently identical access to admin (every
  authenticated session can read/write full state) — see the note at the
  top of this file

New accounts are always created as `user` on first Microsoft sign-in —
nobody is ever auto-admin or auto-manager.

## Known gaps ported as-is from the prototype

- `state.nonWorking` has a table (`non_working`) and is round-tripped
  through `GET`/`PUT /api/state`, but nothing in the current frontend
  renders or edits it (same as in the localStorage version) — this is the
  README's still-planned "Non-working time table" feature.
- `app_settings.admin_mode` is carried over as a manual global toggle
  (the "Admin mode" checkbox that unlocks editing committed dates), not
  derived from `users.user_type`. Worth revisiting once real roles are
  wired into the frontend, since right now any signed-in user can flip it.

## Project layout

```
src/
  app.js, index.js        Express app + startup
  config/                 env, db pool, session, MSAL (Azure AD)
  middleware/              requireAuth, requireRole
  routes/                  auth.routes.js, api.routes.js
  controllers/ / services/ / repositories/
                           Controller -> Service -> Repository, one direction
                           only. Repositories are the only place with raw SQL.
db/
  migrations/              numbered .sql files, tracked in schema_migrations
  scripts/                 migrate.js, promote-admin.js
public/
  login.html               (index.html/app.js not yet moved here — see Status)
```
