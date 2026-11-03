-- Tiles come from Contract information: every suffix row with a letter (on a
-- contract with a number) has one tile, kept up to date from it by
-- setupRepo.syncContractTiles. contract_info_suffix_id links the two; it has
-- no foreign key because replaceContractInfo deletes and re-inserts the whole
-- table on every save. NULL = a tile made by hand (+ Add a new tile).
-- Removing the suffix (or its contract) deletes the tile, or retires it when
-- time has been clocked on it: retired tiles are on no dashboard and not in
-- Add tile, but their time stays in Edit times and Data export.
-- The previous version still runs on this schema (it ignores both columns).

ALTER TABLE contracts ADD COLUMN contract_info_suffix_id TEXT;
ALTER TABLE contracts ADD COLUMN retired BOOLEAN NOT NULL DEFAULT false;
CREATE UNIQUE INDEX idx_contracts_info_suffix ON contracts(contract_info_suffix_id) WHERE contract_info_suffix_id IS NOT NULL;

-- Existing tiles take over the suffix row with the same contract number and
-- suffix letter, so they keep their image, layout and time. Where several
-- tiles match one suffix, the one with the most time blocks (then the oldest)
-- is linked; the others stay hand-made tiles.
WITH candidates AS (
  SELECT DISTINCT ON (s.id) s.id AS suffix_id, c.id AS contract_id
  FROM contract_info_suffixes s
  JOIN contract_info i ON i.id = s.contract_info_id
  JOIN contracts c ON NOT c.system
    AND upper(trim(c.number)) = upper(trim(i.number))
    AND upper(trim(c.suffix)) = upper(trim(s.letter))
  WHERE trim(i.number) <> '' AND trim(s.letter) <> ''
  ORDER BY s.id, (SELECT count(*) FROM time_sessions t WHERE t.contract_id = c.id) DESC, c.sort_order
),
one_per_tile AS (
  SELECT DISTINCT ON (contract_id) suffix_id, contract_id FROM candidates ORDER BY contract_id, suffix_id
)
UPDATE contracts c SET contract_info_suffix_id = o.suffix_id FROM one_per_tile o WHERE c.id = o.contract_id;
