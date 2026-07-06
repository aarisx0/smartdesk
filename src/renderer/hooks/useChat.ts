import { useState, useCallback, useRef } from 'react';
import type { SearchResultItem, SearchMeta } from '../components/SearchResults';

const API = 'http://localhost:3001';

// ─── types ────────────────────────────────────────────────────────────────────

export type MessageRole = 'user' | 'assistant';

export type MessagePayload =
  | { type: 'text';       text: string }
  | { type: 'file-list';  results: SearchResultItem[]; meta: SearchMeta; query: string }
  | { type: 'action';     action: ChatAction }
  | { type: 'stats';      stats: StorageStats }
  | { type: 'error';      text: string };

export interface ChatMessage {
  id:        string;
  role:      MessageRole;
  payload:   MessagePayload;
  timestamp: Date;
}

export interface ChatAction {
  label:      string;
  icon:       string;
  count:      number;
  detail:     string;
  cta?:       string;
  ctaTarget?: string;
}

export interface StorageStats {
  totalFiles:     number;
  organizedFiles: number;
  pendingFiles:   number;
  healthScore:    number;
  topExtensions:  { ext: string; count: number }[];
}

export interface ApprovalPlanItem {
  operation: 'move' | 'delete' | 'rename' | 'create_folder' | 'move_folder';
  name: string;
  sourcePath: string;
  targetPath: string | null;
  newName: string | null;
  sizeBytes: number | null;
}

export interface ApprovalPlan {
  id: string;
  type: 'move_files' | 'delete_files' | 'delete_file' | 'rename_file' | 'create_folder' | 'move_folder' | 'scan_structure' | 'mixed';
  title: string;
  detail: string;
  sourceLabel: string;
  destinationLabel: string;
  count: number;
  items: ApprovalPlanItem[];
}

interface PendingOperation {
  type: 'move' | 'delete' | 'rename' | 'organize';
  source?: string;
  destination?: string;
  specificFile?: string;
  requestText?: string;
}

interface AgentIntent {
  type: string;
  query?: string | null;
  source?: string | null;
  destination?: string | null;
  folderHint?: string | null;
  approvalPlan?: ApprovalPlan;
}

// ─── command patterns (broad NL matching) ─────────────────────────────────────

interface AgentResponse {
  reply?:     string;
  intent?:    AgentIntent;
  error?:     string;
  threadId?:  string | null;
}

// ─── command patterns (broad NL matching) ────────────────────────────────────

const CMD = {
  // Clean / organise / move
  cleanDesktop:    /\b(clean|organis[e]?|organiz[e]?|move|sort)\b.*(desktop)/i,
  cleanDownloads:  /\b(clean|organis[e]?|organiz[e]?|move|sort)\b.*(downloads?)/i,
  moveToFolder:    /\bmove\b.*(files?|stuff|everything)\b/i,
  organizeFolder:  /\b(organis[e]?|organiz[e]?|clean\s+up|sort)\b\s+(.+)/i,

  // Explicit move with source AND destination
  moveExplicit:    /\bmove\b.+\bfrom\b.+\bto\b/i,

  // Find / search
  findFile:        /\b(find|where|locate|search|look\s+for|show\s+me)\b\s+(?:a\s+file\s+(?:called|named)\s+|file\s+)?(.+)/i,

  // Duplicates
  duplicates:      /\b(duplicate|duplicate\s+files?|copies|same\s+file)\b/i,

  // Stats
  storageReport:   /\b(storage|disk\s+usage|space|how\s+much\s+space|report)\b/i,

  // Scan structure
  scanStructure:   /\b(scan|analyse?|analyze|check)\b.*(folder|structure|system|files?)/i,

  // Pending approvals
  pending:         /\b(pending|waiting|need\s+approval|approve)\b/i,
} as const;

// ─── helpers ──────────────────────────────────────────────────────────────────

let _id = 0;
const newId = () => `msg-${++_id}-${Date.now()}`;
const makeMsg = (role: MessageRole, payload: MessagePayload): ChatMessage => ({
  id: newId(), role, payload, timestamp: new Date(),
});
const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function mapPendingFiles(data: any[]) {
  return (Array.isArray(data) ? data : []).map((r: any) => ({
    id: r.id, filename: r.filename, extension: r.extension ?? '',
    filepath: r.filepath, suggested_folder: r.suggested_folder ?? null,
    confidence_score: r.confidence_score ?? null,
    ai_reasoning: r.ai_reasoning ?? null,
    size_bytes: r.size_bytes ?? null, created_at: r.created_at,
  }));
}

function sanitizeSearchQuery(value: string): string {
  return value
    // Remove conversational prefixes
    .replace(/^(hey[,!]?\s*)?(hi[,!]?\s*)?(hello[,!]?\s*)?(please[,!]?\s*)?/i, '')
    // Remove filler verbs before the actual query
    .replace(/\b(can you|could you|would you|please|for me|help me)\b/ig, ' ')
    // Remove search keywords themselves (already consumed by regex)
    .replace(/\b(find|locate|search|look for|where is|show me|get me)\b/ig, ' ')
    // Remove "the file" / "a file" / "file called" / "file named"
    .replace(/\b(the|a)\s+file\b/ig, ' ')
    .replace(/\bfile\s+(called|named|with name)\b/ig, ' ')
    // Remove trailing punctuation
    .replace(/[?!.,]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function extractRequestedFileHint(value: string): string | undefined {
  const text = value.trim();
  if (!text) return undefined;

  const quoted = text.match(/["']([^"']+)["']/);
  if (quoted?.[1]) return quoted[1].trim();

  const withExt = text.match(/\b([a-zA-Z0-9_\s\-]+\.[a-zA-Z0-9]{2,10})\b/);
  if (withExt?.[1]) return withExt[1].trim();

  const natural = text.match(/\b(?:move|delete|remove|trash|rename)\s+(?:the\s+|my\s+|a\s+|an\s+)?(.+?)\s+(?:from|to|in|into)\b/i);
  if (!natural?.[1]) return undefined;

  const hint = natural[1]
    .replace(/\b(files?|folder)\b/ig, ' ')
    .replace(/[.?!,]+$/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (!hint) return undefined;
  if (/^(all|everything|stuff|items?|files?|it|them)$/i.test(hint)) return undefined;
  return hint;
}

function getPlanActionMeta(type: string) {
  if (type === 'delete_file' || type === 'delete_files') {
    return { icon: 'Trash2', cta: 'Approve & Delete' };
  }
  if (type === 'create_folder' || type === 'move_folder') {
    return { icon: 'FolderPlus', cta: 'Approve & Execute' };
  }
  return { icon: 'FolderOpen', cta: 'Approve & Move' };
}

function isProceedConfirmation(input: string): boolean {
  const text = input.trim().toLowerCase();
  if (!text) return false;

  // Block explicit negatives/cancellations first.
  if (/\b(no|not now|don't|do not|stop|cancel|wait|hold on|later|skip)\b/.test(text)) {
    return false;
  }

  // Broad affirmative/continue phrases — single line, no multiline regex.
  const YES_RE = /\b(yes|yeah|yep|yup|sure|ok|okay|alright|all right|proceed|approve|confirm|continue|carry on|go ahead|do it|execute|start|run it|finish it|complete it|make it happen|sounds good|that works|please do|do that|move it|move them|delete it)\b/i;
  return YES_RE.test(text);
}

// ─── hook ─────────────────────────────────────────────────────────────────────

export function useChat() {
  const [messages,      setMessages]      = useState<ChatMessage[]>([]);
  const [typing,        setTyping]        = useState(false);
  const [approvalFiles, setApprovalFiles] = useState<import('./useDashboard').PendingFile[] | null>(null);
  const [approvalPlan,  setApprovalPlan]  = useState<ApprovalPlan | null>(null);
  // Keep a ref in sync with approvalPlan state — avoids stale closure in sendMessage
  const approvalPlanRef = useRef<ApprovalPlan | null>(null);
  // Callback ref: Chat.tsx registers a function here so the hook can open the modal directly
  const openPlanModalRef = useRef<(() => void) | null>(null);
  // Thread ID for conversation continuity — persisted across messages
  const threadIdRef         = useRef<string | null>(null);
  // Stores the last pending operation the agent mentioned (move/delete/rename)
  // so "yes proceed" can build a plan without re-asking the agent
  const pendingOperationRef = useRef<PendingOperation | null>(null);
  const abortRef            = useRef(false);

  const push = useCallback((role: MessageRole, payload: MessagePayload) => {
    setMessages((m) => [...m, makeMsg(role, payload)]);
  }, []);

  // Keep approvalPlanRef in sync whenever we set plan state.
  // We do NOT auto-open the modal — the user clicks "Details" or "Approve & Organise"
  // from the action card. This keeps those buttons visible and clickable at all times,
  // even while the modal happens to be open in the background.
  const setPlan = useCallback((plan: ApprovalPlan | null) => {
    approvalPlanRef.current = plan;
    setApprovalPlan(plan);
    if (!plan) {
      // Plan cleared after successful approval — wipe any stale pending operation.
      pendingOperationRef.current = null;
    }
  }, []);

  const withTyping = useCallback(async (fn: () => Promise<void>) => {
    setTyping(true);
    abortRef.current = false;
    try { await fn(); }
    finally { setTyping(false); }
  }, []);

  const tryBuildOrganizeApprovalPlan = useCallback(async (requestText: string, sourceHint?: string) => {
    try {
      const target = sourceHint || 'watched folders';
      const planRes = await fetch(`${API}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: `prepare an approval plan for this organization request: "${requestText}". Focus on ${target}. Create folders and move files only after approval.`,
          threadId: threadIdRef.current,
        }),
      });
      const planData = await planRes.json() as AgentResponse;
      if (planData.threadId) threadIdRef.current = planData.threadId;
      if (planData.intent?.approvalPlan) {
        setPlan(planData.intent.approvalPlan);
        pendingOperationRef.current = null;
        const meta = getPlanActionMeta(planData.intent.type || planData.intent.approvalPlan.type);
        push('assistant', { type: 'action', action: {
          label:     planData.intent.approvalPlan.title,
          icon:      meta.icon,
          count:     planData.intent.approvalPlan.count,
          detail:    planData.intent.approvalPlan.detail,
          cta:       meta.cta,
          ctaTarget: 'chat-approval-plan',
        }});
        return true;
      }
    } catch {
      // fallback handled by caller
    }
    return false;
  }, [push]);

  // ── handlers ──────────────────────────────────────────────────────────────

  const handleCleanFolder = useCallback(async (folderHint: string) => {
    await withTyping(async () => {
      await delay(500);
      try {
        const res  = await fetch(`${API}/api/activity?status=pending&limit=40`);
        const data = await res.json() as any[];
        const files = mapPendingFiles(data);

        if (files.length === 0) {
          push('assistant', { type: 'action', action: {
            label: `No pending files in ${folderHint}`,
            icon: 'CheckCircle2', count: 0,
            detail: 'Everything looks organised already. Drop files into watched folders to get started.',
          }});
          return;
        }

        setApprovalFiles(files);
        push('assistant', { type: 'action', action: {
          label: `Found ${files.length} file${files.length !== 1 ? 's' : ''} to organise`,
          icon: 'FolderOpen', count: files.length,
          detail: `AI has suggested destinations for ${files.length} file${files.length !== 1 ? 's' : ''} from ${folderHint}.`,
          cta: 'Review & Approve', ctaTarget: 'approval',
        }});
      } catch (err) {
        push('assistant', { type: 'error', text: `Scan failed: ${(err as Error).message}` });
      }
    });
  }, [withTyping, push]);

  const handleFindFile = useCallback(async (query: string) => {
    await withTyping(async () => {
      await delay(250);
      try {
        const res  = await fetch(`${API}/api/search?q=${encodeURIComponent(query)}`);
        const resp = await res.json() as { results: SearchResultItem[]; meta: SearchMeta };
        const results = resp.results ?? [];
        const meta    = resp.meta ?? { query, keywords: [], extHint: null, durationMs: 0, totalFound: 0 };

        if (results.length === 0) {
          push('assistant', { type: 'text', text: `I searched for **"${query}"** but couldn't find any matching files in your watched folders. Try adding the folder in Settings if it isn't being watched yet, or use a shorter keyword.` });
          return;
        }
        push('assistant', { type: 'file-list', results, meta, query });
      } catch (err) {
        push('assistant', { type: 'error', text: `Search failed: ${(err as Error).message}` });
      }
    });
  }, [withTyping, push]);

  /**
   * Handle open_file intent: search for the file, then:
   *  - 1 result  → auto-open it via the Electron shell
   *  - >1 results → show SearchResults card so the user can pick
   *  - 0 results  → friendly "not found" message
   */
  const handleOpenFile = useCallback(async (query: string) => {
    await withTyping(async () => {
      await delay(250);
      try {
        const res  = await fetch(`${API}/api/search?q=${encodeURIComponent(query)}`);
        const resp = await res.json() as { results: SearchResultItem[]; meta: SearchMeta };
        const results = resp.results ?? [];
        const meta    = resp.meta ?? { query, keywords: [], extHint: null, durationMs: 0, totalFound: 0 };

        if (results.length === 0) {
          push('assistant', {
            type: 'text',
            text: `I searched for **"${query}"** but couldn't find any matching files in your watched folders. Try a different keyword or check Settings to make sure the folder is being watched.`,
          });
          return;
        }

        if (results.length === 1) {
          // Single match — open it immediately
          const file = results[0];
          const openErr = await window.electronAPI?.openPath(file.filepath);
          if (openErr) {
            // openPath returns an empty string on success, error message on failure
            push('assistant', {
              type: 'text',
              text: `Found **${file.filename}** but couldn't open it: ${openErr}`,
            });
          } else {
            push('assistant', {
              type: 'text',
              text: `Opening **${file.filename}**…`,
            });
          }
          return;
        }

        // Multiple matches — show results so user can choose
        push('assistant', {
          type: 'text',
          text: `I found ${results.length} files matching **"${query}"**. Which one would you like to open?`,
        });
        push('assistant', { type: 'file-list', results, meta, query });
      } catch (err) {
        push('assistant', { type: 'error', text: `Search failed: ${(err as Error).message}` });
      }
    });
  }, [withTyping, push]);

  const handleDuplicates = useCallback(async () => {
    await withTyping(async () => {
      await delay(400);
      try {
        const res   = await fetch(`${API}/api/duplicates`);
        const data  = await res.json() as any[];
        const count = Array.isArray(data) ? data.length : 0;
        push('assistant', { type: 'action', action: {
          label: count > 0 ? `Found ${count} duplicate group${count !== 1 ? 's' : ''}` : 'No duplicates found',
          icon: 'Copy', count,
          detail: count > 0
            ? 'Identical files found — removing them frees up storage.'
            : 'No duplicates in watched folders. Try running a scan.',
          cta: count > 0 ? 'View Duplicates' : 'Scan Now',
          ctaTarget: '/duplicates',
        }});
      } catch (err) {
        push('assistant', { type: 'error', text: `Duplicate check failed: ${(err as Error).message}` });
      }
    });
  }, [withTyping, push]);

  const handleStorageReport = useCallback(async () => {
    await withTyping(async () => {
      await delay(500);
      try {
        const res  = await fetch(`${API}/api/stats`);
        const data = await res.json();
        const total     = (data.classified ?? 0) + (data.approvals ?? 0) + (data.filesOrganized ?? 0);
        const organized = data.classified ?? 0;
        const pending   = data.approvals  ?? 0;
        const score     = total > 0 ? Math.round((organized / total) * 100) : 0;
        push('assistant', { type: 'stats', stats: {
          totalFiles: total, organizedFiles: organized,
          pendingFiles: pending, healthScore: score, topExtensions: [],
        }});
      } catch (err) {
        push('assistant', { type: 'error', text: `Stats failed: ${(err as Error).message}` });
      }
    });
  }, [withTyping, push]);

  const handleScanStructure = useCallback(async (hint: string, requestText?: string) => {
    await withTyping(async () => {
      // Normalise the folder label for display
      const folderLabel = hint
        ? hint.replace(/^(scan|analyse?|analyze|check)\s*/i, '').trim() || hint
        : 'your watched folders';

      push('assistant', { type: 'text', text: `Scanning **${folderLabel}** and preparing an organisation plan…` });
      await delay(400);

      try {
        // ── Direct scan — never goes through IBM agent ──────────────────────
        const res = await fetch(`${API}/api/chat/scan`, {
          method:  'POST',
          headers: { 'Content-Type': 'application/json' },
          body:    JSON.stringify({ folder: hint || null }),
        });
        const data = await res.json() as AgentResponse;

        if (data.intent?.approvalPlan) {
          // Plan found — clear any stale pending operation and show the action card.
          setPlan(data.intent.approvalPlan);
          pendingOperationRef.current = null;
          push('assistant', { type: 'text', text: data.reply || `I found files to organise in **${folderLabel}**.` });
          push('assistant', { type: 'action', action: {
            label:     data.intent.approvalPlan.title,
            icon:      'Sparkles',
            count:     data.intent.approvalPlan.count,
            detail:    data.intent.approvalPlan.detail,
            cta:       'Approve & Organise',
            ctaTarget: 'chat-approval-plan',
          }});
          return;
        }

        // Nothing to organise in this folder — store pending so "yes" can retry
        pendingOperationRef.current = {
          type: 'organize',
          source: hint || 'Desktop',
          requestText: requestText || hint,
        };
        push('assistant', { type: 'text', text: data.reply || `**${folderLabel}** looks clean — no loose files need organising right now.` });
      } catch (err) {
        push('assistant', { type: 'error', text: `Scan failed: ${(err as Error).message}` });
      }
    });
  }, [withTyping, push, setPlan]);

  const handlePending = useCallback(async () => {
    await withTyping(async () => {
      await delay(400);
      try {
        const res  = await fetch(`${API}/api/activity?status=pending&limit=40`);
        const data = await res.json() as any[];
        const files = mapPendingFiles(data);

        if (files.length === 0) {
          push('assistant', { type: 'text', text: 'No files are waiting for approval right now.' });
          return;
        }
        setApprovalFiles(files);
        push('assistant', { type: 'action', action: {
          label: `${files.length} file${files.length !== 1 ? 's' : ''} awaiting approval`,
          icon: 'CheckCircle2', count: files.length,
          detail: 'These files have been detected and need your approval to be moved.',
          cta: 'Review & Approve', ctaTarget: 'approval',
        }});
      } catch (err) {
        push('assistant', { type: 'error', text: `Failed: ${(err as Error).message}` });
      }
    });
  }, [withTyping, push]);

  /**
   * Show a live folder structure — always reads from disk via /api/chat/structure.
   * Used when user asks "show me the structure of Downloads" (especially after organizing).
   */
  const handleShowStructure = useCallback(async (folderHint: string) => {
    await withTyping(async () => {
      await delay(250);
      try {
        const res = await fetch(`${API}/api/chat/structure`, {
          method:  'POST',
          headers: { 'Content-Type': 'application/json' },
          body:    JSON.stringify({ folder: folderHint }),
        });
        const data = await res.json() as { ok: boolean; label?: string; structure?: string; summary?: string; message?: string };

        if (!data.ok) {
          push('assistant', { type: 'text', text: data.message || `Could not read the structure of **${folderHint}**.` });
          return;
        }

        push('assistant', {
          type: 'text',
          text: `Here is the current structure of **${data.label}** (${data.summary}):\n\n\`\`\`\n${data.structure}\n\`\`\``,
        });
      } catch (err) {
        push('assistant', { type: 'error', text: `Structure read failed: ${(err as Error).message}` });
      }
    });
  }, [withTyping, push]);

  const runLocalRouting = useCallback(async (text: string) => {
    const t = text.toLowerCase();

    if (CMD.pending.test(t)) { await handlePending(); return true; }
    if (CMD.cleanDesktop.test(t)) { await handleCleanFolder('Desktop'); return true; }
    if (CMD.cleanDownloads.test(t)) { await handleCleanFolder('Downloads'); return true; }

    if (CMD.moveToFolder.test(t)) {
      const folder = /desktop/i.test(t) ? 'Desktop' : /downloads?/i.test(t) ? 'Downloads' : 'watched folders';
      await handleCleanFolder(folder);
      return true;
    }

    const orgMatch = text.match(CMD.organizeFolder);
    if (orgMatch) {
      const hint = (orgMatch[2] ?? '').trim();
      const folder = /desktop/i.test(hint) ? 'Desktop'
        : /downloads?/i.test(hint) ? 'Downloads'
          : hint || 'watched folders';
      await handleCleanFolder(folder);
      return true;
    }

    const findMatch = text.match(CMD.findFile);
    if (findMatch) {
      const q = sanitizeSearchQuery((findMatch[2] ?? findMatch[1] ?? '').trim());
      if (q && q.length > 1) {
        await handleFindFile(q);
        return true;
      }
    }

    if (CMD.duplicates.test(t)) { await handleDuplicates(); return true; }
    if (CMD.storageReport.test(t)) { await handleStorageReport(); return true; }

    if (CMD.scanStructure.test(t)) {
      // Extract which folder the user mentioned; fall back to Desktop if none
      const FOLDER_MAP: Record<string, string> = {
        desktop: 'Desktop', downloads: 'Downloads', download: 'Downloads',
        documents: 'Documents', document: 'Documents',
        pictures: 'Pictures', picture: 'Pictures',
        videos: 'Videos', music: 'Music',
      };
      let folderHint = '';
      for (const [alias, canonical] of Object.entries(FOLDER_MAP)) {
        if (t.includes(alias)) { folderHint = canonical; break; }
      }
      await handleScanStructure(folderHint);
      return true;
    }

    return false;
  }, [
    handlePending,
    handleCleanFolder,
    handleFindFile,
    handleDuplicates,
    handleStorageReport,
    handleScanStructure,
  ]);

  // ── Main send — IBM agent ALWAYS called first ─────────────────────────────
  const sendMessage = useCallback(async (input: string) => {
    const text = input.trim();
    if (!text || typing) return;
    const isProceed = isProceedConfirmation(text);

    // ── Case 1: plan exists + user said "yes/proceed" — open approve modal ──
    if (isProceed && approvalPlanRef.current) {
      push('user', { type: 'text', text });
      if (openPlanModalRef.current) openPlanModalRef.current();
      return;
    }

    // ── Case 2: pending operation + confirmation — build plan directly ────────
    if (isProceed && pendingOperationRef.current) {
      const pending = pendingOperationRef.current;
      pendingOperationRef.current = null;
      push('user', { type: 'text', text });

      if (pending.type === 'organize') {
        await handleScanStructure(pending.source || 'Desktop');
        return;
      }

      await withTyping(async () => {
        const { type, source, destination, specificFile } = pending;
        // Build a natural language request to send to the backend plan-builder
        const buildMessage = type === 'delete'
          ? (specificFile ? `delete ${specificFile} from ${source}` : `delete files from ${source}`)
          : (specificFile ? `move ${specificFile} from ${source} to ${destination}` : `move all files from ${source} to ${destination}`);

        try {
          const planRes = await fetch(`${API}/api/chat`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ message: buildMessage, threadId: threadIdRef.current }),
          });
          const planData = await planRes.json() as AgentResponse;
          if (planData.threadId) threadIdRef.current = planData.threadId;
          if (planData.reply) push('assistant', { type: 'text', text: planData.reply });
          if (planData.intent?.approvalPlan) {
            setPlan(planData.intent.approvalPlan);
            pendingOperationRef.current = null;
            const meta = getPlanActionMeta(planData.intent.type || planData.intent.approvalPlan.type);
            push('assistant', { type: 'action', action: {
              label: planData.intent.approvalPlan.title, icon: meta.icon,
              count: planData.intent.approvalPlan.count, detail: planData.intent.approvalPlan.detail,
              cta: meta.cta, ctaTarget: 'chat-approval-plan',
            }});
          }
        } catch (err) {
          push('assistant', { type: 'error', text: `Request failed: ${(err as Error).message}` });
        }
      });
      return;
    }

    // ── Case 1b: isProceed but no plan/pending in memory ─────────────────────
    // The IBM agent asked for confirmation in a previous message, but the plan
    // was never stored as a SmartDesk ApprovalPlan (it was in the IBM thread only).
    // Don't send raw "yes/proceed" to IBM — it will reply "I have no tool access".
    // Instead, send it to the backend with the thread ID so IBM can re-derive the
    // plan in the correct JSON format.
    if (isProceed) {
      push('user', { type: 'text', text });
      await withTyping(async () => {
        try {
          // Re-send with explicit instruction to produce a structured plan
          const res = await fetch(`${API}/api/chat`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              message: `${text} — please produce a SmartDesk action plan now (respond in the required JSON format with intent and approvalPlan)`,
              threadId: threadIdRef.current,
            }),
          });
          const data = await res.json() as AgentResponse;
          if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
          if (data.threadId) threadIdRef.current = data.threadId;

          if (data.reply) push('assistant', { type: 'text', text: data.reply });

          if (data.intent?.approvalPlan) {
            setPlan(data.intent.approvalPlan);
            const meta = getPlanActionMeta(data.intent.type || data.intent.approvalPlan.type);
            push('assistant', { type: 'action', action: {
              label: data.intent.approvalPlan.title, icon: meta.icon,
              count: data.intent.approvalPlan.count, detail: data.intent.approvalPlan.detail,
              cta: meta.cta, ctaTarget: 'chat-approval-plan',
            }});
          }
        } catch (err) {
          push('assistant', { type: 'error', text: `Request failed: ${(err as Error).message}` });
        }
      });
      return;
    }

    push('user', { type: 'text', text });

    // ── Every message goes to IBM agent — no local fast-paths ─────────────────
    await withTyping(async () => {
      await delay(180);
      let agentSucceeded = false;

      try {
        const res = await fetch(`${API}/api/chat`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ message: text, threadId: threadIdRef.current }),
        });
        const data = await res.json() as AgentResponse;
        if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);

        if (data.threadId) threadIdRef.current = data.threadId;
        agentSucceeded = true;

        const intent = data.intent;
        const intentType = intent?.type ?? 'chat';

        // Always show the agent's reply text first — it comes from the real AI
        if (data.reply) {
          push('assistant', { type: 'text', text: data.reply });
        }

        // Store pending context for move/delete so user can say "yes" to execute
        if (data.reply && intent && !intent.approvalPlan) {
          const src = intent.source?.trim() || intent.folderHint?.trim() || undefined;
          const dst = intent.destination?.trim() || undefined;
          const specificFile = extractRequestedFileHint(text) || intent.query?.trim() || undefined;

          if (intentType === 'delete_file' && src) {
            pendingOperationRef.current = { type: 'delete', source: src, specificFile };
          } else if (intentType === 'move_files' && src && dst) {
            pendingOperationRef.current = { type: 'move', source: src, destination: dst, specificFile };
          } else if ((intentType === 'organize_folder' || intentType === 'scan_structure') && src) {
            pendingOperationRef.current = { type: 'organize', source: src };
          }
          // Even for 'chat' intent — if IBM reply sounds like it wants confirmation
          // for a delete/move, store the pending so "yes/proceed" works next turn.
          else if (intentType === 'chat' && data.reply) {
            const replyLower = data.reply.toLowerCase();
            const replyWantsDeleteConfirm =
              /\b(confirm|proceed|yes.*delete|delete.*all|reply.*yes|type.*yes)\b/i.test(data.reply);
            const replyWantsMoveConfirm =
              /\b(confirm|proceed|yes.*move|move.*all|reply.*yes|type.*yes)\b/i.test(data.reply) &&
              /\bmov(e|ing)\b/i.test(data.reply);

            if (replyWantsDeleteConfirm && src) {
              pendingOperationRef.current = { type: 'delete', source: src, specificFile };
            } else if (replyWantsDeleteConfirm && !src) {
              // IBM gave a plan in plain text but no structured source —
              // store a delete pending with requestText so backend can re-derive
              pendingOperationRef.current = { type: 'delete', source: 'watched', requestText: text };
            } else if (replyWantsMoveConfirm && src && dst) {
              pendingOperationRef.current = { type: 'move', source: src, destination: dst, specificFile };
            }
          }
        }

        // Dispatch on intent type to trigger structured UI
        switch (intentType) {

          case 'chat':
          case 'storage_report':
          case 'count_folder_items':
          case 'find_duplicates':
            // Reply already shown — no further action needed
            break;

          case 'move_files':
          case 'delete_file':
          case 'rename_file':
          case 'create_folder':
          case 'move_folder': {
            if (intent?.approvalPlan) {
              setPlan(intent.approvalPlan);
              pendingOperationRef.current = null;
              const meta = getPlanActionMeta(intentType);
              push('assistant', { type: 'action', action: {
                label: intent.approvalPlan.title, icon: meta.icon,
                count: intent.approvalPlan.count, detail: intent.approvalPlan.detail,
                cta: meta.cta, ctaTarget: 'chat-approval-plan',
              }});
            }
            break;
          }

          case 'find_file': {
            const q = sanitizeSearchQuery(intent?.query?.trim() || '');
            if (q && q.length > 1) await handleFindFile(q);
            break;
          }

          case 'open_file': {
            const q = sanitizeSearchQuery(intent?.query?.trim() || '');
            if (q && q.length > 1) await handleOpenFile(q);
            break;
          }

          case 'scan_structure':
          case 'organize_folder': {
            if (intent?.approvalPlan) {
              setPlan(intent.approvalPlan);
              pendingOperationRef.current = null;
              push('assistant', { type: 'action', action: {
                label: intent.approvalPlan.title, icon: 'Sparkles',
                count: intent.approvalPlan.count, detail: intent.approvalPlan.detail,
                cta: 'Approve & Organise', ctaTarget: 'chat-approval-plan',
              }});
            } else {
              // No plan yet — run the local disk scan now using folder from intent or message
              const folderHint = intent?.folderHint?.trim() || intent?.source?.trim() || '';
              await handleScanStructure(folderHint, text);
            }
            break;
          }

          case 'show_duplicates': await handleDuplicates(); break;
          case 'show_pending':    await handlePending();    break;

          case 'show_structure': {
            const folderHint = intent?.folderHint?.trim() || intent?.source?.trim() || '';
            if (folderHint) await handleShowStructure(folderHint);
            break;
          }

          default:
            // Agent replied — nothing extra to do
            break;
        }

      } catch (err) {
        console.error('[chat] IBM agent error:', (err as Error).message);
      }

      // Agent FAILED — fall back to local routing (search, duplicates, stats)
      if (!agentSucceeded) {
        await runLocalRouting(text);
      }
    });
  }, [
    typing, setPlan, push, withTyping, runLocalRouting,
    handleFindFile, handleOpenFile, handleDuplicates, handlePending, handleScanStructure,
    handleShowStructure,
  ]);

  const sendQuickAction    = useCallback((cmd: string) => sendMessage(cmd), [sendMessage]);
  const clearApprovalFiles = useCallback(() => setApprovalFiles(null), []);
  const clearApprovalPlan  = useCallback(() => setPlan(null), [setPlan]);

  // ── Chat session persistence ───────────────────────────────────────────────

  // ID of the currently-loaded session (null = unsaved / new session)
  const sessionIdRef = useRef<string | null>(null);
  const [currentSessionId, setCurrentSessionId] = useState<string | null>(null);

  /**
   * Save (or update) the current messages to the backend.
   * Returns the session id.
   */
  const saveSession = useCallback(async (): Promise<string | null> => {
    if (messages.length === 0) return null;
    try {
      // Serialise messages — strip Date objects so JSON round-trips cleanly
      const serialisable = messages.map((m) => ({
        ...m,
        timestamp: m.timestamp instanceof Date ? m.timestamp.toISOString() : m.timestamp,
      }));
      const body: Record<string, unknown> = {
        messages:  serialisable,
        threadId:  threadIdRef.current,
      };
      if (sessionIdRef.current) body.id = sessionIdRef.current;

      const res  = await fetch(`${API}/api/sessions`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify(body),
      });
      const data = await res.json() as { id?: string; error?: string };
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      if (data.id) {
        sessionIdRef.current = data.id;
        setCurrentSessionId(data.id);
        return data.id;
      }
      throw new Error('Server returned no session ID');
    } catch (err) {
      console.error('[useChat] saveSession failed:', err);
      throw err; // re-throw so ChatHistoryPanel can show the error
    }
  }, [messages]);

  /**
   * Load a saved session from the backend, restoring messages and thread ID.
   */
  const loadSession = useCallback(async (id: string): Promise<void> => {
    try {
      const res  = await fetch(`${API}/api/sessions/${id}`);
      const data = await res.json() as {
        id: string;
        messages: any[];
        thread_id?: string | null;
        error?: string;
      };
      if (data.error) throw new Error(data.error);

      const restored: ChatMessage[] = (data.messages ?? []).map((m: any) => ({
        ...m,
        timestamp: m.timestamp ? new Date(m.timestamp) : new Date(),
      }));
      setMessages(restored);
      setApprovalPlan(null);
      approvalPlanRef.current = null;
      pendingOperationRef.current = null;
      sessionIdRef.current = id;
      setCurrentSessionId(id);
      if (data.thread_id) threadIdRef.current = data.thread_id;
    } catch (err) {
      console.error('[useChat] loadSession failed:', err);
    }
  }, []);

  /**
   * Reset to a blank new session.
   */
  const newSession = useCallback((): void => {
    setMessages([]);
    setApprovalPlan(null);
    setApprovalFiles(null);
    approvalPlanRef.current   = null;
    pendingOperationRef.current = null;
    sessionIdRef.current      = null;
    setCurrentSessionId(null);
    threadIdRef.current       = null;
  }, []);

  /**
   * Delete a session from the backend.
   */
  const deleteSession = useCallback(async (id: string): Promise<void> => {
    try {
      await fetch(`${API}/api/sessions/${id}`, { method: 'DELETE' });
      if (sessionIdRef.current === id) newSession();
    } catch (err) {
      console.error('[useChat] deleteSession failed:', err);
    }
  }, [newSession]);

  return {
    messages, typing,
    // mode/setMode kept for backward compat
    mode: 'command' as const, setMode: (_: any) => {},
    approvalFiles, clearApprovalFiles,
    approvalPlan, clearApprovalPlan,
    openPlanModalRef,
    sendMessage, sendQuickAction,
    pushMessage: push,
    // session persistence
    saveSession, loadSession, newSession, deleteSession,
    currentSessionId,
  };
}
