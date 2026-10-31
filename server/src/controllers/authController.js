'use strict';

const authService = require('../services/authService');
const env = require('../config/env');

// Regenerate the session ID before trusting it with a user identity -- closes a
// session-fixation window (a pre-planted session ID otherwise rides in as authenticated).
function signIn(req, res, next, user) {
  req.session.regenerate((err) => {
    if (err) return next(err);
    req.session.user = user; // this IS "being logged in" -- nothing else to track
    res.redirect('/');
  });
}

async function login(req, res, next) {
  try {
    if (env.devLoginEmail) return signIn(req, res, next, await authService.devLogin(req.query.as || 'admin'));
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
    signIn(req, res, next, await authService.completeLogin(req.query.code));
  } catch (err) {
    if (err.statusCode === 403) {
      // Signed in with Azure AD successfully, but refused by our own checks
      // (domain allowlist, or not ticked into Time Slide -- see
      // usersService.findOrCreateFromAzureClaims). No session is set.
      console.warn('Sign-in rejected:', err.message);
      return res.redirect(`/login.html?error=${err.reason || 'domain'}`);
    }
    next(err);
  }
}

function logout(req, res) {
  req.session.destroy(() => {
    if (env.devLoginEmail) return res.json({ ok: true, redirect: '/login.html' });
    const tenantLogout = `https://login.microsoftonline.com/${env.azure.tenantId}/oauth2/v2.0/logout?post_logout_redirect_uri=${encodeURIComponent(env.azure.postLogoutRedirectUri || '/login.html')}`;
    res.json({ ok: true, redirect: tenantLogout });
  });
}

function whoami(req, res) {
  res.json({ user: req.session.user || null });
}

// The sign-in page asks this to decide whether to offer the development
// accounts; always empty outside development sign-in.
function devAccounts(req, res) {
  res.json({ accounts: authService.devAccounts().map(({ role, name }) => ({ role, name })) });
}

module.exports = { login, callback, logout, whoami, devAccounts };
