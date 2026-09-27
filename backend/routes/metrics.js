const express = require('express');
const { pool } = require('../db/init');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();


// MTTR (Mean Time To Repair)
// = average downtime hours across resolved events.
//
// MTBF (Mean Time Between Failures)
// = average gap, in hours, between the start of one breakdown
//   and the start of the next breakdown on the same motor.
//
// Both need the relevant minimum number of data points.
// We return null (not zero) when there isn't enough history.


router.get('/', requireAuth, async (req, res) => {

  try {

    // Get all motors
    const motorsResult = await pool.query(
      `
      SELECT
        id,
        tag,
        name,
        department
      FROM motors
      ORDER BY id
      `
    );


    // Get all breakdown events in chronological order
    const eventsResult = await pool.query(
      `
      SELECT *
      FROM events
      ORDER BY reported_at ASC
      `
    );


    const motors = motorsResult.rows;
    const events = eventsResult.rows;


    // ----------------------------------------------------------
    // Calculate metrics for each motor
    // ----------------------------------------------------------

    const perMotor = motors.map(m => {

      const motorEvents = events.filter(
        e => e.motor_id === m.id
      );


      // -------------------------
      // MTTR
      // -------------------------

      const resolved = motorEvents.filter(
        e => e.downtime_hours !== null &&
             e.downtime_hours !== undefined
      );


      const mttr = resolved.length
        ? resolved.reduce(
            (total, e) => total + Number(e.downtime_hours),
            0
          ) / resolved.length
        : null;


      // -------------------------
      // MTBF
      // -------------------------

      let mtbf = null;


      if (motorEvents.length >= 2) {

        const gaps = [];


        for (let i = 1; i < motorEvents.length; i++) {

          const previous =
            new Date(
              motorEvents[i - 1].reported_at
            ).getTime();


          const current =
            new Date(
              motorEvents[i].reported_at
            ).getTime();


          const gapHours =
            (current - previous) / 3600000;


          gaps.push(gapHours);
        }


        mtbf =
          gaps.reduce(
            (total, gap) => total + gap,
            0
          ) / gaps.length;
      }


      return {
        motorId: m.id,
        tag: m.tag,
        name: m.name,
        department: m.department,

        breakdownCount: motorEvents.length,

        mttrHours: mttr,

        mtbfHours: mtbf
      };
    });


    // ----------------------------------------------------------
    // Fleet-wide MTTR
    // ----------------------------------------------------------

    const allResolved = events.filter(
      e =>
        e.downtime_hours !== null &&
        e.downtime_hours !== undefined
    );


    const fleetMttr = allResolved.length
      ? allResolved.reduce(
          (total, e) => total + Number(e.downtime_hours),
          0
        ) / allResolved.length
      : null;


    // ----------------------------------------------------------
    // Response
    // ----------------------------------------------------------

    res.json({
      perMotor,

      fleetMttrHours: fleetMttr,

      totalBreakdowns: events.length,

      totalResolved: allResolved.length
    });


  } catch (err) {

    console.error('Metrics error:', err);

    res.status(500).json({
      error: 'Could not calculate maintenance metrics.'
    });
  }
});


module.exports = router;