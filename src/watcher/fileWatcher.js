const chokidar = require('chokidar');
const path = require('path');
const axios = require('axios');
// NOTE: dotenv is loaded centrally in src/main/index.ts before any module is required.

const BACKEND_URL = process.env.BACKEND_URL || 'http://localhost:3001';

/** @type {import('chokidar').FSWatcher | null} */
let watcher = null;

/**
 * @typedef {Object} WatcherEvent
 * @property {'add'|'change'|'unlink'|'addDir'|'unlinkDir'} type
 * @property {string} path
 * @property {string} timestamp
 * @property {number} [size]
 * @property {string} [ext]
 */

/**
 * Set up the Chokidar file watcher.
 * @param {(event: WatcherEvent) => void} onEvent  Callback forwarded to Electron IPC → renderer
 */
function setupWatcher(onEvent) {
  // Start watching an empty set; folders are added dynamically
  watcher = chokidar.watch([], {
    ignored: [
      /(^|[/\\])\../,             // dotfiles
      /node_modules/,
      /\.git/,
      /dist/,
      /release/,
    ],
    persistent: true,
    ignoreInitial: true,
    awaitWriteFinish: {
      stabilityThreshold: 800,
      pollInterval: 100,
    },
    depth: 5,
  });

  const emit = (type) => async (filePath, stats) => {
    /** @type {WatcherEvent} */
    const event = {
      type,
      path: filePath,
      timestamp: new Date().toISOString(),
      size: stats?.size,
      ext: path.extname(filePath).toLowerCase() || undefined,
    };

    // Forward to Electron renderer
    onEvent(event);

    // Only classify actual files being added
    if (type === 'add') {
      try {
        await axios.post(`${BACKEND_URL}/api/classify`, { filePath });
      } catch (err) {
        console.error('[watcher] classify error:', err.message);
      }
    }
  };

  watcher
    .on('add', emit('add'))
    .on('change', emit('change'))
    .on('unlink', emit('unlink'))
    .on('addDir', emit('addDir'))
    .on('unlinkDir', emit('unlinkDir'))
    .on('error', (err) => console.error('[watcher] error:', err));

  console.log('[watcher] ready');
}

/**
 * Dynamically add or remove watched folders at runtime.
 * @param {string[]} folders
 */
function updateWatchedFolders(folders) {
  if (!watcher) return;
  // Clear existing paths
  const watched = watcher.getWatched();
  Object.keys(watched).forEach((dir) => watcher.unwatch(dir));
  // Add new paths
  if (folders.length > 0) watcher.add(folders);
  console.log('[watcher] now watching:', folders);
}

/**
 * Gracefully close the watcher.
 */
async function closeWatcher() {
  if (watcher) {
    await watcher.close();
    watcher = null;
    console.log('[watcher] closed');
  }
}

module.exports = { setupWatcher, updateWatchedFolders, closeWatcher };
