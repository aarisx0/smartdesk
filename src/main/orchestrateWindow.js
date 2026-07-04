'use strict';

/**
 * src/main/orchestrateWindow.js
 *
 * Creates and manages the hidden BrowserWindow that hosts the
 * watsonx Orchestrate embed script.  The window is invisible to the
 * user but stays alive for the entire app session so the agent
 * remains connected and warm.
 *
 * Usage (main process only):
 *   const { createOrchestrateWindow, getOrchestrateWindow } = require('./orchestrateWindow');
 *   await createOrchestrateWindow();           // call once on app ready
 *   const win = getOrchestrateWindow();        // anywhere thereafter
 */

const { BrowserWindow } = require('electron');
const path = require('path');

/** @type {BrowserWindow | null} */
let orchestrateWindow = null;

/** Resolve when the embed page signals it is ready. */
let readyResolve = null;
const readyPromise = new Promise((resolve) => { readyResolve = resolve; });

/**
 * Create the hidden orchestrate window and wait for the page to
 * declare itself ready via IPC (`orchestrate:ready`).
 *
 * The caller should await this and then wait an additional
 * AGENT_WARM_UP_MS before sending the first classification request
 * (the chat widget needs time after DOM-ready to finish its own
 * internal initialisation).
 *
 * @returns {Promise<BrowserWindow>}
 */
async function createOrchestrateWindow() {
  if (orchestrateWindow && !orchestrateWindow.isDestroyed()) {
    return orchestrateWindow;
  }

  orchestrateWindow = new BrowserWindow({
    width:  800,
    height: 600,
    show:   false,          // never shown to the user
    skipTaskbar: true,      // no taskbar entry on Windows
    webPreferences: {
      contextIsolation:  false,  // needed so executeJavaScript can reach window.*
      nodeIntegration:   false,
      webSecurity:       false,  // allow external scripts (wxo CDN)
      // Allow the embed page to call ipcRenderer for the ready signal
      preload: path.join(__dirname, 'orchestratePreload.js'),
    },
  });

  // Load the local embed page
  orchestrateWindow.loadFile(
    path.join(__dirname, '../../src/orchestrate/index.html')
  );

  // Keep the window alive if the renderer process crashes — just reload
  orchestrateWindow.webContents.on('render-process-gone', (_event, details) => {
    console.error('[orchestrate] renderer gone:', details.reason, '— reloading');
    orchestrateWindow?.reload();
  });

  // Prevent the user from accidentally opening DevTools on this window
  orchestrateWindow.webContents.on('devtools-opened', () => {
    if (process.env.NODE_ENV !== 'development') {
      orchestrateWindow?.webContents.closeDevTools();
    }
  });

  // Clean up reference on close (should not happen during normal operation)
  orchestrateWindow.on('closed', () => {
    console.warn('[orchestrate] hidden window was closed');
    orchestrateWindow = null;
  });

  // In development expose devtools so you can inspect the embed
  if (process.env.NODE_ENV === 'development' && process.env.ORCHESTRATE_DEVTOOLS === 'true') {
    orchestrateWindow.webContents.openDevTools({ mode: 'detach' });
  }

  console.log('[orchestrate] hidden window created, waiting for page ready…');
  return orchestrateWindow;
}

/**
 * Resolve the ready promise — called by the IPC handler in index.ts
 * when the embed page fires `orchestrate:ready`.
 */
function signalReady() {
  readyResolve?.();
}

/**
 * Returns the hidden BrowserWindow instance.
 * Returns null if createOrchestrateWindow() has not been called yet.
 * @returns {BrowserWindow | null}
 */
function getOrchestrateWindow() {
  if (!orchestrateWindow || orchestrateWindow.isDestroyed()) return null;
  return orchestrateWindow;
}

/**
 * Promise that resolves when the embed page has called `orchestrate:ready`.
 * @returns {Promise<void>}
 */
function waitForReady() {
  return readyPromise;
}

/**
 * Gracefully destroy the hidden window on app quit.
 */
function destroyOrchestrateWindow() {
  if (orchestrateWindow && !orchestrateWindow.isDestroyed()) {
    orchestrateWindow.destroy();
    orchestrateWindow = null;
  }
}

module.exports = {
  createOrchestrateWindow,
  getOrchestrateWindow,
  waitForReady,
  signalReady,
  destroyOrchestrateWindow,
};
