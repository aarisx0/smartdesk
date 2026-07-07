import { app, BrowserWindow, ipcMain, dialog, shell, nativeTheme, Notification } from 'electron';
import path from 'path';
import Store from 'electron-store';
import { setupWatcher, updateWatchedFolders, closeWatcher } from '../watcher/index';
import { registerIpcHandlers } from './ipcHandlers';
import {
  createOrchestrateWindow,
  getOrchestrateWindow,
  waitForReady,
  signalReady,
  destroyOrchestrateWindow,
} from './orchestrateWindow';

// ── Global EPIPE guard ─────────────────────────────────────────────────────────
// In the packaged Electron app stdout/stderr are closed — any console.log/error
// call throws EPIPE which crashes the main process with an uncaught exception.
// This swallows EPIPE silently everywhere in the process.
process.stdout?.on?.('error', (err: NodeJS.ErrnoException) => { if (err.code !== 'EPIPE') throw err; });
process.stderr?.on?.('error', (err: NodeJS.ErrnoException) => { if (err.code !== 'EPIPE') throw err; });
// Additionally suppress via uncaughtException as a last-resort catch
process.on('uncaughtException', (err: NodeJS.ErrnoException) => {
  if ((err as any).code === 'EPIPE') return; // swallow silently
  // Show the error to the user rather than silently freezing
  safeError('[main] uncaughtException:', err);
  // Don't re-throw — re-throwing from uncaughtException crashes the process
  // which hides the window without showing any error to the user.
});

// Require the watsonx bridge (CJS) and inject the window reference once ready
// eslint-disable-next-line @typescript-eslint/no-require-imports
const watsonxBridge = require('../backend/watsonx');

// ── Safe logging helpers (swallow EPIPE — stdout is closed in packaged app) ──
function safeLog(...args: unknown[])   { try { console.log(...args);   } catch (_) {} }
function safeError(...args: unknown[]) { try { console.error(...args); } catch (_) {} }

// ── Backend server (Express + Socket.IO) ─────────────────────────────────────
// Start the Express server IN-PROCESS (not forked). Running inside the Electron
// main process means Node can load all modules directly from the asar — no
// cross-boundary require issues, no missing transitive dependencies.
let _backendModule: { closeServer?: () => Promise<void> } | null = null;

function startBackendServer(): void {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    _backendModule = require('../backend/server');
    safeLog('[backend] server started in-process');
  } catch (err: unknown) {
    safeError('[backend] failed to start:', err instanceof Error ? err.message : err);
  }
}

async function stopBackendServer(): Promise<void> {
  try {
    if (_backendModule?.closeServer) {
      await _backendModule.closeServer();
      safeLog('[backend] server closed');
    }
  } catch (err: unknown) {
    safeError('[backend] close error:', err instanceof Error ? err.message : err);
  }
}

// ── file:detected payload forwarded from watcher → renderer ──────────────────
interface FileMetadata {
  id:              string | null;
  filename:        string;
  extension:       string;
  filepath:        string;
  size_bytes:      number;
  mime_type:       string | null;
  content_preview: string | null;
  created_at:      string;
  modified_at:     string;
  timestamp:       string;
}

const store  = new Store();
const isDev  = process.env.NODE_ENV === 'development';

// ── Device identity ───────────────────────────────────────────────────────────
import { getDeviceId, getDeviceLabel } from './deviceId';
const DEVICE_ID    = getDeviceId();
const DEVICE_LABEL = getDeviceLabel();

/**
 * How long (ms) to wait after the orchestrate window fires 'ready'
 * before accepting classification requests.  The chat widget needs
 * a short internal initialisation after its DOM-ready event.
 */
const AGENT_WARM_UP_MS = 1_500;

let mainWindow:   BrowserWindow | null = null;
let splashWindow: BrowserWindow | null = null;

// ─────────────────────────────────────────────────────────────────────────────
//  Splash window
// ─────────────────────────────────────────────────────────────────────────────

function createSplashWindow(): BrowserWindow {
  splashWindow = new BrowserWindow({
    width:           480,
    height:          360,
    frame:           false,
    transparent:     false,
    backgroundColor: '#0D0D1A',
    resizable:       false,
    center:          true,
    skipTaskbar:     false,
    alwaysOnTop:     true,
    show:            false,
    webPreferences: {
      contextIsolation: false,   // no preload — isolation not needed
      nodeIntegration:  false,
      sandbox:          false,   // must be false so file:// can load external .js
      webSecurity:      false,   // allow loading local splash.js via file://
    },
  });

  const fsp = require('fs');
  const distSplash = path.join(__dirname, 'splash.html');
  const srcSplash  = path.join(__dirname, '../../src/main/splash.html');
  const splashPath = fsp.existsSync(distSplash) ? distSplash : srcSplash;
  safeLog('[splash] loading from:', splashPath, '| exists:', fsp.existsSync(splashPath));

  splashWindow.loadFile(splashPath);

  // Show as soon as content is painted — prevents blank flash.
  // Fallback: show after 400 ms regardless so users aren't stuck on nothing.
  let shown = false;
  const showSplash = () => {
    if (shown) return;
    shown = true;
    if (splashWindow && !splashWindow.isDestroyed()) splashWindow.show();
  };

  splashWindow.once('ready-to-show', showSplash);
  setTimeout(showSplash, 400);   // guaranteed fallback

  return splashWindow;
}

function closeSplash(): void {
  if (splashWindow && !splashWindow.isDestroyed()) {
    splashWindow.close();
    splashWindow = null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
//  Main window
// ─────────────────────────────────────────────────────────────────────────────

function createMainWindow(): BrowserWindow {
  nativeTheme.themeSource = 'dark';

  mainWindow = new BrowserWindow({
    width:       1280,
    height:      820,
    minWidth:    960,
    minHeight:   600,
    frame:       false,
    transparent: true,
    backgroundColor: '#00000000',
    titleBarStyle:   'hidden',
    vibrancy:        'under-window',
    visualEffectState: 'active',
    show: false,   // shown after splash closes
    webPreferences: {
      preload:          path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration:  false,
      sandbox:          false,
      // webSecurity must be OFF in production: the renderer is a file:// page
      // and needs to fetch http://localhost:3001 (the Express backend).
      // In dev it's also off (Vite handles CORS itself).
      webSecurity:      false,
    },
    icon: path.join(__dirname, '../../assets/icon.png'),
  });

  if (isDev) {
    mainWindow.loadURL('http://localhost:5173');
    if (process.env.OPEN_DEVTOOLS === 'true') {
      mainWindow.webContents.openDevTools({ mode: 'detach' });
    }
  } else {
    // In the packaged app __dirname = app.asar/dist/main/
    // renderer is at              app.asar/dist/renderer/index.html
    // so we go one level up:      ../renderer/index.html
    const rendererPath = path.join(__dirname, '../renderer/index.html');
    mainWindow.loadFile(rendererPath);

    // If the renderer fails to load, show the window anyway so the user
    // sees an error rather than a frozen splash
    mainWindow.webContents.on('did-fail-load', (_e, code, desc) => {
      safeError('[main] renderer failed to load:', code, desc, rendererPath);
      mainWindow?.show();
    });
  }

  mainWindow.on('closed', () => { mainWindow = null; });

  return mainWindow;
}

// ─────────────────────────────────────────────────────────────────────────────
//  App bootstrap
// ─────────────────────────────────────────────────────────────────────────────

async function bootstrap(): Promise<void> {
  // 0. Start the Express backend (no-op in dev since nodemon handles it)
  if (!isDev) startBackendServer();

  // 1. Show splash immediately
  createSplashWindow();

  // 2. Create the main window right away (hidden until splash closes)
  const _mainWin = createMainWindow();

  // 3. Show the main window — always fires, regardless of what else happens
  const showMainWindow = () => {
    try { closeSplash(); } catch (_) {}
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.show();
      mainWindow.focus();
    }
  };

  // Also show on ready-to-show so we don't need to wait for the full 3.5s
  // if the renderer loads quickly
  _mainWin.once('ready-to-show', () => {
    // Only show early if splash has been visible for at least 2s
    setTimeout(showMainWindow, 2_000);
  });

  // 4. Start agent init in the background (non-blocking)
  createOrchestrateWindow().then(async (orchWin) => {
    // Wait for the embed page to fire orchestrate:ready (max 20s)
    await Promise.race([
      waitForReady(),
      new Promise<void>((resolve) => setTimeout(resolve, 20_000)),
    ]);

    safeLog('[main] orchestrate window ready — warming up for', AGENT_WARM_UP_MS, 'ms');
    await new Promise<void>((resolve) => setTimeout(resolve, AGENT_WARM_UP_MS));

    // Wire the watsonx bridge
    watsonxBridge.setOrchestrateWindow(orchWin);
    safeLog('[main] watsonx bridge wired');
  }).catch((err) => {
    safeError('[main] orchestrate window failed:', err);
  });

  // 5. Register this device in DB + start the file watcher
  const savedFolders = (store.get('watchedFolders') as string[] | undefined) ?? [];

  // Upsert device record (non-blocking — failure should not crash the app)
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { upsertDevice } = require('../db/queries');
  upsertDevice(DEVICE_ID, DEVICE_LABEL).catch((e: Error) => safeError('[main] upsertDevice failed:', e.message));

  setupWatcher(
    async (payload: FileMetadata) => {
      const isDuplicate = !!(payload as any).duplicateOf;

      // Forward raw detection to renderer immediately
      mainWindow?.webContents.send('file:detected', payload);
      mainWindow?.webContents.send('watcher:event', {
        type:      'add',
        path:      payload.filepath,
        timestamp: payload.timestamp,
        size:      payload.size_bytes,
        ext:       payload.extension,
      });

      // Auto-classify via watsonx agent (async — don't block)
      if (payload.id) {
        watsonxBridge.classifyFile(payload)
          .then((result: any) => {
            // Push updated classification to renderer
            mainWindow?.webContents.send('file:classified', {
              ...payload,
              suggested_folder: result.subfolder,
              confidence_score: result.confidence,
              ai_reasoning:     result.reasoning,
              status:           'classified',
            });

            // Desktop notification with AI suggestion
            if (Notification.isSupported()) {
              const notif = new Notification({
                title: isDuplicate ? '⚠ Duplicate File Detected' : `📁 ${payload.filename}`,
                body:  isDuplicate
                  ? `Duplicate of an existing file. Suggested: ${result.subfolder}`
                  : `AI suggests moving to: ${result.subfolder} (${Math.round(result.confidence * 100)}% confidence)`,
                silent: false,
              });
              notif.on('click', () => { mainWindow?.show(); mainWindow?.focus(); });
              notif.show();
            }
          })
          .catch((err: Error) => {
            safeError('[main] auto-classify error:', err.message);
          });
      } else {
        // No DB ID — just show basic notification
        if (Notification.isSupported()) {
          const notif = new Notification({
            title: '📁 New File Detected',
            body:  `"${payload.filename}" — click to review`,
            silent: true,
          });
          notif.on('click', () => { mainWindow?.show(); mainWindow?.focus(); });
          notif.show();
        }
      }
    },
    savedFolders,
    DEVICE_ID,
  );

  // 6. Show main window after a comfortable splash (3.5s — long enough to read and animate)
  setTimeout(showMainWindow, 3_500);
}

// ─────────────────────────────────────────────────────────────────────────────
//  IPC handlers
// ─────────────────────────────────────────────────────────────────────────────

// Window controls
ipcMain.on('window:minimize', () => mainWindow?.minimize());
ipcMain.on('window:maximize', () => {
  if (mainWindow?.isMaximized()) mainWindow.unmaximize();
  else mainWindow?.maximize();
});
ipcMain.on('window:close', () => mainWindow?.close());

// Folder picker
ipcMain.handle('dialog:openFolder', async () => {
  const result = await dialog.showOpenDialog(mainWindow!, {
    properties: ['openDirectory', 'multiSelections'],
  });
  return result.canceled ? null : result.filePaths;
});

// Open path in OS
ipcMain.handle('shell:openPath', async (_event, filePath: string) =>
  shell.openPath(filePath)
);

// Move file to Recycle Bin (safe — user can restore)
ipcMain.handle('shell:trashItem', async (_event, filePath: string) =>
  shell.trashItem(filePath)
);

// Persistent store
ipcMain.handle('store:get',    (_event, key: string)                 => store.get(key));
ipcMain.handle('store:set',    (_event, key: string, value: unknown) => store.set(key, value));
ipcMain.handle('store:delete', (_event, key: string)                 => store.delete(key));

// Watched folders
ipcMain.handle('watcher:setFolders', (_event, folders: string[]) => {
  store.set('watchedFolders', folders);
  updateWatchedFolders(folders);
  return { ok: true, folders };
});
ipcMain.handle('watcher:getFolders', () =>
  (store.get('watchedFolders') as string[] | undefined) ?? []
);

// Orchestrate ready signal (fired from orchestratePreload.js)
ipcMain.on('orchestrate:ready', () => {
  safeLog('[main] received orchestrate:ready signal');
  signalReady();
});

// Classify a file on demand from renderer (used by Approvals page, etc.)
ipcMain.handle('watsonx:classify', async (_event, metadata: FileMetadata) => {
  try {
    return await watsonxBridge.classifyFile(metadata);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    safeError('[main] watsonx:classify error:', msg);
    return { category: 'unknown', subfolder: 'Misc', confidence: 0, reasoning: msg };
  }
});

registerIpcHandlers();

// ─────────────────────────────────────────────────────────────────────────────
//  Single-instance lock
// ─────────────────────────────────────────────────────────────────────────────
const gotLock = app.requestSingleInstanceLock();

if (!gotLock) {
  // Another instance is already running — quit this one silently.
  app.quit();
} else {
  // ── Second-instance: user double-clicked while app is already running ──
  app.on('second-instance', () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    } else {
      // Window was closed but process is still alive — re-create it.
      bootstrap();
    }
  });

  // ─────────────────────────────────────────────────────────────────────────
  //  Lifecycle
  // ─────────────────────────────────────────────────────────────────────────

  app.whenReady().then(bootstrap);

  // before-quit: Electron does NOT await async handlers.
  // We prevent the default quit, do our async cleanup, then force-exit.
  let _isQuitting = false;
  app.on('before-quit', (e) => {
    if (_isQuitting) return; // already cleaning up — let it through
    e.preventDefault();
    _isQuitting = true;

    // Run async cleanup then forcibly exit so nothing keeps the event loop alive.
    Promise.allSettled([
      stopBackendServer(),
      closeWatcher(),
    ]).finally(() => {
      destroyOrchestrateWindow();
      // Force-exit so Postgres pool, Socket.IO, and other long-lived handles
      // don't prevent the process from actually terminating.
      process.exit(0);
    });
  });

  app.on('window-all-closed', () => {
    // On Windows/Linux, closing all windows quits the app.
    if (process.platform !== 'darwin') app.quit();
  });

  app.on('activate', () => {
    // macOS: re-create window when clicking dock icon with no windows open.
    if (BrowserWindow.getAllWindows().length === 0) bootstrap();
  });
}
