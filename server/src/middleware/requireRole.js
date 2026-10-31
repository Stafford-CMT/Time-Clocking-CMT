'use strict';

// Each route declares its own requirement -- reading this file's call sites
// tells you the entire access policy, no permissions matrix to cross-reference.
// Not used anywhere yet (every authenticated user can read/write full state
// today, same as the localStorage prototype's free user-switcher) -- wired
// up here so it's ready the moment real role-gated actions are introduced.
module.exports = function requireRole(...allowed) {
  return (req, res, next) => {
    if (!req.session.user) return res.status(401).json({ error: 'Not logged in' });
    if (!allowed.includes(req.session.user.userType)) return res.status(403).json({ error: 'Forbidden' });
    next();
  };
};
