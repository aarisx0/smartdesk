'use strict';

const express   = require('express');
const router    = express.Router();
const fs        = require('fs/promises');
const path      = require('path');
const { query } = require('../../db/supabase');
const learning  = require('../learning');

/** Pull device_id from the x-device-id request header. */
function getDeviceId(req) {
  return (req.headers['x-device-id'] || 'unknown').trim();
}

/**
 * POST /api/moves/approve
 * Body: { fileId: string, approved: boolean }
 */
router.post('/approve', async (req, res) => {
  const deviceId = getDeviceId(req);
  try {
    const { fileId, approved } = req.body;
    if (!fileId) return res.status(400).json({ error: 'fileId is required' });

    // Fetch file record — must belong to this device
    const { rows } = await query(
      `SELECT * FROM files WHERE id = $1 AND device_id = $2 LIMIT 1`,
      [fileId, deviceId]
    );

    if (!rows.length) return res.status(404).json({ error: 'File not found' });
    const file = rows[0];

    if (approved && file.filepath && file.suggested_folder) {
      const destDir  = file.suggested_folder;
      const destPath = path.join(destDir, file.filename);

      try {
        await fs.mkdir(destDir, { recursive: true });
        await fs.rename(file.filepath, destPath);

        // Mark as moved
        await query(
          `UPDATE files SET status = 'moved', updated_at = now() WHERE id = $1`,
          [fileId]
        );

        // Log to activity_log — include device_id
        await query(
          `INSERT INTO activity_log (device_id, action, filename, from_path, to_path, file_size_bytes)
           VALUES ($1, 'moved', $2, $3, $4, $5)`,
          [deviceId, file.filename, file.filepath, destPath, file.size_bytes ?? null]
        );

        // Record learning — pass deviceId so the rule is scoped to this device
        try {
          await learning.recordApproval({
            filename:   file.filename,
            extension:  file.extension,
            aiFolder:   file.suggested_folder,
            userFolder: destPath,
            deviceId,
          });
        } catch { /* non-fatal */ }

        // Update session counter — scoped to device
        await query(
          `INSERT INTO sessions (device_id, session_date, files_processed, folders_created, storage_saved_bytes)
           VALUES ($1, CURRENT_DATE, 1, 1, $2)
           ON CONFLICT (device_id, session_date) DO UPDATE
           SET files_processed     = sessions.files_processed + 1,
               folders_created     = sessions.folders_created + 1,
               storage_saved_bytes = sessions.storage_saved_bytes + EXCLUDED.storage_saved_bytes`,
          [deviceId, file.size_bytes ?? 0]
        );

      } catch (moveErr) {
        console.error('[moves/approve] file move error:', moveErr.message);
        return res.status(500).json({ error: `Could not move file: ${moveErr.message}` });
      }

    } else if (!approved) {
      // Skipped — mark file and log it
      await query(
        `UPDATE files SET status = 'skipped', updated_at = now() WHERE id = $1`,
        [fileId]
      );
      await query(
        `INSERT INTO activity_log (device_id, action, filename, from_path, to_path, file_size_bytes)
         VALUES ($1, 'skipped', $2, $3, NULL, $4)`,
        [deviceId, file.filename, file.filepath, file.size_bytes ?? null]
      );
    }

    req.app.locals.io?.emit('file:moved', { fileId, approved });
    return res.json({ success: true, fileId, approved });

  } catch (err) {
    console.error('[moves/approve]', err);
    return res.status(500).json({ error: err.message });
  }
});

module.exports = router;
