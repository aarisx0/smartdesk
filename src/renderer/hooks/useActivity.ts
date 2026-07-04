import { useState, useEffect } from 'react';

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

  useEffect(() => {
    const load = async () => {
      setLoading(true);
      try {
        const res  = await fetch('http://localhost:3001/api/activity?limit=100');
        const data = await res.json() as ActivityEvent[];
        setEvents(Array.isArray(data) ? data : []);
      } catch (err) {
        console.error('Failed to load activity', err);
        setEvents([]);
      } finally {
        setLoading(false);
      }
    };
    load();

    // Refresh every 30s
    const interval = setInterval(load, 30_000);
    return () => clearInterval(interval);
  }, []);

  return { events, loading };
}
