import { useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { CheckCircle, XCircle, FileText, Folder, ArrowRight, RefreshCw } from 'lucide-react';
import { useApprovals } from '../hooks/useApprovals';

export default function Approvals() {
  const { pending, approve, reject, loading, refresh } = useApprovals();
  const [processingId, setProcessingId] = useState<string | null>(null);

  const handleAction = async (id: string, approved: boolean) => {
    setProcessingId(id);
    await (approved ? approve(id) : reject(id));
    setProcessingId(null);
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-white">Pending Approvals</h1>
          <p className="text-sm mt-0.5" style={{ color: '#8B8BAD' }}>
            Review AI-suggested file moves before they execute
          </p>
        </div>
        <div className="flex items-center gap-2">
          {pending.length > 0 && (
            <span className="badge badge-orange">{pending.length} pending</span>
          )}
          <motion.button whileHover={{ scale: 1.03 }} whileTap={{ scale: 0.97 }}
            className="btn-ghost flex items-center gap-2"
            onClick={refresh}
          >
            <RefreshCw size={14} />
            Refresh
          </motion.button>
        </div>
      </div>

      {loading && (
        <div className="text-center py-16" style={{ color: '#555575' }}>
          <RefreshCw size={24} className="animate-spin mx-auto mb-3" />
          <p className="text-sm">Loading approvals…</p>
        </div>
      )}

      {!loading && pending.length === 0 && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          className="glass-card p-16 text-center"
        >
          <CheckCircle size={40} className="mx-auto mb-4 text-emerald-400"
            style={{ filter: 'drop-shadow(0 0 8px #34D399)' }}
          />
          <p className="text-base font-semibold text-white">All caught up!</p>
          <p className="text-sm mt-1" style={{ color: '#8B8BAD' }}>
            No pending file moves to approve.
          </p>
        </motion.div>
      )}

      <div className="space-y-3">
        <AnimatePresence>
          {pending.map((item) => (
            <motion.div
              key={item.id}
              layout
              initial={{ opacity: 0, y: 12 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, x: -40, height: 0 }}
              transition={{ duration: 0.25 }}
              className="glass-card p-5"
            >
              <div className="flex items-start gap-4">
                <div className="w-10 h-10 rounded-xl flex items-center justify-center shrink-0"
                  style={{ background: 'rgba(79, 70, 229, 0.15)', border: '1px solid rgba(79, 70, 229, 0.3)' }}
                >
                  <FileText size={18} className="text-indigo-400" />
                </div>

                <div className="flex-1 min-w-0">
                  <p className="text-sm font-semibold text-white truncate">{item.fileName}</p>
                  <div className="flex items-center gap-2 mt-1.5 flex-wrap">
                    <span className="text-xs truncate max-w-[200px]" style={{ color: '#8B8BAD' }}>
                      {item.sourcePath}
                    </span>
                    <ArrowRight size={12} style={{ color: '#555575' }} />
                    <span className="flex items-center gap-1 text-xs" style={{ color: '#818CF8' }}>
                      <Folder size={12} />
                      {item.targetPath}
                    </span>
                  </div>
                  <div className="flex items-center gap-2 mt-2">
                    <span className="badge badge-blue">{item.category}</span>
                    <span className="text-xs" style={{ color: '#555575' }}>
                      Confidence: <span className="text-indigo-300">{item.confidence}%</span>
                    </span>
                  </div>
                </div>

                <div className="flex items-center gap-2 shrink-0">
                  <motion.button
                    whileHover={{ scale: 1.06 }}
                    whileTap={{ scale: 0.95 }}
                    disabled={processingId === item.id}
                    onClick={() => handleAction(item.id, false)}
                    className="flex items-center gap-1.5 px-3 py-2 rounded-xl text-xs font-medium transition-all"
                    style={{
                      background: 'rgba(239, 68, 68, 0.1)',
                      border: '1px solid rgba(239, 68, 68, 0.25)',
                      color: '#FCA5A5',
                    }}
                  >
                    <XCircle size={14} />
                    Reject
                  </motion.button>
                  <motion.button
                    whileHover={{ scale: 1.06 }}
                    whileTap={{ scale: 0.95 }}
                    disabled={processingId === item.id}
                    onClick={() => handleAction(item.id, true)}
                    className="btn-gradient text-xs px-3 py-2"
                  >
                    <CheckCircle size={14} />
                    Approve
                  </motion.button>
                </div>
              </div>
            </motion.div>
          ))}
        </AnimatePresence>
      </div>
    </div>
  );
}
