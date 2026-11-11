'use strict';

const reportsService = require('../services/reportsService');

const handle = (action) => async (req, res, next) => {
  try {
    res.json(await action(req));
  } catch (err) {
    next(err);
  }
};

module.exports = {
  contractHours: handle((req) => reportsService.contractHours(req.session.user, req.query)),
};
