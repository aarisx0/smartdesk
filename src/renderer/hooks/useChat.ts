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
  // Also open the modal immediately so the user sees the plan without needing to click.
  const setPlan = useCallback((plan: ApprovalPlan | null) => {
    approvalPlanRef.current = plan;
    setApprovalPlan(plan);
    if (plan) {
      // A real plan is ready — clear any stale pending operation so it
      // never interferes with the next request.
      pendingOperationRef.current = null;
      // Use setTimeout so Chat.tsx has rendered and registered openPlanModalRef
      setTimeout(() => openPlanModalRef.current?.(), 0);
    } else {
      // Plan cleared (cancelled or approved) — also wipe pending so the next
      // request starts with a clean slate.
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
          // Plan found — setPlan clears pendingOperationRef automatically
          setPlan(data.intent.approvalPlan);
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

  // ── Main send — IBM agent first, local fallback ONLY when agent fails ────────────────────
  const sendMessage = useCallback(async (input: string) => {
    const text = input.trim();
    if (!text || typing) return;
    const isProceed = isProceedConfirmation(text);

    // ── Case 1: plan exists — open the modal instead of querying the agent ──
    if (isProceed && approvalPlanRef.current) {
      push('user', { type: 'text', text });
      openPlanModalRef.current?.();
      return;
    }

    // ── Case 2: yes + pending operation stored from last agent reply ─────────
    if (isProceed && pendingOperationRef.current) {
      const pending = pendingOperationRef.current;
      pendingOperationRef.current = null;
      push('user', { type: 'text', text });

      if (pending.type === 'organize') {
        const target = pending.source || 'watched folders';
        push('assistant', { type: 'text', text: `Preparing an organisation plan for **${target}**…` });
        await handleScanStructure(target);
        return;
      }

      await withTyping(async () => {
        const { type, source, destination, specificFile } = pending;

        let buildMessage: string;
        let loadingText: string;

        if (type === 'delete') {
          buildMessage = specificFile
            ? `delete ${specificFile} from ${source}`
            : `delete files from ${source}`;
          loadingText = `Building delete plan for **${specificFile ?? 'files'}** in **${source}**…`;
        } else {
          // move
          const fileLabel = specificFile ? `"${specificFile}"` : 'all files';
          buildMessage = specificFile
            ? `move ${specificFile} from ${source} to ${destination}`
            : `move all files from ${source} to ${destination}`;
          loadingText = `Building move plan: ${fileLabel} from **${source}** → **${destination}**…`;
        }

        push('assistant', { type: 'text', text: loadingText });
        try {
          const planRes = await fetch(`${API}/api/chat`, {
            method:  'POST',
            headers: { 'Content-Type': 'application/json' },
            body:    JSON.stringify({
              message:  buildMessage,
              threadId: threadIdRef.current,
            }),
          });
          const planData = await planRes.json() as AgentResponse;
          if (planData.threadId) threadIdRef.current = planData.threadId;
          if (planData.intent?.approvalPlan) {
            setPlan(planData.intent.approvalPlan);
            const meta = getPlanActionMeta(planData.intent.type || planData.intent.approvalPlan.type);
            push('assistant', { type: 'action', action: {
              label:     planData.intent.approvalPlan.title,
              icon:      meta.icon,
              count:     planData.intent.approvalPlan.count,
              detail:    planData.intent.approvalPlan.detail,
              cta:       meta.cta,
              ctaTarget: 'chat-approval-plan',
            }});
          } else {
            push('assistant', { type: 'text', text: planData.reply || `Ready. Please confirm by clicking Approve.` });
          }
        } catch (err) {
          push('assistant', { type: 'error', text: `Plan failed: ${(err as Error).message}` });
        }
      });
      return;
    }

    // ── Case 3: affirmative but nothing pending — ask what to do, no agent call ──
    if (isProceed) {
      push('user', { type: 'text', text });
      push('assistant', { type: 'text', text: 'What would you like me to do? Try:\n• **"Organise my Desktop"**\n• **"Organise my Downloads"**\n• **"Move files from Desktop to Downloads"**\n• **"Find resume.pdf"**' });
      return;
    }

    push('user', { type: 'text', text });

    // ── Fast path: scan/organize requests skip the IBM agent entirely ─────────
    // We detect these locally and call handleScanStructure directly so the plan
    // is always built correctly regardless of IBM agent availability or response format.
    const SCAN_KEYWORDS = /\b(scan|organis[e]?|organiz[e]?|clean\s*up|reorganis[e]?|reorganiz[e]?|suggest.*organiz|give.*suggestion.*scan|suggestion.*folder|structure.*organiz)\b/i;
    const FOLDER_NAMES = /\b(desktop|downloads?|documents?|pictures?|images?|videos?|music)\b/i;

    if (SCAN_KEYWORDS.test(text) && FOLDER_NAMES.test(text)) {
      const FMAP: Record<string, string> = {
        desktop: 'Desktop', downloads: 'Downloads', download: 'Downloads',
        documents: 'Documents', document: 'Documents',
        pictures: 'Pictures', picture: 'Pictures',
        images: 'Pictures', image: 'Pictures',
        videos: 'Videos', music: 'Music',
      };
      let folderHint = '';
      const tl = text.toLowerCase();
      for (const [alias, canonical] of Object.entries(FMAP)) {
        if (tl.includes(alias)) { folderHint = canonical; break; }
      }
      await handleScanStructure(folderHint || 'Desktop', text);
      return;
    }

    // ── Fast path: "show structure / what's in / list contents" queries ───────
    // These always read from disk directly — never from IBM thread memory.
    const STRUCTURE_KEYWORDS = /\b(show\s+(me\s+)?(the\s+)?structure|what('?s|\s+is)\s+in|list\s+(the\s+)?(contents?|files?)|what\s+(files?|folders?)\s+are\s+in|show\s+(files?|folders?)\s+in|folder\s+structure|current\s+structure)\b/i;

    if (STRUCTURE_KEYWORDS.test(text) && FOLDER_NAMES.test(text)) {
      const FMAP: Record<string, string> = {
        desktop: 'Desktop', downloads: 'Downloads', download: 'Downloads',
        documents: 'Documents', document: 'Documents',
        pictures: 'Pictures', picture: 'Pictures',
        images: 'Pictures', image: 'Pictures',
        videos: 'Videos', music: 'Music',
      };
      let folderHint = '';
      const tl = text.toLowerCase();
      for (const [alias, canonical] of Object.entries(FMAP)) {
        if (tl.includes(alias)) { folderHint = canonical; break; }
      }
      if (folderHint) {
        await handleShowStructure(folderHint);
        return;
      }
    }

    await withTyping(async () => {
      await delay(220);

      let agentSucceeded = false;

      try {
        const res = await fetch(`${API}/api/chat`, {
          method:  'POST',
          headers: { 'Content-Type': 'application/json' },
          body:    JSON.stringify({ message: text, threadId: threadIdRef.current }),
        });

        const data = await res.json() as AgentResponse;
        if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);

        // Store thread ID for next turn — enables conversation continuity
        if (data.threadId) threadIdRef.current = data.threadId;

        agentSucceeded = true;

        const intent = data.intent;
        const intentType = intent?.type ?? 'chat';

        // Show a safe reply. For operation intents, never show "already completed" style text
        // from the LLM before approval/execution has actually happened.
        if (data.reply) {
          const OPERATION_INTENTS = new Set([
            'move_files', 'delete_file', 'create_folder', 'move_folder', 'organize_folder', 'scan_structure',
          ]);

          if (OPERATION_INTENTS.has(intentType)) {
            if (intent?.approvalPlan) {
              // For scan_structure: show the agent's descriptive reply (it contains the breakdown)
              // For other ops: show a shorter confirmation
              if (intentType === 'scan_structure') {
                push('assistant', { type: 'text', text: data.reply });
              } else {
                push('assistant', { type: 'text', text: 'I prepared an approval plan. Review it and approve to execute.' });
              }
            } else if (intentType === 'scan_structure' || intentType === 'organize_folder') {
              push('assistant', { type: 'text', text: 'I will scan and prepare suggestions, then ask for approval before making any file or folder changes.' });
            } else {
              push('assistant', { type: 'text', text: 'I can prepare this as an approval plan and will wait for your permission before making changes.' });
            }
          } else {
            push('assistant', { type: 'text', text: data.reply });
          }

          // Detect if the agent is describing a move or delete operation and store context
          // so the user can say "yes" to trigger the plan
          const replyLower = data.reply.toLowerCase();
          const FOLDER_MAP: Record<string, string> = {
            desktop: 'Desktop', downloads: 'Downloads', download: 'Downloads',
            documents: 'Documents', document: 'Documents',
            pictures: 'Pictures', picture: 'Pictures',
            videos: 'Videos', music: 'Music',
          };

          // Extract specific filename from the original user message
          const specificFile = extractRequestedFileHint(text) || data.intent?.query?.trim() || undefined;

          const isDeleteReply = /\b(delete|remove|trash)\b/.test(replyLower);
          const isMoveReply   = /\bmove\b/.test(replyLower) || /\bfrom\b.+\bto\b/.test(replyLower);

          if (isDeleteReply && !isMoveReply) {
            const fromMatch = replyLower.match(/from\s+(?:the\s+)?(?:your\s+)?([a-z]+)\s*(?:folder)?/i);
            let src: string | null = null;
            if (fromMatch) src = FOLDER_MAP[fromMatch[1].toLowerCase()] ?? null;
            if (!src) {
              // Try extracting from user message
              const msgLower = text.toLowerCase();
              for (const [alias, canonical] of Object.entries(FOLDER_MAP)) {
                if (msgLower.includes(alias)) { src = canonical; break; }
              }
            }
            if (src) {
              pendingOperationRef.current = { type: 'delete', source: src, specificFile };
            }
          } else if (isMoveReply) {
            let src: string | null = null;
            let dst: string | null = null;
            const fromMatch = replyLower.match(/from\s+(?:the\s+)?(?:your\s+)?([a-z]+)\s*(?:folder)?/i);
            const toMatch   = replyLower.match(/to\s+(?:the\s+)?(?:your\s+)?([a-z]+)\s*(?:folder)?/i);
            if (fromMatch) src = FOLDER_MAP[fromMatch[1].toLowerCase()] ?? null;
            if (toMatch)   dst = FOLDER_MAP[toMatch[1].toLowerCase()]   ?? null;
            if (src && dst) {
              pendingOperationRef.current = { type: 'move', source: src, destination: dst, specificFile };
            }
          } else if (/\b(organis|organiz|clean up|sort|reorganis|reorganiz)\b/.test(replyLower)) {
            // IBM agent gave a rich suggestion reply — immediately scan and build
            // a real plan rather than waiting for the user to say "proceed".
            if (!data.intent?.approvalPlan) {
              // Extract folder from user message first, then reply text
              let src: string | null = null;
              const msgLower = text.toLowerCase();
              for (const [alias, canonical] of Object.entries(FOLDER_MAP)) {
                if (msgLower.includes(alias)) { src = canonical; break; }
              }
              if (!src) {
                const fromMatch = replyLower.match(/(?:in|from|for)\s+(?:the\s+)?(?:your\s+)?([a-z]+)\s*(?:folder)?/i);
                if (fromMatch) src = FOLDER_MAP[fromMatch[1].toLowerCase()] ?? null;
              }
              const targetFolder = src || 'Desktop';
              // Kick off the direct scan immediately (non-blocking — runs in parallel with reply display)
              setTimeout(() => handleScanStructure(targetFolder, text), 0);
            }
          }

          if (!pendingOperationRef.current && data.intent && !data.intent.approvalPlan) {
            const src = data.intent.source?.trim() || data.intent.folderHint?.trim() || undefined;
            const dst = data.intent.destination?.trim() || undefined;
            const intentType = data.intent.type;
            const hintedFile = specificFile || data.intent.query?.trim() || undefined;
            if (intentType === 'delete_file' && src) {
              pendingOperationRef.current = { type: 'delete', source: src, specificFile: hintedFile };
            } else if (intentType === 'move_files' && src && dst) {
              pendingOperationRef.current = { type: 'move', source: src, destination: dst, specificFile: hintedFile };
            } else if (intentType === 'organize_folder' || intentType === 'scan_structure') {
              // Extract folder from user message (most reliable) then fall back to intent
              const msgFolder = (() => {
                const tl = text.toLowerCase();
                const FM: Record<string, string> = {
                  desktop: 'Desktop', downloads: 'Downloads', download: 'Downloads',
                  documents: 'Documents', document: 'Documents',
                  pictures: 'Pictures', picture: 'Pictures',
                  videos: 'Videos', music: 'Music',
                };
                for (const [alias, canonical] of Object.entries(FM)) {
                  if (tl.includes(alias)) return canonical;
                }
                return null;
              })();
              const targetFolder = msgFolder || src || 'Desktop';
              // Scan immediately — don't wait for "proceed"
              setTimeout(() => handleScanStructure(targetFolder, text), 0);
            }
          }
        }

        // For these intents the agent reply is sufficient — don't run additional local actions
        const REPLY_ONLY_INTENTS = new Set([
          'chat', 'storage_report', 'count_folder_items',
        ]);

        if (REPLY_ONLY_INTENTS.has(intentType)) {
          // Text reply already shown — done
          return;
        }

        // For action intents, run the local handler to show structured UI
        switch (intentType) {
          case 'move_files':
          case 'delete_file':
          case 'create_folder':
          case 'move_folder': {
            if (intent?.approvalPlan) {
              setPlan(intent.approvalPlan);
              pendingOperationRef.current = null;
              const meta = getPlanActionMeta(intentType);
              push('assistant', { type: 'action', action: {
                label:     intent.approvalPlan.title,
                icon:      meta.icon,
                count:     intent.approvalPlan.count,
                detail:    intent.approvalPlan.detail,
                cta:       meta.cta,
                ctaTarget: 'chat-approval-plan',
              }});
            }
            return;
          }
          case 'find_file': {
            // Only run search if agent gave a query — don't re-search on generic messages
            const q = sanitizeSearchQuery(intent?.query?.trim() || '');
            if (q && q.length > 1) await handleFindFile(q);
            return;
          }
          case 'scan_structure': {
            // If the backend already built a real scan plan — use it directly.
            // setPlan() now also clears pendingOperationRef.
            if (intent?.approvalPlan) {
              setPlan(intent.approvalPlan);
              push('assistant', { type: 'action', action: {
                label:     intent.approvalPlan.title,
                icon:      'Sparkles',
                count:     intent.approvalPlan.count,
                detail:    intent.approvalPlan.detail,
                cta:       'Review & Approve',
                ctaTarget: 'chat-approval-plan',
              }});
              return;
            }
            // No plan from backend — extract folder from user message and scan directly.
            // Do NOT preset pendingOperationRef here; handleScanStructure will set it
            // only if no plan comes back (folder already clean).
            const hintFromMsg = (() => {
              const tl = text.toLowerCase();
              const FM: Record<string, string> = {
                desktop: 'Desktop', downloads: 'Downloads', download: 'Downloads',
                documents: 'Documents', document: 'Documents',
                pictures: 'Pictures', picture: 'Pictures',
                videos: 'Videos', music: 'Music',
              };
              for (const [alias, canonical] of Object.entries(FM)) {
                if (tl.includes(alias)) return canonical;
              }
              return '';
            })();
            const hint = intent?.folderHint?.trim() || intent?.source?.trim() || hintFromMsg;
            await handleScanStructure(hint || 'Desktop', text);
            return;
          }
          case 'show_duplicates':  await handleDuplicates();   return;
          case 'show_pending':     await handlePending();       return;
          case 'organize_folder': {
            const src = intent?.source?.trim() || intent?.folderHint?.trim() || '';
            const dst = intent?.destination?.trim() || '';
            if (src && dst) {
              // Has both source and destination — build a move plan via backend
              try {
                const planRes = await fetch(`${API}/api/chat`, {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({
                    message: `move files from ${src} to ${dst}`,
                    threadId: threadIdRef.current,
                  }),
                });
                const planData = await planRes.json() as AgentResponse;
                if (planData.intent?.approvalPlan) {
                  setPlan(planData.intent.approvalPlan);
                  push('assistant', { type: 'action', action: {
                    label:     planData.intent.approvalPlan.title,
                    icon:      'FolderOpen',
                    count:     planData.intent.approvalPlan.count,
                    detail:    planData.intent.approvalPlan.detail,
                    cta:       'Approve & Move',
                    ctaTarget: 'chat-approval-plan',
                  }});
                  return;
                }
              } catch { /* fall through */ }
            }
            // Single folder — extract from message if intent didn't give one
            const folderForScan = src || (() => {
              const tl = text.toLowerCase();
              const FM: Record<string, string> = {
                desktop: 'Desktop', downloads: 'Downloads', download: 'Downloads',
                documents: 'Documents', document: 'Documents',
                pictures: 'Pictures', picture: 'Pictures',
                videos: 'Videos', music: 'Music',
              };
              for (const [alias, canonical] of Object.entries(FM)) {
                if (tl.includes(alias)) return canonical;
              }
              return 'Desktop';
            })();
            await handleScanStructure(folderForScan, text);
            return;
          }
          default:
            // Unknown intent but agent succeeded — reply already shown
            return;
        }
      } catch (err) {
        console.error('[chat] IBM agent error:', (err as Error).message);
      }

      // IBM agent FAILED — fall through to local pattern matching
      if (!agentSucceeded) {
        const matched = await runLocalRouting(text);
        if (!matched) {
          push('assistant', {
            type: 'text',
            text: `I can help with:\n• **"move files from Desktop to Downloads"**\n• **"find resume.pdf"**\n• **"how many files are in Downloads"**\n• **"show duplicates"**\n• **"storage report"**\n• **"scan folder structure"**`,
          });
        }
      }
    });
  }, [
    typing, setPlan, push, withTyping, runLocalRouting,
    handleFindFile, handleDuplicates, handlePending, handleCleanFolder, handleScanStructure,
    handleShowStructure,
    tryBuildOrganizeApprovalPlan,
  ]);

  const sendQuickAction    = useCallback((cmd: string) => sendMessage(cmd), [sendMessage]);
  const clearApprovalFiles = useCallback(() => setApprovalFiles(null), []);
  const clearApprovalPlan  = useCallback(() => setPlan(null), [setPlan]);

  return {
    messages, typing,
    // mode/setMode kept for backward compat but no longer used for panel
    mode: 'command' as const, setMode: (_: any) => {},
    approvalFiles, clearApprovalFiles,
    approvalPlan, clearApprovalPlan,
    openPlanModalRef,
    sendMessage, sendQuickAction,
    pushMessage: push,
  };
}
