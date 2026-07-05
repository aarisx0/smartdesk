'use strict';

const axios = require('axios');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { query } = require('../../db/supabase');

const ORCHESTRATE_API_URL = (process.env.WATSONX_API_URL || '').trim().replace(/\/+$/, '');
const ORCHESTRATE_API_KEY = (process.env.WATSONX_API_KEY || '').trim();
const ORCHESTRATE_AGENT_ID = (process.env.WATSONX_AGENT_ID || '29847e54-fe41-4afe-8f00-1f1249f5e06a').trim();

let threadId = null;

// ── Per-thread context store ──────────────────────────────────────────────────
// Remembers the last file(s) the agent mentioned per thread so pronouns like
// "delete it", "move it", "it" can be resolved without re-asking the user.
// Structure: Map<threadId, { files: [{name, sourcePath, sizeBytes}], folder: string }>
const threadFileContext = new Map();

/**
 * Store the last found file(s) for a thread so follow-up pronouns work.
 */
function storeThreadFileContext(tid, files, folder) {
  if (!tid) return;
  threadFileContext.set(tid, { files, folder, updatedAt: Date.now() });
  // Evict entries older than 30 minutes to prevent unbounded growth
  const cutoff = Date.now() - 30 * 60 * 1000;
  for (const [k, v] of threadFileContext.entries()) {
    if (v.updatedAt < cutoff) threadFileContext.delete(k);
  }
}

/**
 * Retrieve the last found file context for a thread.
 */
function getThreadFileContext(tid) {
  if (!tid) return null;
  const ctx = threadFileContext.get(tid);
  if (!ctx) return null;
  // Expire after 30 minutes
  if (Date.now() - ctx.updatedAt > 30 * 60 * 1000) {
    threadFileContext.delete(tid);
    return null;
  }
  return ctx;
}

// Track the last time each folder was organized so we can force-refresh context
// after an organize/move operation completes.
const lastOrganizedAt = new Map(); // folderPath -> Date.now()

const planStore = new Map();
const VALID_INTENTS = new Set();

const INTENT = {
  CHAT: 'chat',
  MOVE_FILES: 'move_files',
  DELETE_FILE: 'delete_file',
  RENAME_FILE: 'rename_file',
  CREATE_FOLDER: 'create_folder',
  MOVE_FOLDER: 'move_folder',
  FIND_FILE: 'find_file',
  SHOW_DUPLICATES: 'show_duplicates',
  STORAGE_REPORT: 'storage_report',
  SCAN_STRUCTURE: 'scan_structure',
  SHOW_PENDING: 'show_pending',
  ORGANIZE_FOLDER: 'organize_folder',
  COUNT_FOLDER_ITEMS: 'count_folder_items',
};

Object.values(INTENT).forEach((value) => VALID_INTENTS.add(value));

const FOLDER_ALIASES = {
  // Standard user folders
  desktop: 'Desktop',
  desktops: 'Desktop',
  download: 'Downloads',
  downloads: 'Downloads',
  document: 'Documents',
  documents: 'Documents',
  picture: 'Pictures',
  pictures: 'Pictures',
  photo: 'Pictures',
  photos: 'Pictures',
  image: 'Pictures',
  images: 'Pictures',
  music: 'Music',
  audio: 'Music',
  video: 'Videos',
  videos: 'Videos',
  // Extra common folders
  home: 'Home',
  'home folder': 'Home',
  'my documents': 'Documents',
  'my pictures': 'Pictures',
  'my videos': 'Videos',
  'my music': 'Music',
  'my downloads': 'Downloads',
  // Windows drives / root
  'c drive': 'C:',
  'c:': 'C:',
  'c:\\': 'C:',
  'c:/': 'C:',
  'local disk': 'C:',
  // OneDrive
  onedrive: 'OneDrive',
  'one drive': 'OneDrive',
  // Common dev / work folders
  projects: 'Projects',
  project: 'Projects',
  repos: 'Projects',
  code: 'Projects',
  workspace: 'Projects',
  // Temp / misc
  temp: 'Temp',
  tmp: 'Temp',
  temporary: 'Temp',
};

function getDefaultFolders() {
  const home = os.homedir();
  const folders = {
    Desktop:   path.join(home, 'Desktop'),
    Downloads: path.join(home, 'Downloads'),
    Documents: path.join(home, 'Documents'),
    Pictures:  path.join(home, 'Pictures'),
    Music:     path.join(home, 'Music'),
    Videos:    path.join(home, 'Videos'),
    Home:      home,
    // Common Windows extras
    OneDrive:  path.join(home, 'OneDrive'),
    Projects:  path.join(home, 'Projects'),
    Temp:      os.tmpdir(),
  };

  // NOTE: C:\ root is intentionally NOT included here.
  // Scanning C:\ enumerates system-protected subdirectories (MSOCache, System Volume
  // Information, $Recycle.Bin, etc.) which throw EPERM errors and are never valid
  // places for user files to be moved to/from.

  return folders;
}

async function getWatchedFolders() {
  try {
    const { rows } = await query('SELECT path FROM watched_folders WHERE enabled = true');
    const paths = rows.map((row) => row.path).filter(Boolean);
    if (paths.length > 0) return paths;
  } catch {
    // fall back to standard folders
  }

  const folders = getDefaultFolders();
  return [folders.Desktop, folders.Downloads].filter(Boolean);
}

async function getIamToken() {
  if (!ORCHESTRATE_API_KEY) {
    throw new Error('IBM Orchestrate API key is not configured');
  }

  const response = await axios.post(
    'https://iam.cloud.ibm.com/identity/token',
    new URLSearchParams({
      grant_type: 'urn:ibm:params:oauth:grant-type:apikey',
      apikey: ORCHESTRATE_API_KEY,
    }),
    {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      timeout: 20_000,
    }
  );

  return response.data.access_token;
}

// ─── File system context builders ────────────────────────────────────────────

/**
 * Scan a folder and return a summary of ALL contents (files and immediate
 * subdirectories) so structure queries always reflect the current disk state.
 *
 * We intentionally never cache this — every call reads the actual filesystem
 * so "show me the structure after organising" always returns fresh data.
 *
 * @param {string}  folderPath  Absolute path to scan
 * @param {number}  maxFiles    Max loose files to list (default 150)
 * @param {boolean} deep        If true, also list files inside each subfolder
 */
async function scanFolderForContext(folderPath, maxFiles = 150, deep = false) {
  try {
    const dirents = await fs.readdir(folderPath, { withFileTypes: true });
    const files = [];
    const subfolders = [];

    for (const entry of dirents) {
      if (entry.isFile()) {
        const fullPath = path.join(folderPath, entry.name);
        try {
          const stat = await fs.stat(fullPath);
          files.push({ name: entry.name, sizeBytes: stat.size, isSubfolder: false });
        } catch { /* skip unreadable */ }
      } else if (entry.isDirectory()) {
        subfolders.push(entry.name);
      }
    }

    // Sort loose files by size descending
    files.sort((a, b) => b.sizeBytes - a.sizeBytes);
    const topFiles = files.slice(0, maxFiles);

    // Include subfolder names so structure queries can see the organised folders
    const result = [...topFiles];
    for (const sub of subfolders) {
      result.push({ name: `${sub}/`, sizeBytes: null, isSubfolder: true });
      if (deep) {
        try {
          const subEntries = await fs.readdir(path.join(folderPath, sub), { withFileTypes: true });
          for (const se of subEntries) {
            if (se.isFile()) {
              try {
                const sp = path.join(folderPath, sub, se.name);
                const st = await fs.stat(sp);
                result.push({ name: `  ${sub}/${se.name}`, sizeBytes: st.size, isSubfolder: false });
              } catch { /* skip */ }
            }
          }
        } catch { /* skip unreadable subfolder */ }
      }
    }

    return result;
  } catch {
    return [];
  }
}

/**
 * Format a file list as a compact text block for the system prompt.
 * Entries that are subfolder names (isSubfolder=true) are displayed with a
 * different prefix so the agent understands the current folder layout.
 */
function formatFileListForPrompt(folderLabel, files) {
  if (files.length === 0) return `${folderLabel}: (empty or no access)`;
  const lines = files.map((f) => {
    if (f.isSubfolder) return `  [folder] ${f.name}`;
    const kb = !f.sizeBytes ? '—'
      : f.sizeBytes < 1024 ? `${f.sizeBytes}B`
      : f.sizeBytes < 1048576 ? `${(f.sizeBytes/1024).toFixed(0)}KB`
      : f.sizeBytes < 1073741824 ? `${(f.sizeBytes/1048576).toFixed(1)}MB`
      : `${(f.sizeBytes/1073741824).toFixed(2)}GB`;
    return `  - ${f.name} (${kb})`;
  });
  const fileCount = files.filter((f) => !f.isSubfolder).length;
  const folderCount = files.filter((f) => f.isSubfolder).length;
  const summary = [
    fileCount > 0 && `${fileCount} loose file${fileCount === 1 ? '' : 's'}`,
    folderCount > 0 && `${folderCount} subfolder${folderCount === 1 ? '' : 's'}`,
  ].filter(Boolean).join(', ');
  return `${folderLabel} (${summary}):\n${lines.join('\n')}`;
}

/**
 * Detect which folders are relevant to the user's message so we only scan those.
 * Handles:
 *  - Known aliases (desktop, downloads, c drive, etc.)
 *  - Absolute paths anywhere in the message (C:\..., /home/..., etc.)
 *  - Quoted folder names ("My Projects")
 */
function detectRelevantFolders(message, defaultFolders) {
  const t = message.toLowerCase();
  const relevant = [];

  const addIfNew = (label, folderPath) => {
    if (!relevant.find((f) => f.path === folderPath)) {
      relevant.push({ label, path: folderPath });
    }
  };

  // 1. Match known aliases
  for (const [alias, canonical] of Object.entries(FOLDER_ALIASES)) {
    if (t.includes(alias)) {
      const folderPath = defaultFolders[canonical];
      if (folderPath) addIfNew(canonical, folderPath);
      else {
        // canonical may itself be an alias for a resolved path
        const resolved = resolveFolderRef(canonical);
        if (resolved) addIfNew(resolved.label, resolved.path);
      }
    }
  }

  // 2. Extract absolute Windows paths (C:\...) or Unix paths (/home/...)
  const WIN_PATH  = /[A-Za-z]:[\\\/][^\s"',;)>]*/g;
  const UNIX_PATH = /\/(?:home|usr|var|tmp|mnt|media|opt|root)[^\s"',;)>]*/g;
  for (const re of [WIN_PATH, UNIX_PATH]) {
    let m;
    while ((m = re.exec(message)) !== null) {
      const raw = m[0].replace(/[\\\/]+$/, ''); // strip trailing slashes
      if (raw.length > 2) addIfNew(raw, raw);
    }
  }

  // 3. Quoted folder names that might be custom paths: "My Projects", "Work Stuff"
  const QUOTED = /["']([^"']{3,80})["']/g;
  let qm;
  while ((qm = QUOTED.exec(message)) !== null) {
    const candidate = qm[1].trim();
    // Skip if it looks like a filename (has extension)
    if (/\.[a-z0-9]{1,6}$/i.test(candidate)) continue;
    // Try to resolve relative to home
    const resolved = resolveFolderRef(candidate);
    if (resolved) addIfNew(resolved.label, resolved.path);
  }

  // 4. Fallback: if nothing matched, scan Desktop + Downloads
  if (relevant.length === 0) {
    const fallbacks = ['Desktop', 'Downloads'];
    for (const label of fallbacks) {
      if (defaultFolders[label]) addIfNew(label, defaultFolders[label]);
    }
  }

  return relevant;
}

/**
 * Build a file system context string to inject into the system prompt.
 * This gives the agent real data to answer questions accurately.
 *
 * For structure / "show me" queries we do a deep scan (1 level into each
 * subfolder) so the agent sees the organised state of the folder, not just
 * the loose files sitting at the root.
 */
async function buildFileSystemContext(message, defaultFolders) {
  const relevantFolders = detectRelevantFolders(message, defaultFolders);
  const sections = [];

  // A "structure" query should show subfolders and their contents
  const isStructureQuery = /\b(structure|show|list|what.*in|content|organised|organized|after.*organis|after.*organiz)\b/i.test(message);

  for (const folder of relevantFolders) {
    const files = await scanFolderForContext(folder.path, 200, isStructureQuery);
    sections.push(formatFileListForPrompt(folder.label, files));
  }

  if (sections.length === 0) return '';
  return '\n\nCURRENT FILE SYSTEM CONTEXT (real live data from disk — reflects any recent changes):\n' + sections.join('\n\n');
}

// ─── System prompt ────────────────────────────────────────────────────────────

function buildSystemPrompt(context) {
  return [
    'You are SmartDesk AI, a desktop file organizer assistant running on the user\'s computer.',
    'You have been given REAL, LIVE file system data below — use it to answer questions accurately.',
    'IMPORTANT: The file system context below was just read from disk right now. It reflects the current actual state of the folders, including any recent organising or moves. Always trust this injected data over anything in conversation history.',
    'You can work with ANY folder on the user\'s system — not just the standard ones. If the user mentions a path like C:\\Users\\ASUS\\Projects or any custom folder, use it directly as the source or destination.',
    'Interpret the user message and choose exactly one intent.',
    'Be conversational, friendly, and concise in the reply field.',
    'Never claim a file was moved, deleted, or renamed already. File changes require approval first.',
    'You must return valid JSON only. Do not wrap it in markdown.',
    'Return JSON only with this shape:',
    '{',
    '  "reply": "short helpful reply for the user",',
    '  "intent": {',
    '    "type": "chat | move_files | delete_file | rename_file | create_folder | move_folder | find_file | show_duplicates | storage_report | scan_structure | show_pending | organize_folder | count_folder_items",',
    '    "query": "string or null",',
    '    "source": "folder name/path or null — can be ANY path the user mentioned",',
    '    "destination": "folder name/path or null — can be ANY path the user mentioned",',
    '    "folderHint": "folder name/path or null — can be ANY path the user mentioned"',
    '  }',
    '}',
    'Use move_files when the user wants files moved from one folder to another.',
    'Use delete_file when the user wants to delete or remove a specific file (files are safely moved to SmartDesk Trash, not permanently deleted).',
    'Use rename_file when the user wants to rename a file.',
    'Use create_folder when the user asks to create a new folder (optionally and move a file into it).',
    'Use move_folder when the user asks to move one folder into another folder.',
    'Use organize_folder when the user asks to organize/clean a specific folder.',
    'Use scan_structure when the user asks for reorganization suggestions or a broader folder review.',
    'Use find_file when the user is asking where a file is or wants a file search.',
    'Use count_folder_items when the user asks how many files are in a folder.',
    'For find_file, set query to the cleaned search phrase only (no greetings or filler words). Use the file system context to confirm if the file exists and mention it in the reply.',
    'For count_folder_items, answer the count directly from the file system context above.',
    'For largest/smallest file questions, inspect the file system context and answer with the filename and size.',
    'When the user asks to "show structure", "show what is in", or "list contents" of a folder, use type "chat" and describe the current folder layout using the injected file system context (subfolders and files listed above).',
    'If the user mentions a drive (like C: drive, D: drive) or any absolute path, set source/folderHint to that path exactly.',
    'If you are missing details for an action, keep the reply conversational and set type to chat.',
    'Examples:',
    '{"reply":"I found resume.pdf in Downloads (245KB).","intent":{"type":"find_file","query":"resume","source":null,"destination":null,"folderHint":"Downloads"}}',
    '{"reply":"There are 42 files directly in Downloads.","intent":{"type":"count_folder_items","query":null,"source":"Downloads","destination":null,"folderHint":"Downloads"}}',
    '{"reply":"I can prepare a plan to organise C:\\\\Users\\\\ASUS\\\\Projects.","intent":{"type":"organize_folder","query":null,"source":"C:\\\\Users\\\\ASUS\\\\Projects","destination":null,"folderHint":"C:\\\\Users\\\\ASUS\\\\Projects"}}',
    '{"reply":"I can prepare a plan to move nasri rifana resume.pdf from Desktop to Downloads.","intent":{"type":"move_files","query":null,"source":"Desktop","destination":"Downloads","folderHint":"Desktop"}}',
    '{"reply":"I can prepare a plan to delete report.pdf from Desktop. It will be moved to SmartDesk Trash safely.","intent":{"type":"delete_file","query":"report.pdf","source":"Desktop","destination":null,"folderHint":"Desktop"}}',
    `Available watched folders: ${JSON.stringify(context.watchedFolders)}`,
    `Default folders available: ${JSON.stringify(context.defaultFolders)}`,
    context.fileSystemContext || '',
  ].filter(Boolean).join('\n');
}

async function askOrchestrate(message, incomingThreadId) {
  if (!ORCHESTRATE_API_URL) {
    throw new Error('IBM Orchestrate URL is not configured');
  }

  const token = await getIamToken();
  const watchedFolders = await getWatchedFolders();
  const defaultFolders = getDefaultFolders();

  // Scan relevant folders and inject real file data into the system prompt
  const fileSystemContext = await buildFileSystemContext(message, defaultFolders);

  const headers = {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
  };

  // Use the thread ID passed from the client for conversation continuity.
  // If we have a thread ID the system prompt with file context goes in,
  // but the agent also remembers previous turns via the thread.
  const activeThreadId = incomingThreadId || threadId;
  if (activeThreadId) {
    headers['X-IBM-THREAD-ID'] = activeThreadId;
  }

  // Always inject current file context in the user message so the agent has
  // fresh file data regardless of thread memory.
  let userMessage = message;
  if (fileSystemContext) {
    userMessage = message + '\n\n[SmartDesk context (current file system data):\n' + fileSystemContext + ']';
  }

  const response = await axios.post(
    `${ORCHESTRATE_API_URL}/v1/orchestrate/${ORCHESTRATE_AGENT_ID}/chat/completions`,
    {
      stream: false,
      messages: [
        { role: 'system', content: buildSystemPrompt({ watchedFolders, defaultFolders, fileSystemContext }) },
        { role: 'user', content: userMessage },
      ],
    },
    {
      headers,
      timeout: 45_000,
    }
  );

  // Store thread ID so subsequent stateless calls can reuse it if client doesn't send one
  const newThreadId = response.data?.thread_id;
  if (newThreadId) threadId = newThreadId;

  return response.data;
}

function flattenContent(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';

  return content.map((item) => {
    if (typeof item === 'string') return item;
    if (typeof item?.text === 'string') return item.text;
    if (typeof item?.message === 'string') return item.message;
    if (typeof item?.content === 'string') return item.content;
    if (typeof item?.title === 'string') return item.title;
    return '';
  }).filter(Boolean).join('\n');
}

function extractAssistantText(data) {
  const choices = Array.isArray(data?.choices) ? data.choices : [];

  for (const choice of choices) {
    const variants = [
      choice?.message?.content,
      choice?.delta?.content,
      choice?.content,
      choice?.text,
    ];

    for (const variant of variants) {
      const text = flattenContent(variant);
      if (text) return text;
      if (typeof variant === 'string' && variant.trim()) return variant.trim();
    }
  }

  return '';
}

function parseJsonObject(raw) {
  if (!raw) return null;
  const cleaned = String(raw)
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '')
    .trim();

  try {
    return JSON.parse(cleaned);
  } catch {
    const match = cleaned.match(/\{[\s\S]*\}/);
    if (!match) return null;
    try {
      return JSON.parse(match[0]);
    } catch {
      return null;
    }
  }
}

function normalizeTextField(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

/**
 * Classify intent purely from the text of a message (either the user's original
 * message or the agent's reply when it doesn't return JSON).
 *
 * This is the safety net used when the IBM Orchestrate agent ignores the system
 * prompt and returns a free-form response instead of the required JSON structure.
 * It must be reliable enough to correctly route every common action.
 *
 * @param {string} text        The text to classify (agent reply or user message)
 * @param {string} [userMsg]   The original user message — preferred when available
 */
function inferIntentFromText(text, userMsg) {
  // Always prefer classifying from the original user message when available —
  // it's shorter, more direct, and not contaminated by the agent's verbose refusals.
  const primary = (userMsg || text || '').toLowerCase();
  const fallback = (text || '').toLowerCase();

  const t = primary || fallback;

  // ── Delete / remove / trash ──────────────────────────────────────────────
  if (/\b(delete|remove|trash|erase|get\s+rid\s+of|wipe)\b/i.test(t))
    return { type: INTENT.DELETE_FILE, query: null, source: null, destination: null, folderHint: null };

  // ── Rename ────────────────────────────────────────────────────────────────
  if (/\brename\b/i.test(t))
    return { type: INTENT.RENAME_FILE, query: null, source: null, destination: null, folderHint: null };

  // ── Create folder ─────────────────────────────────────────────────────────
  if (/\b(create|make|new)\b.*\bfolder\b/i.test(t))
    return { type: INTENT.CREATE_FOLDER, query: null, source: null, destination: null, folderHint: null };

  // ── Move folder ───────────────────────────────────────────────────────────
  if (/\bmove\b.*\bfolder\b.*\bto\b/i.test(t))
    return { type: INTENT.MOVE_FOLDER, query: null, source: null, destination: null, folderHint: null };

  // ── Move files ────────────────────────────────────────────────────────────
  if (/\bmove\b.*\b(from|to)\b/i.test(t))
    return { type: INTENT.MOVE_FILES, query: null, source: null, destination: null, folderHint: null };

  // ── Find / search / list (broad — catches "list all exe", "show me pdfs", etc.) ──
  if (/\b(find|where\s+is|locate|search(\s+for|\s+through)?|look\s+for|list\s+(all|the|my)?|show\s+(me\s+)?all|show\s+(me\s+)?the|get\s+(me\s+)?all)\b/i.test(t))
    return { type: INTENT.FIND_FILE, query: null, source: null, destination: null, folderHint: null };

  // ── Duplicates ────────────────────────────────────────────────────────────
  if (/\b(duplicate|duplicate\s+files?|same\s+file|copies)\b/i.test(t))
    return { type: INTENT.SHOW_DUPLICATES, query: null, source: null, destination: null, folderHint: null };

  // ── Storage / disk usage ──────────────────────────────────────────────────
  if (/\b(storage\s+report|disk\s+usage|disk\s+space|how\s+much\s+space|storage\s+usage)\b/i.test(t))
    return { type: INTENT.STORAGE_REPORT, query: null, source: null, destination: null, folderHint: null };

  // ── Count files ───────────────────────────────────────────────────────────
  if (/\b(how\s+many\s+files?|count\s+(?:the\s+)?files?|number\s+of\s+files?)\b/i.test(t))
    return { type: INTENT.COUNT_FOLDER_ITEMS, query: null, source: null, destination: null, folderHint: null };

  // ── Organise / clean ──────────────────────────────────────────────────────
  if (/\b(organis[e]?|organiz[e]?|clean\s+up|tidy\s+up|sort\s+out)\b/i.test(t))
    return { type: INTENT.ORGANIZE_FOLDER, query: null, source: null, destination: null, folderHint: null };

  // ── Scan / analyse structure ──────────────────────────────────────────────
  if (/\b(scan|analyse?|analyze)\b.*\b(folder|structure|files?)\b/i.test(t))
    return { type: INTENT.SCAN_STRUCTURE, query: null, source: null, destination: null, folderHint: null };

  // ── Pending approvals ──────────────────────────────────────────────────────
  if (/\b(pending|waiting\s+for\s+approval|show\s+pending)\b/i.test(t))
    return { type: INTENT.SHOW_PENDING, query: null, source: null, destination: null, folderHint: null };

  return { type: INTENT.CHAT, query: null, source: null, destination: null, folderHint: null };
}

// Keep old name as alias so nothing else breaks
const inferIntentFromPlainText = inferIntentFromText;

/**
 * Parse the agent response (JSON or plain text) into a normalized reply+intent.
 *
 * @param {string}      raw             Raw text from the agent
 * @param {string|null} originalUserMsg The user's original message — used to
 *                                      correctly infer intent when the agent
 *                                      ignores the JSON format instruction.
 */
function normalizeIntent(raw, originalUserMsg) {
  // Try to parse structured JSON first
  const parsed = parseJsonObject(raw);

  if (parsed && typeof parsed === 'object' && parsed.intent?.type) {
    const intent = parsed.intent;
    const type = normalizeTextField(intent.type);
    if (!type || !VALID_INTENTS.has(type)) {
      // Unknown intent type — treat as plain chat reply
      return {
        reply: normalizeTextField(parsed.reply) || raw,
        intent: { type: INTENT.CHAT, query: null, source: null, destination: null, folderHint: null },
        meta: { source: 'ibm', available: true },
      };
    }
    return {
      reply: normalizeTextField(parsed.reply)
        || 'I can help with that. If anything changes files, I will show you the plan before doing it.',
      intent: {
        type,
        query:       normalizeTextField(intent.query),
        source:      normalizeTextField(intent.source),
        destination: normalizeTextField(intent.destination),
        folderHint:  normalizeTextField(intent.folderHint),
      },
      meta: { source: 'ibm', available: true },
    };
  }

  // Agent returned plain text (not JSON) — the IBM Orchestrate agent ignored the
  // system prompt JSON instruction. Use the agent's text as the user-facing reply
  // but infer the intent from the ORIGINAL USER MESSAGE (more reliable than the
  // agent's verbose refusal text which often doesn't mention the action type).
  const plainText = (typeof raw === 'string' ? raw : '').trim();
  if (plainText) {
    const inferred = inferIntentFromText(plainText, originalUserMsg);

    // Detect agent "refusal" or confusion responses (agent acting like a general
    // assistant instead of SmartDesk). Replace them with a helpful SmartDesk reply.
    // IMPORTANT: do NOT replace replies that contain useful file info (paths, sizes,
    // locations) — those are legitimate answers the user needs to see.
    const hasUsefulFileInfo =
      /\b(found|located|present|exists?|path|folder|directory|downloads?|desktop|documents?|pictures?|\.jpg|\.png|\.pdf|\.exe|\.mp4|\.zip|→|├|└|KB|MB|GB)\b/i.test(plainText);

    const isAgentConfusion =
      !hasUsefulFileInfo && (
        /I\s+(don'?t|do\s+not|cannot|can'?t)\s+(have|access|use|perform|execute|directly)\b/i.test(plainText) ||
        /\b(filesystem|file\s*system|modification\s+tool|command.?line\s+access|tool\s+available|no\s+tool)\b/i.test(plainText) ||
        /\b(provide\s+a\s+tool|provide\s+command|allow\s+file\s+removal|execute\s+the\s+plan\s+immediately)\b/i.test(plainText) ||
        // IBM saying it has no environment/tool to execute the operation
        /\b(environment\s+does\s+not\s+provide|does\s+not\s+provide\s+a?\s+file|no\s+file.?system\s+tool|cannot\s+invoke|grant\s+access\s+to\s+a\s+(deletion|file|tool))\b/i.test(plainText) ||
        /\b(run\s+the\s+deletions\s+from\s+your\s+side|carry\s+out\s+the\s+deletions|need\s+a\s+tool\s+that\s+can\s+(remove|delete|move))\b/i.test(plainText)
      );

    let replyToUser = plainText;
    if (isAgentConfusion) {
      // Build a helpful contextual reply based on the inferred intent
      if (inferred.type === INTENT.DELETE_FILE) {
        replyToUser = 'I can prepare a safe deletion plan for those files. SmartDesk will move them to the Trash folder (recoverable) — nothing is permanently deleted without your approval.';
      } else if (inferred.type === INTENT.MOVE_FILES) {
        replyToUser = 'I can prepare a move plan for those files. Review it and approve before anything is changed.';
      } else if (inferred.type === INTENT.ORGANIZE_FOLDER || inferred.type === INTENT.SCAN_STRUCTURE) {
        replyToUser = 'I can scan that folder and build an organisation plan. Review the suggested moves and approve to proceed.';
      } else if (inferred.type === INTENT.FIND_FILE) {
        replyToUser = 'Let me search for that file across your watched folders.';
      } else {
        replyToUser = 'I can help with that. Let me prepare the plan — everything needs your approval before any files are changed.';
      }
    }

    return {
      reply: replyToUser,
      intent: inferred,
      meta: { source: 'ibm', available: true },
    };
  }

  throw new Error('IBM Orchestrate returned an empty response');
}

function buildUnavailableFallback() {
  return {
    reply: 'I cannot reach the IBM assistant right now, so I cannot reliably interpret that request. Please try again in a moment.',
    intent: {
      type: INTENT.CHAT,
      query: null,
      source: null,
      destination: null,
      folderHint: null,
    },
    meta: {
      source: 'fallback',
      available: false,
    },
  };
}

function cleanupFolderPhrase(value) {
  return String(value || '')
    .replace(/[.?!]+$/, '')
    .replace(/^(the|my)\s+/i, '')
    .replace(/\s+folder$/i, '')
    .trim();
}

function resolveFolderRef(input) {
  if (!input) return null;

  const cleaned = cleanupFolderPhrase(input).replace(/^"|"$/g, '');
  if (!cleaned) return null;

  const defaults = getDefaultFolders();

  // 1. Exact match in defaults (case-insensitive)
  const lc = cleaned.toLowerCase();
  const exactDefault = Object.entries(defaults).find(([label]) => label.toLowerCase() === lc);
  if (exactDefault) return { label: exactDefault[0], path: exactDefault[1] };

  // 2. Alias lookup
  const mapped = FOLDER_ALIASES[lc];
  if (mapped && defaults[mapped]) return { label: mapped, path: defaults[mapped] };

  // 3. Already absolute path
  if (path.isAbsolute(cleaned)) {
    return { label: cleaned, path: cleaned };
  }

  // 4. Windows drive root shorthand: "C:", "D:" etc.
  if (/^[A-Za-z]:$/.test(cleaned)) {
    return { label: cleaned.toUpperCase(), path: cleaned.toUpperCase() + '\\' };
  }

  // 5. Looks like a relative sub-path (e.g. "Users/ASUS/Projects") — resolve under drive root on Windows
  if (process.platform === 'win32' && /^[A-Za-z]:[\\\/]/.test(cleaned)) {
    return { label: cleaned, path: cleaned };
  }

  // 6. Subfolder path like "Downloads/Images" or "Downloads\Images" —
  //    check if the first segment is a known top-level folder alias,
  //    then resolve the full path under home.
  //    e.g. "Downloads/Images" → home/Downloads/Images with label "Downloads/Images"
  const sep = cleaned.includes('/') ? '/' : cleaned.includes('\\') ? '\\' : null;
  if (sep) {
    const parts = cleaned.split(/[/\\]/);
    const topSegment = parts[0].toLowerCase();
    // Check if the top segment resolves to a known folder alias or default folder name
    const topAlias = FOLDER_ALIASES[topSegment];
    const topDefaultKey = topAlias
      ? topAlias
      : Object.keys(defaults).find((k) => k.toLowerCase() === topSegment);
    const topDefault = topDefaultKey ? defaults[topDefaultKey] : null;
    if (topDefault) {
      // Build full path: replace the first segment with the resolved absolute path
      const rest = parts.slice(1);
      const resolvedPath = path.join(topDefault, ...rest);
      // Use the original input as the label (e.g. "Downloads/Images") to preserve context
      return { label: cleaned, path: resolvedPath };
    }
    // Even if top segment isn't known, try resolving relative to home
    const homeCandidate = path.join(os.homedir(), cleaned);
    return { label: cleaned, path: homeCandidate };
  }

  // 7. Try home/<name>
  const homeCandidate = path.join(os.homedir(), cleaned);
  return { label: cleaned, path: homeCandidate };
}

async function listDirectFiles(folderPath) {
  const dirents = await fs.readdir(folderPath, { withFileTypes: true });
  const items = [];

  for (const entry of dirents) {
    if (!entry.isFile()) continue;
    const sourcePath = path.join(folderPath, entry.name);
    let stats;
    try {
      stats = await fs.stat(sourcePath);
    } catch {
      continue;
    }
    items.push({
      name: entry.name,
      sourcePath,
      sizeBytes: stats.size,
    });
  }

  return items;
}

async function countDirectFiles(folderPath) {
  const items = await listDirectFiles(folderPath);
  return items.length;
}

async function ensureFolderExists(folderPath) {
  try {
    const stats = await fs.stat(folderPath);
    return stats.isDirectory();
  } catch {
    return false;
  }
}

async function pathExists(targetPath) {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

function isSubPath(parentPath, childPath) {
  const parent = path.resolve(parentPath);
  const child = path.resolve(childPath);
  return child === parent || child.startsWith(parent + path.sep);
}

function parseFolderMoveRequest(message) {
  const trimmed = String(message || '').trim();
  const full = trimmed.match(/\bmove\s+(?:the\s+)?folder\s+["']?([^"']+?)["']?(?:\s+from\s+["']?([^"']+?)["']?)?\s+to\s+["']?([^"']+?)["']?\s*[.?!]*$/i);
  if (!full) return null;
  return {
    folderName: full[1]?.trim() || null,
    sourceBase: full[2]?.trim() || null,
    destination: full[3]?.trim() || null,
  };
}

function parseCreateFolderRequest(message) {
  const trimmed = String(message || '').trim();
  const nameMatch = trimmed.match(/\bcreate\s+(?:a\s+)?folder(?:\s+named)?\s+["']?([^"']+?)["']?(?=\s+(?:in|inside|under)\b|\s*(?:and|then)\s+move\b|[.?!]?$)/i);
  if (!nameMatch) return null;

  const locationMatch = trimmed.match(/\b(?:in|inside|under)\s+["']?([^"']+?)["']?(?=\s*(?:and|then)\s+move\b|[.?!]?$)/i);
  const moveMatch = trimmed.match(/\b(?:and|then)\s+move\s+(.+?)(?:\s+from\s+(.+?))?\s+(?:into|to)\s+(?:it|that\s+folder|the\s+folder)\b/i);

  return {
    folderName: nameMatch[1]?.trim() || null,
    parentRef: locationMatch?.[1]?.trim() || null,
    fileHint: moveMatch?.[1]?.trim() || null,
    fileSourceRef: moveMatch?.[2]?.trim() || null,
  };
}

function createUniqueTarget(basePath, existingNames) {
  if (!existingNames.has(basePath.toLowerCase())) {
    existingNames.add(basePath.toLowerCase());
    return basePath;
  }

  const parsed = path.parse(basePath);
  let index = 1;
  while (true) {
    const candidate = path.join(parsed.dir, `${parsed.name} (${index})${parsed.ext}`);
    if (!existingNames.has(candidate.toLowerCase())) {
      existingNames.add(candidate.toLowerCase());
      return candidate;
    }
    index += 1;
  }
}

/**
 * Extract the specific filename from a message.
 * Also handles path references like "Downloads/Images/aizen.jpg" — returns
 * just the basename ("aizen.jpg") and stores the folder hint as a side-effect
 * via the returned object's folderRef property when the path has a folder prefix.
 *
 * Returns a string (filename) or null if none found.
 * When a path reference is found, the returned string is the basename only —
 * use extractSpecificFileWithFolder for the full result.
 */
function extractSpecificFile(message) {
  // Match quoted filenames: "resume.pdf" or 'resume.pdf'
  const quoted = message.match(/["']([^"']+\.[a-z0-9]+)["']/i);
  if (quoted) return path.basename(quoted[1]); // strip any path prefix from quoted names

  // Match path-like references: Downloads/Images/aizen.jpg or Downloads\Images\aizen.jpg
  // This handles "delete the Downloads/Images/aizen.jpg" style messages
  const pathRef = message.match(/\b([A-Za-z][A-Za-z0-9_\s\-]*[/\\][A-Za-z0-9_\s/\\\-\.]+\.(pdf|docx?|txt|jpg|jpeg|png|mp4|mp3|exe|msi|zip|rar|csv|xlsx?|iso|dmg|deb|rpm|7z|tar|gz|apk|jar))\b/i);
  if (pathRef) return path.basename(pathRef[1]);

  // Match "file named X" or "file called X" or "named X" or "called X"
  const named = message.match(/(?:file\s+(?:named|called)\s+|named\s+|called\s+)([^\s,]+\.[a-z0-9]+)/i);
  if (named) return named[1];
  // Match filename patterns — must NOT start with a command verb
  // Pattern: one or more words (no leading verb) followed by .extension
  // Strip leading action verbs first
  const stripped = message
    .replace(/^\s*(?:move|delete|remove|trash|copy|rename|find|open)\s+/i, '')
    .replace(/\b(?:from|to|in|at|into)\b.*/i, '')
    .trim();
  const filePattern = stripped.match(/^([a-zA-Z0-9_\s\-\.]+\.(pdf|docx?|txt|jpg|jpeg|png|mp4|mp3|exe|msi|zip|rar|csv|xlsx?|iso|dmg|deb|rpm|7z|tar|gz|apk|jar))\s*$/i);
  if (filePattern) return filePattern[1].trim();
  // Match natural language file hints without extension:
  // "move resume file from Desktop to Downloads", "delete the invoice from Documents"
  const natural = message.match(/\b(?:move|delete|remove|trash|rename)\s+(?:the\s+|my\s+|a\s+|an\s+)?(.+?)\s+(?:from|to|in|into)\b/i);
  if (natural) {
    const hint = natural[1]
      .replace(/\b(files?|folder)\b/ig, ' ')
      .replace(/[.?!,]+$/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    const generic = /^(all|everything|stuff|items?|files?|a|an|the|one)$/i;
    if (hint && !generic.test(hint)) return hint;
  }
  return null;
}

/**
 * Like extractSpecificFile but also returns the folder path prefix if the user
 * specified a path like "Downloads/Images/aizen.jpg".
 * Returns { filename, folderRef } where folderRef may be null.
 */
function extractSpecificFileWithFolder(message) {
  // Match path-like references: Downloads/Images/aizen.jpg or Downloads\Images\aizen.jpg
  const pathRef = message.match(/\b([A-Za-z][A-Za-z0-9_\s\-]*[/\\][A-Za-z0-9_\s/\\\-\.]+\.(pdf|docx?|txt|jpg|jpeg|png|mp4|mp3|exe|msi|zip|rar|csv|xlsx?|iso|dmg|deb|rpm|7z|tar|gz|apk|jar))\b/i);
  if (pathRef) {
    const fullPath = pathRef[1];
    const parts = fullPath.split(/[/\\]/);
    const filename = parts[parts.length - 1];
    const folderRef = parts.slice(0, -1).join('/');
    return { filename, folderRef: folderRef || null };
  }

  // Quoted path references: "Downloads/Images/aizen.jpg"
  const quoted = message.match(/["']([^"']+\.[a-z0-9]+)["']/i);
  if (quoted) {
    const fullPath = quoted[1];
    const sep = fullPath.includes('/') || fullPath.includes('\\');
    if (sep) {
      const parts = fullPath.split(/[/\\]/);
      const filename = parts[parts.length - 1];
      const folderRef = parts.slice(0, -1).join('/');
      return { filename, folderRef: folderRef || null };
    }
    return { filename: fullPath, folderRef: null };
  }

  const filename = extractSpecificFile(message);
  return { filename, folderRef: null };
}

function selectFilesByHint(files, fileHint) {
  const hint = normalizeTextField(fileHint);
  if (!hint) return { type: 'all', files };

  const cleanedHint = hint
    .replace(/^["']|["']$/g, '')
    .replace(/\b(files?|folder)\b/ig, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();

  const generic = /^(all|everything|stuff|items?|files?|a|an|the|one)$/i;
  if (!cleanedHint || generic.test(cleanedHint)) {
    return { type: 'all', files };
  }

  const exact = files.filter((f) => f.name.toLowerCase() === cleanedHint);
  if (exact.length === 1) return { type: 'single', files: exact };
  if (exact.length > 1) return { type: 'ambiguous', files: exact };

  const hintBase = path.parse(cleanedHint).name;
  const baseExact = files.filter((f) => path.parse(f.name.toLowerCase()).name === hintBase);
  if (baseExact.length === 1) return { type: 'single', files: baseExact };
  if (baseExact.length > 1) return { type: 'ambiguous', files: baseExact };

  const partial = files.filter((f) => {
    const lower = f.name.toLowerCase();
    const lowerBase = path.parse(lower).name;
    return lower.includes(cleanedHint) || lowerBase.includes(cleanedHint);
  });

  if (partial.length === 1) return { type: 'single', files: partial };
  if (partial.length > 1) return { type: 'ambiguous', files: partial };

  // Word-level partial match: "aizen image" → each word checked against basename.
  // This handles natural-language hints without an extension,
  // e.g. "aizen image" should match "aizen.jpg" because the first word "aizen"
  // matches the file's basename.
  const hintWords = cleanedHint.split(/\s+/).filter((w) => w.length > 2);
  if (hintWords.length > 0) {
    const wordMatch = files.filter((f) => {
      const lowerBase = path.parse(f.name.toLowerCase()).name;
      return hintWords.every((w) => lowerBase.includes(w)) ||
             hintWords.some((w) => lowerBase === w);
    });
    if (wordMatch.length === 1) return { type: 'single', files: wordMatch };
    if (wordMatch.length > 1) return { type: 'ambiguous', files: wordMatch };
  }

  return { type: 'none', files: [] };
}

async function buildDeletePlan(intent, specificFile = null) {
  const rawSource = intent.source || intent.folderHint;
  let source = resolveFolderRef(rawSource);

  // When IBM returns delete_file with no source, search all watched folders
  if (!source) {
    const fileHint = normalizeTextField(specificFile || intent.query);
    if (fileHint) {
      // Try to find the file across all default folders
      const found = await findSingleFileAcrossDefaultFolders(fileHint);
      if (found.type === 'single' && found.match) {
        source = { label: path.basename(found.match.folderPath), path: found.match.folderPath };
      } else if (found.type === 'ambiguous') {
        const options = found.matches.slice(0, 5).map((m) => `"${m.file.name}" in ${path.basename(m.folderPath)}`).join(', ');
        return {
          reply: `I found multiple matches for "${fileHint}": ${options}. Which one do you want to delete?`,
          intent: { type: INTENT.CHAT, query: null, source: null, destination: null, folderHint: null },
        };
      }
    }
    // Still no source — fall back to watched folders as the search scope
    if (!source) {
      const watchedPaths = await getWatchedFolders();
      if (watchedPaths.length > 0) {
        source = { label: path.basename(watchedPaths[0]), path: watchedPaths[0] };
      } else {
        return {
          reply: 'I need to know which folder the file is in before I can prepare a delete plan. Could you tell me where to look?',
          intent: { type: INTENT.CHAT, query: null, source: null, destination: null, folderHint: null },
        };
      }
    }
  }

  // If the resolved folder doesn't exist, it might be a subfolder path like
  // "Downloads/Images" — try resolving it relative to home.
  let sourceExists = await ensureFolderExists(source.path);
  if (!sourceExists && rawSource) {
    const homeBased = path.join(os.homedir(), rawSource);
    if (await ensureFolderExists(homeBased)) {
      source = { label: rawSource, path: homeBased };
      sourceExists = true;
    }
  }

  if (!sourceExists) {
    // Last resort: search the file across all default folders
    const fileHint = normalizeTextField(specificFile || intent.query);
    if (fileHint) {
      const found = await findSingleFileAcrossDefaultFolders(fileHint);
      if (found.type === 'single' && found.match) {
        source = { label: path.basename(found.match.folderPath), path: found.match.folderPath };
        sourceExists = true;
        intent = { ...intent, source: source.label };
      }
    }
  }

  if (!sourceExists) {
    return {
      reply: `I could not find the folder "${source.label}" on this device.`,
      intent: { type: INTENT.CHAT, query: null, source: source.label, destination: null, folderHint: source.label },
    };
  }

  // Determine which file(s) to delete
  const fileToDelete = normalizeTextField(specificFile || intent.query);
  const allFiles = await listDirectFiles(source.path);

  // When no specific file name given, include ALL files in the folder.
  // This handles "delete the exe files", "delete unnecessary files", etc.
  // where IBM has the context but didn't parse an exact filename.
  if (!fileToDelete) {
    if (allFiles.length === 0) {
      return {
        reply: `There are no files directly in **${source.label}** to delete.`,
        intent: { type: INTENT.CHAT, query: null, source: source.label, destination: null, folderHint: source.label },
      };
    }
    // Include all files — the approval modal lets the user deselect any they want to keep
    const trashDir = path.join(os.homedir(), '.SmartDesk', 'Trash');
    const planId = crypto.randomUUID();
    const existingNames = new Set();
    const items = allFiles.map((file) => ({
      operation: 'delete',
      name: file.name,
      sourcePath: file.sourcePath,
      targetPath: createUniqueTarget(path.join(trashDir, file.name), existingNames),
      newName: null,
      sizeBytes: file.sizeBytes,
    }));
    const plan = {
      id: planId,
      type: INTENT.DELETE_FILE,
      title: `Delete ${items.length} file${items.length === 1 ? '' : 's'} from ${source.label}`,
      detail: 'Files will be moved to ~/.SmartDesk/Trash/ and can be recovered.',
      sourceLabel: source.label,
      destinationLabel: 'SmartDesk Trash',
      sourcePath: source.path,
      destinationPath: trashDir,
      count: items.length,
      items,
      createdAt: new Date().toISOString(),
    };
    planStore.set(planId, plan);
    return {
      reply: `I prepared a plan to delete **${items.length} file${items.length === 1 ? '' : 's'}** from **${source.label}**. They will be moved to SmartDesk Trash (recoverable). Review and approve to proceed.`,
      intent: {
        type: INTENT.DELETE_FILE,
        query: null,
        source: source.label,
        destination: 'SmartDesk Trash',
        folderHint: source.label,
        approvalPlan: plan,
      },
    };
  }

  const picked = selectFilesByHint(allFiles, fileToDelete);
  let filesToDelete = [];

  if (picked.type === 'none') {
    // File not found in the stated source folder — search across all folders
    // (including subdirectories) to find the actual current location.
    // This handles the case where IBM's thread memory has a stale source.
    if (fileToDelete) {
      const found = await findSingleFileAcrossDefaultFolders(fileToDelete);
      if (found.type === 'single' && found.match) {
        // Found it somewhere else — update source and re-run from there
        source = { label: found.match.folderPath, path: found.match.folderPath };
        filesToDelete = [found.match.file];
      } else if (found.type === 'ambiguous') {
        const options = found.matches.slice(0, 5)
          .map((m) => `"${m.file.name}" in ${path.basename(m.folderPath)}`).join(', ');
        return {
          reply: `I found "${fileToDelete}" in multiple places: ${options}. Which one should I delete?`,
          intent: { type: INTENT.CHAT, query: null, source: null, destination: null, folderHint: null },
        };
      } else {
        return {
          reply: `I could not find "${fileToDelete}" in ${source.label} or any of your standard folders.`,
          intent: { type: INTENT.CHAT, query: null, source: source.label, destination: null, folderHint: source.label },
        };
      }
    } else {
      return {
        reply: `I could not find "${fileToDelete}" in ${source.label}.`,
        intent: { type: INTENT.CHAT, query: null, source: source.label, destination: null, folderHint: source.label },
      };
    }
  } else {
    if (picked.type === 'ambiguous') {
      const options = picked.files.slice(0, 5).map((f) => `"${f.name}"`).join(', ');
      return {
        reply: `I found multiple matches for "${fileToDelete}" in ${source.label}: ${options}. Please tell me the exact file name to delete.`,
        intent: { type: INTENT.CHAT, query: null, source: source.label, destination: null, folderHint: source.label },
      };
    }
    filesToDelete = picked.files;
  }

  // SmartDesk Trash folder — safe, recoverable
  const trashDir = path.join(os.homedir(), '.SmartDesk', 'Trash');

  const planId = crypto.randomUUID();
  const existingNames = new Set();
  const items = filesToDelete.map((file) => ({
    operation: 'delete',
    name: file.name,
    sourcePath: file.sourcePath,
    targetPath: createUniqueTarget(path.join(trashDir, file.name), existingNames),
    newName: null,
    sizeBytes: file.sizeBytes,
  }));

  const plan = {
    id: planId,
    type: INTENT.DELETE_FILE,
    title: `Delete ${items.length === 1 ? `"${items[0].name}"` : `${items.length} files`} from ${source.label}`,
    detail: 'Files will be moved to ~/.SmartDesk/Trash/ and can be recovered.',
    sourceLabel: source.label,
    destinationLabel: 'SmartDesk Trash',
    sourcePath: source.path,
    destinationPath: trashDir,
    count: items.length,
    items,
    createdAt: new Date().toISOString(),
  };

  planStore.set(planId, plan);

  return {
    reply: `I prepared a plan to delete ${items.length === 1 ? `"${items[0].name}"` : `${items.length} files`} from ${source.label}. Files will be moved to SmartDesk Trash (recoverable). Review before I make any changes.`,
    intent: {
      type: INTENT.DELETE_FILE,
      query: fileToDelete,
      source: source.label,
      destination: 'SmartDesk Trash',
      folderHint: source.label,
      approvalPlan: plan,
    },
  };
}

async function buildMovePlan(intent, specificFile = null) {
  const destination = resolveFolderRef(intent.destination);
  let source = resolveFolderRef(intent.source || intent.folderHint);

  // When source is missing but we have a file hint, search for the file
  // across all watched/default folders to auto-discover the source
  if (!source) {
    const fileHint = normalizeTextField(specificFile || intent.query);
    if (fileHint && destination) {
      const found = await findSingleFileAcrossDefaultFolders(fileHint);
      if (found.type === 'single' && found.match) {
        source = { label: path.basename(found.match.folderPath), path: found.match.folderPath };
      } else if (found.type === 'ambiguous') {
        const options = found.matches.slice(0, 5)
          .map((m) => `"${m.file.name}" in ${path.basename(m.folderPath)}`).join(', ');
        return {
          reply: `I found multiple matches: ${options}. Which one did you want to move?`,
          intent: { type: INTENT.CHAT, query: null, source: null, destination: destination?.label || null, folderHint: null },
        };
      }
    }
    if (!source) {
      return {
        reply: 'I need to know which folder to move the file from. Could you tell me where it is?',
        intent: { type: INTENT.CHAT, query: null, source: null, destination: destination?.label || null, folderHint: null },
      };
    }
  }

  if (!destination) {
    return {
      reply: 'I need to know which folder to move the file to. Where would you like it moved?',
      intent: { type: INTENT.CHAT, query: null, source: source.label, destination: null, folderHint: source.label },
    };
  }

  // Handle subfolder paths like "Downloads/Images" — try home-relative resolution
  let sourceExists = await ensureFolderExists(source.path);
  if (!sourceExists) {
    const homeBased = path.join(os.homedir(), intent.source || intent.folderHint || '');
    if (await ensureFolderExists(homeBased)) {
      source = { label: path.basename(homeBased), path: homeBased };
      sourceExists = true;
    }
  }

  if (!sourceExists) {
    return {
      reply: `I could not find the source folder "${source.label}" on this device.`,
      intent: { type: INTENT.CHAT, query: null, source: source.label, destination: destination.label, folderHint: source.label },
    };
  }

  if (path.resolve(source.path) === path.resolve(destination.path)) {
    return {
      reply: 'The source and destination folders are the same, so there is nothing to move.',
      intent: { type: INTENT.CHAT, query: null, source: source.label, destination: destination.label, folderHint: source.label },
    };
  }

  const files = await listDirectFiles(source.path);
  if (files.length === 0) {
    return {
      reply: `I did not find any files directly inside ${source.label} to move.`,
      intent: { type: INTENT.CHAT, query: null, source: source.label, destination: destination.label, folderHint: source.label },
    };
  }

  // Filter to specific file if provided
  const fileHint = normalizeTextField(specificFile || intent.query);
  let filesToMove = files;
  if (fileHint) {
    const picked = selectFilesByHint(files, fileHint);
    if (picked.type === 'none') {
      return {
        reply: `I could not find "${fileHint}" in ${source.label}.`,
        intent: { type: INTENT.CHAT, query: null, source: source.label, destination: destination.label, folderHint: source.label },
      };
    }
    if (picked.type === 'ambiguous') {
      const options = picked.files.slice(0, 5).map((f) => `"${f.name}"`).join(', ');
      return {
        reply: `I found multiple matches for "${fileHint}" in ${source.label}: ${options}. Please tell me the exact file name to move.`,
        intent: { type: INTENT.CHAT, query: null, source: source.label, destination: destination.label, folderHint: source.label },
      };
    }
    filesToMove = picked.files;
  }

  const planId = crypto.randomUUID();
  const existingNames = new Set();
  const items = filesToMove.map((file) => ({
    operation: 'move',
    name: file.name,
    sourcePath: file.sourcePath,
    targetPath: createUniqueTarget(path.join(destination.path, file.name), existingNames),
    newName: null,
    sizeBytes: file.sizeBytes,
  }));

  const plan = {
    id: planId,
    type: INTENT.MOVE_FILES,
    title: fileHint
      ? `Move "${filesToMove[0]?.name || fileHint}" from ${source.label} to ${destination.label}`
      : `Move files from ${source.label} to ${destination.label}`,
    detail: 'Nothing will be moved until you approve this plan.',
    sourceLabel: source.label,
    destinationLabel: destination.label,
    sourcePath: source.path,
    destinationPath: destination.path,
    count: items.length,
    items,
    createdAt: new Date().toISOString(),
  };

  planStore.set(planId, plan);

  return {
    reply: fileHint
      ? `I prepared a plan to move "${filesToMove[0]?.name || fileHint}" from ${source.label} to ${destination.label}. Review it before I make any changes.`
      : `I prepared a plan to move ${items.length} file${items.length === 1 ? '' : 's'} from ${source.label} to ${destination.label}. Review it before I make any changes.`,
    intent: {
      type: INTENT.MOVE_FILES,
      query: null,
      source: source.label,
      destination: destination.label,
      folderHint: source.label,
      approvalPlan: plan,
    },
  };
}

// System/protected paths to skip when scanning for user files.
// These directories throw EPERM on Windows and never contain user-owned files.
const SYSTEM_PATH_PREFIXES = [
  'C:\\Windows',
  'C:\\Program Files',
  'C:\\Program Files (x86)',
  'C:\\ProgramData',
  'C:\\MSOCache',
  'C:\\System Volume Information',
  'C:\\$Recycle.Bin',
  'C:\\$WINDOWS.~BT',
  'C:\\Recovery',
  'C:\\Boot',
  'C:\\Config.Msi',
  'C:\\Documents and Settings',
];

function isSystemPath(folderPath) {
  const normalized = path.resolve(folderPath).toLowerCase();
  // Skip drive roots (C:\, D:\, etc.) — too broad and causes EPERM
  if (/^[a-z]:\\?$/i.test(normalized)) return true;
  // Skip known system directories
  return SYSTEM_PATH_PREFIXES.some((p) => normalized.startsWith(p.toLowerCase()));
}

async function findSingleFileAcrossDefaultFolders(fileHint) {
  const defaults = getDefaultFolders();
  const matches = [];

  // Build list of folders to search: top-level defaults + their immediate subdirectories
  const foldersToSearch = [];
  for (const folderPath of Object.values(defaults)) {
    if (isSystemPath(folderPath)) continue;
    const exists = await ensureFolderExists(folderPath);
    if (!exists) continue;
    foldersToSearch.push(folderPath);
    // Also search one level deep (e.g. Downloads/Images, Downloads/Documents, etc.)
    try {
      const dirents = await fs.readdir(folderPath, { withFileTypes: true });
      for (const d of dirents) {
        if (d.isDirectory()) {
          const subPath = path.join(folderPath, d.name);
          if (!isSystemPath(subPath)) {
            foldersToSearch.push(subPath);
          }
        }
      }
    } catch { /* skip unreadable */ }
  }

  for (const folderPath of foldersToSearch) {
    if (isSystemPath(folderPath)) continue;
    const exists = await ensureFolderExists(folderPath);
    if (!exists) continue;
    let files;
    try {
      files = await listDirectFiles(folderPath);
    } catch { /* skip permission-denied folders */ continue; }
    const picked = selectFilesByHint(files, fileHint);
    if (picked.type === 'single' && picked.files[0]) {
      matches.push({ folderPath, file: picked.files[0] });
    }
  }
  if (matches.length === 1) return { type: 'single', match: matches[0] };
  if (matches.length > 1) return { type: 'ambiguous', matches };
  return { type: 'none' };
}

async function buildMoveFolderPlan(sourceFolderRef, destinationFolderRef) {
  const source = resolveFolderRef(sourceFolderRef);
  const destination = resolveFolderRef(destinationFolderRef);

  if (!source || !destination) {
    return {
      reply: 'I need both the source folder and destination folder to prepare a folder move plan.',
      intent: { type: INTENT.CHAT, query: null, source: null, destination: null, folderHint: null },
    };
  }

  const sourceExists = await ensureFolderExists(source.path);
  if (!sourceExists) {
    return {
      reply: `I could not find the source folder "${source.label}" on this device.`,
      intent: { type: INTENT.CHAT, query: null, source: source.label, destination: destination.label, folderHint: source.label },
    };
  }

  const destinationExists = await ensureFolderExists(destination.path);
  if (!destinationExists) {
    return {
      reply: `I could not find the destination folder "${destination.label}" on this device.`,
      intent: { type: INTENT.CHAT, query: null, source: source.label, destination: destination.label, folderHint: destination.label },
    };
  }

  if (path.resolve(source.path) === path.resolve(destination.path)) {
    return {
      reply: 'The source and destination folders are the same, so there is nothing to move.',
      intent: { type: INTENT.CHAT, query: null, source: source.label, destination: destination.label, folderHint: source.label },
    };
  }

  if (isSubPath(source.path, destination.path)) {
    return {
      reply: 'I cannot move a folder into itself or one of its own subfolders.',
      intent: { type: INTENT.CHAT, query: null, source: source.label, destination: destination.label, folderHint: source.label },
    };
  }

  const targetPath = path.join(destination.path, path.basename(source.path));
  const targetExists = await pathExists(targetPath);
  if (targetExists) {
    return {
      reply: `A folder named "${path.basename(source.path)}" already exists in ${destination.label}. Please rename it first or choose another destination.`,
      intent: { type: INTENT.CHAT, query: null, source: source.label, destination: destination.label, folderHint: destination.label },
    };
  }

  const planId = crypto.randomUUID();
  const items = [{
    operation: 'move_folder',
    name: path.basename(source.path),
    sourcePath: source.path,
    targetPath,
    newName: null,
    sizeBytes: null,
  }];

  const plan = {
    id: planId,
    type: INTENT.MOVE_FOLDER,
    title: `Move folder "${path.basename(source.path)}" to ${destination.label}`,
    detail: 'The folder move will happen only after you approve this plan.',
    sourceLabel: source.label,
    destinationLabel: destination.label,
    sourcePath: source.path,
    destinationPath: destination.path,
    count: 1,
    items,
    createdAt: new Date().toISOString(),
  };

  planStore.set(planId, plan);
  return {
    reply: `I prepared a plan to move folder "${path.basename(source.path)}" to ${destination.label}. Review before I make any changes.`,
    intent: {
      type: INTENT.MOVE_FOLDER,
      query: null,
      source: source.label,
      destination: destination.label,
      folderHint: source.label,
      approvalPlan: plan,
    },
  };
}

async function buildCreateFolderPlan(message, intent) {
  const parsed = parseCreateFolderRequest(message);
  if (!parsed?.folderName) {
    return {
      reply: 'Please tell me the folder name you want to create.',
      intent: { type: INTENT.CHAT, query: null, source: null, destination: null, folderHint: null },
    };
  }

  const parent = resolveFolderRef(parsed.parentRef || intent.destination || intent.source || intent.folderHint);
  if (!parent) {
    return {
      reply: 'Please tell me where to create that folder (for example: in Downloads).',
      intent: { type: INTENT.CHAT, query: null, source: null, destination: null, folderHint: null },
    };
  }

  const parentExists = await ensureFolderExists(parent.path);
  if (!parentExists) {
    return {
      reply: `I could not find the parent folder "${parent.label}" on this device.`,
      intent: { type: INTENT.CHAT, query: null, source: parent.label, destination: null, folderHint: parent.label },
    };
  }

  const newFolderPath = path.isAbsolute(parsed.folderName)
    ? parsed.folderName
    : path.join(parent.path, parsed.folderName);

  const items = [];
  const newFolderExists = await pathExists(newFolderPath);
  if (!newFolderExists) {
    items.push({
      operation: 'create_folder',
      name: path.basename(newFolderPath),
      sourcePath: parent.path,
      targetPath: newFolderPath,
      newName: null,
      sizeBytes: null,
    });
  }

  const fileHint = normalizeTextField(parsed.fileHint);
  if (fileHint) {
    let sourceFile = null;
    if (parsed.fileSourceRef) {
      const sourceFolder = resolveFolderRef(parsed.fileSourceRef);
      if (!sourceFolder) {
        return {
          reply: `I could not identify the source folder "${parsed.fileSourceRef}" for the file move.`,
          intent: { type: INTENT.CHAT, query: null, source: null, destination: parent.label, folderHint: parent.label },
        };
      }
      const sourceExists = await ensureFolderExists(sourceFolder.path);
      if (!sourceExists) {
        return {
          reply: `I could not find the source folder "${sourceFolder.label}" on this device.`,
          intent: { type: INTENT.CHAT, query: null, source: sourceFolder.label, destination: parent.label, folderHint: sourceFolder.label },
        };
      }
      const files = await listDirectFiles(sourceFolder.path);
      const picked = selectFilesByHint(files, fileHint);
      if (picked.type === 'none') {
        return {
          reply: `I could not find "${fileHint}" in ${sourceFolder.label}.`,
          intent: { type: INTENT.CHAT, query: null, source: sourceFolder.label, destination: parent.label, folderHint: sourceFolder.label },
        };
      }
      if (picked.type === 'ambiguous') {
        const options = picked.files.slice(0, 5).map((f) => `"${f.name}"`).join(', ');
        return {
          reply: `I found multiple matches for "${fileHint}" in ${sourceFolder.label}: ${options}. Please tell me the exact file name.`,
          intent: { type: INTENT.CHAT, query: null, source: sourceFolder.label, destination: parent.label, folderHint: sourceFolder.label },
        };
      }
      sourceFile = picked.files[0];
    } else {
      const cross = await findSingleFileAcrossDefaultFolders(fileHint);
      if (cross.type === 'none') {
        return {
          reply: `I could not find "${fileHint}" in the standard folders.`,
          intent: { type: INTENT.CHAT, query: null, source: null, destination: parent.label, folderHint: parent.label },
        };
      }
      if (cross.type === 'ambiguous') {
        const options = cross.matches
          .slice(0, 5)
          .map((m) => `"${m.file.name}" in ${path.basename(m.folderPath)}`)
          .join(', ');
        return {
          reply: `I found multiple matches for "${fileHint}": ${options}. Please tell me the source folder too.`,
          intent: { type: INTENT.CHAT, query: null, source: null, destination: parent.label, folderHint: parent.label },
        };
      }
      sourceFile = cross.match.file;
    }

    const targetPath = createUniqueTarget(path.join(newFolderPath, sourceFile.name), new Set());
    items.push({
      operation: 'move',
      name: sourceFile.name,
      sourcePath: sourceFile.sourcePath,
      targetPath,
      newName: null,
      sizeBytes: sourceFile.sizeBytes,
    });
  }

  if (items.length === 0) {
    return {
      reply: `Folder "${path.basename(newFolderPath)}" already exists in ${parent.label}, and no file move was requested.`,
      intent: { type: INTENT.CHAT, query: null, source: parent.label, destination: parent.label, folderHint: parent.label },
    };
  }

  const planId = crypto.randomUUID();
  const plan = {
    id: planId,
    type: INTENT.CREATE_FOLDER,
    title: fileHint
      ? `Create "${path.basename(newFolderPath)}" and move "${fileHint}" into it`
      : `Create folder "${path.basename(newFolderPath)}" in ${parent.label}`,
    detail: 'This folder operation plan will run only after your approval.',
    sourceLabel: parent.label,
    destinationLabel: path.basename(newFolderPath),
    sourcePath: parent.path,
    destinationPath: newFolderPath,
    count: items.length,
    items,
    createdAt: new Date().toISOString(),
  };

  planStore.set(planId, plan);
  return {
    reply: fileHint
      ? `I prepared a plan to create folder "${path.basename(newFolderPath)}" in ${parent.label} and move "${fileHint}" into it. Review before I make any changes.`
      : `I prepared a plan to create folder "${path.basename(newFolderPath)}" in ${parent.label}. Review before I make any changes.`,
    intent: {
      type: INTENT.CREATE_FOLDER,
      query: fileHint || parsed.folderName,
      source: parent.label,
      destination: path.basename(newFolderPath),
      folderHint: parent.label,
      approvalPlan: plan,
    },
  };
}

function extractFolderFromMessage(message, role = null) {
  const t = message.toLowerCase();

  // First try to match explicit subfolder paths like "Downloads/Images" or "Downloads\Images"
  // Only match when the path segment appears right after from/in/to.
  const subpathPattern = /(?<=\b(?:from|in|to)\s+)([a-z][a-z0-9_\-]*)[/\\]([a-z0-9_\-]+)/gi;
  let subMatch;
  while ((subMatch = subpathPattern.exec(t)) !== null) {
    const segment0 = subMatch[1].trim().toLowerCase();
    const fullPath = subMatch[0].trim();
    const topAlias = FOLDER_ALIASES[segment0];
    const defaults = getDefaultFolders();
    const topDefaultKey = topAlias
      ? topAlias
      : Object.keys(defaults).find((k) => k.toLowerCase() === segment0);
    if (topDefaultKey) {
      // Determine which preposition preceded this path
      const matchStart = subMatch.index;
      const preceding = t.substring(0, matchStart);
      const isAfterTo   = /\bto\s+$/.test(preceding);
      const isAfterFrom = /\b(?:from|in)\s+$/.test(preceding);
      if (role === 'destination' && isAfterTo)   return fullPath;
      if (role === 'source'      && isAfterFrom) return fullPath;
      if (!role) return fullPath;
    }
  }

  // ── Top-level folder aliases ─────────────────────────────────────────────
  // KEY FIX: The old regex `\b(from|in)\b.*\balias\b` was too greedy.
  // For "move the aizen image from downloads to desktop", it matched "desktop"
  // as the SOURCE because "from" appears before "desktop" anywhere in the string.
  //
  // Correct approach: split the message at the word "to":
  //   • source  = alias found after "from/in" in the part BEFORE the last " to "
  //   • destination = alias found after "to" in the part AFTER "to"
  // This prevents the destination folder from being mistakenly identified as source.

  if (role === 'source') {
    // Only search in the substring from "from/in" up to the last " to "
    const toIdx = t.lastIndexOf(' to ');
    const searchIn = toIdx >= 0 ? t.substring(0, toIdx) : t;
    const fromMatch = searchIn.match(/\b(?:from|in)\s+(.+)$/i);
    if (!fromMatch) return null;
    const afterPrep = fromMatch[1];
    for (const [alias, canonical] of Object.entries(FOLDER_ALIASES)) {
      if (alias.length < 2) continue;
      const idx = afterPrep.toLowerCase().indexOf(alias);
      if (idx === -1) continue;
      const charBefore = idx > 0 ? afterPrep[idx - 1] : ' ';
      const charAfter  = idx + alias.length < afterPrep.length ? afterPrep[idx + alias.length] : ' ';
      if (!/[a-z0-9]/.test(charBefore) && !/[a-z0-9]/.test(charAfter)) return canonical;
    }
    return null;
  }

  if (role === 'destination') {
    // Only search in the substring after the last "to "
    const toMatch = t.match(/\bto\s+(.+)$/i);
    if (!toMatch) return null;
    const afterTo = toMatch[1];
    for (const [alias, canonical] of Object.entries(FOLDER_ALIASES)) {
      if (alias.length < 2) continue;
      const idx = afterTo.toLowerCase().indexOf(alias);
      if (idx === -1) continue;
      const charBefore = idx > 0 ? afterTo[idx - 1] : ' ';
      const charAfter  = idx + alias.length < afterTo.length ? afterTo[idx + alias.length] : ' ';
      if (!/[a-z0-9]/.test(charBefore) && !/[a-z0-9]/.test(charAfter)) return canonical;
    }
    return null;
  }

  // No role — return first matching alias anywhere in message
  for (const [alias, canonical] of Object.entries(FOLDER_ALIASES)) {
    if (t.includes(alias)) return canonical;
  }
  return null;
}

// ─── Category map for scan suggestions ───────────────────────────────────────

const CATEGORY_MAP = [
  { folder: 'Images',     extensions: new Set(['.jpg','.jpeg','.png','.gif','.bmp','.webp','.svg','.ico','.tiff','.tif','.heic','.heif','.avif','.raw','.cr2','.nef','.dng']) },
  { folder: 'Videos',     extensions: new Set(['.mp4','.mkv','.avi','.mov','.wmv','.flv','.webm','.m4v','.3gp','.mpg','.mpeg','.ts','.m2ts','.vob']) },
  { folder: 'Music',      extensions: new Set(['.mp3','.wav','.flac','.aac','.ogg','.wma','.m4a','.opus','.aiff','.alac']) },
  { folder: 'Documents',  extensions: new Set(['.pdf','.doc','.docx','.xls','.xlsx','.ppt','.pptx','.odt','.ods','.odp','.txt','.rtf','.csv','.md','.epub','.pages','.numbers','.key']) },
  { folder: 'Archives',   extensions: new Set(['.zip','.rar','.7z','.tar','.gz','.bz2','.xz','.iso','.dmg','.cab','.lzma','.tgz']) },
  { folder: 'Installers', extensions: new Set(['.exe','.msi','.apk','.deb','.rpm','.pkg','.appimage','.jar','.bat','.sh']) },
  { folder: 'Code',       extensions: new Set(['.js','.ts','.jsx','.tsx','.py','.java','.cpp','.c','.h','.cs','.go','.rb','.php','.html','.css','.json','.xml','.yaml','.yml','.sql','.rs','.swift','.kt','.dart','.lua','.r','.m','.ipynb']) },
];

function classifyFile(filename) {
  const ext = path.extname(filename).toLowerCase();
  if (!ext) return null; // No extension — skip
  for (const cat of CATEGORY_MAP) {
    if (cat.extensions.has(ext)) return cat.folder;
  }
  return 'Others';
}

/**
 * Scan a folder (and optionally sub-folders up to 1 level) for files,
 * classify each by extension, and build an approvalPlan with move operations
 * that would organize them into type-based subfolders.
 *
 * Only files that are NOT already in a typed subfolder are included.
 *
 * @param {string} scanPath     - Absolute path of the folder to scan
 * @param {string} scanLabel    - Human-readable label ("Desktop", "Downloads", …)
 * @returns {Promise<object|null>} approvalPlan or null if nothing to organize
 */
async function buildScanSuggestionPlan(scanPath, scanLabel) {
  // List only direct files in the root — we don't move things out of user's
  // own sub-folders; we only clean up loose files sitting at the top level.
  let dirents;
  try {
    dirents = await fs.readdir(scanPath, { withFileTypes: true });
  } catch {
    return null;
  }

  const items = [];
  const existingNames = new Set();

  for (const entry of dirents) {
    if (!entry.isFile()) continue; // skip sub-folders themselves
    const category = classifyFile(entry.name);
    if (!category) continue; // skip files with no extension

    const sourcePath = path.join(scanPath, entry.name);
    const targetDir  = path.join(scanPath, category);
    const targetPath = createUniqueTarget(path.join(targetDir, entry.name), existingNames);

    let sizeBytes = null;
    try {
      const stat = await fs.stat(sourcePath);
      sizeBytes = stat.size;
    } catch { /* skip unreadable */ }

    items.push({
      operation:  'move',
      name:       entry.name,
      sourcePath,
      targetPath,
      targetDir,   // for display grouping
      category,    // human-readable category label
      newName:    null,
      sizeBytes,
    });
  }

  if (items.length === 0) return null;

  // Build category summary for the plan detail
  const catCounts = {};
  for (const item of items) {
    catCounts[item.category] = (catCounts[item.category] || 0) + 1;
  }
  const catSummary = Object.entries(catCounts)
    .sort((a, b) => b[1] - a[1])
    .map(([cat, n]) => `${n} → ${cat}`)
    .join(', ');

  const planId = crypto.randomUUID();
  const plan = {
    id:               planId,
    type:             'scan_structure',
    title:            `Organise ${items.length} file${items.length === 1 ? '' : 's'} in ${scanLabel}`,
    detail:           `Files will be moved into type-based subfolders: ${catSummary}. Nothing moves until you approve.`,
    sourceLabel:      scanLabel,
    destinationLabel: `${scanLabel} (organised)`,
    sourcePath:       scanPath,
    destinationPath:  scanPath,
    count:            items.length,
    items,
    createdAt:        new Date().toISOString(),
  };

  planStore.set(planId, plan);
  return plan;
}

/**
 * Handle scan_structure intent: scan the target folder(s) and build a real
 * suggestion plan, or report that no files need organising.
 *
 * @param {object}      intent      Parsed intent from the IBM agent
 * @param {string|null} agentReply  The IBM agent's original text reply (used as fallback)
 */
async function handleScanStructureIntent(intent, agentReply) {
  // Determine which folder to scan
  const folderRef = intent.folderHint || intent.source;
  const resolved  = folderRef ? resolveFolderRef(folderRef) : null;

  // Build plans for one or more folders
  const foldersToScan = resolved
    ? [resolved]
    : await getWatchedFolders().then((paths) =>
        paths.map((p) => ({ label: path.basename(p), path: p }))
      );

  const allPlans = [];
  for (const folder of foldersToScan) {
    const exists = await ensureFolderExists(folder.path);
    if (!exists) continue;
    const plan = await buildScanSuggestionPlan(folder.path, folder.label);
    if (plan) allPlans.push(plan);
  }

  if (allPlans.length === 0) {
    const label = resolved ? resolved.label : 'your watched folders';
    // Use IBM agent reply when available — it may contain more context (e.g. for C:\ drive scans)
    const fallbackMsg = agentReply && agentReply.trim()
      ? agentReply.trim()
      : `**${label}** already looks organised — all files are in their own subfolders or there are no loose files to move at the root level.`;
    return {
      reply: fallbackMsg,
      intent: { type: INTENT.SCAN_STRUCTURE, query: null, source: folderRef, destination: null, folderHint: folderRef },
    };
  }

  // If multiple folders, merge into one master plan
  let masterPlan;
  if (allPlans.length === 1) {
    masterPlan = allPlans[0];
  } else {
    const mergedItems = allPlans.flatMap((p) => p.items);
    const totalCount = mergedItems.length;
    const planId = crypto.randomUUID();
    masterPlan = {
      id:               planId,
      type:             'scan_structure',
      title:            `Organise ${totalCount} file${totalCount === 1 ? '' : 's'} across ${allPlans.length} folders`,
      detail:           allPlans.map((p) => `${p.sourceLabel}: ${p.count} files`).join(' • ') + '. Nothing moves until you approve.',
      sourceLabel:      allPlans.map((p) => p.sourceLabel).join(', '),
      destinationLabel: 'Organised subfolders',
      sourcePath:       allPlans[0].sourcePath,
      destinationPath:  allPlans[0].sourcePath,
      count:            totalCount,
      items:            mergedItems,
      createdAt:        new Date().toISOString(),
    };
    planStore.set(planId, masterPlan);
  }

  const catCounts = {};
  for (const item of masterPlan.items) {
    catCounts[item.category] = (catCounts[item.category] || 0) + 1;
  }
  const breakdown = Object.entries(catCounts)
    .sort((a, b) => b[1] - a[1])
    .map(([cat, n]) => `**${n}** → ${cat}`)
    .join(', ');

  return {
    reply: `I scanned **${masterPlan.sourceLabel}** and found **${masterPlan.count} loose file${masterPlan.count === 1 ? '' : 's'}** that can be organised into subfolders: ${breakdown}. Review the plan below and approve to proceed.`,
    intent: {
      type:         INTENT.SCAN_STRUCTURE,
      query:        null,
      source:       masterPlan.sourceLabel,
      destination:  masterPlan.destinationLabel,
      folderHint:   folderRef || masterPlan.sourceLabel,
      approvalPlan: masterPlan,
    },
  };
}

async function buildFolderCountReply(intent, agentReply = null) {
  const folder = resolveFolderRef(intent.source || intent.folderHint);
  if (!folder) {
    // Use the IBM agent's reply — it already answered the question with live file context
    return {
      reply: agentReply || 'I could not tell which folder you meant. Try something like "how many files are in Downloads?"',
      intent: { type: INTENT.CHAT, query: null, source: null, destination: null, folderHint: null },
    };
  }

  const exists = await ensureFolderExists(folder.path);
  if (!exists) {
    return {
      reply: agentReply || `I could not find the **${folder.label}** folder on this device.`,
      intent: { type: INTENT.CHAT, query: null, source: folder.label, destination: null, folderHint: folder.label },
    };
  }

  const count = await countDirectFiles(folder.path);
  return {
    reply: `There ${count === 1 ? 'is' : 'are'} **${count}** file${count === 1 ? '' : 's'} directly inside **${folder.label}**.`,
    intent: { type: INTENT.COUNT_FOLDER_ITEMS, query: null, source: folder.label, destination: null, folderHint: folder.label },
  };
}

async function logManualMove(item) {
  try {
    await query(
      `INSERT INTO activity_log (action, filename, from_path, to_path, file_size_bytes)
       VALUES ('moved', $1, $2, $3, $4)`,
      [item.name, item.sourcePath, item.targetPath, item.sizeBytes ?? null]
    );

    await query(
      `INSERT INTO sessions (session_date, files_processed, folders_created, storage_saved_bytes)
       VALUES (CURRENT_DATE, 1, 0, $1)
       ON CONFLICT (session_date) DO UPDATE
       SET files_processed = sessions.files_processed + 1,
           storage_saved_bytes = sessions.storage_saved_bytes + EXCLUDED.storage_saved_bytes`,
      [item.sizeBytes ?? 0]
    );
  } catch (err) {
    console.error('[orchestrateChat] logging failed:', err.message);
  }
}

async function executePlan(planId) {
  const plan = planStore.get(planId);
  if (!plan) {
    throw new Error('That approval plan expired or could not be found');
  }

  let movedCount = 0;
  let deletedCount = 0;
  let createdFolderCount = 0;
  let movedFolderCount = 0;
  const errors = [];

  for (const item of plan.items) {
    const operation = item.operation || 'move';
    try {
      if (operation === 'delete') {
        // Safe delete: move to SmartDesk Trash folder (recoverable)
        await fs.mkdir(path.dirname(item.targetPath), { recursive: true });
        await fs.rename(item.sourcePath, item.targetPath);
        deletedCount += 1;
        await logManualMove({ ...item, targetPath: item.targetPath });
      } else if (operation === 'create_folder') {
        await fs.mkdir(item.targetPath, { recursive: true });
        createdFolderCount += 1;
        await query(
          `INSERT INTO activity_log (action, filename, from_path, to_path, file_size_bytes)
           VALUES ('created', $1, $2, $3, NULL)`,
          [item.name || path.basename(item.targetPath), path.dirname(item.targetPath), item.targetPath]
        );
        await query(
          `INSERT INTO sessions (session_date, files_processed, folders_created, storage_saved_bytes)
           VALUES (CURRENT_DATE, 0, 1, 0)
           ON CONFLICT (session_date) DO UPDATE
           SET folders_created = sessions.folders_created + 1`
        );
      } else if (operation === 'move_folder') {
        await fs.mkdir(path.dirname(item.targetPath), { recursive: true });
        await fs.rename(item.sourcePath, item.targetPath);
        movedFolderCount += 1;
        await query(
          `INSERT INTO activity_log (action, filename, from_path, to_path, file_size_bytes)
           VALUES ('moved', $1, $2, $3, NULL)`,
          [item.name || path.basename(item.sourcePath), item.sourcePath, item.targetPath]
        );
      } else {
        // Default: move
        await fs.mkdir(path.dirname(item.targetPath), { recursive: true });
        await fs.rename(item.sourcePath, item.targetPath);
        movedCount += 1;
        await logManualMove(item);
      }
    } catch (err) {
      errors.push({ file: item.name, message: err.message });
    }
  }

  planStore.delete(planId);

  // ── Record that this folder was recently organized so structure queries
  //    get a guaranteed fresh scan instead of relying on thread memory ────────
  if (plan.sourcePath) {
    lastOrganizedAt.set(plan.sourcePath, Date.now());
  }

  const totalProcessed = movedCount + deletedCount + movedFolderCount;

  if (plan.type === INTENT.DELETE_FILE) {
    return {
      success: errors.length === 0,
      movedCount: deletedCount,
      errorCount: errors.length,
      errors,
      message: errors.length === 0
        ? `Moved ${deletedCount} file${deletedCount === 1 ? '' : 's'} to SmartDesk Trash.`
        : `Moved ${deletedCount} file${deletedCount === 1 ? '' : 's'} to Trash with ${errors.length} error${errors.length === 1 ? '' : 's'}.`,
    };
  }

  if (plan.type === INTENT.CREATE_FOLDER) {
    const parts = [];
    if (createdFolderCount > 0) parts.push(`created ${createdFolderCount} folder${createdFolderCount === 1 ? '' : 's'}`);
    if (movedCount > 0) parts.push(`moved ${movedCount} file${movedCount === 1 ? '' : 's'}`);
    const summary = parts.length > 0 ? parts.join(' and ') : 'completed the folder plan';
    return {
      success: errors.length === 0,
      movedCount: totalProcessed,
      errorCount: errors.length,
      errors,
      message: errors.length === 0
        ? `Successfully ${summary}.`
        : `Partially completed: ${summary}, with ${errors.length} error${errors.length === 1 ? '' : 's'}.`,
    };
  }

  if (plan.type === INTENT.MOVE_FOLDER) {
    return {
      success: errors.length === 0,
      movedCount: movedFolderCount,
      errorCount: errors.length,
      errors,
      message: errors.length === 0
        ? `Moved ${movedFolderCount} folder${movedFolderCount === 1 ? '' : 's'} to ${plan.destinationLabel}.`
        : `Moved ${movedFolderCount} folder${movedFolderCount === 1 ? '' : 's'} with ${errors.length} error${errors.length === 1 ? '' : 's'}.`,
    };
  }

  if (plan.type === INTENT.SCAN_STRUCTURE) {
    return {
      success: errors.length === 0,
      movedCount,
      errorCount: errors.length,
      errors,
      message: errors.length === 0
        ? `Organised ${movedCount} file${movedCount === 1 ? '' : 's'} into subfolders in ${plan.sourceLabel}.`
        : `Organised ${movedCount} file${movedCount === 1 ? '' : 's'} with ${errors.length} error${errors.length === 1 ? '' : 's'}.`,
    };
  }

  return {
    success: errors.length === 0,
    movedCount: totalProcessed,
    errorCount: errors.length,
    errors,
    message: errors.length === 0
      ? `Moved ${movedCount} file${movedCount === 1 ? '' : 's'} to ${plan.destinationLabel}.`
      : `Moved ${movedCount} file${movedCount === 1 ? '' : 's'} with ${errors.length} error${errors.length === 1 ? '' : 's'}.`,
  };
}

async function processChatMessage(message, incomingThreadId = null) {
  let normalized;

  // Extract a specific filename from the message early — used for move/delete filtering
  // Also extract the folder hint if the user specified a path like "Downloads/Images/aizen.jpg"
  const { filename: specificFile, folderRef: specificFileFolderRef } = extractSpecificFileWithFolder(message);

  try {
    const rawResponse = await askOrchestrate(message, incomingThreadId);
    const rawText = extractAssistantText(rawResponse);
    // Pass the original user message so when the agent ignores the JSON format
    // instruction and replies in plain text, intent is inferred from the user's
    // words (reliable) not the agent's verbose refusal (unreliable).
    normalized = normalizeIntent(rawText, message);
    // Attach the thread ID so the client can send it back next turn
    normalized.threadId = rawResponse?.thread_id || threadId || null;
  } catch (err) {
    console.error('[orchestrateChat] agent request failed:', err.message);
    return buildUnavailableFallback();
  }

  // ── Smart delete detection ────────────────────────────────────────────────
  // Handles: "delete aizen.jpg", "delete it", "delete the exe files",
  //          "delete exe which are not required", "remove them", etc.
  const msgHasDelete = /\b(delete|remove|trash|erase)\b/i.test(message);
  const isPronounRef = /\b(it|them|this|that|those|these|the\s+file|the\s+image|the\s+video|the\s+document)\b/i.test(message);

  // Detect extension-based delete: "delete the exe files", "delete all zip files", etc.
  const extDeleteMatch = message.match(/\bdelete\b.*?\b(exe|zip|rar|msi|pdf|jpg|jpeg|png|mp4|mp3|docx?|xlsx?|txt|iso|dmg|apk|jar|gz|tar|7z)\b/i)
    || message.match(/\b(exe|zip|rar|msi|pdf|jpg|jpeg|png|mp4|mp3|docx?|xlsx?|txt|iso|dmg|apk|jar|gz|tar|7z)\b.*?\bdelete\b/i);
  const extToDelete = extDeleteMatch ? extDeleteMatch[1].toLowerCase() : null;

  if (msgHasDelete) {
    // ── Case A: specific named file ───────────────────────────────────────
    if (specificFile) {
      // If user gave a path reference like "Downloads/Images/aizen.jpg",
      // use the extracted folder path as the source (overrides everything else)
      const srcFromPath = specificFileFolderRef
        ? specificFileFolderRef
        : null;
      const srcFromMsg = srcFromPath
        || extractFolderFromMessage(message, 'source')
        || extractFolderFromMessage(message)
        || normalizeTextField(normalized.intent.source)
        || normalizeTextField(normalized.intent.folderHint);
      normalized.intent.type = INTENT.DELETE_FILE;
      normalized.intent.source = srcFromMsg || normalized.intent.source || normalized.intent.folderHint || 'Downloads';
      normalized.intent.query = specificFile;
    }
    // ── Case B: extension-based delete ("delete the exe files") ──────────
    else if (extToDelete) {
      // Find all files of that extension across thread context or default folders
      const threadCtx = incomingThreadId ? getThreadFileContext(incomingThreadId) : null;
      const searchFolders = threadCtx
        ? [{ label: threadCtx.folder, path: path.dirname(threadCtx.files[0]?.sourcePath || '') }]
        : await getWatchedFolders().then((paths) => paths.map((p) => ({ label: path.basename(p), path: p })));

      const matchedFiles = [];
      for (const folder of searchFolders) {
        const exists = await ensureFolderExists(folder.path);
        if (!exists) continue;
        const files = await listDirectFiles(folder.path);
        const byExt = files.filter((f) => path.extname(f.name).toLowerCase() === `.${extToDelete}`);
        for (const f of byExt) matchedFiles.push({ ...f, folderLabel: folder.label });
      }

      if (matchedFiles.length > 0) {
        const trashDir = path.join(os.homedir(), '.SmartDesk', 'Trash');
        const planId = crypto.randomUUID();
        const existingNames = new Set();
        const items = matchedFiles.map((file) => ({
          operation: 'delete',
          name: file.name,
          sourcePath: file.sourcePath,
          targetPath: createUniqueTarget(path.join(trashDir, file.name), existingNames),
          newName: null,
          sizeBytes: file.sizeBytes ?? null,
        }));
        const plan = {
          id: planId,
          type: INTENT.DELETE_FILE,
          title: `Delete ${items.length} .${extToDelete} file${items.length === 1 ? '' : 's'}`,
          detail: 'Files will be moved to ~/.SmartDesk/Trash/ and can be recovered.',
          sourceLabel: matchedFiles[0].folderLabel,
          destinationLabel: 'SmartDesk Trash',
          sourcePath: path.dirname(matchedFiles[0].sourcePath),
          destinationPath: trashDir,
          count: items.length,
          items,
          createdAt: new Date().toISOString(),
        };
        planStore.set(planId, plan);
        return {
          reply: normalized.reply ||
            `I found **${items.length} .${extToDelete} file${items.length === 1 ? '' : 's'}** that can be deleted. They will be moved to SmartDesk Trash (recoverable). Review the plan below and approve to proceed.`,
          intent: {
            type: INTENT.DELETE_FILE,
            query: `.${extToDelete}`,
            source: matchedFiles[0].folderLabel,
            destination: 'SmartDesk Trash',
            folderHint: matchedFiles[0].folderLabel,
            approvalPlan: plan,
          },
          threadId: normalized.threadId,
        };
      }
      // No files found — let IBM reply flow through (it may have context we don't)
    }
    // ── Case C: pronoun reference ("delete it", "delete them") ────────────
    else if (isPronounRef && incomingThreadId) {
      const ctx = getThreadFileContext(incomingThreadId);
      if (ctx && ctx.files && ctx.files.length > 0) {
        const trashDir = path.join(os.homedir(), '.SmartDesk', 'Trash');
        const planId = crypto.randomUUID();
        const existingNames = new Set();
        const items = ctx.files.map((file) => ({
          operation: 'delete',
          name: file.name,
          sourcePath: file.sourcePath,
          targetPath: createUniqueTarget(path.join(trashDir, file.name), existingNames),
          newName: null,
          sizeBytes: file.sizeBytes ?? null,
        }));
        const plan = {
          id: planId,
          type: INTENT.DELETE_FILE,
          title: items.length === 1
            ? `Delete "${items[0].name}" from ${ctx.folder}`
            : `Delete ${items.length} files from ${ctx.folder}`,
          detail: 'Files will be moved to ~/.SmartDesk/Trash/ and can be recovered.',
          sourceLabel: ctx.folder,
          destinationLabel: 'SmartDesk Trash',
          sourcePath: path.dirname(ctx.files[0].sourcePath),
          destinationPath: trashDir,
          count: items.length,
          items,
          createdAt: new Date().toISOString(),
        };
        planStore.set(planId, plan);
        return {
          reply: normalized.reply || (items.length === 1
            ? `I prepared a plan to delete **"${items[0].name}"** from ${ctx.folder}. It will be moved to SmartDesk Trash (recoverable). Review and approve to proceed.`
            : `I prepared a plan to delete **${items.length} files** from ${ctx.folder}. They will be moved to SmartDesk Trash (recoverable). Review and approve to proceed.`),
          intent: {
            type: INTENT.DELETE_FILE,
            query: items[0].name,
            source: ctx.folder,
            destination: 'SmartDesk Trash',
            folderHint: ctx.folder,
            approvalPlan: plan,
          },
          threadId: normalized.threadId,
        };
      }
    }
    // ── Case D: IBM returned delete_file intent directly — trust it ───────
    // (falls through to buildDeletePlan below)
  }

  // ── Smart create-folder detection ──────────────────────────────────────────
  const createFolderReq = parseCreateFolderRequest(message);
  if (createFolderReq?.folderName) {
    normalized.intent.type = INTENT.CREATE_FOLDER;
    normalized.intent.destination = createFolderReq.parentRef;
    normalized.intent.query = createFolderReq.fileHint || createFolderReq.folderName;
  }

  // ── Smart scan/organize-structure detection ────────────────────────────────
  // Only force SCAN_STRUCTURE when the user explicitly asks to *organise/clean*
  // a folder's structure — NOT when they're asking for information (sizes, counts,
  // listings). Informational queries like "scan each folder and give me the size"
  // should be answered by the IBM agent as a chat/count reply, not diverted into
  // an organise plan.
  //
  // Informational signals (block the override when any of these appear):
  //   - "size", "how big", "how much space", "give me", "show me", "list",
  //     "how many", "count", "what is in", "what's in", "tell me"
  const isInformationalQuery =
    /\b(size|sizes|how\s+big|how\s+much\s+space|how\s+much\s+storage|give\s+me|show\s+me|show\s+the|list|how\s+many|count\s+the|what\s+is\s+in|what'?s\s+in|tell\s+me|report|overview|summary|details?)\b/i.test(message);

  const msgExplicitScan =
    !isInformationalQuery &&
    /\b(scan|analyse?|analyze|review|suggest)\b.*\b(folder|structure|system|files?)\b/i.test(message);

  if (msgExplicitScan) {
    const hint = extractFolderFromMessage(message);
    normalized.intent.type = INTENT.SCAN_STRUCTURE;
    if (hint) {
      normalized.intent.folderHint = hint;
      normalized.intent.source = hint;
    }
  }

  // ── Smart move-folder detection ────────────────────────────────────────────
  const moveFolderReq = parseFolderMoveRequest(message);
  if (moveFolderReq?.folderName && moveFolderReq?.destination) {
    let sourceFolderRef = moveFolderReq.folderName;
    if (moveFolderReq.sourceBase) {
      const sourceBase = resolveFolderRef(moveFolderReq.sourceBase);
      if (sourceBase) {
        sourceFolderRef = path.join(sourceBase.path, moveFolderReq.folderName);
      }
    }
    normalized.intent.type = INTENT.MOVE_FOLDER;
    normalized.intent.source = sourceFolderRef;
    normalized.intent.destination = moveFolderReq.destination;
  }

  // ── Smart move detection ──────────────────────────────────────────────────
  // If message has both source AND destination folder references, always build
  // a move plan — regardless of what intent the agent returned. This handles
  // cases where the agent says "I'm ready but need confirmation" instead of
  // returning move_files intent.
  // Also detect "from X to Y" shorthand where user omits the word "move"
  // e.g. "from downloads to desktop", "from Downloads/Images to Desktop"
  const msgHasMove = (
    (/\bmove\b/i.test(message) && !/\bmove\b.*\bfolder\b/i.test(message)) ||
    (/\bfrom\b.+\bto\b/i.test(message) && !msgHasDelete)
  );
  const srcFromMsg = extractFolderFromMessage(message, 'source');
  const dstFromMsg = extractFolderFromMessage(message, 'destination');

  // Pronoun move: "move it to Downloads", "move it to Documents"
  const moveIsPronounRef = msgHasMove && isPronounRef && dstFromMsg && incomingThreadId;
  if (moveIsPronounRef) {
    const ctx = getThreadFileContext(incomingThreadId);
    if (ctx && ctx.files && ctx.files.length > 0) {
      const dst = resolveFolderRef(dstFromMsg);
      if (dst) {
        const planId = crypto.randomUUID();
        const existingNames = new Set();
        const items = ctx.files.map((file) => ({
          operation: 'move',
          name: file.name,
          sourcePath: file.sourcePath,
          targetPath: createUniqueTarget(path.join(dst.path, file.name), existingNames),
          newName: null,
          sizeBytes: file.sizeBytes ?? null,
        }));
        const plan = {
          id: planId,
          type: INTENT.MOVE_FILES,
          title: items.length === 1
            ? `Move "${items[0].name}" from ${ctx.folder} to ${dst.label}`
            : `Move ${items.length} files from ${ctx.folder} to ${dst.label}`,
          detail: 'Nothing will be moved until you approve this plan.',
          sourceLabel: ctx.folder,
          destinationLabel: dst.label,
          sourcePath: path.dirname(ctx.files[0].sourcePath),
          destinationPath: dst.path,
          count: items.length,
          items,
          createdAt: new Date().toISOString(),
        };
        planStore.set(planId, plan);
        return {
          reply: items.length === 1
            ? `I prepared a plan to move **"${items[0].name}"** from ${ctx.folder} to ${dst.label}. Review and approve to proceed.`
            : `I prepared a plan to move **${items.length} files** from ${ctx.folder} to ${dst.label}. Review and approve to proceed.`,
          intent: {
            type: INTENT.MOVE_FILES,
            query: null,
            source: ctx.folder,
            destination: dst.label,
            folderHint: ctx.folder,
            approvalPlan: plan,
          },
          threadId: normalized.threadId,
        };
      }
    }
  }

  if (msgHasMove && srcFromMsg && dstFromMsg) {
    normalized.intent.type        = INTENT.MOVE_FILES;
    normalized.intent.source      = srcFromMsg;
    normalized.intent.destination = dstFromMsg;
  } else if (msgHasMove && !srcFromMsg && dstFromMsg && normalized.intent.type !== INTENT.MOVE_FILES) {
    // Only destination known ("move it/that to Downloads") — let buildMovePlan search for source
    normalized.intent.type        = INTENT.MOVE_FILES;
    normalized.intent.destination = dstFromMsg;
    // don't set source — buildMovePlan will search using file hint / thread context
  }

  // ── Handle delete_file intent ─────────────────────────────────────────────
  if (normalized.intent.type === INTENT.DELETE_FILE) {
    const fileToDelete = specificFile || normalizeTextField(normalized.intent.query);
    const result = await buildDeletePlan(normalized.intent, fileToDelete);
    result.threadId = normalized.threadId;
    return result;
  }

  if (normalized.intent.type === INTENT.CREATE_FOLDER) {
    // Only run create-folder planner when the user's message actually asks to create one.
    // This prevents unrelated organize/scan requests from being diverted here by LLM misclassification.
    if (createFolderReq?.folderName || /\b(create|make)\b.*\bfolder\b/i.test(message)) {
      const result = await buildCreateFolderPlan(message, normalized.intent);
      result.threadId = normalized.threadId;
      return result;
    }
    normalized.intent.type = INTENT.CHAT;
  }

  if (normalized.intent.type === INTENT.MOVE_FOLDER) {
    const result = await buildMoveFolderPlan(normalized.intent.source, normalized.intent.destination);
    result.threadId = normalized.threadId;
    return result;
  }

  // Also check if intent is already move_files or organize_folder with both src+dst
  const isMoveIntent =
    normalized.intent.type === INTENT.MOVE_FILES ||
    (normalized.intent.type === INTENT.ORGANIZE_FOLDER &&
     normalized.intent.source && normalized.intent.destination);

  if (isMoveIntent) {
    if (!normalized.intent.source) normalized.intent.source = srcFromMsg;
    if (!normalized.intent.destination) normalized.intent.destination = dstFromMsg;
    // If source still missing but IBM's reply or query mentions a file,
    // pass it as specificFile so buildMovePlan can search for it
    const moveFileHint = specificFile
      || normalizeTextField(normalized.intent.query)
      || extractSpecificFile(normalized.reply || '');
    const result = await buildMovePlan(normalized.intent, moveFileHint);
    result.threadId = normalized.threadId;
    return result;
  }

  // ── organize_folder with only a source (no destination) → run scan plan ──
  // "Clean Desktop", "Organise Downloads", "Tidy up my Documents" etc.
  // The IBM agent says organise but gives no destination because it means
  // "sort files into type-based subfolders inside that folder".
  // Guard: do NOT run a scan plan when the user was asking for information
  // (sizes, counts, listings) — the IBM reply is already correct in that case.
  if (normalized.intent.type === INTENT.ORGANIZE_FOLDER && !isInformationalQuery) {
    const folderHint = normalized.intent.source || normalized.intent.folderHint
      || extractFolderFromMessage(message);
    const result = await handleScanStructureIntent(
      {
        type:       INTENT.SCAN_STRUCTURE,
        folderHint: folderHint || null,
        source:     folderHint || null,
        query:      null,
        destination: null,
      },
      normalized.reply,  // pass IBM reply so empty folders use it instead of a canned string
    );
    result.threadId = normalized.threadId;
    return result;
  }

  // If agent gave a plain text reply about a count question but didn't set folderHint,
  // try to extract folder from the original message
  if (normalized.intent.type === INTENT.COUNT_FOLDER_ITEMS && !normalized.intent.folderHint) {
    const folderFromMsg = extractFolderFromMessage(message);
    if (folderFromMsg) {
      normalized.intent.folderHint = folderFromMsg;
      normalized.intent.source     = folderFromMsg;
    }
  }

  if (normalized.intent.type === INTENT.COUNT_FOLDER_ITEMS) {
    const result = await buildFolderCountReply(normalized.intent, normalized.reply);
    result.threadId = normalized.threadId;
    return result;
  }

  // ── Handle scan_structure intent — build a REAL suggestion plan ───────────
  if (normalized.intent.type === INTENT.SCAN_STRUCTURE) {
    const result = await handleScanStructureIntent(normalized.intent, normalized.reply);
    result.threadId = normalized.threadId;
    return result;
  }

  // ── Store thread file context for find_file / chat results ──────────────
  // When the agent answers a find/search/list query, store the found file(s)
  // so follow-up "delete it" / "move it" / "delete them" commands work.
  if (
    normalized.threadId &&
    (normalized.intent.type === INTENT.FIND_FILE || normalized.intent.type === INTENT.CHAT)
  ) {
    const fileHint = normalizeTextField(normalized.intent.query || specificFile);
    const folderRef = normalized.intent.folderHint || normalized.intent.source;

    // Also detect if the message asked about a specific extension type
    const extMentioned = message.match(/\b(exe|zip|rar|msi|pdf|jpg|jpeg|png|mp4|mp3|docx?|xlsx?|txt|iso|dmg|apk|jar|gz|tar|7z)\b/i);
    const extHint = extMentioned ? extMentioned[1].toLowerCase() : null;

    if (fileHint || extHint) {
      const folder = folderRef ? resolveFolderRef(folderRef) : null;
      const searchPaths = folder
        ? [{ label: folder.label, path: folder.path }]
        : await getWatchedFolders().then((paths) =>
            paths.map((p) => ({ label: path.basename(p), path: p }))
          );

      const matches = [];
      for (const fp of searchPaths) {
        const exists = await ensureFolderExists(fp.path);
        if (!exists) continue;
        const files = await listDirectFiles(fp.path);

        if (extHint) {
          // Filter by extension
          const byExt = files.filter((f) => path.extname(f.name).toLowerCase() === `.${extHint}`);
          for (const f of byExt) matches.push({ ...f, folderPath: fp.path, folderLabel: fp.label });
        } else if (fileHint) {
          const picked = selectFilesByHint(files, fileHint);
          if (picked.type === 'single' && picked.files[0]) {
            matches.push({ ...picked.files[0], folderPath: fp.path, folderLabel: fp.label });
          } else if (picked.type === 'ambiguous') {
            for (const f of picked.files) matches.push({ ...f, folderPath: fp.path, folderLabel: fp.label });
          }
        }
        if (matches.length >= 20) break; // cap at 20 to avoid storing huge lists
      }

      if (matches.length > 0) {
        const folderLabel = folder?.label
          || (matches[0].folderLabel)
          || path.basename(matches[0].folderPath || '');
        storeThreadFileContext(normalized.threadId, matches, folderLabel);
      }
    }
  }

  return normalized;
}

/**
 * Return a fresh, human-readable folder structure for the given label.
 * Always reads from disk — never uses any cache or thread memory.
 */
async function getFolderStructure(folderLabel) {
  const resolved = resolveFolderRef(folderLabel);
  if (!resolved) {
    return { ok: false, message: `Could not resolve folder: ${folderLabel}` };
  }
  const exists = await ensureFolderExists(resolved.path);
  if (!exists) {
    return { ok: false, message: `Folder "${resolved.label}" was not found on this device.` };
  }

  const entries = await scanFolderForContext(resolved.path, 300, true);

  const lines = [];
  lines.push(`📁 ${resolved.label}/`);

  const subfolders = entries.filter((e) => e.isSubfolder);
  const looseFiles = entries.filter((e) => !e.isSubfolder && !e.name.includes('/'));

  for (const sub of subfolders) {
    const subName = sub.name.replace(/\/$/, '');
    lines.push(`  📂 ${subName}/`);
    const children = entries.filter((e) => !e.isSubfolder && e.name.startsWith(`  ${subName}/`));
    for (const child of children) {
      const fname = child.name.replace(`  ${subName}/`, '');
      const kb = !child.sizeBytes ? '—'
        : child.sizeBytes < 1024 ? `${child.sizeBytes}B`
        : child.sizeBytes < 1048576 ? `${(child.sizeBytes / 1024).toFixed(0)}KB`
        : `${(child.sizeBytes / 1048576).toFixed(1)}MB`;
      lines.push(`    📄 ${fname} (${kb})`);
    }
  }

  for (const f of looseFiles) {
    const kb = !f.sizeBytes ? '—'
      : f.sizeBytes < 1024 ? `${f.sizeBytes}B`
      : f.sizeBytes < 1048576 ? `${(f.sizeBytes / 1024).toFixed(0)}KB`
      : `${(f.sizeBytes / 1048576).toFixed(1)}MB`;
    lines.push(`  📄 ${f.name} (${kb})`);
  }

  const looseCount = looseFiles.length;
  const subCount = subfolders.length;
  const summary = [
    subCount > 0 && `${subCount} subfolder${subCount === 1 ? '' : 's'}`,
    looseCount > 0 && `${looseCount} loose file${looseCount === 1 ? '' : 's'}`,
  ].filter(Boolean).join(', ') || 'empty';

  return {
    ok: true,
    label: resolved.label,
    path: resolved.path,
    summary,
    structure: lines.join('\n'),
  };
}

module.exports = {
  INTENT,
  extractSpecificFile,
  processChatMessage,
  buildScanPlan: handleScanStructureIntent,
  executePlan,
  getFolderStructure,
};
