/**
 * scripts/migrate-device-id.js
 *
 * Run once to:
 *  1. Add device_id column to all tables that are missing it
 *  2. Add required UNIQUE constraints
 *  3. Tag all existing rows with a given device_id (passed as first CLI arg,
 *     or auto-read from the electron-store if running on the same machine)
 *
 * Usage:
 *   node scripts/migrate-device-id.js [device_id]
 *
 * Example:
 *   node scripts/migrate-device-id.js   (reads device_id from electron-store)
 *   node scripts/migrate-device-id.js abc123
 */

const path = require('path');
const root = path.join(__dirname, '..');
require(path.join(root, 'src/main/env-loader.js'));
const { query } = require(path.join(root, 'src/db/supabase'));

// ── Get device_id ─────────────────────────────────────────────────────────────
// Try to read from electron-store first (same machine), then CLI arg, then generate
let deviceId = process.argv[2] || null;

if (!deviceId) {
  try {
    const Store = require('electron-store');
    const store = new Store();
    deviceId = store.get('deviceId');
    console.log('[migrate] read device_id from electron-store:', deviceId);
  } catch (e) {
    // electron-store not available outside Electron — generate a new one and print it
    const { v4: uuidv4 } = require('uuid');
    deviceId = uuidv4();
    console.warn('[migrate] WARNING: could not read electron-store. Generated new device_id:', deviceId);
    console.warn('[migrate] Pass this ID as the first argument next time if needed.');
  }
}

if (!deviceId) {
  console.error('[migrate] ERROR: no device_id found. Pass it as an argument.');
  process.exit(1);
}

console.log('[migrate] Using device_id:', deviceId);

async function run() {
  // ── Step 1: Add device_id column where missing ──────────────────────────────
  const alterStmts = [
    `ALTER TABLE files            ADD COLUMN IF NOT EXISTS device_id TEXT NOT NULL DEFAULT 'unknown'`,
    `ALTER TABLE activity_log     ADD COLUMN IF NOT EXISTS device_id TEXT NOT NULL DEFAULT 'unknown'`,
    `ALTER TABLE user_preferences ADD COLUMN IF NOT EXISTS device_id TEXT NOT NULL DEFAULT 'unknown'`,
    `ALTER TABLE duplicate_groups ADD COLUMN IF NOT EXISTS device_id TEXT NOT NULL DEFAULT 'unknown'`,
  ];

  // sessions table — check it's the right one first (not auth.sessions)
  const sessCheck = await query(`SELECT column_name FROM information_schema.columns WHERE table_name = 'sessions' AND table_schema = 'public'`);
  const sessHasDeviceId = sessCheck.rows.some(r => r.column_name === 'device_id');
  if (!sessHasDeviceId) {
    alterStmts.push(`ALTER TABLE sessions ADD COLUMN IF NOT EXISTS device_id TEXT NOT NULL DEFAULT 'unknown'`);
  }

  for (const stmt of alterStmts) {
    try {
      await query(stmt);
      console.log('[migrate] ✓', stmt.slice(0, 70) + '...');
    } catch (e) {
      console.warn('[migrate] WARN (may already exist):', e.message);
    }
  }

  // ── Step 2: Add UNIQUE constraints ─────────────────────────────────────────
  const constraints = [
    // Drop old single-column constraint on files.filepath if it exists
    `ALTER TABLE files DROP CONSTRAINT IF EXISTS files_filepath_key`,
    // Add device-scoped unique constraints
    `ALTER TABLE files ADD CONSTRAINT IF NOT EXISTS files_device_filepath_unique UNIQUE (device_id, filepath)`,
    `ALTER TABLE sessions ADD CONSTRAINT IF NOT EXISTS sessions_device_date_unique UNIQUE (device_id, session_date)`,
    `ALTER TABLE user_preferences ADD CONSTRAINT IF NOT EXISTS user_prefs_device_keyword_ext_unique UNIQUE (device_id, pattern_keyword, extension)`,
  ];

  for (const stmt of constraints) {
    try {
      await query(stmt);
      console.log('[migrate] ✓', stmt.slice(0, 80) + '...');
    } catch (e) {
      // Constraint may already exist — not fatal
      console.warn('[migrate] WARN (constraint):', e.message.slice(0, 100));
    }
  }

  // ── Step 3: Add indexes ─────────────────────────────────────────────────────
  const indexes = [
    `CREATE INDEX IF NOT EXISTS idx_files_device           ON files (device_id)`,
    `CREATE INDEX IF NOT EXISTS idx_activity_log_device    ON activity_log (device_id)`,
    `CREATE INDEX IF NOT EXISTS idx_chat_sessions_device   ON chat_sessions (device_id)`,
  ];

  for (const stmt of indexes) {
    try {
      await query(stmt);
      console.log('[migrate] ✓ index:', stmt.slice(30, 80));
    } catch (e) {
      console.warn('[migrate] WARN (index):', e.message.slice(0, 100));
    }
  }

  // ── Step 4: Tag all existing 'unknown' rows with this device_id ─────────────
  const tagTables = ['files', 'activity_log', 'user_preferences', 'duplicate_groups'];

  // For sessions, only update public schema rows
  let totalTagged = 0;

  for (const t of tagTables) {
    try {
      const r = await query(`UPDATE ${t} SET device_id = $1 WHERE device_id = 'unknown'`, [deviceId]);
      const count = r.rowCount ?? 0;
      console.log(`[migrate] tagged ${count} rows in ${t}`);
      totalTagged += count;
    } catch (e) {
      console.error(`[migrate] ERROR tagging ${t}:`, e.message);
    }
  }

  // sessions — only touch public.sessions
  try {
    const r = await query(`UPDATE sessions SET device_id = $1 WHERE device_id = 'unknown' AND session_date IS NOT NULL`, [deviceId]);
    const count = r.rowCount ?? 0;
    console.log(`[migrate] tagged ${count} rows in sessions`);
    totalTagged += count;
  } catch (e) {
    console.error(`[migrate] ERROR tagging sessions:`, e.message);
  }

  // chat_sessions — tag any remaining 'unknown' rows
  try {
    const r = await query(`UPDATE chat_sessions SET device_id = $1 WHERE device_id = 'unknown'`, [deviceId]);
    const count = r.rowCount ?? 0;
    console.log(`[migrate] tagged ${count} rows in chat_sessions`);
    totalTagged += count;
  } catch (e) {
    console.error(`[migrate] ERROR tagging chat_sessions:`, e.message);
  }

  console.log(`\n[migrate] ✅ DONE — ${totalTagged} total rows tagged with device_id: ${deviceId}`);
  console.log('[migrate] Your data is now visible in the app. Restart SmartDesk AI.');
  process.exit(0);
}

run().catch(e => {
  console.error('[migrate] FATAL:', e.message);
  process.exit(1);
});
