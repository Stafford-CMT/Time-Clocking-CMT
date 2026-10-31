# Contract Time Tracker

A browser-based internal tool that lets staff clock their time against the contracts the company has landed, using a customizable, tile-based dashboard.

## Status

The app runs as a Node.js + Express server backed by PostgreSQL, with Microsoft 365 (Entra ID) sign-in. Everything lives in [`server/`](server/) — the frontend is in `server/public/`. See [`server/README.md`](server/README.md) for setup, deployment, the API, and known gaps.

It has not yet been run against a real PostgreSQL server or Azure AD app registration.

## Tech Stack

- **Frontend:** plain HTML/CSS/JavaScript, no build step (`server/public/`)
- **Backend:** Node.js + Express (REST API)
- **Database:** PostgreSQL
- **Auth:** Microsoft 365 login via Microsoft Entra ID (MSAL), with a local-development sign-in shortcut
- **Hosting:** Windows Server — Node process run under PM2, with Caddy as the HTTPS reverse proxy

## Architecture Notes

- **No data loss on crash/disconnect:** start/stop events are written to the database immediately when they happen (not batched), timed by the server. The tile's timer display is calculated from the stored start time and refreshes every second client-side. If the app or connection drops mid-session, reloading re-fetches the open session's start time and the timer resumes correctly.
- **Contract/suffix data source:** lives in a different application's database on a separate server. This app will not connect to that database directly — it will go through an integration layer using whatever protocol that other app exposes (e.g. a REST API, ODBC link, or message queue). Protocol TBD; treat this as an external dependency to confirm with that app's owners. Until then, contract numbers and suffixes are entered on the Contract information page.

## Features

### Tile dashboard

Each tile represents one contract and shows the contract number and suffix, machine type, an image, your accumulated and current-session time, and a start/stop button. Tiles can be dragged to reposition, pinned in place, and hidden. Starting one contract stops whichever one you had running.

### Working times and breaks

Each user has a working-time schedule with breaks. A running clock pauses automatically when your break starts and resumes when it ends (while the app is open).

### Edit or Commit times

A per-day timeline of your recorded time blocks. Drag a block's edges to correct start/end times (linked neighbours move with it; long-press a block to unlink it), double-click to delete. Committing a day locks it; only an admin can edit or unlock a committed day. Admins can view and correct anyone's times.

### Non-working time table (planned)

An editable table, per user, for logging non-working time (e.g. leave) separately from contract time. The database table exists; there is no screen for it yet.

## Getting Started

See [`server/README.md`](server/README.md). In short: create a PostgreSQL database, copy `server/.env.example` to `server/.env` and fill it in, then in `server/` run `npm install`, `npm run migrate`, `npm start`, and open http://localhost:4100.

## License

_Internal project — add a license here if this is ever shared outside the company._
