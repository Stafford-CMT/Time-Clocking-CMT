'use strict';

const sysproService = require('../services/sysproService');
const sysproBrowseService = require('../services/sysproBrowseService');

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

module.exports = { getSyspro, saveSyspro, testSysproEnet, testSysproSql, listSysproTables, readSysproTable };
