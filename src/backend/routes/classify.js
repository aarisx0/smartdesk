'use strict';

const express   = require('express');
const router    = express.Router();
const path      = require('path');
const { query } = require('../../db/supabase');

/**
 * POST /api/classify
 * Body: { filePath: string }
 * Triggers watsonx classification on the file and inserts/updates the files table.
 */
router.post('/', async (req, res) => {
  try {
    const { filePath } = req.body;
    if (!filePath) return res.status(400).json({ error: 'filePath is required' });

    const ext      = path.extname(filePath).toLowerCase();
    const filename = path.basename(filePath);

    // Look up existing record
    const existing = await query(
      `SELECT id, suggested_folder, confidence_score, ai_reasoning, status FROM files WHERE filepath = $1 LIMIT 1`,
      [filePath]
    );

    if (existing.rows.length > 0) {
      return res.json(existing.rows[0]);
    }

    // Insert as pending — watcher/watsonx will classify it
    const insert = await query(
      `INSERT INTO files (filename, extension, filepath, status)
       VALUES ($1, $2, $3, 'pending')
       ON CONFLICT (filepath) DO UPDATE SET status = files.status
       RETURNING id, filename, extension, filepath, status, suggested_folder, confidence_score`,
      [filename, ext, filePath]
    );

    req.app.locals.io?.emit('file:pending', insert.rows[0]);
    return res.json(insert.rows[0]);
  } catch (err) {
    console.error('[classify]', err);
    return res.status(500).json({ error: err.message });
  }
});

module.exports = router;
