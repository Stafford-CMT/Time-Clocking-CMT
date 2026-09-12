# Contract Time Tracker

A browser-based internal tool that lets staff clock their time against the contracts the company has landed, using a customizable, tile-based dashboard.

## Status

Initial browser prototype in progress. The current slice is a dependency-free local dashboard that exercises the main clocking workflow before the React/API/PostgreSQL stack is introduced.

## Planned Tech Stack

- **Frontend:** React (with a drag-and-drop library such as `dnd-kit`)
- **Backend:** Node.js + Express (REST API)
- **Database:** PostgreSQL
- **Auth:** Local/dummy login for now; Microsoft 365 login (via Microsoft Entra ID / MSAL) to be added later
- **Hosting:** Windows Server — Node process run as a service (e.g. via PM2 or NSSM), with IIS as a reverse proxy in front of it

This stack is a starting recommendation, not a final decision — it can change as the project develops.

## Architecture Notes

- **No data loss on crash/disconnect:** start/stop events are written to the database immediately when they happen (not batched). The tile's timer display is purely calculated from the stored start time and can refresh periodically (e.g. every second, client-side) without needing a server round-trip. If the app or connection drops mid-session, reloading re-fetches the open session's start time from the database and the timer resumes correctly — nothing is lost because nothing was ever held only in memory.
- **Contract/suffix data source:** lives in a different application's database on a separate server. This app will not connect to that database directly — it will go through an integration layer using whatever protocol that other app exposes (e.g. a REST API, ODBC link, or message queue). Protocol TBD; treat this as an external dependency to confirm with that app's owners.

## Features

### Tile dashboard

Each tile represents one contract clocking session and shows:

- Contract number
- Suffix
- The logged-in user (from Microsoft 365 login, once wired up)
- Accumulated time
- Current session time
- A start/stop button
- An image placeholder
- Support for dragging to reposition and pinning in place

Contract number and suffix are chosen from a dropdown list, ultimately sourced from a separate SQL database.

### Time correction

Users can edit a clocked session after the fact — both the start time (if a session was started late/early) and the end time (if it was stopped incorrectly).

### Non-working time table

An editable table, per user, for logging non-working time (e.g. leave, breaks) separately from contract time.

## Getting Started

### Current prototype

Open `index.html` directly in a browser. No build step or server is required for this first prototype.

The prototype currently includes:

- Persistent start/stop clock state using browser storage, so a refresh resumes an open session.
- Live current-session timers and accumulated contract totals.
- Draggable and pinnable contract tiles.
- A local dummy user and sample contracts.
- Editable non-working-time entries with duration totals.
- Working-times calendar prototype with registered users, 5-minute timeline columns, scheduled start/end times, break blocks, and overtime-window labels.

### Next setup step

Node.js and npm are not currently available on the development machine. Install the current Node.js LTS release before converting this prototype to the planned React frontend and Express API. The external contract/suffix integration, PostgreSQL persistence, and report generation remain intentionally deferred until their interfaces are confirmed. The current browser prototype persists working-time templates locally and automatically pauses/resumes an active contract around the signed-in user's configured break.

## License

_Internal project — add a license here if this is ever shared outside the company._
