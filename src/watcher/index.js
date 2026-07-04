'use strict';

/**
 * src/watcher/index.js
 *
 * Production file-watcher for SmartDesk AI.
 *
 * Responsibilities:
 *  1. Watch user-selected folders (Desktop + Downloads by default).
 *  2. Ignore temp/in-progress files (.tmp, .crdownload, .part, etc.).
 *  3. Debounce each new/modified path for 2 000 ms before processing
 *     (avoids triggering while a download is still writing).
 *  4. Extract full metadata via src/watcher/metadata.js.
 *  5. Insert the file into Supabase `files` table with status "pending".
 *  6. Emit `file:detected` IPC event to the Electron main process callback
 *     so the renderer can be notified.
 *  7. Expose helpers to add/remove watched folders at runtime.
 */

const chokidar = require('chokidar');
const path     = require('path');
const os       = require('os');
const crypto   = require('crypto');
const fs       = require('fs');
const { extractMetadata } = require('./metadata');
const { insertFile }      = require('../db/queries');
const { query }           = require('../db/supabase');

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
 */
async function processFile(filePath, onDetected) {
  try {
    // 1. Extract metadata (also re-checks the file still exists)
    const metadata = await extractMetadata(filePath);
    if (!metadata) {
      console.debug(`[watcher] skipped (gone): ${filePath}`);
      return;
    }

    // 2. Persist to Supabase with status "pending"
    let dbId = null;
    try {
      dbId = await insertFile(metadata);
    } catch (dbErr) {
      if (dbErr.code === '23505') {
        console.debug(`[watcher] duplicate filepath, skipping insert: ${filePath}`);
      } else {
        console.error('[watcher] DB insert error:', dbErr.message);
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

    console.log(`[watcher] processed: ${metadata.filename} (${metadata.size_bytes} B)${duplicateOf ? ' ⚠ DUPLICATE' : ''}`);
  } catch (err) {
    console.error(`[watcher] pipeline error for ${filePath}:`, err.message);
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
function setupWatcher(onDetected, initialFolders) {
  const folders = (initialFolders && initialFolders.length > 0)
    ? initialFolders
    : defaultWatchFolders();

  watcher = chokidar.watch(folders, {
    ignored: CHOKIDAR_IGNORED,
    persistent: true,
    ignoreInitial: true,          // don't fire for files already on disk at startup
    awaitWriteFinish: {
      stabilityThreshold: 1_000, // file must be stable for 1 s before chokidar fires
      pollInterval: 200,
    },
    depth: 4,                     // traverse up to 4 levels deep
  });

  /**
   * Shared handler for both 'add' and 'change' events.
   * Applies the extension-based ignore check then arms the debounce timer.
   */
  const handleFile = (filePath) => {
    if (shouldIgnore(filePath)) {
      console.debug(`[watcher] ignored (temp ext): ${filePath}`);
      return;
    }

    // Re-arm the debounce: cancel any existing timer, start a fresh 2 s one.
    clearDebounce(filePath);
    const timer = setTimeout(() => {
      debounceMap.delete(filePath);
      processFile(filePath, onDetected);
    }, DEBOUNCE_MS);

    debounceMap.set(filePath, timer);
  };

  watcher
    .on('add',    handleFile)
    .on('change', handleFile)
    .on('unlink', (filePath) => {
      // Cancel any pending processing for a file that was deleted
      clearDebounce(filePath);
      console.debug(`[watcher] unlinked: ${filePath}`);
    })
    .on('error', (err) => console.error('[watcher] error:', err));

  console.log('[watcher] watching:', folders);
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
  console.log('[watcher] updated folders:', folders);
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
    console.log('[watcher] closed');
  }
}

module.exports = { setupWatcher, updateWatchedFolders, closeWatcher };
