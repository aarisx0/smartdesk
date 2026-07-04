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

// Require the watsonx bridge (CJS) and inject the window reference once ready
// eslint-disable-next-line @typescript-eslint/no-require-imports
const watsonxBridge = require('../backend/watsonx');

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
    width:           440,
    height:          300,
    frame:           false,
    transparent:     true,
    resizable:       false,
    center:          true,
    skipTaskbar:     true,
    alwaysOnTop:     true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration:  false,
    },
  });

  splashWindow.loadFile(path.join(__dirname, 'splash.html'));
  splashWindow.once('ready-to-show', () => splashWindow?.show());
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
      webSecurity:      !isDev,   // allow localhost in dev
    },
    icon: path.join(__dirname, '../../assets/icon.png'),
  });

  if (isDev) {
    mainWindow.loadURL('http://localhost:5173');
    // Only open DevTools if explicitly requested via env var
    if (process.env.OPEN_DEVTOOLS === 'true') {
      mainWindow.webContents.openDevTools({ mode: 'detach' });
    }
  } else {
    mainWindow.loadFile(path.join(__dirname, '../../dist/renderer/index.html'));
  }

  mainWindow.on('closed', () => { mainWindow = null; });

  return mainWindow;
}

// ─────────────────────────────────────────────────────────────────────────────
//  App bootstrap
// ─────────────────────────────────────────────────────────────────────────────

async function bootstrap(): Promise<void> {
  // 1. Show splash immediately
  createSplashWindow();

  // 2. Create the main window right away (hidden until splash closes)
  const _mainWin = createMainWindow();

  // 3. Show the main window after a short delay — don't block on agent init
  const showMainWindow = () => {
    closeSplash();
    mainWindow?.show();
    mainWindow?.focus();
  };

  // 4. Start agent init in the background (non-blocking)
  createOrchestrateWindow().then(async (orchWin) => {
    // Wait for the embed page to fire orchestrate:ready (max 20s)
    await Promise.race([
      waitForReady(),
      new Promise<void>((resolve) => setTimeout(resolve, 20_000)),
    ]);

    console.log('[main] orchestrate window ready — warming up for', AGENT_WARM_UP_MS, 'ms');
    await new Promise<void>((resolve) => setTimeout(resolve, AGENT_WARM_UP_MS));

    // Wire the watsonx bridge
    watsonxBridge.setOrchestrateWindow(orchWin);
    console.log('[main] watsonx bridge wired');
  }).catch((err) => {
    console.error('[main] orchestrate window failed:', err);
  });

  // 5. Start the file watcher
  const savedFolders = (store.get('watchedFolders') as string[] | undefined) ?? [];
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
            console.error('[main] auto-classify error:', err.message);
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
  );

  // 6. Show main window after a short splash (1.5s feels natural)
  setTimeout(showMainWindow, 1_500);
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
  console.log('[main] received orchestrate:ready signal');
  signalReady();
});

// Classify a file on demand from renderer (used by Approvals page, etc.)
ipcMain.handle('watsonx:classify', async (_event, metadata: FileMetadata) => {
  try {
    return await watsonxBridge.classifyFile(metadata);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[main] watsonx:classify error:', msg);
    return { category: 'unknown', subfolder: 'Misc', confidence: 0, reasoning: msg };
  }
});

registerIpcHandlers();

// ─────────────────────────────────────────────────────────────────────────────
//  Lifecycle
// ─────────────────────────────────────────────────────────────────────────────

app.whenReady().then(bootstrap);

app.on('window-all-closed', async () => {
  await closeWatcher();
  destroyOrchestrateWindow();
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) bootstrap();
});
