'use strict';

const express = require('express');
const router = express.Router();
const orchestrateChat = require('../services/orchestrateChatService');

router.post('/', async (req, res) => {
  const { message, threadId } = req.body;
  if (!message || typeof message !== 'string') {
    return res.status(400).json({ error: 'message is required' });
  }

  try {
    const result = await orchestrateChat.processChatMessage(message.trim(), threadId || null);
    return res.json(result);
  } catch (err) {
    console.error('[chat route]', err.message);
    return res.status(500).json({ error: err.message });
  }
});

router.post('/execute', async (req, res) => {
  const { planId } = req.body;
  if (!planId || typeof planId !== 'string') {
    return res.status(400).json({ error: 'planId is required' });
  }

  try {
    const result = await orchestrateChat.executePlan(planId.trim());
    return res.json(result);
  } catch (err) {
    console.error('[chat execute]', err.message);
    return res.status(500).json({ error: err.message });
  }
});

module.exports = router;
