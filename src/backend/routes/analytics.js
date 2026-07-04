'use strict';

const express = require('express');
const router = express.Router();
const { query } = require('../../db/supabase');

router.get('/', async (_req, res) => {
  try {
    const [dailyRes, extRes, folderRes, activityRes] = await Promise.all([
      query(
        `SELECT session_date, files_processed, storage_saved_bytes
         FROM sessions
         WHERE session_date >= CURRENT_DATE - INTERVAL '30 days'
         ORDER BY session_date ASC`
      ),
      query(
        `SELECT extension, COUNT(*)::int AS count
         FROM files
         WHERE status IN ('classified', 'moved')
         GROUP BY extension`
      ),
      query(
        `SELECT suggested_folder, COUNT(*)::int AS count
         FROM files
         WHERE status = 'moved' AND suggested_folder IS NOT NULL
         GROUP BY suggested_folder
         ORDER BY count DESC
         LIMIT 5`
      ),
      query(
        `SELECT id, action, filename, from_path, to_path, file_size_bytes, timestamp
         FROM activity_log
         ORDER BY timestamp DESC
         LIMIT 200`
      ),
    ]);

    const daily = (dailyRes.rows || []).map((r) => ({
      date: r.session_date,
      files: Number(r.files_processed || 0),
      storage: Number(r.storage_saved_bytes || 0),
    }));

    const totalOrganized = daily.reduce((sum, row) => sum + row.files, 0);
    const totalStorage = daily.reduce((sum, row) => sum + row.storage, 0);
    const bestDay = daily.reduce((best, row) => (row.files > (best?.files || -1) ? row : best), null);
    const avgPerDay = daily.length > 0 ? Math.round(totalOrganized / daily.length) : 0;

    const categories = (extRes.rows || [])
      .map((r) => ({
        name: (r.extension || 'other').replace('.', '') || 'other',
        value: Number(r.count || 0),
      }))
      .sort((a, b) => b.value - a.value)
      .slice(0, 8);

    const topFolders = (folderRes.rows || []).map((r) => ({
      folder: r.suggested_folder,
      count: Number(r.count || 0),
    }));

    const activity = (activityRes.rows || []).map((r) => ({
      id: r.id,
      action: r.action,
      filename: r.filename,
      from_path: r.from_path,
      to_path: r.to_path,
      file_size_bytes: r.file_size_bytes,
      timestamp: r.timestamp,
    }));

    return res.json({
      daily,
      categories,
      topFolders,
      activity,
      totals: {
        organized: totalOrganized,
        storage: totalStorage,
        bestDay: bestDay?.date || null,
        avgPerDay,
      },
    });
  } catch (err) {
    console.error('[analytics]', err);
    return res.status(500).json({ error: err.message });
  }
});

module.exports = router;
