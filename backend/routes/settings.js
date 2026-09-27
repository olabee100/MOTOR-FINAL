const express = require('express');
const { pool } = require('../db/init');
const { requireAuth, requireRole } = require('../middleware/auth');

const router = express.Router();

const DEFAULTS = {
  spareMotorReorderNew: '2',
  spareMotorReorderRepaired: '2'
};


// ============================================================
// GET SETTINGS
// ============================================================

router.get('/', requireAuth, async (req, res) => {
  try {

    const result = await pool.query(
      'SELECT * FROM settings'
    );

    const out = { ...DEFAULTS };

    result.rows.forEach(r => {
      out[r.key] = r.value;
    });

    res.json(out);

  } catch (err) {

    console.error('Settings load error:', err);

    res.status(500).json({
      error: 'Could not load settings.'
    });
  }
});


// ============================================================
// UPDATE SETTINGS
// ============================================================

router.put(
  '/',
  requireAuth,
  requireRole('admin', 'storekeeper'),
  async (req, res) => {

    try {

      const b = req.body || {};

      // PostgreSQL UPSERT
      const upsert = `
        INSERT INTO settings (key, value)
        VALUES ($1, $2)
        ON CONFLICT (key)
        DO UPDATE SET value = EXCLUDED.value
      `;


      // Update each supplied setting
      for (const [k, v] of Object.entries(b)) {

        await pool.query(
          upsert,
          [k, String(v)]
        );
      }


      res.json({
        ok: true
      });

    } catch (err) {

      console.error('Settings update error:', err);

      res.status(500).json({
        error: 'Could not update settings.'
      });
    }
  }
);


module.exports = router;