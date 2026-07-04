'use strict';

const { query } = require('./supabase');

// ─────────────────────────────────────────────────────────────
//  files
// ─────────────────────────────────────────────────────────────

/**
 * Insert a new file record and return its generated id.
 * @param {{ filename, extension, filepath, size_bytes, mime_type, content_preview }} metadata
 * @returns {Promise<string>} The new file UUID
 */
async function insertFile(metadata) {
  const { filename, extension, filepath, size_bytes, mime_type, content_preview } = metadata;
  const sql = `
    INSERT INTO files (filename, extension, filepath, size_bytes, mime_type, content_preview)
    VALUES ($1, $2, $3, $4, $5, $6)
    RETURNING id
  `;
  const { rows } = await query(sql, [
    filename,
    extension ?? null,
    filepath,
    size_bytes ?? null,
    mime_type ?? null,
    content_preview ?? null,
  ]);
  return rows[0].id;
}

/**
 * Update classification result on an existing file record.
 * @param {string} id
 * @param {string} status           'classified' | 'moved' | 'skipped'
 * @param {string|null} suggestedFolder
 * @param {number|null} confidence   0–1 float
 * @param {string|null} reasoning
 */
async function updateFileStatus(id, status, suggestedFolder, confidence, reasoning) {
  const sql = `
    UPDATE files
    SET status = $2, suggested_folder = $3, confidence_score = $4, ai_reasoning = $5
    WHERE id = $1
  `;
  await query(sql, [id, status, suggestedFolder ?? null, confidence ?? null, reasoning ?? null]);
}

/**
 * Return all files with status = 'pending'.
 * @returns {Promise<object[]>}
 */
async function getPendingFiles() {
  const { rows } = await query(`SELECT * FROM files WHERE status = 'pending' ORDER BY created_at ASC`);
  return rows;
}

/**
 * Return all files with status = 'classified'.
 * @returns {Promise<object[]>}
 */
async function getClassifiedFiles() {
  const { rows } = await query(`SELECT * FROM files WHERE status = 'classified' ORDER BY updated_at DESC`);
  return rows;
}

// ─────────────────────────────────────────────────────────────
//  activity_log
// ─────────────────────────────────────────────────────────────

/**
 * Write one entry to the activity log.
 * @param {'moved'|'created'|'deleted'|'skipped'} action
 * @param {string} filename
 * @param {string|null} fromPath
 * @param {string|null} toPath
 * @param {number|null} sizeBytes
 */
async function logActivity(action, filename, fromPath, toPath, sizeBytes) {
  const sql = `
    INSERT INTO activity_log (action, filename, from_path, to_path, file_size_bytes)
    VALUES ($1, $2, $3, $4, $5)
  `;
  await query(sql, [action, filename, fromPath ?? null, toPath ?? null, sizeBytes ?? null]);
}

// ─────────────────────────────────────────────────────────────
//  user_preferences
// ─────────────────────────────────────────────────────────────

/**
 * Insert a new preference row, or increment times_confirmed if a row with the
 * same (pattern_keyword, extension) pair already exists.
 * When times_confirmed reaches 3 the rule is automatically promoted to a
 * learned rule (is_learned_rule = true).
 *
 * @param {string|null} keyword
 * @param {string|null} ext
 * @param {string|null} aiFolder
 * @param {string|null} userFolder
 */
async function savePreference(keyword, ext, aiFolder, userFolder) {
  const sql = `
    INSERT INTO user_preferences (pattern_keyword, extension, ai_suggested_folder, user_confirmed_folder)
    VALUES ($1, $2, $3, $4)
    ON CONFLICT (pattern_keyword, extension)
    DO UPDATE SET
      times_confirmed       = user_preferences.times_confirmed + 1,
      user_confirmed_folder = EXCLUDED.user_confirmed_folder,
      is_learned_rule       = (user_preferences.times_confirmed + 1) >= 3
  `;
  await query(sql, [keyword ?? null, ext ?? null, aiFolder ?? null, userFolder ?? null]);
}

/**
 * Return all rows where is_learned_rule = true.
 * @returns {Promise<object[]>}
 */
async function getLearnedRules() {
  const { rows } = await query(
    `SELECT * FROM user_preferences WHERE is_learned_rule = true ORDER BY times_confirmed DESC`
  );
  return rows;
}

// ─────────────────────────────────────────────────────────────
//  sessions
// ─────────────────────────────────────────────────────────────

/**
 * Return today's session row, creating it if it doesn't exist yet.
 * @returns {Promise<object>}
 */
async function getTodaySession() {
  // Try to find today's row first (avoids unnecessary INSERT on every call)
  const selectSql = `SELECT * FROM sessions WHERE session_date = CURRENT_DATE LIMIT 1`;
  const { rows } = await query(selectSql);
  if (rows.length > 0) return rows[0];

  // Create a fresh session for today
  const insertSql = `
    INSERT INTO sessions (session_date)
    VALUES (CURRENT_DATE)
    ON CONFLICT DO NOTHING
    RETURNING *
  `;
  const { rows: newRows } = await query(insertSql);

  // Handle the edge-case where a concurrent INSERT already created the row
  if (newRows.length > 0) return newRows[0];
  const { rows: fallback } = await query(selectSql);
  return fallback[0];
}

/**
 * Overwrite session counters with the provided values.
 * @param {string} id
 * @param {number} filesProcessed
 * @param {number} foldersCreated
 * @param {number} duplicatesRemoved
 * @param {number} storageSaved
 */
async function updateSession(id, filesProcessed, foldersCreated, duplicatesRemoved, storageSaved) {
  const sql = `
    UPDATE sessions
    SET files_processed     = $2,
        folders_created     = $3,
        duplicates_removed  = $4,
        storage_saved_bytes = $5
    WHERE id = $1
  `;
  await query(sql, [id, filesProcessed, foldersCreated, duplicatesRemoved, storageSaved]);
}

module.exports = {
  insertFile,
  updateFileStatus,
  getPendingFiles,
  getClassifiedFiles,
  logActivity,
  savePreference,
  getLearnedRules,
  getTodaySession,
  updateSession,
};
