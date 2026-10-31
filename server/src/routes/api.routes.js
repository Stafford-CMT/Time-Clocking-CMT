'use strict';

/* Everything mounted under /api requires a logged-in session (see app.js's
 * requireAuth on this router). Each line below states its own extra role
 * requirement, if any -- reading this file tells you the entire access
 * policy for the API, no permissions matrix to cross-reference elsewhere.
 * Clock/session/commit rules that depend on WHOSE times are being changed
 * live in clockService (own times, or anyone's for an admin).
 */
const express = require('express');
const requireRole = require('../middleware/requireRole');
const authController = require('../controllers/authController');
const setupController = require('../controllers/setupController');
const clockController = require('../controllers/clockController');
const usersController = require('../controllers/usersController');

const router = express.Router();

router.get('/whoami', authController.whoami); // any logged-in session

router.get('/state', setupController.getState); // any logged-in session
router.patch('/setup', setupController.patchSetup); // any logged-in session -- see setupController's comment

router.post('/clock/break/pause', clockController.pauseForBreak); // own clock
router.post('/clock/break/resume', clockController.resumeAfterBreak); // own clock
router.post('/clock/:contractId/start', clockController.start); // own clock
router.post('/clock/:contractId/stop', clockController.stop); // own clock

router.patch('/sessions', clockController.updateSessions); // own sessions, or anyone's for admin
router.delete('/sessions/:id', clockController.removeSession); // own sessions, or anyone's for admin
router.post('/commits/:userId/:date', clockController.commit); // own day, or anyone's for admin
router.delete('/commits/:userId/:date', clockController.uncommit); // admin only (checked in clockService)

router.get('/users', usersController.list); // any logged-in session -- needed for the working-times dropdowns (people in Time Slide only)
router.get('/directory', requireRole('admin'), usersController.directory); // all staff from Entra ID, ticked or not
router.post('/directory/sync', requireRole('admin'), usersController.syncDirectory);
router.put('/users/:id/included', requireRole('admin'), usersController.setIncluded);
router.put('/users/:id/user-type', requireRole('admin'), usersController.setUserType);
router.put('/users/:id/cost-centre', requireRole('admin'), usersController.setCostCentre);

module.exports = router;
