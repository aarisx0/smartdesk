-- =============================================================
--  SmartDesk AI — Database Schema
--  Paste the entire contents of this file into the
--  Supabase SQL Editor and click "Run".
-- =============================================================

-- ─────────────────────────────────────────────────────────────
--  1. files
--     Central record for every file the watcher detects.
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS files (
  id               UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  filename         TEXT          NOT NULL,
  extension        TEXT,
  filepath         TEXT          UNIQUE NOT NULL,
  size_bytes       BIGINT,
  mime_type        TEXT,
  content_preview  TEXT,
  status           TEXT          DEFAULT 'pending'
                                 CHECK (status IN ('pending', 'classified', 'moved', 'skipped')),
  suggested_folder TEXT,
  confidence_score FLOAT,
  ai_reasoning     TEXT,
  created_at       TIMESTAMPTZ   DEFAULT now(),
  updated_at       TIMESTAMPTZ   DEFAULT now()
);

-- ─────────────────────────────────────────────────────────────
--  2. user_preferences
--     Stores AI→user confirmation pairs; builds learned rules.
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS user_preferences (
  id                    UUID   PRIMARY KEY DEFAULT gen_random_uuid(),
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
  action          TEXT   CHECK (action IN ('moved', 'created', 'deleted', 'skipped')),
  filename        TEXT,
  from_path       TEXT,
  to_path         TEXT,
  file_size_bytes BIGINT,
  timestamp       TIMESTAMPTZ DEFAULT now()
);

-- ─────────────────────────────────────────────────────────────
--  4. sessions
--     One row per calendar day; tracks high-level stats.
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS sessions (
  id                   UUID  PRIMARY KEY DEFAULT gen_random_uuid(),
  files_processed      INT          DEFAULT 0,
  folders_created      INT          DEFAULT 0,
  duplicates_removed   INT          DEFAULT 0,
  storage_saved_bytes  BIGINT       DEFAULT 0,
  session_date         DATE         DEFAULT CURRENT_DATE
);

-- ─────────────────────────────────────────────────────────────
--  5. duplicate_groups
--     Groups of files sharing the same content hash.
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS duplicate_groups (
  id               UUID   PRIMARY KEY DEFAULT gen_random_uuid(),
  file_hash        TEXT,
  filenames        JSONB,
  sizes            JSONB,
  recommended_keep TEXT,
  resolved         BOOLEAN     DEFAULT false,
  created_at       TIMESTAMPTZ DEFAULT now()
);

-- ─────────────────────────────────────────────────────────────
--  6. chat_sessions
--     Persists chat conversations so the user can resume them
--     after closing the app.
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS chat_sessions (
  id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  title        TEXT        NOT NULL DEFAULT 'New Chat',
  messages     JSONB       NOT NULL DEFAULT '[]',
  thread_id    TEXT,
  message_count INT        DEFAULT 0,
  created_at   TIMESTAMPTZ DEFAULT now(),
  updated_at   TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_chat_sessions_updated ON chat_sessions (updated_at DESC);

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

-- ─────────────────────────────────────────────────────────────
--  Indexes
-- ─────────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_files_status           ON files (status);
CREATE INDEX IF NOT EXISTS idx_files_extension        ON files (extension);
CREATE INDEX IF NOT EXISTS idx_activity_log_timestamp ON activity_log (timestamp);
CREATE INDEX IF NOT EXISTS idx_user_prefs_keyword     ON user_preferences (pattern_keyword);
