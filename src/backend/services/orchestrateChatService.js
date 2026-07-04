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
};

function getDefaultFolders() {
  const home = os.homedir();
  return {
    Desktop: path.join(home, 'Desktop'),
    Downloads: path.join(home, 'Downloads'),
    Documents: path.join(home, 'Documents'),
    Pictures: path.join(home, 'Pictures'),
    Music: path.join(home, 'Music'),
    Videos: path.join(home, 'Videos'),
  };
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
 * Scan a folder and return a summary of files (name, size, extension).
 * Caps at 200 files to keep the prompt reasonable.
 */
async function scanFolderForContext(folderPath, maxFiles = 150) {
  try {
    const dirents = await fs.readdir(folderPath, { withFileTypes: true });
    const files = [];
    for (const entry of dirents) {
      if (!entry.isFile()) continue;
      const fullPath = path.join(folderPath, entry.name);
      try {
        const stat = await fs.stat(fullPath);
        files.push({ name: entry.name, sizeBytes: stat.size });
      } catch { /* skip unreadable */ }
    }
    // Sort by size descending so largest files appear first — helps agent answer size questions
    files.sort((a, b) => b.sizeBytes - a.sizeBytes);
    return files.slice(0, maxFiles);
  } catch {
    return [];
  }
}

/**
 * Format a file list as a compact text block for the system prompt.
 */
function formatFileListForPrompt(folderLabel, files) {
  if (files.length === 0) return `${folderLabel}: (empty or no access)`;
  const lines = files.map((f) => {
    const kb = f.sizeBytes < 1024 ? `${f.sizeBytes}B`
      : f.sizeBytes < 1048576 ? `${(f.sizeBytes/1024).toFixed(0)}KB`
      : f.sizeBytes < 1073741824 ? `${(f.sizeBytes/1048576).toFixed(1)}MB`
      : `${(f.sizeBytes/1073741824).toFixed(2)}GB`;
    return `  - ${f.name} (${kb})`;
  });
  return `${folderLabel} (${files.length} files):\n${lines.join('\n')}`;
}

/**
 * Detect which folders are relevant to the user's message so we only scan those.
 */
function detectRelevantFolders(message, defaultFolders) {
  const t = message.toLowerCase();
  const relevant = [];

  for (const [alias, canonical] of Object.entries(FOLDER_ALIASES)) {
    if (t.includes(alias) && defaultFolders[canonical]) {
      if (!relevant.find((f) => f.label === canonical)) {
        relevant.push({ label: canonical, path: defaultFolders[canonical] });
      }
    }
  }

  // If no specific folder mentioned, include Desktop and Downloads
  if (relevant.length === 0) {
    const fallbacks = ['Desktop', 'Downloads'];
    for (const label of fallbacks) {
      if (defaultFolders[label]) relevant.push({ label, path: defaultFolders[label] });
    }
  }

  return relevant;
}

/**
 * Build a file system context string to inject into the system prompt.
 * This gives the agent real data to answer questions accurately.
 */
async function buildFileSystemContext(message, defaultFolders) {
  const relevantFolders = detectRelevantFolders(message, defaultFolders);
  const sections = [];

  for (const folder of relevantFolders) {
    const files = await scanFolderForContext(folder.path, 200);
    sections.push(formatFileListForPrompt(folder.label, files));
  }

  if (sections.length === 0) return '';
  return '\n\nCURRENT FILE SYSTEM CONTEXT (real data from this machine):\n' + sections.join('\n\n');
}

// ─── System prompt ────────────────────────────────────────────────────────────

function buildSystemPrompt(context) {
  return [
    'You are SmartDesk AI, a desktop file organizer assistant running on the user\'s computer.',
    'You have been given REAL file system data below — use it to answer questions accurately.',
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
    '    "source": "folder name/path or null",',
    '    "destination": "folder name/path or null",',
    '    "folderHint": "folder name/path or null"',
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
    'If you are missing details for an action, keep the reply conversational and set type to chat.',
    'Examples:',
    '{"reply":"I found resume.pdf in Downloads (245KB).","intent":{"type":"find_file","query":"resume","source":null,"destination":null,"folderHint":"Downloads"}}',
    '{"reply":"There are 42 files directly in Downloads.","intent":{"type":"count_folder_items","query":null,"source":"Downloads","destination":null,"folderHint":"Downloads"}}',
    '{"reply":"The largest file in Downloads is video.mp4 at 2.3GB.","intent":{"type":"chat","query":null,"source":"Downloads","destination":null,"folderHint":null}}',
    '{"reply":"I can prepare a plan to move nasri rifana resume.pdf from Desktop to Downloads.","intent":{"type":"move_files","query":null,"source":"Desktop","destination":"Downloads","folderHint":"Desktop"}}',
    '{"reply":"I can prepare a plan to delete report.pdf from Desktop. It will be moved to SmartDesk Trash safely.","intent":{"type":"delete_file","query":"report.pdf","source":"Desktop","destination":null,"folderHint":"Desktop"}}',
    `Available watched folders: ${JSON.stringify(context.watchedFolders)}`,
    `Default folders: ${JSON.stringify(context.defaultFolders)}`,
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

function inferIntentFromPlainText(text) {
  const t = text.toLowerCase();
  if (/\bcreate\b.*\bfolder\b/.test(t))
    return { type: INTENT.CREATE_FOLDER, query: null, source: null, destination: null, folderHint: null };
  if (/\bmove\b.*\bfolder\b.*\bto\b/.test(t))
    return { type: INTENT.MOVE_FOLDER, query: null, source: null, destination: null, folderHint: null };
  if (/\b(find|search|look|where|locat)\b/.test(t))
    return { type: INTENT.FIND_FILE, query: null, source: null, destination: null, folderHint: null };
  if (/\b(duplicat|copies|same file)\b/.test(t))
    return { type: INTENT.SHOW_DUPLICATES, query: null, source: null, destination: null, folderHint: null };
  if (/\b(storage|disk|space|usage)\b/.test(t))
    return { type: INTENT.STORAGE_REPORT, query: null, source: null, destination: null, folderHint: null };
  if (/\b(how many|count|number of files)\b/.test(t))
    return { type: INTENT.COUNT_FOLDER_ITEMS, query: null, source: null, destination: null, folderHint: null };
  if (/\b(move|organis|organiz|clean)\b/.test(t))
    return { type: INTENT.ORGANIZE_FOLDER, query: null, source: null, destination: null, folderHint: null };
  return { type: INTENT.CHAT, query: null, source: null, destination: null, folderHint: null };
}

function normalizeIntent(raw) {
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

  // Agent returned plain text (not JSON) — treat as conversational reply
  // but also try to infer intent from the raw text
  const plainText = (typeof raw === 'string' ? raw : '').trim();
  if (plainText) {
    const inferred = inferIntentFromPlainText(plainText);
    return {
      reply: plainText,
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
  const aliasKey = cleaned.toLowerCase();
  const mapped = FOLDER_ALIASES[aliasKey];
  if (mapped && defaults[mapped]) {
    return { label: mapped, path: defaults[mapped] };
  }

  if (path.isAbsolute(cleaned)) {
    return { label: cleaned, path: cleaned };
  }

  const exactDefault = Object.entries(defaults).find(([label]) => label.toLowerCase() === aliasKey);
  if (exactDefault) {
    return { label: exactDefault[0], path: exactDefault[1] };
  }

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

function extractSpecificFile(message) {
  // Match quoted filenames: "resume.pdf" or 'resume.pdf'
  const quoted = message.match(/["']([^"']+\.[a-z0-9]+)["']/i);
  if (quoted) return quoted[1];
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

  return { type: 'none', files: [] };
}

async function buildDeletePlan(intent, specificFile = null) {
  const source = resolveFolderRef(intent.source || intent.folderHint);

  if (!source) {
    return {
      reply: 'I need to know which folder the file is in before I can prepare a delete plan.',
      intent: { type: INTENT.CHAT, query: null, source: null, destination: null, folderHint: null },
    };
  }

  const sourceExists = await ensureFolderExists(source.path);
  if (!sourceExists) {
    return {
      reply: `I could not find the folder "${source.label}" on this device.`,
      intent: { type: INTENT.CHAT, query: null, source: source.label, destination: null, folderHint: source.label },
    };
  }

  // Determine which file(s) to delete
  const fileToDelete = normalizeTextField(specificFile || intent.query);
  if (!fileToDelete) {
    return {
      reply: 'Please specify which file you want to delete.',
      intent: { type: INTENT.CHAT, query: null, source: source.label, destination: null, folderHint: source.label },
    };
  }

  const allFiles = await listDirectFiles(source.path);
  const picked = selectFilesByHint(allFiles, fileToDelete);
  let filesToDelete = [];

  if (picked.type === 'none') {
    return {
      reply: `I could not find "${fileToDelete}" in ${source.label}.`,
      intent: { type: INTENT.CHAT, query: null, source: source.label, destination: null, folderHint: source.label },
    };
  }

  if (picked.type === 'ambiguous') {
    const options = picked.files.slice(0, 5).map((f) => `"${f.name}"`).join(', ');
    return {
      reply: `I found multiple matches for "${fileToDelete}" in ${source.label}: ${options}. Please tell me the exact file name to delete.`,
      intent: { type: INTENT.CHAT, query: null, source: source.label, destination: null, folderHint: source.label },
    };
  }

  filesToDelete = picked.files;

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
  const source = resolveFolderRef(intent.source || intent.folderHint);
  const destination = resolveFolderRef(intent.destination);

  if (!source || !destination) {
    return {
      reply: 'I need both a source and destination folder before I can prepare a move plan.',
      intent: { type: INTENT.CHAT, query: null, source: null, destination: null, folderHint: null },
    };
  }

  const sourceExists = await ensureFolderExists(source.path);
  if (!sourceExists) {
    return {
      reply: `I could not find the source folder \"${source.label}\" on this device.`,
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

async function findSingleFileAcrossDefaultFolders(fileHint) {
  const defaults = getDefaultFolders();
  const matches = [];
  for (const folderPath of Object.values(defaults)) {
    const exists = await ensureFolderExists(folderPath);
    if (!exists) continue;
    const files = await listDirectFiles(folderPath);
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
  // Check each known folder alias
  for (const [alias, canonical] of Object.entries(FOLDER_ALIASES)) {
    if (t.includes(alias)) {
      if (role === 'destination') {
        // Only return as destination if preceded by "to"
        const re = new RegExp(`\\bto\\b.*\\b${alias}\\b`, 'i');
        if (re.test(t)) return canonical;
      } else if (role === 'source') {
        // Only return as source if preceded by "from" or "in"
        const re = new RegExp(`\\b(from|in)\\b.*\\b${alias}\\b`, 'i');
        if (re.test(t)) return canonical;
      } else {
        return canonical;
      }
    }
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
    return {
      reply: `**${label}** already looks organised — all files are in their own subfolders or there are no loose files to move.`,
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
    // Return agent's plain-text reply as-is — it was already conversational
    return {
      reply: agentReply || 'I could not tell which folder you meant. Try something like "how many files are in Downloads?"',
      intent: { type: INTENT.CHAT, query: null, source: null, destination: null, folderHint: null },
    };
  }

  const exists = await ensureFolderExists(folder.path);
  if (!exists) {
    return {
      reply: `I could not find the **${folder.label}** folder on this device.`,
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
  const specificFile = extractSpecificFile(message);

  try {
    const rawResponse = await askOrchestrate(message, incomingThreadId);
    const rawText = extractAssistantText(rawResponse);
    normalized = normalizeIntent(rawText);
    // Attach the thread ID so the client can send it back next turn
    normalized.threadId = rawResponse?.thread_id || threadId || null;
  } catch (err) {
    console.error('[orchestrateChat] agent request failed:', err.message);
    return buildUnavailableFallback();
  }

  // ── Smart delete detection ────────────────────────────────────────────────
  // If message mentions delete/remove/trash + a specific file, build a delete plan
  const msgHasDelete = /\b(delete|remove|trash|erase)\b/i.test(message);
  if (msgHasDelete && specificFile) {
    const srcFromMsg = extractFolderFromMessage(message, 'source') || extractFolderFromMessage(message);
    if (srcFromMsg) {
      normalized.intent.type = INTENT.DELETE_FILE;
      normalized.intent.source = srcFromMsg;
      normalized.intent.query = specificFile;
    }
  }

  // ── Smart create-folder detection ──────────────────────────────────────────
  const createFolderReq = parseCreateFolderRequest(message);
  if (createFolderReq?.folderName) {
    normalized.intent.type = INTENT.CREATE_FOLDER;
    normalized.intent.destination = createFolderReq.parentRef;
    normalized.intent.query = createFolderReq.fileHint || createFolderReq.folderName;
  }

  // ── Smart scan/organize-structure detection (guard against misclassified create_folder) ──
  const msgWantsStructureScan =
    /\b(scan|analyse?|analyze|check|review|suggest)\b.*\b(folder|structure|system|files?)\b/i.test(message) ||
    (/\b(organis|organiz|clean\s*up|reorganis|reorganiz)\b/i.test(message) &&
     /\b(folder|desktop|downloads?|documents?|pictures?|videos?|files?)\b/i.test(message) &&
     !/\b(create|make)\b.*\bfolder\b/i.test(message));

  if (msgWantsStructureScan) {
    const hint = extractFolderFromMessage(message);
    normalized.intent.type = INTENT.SCAN_STRUCTURE;
    normalized.intent.folderHint = hint;
    normalized.intent.source = hint;
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
  const msgHasMove = /\bmove\b/i.test(message) && !/\bmove\b.*\bfolder\b/i.test(message);
  const srcFromMsg = extractFolderFromMessage(message, 'source');
  const dstFromMsg = extractFolderFromMessage(message, 'destination');

  if (msgHasMove && srcFromMsg && dstFromMsg) {
    normalized.intent.type        = INTENT.MOVE_FILES;
    normalized.intent.source      = srcFromMsg;
    normalized.intent.destination = dstFromMsg;
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
    const result = await buildMovePlan(normalized.intent, specificFile);
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

  return normalized;
}

module.exports = {
  INTENT,
  extractSpecificFile,
  processChatMessage,
  buildScanPlan: handleScanStructureIntent,
  executePlan,
};
