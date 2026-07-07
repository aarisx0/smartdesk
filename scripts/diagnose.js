const path = require('path');
const root = path.join(__dirname, '..');
require(path.join(root, 'src/main/env-loader.js'));
const { query } = require(path.join(root, 'src/db/supabase'));

const DEVICE_ID = 'ebf2c0de-3012-435c-93b5-5eb51a4c2fbc';

async function main() {
  // 1. What device_ids exist in files?
  const r1 = await query(`SELECT device_id, COUNT(*) FROM files GROUP BY device_id ORDER BY count DESC LIMIT 10`);
  console.log('=== files device_id distribution ===');
  r1.rows.forEach(r => console.log(`  "${r.device_id}" => ${r.count} rows`));

  // 2. What device_ids exist in activity_log?
  const r2 = await query(`SELECT device_id, COUNT(*) FROM activity_log GROUP BY device_id ORDER BY count DESC LIMIT 10`);
  console.log('\n=== activity_log device_id distribution ===');
  r2.rows.forEach(r => console.log(`  "${r.device_id}" => ${r.count} rows`));

  // 3. What does the stats query return for our device?
  const today = new Date().toISOString().slice(0, 10);
  const r3 = await query(`SELECT COUNT(*) FROM files WHERE status = 'moved' AND device_id = $1`, [DEVICE_ID]);
  const r4 = await query(`SELECT COUNT(*) FROM files WHERE status IN ('classified','moved') AND device_id = $1`, [DEVICE_ID]);
  const r5 = await query(`SELECT COUNT(*) FROM files WHERE status = 'pending' AND device_id = $1`, [DEVICE_ID]);
  console.log(`\n=== Stats for device ${DEVICE_ID} ===`);
  console.log(`  moved: ${r3.rows[0].count}`);
  console.log(`  classified+moved: ${r4.rows[0].count}`);
  console.log(`  pending: ${r5.rows[0].count}`);

  // 4. What statuses exist in files for our device?
  const r6 = await query(`SELECT status, COUNT(*) FROM files WHERE device_id = $1 GROUP BY status`, [DEVICE_ID]);
  console.log('\n=== File statuses for our device ===');
  r6.rows.forEach(r => console.log(`  ${r.status}: ${r.count}`));

  // 5. Sample 3 files to see actual data
  const r7 = await query(`SELECT id, filename, status, device_id FROM files WHERE device_id = $1 LIMIT 3`, [DEVICE_ID]);
  console.log('\n=== Sample files rows ===');
  r7.rows.forEach(r => console.log(`  ${r.filename} | status=${r.status} | device=${r.device_id}`));

  // 6. Check activity_log for our device
  const r8 = await query(`SELECT action, COUNT(*) FROM activity_log WHERE device_id = $1 GROUP BY action`, [DEVICE_ID]);
  console.log('\n=== Activity log actions for our device ===');
  r8.rows.forEach(r => console.log(`  ${r.action}: ${r.count}`));

  // 7. What the running server actually returns (direct DB query mimicking stats route)
  const r9 = await query(`SELECT COUNT(*) FROM files WHERE status = 'moved'`); // no device filter
  console.log(`\n=== Global moved count (no device filter): ${r9.rows[0].count}`);

  process.exit(0);
}
main().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
