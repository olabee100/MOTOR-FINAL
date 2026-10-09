const express = require('express');
const { pool } = require('../db/init');
const { requireAuth, requireRole } = require('../middleware/auth');
const { logAudit, diffSummary } = require('../services/audit');

const router = express.Router();

function rowToSpare(r) {
  return {
    id: r.id,
    name: r.name,
    partNumber: r.part_number,
    category: r.category,
    qty: r.qty,
    minQty: r.min_qty,
    unitCost: r.unit_cost,
    location: r.location,
    supplier: r.supplier,
    compatibleMotorIds: r.compatible_motor_ids || [],
    createdAt: r.created_at,
    updatedAt: r.updated_at
  };
}


// GET ALL SPARES
router.get('/', requireAuth, async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT * FROM spares ORDER BY name'
    );

    res.json(result.rows.map(rowToSpare));

  } catch (err) {
    console.error('Get spares error:', err);

    res.status(500).json({
      error: 'Could not load spares.'
    });
  }
});


// CREATE SPARE
router.post(
  '/',
  requireAuth,
  requireRole('admin', 'storekeeper'),
  async (req, res) => {
    try {
      const b = req.body || {};
      const now = new Date();

      const result = await pool.query(
        `
        INSERT INTO spares
        (
          name,
          part_number,
          category,
          qty,
          min_qty,
          unit_cost,
          location,
          supplier,
          compatible_motor_ids,
          created_at,
          updated_at
        )
        VALUES
        (
          $1, $2, $3, $4, $5, $6,
          $7, $8, $9, $10, $11
        )
        RETURNING id
        `,
        [
          b.name || 'Unnamed part',
          b.partNumber || '',
          b.category || 'Other',
          b.qty || 0,
          b.minQty || 0,
          b.unitCost || 0,
          b.location || '',
          b.supplier || '',
          JSON.stringify(b.compatibleMotorIds || []),
          now,
          now
        ]
      );

      const spareId = result.rows[0].id;

      await logAudit(req, {
        entityType: 'spares',
        entityId: spareId,
        entityLabel: b.name,
        action: 'create',
        summary: `Added spare "${b.name}" — qty ${b.qty || 0}`
      });

      res.status(201).json({
        id: spareId
      });

    } catch (err) {
      console.error('Create spare error:', err);

      res.status(500).json({
        error: 'Could not create the spare.'
      });
    }
  }
);


// UPDATE SPARE
router.put(
  '/:id',
  requireAuth,
  requireRole('admin', 'storekeeper'),
  async (req, res) => {
    try {
      const b = req.body || {};
      const spareId = Number(req.params.id);
      const now = new Date();

      const oldResult = await pool.query(
        'SELECT * FROM spares WHERE id = $1',
        [spareId]
      );

      const oldRow = oldResult.rows[0];

      if (!oldRow) {
        return res.status(404).json({
          error: 'Spare not found.'
        });
      }

      await pool.query(
        `
        UPDATE spares
        SET
          name = $1,
          part_number = $2,
          category = $3,
          qty = $4,
          min_qty = $5,
          unit_cost = $6,
          location = $7,
          supplier = $8,
          updated_at = $9
        WHERE id = $10
        `,
        [
          b.name,
          b.partNumber,
          b.category,
          b.qty,
          b.minQty,
          b.unitCost,
          b.location,
          b.supplier,
          now,
          spareId
        ]
      );

      const summary = diffSummary(
        oldRow,
        {
          name: b.name,
          part_number: b.partNumber,
          category: b.category,
          qty: b.qty,
          min_qty: b.minQty,
          unit_cost: b.unitCost,
          location: b.location,
          supplier: b.supplier
        },
        {
          name: 'Name',
          part_number: 'Part number',
          category: 'Category',
          qty: 'Qty',
          min_qty: 'Min qty',
          unit_cost: 'Unit cost',
          location: 'Location',
          supplier: 'Supplier'
        }
      );

      await logAudit(req, {
        entityType: 'spares',
        entityId: spareId,
        entityLabel: b.name,
        action: 'update',
        summary: summary || 'Updated with no field changes.'
      });

      res.json({
        ok: true
      });

    } catch (err) {
      console.error('Update spare error:', err);

      res.status(500).json({
        error: 'Could not update the spare.'
      });
    }
  }
);


// QUICK STOCK ADJUSTMENT
router.post(
  '/:id/adjust',
  requireAuth,
  requireRole('admin', 'storekeeper'),
  async (req, res) => {
    try {
      const delta = parseInt(req.body?.delta) || 0;
      const spareId = Number(req.params.id);

      const result = await pool.query(
        'SELECT * FROM spares WHERE id = $1',
        [spareId]
      );

      const row = result.rows[0];

      if (!row) {
        return res.status(404).json({
          error: 'Spare not found.'
        });
      }

      const newQty = Math.max(0, row.qty + delta);
      const now = new Date();

      await pool.query(
        `
        UPDATE spares
        SET
          qty = $1,
          updated_at = $2
        WHERE id = $3
        `,
        [
          newQty,
          now,
          spareId
        ]
      );

      await logAudit(req, {
        entityType: 'spares',
        entityId: spareId,
        entityLabel: row.name,
        action: 'adjust',
        summary:
          `Stock ${delta >= 0 ? '+' : ''}${delta} ` +
          `(${row.qty} → ${newQty})`
      });

      res.json({
        ok: true,
        qty: newQty
      });

    } catch (err) {
      console.error('Adjust spare error:', err);

      res.status(500).json({
        error: 'Could not adjust stock.'
      });
    }
  }
);


// BULK CREATE
router.post(
  '/bulk',
  requireAuth,
  requireRole('admin', 'storekeeper'),
  async (req, res) => {
    const rows = Array.isArray(req.body?.spares)
      ? req.body.spares
      : [];

    const client = await pool.connect();

    try {
      const now = new Date();

      await client.query('BEGIN');

      let added = 0;

      for (const b of rows) {
        const result = await client.query(
          `
          INSERT INTO spares
          (
            name,
            part_number,
            category,
            qty,
            min_qty,
            unit_cost,
            location,
            supplier,
            compatible_motor_ids,
            created_at,
            updated_at
          )
          VALUES
          (
            $1, $2, $3, $4, $5, $6,
            $7, $8, $9, $10, $11
          )
          RETURNING id
          `,
          [
            b.name || 'Unnamed part',
            b.partNumber || '',
            b.category || 'Other',
            parseInt(b.qty) || 0,
            parseInt(b.minQty) || 0,
            parseFloat(b.unitCost) || 0,
            b.location || '',
            b.supplier || '',
            JSON.stringify(b.compatibleMotorIds || []),
            now,
            now
          ]
        );

        const spareId = result.rows[0].id;

        await logAudit(req, {
          entityType: 'spares',
          entityId: spareId,
          entityLabel: b.name,
          action: 'create',
          summary: `Added via bulk import — "${b.name}"`
        });

        added++;
      }

      await client.query('COMMIT');

      res.status(201).json({
        added
      });

    } catch (err) {
      try {
        await client.query('ROLLBACK');
      } catch (_) {}

      console.error('Bulk spare import error:', err);

      res.status(500).json({
        error: 'Could not import spares.'
      });

    } finally {
      client.release();
    }
  }
);


// DELETE SINGLE SPARE
router.delete('/:id', requireAuth,requireRole('admin'), async (req, res) => {
  try {
    const spareId = Number(req.params.id);

    const result = await pool.query(
      'SELECT name FROM spares WHERE id = $1',
      [spareId]
    );

    const row = result.rows[0];

    await pool.query(
      'DELETE FROM spares WHERE id = $1',
      [spareId]
    );

    if (row) {
      await logAudit(req, {
        entityType: 'spares',
        entityId: spareId,
        entityLabel: row.name,
        action: 'delete',
        summary: `Deleted spare "${row.name}"`
      });
    }

    res.json({
      ok: true
    });

  } catch (err) {
    console.error('Delete spare error:', err);

    res.status(500).json({
      error: 'Could not delete the spare.'
    });
  }
});


// BULK DELETE
router.post('/bulk-delete', requireAuth,requireRole('admin'), async (req, res) => {
  const ids = Array.isArray(req.body?.ids)
    ? req.body.ids
    : [];

  if (!ids.length) {
    return res.json({
      deleted: 0
    });
  }

  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    let deleted = 0;

    for (const id of ids) {
      const spareId = Number(id);

      const result = await client.query(
        'SELECT name FROM spares WHERE id = $1',
        [spareId]
      );

      const row = result.rows[0];

      if (!row) {
        continue;
      }

      await client.query(
        'DELETE FROM spares WHERE id = $1',
        [spareId]
      );

      await logAudit(req, {
        entityType: 'spares',
        entityId: spareId,
        entityLabel: row.name,
        action: 'delete',
        summary: `Deleted spare "${row.name}" (bulk delete)`
      });

      deleted++;
    }

    await client.query('COMMIT');

    res.json({
      deleted
    });

  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch (_) {}

    console.error('Bulk delete spares error:', err);

    res.status(500).json({
      error: 'Could not delete the spares.'
    });

  } finally {
    client.release();
  }
});


module.exports = router;