'use strict';

const sysproService = require('../services/sysproService');
const sysproBrowseService = require('../services/sysproBrowseService');
const sysproJobsService = require('../services/sysproJobsService');
const sysproWorkCentresRepo = require('../repositories/sysproWorkCentresRepo');
const { getPool } = require('../config/db');
const ApiError = require('../utils/ApiError');

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

async function testSysproSql(req, res, next) {
  try {
    res.json(await sysproService.testSql());
  } catch (err) {
    next(err);
  }
}

async function listSysproTables(req, res, next) {
  try {
    res.json(await sysproBrowseService.listTables());
  } catch (err) {
    next(err);
  }
}

async function readSysproTable(req, res, next) {
  try {
    res.json(await sysproBrowseService.readTable({
      schema: req.params.schema,
      name: req.params.name,
      page: req.query.page,
      filterColumn: req.query.column,
      filterText: req.query.find,
    }));
  } catch (err) {
    next(err);
  }
}

async function sysproJobHours(req, res, next) {
  try {
    res.json(await sysproJobsService.jobHours({ from: req.query.from, to: req.query.to }));
  } catch (err) {
    next(err);
  }
}

// Syspro work centre per department (migration 022): ASSY, DESI, or null = not sent to Syspro.
async function listWorkCentres(req, res, next) {
  try {
    res.json(await sysproWorkCentresRepo.list(getPool()));
  } catch (err) {
    next(err);
  }
}

async function setWorkCentre(req, res, next) {
  try {
    const department = String(req.params.department || '').trim();
    const workCentre = req.body ? req.body.workCentre : undefined;
    if (!department || department.length > 200) throw new ApiError(400, 'Choose a department');
    if (workCentre !== null && workCentre !== 'ASSY' && workCentre !== 'DESI') throw new ApiError(400, 'The work centre must be ASSY, DESI or none');
    const db = getPool();
    await sysproWorkCentresRepo.set(db, department, workCentre, req.session.user.id);
    res.json(await sysproWorkCentresRepo.list(db));
  } catch (err) {
    next(err);
  }
}

module.exports = { getSyspro, saveSyspro, testSysproEnet, testSysproSql, listSysproTables, readSysproTable, sysproJobHours, listWorkCentres, setWorkCentre };
