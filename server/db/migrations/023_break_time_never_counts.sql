-- Break time never counts (25 Nov 2026). Until now a clock started during a
-- break, or a block dragged across one in Review times, kept the break time,
-- so it went into every total (e.g. Sean Gratwicke, 17 Nov). From now on the
-- server cuts recorded time around the person's breaks and refuses edits that
-- run into one. This cuts the blocks already recorded the same way: each block
-- that overlaps a break in its owner's working pattern becomes the pieces
-- either side of it (a block wholly inside a break is removed).
--
-- Exported days are left exactly as they are: what went to finance / Syspro
-- must not change. Uses each person's current working pattern (patterns are
-- not dated). Safe to run more than once: a second run finds nothing to cut.

DO $$
DECLARE
  s RECORD; b RECORD;
  f INT[]; t INT[]; nf INT[]; nt INT[]; i INT; bf INT; bt INT;
  cut INT := 0; removed INT := 0;
BEGIN
  FOR s IN
    SELECT ts.*, u.working_pattern_id AS pattern_id, CASE WHEN pd.mode = 'same' THEN 1 ELSE pd.weekday END AS break_weekday
      FROM time_sessions ts
      JOIN users u ON u.id = ts.user_id
      JOIN working_pattern_days pd ON pd.pattern_id = u.working_pattern_id AND pd.weekday = EXTRACT(ISODOW FROM ts.date)::int AND pd.mode <> 'off'
     WHERE NOT EXISTS (SELECT 1 FROM exported_days e WHERE e.user_id = ts.user_id AND e.date = ts.date)
       AND EXISTS (SELECT 1 FROM working_pattern_breaks wb
                    WHERE wb.pattern_id = u.working_pattern_id
                      AND wb.weekday = CASE WHEN pd.mode = 'same' THEN 1 ELSE pd.weekday END
                      AND ts.start_time < wb."end" AND ts.end_time > wb.start)
  LOOP
    f := ARRAY[EXTRACT(EPOCH FROM s.start_time)::int];
    t := ARRAY[EXTRACT(EPOCH FROM s.end_time)::int];
    FOR b IN SELECT start, "end" FROM working_pattern_breaks WHERE pattern_id = s.pattern_id AND weekday = s.break_weekday ORDER BY start LOOP
      bf := EXTRACT(EPOCH FROM b.start)::int; bt := EXTRACT(EPOCH FROM b."end")::int;
      nf := '{}'; nt := '{}';
      FOR i IN 1 .. COALESCE(array_length(f, 1), 0) LOOP
        IF bt <= f[i] OR bf >= t[i] THEN
          nf := nf || f[i]; nt := nt || t[i];
        ELSE
          IF bf > f[i] THEN nf := nf || f[i]; nt := nt || bf; END IF;
          IF t[i] > bt THEN nf := nf || bt; nt := nt || t[i]; END IF;
        END IF;
      END LOOP;
      f := nf; t := nt;
    END LOOP;

    IF COALESCE(array_length(f, 1), 0) = 0 THEN
      DELETE FROM time_sessions WHERE id = s.id;
      removed := removed + 1;
      CONTINUE;
    END IF;

    -- The block keeps its id as the first piece; any later pieces are new rows
    -- with everything else copied. Only the last piece keeps an auto clock-out mark.
    UPDATE time_sessions
       SET start_time = make_time(f[1] / 3600, (f[1] % 3600) / 60, f[1] % 60),
           end_time = make_time(t[1] / 3600, (t[1] % 3600) / 60, t[1] % 60),
           unlinked_end = CASE WHEN array_length(f, 1) > 1 THEN false ELSE s.unlinked_end END,
           auto_stopped = CASE WHEN array_length(f, 1) > 1 THEN false ELSE s.auto_stopped END
     WHERE id = s.id;
    FOR i IN 2 .. array_length(f, 1) LOOP
      INSERT INTO time_sessions (id, contract_id, user_id, date, start_time, end_time, unlinked_start, unlinked_end,
                                 auto_stopped, auto_noticed, rework_reason, entered_by, entered_at, department)
      VALUES ('session-' || (EXTRACT(EPOCH FROM clock_timestamp()) * 1000)::bigint || '-' || substr(md5(random()::text), 1, 6),
              s.contract_id, s.user_id, s.date,
              make_time(f[i] / 3600, (f[i] % 3600) / 60, f[i] % 60),
              make_time(t[i] / 3600, (t[i] % 3600) / 60, t[i] % 60),
              false, CASE WHEN i = array_length(f, 1) THEN s.unlinked_end ELSE false END,
              CASE WHEN i = array_length(f, 1) THEN s.auto_stopped ELSE false END,
              s.auto_noticed, s.rework_reason, s.entered_by, s.entered_at, s.department);
    END LOOP;
    cut := cut + 1;
  END LOOP;
  RAISE NOTICE 'Break time never counts: % block(s) cut around breaks, % block(s) wholly inside a break removed', cut, removed;
END $$;
