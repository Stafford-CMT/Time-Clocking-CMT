-- Edit Times links are now per end: a block's start can be unlinked from the
-- previous block's end without touching its own end (and vice versa).
-- Blocks that were unlinked as a whole keep both ends unlinked.
ALTER TABLE time_sessions ADD COLUMN unlinked_start BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE time_sessions ADD COLUMN unlinked_end BOOLEAN NOT NULL DEFAULT false;
UPDATE time_sessions SET unlinked_start = unlinked, unlinked_end = unlinked;
ALTER TABLE time_sessions DROP COLUMN unlinked;
