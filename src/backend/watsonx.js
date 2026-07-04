'use strict';

/**
 * src/backend/watsonx.js
 *
 * Full pipeline:
 *  1. Check learned rules (instant, confidence 1.0)
 *  2. Check cache (same filename was classified before)
 *  3. Send to wxo Orchestrate agent via the hidden BrowserWindow
 *  4. Poll window.classifyFileResult every 500 ms (max 20 s)
 *  5. Parse JSON response, persist to DB, return result
 *  6. Fallback: rule-based classifier if agent unavailable
 */

const path = require('path');
const { query } = require('../db/supabase');
const { updateFileStatus } = require('../db/queries');

// ─── state ────────────────────────────────────────────────────────────────────

/** @type {import('electron').BrowserWindow | null} */
let _orchestrateWindow = null;

const POLL_INTERVAL_MS = 500;
const POLL_TIMEOUT_MS  = 20_000;  // matches the orchestrate page timeout

// ─── category → suggested folder ─────────────────────────────────────────────

const CATEGORY_FOLDER = {
  document:     'Documents',
  image:        'Images',
  video:        'Videos',
  audio:        'Audio',
  code:         'Code',
  spreadsheet:  'Spreadsheets',
  presentation: 'Presentations',
  archive:      'Archives',
  installer:    'Installers',
  other:        'Misc',
  unknown:      'Misc',
};

// ─── rule-based fallback ──────────────────────────────────────────────────────

const EXT_MAP = {
  document:     ['.pdf','.doc','.docx','.txt','.md','.rtf','.odt','.pages'],
  image:        ['.jpg','.jpeg','.png','.gif','.bmp','.svg','.webp','.ico','.tiff','.heic'],
  video:        ['.mp4','.mov','.avi','.mkv','.wmv','.flv','.webm','.m4v'],
  audio:        ['.mp3','.wav','.flac','.aac','.ogg','.m4a','.wma'],
  code:         ['.js','.ts','.jsx','.tsx','.py','.java','.cs','.cpp','.c','.go','.rs','.rb','.php','.swift','.kt'],
  spreadsheet:  ['.xls','.xlsx','.csv','.ods','.numbers'],
  presentation: ['.ppt','.pptx','.odp','.key'],
  archive:      ['.zip','.rar','.7z','.tar','.gz','.bz2','.xz'],
  installer:    ['.exe','.msi','.dmg','.deb','.rpm','.pkg','.appimage'],
};

function ruleBasedClassify(extension) {
  const ext = (extension ?? '').toLowerCase();
  for (const [category, exts] of Object.entries(EXT_MAP)) {
    if (exts.includes(ext)) {
      return { category, subfolder: CATEGORY_FOLDER[category], confidence: 0.75, reasoning: `Rule-based: ${ext} → ${category}` };
    }
  }
  return { category: 'other', subfolder: 'Misc', confidence: 0.5, reasoning: 'Unknown file type — placed in Misc' };
}

// ─── exports ──────────────────────────────────────────────────────────────────

function setOrchestrateWindow(win) {
  _orchestrateWindow = win;
  console.log('[watsonx] orchestrate window wired');
}

// ─── learned rule check ───────────────────────────────────────────────────────

async function findLearnedRule(filename, extension) {
  try {
    const { rows } = await query(
      `SELECT * FROM user_preferences WHERE is_learned_rule = true ORDER BY times_confirmed DESC`
    );
    const lname = (filename  ?? '').toLowerCase();
    const lext  = (extension ?? '').toLowerCase();

    // Priority: keyword + extension > extension only > keyword only
    for (const r of rows) {
      const kw = (r.pattern_keyword ?? '').toLowerCase();
      const ex = (r.extension       ?? '').toLowerCase();
      if (kw && ex && lname.includes(kw) && lext === ex) return r;
    }
    for (const r of rows) {
      const ex = (r.extension ?? '').toLowerCase();
      if (ex && lext === ex && !r.pattern_keyword) return r;
    }
    for (const r of rows) {
      const kw = (r.pattern_keyword ?? '').toLowerCase();
      if (kw && lname.includes(kw) && !r.extension) return r;
    }
  } catch (e) {
    console.error('[watsonx] learnedRule error:', e.message);
  }
  return null;
}

// ─── cache check ──────────────────────────────────────────────────────────────

async function findCached(filename) {
  try {
    const { rows } = await query(
      `SELECT * FROM files WHERE filename=$1 AND status IN('classified','moved') AND suggested_folder IS NOT NULL ORDER BY updated_at DESC LIMIT 1`,
      [filename]
    );
    return rows[0] ?? null;
  } catch { return null; }
}

// ─── persist result ───────────────────────────────────────────────────────────

async function persist(id, subfolder, confidence, reasoning) {
  if (!id) return;
  try {
    await updateFileStatus(id, 'classified', subfolder, confidence, reasoning);
  } catch (e) {
    console.error('[watsonx] persist error:', e.message);
  }
}

// ─── poll for agent response ──────────────────────────────────────────────────

function pollForResult() {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const iv = setInterval(async () => {
      try {
        const result = await _orchestrateWindow.webContents.executeJavaScript(
          'window.classifyFileResult'
        );
        if (result !== null && result !== undefined && String(result).length > 0) {
          clearInterval(iv);
          resolve(String(result));
          return;
        }
        if (Date.now() - start >= POLL_TIMEOUT_MS) {
          clearInterval(iv);
          reject(new Error('Timeout waiting for agent response'));
        }
      } catch (e) {
        clearInterval(iv);
        reject(e);
      }
    }, POLL_INTERVAL_MS);
  });
}

// ─── parse agent JSON ─────────────────────────────────────────────────────────

function parseJSON(raw) {
  if (!raw) return null;
  const cleaned = raw.replace(/^```[a-z]*\n?/i, '').replace(/\n?```$/, '').trim();
  try { return JSON.parse(cleaned); } catch {}
  const m = cleaned.match(/\{[\s\S]*\}/);
  if (m) { try { return JSON.parse(m[0]); } catch {} }
  return null;
}

// ─── MAIN CLASSIFICATION FUNCTION ────────────────────────────────────────────

/**
 * Classify a file using the pipeline:
 * learned rule → cache → orchestrate agent → rule-based fallback
 *
 * @param {{ id, filename, extension, filepath, size_bytes, mime_type, content_preview }} metadata
 * @returns {Promise<{ category, subfolder, suggested_full_path, confidence, reasoning }>}
 */
async function classifyFile(metadata) {
  const { id, filename, extension, filepath, size_bytes, mime_type, content_preview } = metadata;
  const baseDir = path.dirname(filepath ?? '');

  // ── 1. Learned rule ────────────────────────────────────────────────────────
  const rule = await findLearnedRule(filename, extension);
  if (rule) {
    const subfolder = rule.user_confirmed_folder ?? rule.ai_suggested_folder ?? 'Misc';
    const result = {
      category:            subfolder.split(/[/\\]/)[0] ?? 'other',
      subfolder,
      suggested_full_path: path.join(baseDir, subfolder, filename),
      confidence:          1.0,
      reasoning:           `Learned rule: "${rule.pattern_keyword}" + ${rule.extension}`,
    };
    await persist(id, subfolder, 1.0, result.reasoning);
    console.log('[watsonx] learned rule →', subfolder);
    return result;
  }

  // ── 2. Cache hit ───────────────────────────────────────────────────────────
  const cached = await findCached(filename);
  if (cached) {
    const subfolder = cached.suggested_folder;
    const conf      = cached.confidence_score ?? 0.8;
    const result = {
      category:            subfolder.split(/[/\\]/)[0] ?? 'other',
      subfolder,
      suggested_full_path: path.join(baseDir, subfolder, filename),
      confidence:          conf,
      reasoning:           `Cache hit: previously → "${subfolder}"`,
    };
    await persist(id, subfolder, conf, result.reasoning);
    console.log('[watsonx] cache hit →', subfolder);
    return result;
  }

  // ── 3. wxo Orchestrate agent ───────────────────────────────────────────────
  // NOTE: The wxo embed widget does not expose a scriptable REST API for
  // automated classification. The chat widget is for interactive use only.
  // Classification uses the fast rule-based fallback below.
  console.log(`[watsonx] classifying "${filename}" via rule-based engine`);

  // ── 4. Rule-based fallback ─────────────────────────────────────────────────
  const fb = ruleBasedClassify(extension);
  const result = {
    ...fb,
    suggested_full_path: path.join(baseDir, fb.subfolder, filename),
  };
  await persist(id, fb.subfolder, fb.confidence, fb.reasoning);
  console.log(`[watsonx] fallback "${filename}" → ${fb.subfolder}`);
  return result;
}

module.exports = { classifyFile, setOrchestrateWindow };

// ─── FREE-FORM CHAT ───────────────────────────────────────────────────────────

/**
 * Send any plain-text message to the wxo agent and return the raw reply.
 * Used by the Chat page for free-form conversation.
 *
 * @param {string} message
 * @returns {Promise<string>}  Plain text reply from the agent
 */
async function chatWithAgent(message) {
  // The wxo embed widget does not expose a REST API for programmatic chat.
  // Free-form conversation is handled by the WatsonxPanel in the renderer
  // which loads the embed widget directly in an iframe.
  throw new Error('Use the Ask AI panel for free-form conversation with IBM watsonx Orchestrate');
}

module.exports = { classifyFile, chatWithAgent, setOrchestrateWindow };
