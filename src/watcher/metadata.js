'use strict';

const fs   = require('fs');
const path = require('path');
const mime = require('mime-types');

const PREVIEW_LENGTH = 300;

// ─── lazy-loaded heavy modules ────────────────────────────────────────────────
// Required on first call only — startup stays fast; a failed require is caught
// gracefully so the watcher keeps running even if a native module is missing.

let _pdfParse = null;
let _mammoth  = null;
let _exiftool = null;

function getPdfParse() {
  if (!_pdfParse) _pdfParse = require('pdf-parse');
  return _pdfParse;
}

function getMammoth() {
  if (!_mammoth) _mammoth = require('mammoth');
  return _mammoth;
}

async function getExiftool() {
  if (!_exiftool) {
    const { exiftool } = require('exiftool-vendored');
    _exiftool = exiftool;
  }
  return _exiftool;
}

// ─── stat helpers ─────────────────────────────────────────────────────────────

/**
 * Return fs.Stats for a path, or null if the file has vanished.
 * @param {string} filePath
 * @returns {Promise<import('fs').Stats|null>}
 */
async function safeStat(filePath) {
  try {
    return await fs.promises.stat(filePath);
  } catch {
    return null;
  }
}

// ─── content extractors ───────────────────────────────────────────────────────

/**
 * Extract the first PREVIEW_LENGTH chars from a PDF using pdf-parse.
 * Only parses page 1 to stay fast.
 * @param {string} filePath
 * @returns {Promise<string|null>}
 */
async function extractPdf(filePath) {
  try {
    const pdfParse = getPdfParse();
    const buffer   = await fs.promises.readFile(filePath);
    const data     = await pdfParse(buffer, { max: 1 });
    return (data.text ?? '').trim().slice(0, PREVIEW_LENGTH) || null;
  } catch (err) {
    console.warn(`[metadata] pdf extract failed for ${filePath}:`, err.message);
    return null;
  }
}

/**
 * Read plain-text files (.txt, .md, .csv, .log, .json) directly via fs.
 * No third-party dependency required — just read the bytes.
 * @param {string} filePath
 * @returns {Promise<string|null>}
 */
async function extractPlainText(filePath) {
  try {
    // Cap at 4 KB to avoid reading huge logs into memory
    const fd = await fs.promises.open(filePath, 'r');
    const buf = Buffer.alloc(4096);
    const { bytesRead } = await fd.read(buf, 0, 4096, 0);
    await fd.close();
    return buf.subarray(0, bytesRead).toString('utf8').trim().slice(0, PREVIEW_LENGTH) || null;
  } catch (err) {
    console.warn(`[metadata] plain text extract failed for ${filePath}:`, err.message);
    return null;
  }
}

/**
 * Extract plain text from .docx files using mammoth.
 * mammoth has zero CVEs and no native binary dependencies.
 * @param {string} filePath
 * @returns {Promise<string|null>}
 */
async function extractDocx(filePath) {
  try {
    const mammoth = getMammoth();
    const result  = await mammoth.extractRawText({ path: filePath });
    return (result.value ?? '').trim().slice(0, PREVIEW_LENGTH) || null;
  } catch (err) {
    console.warn(`[metadata] docx extract failed for ${filePath}:`, err.message);
    return null;
  }
}

/**
 * Extract the product name from an .exe or .msi using exiftool-vendored.
 * Returns null gracefully on non-Windows or when exiftool is unavailable.
 * @param {string} filePath
 * @returns {Promise<string|null>}
 */
async function extractExeMetadata(filePath) {
  try {
    const exiftool = await getExiftool();
    const tags     = await exiftool.read(filePath);
    const name =
      tags.ProductName     ||
      tags.FileDescription ||
      tags.InternalName    ||
      null;
    return name ? String(name).slice(0, PREVIEW_LENGTH) : null;
  } catch (err) {
    console.warn(`[metadata] exiftool failed for ${filePath}:`, err.message);
    return null;
  }
}

// ─── main entry point ─────────────────────────────────────────────────────────

/**
 * Gather full metadata for a file path.
 *
 * @param {string} filePath  Absolute path to the file.
 * @returns {Promise<FileMetadata|null>}  null when the file has vanished.
 *
 * @typedef {Object} FileMetadata
 * @property {string}      filename
 * @property {string}      extension       Lower-case, with leading dot (e.g. ".pdf")
 * @property {string}      filepath        Absolute path
 * @property {number}      size_bytes
 * @property {string|null} mime_type
 * @property {string|null} content_preview First 300 chars of content, or null
 * @property {string}      created_at      ISO string from fs birthtime
 * @property {string}      modified_at     ISO string from fs mtime
 */
async function extractMetadata(filePath) {
  const stats = await safeStat(filePath);
  if (!stats || !stats.isFile()) return null;

  const filename  = path.basename(filePath);
  const extension = path.extname(filename).toLowerCase();
  const mimeType  = mime.lookup(filePath) || null;

  let contentPreview = null;

  if (extension === '.pdf') {
    contentPreview = await extractPdf(filePath);
  } else if (extension === '.docx') {
    contentPreview = await extractDocx(filePath);
  } else if (['.txt', '.md', '.csv', '.log', '.json', '.xml', '.yaml', '.yml'].includes(extension)) {
    contentPreview = await extractPlainText(filePath);
  } else if (['.exe', '.msi'].includes(extension)) {
    contentPreview = await extractExeMetadata(filePath);
  }
  // .doc / .rtf / .odt — no safe zero-dep extractor; skip content preview silently

  return {
    filename,
    extension,
    filepath:        filePath,
    size_bytes:      stats.size,
    mime_type:       mimeType,
    content_preview: contentPreview,
    created_at:      stats.birthtime.toISOString(),
    modified_at:     stats.mtime.toISOString(),
  };
}

module.exports = { extractMetadata, safeStat };
