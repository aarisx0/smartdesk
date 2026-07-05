'use strict';

const express = require('express');
const router  = express.Router();
const { query } = require('../../db/supabase');

// ── Ensure the chat_sessions table exists ─────────────────────────────────────
// This runs once when the route module is first loaded (server startup).
// Handles the case where the user hasn't manually applied schema.sql to Supabase.
async function ensureChatSessionsTable() {
  try {
    await query(`
      CREATE TABLE IF NOT EXISTS chat_sessions (
        id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
        title         TEXT        NOT NULL DEFAULT 'New Chat',
        messages      JSONB       NOT NULL DEFAULT '[]',
        thread_id     TEXT,
        message_count INT         DEFAULT 0,
        created_at    TIMESTAMPTZ DEFAULT now(),
        updated_at    TIMESTAMPTZ DEFAULT now()
      )
    `);
    await query(`
      CREATE INDEX IF NOT EXISTS idx_chat_sessions_updated
        ON chat_sessions (updated_at DESC)
    `);
    console.log('[chatSessions] table ready');
  } catch (err) {
    console.error('[chatSessions] failed to ensure table:', err.message);
  }
}

// Kick off the check immediately — non-blocking, errors are logged not thrown
ensureChatSessionsTable();

// ── helpers ───────────────────────────────────────────────────────────────────

/**
 * Derive a short title from the first user message in the messages array.
 * Falls back to "New Chat" when the array is empty.
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
  // Truncate to ≤ 60 chars
  return text.length > 60 ? text.slice(0, 57) + '…' : text;
}

// ── GET /api/chat/sessions ────────────────────────────────────────────────────
// Returns the 50 most-recently-updated sessions (id, title, message_count, updated_at).

router.get('/', async (_req, res) => {
  try {
    const { rows } = await query(
      `SELECT id, title, message_count, thread_id, created_at, updated_at
       FROM chat_sessions
       ORDER BY updated_at DESC
       LIMIT 50`
    );
    return res.json(rows);
  } catch (err) {
    console.error('[chatSessions GET /]', err.message);
    return res.status(500).json({ error: err.message });
  }
});

// ── GET /api/chat/sessions/:id ────────────────────────────────────────────────
// Returns the full session including the messages JSONB array.

router.get('/:id', async (req, res) => {
  const { id } = req.params;
  try {
    const { rows } = await query(
      `SELECT * FROM chat_sessions WHERE id = $1 LIMIT 1`,
      [id]
    );
    if (rows.length === 0) return res.status(404).json({ error: 'Session not found' });
    return res.json(rows[0]);
  } catch (err) {
    console.error('[chatSessions GET /:id]', err.message);
    return res.status(500).json({ error: err.message });
  }
});

// ── POST /api/chat/sessions ───────────────────────────────────────────────────
// Creates a new session or upserts an existing one.
// Body: { id?, messages, threadId? }

router.post('/', async (req, res) => {
  const { id, messages, threadId } = req.body;
  if (!Array.isArray(messages)) {
    return res.status(400).json({ error: 'messages must be an array' });
  }

  const title    = deriveTitle(messages);
  const msgCount = messages.length;

  try {
    if (id) {
      // Update existing session
      const { rows } = await query(
        `UPDATE chat_sessions
         SET messages      = $2,
             title         = $3,
             message_count = $4,
             thread_id     = COALESCE($5, thread_id),
             updated_at    = now()
         WHERE id = $1
         RETURNING id, title, message_count, updated_at`,
        [id, JSON.stringify(messages), title, msgCount, threadId || null]
      );
      if (rows.length === 0) return res.status(404).json({ error: 'Session not found' });
      return res.json(rows[0]);
    }

    // Insert new session
    const { rows } = await query(
      `INSERT INTO chat_sessions (title, messages, message_count, thread_id)
       VALUES ($1, $2, $3, $4)
       RETURNING id, title, message_count, updated_at`,
      [title, JSON.stringify(messages), msgCount, threadId || null]
    );
    return res.status(201).json(rows[0]);
  } catch (err) {
    console.error('[chatSessions POST /]', err.message);
    return res.status(500).json({ error: err.message });
  }
});

// ── DELETE /api/chat/sessions/:id ────────────────────────────────────────────

router.delete('/:id', async (req, res) => {
  const { id } = req.params;
  try {
    await query(`DELETE FROM chat_sessions WHERE id = $1`, [id]);
    return res.json({ ok: true });
  } catch (err) {
    console.error('[chatSessions DELETE /:id]', err.message);
    return res.status(500).json({ error: err.message });
  }
});

module.exports = router;
