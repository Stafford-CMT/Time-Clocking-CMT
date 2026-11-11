'use strict';

/* Everything mounted under /api requires a logged-in session (see app.js's
 * requireAuth on this router). Each line below states its own extra role
 * requirement, if any -- reading this file tells you the entire access
 * policy for the API, no permissions matrix to cross-reference elsewhere.
 * Clock/session/commit rules that depend on WHOSE times are being changed
 * live in clockService (own times, or anyone's for an admin).
 */
const express = require('express');
const requireRole = require('../middleware/requireRole');
const authController = require('../controllers/authController');
const setupController = require('../controllers/setupController');
const clockController = require('../controllers/clockController');
const usersController = require('../controllers/usersController');
const configController = require('../controllers/configController');
const exportController = require('../controllers/exportController');
const costCentreController = require('../controllers/costCentreController');
const imagesController = require('../controllers/imagesController');
const workingPatternsController = require('../controllers/workingPatternsController');
const contractImportController = require('../controllers/contractImportController');
const reportsController = require('../controllers/reportsController');

const router = express.Router();

router.get('/whoami', authController.whoami); // any logged-in session
router.put('/me/theme', usersController.setTheme); // your own light/dark choice (body: theme)

router.get('/state', setupController.getState); // any logged-in session
router.patch('/setup', setupController.patchSetup); // any logged-in session -- see setupController's comment

router.get('/contract-info/workbook', requireRole('admin'), contractImportController.workbook); // Contract information as Excel, to add missing rows to
router.post('/contract-info/import', requireRole('admin'), contractImportController.importWorkbook); // body: dataUrl, apply -- only adds; differences are reported, never saved

router.get('/images', imagesController.list); // any logged-in session -- the tile picture library
router.get('/images/:id', imagesController.file); // any logged-in session
router.post('/images', imagesController.add); // any logged-in session
router.delete('/images/:id', imagesController.remove); // any logged-in session; refused while a tile uses it

router.post('/clock/:contractId/start', clockController.start); // own clock
router.post('/clock/:contractId/stop', clockController.stop); // own clock

router.patch('/sessions', clockController.updateSessions); // own sessions, or anyone's for admin
router.post('/sessions', clockController.restoreSession); // undo a removed block (only one that was really removed): own sessions, or anyone's for admin
router.post('/sessions/take', clockController.takeSession); // the same, drawn over other time: the blocks under it are trimmed or split (never a running clock)
router.post('/sessions/add', clockController.addSession); // time entered by hand (body: contractId, userId, date, start, end, reworkReason?): own, or anyone's for admin; last 28 days
router.delete('/sessions/:id', clockController.removeSession); // own sessions, or anyone's for admin
router.put('/sessions/:id/department', clockController.setSessionDepartment); // body: department; own sessions, or anyone's for admin
router.put('/me/working-department', clockController.setWorkingDepartment); // body: department (null = your own); for today, splits a running clock
router.post('/commits/:userId/:date', clockController.commit); // own day, or anyone's for admin
router.post('/sessions/auto-noticed', clockController.markAutoNoticed); // own sessions: the "stopped automatically" message was seen

router.get('/users', usersController.list); // any logged-in session -- needed for the working-times dropdowns (people in Time Slide only)
router.get('/directory', requireRole('admin', 'manager'), usersController.directory); // staff from Entra ID, ticked or not: everyone for an admin, their team for a manager
router.post('/directory/sync', requireRole('admin'), usersController.syncDirectory);
router.put('/users/:id/included', requireRole('admin', 'manager'), usersController.setIncluded); // a manager: people in their team who are Users (checked in usersService)
router.put('/users/:id/user-type', requireRole('admin'), usersController.setUserType);
router.put('/users/:id/cost-centre', requireRole('admin'), usersController.setCostCentre);
router.put('/cost-centres/:name', requireRole('admin'), costCentreController.rename); // renames it for everyone who has it too
router.delete('/cost-centres/:name', requireRole('admin'), costCentreController.remove); // refused while anyone has it
router.put('/users/:id/auto-clock-out', usersController.setAutoClockOut); // own, or anyone's for admin (checked in usersService)
router.put('/users/:id/working-pattern', requireRole('admin', 'manager'), workingPatternsController.assign); // body: patternId ('' = none); a manager: people in their team (checked in workingPatternsService)

router.post('/working-patterns', requireRole('admin', 'manager'), workingPatternsController.create); // body: name, copyFrom
router.put('/working-patterns/:id', requireRole('admin', 'manager'), workingPatternsController.save); // body: name, days (all seven)
router.delete('/working-patterns/:id', requireRole('admin', 'manager'), workingPatternsController.remove); // refused while anyone is on it, or for the default
router.put('/working-patterns/:id/default', requireRole('admin', 'manager'), workingPatternsController.makeDefault); // the pattern new people start on

router.get('/export/overview', exportController.overview); // own days, or everyone's for admin (checked in exportService)
router.get('/export/times', exportController.exportTimes); // preview spreadsheet, marks nothing: own times, a manager's team, or everyone's for admin
router.post('/export/times', exportController.exportTimes); // the same, for just the time blocks the in-app preview's filters show (body: from, to, ids)
router.get('/export/blocks', exportController.blocks); // the in-app preview's time blocks: same scope as above
router.post('/export/batches', requireRole('admin'), exportController.createBatch); // download = mark committed days as exported
router.get('/export/batches/:id/file', requireRole('admin'), exportController.batchFile);
router.delete('/export/batches/:id', requireRole('admin'), exportController.undoBatch);
router.post('/export/reminders', requireRole('admin'), exportController.sendReminders); // emails people with uncommitted days

router.get('/reports/contract-hours', reportsController.contractHours); // any logged-in session, everyone's contract time (query: from, to)

router.get('/config/syspro',requireRole('admin'), configController.getSyspro); // passwords come back only as "set" flags
router.put('/config/syspro', requireRole('admin'), configController.saveSyspro);
router.post('/config/syspro/test-enet', requireRole('admin'), configController.testSysproEnet);
router.post('/config/syspro/test-sql', requireRole('admin'), configController.testSysproSql);
router.get('/config/syspro/tables', requireRole('admin'), configController.listSysproTables);
router.get('/config/syspro/tables/:schema/:name', requireRole('admin'), configController.readSysproTable);

module.exports = router;
