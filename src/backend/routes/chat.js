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

// Direct scan endpoint — bypasses IBM agent, always runs the local folder scan.
// Accepts optional `folder` (label like "Desktop") to scope the scan.
router.post('/scan', async (req, res) => {
  const { folder } = req.body;
  try {
    const intent = {
      type: orchestrateChat.INTENT.SCAN_STRUCTURE,
      folderHint: folder || null,
      source:     folder || null,
      query:      null,
      destination: null,
    };
    const result = await orchestrateChat.buildScanPlan(intent);
    return res.json(result);
  } catch (err) {
    console.error('[chat scan]', err.message);
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
