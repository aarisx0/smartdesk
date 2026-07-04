'use strict';

const express   = require('express');
const router    = express.Router();
const { query } = require('../../db/supabase');

/**
 * GET /api/activity
 * Returns the 100 most recent entries from activity_log
 * and optionally from watcher events sent via IPC.
 */
router.get('/', async (req, res) => {
  try {
    const status = req.query.status;
    const limit  = parseInt(req.query.limit) || 100;

    let sql;
    let params;

    if (status === 'pending') {
      // Return pending files for chat/approvals use
      sql    = `SELECT id, filename, extension, filepath, suggested_folder,
                       confidence_score, ai_reasoning, size_bytes, created_at
                FROM files WHERE status = 'pending'
                ORDER BY created_at DESC LIMIT $1`;
      params = [limit];
    } else {
      sql    = `SELECT id, action, filename, from_path, to_path,
                       file_size_bytes, timestamp
                FROM activity_log
                ORDER BY timestamp DESC LIMIT $1`;
      params = [limit];
    }

    const { rows } = await query(sql, params);

    if (status === 'pending') {
      return res.json(rows);
    }

    // Map activity_log rows to the shape the renderer expects
    const mapped = rows.map((row) => ({
      id:        row.id,
      type:      row.action ?? 'add',
      action:    row.action ?? 'add',
      path:      row.from_path ?? row.to_path ?? '',
      from_path: row.from_path ?? null,
      to_path:   row.to_path ?? null,
      fileName:  row.filename,
      filename:  row.filename,
      category:  null,
      size:      row.file_size_bytes,
      file_size_bytes: row.file_size_bytes,
      timestamp: row.timestamp,
    }));

    return res.json(mapped);
  } catch (err) {
    console.error('[activity]', err);
    return res.status(500).json({ error: err.message });
  }
});

module.exports = router;
