// NOTE: When running inside the Electron main process (in-process mode),
// dotenv is already loaded by bootstrap.js before this module is required.
// process.env.DATABASE_URL and all other vars are already set.

const express = require('express');
const cors = require('cors');
const http = require('http');
const { Server } = require('socket.io');
// NOTE: dotenv is loaded centrally in src/main/index.ts before this module is required.
const { testConnection } = require('../db/supabase');

const classifyRoutes    = require('./routes/classify');
const activityRoutes    = require('./routes/activity');
const movesRoutes       = require('./routes/moves');
const foldersRoutes     = require('./routes/folders');
const statsRoutes       = require('./routes/stats');
const searchRoutes      = require('./routes/search');
const duplicatesRoutes  = require('./routes/duplicates');
const learningRoutes    = require('./routes/learning');
const chatRoutes        = require('./routes/chat');
const chatSessionsRoutes = require('./routes/chatSessions');
const analyticsRoutes   = require('./routes/analytics');

const app = express();
const server = http.createServer(app);

// ── CORS ──────────────────────────────────────────────────────────────────────
// In the packaged Electron app the renderer is loaded via file:// which browsers
// report as a null Origin.  We must allow that explicitly, plus the Vite dev
// server origin so development still works.
const ALLOWED_ORIGINS = new Set([
  'http://localhost:5173',   // Vite dev
  'http://localhost:3001',   // same-origin API calls
  'app://localhost',         // Electron custom protocol (if used)
]);

function corsOrigin(origin, callback) {
  // file:// renderer sends no Origin header (or the string "null").
  // Allow it unconditionally — this server is localhost-only anyway.
  if (!origin || origin === 'null' || ALLOWED_ORIGINS.has(origin)) {
    return callback(null, true);
  }
  return callback(new Error(`CORS: origin ${origin} not allowed`));
}

const corsOptions = { origin: corsOrigin, credentials: true };

const io = new Server(server, {
  cors: { origin: corsOrigin, methods: ['GET', 'POST'] },
});

// Make io available to routes via app.locals
app.locals.io = io;

app.use(cors(corsOptions));
app.use(express.json({ limit: '1mb' }));

app.use('/api/classify',    classifyRoutes);
app.use('/api/activity',   activityRoutes);
app.use('/api/moves',      movesRoutes);
app.use('/api/folders',    foldersRoutes);
app.use('/api/stats',      statsRoutes);
app.use('/api/search',     searchRoutes);
app.use('/api/duplicates', duplicatesRoutes);
app.use('/api/learning',   learningRoutes);
app.use('/api/chat',      chatRoutes);
app.use('/api/sessions', chatSessionsRoutes);
app.use('/api/analytics', analyticsRoutes);

// Health
app.get('/health', (_req, res) => res.json({ status: 'ok', ts: Date.now() }));

// Socket.IO
io.on('connection', (socket) => {
  console.log('[ws] client connected:', socket.id);
  socket.on('disconnect', () => console.log('[ws] client disconnected:', socket.id));
});

const PORT = process.env.BACKEND_PORT || 3001;

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    // Running in-process inside Electron — do NOT call process.exit() here,
    // that would kill the entire Electron app. Just log and move on.
    console.error(`[backend] Port ${PORT} is already in use — server not started.`);
  } else {
    throw err;
  }
});

server.listen(PORT, async () => {
  console.log(`[backend] listening on http://localhost:${PORT}`);
  await testConnection();
});

// Graceful shutdown — called by Electron main on before-quit
function closeServer() {
  return new Promise((resolve) => {
    server.close(() => resolve());
  });
}

// Keep SIGTERM/SIGINT for dev (nodemon restarts)
process.on('SIGTERM', () => server.close(() => process.exit(0)));
process.on('SIGINT',  () => server.close(() => process.exit(0)));

module.exports = { app, io, closeServer };
