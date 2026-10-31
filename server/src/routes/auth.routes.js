'use strict';

const express = require('express');
const authController = require('../controllers/authController');

const router = express.Router();

router.get('/login', authController.login);
router.get('/callback', authController.callback);
router.post('/logout', authController.logout);
router.get('/dev-accounts', authController.devAccounts);

module.exports = router;
