const express = require('express');
const { pool } = require('../db/init');
const { requireAuth, requireRole } = require('../middleware/auth');
const { sendAlertSms } = require('../services/sms');
const { logAudit } = require('../services/audit');

const router = express.Router();

 // false = test report optional before resolving
function rowToEvent(r) {
  return {
    id: r.id,
    motorId: r.motor_id,
    reportedAt: r.reported_at,
    reportedBy: r.reported_by,
    description: r.description,
    urgency: r.urgency,
    stage: r.stage,
    testReport:
  typeof r.test_report === 'string'
    ? JSON.parse(r.test_report)
    : r.test_report || null,
    repairLocation: r.repair_location,
    repairLocationType: r.repair_location_type || '',

    condition: r.condition_notes,

    // PostgreSQL JSONB is already returned as a JavaScript value
    sparesUsed: r.spares_used || [],
    motorSwaps: r.motor_swaps || [],
    timeline: r.timeline || [],

    resolvedAt: r.resolved_at,
    downtimeHours: r.downtime_hours,

    createdAt: r.created_at,
    updatedAt: r.updated_at
  };
}


function who(req) {
  return req.user
    ? `${req.user.name} (${req.user.role})`
    : 'Unknown';
}


// GET ALL EVENTS
router.get('/', requireAuth, async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT * FROM events ORDER BY reported_at DESC'
    );

    res.json(result.rows.map(rowToEvent));

  } catch (err) {
    console.error('Get events error:', err);

    res.status(500).json({
      error: 'Could not load breakdown records.'
    });
  }
});


// CREATE BREAKDOWN EVENT
router.post(
  '/',
  requireAuth,
  requireRole('admin', 'technician'),
  async (req, res) => {
    try {
      const b = req.body || {};
      const motorId = Number(b.motorId);
      const now = new Date();

      // Find motor
      const motorResult = await pool.query(
        'SELECT * FROM motors WHERE id = $1',
        [motorId]
      );

      const motor = motorResult.rows[0];

      if (!motor) {
        return res.status(400).json({
          error: 'Motor not found.'
        });
      }


      // Prevent duplicate open breakdowns
      const openExisting = await pool.query(
        `
        SELECT id
        FROM events
        WHERE motor_id = $1
          AND stage != 'resolved'
        LIMIT 1
        `,
        [motorId]
      );

      if (openExisting.rows.length > 0) {
        return res.status(409).json({
          error:
            `${motor.tag} already has an open breakdown ` +
            `(#${openExisting.rows[0].id}). Resolve it before logging a new one.`
        });
      }


      // Standby motors cannot have breakdowns reported
      if (motor.manual_status === 'standby') {
        return res.status(409).json({
          error:
            `${motor.tag} is on standby, not in service — it can't break down.`
        });
      }


      // Decommissioned motors cannot have breakdowns reported
      if (motor.manual_status === 'decommissioned') {
        return res.status(409).json({
          error:
            `${motor.tag} is decommissioned — it can't break down.`
        });
      }


      const reportedBy = b.reportedBy || req.user.name;

      const timeline = [
        {
          at: now,
          text: `Breakdown reported by ${who(req)}.`
        }
      ];


      const result = await pool.query(
        `
        INSERT INTO events
        (
          motor_id,
          reported_at,
          reported_by,
          description,
          urgency,
          stage,
          repair_location,
          repair_location_type,
          condition_notes,
          spares_used,
          motor_swaps,
          timeline,
          created_at,
          updated_at
        )
        VALUES
        (
          $1, $2, $3, $4, $5, $6,
          $7, $8, $9, $10, $11, $12, $13, $14
        )
        RETURNING id
        `,
        [
          motorId,
          now,
          reportedBy,
          b.description || '',
          b.urgency || 'medium',
          'reported',
          '',
          '',
          '',
          JSON.stringify([]),
          JSON.stringify([]),
          JSON.stringify(timeline),
          now,
          now
        ]
      );


      const eventId = result.rows[0].id;


      await logAudit(req, {
        entityType: 'events',
        entityId: eventId,
        entityLabel: motor.tag,
        action: 'create',
        summary:
          `Reported breakdown on ${motor.tag} ` +
          `(${b.urgency || 'medium'} urgency)`
      });


      // Send SMS for high urgency
      if ((b.urgency || 'medium') === 'high') {
        sendAlertSms(
          `MotorTrack alert: ${motor.tag} (${motor.name}) is down — HIGH urgency. Reported by ${reportedBy}.`
        ).catch(() => {});
      }


      res.status(201).json({
        id: eventId
      });

    } catch (err) {
      console.error('Create event error:', err);

      res.status(500).json({
        error: 'Could not create the breakdown record.'
      });
    }
  }
);


// UPDATE BREAKDOWN
//
// Handles:
// - workflow stage
// - repair location
// - repair location type
// - condition
// - description
// - urgency
// - reported by
// - notes
router.put(
  '/:id',
  requireAuth,
  requireRole('admin', 'technician'),
  async (req, res) => {
    try {
      const b = req.body || {};
      const eventId = Number(req.params.id);
      const now = new Date();


      const result = await pool.query(
        'SELECT * FROM events WHERE id = $1',
        [eventId]
      );

      const row = result.rows[0];

      if (!row) {
        return res.status(404).json({
          error: 'Event not found.'
        });
      }
  if (req.user.role === 'technician' && row.stage === 'resolved') {
    return res.status(403).json({ error: 'Only an admin can edit a resolved breakdown record.' });
  }
    if (b.stage === 'resolved' && row.stage !== 'resolved') {
    return res.status(409).json({ error: 'Use "Mark resolved". It requires a passed test report.' });
  }

      const next = {
        stage:
          b.stage !== undefined
            ? b.stage
            : row.stage,

        repairLocation:
          b.repairLocation !== undefined
            ? b.repairLocation
            : row.repair_location,

        repairLocationType:
          b.repairLocationType !== undefined
            ? b.repairLocationType
            : row.repair_location_type,

        condition:
          b.condition !== undefined
            ? b.condition
            : row.condition_notes,

        description:
          b.description !== undefined
            ? b.description
            : row.description,

        urgency:
          b.urgency !== undefined
            ? b.urgency
            : row.urgency,

        reportedBy:
          b.reportedBy !== undefined
            ? b.reportedBy
            : row.reported_by
      };


      // JSONB comes back as a JavaScript array
      const timeline = Array.isArray(row.timeline)
        ? [...row.timeline]
        : [];


      const changes = [];


      if (
        b.stage !== undefined &&
        b.stage !== row.stage
      ) {
        changes.push(`stage → "${b.stage}"`);
      }


      if (
        b.repairLocationType !== undefined &&
        b.repairLocationType !== row.repair_location_type
      ) {
        changes.push(
          `workshop → "${b.repairLocationType}"`
        );
      }


      if (
        b.repairLocation !== undefined &&
        b.repairLocation !== row.repair_location
      ) {
        changes.push(
          `location → "${b.repairLocation}"`
        );
      }


      if (
        b.condition !== undefined &&
        b.condition !== row.condition_notes
      ) {
        changes.push(
          `condition → "${b.condition}"`
        );
      }


      if (
        b.description !== undefined &&
        b.description !== row.description
      ) {
        changes.push(
          'description updated'
        );
      }


      if (
        b.urgency !== undefined &&
        b.urgency !== row.urgency
      ) {
        changes.push(
          `urgency → "${b.urgency}"`
        );
      }


      if (
        b.reportedBy !== undefined &&
        b.reportedBy !== row.reported_by
      ) {
        changes.push(
          `reported by → "${b.reportedBy}"`
        );
      }


      let text = changes.length
        ? changes.join(', ')
        : 'Updated.';


      if (b.note) {
        text +=
          (changes.length ? ' — ' : '') +
          b.note;
      }


      timeline.push({
        at: now,
        text: `${text} (${who(req)})`
      });


      await pool.query(
        `
        UPDATE events
        SET
          stage = $1,
          repair_location = $2,
          repair_location_type = $3,
          condition_notes = $4,
          description = $5,
          urgency = $6,
          reported_by = $7,
          timeline = $8,
          updated_at = $9
        WHERE id = $10
        `,
        [
          next.stage,
          next.repairLocation,
          next.repairLocationType,
          next.condition,
          next.description,
          next.urgency,
          next.reportedBy,
          JSON.stringify(timeline),
          now,
          eventId
        ]
      );


      const motorResult = await pool.query(
        'SELECT tag FROM motors WHERE id = $1',
        [row.motor_id]
      );

      const motor = motorResult.rows[0];


      await logAudit(req, {
        entityType: 'events',
        entityId: eventId,
        entityLabel: motor ? motor.tag : '',
        action: 'update',
        summary:
          changes.length
            ? changes.join('; ')
            : 'Updated with no field changes.'
      });


      const updatedResult = await pool.query(
        'SELECT * FROM events WHERE id = $1',
        [eventId]
      );


      res.json({
        ok: true,
        event: rowToEvent(updatedResult.rows[0])
      });

    } catch (err) {
      console.error('Update event error:', err);

      res.status(500).json({
        error: 'Could not update the breakdown record.'
      });
    }
  }
);


// USE SPARE ON REPAIR
//
// Decrements stock and records the spare on the breakdown.
// Both operations happen inside one PostgreSQL transaction.
router.post(
  '/:id/use-spare',
  requireAuth,
  requireRole('admin', 'technician'),
  async (req, res) => {
    const { spareId, qty } = req.body || {};

    const useQty = Math.max(
      1,
      parseInt(qty) || 1
    );

    const eventId = Number(req.params.id);
    const spareIdNumber = Number(spareId);

    const client = await pool.connect();

    try {
      await client.query('BEGIN');


      // Lock event row
      const eventResult = await client.query(
        `
        SELECT *
        FROM events
        WHERE id = $1
        FOR UPDATE
        `,
        [eventId]
      );

      const event = eventResult.rows[0];


      // Lock spare row so two users cannot deduct
      // the same stock simultaneously.
      const spareResult = await client.query(
        `
        SELECT *
        FROM spares
        WHERE id = $1
        FOR UPDATE
        `,
        [spareIdNumber]
      );

      const spare = spareResult.rows[0];


      if (!event || !spare) {
        await client.query('ROLLBACK');

        return res.status(404).json({
          error: 'Event or spare not found.'
        });
      }


      // Don't allow stock to go negative.
      if (spare.qty < useQty) {
        await client.query('ROLLBACK');

        return res.status(400).json({
          error:
            `Insufficient stock. ${spare.name} has ` +
            `${spare.qty} available, but ${useQty} was requested.`
        });
      }


      const now = new Date();


      const sparesUsed = Array.isArray(event.spares_used)
        ? [...event.spares_used]
        : [];


      sparesUsed.push({
        spareId: spare.id,
        spareName: spare.name,
        qty: useQty
      });


      const timeline = Array.isArray(event.timeline)
        ? [...event.timeline]
        : [];


      timeline.push({
        at: now,
        text:
          `Used ${useQty} x ${spare.name} ` +
          `from stock (${who(req)}).`
      });


      await client.query(
        `
        UPDATE events
        SET
          spares_used = $1,
          timeline = $2,
          updated_at = $3
        WHERE id = $4
        `,
        [
          JSON.stringify(sparesUsed),
          JSON.stringify(timeline),
          now,
          eventId
        ]
      );


      await client.query(
        `
        UPDATE spares
        SET
          qty = qty - $1,
          updated_at = $2
        WHERE id = $3
        `,
        [
          useQty,
          now,
          spare.id
        ]
      );


      await client.query('COMMIT');


      await logAudit(req, {
        entityType: 'events',
        entityId: eventId,
        action: 'use-spare',
        summary:
          `Used ${useQty} x ${spare.name}`
      });


      await logAudit(req, {
        entityType: 'spares',
        entityId: spare.id,
        entityLabel: spare.name,
        action: 'adjust',
        summary:
          `Used on repair — qty -${useQty}`
      });


      const updatedResult = await pool.query(
        'SELECT * FROM events WHERE id = $1',
        [eventId]
      );


      res.json({
        ok: true,
        event: rowToEvent(updatedResult.rows[0])
      });

    } catch (err) {
      try {
        await client.query('ROLLBACK');
      } catch (_) {}

      console.error('Use spare error:', err);

      res.status(500).json({
        error: 'Could not record spare usage.'
      });

    } finally {
      client.release();
    }
  }
);


// SWAP BROKEN MOTOR WITH STANDBY MOTOR
router.post(
  '/:id/swap-motor',
  requireAuth,
  requireRole('admin', 'technician'),
  async (req, res) => {
    const { spareMotorId } = req.body || {};

    const eventId = Number(req.params.id);
    const spareMotorIdNumber = Number(spareMotorId);

    const client = await pool.connect();

    try {
      await client.query('BEGIN');


      const eventResult = await client.query(
        `
        SELECT *
        FROM events
        WHERE id = $1
        FOR UPDATE
        `,
        [eventId]
      );

      const event = eventResult.rows[0];


      if (!event) {
        await client.query('ROLLBACK');

        return res.status(404).json({
          error: 'Breakdown or spare motor not found.'
        });
      }


      const spareResult = await client.query(
        `
        SELECT *
        FROM motors
        WHERE id = $1
        FOR UPDATE
        `,
        [spareMotorIdNumber]
      );

      const spareMotor = spareResult.rows[0];


      const brokenResult = await client.query(
        `
        SELECT *
        FROM motors
        WHERE id = $1
        FOR UPDATE
        `,
        [event.motor_id]
      );

      const brokenMotor = brokenResult.rows[0];


      if (!spareMotor || !brokenMotor) {
        await client.query('ROLLBACK');

        return res.status(404).json({
          error: 'Breakdown or spare motor not found.'
        });
      }


      if (spareMotor.manual_status !== 'standby') {
        await client.query('ROLLBACK');

        return res.status(409).json({
          error:
            `${spareMotor.tag} is not currently on standby.`
        });
      }

      const spareRep = spareMotor.test_report ?? null;

if (!spareRep) {
  return res.status(409).json({
    error: `${spareMotor.tag} has no test report. Record a passing test before installation.`
  });
}

if (spareRep.result !== 'pass') {
  return res.status(409).json({
    error: `${spareMotor.tag}'s latest test did not pass. Record a passing test before installation.`
  });
}


      const now = new Date();


      const swaps = Array.isArray(event.motor_swaps)
        ? [...event.motor_swaps]
        : [];


      swaps.push({
        motorId: spareMotor.id,
        tag: spareMotor.tag,
        at: now,
        by: who(req)
      });


      const timeline = Array.isArray(event.timeline)
        ? [...event.timeline]
        : [];


      timeline.push({
        at: now,
        text:
          `Spare motor ${spareMotor.tag} installed ` +
          `in place of ${brokenMotor.tag} (${who(req)}).`
      });


      await client.query(
        `
        UPDATE events
        SET
          motor_swaps = $1,
          timeline = $2,
          updated_at = $3
        WHERE id = $4
        `,
        [
          JSON.stringify(swaps),
          JSON.stringify(timeline),
          now,
          eventId
        ]
      );


      await client.query(
        `
        UPDATE motors
        SET
          manual_status = 'running',
          location_type = $1,
          placement_detail = $2,
          condition_notes = $3,
          updated_at = $4
        WHERE id = $5
        `,
        [
          brokenMotor.location_type,
          brokenMotor.placement_detail,
          `Installed in place of ${brokenMotor.tag}`,
          now,
          spareMotor.id
        ]
      );


      await client.query('COMMIT');


      await logAudit(req, {
        entityType: 'events',
        entityId: eventId,
        entityLabel: brokenMotor.tag,
        action: 'swap-motor',
        summary:
          `Installed spare motor ${spareMotor.tag} ` +
          `in place of ${brokenMotor.tag}`
      });


      await logAudit(req, {
        entityType: 'motors',
        entityId: spareMotor.id,
        entityLabel: spareMotor.tag,
        action: 'update',
        summary:
          `Taken off standby — installed in place of ${brokenMotor.tag}`
      });


      const updatedResult = await pool.query(
        'SELECT * FROM events WHERE id = $1',
        [eventId]
      );


      res.json({
        ok: true,
        event: rowToEvent(updatedResult.rows[0])
      });

    } catch (err) {
      try {
        await client.query('ROLLBACK');
      } catch (_) {}

      console.error('Swap motor error:', err);

      res.status(500).json({
        error: 'Could not complete the motor swap.'
      });

    } finally {
      client.release();
    }
  }
);


// RESOLVE BREAKDOWN
router.post(
  '/:id/resolve',
  requireAuth,
  requireRole('admin', 'technician'),
  async (req, res) => {
    const client = await pool.connect();

    try {
      const eventId = Number(req.params.id);

      await client.query('BEGIN');


      const eventResult = await client.query(
        `
        SELECT *
        FROM events
        WHERE id = $1
        FOR UPDATE
        `,
        [eventId]
      );

      const event = eventResult.rows[0];


      if (!event) {
        await client.query('ROLLBACK');

        return res.status(404).json({
          error: 'Event not found.'
        });
      }

    // Mandatory for every role: a PASSED test report must be on file before resolving.
 
const rep =
  typeof event.test_report === 'string'
    ? JSON.parse(event.test_report)
    : event.test_report;

if (!rep) {
  await client.query('ROLLBACK');

  return res.status(409).json({
    error: 'A test report is required before this motor can be resolved.'
  });
}

if (rep.result !== 'pass') {
  await client.query('ROLLBACK');

  return res.status(409).json({
    error: 'The latest test report is FAILED. Record a new test that passes before resolving.'
  });
}

      const now = new Date();

      const downtimeHours =
        (
          now.getTime() -
          new Date(event.reported_at).getTime()
        ) / 3600000;


      const timeline = Array.isArray(event.timeline)
        ? [...event.timeline]
        : [];


      timeline.push({
        at: now,
        text:
          `Resolved — motor returned to service. ` +
          `Total downtime ${downtimeHours.toFixed(1)} hours. ` +
          `(${who(req)})`
      });


      await client.query(
        `
        UPDATE events
        SET
          stage = 'resolved',
          resolved_at = $1,
          downtime_hours = $2,
          timeline = $3,
          updated_at = $4
        WHERE id = $5
        `,
        [
          now,
          downtimeHours,
          JSON.stringify(timeline),
          now,
          eventId
        ]
      );


      await client.query(
        `
        UPDATE motors
        SET
          condition_notes = $1,
          updated_at = $2
        WHERE id = $3
        `,
        [
          'Good — returned from repair',
          now,
          event.motor_id
        ]
      );


      await client.query('COMMIT');


      const motorResult = await pool.query(
        'SELECT tag FROM motors WHERE id = $1',
        [event.motor_id]
      );

      const motor = motorResult.rows[0];


      await logAudit(req, {
        entityType: 'events',
        entityId: eventId,
        entityLabel: motor ? motor.tag : '',
        action: 'resolve',
        summary:
          `Resolved — downtime ${downtimeHours.toFixed(1)}h`
      });


      const updatedResult = await pool.query(
        'SELECT * FROM events WHERE id = $1',
        [eventId]
      );


      res.json({
        ok: true,
        downtimeHours,
        event: rowToEvent(updatedResult.rows[0])
      });

    } catch (err) {
      try {
        await client.query('ROLLBACK');
      } catch (_) {}

      console.error('Resolve event error:', err);

      res.status(500).json({
        error: 'Could not resolve the breakdown.'
      });

    } finally {
      client.release();
    }
  }
);



 // REOPEN RESOLVED EVENT
router.post(
  '/:id/reopen',
  requireAuth,
  requireRole('admin'),
  async (req, res) => {
    const client = await pool.connect();
    let transactionStarted = false;

    try {
      const eventId = Number(req.params.id);

      if (!Number.isInteger(eventId) || eventId <= 0) {
        return res.status(400).json({
          error: 'Invalid breakdown ID.'
        });
      }

      await client.query('BEGIN');
      transactionStarted = true;

      const result = await client.query(
        'SELECT * FROM events WHERE id = $1 FOR UPDATE',
        [eventId]
      );

      const event = result.rows[0];

      if (!event) {
        await client.query('ROLLBACK');
        transactionStarted = false;

        return res.status(404).json({
          error: 'Event not found.'
        });
      }

      if (event.stage !== 'resolved') {
        await client.query('ROLLBACK');
        transactionStarted = false;

        return res.status(409).json({
          error: 'Only resolved breakdowns can be reopened.'
        });
      }

      const now = new Date();

      const timeline = Array.isArray(event.timeline)
        ? [...event.timeline]
        : typeof event.timeline === 'string'
          ? JSON.parse(event.timeline || '[]')
          : [];

      timeline.push({
        at: now,
        text: `Reopened — issue recurred. (${who(req)})`
      });

      await client.query(
        `UPDATE events
         SET stage = 'in_repair',
             resolved_at = NULL,
             downtime_hours = NULL,
             test_report = NULL,
             timeline = $1,
             updated_at = $2
         WHERE id = $3`,
        [
          JSON.stringify(timeline),
          now,
          eventId
        ]
      );

      await client.query('COMMIT');
      transactionStarted = false;

      try {
        await logAudit(req, {
          entityType: 'events',
          entityId: eventId,
          action: 'reopen',
          summary: 'Reopened after resolution'
        });
      } catch (auditError) {
        console.error('Reopen audit error:', auditError);
      }

      return res.json({ ok: true });

    } catch (err) {
      if (transactionStarted) {
        try {
          await client.query('ROLLBACK');
        } catch (rollbackError) {
          console.error('Reopen rollback error:', rollbackError);
        }
      }

      console.error('Reopen event error:', err);

      return res.status(500).json({
        error: 'Could not reopen the breakdown.'
      });

    } finally {
      client.release();
    }
  }
);



// DELETE SINGLE EVENT
router.delete('/:id', requireAuth,requireRole('admin'), async (req, res) => {
  try {
    const eventId = Number(req.params.id);

    const eventResult = await pool.query(
      'SELECT * FROM events WHERE id = $1',
      [eventId]
    );

    const event = eventResult.rows[0];


    let motor = null;

    if (event) {
      const motorResult = await pool.query(
        'SELECT tag FROM motors WHERE id = $1',
        [event.motor_id]
      );

      motor = motorResult.rows[0];
    }


    await pool.query(
      'DELETE FROM events WHERE id = $1',
      [eventId]
    );


    if (event) {
      await logAudit(req, {
        entityType: 'events',
        entityId: eventId,
        entityLabel: motor ? motor.tag : '',
        action: 'delete',
        summary:
          `Deleted breakdown record for ` +
          `${motor ? motor.tag : 'unknown motor'}`
      });
    }


    res.json({
      ok: true
    });

  } catch (err) {
    console.error('Delete event error:', err);

    res.status(500).json({
      error: 'Could not delete the breakdown record.'
    });
  }
});


// BULK DELETE EVENTS
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
      const eventId = Number(id);

      const result = await client.query(
        'DELETE FROM events WHERE id = $1 RETURNING id',
        [eventId]
      );

      if (result.rows.length > 0) {
        deleted++;

        await logAudit(req, {
          entityType: 'events',
          entityId: eventId,
          action: 'delete',
          summary: 'Deleted (bulk delete)'
        });
      }
    }

    await client.query('COMMIT');

    res.json({
      deleted
    });

  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch (_) {}

    console.error('Bulk delete events error:', err);

    res.status(500).json({
      error: 'Could not delete the breakdown records.'
    });

  } finally {
    client.release();
  }
});

router.post(
  '/:id/test-report',
  requireAuth,
  requireRole('admin', 'technician'),
  async (req, res) => {
    const client = await pool.connect();
    let transactionStarted = false;

    try {
      const eventId = Number(req.params.id);

      if (!Number.isInteger(eventId) || eventId <= 0) {
        return res.status(400).json({
          error: 'Invalid breakdown ID.'
        });
      }

      const b = req.body || {};

      if (!['pass', 'fail'].includes(b.result)) {
        return res.status(400).json({
          error: 'Choose Pass or Fail.'
        });
      }

      await client.query('BEGIN');
      transactionStarted = true;

      const result = await client.query(
        'SELECT * FROM events WHERE id = $1 FOR UPDATE',
        [eventId]
      );

      const event = result.rows[0];

      if (!event) {
        await client.query('ROLLBACK');
        transactionStarted = false;

        return res.status(404).json({
          error: 'Event not found.'
        });
      }

      if (event.stage === 'resolved') {
        await client.query('ROLLBACK');
        transactionStarted = false;

        return res.status(409).json({
          error: 'This breakdown is already resolved.'
        });
      }

      const now = new Date();

      const report = {
        result: b.result,
        noLoadCurrent: b.noLoadCurrent ?? '',
        insulationResistance: b.insulationResistance ?? '',
        vibration: b.vibration ?? '',
        temperature: b.temperature ?? '',
        notes:
          typeof b.notes === 'string'
            ? b.notes.trim()
            : '',
        testedBy: who(req),
        testedAt: now.toISOString()
      };

      const timeline = Array.isArray(event.timeline)
        ? [...event.timeline]
        : typeof event.timeline === 'string'
          ? JSON.parse(event.timeline || '[]')
          : [];

      timeline.push({
        at: now,
        text:
          `Test report recorded: ${b.result.toUpperCase()} ` +
          `(${who(req)}).`
      });

      await client.query(
        `UPDATE events
         SET test_report = $1,
             timeline = $2,
             updated_at = $3
         WHERE id = $4`,
        [
          JSON.stringify(report),
          JSON.stringify(timeline),
          now,
          eventId
        ]
      );

      await client.query('COMMIT');
      transactionStarted = false;

      try {
        await logAudit(req, {
          entityType: 'events',
          entityId: eventId,
          action: 'test-report',
          summary: `Test report: ${b.result}`
        });
      } catch (auditError) {
        console.error('Test report audit error:', auditError);
      }

      const updatedResult = await pool.query(
        'SELECT * FROM events WHERE id = $1',
        [eventId]
      );

      return res.json({
        ok: true,
        event: rowToEvent(updatedResult.rows[0])
      });

    } catch (err) {
      if (transactionStarted) {
        try {
          await client.query('ROLLBACK');
        } catch (rollbackError) {
          console.error('Test report rollback error:', rollbackError);
        }
      }

      console.error('Test report error:', err);

      return res.status(500).json({
        error: 'Could not save the test report.'
      });

    } finally {
      client.release();
    }
  }
);


module.exports = router;