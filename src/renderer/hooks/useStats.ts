import { useState, useEffect } from 'react';

interface Stats {
  filesOrganized: number;
  classified: number;
  approvals: number;
  accuracy: number;
}

export function useStats() {
  const [stats, setStats] = useState<Stats | null>(null);

  useEffect(() => {
    const load = async () => {
      try {
        const res  = await fetch('http://localhost:3001/api/stats');
        const data = await res.json() as Stats;
        setStats(data);
      } catch (err) {
        console.error('Failed to load stats', err);
      }
    };

    load();
    const interval = setInterval(load, 30_000);
    return () => clearInterval(interval);
  }, []);

  return { stats };
}
