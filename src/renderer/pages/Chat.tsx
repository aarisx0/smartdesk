import { useState, useEffect, useRef, useCallback } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
  Send, Mic, Zap, Bot, X, ChevronRight, Eye,
  FolderOpen, FolderSearch, Copy, HardDrive,
  FileText, FileImage, FileVideo, FileAudio, FileCode,
  FileSpreadsheet, FileArchive, File,
  MessageSquare, Brain, CheckCircle2, Sparkles, RefreshCw,
  History, Plus, Trash2, Clock, Save, ChevronLeft,
} from 'lucide-react';
import { type ChatMessage } from '../hooks/useChat';
import { useChatContext } from '../context/ChatContext';
import ApprovalModal from '../components/ApprovalModal';
import ChatApprovalModal from '../components/ChatApprovalModal';
import SearchResults from '../components/SearchResults';
import { apiFetch } from '../lib/apiFetch';

// ─── motion variants ──────────────────────────────────────────────────────────

const pageVariants = {
  hidden:  { opacity: 0, y: 12 },
  visible: { opacity: 1, y: 0,  transition: { duration: 0.3, ease: [0.22, 1, 0.36, 1] } },
  exit:    { opacity: 0, y: -8, transition: { duration: 0.2 } },
};

const msgVariants = {
  hidden:  { opacity: 0, y: 14, scale: 0.97 },
  visible: { opacity: 1, y: 0,  scale: 1,
             transition: { duration: 0.3, ease: [0.22, 1, 0.36, 1] } },
};

const chipVariants = {
  hidden:  { opacity: 0, y: 10, scale: 0.92 },
  visible: (i: number) => ({
    opacity: 1, y: 0, scale: 1,
    transition: { delay: 0.08 + i * 0.06, duration: 0.3, ease: [0.22, 1, 0.36, 1] },
  }),
};

const panelVariants = {
  hidden:  { x: '100%', opacity: 0 },
  visible: { x: 0, opacity: 1,
             transition: { type: 'spring', stiffness: 320, damping: 34 } },
  exit:    { x: '100%', opacity: 0,
             transition: { duration: 0.22, ease: [0.4, 0, 1, 1] } },
};

// ─── quick actions ────────────────────────────────────────────────────────────

const QUICK_ACTIONS = [
  { label: 'Clean Desktop',       icon: FolderOpen,   cmd: 'Clean Desktop'       },
  { label: 'Find a File',         icon: FolderSearch, cmd: 'Find '               },
  { label: 'Show Duplicates',     icon: Copy,         cmd: 'Show duplicates'      },
  { label: 'Storage Report',      icon: HardDrive,    cmd: 'Storage report'       },
  { label: 'Organise Downloads',  icon: Zap,          cmd: 'Organise Downloads'   },
] as const;

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
  '.svg':  { icon: FileImage,       color: '#A78BFA' },
  '.mp4':  { icon: FileVideo,       color: '#FB923C' },
  '.mov':  { icon: FileVideo,       color: '#FB923C' },
  '.mp3':  { icon: FileAudio,       color: '#34D399' },
  '.wav':  { icon: FileAudio,       color: '#34D399' },
  '.js':   { icon: FileCode,        color: '#FBBF24' },
  '.ts':   { icon: FileCode,        color: '#60A5FA' },
  '.py':   { icon: FileCode,        color: '#34D399' },
  '.xlsx': { icon: FileSpreadsheet, color: '#4ADE80' },
  '.csv':  { icon: FileSpreadsheet, color: '#4ADE80' },
  '.zip':  { icon: FileArchive,     color: '#C084FC' },
  '.rar':  { icon: FileArchive,     color: '#C084FC' },
};

function FileTypeIcon({ ext, size = 14 }: { ext: string; size?: number }) {
  const cfg = EXT_CFG[ext?.toLowerCase()] ?? { icon: File, color: '#8B8BAD' };
  const Icon = cfg.icon;
  return <Icon size={size} style={{ color: cfg.color, flexShrink: 0 }} />;
}

function formatBytes(b: number | null): string {
  if (!b) return '—';
  if (b >= 1_048_576) return `${(b / 1_048_576).toFixed(1)} MB`;
  if (b >= 1_024)     return `${(b / 1_024).toFixed(0)} KB`;
  return `${b} B`;
}

// ─── ICON name → component map (for action cards) ────────────────────────────

const ICON_MAP: Record<string, React.ElementType> = {
  FolderOpen, Copy, HardDrive, CheckCircle2, FolderSearch,
  Sparkles, Zap, RefreshCw, FileText,
};

// ─── typing indicator ─────────────────────────────────────────────────────────

function TypingIndicator() {
  return (
    <motion.div
      variants={msgVariants}
      initial="hidden"
      animate="visible"
      exit={{ opacity: 0, scale: 0.9, transition: { duration: 0.15 } }}
      className="flex items-end gap-2.5 mb-4"
    >
      {/* Avatar */}
      <div className="w-7 h-7 rounded-xl flex items-center justify-center shrink-0"
        style={{ background: 'linear-gradient(135deg,#4F46E5,#7C3AED)',
                 boxShadow: '0 0 10px rgba(79,70,229,.4)' }}>
        <Zap size={13} className="text-white" />
      </div>
      <div className="px-4 py-3 rounded-2xl rounded-bl-sm"
        style={{
          background: 'rgba(20,20,43,0.8)',
          border: '1px solid rgba(255,255,255,0.07)',
          backdropFilter: 'blur(12px)',
        }}>
        <div className="flex items-center gap-1.5">
          {[0, 1, 2].map((i) => (
            <motion.span
              key={i}
              className="w-1.5 h-1.5 rounded-full"
              style={{ background: '#818CF8' }}
              animate={{ opacity: [0.3, 1, 0.3], scale: [0.8, 1.2, 0.8] }}
              transition={{ repeat: Infinity, duration: 1.2, delay: i * 0.18, ease: 'easeInOut' }}
            />
          ))}
        </div>
      </div>
    </motion.div>
  );
}

// ─── full markdown renderer (no external library) ────────────────────────────

function MarkdownRenderer({ text }: { text: string }) {
  const CODE_BG   = 'rgba(20,20,43,0.5)';
  const BORDER    = 'rgba(255,255,255,0.07)';
  const TEXT_CLR  = '#C4C4E8';

  // Inline styles helper — applies bold / italic / inline-code to a chunk of text.
  function renderInline(chunk: string, keyPrefix: string): React.ReactNode[] {
    // Split on: **bold**, *italic*, `code`
    const INLINE = /(\*\*[^*]+\*\*|\*[^*]+\*|`[^`]+`)/g;
    const parts = chunk.split(INLINE);
    return parts.map((part, i) => {
      const key = `${keyPrefix}-i${i}`;
      if (part.startsWith('**') && part.endsWith('**')) {
        return (
          <strong key={key} style={{ color: '#E0E0FF', fontWeight: 700 }}>
            {part.slice(2, -2)}
          </strong>
        );
      }
      if (part.startsWith('*') && part.endsWith('*') && part.length > 2) {
        return <em key={key} style={{ fontStyle: 'italic', color: '#C4C4E8' }}>{part.slice(1, -1)}</em>;
      }
      if (part.startsWith('`') && part.endsWith('`') && part.length > 2) {
        return (
          <code
            key={key}
            style={{
              background: CODE_BG,
              border: `1px solid ${BORDER}`,
              borderRadius: 4,
              padding: '1px 5px',
              fontFamily: 'monospace',
              fontSize: '0.85em',
              color: '#A5B4FC',
            }}
          >
            {part.slice(1, -1)}
          </code>
        );
      }
      return <span key={key}>{part}</span>;
    });
  }

  // Parse a table block (array of raw lines including separator)
  function renderTable(lines: string[], tableKey: string): React.ReactNode {
    const rows = lines
      .filter((l) => !l.match(/^\s*\|[-| :]+\|\s*$/))   // drop separator rows
      .map((l) =>
        l
          .replace(/^\s*\|/, '')
          .replace(/\|\s*$/, '')
          .split('|')
          .map((cell) => cell.trim())
      );
    if (rows.length === 0) return null;
    const [headerRow, ...bodyRows] = rows;
    return (
      <div
        key={tableKey}
        style={{ overflowX: 'auto', marginBottom: 10 }}
      >
        <table
          style={{
            borderCollapse: 'collapse',
            width: '100%',
            fontSize: '0.82em',
            color: TEXT_CLR,
          }}
        >
          <thead>
            <tr>
              {headerRow.map((cell, ci) => (
                <th
                  key={ci}
                  style={{
                    borderBottom: `1px solid ${BORDER}`,
                    padding: '4px 10px',
                    textAlign: 'left',
                    fontWeight: 600,
                    color: '#E0E0FF',
                  }}
                >
                  {renderInline(cell, `${tableKey}-h${ci}`)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {bodyRows.map((row, ri) => (
              <tr key={ri}>
                {row.map((cell, ci) => (
                  <td
                    key={ci}
                    style={{
                      borderBottom: `1px solid rgba(255,255,255,0.04)`,
                      padding: '4px 10px',
                    }}
                  >
                    {renderInline(cell, `${tableKey}-r${ri}c${ci}`)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  }

  // Build the block-level elements
  const elements: React.ReactNode[] = [];
  const lines = text.split('\n');
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // ── Fenced code block ```...``` ──────────────────────────────────────────
    if (line.trimStart().startsWith('```')) {
      const lang = line.trimStart().slice(3).trim();
      const codeLines: string[] = [];
      i++;
      while (i < lines.length && !lines[i].trimStart().startsWith('```')) {
        codeLines.push(lines[i]);
        i++;
      }
      i++; // consume closing ```
      elements.push(
        <pre
          key={`code-${i}`}
          style={{
            background: CODE_BG,
            border: `1px solid ${BORDER}`,
            borderRadius: 8,
            padding: '10px 14px',
            overflowX: 'auto',
            fontSize: '0.82em',
            fontFamily: 'monospace',
            color: '#A5B4FC',
            margin: '6px 0',
            whiteSpace: 'pre',
          }}
        >
          {lang && (
            <span
              style={{
                display: 'block',
                fontSize: '0.75em',
                color: '#555575',
                marginBottom: 6,
              }}
            >
              {lang}
            </span>
          )}
          <code>{codeLines.join('\n')}</code>
        </pre>
      );
      continue;
    }

    // ── Table block ──────────────────────────────────────────────────────────
    if (line.trimStart().startsWith('|')) {
      const tableLines: string[] = [];
      while (i < lines.length && lines[i].trimStart().startsWith('|')) {
        tableLines.push(lines[i]);
        i++;
      }
      elements.push(renderTable(tableLines, `table-${i}`));
      continue;
    }

    // ── Heading # / ## ───────────────────────────────────────────────────────
    const h2Match = line.match(/^##\s+(.*)/);
    if (h2Match) {
      elements.push(
        <p
          key={`h2-${i}`}
          style={{
            fontWeight: 700,
            fontSize: '0.95em',
            color: '#E0E0FF',
            margin: '8px 0 2px',
          }}
        >
          {renderInline(h2Match[1], `h2-${i}`)}
        </p>
      );
      i++;
      continue;
    }

    const h1Match = line.match(/^#\s+(.*)/);
    if (h1Match) {
      elements.push(
        <p
          key={`h1-${i}`}
          style={{
            fontWeight: 800,
            fontSize: '1.05em',
            color: '#E0E0FF',
            margin: '10px 0 4px',
          }}
        >
          {renderInline(h1Match[1], `h1-${i}`)}
        </p>
      );
      i++;
      continue;
    }

    // ── Unordered list block (- / *) ─────────────────────────────────────────
    if (line.match(/^\s*[-*]\s+/)) {
      const listItems: string[] = [];
      while (i < lines.length && lines[i].match(/^\s*[-*]\s+/)) {
        listItems.push(lines[i].replace(/^\s*[-*]\s+/, ''));
        i++;
      }
      elements.push(
        <ul
          key={`ul-${i}`}
          style={{
            paddingLeft: 18,
            margin: '4px 0',
            listStyleType: 'disc',
          }}
        >
          {listItems.map((item, li) => (
            <li
              key={li}
              style={{ margin: '2px 0', color: TEXT_CLR, lineHeight: 1.6 }}
            >
              {renderInline(item, `ul-${i}-${li}`)}
            </li>
          ))}
        </ul>
      );
      continue;
    }

    // ── Blank line → paragraph break ─────────────────────────────────────────
    if (line.trim() === '') {
      elements.push(<br key={`br-${i}`} />);
      i++;
      continue;
    }

    // ── Plain text paragraph ──────────────────────────────────────────────────
    elements.push(
      <span key={`p-${i}`} style={{ display: 'block', marginBottom: 2 }}>
        {renderInline(line, `p-${i}`)}
      </span>
    );
    i++;
  }

  return <>{elements}</>;
}

// ─── message renderers ────────────────────────────────────────────────────────

interface MsgProps { msg: ChatMessage; onApprovalCta?: () => void; onDetailsCta?: () => void }

/** User bubble — right-aligned gradient */
function UserBubble({ msg }: MsgProps) {
  if (msg.payload.type !== 'text') return null;
  return (
    <motion.div
      variants={msgVariants}
      initial="hidden"
      animate="visible"
      className="flex justify-end mb-4"
    >
      <div className="max-w-[68%] px-4 py-2.5 rounded-2xl rounded-br-sm text-sm font-medium text-white"
        style={{
          background: 'linear-gradient(135deg,#4F46E5,#7C3AED)',
          boxShadow: '0 2px 16px rgba(79,70,229,.35)',
        }}>
        {msg.payload.text}
      </div>
    </motion.div>
  );
}

/** AI text bubble */
function AITextBubble({ msg }: MsgProps) {
  if (msg.payload.type !== 'text') return null;
  return (
    <motion.div
      variants={msgVariants}
      initial="hidden"
      animate="visible"
      className="flex items-end gap-2.5 mb-4"
    >
      <SmartDeskAvatar />
      <div className="max-w-[72%] px-4 py-3 rounded-2xl rounded-bl-sm text-sm"
        style={{
          background: 'rgba(20,20,43,0.82)',
          border: '1px solid rgba(255,255,255,0.08)',
          backdropFilter: 'blur(16px)',
          color: '#C4C4E8',
          lineHeight: 1.65,
        }}>
        <MarkdownRenderer text={msg.payload.text} />
      </div>
    </motion.div>
  );
}

/** AI action summary card */
function AIActionCard({ msg, onApprovalCta, onDetailsCta }: MsgProps) {
  if (msg.payload.type !== 'action') return null;
  const { action } = msg.payload;
  const Icon = ICON_MAP[action.icon] ?? FolderOpen;

  const glowColor = action.count === 0 ? '#34D399' : '#818CF8';

  // Only show Details button for plan-backed actions (those that open the approval modal)
  const isPlanAction =
    action.ctaTarget === 'chat-approval-plan' || action.ctaTarget === 'approval';

  return (
    <motion.div
      variants={msgVariants}
      initial="hidden"
      animate="visible"
      className="flex items-end gap-2.5 mb-4"
    >
      <SmartDeskAvatar />
      <motion.div
        whileHover={{ y: -2 }}
        className="max-w-[78%] rounded-2xl rounded-bl-sm overflow-hidden"
        style={{
          background: 'rgba(20,20,43,0.88)',
          border: '1px solid rgba(255,255,255,0.09)',
          backdropFilter: 'blur(20px)',
        }}
      >
        {/* Card header */}
        <div className="flex items-center gap-3 px-4 py-3.5 border-b"
          style={{ borderColor: 'rgba(255,255,255,0.06)' }}>
          <div className="w-9 h-9 rounded-xl flex items-center justify-center shrink-0"
            style={{
              background: `${glowColor}18`,
              border: `1px solid ${glowColor}30`,
            }}>
            <Icon size={17} style={{ color: glowColor }} />
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-sm font-semibold text-white">{action.label}</p>
            <p className="text-xs mt-0.5" style={{ color: '#8B8BAD' }}>{action.detail}</p>
          </div>
          {action.count > 0 && (
            <span className="text-xs font-bold px-2.5 py-1 rounded-full shrink-0"
              style={{
                background: `${glowColor}18`,
                color: glowColor,
                border: `1px solid ${glowColor}30`,
                filter: `drop-shadow(0 0 4px ${glowColor}55)`,
              }}>
              {action.count}
            </span>
          )}
        </div>

        {/* CTA buttons row */}
        {action.cta && (
          <div className="px-4 py-3 flex items-center gap-2 flex-wrap">
            {/* Details button — only for plan actions */}
            {isPlanAction && (
              <motion.button
                whileHover={{ scale: 1.03 }}
                whileTap={{ scale: 0.97 }}
                onClick={() => {
                  if (action.ctaTarget === 'approval' || action.ctaTarget === 'chat-approval-plan')
                    onDetailsCta?.();
                }}
                className="flex items-center gap-2 text-xs font-semibold px-4 py-2 rounded-xl
                           transition-all duration-150"
                style={{
                  background: 'rgba(129,140,248,0.12)',
                  color: '#818CF8',
                  border: '1px solid rgba(129,140,248,0.25)',
                }}
              >
                <Eye size={12} />
                Details
              </motion.button>
            )}

            {/* Primary approve/action button */}
            <motion.button
              whileHover={{ scale: 1.03 }}
              whileTap={{ scale: 0.97 }}
              onClick={() => {
                if (action.ctaTarget === 'approval' || action.ctaTarget === 'chat-approval-plan')
                  onApprovalCta?.();
              }}
              className="flex items-center gap-2 text-xs font-semibold px-4 py-2 rounded-xl
                         transition-all duration-150"
              style={{
                background: 'linear-gradient(135deg,#4F46E5,#7C3AED)',
                color: '#fff',
                boxShadow: '0 0 14px rgba(79,70,229,.35)',
              }}
            >
              <ChevronRight size={13} />
              {action.cta}
            </motion.button>
          </div>
        )}
      </motion.div>
    </motion.div>
  );
}

/** AI file-list card — delegates to SearchResults component */
function AIFileListCard({ msg }: MsgProps) {
  if (msg.payload.type !== 'file-list') return null;
  const { results, meta, query } = msg.payload;

  return (
    <motion.div
      variants={msgVariants}
      initial="hidden"
      animate="visible"
      className="flex items-start gap-2.5 mb-4 w-full"
    >
      <SmartDeskAvatar />
      {/* Allow the search results panel to take most of the width */}
      <div className="flex-1 min-w-0 rounded-2xl rounded-tl-sm overflow-hidden"
        style={{
          background: 'rgba(20,20,43,0.88)',
          border: '1px solid rgba(255,255,255,0.09)',
          backdropFilter: 'blur(20px)',
          padding: '16px',
        }}>
        <SearchResults results={results} meta={meta} query={query} />
      </div>
    </motion.div>
  );
}

/** AI storage stats card */
function AIStatsCard({ msg }: MsgProps) {
  if (msg.payload.type !== 'stats') return null;
  const { stats } = msg.payload;

  const healthColor = stats.healthScore >= 80 ? '#34D399'
                    : stats.healthScore >= 50 ? '#FBBF24'
                    : '#F87171';

  return (
    <motion.div
      variants={msgVariants}
      initial="hidden"
      animate="visible"
      className="flex items-end gap-2.5 mb-4"
    >
      <SmartDeskAvatar />
      <div className="max-w-[82%] rounded-2xl rounded-bl-sm overflow-hidden"
        style={{
          background: 'rgba(20,20,43,0.88)',
          border: '1px solid rgba(255,255,255,0.09)',
          backdropFilter: 'blur(20px)',
        }}>
        {/* Title row */}
        <div className="flex items-center gap-2 px-4 py-3.5 border-b"
          style={{ borderColor: 'rgba(255,255,255,0.06)' }}>
          <HardDrive size={15} className="text-indigo-400" />
          <span className="text-sm font-semibold text-white">Storage Report</span>
          <span className="ml-auto text-xs font-bold px-2.5 py-0.5 rounded-full"
            style={{
              background: `${healthColor}18`,
              color: healthColor,
              border: `1px solid ${healthColor}30`,
              filter: `drop-shadow(0 0 4px ${healthColor}55)`,
            }}>
            {stats.healthScore}% organised
          </span>
        </div>

        {/* Stats grid */}
        <div className="grid grid-cols-3 gap-px p-4 pt-3">
          {[
            { label: 'Total Files',   value: stats.totalFiles.toLocaleString(),    color: '#818CF8' },
            { label: 'Organised',     value: stats.organizedFiles.toLocaleString(), color: '#34D399' },
            { label: 'Pending',       value: stats.pendingFiles.toLocaleString(),   color: '#FBBF24' },
          ].map(({ label, value, color }) => (
            <div key={label} className="text-center p-3 rounded-xl"
              style={{ background: `${color}0d`, border: `1px solid ${color}25` }}>
              <p className="text-base font-extrabold"
                style={{ color, filter: `drop-shadow(0 0 5px ${color}55)` }}>{value}</p>
              <p className="text-xs mt-0.5" style={{ color: '#8B8BAD' }}>{label}</p>
            </div>
          ))}
        </div>

        {/* Top extensions */}
        {stats.topExtensions.length > 0 && (
          <div className="px-4 pb-4">
            <p className="text-xs font-semibold mb-2" style={{ color: '#555575' }}>
              Top file types
            </p>
            <div className="flex flex-wrap gap-1.5">
              {stats.topExtensions.map(({ ext, count }) => (
                <span key={ext} className="text-xs px-2 py-0.5 rounded-full flex items-center gap-1"
                  style={{
                    background: 'rgba(79,70,229,.12)',
                    border: '1px solid rgba(79,70,229,.22)',
                    color: '#818CF8',
                  }}>
                  <FileTypeIcon ext={ext} size={10} />
                  {ext} · {count}
                </span>
              ))}
            </div>
          </div>
        )}
      </div>
    </motion.div>
  );
}

/** Error bubble */
function AIErrorBubble({ msg }: MsgProps) {
  if (msg.payload.type !== 'error') return null;
  return (
    <motion.div
      variants={msgVariants}
      initial="hidden"
      animate="visible"
      className="flex items-end gap-2.5 mb-4"
    >
      <SmartDeskAvatar />
      <div className="max-w-[72%] px-4 py-3 rounded-2xl rounded-bl-sm text-xs"
        style={{
          background: 'rgba(239,68,68,.1)',
          border: '1px solid rgba(239,68,68,.22)',
          color: '#FCA5A5',
        }}>
        {msg.payload.text}
      </div>
    </motion.div>
  );
}

/** SmartDesk avatar pill */
function SmartDeskAvatar() {
  return (
    <div className="w-7 h-7 rounded-xl flex items-center justify-center shrink-0"
      style={{
        background: 'linear-gradient(135deg,#4F46E5,#7C3AED)',
        boxShadow: '0 0 10px rgba(79,70,229,.4)',
        alignSelf: 'flex-end',
        marginBottom: 2,
      }}>
      <Zap size={13} className="text-white" />
    </div>
  );
}

/** Route a message to the right renderer */
function MessageRenderer({ msg, onApprovalCta, onDetailsCta }: { msg: ChatMessage; onApprovalCta?: () => void; onDetailsCta?: () => void }) {
  if (msg.role === 'user') return <UserBubble msg={msg} />;

  switch (msg.payload.type) {
    case 'text':      return <AITextBubble msg={msg} />;
    case 'action':    return <AIActionCard msg={msg} onApprovalCta={onApprovalCta} onDetailsCta={onDetailsCta} />;
    case 'file-list': return <AIFileListCard msg={msg} />;
    case 'stats':     return <AIStatsCard msg={msg} />;
    case 'error':     return <AIErrorBubble msg={msg} />;
    default:          return null;
  }
}

// ─── watsonx AI side panel ────────────────────────────────────────────────────

function WatsonxPanel({ onClose }: { onClose: () => void }) {
  // Load the wxo embed from a local HTML file served by Vite.
  // In dev: http://localhost:5173/src/renderer/wxo-chat.html
  // In prod: dist/renderer/wxo-chat.html (relative path)
  const isDev = window.location.protocol === 'http:';
  const wxoSrc = isDev
    ? 'http://localhost:5173/src/renderer/wxo-chat.html'
    : './wxo-chat.html';

  return (
    <motion.div
      key="watson-panel"
      variants={panelVariants}
      initial="hidden"
      animate="visible"
      exit="exit"
      className="flex flex-col shrink-0 border-l overflow-hidden"
      style={{
        width: 420,
        background: 'rgba(12,12,24,0.97)',
        borderColor: 'rgba(255,255,255,0.07)',
        backdropFilter: 'blur(24px)',
      }}
    >
      {/* Panel header */}
      <div className="flex items-center justify-between px-4 py-3.5 border-b shrink-0"
        style={{ borderColor: 'rgba(255,255,255,0.07)' }}>
        <div className="flex items-center gap-2.5">
          <div className="w-8 h-8 rounded-xl flex items-center justify-center"
            style={{ background: 'linear-gradient(135deg,#4F46E5,#7C3AED)', boxShadow: '0 0 14px rgba(79,70,229,.5)' }}>
            <Brain size={16} className="text-white" />
          </div>
          <div>
            <p className="text-xs font-bold text-white leading-none">SmartDesk AI Assistant</p>
            <p className="text-[10px] mt-0.5" style={{ color: '#8B8BAD' }}>
              IBM watsonx™ Orchestrate
            </p>
          </div>
        </div>
        <motion.button
          whileHover={{ scale: 1.1, rotate: 90 }} whileTap={{ scale: 0.9 }}
          transition={{ duration: 0.18 }}
          onClick={onClose}
          className="w-7 h-7 rounded-lg flex items-center justify-center"
          style={{ background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.08)', color: '#8B8BAD' }}
        >
          <X size={13} />
        </motion.button>
      </div>

      {/* wxo embed — loaded from local HTML file, no sandbox restrictions */}
      <div className="flex-1 relative overflow-hidden">
        <iframe
          src={wxoSrc}
          className="absolute inset-0 w-full h-full border-0"
          title="IBM watsonx Orchestrate"
          allow="clipboard-read; clipboard-write"
        />
      </div>

      <div className="px-4 py-2 border-t flex items-center justify-center shrink-0"
        style={{ borderColor: 'rgba(255,255,255,0.06)' }}>
        <span className="text-[10px] font-semibold"
          style={{ background: 'linear-gradient(135deg,#818CF8,#A78BFA)', WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent' }}>
          Powered by IBM watsonx™ Orchestrate
        </span>
      </div>
    </motion.div>
  );
}

// ─── empty state ──────────────────────────────────────────────────────────────

function EmptyState() {
  return (
    <motion.div
      initial={{ opacity: 0, scale: 0.95 }}
      animate={{ opacity: 1, scale: 1, transition: { duration: 0.4, delay: 0.1 } }}
      className="flex flex-col items-center justify-center h-full gap-5 py-16 select-none"
    >
      {/* Glow logo */}
      <motion.div
        animate={{ boxShadow: ['0 0 16px rgba(79,70,229,.3)', '0 0 36px rgba(79,70,229,.6)', '0 0 16px rgba(79,70,229,.3)'] }}
        transition={{ repeat: Infinity, duration: 3, ease: 'easeInOut' }}
        className="w-16 h-16 rounded-2xl flex items-center justify-center"
        style={{ background: 'linear-gradient(135deg,#4F46E5,#7C3AED)' }}
      >
        <Bot size={30} className="text-white" />
      </motion.div>
      <div className="text-center">
        <p className="text-base font-bold text-white">SmartDesk Command Centre</p>
        <p className="text-xs mt-1.5 max-w-xs leading-relaxed" style={{ color: '#8B8BAD' }}>
          Type a command or tap a quick action below.<br />
          I'll handle your files so you don't have to.
        </p>
      </div>
    </motion.div>
  );
}

// ─── chat input bar ───────────────────────────────────────────────────────────

interface InputBarProps {
  onSend: (text: string) => void;
  disabled?: boolean;
}

function InputBar({ onSend, disabled }: InputBarProps) {
  const [text, setText] = useState('');
  const [focused, setFocused] = useState(false);

  const submit = () => {
    const trimmed = text.trim();
    if (!trimmed || disabled) return;
    onSend(trimmed);
    setText('');
  };

  return (
    <div className="relative flex items-center gap-2">
      <motion.div
        className="flex-1 flex items-center gap-2 rounded-2xl px-4 py-2.5 transition-all duration-200"
        style={{
          background: 'rgba(20,20,43,0.8)',
          border: focused
            ? '1px solid rgba(79,70,229,.55)'
            : '1px solid rgba(255,255,255,0.08)',
          backdropFilter: 'blur(16px)',
          boxShadow: focused
            ? '0 0 0 3px rgba(79,70,229,.14), 0 0 16px rgba(79,70,229,.2)'
            : 'none',
        }}
        onFocusCapture={() => setFocused(true)}
        onBlurCapture={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
            setFocused(false);
          }
        }}
      >
        <input
          type="text"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit(); } }}
          disabled={disabled}
          placeholder="Type a command or ask a question…"
          className="flex-1 bg-transparent outline-none text-sm"
          style={{ color: '#E0E0F0' }}
        />
        <motion.button
          whileHover={{ scale: 1.05 }}
          whileTap={{ scale: 0.92 }}
          type="button"
          className="p-1.5 rounded-xl transition-all"
          style={{ color: '#555575' }}
          title="Voice input (coming soon)"
        >
          <Mic size={16} />
        </motion.button>
      </motion.div>

      {/* Send button */}
      <motion.button
        whileHover={{ scale: 1.06 }}
        whileTap={{ scale: 0.93 }}
        onClick={submit}
        disabled={!text.trim() || disabled}
        className="w-10 h-10 rounded-2xl flex items-center justify-center shrink-0 transition-all"
        style={{
          background: text.trim() && !disabled
            ? 'linear-gradient(135deg,#4F46E5,#7C3AED)'
            : 'rgba(255,255,255,0.06)',
          boxShadow: text.trim() && !disabled ? '0 0 18px rgba(79,70,229,.45)' : 'none',
          border: '1px solid rgba(255,255,255,0.08)',
          color: text.trim() && !disabled ? '#fff' : '#555575',
          transition: 'all 0.2s',
        }}
      >
        <Send size={16} />
      </motion.button>
    </div>
  );
}

// ─── chat history panel ───────────────────────────────────────────────────────

interface SessionSummary {
  id: string;
  title: string;
  message_count: number;
  updated_at: string;
}

interface ChatHistoryPanelProps {
  onLoad:   (id: string) => void;
  onDelete: (id: string) => void;
  onNew:    () => void;
  onSave:   () => Promise<string | null>;
  onClose:  () => void;
  currentId: string | null;
  hasMessages: boolean;
}

function ChatHistoryPanel({ onLoad, onDelete, onNew, onSave, onClose, currentId, hasMessages }: ChatHistoryPanelProps) {
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [loading, setLoading]   = useState(true);
  const [saving, setSaving]     = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saveOk, setSaveOk]     = useState(false);

  const fetchSessions = useCallback(async () => {
    setLoading(true);
    try {
      const res  = await apiFetch('/api/sessions');
      if (!res.ok) throw new Error(`Server error: ${res.status}`);
      const data = await res.json() as SessionSummary[];
      setSessions(Array.isArray(data) ? data : []);
    } catch (err) {
      console.error('[ChatHistoryPanel] fetchSessions:', err);
      setSessions([]);
    }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { fetchSessions(); }, [fetchSessions]);

  const handleSave = async () => {
    setSaving(true);
    setSaveError(null);
    setSaveOk(false);
    try {
      const id = await onSave();
      if (id) {
        setSaveOk(true);
        setTimeout(() => setSaveOk(false), 2000);
        await fetchSessions();
      } else {
        setSaveError('Save failed — check that the database schema has been applied.');
      }
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : 'Save failed');
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    await onDelete(id);
    setSessions((s) => s.filter((x) => x.id !== id));
  };

  function relativeTime(iso: string): string {
    const diff = Date.now() - new Date(iso).getTime();
    const mins = Math.floor(diff / 60_000);
    if (mins < 1)  return 'just now';
    if (mins < 60) return `${mins}m ago`;
    const hrs = Math.floor(mins / 60);
    if (hrs < 24)  return `${hrs}h ago`;
    return `${Math.floor(hrs / 24)}d ago`;
  }

  return (
    <motion.div
      initial={{ x: -280, opacity: 0 }}
      animate={{ x: 0, opacity: 1 }}
      exit={{ x: -280, opacity: 0 }}
      transition={{ type: 'spring', stiffness: 340, damping: 36 }}
      className="flex flex-col shrink-0 border-r overflow-hidden"
      style={{
        width: 268,
        background: 'rgba(12,12,28,0.97)',
        borderColor: 'rgba(255,255,255,0.07)',
        backdropFilter: 'blur(20px)',
      }}
    >
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3.5 border-b shrink-0"
        style={{ borderColor: 'rgba(255,255,255,0.07)' }}>
        <div className="flex items-center gap-2">
          <History size={15} className="text-indigo-400" />
          <span className="text-sm font-semibold text-white">Chat History</span>
        </div>
        <motion.button whileHover={{ scale: 1.1 }} whileTap={{ scale: 0.9 }}
          onClick={onClose}
          className="w-6 h-6 rounded-lg flex items-center justify-center"
          style={{ background: 'rgba(255,255,255,0.05)', color: '#8B8BAD' }}
        >
          <ChevronLeft size={13} />
        </motion.button>
      </div>

      {/* Action buttons */}
      <div className="px-3 py-2.5 flex gap-2 border-b shrink-0"
        style={{ borderColor: 'rgba(255,255,255,0.06)' }}>
        <motion.button whileHover={{ scale: 1.03 }} whileTap={{ scale: 0.97 }}
          onClick={onNew}
          className="flex-1 flex items-center justify-center gap-1.5 py-2 rounded-xl text-xs font-semibold"
          style={{ background: 'rgba(79,70,229,0.15)', color: '#818CF8', border: '1px solid rgba(79,70,229,0.25)' }}
        >
          <Plus size={12} /> New Chat
        </motion.button>
        {hasMessages && (
          <motion.button whileHover={{ scale: 1.03 }} whileTap={{ scale: 0.97 }}
            onClick={handleSave}
            disabled={saving}
            className="flex-1 flex items-center justify-center gap-1.5 py-2 rounded-xl text-xs font-semibold"
            style={{
              background: saveOk ? 'rgba(52,211,153,0.2)' : 'rgba(52,211,153,0.1)',
              color: saveOk ? '#6EE7B7' : '#34D399',
              border: `1px solid ${saveOk ? 'rgba(52,211,153,0.4)' : 'rgba(52,211,153,0.2)'}`,
            }}
          >
            <Save size={12} /> {saving ? 'Saving…' : saveOk ? 'Saved ✓' : 'Save'}
          </motion.button>
        )}
      </div>
      {/* Save error */}
      {saveError && (
        <div className="px-3 py-2 text-[10px] shrink-0"
          style={{ color: '#FCA5A5', background: 'rgba(239,68,68,0.08)', borderBottom: '1px solid rgba(239,68,68,0.12)' }}>
          ⚠ {saveError}
        </div>
      )}

      {/* Session list */}
      <div className="flex-1 overflow-y-auto py-2 px-2">
        {loading ? (
          <div className="flex items-center justify-center py-10">
            <RefreshCw size={16} className="animate-spin text-indigo-400" />
          </div>
        ) : sessions.length === 0 ? (
          <div className="text-center py-10 px-4">
            <Clock size={24} className="mx-auto mb-2" style={{ color: '#555575' }} />
            <p className="text-xs" style={{ color: '#555575' }}>No saved chats yet.</p>
            <p className="text-xs mt-1" style={{ color: '#555575' }}>Click Save to keep this conversation.</p>
          </div>
        ) : (
          <div className="space-y-1">
            {sessions.map((s) => (
              <motion.div
                key={s.id}
                whileHover={{ backgroundColor: 'rgba(79,70,229,0.1)' }}
                onClick={() => onLoad(s.id)}
                className="group flex items-start justify-between gap-2 px-3 py-2.5 rounded-xl cursor-pointer transition-all"
                style={{
                  background: s.id === currentId ? 'rgba(79,70,229,0.16)' : 'transparent',
                  border: s.id === currentId ? '1px solid rgba(79,70,229,0.28)' : '1px solid transparent',
                }}
              >
                <div className="flex-1 min-w-0">
                  <p className="text-xs font-medium truncate leading-snug"
                    style={{ color: s.id === currentId ? '#C4C4FF' : '#C4C4E8' }}>
                    {s.title}
                  </p>
                  <div className="flex items-center gap-2 mt-0.5">
                    <span className="text-[10px]" style={{ color: '#555575' }}>
                      {s.message_count} msg{s.message_count !== 1 ? 's' : ''}
                    </span>
                    <span className="text-[10px]" style={{ color: '#555575' }}>·</span>
                    <span className="text-[10px]" style={{ color: '#555575' }}>
                      {relativeTime(s.updated_at)}
                    </span>
                  </div>
                </div>
                <motion.button
                  whileHover={{ scale: 1.15 }}
                  whileTap={{ scale: 0.9 }}
                  onClick={(e) => handleDelete(s.id, e)}
                  className="opacity-0 group-hover:opacity-100 shrink-0 w-6 h-6 rounded-lg flex items-center justify-center transition-opacity"
                  style={{ background: 'rgba(239,68,68,0.15)', color: '#F87171' }}
                >
                  <Trash2 size={11} />
                </motion.button>
              </motion.div>
            ))}
          </div>
        )}
      </div>
    </motion.div>
  );
}

// ─── MAIN PAGE COMPONENT ──────────────────────────────────────────────────────

export default function Chat() {
  const {
    messages, typing,
    approvalFiles, clearApprovalFiles,
    approvalPlan, clearApprovalPlan,
    openPlanModalRef,
    sendMessage, sendQuickAction,
    pushMessage,
    saveSession, loadSession, newSession, deleteSession,
    currentSessionId,
  } = useChatContext();

  const [modalOpen, setModalOpen]         = useState(false);
  const [planModalOpen, setPlanModalOpen] = useState(false);
  const [planModalMode, setPlanModalMode] = useState<'approve' | 'details'>('approve');
  const [historyOpen, setHistoryOpen]     = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, typing]);

  useEffect(() => {
    if (approvalFiles && approvalFiles.length > 0) setModalOpen(true);
  }, [approvalFiles]);

  useEffect(() => {
    openPlanModalRef.current = () => {
      setPlanModalMode('approve');
      setPlanModalOpen(true);
    };
    return () => { openPlanModalRef.current = null; };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Auto-save current session 5 seconds after the last message (debounced)
  const autoSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (messages.length === 0) return;
    if (autoSaveTimerRef.current) clearTimeout(autoSaveTimerRef.current);
    autoSaveTimerRef.current = setTimeout(() => {
      saveSession().catch((err) => {
        console.warn('[Chat] auto-save failed silently:', err?.message ?? err);
      });
    }, 5_000);
    return () => {
      if (autoSaveTimerRef.current) clearTimeout(autoSaveTimerRef.current);
    };
  }, [messages, saveSession]);

  const handleApprovalCta = useCallback(() => {
    if (approvalPlan) {
      setPlanModalMode('approve');
      setPlanModalOpen(true);
    } else {
      setModalOpen(true);
    }
  }, [approvalPlan]);

  const handleDetailsCta = useCallback(() => {
    if (approvalPlan) {
      setPlanModalMode('details');
      setPlanModalOpen(true);
    }
  }, [approvalPlan]);

  const handleLoadSession = useCallback(async (id: string) => {
    await loadSession(id);
    setHistoryOpen(false);
  }, [loadSession]);

  return (
    <motion.div
      variants={pageVariants}
      initial="hidden"
      animate="visible"
      exit="exit"
      className="flex h-full overflow-hidden"
      style={{ minHeight: 0 }}
    >
      {/* ── History panel (slides in from left) ─────────────────────────── */}
      <AnimatePresence>
        {historyOpen && (
          <ChatHistoryPanel
            key="history"
            onLoad={handleLoadSession}
            onDelete={deleteSession}
            onNew={() => { newSession(); setHistoryOpen(false); }}
            onSave={saveSession}
            onClose={() => setHistoryOpen(false)}
            currentId={currentSessionId}
            hasMessages={messages.length > 0}
          />
        )}
      </AnimatePresence>

      {/* ── Main chat column ─────────────────────────────────────────────── */}
      <div className="flex flex-col flex-1 overflow-hidden min-w-0">

        {/* ── Header ────────────────────────────────────────────────────── */}
        <div className="flex items-center justify-between px-1 pb-4 shrink-0">
          <div className="flex items-center gap-3">
            {/* History toggle */}
            <motion.button
              whileHover={{ scale: 1.08 }}
              whileTap={{ scale: 0.93 }}
              onClick={() => setHistoryOpen((v) => !v)}
              className="w-8 h-8 rounded-xl flex items-center justify-center transition-all"
              style={{
                background: historyOpen ? 'rgba(79,70,229,0.2)' : 'rgba(255,255,255,0.05)',
                border: historyOpen ? '1px solid rgba(79,70,229,0.35)' : '1px solid rgba(255,255,255,0.08)',
                color: historyOpen ? '#818CF8' : '#8B8BAD',
              }}
              title="Chat History"
            >
              <History size={15} />
            </motion.button>
            <div>
              <h1 className="text-xl font-bold text-white flex items-center gap-2">
                <MessageSquare size={18} className="text-indigo-400" />
                Chat
              </h1>
              <p className="text-xs mt-0.5" style={{ color: '#8B8BAD' }}>
                Ask anything — file commands, search, duplicates, storage
              </p>
            </div>
          </div>
          {/* New chat button */}
          {messages.length > 0 && (
            <motion.button
              whileHover={{ scale: 1.05 }}
              whileTap={{ scale: 0.95 }}
              onClick={() => newSession()}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-medium"
              style={{ background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.08)', color: '#8B8BAD' }}
            >
              <Plus size={12} /> New Chat
            </motion.button>
          )}
        </div>

        {/* ── Message area ──────────────────────────────────────────────── */}
        <div className="flex-1 overflow-y-auto px-1 pb-2" style={{ minHeight: 0 }}>
          {messages.length === 0 ? (
            <EmptyState />
          ) : (
            <div className="flex flex-col">
              <AnimatePresence initial={false}>
                {messages.map((msg) => (
                  <MessageRenderer
                    key={msg.id}
                    msg={msg}
                    onApprovalCta={handleApprovalCta}
                    onDetailsCta={handleDetailsCta}
                  />
                ))}
              </AnimatePresence>
              <AnimatePresence>
                {typing && <TypingIndicator key="typing" />}
              </AnimatePresence>
              <div ref={bottomRef} />
            </div>
          )}
        </div>

        {/* ── Quick actions ──────────────────────────────────────────────── */}
        {messages.length === 0 && (
          <div className="flex flex-wrap gap-2 pb-3 shrink-0">
            {QUICK_ACTIONS.map(({ label, icon: Icon, cmd }, i) => (
              <motion.button
                key={label}
                custom={i}
                variants={chipVariants}
                initial="hidden"
                animate="visible"
                whileHover={{ scale: 1.04, y: -1 }}
                whileTap={{ scale: 0.96 }}
                onClick={() => sendQuickAction(cmd)}
                className="flex items-center gap-2 px-3.5 py-2 rounded-xl text-xs font-medium transition-all"
                style={{ background: 'rgba(79,70,229,.1)', border: '1px solid rgba(79,70,229,.22)', color: '#818CF8' }}
                onMouseEnter={(e) => {
                  (e.currentTarget as HTMLElement).style.background = 'rgba(79,70,229,.18)';
                  (e.currentTarget as HTMLElement).style.boxShadow = '0 0 12px rgba(79,70,229,.25)';
                }}
                onMouseLeave={(e) => {
                  (e.currentTarget as HTMLElement).style.background = 'rgba(79,70,229,.1)';
                  (e.currentTarget as HTMLElement).style.boxShadow = 'none';
                }}
              >
                <Icon size={13} />
                {label}
              </motion.button>
            ))}
          </div>
        )}

        {/* ── Input bar ─────────────────────────────────────────────────── */}
        <div className="shrink-0 pt-2">
          <InputBar onSend={sendMessage} disabled={typing} />
          <p className="text-center text-[10px] mt-2" style={{ color: '#555575' }}>
            Try: "Clean Desktop" · "Find resume.pdf" · "Show duplicates" · "Storage report"
          </p>
        </div>

      </div>{/* end main column */}

      {/* ── Approval Modal ────────────────────────────────────────────────── */}
      <AnimatePresence>
        {modalOpen && approvalFiles && (
          <ApprovalModal
            files={approvalFiles}
            onClose={() => { setModalOpen(false); clearApprovalFiles(); }}
            onApproved={() => { setModalOpen(false); clearApprovalFiles(); }}
          />
        )}
      </AnimatePresence>

      {planModalOpen && approvalPlan && (
        <ChatApprovalModal
          plan={approvalPlan}
          mode={planModalMode}
          onClose={() => setPlanModalOpen(false)}
          onCancel={() => setPlanModalOpen(false)}
          onApproved={(message) => {
            setPlanModalOpen(false);
            clearApprovalPlan();
            pushMessage('assistant', { type: 'text', text: message });
          }}
        />
      )}
    </motion.div>
  );
}
