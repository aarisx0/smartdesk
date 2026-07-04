import { ipcMain } from 'electron';
import axios from 'axios';

const BACKEND_URL = process.env.BACKEND_URL || 'http://localhost:3001';

/**
 * Registers IPC handlers that proxy requests to the Express backend.
 * The renderer calls ipcRenderer.invoke('api:*') instead of fetch()
 * so it never needs to know the backend port.
 */
export function registerIpcHandlers(): void {
  // Classify a file via watsonx
  ipcMain.handle('api:classifyFile', async (_event, payload: { filePath: string }) => {
    const { data } = await axios.post(`${BACKEND_URL}/api/classify`, payload);
    return data;
  });

  // Approve / reject a suggested move
  ipcMain.handle('api:approveMove', async (_event, payload: { fileId: string; approved: boolean }) => {
    const { data } = await axios.post(`${BACKEND_URL}/api/moves/approve`, payload);
    return data;
  });

  // Fetch recent activity log
  ipcMain.handle('api:getActivity', async () => {
    const { data } = await axios.get(`${BACKEND_URL}/api/activity`);
    return data;
  });

  // Fetch stats
  ipcMain.handle('api:getStats', async () => {
    const { data } = await axios.get(`${BACKEND_URL}/api/stats`);
    return data;
  });

  // List watched folders
  ipcMain.handle('api:getWatchedFolders', async () => {
    const { data } = await axios.get(`${BACKEND_URL}/api/folders`);
    return data;
  });

  // Add / remove watched folder
  ipcMain.handle('api:updateFolders', async (_event, payload: { folders: string[] }) => {
    const { data } = await axios.post(`${BACKEND_URL}/api/folders`, payload);
    return data;
  });

  // Chat: scan a folder and return pending file count (used by Chat command mode)
  ipcMain.handle('chat:scanFolder', async (_event, folderHint: string) => {
    const { data } = await axios.get(`${BACKEND_URL}/api/activity`, {
      params: { status: 'pending', limit: 50 },
    });
    return { folder: folderHint, files: data ?? [], count: (data ?? []).length };
  });

  // Natural-language file search — calls the full search pipeline
  ipcMain.handle('api:search', async (_event, query: string) => {
    const { data } = await axios.get(`${BACKEND_URL}/api/search`, {
      params: { q: query },
    });
    return data; // { results, meta }
  });

  // ── Chat with wxo Orchestrate agent ─────────────────────────────────────
  // The renderer sends a free-form message; Electron main forwards it to the
  // hidden orchestrate BrowserWindow and polls for the reply.
  // This is the ONLY correct path — the backend (nodemon) is a separate process
  // and cannot share the BrowserWindow reference.
  ipcMain.handle('agent:chat', async (_event, message: string) => {
    const watsonxBridge = require('../backend/watsonx');
    try {
      const reply = await watsonxBridge.chatWithAgent(message);
      return { reply };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return { error: msg };
    }
  });
}
