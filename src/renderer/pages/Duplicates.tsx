import { useState, useEffect, useCallback } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
  Copy, Trash2, CheckCircle2, HardDrive, RefreshCw,
  ChevronDown, ChevronUp, Star, FolderOpen, AlertTriangle,
} from 'lucide-react';
import { formatDistanceToNow } from 'date-fns';

// ─── types ────────────────────────────────────────────────────────────────────

interface FileInfo {
  filepath: string;
  filename: string;
  size:     number;
  mtime:    string;
}

interface DuplicateGroup {
  id?:              string;
  type:             'exact' | 'near';
  hash:             string;
  files:            FileInfo[];
  recommendedKeep:  string;
  recoverableBytes: number;
}

// ─── helpers ──────────────────────────────────────────────────────────────────

function formatBytes(b: number): string {
  if (b >= 1_073_741_824) return `${(b / 1_073_741_824).toFixed(1)} GB`;
  if (b >= 1_048_576)     return `${(b / 1_048_576).toFixed(1)} MB`;
  if (b >= 1_024)         return `${(b / 1_024).toFixed(0)} KB`;
  return `${b} B`;
}

function basename(p: string) {
  return p.replace(/\\/g, '/').split('/').pop() ?? p;
}

function parentDir(p: string) {
  const parts = p.replace(/\\/g, '/').split('/');
  return parts.slice(0, -1).slice(-2).join('/');
}

// ─── motion variants ──────────────────────────────────────────────────────────

const fadeUp = {
  hidden:  { opacity: 0, y: 14 },
  visible: { opacity: 1, y: 0, transition: { duration: 0.35, ease: [0.22, 1, 0.36, 1] } },
  exit:    { opacity: 0, x: 40, height: 0, marginBottom: 0, transition: { duration: 0.25 } },
};

const stagger = {
  hidden:  {},
  visible: { transition: { staggerChildren: 0.06 } },
};

// ─── confirm dialog ───────────────────────────────────────────────────────────

function ConfirmDialog({
  count, onConfirm, onCancel,
}: { count: number; onConfirm: () => void; onCancel: () => void }) {
  return (
    <motion.div
      initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
      className="fixed inset-0 z-50 flex items-center justify-center"
      style={{ background: 'rgba(0,0,0,0.6)', backdropFilter: 'blur(8px)' }}
    >
      <motion.div
        initial={{ scale: 0.9, opacity: 0 }}
        animate={{ scale: 1, opacity: 1 }}
        exit={{ scale: 0.9, opacity: 0 }}
        className="glass-card p-6 max-w-sm w-full mx-4 text-center"
      >
        <div className="w-12 h-12 rounded-2xl mx-auto mb-4 flex items-center justify-center"
          style={{ background: 'rgba(239,68,68,0.12)', border: '1px solid rgba(239,68,68,0.25)' }}>
          <AlertTriangle size={22} style={{ color: '#FCA5A5' }} />
        </div>
        <h3 className="text-base font-bold text-white mb-2">Move to Recycle Bin?</h3>
        <p className="text-sm mb-5" style={{ color: '#8B8BAD' }}>
          This moves <strong className="text-white">{count} file{count !== 1 ? 's' : ''}</strong> to
          the Recycle Bin. You can restore them at any time.
        </p>
        <div className="flex gap-3">
          <button onClick={onCancel} className="btn-ghost flex-1 justify-center text-sm py-2">
            Cancel
          </button>
          <motion.button
            whileHover={{ scale: 1.03 }}
            whileTap={{ scale: 0.97 }}
            onClick={onConfirm}
            className="flex-1 py-2 rounded-xl text-sm font-semibold text-white flex items-center justify-center gap-2"
            style={{ background: 'linear-gradient(135deg, #DC2626, #B91C1C)', boxShadow: '0 0 16px rgba(239,68,68,.35)' }}
          >
            <Trash2 size={14} />
            Move to Bin
          </motion.button>
        </div>
      </motion.div>
    </motion.div>
  );
}

// ─── group card ───────────────────────────────────────────────────────────────

function GroupCard({
  group,
  onTrash,
  onKeepAll,
}: {
  group:     DuplicateGroup;
  onTrash:   (paths: string[], hash: string) => void;
  onKeepAll: (hash: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const toDelete = group.files.filter((f) => f.filepath !== group.recommendedKeep);

  return (
    <motion.div
      variants={fadeUp}
      layout
      className="glass-card overflow-hidden"
    >
      {/* Card header */}
      <div
        className="flex items-center gap-3 px-5 py-4 cursor-pointer select-none"
        onClick={() => setExpanded((v) => !v)}
      >
        <div className="w-9 h-9 rounded-xl flex items-center justify-center shrink-0"
          style={{
            background: group.type === 'exact' ? 'rgba(239,68,68,.12)' : 'rgba(245,158,11,.12)',
            border: `1px solid ${group.type === 'exact' ? 'rgba(239,68,68,.25)' : 'rgba(245,158,11,.25)'}`,
          }}>
          <Copy size={15} style={{ color: group.type === 'exact' ? '#FCA5A5' : '#FCD34D' }} />
        </div>

        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <p className="text-sm font-semibold text-white truncate">
              {basename(group.recommendedKeep)}
            </p>
            <span className="text-xs px-2 py-0.5 rounded-full shrink-0"
              style={{
                background: group.type === 'exact' ? 'rgba(239,68,68,.12)' : 'rgba(245,158,11,.12)',
                color: group.type === 'exact' ? '#FCA5A5' : '#FCD34D',
                border: `1px solid ${group.type === 'exact' ? 'rgba(239,68,68,.2)' : 'rgba(245,158,11,.2)'}`,
              }}>
              {group.type === 'exact' ? 'Exact' : 'Near'} · {group.files.length} files
            </span>
          </div>
          <p className="text-xs mt-0.5" style={{ color: '#555575' }}>
            {formatBytes(group.recoverableBytes)} recoverable
          </p>
        </div>

        <div className="flex items-center gap-2 shrink-0">
          <motion.button
            whileHover={{ scale: 1.05 }}
            whileTap={{ scale: 0.95 }}
            onClick={(e) => { e.stopPropagation(); onTrash(toDelete.map((f) => f.filepath), group.hash); }}
            className="text-xs px-3 py-1.5 rounded-lg flex items-center gap-1.5 font-semibold transition-all"
            style={{ background: 'rgba(239,68,68,.1)', color: '#FCA5A5', border: '1px solid rgba(239,68,68,.2)' }}
            onMouseEnter={(e) => (e.currentTarget.style.boxShadow = '0 0 12px rgba(239,68,68,.3)')}
            onMouseLeave={(e) => (e.currentTarget.style.boxShadow = 'none')}
          >
            <Trash2 size={12} />
            Keep Best
          </motion.button>
          <motion.button
            whileHover={{ scale: 1.05 }}
            whileTap={{ scale: 0.95 }}
            onClick={(e) => { e.stopPropagation(); onKeepAll(group.hash); }}
            className="text-xs px-3 py-1.5 rounded-lg flex items-center gap-1.5 transition-all"
            style={{ background: 'rgba(255,255,255,.04)', color: '#8B8BAD', border: '1px solid rgba(255,255,255,.08)' }}
          >
            Keep All
          </motion.button>
          {expanded ? <ChevronUp size={15} style={{ color: '#555575' }} /> : <ChevronDown size={15} style={{ color: '#555575' }} />}
        </div>
      </div>

      {/* Expanded file list */}
      <AnimatePresence initial={false}>
        {expanded && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.22 }}
            className="overflow-hidden"
          >
            <div className="border-t px-5 pb-4 pt-3 space-y-2"
              style={{ borderColor: 'rgba(255,255,255,0.05)' }}>
              {group.files.map((file) => {
                const isKeep = file.filepath === group.recommendedKeep;
                return (
                  <div
                    key={file.filepath}
                    className="flex items-center gap-3 p-3 rounded-xl"
                    style={{
                      background: isKeep ? 'rgba(16,185,129,.07)' : 'rgba(255,255,255,.02)',
                      border: `1px solid ${isKeep ? 'rgba(16,185,129,.2)' : 'rgba(255,255,255,.05)'}`,
                    }}
                  >
                    {isKeep ? (
                      <Star size={13} style={{ color: '#34D399', flexShrink: 0 }} />
                    ) : (
                      <Copy size={13} style={{ color: '#555575', flexShrink: 0 }} />
                    )}
                    <div className="flex-1 min-w-0">
                      <p className="text-xs font-medium truncate"
                        style={{ color: isKeep ? '#34D399' : '#C4C4E8' }}>
                        {basename(file.filepath)}
                      </p>
                      <p className="text-xs truncate mt-0.5" style={{ color: '#555575' }}>
                        {parentDir(file.filepath)}
                      </p>
                    </div>
                    <div className="text-right shrink-0">
                      <p className="text-xs font-medium" style={{ color: '#8B8BAD' }}>
                        {formatBytes(file.size)}
                      </p>
                      {file.mtime && (
                        <p className="text-xs mt-0.5" style={{ color: '#555575' }}>
                          {formatDistanceToNow(new Date(file.mtime), { addSuffix: true })}
                        </p>
                      )}
                    </div>
                    {isKeep && (
                      <span className="text-xs px-2 py-0.5 rounded-full shrink-0"
                        style={{ background: 'rgba(16,185,129,.15)', color: '#34D399', border: '1px solid rgba(16,185,129,.25)' }}>
                        Keep
                      </span>
                    )}
                  </div>
                );
              })}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  );
}

// ─── main page ────────────────────────────────────────────────────────────────

export default function Duplicates() {
  const [groups,    setGroups]    = useState<DuplicateGroup[]>([]);
  const [loading,   setLoading]   = useState(true);
  const [scanning,  setScanning]  = useState(false);
  const [confirm,   setConfirm]   = useState<{ paths: string[]; hash: string } | null>(null);

  const totalRecoverable = groups.reduce((s, g) => s + g.recoverableBytes, 0);

  const fetchGroups = useCallback(async () => {
    setLoading(true);
    try {
      const res  = await fetch('http://localhost:3001/api/duplicates');
      const data = await res.json();
      // Parse stored JSONB arrays back into FileInfo[]
      const parsed: DuplicateGroup[] = (data as any[]).map((row) => {
        const filepaths: string[] = typeof row.filenames === 'string'
          ? JSON.parse(row.filenames) : (row.filenames ?? []);
        const sizes: number[] = typeof row.sizes === 'string'
          ? JSON.parse(row.sizes) : (row.sizes ?? []);
        return {
          id:              row.id,
          type:            row.file_hash ? 'exact' : 'near',
          hash:            row.file_hash ?? '',
          files:           filepaths.map((fp, i) => ({
            filepath: fp,
            filename: fp.replace(/\\/g, '/').split('/').pop() ?? fp,
            size:     sizes[i] ?? 0,
            mtime:    '',
          })),
          recommendedKeep:  row.recommended_keep ?? filepaths[0] ?? '',
          recoverableBytes: sizes.reduce((s: number, n: number) => s + n, 0) - (sizes[0] ?? 0),
        };
      });
      setGroups(parsed);
    } catch (err) {
      console.error('[duplicates] fetch error:', err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchGroups(); }, [fetchGroups]);

  const handleScan = async () => {
    setScanning(true);
    try {
      // Get watched folders from Electron store, fall back to default
      const watchedFolders = await window.electronAPI?.watcher?.getFolders?.() ?? [];
      const res  = await fetch('http://localhost:3001/api/duplicates/scan', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ folders: watchedFolders }),
      });
      const data = await res.json();
      setGroups(data.groups ?? []);
    } catch (err) {
      console.error('[duplicates] scan error:', err);
    } finally {
      setScanning(false);
    }
  };

  const handleTrashConfirm = (paths: string[], hash: string) => {
    setConfirm({ paths, hash });
  };

  const executeTrash = async () => {
    if (!confirm) return;
    // Ask Electron main to trash each file
    for (const fp of confirm.paths) {
      await window.electronAPI?.invoke('shell:trashItem', fp);
    }
    // Mark resolved in DB
    await fetch('http://localhost:3001/api/duplicates/resolve', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ hash: confirm.hash }),
    });
    setGroups((prev) => prev.filter((g) => g.hash !== confirm.hash));
    setConfirm(null);
  };

  const handleKeepAll = async (hash: string) => {
    await fetch('http://localhost:3001/api/duplicates/resolve', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ hash }),
    });
    setGroups((prev) => prev.filter((g) => g.hash !== hash));
  };

  return (
    <motion.div
      className="space-y-5"
      variants={stagger}
      initial="hidden"
      animate="visible"
    >
      {/* Header */}
      <motion.div variants={fadeUp} className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold text-white">Duplicate Files</h1>
          <p className="text-sm mt-0.5" style={{ color: '#8B8BAD' }}>
            Find and remove exact and near-duplicate files from your watched folders
          </p>
        </div>
        <motion.button
          whileHover={{ scale: 1.03 }}
          whileTap={{ scale: 0.97 }}
          onClick={handleScan}
          disabled={scanning}
          className="btn-gradient text-sm"
        >
          <RefreshCw size={14} className={scanning ? 'animate-spin' : ''} />
          {scanning ? 'Scanning…' : 'Scan Now'}
        </motion.button>
      </motion.div>

      {/* Stats bar */}
      <AnimatePresence>
        {groups.length > 0 && (
          <motion.div
            variants={fadeUp}
            className="glass-card px-5 py-4 flex items-center gap-6 flex-wrap"
          >
            <div className="flex items-center gap-2">
              <div className="w-8 h-8 rounded-lg flex items-center justify-center"
                style={{ background: 'rgba(239,68,68,.12)', border: '1px solid rgba(239,68,68,.2)' }}>
                <Copy size={14} style={{ color: '#FCA5A5' }} />
              </div>
              <div>
                <p className="text-lg font-bold text-white">{groups.length}</p>
                <p className="text-xs" style={{ color: '#8B8BAD' }}>duplicate groups</p>
              </div>
            </div>
            <div className="flex items-center gap-2">
              <div className="w-8 h-8 rounded-lg flex items-center justify-center"
                style={{ background: 'rgba(16,185,129,.12)', border: '1px solid rgba(16,185,129,.2)' }}>
                <HardDrive size={14} style={{ color: '#34D399' }} />
              </div>
              <div>
                <p className="text-lg font-bold" style={{ color: '#34D399' }}>
                  {formatBytes(totalRecoverable)}
                </p>
                <p className="text-xs" style={{ color: '#8B8BAD' }}>recoverable</p>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Groups */}
      {loading ? (
        <div className="py-20 text-center text-sm" style={{ color: '#555575' }}>
          Loading duplicate groups…
        </div>
      ) : groups.length === 0 ? (
        <motion.div variants={fadeUp} className="glass-card py-20 text-center">
          <CheckCircle2 size={40} className="mx-auto mb-4 text-emerald-400"
            style={{ filter: 'drop-shadow(0 0 8px #34D399)' }} />
          <p className="text-base font-semibold text-white">No duplicates found</p>
          <p className="text-sm mt-1.5 mb-5" style={{ color: '#8B8BAD' }}>
            Your watched folders look clean. Run a scan to check.
          </p>
          <motion.button
            whileHover={{ scale: 1.04 }}
            whileTap={{ scale: 0.96 }}
            onClick={handleScan}
            disabled={scanning}
            className="btn-gradient"
          >
            <FolderOpen size={14} />
            {scanning ? 'Scanning…' : 'Scan Folders'}
          </motion.button>
        </motion.div>
      ) : (
        <motion.div variants={stagger} className="space-y-3">
          <AnimatePresence>
            {groups.map((g) => (
              <GroupCard
                key={g.hash || g.id || g.files[0]?.filepath}
                group={g}
                onTrash={handleTrashConfirm}
                onKeepAll={handleKeepAll}
              />
            ))}
          </AnimatePresence>
        </motion.div>
      )}

      {/* Confirm dialog */}
      <AnimatePresence>
        {confirm && (
          <ConfirmDialog
            count={confirm.paths.length}
            onConfirm={executeTrash}
            onCancel={() => setConfirm(null)}
          />
        )}
      </AnimatePresence>
    </motion.div>
  );
}
