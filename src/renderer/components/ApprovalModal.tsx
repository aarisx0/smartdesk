import { useEffect, useRef, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { motion, AnimatePresence } from 'framer-motion';
import {
  X, ChevronDown, ChevronUp, ArrowRight,
  CheckCircle2, XCircle, AlertTriangle, Loader2,
  FileText, FileImage, FileVideo, FileAudio,
  FileCode, FileSpreadsheet, FileArchive, File,
  FolderOpen, Sparkles, Filter,
} from 'lucide-react';
import type { PendingFile } from '../hooks/useDashboard';
import { useApprovalModal, type FileProgress } from '../hooks/useApprovalModal';

// ─── prop types ────────────────────────────────────────────────────────────────

export interface ApprovalModalProps {
  /** Files waiting for approval — passed from Dashboard / Approvals page. */
  files: PendingFile[];
  /** Called when the modal should close (after completion or cancel). */
  onClose: () => void;
  /** Called after files have been successfully moved (to trigger a data refresh). */
  onApproved?: () => void;
}

// ─── motion variants ──────────────────────────────────────────────────────────

const overlayVariants = {
  hidden:  { opacity: 0 },
  visible: { opacity: 1, transition: { duration: 0.22 } },
  exit:    { opacity: 0, transition: { duration: 0.18 } },
};

const modalVariants = {
  hidden:  { y: '100%', opacity: 0 },
  visible: {
    y: 0, opacity: 1,
    transition: { type: 'spring', stiffness: 380, damping: 36, mass: 0.9 },
  },
  exit: {
    y: '60%', opacity: 0,
    transition: { duration: 0.22, ease: [0.4, 0, 1, 1] },
  },
};

const rowVariants = {
  hidden:  { opacity: 0, x: -16 },
  visible: (i: number) => ({
    opacity: 1, x: 0,
    transition: { delay: i * 0.04, duration: 0.28, ease: [0.22, 1, 0.36, 1] },
  }),
  exit: { opacity: 0, x: 32, transition: { duration: 0.2 } },
};

const reasonVariants = {
  hidden:  { opacity: 0, height: 0 },
  visible: { opacity: 1, height: 'auto', transition: { duration: 0.22 } },
  exit:    { opacity: 0, height: 0,      transition: { duration: 0.15 } },
};

// ─── helpers ──────────────────────────────────────────────────────────────────

function formatBytes(b: number): string {
  if (b >= 1_073_741_824) return `${(b / 1_073_741_824).toFixed(1)} GB`;
  if (b >= 1_048_576)    return `${(b / 1_048_576).toFixed(1)} MB`;
  if (b >= 1_024)        return `${(b / 1_024).toFixed(0)} KB`;
  return `${b} B`;
}

function truncateMid(s: string, maxLen = 44): string {
  if (!s || s.length <= maxLen) return s;
  const half = Math.floor(maxLen / 2) - 1;
  return `${s.slice(0, half)}…${s.slice(-half)}`;
}

// ─── file-type icon ───────────────────────────────────────────────────────────

const EXT_CFG: Record<string, { icon: React.ElementType; color: string }> = {
  '.pdf':  { icon: FileText,        color: '#F87171' },
  '.doc':  { icon: FileText,        color: '#60A5FA' },
  '.docx': { icon: FileText,        color: '#60A5FA' },
  '.txt':  { icon: FileText,        color: '#94A3B8' },
  '.md':   { icon: FileText,        color: '#94A3B8' },
  '.jpg':  { icon: FileImage,       color: '#F472B6' },
  '.jpeg': { icon: FileImage,       color: '#F472B6' },
  '.png':  { icon: FileImage,       color: '#F472B6' },
  '.gif':  { icon: FileImage,       color: '#F472B6' },
  '.svg':  { icon: FileImage,       color: '#A78BFA' },
  '.mp4':  { icon: FileVideo,       color: '#FB923C' },
  '.mov':  { icon: FileVideo,       color: '#FB923C' },
  '.mkv':  { icon: FileVideo,       color: '#FB923C' },
  '.mp3':  { icon: FileAudio,       color: '#34D399' },
  '.wav':  { icon: FileAudio,       color: '#34D399' },
  '.flac': { icon: FileAudio,       color: '#34D399' },
  '.js':   { icon: FileCode,        color: '#FBBF24' },
  '.ts':   { icon: FileCode,        color: '#60A5FA' },
  '.py':   { icon: FileCode,        color: '#34D399' },
  '.xlsx': { icon: FileSpreadsheet, color: '#4ADE80' },
  '.csv':  { icon: FileSpreadsheet, color: '#4ADE80' },
  '.zip':  { icon: FileArchive,     color: '#C084FC' },
  '.rar':  { icon: FileArchive,     color: '#C084FC' },
};

function FileTypeIcon({ ext, size = 17 }: { ext: string; size?: number }) {
  const cfg = EXT_CFG[ext.toLowerCase()] ?? { icon: File, color: '#8B8BAD' };
  const Icon = cfg.icon;
  return <Icon size={size} style={{ color: cfg.color, flexShrink: 0 }} />;
}

// ─── confidence badge ─────────────────────────────────────────────────────────

function ConfidenceBadge({ score }: { score: number | null }) {
  if (score === null || score === undefined)
    return <span className="text-xs" style={{ color: '#555575' }}>N/A</span>;
  const pct = score <= 1 ? Math.round(score * 100) : Math.round(score);
  const [bg, fg, border, label] =
    pct >= 80 ? ['rgba(16,185,129,.14)', '#34D399', 'rgba(16,185,129,.28)', `${pct}%`]
  : pct >= 50 ? ['rgba(245,158,11,.13)', '#FCD34D', 'rgba(245,158,11,.27)', `${pct}%`]
  :             ['rgba(239,68,68,.13)',  '#FCA5A5', 'rgba(239,68,68,.27)',  `${pct}%`];
  return (
    <span className="inline-flex items-center gap-1 text-xs font-semibold px-2 py-0.5 rounded-full"
      style={{ background: bg, color: fg, border: `1px solid ${border}` }}>
      {pct < 50 && <AlertTriangle size={10} />}
      {label}
    </span>
  );
}

// ─── per-file progress bar ────────────────────────────────────────────────────

function ProgressBar({ prog }: { prog: FileProgress }) {
  if (prog.status === 'waiting') return null;

  if (prog.status === 'done')
    return (
      <motion.div
        initial={{ scale: 0.5, opacity: 0 }}
        animate={{ scale: 1,   opacity: 1 }}
        className="flex items-center gap-1.5 text-xs font-medium"
        style={{ color: '#34D399' }}
      >
        <CheckCircle2 size={14} style={{ filter: 'drop-shadow(0 0 4px #34D399)' }} />
        Moved
      </motion.div>
    );

  if (prog.status === 'error')
    return (
      <div className="flex items-center gap-1.5 text-xs" style={{ color: '#FCA5A5' }}>
        <XCircle size={13} />
        <span className="truncate max-w-[140px]">{prog.message}</span>
      </div>
    );

  // moving — animated bar
  return (
    <div className="flex items-center gap-2 min-w-[120px]">
      <div className="flex-1 h-1.5 rounded-full overflow-hidden"
        style={{ background: 'rgba(255,255,255,0.08)' }}>
        <motion.div
          className="h-full rounded-full"
          style={{ background: 'linear-gradient(90deg, #4F46E5, #7C3AED)' }}
          animate={{ width: `${prog.progress}%` }}
          transition={{ ease: 'linear', duration: 0.05 }}
        />
      </div>
      <span className="text-xs font-medium tabular-nums" style={{ color: '#818CF8', minWidth: 32 }}>
        {prog.progress}%
      </span>
      <Loader2 size={12} className="animate-spin shrink-0" style={{ color: '#818CF8' }} />
    </div>
  );
}

// ─── confetti canvas ──────────────────────────────────────────────────────────

interface Particle {
  x: number; y: number;
  vx: number; vy: number;
  rot: number; rotV: number;
  w: number; h: number;
  color: string;
  opacity: number;
}

function ConfettiCanvas() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const frameRef  = useRef<number>(0);
  const particles = useRef<Particle[]>([]);

  const COLORS = ['#4F46E5', '#7C3AED', '#34D399', '#F472B6', '#FBBF24', '#818CF8', '#A78BFA'];

  const spawnParticles = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const W = canvas.width;

    particles.current = Array.from({ length: 110 }, () => ({
      x:     Math.random() * W,
      y:     -10 - Math.random() * 100,
      vx:    (Math.random() - 0.5) * 3.5,
      vy:    2.5 + Math.random() * 3.5,
      rot:   Math.random() * 360,
      rotV:  (Math.random() - 0.5) * 8,
      w:     5 + Math.random() * 6,
      h:     3 + Math.random() * 4,
      color: COLORS[Math.floor(Math.random() * COLORS.length)],
      opacity: 0.85 + Math.random() * 0.15,
    }));
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d')!;

    const resize = () => {
      canvas.width  = canvas.offsetWidth;
      canvas.height = canvas.offsetHeight;
    };
    resize();
    window.addEventListener('resize', resize);

    spawnParticles();

    const draw = () => {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      const alive: Particle[] = [];

      for (const p of particles.current) {
        p.x   += p.vx;
        p.y   += p.vy;
        p.vy  += 0.07;          // gravity
        p.rot += p.rotV;
        p.opacity -= 0.004;

        if (p.y < canvas.height && p.opacity > 0) alive.push(p);

        ctx.save();
        ctx.globalAlpha = Math.max(0, p.opacity);
        ctx.translate(p.x, p.y);
        ctx.rotate((p.rot * Math.PI) / 180);
        ctx.fillStyle = p.color;
        ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h);
        ctx.restore();
      }

      particles.current = alive;
      if (alive.length > 0) frameRef.current = requestAnimationFrame(draw);
    };

    frameRef.current = requestAnimationFrame(draw);

    return () => {
      cancelAnimationFrame(frameRef.current);
      window.removeEventListener('resize', resize);
    };
  }, [spawnParticles]);

  return (
    <canvas
      ref={canvasRef}
      className="absolute inset-0 w-full h-full pointer-events-none"
      style={{ zIndex: 1 }}
    />
  );
}

// ─── completion screen ────────────────────────────────────────────────────────

function CompletionScreen({
  summary,
  onClose,
}: {
  summary: { filesOrganized: number; foldersCreated: number; storageSavedBytes: number; errors: number };
  onClose: () => void;
}) {
  const stats = [
    { label: 'Files Moved',       value: summary.filesOrganized,                color: '#818CF8' },
    { label: 'Folders Created',   value: summary.foldersCreated,                color: '#34D399' },
    { label: 'Storage Processed', value: formatBytes(summary.storageSavedBytes), color: '#FBBF24' },
  ];

  return (
    <motion.div
      key="completion"
      initial={{ opacity: 0, scale: 0.94 }}
      animate={{ opacity: 1, scale: 1, transition: { duration: 0.35, ease: [0.22, 1, 0.36, 1] } }}
      exit={{ opacity: 0 }}
      className="relative flex flex-col items-center justify-center h-full min-h-[380px] px-8 py-10 text-center overflow-hidden"
    >
      <ConfettiCanvas />

      {/* Content sits above the canvas */}
      <div className="relative z-10 flex flex-col items-center gap-5">
        {/* Glow icon */}
        <motion.div
          initial={{ scale: 0.3, opacity: 0 }}
          animate={{ scale: 1, opacity: 1, transition: { type: 'spring', stiffness: 320, damping: 22, delay: 0.1 } }}
          className="w-20 h-20 rounded-2xl flex items-center justify-center"
          style={{
            background: 'linear-gradient(135deg, #4F46E5, #7C3AED)',
            boxShadow:  '0 0 48px rgba(79,70,229,.65)',
          }}
        >
          <Sparkles size={36} className="text-white" />
        </motion.div>

        {/* Headline */}
        <motion.div
          initial={{ opacity: 0, y: 16 }}
          animate={{ opacity: 1, y: 0, transition: { delay: 0.2, duration: 0.3 } }}
        >
          <h2 className="text-2xl font-extrabold"
            style={{
              background: 'linear-gradient(135deg, #818CF8, #A78BFA)',
              WebkitBackgroundClip: 'text',
              WebkitTextFillColor: 'transparent',
              backgroundClip: 'text',
              filter: 'drop-shadow(0 0 10px rgba(129,140,248,.45))',
            }}>
            Organisation Complete!
          </h2>
          <p className="text-sm mt-1" style={{ color: '#8B8BAD' }}>
            Your desktop is cleaner now.
          </p>
        </motion.div>

        {/* Summary cards */}
        <motion.div
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0, transition: { delay: 0.32, duration: 0.3 } }}
          className="grid grid-cols-3 gap-3 w-full max-w-sm"
        >
          {stats.map(({ label, value, color }) => (
            <div key={label} className="rounded-xl p-4 flex flex-col items-center gap-1"
              style={{
                background: `${color}12`,
                border: `1px solid ${color}30`,
              }}>
              <span className="text-xl font-extrabold"
                style={{ color, filter: `drop-shadow(0 0 6px ${color}66)` }}>
                {value}
              </span>
              <span className="text-xs text-center leading-tight" style={{ color: '#8B8BAD' }}>
                {label}
              </span>
            </div>
          ))}
        </motion.div>

        {/* Error notice */}
        {summary.errors > 0 && (
          <motion.p
            initial={{ opacity: 0 }} animate={{ opacity: 1, transition: { delay: 0.4 } }}
            className="text-xs px-3 py-1.5 rounded-lg"
            style={{ background: 'rgba(239,68,68,.12)', color: '#FCA5A5', border: '1px solid rgba(239,68,68,.22)' }}
          >
            {summary.errors} file{summary.errors > 1 ? 's' : ''} could not be moved.
          </motion.p>
        )}

        {/* Done button */}
        <motion.button
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0, transition: { delay: 0.44 } }}
          whileHover={{ scale: 1.04 }}
          whileTap={{ scale: 0.96 }}
          onClick={onClose}
          className="btn-gradient mt-2 px-8 py-3 text-sm"
        >
          Done
        </motion.button>
      </div>
    </motion.div>
  );
}

// ─── single file row ──────────────────────────────────────────────────────────

interface FileRowProps {
  file: PendingFile;
  index: number;
  isSelected: boolean;
  isExpanded: boolean;
  prog: FileProgress | undefined;
  phase: 'idle' | 'approving' | 'complete';
  onToggleSelect: () => void;
  onToggleExpand: () => void;
}

function FileRow({
  file, index, isSelected, isExpanded, prog,
  phase, onToggleSelect, onToggleExpand,
}: FileRowProps) {
  const isMoving = prog?.status === 'moving' || prog?.status === 'done' || prog?.status === 'error';

  return (
    <motion.div
      key={file.id}
      custom={index}
      variants={rowVariants}
      initial="hidden"
      animate="visible"
      exit="exit"
      layout
      className="border-b last:border-b-0"
      style={{ borderColor: 'rgba(255,255,255,0.05)' }}
    >
      {/* Main row */}
      <div className="flex items-center gap-3 px-5 py-3.5 hover:bg-white/[0.02] transition-colors">
        {/* Checkbox */}
        {phase === 'idle' && (
          <button
            onClick={onToggleSelect}
            className="w-4.5 h-4.5 rounded-md shrink-0 flex items-center justify-center transition-all"
            style={{
              width: 18, height: 18,
              background: isSelected ? 'linear-gradient(135deg,#4F46E5,#7C3AED)' : 'rgba(255,255,255,0.06)',
              border: isSelected ? 'none' : '1.5px solid rgba(255,255,255,0.15)',
              boxShadow: isSelected ? '0 0 8px rgba(79,70,229,.45)' : 'none',
            }}
          >
            {isSelected && (
              <svg width="10" height="8" viewBox="0 0 10 8" fill="none">
                <path d="M1 4L3.5 6.5L9 1" stroke="white" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"/>
              </svg>
            )}
          </button>
        )}

        {/* File icon */}
        <FileTypeIcon ext={file.extension} size={16} />

        {/* Filename + paths */}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1.5 flex-wrap">
            <span className="text-xs font-semibold text-white truncate max-w-[180px]"
              title={file.filename}>
              {file.filename}
            </span>
            <ConfidenceBadge score={file.confidence_score} />
          </div>

          {/* Path row */}
          {phase === 'idle' && (
            <div className="flex items-center gap-1.5 mt-0.5 flex-wrap">
              <span className="text-xs truncate max-w-[160px]"
                style={{ color: '#555575' }}
                title={file.filepath}>
                {truncateMid(file.filepath)}
              </span>
              <ArrowRight size={10} style={{ color: '#4F46E5', flexShrink: 0 }} />
              <span className="flex items-center gap-1 text-xs font-medium truncate max-w-[140px]"
                style={{ color: '#818CF8' }}>
                <FolderOpen size={10} />
                {file.suggested_folder ?? '—'}
              </span>
              {file.size_bytes !== null && (
                <span className="text-xs" style={{ color: '#555575' }}>
                  · {formatBytes(file.size_bytes)}
                </span>
              )}
            </div>
          )}
        </div>

        {/* Right side: progress or expand button */}
        <div className="flex items-center gap-2 shrink-0">
          {phase === 'approving' && prog ? (
            <ProgressBar prog={prog} />
          ) : phase === 'idle' && file.ai_reasoning ? (
            <button
              onClick={onToggleExpand}
              className="p-1 rounded-lg transition-all"
              style={{
                color: '#555575',
                background: isExpanded ? 'rgba(79,70,229,.1)' : 'transparent',
              }}
              title="Toggle AI reasoning"
            >
              {isExpanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
            </button>
          ) : null}
        </div>
      </div>

      {/* Expandable reasoning */}
      <AnimatePresence initial={false}>
        {isExpanded && file.ai_reasoning && phase === 'idle' && (
          <motion.div
            key="reason"
            variants={reasonVariants}
            initial="hidden"
            animate="visible"
            exit="exit"
            className="overflow-hidden"
          >
            <div className="mx-5 mb-3 px-4 py-3 rounded-xl text-xs leading-relaxed"
              style={{
                background: 'rgba(79,70,229,.07)',
                border: '1px solid rgba(79,70,229,.18)',
                color: '#A0A0C8',
              }}>
              <span className="text-indigo-300 font-semibold">AI Reasoning: </span>
              {file.ai_reasoning}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  );
}

// ─── main modal ───────────────────────────────────────────────────────────────

export default function ApprovalModal({ files, onClose, onApproved }: ApprovalModalProps) {
  const {
    filteredFiles, selected, totalStorageBytes,
    showLowOnly, setShowLowOnly,
    expandedId, isAllSelected,
    phase, progress, summary,
    toggleFile, toggleAll, toggleExpand,
    approveSelected, approveAll, reset,
  } = useApprovalModal(files, () => { onApproved?.(); onClose(); });

  // Close on Escape (idle phase only)
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && phase === 'idle') onClose();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [phase, onClose]);

  // Prevent body scroll bleed
  useEffect(() => {
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = ''; };
  }, []);

  const selectedCount  = selected.size;
  const storageSummary = totalStorageBytes > 0 ? formatBytes(totalStorageBytes) : null;

  const modal = (
    <AnimatePresence mode="wait">
      {/* Overlay */}
      <motion.div
        key="overlay"
        variants={overlayVariants}
        initial="hidden"
        animate="visible"
        exit="exit"
        className="fixed inset-0 flex items-end justify-center"
        style={{ zIndex: 100, background: 'rgba(8,8,20,0.72)', backdropFilter: 'blur(8px)' }}
        onClick={(e) => { if (e.target === e.currentTarget && phase === 'idle') onClose(); }}
      >
        {/* Modal panel */}
        <motion.div
          key="modal"
          variants={modalVariants}
          initial="hidden"
          animate="visible"
          exit="exit"
          className="relative w-full max-w-3xl rounded-t-3xl flex flex-col overflow-hidden"
          style={{
            maxHeight: '88vh',
            background: 'rgba(14, 14, 28, 0.97)',
            border: '1px solid rgba(255,255,255,0.09)',
            borderBottom: 'none',
            backdropFilter: 'blur(32px)',
            WebkitBackdropFilter: 'blur(32px)',
            boxShadow: '0 -8px 60px rgba(0,0,0,0.6), 0 0 0 1px rgba(79,70,229,0.12)',
          }}
          onClick={(e) => e.stopPropagation()}
        >
          {/* ── Content switches between idle/approving and complete ── */}
          <AnimatePresence mode="wait">
            {phase === 'complete' && summary ? (
              <CompletionScreen key="done" summary={summary} onClose={reset} />
            ) : (
              <motion.div
                key="workflow"
                initial={{ opacity: 1 }}
                exit={{ opacity: 0, transition: { duration: 0.18 } }}
                className="flex flex-col overflow-hidden"
                style={{ maxHeight: '88vh' }}
              >
                {/* ── Header ──────────────────────────────────────────── */}
                <div className="flex items-center justify-between px-6 py-5 shrink-0 border-b"
                  style={{ borderColor: 'rgba(255,255,255,0.07)' }}>
                  <div className="flex items-center gap-3">
                    <div className="w-9 h-9 rounded-xl flex items-center justify-center shrink-0"
                      style={{
                        background: 'linear-gradient(135deg,#4F46E5,#7C3AED)',
                        boxShadow: '0 0 18px rgba(79,70,229,.45)',
                      }}>
                      <FolderOpen size={17} className="text-white" />
                    </div>
                    <div>
                      <h2 className="text-base font-bold text-white">Organisation Plan</h2>
                      <p className="text-xs mt-0.5" style={{ color: '#8B8BAD' }}>
                        Review AI suggestions before any files are moved
                      </p>
                    </div>
                    <span className="text-xs font-semibold px-2.5 py-1 rounded-full ml-1"
                      style={{
                        background: 'rgba(79,70,229,.18)',
                        color: '#818CF8',
                        border: '1px solid rgba(79,70,229,.3)',
                      }}>
                      {files.length} file{files.length !== 1 ? 's' : ''}
                    </span>
                  </div>
                  {phase === 'idle' && (
                    <motion.button
                      whileHover={{ scale: 1.1, rotate: 90 }}
                      whileTap={{ scale: 0.9 }}
                      onClick={onClose}
                      className="w-8 h-8 rounded-xl flex items-center justify-center transition-all"
                      style={{
                        background: 'rgba(255,255,255,0.05)',
                        border: '1px solid rgba(255,255,255,0.08)',
                        color: '#8B8BAD',
                      }}
                      transition={{ duration: 0.18 }}
                    >
                      <X size={15} />
                    </motion.button>
                  )}
                </div>

                {/* ── Toolbar: select-all + filter ──────────────────── */}
                {phase === 'idle' && (
                  <div className="flex items-center justify-between px-6 py-3 shrink-0 border-b"
                    style={{ borderColor: 'rgba(255,255,255,0.05)' }}>
                    {/* Select all */}
                    <label className="flex items-center gap-2.5 cursor-pointer select-none">
                      <button
                        onClick={toggleAll}
                        className="rounded-md flex items-center justify-center transition-all"
                        style={{
                          width: 18, height: 18,
                          background: isAllSelected ? 'linear-gradient(135deg,#4F46E5,#7C3AED)' : 'rgba(255,255,255,0.06)',
                          border: isAllSelected ? 'none' : '1.5px solid rgba(255,255,255,0.15)',
                          boxShadow: isAllSelected ? '0 0 8px rgba(79,70,229,.4)' : 'none',
                          flexShrink: 0,
                        }}
                      >
                        {isAllSelected && (
                          <svg width="10" height="8" viewBox="0 0 10 8" fill="none">
                            <path d="M1 4L3.5 6.5L9 1" stroke="white" strokeWidth="1.8"
                              strokeLinecap="round" strokeLinejoin="round"/>
                          </svg>
                        )}
                      </button>
                      <span className="text-xs font-medium" style={{ color: '#8B8BAD' }}>
                        {isAllSelected
                          ? `All ${filteredFiles.length} selected`
                          : `${selectedCount} of ${filteredFiles.length} selected`}
                      </span>
                    </label>

                    {/* Low confidence filter */}
                    <motion.button
                      whileTap={{ scale: 0.95 }}
                      onClick={() => setShowLowOnly((v) => !v)}
                      className="flex items-center gap-2 px-3 py-1.5 rounded-xl text-xs font-medium transition-all"
                      style={{
                        background: showLowOnly ? 'rgba(245,158,11,.14)' : 'rgba(255,255,255,0.05)',
                        border: showLowOnly ? '1px solid rgba(245,158,11,.3)' : '1px solid rgba(255,255,255,0.08)',
                        color:  showLowOnly ? '#FCD34D' : '#8B8BAD',
                      }}
                    >
                      <Filter size={12} />
                      Low Confidence Only
                      {showLowOnly && (
                        <span className="ml-1 px-1.5 py-0.5 rounded-full text-[10px] font-bold"
                          style={{ background: 'rgba(245,158,11,.25)', color: '#FCD34D' }}>
                          ON
                        </span>
                      )}
                    </motion.button>
                  </div>
                )}

                {/* ── File list ────────────────────────────────────────── */}
                <div className="flex-1 overflow-y-auto">
                  {filteredFiles.length === 0 ? (
                    <div className="py-16 text-center text-sm" style={{ color: '#555575' }}>
                      {showLowOnly ? 'No low-confidence files.' : 'No files to review.'}
                    </div>
                  ) : (
                    <AnimatePresence initial={false}>
                      {filteredFiles.map((file, i) => (
                        <FileRow
                          key={file.id}
                          file={file}
                          index={i}
                          isSelected={selected.has(file.id)}
                          isExpanded={expandedId === file.id}
                          prog={progress.get(file.id)}
                          phase={phase}
                          onToggleSelect={() => toggleFile(file.id)}
                          onToggleExpand={() => toggleExpand(file.id)}
                        />
                      ))}
                    </AnimatePresence>
                  )}
                </div>

                {/* ── Sticky footer ────────────────────────────────────── */}
                <div
                  className="shrink-0 px-6 py-4 flex items-center justify-between gap-3 flex-wrap border-t"
                  style={{
                    borderColor: 'rgba(255,255,255,0.07)',
                    background: 'rgba(10,10,22,0.85)',
                    backdropFilter: 'blur(16px)',
                  }}
                >
                  {/* Storage preview */}
                  <div className="text-xs" style={{ color: '#8B8BAD' }}>
                    {phase === 'idle' && storageSummary ? (
                      <>
                        <span style={{ color: '#E0E0F0', fontWeight: 600 }}>
                          {storageSummary}
                        </span>
                        {' '}will be reorganised
                      </>
                    ) : phase === 'approving' ? (
                      <span className="flex items-center gap-1.5" style={{ color: '#818CF8' }}>
                        <Loader2 size={12} className="animate-spin" />
                        Moving files…
                      </span>
                    ) : null}
                  </div>

                  {/* Action buttons */}
                  {phase === 'idle' && (
                    <div className="flex items-center gap-2 flex-wrap">
                      {/* Cancel */}
                      <motion.button
                        whileHover={{ scale: 1.03 }}
                        whileTap={{ scale: 0.97 }}
                        onClick={onClose}
                        className="btn-ghost text-xs py-2 px-4"
                      >
                        Cancel
                      </motion.button>

                      {/* Approve All */}
                      <motion.button
                        whileHover={{ scale: 1.03 }}
                        whileTap={{ scale: 0.97 }}
                        onClick={approveAll}
                        disabled={files.length === 0}
                        className="flex items-center gap-2 px-4 py-2 rounded-xl text-xs font-semibold
                                   transition-all duration-200"
                        style={{
                          background: 'rgba(52,211,153,.12)',
                          border: '1px solid rgba(52,211,153,.28)',
                          color: '#34D399',
                          opacity: files.length === 0 ? 0.45 : 1,
                        }}
                        onMouseEnter={(e) => {
                          (e.currentTarget as HTMLElement).style.boxShadow = '0 0 16px rgba(52,211,153,.3)';
                        }}
                        onMouseLeave={(e) => {
                          (e.currentTarget as HTMLElement).style.boxShadow = 'none';
                        }}
                      >
                        <CheckCircle2 size={14} />
                        Approve All ({files.length})
                      </motion.button>

                      {/* Approve Selected */}
                      <motion.button
                        whileHover={{ scale: 1.03 }}
                        whileTap={{ scale: 0.97 }}
                        onClick={approveSelected}
                        disabled={selectedCount === 0}
                        className="btn-gradient text-xs py-2 px-5"
                        style={{
                          opacity: selectedCount === 0 ? 0.45 : 1,
                          boxShadow: selectedCount > 0 ? '0 0 22px rgba(79,70,229,.45)' : 'none',
                        }}
                      >
                        <CheckCircle2 size={14} />
                        Approve Selected ({selectedCount})
                      </motion.button>
                    </div>
                  )}
                </div>
              </motion.div>
            )}
          </AnimatePresence>
        </motion.div>
      </motion.div>
    </AnimatePresence>
  );

  return createPortal(modal, document.body);
}
