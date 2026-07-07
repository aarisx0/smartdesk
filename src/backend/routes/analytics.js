'use strict';

const express = require('express');
const router  = express.Router();
const { query } = require('../../db/supabase');

/** Pull device_id from the x-device-id request header. */
function getDeviceId(req) {
  return (req.headers['x-device-id'] || 'unknown').trim();
}

/** GET /api/analytics — all chart data scoped to the requesting device */
router.get('/', async (req, res) => {
  const deviceId = getDeviceId(req);
  try {
    const [dailyRes, extRes, folderRes, activityRes] = await Promise.all([

      // Daily activity — use activity_log as source of truth for moves
      // Also pull from sessions for storage_saved_bytes
      query(
        `SELECT
           DATE(timestamp) AS session_date,
           COUNT(*)::int   AS files_processed,
           COALESCE(SUM(file_size_bytes), 0)::bigint AS storage_saved_bytes
         FROM activity_log
         WHERE action = 'moved'
           AND device_id = $1
           AND timestamp >= CURRENT_DATE - INTERVAL '30 days'
         GROUP BY DATE(timestamp)
         ORDER BY session_date ASC`,
        [deviceId]
      ),

      // File type breakdown — use all classified/moved files
      query(
        `SELECT extension, COUNT(*)::int AS count
         FROM files
         WHERE status IN ('classified', 'moved')
           AND device_id = $1
         GROUP BY extension`,
        [deviceId]
      ),

      // Top destination folders — from activity_log to_path
      query(
        `SELECT to_path AS suggested_folder, COUNT(*)::int AS count
         FROM activity_log
         WHERE action = 'moved'
           AND to_path IS NOT NULL
           AND device_id = $1
         GROUP BY to_path
         ORDER BY count DESC
         LIMIT 5`,
        [deviceId]
      ),

      // Recent activity feed
      query(
        `SELECT id, action, filename, from_path, to_path, file_size_bytes, timestamp
         FROM activity_log
         WHERE device_id = $1
         ORDER BY timestamp DESC
         LIMIT 200`,
        [deviceId]
      ),
    ]);

    const daily = (dailyRes.rows || []).map((r) => ({
      date:    r.session_date,
      files:   Number(r.files_processed   || 0),
      storage: Number(r.storage_saved_bytes || 0),
    }));

    const totalOrganized = daily.reduce((sum, row) => sum + row.files, 0);
    const totalStorage   = daily.reduce((sum, row) => sum + row.storage, 0);
    const bestDay        = daily.reduce(
      (best, row) => (row.files > (best?.files || -1) ? row : best), null
    );
    const avgPerDay = daily.length > 0
      ? Math.round(totalOrganized / daily.length)
      : 0;

    const categories = (extRes.rows || [])
      .map((r) => ({
        name:  (r.extension || 'other').replace('.', '') || 'other',
        value: Number(r.count || 0),
      }))
      .sort((a, b) => b.value - a.value)
      .slice(0, 8);

    // Simplify top folders — use just the last folder name from path
    const topFolders = (folderRes.rows || []).map((r) => {
      const p = r.suggested_folder || '';
      const parts = p.replace(/\\/g, '/').split('/').filter(Boolean);
      return {
        folder: parts[parts.length - 1] || p,
        fullPath: p,
        count: Number(r.count || 0),
      };
    });

    const activity = (activityRes.rows || []).map((r) => ({
      id:              r.id,
      action:          r.action,
      filename:        r.filename,
      from_path:       r.from_path,
      to_path:         r.to_path,
      file_size_bytes: r.file_size_bytes,
      timestamp:       r.timestamp,
    }));

    return res.json({
      daily,
      categories,
      topFolders,
      activity,
      totals: {
        organized: totalOrganized,
        storage:   totalStorage,
        bestDay:   bestDay?.date || null,
        avgPerDay,
      },
    });
  } catch (err) {
    console.error('[analytics]', err);
    return res.status(500).json({ error: err.message });
  }
});

module.exports = router;
