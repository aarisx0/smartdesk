// Global type augmentation for the contextBridge API
// exposed via src/main/preload.ts

export interface WatcherEvent {
  type: 'add' | 'change' | 'unlink' | 'addDir' | 'unlinkDir';
  path: string;
  timestamp: string;
  size?: number;
  ext?: string;
}

export interface FileDetectedPayload {
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
  duplicateOf:     string | null;  // path of existing copy if duplicate
}

interface ElectronAPI {
  window: {
    minimize(): void;
    maximize(): void;
    close(): void;
  };
  openFolder(): Promise<string[] | null>;
  openPath(filePath: string): Promise<string>;
  trashItem(filePath: string): Promise<void>;
  store: {
    get(key: string): Promise<unknown>;
    set(key: string, value: unknown): Promise<void>;
    delete(key: string): Promise<void>;
  };
  watcher: {
    getFolders(): Promise<string[]>;
    setFolders(folders: string[]): Promise<{ ok: boolean; folders: string[] }>;
  };
  onWatcherEvent(callback: (event: WatcherEvent) => void): () => void;
  onFileDetected(callback: (payload: FileDetectedPayload) => void): () => void;
  onFileClassified(callback: (payload: FileDetectedPayload & { suggested_folder: string; confidence_score: number; ai_reasoning: string }) => void): () => void;
  invoke(channel: string, ...args: unknown[]): Promise<unknown>;
  chatWithAgent(message: string): Promise<{ reply?: string; error?: string }>;
  getDeviceId(): Promise<string>;
  getDeviceLabel(): Promise<string>;
  onDbMigrated(callback: (payload: { rowsMigrated: number }) => void): () => void;
}

declare global {
  interface Window {
    electronAPI: ElectronAPI;
  }
}

export {};
