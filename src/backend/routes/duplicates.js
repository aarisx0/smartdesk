'use strict';

const express    = require('express');
const router     = express.Router();
const duplicates = require('../duplicates');
const path       = require('path');
const os         = require('os');

// GET /api/duplicates — return stored unresolved groups
router.get('/', async (_req, res) => {
  try {
    const groups = await duplicates.getGroups();
    res.json(groups);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/duplicates/scan — trigger a fresh scan
// Body: { folders?: string[] }  — if omitted, falls back to Desktop + Downloads
router.post('/scan', async (req, res) => {
  try {
    let folders = req.body?.folders;

    // Fallback: use Desktop + Downloads
    if (!Array.isArray(folders) || folders.length === 0) {
      const home = os.homedir();
      folders = [
        path.join(home, 'Desktop'),
        path.join(home, 'Downloads'),
      ];
    }

    console.log('[duplicates] scanning folders:', folders);
    const groups = await duplicates.scan(folders);
    res.json({ groups, count: groups.length });
  } catch (err) {
    console.error('[duplicates/scan]', err);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/duplicates/resolve — mark a group resolved
router.post('/resolve', async (req, res) => {
  try {
    const { hash } = req.body;
    await duplicates.markResolved(hash);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
