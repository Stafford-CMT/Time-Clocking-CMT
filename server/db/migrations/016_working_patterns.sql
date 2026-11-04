-- Working patterns (Lists -> Working patterns): named weekly patterns such as
-- "Normal start" and "Early start", each with its own times per day of the
-- week, and each person on one pattern (users.working_pattern_id). They
-- replace the per-person working_times, which are kept untouched for rollback.
--
-- A day is 'own' (its own start, end and breaks), 'same' (follows Monday) or
-- 'off' (not a working day: no hours or breaks; a forgotten clock still stops
-- at Monday's auto clock-out). Monday is always 'own'. weekday is ISO: 1 =
-- Monday ... 7 = Sunday. One pattern is the default for people newly ticked
-- into Time Slide.
CREATE TABLE working_patterns (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  is_default BOOLEAN NOT NULL DEFAULT false
);
CREATE UNIQUE INDEX working_patterns_name_key ON working_patterns (lower(name));
CREATE UNIQUE INDEX working_patterns_one_default ON working_patterns (is_default) WHERE is_default;

CREATE TABLE working_pattern_days (
  pattern_id TEXT NOT NULL REFERENCES working_patterns(id) ON DELETE CASCADE,
  weekday    SMALLINT NOT NULL CHECK (weekday BETWEEN 1 AND 7),
  mode       TEXT NOT NULL CHECK (mode IN ('own', 'same', 'off')),
  start      TIME,
  "end"      TIME,
  PRIMARY KEY (pattern_id, weekday),
  CHECK (weekday <> 1 OR mode = 'own'),
  CHECK (mode <> 'own' OR (start IS NOT NULL AND "end" IS NOT NULL AND "end" > start))
);

CREATE TABLE working_pattern_breaks (
  id         TEXT PRIMARY KEY,
  pattern_id TEXT NOT NULL,
  weekday    SMALLINT NOT NULL,
  start      TIME NOT NULL,
  "end"      TIME NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY (pattern_id, weekday) REFERENCES working_pattern_days(pattern_id, weekday) ON DELETE CASCADE
);

ALTER TABLE users ADD COLUMN working_pattern_id TEXT REFERENCES working_patterns(id) ON DELETE SET NULL;

-- A new pattern: Monday and Friday with these times and breaks (Friday is
-- its own day, ready to be made shorter), Tuesday to Thursday the same as
-- Monday, the weekend off.
CREATE FUNCTION pg_temp.add_pattern(p_id TEXT, p_name TEXT, p_sort INTEGER, p_start TIME, p_end TIME, p_breaks JSONB) RETURNS VOID AS $$
DECLARE
  d INTEGER;
  b JSONB;
  i INTEGER;
BEGIN
  INSERT INTO working_patterns (id, name, sort_order) VALUES (p_id, p_name, p_sort);
  FOR d IN 1..7 LOOP
    INSERT INTO working_pattern_days (pattern_id, weekday, mode, start, "end")
    VALUES (p_id, d, CASE WHEN d IN (1, 5) THEN 'own' WHEN d IN (6, 7) THEN 'off' ELSE 'same' END,
            CASE WHEN d IN (1, 5) THEN p_start END, CASE WHEN d IN (1, 5) THEN p_end END);
  END LOOP;
  FOREACH d IN ARRAY ARRAY[1, 5] LOOP
    i := 0;
    FOR b IN SELECT value FROM jsonb_array_elements(COALESCE(p_breaks, '[]'::jsonb)) LOOP
      INSERT INTO working_pattern_breaks (id, pattern_id, weekday, start, "end", sort_order)
      VALUES (p_id || '-' || d || '-' || i, p_id, d, (b->>'start')::TIME, (b->>'end')::TIME, i);
      i := i + 1;
    END LOOP;
  END LOOP;
END;
$$ LANGUAGE plpgsql;

/* Everyone keeps exactly the hours they have today. People are grouped by
 * identical working times (start, end and breaks). The two biggest groups
 * become "Normal start" (the later start) and "Early start" (the earlier);
 * any other group gets a pattern of its own ("Times for <name>", or "Other
 * times N" for several people), for an admin to tidy up. The pattern matching
 * the old default working times is the default for new people. */
DO $$
DECLARE
  g RECORD;
  normal RECORD;
  early RECORD;
  pid TEXT;
  pname TEXT;
  others INTEGER := 0;
  default_sig TEXT;
BEGIN
  CREATE TEMP TABLE wt_sig ON COMMIT DROP AS
    SELECT w.id AS wt_id, w.user_id, w.start, w."end",
           COALESCE((SELECT string_agg(b.start::TEXT || '-' || b."end"::TEXT, ',' ORDER BY b.start, b."end")
                       FROM working_time_breaks b WHERE b.working_time_id = w.id), '') AS brk
      FROM working_times w;
  CREATE TEMP TABLE sig_groups ON COMMIT DROP AS
    SELECT start, "end", brk, count(*) AS people, min(wt_id) AS sample_wt,
           row_number() OVER (ORDER BY count(*) DESC, start DESC, "end", brk) AS rank,
           NULL::TEXT AS pattern_id
      FROM wt_sig GROUP BY start, "end", brk;

  SELECT d.start::TEXT || '|' || d."end"::TEXT || '|' ||
         COALESCE((SELECT string_agg(b.start::TEXT || '-' || b."end"::TEXT, ',' ORDER BY b.start, b."end") FROM default_working_time_breaks b), '')
    INTO default_sig FROM default_working_times d WHERE d.id = 1;

  IF NOT EXISTS (SELECT 1 FROM sig_groups) THEN
    -- Nobody has working times yet: both patterns start as the old defaults.
    FOR g IN SELECT 'pat-normal' AS id, 'Normal start' AS name, 0 AS sort UNION ALL SELECT 'pat-early', 'Early start', 1 LOOP
      PERFORM pg_temp.add_pattern(g.id, g.name, g.sort, d.start, d."end",
        (SELECT jsonb_agg(jsonb_build_object('start', b.start, 'end', b."end") ORDER BY b.sort_order) FROM default_working_time_breaks b))
        FROM default_working_times d WHERE d.id = 1;
    END LOOP;
    UPDATE working_patterns SET is_default = true WHERE id = 'pat-normal';
    RETURN;
  END IF;

  SELECT * INTO normal FROM sig_groups WHERE rank = 1;
  SELECT * INTO early FROM sig_groups WHERE rank = 2;
  IF early.rank IS NOT NULL AND early.start > normal.start THEN
    g := normal; normal := early; early := g;
  END IF;
  UPDATE sig_groups SET pattern_id = 'pat-normal' WHERE rank = normal.rank;
  IF early.rank IS NOT NULL THEN UPDATE sig_groups SET pattern_id = 'pat-early' WHERE rank = early.rank; END IF;

  FOR g IN SELECT * FROM sig_groups ORDER BY rank LOOP
    IF g.pattern_id IS NULL THEN
      others := others + 1;
      pid := 'pat-other-' || others;
      IF g.people = 1 THEN
        SELECT 'Times for ' || COALESCE(NULLIF(u.name, ''), u.email, 'one person') INTO pname
          FROM wt_sig s JOIN users u ON u.id = s.user_id WHERE s.wt_id = g.sample_wt;
      ELSE
        pname := 'Other times ' || others;
      END IF;
      UPDATE sig_groups SET pattern_id = pid WHERE rank = g.rank;
    ELSE
      pid := g.pattern_id;
      pname := CASE pid WHEN 'pat-normal' THEN 'Normal start' ELSE 'Early start' END;
    END IF;
    PERFORM pg_temp.add_pattern(pid, pname, CASE pid WHEN 'pat-normal' THEN 0 WHEN 'pat-early' THEN 1 ELSE 1 + others END, g.start, g."end",
      (SELECT jsonb_agg(jsonb_build_object('start', b.start, 'end', b."end") ORDER BY b.sort_order, b.start) FROM working_time_breaks b WHERE b.working_time_id = g.sample_wt));
  END LOOP;

  -- Only one group: Early start begins as a copy of Normal start, to be changed.
  IF early.rank IS NULL THEN
    PERFORM pg_temp.add_pattern('pat-early', 'Early start', 1, normal.start, normal."end",
      (SELECT jsonb_agg(jsonb_build_object('start', b.start, 'end', b."end") ORDER BY b.sort_order, b.start) FROM working_time_breaks b WHERE b.working_time_id = normal.sample_wt));
  END IF;

  UPDATE users u SET working_pattern_id = sg.pattern_id
    FROM wt_sig s JOIN sig_groups sg ON sg.start = s.start AND sg."end" = s."end" AND sg.brk = s.brk
   WHERE u.id = s.user_id;

  UPDATE working_patterns SET is_default = true
   WHERE id = COALESCE((SELECT pattern_id FROM sig_groups WHERE start::TEXT || '|' || "end"::TEXT || '|' || brk = default_sig LIMIT 1), 'pat-normal');
END;
$$;
