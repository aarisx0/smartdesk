import { useState, useEffect, useCallback } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
  BarChart, Bar, AreaChart, Area, PieChart, Pie, Cell,
  XAxis, YAxis, Tooltip, ResponsiveContainer, Legend,
} from 'recharts';
import {
  BarChart2, HardDrive, Zap, Calendar, TrendingUp,
  ArrowRight, FolderOpen, Download, Filter,
} from 'lucide-react';
import { formatDistanceToNow, format } from 'date-fns';

// ─── types ────────────────────────────────────────────────────────────────────

interface DailyStats { date: string; files: number; storage: number }
interface CategoryData { name: string; value: number; color: string }
interface FolderData { folder: string; count: number }
interface ActivityRow {
  id: string; action: string; filename: string;
  from_path: string; to_path: string;
  file_size_bytes: number; timestamp: string;
}

// ─── constants ────────────────────────────────────────────────────────────────

const CATEGORY_COLORS = [
  '#818CF8', '#34D399', '#F472B6', '#FBBF24',
  '#60A5FA', '#A78BFA', '#FB923C', '#4ADE80',
];

const fadeUp = {
  hidden:  { opacity: 0, y: 18 },
  visible: { opacity: 1, y: 0, transition: { duration: 0.4, ease: [0.22, 1, 0.36, 1] } },
};

const stagger = {
  hidden:  {},
  visible: { transition: { staggerChildren: 0.07 } },
};

// ─── helpers ──────────────────────────────────────────────────────────────────

function formatBytes(b: number): string {
  if (b >= 1_073_741_824) return `${(b / 1_073_741_824).toFixed(1)} GB`;
  if (b >= 1_048_576)     return `${(b / 1_048_576).toFixed(1)} MB`;
  if (b >= 1_024)         return `${(b / 1_024).toFixed(0)} KB`;
  return `${b} B`;
}

function actionColor(action: string): string {
  const map: Record<string, string> = {
    moved:   '#818CF8',
    created: '#34D399',
    deleted: '#FCA5A5',
    skipped: '#FBBF24',
  };
  return map[action] ?? '#8B8BAD';
}

// ─── custom tooltip ───────────────────────────────────────────────────────────

const ChartTooltip = ({ active, payload, label }: any) => {
  if (!active || !payload?.length) return null;
  return (
    <div className="rounded-xl px-3 py-2 text-xs"
      style={{ background: 'rgba(20,20,43,0.95)', border: '1px solid rgba(79,70,229,0.35)' }}>
      <p className="font-semibold text-white mb-1">{label}</p>
      {payload.map((p: any) => (
        <p key={p.dataKey} style={{ color: p.color ?? '#818CF8' }}>
          {p.name}: {typeof p.value === 'number' && p.value > 1000 ? formatBytes(p.value) : p.value}
        </p>
      ))}
    </div>
  );
};

// ─── main component ───────────────────────────────────────────────────────────

export default function Analytics() {
  const [daily,      setDaily]      = useState<DailyStats[]>([]);
  const [categories, setCategories] = useState<CategoryData[]>([]);
  const [topFolders, setTopFolders] = useState<FolderData[]>([]);
  const [activity,   setActivity]   = useState<ActivityRow[]>([]);
  const [totals,     setTotals]     = useState({ organized: 0, storage: 0, bestDay: '', avgPerDay: 0 });
  const [page,       setPage]       = useState(0);
  const [filter,     setFilter]     = useState<string>('all');
  const [loading,    setLoading]    = useState(true);
  const PAGE_SIZE = 25;

  const fetchAll = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch('http://localhost:3001/api/analytics');
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);

      const dailyData: DailyStats[] = (Array.isArray(data.daily) ? data.daily : []).map((r: any) => ({
        date: format(new Date(r.date), 'MMM d'),
        files: Number(r.files || 0),
        storage: Number(r.storage || 0),
      }));
      setDaily(dailyData);

      const totalOrganized = Number(data?.totals?.organized || 0);
      const totalStorage = Number(data?.totals?.storage || 0);
      const bestDayRaw = data?.totals?.bestDay ? new Date(data.totals.bestDay) : null;
      const avgPerDay = Number(data?.totals?.avgPerDay || 0);
      setTotals({
        organized: totalOrganized,
        storage: totalStorage,
        bestDay: bestDayRaw ? format(bestDayRaw, 'MMM d') : '—',
        avgPerDay,
      });

      const catData: CategoryData[] = (Array.isArray(data.categories) ? data.categories : [])
        .map((row: any, i: number) => ({
          name: String(row.name || 'other'),
          value: Number(row.value || 0),
          color: CATEGORY_COLORS[i % CATEGORY_COLORS.length],
        }));
      setCategories(catData);

      const folderData: FolderData[] = (Array.isArray(data.topFolders) ? data.topFolders : [])
        .map((row: any) => ({
          folder: String(row.folder || ''),
          count: Number(row.count || 0),
        }));
      setTopFolders(folderData);

      setActivity(Array.isArray(data.activity) ? data.activity : []);

    } catch (err) {
      console.error('[analytics] fetch error:', err);
      setDaily([]);
      setCategories([]);
      setTopFolders([]);
      setActivity([]);
      setTotals({ organized: 0, storage: 0, bestDay: '—', avgPerDay: 0 });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchAll(); }, [fetchAll]);

  // ── filtered activity ──────────────────────────────────────────────────────
  const filtered = filter === 'all'
    ? activity
    : activity.filter((r) => r.action === filter);

  const paginated = filtered.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);
  const totalPages = Math.ceil(filtered.length / PAGE_SIZE);

  // ── CSV export ─────────────────────────────────────────────────────────────
  const exportCSV = () => {
    const header = 'Action,Filename,From,To,Size,Timestamp\n';
    const rows = filtered.map((r) =>
      [r.action, r.filename, r.from_path, r.to_path, r.file_size_bytes, r.timestamp]
        .map((v) => `"${v ?? ''}"`)
        .join(',')
    ).join('\n');
    const blob = new Blob([header + rows], { type: 'text/csv' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href = url; a.download = 'smartdesk-activity.csv'; a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <motion.div
      className="space-y-6"
      variants={stagger}
      initial="hidden"
      animate="visible"
    >
      {/* ── Header ──────────────────────────────────────────────────────────── */}
      <motion.div variants={fadeUp} className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-white">Analytics</h1>
          <p className="text-sm mt-0.5" style={{ color: '#8B8BAD' }}>
            File organisation trends and storage insights
          </p>
        </div>
        <motion.button
          whileHover={{ scale: 1.04 }}
          whileTap={{ scale: 0.96 }}
          onClick={fetchAll}
          className="btn-ghost text-xs"
        >
          <TrendingUp size={13} />
          Refresh
        </motion.button>
      </motion.div>

      {/* ── Summary cards ────────────────────────────────────────────────────── */}
      <motion.div variants={stagger} className="grid grid-cols-2 xl:grid-cols-4 gap-4">
        {[
          { label: 'Total Organised', value: totals.organized.toLocaleString(), icon: Zap,       color: '#818CF8' },
          { label: 'Storage Saved',   value: formatBytes(totals.storage),        icon: HardDrive,  color: '#34D399' },
          { label: 'Best Day',        value: totals.bestDay || '—',              icon: Calendar,   color: '#FBBF24' },
          { label: 'Avg / Day',       value: `${totals.avgPerDay} files`,        icon: BarChart2,  color: '#F472B6' },
        ].map(({ label, value, icon: Icon, color }) => (
          <motion.div
            key={label}
            variants={fadeUp}
            whileHover={{ y: -3 }}
            className="glass-card p-5 relative overflow-hidden"
          >
            <div className="absolute inset-0 pointer-events-none"
              style={{ background: `radial-gradient(ellipse at 80% 20%, ${color}18, transparent 65%)` }} />
            <div className="w-10 h-10 rounded-xl flex items-center justify-center mb-4"
              style={{ background: `${color}20`, border: `1px solid ${color}35` }}>
              <Icon size={18} style={{ color }} />
            </div>
            <p className="text-2xl font-extrabold"
              style={{ background: `linear-gradient(135deg, ${color}, ${color}aa)`,
                       WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent',
                       backgroundClip: 'text', filter: `drop-shadow(0 0 8px ${color}55)` }}>
              {value}
            </p>
            <p className="text-xs mt-1.5" style={{ color: '#8B8BAD' }}>{label}</p>
          </motion.div>
        ))}
      </motion.div>

      {/* ── Charts row ───────────────────────────────────────────────────────── */}
      <motion.div variants={stagger} className="grid grid-cols-12 gap-4">

        {/* Files per day — BarChart */}
        <motion.div variants={fadeUp} className="col-span-12 lg:col-span-7 glass-card p-5">
          <div className="flex items-center gap-2 mb-4">
            <BarChart2 size={15} className="text-indigo-400" />
            <h2 className="text-sm font-semibold text-white">Files Organised (Last 30 Days)</h2>
          </div>
          <ResponsiveContainer width="100%" height={220}>
            <BarChart data={daily} barSize={10}>
              <defs>
                <linearGradient id="barGrad" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%"   stopColor="#818CF8" stopOpacity={0.9} />
                  <stop offset="100%" stopColor="#4F46E5" stopOpacity={0.4} />
                </linearGradient>
              </defs>
              <XAxis dataKey="date" tick={{ fill: '#555575', fontSize: 10 }} axisLine={false} tickLine={false} />
              <YAxis tick={{ fill: '#555575', fontSize: 10 }} axisLine={false} tickLine={false} />
              <Tooltip content={<ChartTooltip />} />
              <Bar dataKey="files" name="Files" fill="url(#barGrad)" radius={[4, 4, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </motion.div>

        {/* Category donut */}
        <motion.div variants={fadeUp} className="col-span-12 lg:col-span-5 glass-card p-5">
          <div className="flex items-center gap-2 mb-4">
            <FolderOpen size={15} className="text-violet-400" />
            <h2 className="text-sm font-semibold text-white">File Categories</h2>
          </div>
          {categories.length === 0 ? (
            <div className="flex items-center justify-center h-48 text-sm" style={{ color: '#555575' }}>
              No data yet
            </div>
          ) : (
            <div className="flex items-center gap-4">
              <ResponsiveContainer width="50%" height={180}>
                <PieChart>
                  <Pie data={categories} cx="50%" cy="50%" innerRadius={50} outerRadius={80}
                       dataKey="value" paddingAngle={3}>
                    {categories.map((c, i) => (
                      <Cell key={i} fill={c.color}
                        style={{ filter: `drop-shadow(0 0 4px ${c.color}66)` }} />
                    ))}
                  </Pie>
                  <Tooltip content={<ChartTooltip />} />
                </PieChart>
              </ResponsiveContainer>
              <div className="flex flex-col gap-1.5 flex-1">
                {categories.slice(0, 6).map((c) => (
                  <div key={c.name} className="flex items-center gap-2 text-xs">
                    <span className="w-2 h-2 rounded-full shrink-0" style={{ background: c.color }} />
                    <span className="truncate" style={{ color: '#C4C4E8' }}>.{c.name}</span>
                    <span className="ml-auto font-semibold" style={{ color: c.color }}>{c.value}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </motion.div>
      </motion.div>

      {/* ── Storage + Top Folders ────────────────────────────────────────────── */}
      <motion.div variants={stagger} className="grid grid-cols-12 gap-4">

        {/* Storage area chart */}
        <motion.div variants={fadeUp} className="col-span-12 lg:col-span-7 glass-card p-5">
          <div className="flex items-center gap-2 mb-4">
            <HardDrive size={15} className="text-emerald-400" />
            <h2 className="text-sm font-semibold text-white">Storage Saved Over Time</h2>
          </div>
          <ResponsiveContainer width="100%" height={180}>
            <AreaChart data={daily}>
              <defs>
                <linearGradient id="areaGrad" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%"   stopColor="#34D399" stopOpacity={0.3} />
                  <stop offset="95%"  stopColor="#34D399" stopOpacity={0} />
                </linearGradient>
              </defs>
              <XAxis dataKey="date" tick={{ fill: '#555575', fontSize: 10 }} axisLine={false} tickLine={false} />
              <YAxis tickFormatter={(v) => formatBytes(v)} tick={{ fill: '#555575', fontSize: 10 }} axisLine={false} tickLine={false} />
              <Tooltip content={<ChartTooltip />} />
              <Area type="monotone" dataKey="storage" name="Storage" stroke="#34D399"
                strokeWidth={2} fill="url(#areaGrad)"
                style={{ filter: 'drop-shadow(0 0 6px #34D39966)' }} />
            </AreaChart>
          </ResponsiveContainer>
        </motion.div>

        {/* Top folders horizontal bar */}
        <motion.div variants={fadeUp} className="col-span-12 lg:col-span-5 glass-card p-5">
          <div className="flex items-center gap-2 mb-4">
            <FolderOpen size={15} className="text-amber-400" />
            <h2 className="text-sm font-semibold text-white">Top 5 Destination Folders</h2>
          </div>
          {topFolders.length === 0 ? (
            <div className="flex items-center justify-center h-32 text-sm" style={{ color: '#555575' }}>
              No moves yet
            </div>
          ) : (
            <div className="space-y-3">
              {topFolders.map((f, i) => {
                const max   = topFolders[0].count;
                const pct   = Math.round((f.count / max) * 100);
                const color = CATEGORY_COLORS[i % CATEGORY_COLORS.length];
                return (
                  <div key={f.folder}>
                    <div className="flex items-center justify-between mb-1">
                      <span className="text-xs truncate max-w-[70%]" style={{ color: '#C4C4E8' }}
                        title={f.folder}>
                        {f.folder.split(/[/\\]/).pop() ?? f.folder}
                      </span>
                      <span className="text-xs font-semibold" style={{ color }}>{f.count}</span>
                    </div>
                    <div className="h-1.5 rounded-full overflow-hidden"
                      style={{ background: 'rgba(255,255,255,0.06)' }}>
                      <motion.div
                        initial={{ width: 0 }}
                        animate={{ width: `${pct}%` }}
                        transition={{ duration: 0.6, delay: i * 0.08, ease: 'easeOut' }}
                        className="h-full rounded-full"
                        style={{ background: color, boxShadow: `0 0 6px ${color}88` }}
                      />
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </motion.div>
      </motion.div>

      {/* ── Activity Log ─────────────────────────────────────────────────────── */}
      <motion.div variants={fadeUp} className="glass-card overflow-hidden">
        <div className="flex items-center justify-between px-5 py-4 border-b"
          style={{ borderColor: 'rgba(255,255,255,0.05)' }}>
          <h2 className="text-sm font-semibold text-white flex items-center gap-2">
            <Calendar size={15} className="text-indigo-400" />
            Activity Log
          </h2>
          <div className="flex items-center gap-2">
            {/* Filter */}
            <div className="flex items-center gap-1">
              <Filter size={12} style={{ color: '#555575' }} />
              {['all', 'moved', 'created', 'deleted', 'skipped'].map((f) => (
                <button
                  key={f}
                  onClick={() => { setFilter(f); setPage(0); }}
                  className="text-xs px-2.5 py-1 rounded-lg transition-all"
                  style={{
                    background: filter === f ? 'rgba(79,70,229,0.2)' : 'transparent',
                    color:      filter === f ? '#818CF8' : '#555575',
                    border:     filter === f ? '1px solid rgba(79,70,229,0.35)' : '1px solid transparent',
                  }}
                >
                  {f}
                </button>
              ))}
            </div>
            <motion.button
              whileHover={{ scale: 1.05 }}
              whileTap={{ scale: 0.95 }}
              onClick={exportCSV}
              className="btn-ghost text-xs py-1.5 px-3"
            >
              <Download size={12} />
              CSV
            </motion.button>
          </div>
        </div>

        {/* Table header */}
        <div className="grid grid-cols-12 px-5 py-2.5 text-xs font-semibold uppercase tracking-wider border-b"
          style={{ color: '#555575', borderColor: 'rgba(255,255,255,0.04)' }}>
          <span className="col-span-1">Action</span>
          <span className="col-span-3">File</span>
          <span className="col-span-4">Path Change</span>
          <span className="col-span-2">Size</span>
          <span className="col-span-2">When</span>
        </div>

        {loading ? (
          <div className="py-12 text-center text-sm" style={{ color: '#555575' }}>Loading…</div>
        ) : paginated.length === 0 ? (
          <div className="py-12 text-center text-sm" style={{ color: '#555575' }}>No activity yet</div>
        ) : (
          <div className="divide-y" style={{ divideColor: 'rgba(255,255,255,0.04)' }}>
            <AnimatePresence initial={false}>
              {paginated.map((row, i) => (
                <motion.div
                  key={row.id}
                  initial={{ opacity: 0, x: -6 }}
                  animate={{ opacity: 1, x: 0 }}
                  transition={{ delay: i * 0.02 }}
                  className="grid grid-cols-12 px-5 py-3 items-center hover:bg-white/[0.02] transition-colors"
                >
                  <div className="col-span-1">
                    <span className="text-xs font-semibold px-2 py-0.5 rounded-full"
                      style={{
                        background: `${actionColor(row.action)}22`,
                        color: actionColor(row.action),
                        border: `1px solid ${actionColor(row.action)}44`,
                      }}>
                      {row.action}
                    </span>
                  </div>
                  <div className="col-span-3 min-w-0 pr-3">
                    <p className="text-xs font-medium text-white truncate">{row.filename}</p>
                  </div>
                  <div className="col-span-4 flex items-center gap-1.5 min-w-0 pr-3">
                    {row.from_path && (
                      <>
                        <span className="text-xs truncate line-through" style={{ color: '#555575' }}
                          title={row.from_path}>
                          {row.from_path.split(/[/\\]/).slice(-2).join('/')}
                        </span>
                        <ArrowRight size={10} style={{ color: '#4F46E5', shrink: 0 }} />
                      </>
                    )}
                    {row.to_path && (
                      <span className="text-xs truncate font-medium" style={{ color: '#818CF8' }}
                        title={row.to_path}>
                        {row.to_path.split(/[/\\]/).slice(-2).join('/')}
                      </span>
                    )}
                    {!row.from_path && !row.to_path && (
                      <span className="text-xs" style={{ color: '#555575' }}>—</span>
                    )}
                  </div>
                  <div className="col-span-2 text-xs" style={{ color: '#8B8BAD' }}>
                    {row.file_size_bytes ? formatBytes(row.file_size_bytes) : '—'}
                  </div>
                  <div className="col-span-2 text-xs" style={{ color: '#555575' }}>
                    {formatDistanceToNow(new Date(row.timestamp), { addSuffix: true })}
                  </div>
                </motion.div>
              ))}
            </AnimatePresence>
          </div>
        )}

        {/* Pagination */}
        {totalPages > 1 && (
          <div className="flex items-center justify-between px-5 py-3 border-t"
            style={{ borderColor: 'rgba(255,255,255,0.05)' }}>
            <span className="text-xs" style={{ color: '#555575' }}>
              {filtered.length} results · Page {page + 1} of {totalPages}
            </span>
            <div className="flex gap-2">
              <button
                disabled={page === 0}
                onClick={() => setPage((p) => p - 1)}
                className="text-xs px-3 py-1.5 rounded-lg btn-ghost disabled:opacity-30"
              >
                Prev
              </button>
              <button
                disabled={page >= totalPages - 1}
                onClick={() => setPage((p) => p + 1)}
                className="text-xs px-3 py-1.5 rounded-lg btn-ghost disabled:opacity-30"
              >
                Next
              </button>
            </div>
          </div>
        )}
      </motion.div>
    </motion.div>
  );
}
