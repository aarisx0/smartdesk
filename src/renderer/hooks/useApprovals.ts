import { useState, useEffect, useCallback } from 'react';

export interface PendingApproval {
  id: string;
  fileName: string;
  sourcePath: string;
  targetPath: string;
  category: string;
  confidence: number;
  createdAt: string;
}

export function useApprovals() {
  const [pending,  setPending]  = useState<PendingApproval[]>([]);
  const [loading,  setLoading]  = useState(true);

  const fetchApprovals = useCallback(async () => {
    setLoading(true);
    try {
      const res  = await fetch('http://localhost:3001/api/activity?status=pending&limit=50');
      const data = await res.json() as any[];

      // Map the `files` table pending rows → PendingApproval shape
      const mapped: PendingApproval[] = (Array.isArray(data) ? data : []).map((row) => ({
        id:         row.id,
        fileName:   row.filename,
        sourcePath: row.filepath,
        targetPath: row.suggested_folder ?? '',
        category:   row.extension ?? 'File',
        confidence: row.confidence_score != null
          ? (row.confidence_score <= 1 ? Math.round(row.confidence_score * 100) : row.confidence_score)
          : 0,
        createdAt:  row.created_at,
      }));

      setPending(mapped);
    } catch (err) {
      console.error('Failed to load approvals', err);
      setPending([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchApprovals(); }, [fetchApprovals]);

  const approve = useCallback(async (id: string) => {
    try {
      await fetch('http://localhost:3001/api/moves/approve', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ fileId: id, approved: true }),
      });
      setPending((prev) => prev.filter((p) => p.id !== id));
    } catch (err) {
      console.error('Failed to approve', err);
    }
  }, []);

  const reject = useCallback(async (id: string) => {
    try {
      await fetch('http://localhost:3001/api/moves/approve', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ fileId: id, approved: false }),
      });
      setPending((prev) => prev.filter((p) => p.id !== id));
    } catch (err) {
      console.error('Failed to reject', err);
    }
  }, []);

  return { pending, approve, reject, loading, refresh: fetchApprovals };
}
