import { useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { motion, AnimatePresence } from 'framer-motion';
import { ArrowRight, CheckCircle2, Loader2, Trash2, X } from 'lucide-react';
import type { ApprovalPlan } from '../hooks/useChat';

const API = 'http://localhost:3001';

function formatBytes(bytes: number | null) {
  if (!bytes) return '-';
  if (bytes >= 1_048_576) return `${(bytes / 1_048_576).toFixed(1)} MB`;
  if (bytes >= 1_024) return `${Math.round(bytes / 1_024)} KB`;
  return `${bytes} B`;
}

interface ChatApprovalModalProps {
  plan: ApprovalPlan;
  onClose: () => void;
  onCancel: () => void;
  onApproved: (message: string) => void;
}

export default function ChatApprovalModal({ plan, onClose, onCancel, onApproved }: ChatApprovalModalProps) {
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const isDelete = plan.type === 'delete_file' || plan.type === 'delete_files';
  const isScan = plan.type === 'scan_structure';
  const hasFolderOps = plan.items.some((item) => item.operation === 'create_folder' || item.operation === 'move_folder');

  const totalSize = useMemo(
    () => plan.items.reduce((sum, item) => sum + (item.sizeBytes ?? 0), 0),
    [plan.items]
  );

  const handleApprove = async () => {
    setSubmitting(true);
    setError(null);

    try {
      const res = await fetch(`${API}/api/chat/execute`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ planId: plan.id }),
      });

      const data = await res.json() as { message?: string; error?: string };
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      onApproved(data.message || 'Plan completed.');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not execute the plan');
    } finally {
      setSubmitting(false);
    }
  };

  return createPortal(
    <AnimatePresence>
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        className="fixed inset-0 z-[100] flex items-center justify-center p-4"
        style={{ background: 'rgba(3, 5, 12, 0.72)', backdropFilter: 'blur(12px)' }}
      >
        <motion.div
          initial={{ opacity: 0, y: 22, scale: 0.98 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={{ opacity: 0, y: 18, scale: 0.98 }}
          className="w-full max-w-3xl rounded-3xl overflow-hidden"
          style={{
            background: 'rgba(20,20,43,0.95)',
            border: '1px solid rgba(255,255,255,0.08)',
            boxShadow: '0 24px 80px rgba(0,0,0,0.45)',
          }}
        >
          {/* Header */}
          <div className="flex items-start justify-between gap-4 px-6 py-5 border-b" style={{ borderColor: 'rgba(255,255,255,0.08)' }}>
            <div>
              <p className="text-lg font-semibold text-white">{plan.title}</p>
              <p className="text-sm mt-1" style={{ color: '#9CA3AF' }}>{plan.detail}</p>
              <div className="flex flex-wrap gap-2 mt-3 text-xs">
                <span className="px-2.5 py-1 rounded-full" style={{ background: 'rgba(99,102,241,0.14)', color: '#A5B4FC' }}>
                  {plan.count} {plan.count === 1 ? 'file' : 'files'}
                </span>
                {totalSize > 0 && (
                  <span className="px-2.5 py-1 rounded-full" style={{ background: 'rgba(52,211,153,0.12)', color: '#6EE7B7' }}>
                    {formatBytes(totalSize)}
                  </span>
                )}
                {isDelete && (
                  <span className="px-2.5 py-1 rounded-full" style={{ background: 'rgba(239,68,68,0.12)', color: '#FCA5A5' }}>
                    Will be moved to SmartDesk Trash (recoverable)
                  </span>
                )}
              </div>
            </div>
            <button onClick={onClose} className="p-2 rounded-xl" style={{ color: '#9CA3AF', background: 'rgba(255,255,255,0.05)' }}>
              <X size={18} />
            </button>          </div>

          {/* Operation summary bar */}
          <div className="px-6 py-4 border-b text-sm" style={{ borderColor: 'rgba(255,255,255,0.08)', color: '#D1D5DB' }}>
            {isDelete ? (
              <div className="flex items-center gap-2">
                <Trash2 size={14} style={{ color: '#FCA5A5' }} />
                <span style={{ color: '#FCA5A5' }}>From: {plan.sourceLabel}</span>
                <ArrowRight size={14} className="text-red-400" />
                <span style={{ color: '#FCA5A5' }}>~/.SmartDesk/Trash/</span>
              </div>
            ) : (
              <div className="flex items-center gap-2">
                <span>{plan.sourceLabel}</span>
                <ArrowRight size={14} className="text-indigo-300" />
                <span>{plan.destinationLabel}</span>
              </div>
            )}
          </div>

          {/* Delete warning banner */}
          {isDelete && (
            <div className="px-6 py-3 text-sm" style={{ background: 'rgba(239,68,68,0.08)', borderBottom: '1px solid rgba(239,68,68,0.15)', color: '#FCA5A5' }}>
              ⚠️ Files will be moved to <code style={{ fontFamily: 'monospace' }}>~/.SmartDesk/Trash/</code> and can be recovered at any time.
            </div>
          )}

          {/* File list */}
          <div className="max-h-[420px] overflow-y-auto px-6 py-4">
            <div className="space-y-2">
              {plan.items.map((item) => {
                const op = item.operation ?? (isDelete ? 'delete' : 'move');
                const key = `${item.sourcePath}-${item.targetPath ?? item.newName ?? item.name}`;

                return (
                  <div
                    key={key}
                    className="rounded-2xl px-4 py-3"
                    style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.05)' }}
                  >
                    <div className="flex items-center justify-between gap-4">
                      <div className="min-w-0 flex-1">
                        <p className="text-sm font-medium text-white truncate">{item.name}</p>

                        {op === 'delete' && (
                          <>
                            <p className="text-xs truncate mt-1" style={{ color: '#FCA5A5' }}>{item.sourcePath}</p>
                            <p className="text-xs truncate mt-1" style={{ color: '#6B7280' }}>→ SmartDesk Trash (recoverable)</p>
                          </>
                        )}

                        {op === 'move' && (
                          <>
                            <p className="text-xs truncate mt-1" style={{ color: '#9CA3AF' }}>{item.sourcePath}</p>
                            <p className="text-xs truncate mt-1" style={{ color: '#A5B4FC' }}>
                              {(item as any).category
                                ? `→ ${(item as any).category}/`
                                : item.targetPath
                              }
                            </p>
                          </>
                        )}

                        {op === 'rename' && (
                          <>
                            <p className="text-xs truncate mt-1" style={{ color: '#9CA3AF' }}>{item.sourcePath}</p>
                            <div className="flex items-center gap-1 mt-1">
                              <span className="text-xs" style={{ color: '#9CA3AF' }}>{item.name}</span>
                              <ArrowRight size={10} style={{ color: '#A5B4FC' }} />
                              <span className="text-xs" style={{ color: '#A5B4FC' }}>{item.newName}</span>
                            </div>
                          </>
                        )}

                        {op === 'create_folder' && (
                          <>
                            <p className="text-xs truncate mt-1" style={{ color: '#9CA3AF' }}>Parent: {item.sourcePath}</p>
                            <p className="text-xs truncate mt-1" style={{ color: '#A5B4FC' }}>Create: {item.targetPath}</p>
                          </>
                        )}

                        {op === 'move_folder' && (
                          <>
                            <p className="text-xs truncate mt-1" style={{ color: '#9CA3AF' }}>{item.sourcePath}</p>
                            <p className="text-xs truncate mt-1" style={{ color: '#A5B4FC' }}>{item.targetPath}</p>
                          </>
                        )}
                      </div>

                      <div className="flex items-center gap-2 shrink-0">
                        {op === 'delete' && <Trash2 size={14} style={{ color: '#FCA5A5' }} />}
                        {op === 'move' && <ArrowRight size={14} style={{ color: '#A5B4FC' }} />}
                        {(op === 'create_folder' || op === 'move_folder') && <ArrowRight size={14} style={{ color: '#A5B4FC' }} />}
                        <span className="text-xs" style={{ color: '#9CA3AF' }}>{formatBytes(item.sizeBytes)}</span>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          {/* Footer */}
          <div className="px-6 py-5 border-t" style={{ borderColor: 'rgba(255,255,255,0.08)' }}>
            {error && <p className="text-sm mb-3" style={{ color: '#FCA5A5' }}>{error}</p>}
            <div className="flex items-center justify-end gap-3">
              <button
                onClick={onCancel}
                disabled={submitting}
                className="px-4 py-2 rounded-xl text-sm"
                style={{ background: 'rgba(255,255,255,0.06)', color: '#D1D5DB' }}
              >
                Cancel
              </button>
              <button
                onClick={handleApprove}
                disabled={submitting}
                className="inline-flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-semibold"
                style={
                  isDelete
                    ? { background: 'linear-gradient(135deg,#DC2626,#B91C1C)', color: '#fff' }
                    : { background: 'linear-gradient(135deg,#4F46E5,#7C3AED)', color: '#fff' }
                }
              >
                {submitting
                  ? <Loader2 size={16} className="animate-spin" />
                  : isDelete
                    ? <Trash2 size={16} />
                    : <CheckCircle2 size={16} />
                }
                {submitting
                  ? (isDelete ? 'Deleting...' : isScan ? 'Organising...' : hasFolderOps ? 'Executing Plan...' : 'Moving Files...')
                  : (isDelete ? 'Approve & Delete' : isScan ? 'Approve & Organise' : hasFolderOps ? 'Approve & Execute' : 'Approve and Move')
                }
              </button>
            </div>
          </div>
        </motion.div>
      </motion.div>
    </AnimatePresence>,
    document.body
  );
}
