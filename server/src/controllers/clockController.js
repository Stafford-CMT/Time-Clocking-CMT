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
  start: handle((req) => clockService.start(req.session.user, req.params.contractId, req.body && req.body.reworkReason)),
  stop: handle((req) => clockService.stop(req.session.user, req.params.contractId)),
  updateSessions: handle((req) => clockService.updateSessions(req.session.user, req.body && req.body.changes)),
  removeSession: handle((req) => clockService.removeSession(req.session.user, req.params.id)),
  restoreSession: handle((req) => clockService.restoreSession(req.session.user, req.body && req.body.session)),
  addSession: handle((req) => clockService.addSession(req.session.user, req.body)),
  takeSession: handle((req) => clockService.addSession(req.session.user, req.body, { take: true })),
  commit: handle((req) => clockService.commit(req.session.user, req.params.userId, req.params.date)),
  markAutoNoticed: handle((req) => clockService.markAutoNoticed(req.session.user, req.body && req.body.ids)),
};
