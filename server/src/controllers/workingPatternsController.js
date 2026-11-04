'use strict';

const workingPatternsService = require('../services/workingPatternsService');

const handle = (action) => async (req, res, next) => {
  try {
    res.json(await action(req));
  } catch (err) {
    next(err);
  }
};

module.exports = {
  create: handle((req) => workingPatternsService.create(req.body)),
  save: handle((req) => workingPatternsService.save(req.params.id, req.body)),
  remove: handle((req) => workingPatternsService.remove(req.params.id)),
  makeDefault: handle((req) => workingPatternsService.makeDefault(req.params.id)),
  assign: handle((req) => workingPatternsService.assign(req.session.user, req.params.id, req.body && req.body.patternId)),
};
