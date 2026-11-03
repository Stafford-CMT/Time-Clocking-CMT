'use strict';

/* The tile picture library (migration 014). A picture's id comes from its
 * bytes, so uploading the same picture again finds the one already kept. */

async function list(db) {
  return (await db.query(
    `SELECT i.id, i.name, i.width, i.height, i.created_at,
       (SELECT count(*)::int FROM contracts c WHERE c.image_id = i.id AND NOT c.retired) AS tiles
     FROM images i ORDER BY i.created_at DESC, i.id`
  )).rows.map((r) => ({ id: r.id, name: r.name, width: r.width, height: r.height, tiles: r.tiles }));
}

async function get(db, id) {
  return (await db.query('SELECT mime, data FROM images WHERE id = $1', [id])).rows[0] || null;
}

async function exists(db, id) {
  return (await db.query('SELECT 1 FROM images WHERE id = $1', [id])).rowCount > 0;
}

async function add(db, { id, mime, data, name, width, height }) {
  await db.query(
    'INSERT INTO images (id, mime, data, name, width, height) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (id) DO NOTHING',
    [id, mime, data, name, width, height]
  );
}

// Tiles (retired ones too: their time is still shown) using the picture.
async function usage(db, id) {
  return (await db.query('SELECT count(*)::int AS n FROM contracts WHERE image_id = $1', [id])).rows[0].n;
}

async function remove(db, id) {
  await db.query('DELETE FROM images WHERE id = $1', [id]);
}

module.exports = { list, get, exists, add, usage, remove };
