# Contract Time Tracker

A browser-based internal tool that lets staff clock their time against the contracts the company has landed, using a customizable, tile-based dashboard.

## Status

Early planning — no code written yet. This README doubles as a working spec while the project takes shape.

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

_To be filled in once the project is scaffolded (install steps, environment variables, how to run it locally)._

## License

_Internal project — add a license here if this is ever shared outside the company._
