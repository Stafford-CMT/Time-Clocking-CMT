'use strict';

const exportService = require('../services/exportService');

const handle = (action) => async (req, res, next) => {
  try {
    res.json(await action(req));
  } catch (err) {
    next(err);
  }
};

// Sends a spreadsheet from exportService as a download.
const download = (action) => async (req, res, next) => {
  try {
    const { buffer, filename } = await action(req);
    res.set('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.set('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(buffer);
  } catch (err) {
    next(err);
  }
};

module.exports = {
  overview: handle((req) => exportService.overview(req.session.user, req.query)),
  exportTimes: download((req) => exportService.exportTimes(req.session.user, { ...req.query, ...(req.method === 'POST' ? req.body || {} : {}) })),
  blocks: handle((req) => exportService.blocks(req.session.user, req.query)),
  createBatch: download((req) => exportService.createBatch(req.session.user, req.body || {})),
  batchFile: download((req) => exportService.batchFile(req.session.user, req.params.id)),
  undoBatch: handle((req) => exportService.undoBatch(req.session.user, req.params.id)),
  sendReminders: handle((req) => exportService.sendReminders(req.session.user, req.body || {})),
};
