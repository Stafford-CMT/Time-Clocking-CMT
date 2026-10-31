-- Staff now come from Microsoft Entra ID (see directoryService): every member
-- of the tenant gets a users row, and an admin ticks who is in Time Slide.

-- Only people who are ticked can sign in or appear in the app's lists.
ALTER TABLE users ADD COLUMN included BOOLEAN NOT NULL DEFAULT false;

-- Details copied from Entra ID on each sync. in_directory goes false when
-- someone is no longer in Entra ID (their row and times are kept).
ALTER TABLE users ADD COLUMN in_directory BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE users ADD COLUMN account_enabled BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE users ADD COLUMN job_title TEXT;
ALTER TABLE users ADD COLUMN department TEXT;
ALTER TABLE users ADD COLUMN office_location TEXT;
ALTER TABLE users ADD COLUMN synced_at TIMESTAMPTZ;

-- Everyone already using the app keeps access.
UPDATE users SET included = true;
