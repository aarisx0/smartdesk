'use strict';

const { Pool } = require('pg');
require('dotenv').config();

if (!process.env.DATABASE_URL) {
  throw new Error('[db] DATABASE_URL is not set. Add it to your .env file.');
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 10,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
  ssl: { rejectUnauthorized: false }, // required for Supabase pooler
});

pool.on('error', (err) => {
  console.error('[db] Unexpected pool error:', err.message);
});

/**
 * Execute a parameterised SQL query.
 * @param {string} text  SQL string with $1, $2 … placeholders
 * @param {unknown[]} [params]
 * @returns {Promise<import('pg').QueryResult>}
 */
async function query(text, params) {
  const start = Date.now();
  const result = await pool.query(text, params);
  const duration = Date.now() - start;
  if (process.env.NODE_ENV !== 'production') {
    console.debug(`[db] query (${duration}ms) — ${text.slice(0, 80)}`);
  }
  return result;
}

/**
 * Test the connection on startup.
 * Resolves with true or throws if the database is unreachable.
 */
async function testConnection() {
  const client = await pool.connect();
  try {
    await client.query('SELECT 1');
    console.log('[db] Supabase Postgres connected');
    return true;
  } finally {
    client.release();
  }
}

module.exports = { query, testConnection, pool };
