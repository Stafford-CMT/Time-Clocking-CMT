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
// the prototype -- except the admin-only sections setupService refuses
// (default working times, cost centres).
async function patchSetup(req, res, next) {
  try {
    await setupService.applyPatch(req.body, req.session.user);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
}

module.exports = { getState, patchSetup };
