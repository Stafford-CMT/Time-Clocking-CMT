-- Setup -> Configuration: how Time Slide reaches Syspro. One row (id = 1).
-- Passwords are stored encrypted (AES-256-GCM, key SETTINGS_ENCRYPTION_KEY in
-- server/.env) and are never sent back to the browser.
CREATE TABLE syspro_settings (
  id                          INTEGER PRIMARY KEY CHECK (id = 1),
  -- Syspro e.net Solutions (web services): posting into Syspro
  enet_url                    TEXT NOT NULL DEFAULT '',
  enet_operator               TEXT NOT NULL DEFAULT '',
  enet_operator_password      TEXT,
  enet_company_id             TEXT NOT NULL DEFAULT '',
  enet_company_password       TEXT,
  -- Syspro SQL Server database: read-only lookups
  sql_server                  TEXT NOT NULL DEFAULT '',
  sql_port                    INTEGER NOT NULL DEFAULT 1433,
  sql_database                TEXT NOT NULL DEFAULT '',
  sql_user                    TEXT NOT NULL DEFAULT '',
  sql_password                TEXT,
  sql_encrypt                 BOOLEAN NOT NULL DEFAULT true,
  sql_trust_server_certificate BOOLEAN NOT NULL DEFAULT false,
  updated_at                  TIMESTAMPTZ,
  updated_by                  TEXT REFERENCES users(id) ON DELETE SET NULL
);
INSERT INTO syspro_settings (id) VALUES (1);
