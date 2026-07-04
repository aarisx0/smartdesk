import { useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
  RadialBarChart, RadialBar, PolarAngleAxis, ResponsiveContainer,
} from 'recharts';
import { formatDistanceToNow } from 'date-fns';
import {
  FolderOpen, FolderPlus, Copy, HardDrive,
  FileText, FileImage, FileVideo, FileAudio,
  FileCode, FileSpreadsheet, FileArchive, File,
  ArrowRight, CheckCircle2, XCircle, Bell,
  RefreshCw, Zap, ChevronRight,
} from 'lucide-react';
import {
  useDashboard, useAnimatedCounter,
  type OrganizedFile, type PendingFile,
} from '../hooks/useDashboard';
import ApprovalModal from '../components/ApprovalModal';

// ─── motion variants ──────────────────────────────────────────────────────────

const pageVariants = {
  hidden:  { opacity: 0, y: 16 },
  visible: { opacity: 1, y: 0, transition: { duration: 0.35, ease: [0.22, 1, 0.36, 1] } },
  exit:    { opacity: 0, y: -8, transition: { duration: 0.2 } },
};

const staggerContainer = {
  hidden:  {},
  visible: { transition: { staggerChildren: 0.07 } },
};

const fadeUp = {
  hidden:  { opacity: 0, y: 18 },
  visible: { opacity: 1, y: 0, transition: { duration: 0.4, ease: [0.22, 1, 0.36, 1] } },
};

const rowVariant = {
  hidden:  { opacity: 0, x: -12 },
  visible: { opacity: 1, x: 0,  transition: { duration: 0.3, ease: 'easeOut' } },
  exit:    { opacity: 0, x: 40, height: 0, marginBottom: 0,
             transition: { duration: 0.25, ease: 'easeIn' } },
};

// ─── helpers ──────────────────────────────────────────────────────────────────

function formatBytes(b: number): string {
  if (b >= 1073741824) return `${(b / 1073741824).toFixed(1)} GB`;
  if (b >= 1048576)    return `${(b / 1048576).toFixed(1)} MB`;
  if (b >= 1024)       return `${(b / 1024).toFixed(0)} KB`;
  return `${b} B`;
}

function getGreeting(): string {
  const h = new Date().getHours();
  if (h < 12) return 'Good morning';
  if (h < 17) return 'Good afternoon';
  return 'Good evening';
}

function timeAgo(iso: string): string {
  try {
    return formatDistanceToNow(new Date(iso), { addSuffix: true });
  } catch {
    return '—';
  }
}

// ─── file-type icon ───────────────────────────────────────────────────────────

const EXT_MAP: Record<string, { icon: React.ElementType; color: string }> = {
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

function FileIcon({ extension, size = 16 }: { extension: string; size?: number }) {
  const cfg = EXT_MAP[extension.toLowerCase()] ?? { icon: File, color: '#8B8BAD' };
  const Icon = cfg.icon;
  return <Icon size={size} style={{ color: cfg.color, flexShrink: 0 }} />;
}

// ─── confidence badge ─────────────────────────────────────────────────────────

function ConfidenceBadge({ score }: { score: number | null }) {
  if (score === null) return <span className="text-xs" style={{ color: '#555575' }}>—</span>;
  const pct = score <= 1 ? Math.round(score * 100) : Math.round(score);
  const [bg, color, border] =
    pct >= 80 ? ['rgba(16,185,129,.12)', '#34D399', 'rgba(16,185,129,.25)']
  : pct >= 50 ? ['rgba(245,158,11,.12)', '#FCD34D', 'rgba(245,158,11,.25)']
  :             ['rgba(239,68,68,.12)',  '#FCA5A5', 'rgba(239,68,68,.25)'];
  return (
    <span className="text-xs font-semibold px-2 py-0.5 rounded-full"
      style={{ background: bg, color, border: `1px solid ${border}` }}>
      {pct}%
    </span>
  );
}

// ─── stat card ────────────────────────────────────────────────────────────────

interface StatCardProps {
  label: string;
  rawValue: number;
  display?: (n: number) => string;
  icon: React.ElementType;
  color: string;
  index: number;
}

function StatCard({ label, rawValue, display, icon: Icon, color, index }: StatCardProps) {
  const animated = useAnimatedCounter(rawValue, 1400 + index * 100);
  const shown    = display ? display(animated) : animated.toLocaleString();

  return (
    <motion.div
      variants={fadeUp}
      whileHover={{ y: -3, transition: { duration: 0.18 } }}
      className="glass-card p-5 relative overflow-hidden"
    >
      {/* background radial glow */}
      <div className="absolute inset-0 pointer-events-none"
        style={{
          background: `radial-gradient(ellipse at 80% 20%, ${color}18 0%, transparent 65%)`,
        }}
      />
      <div className="flex items-start justify-between mb-4 relative">
        <div className="w-10 h-10 rounded-xl flex items-center justify-center"
          style={{ background: `${color}20`, border: `1px solid ${color}35` }}>
          <Icon size={18} style={{ color }} />
        </div>
      </div>
      <p className="text-3xl font-extrabold relative"
        style={{
          background: `linear-gradient(135deg, ${color}, ${color}aa)`,
          WebkitBackgroundClip: 'text',
          WebkitTextFillColor: 'transparent',
          backgroundClip: 'text',
          filter: `drop-shadow(0 0 8px ${color}55)`,
        }}>
        {shown}
      </p>
      <p className="text-xs mt-1.5 relative" style={{ color: '#8B8BAD' }}>{label}</p>
    </motion.div>
  );
}

// ─── desktop health radial chart ─────────────────────────────────────────────

function DesktopHealth({ score, total, organized }: { score: number; total: number; organized: number }) {
  const arcColor = score >= 80 ? '#34D399' : score >= 50 ? '#FBBF24' : '#F87171';
  const glowColor = score >= 80 ? '#34D39944' : score >= 50 ? '#FBBF2444' : '#F8717144';

  const data = [{ name: 'score', value: score, fill: arcColor }];

  return (
    <motion.div variants={fadeUp} className="glass-card p-6 flex flex-col">
      <div className="flex items-center gap-2 mb-4">
        <HardDrive size={16} className="text-indigo-400" />
        <h2 className="text-sm font-semibold text-white">Desktop Health</h2>
      </div>

      <div className="flex-1 flex items-center justify-center">
        <div className="relative w-48 h-48">
          <ResponsiveContainer width="100%" height="100%">
            <RadialBarChart
              cx="50%" cy="50%"
              innerRadius="68%" outerRadius="88%"
              startAngle={225} endAngle={-45}
              data={data}
              barSize={14}
            >
              <PolarAngleAxis
                type="number" domain={[0, 100]}
                angleAxisId={0} tick={false}
              />
              <RadialBar
                background={{ fill: 'rgba(255,255,255,0.04)' }}
                dataKey="value"
                angleAxisId={0}
                cornerRadius={7}
                style={{ filter: `drop-shadow(0 0 6px ${glowColor})` }}
              />
            </RadialBarChart>
          </ResponsiveContainer>
          {/* Centre label */}
          <div className="absolute inset-0 flex flex-col items-center justify-center pointer-events-none">
            <span className="text-4xl font-extrabold"
              style={{ color: arcColor, filter: `drop-shadow(0 0 10px ${arcColor})` }}>
              {score}%
            </span>
            <span className="text-xs mt-0.5" style={{ color: '#8B8BAD' }}>organized</span>
          </div>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3 mt-4">
        {[
          { label: 'Total Files',   value: total.toLocaleString()     },
          { label: 'Organized',     value: organized.toLocaleString() },
        ].map(({ label, value }) => (
          <div key={label} className="rounded-xl p-3 text-center"
            style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.06)' }}>
            <p className="text-lg font-bold text-white">{value}</p>
            <p className="text-xs mt-0.5" style={{ color: '#8B8BAD' }}>{label}</p>
          </div>
        ))}
      </div>
    </motion.div>
  );
}

// ─── recently organized table ─────────────────────────────────────────────────

function truncatePath(p: string, maxLen = 34): string {
  if (!p || p.length <= maxLen) return p;
  const parts = p.replace(/\\/g, '/').split('/');
  const file  = parts.pop() ?? '';
  const dir   = parts.slice(-2).join('/');
  return `…/${dir}/${file}`.slice(0, maxLen + 5);
}

function RecentlyOrganized({ files }: { files: OrganizedFile[] }) {
  return (
    <motion.div variants={fadeUp} className="glass-card overflow-hidden">
      <div className="flex items-center justify-between px-5 py-4 border-b"
        style={{ borderColor: 'rgba(255,255,255,0.05)' }}>
        <div className="flex items-center gap-2">
          <Zap size={15} className="text-indigo-400" />
          <h2 className="text-sm font-semibold text-white">Recently Organised</h2>
        </div>
        <span className="text-xs" style={{ color: '#555575' }}>{files.length} files</span>
      </div>

      {/* Table header */}
      <div className="grid grid-cols-12 px-5 py-2.5 text-xs font-semibold uppercase tracking-wider border-b"
        style={{ color: '#555575', borderColor: 'rgba(255,255,255,0.04)' }}>
        <span className="col-span-4">File</span>
        <span className="col-span-4">Path change</span>
        <span className="col-span-2 text-center">Confidence</span>
        <span className="col-span-2 text-right">When</span>
      </div>

      {files.length === 0 ? (
        <div className="py-12 text-center text-sm" style={{ color: '#555575' }}>
          No files organised yet — add a folder to watch.
        </div>
      ) : (
        <div className="divide-y divide-white/5 overflow-y-auto max-h-64">
          <AnimatePresence initial={false}>
            {files.map((f, i) => (
              <motion.div
                key={f.id}
                variants={rowVariant}
                initial="hidden"
                animate="visible"
                exit="exit"
                custom={i}
                className="grid grid-cols-12 px-5 py-3 items-center
                           hover:bg-white/[0.02] transition-colors"
              >
                {/* File */}
                <div className="col-span-4 flex items-center gap-2.5 min-w-0">
                  <FileIcon extension={f.extension} />
                  <span className="text-xs font-medium text-white truncate"
                    title={f.filename}>
                    {f.filename}
                  </span>
                </div>
                {/* Path change */}
                <div className="col-span-4 flex items-center gap-1.5 min-w-0 pr-2">
                  <span className="text-xs truncate line-through"
                    style={{ color: '#555575' }} title={f.filepath}>
                    {truncatePath(f.filepath)}
                  </span>
                  <ArrowRight size={11} className="shrink-0" style={{ color: '#4F46E5' }} />
                  <span className="text-xs truncate font-medium"
                    style={{ color: '#818CF8' }} title={f.suggested_folder}>
                    {f.suggested_folder ?? '—'}
                  </span>
                </div>
                {/* Confidence */}
                <div className="col-span-2 flex justify-center">
                  <ConfidenceBadge score={f.confidence_score} />
                </div>
                {/* When */}
                <div className="col-span-2 text-right text-xs" style={{ color: '#555575' }}>
                  {timeAgo(f.updated_at)}
                </div>
              </motion.div>
            ))}
          </AnimatePresence>
        </div>
      )}
    </motion.div>
  );
}

// ─── pending approvals panel ──────────────────────────────────────────────────

function PendingApprovals({
  files, onApprove, onSkip,
}: {
  files: PendingFile[];
  onApprove: (id: string) => void;
  onSkip:    (id: string) => void;
}) {
  return (
    <motion.div variants={fadeUp} className="glass-card overflow-hidden flex flex-col">
      <div className="flex items-center justify-between px-5 py-4 border-b shrink-0"
        style={{ borderColor: 'rgba(255,255,255,0.05)' }}>
        <div className="flex items-center gap-2">
          <Bell size={15} className="text-violet-400" />
          <h2 className="text-sm font-semibold text-white">Pending Approvals</h2>
        </div>
        {files.length > 0 && (
          <span className="text-xs font-semibold px-2 py-0.5 rounded-full"
            style={{
              background: 'rgba(245,158,11,.15)',
              color: '#FCD34D',
              border: '1px solid rgba(245,158,11,.25)',
            }}>
            {files.length}
          </span>
        )}
      </div>

      <div className="flex-1 overflow-y-auto max-h-72">
        {files.length === 0 ? (
          <div className="py-14 text-center">
            <CheckCircle2 size={32} className="mx-auto mb-3 text-emerald-400"
              style={{ filter: 'drop-shadow(0 0 6px #34D399)' }} />
            <p className="text-sm font-medium text-white">All caught up!</p>
            <p className="text-xs mt-1" style={{ color: '#8B8BAD' }}>
              No files waiting for approval.
            </p>
          </div>
        ) : (
          <div className="divide-y divide-white/5">
            <AnimatePresence initial={false}>
              {files.map((f) => (
                <motion.div
                  key={f.id}
                  variants={rowVariant}
                  initial="hidden"
                  animate="visible"
                  exit="exit"
                  layout
                  className="px-5 py-3.5"
                >
                  <div className="flex items-start gap-3">
                    <FileIcon extension={f.extension} size={15} />
                    <div className="flex-1 min-w-0">
                      <p className="text-xs font-semibold text-white truncate">{f.filename}</p>
                      {f.suggested_folder && (
                        <div className="flex items-center gap-1 mt-0.5">
                          <ChevronRight size={11} style={{ color: '#4F46E5' }} />
                          <span className="text-xs truncate" style={{ color: '#818CF8' }}>
                            {f.suggested_folder}
                          </span>
                          {f.confidence_score !== null && (
                            <span className="ml-1">
                              <ConfidenceBadge score={f.confidence_score} />
                            </span>
                          )}
                        </div>
                      )}
                      {f.ai_reasoning && (
                        <p className="text-xs mt-0.5 truncate" style={{ color: '#555575' }}>
                          {f.ai_reasoning}
                        </p>
                      )}
                    </div>
                    {/* Actions */}
                    <div className="flex items-center gap-1.5 shrink-0">
                      <motion.button
                        whileHover={{ scale: 1.08 }}
                        whileTap={{ scale: 0.93 }}
                        onClick={() => onApprove(f.id)}
                        className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-xs font-semibold
                                   transition-all duration-150"
                        style={{
                          background: 'rgba(16,185,129,.12)',
                          border: '1px solid rgba(16,185,129,.25)',
                          color: '#34D399',
                        }}
                        onMouseEnter={(e) => {
                          (e.currentTarget as HTMLElement).style.boxShadow = '0 0 12px rgba(52,211,153,.35)';
                        }}
                        onMouseLeave={(e) => {
                          (e.currentTarget as HTMLElement).style.boxShadow = 'none';
                        }}
                      >
                        <CheckCircle2 size={12} />
                        Move
                      </motion.button>
                      <motion.button
                        whileHover={{ scale: 1.08 }}
                        whileTap={{ scale: 0.93 }}
                        onClick={() => onSkip(f.id)}
                        className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-xs font-semibold
                                   transition-all duration-150"
                        style={{
                          background: 'rgba(239,68,68,.1)',
                          border: '1px solid rgba(239,68,68,.22)',
                          color: '#FCA5A5',
                        }}
                        onMouseEnter={(e) => {
                          (e.currentTarget as HTMLElement).style.boxShadow = '0 0 12px rgba(252,165,165,.3)';
                        }}
                        onMouseLeave={(e) => {
                          (e.currentTarget as HTMLElement).style.boxShadow = 'none';
                        }}
                      >
                        <XCircle size={12} />
                        Skip
                      </motion.button>
                    </div>
                  </div>
                </motion.div>
              ))}
            </AnimatePresence>
          </div>
        )}
      </div>
    </motion.div>
  );
}

// ─── watched folder pill ──────────────────────────────────────────────────────

function FolderPill({ folder }: { folder: string }) {
  const name = folder.replace(/\\/g, '/').split('/').pop() ?? folder;
  return (
    <span className="flex items-center gap-1.5 text-xs font-medium px-2.5 py-1 rounded-full"
      style={{
        background: 'rgba(79,70,229,.12)',
        border: '1px solid rgba(79,70,229,.25)',
        color: '#818CF8',
      }}>
      <FolderOpen size={11} />
      {name}
    </span>
  );
}

// ─── main Dashboard component ─────────────────────────────────────────────────

const STAT_CARDS = [
  {
    key: 'filesOrganized' as const,
    label: 'Files Organised Today',
    icon: FolderOpen,
    color: '#818CF8',
  },
  {
    key: 'foldersCreated' as const,
    label: 'Folders Created',
    icon: FolderPlus,
    color: '#34D399',
  },
  {
    key: 'duplicatesRemoved' as const,
    label: 'Duplicates Removed',
    icon: Copy,
    color: '#F472B6',
  },
  {
    key: 'storageSavedBytes' as const,
    label: 'Storage Saved',
    icon: HardDrive,
    color: '#FBBF24',
    display: (n: number) => formatBytes(n),
  },
];

export default function Dashboard() {
  const {
    stats, organized, pending, health, watchedFolders,
    loading, error, approveFile, skipFile, refresh,
  } = useDashboard();

  const [refreshing,   setRefreshing]   = useState(false);
  const [modalOpen,    setModalOpen]    = useState(false);

  const handleRefresh = async () => {
    setRefreshing(true);
    await refresh();
    setTimeout(() => setRefreshing(false), 600);
  };

  // ── notification badge (pending count) ─────────────────────────────────────
  const pendingCount = pending.length;

  return (
    <motion.div
      className="space-y-5 h-full"
      variants={pageVariants}
      initial="hidden"
      animate="visible"
      exit="exit"
    >
      {/* ── Top bar ─────────────────────────────────────────────────────────── */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-xl font-bold text-white">
            {getGreeting()} 👋
          </h1>
          <p className="text-xs mt-0.5" style={{ color: '#8B8BAD' }}>
            Here's what SmartDesk AI has been up to.
          </p>
        </div>

        <div className="flex items-center gap-3 flex-wrap">
          {/* Watched folder pills */}
          {watchedFolders.slice(0, 4).map((f) => (
            <FolderPill key={f} folder={f} />
          ))}
          {watchedFolders.length > 4 && (
            <span className="text-xs" style={{ color: '#555575' }}>
              +{watchedFolders.length - 4} more
            </span>
          )}

          {/* Notification bell — opens the Approval Modal */}
          <motion.button
            whileHover={{ scale: 1.08 }}
            whileTap={{ scale: 0.93 }}
            onClick={() => pendingCount > 0 && setModalOpen(true)}
            className="relative w-9 h-9 rounded-xl flex items-center justify-center transition-all"
            style={{
              background: 'rgba(255,255,255,0.04)',
              border: '1px solid rgba(255,255,255,0.07)',
              color: '#8B8BAD',
              cursor: pendingCount > 0 ? 'pointer' : 'default',
            }}
          >
            <Bell size={16} />
            {pendingCount > 0 && (
              <span className="absolute -top-1 -right-1 w-4 h-4 rounded-full text-[10px]
                               font-bold flex items-center justify-center text-white"
                style={{
                  background: 'linear-gradient(135deg, #4F46E5, #7C3AED)',
                  boxShadow: '0 0 8px rgba(79,70,229,.6)',
                }}>
                {pendingCount > 9 ? '9+' : pendingCount}
              </span>
            )}
          </motion.button>

          {/* Refresh */}
          <motion.button
            whileHover={{ scale: 1.05 }}
            whileTap={{ scale: 0.95 }}
            onClick={handleRefresh}
            className="btn-ghost text-xs"
          >
            <RefreshCw size={13} className={refreshing ? 'animate-spin' : ''} />
            Refresh
          </motion.button>
        </div>
      </div>

      {/* ── Error banner ────────────────────────────────────────────────────── */}
      <AnimatePresence>
        {error && (
          <motion.div
            initial={{ opacity: 0, y: -8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}
            className="rounded-xl px-4 py-3 text-sm flex items-center gap-2"
            style={{ background: 'rgba(239,68,68,.1)', border: '1px solid rgba(239,68,68,.2)', color: '#FCA5A5' }}
          >
            <XCircle size={15} />
            {error}
          </motion.div>
        )}
      </AnimatePresence>

      {/* ── Stats row ────────────────────────────────────────────────────────── */}
      <motion.div
        variants={staggerContainer}
        initial="hidden"
        animate={loading ? 'hidden' : 'visible'}
        className="grid grid-cols-2 xl:grid-cols-4 gap-4"
      >
        {STAT_CARDS.map((card, i) => (
          <StatCard
            key={card.key}
            label={card.label}
            rawValue={stats[card.key]}
            display={card.display}
            icon={card.icon}
            color={card.color}
            index={i}
          />
        ))}
      </motion.div>

      {/* ── Main content grid ────────────────────────────────────────────────── */}
      <motion.div
        variants={staggerContainer}
        initial="hidden"
        animate={loading ? 'hidden' : 'visible'}
        className="grid grid-cols-12 gap-4"
      >
        {/* Desktop Health — col 3 */}
        <div className="col-span-12 lg:col-span-3">
          <DesktopHealth
            score={health.score}
            total={health.total}
            organized={health.organized}
          />
        </div>

        {/* Pending Approvals — col 4 */}
        <div className="col-span-12 lg:col-span-4">
          <PendingApprovals
            files={pending}
            onApprove={approveFile}
            onSkip={skipFile}
          />
        </div>

        {/* Watcher status mini card — col 2 */}
        <div className="col-span-12 lg:col-span-2">
          <motion.div variants={fadeUp} className="glass-card p-5 h-full flex flex-col gap-4">
            <p className="text-xs font-semibold text-white">Watcher Status</p>
            <div className="flex flex-col gap-2 flex-1">
              {[
                { label: 'Engine',  value: 'Active',       dot: '#34D399' },
                { label: 'Agent',   value: 'Connected',    dot: '#818CF8' },
                { label: 'DB',      value: 'Live',         dot: '#34D399' },
                { label: 'Realtime', value: 'Subscribed',  dot: '#FBBF24' },
              ].map(({ label, value, dot }) => (
                <div key={label} className="flex items-center justify-between text-xs">
                  <span style={{ color: '#8B8BAD' }}>{label}</span>
                  <span className="flex items-center gap-1.5 font-medium" style={{ color: '#E0E0F0' }}>
                    <span className="w-1.5 h-1.5 rounded-full"
                      style={{ background: dot, boxShadow: `0 0 4px ${dot}` }} />
                    {value}
                  </span>
                </div>
              ))}
            </div>
            <div className="mt-auto pt-3 border-t" style={{ borderColor: 'rgba(255,255,255,0.06)' }}>
              <p className="text-xs" style={{ color: '#555575' }}>
                Watching <span className="text-white font-semibold">{watchedFolders.length}</span> folder{watchedFolders.length !== 1 ? 's' : ''}
              </p>
            </div>
          </motion.div>
        </div>

        {/* Quick tip — col 3 */}
        <div className="col-span-12 lg:col-span-3">
          <motion.div
            variants={fadeUp}
            className="glass-card p-5 h-full relative overflow-hidden flex flex-col"
          >
            <div className="absolute inset-0 pointer-events-none"
              style={{ background: 'radial-gradient(ellipse at 0% 100%, rgba(124,58,237,.12) 0%, transparent 60%)' }} />
            <div className="flex items-center gap-2 mb-3 relative">
              <Zap size={14} className="text-violet-400" />
              <p className="text-xs font-semibold text-white">AI Tip</p>
            </div>
            <p className="text-xs relative" style={{ color: '#8B8BAD', lineHeight: 1.7 }}>
              SmartDesk learns from your approvals.
              Files you move to the same folder 3 times
              become <span style={{ color: '#A78BFA', fontWeight: 600 }}>learned rules</span> and
              are organised automatically.
            </p>
          </motion.div>
        </div>
      </motion.div>

      {/* ── Recently Organised table ─────────────────────────────────────────── */}
      <motion.div
        initial="hidden"
        animate={loading ? 'hidden' : 'visible'}
        variants={fadeUp}
      >
        <RecentlyOrganized files={organized} />
      </motion.div>

      {/* ── Loading skeleton overlay ─────────────────────────────────────────── */}
      <AnimatePresence>
        {loading && (
          <motion.div
            initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            className="fixed inset-0 flex items-center justify-center"
            style={{ background: 'rgba(15,15,26,0.6)', backdropFilter: 'blur(4px)', zIndex: 50 }}
          >
            <div className="flex flex-col items-center gap-3">
              <div className="w-10 h-10 rounded-xl flex items-center justify-center"
                style={{ background: 'linear-gradient(135deg,#4F46E5,#7C3AED)',
                         boxShadow: '0 0 24px rgba(79,70,229,.5)' }}>
                <Zap size={20} className="text-white animate-pulse" />
              </div>
              <p className="text-sm font-medium" style={{ color: '#8B8BAD' }}>
                Loading dashboard…
              </p>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* ── Approval Modal (portal, renders over everything) ─────────────────── */}
      <AnimatePresence>
        {modalOpen && (
          <ApprovalModal
            files={pending}
            onClose={() => setModalOpen(false)}
            onApproved={() => { refresh(); setModalOpen(false); }}
          />
        )}
      </AnimatePresence>
    </motion.div>
  );
}
