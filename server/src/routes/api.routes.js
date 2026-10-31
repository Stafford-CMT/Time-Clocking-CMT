'use strict';

/* Everything mounted under /api requires a logged-in session (see app.js's
 * requireAuth on this router). Each line below states its own extra role
 * requirement, if any -- reading this file tells you the entire access
 * policy for the API, no permissions matrix to cross-reference elsewhere.
 */
const express = require('express');
const requireRole = require('../middleware/requireRole');
const authController = require('../controllers/authController');
const stateController = require('../controllers/stateController');
const usersController = require('../controllers/usersController');

const router = express.Router();

router.get('/whoami', authController.whoami); // any logged-in session

router.get('/state', stateController.getState); // any logged-in session (read)
router.put('/state', stateController.putState); // any logged-in session (write) -- see stateController's comment

router.get('/users', usersController.list); // any logged-in session -- needed for the user-switcher / working-times dropdowns
router.put('/users/:id/user-type', requireRole('admin'), usersController.setUserType);

module.exports = router;
