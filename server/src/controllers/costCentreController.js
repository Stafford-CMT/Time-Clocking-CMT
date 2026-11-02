'use strict';

const costCentreService = require('../services/costCentreService');

const handle = (action) => async (req, res, next) => {
  try {
    res.json(await action(req));
  } catch (err) {
    next(err);
  }
};

module.exports = {
  rename: handle((req) => costCentreService.rename(req.params.name, req.body && req.body.name)),
  remove: handle((req) => costCentreService.remove(req.params.name)),
};
