'use strict';

const authService = require('../services/authService');
const env = require('../config/env');

async function login(req, res, next) {
  try {
    const url = await authService.getLoginRedirectUrl();
    res.redirect(url);
  } catch (err) {
    next(err);
  }
}

async function callback(req, res, next) {
  try {
    if (req.query.error) {
      console.error('Azure AD sign-in error:', req.query.error_description || req.query.error);
      return res.redirect('/login.html?error=1');
    }
    const user = await authService.completeLogin(req.query.code);
    // Regenerate the session ID before trusting it with a user identity -- closes a
    // session-fixation window (a pre-planted session ID otherwise rides in as authenticated).
    req.session.regenerate((err) => {
      if (err) return next(err);
      req.session.user = user; // this IS "being logged in" -- nothing else to track
      res.redirect('/');
    });
  } catch (err) {
    if (err.statusCode === 403) {
      // Signed in with Azure AD successfully, but rejected by our own
      // domain allowlist (see usersService.findOrCreateFromAzureClaims) --
      // no session is set, so this is a real sign-in refusal, not a login.
      console.warn('Sign-in rejected:', err.message);
      return res.redirect('/login.html?error=domain');
    }
    next(err);
  }
}

function logout(req, res) {
  req.session.destroy(() => {
    const tenantLogout = `https://login.microsoftonline.com/${env.azure.tenantId}/oauth2/v2.0/logout?post_logout_redirect_uri=${encodeURIComponent(env.azure.postLogoutRedirectUri || '/login.html')}`;
    res.json({ ok: true, redirect: tenantLogout });
  });
}

function whoami(req, res) {
  res.json({ user: req.session.user || null });
}

module.exports = { login, callback, logout, whoami };
