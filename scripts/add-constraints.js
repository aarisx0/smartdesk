const path = require('path');
const root = path.join(__dirname, '..');
require(path.join(root, 'src/main/env-loader.js'));
const { query } = require(path.join(root, 'src/db/supabase'));

async function run() {
  // Add UNIQUE constraints — using DO $$ block to skip if already exists
  const constraints = [
    {
      name: 'files_device_filepath_unique',
      sql: `ALTER TABLE files ADD CONSTRAINT files_device_filepath_unique UNIQUE (device_id, filepath)`,
    },
    {
      name: 'sessions_device_date_unique',
      sql: `ALTER TABLE sessions ADD CONSTRAINT sessions_device_date_unique UNIQUE (device_id, session_date)`,
    },
    {
      name: 'user_prefs_device_keyword_ext_unique',
      sql: `ALTER TABLE user_preferences ADD CONSTRAINT user_prefs_device_keyword_ext_unique UNIQUE (device_id, pattern_keyword, extension)`,
    },
  ];

  for (const c of constraints) {
    try {
      // Check if constraint already exists
      const exists = await query(
        `SELECT 1 FROM information_schema.table_constraints WHERE constraint_name = $1`,
        [c.name]
      );
      if (exists.rows.length > 0) {
        console.log(`[constraints] already exists: ${c.name}`);
        continue;
      }
      await query(c.sql);
      console.log(`[constraints] ✓ added: ${c.name}`);
    } catch (e) {
      console.warn(`[constraints] WARN ${c.name}:`, e.message.slice(0, 120));
    }
  }

  // Verify final state
  console.log('\n--- Verification ---');
  const tables = ['files', 'activity_log', 'sessions', 'chat_sessions', 'user_preferences', 'duplicate_groups'];
  for (const t of tables) {
    const r = await query(
      `SELECT column_name FROM information_schema.columns WHERE table_name = $1 AND table_schema = 'public'`,
      [t]
    );
    const cols = r.rows.map(c => c.column_name);
    const hasDeviceId = cols.includes('device_id');
    const countR = await query(`SELECT COUNT(*) FROM ${t}`);
    console.log(`${t}: device_id=${hasDeviceId} | rows=${countR.rows[0].count}`);
  }
  process.exit(0);
}

run().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
