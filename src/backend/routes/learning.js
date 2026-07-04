'use strict';

const express  = require('express');
const router   = express.Router();
const learning = require('../learning');

// GET /api/learning/rules
router.get('/rules', async (_req, res) => {
  try {
    const rules = await learning.getAllRules();
    res.json(rules);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/learning/rules/:id
router.delete('/rules/:id', async (req, res) => {
  try {
    await learning.deleteRule(req.params.id);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/learning/rules — clear all
router.delete('/rules', async (_req, res) => {
  try {
    await learning.clearAllRules();
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/learning/approve
router.post('/approve', async (req, res) => {
  try {
    await learning.recordApproval(req.body);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
