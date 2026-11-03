'use strict';

const imagesService = require('../services/imagesService');

const handle = (action) => async (req, res, next) => {
  try {
    res.json(await action(req));
  } catch (err) {
    next(err);
  }
};

// A picture never changes (its id is made from its bytes), so the browser may keep it for good.
async function file(req, res, next) {
  try {
    const image = await imagesService.get(req.params.id);
    res.set({ 'Content-Type': image.mime, 'Cache-Control': 'private, max-age=31536000, immutable' }).send(image.data);
  } catch (err) {
    next(err);
  }
}

module.exports = {
  list: handle(() => imagesService.list()),
  file,
  add: handle((req) => imagesService.add(req.body)),
  remove: handle((req) => imagesService.remove(req.params.id)),
};
