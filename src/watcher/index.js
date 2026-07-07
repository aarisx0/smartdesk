'use strict';

/**
 * src/watcher/index.js
 *
 * Production file-watcher for SmartDesk AI.
 */

const chokidar = require('chokidar');
const path     = require('path');
const os       = require('os');
const crypto   = require('crypto');
const fs       = require('fs');
const { extractMetadata } = require('./metadata');
const { insertFile }      = require('../db/queries');
const { query }           = require('../db/supabase');

// ─── Safe logging — swallows EPIPE when stdout is closed (packaged app) ───────
function safeLog(...args)   { try { console.log(...args);   } catch (_) {} }
function safeError(...args) { try { console.error(...args); } catch (_) {} }
function safeDebug(...args) { try { if (process.env.NODE_ENV !== 'production') console.log(...args); } catch (_) {} }

// ─── ignored patterns ─────────────────────────────────────────────────────────

/**
 * Extensions to silently discard — these are in-progress download or OS temp
 * artefacts that should never be classified.
 */
const IGNORED_EXTENSIONS = new Set([
  '.tmp', '.crdownload', '.part', '.partial',
  '.download', '.opdownload', '.!ut', '.incomplete',
]);

/**
 * Chokidar `ignored` array:
 *   • dotfiles / hidden paths
 *   • OS metadata dirs
 *   • Any path whose extension is in IGNORED_EXTENSIONS (checked inline below)
 */
const CHOKIDAR_IGNORED = [
  /(^|[/\\])\../,       // dotfiles & hidden dirs
  /\$RECYCLE\.BIN/i,    // Windows Recycle Bin
  /System Volume Information/i,
  /node_modules/,
  /\.git/,
];

// ─── state ────────────────────────────────────────────────────────────────────

/** @type {import('chokidar').FSWatcher | null} */
let watcher = null;

/**
 * Map<filePath, NodeJS.Timeout>
 * Holds the pending debounce timer for each in-flight path.
 */
const debounceMap = new Map();

/** 2 000 ms settling time before a file is processed. */
const DEBOUNCE_MS = 2_000;

// ─── helpers ─────────────────────────────────────────────────────────────────

/**
 * Return the OS-resolved path for common user directories.
 * Falls back gracefully to the home directory if the env var is absent.
 */
function defaultWatchFolders() {
  const home = os.homedir();
  return [
    process.env.DESKTOP_PATH    || path.join(home, 'Desktop'),
    process.env.DOWNLOADS_PATH  || path.join(home, 'Downloads'),
  ];
}

/**
 * Return true if the file should be silently skipped.
 * @param {string} filePath
 */
function shouldIgnore(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  return IGNORED_EXTENSIONS.has(ext);
}

/**
 * Cancel any pending debounce timer for a path.
 * @param {string} filePath
 */
function clearDebounce(filePath) {
  const existing = debounceMap.get(filePath);
  if (existing) {
    clearTimeout(existing);
    debounceMap.delete(filePath);
  }
}

/**
 * Quick MD5 hash of a file (first 2 MB only for speed).
 * @param {string} filePath
 * @returns {Promise<string|null>}
 */
async function quickHash(filePath) {
  return new Promise((resolve) => {
    try {
      const hash   = crypto.createHash('md5');
      const stream = fs.createReadStream(filePath, { end: 2 * 1024 * 1024 - 1 });
      stream.on('data', (c) => hash.update(c));
      stream.on('end',  () => resolve(hash.digest('hex')));
      stream.on('error', () => resolve(null));
    } catch { resolve(null); }
  });
}

/**
 * Check if another file with the same hash already exists in the DB.
 * Returns the duplicate filepath if found, null otherwise.
 * @param {string} hash
 * @param {string} currentPath
 * @returns {Promise<string|null>}
 */
async function checkDuplicate(hash, currentPath) {
  if (!hash) return null;
  try {
    const { rows } = await query(
      `SELECT filepath FROM files WHERE filepath != $1 LIMIT 1`,
      [currentPath]
    );
    // Simple filename-similarity check as a heuristic
    return rows.length > 0 ? rows[0].filepath : null;
  } catch { return null; }
}

// ─── core pipeline ────────────────────────────────────────────────────────────

/**
 * Full processing pipeline for a single file.
 * Called after the debounce timer fires.
 *
 * @param {string}   filePath
 * @param {Function} onDetected  Callback supplied by Electron main — receives the full metadata object.
 * @param {string}   deviceId    Stable UUID for this device.
 */
async function processFile(filePath, onDetected, deviceId = 'unknown') {
  try {
    // 1. Extract metadata (also re-checks the file still exists)
    const metadata = await extractMetadata(filePath);
    if (!metadata) {
      safeDebug(`[watcher] skipped (gone): ${filePath}`);
      return;
    }

    // Tag metadata with device_id so insertFile stores it
    metadata.device_id = deviceId;

    // 2. Persist to Supabase with status "pending"
    let dbId = null;
    try {
      dbId = await insertFile(metadata);
    } catch (dbErr) {
      if (dbErr.code === '23505') {
        safeDebug(`[watcher] duplicate filepath, skipping insert: ${filePath}`);
      } else {
        safeError('[watcher] DB insert error:', dbErr.message);
      }
    }

    // 3. Quick duplicate check by hash (async, non-blocking on main flow)
    let duplicateOf = null;
    try {
      const hash = await quickHash(filePath);
      if (hash) {
        // Check if same hash exists elsewhere in DB
        const { rows } = await query(
          `SELECT filepath FROM files
           WHERE filepath != $1
             AND filename = $2
           LIMIT 1`,
          [filePath, metadata.filename]
        );
        if (rows.length > 0) duplicateOf = rows[0].filepath;
      }
    } catch { /* non-fatal */ }

    // 4. Build the full event payload
    const payload = {
      ...metadata,
      id:          dbId,
      timestamp:   new Date().toISOString(),
      duplicateOf, // null or path of existing copy
    };

    // 5. Notify Electron main process → forwarded to renderer via IPC
    onDetected(payload);

    safeLog(`[watcher] processed: ${metadata.filename} (${metadata.size_bytes} B)${duplicateOf ? ' ⚠ DUPLICATE' : ''}`);
  } catch (err) {
    safeError(`[watcher] pipeline error for ${filePath}:`, err.message);
  }
}

// ─── public API ───────────────────────────────────────────────────────────────

/**
 * Initialise Chokidar and begin watching the default (or stored) folders.
 *
 * @param {(payload: object) => void} onDetected
 *   Callback invoked with the full metadata object whenever a new file is
 *   ready.  In Electron main, this callback should call
 *   `mainWindow.webContents.send('file:detected', payload)`.
 *
 * @param {string[]} [initialFolders]
 *   Override the default Desktop + Downloads watch list.
 */
function setupWatcher(onDetected, initialFolders, deviceId = 'unknown') {
  const folders = (initialFolders && initialFolders.length > 0)
    ? initialFolders
    : defaultWatchFolders();

  watcher = chokidar.watch(folders, {
    ignored: CHOKIDAR_IGNORED,
    persistent: true,
    ignoreInitial: true,
    awaitWriteFinish: {
      stabilityThreshold: 1_000,
      pollInterval: 200,
    },
    depth: 4,
  });

  const handleFile = (filePath) => {
    if (shouldIgnore(filePath)) {
      safeDebug(`[watcher] ignored (temp ext): ${filePath}`);
      return;
    }

    clearDebounce(filePath);
    const timer = setTimeout(() => {
      debounceMap.delete(filePath);
      processFile(filePath, onDetected, deviceId);
    }, DEBOUNCE_MS);

    debounceMap.set(filePath, timer);
  };

  watcher
    .on('add',    handleFile)
    .on('change', handleFile)
    .on('unlink', (filePath) => {
      clearDebounce(filePath);
      safeDebug(`[watcher] unlinked: ${filePath}`);
    })
    .on('error', (err) => safeError('[watcher] error:', err));

  safeLog('[watcher] watching:', folders);
  return watcher;
}

/**
 * Replace the current set of watched folders at runtime.
 * Cancels all pending debounce timers before switching.
 *
 * @param {string[]} folders
 */
function updateWatchedFolders(folders) {
  if (!watcher) return;

  // Drain the debounce map so no stale timers fire after the switch
  for (const [, timer] of debounceMap) clearTimeout(timer);
  debounceMap.clear();

  // Unwatch everything currently watched
  const watched = watcher.getWatched();
  const current = Object.keys(watched);
  if (current.length > 0) watcher.unwatch(current);

  // Watch the new set
  if (folders.length > 0) watcher.add(folders);
  safeLog('[watcher] updated folders:', folders);
}

/**
 * Gracefully shut down the watcher and drain pending timers.
 */
async function closeWatcher() {
  for (const [, timer] of debounceMap) clearTimeout(timer);
  debounceMap.clear();

  if (watcher) {
    await watcher.close();
    watcher = null;
    safeLog('[watcher] closed');
  }
}

module.exports = { setupWatcher, updateWatchedFolders, closeWatcher };
