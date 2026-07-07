const path = require('path');
const root = path.join(__dirname, '..');
require(path.join(root, 'src/main/env-loader.js'));
const { query } = require(path.join(root, 'src/db/supabase'));

async function main() {
  const tables = ['files', 'activity_log', 'sessions', 'chat_sessions', 'user_preferences', 'duplicate_groups'];
  console.log('--- device_id column presence ---');
  for (const t of tables) {
    const r = await query(`SELECT column_name FROM information_schema.columns WHERE table_name = $1`, [t]);
    const cols = r.rows.map(c => c.column_name);
    const hasDeviceId = cols.includes('device_id');
    console.log(`${t}: device_id=${hasDeviceId} | all cols: ${cols.join(', ')}`);
  }
  console.log('\n--- Row counts ---');
  for (const t of tables) {
    try {
      const r = await query(`SELECT COUNT(*) FROM ${t}`);
      console.log(`${t}: ${r.rows[0].count} rows`);
    } catch(e) {
      console.log(`${t}: ERROR - ${e.message}`);
    }
  }
  process.exit(0);
}
main().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
