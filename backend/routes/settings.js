const express = require('express');
const db = require('../db/init');
const { requireAuth, requireRole } = require('../middleware/auth');
const router = express.Router();

const DEFAULTS = { spareMotorReorderNew: '2', spareMotorReorderRepaired: '2' };

router.get('/', requireAuth, (req, res) => {
  const rows = db.prepare('SELECT * FROM settings').all();
  const out = { ...DEFAULTS };
  rows.forEach(r => { out[r.key] = r.value; });
  res.json(out);
});

router.put('/', requireAuth, requireRole('admin', 'storekeeper'), (req, res) => {
  const b = req.body || {};
  const upsert = db.prepare(`INSERT INTO settings (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value`);
  Object.entries(b).forEach(([k, v]) => upsert.run(k, String(v)));
  res.json({ ok: true });
});

module.exports = router;
