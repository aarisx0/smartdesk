import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('electronAPI', {
  // Window controls
  window: {
    minimize: () => ipcRenderer.send('window:minimize'),
    maximize: () => ipcRenderer.send('window:maximize'),
    close: () => ipcRenderer.send('window:close'),
  },

  // Dialog
  openFolder: (): Promise<string[] | null> =>
    ipcRenderer.invoke('dialog:openFolder'),

  // Shell
  openPath: (filePath: string): Promise<string> =>
    ipcRenderer.invoke('shell:openPath', filePath),

  trashItem: (filePath: string): Promise<void> =>
    ipcRenderer.invoke('shell:trashItem', filePath),

  // Persistent store
  store: {
    get: (key: string): Promise<unknown> => ipcRenderer.invoke('store:get', key),
    set: (key: string, value: unknown): Promise<void> =>
      ipcRenderer.invoke('store:set', key, value),
    delete: (key: string): Promise<void> => ipcRenderer.invoke('store:delete', key),
  },

  // File watcher — raw chokidar events (live feed)
  onWatcherEvent: (
    callback: (event: WatcherEvent) => void
  ): (() => void) => {
    const listener = (_: Electron.IpcRendererEvent, event: WatcherEvent) =>
      callback(event);
    ipcRenderer.on('watcher:event', listener);
    return () => ipcRenderer.removeListener('watcher:event', listener);
  },

  // File watcher — fully classified metadata events (approval / activity UI)
  onFileDetected: (
    callback: (payload: FileDetectedPayload) => void
  ): (() => void) => {
    const listener = (_: Electron.IpcRendererEvent, payload: FileDetectedPayload) =>
      callback(payload);
    ipcRenderer.on('file:detected', listener);
    return () => ipcRenderer.removeListener('file:detected', listener);
  },

  // File classified by AI — updated with suggestion
  onFileClassified: (
    callback: (payload: FileDetectedPayload & { suggested_folder: string; confidence_score: number; ai_reasoning: string }) => void
  ): (() => void) => {
    const listener = (_: Electron.IpcRendererEvent, payload: any) => callback(payload);
    ipcRenderer.on('file:classified', listener);
    return () => ipcRenderer.removeListener('file:classified', listener);
  },

  // Watched folder management
  watcher: {
    getFolders: (): Promise<string[]> =>
      ipcRenderer.invoke('watcher:getFolders'),
    setFolders: (folders: string[]): Promise<{ ok: boolean; folders: string[] }> =>
      ipcRenderer.invoke('watcher:setFolders', folders),
  },

  // Backend API passthrough (optional convenience)
  invoke: (channel: string, ...args: unknown[]): Promise<unknown> =>
    ipcRenderer.invoke(channel, ...args),

  // Chat with wxo Orchestrate agent — free-form conversation
  chatWithAgent: (message: string): Promise<{ reply?: string; error?: string }> =>
    ipcRenderer.invoke('agent:chat', message),

  // Device identity — stable UUID for this installation (used to scope DB queries)
  getDeviceId: (): Promise<string> => ipcRenderer.invoke('device:getId'),
  getDeviceLabel: (): Promise<string> => ipcRenderer.invoke('device:getLabel'),

  // Fired once after launch when old 'unknown' rows are re-tagged to this device.
  // Renderer should refresh all data when this fires.
  onDbMigrated: (callback: (payload: { rowsMigrated: number }) => void): (() => void) => {
    const listener = (_: Electron.IpcRendererEvent, payload: { rowsMigrated: number }) => callback(payload);
    ipcRenderer.on('db:migrated', listener);
    return () => ipcRenderer.removeListener('db:migrated', listener);
  },
});

// Types available in renderer window
interface WatcherEvent {
  type: 'add' | 'change' | 'unlink' | 'addDir' | 'unlinkDir';
  path: string;
  timestamp: string;
  size?: number;
  ext?: string;
}

interface FileDetectedPayload {
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

declare global {
  interface Window {
    electronAPI: ReturnType<typeof import('electron')['contextBridge']['exposeInMainWorld']>;
  }
}
