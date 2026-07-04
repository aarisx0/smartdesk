'use strict';

/**
 * src/backend/search.js
 *
 * Natural-language file search engine.
 *
 * Pipeline:
 *   1. parseIntent(query)  – extract keywords + type hint (no external AI needed)
 *   2. searchSupabase()    – fuzzy ILIKE + extension filter, ranked by score
 *   3. searchFilesystem()  – live readdir scan of watched folders if DB < 3 hits
 *   4. merge + dedup + final sort by match_score DESC
 */

const fs   = require('fs');
const path = require('path');
const { query: dbQuery } = require('../db/supabase');

// ─── NLP constants ────────────────────────────────────────────────────────────

/** Words that carry no search signal – strip before keyword extraction. */
const STOP_WORDS = new Set([
  'find', 'where', 'is', 'my', 'the', 'a', 'an', 'i', 'me', 'file', 'files',
  'please', 'can', 'you', 'show', 'get', 'look', 'for', 'search', 'locate',
  'help', 'need', 'want', 'give', 'fetch', 'retrieve', 'of', 'in', 'on',
  'and', 'or', 'with', 'from', 'to', 'do', 'have', 'any', 'some', 'all',
]);

/**
 * Semantic keyword → extension mapping.
 * Each entry is checked against every remaining keyword (after stop-word removal).
 */
const TYPE_HINTS = [
  { triggers: ['pdf', 'certificate', 'cert', 'document', 'doc', 'report', 'resume', 'cv',
               'letter', 'form', 'contract', 'invoice', 'receipt', 'notes', 'note',
               'assignment', 'essay', 'paper', 'thesis'],
    extensions: ['.pdf', '.doc', '.docx', '.txt', '.md', '.rtf', '.odt'] },

  { triggers: ['image', 'photo', 'picture', 'pic', 'screenshot', 'scan', 'scan',
               'wallpaper', 'photo', 'img'],
    extensions: ['.jpg', '.jpeg', '.png', '.gif', '.bmp', '.webp', '.svg', '.ico', '.tiff'] },

  { triggers: ['video', 'movie', 'film', 'clip', 'recording', 'reel'],
    extensions: ['.mp4', '.mov', '.avi', '.mkv', '.wmv', '.flv', '.webm', '.m4v'] },

  { triggers: ['audio', 'music', 'song', 'track', 'podcast', 'sound', 'mp3'],
    extensions: ['.mp3', '.wav', '.flac', '.aac', '.ogg', '.m4a', '.wma'] },

  { triggers: ['zip', 'archive', 'compressed', 'rar', 'tarball', 'package'],
    extensions: ['.zip', '.rar', '.7z', '.tar', '.gz', '.bz2', '.xz'] },

  { triggers: ['spreadsheet', 'excel', 'sheet', 'csv', 'data', 'table'],
    extensions: ['.xlsx', '.xls', '.csv', '.ods', '.numbers'] },

  { triggers: ['presentation', 'slides', 'powerpoint', 'ppt', 'deck'],
    extensions: ['.pptx', '.ppt', '.key', '.odp'] },

  { triggers: ['code', 'script', 'program', 'source', 'js', 'ts', 'py', 'python'],
    extensions: ['.js', '.ts', '.jsx', '.tsx', '.py', '.java', '.cs', '.cpp', '.c',
                 '.go', '.rs', '.rb', '.php', '.swift', '.kt'] },
];

// ─── intent parser ────────────────────────────────────────────────────────────

/**
 * @typedef {Object} ParsedIntent
 * @property {string[]} keywords     – meaningful search terms (stop words removed)
 * @property {string[]|null} extHint – list of extensions to filter by, or null
 * @property {string} rawQuery       – original input (lowercased & trimmed)
 */

/**
 * Parse a natural language query into structured search intent.
 * @param {string} raw
 * @returns {ParsedIntent}
 */
function parseIntent(raw) {
  const rawQuery = (raw ?? '').trim().toLowerCase();

  // Tokenise – keep only alphanumeric tokens ≥ 2 chars
  const tokens = rawQuery
    .replace(/[^\w\s]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length >= 2);

  // Identify type hints first (before removing stop words,
  // in case a trigger word like "notes" is also meaningful)
  let extHint = null;
  for (const hint of TYPE_HINTS) {
    if (tokens.some((t) => hint.triggers.includes(t))) {
      extHint = hint.extensions;
      break;
    }
  }

  // Remove stop words AND type-hint trigger words for the keyword list
  // (we don't want "certificate" as a filename keyword when it was a type hint)
  const triggerWords = extHint
    ? new Set(TYPE_HINTS.find((h) => h.extensions === extHint)?.triggers ?? [])
    : new Set();

  const keywords = tokens.filter(
    (t) => !STOP_WORDS.has(t) && !triggerWords.has(t) && t.length >= 2
  );

  return { keywords, extHint, rawQuery };
}

// ─── scoring ──────────────────────────────────────────────────────────────────

/**
 * Compute a relevance score 0–100 for a file path + name against keywords.
 *   100 – exact filename match (after stripping extension)
 *    80 – full keyword found in filename stem
 *    50 – keyword found in full path
 *    +10 per additional keyword matched
 *
 * @param {string} filepath
 * @param {string} filename
 * @param {string[]} keywords
 * @returns {number}
 */
function scoreResult(filepath, filename, keywords) {
  const stem  = path.basename(filename, path.extname(filename)).toLowerCase();
  const fpath = filepath.toLowerCase();
  const fname = filename.toLowerCase();

  if (keywords.length === 0) return 40; // no keywords – mild match

  let score = 0;

  for (const kw of keywords) {
    if (stem === kw)           { score += 100; continue; }
    if (stem.includes(kw))     { score += 80;  continue; }
    if (fname.includes(kw))    { score += 70;  continue; }
    if (fpath.includes(kw))    { score += 50;  continue; }
  }

  // Normalise to 0–100 range per keyword
  return Math.min(100, Math.round(score / keywords.length));
}

// ─── Supabase search ──────────────────────────────────────────────────────────

/**
 * Search the `files` table using ILIKE for each keyword.
 *
 * Priority ordering:
 *   1. Rows where filename ILIKE every keyword (exact multi-keyword match)
 *   2. Rows where filename ILIKE any keyword
 *   3. Then by updated_at DESC
 *
 * @param {ParsedIntent} intent
 * @returns {Promise<object[]>}
 */
async function searchSupabase(intent) {
  const { keywords, extHint } = intent;

  if (keywords.length === 0 && !extHint) return [];

  // Build WHERE clause parts
  const conditions  = [];
  const params      = [];
  let   paramIdx    = 1;

  // Keyword ILIKE conditions (OR across keywords for broad recall)
  if (keywords.length > 0) {
    const ilikeOr = keywords
      .map((kw) => {
        params.push(`%${kw}%`);
        return `filename ILIKE $${paramIdx++}`;
      })
      .join(' OR ');
    conditions.push(`(${ilikeOr})`);
  }

  // Extension filter (IN list)
  if (extHint && extHint.length > 0) {
    const extPlaceholders = extHint.map(() => `$${paramIdx++}`).join(', ');
    params.push(...extHint);
    conditions.push(`extension IN (${extPlaceholders})`);
  }

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  const sql = `
    SELECT
      id, filename, extension, filepath,
      size_bytes, updated_at, status,
      mime_type
    FROM files
    ${whereClause}
    ORDER BY updated_at DESC
    LIMIT 50
  `;

  try {
    const { rows } = await dbQuery(sql, params);
    return rows;
  } catch (err) {
    console.error('[search] Supabase query error:', err.message);
    return [];
  }
}

// ─── filesystem fallback ──────────────────────────────────────────────────────

/**
 * Recursively read a directory up to `maxDepth` levels.
 * Returns a flat list of absolute file paths.
 *
 * We use native `fs.readdir` (no glob package needed) for zero extra deps.
 *
 * @param {string} dir
 * @param {number} maxDepth
 * @returns {Promise<string[]>}
 */
async function readdirDeep(dir, maxDepth = 4) {
  if (maxDepth <= 0) return [];
  let entries;
  try {
    entries = await fs.promises.readdir(dir, { withFileTypes: true });
  } catch {
    return []; // no access — skip silently
  }

  const files = [];
  for (const entry of entries) {
    // Skip hidden files, system dirs, and known noise
    if (entry.name.startsWith('.')) continue;
    if (['node_modules', '$RECYCLE.BIN', 'System Volume Information'].includes(entry.name)) continue;

    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const nested = await readdirDeep(fullPath, maxDepth - 1);
      files.push(...nested);
    } else if (entry.isFile()) {
      files.push(fullPath);
    }
  }
  return files;
}

/**
 * Get the list of watched folder paths from the DB.
 * Falls back to Desktop + Downloads if none configured.
 * @returns {Promise<string[]>}
 */
async function getWatchedFolders() {
  try {
    const { rows } = await dbQuery(
      `SELECT path FROM watched_folders WHERE enabled = true`
    );
    const paths = rows.map((r) => r.path).filter(Boolean);
    if (paths.length > 0) return paths;
  } catch {
    /* fall through */
  }

  const home = process.env.HOME || process.env.USERPROFILE || '';
  return [
    path.join(home, 'Desktop'),
    path.join(home, 'Downloads'),
  ];
}

/**
 * Live filesystem search — used when Supabase returns fewer than 3 results.
 *
 * @param {ParsedIntent} intent
 * @returns {Promise<object[]>}
 */
async function searchFilesystem(intent) {
  const { keywords, extHint } = intent;
  if (keywords.length === 0 && !extHint) return [];

  const folders = await getWatchedFolders();
  const results = [];

  for (const folder of folders) {
    const allFiles = await readdirDeep(folder, 4);

    for (const fullPath of allFiles) {
      const filename  = path.basename(fullPath);
      const extension = path.extname(filename).toLowerCase();

      // Extension filter
      if (extHint && !extHint.includes(extension)) continue;

      // At least one keyword must match the filename
      const stem    = path.basename(filename, extension).toLowerCase();
      const matched = keywords.length === 0
        || keywords.some((kw) => stem.includes(kw) || filename.toLowerCase().includes(kw));

      if (!matched) continue;

      let stat;
      try { stat = await fs.promises.stat(fullPath); }
      catch { continue; }

      results.push({
        id:         null,
        filename,
        extension,
        filepath:   fullPath,
        size_bytes: stat.size,
        updated_at: stat.mtime.toISOString(),
        status:     'fs',
        mime_type:  null,
        _source:    'fs',
      });

      if (results.length >= 30) break; // cap per folder
    }
  }

  return results;
}

// ─── main search function ─────────────────────────────────────────────────────

/**
 * @typedef {Object} SearchResult
 * @property {string|null} id
 * @property {string}      filename
 * @property {string}      extension
 * @property {string}      filepath
 * @property {number|null} size_bytes
 * @property {string}      updated_at
 * @property {string}      status
 * @property {string|null} mime_type
 * @property {number}      match_score   0–100
 * @property {string}      _source       'db' | 'fs'
 */

/**
 * Run the full search pipeline for a natural-language query.
 *
 * @param {string} rawQuery
 * @returns {Promise<{ results: SearchResult[], meta: { query: string, keywords: string[], extHint: string[]|null, durationMs: number, totalFound: number } }>}
 */
async function search(rawQuery) {
  const t0     = Date.now();
  const intent = parseIntent(rawQuery);

  // 1. Database search
  const dbRows = await searchSupabase(intent);

  // 2. Filesystem fallback when DB returns few results
  let fsRows = [];
  if (dbRows.length < 3) {
    fsRows = await searchFilesystem(intent);
  }

  // 3. Merge, annotate source, deduplicate by filepath
  const seenPaths = new Set();
  const all = [];

  for (const row of dbRows) {
    if (seenPaths.has(row.filepath)) continue;
    seenPaths.add(row.filepath);
    all.push({ ...row, _source: 'db' });
  }
  for (const row of fsRows) {
    if (seenPaths.has(row.filepath)) continue;
    seenPaths.add(row.filepath);
    all.push(row);
  }

  // 4. Score every result
  const scored = all.map((row) => ({
    ...row,
    match_score: scoreResult(row.filepath, row.filename, intent.keywords),
  }));

  // 5. Sort: match_score DESC, then updated_at DESC
  scored.sort((a, b) => {
    const scoreDiff = b.match_score - a.match_score;
    if (scoreDiff !== 0) return scoreDiff;
    return new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime();
  });

  const durationMs = Date.now() - t0;

  return {
    results: scored.slice(0, 40), // hard cap
    meta: {
      query:      intent.rawQuery,
      keywords:   intent.keywords,
      extHint:    intent.extHint,
      durationMs,
      totalFound: scored.length,
    },
  };
}

module.exports = { search, parseIntent };
