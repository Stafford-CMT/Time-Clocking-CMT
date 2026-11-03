-- Tile pictures move into their own library: stored once as bytes, served by
-- GET /api/images/:id only when a tile on screen needs them (and cached by
-- the browser), instead of riding inside every /api/state as data: URLs.
-- One picture can be on several tiles. The id is made from the picture's
-- bytes, so the same picture uploaded twice is kept once.
-- contracts.image is left as it was so the previous version still runs (it
-- shows the pictures tiles had before this update); a later migration can
-- drop it.

CREATE TABLE images (
  id         TEXT PRIMARY KEY,
  mime       TEXT NOT NULL,
  data       BYTEA NOT NULL,
  name       TEXT NOT NULL DEFAULT '', -- the uploaded file's name, shown in the library
  width      INTEGER,
  height     INTEGER,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE contracts ADD COLUMN image_id TEXT REFERENCES images(id) ON DELETE SET NULL;

-- Existing pictures: data:image/<type>;base64,<data> -> one library row per
-- distinct picture.
INSERT INTO images (id, mime, data, name)
SELECT DISTINCT ON (id) id, mime, data, name FROM (
  SELECT 'img-' || left(encode(sha256(decode(split_part(image, ',', 2), 'base64')), 'hex'), 32) AS id,
         substring(image FROM '^data:([^;,]+)') AS mime,
         decode(split_part(image, ',', 2), 'base64') AS data,
         trim(concat_ws(' ', number, suffix)) AS name
  FROM contracts
  WHERE image ~* '^data:image/[a-z0-9.+-]+;base64,'
) pictures
ORDER BY id, name;

UPDATE contracts SET image_id = 'img-' || left(encode(sha256(decode(split_part(image, ',', 2), 'base64')), 'hex'), 32)
WHERE image ~* '^data:image/[a-z0-9.+-]+;base64,';
