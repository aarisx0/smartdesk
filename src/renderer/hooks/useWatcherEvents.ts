import { useState, useEffect, useCallback } from 'react';

export interface WatcherEvent {
  type: 'add' | 'change' | 'unlink' | 'addDir' | 'unlinkDir';
  path: string;
  timestamp: string;
  size?: number;
  ext?: string;
}

export function useWatcherEvents() {
  const [events, setEvents] = useState<WatcherEvent[]>([]);

  useEffect(() => {
    const unsubscribe = window.electronAPI?.onWatcherEvent((event: WatcherEvent) => {
      setEvents((prev) => [event, ...prev].slice(0, 200));
    });
    return () => unsubscribe?.();
  }, []);

  const clearEvents = useCallback(() => setEvents([]), []);

  return { events, clearEvents };
}
