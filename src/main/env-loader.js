'use strict';
/**
 * env-loader.js
 *
 * Loads .env BEFORE any other module is required.
 * Works in BOTH contexts:
 *   1. Electron main process — uses process.resourcesPath (Electron API)
 *   2. Forked Node child (backend/server.js) — uses DOT_ENV_PATH or
 *      RESOURCES_PATH env vars passed explicitly by the parent fork() call.
 *
 * Path priority:
 *   1. DOT_ENV_PATH env var  — set explicitly by parent fork() call (most reliable)
 *   2. RESOURCES_PATH env var + /.env  — set by parent fork() call
 *   3. process.resourcesPath + /.env   — Electron main process only
 *   4. __dirname/../../.env            — dev: dist/main/ → project root
 *   5. __dirname/../../../.env         — deeper nesting fallback
 *   6. process.cwd()/.env              — last resort
 */

const path   = require('path');
const fs     = require('fs');
const dotenv = require('dotenv');

const candidates = [];

// 1. Explicit .env path passed from parent (most reliable for forked children)
if (process.env.DOT_ENV_PATH) {
  candidates.push(process.env.DOT_ENV_PATH);
}

// 2. Explicit resources path passed from parent
if (process.env.RESOURCES_PATH) {
  candidates.push(path.join(process.env.RESOURCES_PATH, '.env'));
}

// 3. Electron main process — process.resourcesPath is set by Electron
if (process.resourcesPath) {
  candidates.push(path.join(process.resourcesPath, '.env'));
}

// 4-5. Dev/unpacked paths: dist/main/env-loader.js → project root
candidates.push(path.join(__dirname, '../../.env'));    // dist/main/ → root
candidates.push(path.join(__dirname, '../../../.env')); // deeper nesting

// 6. cwd fallback
candidates.push(path.join(process.cwd(), '.env'));

const found = candidates.find(p => {
  try { return fs.existsSync(p); } catch (_) { return false; }
});

if (found) {
  dotenv.config({ path: found, override: false });
  try { console.log('[env-loader] loaded .env from:', found); } catch (_) {}
} else {
  dotenv.config({ override: false });
  try { console.warn('[env-loader] WARNING: .env not found. Tried:', candidates); } catch (_) {}
}
