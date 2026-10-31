'use strict';

const sysproService = require('../services/sysproService');

async function getSyspro(req, res, next) {
  try {
    res.json(await sysproService.getSettings());
  } catch (err) {
    next(err);
  }
}

async function saveSyspro(req, res, next) {
  try {
    res.json(await sysproService.saveSettings(req.body, req.session.user.id));
  } catch (err) {
    next(err);
  }
}

async function testSysproEnet(req, res, next) {
  try {
    res.json(await sysproService.testEnet());
  } catch (err) {
    next(err);
  }
}

module.exports = { getSyspro, saveSyspro, testSysproEnet };
