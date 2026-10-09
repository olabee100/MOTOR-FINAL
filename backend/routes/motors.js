const express = require('express');
const { pool } = require('../db/init');
const { requireAuth, requireRole } = require('../middleware/auth');
const { logAudit, diffSummary } = require('../services/audit');

const router = express.Router();

const pool = require('../db/pool'); // use whatever your file exports

const asArr = (v) => {
  if (!v) return [];
  if (Array.isArray(v)) return v;
  try { const p = JSON.parse(v); return Array.isArray(p) ? p : []; } catch { return []; }
};
const asObj = (v) => {
  if (!v) return null;
  if (typeof v === 'object') return v;
  try { return JSON.parse(v); } catch { return null; }
};
const toIso = (v) => { const d = new Date(v); return isNaN(d.getTime()) ? null : d.toISOString(); };
// Pulls "Name (role)" out of the end of a timeline line
const byFromText = (t) => {
  const s = String(t || '');
  const m = s.match(/\(([^()]*\([^()]*\))\)\.?\s*$/) || s.match(/ by ([^()]*\([^()]*\))\.?\s*$/);
  return m ? m[1].trim() : '';
};
const readings = (r) => {
  const p = [];
  if (r.noLoadCurrent !== '' && r.noLoadCurrent != null) p.push(`no-load ${r.noLoadCurrent} A`);
  if (r.insulationResistance !== '' && r.insulationResistance != null) p.push(`insulation ${r.insulationResistance} MΩ`);
  if (r.vibration !== '' && r.vibration != null) p.push(`vibration ${r.vibration} mm/s`);
  if (r.temperature !== '' && r.temperature != null) p.push(`temp ${r.temperature} °C`);
  if (r.notes) p.push(`notes: ${r.notes}`);
  return p.join(', ');
};

// A technician may only touch a motor that is currently broken down or under repair.


async function techCanEdit(motorId) {
  const motorResult = await pool.query(
    'SELECT id, manual_status FROM motors WHERE id = $1',
    [motorId]
  );

  const motor = motorResult.rows[0];

  if (!motor) return false;

  // Allow editing motors that are currently under repair.
  if (motor.manual_status === 'repair') return true;

  // Allow editing motors with breakdown history,
  // including breakdowns that have already been resolved.
  const eventResult = await pool.query(
    `SELECT 1
     FROM events
     WHERE motor_id = $1
     LIMIT 1`,
    [motorId]
  );

  return eventResult.rows.length > 0;
}



function rowToMotor(r) {
  const locType = r.location_type || '';
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

    testReport:
  typeof r.test_report === 'string'
    ? JSON.parse(r.test_report)
    : r.test_report || null,

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
  requireRole('admin'),
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
          $8, $9, $10, $11, $12, $13
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
          b.locationType || '',
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

   

if (req.user.role === 'technician') {
  if (!(await techCanEdit(motorId))) {
    return res.status(403).json({
      error: 'Technicians can only edit motors involved in a breakdown or under repair.'
    });
  }

  const allowedStatuses = ['standby', 'repair'];

  if (
    b.manualStatus !== undefined &&
    b.manualStatus !== oldRow.manual_status
  ) {
    if (!allowedStatuses.includes(b.manualStatus)) {
      return res.status(403).json({
        error: 'Technicians can only change motor status to standby or repair. Ask an admin to set a motor to running.'
      });
    }
  }
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
          b.locationType || '',
          b.placementDetail || '',
          b.standbyCategory || 'new',
          b.condition,
          now,
          motorId
        ]
      );

      if (
  b.manualStatus === 'standby' &&
  oldRow.manual_status !== 'standby'
) {
  await pool.query(
    'UPDATE motors SET test_report = NULL WHERE id = $1',
    [motorId]
  );
}

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
  requireRole('admin'),
  async (req, res) => {
    const client = await pool.connect();

    try {
      const rows = Array.isArray(req.body?.motors)
        ? req.body.motors
        : [];
console.log('BULK ROWS:', JSON.stringify(rows, null, 2));
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
  '',                          // current_location
  b.locationType || '',       // location_type
  b.placementDetail || '',    // placement_detail
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
router.delete('/:id', requireAuth,requireRole('admin'), async (req, res) => {
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

router.post(
  '/:id/test-report',
  requireAuth,
  requireRole('admin', 'technician', 'storekeeper'),
  async (req, res) => {
    try {
      const motorId = Number(req.params.id);

      if (!Number.isInteger(motorId) || motorId <= 0) {
        return res.status(400).json({ error: 'Invalid motor ID.' });
      }

      const result = await pool.query(
        'SELECT id, tag, manual_status FROM motors WHERE id = $1',
        [motorId]
      );

      const motor = result.rows[0];

      if (!motor) {
        return res.status(404).json({ error: 'Motor not found.' });
      }

      if (motor.manual_status !== 'standby') {
        return res.status(409).json({
          error: 'Test reports on this screen are for spare motors on standby.'
        });
      }

      const b = req.body || {};

      if (!['pass', 'fail'].includes(b.result)) {
        return res.status(400).json({
          error: 'Choose Pass or Fail.'
        });
      }

      const report = {
        result: b.result,
        noLoadCurrent: b.noLoadCurrent ?? '',
        insulationResistance: b.insulationResistance ?? '',
        vibration: b.vibration ?? '',
        temperature: b.temperature ?? '',
        notes: String(b.notes || '').trim(),
        testedBy: `${req.user.name} (${req.user.role})`,
        testedAt: new Date().toISOString()
      };

      await pool.query(
        `UPDATE motors
         SET test_report = $1::jsonb,
             updated_at = NOW()
         WHERE id = $2`,
        [JSON.stringify(report), motorId]
      );

      await logAudit(req, {
        entityType: 'motors',
        entityId: motor.id,
        entityLabel: motor.tag,
        action: 'test-report',
        summary: `Spare test report: ${b.result.toUpperCase()}`
      });

      return res.json({ ok: true, testReport: report });
    } catch (err) {
      console.error('Save spare test report error:', err);

      return res.status(500).json({
        error: 'Could not save the test report.'
      });
    }
  }
);

router.get('/:id/history', requireAuth, async (req, res, next) => {
  try {
    const id = parseInt(req.params.id, 10);
    const { rows: mrows } = await pool.query('SELECT * FROM motors WHERE id = $1', [id]);
    if (!mrows.length) return res.status(404).json({ error: 'Motor not found.' });
    const m = mrows[0];

    const entries = [];
    const add = (at, type, by, summary, extra = {}) => {
      const t = toIso(at);
      if (t) entries.push({ at: t, type, by: by || '', summary: summary || '', ...extra });
    };

    // 1. Changes made to the motor record itself (who / what / when)
    const { rows: motorAudit } = await pool.query(
      "SELECT created_at, user_name, action, summary FROM audit_log WHERE entity_type = 'motors' AND entity_id::text = $1",
      [String(id)]
    );
    motorAudit.forEach(a => add(a.created_at, 'Motor record', a.user_name, a.summary || a.action));
    if (!motorAudit.some(a => a.action === 'create')) {
      add(m.created_at, 'Motor record', '', `Motor "${m.tag}" added to the system`);
    }

    // 2. Test report saved on the motor while it was a standby spare
    const spareTest = asObj(m.test_report);
    if (spareTest) {
      const rd = readings(spareTest);
      add(spareTest.testedAt, 'Spare test', spareTest.testedBy,
        `Spare test report: ${String(spareTest.result).toUpperCase()}${rd ? ' — ' + rd : ''}`);
    }

    // 3. Every breakdown / repair on this motor
    const { rows: evs } = await pool.query('SELECT * FROM events WHERE motor_id = $1 ORDER BY reported_at', [id]);
    evs.forEach(ev => {
      const tag = `Breakdown #${ev.id}`;
      const timeline = asArr(ev.timeline);
      const first = timeline.find(t => /^Breakdown reported/.test(t.text || ''));
      add(ev.reported_at, 'Breakdown', (first && byFromText(first.text)) || ev.reported_by,
        `${tag} reported (${ev.urgency} urgency): ${ev.description || 'no description'}`, { eventId: ev.id });
      timeline.forEach(t => {
        if (/^Breakdown reported/.test(t.text || '')) return;
        add(t.at, 'Repair', byFromText(t.text), `${tag}: ${t.text}`, { eventId: ev.id });
      });
      const rep = asObj(ev.test_report);
      if (rep) {
        const rd = readings(rep);
        if (rd) add(rep.testedAt, 'Test readings', rep.testedBy,
          `${tag} latest test (${String(rep.result).toUpperCase()}): ${rd}`, { eventId: ev.id });
      }
    });

    // 4. Times this motor was installed as a spare for another motor
    const { rows: swapEvs } = await pool.query(
      `SELECT e.id, e.motor_swaps, m2.tag AS broken_tag
         FROM events e JOIN motors m2 ON m2.id = e.motor_id
        WHERE e.motor_swaps IS NOT NULL AND e.motor_swaps::text NOT IN ('[]', '')`
    );
    swapEvs.forEach(e => asArr(e.motor_swaps).forEach(s => {
      if (String(s.motorId) === String(id)) {
        add(s.at, 'Used as spare', s.by,
          `Installed as a spare in place of ${e.broken_tag} (breakdown #${e.id})`, { eventId: e.id });
      }
    }));

    entries.sort((a, b) => a.at.localeCompare(b.at));
    res.json({
      motor: { id: m.id, tag: m.tag, name: m.name, department: m.department, kw: m.hp, voltage: m.voltage, rpm: m.rpm },
      entries,
    });
  } catch (e) { next(e); }
});

module.exports = router;