'use strict';

const express   = require('express');
const router    = express.Router();
const { query } = require('../../db/supabase');

/** Pull device_id from the x-device-id request header. */
function getDeviceId(req) {
  return (req.headers['x-device-id'] || 'unknown').trim();
}

/**
 * GET /api/activity
 * Returns activity log or pending files — scoped to the requesting device.
 */
router.get('/', async (req, res) => {
  const deviceId = getDeviceId(req);
  try {
    const status = req.query.status;
    const limit  = parseInt(req.query.limit) || 100;

    let sql;
    let params;

    if (status === 'pending') {
      // Pending files waiting for approval — this device only
      sql = `
        SELECT id, filename, extension, filepath, suggested_folder,
               confidence_score, ai_reasoning, size_bytes, created_at
        FROM files
        WHERE status = 'pending' AND device_id = $1
        ORDER BY created_at DESC
        LIMIT $2
      `;
      params = [deviceId, limit];
    } else {
      // Activity log — this device only
      sql = `
        SELECT id, action, filename, from_path, to_path,
               file_size_bytes, timestamp
        FROM activity_log
        WHERE device_id = $1
        ORDER BY timestamp DESC
        LIMIT $2
      `;
      params = [deviceId, limit];
    }

    const { rows } = await query(sql, params);

    if (status === 'pending') {
      return res.json(rows);
    }

    // Map activity_log rows to the shape the renderer expects
    const mapped = rows.map((row) => ({
      id:              row.id,
      type:            row.action ?? 'add',
      action:          row.action ?? 'add',
      path:            row.from_path ?? row.to_path ?? '',
      from_path:       row.from_path ?? null,
      to_path:         row.to_path   ?? null,
      fileName:        row.filename,
      filename:        row.filename,
      category:        null,
      size:            row.file_size_bytes,
      file_size_bytes: row.file_size_bytes,
      timestamp:       row.timestamp,
    }));

    return res.json(mapped);
  } catch (err) {
    console.error('[activity]', err);
    return res.status(500).json({ error: err.message });
  }
});

module.exports = router;
