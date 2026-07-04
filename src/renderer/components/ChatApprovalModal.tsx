import { useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { motion, AnimatePresence } from 'framer-motion';
import {
  ArrowRight, CheckCircle2, Loader2, Trash2, X,
  FolderOpen, Info, Eye, Sparkles,
} from 'lucide-react';
import type { ApprovalPlan } from '../hooks/useChat';

const API = 'http://localhost:3001';

function formatBytes(bytes: number | null) {
  if (!bytes) return '-';
  if (bytes >= 1_048_576) return `${(bytes / 1_048_576).toFixed(1)} MB`;
  if (bytes >= 1_024) return `${Math.round(bytes / 1_024)} KB`;
  return `${bytes} B`;
}

/** Group organize-plan items by category for a cleaner details view */
function groupByCategory(items: ApprovalPlan['items']) {
  const map = new Map<string, ApprovalPlan['items']>();
  for (const item of items) {
    const cat = (item as any).category ?? 'Other';
    if (!map.has(cat)) map.set(cat, []);
    map.get(cat)!.push(item);
  }
  return Array.from(map.entries()).sort((a, b) => b[1].length - a[1].length);
}

interface ChatApprovalModalProps {
  plan: ApprovalPlan;
  /** 'approve' (default) — full modal with Approve button.
   *  'details' — read-only view; only shows Cancel + "Approve & Execute" buttons. */
  mode?: 'approve' | 'details';
  onClose: () => void;
  onCancel: () => void;
  onApproved: (message: string) => void;
}

export default function ChatApprovalModal({
  plan,
  mode = 'approve',
  onClose,
  onCancel,
  onApproved,
}: ChatApprovalModalProps) {
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // In 'details' mode the user can switch to see the raw file list
  const [detailsView, setDetailsView] = useState<'grouped' | 'list'>('grouped');

  const isDelete = plan.type === 'delete_file' || plan.type === 'delete_files';
  const isScan = plan.type === 'scan_structure';
  const hasFolderOps = plan.items.some(
    (item) => item.operation === 'create_folder' || item.operation === 'move_folder'
  );

  const totalSize = useMemo(
    () => plan.items.reduce((sum, item) => sum + (item.sizeBytes ?? 0), 0),
    [plan.items]
  );

  const grouped = useMemo(() => groupByCategory(plan.items), [plan.items]);

  const handleApprove = async () => {
    setSubmitting(true);
    setError(null);

    try {
      const res = await fetch(`${API}/api/chat/execute`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ planId: plan.id }),
      });

      const data = (await res.json()) as { message?: string; error?: string };
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      onApproved(data.message || 'Plan completed.');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not execute the plan');
    } finally {
      setSubmitting(false);
    }
  };

  // ── Label helpers ────────────────────────────────────────────────────────
  const approveLabel = isDelete
    ? 'Approve & Delete'
    : isScan
    ? 'Approve & Organise'
    : hasFolderOps
    ? 'Approve & Execute'
    : 'Approve & Move';

  const loadingLabel = isDelete
    ? 'Deleting…'
    : isScan
    ? 'Organising…'
    : hasFolderOps
    ? 'Executing…'
    : 'Moving Files…';

  const categoryColors: Record<string, string> = {
    Images: '#F472B6',
    Videos: '#FB923C',
    Music: '#34D399',
    Documents: '#60A5FA',
    Archives: '#C084FC',
    Installers: '#FBBF24',
    Code: '#34D399',
    Others: '#8B8BAD',
    Other: '#8B8BAD',
  };

  return createPortal(
    <AnimatePresence>
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        className="fixed inset-0 z-[100] flex items-center justify-center p-4"
        style={{ background: 'rgba(3, 5, 12, 0.72)', backdropFilter: 'blur(12px)' }}
        onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
      >
        <motion.div
          initial={{ opacity: 0, y: 22, scale: 0.98 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={{ opacity: 0, y: 18, scale: 0.98 }}
          className="w-full max-w-3xl rounded-3xl overflow-hidden flex flex-col"
          style={{
            background: 'rgba(20,20,43,0.97)',
            border: '1px solid rgba(255,255,255,0.08)',
            boxShadow: '0 24px 80px rgba(0,0,0,0.5)',
            maxHeight: '90vh',
          }}
        >
          {/* ── Header ──────────────────────────────────────────────────── */}
          <div
            className="flex items-start justify-between gap-4 px-6 py-5 border-b shrink-0"
            style={{ borderColor: 'rgba(255,255,255,0.08)' }}
          >
            <div className="flex-1 min-w-0">
              {/* Mode badge */}
              <div className="flex items-center gap-2 mb-2">
                {mode === 'details' ? (
                  <span
                    className="inline-flex items-center gap-1.5 text-[10px] font-bold px-2.5 py-1 rounded-full uppercase tracking-wider"
                    style={{ background: 'rgba(129,140,248,0.15)', color: '#818CF8', border: '1px solid rgba(129,140,248,0.25)' }}
                  >
                    <Eye size={10} />
                    Plan Details
                  </span>
                ) : (
                  <span
                    className="inline-flex items-center gap-1.5 text-[10px] font-bold px-2.5 py-1 rounded-full uppercase tracking-wider"
                    style={{ background: 'rgba(52,211,153,0.12)', color: '#34D399', border: '1px solid rgba(52,211,153,0.2)' }}
                  >
                    <CheckCircle2 size={10} />
                    Ready to Execute
                  </span>
                )}
              </div>
              <p className="text-lg font-semibold text-white leading-snug">{plan.title}</p>
              <p className="text-sm mt-1" style={{ color: '#9CA3AF' }}>
                {plan.detail}
              </p>
              {/* Meta chips */}
              <div className="flex flex-wrap gap-2 mt-3 text-xs">
                <span
                  className="px-2.5 py-1 rounded-full"
                  style={{ background: 'rgba(99,102,241,0.14)', color: '#A5B4FC' }}
                >
                  {plan.count} {plan.count === 1 ? 'item' : 'items'}
                </span>
                {totalSize > 0 && (
                  <span
                    className="px-2.5 py-1 rounded-full"
                    style={{ background: 'rgba(52,211,153,0.12)', color: '#6EE7B7' }}
                  >
                    {formatBytes(totalSize)}
                  </span>
                )}
                {isScan && (
                  <span
                    className="px-2.5 py-1 rounded-full"
                    style={{ background: 'rgba(251,146,60,0.12)', color: '#FCD34D' }}
                  >
                    {grouped.length} folder{grouped.length === 1 ? '' : 's'} will be created
                  </span>
                )}
                {isDelete && (
                  <span
                    className="px-2.5 py-1 rounded-full"
                    style={{ background: 'rgba(239,68,68,0.12)', color: '#FCA5A5' }}
                  >
                    Moved to SmartDesk Trash (recoverable)
                  </span>
                )}
              </div>
            </div>
            <button
              onClick={onClose}
              className="p-2 rounded-xl shrink-0"
              style={{ color: '#9CA3AF', background: 'rgba(255,255,255,0.05)' }}
            >
              <X size={18} />
            </button>
          </div>

          {/* ── Source → Destination bar ────────────────────────────────── */}
          <div
            className="px-6 py-3 border-b text-sm shrink-0"
            style={{ borderColor: 'rgba(255,255,255,0.06)', color: '#D1D5DB' }}
          >
            {isDelete ? (
              <div className="flex items-center gap-2">
                <Trash2 size={13} style={{ color: '#FCA5A5' }} />
                <span style={{ color: '#FCA5A5' }}>From: {plan.sourceLabel}</span>
                <ArrowRight size={13} className="text-red-400" />
                <span style={{ color: '#FCA5A5' }}>~/.SmartDesk/Trash/</span>
              </div>
            ) : (
              <div className="flex items-center gap-2">
                <FolderOpen size={13} className="text-indigo-400" />
                <span>{plan.sourceLabel}</span>
                <ArrowRight size={13} className="text-indigo-300" />
                <span className="text-indigo-300">{plan.destinationLabel}</span>
              </div>
            )}
          </div>

          {/* ── Delete warning banner ────────────────────────────────────── */}
          {isDelete && (
            <div
              className="px-6 py-3 text-sm shrink-0"
              style={{
                background: 'rgba(239,68,68,0.07)',
                borderBottom: '1px solid rgba(239,68,68,0.14)',
                color: '#FCA5A5',
              }}
            >
              ⚠️ Files will be moved to{' '}
              <code style={{ fontFamily: 'monospace' }}>~/.SmartDesk/Trash/</code> and can be
              recovered at any time.
            </div>
          )}

          {/* ── View toggle (Details mode only, for scan plans) ─────────── */}
          {mode === 'details' && isScan && (
            <div
              className="px-6 pt-4 pb-1 flex items-center gap-2 shrink-0"
            >
              <button
                onClick={() => setDetailsView('grouped')}
                className="text-xs px-3 py-1.5 rounded-lg font-medium transition-all"
                style={
                  detailsView === 'grouped'
                    ? { background: 'rgba(99,102,241,0.2)', color: '#A5B4FC', border: '1px solid rgba(99,102,241,0.3)' }
                    : { background: 'transparent', color: '#6B7280', border: '1px solid rgba(255,255,255,0.07)' }
                }
              >
                <Sparkles size={11} className="inline mr-1" />
                By Category
              </button>
              <button
                onClick={() => setDetailsView('list')}
                className="text-xs px-3 py-1.5 rounded-lg font-medium transition-all"
                style={
                  detailsView === 'list'
                    ? { background: 'rgba(99,102,241,0.2)', color: '#A5B4FC', border: '1px solid rgba(99,102,241,0.3)' }
                    : { background: 'transparent', color: '#6B7280', border: '1px solid rgba(255,255,255,0.07)' }
                }
              >
                All Files
              </button>
            </div>
          )}

          {/* ── Plan content (scrollable) ────────────────────────────────── */}
          <div className="flex-1 overflow-y-auto px-6 py-4 min-h-0">
            {/* ── Grouped view (scan plans in details mode) ────────────── */}
            {mode === 'details' && isScan && detailsView === 'grouped' ? (
              <div className="space-y-4">
                {grouped.map(([category, items]) => {
                  const color = categoryColors[category] ?? '#8B8BAD';
                  const catSize = items.reduce((s, i) => s + (i.sizeBytes ?? 0), 0);
                  return (
                    <div
                      key={category}
                      className="rounded-2xl overflow-hidden"
                      style={{ border: `1px solid ${color}22`, background: `${color}08` }}
                    >
                      {/* Category header */}
                      <div
                        className="flex items-center justify-between px-4 py-2.5"
                        style={{ borderBottom: `1px solid ${color}18` }}
                      >
                        <div className="flex items-center gap-2">
                          <div
                            className="w-2 h-2 rounded-full"
                            style={{ background: color, boxShadow: `0 0 6px ${color}88` }}
                          />
                          <span className="text-sm font-semibold" style={{ color }}>
                            📂 {category}/
                          </span>
                        </div>
                        <div className="flex items-center gap-3">
                          <span className="text-xs" style={{ color: '#6B7280' }}>
                            {formatBytes(catSize)}
                          </span>
                          <span
                            className="text-xs font-bold px-2 py-0.5 rounded-full"
                            style={{ background: `${color}22`, color }}
                          >
                            {items.length} file{items.length === 1 ? '' : 's'}
                          </span>
                        </div>
                      </div>
                      {/* Files in this category */}
                      <div className="px-4 py-2 space-y-1.5">
                        {items.map((item) => (
                          <div
                            key={`${item.sourcePath}-${item.name}`}
                            className="flex items-center justify-between gap-3 py-1"
                          >
                            <div className="min-w-0 flex-1 flex items-center gap-2">
                              <ArrowRight size={11} style={{ color: `${color}88`, flexShrink: 0 }} />
                              <span
                                className="text-xs truncate"
                                style={{ color: '#C4C4E8' }}
                                title={item.name}
                              >
                                {item.name}
                              </span>
                            </div>
                            <span className="text-xs shrink-0" style={{ color: '#6B7280' }}>
                              {formatBytes(item.sizeBytes)}
                            </span>
                          </div>
                        ))}
                      </div>
                    </div>
                  );
                })}
              </div>
            ) : (
              /* ── Flat list view (default for non-scan or 'approve' mode) */
              <div className="space-y-2">
                {plan.items.map((item) => {
                  const op = item.operation ?? (isDelete ? 'delete' : 'move');
                  const key = `${item.sourcePath}-${item.targetPath ?? item.newName ?? item.name}`;
                  const catColor =
                    categoryColors[(item as any).category ?? ''] ?? '#818CF8';

                  return (
                    <div
                      key={key}
                      className="rounded-2xl px-4 py-3"
                      style={{
                        background: 'rgba(255,255,255,0.04)',
                        border: '1px solid rgba(255,255,255,0.05)',
                      }}
                    >
                      <div className="flex items-center justify-between gap-4">
                        <div className="min-w-0 flex-1">
                          <p className="text-sm font-medium text-white truncate">{item.name}</p>

                          {op === 'delete' && (
                            <>
                              <p className="text-xs truncate mt-1" style={{ color: '#FCA5A5' }}>
                                {item.sourcePath}
                              </p>
                              <p className="text-xs truncate mt-1" style={{ color: '#6B7280' }}>
                                → SmartDesk Trash (recoverable)
                              </p>
                            </>
                          )}

                          {op === 'move' && (
                            <>
                              <p className="text-xs truncate mt-1" style={{ color: '#9CA3AF' }}>
                                {item.sourcePath}
                              </p>
                              <p className="text-xs truncate mt-1" style={{ color: catColor }}>
                                {(item as any).category
                                  ? `→ ${(item as any).category}/`
                                  : item.targetPath}
                              </p>
                            </>
                          )}

                          {op === 'rename' && (
                            <>
                              <p className="text-xs truncate mt-1" style={{ color: '#9CA3AF' }}>
                                {item.sourcePath}
                              </p>
                              <div className="flex items-center gap-1 mt-1">
                                <span className="text-xs" style={{ color: '#9CA3AF' }}>
                                  {item.name}
                                </span>
                                <ArrowRight size={10} style={{ color: '#A5B4FC' }} />
                                <span className="text-xs" style={{ color: '#A5B4FC' }}>
                                  {item.newName}
                                </span>
                              </div>
                            </>
                          )}

                          {op === 'create_folder' && (
                            <>
                              <p className="text-xs truncate mt-1" style={{ color: '#9CA3AF' }}>
                                Parent: {item.sourcePath}
                              </p>
                              <p className="text-xs truncate mt-1" style={{ color: '#A5B4FC' }}>
                                Create: {item.targetPath}
                              </p>
                            </>
                          )}

                          {op === 'move_folder' && (
                            <>
                              <p className="text-xs truncate mt-1" style={{ color: '#9CA3AF' }}>
                                {item.sourcePath}
                              </p>
                              <p className="text-xs truncate mt-1" style={{ color: '#A5B4FC' }}>
                                {item.targetPath}
                              </p>
                            </>
                          )}
                        </div>

                        <div className="flex items-center gap-2 shrink-0">
                          {op === 'delete' && <Trash2 size={14} style={{ color: '#FCA5A5' }} />}
                          {op === 'move' && <ArrowRight size={14} style={{ color: catColor }} />}
                          {(op === 'create_folder' || op === 'move_folder') && (
                            <ArrowRight size={14} style={{ color: '#A5B4FC' }} />
                          )}
                          <span className="text-xs" style={{ color: '#9CA3AF' }}>
                            {formatBytes(item.sizeBytes)}
                          </span>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          {/* ── Footer ──────────────────────────────────────────────────── */}
          <div
            className="px-6 py-5 border-t shrink-0"
            style={{ borderColor: 'rgba(255,255,255,0.08)' }}
          >
            {error && (
              <p className="text-sm mb-3" style={{ color: '#FCA5A5' }}>
                {error}
              </p>
            )}
            <div className="flex items-center justify-between gap-3">
              {/* Left: info note for details mode */}
              {mode === 'details' && (
                <p className="text-xs flex items-center gap-1.5" style={{ color: '#6B7280' }}>
                  <Info size={12} />
                  Nothing will change until you approve.
                </p>
              )}

              <div className="flex items-center gap-3 ml-auto">
                <button
                  onClick={onCancel}
                  disabled={submitting}
                  className="px-4 py-2 rounded-xl text-sm transition-all"
                  style={{
                    background: 'rgba(255,255,255,0.06)',
                    color: '#D1D5DB',
                    border: '1px solid rgba(255,255,255,0.08)',
                  }}
                >
                  Cancel
                </button>
                <motion.button
                  whileHover={{ scale: submitting ? 1 : 1.03 }}
                  whileTap={{ scale: submitting ? 1 : 0.97 }}
                  onClick={handleApprove}
                  disabled={submitting}
                  className="inline-flex items-center gap-2 px-5 py-2 rounded-xl text-sm font-semibold transition-all"
                  style={
                    isDelete
                      ? { background: 'linear-gradient(135deg,#DC2626,#B91C1C)', color: '#fff' }
                      : {
                          background: 'linear-gradient(135deg,#4F46E5,#7C3AED)',
                          color: '#fff',
                          boxShadow: '0 0 18px rgba(79,70,229,.4)',
                        }
                  }
                >
                  {submitting ? (
                    <Loader2 size={15} className="animate-spin" />
                  ) : isDelete ? (
                    <Trash2 size={15} />
                  ) : (
                    <CheckCircle2 size={15} />
                  )}
                  {submitting ? loadingLabel : approveLabel}
                </motion.button>
              </div>
            </div>
          </div>
        </motion.div>
      </motion.div>
    </AnimatePresence>,
    document.body
  );
}
