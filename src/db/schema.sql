-- =============================================================
--  SmartDesk AI — Database Schema
--  Paste the entire contents of this file into the
--  Supabase SQL Editor and click "Run".
-- =============================================================

-- ─────────────────────────────────────────────────────────────
--  1. files
--     Central record for every file the watcher detects.
--     device_id tags every row to the originating machine.
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS files (
  id               UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  device_id        TEXT          NOT NULL DEFAULT 'unknown',
  filename         TEXT          NOT NULL,
  extension        TEXT,
  filepath         TEXT          NOT NULL,
  size_bytes       BIGINT,
  mime_type        TEXT,
  content_preview  TEXT,
  status           TEXT          DEFAULT 'pending'
                                 CHECK (status IN ('pending', 'classified', 'moved', 'skipped')),
  suggested_folder TEXT,
  confidence_score FLOAT,
  ai_reasoning     TEXT,
  created_at       TIMESTAMPTZ   DEFAULT now(),
  updated_at       TIMESTAMPTZ   DEFAULT now(),
  -- filepath is unique PER device (same file path can exist on two different machines)
  UNIQUE (device_id, filepath)
);

-- ─────────────────────────────────────────────────────────────
--  2. user_preferences
--     Stores AI→user confirmation pairs; builds learned rules.
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS user_preferences (
  id                    UUID   PRIMARY KEY DEFAULT gen_random_uuid(),
  device_id             TEXT          NOT NULL DEFAULT 'unknown',
  pattern_keyword       TEXT,
  extension             TEXT,
  ai_suggested_folder   TEXT,
  user_confirmed_folder TEXT,
  times_confirmed       INT            DEFAULT 1,
  is_learned_rule       BOOLEAN        DEFAULT false,
  created_at            TIMESTAMPTZ    DEFAULT now()
);

-- ─────────────────────────────────────────────────────────────
--  3. activity_log
--     Audit trail of every file operation.
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS activity_log (
  id              UUID   PRIMARY KEY DEFAULT gen_random_uuid(),
  device_id       TEXT          NOT NULL DEFAULT 'unknown',
  action          TEXT   CHECK (action IN ('moved', 'created', 'deleted', 'skipped')),
  filename        TEXT,
  from_path       TEXT,
  to_path         TEXT,
  file_size_bytes BIGINT,
  timestamp       TIMESTAMPTZ DEFAULT now()
);

-- ─────────────────────────────────────────────────────────────
--  4. sessions
--     One row per device per calendar day; tracks stats.
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS sessions (
  id                   UUID  PRIMARY KEY DEFAULT gen_random_uuid(),
  device_id            TEXT          NOT NULL DEFAULT 'unknown',
  files_processed      INT          DEFAULT 0,
  folders_created      INT          DEFAULT 0,
  duplicates_removed   INT          DEFAULT 0,
  storage_saved_bytes  BIGINT       DEFAULT 0,
  session_date         DATE         DEFAULT CURRENT_DATE,
  UNIQUE (device_id, session_date)
);

-- ─────────────────────────────────────────────────────────────
--  5. duplicate_groups
--     Groups of files sharing the same content hash.
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS duplicate_groups (
  id               UUID   PRIMARY KEY DEFAULT gen_random_uuid(),
  device_id        TEXT          NOT NULL DEFAULT 'unknown',
  file_hash        TEXT,
  filenames        JSONB,
  sizes            JSONB,
  recommended_keep TEXT,
  resolved         BOOLEAN     DEFAULT false,
  created_at       TIMESTAMPTZ DEFAULT now()
);

-- ─────────────────────────────────────────────────────────────
--  6. chat_sessions
--     Persists chat conversations so the user can resume them.
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS chat_sessions (
  id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  device_id    TEXT          NOT NULL DEFAULT 'unknown',
  title        TEXT        NOT NULL DEFAULT 'New Chat',
  messages     JSONB       NOT NULL DEFAULT '[]',
  thread_id    TEXT,
  message_count INT        DEFAULT 0,
  created_at   TIMESTAMPTZ DEFAULT now(),
  updated_at   TIMESTAMPTZ DEFAULT now()
);

-- ─────────────────────────────────────────────────────────────
--  7. devices
--     Registry of all devices that have used the app.
--     Auto-upserted on every app launch.
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS devices (
  id           TEXT        PRIMARY KEY,   -- the UUID from electron-store
  label        TEXT,                       -- "HOSTNAME (win32)"
  first_seen   TIMESTAMPTZ DEFAULT now(),
  last_seen    TIMESTAMPTZ DEFAULT now()
);

-- ─────────────────────────────────────────────────────────────
--  Trigger: keep files.updated_at current
-- ─────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS files_updated_at ON files;
CREATE TRIGGER files_updated_at
  BEFORE UPDATE ON files
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

DROP TRIGGER IF EXISTS chat_sessions_updated_at ON chat_sessions;
CREATE TRIGGER chat_sessions_updated_at
  BEFORE UPDATE ON chat_sessions
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- ─────────────────────────────────────────────────────────────
--  Indexes
-- ─────────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_files_status           ON files (status);
CREATE INDEX IF NOT EXISTS idx_files_extension        ON files (extension);
CREATE INDEX IF NOT EXISTS idx_files_device           ON files (device_id);
CREATE INDEX IF NOT EXISTS idx_activity_log_timestamp ON activity_log (timestamp);
CREATE INDEX IF NOT EXISTS idx_activity_log_device    ON activity_log (device_id);
CREATE INDEX IF NOT EXISTS idx_user_prefs_keyword     ON user_preferences (pattern_keyword);
CREATE INDEX IF NOT EXISTS idx_chat_sessions_updated  ON chat_sessions (updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_chat_sessions_device   ON chat_sessions (device_id);

-- ─────────────────────────────────────────────────────────────
--  Migration helpers — run these if upgrading an existing DB
--  (safe to run even on a fresh schema — IF NOT EXISTS handles it)
-- ─────────────────────────────────────────────────────────────
ALTER TABLE files            ADD COLUMN IF NOT EXISTS device_id TEXT NOT NULL DEFAULT 'unknown';
ALTER TABLE user_preferences ADD COLUMN IF NOT EXISTS device_id TEXT NOT NULL DEFAULT 'unknown';
ALTER TABLE activity_log     ADD COLUMN IF NOT EXISTS device_id TEXT NOT NULL DEFAULT 'unknown';
ALTER TABLE sessions         ADD COLUMN IF NOT EXISTS device_id TEXT NOT NULL DEFAULT 'unknown';
ALTER TABLE duplicate_groups ADD COLUMN IF NOT EXISTS device_id TEXT NOT NULL DEFAULT 'unknown';
ALTER TABLE chat_sessions    ADD COLUMN IF NOT EXISTS device_id TEXT NOT NULL DEFAULT 'unknown';

-- Re-add UNIQUE constraint on files scoped to device
ALTER TABLE files DROP CONSTRAINT IF EXISTS files_filepath_key;
ALTER TABLE files ADD CONSTRAINT IF NOT EXISTS files_device_filepath_unique UNIQUE (device_id, filepath);

-- Re-add UNIQUE constraint on sessions scoped to device
ALTER TABLE sessions ADD CONSTRAINT IF NOT EXISTS sessions_device_date_unique UNIQUE (device_id, session_date);
