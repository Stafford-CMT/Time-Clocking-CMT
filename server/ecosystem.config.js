// If this server already runs a shared Caddy instance for other apps (e.g.
// Gantt's on CMTDC01), this app is just its own PM2 process on its own
// port, reverse-proxied by adding a site block to the EXISTING Caddyfile.
// See Caddyfile-snippet.txt in this folder.
module.exports = {
  apps: [
    {
      name: 'time-clocking-server',
      script: 'src/index.js',
      cwd: __dirname,
      env: { NODE_ENV: 'production' },
    },
  ],
};
