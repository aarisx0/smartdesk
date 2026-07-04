'use strict';

const express   = require('express');
const router    = express.Router();
const { query } = require('../../db/supabase');

/** GET /api/stats — summary counts from the files and sessions tables */
router.get('/', async (_req, res) => {
  try {
    const today = new Date().toISOString().slice(0, 10);

    const [movedRes, classifiedRes, pendingRes, sessionRes] = await Promise.all([
      query(`SELECT COUNT(*) FROM files WHERE status = 'moved'`),
      query(`SELECT COUNT(*) FROM files WHERE status IN ('classified','moved')`),
      query(`SELECT COUNT(*) FROM files WHERE status = 'pending'`),
      query(`SELECT files_processed, folders_created, duplicates_removed, storage_saved_bytes
             FROM sessions WHERE session_date = $1 LIMIT 1`, [today]),
    ]);

    const session = sessionRes.rows[0] ?? {};

    return res.json({
      filesOrganized:    parseInt(movedRes.rows[0].count)      ?? 0,
      classified:        parseInt(classifiedRes.rows[0].count) ?? 0,
      approvals:         parseInt(pendingRes.rows[0].count)    ?? 0,
      accuracy:          0,
      // Session stats
      files_processed:   session.files_processed      ?? 0,
      folders_created:   session.folders_created      ?? 0,
      duplicates_removed: session.duplicates_removed  ?? 0,
      storage_saved_bytes: session.storage_saved_bytes ?? 0,
    });
  } catch (err) {
    console.error('[stats]', err);
    return res.status(500).json({ error: err.message });
  }
});

module.exports = router;
