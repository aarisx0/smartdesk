'use strict';

/**
 * src/backend/duplicates.js
 *
 * Scans watched folders for exact and near-duplicate files.
 * - Exact duplicates: identical MD5 hash
 * - Near duplicates: Levenshtein distance ≤ 3 on basenames
 * - Stores groups in Supabase duplicate_groups
 * - Recommends keeping newest or largest file
 */

const fs      = require('fs');
const path    = require('path');
const crypto  = require('crypto');
const { query } = require('../db/supabase');

// ─── MD5 hash ─────────────────────────────────────────────────────────────────

/**
 * Compute MD5 hash of a file.
 * @param {string} filePath
 * @returns {Promise<string|null>}
 */
async function md5File(filePath) {
  return new Promise((resolve) => {
    try {
      const hash   = crypto.createHash('md5');
      const stream = fs.createReadStream(filePath);
      stream.on('data', (chunk) => hash.update(chunk));
      stream.on('end',  () => resolve(hash.digest('hex')));
      stream.on('error', () => resolve(null));
    } catch {
      resolve(null);
    }
  });
}

// ─── Levenshtein distance ─────────────────────────────────────────────────────

/**
 * Classic dynamic-programming Levenshtein distance.
 * @param {string} a
 * @param {string} b
 * @returns {number}
 */
function levenshtein(a, b) {
  const m = a.length, n = b.length;
  const dp = Array.from({ length: m + 1 }, (_, i) =>
    Array.from({ length: n + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0))
  );
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = a[i - 1] === b[j - 1]
        ? dp[i - 1][j - 1]
        : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
    }
  }
  return dp[m][n];
}

// ─── Directory walker ──────────────────────────────────────────────────────────

/**
 * Recursively collect all file paths under a directory (max depth 4).
 * @param {string} dir
 * @param {number} depth
 * @returns {string[]}
 */
function walkDir(dir, depth = 0) {
  if (depth > 4) return [];
  let results = [];
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results = results.concat(walkDir(fullPath, depth + 1));
    } else if (entry.isFile()) {
      results.push(fullPath);
    }
  }
  return results;
}

// ─── Stat helper ──────────────────────────────────────────────────────────────

function safeStat(filePath) {
  try {
    return fs.statSync(filePath);
  } catch {
    return null;
  }
}

// ─── Main scan ────────────────────────────────────────────────────────────────

/**
 * Scan watched folders and return duplicate groups.
 *
 * @param {string[]} watchedFolders
 * @returns {Promise<DuplicateGroup[]>}
 *
 * @typedef {Object} DuplicateGroup
 * @property {string}   type           'exact' | 'near'
 * @property {string}   hash           MD5 hash (exact) or '' (near)
 * @property {FileInfo[]} files
 * @property {string}   recommendedKeep  filepath of file to keep
 * @property {number}   recoverableBytes total bytes of files to delete
 *
 * @typedef {Object} FileInfo
 * @property {string} filepath
 * @property {string} filename
 * @property {number} size
 * @property {Date}   mtime
 */
async function scan(watchedFolders) {
  if (!watchedFolders || watchedFolders.length === 0) return [];

  // 1. Collect all files
  const allFiles = [];
  for (const folder of watchedFolders) {
    const paths = walkDir(folder);
    for (const fp of paths) {
      const stat = safeStat(fp);
      if (!stat) continue;
      allFiles.push({ filepath: fp, filename: path.basename(fp), size: stat.size, mtime: stat.mtime });
    }
  }

  console.log(`[duplicates] scanning ${allFiles.length} files across ${watchedFolders.length} folders`);

  // 2. Exact duplicates via MD5
  const hashMap = new Map(); // hash → FileInfo[]
  for (const file of allFiles) {
    // Skip very small files (< 1 KB) and very large (> 500 MB) to stay fast
    if (file.size < 1024 || file.size > 500 * 1024 * 1024) continue;
    const hash = await md5File(file.filepath);
    if (!hash) continue;
    if (!hashMap.has(hash)) hashMap.set(hash, []);
    hashMap.get(hash).push(file);
  }

  const exactGroups = [];
  for (const [hash, files] of hashMap) {
    if (files.length < 2) continue;
    const recommended = recommendKeep(files);
    exactGroups.push({
      type: 'exact',
      hash,
      files,
      recommendedKeep: recommended.filepath,
      recoverableBytes: files.reduce((s, f) => s + f.size, 0) - recommended.size,
    });
  }

  // 3. Near duplicates via Levenshtein on basenames (without extension)
  const nearGroups = [];
  const usedPaths  = new Set(exactGroups.flatMap((g) => g.files.map((f) => f.filepath)));

  const remaining = allFiles.filter((f) => !usedPaths.has(f.filepath));
  const visited   = new Set();

  for (let i = 0; i < remaining.length; i++) {
    if (visited.has(i)) continue;
    const group = [remaining[i]];
    const baseName = path.parse(remaining[i].filename).name.toLowerCase();

    for (let j = i + 1; j < remaining.length; j++) {
      if (visited.has(j)) continue;
      const otherBase = path.parse(remaining[j].filename).name.toLowerCase();
      if (levenshtein(baseName, otherBase) <= 3) {
        group.push(remaining[j]);
        visited.add(j);
      }
    }

    if (group.length >= 2) {
      visited.add(i);
      const recommended = recommendKeep(group);
      nearGroups.push({
        type: 'near',
        hash: '',
        files: group,
        recommendedKeep: recommended.filepath,
        recoverableBytes: group.reduce((s, f) => s + f.size, 0) - recommended.size,
      });
    }
  }

  const allGroups = [...exactGroups, ...nearGroups];

  // 4. Persist to Supabase
  await persistGroups(allGroups);

  console.log(`[duplicates] found ${exactGroups.length} exact + ${nearGroups.length} near-duplicate groups`);
  return allGroups;
}

/**
 * Choose the file to keep: newest mtime, tiebreak by largest size.
 * @param {FileInfo[]} files
 * @returns {FileInfo}
 */
function recommendKeep(files) {
  return files.reduce((best, f) => {
    if (f.mtime > best.mtime) return f;
    if (f.mtime.getTime() === best.mtime.getTime() && f.size > best.size) return f;
    return best;
  });
}

/**
 * Upsert duplicate groups into Supabase.
 * @param {DuplicateGroup[]} groups
 */
async function persistGroups(groups) {
  for (const g of groups) {
    try {
      const sql = `
        INSERT INTO duplicate_groups (file_hash, filenames, sizes, recommended_keep, resolved)
        VALUES ($1, $2, $3, $4, false)
        ON CONFLICT DO NOTHING
      `;
      await query(sql, [
        g.hash || null,
        JSON.stringify(g.files.map((f) => f.filepath)),
        JSON.stringify(g.files.map((f) => f.size)),
        g.recommendedKeep,
      ]);
    } catch (err) {
      console.error('[duplicates] persist error:', err.message);
    }
  }
}

/**
 * Mark a duplicate group as resolved in Supabase.
 * @param {string} hash
 */
async function markResolved(hash) {
  try {
    await query(
      `UPDATE duplicate_groups SET resolved = true WHERE file_hash = $1`,
      [hash]
    );
  } catch (err) {
    console.error('[duplicates] markResolved error:', err.message);
  }
}

/**
 * Get all unresolved duplicate groups from Supabase.
 * @returns {Promise<object[]>}
 */
async function getGroups() {
  try {
    const { rows } = await query(
      `SELECT * FROM duplicate_groups WHERE resolved = false ORDER BY created_at DESC`
    );
    return rows;
  } catch (err) {
    console.error('[duplicates] getGroups error:', err.message);
    return [];
  }
}

module.exports = { scan, markResolved, getGroups, recommendKeep };
