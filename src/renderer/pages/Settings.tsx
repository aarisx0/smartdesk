import { useState, useEffect, useCallback } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
  FolderOpen, Plus, Trash2, Save,
  BookOpen, AlertTriangle, CheckCircle2, RefreshCw, X, ExternalLink,
} from 'lucide-react';
import { apiFetch } from '../lib/apiFetch';

interface FolderEntry { path: string; enabled: boolean }

interface LearnedRule {
  id: string;
  pattern_keyword: string | null;
  extension: string | null;
  user_confirmed_folder: string;
  times_confirmed: number;
  is_learned_rule: boolean;
  created_at: string;
}

const fadeUp = {
  hidden:  { opacity: 0, y: 12 },
  visible: { opacity: 1, y: 0, transition: { duration: 0.3, ease: [0.22, 1, 0.36, 1] } },
  exit:    { opacity: 0, x: 20, height: 0, transition: { duration: 0.2 } },
};

export default function Settings() {
  const [folders,      setFolders]      = useState<FolderEntry[]>([]);
  const [autoApprove,  setAutoApprove]  = useState(false);
  const [saved,        setSaved]        = useState(false);

  const [rules,        setRules]        = useState<LearnedRule[]>([]);
  const [rulesLoading, setRulesLoading] = useState(true);
  const [clearConfirm, setClearConfirm] = useState(false);
  const [dbStatus,     setDbStatus]     = useState<'ok' | 'error' | 'checking'>('checking');

  // ── load settings ──────────────────────────────────────────────────────────
  useEffect(() => {
    (async () => {
      const stored = await window.electronAPI?.store.get('watchedFolders') as FolderEntry[] | null;
      if (stored) setFolders(Array.isArray(stored) ? stored : []);
      const aa = await window.electronAPI?.store.get('autoApprove') as boolean | null;
      if (aa !== null && aa !== undefined) setAutoApprove(aa);
    })();
  }, []);

  // ── DB health check ────────────────────────────────────────────────────────
  const checkDb = useCallback(async () => {
    setDbStatus('checking');
    try {
      const res = await apiFetch('/health');
      setDbStatus(res.ok ? 'ok' : 'error');
    } catch {
      setDbStatus('error');
    }
  }, []);

  // ── load learned rules ─────────────────────────────────────────────────────
  const loadRules = useCallback(async () => {
    setRulesLoading(true);
    try {
      const res  = await apiFetch('/api/learning/rules');
      const data = await res.json();
      setRules(Array.isArray(data) ? data : []);
    } catch (err) {
      console.error('Failed to load rules', err);
      setRules([]);
    } finally {
      setRulesLoading(false);
    }
  }, []);

  useEffect(() => { loadRules(); checkDb(); }, [loadRules, checkDb]);

  // ── folder management ──────────────────────────────────────────────────────
  const addFolder = async () => {
    const paths = await window.electronAPI?.openFolder();
    if (!paths) return;
    const newEntries: FolderEntry[] = paths.map((p) => ({ path: p, enabled: true }));
    setFolders((prev) => {
      const existing = new Set(prev.map((f) => f.path));
      return [...prev, ...newEntries.filter((e) => !existing.has(e.path))];
    });
  };

  const removeFolder = (idx: number) =>
    setFolders((prev) => prev.filter((_, i) => i !== idx));

  // ── save ───────────────────────────────────────────────────────────────────
  const handleSave = async () => {
    await window.electronAPI?.store.set('watchedFolders', folders);
    await window.electronAPI?.store.set('autoApprove', autoApprove);
    await window.electronAPI?.watcher.setFolders(
      folders.filter((f) => f.enabled).map((f) => f.path)
    );
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  };

  // ── delete / clear rules ───────────────────────────────────────────────────
  const deleteRule = async (id: string) => {
    try {
      await apiFetch(`/api/learning/rules/${id}`, { method: 'DELETE' });
      setRules((prev) => prev.filter((r) => r.id !== id));
    } catch (err) {
      console.error('Failed to delete rule', err);
    }
  };

  const clearAllRules = async () => {
    try {
      await apiFetch('/api/learning/rules', { method: 'DELETE' });
      setRules([]);
      setClearConfirm(false);
    } catch (err) {
      console.error('Failed to clear rules', err);
    }
  };

  return (
    <div className="space-y-6 max-w-2xl">
      <div>
        <h1 className="text-2xl font-bold text-white">Settings</h1>
        <p className="text-sm mt-0.5" style={{ color: '#8B8BAD' }}>
          Manage watched folders, automation rules, and AI-learned preferences
        </p>
      </div>

      {/* ── DB Status ──────────────────────────────────────────────────────── */}
      <section className="glass-card p-4 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <span className="text-sm text-white font-medium">Database Connection</span>
          {dbStatus === 'checking' && (
            <span className="text-xs flex items-center gap-1.5" style={{ color: '#8B8BAD' }}>
              <RefreshCw size={12} className="animate-spin" /> Checking…
            </span>
          )}
          {dbStatus === 'ok' && (
            <span className="text-xs flex items-center gap-1.5" style={{ color: '#34D399' }}>
              <CheckCircle2 size={12} /> Connected
            </span>
          )}
          {dbStatus === 'error' && (
            <span className="text-xs flex items-center gap-1.5" style={{ color: '#FCA5A5' }}>
              <AlertTriangle size={12} /> Disconnected — check your .env file
            </span>
          )}
        </div>
        <motion.button
          whileHover={{ scale: 1.05 }} whileTap={{ scale: 0.95 }}
          onClick={checkDb}
          className="btn-ghost text-xs py-1.5 px-3"
        >
          <RefreshCw size={12} />
          Recheck
        </motion.button>
      </section>

      {/* ── Watched Folders ────────────────────────────────────────────────── */}
      <section className="glass-card p-6">
        <h2 className="text-sm font-semibold text-white mb-4 flex items-center gap-2">
          <FolderOpen size={16} className="text-indigo-400" />
          Watched Folders
        </h2>
        <div className="space-y-2 mb-4">
          {folders.length === 0 && (
            <p className="text-sm py-4 text-center" style={{ color: '#555575' }}>
              No folders added yet. Click "Add Folder" to start monitoring.
            </p>
          )}
          <AnimatePresence>
            {folders.map((f, i) => (
              <motion.div
                key={f.path}
                variants={fadeUp}
                initial="hidden"
                animate="visible"
                exit="exit"
                layout
                className="flex items-center gap-3 p-3 rounded-xl"
                style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.06)' }}
              >
                <FolderOpen size={15} className="text-indigo-400 shrink-0" />
                <span className="text-sm flex-1 truncate" style={{ color: '#C4C4E8' }}>{f.path}</span>
                <button
                  onClick={() => window.electronAPI?.openPath(f.path)}
                  className="p-1 rounded opacity-50 hover:opacity-100 transition-opacity"
                  style={{ color: '#8B8BAD' }}
                  title="Open in Explorer"
                >
                  <ExternalLink size={13} />
                </button>
                <button
                  onClick={() => removeFolder(i)}
                  className="p-1 rounded opacity-50 hover:opacity-100 transition-opacity"
                  style={{ color: '#FCA5A5' }}
                  title="Remove"
                >
                  <Trash2 size={13} />
                </button>
              </motion.div>
            ))}
          </AnimatePresence>
        </div>
        <motion.button
          whileHover={{ scale: 1.02 }} whileTap={{ scale: 0.97 }}
          onClick={addFolder}
          className="btn-ghost w-full justify-center"
        >
          <Plus size={15} />
          Add Folder
        </motion.button>
      </section>

      {/* ── Automation ─────────────────────────────────────────────────────── */}
      <section className="glass-card p-6">
        <h2 className="text-sm font-semibold text-white mb-4">Automation</h2>
        <label className="flex items-center justify-between cursor-pointer">
          <div>
            <p className="text-sm text-white">Auto-approve high-confidence moves</p>
            <p className="text-xs mt-0.5" style={{ color: '#555575' }}>
              Automatically move files when AI confidence is above 90%
            </p>
          </div>
          <div
            onClick={() => setAutoApprove((v) => !v)}
            className="relative w-11 h-6 rounded-full transition-all duration-300 cursor-pointer shrink-0"
            style={{
              background: autoApprove
                ? 'linear-gradient(135deg, #4F46E5, #7C3AED)'
                : 'rgba(255,255,255,0.1)',
            }}
          >
            <motion.div
              animate={{ x: autoApprove ? 20 : 2 }}
              transition={{ type: 'spring', stiffness: 500, damping: 30 }}
              className="absolute top-1 w-4 h-4 bg-white rounded-full shadow"
            />
          </div>
        </label>
      </section>

      {/* ── Learned Rules ──────────────────────────────────────────────────── */}
      <section className="glass-card overflow-hidden">
        <div className="flex items-center justify-between px-6 py-4 border-b"
          style={{ borderColor: 'rgba(255,255,255,0.06)' }}>
          <h2 className="text-sm font-semibold text-white flex items-center gap-2">
            <BookOpen size={15} className="text-violet-400" />
            Learned Rules
            <span className="text-xs px-2 py-0.5 rounded-full"
              style={{ background: 'rgba(79,70,229,.15)', color: '#818CF8', border: '1px solid rgba(79,70,229,.25)' }}>
              {rules.filter((r) => r.is_learned_rule).length} active
            </span>
          </h2>
          <div className="flex items-center gap-2">
            <motion.button
              whileHover={{ scale: 1.05 }} whileTap={{ scale: 0.95 }}
              onClick={loadRules}
              className="p-1.5 rounded-lg transition-all"
              style={{ color: '#555575', background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.07)' }}
              title="Refresh"
            >
              <RefreshCw size={13} className={rulesLoading ? 'animate-spin' : ''} />
            </motion.button>
            {rules.length > 0 && (
              <motion.button
                whileHover={{ scale: 1.04 }} whileTap={{ scale: 0.96 }}
                onClick={() => setClearConfirm(true)}
                className="text-xs px-3 py-1.5 rounded-lg transition-all"
                style={{ background: 'rgba(239,68,68,.1)', color: '#FCA5A5', border: '1px solid rgba(239,68,68,.2)' }}
              >
                Clear All
              </motion.button>
            )}
          </div>
        </div>

        {rulesLoading ? (
          <div className="py-10 text-center text-sm" style={{ color: '#555575' }}>
            <RefreshCw size={18} className="animate-spin mx-auto mb-2" />
            Loading rules…
          </div>
        ) : rules.length === 0 ? (
          <div className="py-10 text-center text-sm" style={{ color: '#555575' }}>
            No learned rules yet. SmartDesk learns from your approvals automatically.
          </div>
        ) : (
          <>
            <div className="grid grid-cols-12 px-6 py-2.5 text-xs font-semibold uppercase tracking-wider"
              style={{ color: '#555575', borderBottom: '1px solid rgba(255,255,255,0.04)' }}>
              <span className="col-span-4">Pattern</span>
              <span className="col-span-2">Extension</span>
              <span className="col-span-3">Destination</span>
              <span className="col-span-2 text-center">Confirmed</span>
              <span className="col-span-1" />
            </div>
            <div className="divide-y" style={{ divideColor: 'rgba(255,255,255,0.04)' }}>
              <AnimatePresence initial={false}>
                {rules.map((rule) => (
                  <motion.div
                    key={rule.id}
                    variants={fadeUp}
                    initial="hidden"
                    animate="visible"
                    exit="exit"
                    layout
                    className="grid grid-cols-12 px-6 py-3 items-center hover:bg-white/[0.02] transition-colors"
                  >
                    <div className="col-span-4 min-w-0">
                      <span className="text-xs font-medium truncate text-white">
                        {rule.pattern_keyword ?? '—'}
                      </span>
                    </div>
                    <div className="col-span-2">
                      <span className="text-xs font-mono px-1.5 py-0.5 rounded"
                        style={{ background: 'rgba(79,70,229,.1)', color: '#818CF8' }}>
                        {rule.extension ?? '*'}
                      </span>
                    </div>
                    <div className="col-span-3 min-w-0">
                      <span className="text-xs truncate" style={{ color: '#C4C4E8' }}
                        title={rule.user_confirmed_folder}>
                        {rule.user_confirmed_folder?.split(/[/\\]/).pop() ?? rule.user_confirmed_folder}
                      </span>
                    </div>
                    <div className="col-span-2 flex items-center justify-center gap-1.5">
                      <span className="text-xs font-semibold"
                        style={{ color: rule.is_learned_rule ? '#34D399' : '#FBBF24' }}>
                        {rule.times_confirmed}×
                      </span>
                      {rule.is_learned_rule && (
                        <CheckCircle2 size={11} style={{ color: '#34D399' }} />
                      )}
                    </div>
                    <div className="col-span-1 flex justify-end">
                      <motion.button
                        whileHover={{ scale: 1.1 }} whileTap={{ scale: 0.9 }}
                        onClick={() => deleteRule(rule.id)}
                        className="p-1 rounded opacity-40 hover:opacity-100 transition-opacity"
                        style={{ color: '#FCA5A5' }}
                        title="Delete rule"
                      >
                        <X size={13} />
                      </motion.button>
                    </div>
                  </motion.div>
                ))}
              </AnimatePresence>
            </div>
          </>
        )}
      </section>

      {/* ── Save button ────────────────────────────────────────────────────── */}
      <motion.button
        whileHover={{ scale: 1.02 }} whileTap={{ scale: 0.97 }}
        onClick={handleSave}
        className="btn-gradient w-full justify-center"
      >
        <Save size={15} />
        {saved ? '✓ Saved!' : 'Save Settings'}
      </motion.button>

      {/* ── Clear rules confirmation ────────────────────────────────────────── */}
      <AnimatePresence>
        {clearConfirm && (
          <motion.div
            initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            className="fixed inset-0 z-50 flex items-center justify-center"
            style={{ background: 'rgba(0,0,0,0.6)', backdropFilter: 'blur(6px)' }}
          >
            <motion.div
              initial={{ scale: 0.9, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              exit={{ scale: 0.9, opacity: 0 }}
              className="glass-card p-6 max-w-sm w-full mx-4 text-center"
            >
              <AlertTriangle size={32} className="mx-auto mb-3" style={{ color: '#FCA5A5' }} />
              <h3 className="text-base font-bold text-white mb-2">Clear All Rules?</h3>
              <p className="text-sm mb-5" style={{ color: '#8B8BAD' }}>
                This will delete all <strong className="text-white">{rules.length}</strong> learned
                rules. SmartDesk will start relearning from your next approvals.
              </p>
              <div className="flex gap-3">
                <button
                  onClick={() => setClearConfirm(false)}
                  className="btn-ghost flex-1 justify-center text-sm py-2"
                >
                  Cancel
                </button>
                <motion.button
                  whileHover={{ scale: 1.03 }} whileTap={{ scale: 0.97 }}
                  onClick={clearAllRules}
                  className="flex-1 py-2 rounded-xl text-sm font-semibold text-white"
                  style={{ background: 'linear-gradient(135deg, #DC2626, #B91C1C)' }}
                >
                  Clear All
                </motion.button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
