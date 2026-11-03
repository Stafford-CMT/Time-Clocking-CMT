'use strict';

/* Tile pictures. The browser shrinks a picture before uploading it (about
 * 1280px across, JPEG), so uploads are small; the limit here only stops
 * something unreasonable getting in. Anyone signed in can add a picture or
 * delete one no tile uses, like the rest of the setup lists. */
const crypto = require('crypto');
const imagesRepo = require('../repositories/imagesRepo');
const { getPool } = require('../config/db');
const ApiError = require('../utils/ApiError');

const MAX_BYTES = 3 * 1024 * 1024;
const TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];

const idFor = (data) => `img-${crypto.createHash('sha256').update(data).digest('hex').slice(0, 32)}`;

async function list() {
  return imagesRepo.list(getPool());
}

async function get(id) {
  const image = await imagesRepo.get(getPool(), id);
  if (!image) throw new ApiError(404, 'Picture not found');
  return image;
}

async function add(body) {
  const match = /^data:([^;,]+);base64,(.+)$/s.exec((body && body.dataUrl) || '');
  if (!match || !TYPES.includes(match[1].toLowerCase())) throw new ApiError(400, 'Choose a JPEG, PNG, WebP or GIF picture');
  const data = Buffer.from(match[2], 'base64');
  if (!data.length) throw new ApiError(400, 'The picture is empty');
  if (data.length > MAX_BYTES) throw new ApiError(400, 'The picture is too large (3 MB at most)');
  const size = (n) => (Number.isInteger(n) && n > 0 && n < 100000 ? n : null);
  const image = { id: idFor(data), mime: match[1].toLowerCase(), data, name: String(body.name || '').trim().slice(0, 200), width: size(body.width), height: size(body.height) };
  await imagesRepo.add(getPool(), image);
  return { id: image.id };
}

async function remove(id) {
  const db = getPool();
  const tiles = await imagesRepo.usage(db, id);
  if (tiles) throw new ApiError(409, `This picture is on ${tiles} ${tiles === 1 ? 'tile' : 'tiles'}; change ${tiles === 1 ? 'its' : 'their'} picture first`);
  await imagesRepo.remove(db, id);
  return { ok: true };
}

module.exports = { list, get, add, remove };
