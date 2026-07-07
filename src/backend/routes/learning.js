'use strict';

const express  = require('express');
const router   = express.Router();
const learning = require('../learning');

/** Pull device_id from the x-device-id request header. */
function getDeviceId(req) {
  return (req.headers['x-device-id'] || 'unknown').trim();
}

// GET /api/learning/rules — scoped to this device
router.get('/rules', async (req, res) => {
  const deviceId = getDeviceId(req);
  try {
    const rules = await learning.getAllRules(deviceId);
    res.json(rules);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/learning/rules/:id — delete one rule (no device check needed — PK is UUID)
router.delete('/rules/:id', async (req, res) => {
  try {
    await learning.deleteRule(req.params.id);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/learning/rules — clear all rules for this device only
router.delete('/rules', async (req, res) => {
  const deviceId = getDeviceId(req);
  try {
    await learning.clearAllRules(deviceId);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/learning/approve — record an approval scoped to this device
router.post('/approve', async (req, res) => {
  const deviceId = getDeviceId(req);
  try {
    await learning.recordApproval({ ...req.body, deviceId });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
