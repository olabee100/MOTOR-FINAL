const express = require('express');
const db = require('../db/init');
const { requireAuth } = require('../middleware/auth');
const router = express.Router();

// History for one specific item (a motor, a spare, or a breakdown event)
router.get('/', requireAuth, (req, res) => {
  const { entityType, entityId, limit } = req.query;
  let rows;
  if (entityType && entityId) {
    rows = db.prepare('SELECT * FROM audit_log WHERE entity_type=? AND entity_id=? ORDER BY created_at DESC LIMIT ?')
      .all(entityType, entityId, parseInt(limit) || 100);
  } else {
    rows = db.prepare('SELECT * FROM audit_log ORDER BY created_at DESC LIMIT ?').all(parseInt(limit) || 200);
  }
  res.json(rows);
});

module.exports = router;
