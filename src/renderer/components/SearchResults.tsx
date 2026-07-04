import { useMemo } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { formatDistanceToNow } from 'date-fns';
import {
  FolderOpen, ExternalLink, Search, Clock, FileText,
  FileImage, FileVideo, FileAudio, FileCode,
  FileSpreadsheet, FileArchive, File, Database, HardDrive,
} from 'lucide-react';

// ─── types ─────────────────────────────────────────────────────────────────────

export interface SearchResultItem {
  id:          string | null;
  filename:    string;
  extension:   string;
  filepath:    string;
  size_bytes:  number | null;
  updated_at:  string;
  status:      string;
  mime_type:   string | null;
  match_score: number;
  _source:     'db' | 'fs';
}

export interface SearchMeta {
  query:      string;
  keywords:   string[];
  extHint:    string[] | null;
  durationMs: number;
  totalFound: number;
}

export interface SearchResultsProps {
  results:  SearchResultItem[];
  meta:     SearchMeta | null;
  loading?: boolean;
  query?:   string;
}

// ─── motion variants ───────────────────────────────────────────────────────────

const listVariants = {
  hidden:  {},
  visible: { transition: { staggerChildren: 0.055 } },
};

const cardVariants = {
  hidden:  { opacity: 0, y: 16, scale: 0.97 },
  visible: {
    opacity: 1, y: 0, scale: 1,
    transition: { duration: 0.32, ease: [0.22, 1, 0.36, 1] },
  },
  exit: {
    opacity: 0, x: 20, scale: 0.96,
    transition: { duration: 0.18 },
  },
};

const emptyVariants = {
  hidden:  { opacity: 0, scale: 0.93 },
  visible: { opacity: 1, scale: 1, transition: { duration: 0.4, ease: [0.22, 1, 0.36, 1] } },
};

// ─── helpers ───────────────────────────────────────────────────────────────────

function formatBytes(b: number | null): string {
  if (!b || b === 0) return '—';
  if (b >= 1_073_741_824) return `${(b / 1_073_741_824).toFixed(1)} GB`;
  if (b >= 1_048_576)     return `${(b / 1_048_576).toFixed(1)} MB`;
  if (b >= 1_024)         return `${(b / 1_024).toFixed(0)} KB`;
  return `${b} B`;
}

function timeAgo(iso: string): string {
  try { return formatDistanceToNow(new Date(iso), { addSuffix: true }); }
  catch { return '—'; }
}

function formatMs(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

/** Truncate a path to the last N segments for display. */
function shortenPath(p: string, segments = 4): string {
  if (!p) return '';
  const parts = p.replace(/\\/g, '/').split('/');
  if (parts.length <= segments) return p;
  return '…/' + parts.slice(-segments).join('/');
}

// ─── file-type icon config ─────────────────────────────────────────────────────

const EXT_CFG: Record<string, { icon: React.ElementType; color: string; bg: string }> = {
  '.pdf':  { icon: FileText,        color: '#F87171', bg: 'rgba(248,113,113,.14)' },
  '.doc':  { icon: FileText,        color: '#60A5FA', bg: 'rgba(96,165,250,.14)'  },
  '.docx': { icon: FileText,        color: '#60A5FA', bg: 'rgba(96,165,250,.14)'  },
  '.txt':  { icon: FileText,        color: '#94A3B8', bg: 'rgba(148,163,184,.12)' },
  '.md':   { icon: FileText,        color: '#94A3B8', bg: 'rgba(148,163,184,.12)' },
  '.jpg':  { icon: FileImage,       color: '#F472B6', bg: 'rgba(244,114,182,.14)' },
  '.jpeg': { icon: FileImage,       color: '#F472B6', bg: 'rgba(244,114,182,.14)' },
  '.png':  { icon: FileImage,       color: '#F472B6', bg: 'rgba(244,114,182,.14)' },
  '.gif':  { icon: FileImage,       color: '#F472B6', bg: 'rgba(244,114,182,.14)' },
  '.webp': { icon: FileImage,       color: '#F472B6', bg: 'rgba(244,114,182,.14)' },
  '.svg':  { icon: FileImage,       color: '#A78BFA', bg: 'rgba(167,139,250,.14)' },
  '.mp4':  { icon: FileVideo,       color: '#FB923C', bg: 'rgba(251,146,60,.14)'  },
  '.mov':  { icon: FileVideo,       color: '#FB923C', bg: 'rgba(251,146,60,.14)'  },
  '.mkv':  { icon: FileVideo,       color: '#FB923C', bg: 'rgba(251,146,60,.14)'  },
  '.mp3':  { icon: FileAudio,       color: '#34D399', bg: 'rgba(52,211,153,.13)'  },
  '.wav':  { icon: FileAudio,       color: '#34D399', bg: 'rgba(52,211,153,.13)'  },
  '.flac': { icon: FileAudio,       color: '#34D399', bg: 'rgba(52,211,153,.13)'  },
  '.js':   { icon: FileCode,        color: '#FBBF24', bg: 'rgba(251,191,36,.13)'  },
  '.ts':   { icon: FileCode,        color: '#60A5FA', bg: 'rgba(96,165,250,.14)'  },
  '.py':   { icon: FileCode,        color: '#34D399', bg: 'rgba(52,211,153,.13)'  },
  '.xlsx': { icon: FileSpreadsheet, color: '#4ADE80', bg: 'rgba(74,222,128,.13)'  },
  '.csv':  { icon: FileSpreadsheet, color: '#4ADE80', bg: 'rgba(74,222,128,.13)'  },
  '.zip':  { icon: FileArchive,     color: '#C084FC', bg: 'rgba(192,132,252,.14)' },
  '.rar':  { icon: FileArchive,     color: '#C084FC', bg: 'rgba(192,132,252,.14)' },
  '.7z':   { icon: FileArchive,     color: '#C084FC', bg: 'rgba(192,132,252,.14)' },
};

function getExtCfg(ext: string) {
  return EXT_CFG[ext?.toLowerCase()] ?? { icon: File, color: '#8B8BAD', bg: 'rgba(139,139,173,.12)' };
}

// ─── keyword highlight ─────────────────────────────────────────────────────────

/**
 * Split `text` into plain/highlighted spans based on `keywords`.
 * Matching is case-insensitive.
 */
function HighlightedText({
  text,
  keywords,
}: {
  text: string;
  keywords: string[];
}) {
  const parts = useMemo(() => {
    if (!keywords.length) return [{ t: text, hi: false }];

    // Build one regex from all keywords
    const escaped = keywords.map((k) => k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
    const re = new RegExp(`(${escaped})`, 'gi');

    const segments: { t: string; hi: boolean }[] = [];
    let last = 0;
    let match: RegExpExecArray | null;

    while ((match = re.exec(text)) !== null) {
      if (match.index > last) segments.push({ t: text.slice(last, match.index), hi: false });
      segments.push({ t: match[0], hi: true });
      last = match.index + match[0].length;
    }
    if (last < text.length) segments.push({ t: text.slice(last), hi: false });
    return segments;
  }, [text, keywords]);

  return (
    <>
      {parts.map((p, i) =>
        p.hi
          ? <mark key={i} style={{
              background: 'rgba(129,140,248,.28)',
              color: '#C7D2FE',
              borderRadius: 3,
              padding: '0 2px',
              fontWeight: 700,
            }}>{p.t}</mark>
          : <span key={i}>{p.t}</span>
      )}
    </>
  );
}

// ─── score badge ───────────────────────────────────────────────────────────────

function ScoreBadge({ score }: { score: number }) {
  const [bg, color, border] =
    score >= 75 ? ['rgba(52,211,153,.13)', '#34D399', 'rgba(52,211,153,.28)']
  : score >= 45 ? ['rgba(251,191,36,.12)', '#FCD34D', 'rgba(251,191,36,.26)']
  :               ['rgba(139,139,173,.1)', '#8B8BAD', 'rgba(139,139,173,.22)'];

  return (
    <span className="text-[10px] font-bold px-1.5 py-0.5 rounded-full"
      style={{ background: bg, color, border: `1px solid ${border}` }}>
      {score}%
    </span>
  );
}

// ─── source badge ──────────────────────────────────────────────────────────────

function SourceBadge({ source }: { source: 'db' | 'fs' }) {
  return (
    <span className="flex items-center gap-1 text-[10px] font-medium px-1.5 py-0.5 rounded-full"
      style={{
        background: source === 'db'
          ? 'rgba(79,70,229,.12)' : 'rgba(16,185,129,.1)',
        color: source === 'db' ? '#818CF8' : '#34D399',
        border: `1px solid ${source === 'db' ? 'rgba(79,70,229,.25)' : 'rgba(16,185,129,.22)'}`,
      }}>
      {source === 'db' ? <Database size={9} /> : <HardDrive size={9} />}
      {source === 'db' ? 'DB' : 'Live'}
    </span>
  );
}

// ─── single result card ────────────────────────────────────────────────────────

function ResultCard({
  result,
  keywords,
}: {
  result: SearchResultItem;
  keywords: string[];
}) {
  const cfg  = getExtCfg(result.extension);
  const Icon = cfg.icon;

  const openFile = () => window.electronAPI?.openPath(result.filepath);
  const openLocation = () => {
    // Electron's shell.showItemInFolder is not exposed via contextBridge yet —
    // fall back to opening the parent directory.
    const dir = result.filepath.replace(/[\\/][^\\/]+$/, '');
    window.electronAPI?.openPath(dir);
  };

  return (
    <motion.div
      variants={cardVariants}
      layout
      whileHover={{ y: -2, transition: { duration: 0.18 } }}
      className="glass-card p-4 relative overflow-hidden group"
    >
      {/* Radial glow behind icon */}
      <div className="absolute inset-0 pointer-events-none opacity-0 group-hover:opacity-100
                      transition-opacity duration-300"
        style={{
          background: `radial-gradient(ellipse at 0% 50%, ${cfg.color}12 0%, transparent 60%)`,
        }}
      />

      <div className="flex items-start gap-4 relative">
        {/* File type icon */}
        <div className="w-11 h-11 rounded-xl flex items-center justify-center shrink-0"
          style={{ background: cfg.bg, border: `1px solid ${cfg.color}30` }}>
          <Icon size={20} style={{ color: cfg.color }} />
        </div>

        {/* Main content */}
        <div className="flex-1 min-w-0">
          {/* Filename row */}
          <div className="flex items-center gap-2 flex-wrap">
            <p className="text-sm font-semibold text-white truncate max-w-[300px]"
              title={result.filename}>
              <HighlightedText text={result.filename} keywords={keywords} />
            </p>
            <div className="flex items-center gap-1.5 shrink-0">
              <ScoreBadge score={result.match_score} />
              <SourceBadge source={result._source} />
            </div>
          </div>

          {/* Path */}
          <p className="text-xs mt-0.5 truncate" style={{ color: '#555575' }}
            title={result.filepath}>
            <HighlightedText text={shortenPath(result.filepath)} keywords={keywords} />
          </p>

          {/* Meta row */}
          <div className="flex items-center gap-3 mt-2 flex-wrap">
            <span className="flex items-center gap-1 text-xs" style={{ color: '#8B8BAD' }}>
              <HardDrive size={11} />
              {formatBytes(result.size_bytes)}
            </span>
            <span className="flex items-center gap-1 text-xs" style={{ color: '#8B8BAD' }}>
              <Clock size={11} />
              {timeAgo(result.updated_at)}
            </span>
            {result.extension && (
              <span className="text-xs px-1.5 py-0.5 rounded-md font-mono"
                style={{
                  background: `${cfg.color}15`,
                  color: cfg.color,
                  border: `1px solid ${cfg.color}28`,
                }}>
                {result.extension}
              </span>
            )}
          </div>
        </div>

        {/* Action buttons */}
        <div className="flex flex-col gap-1.5 shrink-0 ml-1">
          <motion.button
            whileHover={{ scale: 1.06 }}
            whileTap={{ scale: 0.93 }}
            onClick={openLocation}
            title="Show in Explorer"
            className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-xl text-xs font-medium
                       transition-all duration-150"
            style={{
              background: 'rgba(255,255,255,0.05)',
              border: '1px solid rgba(255,255,255,0.09)',
              color: '#8B8BAD',
            }}
            onMouseEnter={(e) => {
              (e.currentTarget as HTMLElement).style.color = '#E0E0FF';
              (e.currentTarget as HTMLElement).style.borderColor = 'rgba(79,70,229,.35)';
              (e.currentTarget as HTMLElement).style.background = 'rgba(79,70,229,.1)';
            }}
            onMouseLeave={(e) => {
              (e.currentTarget as HTMLElement).style.color = '#8B8BAD';
              (e.currentTarget as HTMLElement).style.borderColor = 'rgba(255,255,255,0.09)';
              (e.currentTarget as HTMLElement).style.background = 'rgba(255,255,255,0.05)';
            }}
          >
            <FolderOpen size={12} />
            Location
          </motion.button>

          <motion.button
            whileHover={{ scale: 1.06 }}
            whileTap={{ scale: 0.93 }}
            onClick={openFile}
            title="Open File"
            className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-xl text-xs font-semibold
                       transition-all duration-150"
            style={{
              background: 'linear-gradient(135deg,#4F46E5,#7C3AED)',
              color: '#fff',
              boxShadow: '0 0 10px rgba(79,70,229,.3)',
            }}
            onMouseEnter={(e) => {
              (e.currentTarget as HTMLElement).style.boxShadow = '0 0 18px rgba(79,70,229,.55)';
            }}
            onMouseLeave={(e) => {
              (e.currentTarget as HTMLElement).style.boxShadow = '0 0 10px rgba(79,70,229,.3)';
            }}
          >
            <ExternalLink size={12} />
            Open
          </motion.button>
        </div>
      </div>
    </motion.div>
  );
}

// ─── search stats bar ──────────────────────────────────────────────────────────

function StatsBar({ meta, loading }: { meta: SearchMeta | null; loading?: boolean }) {
  if (loading) {
    return (
      <div className="flex items-center gap-2 mb-4 text-xs" style={{ color: '#8B8BAD' }}>
        <motion.div
          animate={{ rotate: 360 }}
          transition={{ repeat: Infinity, duration: 1, ease: 'linear' }}
        >
          <Search size={13} />
        </motion.div>
        Searching…
      </div>
    );
  }

  if (!meta) return null;

  return (
    <motion.div
      initial={{ opacity: 0, y: -6 }}
      animate={{ opacity: 1, y: 0 }}
      className="flex items-center gap-3 mb-4 flex-wrap"
    >
      {/* Result count */}
      <span className="flex items-center gap-1.5 text-xs font-semibold"
        style={{
          background: 'linear-gradient(135deg,#818CF8,#A78BFA)',
          WebkitBackgroundClip: 'text',
          WebkitTextFillColor: 'transparent',
          backgroundClip: 'text',
          filter: 'drop-shadow(0 0 4px rgba(129,140,248,.4))',
        }}>
        <Search size={12} />
        {meta.totalFound} result{meta.totalFound !== 1 ? 's' : ''} found
      </span>

      <span className="text-xs" style={{ color: '#555575' }}>·</span>

      {/* Timing */}
      <span className="flex items-center gap-1 text-xs" style={{ color: '#555575' }}>
        <Clock size={11} />
        {formatMs(meta.durationMs)}
      </span>

      {/* Active keywords */}
      {meta.keywords.length > 0 && (
        <>
          <span className="text-xs" style={{ color: '#555575' }}>·</span>
          <div className="flex items-center gap-1.5 flex-wrap">
            {meta.keywords.map((kw) => (
              <span key={kw} className="text-xs px-2 py-0.5 rounded-full font-medium"
                style={{
                  background: 'rgba(129,140,248,.15)',
                  color: '#818CF8',
                  border: '1px solid rgba(129,140,248,.25)',
                }}>
                {kw}
              </span>
            ))}
          </div>
        </>
      )}

      {/* Type hint */}
      {meta.extHint && meta.extHint.length > 0 && (
        <>
          <span className="text-xs" style={{ color: '#555575' }}>·</span>
          <span className="text-xs" style={{ color: '#8B8BAD' }}>
            type: {meta.extHint.slice(0, 3).join(', ')}
          </span>
        </>
      )}
    </motion.div>
  );
}

// ─── empty state ───────────────────────────────────────────────────────────────

function EmptyState({ query }: { query?: string }) {
  return (
    <motion.div
      key="empty"
      variants={emptyVariants}
      initial="hidden"
      animate="visible"
      exit={{ opacity: 0, scale: 0.94 }}
      className="flex flex-col items-center justify-center py-20 gap-5 select-none"
    >
      <motion.div
        animate={{ y: [0, -6, 0] }}
        transition={{ repeat: Infinity, duration: 2.6, ease: 'easeInOut' }}
        className="w-16 h-16 rounded-2xl flex items-center justify-center"
        style={{
          background: 'rgba(79,70,229,.12)',
          border: '1px solid rgba(79,70,229,.22)',
          boxShadow: '0 0 24px rgba(79,70,229,.12)',
        }}
      >
        <Search size={28} style={{ color: '#818CF8' }} />
      </motion.div>

      <div className="text-center">
        <p className="text-sm font-semibold text-white">No files found</p>
        <p className="text-xs mt-1.5 max-w-xs leading-relaxed" style={{ color: '#8B8BAD' }}>
          {query
            ? <>Couldn't find anything for <span style={{ color: '#818CF8', fontWeight: 600 }}>"{query}"</span>.<br />Try different keywords or check your watched folders.</>
            : 'Try different keywords. Make sure your watched folders are configured in Settings.'}
        </p>
      </div>
    </motion.div>
  );
}

// ─── loading skeleton ──────────────────────────────────────────────────────────

function SkeletonCard() {
  return (
    <div className="glass-card p-4">
      <div className="flex items-start gap-4">
        <div className="w-11 h-11 rounded-xl shrink-0"
          style={{ background: 'rgba(255,255,255,0.05)' }} />
        <div className="flex-1 space-y-2">
          <div className="h-4 rounded-lg w-2/3"
            style={{ background: 'rgba(255,255,255,0.06)' }} />
          <div className="h-3 rounded-lg w-full"
            style={{ background: 'rgba(255,255,255,0.04)' }} />
          <div className="h-3 rounded-lg w-1/3"
            style={{ background: 'rgba(255,255,255,0.04)' }} />
        </div>
      </div>
    </div>
  );
}

// ─── main export ───────────────────────────────────────────────────────────────

export default function SearchResults({
  results,
  meta,
  loading = false,
  query,
}: SearchResultsProps) {
  const keywords = meta?.keywords ?? [];

  return (
    <div className="flex flex-col min-h-0">
      {/* Stats bar */}
      <StatsBar meta={meta} loading={loading} />

      {/* Loading skeletons */}
      {loading && (
        <div className="space-y-3">
          {[0, 1, 2].map((i) => (
            <motion.div
              key={i}
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0, transition: { delay: i * 0.08 } }}
            >
              <SkeletonCard />
            </motion.div>
          ))}
        </div>
      )}

      {/* Results list */}
      {!loading && (
        <AnimatePresence mode="wait">
          {results.length === 0 ? (
            <EmptyState key="empty" query={query} />
          ) : (
            <motion.div
              key="list"
              variants={listVariants}
              initial="hidden"
              animate="visible"
              exit={{ opacity: 0 }}
              className="space-y-3"
            >
              <AnimatePresence>
                {results.map((r) => (
                  <ResultCard
                    key={r.id ?? r.filepath}
                    result={r}
                    keywords={keywords}
                  />
                ))}
              </AnimatePresence>
            </motion.div>
          )}
        </AnimatePresence>
      )}
    </div>
  );
}
