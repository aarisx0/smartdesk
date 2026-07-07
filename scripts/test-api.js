const path = require('path');
const http = require('http');

const DEVICE_ID = 'ebf2c0de-3012-435c-93b5-5eb51a4c2fbc';
const ROOT = path.join(__dirname, '..');

// Load env from dist
require(path.join(ROOT, 'dist/main/env-loader.js'));
process.env.NODE_ENV = 'test';

// Start server from dist
require(path.join(ROOT, 'dist/backend/server.js'));

function get(path, headers = {}) {
  return new Promise((resolve, reject) => {
    const opts = {
      hostname: 'localhost', port: 3001, path, method: 'GET',
      headers: { 'x-device-id': DEVICE_ID, ...headers }
    };
    const req = http.request(opts, res => {
      let body = '';
      res.on('data', d => body += d);
      res.on('end', () => { try { resolve(JSON.parse(body)); } catch { resolve(body); } });
    });
    req.on('error', reject);
    req.end();
  });
}

function post(path, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const opts = {
      hostname: 'localhost', port: 3001, path, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data), 'x-device-id': DEVICE_ID, ...headers }
    };
    const req = http.request(opts, res => {
      let body = '';
      res.on('data', d => body += d);
      res.on('end', () => { try { resolve(JSON.parse(body)); } catch { resolve(body); } });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

async function runTests() {
  // Wait for server
  await new Promise(r => setTimeout(r, 2000));

  console.log('\n========== API TEST RESULTS ==========\n');

  try {
    const stats = await get('/api/stats');
    console.log('✓ /api/stats:', JSON.stringify(stats));
  } catch(e) { console.error('✗ /api/stats:', e.message); }

  try {
    const activity = await get('/api/activity?limit=3');
    console.log(`✓ /api/activity: ${Array.isArray(activity) ? activity.length + ' rows' : JSON.stringify(activity).slice(0,100)}`);
    if (Array.isArray(activity) && activity[0]) console.log('  sample:', JSON.stringify(activity[0]).slice(0,120));
  } catch(e) { console.error('✗ /api/activity:', e.message); }

  try {
    const analytics = await get('/api/analytics');
    console.log('✓ /api/analytics totals:', JSON.stringify(analytics.totals));
    console.log('  daily rows:', analytics.daily?.length, '| categories:', analytics.categories?.length, '| topFolders:', analytics.topFolders?.length);
  } catch(e) { console.error('✗ /api/analytics:', e.message); }

  try {
    const sessions = await get('/api/sessions');
    console.log(`✓ /api/sessions: ${Array.isArray(sessions) ? sessions.length + ' sessions' : JSON.stringify(sessions).slice(0,100)}`);
  } catch(e) { console.error('✗ /api/sessions:', e.message); }

  try {
    const pending = await get('/api/activity?status=pending&limit=5');
    console.log(`✓ /api/activity?status=pending: ${Array.isArray(pending) ? pending.length + ' pending' : JSON.stringify(pending).slice(0,100)}`);
  } catch(e) { console.error('✗ /api/activity pending:', e.message); }

  try {
    const chat = await post('/api/chat', { message: 'show my storage stats' });
    console.log('✓ /api/chat reply:', JSON.stringify(chat.reply).slice(0, 120));
    console.log('  intent type:', chat.intent?.type);
  } catch(e) { console.error('✗ /api/chat:', e.message); }

  console.log('\n========== END TEST ==========\n');
  process.exit(0);
}

runTests();
