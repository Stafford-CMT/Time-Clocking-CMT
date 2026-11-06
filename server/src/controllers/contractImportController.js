'use strict';

const contractImportService = require('../services/contractImportService');

module.exports = {
  // The workbook of today's Contract information, to add rows to.
  async workbook(req, res, next) {
    try {
      const { buffer, filename } = await contractImportService.workbook();
      res.set('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.set('Content-Disposition', `attachment; filename="${filename}"`);
      res.send(buffer);
    } catch (err) {
      next(err);
    }
  },
  // body: dataUrl (the .xlsx), apply (false = check only)
  async importWorkbook(req, res, next) {
    try {
      res.json(await contractImportService.importWorkbook(req.body || {}));
    } catch (err) {
      next(err);
    }
  },
};
