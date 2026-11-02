-- Default auto clock-out: minutes after the end of someone's working day
-- (0 to 5 hours, set in Lists -> Users -> Default working times). Used for
-- everyone who hasn't dragged their own auto clock-out line
-- (users.auto_clock_out NULL); never later than midnight.
ALTER TABLE default_working_times
  ADD COLUMN auto_clock_out_delay INTEGER NOT NULL DEFAULT 120
  CONSTRAINT default_working_times_auto_clock_out_delay_check CHECK (auto_clock_out_delay BETWEEN 0 AND 300);
