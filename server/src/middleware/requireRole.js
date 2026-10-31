'use strict';

// Each route declares its own requirement -- reading this file's call sites
// tells you the entire access policy, no permissions matrix to cross-reference.
// Currently gates user management (see api.routes.js). Rules that depend on
// whose data is touched (own times vs. an admin editing anyone's) can't be
// expressed per-route and live in clockService instead.
module.exports = function requireRole(...allowed) {
  return (req, res, next) => {
    if (!req.session.user) return res.status(401).json({ error: 'Not logged in' });
    if (!allowed.includes(req.session.user.userType)) return res.status(403).json({ error: 'Forbidden' });
    next();
  };
};
