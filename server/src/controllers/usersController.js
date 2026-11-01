'use strict';

const usersService = require('../services/usersService');
const directoryService = require('../services/directoryService');

async function list(req, res, next) {
  try {
    res.json(await usersService.listUsers());
  } catch (err) {
    next(err);
  }
}

async function setUserType(req, res, next) {
  try {
    const user = await usersService.setUserType(req.params.id, req.body.userType, req.session.user.id);
    res.json(user);
  } catch (err) {
    if (err.statusCode) return res.status(err.statusCode).json({ error: err.message });
    next(err);
  }
}

async function setCostCentre(req, res, next) {
  try {
    res.json(await usersService.setCostCentre(req.params.id, req.body.costCentre));
  } catch (err) {
    next(err);
  }
}

async function setAutoClockOut(req, res, next) {
  try {
    res.json(await usersService.setAutoClockOut(req.session.user, req.params.id, req.body.autoClockOut));
  } catch (err) {
    next(err);
  }
}

async function directory(req, res, next) {
  try {
    res.json({ people: await usersService.listDirectory(), sync: directoryService.getStatus() });
  } catch (err) {
    next(err);
  }
}

async function syncDirectory(req, res, next) {
  try {
    const sync = await directoryService.sync();
    res.json({ people: await usersService.listDirectory(), sync });
  } catch (err) {
    next(err);
  }
}

async function setIncluded(req, res, next) {
  try {
    res.json(await usersService.setIncluded(req.params.id, req.body.included, req.session.user.id));
  } catch (err) {
    next(err);
  }
}

module.exports = { list, setUserType, setCostCentre, setAutoClockOut, directory, syncDirectory, setIncluded };
