'use strict';

const { Pool } = require('pg');
// NOTE: dotenv is loaded centrally in src/main/bootstrap.js before any module is required.
// Do NOT call dotenv.config() here — it would look in the wrong directory in production.

// Safe logger — silently swallows EPIPE (no stdout in packaged Electron app)
function safeLog(...args) {
  try { console.log(...args); } catch (_) {}
}
function safeError(...args) {
  try { console.error(...args); } catch (_) {}
}

// DATABASE_URL is required for DB operations, but its absence must NOT crash
// the main process — the window must still open and show the UI.
// Any DB call while pool===null will simply reject with a clear error.
let pool = null;

if (!process.env.DATABASE_URL) {
  safeError('[db] WARNING: DATABASE_URL is not set. Database features will be unavailable.');
} else {
  pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    max: 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
    ssl: { rejectUnauthorized: false }, // required for Supabase pooler
  });

  pool.on('error', (err) => {
    safeError('[db] Unexpected pool error:', err.message);
  });
}

/**
 * Execute a parameterised SQL query.
 * Returns an empty result set (not a throw) when the pool is unavailable,
 * so callers that destructure `{ rows }` don't crash.
 *
 * @param {string} text  SQL string with $1, $2 … placeholders
 * @param {unknown[]} [params]
 * @returns {Promise<import('pg').QueryResult>}
 */
async function query(text, params) {
  if (!pool) {
    safeError('[db] query skipped — no DATABASE_URL configured');
    return { rows: [], rowCount: 0 };
  }
  const result = await pool.query(text, params);
  return result;
}

/**
 * Test the connection on startup.
 * Resolves silently (does not throw) if the pool is unavailable.
 */
async function testConnection() {
  if (!pool) {
    safeError('[db] testConnection skipped — no DATABASE_URL configured');
    return false;
  }
  const client = await pool.connect();
  try {
    await client.query('SELECT 1');
    safeLog('[db] Supabase Postgres connected');
    return true;
  } finally {
    client.release();
  }
}

module.exports = { query, testConnection, pool };
