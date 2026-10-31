'use strict';

const setupService = require('../services/setupService');

async function getState(req, res, next) {
  try {
    res.json(await setupService.getFullState(req.session.user));
  } catch (err) {
    next(err);
  }
}

// Every authenticated user (any role) can edit setup data today -- same as
// the prototype. Add requireRole on the route if that should change.
async function patchSetup(req, res, next) {
  try {
    await setupService.applyPatch(req.body);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
}

module.exports = { getState, patchSetup };
