/**
 * scripts/copy-runtime.js
 * Copies runtime JS files (watcher, db, backend, splash) into dist/
 * Works on Windows regardless of shell (cmd, PowerShell, Git Bash).
 */
'use strict';

const fs   = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

function copyDir(src, dest) {
  if (!fs.existsSync(src)) {
    console.warn(`[copy-runtime] skipping missing dir: ${src}`);
    return;
  }
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDir(s, d);
    } else {
      fs.copyFileSync(s, d);
    }
  }
  console.log(`[copy-runtime] ${src.replace(ROOT, '')}  →  ${dest.replace(ROOT, '')}`);
}

function copyFile(src, dest) {
  if (!fs.existsSync(src)) {
    console.warn(`[copy-runtime] skipping missing file: ${src}`);
    return;
  }
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
  console.log(`[copy-runtime] ${src.replace(ROOT, '')}  →  ${dest.replace(ROOT, '')}`);
}

// ── Directories ──────────────────────────────────────────────────────────────
copyDir(path.join(ROOT, 'src', 'watcher'),  path.join(ROOT, 'dist', 'watcher'));
copyDir(path.join(ROOT, 'src', 'db'),       path.join(ROOT, 'dist', 'db'));
copyDir(path.join(ROOT, 'src', 'backend'),  path.join(ROOT, 'dist', 'backend'));

// ── Splash files (must be next to dist/main/index.js) ───────────────────────
copyFile(path.join(ROOT, 'src', 'main', 'splash.html'),    path.join(ROOT, 'dist', 'main', 'splash.html'));
copyFile(path.join(ROOT, 'src', 'main', 'splash.js'),      path.join(ROOT, 'dist', 'main', 'splash.js'));

// ── Bootstrap entry point + env loader (CJS, not compiled by tsc) ────────────
copyFile(path.join(ROOT, 'src', 'main', 'bootstrap.js'),   path.join(ROOT, 'dist', 'main', 'bootstrap.js'));
copyFile(path.join(ROOT, 'src', 'main', 'env-loader.js'),  path.join(ROOT, 'dist', 'main', 'env-loader.js'));

console.log('[copy-runtime] done.');
