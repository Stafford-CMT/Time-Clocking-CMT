'use strict';

const clockService = require('../services/clockService');

// Each handler acts as the signed-in user (req.session.user) and responds
// with the refreshed clock state.
const handle = (action) => async (req, res, next) => {
  try {
    res.json(await action(req));
  } catch (err) {
    next(err);
  }
};

module.exports = {
  start: handle((req) => clockService.start(req.session.user, req.params.contractId)),
  stop: handle((req) => clockService.stop(req.session.user, req.params.contractId)),
  updateSessions: handle((req) => clockService.updateSessions(req.session.user, req.body && req.body.changes)),
  removeSession: handle((req) => clockService.removeSession(req.session.user, req.params.id)),
  restoreSession: handle((req) => clockService.restoreSession(req.session.user, req.body && req.body.session)),
  commit: handle((req) => clockService.commit(req.session.user, req.params.userId, req.params.date)),
  uncommit: handle((req) => clockService.uncommit(req.session.user, req.params.userId, req.params.date)),
  markAutoNoticed: handle((req) => clockService.markAutoNoticed(req.session.user, req.body && req.body.ids)),
};
