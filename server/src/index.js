'use strict';

const env = require('./config/env');
const app = require('./app');
const setupService = require('./services/setupService');
const directoryService = require('./services/directoryService');
const clockService = require('./services/clockService');

async function main() {
  await setupService.ensureSeeded();
  // Bound to localhost only -- this port is an internal handoff to the
  // Caddy reverse proxy on the same machine, never reachable directly from
  // the network (Caddy is the only thing anyone else ever talks to).
  app.listen(env.port, '127.0.0.1', () => {
    console.log(`Time Slide server running on 127.0.0.1:${env.port} (behind Caddy for HTTPS).`);
  });
  directoryService.startSchedule();
  clockService.startClockSchedule(); // breaks and auto clock-out
}

main().catch((err) => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
