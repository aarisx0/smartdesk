import { useState, useEffect, useCallback } from 'react';
import { apiFetch } from '../lib/apiFetch';

export interface ActivityEvent {
  id?: string;
  type: string;
  path: string;
  fileName: string;
  category?: string;
  size?: number;
  timestamp: string;
}

export function useActivity() {
  const [events,  setEvents]  = useState<ActivityEvent[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res  = await apiFetch('/api/activity?limit=100');
      const data = await res.json() as ActivityEvent[];
      setEvents(Array.isArray(data) ? data : []);
    } catch (err) {
      console.error('Failed to load activity', err);
      setEvents([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
    // Refresh every 30s
    const interval = setInterval(load, 30_000);
    return () => clearInterval(interval);
  }, [load]);

  // Refresh when main process finishes re-tagging old 'unknown' rows
  useEffect(() => {
    const unsub = window.electronAPI?.onDbMigrated?.(() => load());
    return () => unsub?.();
  }, [load]);

  return { events, loading };
}
