import { useState, useEffect } from 'react';
import { Outlet, NavLink, useLocation } from 'react-router-dom';
import { motion, AnimatePresence } from 'framer-motion';
import {
  LayoutDashboard, CheckCircle, Activity, Settings,
  MessageSquare, BarChart2, Copy,
  Minus, Square, X, Zap, ChevronLeft, ChevronRight,
} from 'lucide-react';

// ─── nav definition ───────────────────────────────────────────────────────────

const NAV_ITEMS: Array<{
  to: string;
  icon: React.ElementType;
  label: string;
  badge?: boolean;
}> = [
  { to: '/',           icon: LayoutDashboard, label: 'Dashboard'      },
  { to: '/approvals',  icon: CheckCircle,     label: 'Approvals',  badge: true },
  { to: '/chat',       icon: MessageSquare,   label: 'Chat'            },
  { to: '/analytics',  icon: BarChart2,       label: 'Analytics'       },
  { to: '/duplicates', icon: Copy,            label: 'Duplicates'      },
  { to: '/activity',   icon: Activity,        label: 'Activity'        },
  { to: '/settings',   icon: Settings,        label: 'Settings'        },
] as const;

// ─── motion variants ──────────────────────────────────────────────────────────

const sidebarVariants = {
  expanded:  { width: 232, transition: { duration: 0.25, ease: [0.22, 1, 0.36, 1] } },
  collapsed: { width: 64,  transition: { duration: 0.25, ease: [0.22, 1, 0.36, 1] } },
};

const labelVariants = {
  expanded:  { opacity: 1, x: 0,   width: 'auto', transition: { duration: 0.2, delay: 0.05 } },
  collapsed: { opacity: 0, x: -8,  width: 0,      transition: { duration: 0.15 } },
};

// ─── component ────────────────────────────────────────────────────────────────

export default function Layout() {
  const location = useLocation();
  const [collapsed, setCollapsed] = useState(false);
  const [pendingCount, setPendingCount] = useState(0);

  // Fetch real pending count from backend, refresh every 30s
  useEffect(() => {
    const load = async () => {
      try {
        const res  = await fetch('http://localhost:3001/api/activity?status=pending&limit=1');
        const data = await res.json() as any[];
        // The backend returns the actual rows — get count from stats endpoint instead
        const statsRes  = await fetch('http://localhost:3001/api/stats');
        const statsData = await statsRes.json();
        setPendingCount(statsData.approvals ?? 0);
      } catch { /* silently ignore */ }
    };
    load();
    const iv = setInterval(load, 30_000);
    return () => clearInterval(iv);
  }, []);

  const handleWindow = (action: 'minimize' | 'maximize' | 'close') =>
    window.electronAPI?.window[action]();

  return (
    <div className="flex h-screen w-screen overflow-hidden" style={{ background: '#0F0F1A' }}>

      {/* ── Sidebar ─────────────────────────────────────────────────────────── */}
      <motion.aside
        animate={collapsed ? 'collapsed' : 'expanded'}
        variants={sidebarVariants}
        className="relative flex flex-col shrink-0 overflow-hidden border-r py-5"
        style={{
          background: 'rgba(12, 12, 24, 0.88)',
          backdropFilter: 'blur(24px)',
          WebkitBackdropFilter: 'blur(24px)',
          borderColor: 'rgba(255,255,255,0.06)',
          zIndex: 20,
        }}
      >
        {/* Logo row */}
        <div className={`flex items-center gap-3 mb-6 px-4 ${collapsed ? 'justify-center' : ''}`}>
          <motion.div
            whileHover={{ scale: 1.08 }}
            className="w-8 h-8 shrink-0 rounded-xl flex items-center justify-center cursor-pointer"
            style={{
              background: 'linear-gradient(135deg, #4F46E5, #7C3AED)',
              boxShadow: '0 0 16px rgba(79,70,229,.45)',
            }}
            onClick={() => setCollapsed(false)}
          >
            <Zap size={16} className="text-white" />
          </motion.div>

          <AnimatePresence initial={false}>
            {!collapsed && (
              <motion.div
                variants={labelVariants}
                animate="expanded"
                initial="collapsed"
                exit="collapsed"
                className="overflow-hidden whitespace-nowrap"
              >
                <p className="text-sm font-bold text-white leading-none">SmartDesk</p>
                <p className="text-xs mt-0.5" style={{ color: '#8B8BAD' }}>AI Organizer</p>
              </motion.div>
            )}
          </AnimatePresence>
        </div>

        {/* Navigation */}
        <nav className="flex flex-col gap-0.5 flex-1 px-2 overflow-y-auto overflow-x-hidden">
          {NAV_ITEMS.map(({ to, icon: Icon, label, badge }) => {
            const isActive =
              to === '/'
                ? location.pathname === '/'
                : location.pathname.startsWith(to);

            return (
              <NavLink
                key={to}
                to={to}
                title={collapsed ? label : undefined}
                className="group relative flex items-center gap-3 px-3 py-2.5 rounded-xl
                           text-sm font-medium transition-all duration-150 outline-none select-none"
                style={({ isActive: a }) => ({
                  color:      a ? '#F0F0FF' : '#8B8BAD',
                  background: a ? 'rgba(79,70,229,.18)' : 'transparent',
                  boxShadow:  a ? 'inset 3px 0 0 #4F46E5' : 'none',
                })}
                onMouseEnter={(e) => {
                  if (!isActive) {
                    (e.currentTarget as HTMLElement).style.background = 'rgba(79,70,229,.08)';
                    (e.currentTarget as HTMLElement).style.color = '#C4C4E8';
                  }
                }}
                onMouseLeave={(e) => {
                  if (!isActive) {
                    (e.currentTarget as HTMLElement).style.background = 'transparent';
                    (e.currentTarget as HTMLElement).style.color = '#8B8BAD';
                  }
                }}
              >
                <Icon size={17} className="shrink-0" />

                <AnimatePresence initial={false}>
                  {!collapsed && (
                    <motion.span
                      variants={labelVariants}
                      animate="expanded"
                      initial="collapsed"
                      exit="collapsed"
                      className="overflow-hidden whitespace-nowrap flex-1"
                    >
                      {label}
                    </motion.span>
                  )}
                </AnimatePresence>

                {/* Badge (approvals) */}
                {badge && !collapsed && pendingCount > 0 && (
                  <span
                    className="ml-auto text-xs font-semibold px-1.5 py-0.5 rounded-full"
                    style={{
                      background: 'rgba(79,70,229,.2)',
                      color: '#818CF8',
                      border: '1px solid rgba(79,70,229,.3)',
                    }}
                  >
                    {pendingCount > 99 ? '99+' : pendingCount}
                  </span>
                )}

                {/* Collapsed tooltip dot for badge */}
                {badge && collapsed && pendingCount > 0 && (
                  <span
                    className="absolute top-1.5 right-1.5 w-1.5 h-1.5 rounded-full"
                    style={{ background: '#4F46E5', boxShadow: '0 0 4px #4F46E5' }}
                  />
                )}
              </NavLink>
            );
          })}
        </nav>

        {/* Status dot */}
        {!collapsed && (
          <motion.div
            initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            className="mx-3 mt-3 rounded-xl p-3"
            style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.06)' }}
          >
            <div className="flex items-center gap-2">
              <span className="w-2 h-2 rounded-full bg-emerald-400"
                style={{ boxShadow: '0 0 6px #34D399' }} />
              <span className="text-xs" style={{ color: '#8B8BAD' }}>Watcher active</span>
            </div>
          </motion.div>
        )}

        {/* Collapse toggle — sits at the bottom */}
        <motion.button
          whileHover={{ scale: 1.1 }}
          whileTap={{ scale: 0.92 }}
          onClick={() => setCollapsed((v) => !v)}
          className="mx-auto mt-4 w-7 h-7 rounded-lg flex items-center justify-center
                     transition-all duration-150 shrink-0"
          style={{
            background: 'rgba(255,255,255,0.05)',
            border: '1px solid rgba(255,255,255,0.08)',
            color: '#555575',
          }}
          aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
        >
          {collapsed ? <ChevronRight size={13} /> : <ChevronLeft size={13} />}
        </motion.button>
      </motion.aside>

      {/* ── Main area ───────────────────────────────────────────────────────── */}
      <div className="flex flex-col flex-1 overflow-hidden min-w-0">

        {/* Title bar / drag region */}
        <header
          className="flex items-center justify-between px-5 shrink-0 select-none"
          style={{
            height: 44,
            background: 'rgba(12, 12, 24, 0.92)',
            borderBottom: '1px solid rgba(255,255,255,0.05)',
            WebkitAppRegion: 'drag',
          } as React.CSSProperties}
        >
          <p className="text-xs font-medium" style={{ color: '#555575' }}>
            SmartDesk AI — powered by IBM watsonx Orchestrate
          </p>

          {/* Window controls */}
          <div
            className="flex items-center gap-1"
            style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
          >
            {(['minimize', 'maximize', 'close'] as const).map((action) => (
              <button
                key={action}
                onClick={() => handleWindow(action)}
                className="w-8 h-8 rounded-lg flex items-center justify-center transition-all duration-150"
                style={{ color: '#555575' }}
                onMouseEnter={(e) => {
                  (e.currentTarget as HTMLElement).style.background = 'rgba(255,255,255,0.06)';
                  (e.currentTarget as HTMLElement).style.color = '#F0F0FF';
                }}
                onMouseLeave={(e) => {
                  (e.currentTarget as HTMLElement).style.background = 'transparent';
                  (e.currentTarget as HTMLElement).style.color = '#555575';
                }}
              >
                {action === 'minimize' && <Minus size={13} />}
                {action === 'maximize' && <Square size={12} />}
                {action === 'close'    && <X size={13} />}
              </button>
            ))}
          </div>
        </header>

        {/* Page outlet */}
        <main className="flex-1 overflow-y-auto p-6">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
