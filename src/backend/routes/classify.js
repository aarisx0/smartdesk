'use strict';

const express   = require('express');
const router    = express.Router();
const path      = require('path');
const { query } = require('../../db/supabase');

/** Pull device_id from the x-device-id request header. */
function getDeviceId(req) {
  return (req.headers['x-device-id'] || 'unknown').trim();
}

/**
 * POST /api/classify
 * Body: { filePath: string }
 * Triggers watsonx classification on the file and inserts/updates the files table.
 */
router.post('/', async (req, res) => {
  const deviceId = getDeviceId(req);
  try {
    const { filePath } = req.body;
    if (!filePath) return res.status(400).json({ error: 'filePath is required' });

    const ext      = path.extname(filePath).toLowerCase();
    const filename = path.basename(filePath);

    // Look up existing record for this device
    const existing = await query(
      `SELECT id, suggested_folder, confidence_score, ai_reasoning, status
       FROM files
       WHERE filepath = $1 AND device_id = $2
       LIMIT 1`,
      [filePath, deviceId]
    );

    if (existing.rows.length > 0) {
      return res.json(existing.rows[0]);
    }

    // Insert as pending — tagged with device_id
    const insert = await query(
      `INSERT INTO files (device_id, filename, extension, filepath, status)
       VALUES ($1, $2, $3, $4, 'pending')
       ON CONFLICT (device_id, filepath) DO UPDATE SET status = files.status
       RETURNING id, filename, extension, filepath, status, suggested_folder, confidence_score`,
      [deviceId, filename, ext, filePath]
    );

    req.app.locals.io?.emit('file:pending', insert.rows[0]);
    return res.json(insert.rows[0]);
  } catch (err) {
    console.error('[classify]', err);
    return res.status(500).json({ error: err.message });
  }
});

module.exports = router;
