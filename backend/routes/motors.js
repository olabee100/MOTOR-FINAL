const express = require('express');
const { pool } = require('../db/init');
const { requireAuth, requireRole } = require('../middleware/auth');
const { logAudit, diffSummary } = require('../services/audit');

const router = express.Router();


function rowToMotor(r) {
  const locType = r.location_type || 'Mill floor';
  const detail = r.placement_detail || '';

  return {
    id: r.id,
    tag: r.tag,
    name: r.name,
    department: r.department,
    kw: r.hp,
    voltage: r.voltage,
    rpm: r.rpm,
    manualStatus: r.manual_status,

    locationType: locType,
    placementDetail: detail,

    currentLocation: detail
      ? `${locType} — ${detail}`
      : locType,

    standbyCategory: r.standby_category || 'new',
    condition: r.condition_notes,

    createdAt: r.created_at,
    updatedAt: r.updated_at
  };
}


// GET ALL MOTORS
router.get('/', requireAuth, async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT * FROM motors ORDER BY tag'
    );

    res.json(result.rows.map(rowToMotor));

  } catch (err) {
    console.error('Get motors error:', err);

    res.status(500).json({
      error: 'Could not load motors.'
    });
  }
});


// CREATE MOTOR
router.post(
  '/',
  requireAuth,
  requireRole('admin', 'technician'),
  async (req, res) => {
    try {
      const b = req.body || {};

      const tag = (b.tag || 'UNTAGGED').trim();

      // Check duplicate tag
      const dupe = await pool.query(
        `
        SELECT id
        FROM motors
        WHERE LOWER(tag) = LOWER($1)
        LIMIT 1
        `,
        [tag]
      );

      if (dupe.rows.length > 0) {
        return res.status(409).json({
          error: `A motor with tag "${tag}" already exists. Each motor needs a unique tag.`
        });
      }

      const now = new Date();

      const result = await pool.query(
        `
        INSERT INTO motors
        (
          tag,
          name,
          department,
          hp,
          voltage,
          rpm,
          manual_status,
          current_location,
          location_type,
          placement_detail,
          standby_category,
          condition_notes,
          created_at,
          updated_at
        )
        VALUES
        (
          $1, $2, $3, $4, $5, $6, $7,
          $8, $9, $10, $11, $12, $13, $14
        )
        RETURNING id
        `,
        [
          tag,
          b.name || 'Unnamed motor',
          b.department || 'Milling',
          b.kw || 0,
          b.voltage || 415,
          b.rpm || 1450,
          b.manualStatus || 'running',
          '',
          b.locationType || 'Mill floor',
          b.placementDetail || '',
          b.standbyCategory || 'new',
          b.condition || '',
          now,
          now
        ]
      );

      const motorId = result.rows[0].id;

      await logAudit(req, {
        entityType: 'motors',
        entityId: motorId,
        entityLabel: tag,
        action: 'create',
        summary: `Added motor "${tag}" — ${b.name || ''}`
      });

      res.status(201).json({
        id: motorId
      });

    } catch (err) {
      console.error('Create motor error:', err);

      res.status(500).json({
        error: 'Could not create the motor.'
      });
    }
  }
);


// UPDATE MOTOR
router.put(
  '/:id',
  requireAuth,
  requireRole('admin', 'technician'),
  async (req, res) => {
    try {
      const b = req.body || {};
      const motorId = Number(req.params.id);
      const now = new Date();

      // Get existing motor
      const oldResult = await pool.query(
        'SELECT * FROM motors WHERE id = $1',
        [motorId]
      );

      const oldRow = oldResult.rows[0];

      if (!oldRow) {
        return res.status(404).json({
          error: 'Motor not found.'
        });
      }

      const tag = (b.tag || '').trim();

      // Check duplicate tag excluding current motor
      const dupe = await pool.query(
        `
        SELECT id
        FROM motors
        WHERE LOWER(tag) = LOWER($1)
          AND id != $2
        LIMIT 1
        `,
        [tag, motorId]
      );

      if (dupe.rows.length > 0) {
        return res.status(409).json({
          error: `A motor with tag "${tag}" already exists. Each motor needs a unique tag.`
        });
      }

      await pool.query(
        `
        UPDATE motors
        SET
          tag = $1,
          name = $2,
          department = $3,
          hp = $4,
          voltage = $5,
          rpm = $6,
          manual_status = $7,
          location_type = $8,
          placement_detail = $9,
          standby_category = $10,
          condition_notes = $11,
          updated_at = $12
        WHERE id = $13
        `,
        [
          tag,
          b.name,
          b.department,
          b.kw,
          b.voltage,
          b.rpm,
          b.manualStatus,
          b.locationType || 'Mill floor',
          b.placementDetail || '',
          b.standbyCategory || 'new',
          b.condition,
          now,
          motorId
        ]
      );

      const summary = diffSummary(
        oldRow,
        {
          tag: b.tag,
          name: b.name,
          department: b.department,
          hp: b.kw,
          manual_status: b.manualStatus,
          location_type: b.locationType,
          placement_detail: b.placementDetail,
          standby_category: b.standbyCategory,
          condition_notes: b.condition
        },
        {
          tag: 'Tag',
          name: 'Name',
          department: 'Department',
          hp: 'kW',
          manual_status: 'Status',
          location_type: 'Location type',
          placement_detail: 'Placement',
          standby_category: 'Spare category',
          condition_notes: 'Condition'
        }
      );

      await logAudit(req, {
        entityType: 'motors',
        entityId: motorId,
        entityLabel: b.tag,
        action: 'update',
        summary: summary || 'Updated with no field changes.'
      });

      res.json({
        ok: true
      });

    } catch (err) {
      console.error('Update motor error:', err);

      res.status(500).json({
        error: 'Could not update the motor.'
      });
    }
  }
);


// BULK CREATE
router.post(
  '/bulk',
  requireAuth,
  requireRole('admin', 'technician'),
  async (req, res) => {
    const client = await pool.connect();

    try {
      const rows = Array.isArray(req.body?.motors)
        ? req.body.motors
        : [];

      const now = new Date();

      const seenInBatch = new Set();
      const skipped = [];

      await client.query('BEGIN');

      for (const b of rows) {
        const tag = (b.tag || 'UNTAGGED').trim();
        const tagKey = tag.toLowerCase();

        // Duplicate within same upload
        if (seenInBatch.has(tagKey)) {
          skipped.push(tag);
          continue;
        }

        // Duplicate already in PostgreSQL
        const existing = await client.query(
          `
          SELECT id
          FROM motors
          WHERE LOWER(tag) = LOWER($1)
          LIMIT 1
          `,
          [tag]
        );

        if (existing.rows.length > 0) {
          skipped.push(tag);
          continue;
        }

        seenInBatch.add(tagKey);

        const result = await client.query(
          `
          INSERT INTO motors
          (
            tag,
            name,
            department,
            hp,
            voltage,
            rpm,
            manual_status,
            current_location,
            location_type,
            placement_detail,
            standby_category,
            condition_notes,
            created_at,
            updated_at
          )
          VALUES
          (
            $1, $2, $3, $4, $5, $6, $7,
            $8, $9, $10, $11, $12, $13, $14
          )
          RETURNING id
          `,
          [
            tag,
            b.name || tag || 'Unnamed motor',
            b.department || 'Milling',
            parseFloat(b.kw) || 0,
            parseInt(b.voltage) || 415,
            parseInt(b.rpm) || 1450,
            b.manualStatus || 'running',
            '',
            b.locationType || 'Mill floor',
            b.placementDetail || b.currentLocation || '',
            b.standbyCategory || 'new',
            b.condition || '',
            now,
            now
          ]
        );

        const motorId = result.rows[0].id;

        await logAudit(req, {
          entityType: 'motors',
          entityId: motorId,
          entityLabel: tag,
          action: 'create',
          summary: `Added via bulk import — "${tag}"`
        });
      }

      await client.query('COMMIT');

      res.status(201).json({
        added: rows.length - skipped.length,
        skipped
      });

    } catch (err) {
      await client.query('ROLLBACK');

      console.error('Bulk motor import error:', err);

      res.status(500).json({
        error: 'Could not import motors.'
      });

    } finally {
      client.release();
    }
  }
);


// DELETE SINGLE MOTOR
router.delete('/:id', requireAuth, async (req, res) => {
  const client = await pool.connect();

  try {
    const motorId = Number(req.params.id);

    const result = await client.query(
      'SELECT tag FROM motors WHERE id = $1',
      [motorId]
    );

    const row = result.rows[0];

    if (!row) {
      return res.json({
        ok: true
      });
    }

    await client.query('BEGIN');

    const eventCount = await client.query(
      `
      SELECT COUNT(*)::int AS n
      FROM events
      WHERE motor_id = $1
      `,
      [motorId]
    );

    const removedEvents = eventCount.rows[0].n;

    // Remove breakdown history first because events reference motors
    await client.query(
      'DELETE FROM events WHERE motor_id = $1',
      [motorId]
    );

    await client.query(
      'DELETE FROM motors WHERE id = $1',
      [motorId]
    );

    await client.query('COMMIT');

    await logAudit(req, {
      entityType: 'motors',
      entityId: motorId,
      entityLabel: row.tag,
      action: 'delete',
      summary:
        `Deleted motor "${row.tag}"` +
        (
          removedEvents
            ? ` and ${removedEvents} breakdown record(s)`
            : ''
        )
    });

    res.json({
      ok: true,
      removedEvents
    });

  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch (_) {}

    console.error('Delete motor error:', err);

    res.status(500).json({
      error: 'Could not delete the motor.'
    });

  } finally {
    client.release();
  }
});


// BULK DELETE
router.post('/bulk-delete', requireAuth, async (req, res) => {
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
      const motorId = Number(id);

      const result = await client.query(
        'SELECT tag FROM motors WHERE id = $1',
        [motorId]
      );

      const row = result.rows[0];

      if (!row) {
        continue;
      }

      const eventCount = await client.query(
        `
        SELECT COUNT(*)::int AS n
        FROM events
        WHERE motor_id = $1
        `,
        [motorId]
      );

      const removedEvents = eventCount.rows[0].n;

      await client.query(
        'DELETE FROM events WHERE motor_id = $1',
        [motorId]
      );

      await client.query(
        'DELETE FROM motors WHERE id = $1',
        [motorId]
      );

      deleted++;

      await logAudit(req, {
        entityType: 'motors',
        entityId: motorId,
        entityLabel: row.tag,
        action: 'delete',
        summary:
          `Deleted motor "${row.tag}"` +
          (
            removedEvents
              ? ` and ${removedEvents} breakdown record(s)`
              : ''
          ) +
          ' (bulk delete)'
      });
    }

    await client.query('COMMIT');

    res.json({
      deleted
    });

  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch (_) {}

    console.error('Bulk delete motors error:', err);

    res.status(500).json({
      error: 'Could not delete the motors.'
    });

  } finally {
    client.release();
  }
});


module.exports = router;