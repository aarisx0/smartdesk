'use strict';

const express = require('express');
const router  = express.Router();
const Store   = require('electron-store');

// Use electron-store (same store the main process uses) for watched folders
let store;
try {
  store = new Store();
} catch {
  store = null;
}

/** GET /api/folders — return saved watched folders */
router.get('/', (_req, res) => {
  try {
    const folders = store?.get('watchedFolders') ?? [];
    return res.json(Array.isArray(folders) ? folders.map((p) => ({ path: p, enabled: true })) : []);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

/** POST /api/folders — body: { folders: string[] } */
router.post('/', (req, res) => {
  try {
    const { folders } = req.body;
    if (!Array.isArray(folders)) return res.status(400).json({ error: 'folders must be an array' });
    store?.set('watchedFolders', folders);
    req.app.locals.io?.emit('folders:updated', folders);
    return res.json({ ok: true, folders });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

module.exports = router;
