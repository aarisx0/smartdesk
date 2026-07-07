'use strict';

/**
 * src/backend/learning.js
 *
 * Learning engine — records user approval/override patterns and
 * promotes them to automatic rules after 3 confirmations.
 *
 * All operations are scoped to a device_id so each installation
 * maintains its own independent set of learned rules.
 */

const { query } = require('../db/supabase');

// ─── Stop words stripped when extracting keywords ────────────────────────────
const STOP_WORDS = new Set([
  'the', 'a', 'an', 'is', 'it', 'in', 'on', 'at', 'to', 'for',
  'of', 'and', 'or', 'my', 'file', 'new', 'copy', 'final', 'draft',
]);

function extractKeyword(filename) {
  const stem = filename.replace(/\.[^.]+$/, '').toLowerCase();
  const cleaned = stem.replace(/[^a-z0-9_]/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '');
  return cleaned.split('_').filter((w) => w.length > 1 && !STOP_WORDS.has(w)).join('_') || cleaned;
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Record a user approval scoped to a device.
 *
 * @param {object} params
 * @param {string} params.filename
 * @param {string} params.extension
 * @param {string|null} params.aiFolder
 * @param {string}      params.userFolder
 * @param {string}      [params.deviceId='unknown']
 */
async function recordApproval({ filename, extension, aiFolder, userFolder, deviceId = 'unknown' }) {
  const keyword = extractKeyword(filename);
  try {
    await query(
      `INSERT INTO user_preferences
         (device_id, pattern_keyword, extension, ai_suggested_folder, user_confirmed_folder, times_confirmed)
       VALUES ($1, $2, $3, $4, $5, 1)
       ON CONFLICT (device_id, pattern_keyword, extension)
       DO UPDATE SET
         times_confirmed       = user_preferences.times_confirmed + 1,
         user_confirmed_folder = EXCLUDED.user_confirmed_folder,
         is_learned_rule       = (user_preferences.times_confirmed + 1) >= 3`,
      [deviceId, keyword, extension ?? null, aiFolder ?? null, userFolder]
    );
    console.log(`[learning] approval recorded: ${keyword} → ${userFolder} (device: ${deviceId})`);
  } catch (err) {
    console.error('[learning] recordApproval error:', err.message);
  }
}

/**
 * Record a user override scoped to a device.
 */
async function recordOverride({ filename, extension, aiFolder, userFolder, deviceId = 'unknown' }) {
  const keyword = extractKeyword(filename);
  try {
    const { rows } = await query(
      `SELECT id, times_confirmed, is_learned_rule FROM user_preferences
       WHERE device_id = $1 AND pattern_keyword = $2 AND extension = $3
       LIMIT 1`,
      [deviceId, keyword, extension ?? null]
    );

    if (rows.length === 0) {
      await recordApproval({ filename, extension, aiFolder, userFolder, deviceId });
      return;
    }

    const rule = rows[0];
    const newCount  = Math.max(0, rule.times_confirmed - 2);
    const isLearned = newCount >= 3;

    await query(
      `UPDATE user_preferences
       SET times_confirmed = $1, is_learned_rule = $2, user_confirmed_folder = $3
       WHERE id = $4`,
      [newCount, isLearned, userFolder, rule.id]
    );
    console.log(`[learning] override recorded: ${keyword} demoted to ${newCount}`);
  } catch (err) {
    console.error('[learning] recordOverride error:', err.message);
  }
}

/**
 * Check if a learned rule exists for this device.
 */
async function checkLearnedRule(filename, extension, deviceId = 'unknown') {
  const keyword = extractKeyword(filename);
  try {
    const { rows } = await query(
      `SELECT user_confirmed_folder, times_confirmed FROM user_preferences
       WHERE device_id = $1
         AND is_learned_rule = true
         AND (pattern_keyword = $2 OR $2 ILIKE '%' || pattern_keyword || '%')
         AND (extension = $3 OR extension IS NULL)
       ORDER BY times_confirmed DESC
       LIMIT 1`,
      [deviceId, keyword, extension ?? null]
    );
    if (rows.length === 0) return null;
    return {
      folder:     rows[0].user_confirmed_folder,
      confidence: Math.min(1.0, 0.7 + (rows[0].times_confirmed * 0.05)),
    };
  } catch (err) {
    console.error('[learning] checkLearnedRule error:', err.message);
    return null;
  }
}

/**
 * Return all rules for this device (for Settings page).
 */
async function getAllRules(deviceId = 'unknown') {
  try {
    const { rows } = await query(
      `SELECT id, pattern_keyword, extension, user_confirmed_folder,
              times_confirmed, is_learned_rule, created_at
       FROM user_preferences
       WHERE device_id = $1
       ORDER BY is_learned_rule DESC, times_confirmed DESC`,
      [deviceId]
    );
    return rows;
  } catch (err) {
    console.error('[learning] getAllRules error:', err.message);
    return [];
  }
}

/**
 * Delete a specific rule by id.
 */
async function deleteRule(id) {
  try {
    await query(`DELETE FROM user_preferences WHERE id = $1`, [id]);
  } catch (err) {
    console.error('[learning] deleteRule error:', err.message);
  }
}

/**
 * Clear all rules for this device.
 */
async function clearAllRules(deviceId = 'unknown') {
  try {
    await query(`DELETE FROM user_preferences WHERE device_id = $1`, [deviceId]);
    console.log('[learning] all rules cleared for device:', deviceId);
  } catch (err) {
    console.error('[learning] clearAllRules error:', err.message);
  }
}

module.exports = {
  recordApproval,
  recordOverride,
  checkLearnedRule,
  getAllRules,
  deleteRule,
  clearAllRules,
  extractKeyword,
};
