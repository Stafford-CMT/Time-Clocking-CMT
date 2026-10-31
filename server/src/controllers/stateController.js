'use strict';

const stateService = require('../services/stateService');

async function getState(req, res) {
  try {
    res.json(await stateService.getFullState());
  } catch (err) {
    console.error('GET /api/state failed:', err);
    res.status(500).json({ error: 'Failed to load state' });
  }
}

// Every authenticated user (any role) can write here today -- same as the
// localStorage prototype, where the "current user" dropdown had no real
// access control. See requireRole.js's comment if/when that changes.
async function putState(req, res) {
  try {
    await stateService.replaceFullState(req.body || {});
    res.json({ ok: true });
  } catch (err) {
    console.error('PUT /api/state failed:', err);
    res.status(500).json({ error: 'Failed to save state' });
  }
}

module.exports = { getState, putState };
