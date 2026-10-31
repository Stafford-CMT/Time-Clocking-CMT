'use strict';

const usersRepo = require('../repositories/usersRepo');

// req.session.user is a snapshot taken once at /auth/callback -- without
// this, an admin demoting another admin (or deactivating someone) would
// have no effect on that person's ALREADY-established session until it
// expires (SESSION_MAX_AGE_MS) or they log out. Re-checking the live role
// here, on every request, closes that gap: a demotion/deactivation takes
// effect on the very next request, not up to a week later.
module.exports = async function requireAuth(req, res, next) {
  if (!req.session.user) return res.status(401).json({ error: 'Not logged in' });
  try {
    const current = await usersRepo.findById(req.session.user.id);
    if (!current || !current.is_active || !current.included) {
      req.session.destroy(() => {});
      return res.status(401).json({ error: 'Not logged in' });
    }
    // Keep the session's role in sync with the DB so requireRole (and
    // anything else reading req.session.user) always sees the current
    // value, not the one captured at login time.
    req.session.user.userType = current.user_type;
    req.session.user.name = current.name;
    req.session.user.email = current.email;
    next();
  } catch (err) {
    next(err);
  }
};
