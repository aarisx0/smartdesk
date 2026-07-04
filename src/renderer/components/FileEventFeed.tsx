import { AnimatePresence, motion } from 'framer-motion';
import { FileText, FolderPlus, Edit3, Trash2 } from 'lucide-react';
import type { WatcherEvent } from '../hooks/useWatcherEvents';

interface Props {
  events: WatcherEvent[];
}

const eventConfig = {
  add: { icon: FileText, label: 'Added', color: '#818CF8' },
  addDir: { icon: FolderPlus, label: 'Dir Added', color: '#34D399' },
  change: { icon: Edit3, label: 'Modified', color: '#FCD34D' },
  unlink: { icon: Trash2, label: 'Deleted', color: '#FCA5A5' },
  unlinkDir: { icon: Trash2, label: 'Dir Removed', color: '#FCA5A5' },
} as const;

export default function FileEventFeed({ events }: Props) {
  if (events.length === 0) {
    return (
      <div className="py-10 text-center text-sm" style={{ color: '#555575' }}>
        Waiting for file events…
      </div>
    );
  }

  return (
    <div className="space-y-2 max-h-72 overflow-y-auto pr-1">
      <AnimatePresence initial={false}>
        {events.slice(0, 50).map((ev, i) => {
          const cfg = eventConfig[ev.type] ?? eventConfig.add;
          const Icon = cfg.icon;
          return (
            <motion.div
              key={`${ev.path}-${ev.timestamp}`}
              initial={{ opacity: 0, x: -10 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, height: 0 }}
              transition={{ duration: 0.2, delay: i < 5 ? i * 0.04 : 0 }}
              className="flex items-center gap-3 p-2.5 rounded-lg hover:bg-white/[0.02] transition-colors"
            >
              <div className="w-7 h-7 rounded-lg flex items-center justify-center shrink-0"
                style={{ background: `${cfg.color}15` }}>
                <Icon size={13} style={{ color: cfg.color }} />
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-xs font-medium text-white truncate">
                  {ev.path.split(/[\\/]/).pop()}
                </p>
                <p className="text-xs truncate" style={{ color: '#555575' }}>{ev.path}</p>
              </div>
              <div className="shrink-0 text-right">
                <span className="text-xs font-medium" style={{ color: cfg.color }}>
                  {cfg.label}
                </span>
                <p className="text-xs" style={{ color: '#555575' }}>
                  {new Date(ev.timestamp).toLocaleTimeString()}
                </p>
              </div>
            </motion.div>
          );
        })}
      </AnimatePresence>
    </div>
  );
}
