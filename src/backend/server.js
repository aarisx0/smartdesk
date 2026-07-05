const express = require('express');
const cors = require('cors');
const http = require('http');
const { Server } = require('socket.io');
require('dotenv').config();
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

const io = new Server(server, {
  cors: {
    origin: ['http://localhost:5173', 'app://localhost'],
    methods: ['GET', 'POST'],
  },
});

// Make io available to routes via app.locals
app.locals.io = io;

app.use(cors({ origin: ['http://localhost:5173', 'app://localhost'] }));
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
    console.error(`[backend] Port ${PORT} is already in use. Kill the process using that port and try again.`);
    process.exit(1);
  } else {
    throw err;
  }
});

server.listen(PORT, async () => {
  console.log(`[backend] listening on http://localhost:${PORT}`);
  await testConnection();
});

// Graceful shutdown so nodemon restarts don't leave the port occupied
process.on('SIGTERM', () => server.close(() => process.exit(0)));
process.on('SIGINT',  () => server.close(() => process.exit(0)));

module.exports = { app, io };
