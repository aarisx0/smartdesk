'use strict';

const express   = require('express');
const router    = express.Router();
const fs        = require('fs/promises');
const path      = require('path');
const { query } = require('../../db/supabase');
const learning  = require('../learning');

/**
 * POST /api/moves/approve
 * Body: { fileId: string, approved: boolean }
 */
router.post('/approve', async (req, res) => {
  try {
    const { fileId, approved } = req.body;
    if (!fileId) return res.status(400).json({ error: 'fileId is required' });

    // Fetch file record from the `files` table
    const { rows } = await query(
      `SELECT * FROM files WHERE id = $1 LIMIT 1`,
      [fileId]
    );

    if (!rows.length) return res.status(404).json({ error: 'File not found' });
    const file = rows[0];

    if (approved && file.filepath && file.suggested_folder) {
      // Build destination path: suggested_folder / filename
      const destDir  = file.suggested_folder;
      const destPath = path.join(destDir, file.filename);

      try {
        // Create destination directory if needed
        await fs.mkdir(destDir, { recursive: true });
        // Move the file
        await fs.rename(file.filepath, destPath);

        // Mark as moved + record learning
        await query(
          `UPDATE files SET status = 'moved', updated_at = now() WHERE id = $1`,
          [fileId]
        );

        // Log to activity_log
        await query(
          `INSERT INTO activity_log (action, filename, from_path, to_path, file_size_bytes)
           VALUES ('moved', $1, $2, $3, $4)`,
          [file.filename, file.filepath, destPath, file.size_bytes ?? null]
        );

        // Record learning approval
        try {
          await learning.recordApproval({
            filename:  file.filename,
            extension: file.extension,
            aiFolder:  file.suggested_folder,
            userFolder: destPath,
          });
        } catch { /* non-fatal */ }

        // Update session counter
        await query(
          `INSERT INTO sessions (session_date, files_processed, folders_created, storage_saved_bytes)
           VALUES (CURRENT_DATE, 1, 1, $1)
           ON CONFLICT (session_date) DO UPDATE
           SET files_processed    = sessions.files_processed + 1,
               storage_saved_bytes = sessions.storage_saved_bytes + EXCLUDED.storage_saved_bytes`,
          [file.size_bytes ?? 0]
        );

      } catch (moveErr) {
        console.error('[moves/approve] file move error:', moveErr.message);
        return res.status(500).json({ error: `Could not move file: ${moveErr.message}` });
      }
    } else if (!approved) {
      // Skipped
      await query(
        `UPDATE files SET status = 'skipped', updated_at = now() WHERE id = $1`,
        [fileId]
      );
      await query(
        `INSERT INTO activity_log (action, filename, from_path, to_path, file_size_bytes)
         VALUES ('skipped', $1, $2, NULL, $3)`,
        [file.filename, file.filepath, file.size_bytes ?? null]
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
