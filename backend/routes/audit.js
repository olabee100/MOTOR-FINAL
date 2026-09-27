const express = require('express');
const { pool } = require('../db/init');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

// History for one specific item
// (a motor, a spare, or a breakdown event)
router.get('/', requireAuth, async (req, res) => {
  try {
    const { entityType, entityId, limit } = req.query;

    const requestedLimit = parseInt(limit);

    const safeLimit =
      Number.isFinite(requestedLimit) && requestedLimit > 0
        ? Math.min(requestedLimit, 500)
        : entityType && entityId
          ? 100
          : 200;

    let result;

    if (entityType && entityId) {
      result = await pool.query(
        `
        SELECT *
        FROM audit_log
        WHERE entity_type = $1
          AND entity_id = $2
        ORDER BY created_at DESC
        LIMIT $3
        `,
        [
          entityType,
          Number(entityId),
          safeLimit
        ]
      );
    } else {
      result = await pool.query(
        `
        SELECT *
        FROM audit_log
        ORDER BY created_at DESC
        LIMIT $1
        `,
        [safeLimit]
      );
    }

    res.json(result.rows);

  } catch (err) {
    console.error('Audit log error:', err);

    res.status(500).json({
      error: 'Could not load audit history.'
    });
  }
});

module.exports = router;