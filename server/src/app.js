'use strict';

const path = require('path');
const express = require('express');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');

const env = require('./config/env');
const sessionMiddleware = require('./config/session');
const requireAuth = require('./middleware/requireAuth');
const authRoutes = require('./routes/auth.routes');
const apiRoutes = require('./routes/api.routes');
const ApiError = require('./utils/ApiError');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');

const app = express();

// Behind Caddy in production -- without this, express-session's
// `secure: true` cookie silently never gets set because Express doesn't
// know the original request was HTTPS (it only sees Caddy's own plain-HTTP
// connection to it).
if (env.nodeEnv === 'production') app.set('trust proxy', 1);

app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      // The frontend ships as plain script/inline-handler files (no build
      // step) -- both need 'unsafe-inline' here or the app fails to run. A
      // nonce-based CSP would be tighter but requires templating index.html
      // per-request; not worth it for a LAN-only app serving no third-party content.
      scriptSrc: ["'self'", "'unsafe-inline'"],
      scriptSrcAttr: ["'unsafe-inline'"],
      // styles.css @imports DM Sans / Space Grotesk from Google Fonts.
      styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
      fontSrc: ["'self'", 'https://fonts.gstatic.com'],
      imgSrc: ["'self'", 'data:'],
      connectSrc: ["'self'"],
      // Production is HTTPS behind Caddy; locally (plain http://localhost)
      // this would make the browser rewrite every request to https and fail.
      upgradeInsecureRequests: env.nodeEnv === 'production' ? [] : null,
    },
  },
}));
app.use(express.json({ limit: '15mb' })); // contract tile images ride as data: URLs, same limit as the localStorage prototype allowed
app.use(sessionMiddleware);

// Development sign-in is exempt: switching between test accounts would
// otherwise hit the limit within minutes.
app.use('/auth', rateLimit({ windowMs: 15 * 60 * 1000, max: 20, skip: () => Boolean(env.devLoginEmail) }), authRoutes);

// login.html (and its icon) must load before anyone can log in; everything
// else in public/ requires a session, including index.html itself.
app.get('/login.html', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'login.html')));
app.get('/favicon.svg', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'favicon.svg')));

app.use('/api', requireAuth, apiRoutes);

app.use((req, res, next) => {
  if (!req.session.user && req.path !== '/login.html') return res.redirect('/login.html');
  next();
}, express.static(PUBLIC_DIR));

// Single error-handling middleware, mounted last. Only an intentional
// ApiError's message is ever sent to the client -- an unexpected exception
// (a raw MSAL/pg error, say) could otherwise leak internal detail to an
// unauthenticated caller (e.g. via /auth/callback, reachable pre-session).
app.use((err, req, res, next) => {
  if (err instanceof ApiError) {
    return res.status(err.statusCode).json({ error: err.message });
  }
  console.error(err);
  res.status(500).json({ error: 'Internal server error' });
});

module.exports = app;
