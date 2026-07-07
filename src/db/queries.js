'use strict';

const { query } = require('./supabase');

// ─────────────────────────────────────────────────────────────
//  files
// ─────────────────────────────────────────────────────────────

/**
 * Insert a new file record and return its generated id.
 * @param {{ filename, extension, filepath, size_bytes, mime_type, content_preview, device_id? }} metadata
 * @returns {Promise<string>} The new file UUID
 */
async function insertFile(metadata) {
  const {
    filename,
    extension,
    filepath,
    size_bytes,
    mime_type,
    content_preview,
    device_id = 'unknown',
  } = metadata;

  const sql = `
    INSERT INTO files (device_id, filename, extension, filepath, size_bytes, mime_type, content_preview)
    VALUES ($1, $2, $3, $4, $5, $6, $7)
    RETURNING id
  `;
  const { rows } = await query(sql, [
    device_id,
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
 * Return all pending files for this device.
 */
async function getPendingFiles(deviceId = 'unknown') {
  const { rows } = await query(
    `SELECT * FROM files WHERE status = 'pending' AND device_id = $1 ORDER BY created_at ASC`,
    [deviceId]
  );
  return rows;
}

/**
 * Return all classified files for this device.
 */
async function getClassifiedFiles(deviceId = 'unknown') {
  const { rows } = await query(
    `SELECT * FROM files WHERE status = 'classified' AND device_id = $1 ORDER BY updated_at DESC`,
    [deviceId]
  );
  return rows;
}

// ─────────────────────────────────────────────────────────────
//  activity_log
// ─────────────────────────────────────────────────────────────

/**
 * Write one entry to the activity log.
 */
async function logActivity(action, filename, fromPath, toPath, sizeBytes, deviceId = 'unknown') {
  const sql = `
    INSERT INTO activity_log (device_id, action, filename, from_path, to_path, file_size_bytes)
    VALUES ($1, $2, $3, $4, $5, $6)
  `;
  await query(sql, [deviceId, action, filename, fromPath ?? null, toPath ?? null, sizeBytes ?? null]);
}

// ─────────────────────────────────────────────────────────────
//  user_preferences
// ─────────────────────────────────────────────────────────────

/**
 * Upsert a preference row for this device.
 */
async function savePreference(keyword, ext, aiFolder, userFolder, deviceId = 'unknown') {
  const sql = `
    INSERT INTO user_preferences (device_id, pattern_keyword, extension, ai_suggested_folder, user_confirmed_folder)
    VALUES ($1, $2, $3, $4, $5)
    ON CONFLICT (device_id, pattern_keyword, extension)
    DO UPDATE SET
      times_confirmed       = user_preferences.times_confirmed + 1,
      user_confirmed_folder = EXCLUDED.user_confirmed_folder,
      is_learned_rule       = (user_preferences.times_confirmed + 1) >= 3
  `;
  await query(sql, [deviceId, keyword ?? null, ext ?? null, aiFolder ?? null, userFolder ?? null]);
}

/**
 * Return learned rules for this device.
 */
async function getLearnedRules(deviceId = 'unknown') {
  const { rows } = await query(
    `SELECT * FROM user_preferences WHERE is_learned_rule = true AND device_id = $1 ORDER BY times_confirmed DESC`,
    [deviceId]
  );
  return rows;
}

// ─────────────────────────────────────────────────────────────
//  sessions
// ─────────────────────────────────────────────────────────────

/**
 * Return today's session for this device, creating it if needed.
 */
async function getTodaySession(deviceId = 'unknown') {
  const selectSql = `SELECT * FROM sessions WHERE session_date = CURRENT_DATE AND device_id = $1 LIMIT 1`;
  const { rows } = await query(selectSql, [deviceId]);
  if (rows.length > 0) return rows[0];

  const insertSql = `
    INSERT INTO sessions (device_id, session_date)
    VALUES ($1, CURRENT_DATE)
    ON CONFLICT (device_id, session_date) DO NOTHING
    RETURNING *
  `;
  const { rows: newRows } = await query(insertSql, [deviceId]);
  if (newRows.length > 0) return newRows[0];

  const { rows: fallback } = await query(selectSql, [deviceId]);
  return fallback[0];
}

/**
 * Overwrite session counters.
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

// ─────────────────────────────────────────────────────────────
//  devices
// ─────────────────────────────────────────────────────────────

/**
 * Register or update this device in the devices table.
 * Called once on every app launch so last_seen stays current.
 */
async function upsertDevice(deviceId, label) {
  const sql = `
    INSERT INTO devices (id, label, first_seen, last_seen)
    VALUES ($1, $2, now(), now())
    ON CONFLICT (id) DO UPDATE SET
      label     = EXCLUDED.label,
      last_seen = now()
  `;
  await query(sql, [deviceId, label]);
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
  upsertDevice,
};
