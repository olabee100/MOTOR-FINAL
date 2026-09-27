const express = require('express');
const { pool } = require('../db/init');
const { requireAuth, requireRole } = require('../middleware/auth');

const router = express.Router();


// ============================================================
// EXPORT BACKUP
// ============================================================

router.get(
  '/export',
  requireAuth,
  requireRole('admin'),
  async (req, res) => {
    try {
      const [
        usersResult,
        motorsResult,
        sparesResult,
        eventsResult
      ] = await Promise.all([
        pool.query('SELECT * FROM users ORDER BY id'),
        pool.query('SELECT * FROM motors ORDER BY id'),
        pool.query('SELECT * FROM spares ORDER BY id'),
        pool.query('SELECT * FROM events ORDER BY id')
      ]);


      const dump = {
        exportedAt: new Date().toISOString(),
        version: 2,

        users: usersResult.rows,
        motors: motorsResult.rows,
        spares: sparesResult.rows,
        events: eventsResult.rows
      };


      res.setHeader(
        'Content-Disposition',
        `attachment; filename="motortrack-backup-${Date.now()}.json"`
      );

      res.setHeader(
        'Content-Type',
        'application/json'
      );

      res.json(dump);

    } catch (err) {
      console.error('Backup export failed:', err);

      res.status(500).json({
        error: 'Could not export MotorTrack backup.'
      });
    }
  }
);


// ============================================================
// IMPORT / RESTORE BACKUP
// ============================================================

// Replaces ALL current data with what's in the uploaded backup file.
router.post(
  '/import',
  requireAuth,
  requireRole('admin'),
  async (req, res) => {

    const dump = req.body || {};


    // Basic validation
    if (
      !Array.isArray(dump.motors) ||
      !Array.isArray(dump.spares) ||
      !Array.isArray(dump.events) ||
      !Array.isArray(dump.users)
    ) {
      return res.status(400).json({
        error: 'That file does not look like a MotorTrack backup.'
      });
    }


    const client = await pool.connect();


    try {
      await client.query('BEGIN');


      // --------------------------------------------------------
      // Delete existing data
      // --------------------------------------------------------

      await client.query('DELETE FROM events');
      await client.query('DELETE FROM spares');
      await client.query('DELETE FROM motors');
      await client.query('DELETE FROM users');


      // --------------------------------------------------------
      // Restore users
      // --------------------------------------------------------

      for (const u of dump.users) {

        await client.query(
          `
          INSERT INTO users
          (
            id,
            username,
            password_hash,
            name,
            role,
            phone,
            created_at
          )
          VALUES
          (
            $1, $2, $3, $4, $5, $6, $7
          )
          `,
          [
            u.id,
            u.username,
            u.password_hash,
            u.name,
            u.role,
            u.phone || '',
            u.created_at
          ]
        );
      }


      // --------------------------------------------------------
      // Restore motors
      // --------------------------------------------------------

      for (const m of dump.motors) {

        await client.query(
          `
          INSERT INTO motors
          (
            id,
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
          `,
          [
            m.id,
            m.tag,
            m.name,
            m.department,
            m.hp,
            m.voltage,
            m.rpm,
            m.manual_status,
            m.current_location || '',
            m.location_type || '',
            m.placement_detail || '',
            m.standby_category || '',
            m.condition_notes || '',
            m.created_at,
            m.updated_at
          ]
        );
      }


      // --------------------------------------------------------
      // Restore spares
      // --------------------------------------------------------

      for (const s of dump.spares) {

        await client.query(
          `
          INSERT INTO spares
          (
            id,
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
            $7, $8, $9, $10, $11, $12
          )
          `,
          [
            s.id,
            s.name,
            s.part_number,
            s.category,
            s.qty,
            s.min_qty,
            s.unit_cost,
            s.location,
            s.supplier,
            JSON.stringify(s.compatible_motor_ids || []),
            s.created_at,
            s.updated_at
          ]
        );
      }


      // --------------------------------------------------------
      // Restore events
      // --------------------------------------------------------

      for (const e of dump.events) {

        await client.query(
          `
          INSERT INTO events
          (
            id,
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
            resolved_at,
            downtime_hours,
            created_at,
            updated_at
          )
          VALUES
          (
            $1, $2, $3, $4, $5, $6, $7,
            $8, $9, $10, $11, $12, $13,
            $14, $15, $16, $17
          )
          `,
          [
            e.id,
            e.motor_id,
            e.reported_at,
            e.reported_by,
            e.description,
            e.urgency,
            e.stage,
            e.repair_location || '',
            e.repair_location_type || '',
            e.condition_notes || '',
            JSON.stringify(e.spares_used || []),
            JSON.stringify(e.motor_swaps || []),
            JSON.stringify(e.timeline || []),
            e.resolved_at || null,
            e.downtime_hours ?? null,
            e.created_at,
            e.updated_at
          ]
        );
      }


      // --------------------------------------------------------
      // Reset PostgreSQL SERIAL sequences
      // --------------------------------------------------------
      //
      // Unlike SQLite's sqlite_sequence, PostgreSQL uses
      // sequences behind SERIAL columns.
      //
      // We move each sequence to the highest restored ID.
      // --------------------------------------------------------

      const tables = [
        ['users', 'users_id_seq'],
        ['motors', 'motors_id_seq'],
        ['spares', 'spares_id_seq'],
        ['events', 'events_id_seq']
      ];


      for (const [table, sequence] of tables) {

        await client.query(
          `
          SELECT setval(
            $1::regclass,
            COALESCE(
              (SELECT MAX(id) FROM ${table}),
              1
            ),
            (SELECT COUNT(*) > 0 FROM ${table})
          )
          `,
          [sequence]
        );
      }


      await client.query('COMMIT');


      res.json({
        ok: true,
        restored: {
          users: dump.users.length,
          motors: dump.motors.length,
          spares: dump.spares.length,
          events: dump.events.length
        }
      });


    } catch (err) {

      await client.query('ROLLBACK');

      console.error('Restore failed:', err);

      res.status(500).json({
        error: 'Restore failed: ' + err.message
      });

    } finally {

      client.release();
    }
  }
);


module.exports = router;