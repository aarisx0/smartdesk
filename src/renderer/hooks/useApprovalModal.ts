import { useState, useCallback, useMemo } from 'react';
import type { PendingFile } from './useDashboard';

// ─── types ────────────────────────────────────────────────────────────────────

export type ApprovalPhase = 'idle' | 'approving' | 'complete';

export type FileProgress =
  | { status: 'waiting' }
  | { status: 'moving';  progress: number }   // 0–100
  | { status: 'done' }
  | { status: 'error';   message: string };

export interface CompletionSummary {
  filesOrganized: number;
  foldersCreated: number;
  storageSavedBytes: number;
  errors: number;
}

interface SessionStatsSnapshot {
  files_processed: number;
  folders_created: number;
  storage_saved_bytes: number;
}

// ─── hook ─────────────────────────────────────────────────────────────────────

export function useApprovalModal(files: PendingFile[], onDone: () => void) {
  // ── selection ────────────────────────────────────────────────────────────────
  const [selected,  setSelected]  = useState<Set<string>>(() => new Set(files.map((f) => f.id)));
  const [showLowOnly, setShowLowOnly] = useState(false);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  // ── approval state ───────────────────────────────────────────────────────────
  const [phase,    setPhase]    = useState<ApprovalPhase>('idle');
  const [progress, setProgress] = useState<Map<string, FileProgress>>(new Map());
  const [summary,  setSummary]  = useState<CompletionSummary | null>(null);

  // ── derived ──────────────────────────────────────────────────────────────────

  const filteredFiles = useMemo(() => {
    if (!showLowOnly) return files;
    return files.filter((f) => {
      const pct = f.confidence_score !== null
        ? (f.confidence_score <= 1 ? f.confidence_score * 100 : f.confidence_score)
        : 100;
      return pct < 50;
    });
  }, [files, showLowOnly]);

  const selectedFilesData = useMemo(
    () => files.filter((f) => selected.has(f.id)),
    [files, selected]
  );

  const totalStorageBytes = useMemo(
    () => selectedFilesData.reduce((acc, f) => acc + (f.size_bytes ?? 0), 0),
    [selectedFilesData]
  );

  const isAllSelected = filteredFiles.length > 0 && filteredFiles.every((f) => selected.has(f.id));

  // ── selection actions ─────────────────────────────────────────────────────────

  const toggleFile = useCallback((id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }, []);

  const toggleAll = useCallback(() => {
    if (isAllSelected) {
      setSelected((prev) => {
        const next = new Set(prev);
        filteredFiles.forEach((f) => next.delete(f.id));
        return next;
      });
    } else {
      setSelected((prev) => {
        const next = new Set(prev);
        filteredFiles.forEach((f) => next.add(f.id));
        return next;
      });
    }
  }, [isAllSelected, filteredFiles]);

  const toggleExpand = useCallback((id: string) => {
    setExpandedId((prev) => (prev === id ? null : id));
  }, []);

  // ── approval engine ───────────────────────────────────────────────────────────

  /**
   * Approve a batch of file IDs.
   * Drives per-file animated progress bars then transitions to the completion screen.
   */
  const runApproval = useCallback(async (ids: string[]) => {
    if (ids.length === 0) return;
    setPhase('approving');

    const beforeStats = await fetchSessionStats();

    // Initialise all as waiting
    const initMap = new Map<string, FileProgress>(ids.map((id) => [id, { status: 'waiting' }]));
    setProgress(initMap);

    let filesOrganized  = 0;
    let storageSaved = 0;
    let errors          = 0;

    for (const id of ids) {
      const file = files.find((f) => f.id === id);
      if (!file) continue;

      // Mark this row as processing while the real API call runs.
      setProgress((prev) => new Map(prev).set(id, { status: 'moving', progress: 10 }));

      // ── Call the REST approve endpoint ──────────────────────────────────────
      try {
        const res = await fetch('http://localhost:3001/api/moves/approve', {
          method:  'POST',
          headers: { 'Content-Type': 'application/json' },
          body:    JSON.stringify({ fileId: id, approved: true }),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        filesOrganized++;
        storageSaved += Number(file.size_bytes ?? 0);
        setProgress((prev) => new Map(prev).set(id, { status: 'moving', progress: 100 }));
        setProgress((prev) => new Map(prev).set(id, { status: 'done' }));
      } catch (err) {
        errors++;
        const msg = err instanceof Error ? err.message : 'Unknown error';
        setProgress((prev) => new Map(prev).set(id, { status: 'error', message: msg }));
      }

      await sleep(60);
    }

    const afterStats = await fetchSessionStats();
    const filesProcessedDelta = Math.max(0, afterStats.files_processed - beforeStats.files_processed);
    const foldersCreatedDelta = Math.max(0, afterStats.folders_created - beforeStats.folders_created);
    const storageDelta = Math.max(0, afterStats.storage_saved_bytes - beforeStats.storage_saved_bytes);

    setSummary({
      filesOrganized: filesProcessedDelta || filesOrganized,
      foldersCreated: foldersCreatedDelta,
      storageSavedBytes: storageDelta || storageSaved,
      errors,
    });
    // Short pause before flipping to completion screen
    await sleep(400);
    setPhase('complete');
  }, [files]);

  const approveSelected = useCallback(() => runApproval([...selected]), [runApproval, selected]);
  const approveAll      = useCallback(() => runApproval(files.map((f) => f.id)), [runApproval, files]);

  const reset = useCallback(() => {
    setPhase('idle');
    setProgress(new Map());
    setSummary(null);
    onDone();
  }, [onDone]);

  return {
    // state
    filteredFiles, selectedFilesData, selected, totalStorageBytes,
    showLowOnly, setShowLowOnly,
    expandedId, isAllSelected,
    phase, progress, summary,
    // actions
    toggleFile, toggleAll, toggleExpand,
    approveSelected, approveAll, reset,
  };
}

// ─── helpers ──────────────────────────────────────────────────────────────────

function sleep(ms: number) {
  return new Promise<void>((r) => setTimeout(r, ms));
}

async function fetchSessionStats(): Promise<SessionStatsSnapshot> {
  try {
    const res = await fetch('http://localhost:3001/api/stats');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json() as Record<string, unknown>;
    return {
      files_processed: Number(data.files_processed ?? 0),
      folders_created: Number(data.folders_created ?? 0),
      storage_saved_bytes: Number(data.storage_saved_bytes ?? 0),
    };
  } catch {
    return {
      files_processed: 0,
      folders_created: 0,
      storage_saved_bytes: 0,
    };
  }
}
