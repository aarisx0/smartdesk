'use strict';

require('dotenv').config();
const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

async function main() {
  const schemaPath = path.join(__dirname, '../src/db/schema.sql');
  // Also add UNIQUE constraint on sessions.session_date
  const extraSQL = `
    ALTER TABLE sessions DROP CONSTRAINT IF EXISTS sessions_session_date_key;
    ALTER TABLE sessions ADD CONSTRAINT sessions_session_date_key UNIQUE (session_date);
    
    -- user_preferences needs UNIQUE on (pattern_keyword, extension) for ON CONFLICT
    ALTER TABLE user_preferences DROP CONSTRAINT IF EXISTS user_prefs_keyword_ext_key;
    ALTER TABLE user_preferences ADD CONSTRAINT user_prefs_keyword_ext_key 
      UNIQUE (pattern_keyword, extension);
  `;

  let sql = fs.readFileSync(schemaPath, 'utf8') + '\n' + extraSQL;

  const client = await pool.connect();
  try {
    await client.query(sql);
    console.log('[schema] All tables created/verified successfully.');
  } catch (err) {
    console.error('[schema] Error:', err.message);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

main();
