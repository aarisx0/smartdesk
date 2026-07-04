'use strict';

const express = require('express');
const router  = express.Router();
const { search } = require('../search');

/**
 * GET /api/search?q=find+my+internship+certificate
 *
 * Response:
 * {
 *   results: SearchResult[],
 *   meta: { query, keywords, extHint, durationMs, totalFound }
 * }
 */
router.get('/', async (req, res) => {
  try {
    const q = (req.query.q ?? '').toString().trim();
    if (!q) {
      return res.status(400).json({ error: 'Query parameter "q" is required' });
    }

    const result = await search(q);
    return res.json(result);
  } catch (err) {
    console.error('[search route]', err);
    return res.status(500).json({ error: err.message });
  }
});

module.exports = router;
