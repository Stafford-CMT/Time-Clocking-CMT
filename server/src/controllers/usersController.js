'use strict';

const usersService = require('../services/usersService');

async function list(req, res, next) {
  try {
    res.json(await usersService.listUsers());
  } catch (err) {
    next(err);
  }
}

async function setUserType(req, res, next) {
  try {
    const user = await usersService.setUserType(req.params.id, req.body.userType, req.session.user.id);
    res.json(user);
  } catch (err) {
    if (err.statusCode) return res.status(err.statusCode).json({ error: err.message });
    next(err);
  }
}

module.exports = { list, setUserType };
