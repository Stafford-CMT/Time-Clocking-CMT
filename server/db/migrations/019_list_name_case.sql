-- One style for every name list (same rules as src/utils/textCase.js): machine
-- types in capitals, customers in title case, suffix descriptions, cost
-- centres and rework reasons in sentence case. A word typed all in capitals
-- (an acronym such as RFU) is kept, unless the whole name is in capitals.
-- Every renamed entry is changed everywhere it is used too; if two entries
-- become the same name, they merge into one.

CREATE FUNCTION pg_temp.tidy(t TEXT) RETURNS TEXT AS $$
  SELECT btrim(regexp_replace(t, '\s+', ' ', 'g'));
$$ LANGUAGE sql IMMUTABLE;

CREATE FUNCTION pg_temp.typed_in_capitals(t TEXT) RETURNS BOOLEAN AS $$
  SELECT position(' ' IN t) > 0 AND t = upper(t) AND t ~ '[A-Z]';
$$ LANGUAGE sql IMMUTABLE;

CREATE FUNCTION pg_temp.is_acronym(w TEXT, all_caps BOOLEAN) RETURNS BOOLEAN AS $$
  SELECT NOT all_caps AND w ~ '[A-Z].*[A-Z]' AND w = upper(w);
$$ LANGUAGE sql IMMUTABLE;

CREATE FUNCTION pg_temp.sentence_case(t TEXT) RETURNS TEXT AS $$
DECLARE
  clean TEXT := pg_temp.tidy(t);
  all_caps BOOLEAN := pg_temp.typed_in_capitals(pg_temp.tidy(t));
  w TEXT; parts TEXT[] := '{}'; i INTEGER := 0;
BEGIN
  FOREACH w IN ARRAY string_to_array(clean, ' ') LOOP
    i := i + 1;
    IF pg_temp.is_acronym(w, all_caps) THEN parts := parts || w;
    ELSIF i = 1 THEN parts := parts || (upper(left(w, 1)) || lower(substr(w, 2)));
    ELSE parts := parts || lower(w);
    END IF;
  END LOOP;
  RETURN array_to_string(parts, ' ');
END;
$$ LANGUAGE plpgsql;

CREATE FUNCTION pg_temp.title_case(t TEXT) RETURNS TEXT AS $$
DECLARE
  clean TEXT := pg_temp.tidy(t);
  all_caps BOOLEAN := pg_temp.typed_in_capitals(pg_temp.tidy(t));
  w TEXT; parts TEXT[] := '{}';
BEGIN
  FOREACH w IN ARRAY string_to_array(clean, ' ') LOOP
    parts := parts || CASE WHEN pg_temp.is_acronym(w, all_caps) THEN w ELSE initcap(w) END;
  END LOOP;
  RETURN array_to_string(parts, ' ');
END;
$$ LANGUAGE plpgsql;

-- Renames every entry of one list to its tidied form, and the same value in each
-- 'table.column' that copies it.
CREATE FUNCTION pg_temp.restyle(list TEXT, style TEXT, refs TEXT[]) RETURNS VOID AS $$
DECLARE
  old_name TEXT; new_name TEXT; ref TEXT; taken BOOLEAN;
BEGIN
  FOR old_name IN EXECUTE format('SELECT name FROM %I', list) LOOP
    new_name := CASE style WHEN 'upper' THEN upper(pg_temp.tidy(old_name)) WHEN 'title' THEN pg_temp.title_case(old_name) ELSE pg_temp.sentence_case(old_name) END;
    CONTINUE WHEN new_name = old_name OR new_name = '';
    -- (EXECUTE never sets FOUND, so the answer is read into a variable)
    EXECUTE format('SELECT EXISTS (SELECT 1 FROM %I WHERE name = $1)', list) INTO taken USING new_name;
    IF taken THEN
      EXECUTE format('DELETE FROM %I WHERE name = $1', list) USING old_name;
    ELSE
      EXECUTE format('UPDATE %I SET name = $1 WHERE name = $2', list) USING new_name, old_name;
    END IF;
    FOREACH ref IN ARRAY refs LOOP
      EXECUTE format('UPDATE %I SET %I = $1 WHERE %I = $2', split_part(ref, '.', 1), split_part(ref, '.', 2), split_part(ref, '.', 2)) USING new_name, old_name;
    END LOOP;
    RAISE NOTICE '% : "%" -> "%"', list, old_name, new_name;
  END LOOP;
END;
$$ LANGUAGE plpgsql;

SELECT pg_temp.restyle('machine_types', 'upper', ARRAY['contract_info.machine_type', 'contracts.machine_type']);
SELECT pg_temp.restyle('suffix_descriptions', 'sentence', ARRAY['contract_info_suffixes.description', 'contracts.suffix_description']);
SELECT pg_temp.restyle('customers', 'title', ARRAY['contract_info.customer_name', 'contracts.customer_name']);
SELECT pg_temp.restyle('cost_centres', 'sentence', ARRAY['users.cost_centre']);
SELECT pg_temp.restyle('rework_reasons', 'sentence', ARRAY['time_sessions.rework_reason', 'active_sessions.rework_reason', 'user_break_state.rework_reason']);
