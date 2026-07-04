import { motion, AnimatePresence } from 'framer-motion';
import { FileText, FolderPlus, Edit, Trash2, Clock } from 'lucide-react';
import { useActivity } from '../hooks/useActivity';

const iconMap = {
  add: { icon: FileText, color: '#818CF8', bg: 'rgba(79,70,229,0.12)' },
  addDir: { icon: FolderPlus, color: '#34D399', bg: 'rgba(16,185,129,0.12)' },
  change: { icon: Edit, color: '#FCD34D', bg: 'rgba(245,158,11,0.12)' },
  unlink: { icon: Trash2, color: '#FCA5A5', bg: 'rgba(239,68,68,0.12)' },
  unlinkDir: { icon: Trash2, color: '#FCA5A5', bg: 'rgba(239,68,68,0.12)' },
} as const;

export default function Activity() {
  const { events, loading } = useActivity();

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-2xl font-bold text-white">Activity Log</h1>
        <p className="text-sm mt-0.5" style={{ color: '#8B8BAD' }}>
          Full history of file system events and AI classifications
        </p>
      </div>

      <div className="glass-card overflow-hidden">
        {/* Table header */}
        <div className="grid grid-cols-12 px-5 py-3 text-xs font-semibold uppercase tracking-wider border-b"
          style={{ color: '#555575', borderColor: 'rgba(255,255,255,0.05)' }}>
          <span className="col-span-1">Type</span>
          <span className="col-span-5">File Path</span>
          <span className="col-span-2">Category</span>
          <span className="col-span-2">Size</span>
          <span className="col-span-2 flex items-center gap-1">
            <Clock size={12} /> Time
          </span>
        </div>

        {loading && (
          <div className="py-16 text-center text-sm" style={{ color: '#555575' }}>
            Loading events…
          </div>
        )}

        <div className="divide-y divide-white/5">
          <AnimatePresence>
            {events.map((ev, i) => {
              const { icon: Icon, color, bg } =
                iconMap[ev.type as keyof typeof iconMap] ?? iconMap.add;
              return (
                <motion.div
                  key={ev.id ?? i}
                  initial={{ opacity: 0, x: -8 }}
                  animate={{ opacity: 1, x: 0 }}
                  transition={{ delay: i * 0.03 }}
                  className="grid grid-cols-12 px-5 py-3.5 items-center hover:bg-white/[0.02] transition-colors"
                >
                  <div className="col-span-1">
                    <div className="w-7 h-7 rounded-lg flex items-center justify-center"
                      style={{ background: bg }}>
                      <Icon size={13} style={{ color }} />
                    </div>
                  </div>
                  <div className="col-span-5 min-w-0 pr-4">
                    <p className="text-xs font-medium text-white truncate">{ev.fileName}</p>
                    <p className="text-xs truncate mt-0.5" style={{ color: '#555575' }}>{ev.path}</p>
                  </div>
                  <div className="col-span-2">
                    {ev.category ? (
                      <span className="badge badge-blue">{ev.category}</span>
                    ) : (
                      <span className="text-xs" style={{ color: '#555575' }}>—</span>
                    )}
                  </div>
                  <div className="col-span-2 text-xs" style={{ color: '#8B8BAD' }}>
                    {ev.size ? formatBytes(ev.size) : '—'}
                  </div>
                  <div className="col-span-2 text-xs" style={{ color: '#555575' }}>
                    {new Date(ev.timestamp).toLocaleTimeString()}
                  </div>
                </motion.div>
              );
            })}
          </AnimatePresence>
        </div>
      </div>
    </div>
  );
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
}
