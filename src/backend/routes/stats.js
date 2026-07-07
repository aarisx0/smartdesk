'use strict';

const express   = require('express');
const router    = express.Router();
const { query } = require('../../db/supabase');

/** Pull device_id from the x-device-id request header. */
function getDeviceId(req) {
  return (req.headers['x-device-id'] || 'unknown').trim();
}

/** GET /api/stats — summary counts scoped to the requesting device */
router.get('/', async (req, res) => {
  const deviceId = getDeviceId(req);
  try {
    const today = new Date().toISOString().slice(0, 10);

    const [movedRes, classifiedRes, pendingRes, sessionRes] = await Promise.all([
      // Files organized = moved actions in activity_log (source of truth for moves)
      query(
        `SELECT COUNT(*) FROM activity_log WHERE action = 'moved' AND device_id = $1`,
        [deviceId]
      ),
      // Classified = files with status classified OR moved
      query(
        `SELECT COUNT(*) FROM files WHERE status IN ('classified','moved') AND device_id = $1`,
        [deviceId]
      ),
      // Pending = files waiting for approval
      query(
        `SELECT COUNT(*) FROM files WHERE status = 'pending' AND device_id = $1`,
        [deviceId]
      ),
      // Today's session stats
      query(
        `SELECT files_processed, folders_created, duplicates_removed, storage_saved_bytes
         FROM sessions
         WHERE session_date = $1 AND device_id = $2
         LIMIT 1`,
        [today, deviceId]
      ),
    ]);

    const session = sessionRes.rows[0] ?? {};

    // files_processed in session tracks today's moves; fall back to total moved count
    const filesOrganized = parseInt(movedRes.rows[0]?.count ?? '0') || 0;
    const filesProcessed = session.files_processed ?? filesOrganized;

    return res.json({
      filesOrganized,
      classified:          parseInt(classifiedRes.rows[0]?.count ?? '0') || 0,
      approvals:           parseInt(pendingRes.rows[0]?.count    ?? '0') || 0,
      accuracy:            0,
      files_processed:     filesProcessed,
      folders_created:     session.folders_created      ?? 0,
      duplicates_removed:  session.duplicates_removed   ?? 0,
      storage_saved_bytes: session.storage_saved_bytes  ?? 0,
    });
  } catch (err) {
    console.error('[stats]', err);
    return res.status(500).json({ error: err.message });
  }
});

module.exports = router;
