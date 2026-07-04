'use strict';

/**
 * src/backend/learning.js
 *
 * Learning engine — records user approval/override patterns and
 * promotes them to automatic rules after 3 confirmations.
 *
 * Rules:
 *  - After 3 confirmations for the same (keyword, extension) pair
 *    → is_learned_rule = true → future classifications skip watsonx
 *  - 2 overrides of a learned rule → demote back to suggestion
 */

const { query } = require('../db/supabase');

// ─── Stop words stripped when extracting keywords ────────────────────────────
const STOP_WORDS = new Set([
  'the', 'a', 'an', 'is', 'it', 'in', 'on', 'at', 'to', 'for',
  'of', 'and', 'or', 'my', 'file', 'new', 'copy', 'final', 'draft',
]);

/**
 * Extract a short keyword from a filename (stem, lowercased, stop-words removed).
 * e.g. "Q4_Sales_Report.xlsx" → "q4_sales_report"
 * @param {string} filename
 * @returns {string}
 */
function extractKeyword(filename) {
  const stem = filename.replace(/\.[^.]+$/, '').toLowerCase();
  // Keep alphanumeric + underscores, strip the rest
  const cleaned = stem.replace(/[^a-z0-9_]/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '');
  return cleaned.split('_').filter((w) => w.length > 1 && !STOP_WORDS.has(w)).join('_') || cleaned;
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Record a user approval: increment confirmation count, promote to learned rule at 3.
 *
 * @param {object} params
 * @param {string} params.filename
 * @param {string} params.extension
 * @param {string|null} params.aiFolder         Folder watsonx suggested
 * @param {string}      params.userFolder        Folder user confirmed
 */
async function recordApproval({ filename, extension, aiFolder, userFolder }) {
  const keyword = extractKeyword(filename);
  try {
    await query(
      `INSERT INTO user_preferences
         (pattern_keyword, extension, ai_suggested_folder, user_confirmed_folder, times_confirmed)
       VALUES ($1, $2, $3, $4, 1)
       ON CONFLICT (pattern_keyword, extension)
       DO UPDATE SET
         times_confirmed       = user_preferences.times_confirmed + 1,
         user_confirmed_folder = EXCLUDED.user_confirmed_folder,
         is_learned_rule       = (user_preferences.times_confirmed + 1) >= 3`,
      [keyword, extension ?? null, aiFolder ?? null, userFolder]
    );
    console.log(`[learning] approval recorded: ${keyword} → ${userFolder}`);
  } catch (err) {
    console.error('[learning] recordApproval error:', err.message);
  }
}

/**
 * Record a user override (moved file to a different folder than AI suggested).
 * Two overrides demote a learned rule back to a suggestion.
 *
 * @param {object} params
 * @param {string} params.filename
 * @param {string} params.extension
 * @param {string|null} params.aiFolder
 * @param {string}      params.userFolder
 */
async function recordOverride({ filename, extension, aiFolder, userFolder }) {
  const keyword = extractKeyword(filename);
  try {
    // Check current state
    const { rows } = await query(
      `SELECT id, times_confirmed, is_learned_rule FROM user_preferences
       WHERE pattern_keyword = $1 AND extension = $2 LIMIT 1`,
      [keyword, extension ?? null]
    );

    if (rows.length === 0) {
      // No existing rule — treat as a fresh approval for the overridden folder
      await recordApproval({ filename, extension, aiFolder, userFolder });
      return;
    }

    const rule = rows[0];
    // Demote learned rule after 2 overrides (decrement by 2)
    const newCount = Math.max(0, rule.times_confirmed - 2);
    const isLearned = newCount >= 3;

    await query(
      `UPDATE user_preferences
       SET times_confirmed = $1, is_learned_rule = $2, user_confirmed_folder = $3
       WHERE id = $4`,
      [newCount, isLearned, userFolder, rule.id]
    );
    console.log(`[learning] override recorded: ${keyword} demoted to ${newCount} confirmations`);
  } catch (err) {
    console.error('[learning] recordOverride error:', err.message);
  }
}

/**
 * Check if a learned rule exists for the given filename + extension.
 * Returns the destination folder if found, null otherwise.
 *
 * @param {string} filename
 * @param {string} extension
 * @returns {Promise<{folder: string, confidence: number}|null>}
 */
async function checkLearnedRule(filename, extension) {
  const keyword = extractKeyword(filename);
  try {
    const { rows } = await query(
      `SELECT user_confirmed_folder, times_confirmed FROM user_preferences
       WHERE is_learned_rule = true
         AND (pattern_keyword = $1 OR $1 ILIKE '%' || pattern_keyword || '%')
         AND (extension = $2 OR extension IS NULL)
       ORDER BY times_confirmed DESC
       LIMIT 1`,
      [keyword, extension ?? null]
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
 * Return all learned rules for display in Settings.
 * @returns {Promise<object[]>}
 */
async function getAllRules() {
  try {
    const { rows } = await query(
      `SELECT id, pattern_keyword, extension, user_confirmed_folder,
              times_confirmed, is_learned_rule, created_at
       FROM user_preferences
       ORDER BY is_learned_rule DESC, times_confirmed DESC`
    );
    return rows;
  } catch (err) {
    console.error('[learning] getAllRules error:', err.message);
    return [];
  }
}

/**
 * Delete a specific rule by id.
 * @param {string} id UUID
 */
async function deleteRule(id) {
  try {
    await query(`DELETE FROM user_preferences WHERE id = $1`, [id]);
  } catch (err) {
    console.error('[learning] deleteRule error:', err.message);
  }
}

/**
 * Clear all learned rules.
 */
async function clearAllRules() {
  try {
    await query(`DELETE FROM user_preferences`);
    console.log('[learning] all rules cleared');
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
