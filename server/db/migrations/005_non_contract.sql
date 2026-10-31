-- "Non-contract": a built-in clock for time that isn't booked to a contract
-- (dashboard card, always the first row in Edit times). It lives in contracts
-- so clocks, breaks, Edit times and commits treat it like any other, but it
-- is never a tile and can't be edited or reordered.
ALTER TABLE contracts ADD COLUMN system BOOLEAN NOT NULL DEFAULT false;
INSERT INTO contracts (id, customer_name, system, sort_order) VALUES ('non-contract', 'Non-contract', true, -1);
