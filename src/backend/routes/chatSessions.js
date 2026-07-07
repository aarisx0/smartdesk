'use strict';

const express = require('express');
const router  = express.Router();
const { query } = require('../../db/supabase');

// ── Ensure the chat_sessions table exists (with device_id column) ─────────────
async function ensureChatSessionsTable() {
  try {
    await query(`
      CREATE TABLE IF NOT EXISTS chat_sessions (
        id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
        device_id     TEXT        NOT NULL DEFAULT 'unknown',
        title         TEXT        NOT NULL DEFAULT 'New Chat',
        messages      JSONB       NOT NULL DEFAULT '[]',
        thread_id     TEXT,
        message_count INT         DEFAULT 0,
        created_at    TIMESTAMPTZ DEFAULT now(),
        updated_at    TIMESTAMPTZ DEFAULT now()
      )
    `);
    // Add device_id if upgrading from old schema
    await query(`ALTER TABLE chat_sessions ADD COLUMN IF NOT EXISTS device_id TEXT NOT NULL DEFAULT 'unknown'`);
    await query(`CREATE INDEX IF NOT EXISTS idx_chat_sessions_updated ON chat_sessions (updated_at DESC)`);
    await query(`CREATE INDEX IF NOT EXISTS idx_chat_sessions_device  ON chat_sessions (device_id)`);
    console.log('[chatSessions] table ready');
  } catch (err) {
    console.error('[chatSessions] failed to ensure table:', err.message);
  }
}

ensureChatSessionsTable();

// ── helpers ───────────────────────────────────────────────────────────────────

/**
 * Derive a short title from the first user message in the messages array.
 */
function deriveTitle(messages) {
  if (!Array.isArray(messages) || messages.length === 0) return 'New Chat';
  const firstUser = messages.find((m) => m.role === 'user');
  if (!firstUser) return 'New Chat';
  const text = (
    typeof firstUser.payload?.text === 'string'
      ? firstUser.payload.text
      : JSON.stringify(firstUser.payload)
  ).trim();
  return text.length > 60 ? text.slice(0, 57) + '…' : text;
}

/**
 * Pull device_id from the x-device-id header.
 * Falls back to 'unknown' so older callers don't break.
 */
function getDeviceId(req) {
  return (req.headers['x-device-id'] || 'unknown').trim();
}

// ── GET /api/sessions ─────────────────────────────────────────────────────────
// Returns the 50 most-recently-updated sessions for THIS device only.

router.get('/', async (req, res) => {
  const deviceId = getDeviceId(req);
  try {
    const { rows } = await query(
      `SELECT id, title, message_count, thread_id, created_at, updated_at
       FROM chat_sessions
       WHERE device_id = $1
       ORDER BY updated_at DESC
       LIMIT 50`,
      [deviceId]
    );
    return res.json(rows);
  } catch (err) {
    console.error('[chatSessions GET /]', err.message);
    return res.status(500).json({ error: err.message });
  }
});

// ── GET /api/sessions/:id ─────────────────────────────────────────────────────
// Returns the full session — must belong to this device.

router.get('/:id', async (req, res) => {
  const { id } = req.params;
  const deviceId = getDeviceId(req);
  try {
    const { rows } = await query(
      `SELECT * FROM chat_sessions WHERE id = $1 AND device_id = $2 LIMIT 1`,
      [id, deviceId]
    );
    if (rows.length === 0) return res.status(404).json({ error: 'Session not found' });
    return res.json(rows[0]);
  } catch (err) {
    console.error('[chatSessions GET /:id]', err.message);
    return res.status(500).json({ error: err.message });
  }
});

// ── POST /api/sessions ────────────────────────────────────────────────────────
// Creates a new session or updates an existing one — always scoped to device.
// Body: { id?, messages, threadId? }

router.post('/', async (req, res) => {
  const { id, messages, threadId } = req.body;
  const deviceId = getDeviceId(req);

  if (!Array.isArray(messages)) {
    return res.status(400).json({ error: 'messages must be an array' });
  }

  const title    = deriveTitle(messages);
  const msgCount = messages.length;

  try {
    if (id) {
      // Update existing session — enforce device ownership
      const { rows } = await query(
        `UPDATE chat_sessions
         SET messages      = $3,
             title         = $4,
             message_count = $5,
             thread_id     = COALESCE($6, thread_id),
             updated_at    = now()
         WHERE id = $1 AND device_id = $2
         RETURNING id, title, message_count, updated_at`,
        [id, deviceId, JSON.stringify(messages), title, msgCount, threadId || null]
      );
      if (rows.length === 0) return res.status(404).json({ error: 'Session not found' });
      return res.json(rows[0]);
    }

    // Insert new session — tag with device_id
    const { rows } = await query(
      `INSERT INTO chat_sessions (device_id, title, messages, message_count, thread_id)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, title, message_count, updated_at`,
      [deviceId, title, JSON.stringify(messages), msgCount, threadId || null]
    );
    return res.status(201).json(rows[0]);
  } catch (err) {
    console.error('[chatSessions POST /]', err.message);
    return res.status(500).json({ error: err.message });
  }
});

// ── DELETE /api/sessions/:id ──────────────────────────────────────────────────
// Only deletes if the session belongs to this device.

router.delete('/:id', async (req, res) => {
  const { id } = req.params;
  const deviceId = getDeviceId(req);
  try {
    const { rowCount } = await query(
      `DELETE FROM chat_sessions WHERE id = $1 AND device_id = $2`,
      [id, deviceId]
    );
    if (rowCount === 0) return res.status(404).json({ error: 'Session not found' });
    return res.json({ ok: true });
  } catch (err) {
    console.error('[chatSessions DELETE /:id]', err.message);
    return res.status(500).json({ error: err.message });
  }
});

module.exports = router;
