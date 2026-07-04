'use strict';

/**
 * src/main/orchestratePreload.js
 *
 * Minimal preload for the hidden orchestrate BrowserWindow.
 * Its only job is to let the embed page fire `orchestrate:ready`
 * back to the main process once the agent chat has loaded.
 */

const { ipcRenderer } = require('electron');

// Expose a tiny bridge on window so the embed page can call it
window.__smartdeskBridge = {
  signalReady() {
    ipcRenderer.send('orchestrate:ready');
  },
};
