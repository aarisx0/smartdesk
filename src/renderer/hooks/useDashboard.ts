import { useState, useEffect, useCallback, useRef } from 'react';
import { apiFetch } from '../lib/apiFetch';

// ─── types ────────────────────────────────────────────────────────────────────

export interface DashboardStats {
  filesOrganized:    number;
  foldersCreated:    number;
  duplicatesRemoved: number;
  storageSavedBytes: number;
}

export interface OrganizedFile {
  id:               string;
  filename:         string;
  extension:        string;
  filepath:         string;
  suggested_folder: string;
  confidence_score: number;
  updated_at:       string;
  status:           string;
}

export interface PendingFile {
  id:               string;
  filename:         string;
  extension:        string;
  filepath:         string;
  suggested_folder: string | null;
  confidence_score: number | null;
  ai_reasoning:     string | null;
  size_bytes:       number | null;
  created_at:       string;
}

export interface HealthData {
  score:     number; // 0–100
  total:     number;
  organized: number;
}

// ─── animated counter ─────────────────────────────────────────────────────────

export function useAnimatedCounter(target: number, durationMs = 1200): number {
  const [value, setValue] = useState(0);
  const rafRef = useRef<number>(0);

  useEffect(() => {
    if (target === 0) { setValue(0); return; }
    const start    = performance.now();
    const startVal = 0;

    const tick = (now: number) => {
      const elapsed  = now - start;
      const progress = Math.min(elapsed / durationMs, 1);
      const eased    = 1 - Math.pow(1 - progress, 3);
      setValue(Math.round(startVal + eased * (target - startVal)));
      if (progress < 1) rafRef.current = requestAnimationFrame(tick);
    };

    rafRef.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafRef.current);
  }, [target, durationMs]);

  return value;
}

// ─── main hook ────────────────────────────────────────────────────────────────

export function useDashboard() {
  const [stats,          setStats]          = useState<DashboardStats>({ filesOrganized: 0, foldersCreated: 0, duplicatesRemoved: 0, storageSavedBytes: 0 });
  const [organized,      setOrganized]      = useState<OrganizedFile[]>([]);
  const [pending,        setPending]        = useState<PendingFile[]>([]);
  const [health,         setHealth]         = useState<HealthData>({ score: 0, total: 0, organized: 0 });
  const [watchedFolders, setWatchedFolders] = useState<string[]>([]);
  const [loading,        setLoading]        = useState(true);
  const [error,          setError]          = useState<string | null>(null);

  // ── fetch helpers ─────────────────────────────────────────────────────────────

  const fetchStats = useCallback(async () => {
    try {
      const res  = await apiFetch('/api/stats');
      const data = await res.json();
      setStats({
        filesOrganized:    data.files_processed      ?? data.filesOrganized      ?? 0,
        foldersCreated:    data.folders_created      ?? data.foldersCreated      ?? 0,
        duplicatesRemoved: data.duplicates_removed   ?? data.duplicatesRemoved   ?? 0,
        storageSavedBytes: data.storage_saved_bytes  ?? data.storageSavedBytes   ?? 0,
      });
    } catch (e) { console.error('[dashboard] fetchStats', e); }
  }, []);

  const fetchOrganized = useCallback(async () => {
    try {
      // Reuse activity endpoint for moved/classified files
      const res  = await apiFetch('/api/activity?limit=20');
      const data = await res.json() as any[];
      if (!Array.isArray(data)) return;
      // Map activity_log rows to OrganizedFile shape
      setOrganized(data.slice(0, 20).map((row) => ({
        id:               row.id ?? '',
        filename:         row.fileName ?? row.filename ?? '',
        extension:        row.extension ?? '',
        filepath:         row.path ?? row.filepath ?? '',
        suggested_folder: row.to_path ?? '',
        confidence_score: row.confidence_score ?? 0,
        updated_at:       row.timestamp ?? row.updated_at ?? new Date().toISOString(),
        status:           row.type ?? row.action ?? 'moved',
      })));
    } catch (e) { console.error('[dashboard] fetchOrganized', e); }
  }, []);

  const fetchPending = useCallback(async () => {
    try {
      const res  = await apiFetch('/api/activity?status=pending&limit=15');
      const data = await res.json() as any[];
      if (!Array.isArray(data)) return;
      setPending(data.map((row) => ({
        id:               row.id,
        filename:         row.filename,
        extension:        row.extension ?? '',
        filepath:         row.filepath,
        suggested_folder: row.suggested_folder ?? null,
        confidence_score: row.confidence_score ?? null,
        ai_reasoning:     row.ai_reasoning     ?? null,
        size_bytes:       row.size_bytes        ?? null,
        created_at:       row.created_at,
      })));
    } catch (e) { console.error('[dashboard] fetchPending', e); }
  }, []);

  const fetchHealth = useCallback(async () => {
    try {
      const res  = await apiFetch('/api/stats');
      const data = await res.json();
      const total     = (data.classified ?? 0) + (data.approvals ?? 0);
      const organized = data.classified ?? 0;
      const score     = total > 0 ? Math.round((organized / total) * 100) : 0;
      setHealth({ score, total, organized });
    } catch (e) { console.error('[dashboard] fetchHealth', e); }
  }, []);

  const fetchWatchedFolders = useCallback(async () => {
    // Try IPC first (Electron), then backend
    try {
      const folders = await window.electronAPI?.watcher?.getFolders?.();
      if (folders && folders.length > 0) { setWatchedFolders(folders); return; }
    } catch { /* not in Electron */ }
    try {
      const res  = await apiFetch('/api/folders');
      const data = await res.json() as { path: string }[];
      if (Array.isArray(data)) setWatchedFolders(data.map((f) => f.path));
    } catch (e) { console.error('[dashboard] fetchWatchedFolders', e); }
  }, []);

  // ── approve / skip ─────────────────────────────────────────────────────────────

  const approveFile = useCallback(async (id: string) => {
    setPending((p) => p.filter((f) => f.id !== id));
    try {
      await apiFetch('/api/moves/approve', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ fileId: id, approved: true }),
      });
      await Promise.all([fetchStats(), fetchOrganized(), fetchHealth()]);
    } catch (e) {
      console.error('[dashboard] approveFile', e);
      fetchPending();
    }
  }, [fetchStats, fetchOrganized, fetchHealth, fetchPending]);

  const skipFile = useCallback(async (id: string) => {
    setPending((p) => p.filter((f) => f.id !== id));
    try {
      await apiFetch('/api/moves/approve', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ fileId: id, approved: false }),
      });
    } catch (e) {
      console.error('[dashboard] skipFile', e);
      fetchPending();
    }
  }, [fetchPending]);

  // ── initial load ───────────────────────────────────────────────────────────────

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      setLoading(true);
      setError(null);
      try {
        await Promise.all([
          fetchStats(), fetchOrganized(), fetchPending(),
          fetchHealth(), fetchWatchedFolders(),
        ]);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : 'Unknown error');
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    load();
    return () => { cancelled = true; };
  }, [fetchStats, fetchOrganized, fetchPending, fetchHealth, fetchWatchedFolders]);

  // ── watcher IPC events ─────────────────────────────────────────────────────────

  useEffect(() => {
    // Raw detection — add to pending immediately
    const unsubDetected = window.electronAPI?.onFileDetected?.((payload) => {
      setPending((prev) => {
        if (prev.some((f) => f.filepath === payload.filepath)) return prev;
        return [{
          id:               payload.id ?? crypto.randomUUID(),
          filename:         payload.filename,
          extension:        payload.extension,
          filepath:         payload.filepath,
          suggested_folder: null,
          confidence_score: null,
          ai_reasoning:     (payload as any).duplicateOf
            ? `⚠ Possible duplicate of: ${(payload as any).duplicateOf}`
            : null,
          size_bytes:       payload.size_bytes,
          created_at:       payload.timestamp,
        }, ...prev];
      });
    });

    // AI classified — update the pending entry with suggestion
    const unsubClassified = window.electronAPI?.onFileClassified?.((payload) => {
      setPending((prev) => prev.map((f) => {
        if (f.filepath !== payload.filepath) return f;
        return {
          ...f,
          id:               f.id ?? payload.id ?? crypto.randomUUID(),
          suggested_folder: payload.suggested_folder ?? f.suggested_folder,
          confidence_score: payload.confidence_score ?? f.confidence_score,
          ai_reasoning:     payload.ai_reasoning     ?? f.ai_reasoning,
        };
      }));
    });

    return () => {
      unsubDetected?.();
      unsubClassified?.();
    };
  }, []);

  // ── DB migration signal ────────────────────────────────────────────────────
  // When the main process re-tags old 'unknown' rows to this device_id on
  // first launch, it fires db:migrated. Refresh everything so the dashboard
  // immediately shows the recovered data.
  useEffect(() => {
    const unsub = window.electronAPI?.onDbMigrated?.((payload) => {
      console.log(`[dashboard] db:migrated — refreshing (${payload.rowsMigrated} rows recovered)`);
      Promise.all([fetchStats(), fetchOrganized(), fetchPending(), fetchHealth()]);
    });
    return () => unsub?.();
  }, [fetchStats, fetchOrganized, fetchPending, fetchHealth]);

  return {
    stats, organized, pending, health, watchedFolders,
    loading, error,
    approveFile, skipFile,
    refresh: () => Promise.all([fetchStats(), fetchOrganized(), fetchPending(), fetchHealth()]),
  };
}
